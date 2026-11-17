const jwt = require("jsonwebtoken");

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_MAX_ENTRIES = 20000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

function setupSocketHandlers(io, bufferQueue, worker, options = {}) {
  const getRuntimeConfig =
    typeof options.getRuntimeConfig === "function"
      ? options.getRuntimeConfig
      : () => ({
          jwtSecret:
            options.jwtSecret ||
            process.env.DATASTACK_JWT_SECRET ||
            "datastack-jwt-default-secret-key-32-chars-long",
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

  const idempotencyMap = new Map();
  const rateLimitMap = new Map();
  let lastCleanupAt = Date.now();

  function cleanupMaps(now) {
    if (
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

  function validateSingleEvent(clientId, eventId, rawData, clientRateLimit) {
    const config = getRuntimeConfig();
    const now = Date.now();
    cleanupMaps(now);

    // 1. Idempotency check (with 5-minute TTL)
    if (config.enableIdempotency && eventId) {
      const key = `${clientId}:${eventId}`;
      const existingTime = idempotencyMap.get(key);
      if (existingTime && now - existingTime < IDEMPOTENCY_TTL_MS) {
        return {
          allowed: false,
          duplicate: true,
          code: "DUPLICATE_EVENT",
          reason: "Duplicate event dropped",
        };
      }
      idempotencyMap.set(key, now);
    }

    // 2. Rate limit check
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

    // 3. Payload byte size check
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

    return { allowed: true, payloadStr };
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
      const decoded = jwt.verify(cleanToken, config.jwtSecret);

      const dbCheck = await verifyClientInDb(
        decoded.clientId,
        cleanToken,
        true,
      );
      if (!dbCheck.allowed) {
        return next(new Error(dbCheck.reason || "CLIENT_REVOKED"));
      }

      socket.data.clientId = decoded.clientId;
      socket.data.token = cleanToken;
      socket.data.rateLimit =
        dbCheck.rateLimit || decoded.rateLimit || config.maxEventsPerSec || 100;
      next();
    } catch (err) {
      next(new Error(`AUTH_INVALID: ${err.message}`));
    }
  });

  io.on("connection", (socket) => {
    const clientId = socket.data.clientId;
    socket.join(`client:${clientId}`);

    // Single event
    socket.on("sync_data", async (payload, callback) => {
      try {
        const dbCheck = await verifyClientInDb(
          clientId,
          socket.data.token,
          false,
        );
        if (!dbCheck.allowed) {
          if (callback) {
            callback({
              success: false,
              code: "CLIENT_REVOKED",
              error: dbCheck.reason || "CLIENT_REVOKED",
            });
          }
          socket.disconnect(true);
          return;
        }

        const effectiveClientRate =
          dbCheck.rateLimit || socket.data.rateLimit || 100;
        const safePayload = payload && typeof payload === "object" ? payload : {};
        const eventId =
          safePayload.eventId ||
          `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const timestamp = safePayload.timestamp || new Date().toISOString();

        const check = validateSingleEvent(
          clientId,
          eventId,
          safePayload.data,
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
        onBufferPush();

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

        const dbCheck = await verifyClientInDb(
          clientId,
          socket.data.token,
          false,
        );
        if (!dbCheck.allowed) {
          if (callback) {
            callback({
              success: false,
              processed: 0,
              rejected: batch.length,
              code: "CLIENT_REVOKED",
              error: dbCheck.reason || "CLIENT_REVOKED",
            });
          }
          socket.disconnect(true);
          return;
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
            safeItem.eventId ||
            `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          const timestamp = safeItem.timestamp || new Date().toISOString();
          const rawData =
            safeItem.data !== undefined ? safeItem.data : safeItem;

          const check = validateSingleEvent(
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
          onBufferPush();
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
        const dbCheck = await verifyClientInDb(
          clientId,
          socket.data.token,
          true,
        );
        if (!dbCheck.allowed) {
          if (callback) {
            callback({
              success: false,
              status: "REVOKED",
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
}

module.exports = { setupSocketHandlers };
