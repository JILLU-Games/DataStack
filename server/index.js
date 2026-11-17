const crypto = require('node:crypto');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { setupSocketHandlers } = require('./socket/handlers');
const { CsvWriterWorker } = require('./workers/csvWriter');

const PORT = Number(process.env.PORT_SOCKET) || 4000;
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const REDIS_BUFFER_KEY = 'datastack:buffer:events';
const REDIS_RECENT_KEY = 'datastack:recent:events';
const REDIS_FLUSH_LOCK_KEY = 'datastack:flush:lock';
const REDIS_RECENT_LIMIT = 500;
const FLUSH_LOCK_TTL_MS = 15000;
const UNLOCK_LUA_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const bufferQueue = [];
const writer = new CsvWriterWorker();
let redisClient = undefined;
let redisUrlConfigured = '';
let redisConnected = false;
let redisTestOverride = undefined;
const pendingRedisWrites = new Set();

function getRedisClient() {
  if (redisTestOverride !== undefined) {
    return redisTestOverride;
  }

  const configuredUrl = (process.env.REDIS_URL || '').trim();
  if (!configuredUrl) {
    if (redisClient && typeof redisClient.disconnect === 'function') {
      try {
        redisClient.disconnect();
      } catch {
        // ignore
      }
    }
    redisClient = null;
    redisUrlConfigured = '';
    redisConnected = false;
    return null;
  }

  if (redisClient && redisUrlConfigured === configuredUrl) {
    return redisClient;
  }

  if (redisClient && typeof redisClient.disconnect === 'function') {
    try {
      redisClient.disconnect();
    } catch {
      // ignore
    }
  }

  try {
    const client = new Redis(configuredUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 250, 3000),
    });
    client.on('ready', () => {
      redisConnected = true;
    });
    client.on('connect', () => {
      redisConnected = true;
    });
    client.on('close', () => {
      redisConnected = false;
    });
    client.on('end', () => {
      redisConnected = false;
    });
    client.on('error', () => {
      redisConnected = false;
    });
    redisClient = client;
    redisUrlConfigured = configuredUrl;
    redisConnected = client.status === 'ready' || client.status === 'connect';
    return redisClient;
  } catch {
    redisClient = null;
    redisUrlConfigured = configuredUrl;
    redisConnected = false;
    return null;
  }
}

function setRedisClientForTests(client) {
  redisTestOverride = client;
  redisConnected = Boolean(client);
}

async function pushEventsToRedisOrFallback(events) {
  if (!events || events.length === 0) return bufferQueue.length;
  const redis = getRedisClient();
  if (redis) {
    const serialized = events.map((e) => JSON.stringify(e));
    try {
      const len = await redis.rpush(REDIS_BUFFER_KEY, ...serialized);
      await redis.lpush(REDIS_RECENT_KEY, ...serialized);
      await redis.ltrim(REDIS_RECENT_KEY, 0, REDIS_RECENT_LIMIT - 1);
      redisConnected = true;
      return Number(len) + bufferQueue.length;
    } catch {
      redisConnected = false;
    }
  }

  bufferQueue.push(...events);
  return bufferQueue.length;
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_DEFAULT_JWT_SECRET = 'datastack-jwt-default-secret-key-32-chars-long';

function resolveInitialJwtSecret() {
  const configured = (process.env.DATASTACK_JWT_SECRET || '').trim();
  if (IS_PRODUCTION) {
    return configured.length >= 32 ? configured : '';
  }
  if (configured.length > 0) {
    return configured.length >= 32 ? configured : '';
  }
  return DEV_DEFAULT_JWT_SECRET;
}

const runtimeConfig = {
  jwtSecret: resolveInitialJwtSecret(),
  maxEventsPerSec: 100,
  maxPayloadSizeBytes: 100 * 1024,
  batchFlushThreshold: 500,
  batchFlushIntervalMs: 2000,
  fileRotationMb: 100,
  enableIdempotency: true,
  autoPruneDays: 30,
};

function resolveInternalSecret(jwtSecretOverride) {
  const explicit = (process.env.DATASTACK_INTERNAL_SECRET || '').trim();
  if (IS_PRODUCTION) {
    if (explicit.length >= 32) return explicit;
    if (explicit.length > 0) return '';
  } else if (explicit.length > 0) {
    return explicit;
  }
  const activeJwt = String(
    jwtSecretOverride !== undefined ? jwtSecretOverride : runtimeConfig.jwtSecret || '',
  ).trim();
  const minJwtLen = IS_PRODUCTION ? 32 : 1;
  if (activeJwt.length < minJwtLen) {
    return '';
  }
  return crypto
    .createHash('sha256')
    .update(`datastack-internal:${activeJwt}`)
    .digest('hex');
}

function timingSafeSecretEqual(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireInternalAuth(req, res, next) {
  const expected = resolveInternalSecret();
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'INTERNAL_AUTH_UNAVAILABLE: Internal bridge secret is not configured',
      code: 'INTERNAL_AUTH_UNAVAILABLE',
    });
  }
  const presented = req.get('x-datastack-internal-secret');
  if (!presented || !timingSafeSecretEqual(presented, expected)) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED: Missing or invalid internal authentication header',
      code: 'UNAUTHORIZED',
    });
  }
  return next();
}

let dbPool = null;
if (process.env.DATABASE_URL) {
  try {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      max: 5,
    });
  } catch {
    dbPool = null;
  }
}

// Short-lived cache (2s TTL) for DB client status & token checks on high-frequency events
const clientAuthCache = new Map();
const deletedClientsSet = new Set();
const inMemoryClientRegistry = new Map();
const inMemoryClientActivity = new Map();
let hasSyncedInMemoryClients = false;
const CLIENT_CACHE_TTL_MS = 2000;

async function verifyClientInDb(clientId, presentedToken, bypassCache = false) {
  if (!clientId) {
    return { allowed: true };
  }

  const normalizedId = String(clientId).trim().toLowerCase();
  if (deletedClientsSet.has(normalizedId)) {
    return {
      allowed: false,
      reason: 'CLIENT_REVOKED: Client access has been deleted or revoked by admin',
    };
  }

  if (!dbPool) {
    const memClient = inMemoryClientRegistry.get(normalizedId);
    if (memClient) {
      if (memClient.status === 'revoked') {
        return {
          allowed: false,
          reason: 'CLIENT_REVOKED: Client access has been revoked by admin',
        };
      }
      if (memClient.token && presentedToken && memClient.token !== presentedToken) {
        return {
          allowed: false,
          reason: 'TOKEN_ROTATED: Client credentials have been rotated',
        };
      }
      return { allowed: true, rateLimit: memClient.rateLimit || 100 };
    }
    if (hasSyncedInMemoryClients) {
      return {
        allowed: false,
        reason: 'CLIENT_REVOKED: Client registration not found or has been deleted',
      };
    }
    return { allowed: true };
  }

  const now = Date.now();
  const prevCached = clientAuthCache.get(normalizedId);
  if (!bypassCache && prevCached && now - prevCached.checkedAt < CLIENT_CACHE_TTL_MS) {
    if (prevCached.status === 'revoked') {
      return {
        allowed: false,
        reason: 'CLIENT_REVOKED: Client access has been revoked by admin',
      };
    }
    if (prevCached.token && presentedToken && prevCached.token !== presentedToken) {
      return {
        allowed: false,
        reason: 'TOKEN_ROTATED: Client credentials have been rotated',
      };
    }
    return { allowed: true, rateLimit: prevCached.rateLimit };
  }

  try {
    const deletedRes = await dbPool.query(
      `SELECT 1 FROM deleted_clients WHERE client_id = $1`,
      [normalizedId],
    );
    if (deletedRes.rowCount && deletedRes.rowCount > 0) {
      clientAuthCache.delete(normalizedId);
      deletedClientsSet.add(normalizedId);
      return {
        allowed: false,
        reason: 'CLIENT_REVOKED: Client access has been deleted by admin',
      };
    }

    const res = await dbPool.query(
      `SELECT status, token, rate_limit FROM client_sdks WHERE client_id = $1`,
      [normalizedId],
    );
    if (!res.rowCount || res.rowCount === 0) {
      clientAuthCache.delete(normalizedId);
      return {
        allowed: false,
        reason: 'CLIENT_REVOKED: Client registration not found or has been deleted',
      };
    }
    const row = res.rows[0];
    const entry = {
      status: row.status,
      token: row.token,
      rateLimit: Number(row.rate_limit) || 100,
      checkedAt: now,
    };
    clientAuthCache.set(normalizedId, entry);

    if (entry.status === 'revoked') {
      return {
        allowed: false,
        reason: 'CLIENT_REVOKED: Client access has been revoked by admin',
      };
    }
    if (entry.token && presentedToken && entry.token !== presentedToken) {
      return {
        allowed: false,
        reason: 'TOKEN_ROTATED: Client credentials have been rotated',
      };
    }
    return { allowed: true, rateLimit: entry.rateLimit };
  } catch {
    return {
      allowed: false,
      reason: 'AUTH_UNAVAILABLE: Unable to verify client credentials against database',
    };
  }
}

function recordClientActivity(clientId, count = 1) {
  if (!clientId || count <= 0) return;
  const normalizedId = String(clientId).trim().toLowerCase();
  const nowIso = new Date().toISOString();

  if (!dbPool) {
    const prev = inMemoryClientActivity.get(normalizedId) || {
      totalEvents: 0,
      lastActive: nowIso,
    };
    inMemoryClientActivity.set(normalizedId, {
      totalEvents: prev.totalEvents + count,
      lastActive: nowIso,
    });
    return;
  }

  dbPool
    .query(
      `UPDATE client_sdks
       SET total_events = total_events + $2,
           last_active = $3,
           updated_at = NOW()
       WHERE client_id = $1`,
      [normalizedId, count, nowIso],
    )
    .catch(() => undefined);
}

let isFlushing = false;
let flushTimer = null;

async function flushBuffer() {
  if (pendingRedisWrites.size > 0) {
    await Promise.allSettled([...pendingRedisWrites]);
  }
  if (isFlushing) {
    return { written: 0, files: [] };
  }
  isFlushing = true;
  let totalWritten = 0;
  const filesSet = new Set();

  try {
    const redis = getRedisClient();
    if (redis) {
      const lockToken = crypto.randomUUID();
      let lockAcquired = false;

      try {
        const lockResult = await redis.set(
          REDIS_FLUSH_LOCK_KEY,
          lockToken,
          'PX',
          FLUSH_LOCK_TTL_MS,
          'NX',
        );
        lockAcquired = lockResult === 'OK';
        redisConnected = true;
      } catch {
        redisConnected = false;
        lockAcquired = false;
      }

      if (lockAcquired) {
        try {
          const chunkSize = Math.max(500, runtimeConfig.batchFlushThreshold);
          while (true) {
            const rawItems = await redis.lrange(REDIS_BUFFER_KEY, 0, chunkSize - 1);
            if (!rawItems || rawItems.length === 0) {
              break;
            }

            const parsedBatch = [];
            for (const raw of rawItems) {
              try {
                const evt = JSON.parse(raw);
                if (evt && evt.eventId) {
                  parsedBatch.push(evt);
                }
              } catch {
                // Skip malformed entry while still trimming consumed range
              }
            }

            if (parsedBatch.length > 0) {
              const res = await writer.writeBatch(parsedBatch);
              totalWritten += res.written;
              for (const f of res.files) filesSet.add(f);
            }

            // Trim ONLY after CSV batch write succeeds
            await redis.ltrim(REDIS_BUFFER_KEY, rawItems.length, -1);

            if (rawItems.length < chunkSize) {
              break;
            }
          }
        } finally {
          try {
            await redis.eval(UNLOCK_LUA_SCRIPT, 1, REDIS_FLUSH_LOCK_KEY, lockToken);
          } catch {
            // Lock expires automatically via PX TTL
          }
        }
      }
    }

    if (bufferQueue.length > 0) {
      const batch = bufferQueue.splice(0, bufferQueue.length);
      try {
        const res = await writer.writeBatch(batch);
        totalWritten += res.written;
        for (const f of res.files) filesSet.add(f);
      } catch (err) {
        bufferQueue.unshift(...batch);
        throw err;
      }
    }

    const files = Array.from(filesSet);
    if (totalWritten > 0) {
      console.log(
        `[CSV Worker] Flushed ${totalWritten} events to ${files.length} file(s)`,
      );
    }
    return { written: totalWritten, files };
  } catch (err) {
    console.error('[CSV Worker] Flush error:', err);
    return { written: totalWritten, files: Array.from(filesSet) };
  } finally {
    isFlushing = false;
  }
}

function scheduleFlushTimer(intervalMs) {
  const safeInterval = Math.max(100, Number(intervalMs) || 2000);
  runtimeConfig.batchFlushIntervalMs = safeInterval;
  if (flushTimer) {
    clearInterval(flushTimer);
  }
  flushTimer = setInterval(() => {
    void flushBuffer();
  }, safeInterval);
}

scheduleFlushTimer(runtimeConfig.batchFlushIntervalMs);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

function applyRuntimeSettingsObject(settingsObj) {
  if (!settingsObj || typeof settingsObj !== 'object') {
    return { jwtRotated: false };
  }

  if (settingsObj.maxEventsPerSec !== undefined) {
    const val = Number(settingsObj.maxEventsPerSec);
    if (Number.isFinite(val) && val >= 1) {
      runtimeConfig.maxEventsPerSec = Math.floor(val);
    }
  }

  if (settingsObj.maxPayloadSizeKb !== undefined) {
    const kb = Number(settingsObj.maxPayloadSizeKb);
    if (Number.isFinite(kb) && kb >= 1) {
      runtimeConfig.maxPayloadSizeBytes = Math.floor(kb) * 1024;
    }
  }

  if (settingsObj.batchFlushThreshold !== undefined) {
    const threshold = Number(settingsObj.batchFlushThreshold);
    if (Number.isFinite(threshold) && threshold >= 1) {
      runtimeConfig.batchFlushThreshold = Math.floor(threshold);
    }
  }

  if (settingsObj.enableIdempotency !== undefined) {
    runtimeConfig.enableIdempotency = Boolean(settingsObj.enableIdempotency);
  }

  if (settingsObj.fileRotationMb !== undefined) {
    const nextRotationMb = Number(settingsObj.fileRotationMb);
    if (
      Number.isFinite(nextRotationMb) &&
      nextRotationMb >= 1 &&
      nextRotationMb !== runtimeConfig.fileRotationMb
    ) {
      runtimeConfig.fileRotationMb = nextRotationMb;
      writer.setMaxFileSizeMb(nextRotationMb);
    }
  }

  if (settingsObj.autoPruneDays !== undefined && settingsObj.autoPruneDays !== null) {
    const parsedPrune = Number(settingsObj.autoPruneDays);
    if (Number.isFinite(parsedPrune) && parsedPrune >= 0) {
      const nextPruneDays = Math.floor(parsedPrune);
      const changed = nextPruneDays !== runtimeConfig.autoPruneDays;
      runtimeConfig.autoPruneDays = nextPruneDays;
      if (changed && nextPruneDays > 0) {
        writer.pruneExpiredPartitions(nextPruneDays);
      }
    }
  }

  if (settingsObj.batchFlushIntervalMs !== undefined) {
    const nextIntervalMs = Math.max(
      100,
      Number(settingsObj.batchFlushIntervalMs) || 2000,
    );
    if (nextIntervalMs !== runtimeConfig.batchFlushIntervalMs) {
      scheduleFlushTimer(nextIntervalMs);
    }
  }

  let jwtRotated = false;
  if (settingsObj.jwtSecret !== undefined && settingsObj.jwtSecret !== null) {
    const candidateSecret = String(settingsObj.jwtSecret).trim();
    const validSecret =
      candidateSecret.length >= 32 ||
      (!IS_PRODUCTION && candidateSecret.length > 0);
    if (validSecret && candidateSecret !== runtimeConfig.jwtSecret) {
      runtimeConfig.jwtSecret = candidateSecret;
      clientAuthCache.clear();
      io.disconnectSockets(true);
      jwtRotated = true;
    }
  }

  return { jwtRotated };
}

async function ensureDatabaseSchema() {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS client_sdks (
        client_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        token TEXT NOT NULL,
        rate_limit INTEGER NOT NULL DEFAULT 100,
        status TEXT NOT NULL DEFAULT 'active',
        total_events BIGINT NOT NULL DEFAULT 0,
        last_active TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        id TEXT PRIMARY KEY DEFAULT 'default',
        server_port INTEGER NOT NULL DEFAULT 4000,
        web_port INTEGER NOT NULL DEFAULT 3000,
        max_events_per_sec INTEGER NOT NULL DEFAULT 100,
        max_payload_size_kb INTEGER NOT NULL DEFAULT 100,
        batch_flush_threshold INTEGER NOT NULL DEFAULT 500,
        batch_flush_interval_ms INTEGER NOT NULL DEFAULT 2000,
        file_rotation_mb INTEGER NOT NULL DEFAULT 100,
        jwt_secret TEXT NOT NULL,
        enable_idempotency BOOLEAN NOT NULL DEFAULT true,
        auto_prune_days INTEGER NOT NULL DEFAULT 30,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS deleted_clients (
        client_id TEXT PRIMARY KEY,
        deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dbPool.query(`
      ALTER TABLE client_sdks
        ADD COLUMN IF NOT EXISTS rate_limit INTEGER NOT NULL DEFAULT 100,
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS total_events BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    await dbPool.query(`
      ALTER TABLE admin_settings
        ADD COLUMN IF NOT EXISTS server_port INTEGER NOT NULL DEFAULT 4000,
        ADD COLUMN IF NOT EXISTS web_port INTEGER NOT NULL DEFAULT 3000,
        ADD COLUMN IF NOT EXISTS max_events_per_sec INTEGER NOT NULL DEFAULT 100,
        ADD COLUMN IF NOT EXISTS max_payload_size_kb INTEGER NOT NULL DEFAULT 100,
        ADD COLUMN IF NOT EXISTS batch_flush_threshold INTEGER NOT NULL DEFAULT 500,
        ADD COLUMN IF NOT EXISTS batch_flush_interval_ms INTEGER NOT NULL DEFAULT 2000,
        ADD COLUMN IF NOT EXISTS file_rotation_mb INTEGER NOT NULL DEFAULT 100,
        ADD COLUMN IF NOT EXISTS enable_idempotency BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS auto_prune_days INTEGER NOT NULL DEFAULT 30,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
  } catch {
    // Ignore transient startup DB error; retried on next sync cycle
  }
}

async function syncSettingsFromDatabase() {
  if (!dbPool) return;
  try {
    await ensureDatabaseSchema();
    const res = await dbPool.query(
      `SELECT max_events_per_sec, max_payload_size_kb, batch_flush_threshold,
              batch_flush_interval_ms, file_rotation_mb, jwt_secret, enable_idempotency,
              auto_prune_days
       FROM admin_settings
       WHERE id = 'default'`,
    );
    if (!res.rowCount || res.rowCount === 0) return;
    const row = res.rows[0];
    const parsedPrune =
      row.auto_prune_days !== undefined && row.auto_prune_days !== null
        ? Number(row.auto_prune_days)
        : NaN;

    applyRuntimeSettingsObject({
      maxEventsPerSec: Number(row.max_events_per_sec) || 100,
      maxPayloadSizeKb: Number(row.max_payload_size_kb) || 100,
      batchFlushThreshold: Math.max(1, Number(row.batch_flush_threshold) || 500),
      batchFlushIntervalMs: Math.max(
        100,
        Number(row.batch_flush_interval_ms) || 2000,
      ),
      fileRotationMb: Number(row.file_rotation_mb) || 100,
      enableIdempotency: Boolean(row.enable_idempotency),
      autoPruneDays: Number.isFinite(parsedPrune) ? parsedPrune : 30,
      jwtSecret: row.jwt_secret ? String(row.jwt_secret).trim() : undefined,
    });
  } catch {
    // Keep existing runtimeConfig if table is not ready yet
  }
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let settingsSyncTimer = null;
let pruneTimer = null;
if (process.env.DATASTACK_DISABLE_LISTEN !== '1') {
  if (dbPool) {
    void syncSettingsFromDatabase();
    settingsSyncTimer = setInterval(() => {
      void syncSettingsFromDatabase();
    }, 3000);
  }
  pruneTimer = setInterval(() => {
    if (runtimeConfig.autoPruneDays > 0) {
      writer.pruneExpiredPartitions(runtimeConfig.autoPruneDays);
    }
  }, PRUNE_INTERVAL_MS);
}

const socketHandlersApi = setupSocketHandlers(io, bufferQueue, writer, {
  getRuntimeConfig: () => runtimeConfig,
  verifyClientInDb,
  recordClientActivity,
  onBufferPush: () => {
    const redis = getRedisClient();
    if (redis && bufferQueue.length > 0) {
      const pushed = bufferQueue.splice(0, bufferQueue.length);
      const op = pushEventsToRedisOrFallback(pushed).then((totalQueued) => {
        if (totalQueued >= runtimeConfig.batchFlushThreshold) {
          void flushBuffer();
        }
      });
      pendingRedisWrites.add(op);
      void op.finally(() => {
        pendingRedisWrites.delete(op);
      });
      return;
    }

    if (bufferQueue.length >= runtimeConfig.batchFlushThreshold) {
      void flushBuffer();
    }
  },
});

async function getRedisBufferLen() {
  const redis = getRedisClient();
  if (!redis) return 0;
  try {
    const len = Number(await redis.llen(REDIS_BUFFER_KEY)) || 0;
    redisConnected = true;
    return len;
  } catch {
    redisConnected = false;
    return 0;
  }
}

// Public health check endpoint
app.get('/health', async (_req, res) => {
  const redisBufferSize = await getRedisBufferLen();
  res.json({
    status: 'online',
    service: 'DataStack Express Ingestion',
    port: PORT,
    activeSockets: io.engine ? io.engine.clientsCount : 0,
    bufferSize: bufferQueue.length + redisBufferSize,
    localBufferSize: bufferQueue.length,
    redisBufferSize,
    redisConnected,
    maxEventsPerSec: runtimeConfig.maxEventsPerSec,
    maxPayloadSizeBytes: runtimeConfig.maxPayloadSizeBytes,
    uptime: process.uptime(),
  });
});

// Require internal shared authentication on all /internal/* bridge endpoints
app.use('/internal', requireInternalAuth);

// Internal metrics endpoint for Next.js dashboard & in-memory client activity aggregation
app.get('/internal/metrics', async (_req, res) => {
  const redisBufferSize = await getRedisBufferLen();
  res.json({
    activeSockets: io.engine ? io.engine.clientsCount : 0,
    bufferSize: bufferQueue.length + redisBufferSize,
    localBufferSize: bufferQueue.length,
    redisBufferSize,
    redisConnected,
    registrySize: inMemoryClientRegistry.size,
    hasSyncedInMemoryClients,
    securityStats: socketHandlersApi.getSecurityStats(),
    clientActivity: Object.fromEntries(inMemoryClientActivity.entries()),
  });
});

// Internal instant settings synchronization triggered by Next.js POST /api/settings
app.post('/internal/settings-sync', (req, res) => {
  const result = applyRuntimeSettingsObject(req.body || {});
  res.json({
    success: true,
    jwtRotated: result.jwtRotated,
  });
});

// Internal flush endpoint triggered by Next.js POST /api/storage & GET /api/export
app.post('/internal/flush', async (_req, res) => {
  try {
    const result = await flushBuffer();
    res.json({
      success: true,
      flushedCount: result.written,
      filesUpdated: result.files,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Flush failed',
    });
  }
});

// Internal endpoint to expose Port 4000 buffered events before CSV flush
app.get('/internal/recent', async (req, res) => {
  const clientId = req.query.clientId ? String(req.query.clientId) : '';
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 50));

  const redis = getRedisClient();
  let redisEvents = [];
  if (redis) {
    try {
      const readCap = Math.min(REDIS_RECENT_LIMIT, Math.max(limit * 2, limit));
      const rawItems = await redis.lrange(REDIS_RECENT_KEY, 0, readCap - 1);
      redisConnected = true;
      for (const raw of rawItems) {
        try {
          const evt = JSON.parse(raw);
          if (!evt || !evt.eventId) continue;
          if (clientId && clientId !== 'all' && evt.clientId !== clientId) continue;
          redisEvents.push(evt);
          if (redisEvents.length >= limit) break;
        } catch {
          // ignore malformed item
        }
      }
    } catch {
      redisConnected = false;
      redisEvents = [];
    }
  }

  const localFiltered =
    clientId && clientId !== 'all'
      ? bufferQueue.filter((evt) => evt.clientId === clientId)
      : bufferQueue;
  const localRecent = localFiltered.slice(-limit).reverse();

  const merged = [];
  const seen = new Set();
  for (const evt of [...localRecent, ...redisEvents]) {
    if (!evt || !evt.eventId) continue;
    const key = `${evt.clientId}:${evt.eventId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(evt);
    if (merged.length >= limit) break;
  }

  res.json({ events: merged, count: merged.length });
});

// Internal endpoint triggered by Next.js SDKManager when a client is deleted, revoked, rotated, or synced
app.post('/internal/client-sync', (req, res) => {
  const action = req.body && req.body.action ? String(req.body.action) : '';

  if (action === 'bulk_sync' && Array.isArray(req.body.clients)) {
    hasSyncedInMemoryClients = true;
    inMemoryClientRegistry.clear();
    clientAuthCache.clear();
    const activeIds = new Set();
    for (const item of req.body.clients) {
      if (!item || !item.clientId) continue;
      const cid = String(item.clientId).trim().toLowerCase();
      activeIds.add(cid);
      deletedClientsSet.delete(cid);
      inMemoryClientRegistry.set(cid, {
        clientId: cid,
        name: String(item.name || cid),
        status: item.status === 'revoked' ? 'revoked' : 'active',
        token: String(item.token || ''),
        rateLimit: Math.max(1, Number(item.rateLimit) || 100),
      });
      if (item.status === 'revoked') {
        io.to(`client:${cid}`).disconnectSockets(true);
      }
    }
    return res.json({ success: true, count: activeIds.size });
  }

  const rawClientId = req.body && req.body.clientId ? String(req.body.clientId) : '';
  const normalizedId = rawClientId.trim().toLowerCase();
  const clientPayload =
    req.body && req.body.client && typeof req.body.client === 'object'
      ? req.body.client
      : null;

  if (normalizedId) {
    hasSyncedInMemoryClients = true;
    clientAuthCache.delete(normalizedId);

    if (action === 'deleted') {
      deletedClientsSet.add(normalizedId);
      inMemoryClientRegistry.delete(normalizedId);
      inMemoryClientActivity.delete(normalizedId);
      io.to(`client:${normalizedId}`).disconnectSockets(true);
    } else if (action === 'revoked') {
      const existingMem = inMemoryClientRegistry.get(normalizedId);
      if (clientPayload) {
        inMemoryClientRegistry.set(normalizedId, {
          clientId: normalizedId,
          name: String(clientPayload.name || normalizedId),
          status: 'revoked',
          token: String(clientPayload.token || ''),
          rateLimit: Math.max(1, Number(clientPayload.rateLimit) || 100),
        });
      } else if (existingMem) {
        existingMem.status = 'revoked';
      } else {
        inMemoryClientRegistry.set(normalizedId, {
          clientId: normalizedId,
          name: normalizedId,
          status: 'revoked',
          token: '',
          rateLimit: 100,
        });
      }
      io.to(`client:${normalizedId}`).disconnectSockets(true);
    } else if (action === 'registered') {
      deletedClientsSet.delete(normalizedId);
      if (clientPayload) {
        inMemoryClientRegistry.set(normalizedId, {
          clientId: normalizedId,
          name: String(clientPayload.name || normalizedId),
          status: clientPayload.status === 'revoked' ? 'revoked' : 'active',
          token: String(clientPayload.token || ''),
          rateLimit: Math.max(1, Number(clientPayload.rateLimit) || 100),
        });
      }
    } else if (action === 'updated') {
      if (clientPayload) {
        inMemoryClientRegistry.set(normalizedId, {
          clientId: normalizedId,
          name: String(clientPayload.name || normalizedId),
          status: clientPayload.status === 'revoked' ? 'revoked' : 'active',
          token: String(clientPayload.token || ''),
          rateLimit: Math.max(1, Number(clientPayload.rateLimit) || 100),
        });
      }
      io.to(`client:${normalizedId}`).disconnectSockets(true);
    }
  }

  res.json({ success: true });
});

function stopTimers() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (settingsSyncTimer) {
    clearInterval(settingsSyncTimer);
    settingsSyncTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[DataStack Ingestion Engine] Received ${signal}, flushing buffer before exit...`);

  stopTimers();

  try {
    await flushBuffer();
  } catch {
    // Best-effort flush on exit
  }

  try {
    io.close();
    server.close();
    if (redisClient && typeof redisClient.quit === 'function') {
      await redisClient.quit().catch(() => undefined);
    }
    if (dbPool) {
      await dbPool.end();
    }
  } catch {
    // Ignore close errors
  }

  process.exit(0);
}

if (process.env.DATASTACK_DISABLE_LISTEN !== '1') {
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });

  server.listen(PORT, () => {
    console.log(
      `[DataStack Ingestion Engine] Express + Socket.IO listening on port ${PORT}`,
    );
  });
}

module.exports = {
  app,
  server,
  io,
  writer,
  bufferQueue,
  flushBuffer,
  runtimeConfig,
  verifyClientInDb,
  recordClientActivity,
  applyRuntimeSettingsObject,
  setRedisClientForTests,
  stopTimers,
};
