import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseEngine } from "../Database/database";
import { getInternalIngestionHeaders } from "../Security/security";
import {
  decryptSecret,
  encryptSecret,
  getMaskedHintFromEncrypted,
} from "../Security/secretVault";
import { SSRFBlockedError, validateOutboundUrlSync } from "../Security/ssrfGuard";
import { validateAllowedIpsInput } from "../Security/ipAllowlist";

export type McpPermissionKey =
  | "metrics_health_read"
  | "runtime_logs_read"
  | "build_logs_read"
  | "audit_logs_read"
  | "ingestion_events_read"
  | "clients_read"
  | "clients_create"
  | "clients_update"
  | "clients_revoke_delete"
  | "files_list_read"
  | "files_download"
  | "files_upload_create"
  | "files_edit"
  | "files_delete"
  | "settings_read"
  | "settings_write"
  | "storage_maintenance";

export type McpPermissions = Record<McpPermissionKey, boolean>;

export interface McpPermissionDefinition {
  key: McpPermissionKey;
  label: string;
  description: string;
  category:
    | "Observability & Logs"
    | "Clients & SDKs"
    | "Files & Storage"
    | "Admin & Maintenance";
  defaultEnabled: boolean;
  risk: "read" | "write" | "destructive";
}

export const MCP_PERMISSION_DEFINITIONS: readonly McpPermissionDefinition[] = [
  {
    key: "metrics_health_read",
    label: "Dashboard Metrics & Health",
    description: "Inspect dashboard metrics, Redis/PG health, buffer depth, and storage usage.",
    category: "Observability & Logs",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "runtime_logs_read",
    label: "Runtime Logs (Web & Ingestion)",
    description: "Read rotating Next.js (Port 3000) and Ingestion (Port 4000) stdout/stderr logs.",
    category: "Observability & Logs",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "build_logs_read",
    label: "Build & Coolify Logs",
    description: "Read captured Next.js build manifest/logs and optional Coolify deploy logs.",
    category: "Observability & Logs",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "audit_logs_read",
    label: "Admin Audit Logs",
    description: "Search administrative, RBAC, client, and MCP action history.",
    category: "Observability & Logs",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "ingestion_events_read",
    label: "Telemetry Events Read",
    description: "Query buffered recent events and stored CSV/GZ telemetry partitions.",
    category: "Observability & Logs",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "clients_read",
    label: "List & Inspect Clients",
    description: "View registered SDK client IDs, quotas, allowlists, and token previews.",
    category: "Clients & SDKs",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "clients_create",
    label: "Create SDK Clients",
    description: "Register new SDK client credentials from an AI agent session.",
    category: "Clients & SDKs",
    defaultEnabled: false,
    risk: "write",
  },
  {
    key: "clients_update",
    label: "Update SDK Clients",
    description: "Modify client names, rate limits, storage quotas, allowed IPs, or expiry.",
    category: "Clients & SDKs",
    defaultEnabled: false,
    risk: "write",
  },
  {
    key: "clients_revoke_delete",
    label: "Rotate, Revoke & Delete Clients",
    description: "Regenerate client JWTs, revoke active client tokens, or permanently delete clients.",
    category: "Clients & SDKs",
    defaultEnabled: false,
    risk: "destructive",
  },
  {
    key: "files_list_read",
    label: "Browse & Read Storage Files",
    description: "List directories and inspect bounded lines/bytes strictly inside /app/storage.",
    category: "Files & Storage",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "files_download",
    label: "Download Storage File Chunks",
    description: "Fetch bounded text or base64 file chunks inside /app/storage.",
    category: "Files & Storage",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "files_upload_create",
    label: "Upload & Create Files",
    description: "Upload or create new files inside /app/storage (respecting .lock protection).",
    category: "Files & Storage",
    defaultEnabled: false,
    risk: "write",
  },
  {
    key: "files_edit",
    label: "Edit Storage Files",
    description: "Perform targeted search/replace edits on non-locked files inside /app/storage.",
    category: "Files & Storage",
    defaultEnabled: false,
    risk: "write",
  },
  {
    key: "files_delete",
    label: "Delete Storage Files",
    description: "Delete non-locked files inside /app/storage.",
    category: "Files & Storage",
    defaultEnabled: false,
    risk: "destructive",
  },
  {
    key: "settings_read",
    label: "Read System Settings",
    description: "Inspect masked public runtime settings (raw secrets are always hidden).",
    category: "Admin & Maintenance",
    defaultEnabled: true,
    risk: "read",
  },
  {
    key: "settings_write",
    label: "Update System Settings",
    description: "Modify ingestion/storage thresholds (SSRF-guarded; never touches admin users or JWT keys).",
    category: "Admin & Maintenance",
    defaultEnabled: false,
    risk: "destructive",
  },
  {
    key: "storage_maintenance",
    label: "Buffer Flush & S3 Archive",
    description: "Trigger manual buffer flushes to CSV or on-demand S3 cold backups.",
    category: "Admin & Maintenance",
    defaultEnabled: false,
    risk: "write",
  },
] as const;

export interface McpSettingsRecord {
  enabled: boolean;
  tokenHash: string;
  tokenEnc: string;
  tokenPreview: string;
  allowedIps: string;
  permissions: McpPermissions;
  coolifyUrl: string;
  coolifyTokenEnc: string;
  coolifyAppUuid: string;
  updatedAt: string;
}

export interface PublicMcpSettings {
  enabled: boolean;
  hasToken: boolean;
  tokenPreview: string;
  allowedIps: string;
  permissions: McpPermissions;
  coolifyUrl: string;
  hasCoolifyToken: boolean;
  coolifyTokenMask: string;
  coolifyAppUuid: string;
  endpointPath: string;
  updatedAt: string;
}

export interface McpBridgeSyncResult {
  attempted: boolean;
  ok: boolean;
  synced: boolean;
  status?: number;
  error?: string;
  checkedAt: string;
}

export type McpSettingsUpdateInput = {
  enabled?: boolean;
  allowedIps?: string;
  permissions?: Partial<Record<McpPermissionKey, boolean>>;
  rotateToken?: boolean;
  revokeToken?: boolean;
  coolifyUrl?: string;
  coolifyToken?: string;
  clearCoolifyToken?: boolean;
  coolifyAppUuid?: string;
};

type McpGlobals = typeof globalThis & {
  __dataStackMcpSettings?: McpSettingsRecord;
  __dataStackLastMcpBridgeSync?: McpBridgeSyncResult;
};

const globals = globalThis as McpGlobals;

export function getDefaultMcpPermissions(): McpPermissions {
  const out = {} as McpPermissions;
  for (const def of MCP_PERMISSION_DEFINITIONS) {
    out[def.key] = def.defaultEnabled;
  }
  return out;
}

export function normalizeMcpPermissions(
  raw: unknown,
  base: McpPermissions = getDefaultMcpPermissions(),
): McpPermissions {
  const merged: McpPermissions = { ...base };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return merged;
  }
  const source = raw as Record<string, unknown>;
  for (const def of MCP_PERMISSION_DEFINITIONS) {
    if (typeof source[def.key] === "boolean") {
      merged[def.key] = source[def.key] as boolean;
    }
  }
  return merged;
}

export function getDefaultMcpSettings(): McpSettingsRecord {
  return {
    enabled: false,
    tokenHash: "",
    tokenEnc: "",
    tokenPreview: "",
    allowedIps: "",
    permissions: getDefaultMcpPermissions(),
    coolifyUrl: "",
    coolifyTokenEnc: "",
    coolifyAppUuid: "",
    updatedAt: new Date().toISOString(),
  };
}

export function generateMcpBearerToken(): string {
  return `dsmcp_${randomBytes(32).toString("hex")}`;
}

export function hashMcpToken(rawToken: string): string {
  return createHash("sha256").update(String(rawToken || ""), "utf8").digest("hex");
}

export function formatMcpTokenPreview(rawToken: string): string {
  const clean = String(rawToken || "").trim();
  if (!clean) return "";
  if (clean.length <= 14) return `${clean.slice(0, 4)}...`;
  return `${clean.slice(0, 10)}...${clean.slice(-4)}`;
}

export function verifyMcpBearerTokenHash(
  presentedToken: string,
  expectedHashHex: string,
): boolean {
  const cleanPresented = String(presentedToken || "").trim();
  const cleanExpected = String(expectedHashHex || "").trim().toLowerCase();
  if (!cleanPresented || cleanExpected.length !== 64) {
    return false;
  }
  try {
    const presentedBuf = Buffer.from(hashMcpToken(cleanPresented), "hex");
    const expectedBuf = Buffer.from(cleanExpected, "hex");
    if (presentedBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(presentedBuf, expectedBuf);
  } catch {
    return false;
  }
}

function getMcpState(): McpSettingsRecord {
  if (!globals.__dataStackMcpSettings) {
    globals.__dataStackMcpSettings = getDefaultMcpSettings();
  }
  return globals.__dataStackMcpSettings;
}

export function toPublicMcpSettings(record: McpSettingsRecord): PublicMcpSettings {
  return {
    enabled: Boolean(record.enabled),
    hasToken: Boolean(record.tokenHash),
    tokenPreview: record.tokenPreview || "",
    allowedIps: record.allowedIps || "",
    permissions: normalizeMcpPermissions(record.permissions),
    coolifyUrl: record.coolifyUrl || "",
    hasCoolifyToken: Boolean(record.coolifyTokenEnc),
    coolifyTokenMask: getMaskedHintFromEncrypted(record.coolifyTokenEnc),
    coolifyAppUuid: record.coolifyAppUuid || "",
    endpointPath: "/mcp",
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
}

export class McpSettingsManager {
  public static getSettings(): McpSettingsRecord {
    const current = getMcpState();
    return {
      ...current,
      permissions: { ...current.permissions },
    };
  }

  public static async getSettingsAsync(): Promise<McpSettingsRecord> {
    const pool = DatabaseEngine.getPool();
    if (!pool) {
      return this.getSettings();
    }

    try {
      await DatabaseEngine.ensureSchema();
      const res = await pool.query<{
        enabled: boolean;
        token_hash: string;
        token_enc: string;
        token_preview: string;
        allowed_ips: string;
        permissions_json: string;
        coolify_url: string;
        coolify_token_enc: string;
        coolify_app_uuid: string;
        updated_at: Date | string;
      }>(
        `SELECT enabled, token_hash, token_enc, token_preview, allowed_ips,
                permissions_json, coolify_url, coolify_token_enc, coolify_app_uuid, updated_at
         FROM mcp_settings
         WHERE id = 'default'`,
      );

      if (!res.rowCount || res.rowCount === 0) {
        return this.getSettings();
      }

      const row = res.rows[0];
      let parsedPermissions: unknown = {};
      try {
        parsedPermissions = JSON.parse(row.permissions_json || "{}");
      } catch {
        parsedPermissions = {};
      }

      const hydrated: McpSettingsRecord = {
        enabled: Boolean(row.enabled),
        tokenHash: String(row.token_hash || ""),
        tokenEnc: String(row.token_enc || ""),
        tokenPreview: String(row.token_preview || ""),
        allowedIps: String(row.allowed_ips || ""),
        permissions: normalizeMcpPermissions(parsedPermissions),
        coolifyUrl: String(row.coolify_url || ""),
        coolifyTokenEnc: String(row.coolify_token_enc || ""),
        coolifyAppUuid: String(row.coolify_app_uuid || ""),
        updatedAt:
          row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : String(row.updated_at || new Date().toISOString()),
      };
      globals.__dataStackMcpSettings = hydrated;
      return { ...hydrated, permissions: { ...hydrated.permissions } };
    } catch (err) {
      console.warn(
        "[DataStack MCP] Failed to read mcp_settings from PostgreSQL (using cached/default state):",
        err instanceof Error ? err.message : err,
      );
      return this.getSettings();
    }
  }

  public static async getPublicSettingsAsync(): Promise<PublicMcpSettings> {
    const settings = await this.getSettingsAsync();
    return toPublicMcpSettings(settings);
  }

  public static getLastBridgeSyncStatus(): McpBridgeSyncResult | null {
    return globals.__dataStackLastMcpBridgeSync ?? null;
  }

  private static async persistToDb(record: McpSettingsRecord): Promise<void> {
    const pool = DatabaseEngine.getPool();
    if (!pool) return;

    const schemaOk = await DatabaseEngine.ensureSchema();
    if (!schemaOk) {
      throw new Error(
        "DATABASE_WRITE_FAILED: Unable to verify PostgreSQL schema for mcp_settings.",
      );
    }

    await pool.query(
      `
        INSERT INTO mcp_settings (
          id, enabled, token_hash, token_enc, token_preview,
          allowed_ips, permissions_json, coolify_url, coolify_token_enc,
          coolify_app_uuid, updated_at
        )
        VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          token_hash = EXCLUDED.token_hash,
          token_enc = EXCLUDED.token_enc,
          token_preview = EXCLUDED.token_preview,
          allowed_ips = EXCLUDED.allowed_ips,
          permissions_json = EXCLUDED.permissions_json,
          coolify_url = EXCLUDED.coolify_url,
          coolify_token_enc = EXCLUDED.coolify_token_enc,
          coolify_app_uuid = EXCLUDED.coolify_app_uuid,
          updated_at = EXCLUDED.updated_at
      `,
      [
        record.enabled,
        record.tokenHash,
        record.tokenEnc,
        record.tokenPreview,
        record.allowedIps,
        JSON.stringify(record.permissions),
        record.coolifyUrl,
        record.coolifyTokenEnc,
        record.coolifyAppUuid,
        record.updatedAt,
      ],
    );
  }

  private static async notifyIngestionMcpSync(
    record: McpSettingsRecord,
    tokenRotated: boolean,
  ): Promise<McpBridgeSyncResult> {
    const checkedAt = new Date().toISOString();
    const configuredUrl = process.env.INGESTION_INTERNAL_URL?.trim();
    if (process.env.DATASTACK_DISABLE_LISTEN === "1" && !configuredUrl) {
      const skipped: McpBridgeSyncResult = {
        attempted: false,
        ok: true,
        synced: false,
        checkedAt,
      };
      globals.__dataStackLastMcpBridgeSync = skipped;
      return skipped;
    }

    const headers = getInternalIngestionHeaders();
    if (!headers["x-datastack-internal-secret"]) {
      const result: McpBridgeSyncResult = {
        attempted: true,
        ok: false,
        synced: false,
        error: "Internal bridge secret is not configured",
        checkedAt,
      };
      globals.__dataStackLastMcpBridgeSync = result;
      return result;
    }

    const ingestionBaseUrl = (
      configuredUrl || "http://127.0.0.1:4000"
    ).replace(/\/$/, "");

    let coolifyTokenPlain = "";
    if (record.coolifyTokenEnc) {
      try {
        coolifyTokenPlain = decryptSecret(record.coolifyTokenEnc);
      } catch {
        coolifyTokenPlain = "";
      }
    }

    try {
      const res = await fetch(`${ingestionBaseUrl}/internal/mcp-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          enabled: record.enabled,
          tokenHash: record.tokenHash,
          tokenPreview: record.tokenPreview,
          allowedIps: record.allowedIps,
          permissions: record.permissions,
          coolifyUrl: record.coolifyUrl,
          coolifyToken: coolifyTokenPlain,
          coolifyAppUuid: record.coolifyAppUuid,
          updatedAt: record.updatedAt,
          tokenRotated,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(1500),
      });
      const result: McpBridgeSyncResult = {
        attempted: true,
        ok: res.ok,
        synced: res.ok,
        status: res.status,
        ...(res.ok ? {} : { error: `Port 4000 mcp-sync returned HTTP ${res.status}` }),
        checkedAt,
      };
      globals.__dataStackLastMcpBridgeSync = result;
      return result;
    } catch (err: unknown) {
      const result: McpBridgeSyncResult = {
        attempted: true,
        ok: false,
        synced: false,
        error: err instanceof Error ? err.message : "Port 4000 unreachable",
        checkedAt,
      };
      globals.__dataStackLastMcpBridgeSync = result;
      return result;
    }
  }

  public static async updateSettingsAsync(
    updates: McpSettingsUpdateInput,
  ): Promise<{
    settings: PublicMcpSettings;
    issuedToken?: string;
    tokenRotated: boolean;
    bridgeSync: McpBridgeSyncResult;
  }> {
    const current = await this.getSettingsAsync();
    let nextEnabled =
      typeof updates.enabled === "boolean" ? updates.enabled : current.enabled;
    let nextAllowedIps = current.allowedIps;

    if (updates.allowedIps !== undefined) {
      const ipCheck = validateAllowedIpsInput(updates.allowedIps);
      if (!ipCheck.valid) {
        throw new Error(ipCheck.error || "Invalid allowedIps list.");
      }
      nextAllowedIps = ipCheck.normalized;
    }

    let nextCoolifyUrl = current.coolifyUrl;
    if (updates.coolifyUrl !== undefined) {
      const trimmed = String(updates.coolifyUrl || "").trim();
      if (trimmed) {
        const ssrf = validateOutboundUrlSync(trimmed, {
          fieldName: "coolifyUrl",
        });
        if (!ssrf.allowed) {
          if (ssrf.code === "SSRF_BLOCKED_HOST") {
            throw new SSRFBlockedError(
              ssrf.error || "coolifyUrl target host is blocked.",
              ssrf.hostname || "",
            );
          }
          throw new Error(ssrf.error || "Invalid coolifyUrl.");
        }
      }
      nextCoolifyUrl = trimmed;
    }

    const nextCoolifyAppUuid =
      updates.coolifyAppUuid !== undefined
        ? String(updates.coolifyAppUuid || "").trim().slice(0, 128)
        : current.coolifyAppUuid;

    let nextCoolifyTokenEnc = current.coolifyTokenEnc;
    if (updates.clearCoolifyToken) {
      nextCoolifyTokenEnc = "";
    } else if (
      typeof updates.coolifyToken === "string" &&
      updates.coolifyToken.trim().length > 0
    ) {
      nextCoolifyTokenEnc = encryptSecret(updates.coolifyToken.trim());
    }

    const nextPermissions = normalizeMcpPermissions(
      updates.permissions,
      current.permissions,
    );

    let nextTokenHash = current.tokenHash;
    let nextTokenEnc = current.tokenEnc;
    let nextTokenPreview = current.tokenPreview;
    let issuedToken: string | undefined;
    let tokenRotated = false;

    if (updates.revokeToken) {
      nextTokenHash = "";
      nextTokenEnc = "";
      nextTokenPreview = "";
      nextEnabled = false;
      tokenRotated = true;
    } else if (
      updates.rotateToken ||
      (nextEnabled && !current.tokenHash)
    ) {
      const freshToken = generateMcpBearerToken();
      issuedToken = freshToken;
      nextTokenHash = hashMcpToken(freshToken);
      nextTokenEnc = encryptSecret(freshToken);
      nextTokenPreview = formatMcpTokenPreview(freshToken);
      tokenRotated = true;
    }

    const nextRecord: McpSettingsRecord = {
      enabled: nextEnabled,
      tokenHash: nextTokenHash,
      tokenEnc: nextTokenEnc,
      tokenPreview: nextTokenPreview,
      allowedIps: nextAllowedIps,
      permissions: nextPermissions,
      coolifyUrl: nextCoolifyUrl,
      coolifyTokenEnc: nextCoolifyTokenEnc,
      coolifyAppUuid: nextCoolifyAppUuid,
      updatedAt: new Date().toISOString(),
    };

    await this.persistToDb(nextRecord);
    globals.__dataStackMcpSettings = nextRecord;
    const bridgeSync = await this.notifyIngestionMcpSync(
      nextRecord,
      tokenRotated || updates.enabled === false,
    );

    return {
      settings: toPublicMcpSettings(nextRecord),
      ...(issuedToken ? { issuedToken } : {}),
      tokenRotated,
      bridgeSync,
    };
  }

  public static resetForTests(): void {
    delete globals.__dataStackMcpSettings;
    delete globals.__dataStackLastMcpBridgeSync;
  }
}
