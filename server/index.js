const crypto = require('node:crypto');
const dnsPromises = require('node:dns/promises');
const net = require('node:net');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { setupSocketHandlers, normalizeClientId } = require('./socket/handlers');
const { CsvWriterWorker } = require('./workers/csvWriter');
const {
  mountFilesManager,
  syncInMemoryAdminSessionState,
  clearInMemoryAdminSessionStateForTests,
} = require('./filesManager');

function parseAllowedCorsOrigins(raw = process.env.DATASTACK_CORS_ORIGINS) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '*') return null;
  const origins = trimmed
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (origins.length === 0 || origins.includes('*')) return null;
  return new Set(origins);
}

function isOriginAllowedByCors(origin, raw = process.env.DATASTACK_CORS_ORIGINS) {
  if (!origin) return true;
  const allowlist = parseAllowedCorsOrigins(raw);
  if (!allowlist) return true;
  const normalized = String(origin).trim().replace(/\/+$/, '');
  return allowlist.has(normalized);
}

function corsOriginDelegate(origin, callback) {
  return callback(null, isOriginAllowedByCors(origin));
}

const PORT = Number(process.env.PORT_SOCKET) || 4000;
const app = express();
app.use(cors({ origin: corsOriginDelegate }));
const jsonBodyParser = express.json({ limit: '10mb' });
app.use((req, res, next) => {
  if (req.path === '/vcon/files-engine' || req.path.startsWith('/vcon/files-engine/')) {
    return next();
  }
  return jsonBodyParser(req, res, next);
});
let filesManagerHandle = null;

const REDIS_BUFFER_KEY = 'datastack:buffer:events';
const REDIS_RECENT_KEY = 'datastack:recent:events';
const REDIS_FLUSH_LOCK_KEY = 'datastack:flush:lock';
const REDIS_CLIENTS_REGISTRY_KEY = 'datastack:clients:registry';
const REDIS_CLIENTS_DELETED_KEY = 'datastack:clients:deleted';
const DEFAULT_REDIS_RECENT_LIMIT = 500;
const MAX_REDIS_RECENT_LIMIT = 5000;
const FLUSH_LOCK_TTL_MS = 30000;
const FLUSH_LOCK_WAIT_MS = 400;
const FLUSH_LOCK_RETRY_MS = 25;
const UNLOCK_LUA_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const RENEW_LOCK_LUA_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

function getRedisRecentLimit() {
  const envRaw = Number(process.env.DATASTACK_RECENT_LIMIT);
  if (Number.isFinite(envRaw) && envRaw >= 100) {
    return Math.min(MAX_REDIS_RECENT_LIMIT, Math.floor(envRaw));
  }
  const threshold = Number(runtimeConfig && runtimeConfig.batchFlushThreshold) || DEFAULT_REDIS_RECENT_LIMIT;
  return Math.min(
    MAX_REDIS_RECENT_LIMIT,
    Math.max(DEFAULT_REDIS_RECENT_LIMIT, Math.floor(threshold)),
  );
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    let bufferLen = null;
    try {
      bufferLen = await redis.rpush(REDIS_BUFFER_KEY, ...serialized);
      redisConnected = true;
    } catch {
      redisConnected = false;
    }

    if (bufferLen !== null) {
      // Best-effort recent list mirror: never duplicate into RAM buffer once rpush succeeded
      try {
        const recentLimit = getRedisRecentLimit();
        await redis.lpush(REDIS_RECENT_KEY, ...serialized);
        await redis.ltrim(REDIS_RECENT_KEY, 0, recentLimit - 1);
      } catch {
        // Non-fatal: events are already durable in REDIS_BUFFER_KEY
      }
      return Number(bufferLen) + bufferQueue.length;
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
  compressAfterDays: 0,
  enableS3Backup: false,
  diskPauseThresholdPct: 95,
  enableWebhookAlerts: false,
  webhookUrl: '',
  webhookSecret: '',
  webhookCooldownSec: 300,
};

let previousJwtSecret = '';
let previousJwtSecretGraceUntil = 0;
const JWT_ROTATION_BRIDGE_GRACE_MS = 60 * 1000;

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
  const matchesCurrent = Boolean(presented && timingSafeSecretEqual(presented, expected));
  let matchesGrace = false;
  if (!matchesCurrent && presented && previousJwtSecret && Date.now() <= previousJwtSecretGraceUntil) {
    const graceExpected = resolveInternalSecret(previousJwtSecret);
    matchesGrace = Boolean(graceExpected && timingSafeSecretEqual(presented, graceExpected));
  }
  if (!matchesCurrent && !matchesGrace) {
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
    dbPool.on('error', (err) => {
      console.error(
        '[DataStack Ingestion DB] Unexpected idle PostgreSQL pool error:',
        err instanceof Error ? err.message : err,
      );
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

function stripIpv6MappedPrefix(rawIp) {
  let ip = String(rawIp || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  const pctIndex = ip.indexOf('%');
  if (pctIndex !== -1) {
    ip = ip.slice(0, pctIndex);
  }
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(ip)) {
    return ip.slice(7);
  }
  return ip.toLowerCase();
}

function ipv4ToUint32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    acc = ((acc << 8) | num) >>> 0;
  }
  return acc >>> 0;
}

function matchesIpv4Cidr(clientIp, cidrPattern) {
  const [networkStr, prefixStr] = cidrPattern.split('/');
  if (!networkStr || prefixStr === undefined) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const clientNum = ipv4ToUint32(clientIp);
  const networkNum = ipv4ToUint32(networkStr);
  if (clientNum === null || networkNum === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (clientNum & mask) >>> 0 === (networkNum & mask) >>> 0;
}

function isClientIpAllowed(clientIp, rawAllowedIps) {
  if (!rawAllowedIps || !String(rawAllowedIps).trim()) return true;
  const entries = String(rawAllowedIps)
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return true;
  if (entries.includes('*') || entries.includes('0.0.0.0/0') || entries.includes('::/0')) {
    return true;
  }
  const normalizedClientIp = stripIpv6MappedPrefix(clientIp);
  if (!normalizedClientIp || normalizedClientIp === 'unknown') {
    return false;
  }
  const clientFamily = net.isIP(normalizedClientIp);
  for (const entry of entries) {
    const normalizedEntry = stripIpv6MappedPrefix(entry);
    if (normalizedEntry.includes('/')) {
      const [netAddrRaw, prefixStr] = normalizedEntry.split('/');
      const netAddr = stripIpv6MappedPrefix(netAddrRaw);
      const prefix = Number(prefixStr);
      const ruleFamily = net.isIP(netAddr);

      if (
        clientFamily === 4 &&
        ruleFamily === 4 &&
        Number.isInteger(prefix) &&
        prefix >= 0 &&
        prefix <= 32
      ) {
        if (prefix === 0) return true;
        try {
          const bl = new net.BlockList();
          bl.addSubnet(netAddr, prefix, 'ipv4');
          if (bl.check(normalizedClientIp, 'ipv4')) {
            return true;
          }
        } catch {
          if (matchesIpv4Cidr(normalizedClientIp, `${netAddr}/${prefix}`)) {
            return true;
          }
        }
      } else if (
        clientFamily === 6 &&
        ruleFamily === 6 &&
        Number.isInteger(prefix) &&
        prefix >= 0 &&
        prefix <= 128
      ) {
        if (prefix === 0) return true;
        try {
          const bl = new net.BlockList();
          bl.addSubnet(netAddr, prefix, 'ipv6');
          if (bl.check(normalizedClientIp, 'ipv6')) {
            return true;
          }
        } catch {
          if (prefix === 128 && normalizedClientIp === netAddr) {
            return true;
          }
        }
      }
    } else {
      if (normalizedClientIp === normalizedEntry) {
        return true;
      }
      if (
        (normalizedClientIp === '127.0.0.1' && normalizedEntry === '::1') ||
        (normalizedClientIp === '::1' && normalizedEntry === '127.0.0.1')
      ) {
        return true;
      }
    }
  }
  return false;
}

function isClientTokenExpired(expiresAt, nowMs = Date.now()) {
  if (!expiresAt) return false;
  const ts =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : new Date(String(expiresAt)).getTime();
  if (Number.isNaN(ts)) return false;
  return ts <= nowMs;
}

async function verifyClientInDb(clientId, presentedToken, bypassCache = false, clientIp = '') {
  const normalizedId = normalizeClientId(clientId);
  if (!normalizedId) {
    return {
      allowed: false,
      code: 'CLIENT_REVOKED',
      reason: 'CLIENT_REVOKED: Missing client identifier',
    };
  }
  if (deletedClientsSet.has(normalizedId)) {
    return {
      allowed: false,
      code: 'CLIENT_REVOKED',
      reason: 'CLIENT_REVOKED: Client access has been deleted or revoked by admin',
    };
  }

  if (!dbPool) {
    let memClient = inMemoryClientRegistry.get(normalizedId);
    if (!memClient) {
      const redis = getRedisClient();
      if (redis && typeof redis.sismember === 'function' && typeof redis.hget === 'function') {
        try {
          const isDeleted = await redis.sismember(REDIS_CLIENTS_DELETED_KEY, normalizedId);
          if (isDeleted) {
            deletedClientsSet.add(normalizedId);
            return {
              allowed: false,
              code: 'CLIENT_REVOKED',
              reason: 'CLIENT_REVOKED: Client access has been deleted by admin',
            };
          }
          const rawClient = await redis.hget(REDIS_CLIENTS_REGISTRY_KEY, normalizedId);
          if (rawClient) {
            const parsed = JSON.parse(rawClient);
            if (parsed && parsed.clientId) {
              memClient = {
                clientId: normalizedId,
                name: String(parsed.name || normalizedId),
                status: parsed.status === 'revoked' ? 'revoked' : 'active',
                token: String(parsed.token || ''),
                rateLimit: Math.max(1, Number(parsed.rateLimit) || 100),
                storageQuotaMb: Math.max(0, Math.floor(Number(parsed.storageQuotaMb) || 0)),
                allowedIps: typeof parsed.allowedIps === 'string' ? parsed.allowedIps : '',
                expiresAt: parsed.expiresAt ? String(parsed.expiresAt) : null,
              };
              inMemoryClientRegistry.set(normalizedId, memClient);
              hasSyncedInMemoryClients = true;
            }
          }
        } catch {
          // Ignore Redis registry lookup error and check local state
        }
      }
    }

    if (memClient) {
      if (memClient.status === 'revoked') {
        return {
          allowed: false,
          code: 'CLIENT_REVOKED',
          reason: 'CLIENT_REVOKED: Client access has been revoked by admin',
        };
      }
      if (memClient.token && presentedToken && memClient.token !== presentedToken) {
        return {
          allowed: false,
          code: 'TOKEN_ROTATED',
          reason: 'TOKEN_ROTATED: Client credentials have been rotated',
        };
      }
      if (isClientTokenExpired(memClient.expiresAt)) {
        return {
          allowed: false,
          code: 'CLIENT_TOKEN_EXPIRED',
          reason: `CLIENT_TOKEN_EXPIRED: Client '${normalizedId}' token has expired`,
        };
      }
      if (memClient.allowedIps && memClient.allowedIps.trim() && !isClientIpAllowed(clientIp, memClient.allowedIps)) {
        return {
          allowed: false,
          code: 'CLIENT_IP_FORBIDDEN',
          reason: `CLIENT_IP_FORBIDDEN: Client IP '${clientIp || 'unknown'}' is not authorized`,
        };
      }
      return {
        allowed: true,
        rateLimit: memClient.rateLimit || 100,
        storageQuotaMb: memClient.storageQuotaMb || 0,
      };
    }

    return {
      allowed: false,
      code: 'CLIENT_REVOKED',
      reason: 'CLIENT_REVOKED: Client registration not found or has been deleted',
    };
  }

  const now = Date.now();
  const prevCached = clientAuthCache.get(normalizedId);
  if (!bypassCache && prevCached && now - prevCached.checkedAt < CLIENT_CACHE_TTL_MS) {
    if (prevCached.status === 'revoked') {
      return {
        allowed: false,
        code: 'CLIENT_REVOKED',
        reason: 'CLIENT_REVOKED: Client access has been revoked by admin',
      };
    }
    if (prevCached.token && presentedToken && prevCached.token !== presentedToken) {
      return {
        allowed: false,
        code: 'TOKEN_ROTATED',
        reason: 'TOKEN_ROTATED: Client credentials have been rotated',
      };
    }
    if (isClientTokenExpired(prevCached.expiresAt, now)) {
      return {
        allowed: false,
        code: 'CLIENT_TOKEN_EXPIRED',
        reason: `CLIENT_TOKEN_EXPIRED: Client '${normalizedId}' token has expired`,
      };
    }
    if (prevCached.allowedIps && prevCached.allowedIps.trim() && !isClientIpAllowed(clientIp, prevCached.allowedIps)) {
      return {
        allowed: false,
        code: 'CLIENT_IP_FORBIDDEN',
        reason: `CLIENT_IP_FORBIDDEN: Client IP '${clientIp || 'unknown'}' is not authorized`,
      };
    }
    return {
      allowed: true,
      rateLimit: prevCached.rateLimit,
      storageQuotaMb: prevCached.storageQuotaMb || 0,
    };
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
        code: 'CLIENT_REVOKED',
        reason: 'CLIENT_REVOKED: Client access has been deleted by admin',
      };
    }

    const res = await dbPool.query(
      `SELECT status, token, rate_limit, storage_quota_mb, allowed_ips, expires_at FROM client_sdks WHERE client_id = $1`,
      [normalizedId],
    );
    if (!res.rowCount || res.rowCount === 0) {
      clientAuthCache.delete(normalizedId);
      return {
        allowed: false,
        code: 'CLIENT_REVOKED',
        reason: 'CLIENT_REVOKED: Client registration not found or has been deleted',
      };
    }
    const row = res.rows[0];
    const parsedQuota = Number(row.storage_quota_mb);
    let expiresAtIso = null;
    if (row.expires_at) {
      const d = new Date(row.expires_at);
      if (!Number.isNaN(d.getTime())) {
        expiresAtIso = d.toISOString();
      }
    }
    const entry = {
      status: row.status,
      token: row.token,
      rateLimit: Number(row.rate_limit) || 100,
      storageQuotaMb: Number.isFinite(parsedQuota) && parsedQuota >= 0 ? Math.floor(parsedQuota) : 0,
      allowedIps: typeof row.allowed_ips === 'string' ? row.allowed_ips : '',
      expiresAt: expiresAtIso,
      checkedAt: now,
    };
    clientAuthCache.set(normalizedId, entry);

    if (entry.status === 'revoked') {
      return {
        allowed: false,
        code: 'CLIENT_REVOKED',
        reason: 'CLIENT_REVOKED: Client access has been revoked by admin',
      };
    }
    if (entry.token && presentedToken && entry.token !== presentedToken) {
      return {
        allowed: false,
        code: 'TOKEN_ROTATED',
        reason: 'TOKEN_ROTATED: Client credentials have been rotated',
      };
    }
    if (isClientTokenExpired(entry.expiresAt, now)) {
      return {
        allowed: false,
        code: 'CLIENT_TOKEN_EXPIRED',
        reason: `CLIENT_TOKEN_EXPIRED: Client '${normalizedId}' token has expired`,
      };
    }
    if (entry.allowedIps && entry.allowedIps.trim() && !isClientIpAllowed(clientIp, entry.allowedIps)) {
      return {
        allowed: false,
        code: 'CLIENT_IP_FORBIDDEN',
        reason: `CLIENT_IP_FORBIDDEN: Client IP '${clientIp || 'unknown'}' is not authorized`,
      };
    }
    return {
      allowed: true,
      rateLimit: entry.rateLimit,
      storageQuotaMb: entry.storageQuotaMb,
    };
  } catch {
    return {
      allowed: false,
      code: 'AUTH_UNAVAILABLE',
      reason: 'AUTH_UNAVAILABLE: Unable to verify client credentials against database',
    };
  }
}

const pendingDbClientActivity = new Map();
const CLIENT_ACTIVITY_FLUSH_INTERVAL_MS = 1000;
let activityFlushTimer = null;
let activeActivityFlushPromise = null;

let schemaEnsurePromise = null;
let schemaEnsurePool = null;
let hasHydratedSettingsFromDb = false;

function isDbReadyForMaintenance() {
  return !dbPool || hasHydratedSettingsFromDb === true;
}

function setDbPoolForTests(pool) {
  dbPool = pool;
  schemaEnsurePromise = null;
  schemaEnsurePool = null;
  hasHydratedSettingsFromDb = false;
}

async function flushPendingClientActivity() {
  if (activeActivityFlushPromise) {
    await activeActivityFlushPromise;
    if (pendingDbClientActivity.size === 0) return 0;
  }
  if (!dbPool || pendingDbClientActivity.size === 0) return 0;

  const snapshot = Array.from(pendingDbClientActivity.entries());
  pendingDbClientActivity.clear();

  const clientIds = [];
  const deltas = [];
  const lastActives = [];
  for (const [cid, entry] of snapshot) {
    clientIds.push(cid);
    deltas.push(entry.count);
    lastActives.push(entry.lastActive);
  }

  const run = (async () => {
    try {
      await dbPool.query(
        `UPDATE client_sdks AS c
         SET total_events = c.total_events + v.delta,
             last_active = GREATEST(COALESCE(c.last_active, v.last_active), v.last_active),
             updated_at = NOW()
         FROM (
           SELECT UNNEST($1::text[]) AS client_id,
                  UNNEST($2::bigint[]) AS delta,
                  UNNEST($3::timestamptz[]) AS last_active
         ) AS v
         WHERE c.client_id = v.client_id`,
        [clientIds, deltas, lastActives],
      );
      return clientIds.length;
    } catch {
      // Re-merge deltas so transient DB failures do not lose event counts
      for (const [cid, entry] of snapshot) {
        const current = pendingDbClientActivity.get(cid);
        if (current) {
          pendingDbClientActivity.set(cid, {
            count: current.count + entry.count,
            lastActive:
              current.lastActive > entry.lastActive
                ? current.lastActive
                : entry.lastActive,
          });
        } else {
          pendingDbClientActivity.set(cid, { ...entry });
        }
      }
      return 0;
    } finally {
      activeActivityFlushPromise = null;
    }
  })();

  activeActivityFlushPromise = run;
  return run;
}

function ensureActivityFlushTimer() {
  if (activityFlushTimer) return;
  activityFlushTimer = setInterval(() => {
    void flushPendingClientActivity().catch(() => undefined);
  }, CLIENT_ACTIVITY_FLUSH_INTERVAL_MS);
  if (typeof activityFlushTimer.unref === 'function') {
    activityFlushTimer.unref();
  }
}

function recordClientActivity(clientId, count = 1) {
  if (!clientId || count <= 0) return;
  const normalizedId = normalizeClientId(clientId);
  if (!normalizedId) return;
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

  const prevPending = pendingDbClientActivity.get(normalizedId);
  if (prevPending) {
    pendingDbClientActivity.set(normalizedId, {
      count: prevPending.count + count,
      lastActive: nowIso > prevPending.lastActive ? nowIso : prevPending.lastActive,
    });
  } else {
    pendingDbClientActivity.set(normalizedId, {
      count,
      lastActive: nowIso,
    });
  }
  ensureActivityFlushTimer();
}

let isFlushing = false;
let activeFlushPromise = null;
let flushTimer = null;

function purgeClientFromLocalBuffer(normalizedId) {
  if (!normalizedId || bufferQueue.length === 0) return 0;
  let removed = 0;
  let writeIdx = 0;
  for (let i = 0; i < bufferQueue.length; i += 1) {
    const evt = bufferQueue[i];
    if (evt && normalizeClientId(evt.clientId) === normalizedId) {
      removed += 1;
    } else {
      bufferQueue[writeIdx] = evt;
      writeIdx += 1;
    }
  }
  bufferQueue.length = writeIdx;
  return removed;
}

async function isClientDeletedForFlush(clientId, redis, cache) {
  const normalized = normalizeClientId(clientId);
  if (!normalized) return false;
  if (deletedClientsSet.has(normalized)) return true;
  if (cache && cache.has(normalized)) return Boolean(cache.get(normalized));
  if (redis && typeof redis.sismember === 'function') {
    try {
      const isDeleted =
        Number(await redis.sismember(REDIS_CLIENTS_DELETED_KEY, normalized)) === 1;
      if (cache) cache.set(normalized, isDeleted);
      if (isDeleted) deletedClientsSet.add(normalized);
      return isDeleted;
    } catch {
      // Ignore transient Redis tombstone lookup error
    }
  }
  if (cache) cache.set(normalized, false);
  return false;
}

async function flushBuffer(options = {}) {
  if (pendingRedisWrites.size > 0) {
    await Promise.allSettled([...pendingRedisWrites]);
  }
  if (activeFlushPromise) {
    return activeFlushPromise;
  }

  const executeFlush = async () => {
    isFlushing = true;
    let totalWritten = 0;
    let lockTimedOut = false;
    const filesSet = new Set();
    const deletedCheckCache = new Map();

    try {
      if (pendingRedisWrites.size > 0) {
        await Promise.allSettled([...pendingRedisWrites]);
      }

      const redis = getRedisClient();
      if (redis) {
        const lockToken = crypto.randomUUID();
        const lockTtlMs = Math.max(50, Number(options && options.lockTtlMs) || FLUSH_LOCK_TTL_MS);
        const waitMs = Math.max(
          0,
          options && options.waitMs !== undefined ? Number(options.waitMs) : FLUSH_LOCK_WAIT_MS,
        );
        const deadline = Date.now() + waitMs;
        let lockAcquired = false;
        let redisError = false;

        while (true) {
          try {
            const lockResult = await redis.set(
              REDIS_FLUSH_LOCK_KEY,
              lockToken,
              'PX',
              lockTtlMs,
              'NX',
            );
            redisConnected = true;
            if (lockResult === 'OK') {
              lockAcquired = true;
              break;
            }
          } catch {
            redisConnected = false;
            redisError = true;
            break;
          }

          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            break;
          }
          await sleepMs(Math.min(FLUSH_LOCK_RETRY_MS, remaining));
        }

        if (!lockAcquired && !redisError) {
          lockTimedOut = true;
          if (options && options.throwOnLockTimeout === true) {
            throw new Error(
              'FLUSH_LOCK_TIMEOUT: Timed out waiting for distributed Redis flush lock',
            );
          }
        }

        if (lockAcquired) {
          const renewIntervalMs = Math.max(20, Math.floor(lockTtlMs / 3));
          let lastRenewAt = Date.now();
          let lockLost = false;
          let renewInFlight = null;

          const renewLockOnce = () => {
            if (renewInFlight) return renewInFlight;
            renewInFlight = (async () => {
              try {
                const renewed = await redis.eval(
                  RENEW_LOCK_LUA_SCRIPT,
                  1,
                  REDIS_FLUSH_LOCK_KEY,
                  lockToken,
                  String(lockTtlMs),
                );
                if (Number(renewed) === 1) {
                  lastRenewAt = Date.now();
                  return true;
                }
                lockLost = true;
                return false;
              } catch {
                return false;
              } finally {
                renewInFlight = null;
              }
            })();
            return renewInFlight;
          };

          const renewTimer = setInterval(() => {
            void renewLockOnce();
          }, renewIntervalMs);
          if (typeof renewTimer.unref === 'function') {
            renewTimer.unref();
          }

          try {
            const chunkSize = Math.max(500, runtimeConfig.batchFlushThreshold);
            while (true) {
              if (lockLost) break;

              const rawItems = await redis.lrange(REDIS_BUFFER_KEY, 0, chunkSize - 1);
              if (!rawItems || rawItems.length === 0) {
                break;
              }

              const parsedBatch = [];
              let malformedCount = 0;
              for (const raw of rawItems) {
                try {
                  const evt = JSON.parse(raw);
                  if (evt && evt.eventId) {
                    if (await isClientDeletedForFlush(evt.clientId, redis, deletedCheckCache)) {
                      continue;
                    }
                    parsedBatch.push(evt);
                  } else {
                    malformedCount += 1;
                  }
                } catch {
                  malformedCount += 1;
                }
              }
              if (malformedCount > 0) {
                console.warn(
                  `[CSV Worker] Skipped ${malformedCount} malformed buffered Redis event(s) during flush`,
                );
              }

              if (Date.now() - lastRenewAt >= renewIntervalMs) {
                await renewLockOnce();
              }
              if (lockLost) break;

              if (parsedBatch.length > 0) {
                const res = await writer.writeBatch(parsedBatch);
                totalWritten += res.written;
                for (const f of res.files) filesSet.add(f);
              }

              if (Date.now() - lastRenewAt >= renewIntervalMs) {
                await renewLockOnce();
              }
              if (lockLost) break;

              // Trim ONLY after CSV batch write succeeds and lock ownership holds
              await redis.ltrim(REDIS_BUFFER_KEY, rawItems.length, -1);

              if (rawItems.length < chunkSize) {
                break;
              }
            }
          } finally {
            clearInterval(renewTimer);
            if (renewInFlight) {
              await renewInFlight.catch(() => false);
            }
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
        const validBatch = [];
        for (const evt of batch) {
          if (await isClientDeletedForFlush(evt.clientId, redis, deletedCheckCache)) {
            continue;
          }
          validBatch.push(evt);
        }

        if (validBatch.length > 0) {
          try {
            const res = await writer.writeBatch(validBatch);
            totalWritten += res.written;
            for (const f of res.files) filesSet.add(f);
          } catch (err) {
            bufferQueue.unshift(...validBatch);
            throw err;
          }
        }
      }

      const files = Array.from(filesSet);
      if (totalWritten > 0) {
        console.log(
          `[CSV Worker] Flushed ${totalWritten} events to ${files.length} file(s)`,
        );
      }
      return {
        written: totalWritten,
        files,
        ...(lockTimedOut ? { lockTimedOut: true } : {}),
      };
    } catch (err) {
      console.error('[CSV Worker] Flush error:', err);
      throw err;
    } finally {
      isFlushing = false;
      activeFlushPromise = null;
    }
  };

  let flushDone = false;
  const promise = (async () => {
    try {
      return await executeFlush();
    } finally {
      flushDone = true;
      isFlushing = false;
      if (activeFlushPromise === promise) {
        activeFlushPromise = null;
      }
    }
  })();
  if (!flushDone) {
    activeFlushPromise = promise;
  }
  return promise;
}

function scheduleFlushTimer(intervalMs) {
  const safeInterval = Math.max(100, Number(intervalMs) || 2000);
  runtimeConfig.batchFlushIntervalMs = safeInterval;
  if (flushTimer) {
    clearInterval(flushTimer);
  }
  flushTimer = setInterval(() => {
    void flushBuffer().catch(() => undefined);
  }, safeInterval);
}

scheduleFlushTimer(runtimeConfig.batchFlushIntervalMs);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOriginDelegate, methods: ['GET', 'POST'] },
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

  if (settingsObj.enableS3Backup !== undefined) {
    runtimeConfig.enableS3Backup = Boolean(settingsObj.enableS3Backup);
  }

  if (
    settingsObj.diskPauseThresholdPct !== undefined &&
    settingsObj.diskPauseThresholdPct !== null
  ) {
    const pct = Number(settingsObj.diskPauseThresholdPct);
    if (Number.isFinite(pct) && (pct === 0 || (pct >= 50 && pct <= 99))) {
      runtimeConfig.diskPauseThresholdPct = Math.floor(pct);
    }
  }

  if (
    settingsObj.compressAfterDays !== undefined &&
    settingsObj.compressAfterDays !== null
  ) {
    const parsedCompress = Number(settingsObj.compressAfterDays);
    if (Number.isFinite(parsedCompress) && parsedCompress >= 0) {
      const nextCompressDays = Math.floor(parsedCompress);
      const changed = nextCompressDays !== runtimeConfig.compressAfterDays;
      runtimeConfig.compressAfterDays = nextCompressDays;
      if (changed && nextCompressDays > 0 && isDbReadyForMaintenance()) {
        void writer.compressOldPartitionsAsync(nextCompressDays).catch(() => undefined);
      }
    }
  }

  if (settingsObj.autoPruneDays !== undefined && settingsObj.autoPruneDays !== null) {
    const parsedPrune = Number(settingsObj.autoPruneDays);
    if (Number.isFinite(parsedPrune) && parsedPrune >= 0) {
      const nextPruneDays = Math.floor(parsedPrune);
      const changed = nextPruneDays !== runtimeConfig.autoPruneDays;
      runtimeConfig.autoPruneDays = nextPruneDays;
      if (
        changed &&
        nextPruneDays > 0 &&
        !runtimeConfig.enableS3Backup &&
        isDbReadyForMaintenance()
      ) {
        void writer.pruneExpiredPartitionsAsync(nextPruneDays).catch(() => undefined);
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

  if (settingsObj.enableWebhookAlerts !== undefined) {
    runtimeConfig.enableWebhookAlerts = Boolean(settingsObj.enableWebhookAlerts);
  }

  if (settingsObj.webhookUrl !== undefined && settingsObj.webhookUrl !== null) {
    runtimeConfig.webhookUrl = String(settingsObj.webhookUrl).trim();
  }

  if (settingsObj.webhookSecret !== undefined && settingsObj.webhookSecret !== null) {
    runtimeConfig.webhookSecret = String(settingsObj.webhookSecret);
  } else if (
    settingsObj.webhookSecretEnc !== undefined &&
    settingsObj.webhookSecretEnc !== null
  ) {
    runtimeConfig.webhookSecret = decryptVaultSecret(String(settingsObj.webhookSecretEnc));
  }

  if (
    settingsObj.webhookCooldownSec !== undefined &&
    settingsObj.webhookCooldownSec !== null
  ) {
    const cooldown = Number(settingsObj.webhookCooldownSec);
    if (Number.isFinite(cooldown) && cooldown >= 0) {
      runtimeConfig.webhookCooldownSec = Math.floor(cooldown);
    }
  }

  let jwtRotated = false;
  if (settingsObj.jwtSecret !== undefined && settingsObj.jwtSecret !== null) {
    const candidateSecret = String(settingsObj.jwtSecret).trim();
    const validSecret =
      candidateSecret.length >= 32 ||
      (!IS_PRODUCTION && candidateSecret.length > 0);
    if (validSecret && candidateSecret !== runtimeConfig.jwtSecret) {
      if (runtimeConfig.jwtSecret) {
        previousJwtSecret = runtimeConfig.jwtSecret;
        previousJwtSecretGraceUntil = Date.now() + JWT_ROTATION_BRIDGE_GRACE_MS;
      }
      runtimeConfig.jwtSecret = candidateSecret;
      clientAuthCache.clear();
      io.disconnectSockets(true);
      jwtRotated = true;
    }
  }

  return { jwtRotated };
}

const VAULT_PREFIX = 'v1';
const DEV_DEFAULT_SESSION_SECRET = 'datastack-admin-session-default-secret-32-chars';
const webhookCooldownMap = new Map();

function clearWebhookCooldownCacheForTests() {
  webhookCooldownMap.clear();
}

function resolveVaultMasterSecret() {
  const candidate = (process.env.DATASTACK_ADMIN_SESSION_SECRET || '').trim();
  if (process.env.NODE_ENV === 'production') {
    return candidate.length >= 32 ? candidate : null;
  }
  if (candidate.length > 0) {
    return candidate.length >= 32 ? candidate : null;
  }
  return DEV_DEFAULT_SESSION_SECRET;
}

function decryptVaultSecret(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return '';
  const trimmed = ciphertext.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(':');
  if (parts.length !== 4 || parts[0] !== VAULT_PREFIX) {
    console.warn(
      '[DataStack Vault] Ignoring unrecognized stored webhook secret format on Port 4000.',
    );
    return '';
  }
  const master = resolveVaultMasterSecret();
  if (!master) {
    console.warn(
      '[DataStack Vault] DATASTACK_ADMIN_SESSION_SECRET (>= 32 chars) unavailable on Port 4000; skipping webhook secret decryption.',
    );
    return '';
  }
  try {
    const derived = crypto.hkdfSync(
      'sha256',
      Buffer.from(master, 'utf8'),
      Buffer.from('datastack-vault-salt-v1', 'utf8'),
      Buffer.from('datastack-aes-256-gcm-v1', 'utf8'),
      32,
    );
    const key = Buffer.from(derived);
    const iv = Buffer.from(parts[1], 'base64url');
    const authTag = Buffer.from(parts[2], 'base64url');
    const encrypted = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || authTag.length !== 16) {
      return '';
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: 16,
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    console.warn(
      '[DataStack Vault] Failed to decrypt stored webhook secret on Port 4000. Verify DATASTACK_ADMIN_SESSION_SECRET matches Port 3000.',
    );
    return '';
  }
}

function formatOutboundWebhookBody(_url, payload, timestamp) {
  const safeTimestamp = timestamp || payload.timestamp || new Date().toISOString();
  const severity = payload.severity || 'warning';
  const prefix =
    severity === 'critical'
      ? '[CRITICAL]'
      : severity === 'warning'
        ? '[WARNING]'
        : '[INFO]';
  const title = payload.title || String(payload.event || 'Alert');
  const clientTag = payload.clientId ? ` (client: ${payload.clientId})` : '';
  const summaryLine = `${prefix} DataStack ${payload.event}${clientTag} — ${title}: ${payload.message}`;

  return JSON.stringify({
    instance: 'DataStack',
    event: payload.event,
    severity,
    title,
    message: payload.message,
    ...(payload.clientId ? { clientId: payload.clientId } : {}),
    ...(payload.details ? { details: payload.details } : {}),
    timestamp: safeTimestamp,
    // Slack & Discord compatible top-level fields (1:1 parity with Port 3000)
    text: summaryLine,
    content: summaryLine,
  });
}

const WEBHOOK_ALWAYS_BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

const WEBHOOK_PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

const WEBHOOK_ALWAYS_BLOCKED_IPS = (() => {
  const list = new net.BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addSubnet('224.0.0.0', 4, 'ipv4');
  list.addSubnet('240.0.0.0', 4, 'ipv4');
  list.addAddress('::', 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addSubnet('ff00::', 8, 'ipv6');
  return list;
})();

const WEBHOOK_PRIVATE_IPS = (() => {
  const list = new net.BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  list.addSubnet('100.64.0.0', 10, 'ipv4');
  list.addSubnet('198.18.0.0', 15, 'ipv4');
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  return list;
})();

function isPrivateWebhookUrlAllowed(env = process.env) {
  const raw = String(env.DATASTACK_ALLOW_PRIVATE_URLS || '')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function normalizeWebhookIp(rawHost) {
  let clean = String(rawHost || '').trim().toLowerCase();
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx >= 0) clean = clean.slice(0, zoneIdx);
  clean = clean.replace(/\.+$/, '');
  if (!clean) return null;

  if (clean.startsWith('::ffff:')) {
    const mapped = clean.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) {
      return { ip: mapped, family: 4 };
    }
    const hexParts = mapped.split(':');
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0], 16);
      const lo = Number.parseInt(hexParts[1], 16);
      if (
        Number.isInteger(hi) &&
        Number.isInteger(lo) &&
        hi >= 0 &&
        hi <= 0xffff &&
        lo >= 0 &&
        lo <= 0xffff
      ) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        if (net.isIP(ipv4) === 4) {
          return { ip: ipv4, family: 4 };
        }
      }
    }
  }

  const family = net.isIP(clean);
  if (family === 4 || family === 6) {
    return { ip: clean, family };
  }
  return null;
}

function checkWebhookIpAllowed(rawIp, allowPrivate) {
  const parsed = normalizeWebhookIp(rawIp);
  if (!parsed) return { allowed: false, reason: 'Invalid IP address' };
  const ipType = parsed.family === 4 ? 'ipv4' : 'ipv6';
  if (WEBHOOK_ALWAYS_BLOCKED_IPS.check(parsed.ip, ipType)) {
    return {
      allowed: false,
      reason: `Address '${parsed.ip}' is in a restricted link-local/metadata/reserved range`,
    };
  }
  if (!allowPrivate && WEBHOOK_PRIVATE_IPS.check(parsed.ip, ipType)) {
    return {
      allowed: false,
      reason: `Address '${parsed.ip}' is a private or loopback network address`,
    };
  }
  return { allowed: true };
}

async function validateOutboundWebhookUrlAsync(rawUrl, options = {}) {
  const allowPrivate =
    options.allowPrivate !== undefined
      ? Boolean(options.allowPrivate)
      : isPrivateWebhookUrlAllowed(options.env || process.env);

  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return { allowed: false, code: 'INVALID_URL', error: 'Webhook URL is not a valid URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      code: 'SSRF_BLOCKED_HOST',
      error: 'Webhook URL must use http:// or https://.',
    };
  }
  if (parsed.username || parsed.password) {
    return {
      allowed: false,
      code: 'SSRF_BLOCKED_HOST',
      error: 'Webhook URL must not embed credentials.',
    };
  }

  let host = String(parsed.hostname || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '');
  if (!host) {
    return { allowed: false, code: 'INVALID_URL', error: 'Webhook URL hostname is empty.' };
  }

  if (WEBHOOK_ALWAYS_BLOCKED_HOSTNAMES.has(host)) {
    return {
      allowed: false,
      code: 'SSRF_BLOCKED_HOST',
      error: `Webhook target '${host}' is blocked (cloud metadata/internal endpoint).`,
    };
  }

  const literalIp = normalizeWebhookIp(host);
  if (literalIp) {
    const ipCheck = checkWebhookIpAllowed(host, allowPrivate);
    if (!ipCheck.allowed) {
      return { allowed: false, code: 'SSRF_BLOCKED_HOST', error: ipCheck.reason };
    }
    return { allowed: true, url: parsed.toString() };
  }

  if (!allowPrivate) {
    if (
      WEBHOOK_PRIVATE_HOSTNAMES.has(host) ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      !host.includes('.')
    ) {
      return {
        allowed: false,
        code: 'SSRF_BLOCKED_HOST',
        error: `Webhook target '${host}' is a private/internal hostname.`,
      };
    }
  }

  try {
    const lookupFn =
      options.dnsLookup ||
      ((h) => dnsPromises.lookup(h, { all: true, verbatim: true }));
    const records = await lookupFn(host);
    for (const rec of records) {
      const check = checkWebhookIpAllowed(rec.address, allowPrivate);
      if (!check.allowed) {
        return {
          allowed: false,
          code: 'SSRF_BLOCKED_HOST',
          error: `Webhook hostname '${host}' resolved to blocked address: ${check.reason}`,
        };
      }
    }
  } catch {
    // Let fetch handle unresolved DNS names cleanly
  }

  return { allowed: true, url: parsed.toString() };
}

async function triggerWebhookAlert(payload, options = {}) {
  try {
    const enabled =
      options.enableWebhookAlerts !== undefined
        ? Boolean(options.enableWebhookAlerts)
        : Boolean(runtimeConfig.enableWebhookAlerts);
    const url = (
      options.webhookUrl !== undefined
        ? String(options.webhookUrl)
        : String(runtimeConfig.webhookUrl || '')
    ).trim();

    if (!enabled || !url) {
      return { dispatched: false, reason: 'disabled_or_empty_url' };
    }

    const ssrfCheck = await validateOutboundWebhookUrlAsync(url, {
      allowPrivate: options.allowPrivate,
      dnsLookup: options.dnsLookup,
    });
    if (!ssrfCheck.allowed) {
      return {
        dispatched: false,
        code: ssrfCheck.code || 'SSRF_BLOCKED_HOST',
        reason: ssrfCheck.code || 'SSRF_BLOCKED_HOST',
        error: ssrfCheck.error,
      };
    }

    const cooldownSec = Math.max(
      0,
      Number(
        options.webhookCooldownSec !== undefined
          ? options.webhookCooldownSec
          : runtimeConfig.webhookCooldownSec,
      ) || 0,
    );
    const dedupKey = `${payload.event}:${payload.clientId || 'global'}`;
    const now = Date.now();
    const lastFired = webhookCooldownMap.get(dedupKey) || 0;

    if (!options.bypassCooldown && cooldownSec > 0 && now - lastFired < cooldownSec * 1000) {
      return { dispatched: false, reason: 'cooldown_active' };
    }

    webhookCooldownMap.set(dedupKey, now);

    const timestamp = payload.timestamp || new Date(now).toISOString();
    const rawBody = formatOutboundWebhookBody(url, payload, timestamp);
    const secret =
      options.webhookSecret !== undefined
        ? String(options.webhookSecret || '')
        : String(runtimeConfig.webhookSecret || '');

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'DataStack-Webhook-Notifier/2.0',
      'X-DataStack-Event': String(payload.event || ''),
      'X-DataStack-Timestamp': timestamp,
    };

    if (secret) {
      const signature = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
      headers['X-DataStack-Signature'] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const fetchImpl = options.fetchImpl || global.fetch;

    try {
      const res = await fetchImpl(ssrfCheck.url, {
        method: 'POST',
        headers,
        body: rawBody,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        return {
          dispatched: false,
          code: 'SSRF_BLOCKED_HOST',
          reason: 'SSRF_BLOCKED_HOST',
          status: res.status,
          error: `Webhook endpoint attempted an unsupported HTTP ${res.status} redirect.`,
        };
      }
      return { dispatched: true, status: res.status };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      dispatched: false,
      reason: err && err.message ? err.message : 'webhook_dispatch_failed',
    };
  }
}

async function ensureDatabaseSchema() {
  const pool = dbPool;
  if (!pool) return false;
  if (schemaEnsurePromise && schemaEnsurePool === pool) {
    return schemaEnsurePromise;
  }

  schemaEnsurePool = pool;
  schemaEnsurePromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS client_sdks (
          client_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          secret TEXT NOT NULL,
          token TEXT NOT NULL,
          rate_limit INTEGER NOT NULL DEFAULT 100,
          storage_quota_mb INTEGER NOT NULL DEFAULT 0,
          allowed_ips TEXT NOT NULL DEFAULT '',
          expires_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'active',
          total_events BIGINT NOT NULL DEFAULT 0,
          last_active TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
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
          compress_after_days INTEGER NOT NULL DEFAULT 0,
          enable_s3_backup BOOLEAN NOT NULL DEFAULT false,
          s3_endpoint TEXT NOT NULL DEFAULT '',
          s3_region TEXT NOT NULL DEFAULT 'auto',
          s3_bucket TEXT NOT NULL DEFAULT '',
          s3_prefix TEXT NOT NULL DEFAULT 'datastack/',
          s3_access_key_id TEXT NOT NULL DEFAULT '',
          s3_secret_access_key_enc TEXT NOT NULL DEFAULT '',
          disk_pause_threshold_pct INTEGER NOT NULL DEFAULT 95,
          enable_webhook_alerts BOOLEAN NOT NULL DEFAULT false,
          webhook_url TEXT NOT NULL DEFAULT '',
          webhook_secret_enc TEXT NOT NULL DEFAULT '',
          webhook_cooldown_sec INTEGER NOT NULL DEFAULT 300,
          enable_prometheus_metrics BOOLEAN NOT NULL DEFAULT false,
          prometheus_metrics_token_enc TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS deleted_clients (
          client_id TEXT PRIMARY KEY,
          deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
          id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          email TEXT NOT NULL UNIQUE,
          password_salt BYTEA NOT NULL,
          password_hash BYTEA NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_login_attempts (
          key_hash TEXT PRIMARY KEY,
          window_started_at TIMESTAMPTZ NOT NULL,
          failed_attempts INTEGER NOT NULL,
          blocked_until TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_team_members (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'viewer',
          status TEXT NOT NULL DEFAULT 'active',
          password_salt BYTEA NOT NULL,
          password_hash BYTEA NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 1,
          invited_by TEXT NOT NULL DEFAULT 'owner',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_audit_logs (
          id TEXT PRIMARY KEY,
          actor_email TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          ip_address TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        ALTER TABLE client_sdks
          ADD COLUMN IF NOT EXISTS rate_limit INTEGER NOT NULL DEFAULT 100,
          ADD COLUMN IF NOT EXISTS storage_quota_mb INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS allowed_ips TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
          ADD COLUMN IF NOT EXISTS total_events BIGINT NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      `);
      await pool.query(`
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
          ADD COLUMN IF NOT EXISTS compress_after_days INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS enable_s3_backup BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS s3_endpoint TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS s3_region TEXT NOT NULL DEFAULT 'auto',
          ADD COLUMN IF NOT EXISTS s3_bucket TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS s3_prefix TEXT NOT NULL DEFAULT 'datastack/',
          ADD COLUMN IF NOT EXISTS s3_access_key_id TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS s3_secret_access_key_enc TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS disk_pause_threshold_pct INTEGER NOT NULL DEFAULT 95,
          ADD COLUMN IF NOT EXISTS enable_webhook_alerts BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS webhook_url TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS webhook_secret_enc TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS webhook_cooldown_sec INTEGER NOT NULL DEFAULT 300,
          ADD COLUMN IF NOT EXISTS enable_prometheus_metrics BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS prometheus_metrics_token_enc TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      `);
      await pool.query(`
        ALTER TABLE admin_users
          ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1
      `);
      return true;
    } catch {
      if (schemaEnsurePool === pool) {
        schemaEnsurePromise = null;
      }
      return false;
    }
  })();

  return schemaEnsurePromise;
}

async function syncSettingsFromDatabase() {
  if (!dbPool) return false;
  try {
    const schemaReady = await ensureDatabaseSchema();
    if (!schemaReady) return false;

    const res = await dbPool.query(
      `SELECT max_events_per_sec, max_payload_size_kb, batch_flush_threshold,
              batch_flush_interval_ms, file_rotation_mb, jwt_secret, enable_idempotency,
              auto_prune_days, compress_after_days, enable_s3_backup, disk_pause_threshold_pct,
              enable_webhook_alerts, webhook_url, webhook_secret_enc, webhook_cooldown_sec
       FROM admin_settings
       WHERE id = 'default'`,
    );
    if (!res.rowCount || res.rowCount === 0) {
      hasHydratedSettingsFromDb = true;
      return true;
    }
    hasHydratedSettingsFromDb = true;
    const row = res.rows[0];
    const parsedPrune =
      row.auto_prune_days !== undefined && row.auto_prune_days !== null
        ? Number(row.auto_prune_days)
        : NaN;
    const parsedCompress =
      row.compress_after_days !== undefined && row.compress_after_days !== null
        ? Number(row.compress_after_days)
        : NaN;
    const parsedDiskPct =
      row.disk_pause_threshold_pct !== undefined && row.disk_pause_threshold_pct !== null
        ? Number(row.disk_pause_threshold_pct)
        : NaN;
    const parsedWebhookCooldown =
      row.webhook_cooldown_sec !== undefined && row.webhook_cooldown_sec !== null
        ? Number(row.webhook_cooldown_sec)
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
      compressAfterDays: Number.isFinite(parsedCompress) ? Math.max(0, parsedCompress) : 0,
      enableS3Backup: Boolean(row.enable_s3_backup),
      diskPauseThresholdPct: Number.isFinite(parsedDiskPct) ? parsedDiskPct : 95,
      enableWebhookAlerts: Boolean(row.enable_webhook_alerts),
      webhookUrl: row.webhook_url ? String(row.webhook_url).trim() : '',
      webhookSecretEnc: row.webhook_secret_enc ? String(row.webhook_secret_enc) : '',
      webhookCooldownSec: Number.isFinite(parsedWebhookCooldown)
        ? Math.max(0, parsedWebhookCooldown)
        : 300,
      jwtSecret: row.jwt_secret ? String(row.jwt_secret).trim() : undefined,
    });
    return true;
  } catch {
    return false;
  }
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let settingsSyncTimer = null;
let pruneTimer = null;

const socketHandlersApi = setupSocketHandlers(io, bufferQueue, writer, {
  getRuntimeConfig: () => runtimeConfig,
  getRedisClient,
  verifyClientInDb,
  recordClientActivity,
  triggerWebhookAlert,
  onBufferPush: async () => {
    const redis = getRedisClient();
    if (redis) {
      if (bufferQueue.length > 0) {
        const pushed = bufferQueue.splice(0, bufferQueue.length);
        const op = pushEventsToRedisOrFallback(pushed);
        pendingRedisWrites.add(op);
        try {
          const totalQueued = await op;
          if (totalQueued >= runtimeConfig.batchFlushThreshold) {
            void flushBuffer().catch(() => undefined);
          }
        } finally {
          pendingRedisWrites.delete(op);
        }
        return;
      }
      if (pendingRedisWrites.size > 0) {
        await Promise.all([...pendingRedisWrites]);
      }
      return;
    }

    if (bufferQueue.length >= runtimeConfig.batchFlushThreshold) {
      void flushBuffer().catch(() => undefined);
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
    serverPort: PORT,
    webPort: Number(process.env.PORT) || 3000,
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
    port: PORT,
    serverPort: PORT,
    webPort: Number(process.env.PORT) || 3000,
    activeSockets: io.engine ? io.engine.clientsCount : 0,
    bufferSize: bufferQueue.length + redisBufferSize,
    localBufferSize: bufferQueue.length,
    redisBufferSize,
    redisConnected,
    registrySize: inMemoryClientRegistry.size,
    hasSyncedInMemoryClients,
    inMemoryClients: Array.from(inMemoryClientRegistry.values()),
    securityStats: socketHandlersApi.getSecurityStats(),
    clientActivity: Object.fromEntries(inMemoryClientActivity.entries()),
  });
});

// Internal shared security check for Port 3000 HTTP ingestion when Redis is unavailable (BUG-03)
app.post('/internal/security-check', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const clientId = normalizeClientId(body.clientId || '');
  if (!clientId) {
    return res.status(400).json({
      allowed: false,
      code: 'MALFORMED_PAYLOAD',
      reason: 'Missing clientId',
    });
  }
  const eventId = typeof body.eventId === 'string' ? body.eventId : '';
  const clientRateLimit = Number(body.clientMaxRate) || 100;
  const payloadBytes =
    typeof body.payloadBytes === 'number' &&
    Number.isFinite(body.payloadBytes) &&
    body.payloadBytes >= 0
      ? body.payloadBytes
      : undefined;

  const result = socketHandlersApi.validateSingleEventLocal(
    clientId,
    eventId,
    body.payload ?? {},
    clientRateLimit,
    payloadBytes,
  );

  return res.json({
    allowed: Boolean(result.allowed),
    duplicate: Boolean(result.duplicate),
    ...(result.code ? { code: result.code } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  });
});

// Internal instant settings synchronization triggered by Next.js POST /api/settings
app.post('/internal/settings-sync', (req, res) => {
  hasHydratedSettingsFromDb = true;
  const result = applyRuntimeSettingsObject(req.body || {});
  res.json({
    success: true,
    jwtRotated: result.jwtRotated,
  });
});

// Internal flush endpoint triggered by Next.js POST /api/storage & GET /api/export
app.post('/internal/flush', async (req, res) => {
  try {
    const throwOnLockTimeout = Boolean(req.body && req.body.throwOnLockTimeout === true);
    const waitMs =
      req.body && Number.isFinite(Number(req.body.waitMs))
        ? Math.max(0, Number(req.body.waitMs))
        : 2500;
    const result = await flushBuffer({ waitMs, throwOnLockTimeout });
    res.json({
      success: true,
      flushedCount: result.written,
      filesUpdated: result.files,
      ...(result.lockTimedOut ? { lockTimedOut: true } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Flush failed';
    if (message.includes('FLUSH_LOCK_TIMEOUT')) {
      return res.status(503).json({
        success: false,
        code: 'FLUSH_LOCK_TIMEOUT',
        error: message,
      });
    }
    res.status(500).json({
      success: false,
      error: message,
    });
  }
});

// Internal endpoint to expose Port 4000 buffered events before CSV flush
app.get('/internal/recent', async (req, res) => {
  const rawClientId = req.query.clientId ? String(req.query.clientId) : '';
  const filterClientId =
    rawClientId && rawClientId !== 'all' ? normalizeClientId(rawClientId) : '';
  const recentLimit = getRedisRecentLimit();
  const limit = Math.min(recentLimit, Math.max(1, Number(req.query.limit) || 50));

  const redis = getRedisClient();
  let redisEvents = [];
  if (redis) {
    try {
      const readCap = Math.min(recentLimit, Math.max(limit * 2, limit));
      const rawItems = await redis.lrange(REDIS_RECENT_KEY, 0, readCap - 1);
      redisConnected = true;
      for (const raw of rawItems) {
        try {
          const evt = JSON.parse(raw);
          if (!evt || !evt.eventId) continue;
          const normEvtClientId = normalizeClientId(evt.clientId);
          if (deletedClientsSet.has(normEvtClientId)) continue;
          if (filterClientId && normEvtClientId !== filterClientId) continue;
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

  const localFiltered = filterClientId
    ? bufferQueue.filter((evt) => normalizeClientId(evt.clientId) === filterClientId)
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
app.post('/internal/client-sync', async (req, res) => {
  const action = req.body && req.body.action ? String(req.body.action) : '';

  if (action === 'bulk_sync' && Array.isArray(req.body.clients)) {
    const forceReplace = req.body.forceReplace === true;
    // BUG-02 Guard: Never wipe a populated Port 4000 in-memory registry when a cold-restarted
    // Port 3000 (without DB) sends an empty bulk_sync without explicit forceReplace.
    if (
      req.body.clients.length === 0 &&
      !forceReplace &&
      inMemoryClientRegistry.size > 0
    ) {
      hasSyncedInMemoryClients = true;
      return res.json({
        success: true,
        count: inMemoryClientRegistry.size,
        preserved: true,
        clients: Array.from(inMemoryClientRegistry.values()),
      });
    }

    hasSyncedInMemoryClients = true;
    const prevRegistry = new Map(inMemoryClientRegistry);
    inMemoryClientRegistry.clear();
    clientAuthCache.clear();
    const activeIds = new Set();
    for (const item of req.body.clients) {
      if (!item || !item.clientId) continue;
      const cid = normalizeClientId(item.clientId);
      if (!cid) continue;
      const nextStatus = item.status === 'revoked' ? 'revoked' : 'active';
      const nextToken = String(item.token || '');
      const prev = prevRegistry.get(cid);
      activeIds.add(cid);
      deletedClientsSet.delete(cid);
      inMemoryClientRegistry.set(cid, {
        clientId: cid,
        name: String(item.name || cid),
        status: nextStatus,
        token: nextToken,
        rateLimit: Math.max(1, Number(item.rateLimit) || 100),
        storageQuotaMb: Math.max(0, Math.floor(Number(item.storageQuotaMb) || 0)),
        allowedIps: typeof item.allowedIps === 'string' ? item.allowedIps : '',
        expiresAt: item.expiresAt ? String(item.expiresAt) : null,
      });
      if (nextStatus === 'revoked' || (prev && nextToken && prev.token !== nextToken)) {
        io.to(`client:${cid}`).disconnectSockets(true);
      }
    }
    if (forceReplace) {
      for (const prevCid of prevRegistry.keys()) {
        if (!activeIds.has(prevCid)) {
          io.to(`client:${prevCid}`).disconnectSockets(true);
        }
      }
    }
    return res.json({ success: true, count: activeIds.size, preserved: false });
  }

  const rawClientId = req.body && req.body.clientId ? String(req.body.clientId) : '';
  const normalizedId = normalizeClientId(rawClientId);
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
      pendingDbClientActivity.delete(normalizedId);
      purgeClientFromLocalBuffer(normalizedId);
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
          storageQuotaMb: Math.max(0, Math.floor(Number(clientPayload.storageQuotaMb) || 0)),
          allowedIps: typeof clientPayload.allowedIps === 'string' ? clientPayload.allowedIps : '',
          expiresAt: clientPayload.expiresAt ? String(clientPayload.expiresAt) : null,
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
          storageQuotaMb: 0,
          allowedIps: '',
          expiresAt: null,
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
          storageQuotaMb: Math.max(0, Math.floor(Number(clientPayload.storageQuotaMb) || 0)),
          allowedIps: typeof clientPayload.allowedIps === 'string' ? clientPayload.allowedIps : '',
          expiresAt: clientPayload.expiresAt ? String(clientPayload.expiresAt) : null,
        });
      }
    } else if (action === 'updated') {
      const prevClient = inMemoryClientRegistry.get(normalizedId);
      const nextStatus =
        clientPayload && clientPayload.status === 'revoked' ? 'revoked' : 'active';
      const nextToken = clientPayload ? String(clientPayload.token || '') : '';
      const nextAllowedIps =
        clientPayload && typeof clientPayload.allowedIps === 'string'
          ? clientPayload.allowedIps.trim()
          : '';
      const nextExpiresAt =
        clientPayload && clientPayload.expiresAt
          ? String(clientPayload.expiresAt)
          : null;

      if (clientPayload) {
        inMemoryClientRegistry.set(normalizedId, {
          clientId: normalizedId,
          name: String(clientPayload.name || normalizedId),
          status: nextStatus,
          token: nextToken,
          rateLimit: Math.max(1, Number(clientPayload.rateLimit) || 100),
          storageQuotaMb: Math.max(0, Math.floor(Number(clientPayload.storageQuotaMb) || 0)),
          allowedIps: nextAllowedIps,
          expiresAt: nextExpiresAt,
        });
      }

      const tokenExpired = Boolean(
        nextExpiresAt && isClientTokenExpired(nextExpiresAt),
      );
      const shouldDisconnectRoom =
        !clientPayload ||
        nextStatus === 'revoked' ||
        tokenExpired ||
        Boolean(
          prevClient &&
            (prevClient.status !== nextStatus ||
              (nextToken && prevClient.token !== nextToken) ||
              (prevClient.allowedIps || '').trim() !== nextAllowedIps ||
              (prevClient.expiresAt || null) !== nextExpiresAt),
        );

      let disconnected = false;
      if (shouldDisconnectRoom) {
        io.to(`client:${normalizedId}`).disconnectSockets(true);
        disconnected = true;
      } else if (!prevClient) {
        const liveSockets = await io.in(`client:${normalizedId}`).fetchSockets();
        for (const sock of liveSockets) {
          const sockToken =
            sock.data && sock.data.token ? String(sock.data.token) : '';
          const sockIp =
            sock.data && sock.data.clientIp ? String(sock.data.clientIp) : '';
          const tokenMismatch = Boolean(
            nextToken && sockToken && sockToken !== nextToken,
          );
          const ipForbidden = Boolean(
            nextAllowedIps && (!sockIp || !isClientIpAllowed(sockIp, nextAllowedIps)),
          );
          if (tokenMismatch || ipForbidden) {
            sock.disconnect(true);
            disconnected = true;
          }
        }
      }

      return res.json({ success: true, disconnected });
    }
  }

  res.json({ success: true });
});

app.post('/internal/admin-session-sync', requireInternalAuth, (req, res) => {
  const synced = syncInMemoryAdminSessionState(req.body || {});
  res.json({ success: true, synced });
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
  if (activityFlushTimer) {
    clearInterval(activityFlushTimer);
    activityFlushTimer = null;
  }
}

let isShuttingDown = false;

async function closeServerGracefully() {
  try {
    await Promise.race([
      new Promise((resolve) => {
        if (io && typeof io.close === 'function') {
          io.close(() => resolve());
        } else if (server && server.listening) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      }),
      sleepMs(2000),
    ]);
    if (server && typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  } catch {
    // Ignore close errors
  }
}

async function gracefulShutdown(signal, options = {}) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const shouldExit = options.exit !== false;
  console.log(
    `[DataStack Ingestion Engine] Received ${signal}, closing ingress and flushing buffer before exit...`,
  );

  try {
    stopTimers();

    // Close Socket.IO & HTTP listeners before final flush so late traffic cannot enter after drain starts
    if (filesManagerHandle && typeof filesManagerHandle.close === 'function') {
      await Promise.race([filesManagerHandle.close().catch(() => undefined), sleepMs(2000)]);
      filesManagerHandle = null;
    }
    await closeServerGracefully();

    try {
      if (pendingRedisWrites.size > 0) {
        await Promise.race([
          Promise.allSettled([...pendingRedisWrites]),
          sleepMs(2000),
        ]);
      }
      await Promise.race([
        Promise.allSettled([flushBuffer(), flushPendingClientActivity()]),
        sleepMs(6000),
      ]);
    } catch {
      // Best-effort flush on exit
    }

    try {
      const activeRedis =
        redisTestOverride !== undefined ? redisTestOverride : redisClient;
      if (activeRedis && typeof activeRedis.quit === 'function') {
        let quitFinished = false;
        await Promise.race([
          activeRedis
            .quit()
            .then(() => {
              quitFinished = true;
            })
            .catch(() => {
              quitFinished = true;
            }),
          sleepMs(2000),
        ]);
        if (!quitFinished && typeof activeRedis.disconnect === 'function') {
          activeRedis.disconnect();
        }
      }
      if (dbPool && typeof dbPool.end === 'function') {
        await Promise.race([dbPool.end().catch(() => undefined), sleepMs(2000)]);
      }
    } catch {
      // Ignore close errors
    }

    if (shouldExit) {
      process.exit(0);
    }
  } finally {
    if (!shouldExit) {
      isShuttingDown = false;
    }
  }
}

async function startIngestionServer() {
  if (dbPool) {
    await Promise.race([
      syncSettingsFromDatabase().catch(() => false),
      sleepMs(5000),
    ]);
    settingsSyncTimer = setInterval(() => {
      void syncSettingsFromDatabase();
    }, 3000);
  }

  pruneTimer = setInterval(() => {
    if (!isDbReadyForMaintenance()) return;
    if (runtimeConfig.compressAfterDays > 0) {
      void writer
        .compressOldPartitionsAsync(runtimeConfig.compressAfterDays)
        .catch(() => undefined);
    }
    if (runtimeConfig.autoPruneDays > 0 && !runtimeConfig.enableS3Backup) {
      void writer
        .pruneExpiredPartitionsAsync(runtimeConfig.autoPruneDays)
        .catch(() => undefined);
    }
  }, PRUNE_INTERVAL_MS);

  if (isShuttingDown) return;

  if (!filesManagerHandle) {
    filesManagerHandle = await mountFilesManager({
      app,
      server,
      rootDir: writer.baseDir,
      getDbPool: () => dbPool,
      corsOriginDelegate,
    });
  }

  await new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(
        `[DataStack Ingestion Engine] Express + Socket.IO listening on port ${PORT}`,
      );
      resolve();
    });
  });
}

if (process.env.DATASTACK_DISABLE_LISTEN !== '1') {
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });

  void startIngestionServer();
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
  flushPendingClientActivity,
  applyRuntimeSettingsObject,
  ensureDatabaseSchema,
  syncSettingsFromDatabase,
  isDbReadyForMaintenance,
  gracefulShutdown,
  startIngestionServer,
  setRedisClientForTests,
  setDbPoolForTests,
  stopTimers,
  parseAllowedCorsOrigins,
  isOriginAllowedByCors,
  corsOriginDelegate,
  isClientIpAllowed,
  isClientTokenExpired,
  triggerWebhookAlert,
  validateOutboundWebhookUrlAsync,
  clearWebhookCooldownCacheForTests,
  decryptVaultSecret,
  formatOutboundWebhookBody,
  mountFilesManager,
  syncInMemoryAdminSessionState,
  clearInMemoryAdminSessionStateForTests,
  getFilesManagerHandle: () => filesManagerHandle,
};
