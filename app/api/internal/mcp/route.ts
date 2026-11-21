import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  SettingsManager,
  type AdminSettingsUpdateInput,
} from "@/core/adminSettings/settingsManager";
import { ApiEngine } from "@/core/apiEngine/apiService";
import {
  listAdminAuditLogsWithStatusAsync,
  recordAdminAuditLogAsync,
} from "@/core/auth/auditLog";
import { DataBufferEngine, REDIS_BUFFER_KEY } from "@/core/data/buffer";
import { DatabaseEngine } from "@/core/Database/database";
import {
  readBuildLogs,
  readRuntimeLogs,
} from "@/core/logs/runtimeLogCapture";
import { SDKManager } from "@/core/sdk/sdkManager";
import {
  validateAllowedIpsInput,
  validateClientExpiresAtInput,
} from "@/core/Security/ipAllowlist";
import { resolveInternalIngestionSecret } from "@/core/Security/security";
import { SSRFBlockedError, validateOutboundUrlSync } from "@/core/Security/ssrfGuard";
import { CSVStorageManager } from "@/core/Storage/csvStorage";
import {
  buildS3ObjectKey,
  normalizeS3EndpointUrl,
  uploadFileToS3,
} from "@/core/Storage/s3Archive";
import { parse } from "csv-parse";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const MCP_ALLOWED_SETTINGS_FIELDS = new Set([
  "maxEventsPerSec",
  "maxPayloadSizeKb",
  "batchFlushThreshold",
  "batchFlushIntervalMs",
  "fileRotationMb",
  "enableIdempotency",
  "autoPruneDays",
  "compressAfterDays",
  "diskPauseThresholdPct",
  "enableWebhookAlerts",
  "webhookUrl",
  "webhookCooldownSec",
  "enableS3Backup",
  "s3Endpoint",
  "s3Region",
  "s3Bucket",
  "s3Prefix",
  "s3AccessKeyId",
  "enablePrometheusMetrics",
]);

function verifyInternalBridgeSecret(request: NextRequest): boolean {
  const presented =
    request.headers.get("x-datastack-internal-secret")?.trim() || "";
  const expected = resolveInternalIngestionSecret();
  if (!presented || !expected) return false;
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

function serializeRedactedClient(
  client: {
    clientId: string;
    name: string;
    secret?: string;
    token?: string;
    rateLimit: number;
    storageQuotaMb: number;
    allowedIps: string;
    expiresAt?: string | null;
    status: "active" | "revoked";
    totalEvents: number;
    lastActive?: string;
    createdAt: string;
  },
  includeToken = false,
) {
  const { secret, token, ...rest } = client;
  void secret;
  return {
    ...rest,
    tokenPreview: token ? `${token.slice(0, 12)}...` : "",
    ...(includeToken && token ? { token } : {}),
  };
}

function parseBoundedInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  if (raw < min || raw > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
  return raw;
}

export async function POST(req: NextRequest) {
  if (DatabaseEngine.getPool()) {
    await SettingsManager.getSettingsAsync();
  }
  if (!verifyInternalBridgeSecret(req)) {
    return NextResponse.json(
      {
        error: "Internal MCP bridge authentication failed.",
        code: "MCP_BRIDGE_UNAUTHORIZED",
      },
      { status: 401 },
    );
  }

  let body: { action?: unknown; params?: unknown; actorIp?: unknown };
  try {
    const parsed = await req.json();
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { action?: unknown; params?: unknown; actorIp?: unknown })
        : {};
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request payload.", code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const action = typeof body.action === "string" ? body.action.trim() : "";
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const actorIp =
    typeof body.actorIp === "string" ? body.actorIp.trim().slice(0, 128) : "";

  try {
    switch (action) {
      case "metrics_get": {
        const [metrics, diskUsage] = await Promise.all([
          ApiEngine.getDashboardMetrics(),
          CSVStorageManager.getDiskUsageAsync(),
        ]);
        return NextResponse.json({ success: true, metrics, diskUsage });
      }

      case "runtime_logs_read": {
        const result = readRuntimeLogs({
          service:
            params.service === "web" || params.service === "ingestion"
              ? params.service
              : "all",
          lines: typeof params.lines === "number" ? params.lines : 120,
          search: typeof params.search === "string" ? params.search : undefined,
          level: typeof params.level === "string" ? params.level : undefined,
        });
        return NextResponse.json({ success: true, ...result });
      }

      case "build_logs_read": {
        const result = readBuildLogs({
          lines: typeof params.lines === "number" ? params.lines : 200,
          search: typeof params.search === "string" ? params.search : undefined,
        });
        return NextResponse.json({ success: true, ...result });
      }

      case "audit_query": {
        const result = await listAdminAuditLogsWithStatusAsync({
          limit: typeof params.limit === "number" ? params.limit : 100,
          action: typeof params.action === "string" ? params.action : undefined,
          actorEmail:
            typeof params.actorEmail === "string"
              ? params.actorEmail
              : undefined,
          search: typeof params.search === "string" ? params.search : undefined,
        });
        return NextResponse.json({ success: true, ...result });
      }

      case "clients_list": {
        const clients = (await SDKManager.listClientsAsync()).map((c) =>
          serializeRedactedClient(c, false),
        );
        return NextResponse.json({ success: true, clients, count: clients.length });
      }

      case "clients_get": {
        const rawId = typeof params.clientId === "string" ? params.clientId : "";
        const normalizedId = SDKManager.normalizeClientId(rawId);
        if (!normalizedId) {
          return NextResponse.json(
            { error: "clientId is required.", code: "VALIDATION_ERROR" },
            { status: 400 },
          );
        }
        const client = await SDKManager.getClientAsync(normalizedId);
        if (!client) {
          return NextResponse.json(
            { error: `Client '${normalizedId}' not found.`, code: "NOT_FOUND" },
            { status: 404 },
          );
        }
        return NextResponse.json({
          success: true,
          client: serializeRedactedClient(client, false),
        });
      }

      case "clients_create": {
        const rawClientId =
          typeof params.clientId === "string" ? params.clientId : "";
        const rawName = typeof params.name === "string" ? params.name : "";
        if (!rawClientId.trim() || !rawName.trim()) {
          return NextResponse.json(
            {
              error: "clientId and name are required non-empty strings.",
              code: "VALIDATION_ERROR",
            },
            { status: 400 },
          );
        }
        const safeClientId = SDKManager.normalizeClientId(rawClientId);
        if (!safeClientId) {
          return NextResponse.json(
            { error: "clientId is invalid.", code: "VALIDATION_ERROR" },
            { status: 400 },
          );
        }
        const parsedRateLimit =
          params.rateLimit === undefined ? 100 : Number(params.rateLimit);
        if (
          !Number.isInteger(parsedRateLimit) ||
          parsedRateLimit < 1 ||
          parsedRateLimit > 100000
        ) {
          return NextResponse.json(
            {
              error: "rateLimit must be an integer between 1 and 100000.",
              code: "VALIDATION_ERROR",
            },
            { status: 400 },
          );
        }
        const parsedQuotaMb =
          params.storageQuotaMb === undefined
            ? 0
            : Number(params.storageQuotaMb);
        if (
          !Number.isInteger(parsedQuotaMb) ||
          parsedQuotaMb < 0 ||
          parsedQuotaMb > 1048576
        ) {
          return NextResponse.json(
            {
              error: "storageQuotaMb must be an integer between 0 and 1048576.",
              code: "VALIDATION_ERROR",
            },
            { status: 400 },
          );
        }
        let normalizedAllowedIps = "";
        if (params.allowedIps !== undefined && params.allowedIps !== null) {
          if (typeof params.allowedIps !== "string") {
            return NextResponse.json(
              { error: "allowedIps must be a string.", code: "VALIDATION_ERROR" },
              { status: 400 },
            );
          }
          const ipRes = validateAllowedIpsInput(params.allowedIps);
          if (!ipRes.valid) {
            return NextResponse.json(
              {
                error: ipRes.error || "Invalid allowedIps.",
                code: "VALIDATION_ERROR",
              },
              { status: 400 },
            );
          }
          normalizedAllowedIps = ipRes.normalized;
        }
        let normalizedExpiresAt: string | null = null;
        if (params.expiresAt !== undefined) {
          const expRes = validateClientExpiresAtInput(params.expiresAt);
          if (!expRes.valid) {
            return NextResponse.json(
              {
                error: expRes.error || "Invalid expiresAt.",
                code: "VALIDATION_ERROR",
              },
              { status: 400 },
            );
          }
          normalizedExpiresAt = expRes.iso ?? null;
        }
        const existing = await SDKManager.getClientAsync(safeClientId);
        if (existing) {
          return NextResponse.json(
            { error: `Client '${safeClientId}' already exists.`, code: "CONFLICT" },
            { status: 409 },
          );
        }
        const created = await SDKManager.registerClientAsync({
          clientId: safeClientId,
          name: rawName.trim().slice(0, 120),
          rateLimit: parsedRateLimit,
          storageQuotaMb: parsedQuotaMb,
          allowedIps: normalizedAllowedIps,
          expiresAt: normalizedExpiresAt,
        });
        await recordAdminAuditLogAsync({
          actorEmail: "mcp-agent",
          actorRole: "mcp",
          action: "CLIENT_CREATED",
          target: created.clientId,
          ipAddress: actorIp,
          metadata: {
            via: "mcp",
            name: created.name,
            rateLimit: created.rateLimit,
            storageQuotaMb: created.storageQuotaMb,
          },
        });
        return NextResponse.json(
          { success: true, client: serializeRedactedClient(created, true) },
          { status: 201 },
        );
      }

      case "clients_update": {
        const rawId = typeof params.clientId === "string" ? params.clientId : "";
        const normalizedId = SDKManager.normalizeClientId(rawId);
        if (!normalizedId) {
          return NextResponse.json(
            { error: "clientId is required.", code: "VALIDATION_ERROR" },
            { status: 400 },
          );
        }
        const updates: {
          name?: string;
          rateLimit?: number;
          storageQuotaMb?: number;
          allowedIps?: string;
          expiresAt?: string | null;
          status?: "active" | "revoked";
        } = {};
        if (params.name !== undefined) {
          if (
            typeof params.name !== "string" ||
            params.name.trim().length < 1 ||
            params.name.trim().length > 120
          ) {
            return NextResponse.json(
              { error: "name must be 1..120 characters.", code: "VALIDATION_ERROR" },
              { status: 400 },
            );
          }
          updates.name = params.name.trim();
        }
        if (params.rateLimit !== undefined) {
          updates.rateLimit = parseBoundedInt(
            params.rateLimit,
            "rateLimit",
            1,
            100000,
          );
        }
        if (params.storageQuotaMb !== undefined) {
          updates.storageQuotaMb = parseBoundedInt(
            params.storageQuotaMb,
            "storageQuotaMb",
            0,
            1048576,
          );
        }
        if (params.allowedIps !== undefined) {
          if (typeof params.allowedIps !== "string") {
            return NextResponse.json(
              { error: "allowedIps must be a string.", code: "VALIDATION_ERROR" },
              { status: 400 },
            );
          }
          const ipRes = validateAllowedIpsInput(params.allowedIps);
          if (!ipRes.valid) {
            return NextResponse.json(
              {
                error: ipRes.error || "Invalid allowedIps.",
                code: "VALIDATION_ERROR",
              },
              { status: 400 },
            );
          }
          updates.allowedIps = ipRes.normalized;
        }
        if (params.expiresAt !== undefined) {
          const expRes = validateClientExpiresAtInput(params.expiresAt);
          if (!expRes.valid) {
            return NextResponse.json(
              {
                error: expRes.error || "Invalid expiresAt.",
                code: "VALIDATION_ERROR",
              },
              { status: 400 },
            );
          }
          updates.expiresAt = expRes.iso ?? null;
        }
        if (params.status !== undefined) {
          if (params.status !== "active" && params.status !== "revoked") {
            return NextResponse.json(
              {
                error: "status must be 'active' or 'revoked'.",
                code: "VALIDATION_ERROR",
              },
              { status: 400 },
            );
          }
          updates.status = params.status;
        }
        if (Object.keys(updates).length === 0) {
          return NextResponse.json(
            { error: "No update fields supplied.", code: "VALIDATION_ERROR" },
            { status: 400 },
          );
        }
        const updated = await SDKManager.updateClientAsync(normalizedId, updates);
        if (!updated) {
          return NextResponse.json(
            { error: `Client '${normalizedId}' not found.`, code: "NOT_FOUND" },
            { status: 404 },
          );
        }
        await recordAdminAuditLogAsync({
          actorEmail: "mcp-agent",
          actorRole: "mcp",
          action: updates.status === "revoked" ? "CLIENT_REVOKED" : "CLIENT_UPDATED",
          target: updated.clientId,
          ipAddress: actorIp,
          metadata: { via: "mcp", ...updates },
        });
        return NextResponse.json({
          success: true,
          client: serializeRedactedClient(updated, false),
        });
      }

      case "clients_rotate_token": {
        const rawId = typeof params.clientId === "string" ? params.clientId : "";
        const normalizedId = SDKManager.normalizeClientId(rawId);
        if (!normalizedId) {
          return NextResponse.json(
            { error: "clientId is required.", code: "VALIDATION_ERROR" },
            { status: 400 },
          );
        }
        const refreshed = await SDKManager.regenerateTokenAsync(normalizedId);
        if (!refreshed) {
          return NextResponse.json(
            { error: `Client '${normalizedId}' not found.`, code: "NOT_FOUND" },
            { status: 404 },
          );
        }
        await recordAdminAuditLogAsync({
          actorEmail: "mcp-agent",
          actorRole: "mcp",
          action: "CLIENT_TOKEN_ROTATED",
          target: refreshed.clientId,
          ipAddress: actorIp,
          metadata: { via: "mcp" },
        });
        return NextResponse.json({
          success: true,
          client: serializeRedactedClient(refreshed, true),
        });
      }

      case "clients_revoke": {
        const rawId = typeof params.clientId === "string" ? params.clientId : "";
        const normalizedId = SDKManager.normalizeClientId(rawId);
        if (!normalizedId) {
          return NextResponse.json(
            { error: "clientId is required.", code: "VALIDATION_ERROR" },
            { status: 400 },
          );
        }
        const updated = await SDKManager.updateClientAsync(normalizedId, {
          status: "revoked",
        });
        if (!updated) {
          return NextResponse.json(
            { error: `Client '${normalizedId}' not found.`, code: "NOT_FOUND" },
            { status: 404 },
          );
        }
        await recordAdminAuditLogAsync({
          actorEmail: "mcp-agent",
          actorRole: "mcp",
          action: "CLIENT_REVOKED",
          target: updated.clientId,
          ipAddress: actorIp,
          metadata: { via: "mcp" },
        });
        return NextResponse.json({
          success: true,
          client: serializeRedactedClient(updated, false),
        });
      }

      case "clients_delete": {
        const rawId = typeof params.clientId === "string" ? params.clientId : "";
        const normalizedId = SDKManager.normalizeClientId(rawId);
        if (!normalizedId) {
          return NextResponse.json(
            { error: "clientId is required.", code: "VALIDATION_ERROR" },
            { status: 400 },
          );
        }
        const purgeFiles = params.purgeFiles === true;
        const result = await SDKManager.deleteClientWithStatsAsync(normalizedId, {
          purgeFiles,
        });
        if (!result.deleted) {
          return NextResponse.json(
            { error: `Client '${normalizedId}' not found.`, code: "NOT_FOUND" },
            { status: 404 },
          );
        }
        await recordAdminAuditLogAsync({
          actorEmail: "mcp-agent",
          actorRole: "mcp",
          action: "CLIENT_DELETED",
          target: normalizedId,
          ipAddress: actorIp,
          metadata: { via: "mcp", purgeFiles, purgedFiles: result.purgedFiles },
        });
        return NextResponse.json({
          success: true,
          clientId: normalizedId,
          purgedFiles: result.purgedFiles,
        });
      }

      case "settings_get": {
        const settings = await SettingsManager.getPublicSettingsAsync();
        return NextResponse.json({ success: true, settings });
      }

      case "settings_update": {
        const unknown = Object.keys(params).filter(
          (k) => !MCP_ALLOWED_SETTINGS_FIELDS.has(k),
        );
        if (unknown.length > 0) {
          return NextResponse.json(
            {
              error: `Disallowed or unknown settings field(s) for MCP: ${unknown.join(", ")}`,
              code: "VALIDATION_ERROR",
            },
            { status: 400 },
          );
        }
        const validated: AdminSettingsUpdateInput = {};
        if (params.maxEventsPerSec !== undefined) {
          validated.maxEventsPerSec = parseBoundedInt(
            params.maxEventsPerSec,
            "maxEventsPerSec",
            1,
            100000,
          );
        }
        if (params.maxPayloadSizeKb !== undefined) {
          validated.maxPayloadSizeKb = parseBoundedInt(
            params.maxPayloadSizeKb,
            "maxPayloadSizeKb",
            1,
            10240,
          );
        }
        if (params.batchFlushThreshold !== undefined) {
          validated.batchFlushThreshold = parseBoundedInt(
            params.batchFlushThreshold,
            "batchFlushThreshold",
            1,
            50000,
          );
        }
        if (params.batchFlushIntervalMs !== undefined) {
          validated.batchFlushIntervalMs = parseBoundedInt(
            params.batchFlushIntervalMs,
            "batchFlushIntervalMs",
            100,
            60000,
          );
        }
        if (params.fileRotationMb !== undefined) {
          validated.fileRotationMb = parseBoundedInt(
            params.fileRotationMb,
            "fileRotationMb",
            1,
            2048,
          );
        }
        if (params.autoPruneDays !== undefined) {
          validated.autoPruneDays = parseBoundedInt(
            params.autoPruneDays,
            "autoPruneDays",
            0,
            3650,
          );
        }
        if (params.compressAfterDays !== undefined) {
          validated.compressAfterDays = parseBoundedInt(
            params.compressAfterDays,
            "compressAfterDays",
            0,
            3650,
          );
        }
        if (params.diskPauseThresholdPct !== undefined) {
          const pct = parseBoundedInt(
            params.diskPauseThresholdPct,
            "diskPauseThresholdPct",
            0,
            99,
          );
          if (pct !== 0 && pct < 50) {
            throw new Error(
              "diskPauseThresholdPct must be 0 or between 50 and 99.",
            );
          }
          validated.diskPauseThresholdPct = pct;
        }
        if (params.enableIdempotency !== undefined) {
          if (typeof params.enableIdempotency !== "boolean") {
            throw new Error("enableIdempotency must be a boolean.");
          }
          validated.enableIdempotency = params.enableIdempotency;
        }
        if (params.enableWebhookAlerts !== undefined) {
          if (typeof params.enableWebhookAlerts !== "boolean") {
            throw new Error("enableWebhookAlerts must be a boolean.");
          }
          validated.enableWebhookAlerts = params.enableWebhookAlerts;
        }
        if (params.webhookUrl !== undefined) {
          const wh = String(params.webhookUrl || "").trim();
          if (wh) {
            const check = validateOutboundUrlSync(wh, {
              fieldName: "webhookUrl",
            });
            if (!check.allowed) {
              if (check.code === "SSRF_BLOCKED_HOST") {
                throw new SSRFBlockedError(
                  check.error || "webhookUrl blocked.",
                  check.hostname || "",
                );
              }
              throw new Error(check.error || "Invalid webhookUrl.");
            }
          }
          validated.webhookUrl = wh;
        }
        if (params.webhookCooldownSec !== undefined) {
          validated.webhookCooldownSec = parseBoundedInt(
            params.webhookCooldownSec,
            "webhookCooldownSec",
            10,
            86400,
          );
        }
        if (params.enableS3Backup !== undefined) {
          if (typeof params.enableS3Backup !== "boolean") {
            throw new Error("enableS3Backup must be a boolean.");
          }
          validated.enableS3Backup = params.enableS3Backup;
        }
        if (params.s3Endpoint !== undefined) {
          const ep = String(params.s3Endpoint || "").trim();
          if (ep) {
            const norm = /^https?:\/\//i.test(ep) ? ep : `https://${ep}`;
            const check = validateOutboundUrlSync(norm, {
              fieldName: "s3Endpoint",
            });
            if (!check.allowed) {
              if (check.code === "SSRF_BLOCKED_HOST") {
                throw new SSRFBlockedError(
                  check.error || "s3Endpoint blocked.",
                  check.hostname || "",
                );
              }
              throw new Error(check.error || "Invalid s3Endpoint.");
            }
          }
          validated.s3Endpoint = ep;
        }
        if (params.s3Region !== undefined) {
          validated.s3Region = String(params.s3Region || "").trim().slice(0, 64) || "auto";
        }
        if (params.s3Bucket !== undefined) {
          validated.s3Bucket = String(params.s3Bucket || "").trim().slice(0, 128);
        }
        if (params.s3Prefix !== undefined) {
          validated.s3Prefix = String(params.s3Prefix || "").trim().slice(0, 256);
        }
        if (params.s3AccessKeyId !== undefined) {
          validated.s3AccessKeyId = String(params.s3AccessKeyId || "").trim().slice(0, 256);
        }
        if (params.enablePrometheusMetrics !== undefined) {
          if (typeof params.enablePrometheusMetrics !== "boolean") {
            throw new Error("enablePrometheusMetrics must be a boolean.");
          }
          validated.enablePrometheusMetrics = params.enablePrometheusMetrics;
        }

        if (Object.keys(validated).length === 0) {
          return NextResponse.json(
            { error: "No valid settings supplied.", code: "VALIDATION_ERROR" },
            { status: 400 },
          );
        }

        await SettingsManager.updateSettingsAsync(validated);
        await recordAdminAuditLogAsync({
          actorEmail: "mcp-agent",
          actorRole: "mcp",
          action: "SETTINGS_UPDATED",
          target: "admin_settings",
          ipAddress: actorIp,
          metadata: { via: "mcp", updatedFields: Object.keys(validated) },
        });
        const settings = await SettingsManager.getPublicSettingsAsync();
        return NextResponse.json({ success: true, settings });
      }

      case "data_query": {
        const rawClientId =
          typeof params.clientId === "string" && params.clientId.trim()
            ? params.clientId.trim()
            : "all";
        const clientId =
          rawClientId === "all"
            ? "all"
            : SDKManager.normalizeClientId(rawClientId) || "all";
        const sanitizedClientId =
          clientId === "all"
            ? "all"
            : CSVStorageManager.sanitizeClientId(clientId);
        const search =
          typeof params.search === "string"
            ? params.search.trim().toLowerCase()
            : "";
        const limit = Math.min(
          100,
          Math.max(1, Number(params.limit) || 25),
        );
        const from = typeof params.from === "string" ? params.from.trim() : "";
        const to = typeof params.to === "string" ? params.to.trim() : "";

        const results: Array<{
          clientId: string;
          eventId: string;
          timestamp: string;
          payload: string;
          status: "stored" | "buffered";
        }> = [];
        const seen = new Set<string>();
        const corruptPartitions: Array<{
          clientId: string;
          filename: string;
          error: string;
        }> = [];

        const buffered = await DataBufferEngine.getRecentEventsAsync(
          limit,
          clientId === "all" ? undefined : clientId,
        );
        for (const evt of buffered) {
          const dedupe = `${evt.clientId}:${evt.eventId}`;
          if (seen.has(dedupe)) continue;
          if (
            search &&
            !evt.payload.toLowerCase().includes(search) &&
            !evt.eventId.toLowerCase().includes(search) &&
            !evt.clientId.toLowerCase().includes(search)
          ) {
            continue;
          }
          seen.add(dedupe);
          results.push({ ...evt, status: "buffered" });
          if (results.length >= limit) break;
        }

        const storageDir = CSVStorageManager.baseStorageDir;
        try {
          const clientFolders = await readdir(storageDir);
          for (const folder of clientFolders) {
            if (results.length >= limit) break;
            if (
              clientId !== "all" &&
              folder !== sanitizedClientId &&
              folder !== clientId
            ) {
              continue;
            }
            const clientDir = path.join(storageDir, folder);
            const stat = await lstat(clientDir).catch(() => null);
            if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
              continue;
            }
            const entries = await readdir(clientDir).catch(() => [] as string[]);
            const partitionFiles = entries
              .filter((f) => CSVStorageManager.isPartitionFilename(f))
              .sort()
              .reverse();
            for (const filename of partitionFiles) {
              if (results.length >= limit) break;
              const fileDate = CSVStorageManager.extractDateFromFilename(filename);
              if (from && fileDate < from) continue;
              if (to && fileDate > to) continue;
              const fullPath = path.join(clientDir, filename);
              const fileLstat = await lstat(fullPath).catch(() => null);
              if (!fileLstat || fileLstat.isSymbolicLink() || !fileLstat.isFile()) {
                continue;
              }
              const fileStream = CSVStorageManager.openPartitionTextStream(fullPath);
              const parser = fileStream.pipe(
                parse({ columns: true, skip_empty_lines: true, bom: true, trim: true }),
              );
              fileStream.on("error", (streamErr) => {
                if (!parser.destroyed) parser.destroy(streamErr);
              });
              try {
                for await (const row of parser as AsyncIterable<{
                  clientId?: string;
                  eventId?: string;
                  timestamp?: string;
                  payload?: string;
                }>) {
                  if (!row.eventId) continue;
                  const cid = row.clientId || folder;
                  const dedupe = `${cid}:${row.eventId}`;
                  if (seen.has(dedupe)) continue;
                  const payload = row.payload || "{}";
                  if (
                    search &&
                    !payload.toLowerCase().includes(search) &&
                    !row.eventId.toLowerCase().includes(search) &&
                    !cid.toLowerCase().includes(search)
                  ) {
                    continue;
                  }
                  seen.add(dedupe);
                  results.push({
                    clientId: cid,
                    eventId: row.eventId,
                    timestamp: row.timestamp || `${fileDate}T00:00:00.000Z`,
                    payload,
                    status: "stored",
                  });
                  if (results.length >= limit) break;
                }
              } catch (fileErr) {
                corruptPartitions.push({
                  clientId: folder,
                  filename,
                  error:
                    fileErr instanceof Error ? fileErr.message : String(fileErr),
                });
              } finally {
                if (!parser.destroyed) parser.destroy();
                if (!fileStream.destroyed) fileStream.destroy();
              }
            }
          }
        } catch {
          // storage dir may not exist yet
        }

        const redisQueueLen = await (async () => {
          try {
            const redis = DataBufferEngine.getRedisClient();
            return redis ? Number(await redis.llen(REDIS_BUFFER_KEY)) || 0 : 0;
          } catch {
            return 0;
          }
        })();

        return NextResponse.json({
          success: true,
          events: results,
          count: results.length,
          redisQueueLen,
          corruptPartitions,
        });
      }

      case "storage_stats": {
        const [files, diskUsage] = await Promise.all([
          CSVStorageManager.listAllFilesAsync(),
          CSVStorageManager.getDiskUsageAsync(),
        ]);
        const stats = CSVStorageManager.formatStorageStats(files);
        return NextResponse.json({
          success: true,
          stats,
          fileCount: files.length,
          diskUsage,
        });
      }

      case "storage_flush": {
        await SettingsManager.getSettingsAsync();
        const localRes = await DataBufferEngine.flush({
          waitMs: 2500,
          throwOnLockTimeout: true,
        });
        await recordAdminAuditLogAsync({
          actorEmail: "mcp-agent",
          actorRole: "mcp",
          action: "STORAGE_FLUSH_TRIGGERED",
          target: "storage_buffer",
          ipAddress: actorIp,
          metadata: {
            via: "mcp",
            flushedCount: localRes.count,
            filesUpdated: localRes.files.length,
          },
        });
        return NextResponse.json({
          success: true,
          flushedCount: localRes.count,
          filesUpdated: localRes.files,
        });
      }

      case "storage_s3_archive": {
        const settings = await SettingsManager.getSettingsAsync();
        const s3Config = await SettingsManager.getDecryptedS3ConfigAsync();
        if (
          !s3Config.bucket.trim() ||
          !s3Config.accessKeyId.trim() ||
          !s3Config.secretAccessKey.trim()
        ) {
          return NextResponse.json(
            {
              success: false,
              code: "S3_INVALID_CONFIG",
              error:
                "Configure S3 Bucket, Access Key ID, and Secret Access Key before archiving.",
            },
            { status: 400 },
          );
        }
        normalizeS3EndpointUrl(s3Config.endpoint, s3Config.region);
        const pruneAfterUpload = params.pruneAfterUpload === true;
        const archiveRes =
          await CSVStorageManager.pruneOrArchiveExpiredPartitionsAsync(
            settings.autoPruneDays,
            {
              archiveOnlyWithoutDelete: !pruneAfterUpload,
              beforeDeleteFile: async (file) => {
                const key = buildS3ObjectKey(
                  s3Config.prefix,
                  file.clientId,
                  file.filename,
                );
                const uploadRes = await uploadFileToS3(
                  s3Config,
                  file.filePath,
                  key,
                );
                if (!uploadRes.ok) {
                  throw new Error(
                    uploadRes.error || `Failed to upload ${file.filename}`,
                  );
                }
              },
            },
          );
        await recordAdminAuditLogAsync({
          actorEmail: "mcp-agent",
          actorRole: "mcp",
          action: "S3_ARCHIVE_TRIGGERED",
          target: s3Config.bucket,
          ipAddress: actorIp,
          metadata: {
            via: "mcp",
            archivedCount: archiveRes.archivedCount,
            prunedCount: archiveRes.prunedCount,
            pruneAfterUpload,
          },
        });
        return NextResponse.json({ success: true, ...archiveRes });
      }

      default:
        return NextResponse.json(
          { error: `Unknown MCP bridge action '${action}'.`, code: "VALIDATION_ERROR" },
          { status: 400 },
        );
    }
  } catch (err: unknown) {
    if (err instanceof SSRFBlockedError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "MCP bridge error";
    return NextResponse.json(
      { error: message, code: "MCP_BRIDGE_ERROR" },
      { status: 400 },
    );
  }
}
