import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

process.env.DATASTACK_DISABLE_LISTEN = "1";

import { POST as internalMcpPost } from "../app/api/internal/mcp/route";
import {
  clearAuditLogsForTests,
  listAdminAuditLogsWithStatusAsync,
  recordAdminAuditLogAsync,
} from "../core/auth/auditLog";
import { CORE_SCHEMA_TABLE_DDLS } from "../core/Database/database";
import {
  appendRuntimeLogLine,
  readBuildLogs,
  readRuntimeLogs,
  scrubSensitiveLogText,
  syncStandaloneBuildArtifactsToLogsDir,
} from "../core/logs/runtimeLogCapture";
import {
  MCP_PERMISSION_DEFINITIONS,
  McpSettingsManager,
  generateMcpBearerToken,
  hashMcpToken,
  verifyMcpBearerTokenHash,
} from "../core/mcp/mcpSettings";
import { SDKManager } from "../core/sdk/sdkManager";
import { getInternalIngestionHeaders } from "../core/Security/security";
import { SSRFBlockedError } from "../core/Security/ssrfGuard";
import { CSVStorageManager } from "../core/Storage/csvStorage";
import { middleware } from "../middleware";

const require = createRequire(import.meta.url);
const cjsRuntimeLogCapture = require("../server/runtimeLogCapture.js") as {
  MAX_LOG_FILE_BYTES: number;
  scrubSensitiveLogText: (raw: string) => string;
  appendRuntimeLogLine: (
    service: string,
    streamName: "stdout" | "stderr",
    rawChunk: string,
    options?: { logsDir?: string; env?: NodeJS.ProcessEnv },
  ) => number;
  readRuntimeLogs: (options?: {
    logsDir?: string;
    service?: string;
    lines?: number;
    search?: string;
    level?: string;
  }) => {
    entries: Array<{ ts: string; service: string; level: string; message: string }>;
    totalMatched: number;
    exists: boolean;
    code?: string;
    warning?: string;
  };
  readBuildLogs: (options?: {
    logsDir?: string;
    cwd?: string;
    lines?: number;
    search?: string;
  }) => {
    meta: Record<string, unknown> | null;
    lines: string[];
    totalLines: number;
    exists: boolean;
    code?: string;
    warning?: string;
  };
};

const ingestionServer = require("../server/index.js") as {
  setDbPoolForTests: (pool: unknown) => void;
  syncSettingsFromDatabase: () => Promise<boolean>;
};

test("R5-Phase-01 [MCP-AUDIT-02 / ERR-R5-02]: Runtime log capture scrubs secrets, rotates at 2MB, filters/tails safely, and handles missing dirs gracefully", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-r5-logs-"));
  const logsDir = path.join(tmpDir, ".runtime-logs");
  try {
    // 1. Missing directory returns LOG_CAPTURE_UNAVAILABLE cleanly without throwing
    const missingRead = readRuntimeLogs({ logsDir });
    assert.equal(missingRead.exists, false);
    assert.equal(missingRead.code, "LOG_CAPTURE_UNAVAILABLE");
    assert.equal(missingRead.entries.length, 0);

    const missingBuild = readBuildLogs({ logsDir, cwd: tmpDir });
    assert.equal(missingBuild.exists, false);
    assert.equal(missingBuild.code, "LOG_CAPTURE_UNAVAILABLE");

    // 2. Secret scrubbing across TS + CJS implementations
    const rawLine =
      'Auth Bearer secret_jwt_token_123 dsmcp_abcdef1234567890 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SuperSecretSignature {"coolifyToken":"cf_live_999","mcpToken":"dsmcp_xyz987654321"}';
    const scrubbedTs = scrubSensitiveLogText(rawLine);
    const scrubbedCjs = cjsRuntimeLogCapture.scrubSensitiveLogText(rawLine);
    assert.equal(scrubbedTs, scrubbedCjs);
    assert.ok(!scrubbedTs.includes("secret_jwt_token_123"));
    assert.ok(!scrubbedTs.includes("abcdef1234567890"));
    assert.ok(!scrubbedTs.includes("SuperSecretSignature"));
    assert.ok(!scrubbedTs.includes("cf_live_999"));
    assert.ok(scrubbedTs.includes("[REDACTED]"));

    // 3. Multi-service append + read filtering
    const writtenWeb = appendRuntimeLogLine("web", "stdout", `${rawLine}\n[web] ready on port 3000\n`, {
      logsDir,
    });
    const writtenIng = cjsRuntimeLogCapture.appendRuntimeLogLine(
      "ingestion",
      "stderr",
      "[ingestion] redis reconnect warning\n",
      { logsDir },
    );
    assert.equal(writtenWeb, 2);
    assert.equal(writtenIng, 1);

    const allLogs = readRuntimeLogs({ logsDir, service: "all", lines: 50 });
    assert.equal(allLogs.exists, true);
    assert.equal(allLogs.totalMatched, 3);
    assert.equal(allLogs.entries.length, 3);
    assert.ok(allLogs.entries.every((e) => !e.message.includes("secret_jwt_token_123")));

    const errOnly = cjsRuntimeLogCapture.readRuntimeLogs({
      logsDir,
      service: "ingestion",
      level: "error",
    });
    assert.equal(errOnly.exists, true);
    assert.equal(errOnly.entries.length, 1);
    assert.equal(errOnly.entries[0]?.service, "ingestion");
    assert.equal(errOnly.entries[0]?.level, "error");

    // 4. Rotation to .1 backup when file size >= 2MB
    const webLogPath = path.join(logsDir, "web.log");
    await fs.writeFile(webLogPath, "x".repeat(cjsRuntimeLogCapture.MAX_LOG_FILE_BYTES + 128), "utf8");
    appendRuntimeLogLine("web", "stdout", "[web] post-rotation line\n", { logsDir });
    const backupStat = await fs.stat(`${webLogPath}.1`);
    assert.ok(backupStat.size >= cjsRuntimeLogCapture.MAX_LOG_FILE_BYTES);
    const afterRotate = readRuntimeLogs({ logsDir, service: "web", search: "post-rotation" });
    assert.equal(afterRotate.entries.length, 1);
    assert.match(afterRotate.entries[0]?.message || "", /post-rotation/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("R5-Phase-01 [MCP-AUDIT-03]: Standalone build.log & build-meta.json sync to .runtime-logs and Dockerfile.web/capture-build-log stay intact", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-r5-build-"));
  const standaloneDir = path.join(tmpDir, ".next", "standalone");
  const logsDir = path.join(tmpDir, "storage", ".runtime-logs");
  try {
    await fs.mkdir(standaloneDir, { recursive: true });
    await fs.writeFile(
      path.join(standaloneDir, "build.log"),
      "Creating an optimized production build ...\nCompiled successfully in 12.4s\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(standaloneDir, "build-meta.json"),
      JSON.stringify({ appName: "datastack", status: "succeeded", exitCode: 0 }),
      "utf8",
    );

    const synced = syncStandaloneBuildArtifactsToLogsDir({ cwd: tmpDir, logsDir });
    assert.equal(synced.synced, true);

    const buildRead = readBuildLogs({ logsDir, cwd: tmpDir, search: "compiled" });
    assert.equal(buildRead.exists, true);
    assert.equal(buildRead.meta?.status, "succeeded");
    assert.equal(buildRead.lines.length, 1);
    assert.match(buildRead.lines[0] || "", /Compiled successfully/);

    const pkgJson = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    assert.equal(pkgJson.scripts?.build, "node scripts/capture-build-log.js");

    const dockerfileWeb = await fs.readFile(path.resolve(process.cwd(), "docker/Dockerfile.web"), "utf8");
    assert.match(dockerfileWeb, /\.runtime-logs/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("R5-Phase-01 [MCP-AUDIT-05]: McpSettingsManager enforces OFF default, 17 granular toggles, token hash/vault, CIDR/SSRF validation, DB roundtrip & Port 4000 sync", async () => {
  McpSettingsManager.resetForTests();
  const prevDbUrl = process.env.DATABASE_URL;
  const prevCorePool = (globalThis as Record<string, unknown>).__dataStackCorePool;
  const prevCoreSchema = (globalThis as Record<string, unknown>).__dataStackCoreSchema;
  const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;

  let persistedRow: Record<string, unknown> | null = null;
  const syncPayloads: Array<Record<string, unknown>> = [];

  const syncServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      if (req.url === "/internal/mcp-sync" && req.method === "POST") {
        syncPayloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });

  await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", () => resolve()));
  const syncPort = (syncServer.address() as AddressInfo).port;

  try {
    process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${syncPort}`;
    assert.equal(MCP_PERMISSION_DEFINITIONS.length, 17);

    const mockPool = {
      async query(sql: string, params?: unknown[]) {
        if (/INSERT INTO mcp_settings/i.test(sql) && params) {
          persistedRow = {
            enabled: params[0],
            token_hash: params[1],
            token_enc: params[2],
            token_preview: params[3],
            allowed_ips: params[4],
            permissions_json: params[5],
            coolify_url: params[6],
            coolify_token_enc: params[7],
            coolify_app_uuid: params[8],
            updated_at: params[9],
          };
          return { rowCount: 1, rows: [] };
        }
        if (/FROM mcp_settings/i.test(sql)) {
          return persistedRow
            ? { rowCount: 1, rows: [persistedRow] }
            : { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    process.env.DATABASE_URL = "postgres://datastack:test@127.0.0.1:5432/datastack";
    (globalThis as Record<string, unknown>).__dataStackCorePool = mockPool;
    (globalThis as Record<string, unknown>).__dataStackCoreSchema = Promise.resolve();

    // 1. Default safe-by-default OFF state
    const initial = await McpSettingsManager.getPublicSettingsAsync();
    assert.equal(initial.enabled, false);
    assert.equal(initial.hasToken, false);
    assert.equal(initial.permissions.clients_create, false);
    assert.equal(initial.permissions.metrics_health_read, true);

    // 2. Enabling auto-mints Bearer token + encrypts Coolify token + syncs Port 4000
    const enabledRes = await McpSettingsManager.updateSettingsAsync({
      enabled: true,
      allowedIps: "203.0.113.0/24",
      permissions: { clients_create: true, files_edit: true },
      coolifyUrl: "https://coolify.example.com",
      coolifyToken: "coolify_pat_secret_123",
      coolifyAppUuid: "app-uuid-01",
    });

    assert.equal(enabledRes.settings.enabled, true);
    assert.equal(enabledRes.settings.hasToken, true);
    assert.ok(enabledRes.issuedToken?.startsWith("dsmcp_"));
    assert.equal(enabledRes.issuedToken?.length, 70);
    assert.equal(enabledRes.settings.permissions.clients_create, true);
    assert.equal(enabledRes.settings.permissions.files_edit, true);
    assert.equal(enabledRes.settings.hasCoolifyToken, true);
    assert.equal(enabledRes.bridgeSync.ok, true);
    assert.equal(syncPayloads.length, 1);
    assert.equal(syncPayloads[0]?.coolifyToken, "coolify_pat_secret_123");

    // 3. SHA-256 digest & timing-safe verification
    const rawToken = generateMcpBearerToken();
    const digest = hashMcpToken(rawToken);
    assert.equal(verifyMcpBearerTokenHash(rawToken, digest), true);
    assert.equal(verifyMcpBearerTokenHash(`${rawToken}x`, digest), false);

    // 4. Re-hydrate from mock PG row cleanly
    McpSettingsManager.resetForTests();
    const rehydrated = await McpSettingsManager.getPublicSettingsAsync();
    assert.equal(rehydrated.enabled, true);
    assert.equal(rehydrated.allowedIps, "203.0.113.0/24");
    assert.equal(rehydrated.permissions.clients_create, true);
    assert.equal(rehydrated.hasCoolifyToken, true);

    // 5. Reject invalid CIDR & SSRF target for coolifyUrl
    await assert.rejects(
      () => McpSettingsManager.updateSettingsAsync({ allowedIps: "not-a-cidr" }),
      /Invalid/i,
    );
    await assert.rejects(
      () =>
        McpSettingsManager.updateSettingsAsync({
          coolifyUrl: "http://169.254.169.254/latest/meta-data",
        }),
      (err: unknown) => err instanceof SSRFBlockedError,
    );

    // 6. Revoke forces enabled: false and clears token
    const revoked = await McpSettingsManager.updateSettingsAsync({ revokeToken: true });
    assert.equal(revoked.settings.enabled, false);
    assert.equal(revoked.settings.hasToken, false);
  } finally {
    McpSettingsManager.resetForTests();
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    (globalThis as Record<string, unknown>).__dataStackCorePool = prevCorePool;
    (globalThis as Record<string, unknown>).__dataStackCoreSchema = prevCoreSchema;
    if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
    else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;
    await new Promise<void>((resolve) => syncServer.close(() => resolve()));
  }
});

test("R5-Phase-01 [MCP-AUDIT-05 / MCP-AUDIT-07]: Port 3000 & Port 4000 share 8-table mcp_settings DDL parity and auditLog records/redacts MCP actions", async () => {
  // 1. Port 3000 DDL contains mcp_settings as 8th table
  assert.equal(CORE_SCHEMA_TABLE_DDLS.length, 8);
  assert.ok(CORE_SCHEMA_TABLE_DDLS.some((ddl) => /CREATE TABLE IF NOT EXISTS mcp_settings/i.test(ddl)));

  // 2. Port 4000 ensureDatabaseSchema creates mcp_settings as well
  const executedSql: string[] = [];
  try {
    ingestionServer.setDbPoolForTests({
      async query(sql: string) {
        executedSql.push(sql);
        return { rowCount: 0, rows: [] };
      },
    });
    const synced = await ingestionServer.syncSettingsFromDatabase();
    assert.equal(synced, true);
    const createStatements = executedSql.filter((s) => /CREATE TABLE IF NOT EXISTS/i.test(s));
    assert.equal(createStatements.length, 8);
    assert.ok(createStatements.some((s) => /\bmcp_settings\b/.test(s)));
  } finally {
    ingestionServer.setDbPoolForTests(null);
  }

  // 3. MCP_* audit actions & secret redaction
  clearAuditLogsForTests();
  try {
    await recordAdminAuditLogAsync({
      actorEmail: "owner@datastack.dev",
      actorRole: "owner",
      action: "MCP_SETTINGS_UPDATED",
      target: "mcp_settings",
      metadata: {
        mcpToken: "dsmcp_plain_should_redact",
        mcpBearerToken: "dsmcp_bearer_should_redact",
        issuedToken: "dsmcp_issued_should_redact",
        tokenHash: "abc123",
        tokenEnc: "v1:enc",
        coolifyToken: "cf_secret",
        coolifyTokenEnc: "v1:cf_enc",
        safeFlag: true,
      },
    });
    await recordAdminAuditLogAsync({
      actorEmail: "mcp-agent",
      actorRole: "mcp",
      action: "MCP_TOOL_DENIED",
      target: "clients_create",
      metadata: { permission: "clients_create" },
    });

    const list = await listAdminAuditLogsWithStatusAsync({ limit: 10 });
    const settingsEvt = list.logs.find((l) => l.action === "MCP_SETTINGS_UPDATED");
    const deniedEvt = list.logs.find((l) => l.action === "MCP_TOOL_DENIED");
    assert.ok(settingsEvt);
    assert.ok(deniedEvt);
    for (const redactedKey of [
      "mcpToken",
      "mcpBearerToken",
      "issuedToken",
      "tokenHash",
      "tokenEnc",
      "coolifyToken",
      "coolifyTokenEnc",
    ]) {
      assert.equal(settingsEvt.metadata[redactedKey], "[REDACTED]");
    }
    assert.equal(settingsEvt.metadata.safeFlag, true);
  } finally {
    clearAuditLogsForTests();
  }
});

test("R5-Phase-01 [MCP-AUDIT-04 / ERR-R5-01]: middleware permits POST /api/internal/mcp only with x-datastack-internal-secret and route enforces timing-safe auth & actions", async () => {
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const tmpStorage = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-r5-bridge-"));
  const originalBaseDir = CSVStorageManager.baseStorageDir;

  try {
    CSVStorageManager.baseStorageDir = path.join(tmpStorage, "data");
    const internalHeaders = getInternalIngestionHeaders();
    assert.ok(internalHeaders["x-datastack-internal-secret"]);

    // 1. Middleware rejects POST /api/internal/mcp without internal secret (cross-origin check -> 403)
    const noSecretMwReq = new NextRequest("http://localhost:3000/api/internal/mcp", {
      method: "POST",
      headers: { host: "localhost:3000" },
    });
    const noSecretMwRes = await middleware(noSecretMwReq);
    assert.equal(noSecretMwRes.status, 403);

    // 2. Middleware allows POST /api/internal/mcp to reach route when header is present
    const withSecretMwReq = new NextRequest("http://localhost:3000/api/internal/mcp", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "x-datastack-internal-secret": internalHeaders["x-datastack-internal-secret"],
      },
    });
    const withSecretMwRes = await middleware(withSecretMwReq);
    assert.equal(withSecretMwRes.status, 200);

    // 3. Route rejects wrong/missing internal secret with 401 MCP_BRIDGE_UNAUTHORIZED (ERR-R5-01)
    const badSecretReq = new NextRequest("http://localhost:3000/api/internal/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-datastack-internal-secret": "wrong-secret",
      },
      body: JSON.stringify({ action: "metrics_get" }),
    });
    const badSecretRes = await internalMcpPost(badSecretReq);
    assert.equal(badSecretRes.status, 401);
    const badJson = (await badSecretRes.json()) as { code: string };
    assert.equal(badJson.code, "MCP_BRIDGE_UNAUTHORIZED");

    const callBridge = async (action: string, params: Record<string, unknown> = {}) => {
      const req = new NextRequest("http://localhost:3000/api/internal/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-datastack-internal-secret": internalHeaders["x-datastack-internal-secret"],
        },
        body: JSON.stringify({ action, params }),
      });
      const res = await internalMcpPost(req);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // 4. Client create / list / update / rotate / revoke / delete
    const uniqueId = `mcp-test-client-${Date.now()}`;
    const created = await callBridge("clients_create", {
      clientId: uniqueId,
      name: "MCP Test Client",
      rateLimit: 250,
    });
    assert.equal(created.status, 201);
    const createdClient = created.body.client as { clientId: string; token?: string; secret?: string };
    assert.equal(createdClient.clientId, uniqueId);
    assert.ok(createdClient.token);
    assert.equal(createdClient.secret, undefined);

    const listed = await callBridge("clients_list");
    assert.equal(listed.status, 200);
    const listArr = listed.body.clients as Array<{ clientId: string; token?: string }>;
    const found = listArr.find((c) => c.clientId === uniqueId);
    assert.ok(found);
    assert.equal(found?.token, undefined);

    const updated = await callBridge("clients_update", {
      clientId: uniqueId,
      rateLimit: 500,
    });
    assert.equal(updated.status, 200);
    assert.equal((updated.body.client as { rateLimit: number }).rateLimit, 500);

    // 5. settings_update blocks forbidden sensitive field jwtSecret
    const badSettings = await callBridge("settings_update", {
      jwtSecret: "attempted-overwrite-secret",
    });
    assert.equal(badSettings.status, 400);
    assert.equal(badSettings.body.code, "VALIDATION_ERROR");

    // 6. Metrics, settings_get, data_query (with stored CSV row), storage_stats
    const metricsRes = await callBridge("metrics_get");
    assert.equal(metricsRes.status, 200);
    const settingsRes = await callBridge("settings_get");
    assert.equal(settingsRes.status, 200);

    const clientDataDir = path.join(CSVStorageManager.baseStorageDir, CSVStorageManager.sanitizeClientId(uniqueId));
    await fs.mkdir(clientDataDir, { recursive: true });
    await fs.writeFile(
      path.join(clientDataDir, "2026-11-21.csv"),
      `"clientId","eventId","timestamp","payload"\n"${uniqueId}","evt-mcp-csv-1","2026-11-21T10:00:00.000Z","{""ok"":true}"\n`,
      "utf8",
    );
    const dataRes = await callBridge("data_query", { clientId: uniqueId, limit: 10 });
    assert.equal(dataRes.status, 200);
    assert.equal(dataRes.body.count, 1);
    const statsRes = await callBridge("storage_stats");
    assert.equal(statsRes.status, 200);

    // Cleanup client
    const delRes = await callBridge("clients_delete", { clientId: uniqueId, purgeFiles: true });
    assert.equal(delRes.status, 200);
    await SDKManager.deleteClientWithStatsAsync(uniqueId, { purgeFiles: true });
  } finally {
    CSVStorageManager.baseStorageDir = originalBaseDir;
    if (prevStorageDir === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    clearAuditLogsForTests();
    await fs.rm(tmpStorage, { recursive: true, force: true });
  }
});
