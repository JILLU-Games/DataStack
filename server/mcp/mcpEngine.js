const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { scrubSensitiveLogText } = require('../runtimeLogCapture');

const MCP_PERMISSION_KEYS = [
  'metrics_health_read',
  'runtime_logs_read',
  'build_logs_read',
  'audit_logs_read',
  'ingestion_events_read',
  'clients_read',
  'clients_create',
  'clients_update',
  'clients_revoke_delete',
  'files_list_read',
  'files_download',
  'files_upload_create',
  'files_edit',
  'files_delete',
  'settings_read',
  'settings_write',
  'storage_maintenance',
];

const DEFAULT_MCP_PERMISSIONS = {
  metrics_health_read: true,
  runtime_logs_read: true,
  build_logs_read: true,
  audit_logs_read: true,
  ingestion_events_read: true,
  clients_read: true,
  clients_create: false,
  clients_update: false,
  clients_revoke_delete: false,
  files_list_read: true,
  files_download: true,
  files_upload_create: false,
  files_edit: false,
  files_delete: false,
  settings_read: true,
  settings_write: false,
  storage_maintenance: false,
};

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_IN_MEMORY_AUDIT_LOGS = 1000;

function normalizeMcpPermissions(raw, base = DEFAULT_MCP_PERMISSIONS) {
  const out = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  for (const key of MCP_PERMISSION_KEYS) {
    if (typeof raw[key] === 'boolean') {
      out[key] = raw[key];
    }
  }
  return out;
}

function hashMcpToken(rawToken) {
  return crypto
    .createHash('sha256')
    .update(String(rawToken || ''), 'utf8')
    .digest('hex');
}

function verifyMcpBearerTokenHash(presentedToken, expectedHashHex) {
  const cleanPresented = String(presentedToken || '').trim();
  const cleanExpected = String(expectedHashHex || '')
    .trim()
    .toLowerCase();
  if (!cleanPresented || cleanExpected.length !== 64) {
    return false;
  }
  try {
    const presentedBuf = Buffer.from(hashMcpToken(cleanPresented), 'hex');
    const expectedBuf = Buffer.from(cleanExpected, 'hex');
    if (presentedBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(presentedBuf, expectedBuf);
  } catch {
    return false;
  }
}

function extractMcpClientIp(req) {
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
      .map((p) => p.trim())
      .filter(Boolean);
    const rightmost = hops[hops.length - 1];
    if (rightmost) {
      return rightmost.slice(0, 128);
    }
  }
  const socketIp =
    (req && req.socket && req.socket.remoteAddress) || (req && req.ip) || '';
  return String(socketIp).trim() || '127.0.0.1';
}

function sanitizeAuditMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const REDACTED = new Set([
    'token',
    'secret',
    'password',
    'mcpToken',
    'mcpBearerToken',
    'issuedToken',
    'tokenHash',
    'tokenEnc',
    'coolifyToken',
    'coolifyTokenEnc',
    'authorization',
  ]);
  const clean = {};
  for (const [k, v] of Object.entries(meta)) {
    clean[k] = REDACTED.has(k) ? '[REDACTED]' : v;
  }
  return clean;
}

function createMcpEngine(deps) {
  const {
    getStorageDataDir,
    getDbPool,
    isClientIpAllowed,
    resolveInternalSecret,
    decryptVaultSecret,
    validateOutboundUrlAsync,
    flushBuffer,
  } = deps;

  const state = {
    enabled: false,
    tokenHash: '',
    tokenPreview: '',
    allowedIps: '',
    permissions: { ...DEFAULT_MCP_PERMISSIONS },
    coolifyUrl: '',
    coolifyToken: '',
    coolifyAppUuid: '',
    updatedAt: '',
  };

  function resolveSandboxRoot() {
    const dataDir = path.resolve(
      typeof getStorageDataDir === 'function'
        ? getStorageDataDir()
        : path.resolve(process.cwd(), 'storage', 'data'),
    );
    if (path.basename(dataDir).toLowerCase() === 'data') {
      return path.dirname(dataDir);
    }
    return dataDir;
  }

  async function resolveSafeStoragePath(rawRelPath, options = {}) {
    const allowWriteRuntimeLogs = Boolean(options.allowWriteRuntimeLogs);
    const requireExists = Boolean(options.requireExists);
    const sandboxRoot = resolveSandboxRoot();
    await fsp.mkdir(sandboxRoot, { recursive: true });
    const sandboxReal = await fsp.realpath(sandboxRoot);

    const rawStr = String(rawRelPath === undefined || rawRelPath === null ? '' : rawRelPath);
    if (rawStr.includes('\0') || rawStr.includes('\\')) {
      const err = new Error('Invalid characters in storage path.');
      err.code = 'PATH_OUTSIDE_ROOT';
      throw err;
    }

    const stripped = rawStr.trim().replace(/^\/+/, '');
    const normalizedInput = stripped === '.' ? '' : stripped;
    const segments = normalizedInput.split('/').filter(Boolean);

    for (const seg of segments) {
      if (seg === '..' || seg === '.') {
        const err = new Error('Path traversal outside storage root is forbidden.');
        err.code = 'PATH_OUTSIDE_ROOT';
        throw err;
      }
      if (seg.toLowerCase().endsWith('.lock')) {
        const err = new Error('Cooperative storage lockfiles (*.lock) are protected.');
        err.code = 'LOCKFILE_PROTECTED';
        throw err;
      }
    }

    if (
      !allowWriteRuntimeLogs &&
      segments.length > 0 &&
      segments[0].toLowerCase() === '.runtime-logs'
    ) {
      const err = new Error(
        '.runtime-logs directory is read-only via runtime/build log tools.',
      );
      err.code = 'PROTECTED_LOG_DIR';
      throw err;
    }

    const resolvedTarget = segments.length
      ? path.resolve(sandboxRoot, ...segments)
      : sandboxRoot;

    if (
      resolvedTarget !== sandboxRoot &&
      !resolvedTarget.startsWith(`${sandboxRoot}${path.sep}`)
    ) {
      const err = new Error('Resolved path escapes storage sandbox root.');
      err.code = 'PATH_OUTSIDE_ROOT';
      throw err;
    }

    // Walk segments to ensure no symlink ancestor or target escapes sandbox
    let cursor = sandboxRoot;
    for (let i = 0; i < segments.length; i += 1) {
      cursor = path.join(cursor, segments[i]);
      try {
        const st = await fsp.lstat(cursor);
        if (st.isSymbolicLink()) {
          const err = new Error('Symlinks are forbidden inside storage sandbox.');
          err.code = 'SYMLINK_FORBIDDEN';
          throw err;
        }
        const real = await fsp.realpath(cursor);
        if (real !== sandboxReal && !real.startsWith(`${sandboxReal}${path.sep}`)) {
          const err = new Error('Resolved symlink escapes storage sandbox.');
          err.code = 'PATH_OUTSIDE_ROOT';
          throw err;
        }
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          if (requireExists) {
            const notFound = new Error(
              `Storage path '${normalizedInput || '/'}' does not exist.`,
            );
            notFound.code = 'NOT_FOUND';
            throw notFound;
          }
          break;
        }
        throw e;
      }
    }

    return {
      sandboxRoot,
      sandboxReal,
      relativePath: segments.join('/'),
      fullPath: resolvedTarget,
    };
  }

  function syncState(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.enabled !== undefined) {
      state.enabled = Boolean(payload.enabled);
    }
    if (typeof payload.tokenHash === 'string') {
      state.tokenHash = payload.tokenHash.trim().toLowerCase();
    }
    if (typeof payload.tokenPreview === 'string') {
      state.tokenPreview = payload.tokenPreview.trim();
    }
    if (typeof payload.allowedIps === 'string') {
      state.allowedIps = payload.allowedIps.trim();
    }
    if (payload.permissions !== undefined) {
      state.permissions = normalizeMcpPermissions(payload.permissions, state.permissions);
    }
    if (typeof payload.coolifyUrl === 'string') {
      state.coolifyUrl = payload.coolifyUrl.trim();
    }
    if (typeof payload.coolifyToken === 'string') {
      state.coolifyToken = payload.coolifyToken.trim();
    }
    if (typeof payload.coolifyAppUuid === 'string') {
      state.coolifyAppUuid = payload.coolifyAppUuid.trim();
    }
    if (typeof payload.updatedAt === 'string') {
      state.updatedAt = payload.updatedAt;
    }
  }

  async function hydrateFromDatabase(poolArg) {
    const pool = poolArg || (typeof getDbPool === 'function' ? getDbPool() : null);
    if (!pool || typeof pool.query !== 'function') return false;
    try {
      const res = await pool.query(
        `SELECT enabled, token_hash, token_preview, allowed_ips, permissions_json,
                coolify_url, coolify_token_enc, coolify_app_uuid, updated_at
         FROM mcp_settings
         WHERE id = 'default'`,
      );
      if (!res || !res.rowCount || res.rowCount === 0) {
        return true;
      }
      const row = res.rows[0];
      let parsedPerms = {};
      try {
        parsedPerms = JSON.parse(row.permissions_json || '{}');
      } catch {
        parsedPerms = {};
      }
      let decryptedCoolifyToken = '';
      if (row.coolify_token_enc && typeof decryptVaultSecret === 'function') {
        decryptedCoolifyToken = decryptVaultSecret(String(row.coolify_token_enc));
      }
      syncState({
        enabled: Boolean(row.enabled),
        tokenHash: String(row.token_hash || ''),
        tokenPreview: String(row.token_preview || ''),
        allowedIps: String(row.allowed_ips || ''),
        permissions: normalizeMcpPermissions(parsedPerms, DEFAULT_MCP_PERMISSIONS),
        coolifyUrl: String(row.coolify_url || ''),
        coolifyToken: decryptedCoolifyToken,
        coolifyAppUuid: String(row.coolify_app_uuid || ''),
        updatedAt:
          row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : String(row.updated_at || ''),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function recordMcpAudit({ action, target, ipAddress, metadata }) {
    const entry = {
      id: `aud_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
      actorEmail: 'mcp-agent',
      actorRole: 'mcp',
      action,
      target: String(target || 'mcp').slice(0, 256),
      ipAddress: String(ipAddress || '').slice(0, 128),
      metadata: sanitizeAuditMeta(metadata),
      createdAt: new Date().toISOString(),
    };

    const pool = typeof getDbPool === 'function' ? getDbPool() : null;
    if (pool && typeof pool.query === 'function') {
      try {
        await pool.query(
          `INSERT INTO admin_audit_logs (
             id, actor_email, actor_role, action, target, ip_address, metadata_json, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
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
        return entry;
      } catch {
        // Fall through to in-memory buffer only if DB insert failed
      }
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

  async function callWebInternalMcp(action, params, actorIp) {
    const secret =
      typeof resolveInternalSecret === 'function' ? resolveInternalSecret() : '';
    if (!secret) {
      const err = new Error('Internal MCP bridge secret is not configured.');
      err.code = 'MCP_BRIDGE_UNAUTHORIZED';
      throw err;
    }
    const baseUrl = (
      process.env.WEB_INTERNAL_URL ||
      `http://127.0.0.1:${Number(process.env.PORT) || 3000}`
    ).replace(/\/+$/, '');

    const res = await fetch(`${baseUrl}/api/internal/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-datastack-internal-secret': secret,
      },
      body: JSON.stringify({ action, params: params || {}, actorIp }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        (data && data.error) || `Internal MCP bridge returned HTTP ${res.status}`,
      );
      err.code = (data && data.code) || 'MCP_BRIDGE_ERROR';
      throw err;
    }
    return data;
  }

  async function fetchCoolifyLogs(lines = 120) {
    if (!state.coolifyUrl || !state.coolifyToken || !state.coolifyAppUuid) {
      return {
        coolifyConfigured: false,
        note: 'Optional Coolify log integration is not configured in Admin MCP Settings.',
      };
    }

    const endpoint = `${state.coolifyUrl.replace(/\/+$/, '')}/api/v1/applications/${encodeURIComponent(
      state.coolifyAppUuid,
    )}/logs?lines=${Math.min(500, Math.max(1, Number(lines) || 120))}`;

    if (typeof validateOutboundUrlAsync === 'function') {
      const ssrf = await validateOutboundUrlAsync(endpoint);
      if (!ssrf.allowed) {
        const err = new Error(ssrf.error || 'Coolify URL blocked by SSRF guard.');
        err.code = ssrf.code || 'SSRF_BLOCKED_HOST';
        throw err;
      }
    }

    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${state.coolifyToken}`,
        Accept: 'application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });

    if (res.status >= 300 && res.status < 400) {
      const err = new Error(`Coolify endpoint attempted HTTP ${res.status} redirect.`);
      err.code = 'SSRF_BLOCKED_HOST';
      throw err;
    }

    const rawText = await res.text();
    const scrubbed = scrubSensitiveLogText(rawText);
    if (!res.ok) {
      return {
        coolifyConfigured: true,
        ok: false,
        status: res.status,
        error: scrubbed.slice(0, 500),
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(scrubbed);
    } catch {
      parsed = { raw: scrubbed.slice(0, 64 * 1024) };
    }
    return {
      coolifyConfigured: true,
      ok: true,
      data: parsed,
    };
  }

  function formatToolSuccess(data) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  function formatToolError(code, message, extra = {}) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: false,
              code: code || 'MCP_TOOL_ERROR',
              error: message,
              ...extra,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  function createScopedMcpServer(actorIp) {
    const server = new McpServer(
      {
        name: 'datastack-mcp',
        version: '2.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    const registerGuardedTool = (name, config, permissionKey, handler) => {
      server.registerTool(name, config, async (args) => {
        if (!state.permissions[permissionKey]) {
          await recordMcpAudit({
            action: 'MCP_TOOL_DENIED',
            target: name,
            ipAddress: actorIp,
            metadata: {
              permission: permissionKey,
              code: 'MCP_PERMISSION_DENIED',
            },
          });
          return formatToolError(
            'MCP_PERMISSION_DENIED',
            `Permission '${permissionKey}' is disabled in Admin MCP Settings.`,
            { permission: permissionKey, tool: name },
          );
        }

        try {
          const result = await handler(args || {});
          await recordMcpAudit({
            action: 'MCP_TOOL_CALLED',
            target: name,
            ipAddress: actorIp,
            metadata: { permission: permissionKey },
          });
          return formatToolSuccess(result);
        } catch (err) {
          const errCode = (err && err.code) || 'MCP_TOOL_ERROR';
          const errMsg = err instanceof Error ? err.message : String(err);
          await recordMcpAudit({
            action: 'MCP_TOOL_CALLED',
            target: name,
            ipAddress: actorIp,
            metadata: {
              permission: permissionKey,
              errorCode: errCode,
            },
          });
          return formatToolError(errCode, errMsg, { tool: name });
        }
      });
    };

    // 1. Metrics & Health
    registerGuardedTool(
      'datastack_metrics_health',
      {
        description:
          'Inspect live DataStack dashboard metrics, active Socket.IO connections, buffer queue depth, PostgreSQL/Redis status, and VPS disk usage.',
        inputSchema: {},
      },
      'metrics_health_read',
      async () => callWebInternalMcp('metrics_get', {}, actorIp),
    );

    // 2. Runtime Logs (Web + Ingestion)
    registerGuardedTool(
      'datastack_runtime_logs',
      {
        description:
          'Read rotating stdout/stderr runtime logs for Next.js Web (Port 3000) and Ingestion (Port 4000) with optional service, level, and search filters.',
        inputSchema: {
          service: z.enum(['all', 'web', 'ingestion']).optional(),
          lines: z.number().int().min(1).max(500).optional(),
          level: z.enum(['all', 'info', 'error']).optional(),
          search: z.string().max(200).optional(),
        },
      },
      'runtime_logs_read',
      async (args) => callWebInternalMcp('runtime_logs_read', args, actorIp),
    );

    // 3. Build & Optional Coolify Logs
    registerGuardedTool(
      'datastack_build_logs',
      {
        description:
          'Read captured Next.js standalone build logs and build metadata, and optionally fetch Coolify deployment logs when configured.',
        inputSchema: {
          lines: z.number().int().min(1).max(500).optional(),
          search: z.string().max(200).optional(),
          includeCoolify: z.boolean().optional(),
        },
      },
      'build_logs_read',
      async (args) => {
        const buildRes = await callWebInternalMcp(
          'build_logs_read',
          { lines: args.lines, search: args.search },
          actorIp,
        );
        if (args.includeCoolify) {
          const coolify = await fetchCoolifyLogs(args.lines || 120);
          return { ...buildRes, coolify };
        }
        return buildRes;
      },
    );

    // 4. Admin Audit Logs
    registerGuardedTool(
      'datastack_audit_logs',
      {
        description:
          'Query immutable Admin Console, RBAC, Client, Storage, and MCP governance audit logs.',
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional(),
          action: z.string().max(100).optional(),
          actorEmail: z.string().max(160).optional(),
          search: z.string().max(200).optional(),
        },
      },
      'audit_logs_read',
      async (args) => callWebInternalMcp('audit_query', args, actorIp),
    );

    // 5. Ingested Events Query
    registerGuardedTool(
      'datastack_events_query',
      {
        description:
          'Query buffered in-flight events and stored CSV/CSV.GZ telemetry partitions across clients or date ranges.',
        inputSchema: {
          clientId: z.string().max(120).optional(),
          search: z.string().max(200).optional(),
          from: z.string().max(32).optional(),
          to: z.string().max(32).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
      },
      'ingestion_events_read',
      async (args) => callWebInternalMcp('data_query', args, actorIp),
    );

    // 6. Clients Read
    registerGuardedTool(
      'datastack_clients_list',
      {
        description:
          'List all registered SDK clients or inspect a single client by clientId (secrets are redacted).',
        inputSchema: {
          clientId: z.string().max(120).optional(),
        },
      },
      'clients_read',
      async (args) => {
        if (args.clientId) {
          return callWebInternalMcp(
            'clients_get',
            { clientId: args.clientId },
            actorIp,
          );
        }
        return callWebInternalMcp('clients_list', {}, actorIp);
      },
    );

    // 7. Clients Create
    registerGuardedTool(
      'datastack_clients_create',
      {
        description: 'Register a new SDK client and issue its initial client JWT token.',
        inputSchema: {
          clientId: z.string().min(1).max(120),
          name: z.string().min(1).max(120),
          rateLimit: z.number().int().min(1).max(100000).optional(),
          storageQuotaMb: z.number().int().min(0).max(1048576).optional(),
          allowedIps: z.string().max(2048).optional(),
          expiresAt: z.string().max(64).nullable().optional(),
        },
      },
      'clients_create',
      async (args) => callWebInternalMcp('clients_create', args, actorIp),
    );

    // 8. Clients Update
    registerGuardedTool(
      'datastack_clients_update',
      {
        description:
          'Update an existing SDK client (name, rateLimit, storageQuotaMb, allowedIps, expiresAt, or status).',
        inputSchema: {
          clientId: z.string().min(1).max(120),
          name: z.string().min(1).max(120).optional(),
          rateLimit: z.number().int().min(1).max(100000).optional(),
          storageQuotaMb: z.number().int().min(0).max(1048576).optional(),
          allowedIps: z.string().max(2048).optional(),
          expiresAt: z.string().max(64).nullable().optional(),
          status: z.enum(['active', 'revoked']).optional(),
        },
      },
      'clients_update',
      async (args) => callWebInternalMcp('clients_update', args, actorIp),
    );

    // 9. Clients Rotate / Revoke / Delete
    registerGuardedTool(
      'datastack_clients_manage_token',
      {
        description:
          'Rotate a client JWT token, revoke client access, or permanently delete a client (optionally purging CSV files).',
        inputSchema: {
          action: z.enum(['rotate_token', 'revoke', 'delete']),
          clientId: z.string().min(1).max(120),
          purgeFiles: z.boolean().optional(),
        },
      },
      'clients_revoke_delete',
      async (args) => {
        if (args.action === 'rotate_token') {
          return callWebInternalMcp(
            'clients_rotate_token',
            { clientId: args.clientId },
            actorIp,
          );
        }
        if (args.action === 'revoke') {
          return callWebInternalMcp(
            'clients_revoke',
            { clientId: args.clientId },
            actorIp,
          );
        }
        return callWebInternalMcp(
          'clients_delete',
          { clientId: args.clientId, purgeFiles: args.purgeFiles === true },
          actorIp,
        );
      },
    );

    // 10. Files List / Inspect Lines
    registerGuardedTool(
      'datastack_files_list',
      {
        description:
          'List directories or inspect bounded text lines inside /app/storage (symlinks and *.lock files are blocked).',
        inputSchema: {
          path: z.string().max(512).optional(),
          readLines: z.boolean().optional(),
          offsetLines: z.number().int().min(0).max(1000000).optional(),
          limitLines: z.number().int().min(1).max(500).optional(),
        },
      },
      'files_list_read',
      async (args) => {
        const target = await resolveSafeStoragePath(args.path || '', {
          allowWriteRuntimeLogs: true,
          requireExists: true,
        });
        const stat = await fsp.lstat(target.fullPath);
        if (stat.isDirectory()) {
          const rawNames = await fsp.readdir(target.fullPath);
          const entries = [];
          for (const name of rawNames.sort()) {
            if (name.toLowerCase().endsWith('.lock')) continue;
            const childPath = path.join(target.fullPath, name);
            const childStat = await fsp.lstat(childPath).catch(() => null);
            if (!childStat || childStat.isSymbolicLink()) continue;
            entries.push({
              name,
              path: target.relativePath ? `${target.relativePath}/${name}` : name,
              type: childStat.isDirectory() ? 'directory' : 'file',
              sizeBytes: childStat.isFile() ? childStat.size : 0,
              modifiedAt: childStat.mtime.toISOString(),
            });
          }
          return {
            ok: true,
            kind: 'directory',
            path: target.relativePath || '/',
            entries,
            count: entries.length,
          };
        }

        if (!stat.isFile()) {
          const err = new Error('Target is not a regular file or directory.');
          err.code = 'INVALID_FILE_TYPE';
          throw err;
        }

        if (!args.readLines) {
          return {
            ok: true,
            kind: 'file',
            path: target.relativePath,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        }

        const bytesToRead = Math.min(stat.size, MAX_READ_BYTES);
        const fh = await fsp.open(target.fullPath, 'r');
        try {
          const buf = Buffer.allocUnsafe(bytesToRead);
          const { bytesRead } = await fh.read(buf, 0, bytesToRead, 0);
          const text = buf.subarray(0, bytesRead).toString('utf8');
          const allLines = text.split(/\r?\n/);
          const offset = Math.max(0, Number(args.offsetLines) || 0);
          const limit = Math.min(500, Math.max(1, Number(args.limitLines) || 120));
          return {
            ok: true,
            kind: 'file_lines',
            path: target.relativePath,
            totalSizeBytes: stat.size,
            truncatedToBytes: bytesToRead < stat.size ? bytesToRead : null,
            offsetLines: offset,
            lines: allLines.slice(offset, offset + limit),
            totalLinesInWindow: allLines.length,
          };
        } finally {
          await fh.close();
        }
      },
    );

    // 11. Files Download Chunk
    registerGuardedTool(
      'datastack_files_download',
      {
        description:
          'Download a bounded utf8 or base64 byte chunk from a non-locked file inside /app/storage.',
        inputSchema: {
          path: z.string().min(1).max(512),
          offsetBytes: z.number().int().min(0).optional(),
          maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).optional(),
          encoding: z.enum(['utf8', 'base64']).optional(),
        },
      },
      'files_download',
      async (args) => {
        const target = await resolveSafeStoragePath(args.path, {
          allowWriteRuntimeLogs: true,
          requireExists: true,
        });
        const stat = await fsp.lstat(target.fullPath);
        if (!stat.isFile()) {
          const err = new Error('Target path is not a regular file.');
          err.code = 'INVALID_FILE_TYPE';
          throw err;
        }
        const offset = Math.min(stat.size, Math.max(0, Number(args.offsetBytes) || 0));
        const maxBytes = Math.min(
          MAX_READ_BYTES,
          Math.max(1, Number(args.maxBytes) || 131072),
        );
        const remaining = Math.max(0, stat.size - offset);
        const length = Math.min(remaining, maxBytes);
        const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';

        const fh = await fsp.open(target.fullPath, 'r');
        try {
          const buf = Buffer.allocUnsafe(length);
          const { bytesRead } = length > 0
            ? await fh.read(buf, 0, length, offset)
            : { bytesRead: 0 };
          const slice = buf.subarray(0, bytesRead);
          return {
            ok: true,
            path: target.relativePath,
            encoding,
            offsetBytes: offset,
            bytesRead,
            totalSizeBytes: stat.size,
            hasMore: offset + bytesRead < stat.size,
            content: slice.toString(encoding),
          };
        } finally {
          await fh.close();
        }
      },
    );

    // 12. Files Upload / Create
    registerGuardedTool(
      'datastack_files_upload',
      {
        description:
          'Create or upload a file inside /app/storage (respecting *.lock and .runtime-logs write protection).',
        inputSchema: {
          path: z.string().min(1).max(512),
          content: z.string(),
          encoding: z.enum(['utf8', 'base64']).optional(),
          overwrite: z.boolean().optional(),
        },
      },
      'files_upload_create',
      async (args) => {
        const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
        const dataBuf = Buffer.from(args.content, encoding);
        if (dataBuf.length > MAX_WRITE_BYTES) {
          const err = new Error(
            `Upload exceeds ${MAX_WRITE_BYTES} bytes single-call safety limit.`,
          );
          err.code = 'PAYLOAD_TOO_LARGE';
          throw err;
        }

        const target = await resolveSafeStoragePath(args.path, {
          allowWriteRuntimeLogs: false,
          requireExists: false,
        });
        if (!target.relativePath) {
          const err = new Error('Target file path must not be root directory.');
          err.code = 'VALIDATION_ERROR';
          throw err;
        }

        const lockSibling = `${target.fullPath}.lock`;
        if (fs.existsSync(lockSibling)) {
          const err = new Error('File is currently locked by storage writer.');
          err.code = 'LOCKFILE_PROTECTED';
          throw err;
        }

        const existingStat = await fsp.lstat(target.fullPath).catch(() => null);
        if (existingStat) {
          if (existingStat.isDirectory() || existingStat.isSymbolicLink()) {
            const err = new Error('Cannot overwrite directory or symlink.');
            err.code = 'INVALID_FILE_TYPE';
            throw err;
          }
          if (!args.overwrite) {
            const err = new Error(
              `File '${target.relativePath}' already exists and overwrite=false.`,
            );
            err.code = 'FILE_EXISTS';
            throw err;
          }
        }

        await fsp.mkdir(path.dirname(target.fullPath), { recursive: true });
        await fsp.writeFile(target.fullPath, dataBuf);
        return {
          ok: true,
          path: target.relativePath,
          bytesWritten: dataBuf.length,
          overwritten: Boolean(existingStat),
        };
      },
    );

    // 13. Files Edit (Targeted Search & Replace)
    registerGuardedTool(
      'datastack_files_edit',
      {
        description:
          'Perform targeted search/replace editing on a regular non-locked UTF-8 file inside /app/storage.',
        inputSchema: {
          path: z.string().min(1).max(512),
          search: z.string().min(1),
          replace: z.string(),
          replaceAll: z.boolean().optional(),
        },
      },
      'files_edit',
      async (args) => {
        const target = await resolveSafeStoragePath(args.path, {
          allowWriteRuntimeLogs: false,
          requireExists: true,
        });
        const stat = await fsp.lstat(target.fullPath);
        if (!stat.isFile()) {
          const err = new Error('Target path is not a regular file.');
          err.code = 'INVALID_FILE_TYPE';
          throw err;
        }
        if (stat.size > MAX_WRITE_BYTES) {
          const err = new Error(
            `File exceeds ${MAX_WRITE_BYTES} bytes safe inline edit limit.`,
          );
          err.code = 'PAYLOAD_TOO_LARGE';
          throw err;
        }
        const lockSibling = `${target.fullPath}.lock`;
        if (fs.existsSync(lockSibling)) {
          const err = new Error('File is currently locked by storage writer.');
          err.code = 'LOCKFILE_PROTECTED';
          throw err;
        }

        const current = await fsp.readFile(target.fullPath, 'utf8');
        if (!current.includes(args.search)) {
          const err = new Error('Search text was not found in target file.');
          err.code = 'SEARCH_NOT_FOUND';
          throw err;
        }

        let occurrences = 0;
        let updated;
        if (args.replaceAll) {
          const parts = current.split(args.search);
          occurrences = parts.length - 1;
          updated = parts.join(args.replace);
        } else {
          occurrences = 1;
          const idx = current.indexOf(args.search);
          updated =
            current.slice(0, idx) +
            args.replace +
            current.slice(idx + args.search.length);
        }

        if (Buffer.byteLength(updated, 'utf8') > MAX_WRITE_BYTES) {
          const err = new Error('Edited content exceeds maximum safe file size.');
          err.code = 'PAYLOAD_TOO_LARGE';
          throw err;
        }

        await fsp.writeFile(target.fullPath, updated, 'utf8');
        return {
          ok: true,
          path: target.relativePath,
          replacements: occurrences,
          newSizeBytes: Buffer.byteLength(updated, 'utf8'),
        };
      },
    );

    // 14. Files Delete
    registerGuardedTool(
      'datastack_files_delete',
      {
        description:
          'Delete a regular non-locked file inside /app/storage (directories, symlinks, *.lock, and .runtime-logs are protected).',
        inputSchema: {
          path: z.string().min(1).max(512),
        },
      },
      'files_delete',
      async (args) => {
        const target = await resolveSafeStoragePath(args.path, {
          allowWriteRuntimeLogs: false,
          requireExists: true,
        });
        if (!target.relativePath) {
          const err = new Error('Cannot delete storage root.');
          err.code = 'PATH_OUTSIDE_ROOT';
          throw err;
        }
        const stat = await fsp.lstat(target.fullPath);
        if (!stat.isFile()) {
          const err = new Error('Only regular files may be deleted via MCP.');
          err.code = 'INVALID_FILE_TYPE';
          throw err;
        }
        const lockSibling = `${target.fullPath}.lock`;
        if (fs.existsSync(lockSibling)) {
          const err = new Error('File is currently locked by storage writer.');
          err.code = 'LOCKFILE_PROTECTED';
          throw err;
        }
        await fsp.unlink(target.fullPath);
        return {
          ok: true,
          deletedPath: target.relativePath,
        };
      },
    );

    // 15. Settings Read (Masked)
    registerGuardedTool(
      'datastack_settings_read',
      {
        description:
          'Read DataStack public runtime settings (all secrets and tokens remain masked).',
        inputSchema: {},
      },
      'settings_read',
      async () => callWebInternalMcp('settings_get', {}, actorIp),
    );

    // 16. Settings Write (Allowlisted Non-Secret Fields Only)
    registerGuardedTool(
      'datastack_settings_update',
      {
        description:
          'Update safe allowlisted DataStack runtime settings (rate limits, batch thresholds, rotation, retention, non-secret webhook/S3/Prometheus flags).',
        inputSchema: {
          maxEventsPerSec: z.number().int().min(1).max(100000).optional(),
          maxPayloadSizeKb: z.number().int().min(1).max(10240).optional(),
          batchFlushThreshold: z.number().int().min(1).max(50000).optional(),
          batchFlushIntervalMs: z.number().int().min(100).max(60000).optional(),
          fileRotationMb: z.number().int().min(1).max(2048).optional(),
          enableIdempotency: z.boolean().optional(),
          autoPruneDays: z.number().int().min(0).max(3650).optional(),
          compressAfterDays: z.number().int().min(0).max(3650).optional(),
          diskPauseThresholdPct: z.number().int().min(0).max(99).optional(),
          enableWebhookAlerts: z.boolean().optional(),
          webhookUrl: z.string().max(1024).optional(),
          webhookCooldownSec: z.number().int().min(10).max(86400).optional(),
          enableS3Backup: z.boolean().optional(),
          s3Endpoint: z.string().max(512).optional(),
          s3Region: z.string().max(64).optional(),
          s3Bucket: z.string().max(128).optional(),
          s3Prefix: z.string().max(256).optional(),
          s3AccessKeyId: z.string().max(256).optional(),
          enablePrometheusMetrics: z.boolean().optional(),
        },
      },
      'settings_write',
      async (args) => callWebInternalMcp('settings_update', args, actorIp),
    );

    // 17. Storage Stats / Flush / S3 Archive
    registerGuardedTool(
      'datastack_storage_maintenance',
      {
        description:
          'Inspect storage stats, trigger an immediate ingestion+web buffer flush to CSV, or trigger an S3 cold archive run.',
        inputSchema: {
          action: z.enum(['stats', 'flush', 's3_archive']),
          pruneAfterUpload: z.boolean().optional(),
        },
      },
      'storage_maintenance',
      async (args) => {
        if (args.action === 'stats') {
          return callWebInternalMcp('storage_stats', {}, actorIp);
        }
        if (args.action === 'flush') {
          let ingestionFlushed = 0;
          if (typeof flushBuffer === 'function') {
            const ing = await flushBuffer({ waitMs: 2500, throwOnLockTimeout: true });
            ingestionFlushed = ing ? Number(ing.written) || 0 : 0;
          }
          const web = await callWebInternalMcp('storage_flush', {}, actorIp);
          return {
            ...web,
            ingestionFlushed,
          };
        }
        return callWebInternalMcp(
          'storage_s3_archive',
          { pruneAfterUpload: args.pruneAfterUpload === true },
          actorIp,
        );
      },
    );

    return server;
  }

  async function authenticateRequest(req) {
    if (!state.enabled || !state.tokenHash || state.tokenHash.length !== 64) {
      return {
        allowed: false,
        status: 503,
        code: 'MCP_DISABLED',
        error: 'MCP Server is currently disabled in Admin Console Settings.',
      };
    }

    const clientIp = extractMcpClientIp(req);
    if (
      state.allowedIps &&
      typeof isClientIpAllowed === 'function' &&
      !isClientIpAllowed(clientIp, state.allowedIps)
    ) {
      await recordMcpAudit({
        action: 'MCP_TOOL_DENIED',
        target: 'mcp_ip_allowlist',
        ipAddress: clientIp,
        metadata: { code: 'MCP_IP_FORBIDDEN' },
      });
      return {
        allowed: false,
        status: 403,
        code: 'MCP_IP_FORBIDDEN',
        error: `Client IP '${clientIp}' is not in the MCP allowed IP/CIDR list.`,
      };
    }

    const authHeader =
      (req.headers && (req.headers.authorization || req.headers.Authorization)) ||
      '';
    const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
    const presented = match ? match[1].trim() : '';
    if (!presented || !verifyMcpBearerTokenHash(presented, state.tokenHash)) {
      await recordMcpAudit({
        action: 'MCP_TOOL_DENIED',
        target: 'mcp_auth',
        ipAddress: clientIp,
        metadata: { code: 'MCP_UNAUTHORIZED' },
      });
      return {
        allowed: false,
        status: 401,
        code: 'MCP_UNAUTHORIZED',
        error: 'Missing or invalid MCP Bearer token.',
      };
    }

    return { allowed: true, clientIp };
  }

  async function handleHttpRequest(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');

    const auth = await authenticateRequest(req);
    if (!auth.allowed) {
      return res.status(auth.status).json({
        jsonrpc: '2.0',
        error: {
          code: auth.status === 401 ? -32001 : auth.status === 403 ? -32003 : -32000,
          message: auth.error,
          data: { code: auth.code },
        },
        id: null,
      });
    }

    // Ensure simple HTTP JSON-RPC clients that omit text/event-stream still succeed cleanly
    const method = String(req.method || 'POST').toUpperCase();
    const rawAccept = String((req.headers && req.headers.accept) || '');
    if (
      method === 'POST' &&
      (!rawAccept.includes('application/json') ||
        !rawAccept.includes('text/event-stream'))
    ) {
      req.headers.accept = 'application/json, text/event-stream';
    }

    const mcpServer = createScopedMcpServer(auth.clientIp);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void mcpServer.close().catch(() => undefined);
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(
        req,
        res,
        method === 'POST' ? req.body : undefined,
      );
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message:
              err instanceof Error ? err.message : 'Internal MCP server error',
          },
          id: null,
        });
      }
    }
  }

  function getStateSnapshot() {
    return {
      ...state,
      coolifyToken: state.coolifyToken ? '[REDACTED]' : '',
      permissions: { ...state.permissions },
    };
  }

  function resetForTests() {
    state.enabled = false;
    state.tokenHash = '';
    state.tokenPreview = '';
    state.allowedIps = '';
    state.permissions = { ...DEFAULT_MCP_PERMISSIONS };
    state.coolifyUrl = '';
    state.coolifyToken = '';
    state.coolifyAppUuid = '';
    state.updatedAt = '';
  }

  return {
    syncState,
    hydrateFromDatabase,
    authenticateRequest,
    handleHttpRequest,
    getStateSnapshot,
    resetForTests,
    resolveSafeStoragePath,
    MCP_PERMISSION_KEYS,
  };
}

module.exports = {
  createMcpEngine,
  hashMcpToken,
  verifyMcpBearerTokenHash,
  MCP_PERMISSION_KEYS,
  DEFAULT_MCP_PERMISSIONS,
};
