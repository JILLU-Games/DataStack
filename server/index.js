const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { setupSocketHandlers } = require('./socket/handlers');
const { CsvWriterWorker } = require('./workers/csvWriter');

const PORT = Number(process.env.PORT_SOCKET) || 4000;
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const bufferQueue = [];
const writer = new CsvWriterWorker();

const runtimeConfig = {
  jwtSecret:
    process.env.DATASTACK_JWT_SECRET ||
    'datastack-jwt-default-secret-key-32-chars-long',
  maxEventsPerSec: 100,
  maxPayloadSizeBytes: 100 * 1024,
  batchFlushThreshold: 500,
  batchFlushIntervalMs: 2000,
  fileRotationMb: 100,
  enableIdempotency: true,
};

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

// Short-lived cache (2s TTL) for client status & token checks on high-frequency events
const clientAuthCache = new Map();
const CLIENT_CACHE_TTL_MS = 2000;

async function verifyClientInDb(clientId, presentedToken, bypassCache = false) {
  if (!dbPool || !clientId) {
    return { allowed: true };
  }

  const now = Date.now();
  if (!bypassCache) {
    const cached = clientAuthCache.get(clientId);
    if (cached && now - cached.checkedAt < CLIENT_CACHE_TTL_MS) {
      if (cached.status === 'revoked') {
        return {
          allowed: false,
          reason: 'CLIENT_REVOKED: Client access has been revoked by admin',
        };
      }
      if (cached.token && presentedToken && cached.token !== presentedToken) {
        return {
          allowed: false,
          reason: 'TOKEN_ROTATED: Client credentials have been rotated',
        };
      }
      return { allowed: true, rateLimit: cached.rateLimit };
    }
  }

  try {
    const res = await dbPool.query(
      `SELECT status, token, rate_limit FROM client_sdks WHERE client_id = $1`,
      [clientId],
    );
    if (!res.rowCount || res.rowCount === 0) {
      // Allow token-authenticated client if not explicitly revoked in table
      return { allowed: true };
    }
    const row = res.rows[0];
    const entry = {
      status: row.status,
      token: row.token,
      rateLimit: Number(row.rate_limit) || 100,
      checkedAt: now,
    };
    clientAuthCache.set(clientId, entry);

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
    return { allowed: true };
  }
}

function recordClientActivity(clientId, count = 1) {
  if (!dbPool || !clientId || count <= 0) return;
  const nowIso = new Date().toISOString();
  dbPool
    .query(
      `UPDATE client_sdks
       SET total_events = total_events + $2,
           last_active = $3,
           updated_at = NOW()
       WHERE client_id = $1`,
      [clientId, count, nowIso],
    )
    .catch(() => undefined);
}

let isFlushing = false;
let flushTimer = null;

async function flushBuffer() {
  if (bufferQueue.length === 0 || isFlushing) {
    return { written: 0, files: [] };
  }
  isFlushing = true;
  const batch = bufferQueue.splice(0, bufferQueue.length);
  try {
    const result = await writer.writeBatch(batch);
    if (result.written > 0) {
      console.log(
        `[CSV Worker] Flushed ${result.written} events to ${result.files.length} file(s)`,
      );
    }
    return result;
  } catch (err) {
    console.error('[CSV Worker] Flush error:', err);
    bufferQueue.unshift(...batch);
    return { written: 0, files: [] };
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

    runtimeConfig.maxEventsPerSec = Number(row.max_events_per_sec) || 100;
    runtimeConfig.maxPayloadSizeBytes =
      (Number(row.max_payload_size_kb) || 100) * 1024;
    runtimeConfig.batchFlushThreshold =
      Math.max(1, Number(row.batch_flush_threshold) || 500);
    runtimeConfig.enableIdempotency = Boolean(row.enable_idempotency);

    if (row.jwt_secret && String(row.jwt_secret).trim().length > 0) {
      runtimeConfig.jwtSecret = String(row.jwt_secret).trim();
    }

    const nextRotationMb = Number(row.file_rotation_mb) || 100;
    if (nextRotationMb !== runtimeConfig.fileRotationMb) {
      runtimeConfig.fileRotationMb = nextRotationMb;
      writer.setMaxFileSizeMb(nextRotationMb);
    }

    const nextPruneDays = Number(row.auto_prune_days) || 30;
    if (nextPruneDays > 0) {
      writer.pruneExpiredPartitions(nextPruneDays);
    }

    const nextIntervalMs = Math.max(
      100,
      Number(row.batch_flush_interval_ms) || 2000,
    );
    if (nextIntervalMs !== runtimeConfig.batchFlushIntervalMs) {
      scheduleFlushTimer(nextIntervalMs);
    }
  } catch {
    // Keep existing runtimeConfig if table is not ready yet
  }
}

let settingsSyncTimer = null;
if (dbPool) {
  void syncSettingsFromDatabase();
  settingsSyncTimer = setInterval(() => {
    void syncSettingsFromDatabase();
  }, 3000);
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Health check endpoint with activeSockets count and runtime capabilities
app.get('/health', (_req, res) => {
  res.json({
    status: 'online',
    service: 'DataStack Express Ingestion',
    port: PORT,
    activeSockets: io.engine ? io.engine.clientsCount : 0,
    bufferSize: bufferQueue.length,
    maxEventsPerSec: runtimeConfig.maxEventsPerSec,
    maxPayloadSizeBytes: runtimeConfig.maxPayloadSizeBytes,
    uptime: process.uptime(),
  });
});

// Internal flush endpoint triggered by Next.js POST /api/storage
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

setupSocketHandlers(io, bufferQueue, writer, {
  getRuntimeConfig: () => runtimeConfig,
  verifyClientInDb,
  recordClientActivity,
  onBufferPush: () => {
    if (bufferQueue.length >= runtimeConfig.batchFlushThreshold) {
      void flushBuffer();
    }
  },
});

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[DataStack Ingestion Engine] Received ${signal}, flushing buffer before exit...`);

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (settingsSyncTimer) {
    clearInterval(settingsSyncTimer);
    settingsSyncTimer = null;
  }

  try {
    await flushBuffer();
  } catch {
    // Best-effort flush on exit
  }

  try {
    io.close();
    server.close();
    if (dbPool) {
      await dbPool.end();
    }
  } catch {
    // Ignore close errors
  }

  process.exit(0);
}

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

module.exports = { app, server, io, bufferQueue, flushBuffer };
