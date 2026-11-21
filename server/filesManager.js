const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');

const FILES_ENGINE_PREFIX = '/vcon/files-engine';
const FILES_ENGINE_SOCKET_PATH = `${FILES_ENGINE_PREFIX}/socket.io`;
const SESSION_COOKIE_NAME = 'datastack_admin_session';
const DEV_DEFAULT_SESSION_SECRET = 'datastack-admin-session-default-secret-32-chars';
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const CLOUDCMD_MUTATION_ROUTE_RE =
  /^\/api\/v\d+\/(?:fs(?:\/|$)|rename\b|mv\b|cp\b|pack\b|extract\b)/i;
const WRITE_SOCKET_NAMESPACES = ['/fileop'];
const EDITOR_SOCKET_NAMESPACES = ['/edward', '/dword', '/qword', '/deepword'];
const JSON_COMMAND_ROUTE_RE = /^\/api\/v\d+\/(?:rename|mv|cp|pack|extract)(?:\?|$)/i;
const MAX_JSON_COMMAND_BODY_BYTES = 512 * 1024;
const MAX_IN_MEMORY_AUDIT_LOGS = 1000;
const pendingFilesAuditPromises = new Set();
const BLOCKED_VIEWER_SOCKET_EVENTS = new Set([
  'save',
  'write',
  'patch',
  'delete',
  'remove',
  'rename',
  'move',
  'copy',
  'pack',
  'extract',
  'mkdir',
  'mkfile',
  'touch',
]);

function normalizeAdminRole(raw, fallback = 'viewer') {
  if (typeof raw !== 'string') return fallback;
  const clean = raw.trim().toLowerCase();
  if (clean === 'owner' || clean === 'admin' || clean === 'operator' || clean === 'viewer') {
    return clean;
  }
  return fallback;
}

function getAdminSessionSecret(env = process.env) {
  const configured = String(env.DATASTACK_ADMIN_SESSION_SECRET || '').trim();
  if (env.NODE_ENV === 'production') {
    return configured.length >= 32 ? configured : null;
  }
  if (configured.length > 0) {
    return configured.length >= 32 ? configured : null;
  }
  return DEV_DEFAULT_SESSION_SECRET;
}

function parseCookieHeader(rawHeader) {
  const cookies = {};
  if (typeof rawHeader !== 'string' || !rawHeader.trim()) {
    return cookies;
  }
  const pairs = rawHeader.split(';');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = pair.slice(0, eqIndex).trim();
    const rawVal = pair.slice(eqIndex + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(rawVal);
    } catch {
      cookies[key] = rawVal;
    }
  }
  return cookies;
}

function verifyAdminSessionTokenSync(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string' || !token || typeof secret !== 'string' || secret.length < 32) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [payloadPart, sigPart] = parts;

  try {
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(payloadPart, 'utf8')
      .digest();
    const presentedSig = Buffer.from(sigPart, 'base64url');
    if (
      expectedSig.length !== presentedSig.length ||
      !crypto.timingSafeEqual(expectedSig, presentedSig)
    ) {
      return null;
    }

    const decoded = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const session = JSON.parse(decoded);
    if (
      !session ||
      typeof session !== 'object' ||
      typeof session.email !== 'string' ||
      !session.email.trim() ||
      typeof session.expiresAt !== 'number' ||
      session.expiresAt <= nowMs ||
      typeof session.tokenVersion !== 'number' ||
      !Number.isInteger(session.tokenVersion) ||
      session.tokenVersion < 1
    ) {
      return null;
    }

    return {
      email: session.email.trim(),
      expiresAt: session.expiresAt,
      tokenVersion: session.tokenVersion,
      role: session.role ? normalizeAdminRole(session.role, 'owner') : 'owner',
      memberId: typeof session.memberId === 'string' ? session.memberId : undefined,
    };
  } catch {
    return null;
  }
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractFilesClientIp(req) {
  const headers = (req && req.headers) || {};
  const realIp =
    typeof headers['x-real-ip'] === 'string' ? headers['x-real-ip'].trim() : '';
  if (realIp) {
    return realIp.slice(0, 128);
  }
  const forwardedFor =
    typeof headers['x-forwarded-for'] === 'string'
      ? headers['x-forwarded-for']
      : '';
  if (forwardedFor) {
    const hops = forwardedFor
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const rightmost = hops[hops.length - 1];
    if (rightmost) {
      return rightmost.slice(0, 128);
    }
  }
  const socketIp =
    (req && req.socket && req.socket.remoteAddress) ||
    (req && req.ip) ||
    '';
  return String(socketIp).trim() || '127.0.0.1';
}

function trackPendingFilesAudit(promise) {
  pendingFilesAuditPromises.add(promise);
  promise.finally(() => {
    pendingFilesAuditPromises.delete(promise);
  });
}

async function flushPendingFilesAuditLogsForTests() {
  if (pendingFilesAuditPromises.size > 0) {
    await Promise.allSettled([...pendingFilesAuditPromises]);
  }
}

async function recordFilesAuditLogAsync({
  dbPool,
  actorEmail,
  actorRole,
  target,
  ipAddress,
  metadata,
}) {
  const entry = {
    id: `aud_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
    actorEmail: String(actorEmail || 'system').trim().toLowerCase(),
    actorRole: normalizeAdminRole(actorRole, 'owner'),
    action: 'FILES_MANAGER_MUTATION',
    target: String(target || '/').trim() || '/',
    ipAddress: String(ipAddress || '').trim(),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: new Date().toISOString(),
  };

  if (dbPool && typeof dbPool.query === 'function') {
    try {
      await dbPool.query(
        `
          INSERT INTO admin_audit_logs (
            id,
            actor_email,
            actor_role,
            action,
            target,
            ip_address,
            metadata_json,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
        `,
        [
          entry.id,
          entry.actorEmail,
          entry.actorRole,
          entry.action,
          entry.target,
          entry.ipAddress,
          JSON.stringify(entry.metadata),
          entry.createdAt,
        ],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[DataStack Files Audit] PostgreSQL audit insert failed for target=${entry.target}: ${msg}`,
      );
    }
    return entry;
  }

  if (!Array.isArray(globalThis.__dataStackAuditLogs)) {
    globalThis.__dataStackAuditLogs = [];
  }
  globalThis.__dataStackAuditLogs.unshift(entry);
  if (globalThis.__dataStackAuditLogs.length > MAX_IN_MEMORY_AUDIT_LOGS) {
    globalThis.__dataStackAuditLogs.length = MAX_IN_MEMORY_AUDIT_LOGS;
  }
  return entry;
}

function extractFilesAuditTarget(rawUrl, parsedBody) {
  const decoded = safeDecodeUrlRepeatedly(rawUrl || '/') || String(rawUrl || '/');
  const [pathnamePart] = decoded.split('?');
  const normalizedRoute = pathnamePart || '/';

  if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
    const primaryPath =
      typeof parsedBody.to === 'string' && parsedBody.to.trim()
        ? parsedBody.to.trim()
        : typeof parsedBody.from === 'string' && parsedBody.from.trim()
          ? parsedBody.from.trim()
          : typeof parsedBody.path === 'string' && parsedBody.path.trim()
            ? parsedBody.path.trim()
            : '';
    if (primaryPath) {
      return primaryPath;
    }
  }

  const strippedFs = normalizedRoute.replace(/^\/api\/v\d+\/fs/i, '');
  if (strippedFs && strippedFs !== normalizedRoute) {
    return strippedFs.startsWith('/') ? strippedFs : `/${strippedFs}`;
  }
  return normalizedRoute;
}

const inMemoryAdminSessionById = new Map();
const inMemoryAdminSessionByEmail = new Map();

function syncInMemoryAdminSessionState(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const memberId = typeof payload.memberId === 'string' ? payload.memberId.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const prevEmail =
    typeof payload.previousEmail === 'string' ? payload.previousEmail.trim().toLowerCase() : '';
  const disabled = Boolean(payload.disabled || payload.deleted);
  const parsedMin = Number(payload.minTokenVersion ?? payload.tokenVersion);
  const minTokenVersion =
    Number.isInteger(parsedMin) && parsedMin >= 1 ? parsedMin : 1;

  const updateKey = (map, key) => {
    if (!key) return;
    const prev = map.get(key);
    const mergedMin = Math.max(prev ? prev.minTokenVersion : 1, minTokenVersion);
    map.set(key, {
      minTokenVersion: mergedMin,
      disabled,
      updatedAt: Date.now(),
    });
  };

  if (memberId) updateKey(inMemoryAdminSessionById, memberId);
  if (email) updateKey(inMemoryAdminSessionByEmail, email);
  if (prevEmail && prevEmail !== email) {
    // Old email sessions must also be invalidated on email change
    const prevRec = inMemoryAdminSessionByEmail.get(prevEmail);
    inMemoryAdminSessionByEmail.set(prevEmail, {
      minTokenVersion: Math.max(prevRec ? prevRec.minTokenVersion : 1, minTokenVersion),
      disabled: true,
      updatedAt: Date.now(),
    });
  }
  return Boolean(memberId || email || prevEmail);
}

function clearInMemoryAdminSessionStateForTests() {
  inMemoryAdminSessionById.clear();
  inMemoryAdminSessionByEmail.clear();
}

function checkInMemorySessionRevocation(session) {
  const memberId = (session.memberId || 'owner-1').trim();
  const email = session.email.toLowerCase();
  const byId = memberId ? inMemoryAdminSessionById.get(memberId) : undefined;
  const byEmail = email ? inMemoryAdminSessionByEmail.get(email) : undefined;
  for (const record of [byId, byEmail]) {
    if (!record) continue;
    if (record.disabled) {
      return {
        revoked: true,
        error: 'Admin session has been disabled or revoked.',
      };
    }
    if (session.tokenVersion < record.minTokenVersion) {
      return {
        revoked: true,
        error: 'Admin session has been revoked. Please sign in again.',
      };
    }
  }
  return { revoked: false };
}

async function authenticateFilesRequest({
  cookieHeader,
  dbPool,
  env = process.env,
  nowMs = Date.now(),
}) {
  const secret = getAdminSessionSecret(env);
  if (!secret) {
    return {
      valid: false,
      status: 503,
      code: 'FILES_AUTH_UNCONFIGURED',
      error: 'Admin session authentication is not configured.',
    };
  }

  const cookies = parseCookieHeader(cookieHeader);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken) {
    return {
      valid: false,
      status: 401,
      code: 'UNAUTHORIZED',
      error: 'Admin authentication required.',
    };
  }

  const session = verifyAdminSessionTokenSync(rawToken, secret, nowMs);
  if (!session) {
    return {
      valid: false,
      status: 401,
      code: 'UNAUTHORIZED',
      error: 'Invalid or expired admin session.',
    };
  }

  if (!dbPool || typeof dbPool.query !== 'function') {
    const revocation = checkInMemorySessionRevocation(session);
    if (revocation.revoked) {
      return {
        valid: false,
        status: 401,
        code: 'SESSION_REVOKED',
        error: revocation.error,
      };
    }
    return {
      valid: true,
      session: {
        ...session,
        role: normalizeAdminRole(session.role, 'owner'),
        memberId: session.memberId || 'owner-1',
      },
    };
  }

  const sessionEmail = session.email.toLowerCase();
  try {
    const ownerRes = await dbPool.query(
      'SELECT email, COALESCE(token_version, 1) AS token_version FROM admin_users WHERE id = 1',
    );
    if (ownerRes && Array.isArray(ownerRes.rows) && ownerRes.rows.length > 0) {
      const ownerRow = ownerRes.rows[0];
      const ownerEmail = String(ownerRow.email || '').trim().toLowerCase();
      if (ownerEmail && timingSafeStringEqual(sessionEmail, ownerEmail)) {
        const dbVersion = Number(ownerRow.token_version) || 1;
        if (session.tokenVersion !== dbVersion) {
          return {
            valid: false,
            status: 401,
            code: 'SESSION_REVOKED',
            error: 'Admin session has been revoked. Please sign in again.',
          };
        }
        return {
          valid: true,
          session: {
            ...session,
            email: ownerRow.email,
            role: 'owner',
            memberId: 'owner-1',
          },
        };
      }
    }

    const teamRes = await dbPool.query(
      `SELECT id, email, role, status, COALESCE(token_version, 1) AS token_version
       FROM admin_team_members
       WHERE LOWER(email) = $1`,
      [sessionEmail],
    );

    if (teamRes && Array.isArray(teamRes.rows) && teamRes.rows.length > 0) {
      const member = teamRes.rows[0];
      const dbVersion = Number(member.token_version) || 1;
      if (member.status !== 'active' || session.tokenVersion !== dbVersion) {
        return {
          valid: false,
          status: 401,
          code: 'SESSION_REVOKED',
          error: 'Team session has been disabled or revoked.',
        };
      }
      return {
        valid: true,
        session: {
          ...session,
          email: member.email,
          role: normalizeAdminRole(member.role, 'viewer'),
          memberId: member.id,
        },
      };
    }

    // Fallback for env-configured admin before DB admin_users row exists
    const hasOwnerRow = Boolean(ownerRes && Array.isArray(ownerRes.rows) && ownerRes.rows.length > 0);
    if (!hasOwnerRow) {
      const envAdminEmail = String(env.DATASTACK_ADMIN_EMAIL || 'admin@datastack.dev')
        .trim()
        .toLowerCase();
      if (timingSafeStringEqual(sessionEmail, envAdminEmail)) {
        return {
          valid: true,
          session: {
            ...session,
            role: 'owner',
            memberId: 'owner-1',
          },
        };
      }
    }

    return {
      valid: false,
      status: 401,
      code: 'SESSION_REVOKED',
      error: 'Admin account not found or session revoked.',
    };
  } catch {
    return {
      valid: false,
      status: 503,
      code: 'AUTH_DB_UNAVAILABLE',
      error: 'Database session verification is temporarily unavailable.',
    };
  }
}

function matchesHeaderHost(candidateUrl, headers) {
  const requestHost = String(headers.host || '').trim();
  const forwardedHost = String(headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  if (!requestHost && !forwardedHost) return false;

  try {
    const parsedHost = new URL(candidateUrl).host.toLowerCase();
    return Boolean(
      (requestHost && parsedHost === requestHost.toLowerCase()) ||
        (forwardedHost && parsedHost === forwardedHost.toLowerCase()),
    );
  } catch {
    return false;
  }
}

function isSameOriginFilesRequest(req) {
  const headers = (req && req.headers) || {};
  const secFetchSite = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return false;
  }
  const originHeader = headers.origin;
  if (typeof originHeader === 'string' && originHeader.trim()) {
    return matchesHeaderHost(originHeader.trim(), headers);
  }
  const refererHeader = headers.referer;
  if (typeof refererHeader === 'string' && refererHeader.trim()) {
    return matchesHeaderHost(refererHeader.trim(), headers);
  }
  if (secFetchSite === 'same-origin') {
    return true;
  }
  return false;
}

function safeDecodeUrlRepeatedly(rawValue) {
  let current = String(rawValue || '');
  for (let i = 0; i < 3; i += 1) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

function inspectFilesRequestPath(rawUrl, rootDir) {
  const decoded = safeDecodeUrlRepeatedly(rawUrl || '/');
  if (decoded === null) {
    return {
      allowed: false,
      status: 403,
      code: 'PATH_OUTSIDE_ROOT',
      error: 'Malformed URL encoding rejected.',
    };
  }

  if (decoded.includes('\0') || decoded.includes('\\')) {
    return {
      allowed: false,
      status: 403,
      code: 'PATH_OUTSIDE_ROOT',
      error: 'Invalid path characters rejected.',
    };
  }

  const [pathnamePart, queryPart = ''] = decoded.split('?');
  const pathSegments = pathnamePart.split('/').filter(Boolean);

  for (const segment of pathSegments) {
    if (segment === '..') {
      return {
        allowed: false,
        status: 403,
        code: 'PATH_OUTSIDE_ROOT',
        error: 'Path traversal outside storage root is forbidden.',
      };
    }
    if (segment.toLowerCase().endsWith('.lock')) {
      return {
        allowed: false,
        status: 403,
        code: 'LOCKFILE_PROTECTED',
        error: 'Cooperative storage lockfiles (*.lock) are protected from manual access.',
      };
    }
  }

  if (queryPart) {
    const queryLower = queryPart.toLowerCase();
    if (queryLower.includes('..') || queryLower.includes('\0')) {
      return {
        allowed: false,
        status: 403,
        code: 'PATH_OUTSIDE_ROOT',
        error: 'Path traversal in query parameters is forbidden.',
      };
    }
    if (/\.lock(?:$|[&/])/i.test(queryPart)) {
      return {
        allowed: false,
        status: 403,
        code: 'LOCKFILE_PROTECTED',
        error: 'Cooperative storage lockfiles (*.lock) are protected.',
      };
    }
  }

  if (rootDir) {
    const resolvedRoot = path.resolve(rootDir);
    const fsRelative = pathnamePart
      .replace(/^\/api\/v1\/fs/i, '')
      .replace(/^\/fs/i, '')
      .replace(/^\/+/, '');
    const candidatePath = path.resolve(resolvedRoot, fsRelative);
    if (
      candidatePath !== resolvedRoot &&
      !candidatePath.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      return {
        allowed: false,
        status: 403,
        code: 'PATH_OUTSIDE_ROOT',
        error: 'Resolved filesystem path is outside the storage root.',
      };
    }
  }

  return { allowed: true };
}

function inspectNestedPaths(value, rootDir, depth = 0) {
  if (depth > 6 || value === null || value === undefined) {
    return { allowed: true };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return { allowed: true };
    return inspectFilesRequestPath(trimmed.startsWith('/') ? trimmed : `/${trimmed}`, rootDir);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const check = inspectNestedPaths(item, rootDir, depth + 1);
      if (!check.allowed) return check;
    }
    return { allowed: true };
  }
  if (typeof value === 'object') {
    for (const key of ['from', 'to', 'name', 'names', 'path', 'files', 'source', 'dest']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const check = inspectNestedPaths(value[key], rootDir, depth + 1);
        if (!check.allowed) return check;
      }
    }
  }
  return { allowed: true };
}

async function readSmallRequestBody(req, maxBytes = MAX_JSON_COMMAND_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      return { overflow: true, buffer: null };
    }
    chunks.push(buf);
  }
  return { overflow: false, buffer: Buffer.concat(chunks) };
}

function buildCloudCmdConfig(rootDir) {
  const resolvedRoot = path.resolve(rootDir || path.resolve(__dirname, '../storage/data'));
  return {
    name: 'DataStack Files Manager',
    root: resolvedRoot,
    prefix: FILES_ENGINE_PREFIX,
    prefixSocket: '',
    auth: false,
    username: '',
    password: '',
    console: false,
    syncConsolePath: false,
    terminal: false,
    terminalPath: '',
    terminalCommand: '',
    terminalAutoRestart: false,
    configDialog: false,
    configAuth: false,
    configPort: false,
    open: false,
    online: false,
    contact: false,
    oneFilePanel: true,
    keysPanel: true,
    packer: 'zip',
    editor: 'edward',
    diff: true,
    zip: true,
    buffer: true,
    showDotFiles: false,
    showConfig: false,
    export: false,
    exportToken: '',
    import: false,
    importToken: '',
    importListen: false,
    dropbox: false,
    dropboxToken: '',
    log: false,
  };
}

function createFilesSecurityMiddleware({
  rootDir,
  getDbPool,
  env = process.env,
}) {
  return async function filesManagerSecurityGuard(req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private');

    const auth = await authenticateFilesRequest({
      cookieHeader: req.headers.cookie,
      dbPool: typeof getDbPool === 'function' ? getDbPool() : null,
      env,
    });

    if (!auth.valid) {
      return res.status(auth.status).json({
        success: false,
        code: auth.code,
        error: auth.error,
      });
    }

    const method = String(req.method || 'GET').toUpperCase();
    const isSafeMethod = SAFE_HTTP_METHODS.has(method);

    if (!isSafeMethod) {
      if (!isSameOriginFilesRequest(req)) {
        return res.status(403).json({
          success: false,
          code: 'CSRF_REJECTED',
          error: 'Cross-origin file mutation request rejected.',
        });
      }

      if (auth.session.role === 'viewer') {
        return res.status(403).json({
          success: false,
          code: 'INSUFFICIENT_ROLE_PERMISSION',
          error: 'Viewer role has read-only access to Files Manager.',
        });
      }
    }

    const pathCheck = inspectFilesRequestPath(req.url || '/', rootDir);
    if (!pathCheck.allowed) {
      return res.status(pathCheck.status).json({
        success: false,
        code: pathCheck.code,
        error: pathCheck.error,
      });
    }

    // Block config PATCH/socket endpoints defensively even though configDialog is false
    if (!isSafeMethod && /^\/api\/v\d+\/config\b/i.test(req.url || '')) {
      return res.status(403).json({
        success: false,
        code: 'CONFIG_LOCKED',
        error: 'Files Manager runtime configuration is locked by server policy.',
      });
    }

    // Inspect JSON bodies of CloudCmd rename/mv/cp/pack/extract commands for *.lock and traversal
    let parsedCommandBody = null;
    if (method === 'PUT' && JSON_COMMAND_ROUTE_RE.test(req.url || '')) {
      const readResult = await readSmallRequestBody(req);
      if (readResult.overflow) {
        return res.status(413).json({
          success: false,
          code: 'PAYLOAD_TOO_LARGE',
          error: 'Command payload exceeds maximum allowed size.',
        });
      }
      const rawBuffer = readResult.buffer;
      if (rawBuffer && rawBuffer.length > 0) {
        try {
          const parsed = JSON.parse(rawBuffer.toString('utf8'));
          parsedCommandBody = parsed;
          const bodyCheck = inspectNestedPaths(parsed, rootDir);
          if (!bodyCheck.allowed) {
            return res.status(bodyCheck.status).json({
              success: false,
              code: bodyCheck.code,
              error: bodyCheck.error,
            });
          }
        } catch {
          // Let CloudCmd return its standard malformed JSON error
        }
      }
      req[Symbol.asyncIterator] = async function* replayBufferedBody() {
        if (rawBuffer && rawBuffer.length > 0) {
          yield rawBuffer;
        }
      };
    }

    if (
      MUTATING_HTTP_METHODS.has(method) &&
      CLOUDCMD_MUTATION_ROUTE_RE.test(req.url || '')
    ) {
      const actorIp = extractFilesClientIp(req);
      const rawReqUrl = req.url || '/';
      const auditTarget = extractFilesAuditTarget(rawReqUrl, parsedCommandBody);
      const commandMeta =
        parsedCommandBody &&
        typeof parsedCommandBody === 'object' &&
        !Array.isArray(parsedCommandBody)
          ? {
              ...(typeof parsedCommandBody.from === 'string'
                ? { from: parsedCommandBody.from }
                : {}),
              ...(typeof parsedCommandBody.to === 'string'
                ? { to: parsedCommandBody.to }
                : {}),
              ...(Array.isArray(parsedCommandBody.names)
                ? { names: parsedCommandBody.names.slice(0, 20) }
                : {}),
            }
          : {};

      res.on('finish', () => {
        if (res.statusCode < 200 || res.statusCode >= 400) return;
        const pool = typeof getDbPool === 'function' ? getDbPool() : null;
        trackPendingFilesAudit(
          recordFilesAuditLogAsync({
            dbPool: pool,
            actorEmail: auth.session.email,
            actorRole: auth.session.role,
            target: auditTarget,
            ipAddress: actorIp,
            metadata: {
              transport: 'http',
              method,
              path: auditTarget,
              route: (safeDecodeUrlRepeatedly(rawReqUrl) || rawReqUrl).split('?')[0],
              statusCode: res.statusCode,
              ...commandMeta,
            },
          }),
        );
      });
    }

    req.datastackAdminSession = auth.session;
    return next();
  };
}

function attachSocketSecurityGuards(filesIo, { rootDir, getDbPool, env = process.env }) {
  const verifyHandshake = async (socket, next) => {
    const auth = await authenticateFilesRequest({
      cookieHeader: socket.handshake.headers && socket.handshake.headers.cookie,
      dbPool: typeof getDbPool === 'function' ? getDbPool() : null,
      env,
    });
    if (!auth.valid) {
      return next(new Error(auth.code));
    }
    socket.data.adminSession = auth.session;
    return next();
  };

  filesIo.use(verifyHandshake);

  for (const ns of WRITE_SOCKET_NAMESPACES) {
    filesIo.of(ns).use(async (socket, next) => {
      const auth = await authenticateFilesRequest({
        cookieHeader: socket.handshake.headers && socket.handshake.headers.cookie,
        dbPool: typeof getDbPool === 'function' ? getDbPool() : null,
        env,
      });
      if (!auth.valid) {
        return next(new Error(auth.code));
      }
      if (auth.session.role === 'viewer') {
        return next(new Error('INSUFFICIENT_ROLE_PERMISSION'));
      }
      socket.data.adminSession = auth.session;
      socket.use((packet, packetNext) => {
        const eventName = String((packet && packet[0]) || '').toLowerCase();
        const args = Array.isArray(packet) ? packet.slice(1) : [];
        const pathCheck = inspectNestedPaths(args, rootDir);
        if (!pathCheck.allowed) {
          return packetNext(new Error(pathCheck.code));
        }
        const pool = typeof getDbPool === 'function' ? getDbPool() : null;
        const firstArg = args.find((item) => item !== undefined);
        const socketTarget = extractFilesAuditTarget(
          typeof firstArg === 'string' ? firstArg : '/',
          firstArg && typeof firstArg === 'object' ? firstArg : null,
        );
        trackPendingFilesAudit(
          recordFilesAuditLogAsync({
            dbPool: pool,
            actorEmail: auth.session.email,
            actorRole: auth.session.role,
            target: socketTarget,
            ipAddress: extractFilesClientIp({
              headers: socket.handshake && socket.handshake.headers,
              ip: socket.handshake && socket.handshake.address,
            }),
            metadata: {
              transport: 'socket',
              namespace: ns,
              eventName,
              path: socketTarget,
            },
          }),
        );
        return packetNext();
      });
      return next();
    });
  }

  for (const ns of EDITOR_SOCKET_NAMESPACES) {
    filesIo.of(ns).use(async (socket, next) => {
      const auth = await authenticateFilesRequest({
        cookieHeader: socket.handshake.headers && socket.handshake.headers.cookie,
        dbPool: typeof getDbPool === 'function' ? getDbPool() : null,
        env,
      });
      if (!auth.valid) {
        return next(new Error(auth.code));
      }
      socket.data.adminSession = auth.session;
      socket.use((packet, packetNext) => {
        const eventName = String((packet && packet[0]) || '').toLowerCase();
        if (auth.session.role === 'viewer' && BLOCKED_VIEWER_SOCKET_EVENTS.has(eventName)) {
          return packetNext(new Error('INSUFFICIENT_ROLE_PERMISSION'));
        }
        const args = Array.isArray(packet) ? packet.slice(1) : [];
        const pathCheck = inspectNestedPaths(args, rootDir);
        if (!pathCheck.allowed) {
          return packetNext(new Error(pathCheck.code));
        }
        if (BLOCKED_VIEWER_SOCKET_EVENTS.has(eventName)) {
          const pool = typeof getDbPool === 'function' ? getDbPool() : null;
          const firstArg = args.find((item) => item !== undefined);
          const socketTarget = extractFilesAuditTarget(
            typeof firstArg === 'string' ? firstArg : '/',
            firstArg && typeof firstArg === 'object' ? firstArg : null,
          );
          trackPendingFilesAudit(
            recordFilesAuditLogAsync({
              dbPool: pool,
              actorEmail: auth.session.email,
              actorRole: auth.session.role,
              target: socketTarget,
              ipAddress: extractFilesClientIp({
                headers: socket.handshake && socket.handshake.headers,
                ip: socket.handshake && socket.handshake.address,
              }),
              metadata: {
                transport: 'socket',
                namespace: ns,
                eventName,
                path: socketTarget,
              },
            }),
          );
        }
        return packetNext();
      });
      return next();
    });
  }
}

async function mountFilesManager({
  app,
  server,
  rootDir,
  getDbPool,
  corsOriginDelegate,
  env = process.env,
}) {
  const resolvedRoot = path.resolve(rootDir || path.resolve(__dirname, '../storage/data'));
  fs.mkdirSync(resolvedRoot, { recursive: true });

  const configOptions = buildCloudCmdConfig(resolvedRoot);
  const securityGuard = createFilesSecurityMiddleware({
    rootDir: resolvedRoot,
    getDbPool,
    env,
  });

  const router = express.Router();
  router.use(securityGuard);

  router.get('/_status', (req, res) => {
    const session = req.datastackAdminSession || {};
    const role = normalizeAdminRole(session.role, 'viewer');
    return res.status(200).json({
      ok: true,
      engine: 'cloudcmd',
      prefix: FILES_ENGINE_PREFIX,
      role,
      readOnly: role === 'viewer',
      rootConfigured: true,
    });
  });

  let filesIo = null;
  let engineReady = false;
  let initErrorMessage = '';

  try {
    const cloudcmdPkg = await import('cloudcmd');
    const cloudcmdFn = cloudcmdPkg.cloudcmd || cloudcmdPkg.default;
    const createConfigManager =
      cloudcmdPkg.createConfigManager || (cloudcmdFn && cloudcmdFn.createConfigManager);

    if (typeof cloudcmdFn !== 'function') {
      throw new Error('cloudcmd module did not export middleware function');
    }

    if (server) {
      filesIo = new Server(server, {
        path: FILES_ENGINE_SOCKET_PATH,
        cors: corsOriginDelegate
          ? { origin: corsOriginDelegate, methods: ['GET', 'POST'], credentials: true }
          : undefined,
        allowRequest: (req, callback) => {
          const originHeader = req.headers && req.headers.origin;
          if (originHeader && !matchesHeaderHost(originHeader, req.headers)) {
            return callback('CSRF_REJECTED', false);
          }
          authenticateFilesRequest({
            cookieHeader: req.headers && req.headers.cookie,
            dbPool: typeof getDbPool === 'function' ? getDbPool() : null,
            env,
          })
            .then((auth) => {
              if (!auth.valid) {
                return callback(auth.code, false);
              }
              return callback(null, true);
            })
            .catch(() => callback('AUTH_DB_UNAVAILABLE', false));
        },
      });
      attachSocketSecurityGuards(filesIo, { rootDir: resolvedRoot, getDbPool, env });
    }

    // Use in-memory config manager (no configPath) so ~/.cloudcmd.json is never read or written
    const configManager =
      typeof createConfigManager === 'function' ? createConfigManager({}) : undefined;

    const cloudcmdMiddleware = cloudcmdFn({
      socket: filesIo || undefined,
      config: configOptions,
      configManager,
    });

    router.use(cloudcmdMiddleware);
    engineReady = true;
  } catch (err) {
    initErrorMessage = err instanceof Error ? err.message : String(err);
    console.error('[DataStack Files Manager] Failed to initialize cloudcmd:', initErrorMessage);
    router.use((_req, res) =>
      res.status(503).json({
        success: false,
        code: 'FILES_ENGINE_UNAVAILABLE',
        error: 'Files Manager engine failed to initialize on Port 4000.',
      }),
    );
  }

  app.use(FILES_ENGINE_PREFIX, router);

  return {
    prefix: FILES_ENGINE_PREFIX,
    socketPath: FILES_ENGINE_SOCKET_PATH,
    rootDir: resolvedRoot,
    engineReady,
    initErrorMessage,
    configOptions,
    filesIo,
    router,
    async close() {
      if (!filesIo) return;
      try {
        await new Promise((resolve) => {
          filesIo.close(() => resolve());
        });
      } catch {
        // ignore socket close errors on shutdown
      }
      filesIo = null;
    },
  };
}

module.exports = {
  FILES_ENGINE_PREFIX,
  FILES_ENGINE_SOCKET_PATH,
  SESSION_COOKIE_NAME,
  DEV_DEFAULT_SESSION_SECRET,
  normalizeAdminRole,
  getAdminSessionSecret,
  parseCookieHeader,
  verifyAdminSessionTokenSync,
  authenticateFilesRequest,
  isSameOriginFilesRequest,
  inspectFilesRequestPath,
  buildCloudCmdConfig,
  createFilesSecurityMiddleware,
  mountFilesManager,
  syncInMemoryAdminSessionState,
  clearInMemoryAdminSessionStateForTests,
  flushPendingFilesAuditLogsForTests,
};
