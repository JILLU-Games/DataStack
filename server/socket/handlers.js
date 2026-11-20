const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_MAX_ENTRIES = 20000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const REDIS_IDEMPOTENCY_PREFIX = "datastack:idem:";
const REDIS_RATE_LIMIT_PREFIX = "datastack:rl:";
const REDIS_RATE_LIMIT_LUA_SCRIPT = [
  "-- DATASTACK_RATE_LIMIT_INCR",
  'local c = redis.call("INCR", KEYS[1])',
  'if c == 1 or redis.call("PTTL", KEYS[1]) < 0 then',
  '  redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[1]))',
  "end",
  "return c",
].join("\n");

function generateFallbackEventId() {
  return `evt_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function normalizeClientId(clientId) {
  return String(clientId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

function extractSocketClientIp(socket) {
  const headers = (socket && socket.handshake && socket.handshake.headers) || {};
  const realIp =
    typeof headers["x-real-ip"] === "string" ? headers["x-real-ip"].trim() : "";
  if (realIp) {
    return realIp.slice(0, 128);
  }
  const forwardedFor =
    typeof headers["x-forwarded-for"] === "string"
      ? headers["x-forwarded-for"]
      : "";
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const rightmost = hops[hops.length - 1];
    if (rightmost) {
      return rightmost.slice(0, 128);
    }
  }
  const addr =
    (socket && socket.handshake && socket.handshake.address) ||
    (socket && socket.conn && socket.conn.remoteAddress) ||
    "";
  return String(addr).trim() || "127.0.0.1";
}

function setupSocketHandlers(io, bufferQueue, worker, options = {}) {
  const getRuntimeConfig =
    typeof options.getRuntimeConfig === "function"
      ? options.getRuntimeConfig
      : () => ({
          jwtSecret:
            options.jwtSecret ||
            (process.env.DATASTACK_JWT_SECRET || "").trim() ||
            (process.env.NODE_ENV === "production"
              ? ""
              : "datastack-jwt-default-secret-key-32-chars-long"),
          maxEventsPerSec: 100,
          maxPayloadSizeBytes: 100 * 1024,
          batchFlushThreshold: 500,
          enableIdempotency: true,
        });

  const verifyClientInDb =
    typeof options.verifyClientInDb === "function"
      ? options.verifyClientInDb
      : async () => ({ allowed: true });

  const recordClientActivity =
    typeof options.recordClientActivity === "function"
      ? options.recordClientActivity
      : () => undefined;

  const onBufferPush =
    typeof options.onBufferPush === "function"
      ? options.onBufferPush
      : () => undefined;

  const getRedisClient =
    typeof options.getRedisClient === "function"
      ? options.getRedisClient
      : () => null;

  const triggerWebhookAlert =
    typeof options.triggerWebhookAlert === "function"
      ? options.triggerWebhookAlert
      : null;

  const WEBHOOK_REJECTION_CODES = new Set([
    "CLIENT_TOKEN_EXPIRED",
    "CLIENT_IP_FORBIDDEN",
    "DISK_SPACE_LOW",
    "STORAGE_QUOTA_EXCEEDED",
  ]);

  function dispatchRejectionWebhook(code, reason, clientId, details) {
    if (!triggerWebhookAlert || !WEBHOOK_REJECTION_CODES.has(code)) return;
    const severity = code === "DISK_SPACE_LOW" ? "critical" : "warning";
    try {
      Promise.resolve(
        triggerWebhookAlert({
          event: code,
          severity,
          clientId,
          message:
            reason ||
            `${code}: Ingestion request rejected on Port 4000 Socket.IO.`,
          details: details || { transport: "socketio" },
        }),
      ).catch(() => undefined);
    } catch {
      // Never block socket handlers on webhook alert dispatch
    }
  }

  const idempotencyMap = new Map();
  const rateLimitMap = new Map();
  let lastCleanupAt = Date.now();

  function cleanupMaps(now, force = false) {
    if (
      !force &&
      now - lastCleanupAt < CLEANUP_INTERVAL_MS &&
      idempotencyMap.size <= IDEMPOTENCY_MAX_ENTRIES
    ) {
      return;
    }
    lastCleanupAt = now;

    for (const [key, timestamp] of idempotencyMap.entries()) {
      if (now - timestamp > IDEMPOTENCY_TTL_MS) {
        idempotencyMap.delete(key);
      }
    }

    for (const [clientId, rl] of rateLimitMap.entries()) {
      if (now - rl.start > 10000) {
        rateLimitMap.delete(clientId);
      }
    }
  }

  function trackLocalRateWindow(clientId, now) {
    const rl = rateLimitMap.get(clientId);
    if (!rl || now - rl.start >= 1000) {
      rateLimitMap.set(clientId, { count: 1, start: now });
    } else {
      rl.count += 1;
    }
  }

  function supportsSharedSecurityRedis(redis) {
    return Boolean(
      redis &&
        typeof redis.get === "function" &&
        typeof redis.incr === "function" &&
        typeof redis.pexpire === "function" &&
        typeof redis.set === "function",
    );
  }

  function getSecurityStats() {
    cleanupMaps(Date.now(), true);
    const config = getRuntimeConfig();
    return {
      activeIdempotencyKeys: idempotencyMap.size,
      rateLimitedClientsCount: rateLimitMap.size,
      maxPayloadSizeBytes: Number(config.maxPayloadSizeBytes) || 100 * 1024,
    };
  }

  function validateSingleEventLocal(
    clientId,
    eventId,
    rawData,
    clientRateLimit,
    explicitByteLength,
  ) {
    const config = getRuntimeConfig();
    const now = Date.now();
    cleanupMaps(now);

    // 1. Idempotency check (read-only check first; record only after rate-limit & payload checks pass)
    const idempotencyKey = `${clientId}:${eventId}`;
    if (config.enableIdempotency && eventId) {
      const existingTime = idempotencyMap.get(idempotencyKey);
      if (existingTime && now - existingTime < IDEMPOTENCY_TTL_MS) {
        return {
          allowed: false,
          duplicate: true,
          code: "DUPLICATE_EVENT",
          reason: "Duplicate event dropped",
        };
      }
    }

    // 2. Payload byte size check (before consuming rate-limit quota)
    let payloadStr = "";
    let byteLength = 0;
    if (
      typeof explicitByteLength === "number" &&
      Number.isFinite(explicitByteLength) &&
      explicitByteLength >= 0
    ) {
      byteLength = explicitByteLength;
    } else {
      payloadStr =
        typeof rawData === "string" ? rawData : JSON.stringify(rawData ?? {});
      byteLength = Buffer.byteLength(payloadStr, "utf8");
    }
    const maxBytes = Number(config.maxPayloadSizeBytes) || 100 * 1024;
    if (byteLength > maxBytes) {
      return {
        allowed: false,
        duplicate: false,
        code: "PAYLOAD_TOO_LARGE",
        reason: `PAYLOAD_TOO_LARGE: Payload (${(byteLength / 1024).toFixed(1)} KB) exceeds limit of ${(maxBytes / 1024).toFixed(0)} KB`,
      };
    }

    // 3. Rate limit check
    const effectiveLimit = Math.min(
      Number(clientRateLimit) || 100,
      Number(config.maxEventsPerSec) || 100,
    );
    const rl = rateLimitMap.get(clientId);
    if (!rl || now - rl.start >= 1000) {
      rateLimitMap.set(clientId, { count: 1, start: now });
    } else if (rl.count >= effectiveLimit) {
      return {
        allowed: false,
        duplicate: false,
        code: "RATE_LIMIT_EXCEEDED",
        reason: `RATE_LIMIT_EXCEEDED: Limit of ${effectiveLimit} events/sec exceeded`,
      };
    } else {
      rl.count += 1;
    }

    // 4. Record idempotency key ONLY after event passes all checks
    if (config.enableIdempotency && eventId) {
      idempotencyMap.set(idempotencyKey, now);
    }

    return { allowed: true, payloadStr };
  }

  async function validateSingleEventAsync(
    clientId,
    eventId,
    rawData,
    clientRateLimit,
  ) {
    const redis = getRedisClient();
    if (!supportsSharedSecurityRedis(redis)) {
      return validateSingleEventLocal(
        clientId,
        eventId,
        rawData,
        clientRateLimit,
      );
    }

    const config = getRuntimeConfig();
    const now = Date.now();
    cleanupMaps(now);
    const idempotencyKey = `${clientId}:${eventId}`;
    const redisIdemKey = `${REDIS_IDEMPOTENCY_PREFIX}${clientId}:${eventId}`;

    try {
      // 1. Read-only idempotency check
      if (config.enableIdempotency && eventId) {
        const localTime = idempotencyMap.get(idempotencyKey);
        if (localTime && now - localTime < IDEMPOTENCY_TTL_MS) {
          return {
            allowed: false,
            duplicate: true,
            code: "DUPLICATE_EVENT",
            reason: "Duplicate event dropped",
          };
        }
        const existing = await redis.get(redisIdemKey);
        if (existing !== null) {
          idempotencyMap.set(idempotencyKey, now);
          return {
            allowed: false,
            duplicate: true,
            code: "DUPLICATE_EVENT",
            reason: "Duplicate event dropped",
          };
        }
      }

      // 2. Payload byte size check
      const payloadStr =
        typeof rawData === "string" ? rawData : JSON.stringify(rawData ?? {});
      const byteLength = Buffer.byteLength(payloadStr, "utf8");
      const maxBytes = Number(config.maxPayloadSizeBytes) || 100 * 1024;
      if (byteLength > maxBytes) {
        return {
          allowed: false,
          duplicate: false,
          code: "PAYLOAD_TOO_LARGE",
          reason: `PAYLOAD_TOO_LARGE: Payload (${(byteLength / 1024).toFixed(1)} KB) exceeds limit of ${(maxBytes / 1024).toFixed(0)} KB`,
        };
      }

      // 3. Shared atomic Redis rate limit check (single Lua round-trip)
      const effectiveLimit = Math.min(
        Number(clientRateLimit) || 100,
        Number(config.maxEventsPerSec) || 100,
      );
      const windowBucket = Math.floor(now / 1000);
      const rlKey = `${REDIS_RATE_LIMIT_PREFIX}${clientId}:${windowBucket}`;
      let count;
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
      trackLocalRateWindow(clientId, now);

      if (count > effectiveLimit) {
        return {
          allowed: false,
          duplicate: false,
          code: "RATE_LIMIT_EXCEEDED",
          reason: `RATE_LIMIT_EXCEEDED: Limit of ${effectiveLimit} events/sec exceeded`,
        };
      }

      // 4. Atomic claim of idempotency key after all checks succeed
      if (config.enableIdempotency && eventId) {
        const claimed = await redis.set(
          redisIdemKey,
          "1",
          "PX",
          IDEMPOTENCY_TTL_MS,
          "NX",
        );
        idempotencyMap.set(idempotencyKey, now);
        if (claimed !== "OK") {
          return {
            allowed: false,
            duplicate: true,
            code: "DUPLICATE_EVENT",
            reason: "Duplicate event dropped",
          };
        }
      }

      return { allowed: true, payloadStr };
    } catch {
      return validateSingleEventLocal(
        clientId,
        eventId,
        rawData,
        clientRateLimit,
      );
    }
  }

  // Middleware: Handshake Auth
  io.use(async (socket, next) => {
    const authHeader =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization ||
      socket.handshake.query?.token;

    if (!authHeader) {
      return next(new Error("AUTH_REQUIRED: Handshake missing JWT"));
    }

    try {
      const cleanToken = String(authHeader).startsWith("Bearer ")
        ? String(authHeader).slice(7).trim()
        : String(authHeader).trim();
      const config = getRuntimeConfig();
      const minSecretLen = process.env.NODE_ENV === "production" ? 32 : 1;
      if (!config.jwtSecret || config.jwtSecret.length < minSecretLen) {
        return next(
          new Error("AUTH_UNAVAILABLE: DATASTACK_JWT_SECRET is not configured"),
        );
      }
      const decoded = jwt.verify(cleanToken, config.jwtSecret);

      const normalizedClientId = normalizeClientId(decoded.clientId);
      const clientIp = extractSocketClientIp(socket);
      const dbCheck = await verifyClientInDb(
        normalizedClientId,
        cleanToken,
        true,
        clientIp,
      );
      if (!dbCheck.allowed) {
        const errCode = dbCheck.code || "CLIENT_REVOKED";
        dispatchRejectionWebhook(errCode, dbCheck.reason, normalizedClientId, {
          transport: "socketio_handshake",
          clientIp,
        });
        return next(new Error(dbCheck.reason || errCode));
      }

      socket.data.clientId = normalizedClientId;
      socket.data.token = cleanToken;
      socket.data.clientIp = clientIp;
      socket.data.rateLimit =
        dbCheck.rateLimit || decoded.rateLimit || config.maxEventsPerSec || 100;
      next();
    } catch (err) {
      next(new Error(`AUTH_INVALID: ${err.message}`));
    }
  });

  const ENVELOPE_KEYS = new Set(["eventId", "timestamp", "data", "clientId"]);
  function extractBatchItemData(safeItem) {
    return extractSingleEventData(safeItem);
  }

  function extractSingleEventData(rawPayload) {
    if (
      rawPayload === null ||
      rawPayload === undefined ||
      typeof rawPayload !== "object" ||
      Array.isArray(rawPayload)
    ) {
      return rawPayload === undefined ? {} : rawPayload;
    }

    if (rawPayload.data !== undefined) {
      const keys = Object.keys(rawPayload);
      if (keys.every((k) => ENVELOPE_KEYS.has(k))) {
        return rawPayload.data;
      }
      return rawPayload;
    }

    const stripped = {};
    let hasNonEnvelopeKey = false;
    for (const [k, v] of Object.entries(rawPayload)) {
      if (k === "eventId" || k === "timestamp" || k === "clientId") {
        continue;
      }
      hasNonEnvelopeKey = true;
      stripped[k] = v;
    }
    return hasNonEnvelopeKey ? stripped : {};
  }

  io.on("connection", (socket) => {
    const clientId = socket.data.clientId;
    socket.join(`client:${clientId}`);

    // Single event
    socket.on("sync_data", async (payload, callback) => {
      try {
        const clientIp = socket.data.clientIp || extractSocketClientIp(socket);
        const dbCheck = await verifyClientInDb(
          clientId,
          socket.data.token,
          false,
          clientIp,
        );
        if (!dbCheck.allowed) {
          const errCode = dbCheck.code || "CLIENT_REVOKED";
          dispatchRejectionWebhook(errCode, dbCheck.reason, clientId, {
            transport: "socketio_sync_data",
            clientIp,
          });
          if (callback) {
            callback({
              success: false,
              code: errCode,
              error: dbCheck.reason || "CLIENT_REVOKED",
            });
          }
          socket.disconnect(true);
          return;
        }

        if (worker && typeof worker.checkStorageAdmission === "function") {
          const config = getRuntimeConfig();
          const admission = await worker.checkStorageAdmission(
            clientId,
            dbCheck.storageQuotaMb || 0,
            config.diskPauseThresholdPct ?? 95,
          );
          if (!admission.allowed) {
            dispatchRejectionWebhook(admission.code, admission.reason, clientId, {
              transport: "socketio_sync_data",
              clientIp,
            });
            if (callback) {
              callback({
                success: false,
                code: admission.code,
                error: admission.reason,
              });
            }
            return;
          }
        }

        const effectiveClientRate =
          dbCheck.rateLimit || socket.data.rateLimit || 100;
        const safePayload =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? payload
            : {};
        const eventId =
          typeof safePayload.eventId === "string" && safePayload.eventId.trim()
            ? safePayload.eventId.trim()
            : generateFallbackEventId();
        const timestamp =
          typeof safePayload.timestamp === "string" &&
          safePayload.timestamp.trim()
            ? safePayload.timestamp.trim()
            : new Date().toISOString();
        const eventData = extractSingleEventData(payload);

        const check = await validateSingleEventAsync(
          clientId,
          eventId,
          eventData,
          effectiveClientRate,
        );
        if (!check.allowed) {
          if (check.duplicate) {
            if (callback) {
              callback({ success: true, eventId, note: "DUPLICATE_DROPPED" });
            }
            return;
          }
          if (callback) {
            callback({
              success: false,
              eventId,
              code: check.code,
              error: check.reason,
            });
          }
          return;
        }

        const event = {
          clientId,
          eventId,
          timestamp,
          payload: check.payloadStr,
        };

        bufferQueue.push(event);
        recordClientActivity(clientId, 1);
        try {
          await onBufferPush();
        } catch (persistErr) {
          if (callback) {
            callback({
              success: false,
              eventId,
              code: "BUFFER_PERSIST_FAILED",
              error:
                persistErr instanceof Error
                  ? persistErr.message
                  : "Failed to persist event to buffer",
            });
          }
          return;
        }

        if (callback) callback({ success: true, eventId });
      } catch (err) {
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Batch event
    socket.on("batch_sync", async (batch, callback) => {
      try {
        if (!Array.isArray(batch)) {
          if (callback) callback({ success: false, error: "Expected array" });
          return;
        }

        const clientIp = socket.data.clientIp || extractSocketClientIp(socket);
        const dbCheck = await verifyClientInDb(
          clientId,
          socket.data.token,
          false,
          clientIp,
        );
        if (!dbCheck.allowed) {
          const errCode = dbCheck.code || "CLIENT_REVOKED";
          dispatchRejectionWebhook(errCode, dbCheck.reason, clientId, {
            transport: "socketio_batch_sync",
            clientIp,
          });
          if (callback) {
            callback({
              success: false,
              processed: 0,
              rejected: batch.length,
              code: errCode,
              error: dbCheck.reason || "CLIENT_REVOKED",
            });
          }
          socket.disconnect(true);
          return;
        }

        if (worker && typeof worker.checkStorageAdmission === "function") {
          const config = getRuntimeConfig();
          const admission = await worker.checkStorageAdmission(
            clientId,
            dbCheck.storageQuotaMb || 0,
            config.diskPauseThresholdPct ?? 95,
          );
          if (!admission.allowed) {
            dispatchRejectionWebhook(admission.code, admission.reason, clientId, {
              transport: "socketio_batch_sync",
              clientIp,
            });
            if (callback) {
              callback({
                success: false,
                processed: 0,
                rejected: batch.length,
                code: admission.code,
                error: admission.reason,
              });
            }
            return;
          }
        }

        const effectiveClientRate =
          dbCheck.rateLimit || socket.data.rateLimit || 100;
        let processed = 0;
        let rejected = 0;
        let duplicates = 0;
        let hitRateLimit = false;
        let hitPayloadLimit = false;
        const rateLimitedEventIds = [];
        const oversizedEventIds = [];
        const errors = [];

        for (const item of batch) {
          const safeItem = item && typeof item === "object" ? item : {};
          const eventId =
            typeof safeItem.eventId === "string" && safeItem.eventId.trim()
              ? safeItem.eventId.trim()
              : generateFallbackEventId();
          const timestamp =
            typeof safeItem.timestamp === "string" && safeItem.timestamp.trim()
              ? safeItem.timestamp.trim()
              : new Date().toISOString();
          const rawData = extractBatchItemData(safeItem);

          const check = await validateSingleEventAsync(
            clientId,
            eventId,
            rawData,
            effectiveClientRate,
          );
          if (!check.allowed) {
            if (check.duplicate) {
              duplicates += 1;
              continue;
            }
            rejected += 1;
            if (check.code === "RATE_LIMIT_EXCEEDED") {
              hitRateLimit = true;
              rateLimitedEventIds.push(eventId);
            }
            if (check.code === "PAYLOAD_TOO_LARGE") {
              hitPayloadLimit = true;
              oversizedEventIds.push(eventId);
            }
            if (errors.length < 5) {
              errors.push(`${eventId}: ${check.reason}`);
            }
            continue;
          }

          bufferQueue.push({
            clientId,
            eventId,
            timestamp,
            payload: check.payloadStr,
          });
          processed += 1;
        }

        if (processed > 0) {
          recordClientActivity(clientId, processed);
          try {
            await onBufferPush();
          } catch (persistErr) {
            if (callback) {
              callback({
                success: false,
                processed: 0,
                rejected: batch.length,
                duplicates,
                code: "BUFFER_PERSIST_FAILED",
                error:
                  persistErr instanceof Error
                    ? persistErr.message
                    : "Failed to persist batch to buffer",
              });
            }
            return;
          }
        }

        if (processed === 0 && duplicates === 0 && rejected > 0) {
          const code = hitPayloadLimit
            ? "PAYLOAD_TOO_LARGE"
            : hitRateLimit
              ? "RATE_LIMIT_EXCEEDED"
              : "BATCH_REJECTED";
          if (callback) {
            callback({
              success: false,
              processed,
              rejected,
              duplicates,
              code,
              error: errors[0] || "Batch validation failed",
              errors,
              ...(rateLimitedEventIds.length > 0 ? { rateLimitedEventIds } : {}),
              ...(oversizedEventIds.length > 0 ? { oversizedEventIds } : {}),
            });
          }
          return;
        }

        if (callback) {
          callback({
            success: true,
            processed,
            rejected,
            duplicates,
            ...(rateLimitedEventIds.length > 0 ? { rateLimitedEventIds } : {}),
            ...(oversizedEventIds.length > 0 ? { oversizedEventIds } : {}),
            ...(errors.length > 0 ? { errors } : {}),
          });
        }
      } catch (err) {
        if (callback) {
          callback({
            success: false,
            processed: 0,
            rejected: Array.isArray(batch) ? batch.length : 0,
            error: err.message,
          });
        }
      }
    });

    // Heartbeat & Reconnection Verification Event
    socket.on("ping_verify", async (_payload, callback) => {
      try {
        const clientIp = socket.data.clientIp || extractSocketClientIp(socket);
        const dbCheck = await verifyClientInDb(
          clientId,
          socket.data.token,
          true,
          clientIp,
        );
        if (!dbCheck.allowed) {
          const errCode = dbCheck.code || "CLIENT_REVOKED";
          dispatchRejectionWebhook(errCode, dbCheck.reason, clientId, {
            transport: "socketio_ping_verify",
            clientIp,
          });
          if (callback) {
            callback({
              success: false,
              status: "REVOKED",
              code: errCode,
              error: dbCheck.reason || "CLIENT_REVOKED",
            });
          }
          socket.disconnect(true);
          return;
        }
        const config = getRuntimeConfig();
        if (callback) {
          callback({
            success: true,
            status: "VERIFIED",
            clientId,
            rateLimit: dbCheck.rateLimit || socket.data.rateLimit || 100,
            maxPayloadSizeBytes: config.maxPayloadSizeBytes,
            serverTime: new Date().toISOString(),
          });
        }
      } catch (err) {
        if (callback) {
          callback({
            success: false,
            status: "ERROR",
            error: err.message,
          });
        }
      }
    });
  });

  return {
    getSecurityStats,
    validateSingleEventLocal,
  };
}

module.exports = { setupSocketHandlers, normalizeClientId, extractSocketClientIp };
