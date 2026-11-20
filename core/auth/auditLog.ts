import { randomBytes } from "node:crypto";
import { DatabaseEngine } from "@/core/Database/database";

export type AuditActionType =
  | "ADMIN_SETUP"
  | "ADMIN_LOGIN"
  | "ADMIN_LOGOUT"
  | "ADMIN_PROFILE_UPDATED"
  | "ADMIN_PASSWORD_UPDATED"
  | "TEAM_MEMBER_CREATED"
  | "TEAM_MEMBER_UPDATED"
  | "TEAM_MEMBER_REVOKED"
  | "TEAM_MEMBER_DELETED"
  | "CLIENT_CREATED"
  | "CLIENT_UPDATED"
  | "CLIENT_REVOKED"
  | "CLIENT_TOKEN_ROTATED"
  | "CLIENT_DELETED"
  | "SETTINGS_UPDATED"
  | "STORAGE_FLUSH_TRIGGERED"
  | "S3_ARCHIVE_TRIGGERED"
  | "WEBHOOK_TEST_TRIGGERED"
  | string;

export interface AuditLogEntry {
  id: string;
  actorEmail: string;
  actorRole: string;
  action: AuditActionType;
  target: string;
  ipAddress: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RecordAuditLogInput {
  actorEmail: string;
  actorRole: string;
  action: AuditActionType;
  target: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface ListAuditLogsQuery {
  limit?: number;
  action?: string;
  actorEmail?: string;
  search?: string;
}

const MAX_IN_MEMORY_AUDIT_LOGS = 1000;

type AuditLogGlobals = typeof globalThis & {
  __dataStackAuditLogs?: AuditLogEntry[];
};

const globals = globalThis as AuditLogGlobals;

function getInMemoryAuditLogs(): AuditLogEntry[] {
  if (!Array.isArray(globals.__dataStackAuditLogs)) {
    globals.__dataStackAuditLogs = [];
  }
  return globals.__dataStackAuditLogs;
}

function generateAuditLogId(): string {
  return `aud_${Date.now()}_${randomBytes(6).toString("hex")}`;
}

function sanitizeMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const REDACTED_KEYS = new Set([
    "password",
    "newPassword",
    "currentPassword",
    "token",
    "secret",
    "jwtSecret",
    "s3SecretAccessKey",
    "s3SecretAccessKeyEnc",
    "webhookSecret",
    "webhookSecretEnc",
    "prometheusMetricsToken",
    "prometheusMetricsTokenEnc",
  ]);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (REDACTED_KEYS.has(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export async function recordAdminAuditLogAsync(
  input: RecordAuditLogInput,
): Promise<AuditLogEntry> {
  const entry: AuditLogEntry = {
    id: generateAuditLogId(),
    actorEmail: (input.actorEmail || "system").trim().toLowerCase(),
    actorRole: (input.actorRole || "owner").trim().toLowerCase(),
    action: (input.action || "UNKNOWN_ACTION").trim(),
    target: (input.target || "system").trim(),
    ipAddress: (input.ipAddress || "").trim(),
    metadata: sanitizeMetadata(input.metadata),
    createdAt: new Date().toISOString(),
  };

  // Always maintain bounded in-memory copy for fast lookup & fallback
  const mem = getInMemoryAuditLogs();
  mem.unshift(entry);
  if (mem.length > MAX_IN_MEMORY_AUDIT_LOGS) {
    mem.length = MAX_IN_MEMORY_AUDIT_LOGS;
  }

  const pool = DatabaseEngine.getPool();
  if (pool) {
    try {
      await DatabaseEngine.ensureSchema();
      await pool.query(
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
    } catch {
      // Never block or crash administrative actions if audit table write experiences transient DB failure
    }
  }

  return entry;
}

export function recordAdminAuditLog(input: RecordAuditLogInput): void {
  void recordAdminAuditLogAsync(input);
}

export async function listAdminAuditLogsAsync(
  query: ListAuditLogsQuery = {},
): Promise<AuditLogEntry[]> {
  const rawLimit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.floor(query.limit)
      : 100;
  const limit = Math.min(Math.max(rawLimit, 1), 500);
  const actionFilter = query.action?.trim().toUpperCase() || "";
  const actorFilter = query.actorEmail?.trim().toLowerCase() || "";
  const searchFilter = query.search?.trim().toLowerCase() || "";

  const pool = DatabaseEngine.getPool();
  if (pool) {
    try {
      await DatabaseEngine.ensureSchema();
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (actionFilter && actionFilter !== "ALL") {
        params.push(actionFilter);
        conditions.push(`UPPER(action) = $${params.length}`);
      }
      if (actorFilter) {
        params.push(actorFilter);
        conditions.push(`LOWER(actor_email) = $${params.length}`);
      }
      if (searchFilter) {
        params.push(`%${searchFilter}%`);
        const idx = params.length;
        conditions.push(
          `(LOWER(actor_email) LIKE $${idx} OR LOWER(action) LIKE $${idx} OR LOWER(target) LIKE $${idx} OR LOWER(ip_address) LIKE $${idx})`,
        );
      }

      params.push(limit);
      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<{
        id: string;
        actor_email: string;
        actor_role: string;
        action: string;
        target: string;
        ip_address: string;
        metadata_json: string;
        created_at: Date | string;
      }>(
        `
          SELECT
            id,
            actor_email,
            actor_role,
            action,
            target,
            ip_address,
            metadata_json,
            created_at
          FROM admin_audit_logs
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $${params.length}
        `,
        params,
      );

      return result.rows.map((row) => {
        let parsedMeta: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.metadata_json || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedMeta = parsed as Record<string, unknown>;
          }
        } catch {
          parsedMeta = {};
        }
        return {
          id: row.id,
          actorEmail: row.actor_email,
          actorRole: row.actor_role,
          action: row.action,
          target: row.target,
          ipAddress: row.ip_address || "",
          metadata: parsedMeta,
          createdAt:
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : new Date(row.created_at).toISOString(),
        };
      });
    } catch {
      // Fallback to in-memory log buffer if PostgreSQL query fails
    }
  }

  return getInMemoryAuditLogs()
    .filter((entry) => {
      if (
        actionFilter &&
        actionFilter !== "ALL" &&
        entry.action.toUpperCase() !== actionFilter
      ) {
        return false;
      }
      if (actorFilter && entry.actorEmail.toLowerCase() !== actorFilter) {
        return false;
      }
      if (searchFilter) {
        const haystack =
          `${entry.actorEmail} ${entry.actorRole} ${entry.action} ${entry.target} ${entry.ipAddress}`.toLowerCase();
        if (!haystack.includes(searchFilter)) {
          return false;
        }
      }
      return true;
    })
    .slice(0, limit);
}

export function clearAuditLogsForTests(): void {
  globals.__dataStackAuditLogs = [];
}
