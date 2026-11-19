import { createHash } from "node:crypto";
import { AuthService } from "../auth/jwt";
import { DataBufferEngine, type RedisBufferClient } from "../data/buffer";

const REDIS_IDEMPOTENCY_PREFIX = "datastack:idem:";
const REDIS_RATE_LIMIT_PREFIX = "datastack:rl:";
export const REDIS_RATE_LIMIT_LUA_SCRIPT = `
-- DATASTACK_RATE_LIMIT_INCR
local c = redis.call("INCR", KEYS[1])
if c == 1 or redis.call("PTTL", KEYS[1]) < 0 then
  redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[1]))
end
return c
`.trim();

export function resolveInternalIngestionSecret(
  jwtSecretOverride?: string,
): string {
  const explicit = (process.env.DATASTACK_INTERNAL_SECRET || "").trim();
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    if (explicit.length >= 32) return explicit;
    if (explicit.length > 0) return "";
  } else if (explicit.length > 0) {
    return explicit;
  }

  const activeJwt = String(
    jwtSecretOverride ?? AuthService.getSecret() ?? "",
  ).trim();
  const minJwtLen = isProd ? 32 : 1;
  if (activeJwt.length < minJwtLen) {
    return "";
  }

  return createHash("sha256")
    .update(`datastack-internal:${activeJwt}`)
    .digest("hex");
}

export function getInternalIngestionHeaders(
  jwtSecretOverride?: string,
): Record<string, string> {
  const secret = resolveInternalIngestionSecret(jwtSecretOverride);
  return secret ? { "x-datastack-internal-secret": secret } : {};
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  code?:
    | "RATE_LIMIT_EXCEEDED"
    | "PAYLOAD_TOO_LARGE"
    | "DUPLICATE_EVENT"
    | "MALFORMED_PAYLOAD";
}

export type SecurityMode =
  | "redis_shared"
  | "bridge_coordinated"
  | "degraded_local";

export class SecurityEngine {
  public static maxEventsPerSec = 100;
  public static enableIdempotency = true;
  private static lastSecurityMode: SecurityMode = "degraded_local";

  // Idempotency cache: key -> timestamp (expires after TTL)
  private static idempotencySet = new Map<string, number>();
  private static readonly IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Rate limiter: clientId -> { count, windowStart }
  private static rateLimitMap = new Map<
    string,
    { count: number; windowStart: number }
  >();

  // Default Max payload size (100KB)
  public static maxPayloadSizeBytes = 100 * 1024;

  /**
   * Idempotency Check:
   * ClientId + EventId must be unique.
   * Duplicate events are dropped silently or tagged.
   */
  public static hasDuplicate(clientId: string, eventId: string): boolean {
    if (!eventId) return false;
    const key = `${clientId}:${eventId}`;
    const now = Date.now();

    // Periodic cleanup of stale idempotency keys
    if (this.idempotencySet.size > 20000) {
      for (const [k, timestamp] of this.idempotencySet.entries()) {
        if (now - timestamp > this.IDEMPOTENCY_TTL_MS) {
          this.idempotencySet.delete(k);
        }
      }
    }

    if (this.idempotencySet.has(key)) {
      const storedTime = this.idempotencySet.get(key) || 0;
      if (now - storedTime < this.IDEMPOTENCY_TTL_MS) {
        return true;
      }
    }

    return false;
  }

  public static recordIdempotency(clientId: string, eventId: string): void {
    if (!eventId) return;
    this.idempotencySet.set(`${clientId}:${eventId}`, Date.now());
  }

  public static checkIdempotency(clientId: string, eventId: string): boolean {
    if (this.hasDuplicate(clientId, eventId)) {
      return false;
    }
    this.recordIdempotency(clientId, eventId);
    return true;
  }

  /**
   * Rate Limit Check:
   * Enforces max events per second per client.
   */
  public static checkRateLimit(
    clientId: string,
    maxEventsPerSec = this.maxEventsPerSec,
  ): boolean {
    const now = Date.now();
    const current = this.rateLimitMap.get(clientId);

    if (!current || now - current.windowStart >= 1000) {
      this.rateLimitMap.set(clientId, { count: 1, windowStart: now });
      return true;
    }

    if (current.count >= maxEventsPerSec) {
      return false; // Rate limit exceeded
    }

    current.count += 1;
    return true;
  }

  private static trackLocalRateWindow(clientId: string): void {
    const now = Date.now();
    const current = this.rateLimitMap.get(clientId);
    if (!current || now - current.windowStart >= 1000) {
      this.rateLimitMap.set(clientId, { count: 1, windowStart: now });
    } else {
      current.count += 1;
    }
  }

  private static supportsSharedSecurityRedis(
    redis: RedisBufferClient | null,
  ): redis is RedisBufferClient & {
    get: (key: string) => Promise<string | null>;
    incr: (key: string) => Promise<number>;
    pexpire: (key: string, ttlMs: number) => Promise<number>;
  } {
    return Boolean(
      redis &&
        typeof redis.get === "function" &&
        typeof redis.incr === "function" &&
        typeof redis.pexpire === "function" &&
        typeof redis.set === "function",
    );
  }

  /**
   * Validates incoming event payload:
   * Checks duplicate idempotency (read-only), max byte size, and rate limit,
   * and records the idempotency key ONLY after all checks pass.
   */
  public static validateEvent(
    clientId: string,
    eventId: string,
    payload: unknown,
    clientMaxRate = 100,
  ): ValidationResult {
    // 1. Check idempotency (read-only so rate-limited retries are not burned)
    if (this.enableIdempotency && this.hasDuplicate(clientId, eventId)) {
      return {
        allowed: false,
        reason: "Duplicate event dropped silently",
        code: "DUPLICATE_EVENT",
      };
    }

    // 2. Check payload size before consuming rate-limit quota
    const payloadStr =
      typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
    const byteLength = Buffer.byteLength(payloadStr, "utf8");

    if (byteLength > this.maxPayloadSizeBytes) {
      return {
        allowed: false,
        reason: `Payload size (${(byteLength / 1024).toFixed(1)} KB) exceeds limit of ${this.maxPayloadSizeBytes / 1024} KB`,
        code: "PAYLOAD_TOO_LARGE",
      };
    }

    // 3. Check rate limit
    const effectiveRateLimit = Math.min(clientMaxRate, this.maxEventsPerSec);
    const withinLimit = this.checkRateLimit(clientId, effectiveRateLimit);
    if (!withinLimit) {
      return {
        allowed: false,
        reason: `Rate limit of ${effectiveRateLimit} events/sec exceeded for client ${clientId}`,
        code: "RATE_LIMIT_EXCEEDED",
      };
    }

    // 4. Record idempotency key ONLY after event is accepted
    if (this.enableIdempotency && eventId) {
      this.recordIdempotency(clientId, eventId);
    }

    return { allowed: true };
  }

  /**
   * Shared Redis-backed async validator with Port 4000 internal-bridge fallback
   * (so HTTP + WS share rate limits & idempotency even when Redis is unconfigured)
   * and final local-Map fallback for isolated single-process dev.
   */
  public static async validateEventAsync(
    clientId: string,
    eventId: string,
    payload: unknown,
    clientMaxRate = 100,
  ): Promise<ValidationResult> {
    const redis = DataBufferEngine.getRedisClient();
    if (!this.supportsSharedSecurityRedis(redis)) {
      const payloadStr =
        typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
      const payloadBytes = Buffer.byteLength(payloadStr, "utf8");
      if (payloadBytes > this.maxPayloadSizeBytes) {
        return {
          allowed: false,
          reason: `Payload size (${(payloadBytes / 1024).toFixed(1)} KB) exceeds limit of ${this.maxPayloadSizeBytes / 1024} KB`,
          code: "PAYLOAD_TOO_LARGE",
        };
      }

      const headers = getInternalIngestionHeaders();
      if (headers["x-datastack-internal-secret"]) {
        const ingestionBaseUrl = (
          process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
        ).replace(/\/$/, "");
        try {
          const res = await fetch(`${ingestionBaseUrl}/internal/security-check`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headers,
            },
            body: JSON.stringify({
              clientId,
              eventId,
              payloadBytes,
              clientMaxRate,
            }),
            cache: "no-store",
            signal: AbortSignal.timeout(400),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              allowed?: boolean;
              code?: ValidationResult["code"];
              reason?: string;
            };
            this.lastSecurityMode = "bridge_coordinated";
            return {
              allowed: Boolean(data.allowed),
              ...(data.code ? { code: data.code } : {}),
              ...(data.reason ? { reason: data.reason } : {}),
            };
          }
        } catch {
          // Port 4000 unreachable — fall back to local validation
        }
      }

      this.lastSecurityMode = "degraded_local";
      return this.validateEvent(clientId, eventId, payload, clientMaxRate);
    }

    this.lastSecurityMode = "redis_shared";
    const idemKey = `${REDIS_IDEMPOTENCY_PREFIX}${clientId}:${eventId}`;
    try {
      // 1. Read-only idempotency check
      if (this.enableIdempotency && eventId) {
        if (this.hasDuplicate(clientId, eventId)) {
          return {
            allowed: false,
            reason: "Duplicate event dropped silently",
            code: "DUPLICATE_EVENT",
          };
        }
        const existing = await redis.get(idemKey);
        if (existing !== null) {
          this.recordIdempotency(clientId, eventId);
          return {
            allowed: false,
            reason: "Duplicate event dropped silently",
            code: "DUPLICATE_EVENT",
          };
        }
      }

      // 2. Payload byte size check before rate-limit consumption
      const payloadStr =
        typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
      const byteLength = Buffer.byteLength(payloadStr, "utf8");
      if (byteLength > this.maxPayloadSizeBytes) {
        return {
          allowed: false,
          reason: `Payload size (${(byteLength / 1024).toFixed(1)} KB) exceeds limit of ${this.maxPayloadSizeBytes / 1024} KB`,
          code: "PAYLOAD_TOO_LARGE",
        };
      }

      // 3. Shared atomic per-second rate-limit counter in Redis (single Lua round-trip)
      const effectiveRateLimit = Math.min(clientMaxRate, this.maxEventsPerSec);
      const windowBucket = Math.floor(Date.now() / 1000);
      const rlKey = `${REDIS_RATE_LIMIT_PREFIX}${clientId}:${windowBucket}`;
      let count: number;
      if (typeof redis.eval === "function") {
        count = Number(
          await redis.eval(REDIS_RATE_LIMIT_LUA_SCRIPT, 1, rlKey, "2000"),
        );
      } else {
        count = Number(await redis.incr(rlKey));
        if (count === 1) {
          await redis.pexpire(rlKey, 2000);
        }
      }
      this.trackLocalRateWindow(clientId);

      if (count > effectiveRateLimit) {
        return {
          allowed: false,
          reason: `Rate limit of ${effectiveRateLimit} events/sec exceeded for client ${clientId}`,
          code: "RATE_LIMIT_EXCEEDED",
        };
      }

      // 4. Atomic claim of idempotency key after all checks succeed
      if (this.enableIdempotency && eventId) {
        const claimed = await redis.set(
          idemKey,
          "1",
          "PX",
          this.IDEMPOTENCY_TTL_MS,
          "NX",
        );
        this.recordIdempotency(clientId, eventId);
        if (claimed !== "OK") {
          return {
            allowed: false,
            reason: "Duplicate event dropped silently",
            code: "DUPLICATE_EVENT",
          };
        }
      }

      return { allowed: true };
    } catch {
      return this.validateEvent(clientId, eventId, payload, clientMaxRate);
    }
  }

  public static getStats() {
    const now = Date.now();
    for (const [k, timestamp] of this.idempotencySet.entries()) {
      if (now - timestamp > this.IDEMPOTENCY_TTL_MS) {
        this.idempotencySet.delete(k);
      }
    }
    for (const [clientId, entry] of this.rateLimitMap.entries()) {
      if (now - entry.windowStart > 10000) {
        this.rateLimitMap.delete(clientId);
      }
    }

    const mode: SecurityMode = this.supportsSharedSecurityRedis(
      DataBufferEngine.getRedisClient(),
    )
      ? "redis_shared"
      : this.lastSecurityMode === "redis_shared"
        ? "degraded_local"
        : this.lastSecurityMode;

    return {
      activeIdempotencyKeys: this.idempotencySet.size,
      rateLimitedClientsCount: this.rateLimitMap.size,
      maxPayloadSizeBytes: this.maxPayloadSizeBytes,
      mode,
    };
  }
}

export default SecurityEngine;
