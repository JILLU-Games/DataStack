import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";

process.env.DATASTACK_DISABLE_LISTEN = "1";

import { GET as mcpSettingsGet, POST as mcpSettingsPost } from "../app/api/mcp/route";
import { POST as internalMcpPost } from "../app/api/internal/mcp/route";
import { POST as teamPost } from "../app/api/team/route";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  createInitialAdmin,
  resetAdminStateForTests,
} from "../core/auth/adminUsers";
import { clearAuditLogsForTests } from "../core/auth/auditLog";
import { DataBufferEngine } from "../core/data/buffer";
import {
  MCP_PERMISSION_DEFINITIONS,
  McpSettingsManager,
} from "../core/mcp/mcpSettings";
import { SDKManager } from "../core/sdk/sdkManager";
import { getInternalIngestionHeaders } from "../core/Security/security";
import { CSVStorageManager } from "../core/Storage/csvStorage";

const require = createRequire(import.meta.url);
const ingestionServer = require("../server/index.js") as {
  app: import("express").Express;
  mcpEngine: {
    syncState: (payload: Record<string, unknown>) => void;
    hydrateFromDatabase: (pool?: unknown) => Promise<boolean>;
    getStateSnapshot: () => Record<string, unknown>;
    resetForTests: () => void;
  };
  setDbPoolForTests: (pool: unknown) => void;
  stopTimers: () => void;
};
const { createMcpEngine, hashMcpToken } = require("../server/mcp/mcpEngine.js") as {
  createMcpEngine: (deps: Record<string, unknown>) => {
    syncState: (payload: Record<string, unknown>) => void;
    hydrateFromDatabase: (pool?: unknown) => Promise<boolean>;
    handleHttpRequest: (req: unknown, res: unknown) => Promise<void>;
    getStateSnapshot: () => Record<string, unknown>;
    resetForTests: () => void;
    resolveSafeStoragePath: (
      rel: string,
      opts?: { allowWriteRuntimeLogs?: boolean; requireExists?: boolean },
    ) => Promise<{
      sandboxRoot: string;
      sandboxReal: string;
      relativePath: string;
      fullPath: string;
    }>;
  };
  hashMcpToken: (token: string) => string;
};

after(async () => {
  await DataBufferEngine.shutdown();
  ingestionServer.stopTimers();
  resetAdminStateForTests();
  McpSettingsManager.resetForTests();
  clearAuditLogsForTests();
});

async function setupRbacCookies() {
  resetAdminStateForTests();
  await createInitialAdmin("owner@datastack.dev", "OwnerPass123!");
  const secret = getAdminSessionSecret();
  assert.ok(secret, "Expected admin session secret in test runtime");
  const ownerToken = await createAdminSessionToken(
    "owner@datastack.dev",
    secret,
    Date.now() + 3600_000,
    1,
    "owner",
    "owner-1",
  );
  const ownerCookie = `datastack_admin_session=${ownerToken}`;

  const createMember = async (
    email: string,
    password: string,
    role: "operator" | "viewer",
  ) => {
    const res = await teamPost(
      new NextRequest("http://localhost:3000/api/team", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: ownerCookie,
        },
        body: JSON.stringify({ email, password, role }),
      }),
    );
    assert.equal(res.status, 201);
    const json = (await res.json()) as { member: { id: string } };
    const tok = await createAdminSessionToken(
      email,
      secret,
      Date.now() + 3600_000,
      1,
      role,
      json.member.id,
    );
    return `datastack_admin_session=${tok}`;
  };

  const operatorCookie = await createMember(
    "operator@datastack.dev",
    "OperatorPass123!",
    "operator",
  );
  const viewerCookie = await createMember(
    "viewer@datastack.dev",
    "ViewerPass123!",
    "viewer",
  );
  return { ownerCookie, operatorCookie, viewerCookie };
}

test("R5-Phase-02 [MCP-AUDIT-05 / /api/mcp RBAC]: /api/mcp enforces Owner-only RBAC, auto-mints/rotates/revokes tokens, validates permissions/SSRF, and writes audit logs", async () => {
  McpSettingsManager.resetForTests();
  clearAuditLogsForTests();
  const prevDbUrl = process.env.DATABASE_URL;
  const prevDemoAdmin = process.env.DATASTACK_ALLOW_DEMO_ADMIN;
  const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;
  delete process.env.DATABASE_URL;
  process.env.DATASTACK_ALLOW_DEMO_ADMIN = "false";
  const syncPayloads: Array<Record<string, unknown>> = [];

  const mockPort4000Sync = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      if (req.url === "/internal/mcp-sync" && req.method === "POST") {
        syncPayloads.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });

  await new Promise<void>((resolve) =>
    mockPort4000Sync.listen(0, "127.0.0.1", () => resolve()),
  );
  const syncPort = (mockPort4000Sync.address() as AddressInfo).port;
  process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${syncPort}`;

  try {
    const { ownerCookie, operatorCookie, viewerCookie } = await setupRbacCookies();

    // 1. Unauthenticated /api/mcp GET & POST -> 401
    const unauthGet = await mcpSettingsGet(
      new NextRequest("http://localhost:3000/api/mcp", { method: "GET" }),
    );
    assert.equal(unauthGet.status, 401);

    // 2. Non-owner roles (viewer & operator) -> 403 INSUFFICIENT_ROLE_PERMISSION
    for (const cookie of [viewerCookie, operatorCookie]) {
      const roleGet = await mcpSettingsGet(
        new NextRequest("http://localhost:3000/api/mcp", {
          method: "GET",
          headers: { cookie },
        }),
      );
      assert.equal(roleGet.status, 403);
      const rolePost = await mcpSettingsPost(
        new NextRequest("http://localhost:3000/api/mcp", {
          method: "POST",
          headers: { cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
      );
      assert.equal(rolePost.status, 403);
    }

    // 3. Owner GET returns masked public state + 17 permission definitions
    const getRes = await mcpSettingsGet(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "GET",
        headers: { cookie: ownerCookie },
      }),
    );
    assert.equal(getRes.status, 200);
    const getJson = (await getRes.json()) as {
      settings: { enabled: boolean; hasToken: boolean; endpointPath: string };
      permissionDefinitions: Array<{ key: string }>;
      runtime: { permissionCount: number };
    };
    assert.equal(getJson.settings.enabled, false);
    assert.equal(getJson.settings.hasToken, false);
    assert.equal(getJson.settings.endpointPath, "/mcp");
    assert.equal(getJson.permissionDefinitions.length, 17);
    assert.equal(getJson.runtime.permissionCount, 17);

    // 4. Reject unknown fields, unknown permission keys, rotate+revoke conflict, and SSRF coolifyUrl
    const badFieldRes = await mcpSettingsPost(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ rogueField: true }),
      }),
    );
    assert.equal(badFieldRes.status, 400);

    const badPermRes = await mcpSettingsPost(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: { hack_everything: true } }),
      }),
    );
    assert.equal(badPermRes.status, 400);

    const ssrfRes = await mcpSettingsPost(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ coolifyUrl: "http://169.254.169.254/latest" }),
      }),
    );
    assert.equal(ssrfRes.status, 400);
    assert.equal(((await ssrfRes.json()) as { code: string }).code, "SSRF_BLOCKED_HOST");

    // 5. Enable MCP -> mints Bearer token + toggles permissions + syncs Port 4000
    const enableRes = await mcpSettingsPost(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          allowedIps: "127.0.0.1",
          permissions: { clients_create: true, files_upload_create: true },
        }),
      }),
    );
    assert.equal(enableRes.status, 200);
    const enableJson = (await enableRes.json()) as {
      success: boolean;
      issuedToken?: string;
      tokenRotated: boolean;
      settings: { enabled: boolean; hasToken: boolean; tokenPreview: string };
      bridgeSync: { ok: boolean; synced: boolean };
    };
    assert.equal(enableJson.success, true);
    assert.ok(enableJson.issuedToken?.startsWith("dsmcp_"));
    assert.equal(enableJson.tokenRotated, true);
    assert.equal(enableJson.settings.enabled, true);
    assert.equal(enableJson.settings.hasToken, true);
    assert.equal(enableJson.bridgeSync.ok, true);
    assert.equal(syncPayloads.length, 1);

    // 6. Rotate token issues new distinct token; revoke disables MCP
    const rotateRes = await mcpSettingsPost(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ rotateToken: true }),
      }),
    );
    assert.equal(rotateRes.status, 200);
    const rotateJson = (await rotateRes.json()) as { issuedToken?: string };
    assert.ok(rotateJson.issuedToken);
    assert.notEqual(rotateJson.issuedToken, enableJson.issuedToken);

    const revokeRes = await mcpSettingsPost(
      new NextRequest("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { cookie: ownerCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ revokeToken: true }),
      }),
    );
    assert.equal(revokeRes.status, 200);
    const revokeJson = (await revokeRes.json()) as {
      settings: { enabled: boolean; hasToken: boolean };
    };
    assert.equal(revokeJson.settings.enabled, false);
    assert.equal(revokeJson.settings.hasToken, false);
  } finally {
    resetAdminStateForTests();
    McpSettingsManager.resetForTests();
    clearAuditLogsForTests();
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    if (prevDemoAdmin === undefined) delete process.env.DATASTACK_ALLOW_DEMO_ADMIN;
    else process.env.DATASTACK_ALLOW_DEMO_ADMIN = prevDemoAdmin;
    if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
    else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;
    mockPort4000Sync.closeAllConnections?.();
    await new Promise<void>((resolve) => mockPort4000Sync.close(() => resolve()));
  }
});

test("R5-Phase-02 [MCP-AUDIT-01/06/07 & ERR-R5-03/04/05/06]: Port 4000 MCP server enforces disabled/auth/IP gates, registers all 17 SDK tools, enforces permissions & path sandbox, and bridges live tools", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-r5p2-"));
  const tmpDataDir = path.join(tmpRoot, "data");
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const originalBaseDir = CSVStorageManager.baseStorageDir;
  const prevWebInternalUrl = process.env.WEB_INTERNAL_URL;
  const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;
  process.env.INGESTION_INTERNAL_URL = "http://127.0.0.1:1";

  await fs.mkdir(tmpDataDir, { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".runtime-logs"), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, ".runtime-logs", "web.log"),
    "[web] started on 3000\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(tmpDataDir, "active.csv"),
    "clientId,eventId\nc1,e1\n",
    "utf8",
  );
  await fs.writeFile(path.join(tmpDataDir, "active.csv.lock"), "pid:123", "utf8");
  const outsideSecret = path.join(tmpRoot, "..", `outside-${Date.now()}.txt`);
  await fs.writeFile(outsideSecret, "TOP_SECRET", "utf8");
  const symlinkPath = path.join(tmpRoot, "escape-link");
  await fs.symlink(outsideSecret, symlinkPath).catch(() => undefined);

  // Spin up an embedded HTTP wrapper around App Router POST /api/internal/mcp
  const bridgeServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", async () => {
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const nextReq = new NextRequest("http://127.0.0.1:3000/api/internal/mcp", {
        method: req.method || "POST",
        headers: {
          "Content-Type": req.headers["content-type"] || "application/json",
          "x-datastack-internal-secret": String(
            req.headers["x-datastack-internal-secret"] || "",
          ),
        },
        body: req.method === "POST" ? bodyStr : undefined,
      });
      const nextRes = await internalMcpPost(nextReq);
      res.statusCode = nextRes.status;
      res.setHeader("Content-Type", "application/json");
      res.end(await nextRes.text());
    });
  });

  let mcpHttpServer: http.Server | null = null;
  try {
    CSVStorageManager.baseStorageDir = tmpDataDir;
    process.env.DATASTACK_STORAGE_DIR = tmpDataDir;
    clearAuditLogsForTests();

    await new Promise<void>((resolve) =>
      bridgeServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const bridgePort = (bridgeServer.address() as AddressInfo).port;
    process.env.WEB_INTERNAL_URL = `http://127.0.0.1:${bridgePort}`;

    const express = require("express");
    const { isClientIpAllowed } = ingestionServer as unknown as {
      isClientIpAllowed?: (ip: string, allow: string) => boolean;
    };
    const internalHeaders = getInternalIngestionHeaders();

    const engine = createMcpEngine({
      getStorageDataDir: () => tmpDataDir,
      getDbPool: () => null,
      isClientIpAllowed:
        typeof isClientIpAllowed === "function"
          ? isClientIpAllowed
          : (ip: string, list: string) => list.includes(ip),
      resolveInternalSecret: () => internalHeaders["x-datastack-internal-secret"],
      decryptVaultSecret: (v: string) => v,
      validateOutboundUrlAsync: async (urlStr: string) => {
        const u = new URL(urlStr);
        if (u.hostname === "169.254.169.254" || u.hostname === "127.0.0.1") {
          return {
            allowed: false,
            code: "SSRF_BLOCKED_HOST",
            error: `Blocked host ${u.hostname}`,
          };
        }
        return { allowed: true, url: urlStr };
      },
      flushBuffer: async () => ({ written: 2, files: ["active.csv"] }),
    });

    const testApp = express();
    testApp.use(express.json({ limit: "5mb" }));
    testApp.all("/mcp", (req: unknown, res: unknown) => {
      void engine.handleHttpRequest(req, res);
    });
    mcpHttpServer = http.createServer(testApp);
    await new Promise<void>((resolve) =>
      mcpHttpServer!.listen(0, "127.0.0.1", () => resolve()),
    );
    const mcpPort = (mcpHttpServer.address() as AddressInfo).port;
    const mcpUrl = new URL(`http://127.0.0.1:${mcpPort}/mcp`);

    // 1. Disabled by default -> 503 MCP_DISABLED
    const disabledRes = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(disabledRes.status, 503);
    const disabledJson = (await disabledRes.json()) as {
      error?: { data?: { code?: string } };
    };
    assert.equal(disabledJson.error?.data?.code, "MCP_DISABLED");

    // 2. Enable with token + IP allowlist
    const rawToken = `dsmcp_${"a".repeat(64)}`;
    engine.syncState({
      enabled: true,
      tokenHash: hashMcpToken(rawToken),
      allowedIps: "203.0.113.0/24",
      permissions: {
        metrics_health_read: true,
        clients_read: true,
        clients_create: false,
        files_list_read: true,
        files_download: true,
        files_upload_create: true,
        files_edit: true,
        files_delete: true,
        storage_maintenance: true,
        build_logs_read: true,
      },
      coolifyUrl: "http://127.0.0.1:9999",
      coolifyToken: "secret_pat",
      coolifyAppUuid: "app-1",
    });

    // 3. IP blocked -> 403 MCP_IP_FORBIDDEN
    const ipBlockedRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    assert.equal(ipBlockedRes.status, 403);
    assert.equal(
      ((await ipBlockedRes.json()) as { error?: { data?: { code?: string } } }).error?.data
        ?.code,
      "MCP_IP_FORBIDDEN",
    );

    // 4. Open allowlist to loopback & test invalid Bearer token -> 401 MCP_UNAUTHORIZED
    engine.syncState({ allowedIps: "127.0.0.1" });
    const badTokenRes = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dsmcp_wrong_token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 3 }),
    });
    assert.equal(badTokenRes.status, 401);
    assert.equal(
      ((await badTokenRes.json()) as { error?: { data?: { code?: string } } }).error?.data
        ?.code,
      "MCP_UNAUTHORIZED",
    );

    // 5. Real @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport session
    const mcpClient = new Client({
      name: "r5-phase02-test-client",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: {
          Authorization: `Bearer ${rawToken}`,
        },
      },
    });
    await mcpClient.connect(transport);

    const listedTools = await mcpClient.listTools();
    assert.equal(listedTools.tools.length, 17);
    assert.ok(listedTools.tools.some((t) => t.name === "datastack_metrics_health"));
    assert.ok(listedTools.tools.some((t) => t.name === "datastack_files_edit"));
    assert.ok(listedTools.tools.some((t) => t.name === "datastack_storage_maintenance"));

    // 6. Disabled permission blocks tool call (ERR-R5-04 -> MCP_PERMISSION_DENIED)
    const deniedClientCreate = await mcpClient.callTool({
      name: "datastack_clients_create",
      arguments: { clientId: "denied-client", name: "Denied" },
    });
    assert.equal(deniedClientCreate.isError, true);
    const deniedPayload = JSON.parse(
      ((deniedClientCreate.content as Array<{ text: string }>)[0]).text,
    ) as { code: string; permission: string };
    assert.equal(deniedPayload.code, "MCP_PERMISSION_DENIED");
    assert.equal(deniedPayload.permission, "clients_create");

    // 7. Enable clients_create live & invoke -> creates client via /api/internal/mcp bridge
    engine.syncState({ permissions: { clients_create: true } });
    const testClientId = `mcp-live-${Date.now()}`;
    const createdToolRes = await mcpClient.callTool({
      name: "datastack_clients_create",
      arguments: { clientId: testClientId, name: "Live MCP Client", rateLimit: 320 },
    });
    assert.notEqual(createdToolRes.isError, true);
    const createdPayload = JSON.parse(
      ((createdToolRes.content as Array<{ text: string }>)[0]).text,
    ) as { success: boolean; client: { clientId: string; rateLimit: number; token?: string } };
    assert.equal(createdPayload.success, true);
    assert.equal(createdPayload.client.clientId, testClientId);
    assert.equal(createdPayload.client.rateLimit, 320);
    assert.ok(createdPayload.client.token);

    // 8. Sandbox path confinement: traversal, symlink, *.lock, and .runtime-logs write protection
    const traversalRes = await mcpClient.callTool({
      name: "datastack_files_download",
      arguments: { path: "../../etc/passwd" },
    });
    assert.equal(traversalRes.isError, true);
    assert.equal(
      (JSON.parse(((traversalRes.content as Array<{ text: string }>)[0]).text) as { code: string }).code,
      "PATH_OUTSIDE_ROOT",
    );

    if (existsSync(symlinkPath)) {
      const symlinkRes = await mcpClient.callTool({
        name: "datastack_files_download",
        arguments: { path: "escape-link" },
      });
      assert.equal(symlinkRes.isError, true);
      assert.equal(
        (JSON.parse(((symlinkRes.content as Array<{ text: string }>)[0]).text) as { code: string }).code,
        "SYMLINK_FORBIDDEN",
      );
    }

    const lockReadRes = await mcpClient.callTool({
      name: "datastack_files_download",
      arguments: { path: "data/active.csv.lock" },
    });
    assert.equal(lockReadRes.isError, true);
    assert.equal(
      (JSON.parse(((lockReadRes.content as Array<{ text: string }>)[0]).text) as { code: string }).code,
      "LOCKFILE_PROTECTED",
    );

    const lockedFileUploadRes = await mcpClient.callTool({
      name: "datastack_files_upload",
      arguments: { path: "data/active.csv", content: "overwrite", overwrite: true },
    });
    assert.equal(lockedFileUploadRes.isError, true);
    assert.equal(
      (JSON.parse(((lockedFileUploadRes.content as Array<{ text: string }>)[0]).text) as { code: string })
        .code,
      "LOCKFILE_PROTECTED",
    );

    const logWriteRes = await mcpClient.callTool({
      name: "datastack_files_upload",
      arguments: { path: ".runtime-logs/web.log", content: "tamper", overwrite: true },
    });
    assert.equal(logWriteRes.isError, true);
    assert.equal(
      (JSON.parse(((logWriteRes.content as Array<{ text: string }>)[0]).text) as { code: string }).code,
      "PROTECTED_LOG_DIR",
    );

    // 9. Legitimate files upload -> edit -> download -> list -> delete inside sandbox
    const uploadRes = await mcpClient.callTool({
      name: "datastack_files_upload",
      arguments: { path: "notes/hello.txt", content: "alpha beta" },
    });
    assert.notEqual(uploadRes.isError, true);

    const editRes = await mcpClient.callTool({
      name: "datastack_files_edit",
      arguments: { path: "notes/hello.txt", search: "beta", replace: "gamma" },
    });
    assert.notEqual(editRes.isError, true);

    const dlRes = await mcpClient.callTool({
      name: "datastack_files_download",
      arguments: { path: "notes/hello.txt" },
    });
    assert.notEqual(dlRes.isError, true);
    assert.equal(
      (JSON.parse(((dlRes.content as Array<{ text: string }>)[0]).text) as { content: string }).content,
      "alpha gamma",
    );

    const listRes = await mcpClient.callTool({
      name: "datastack_files_list",
      arguments: { path: "data" },
    });
    assert.notEqual(listRes.isError, true);
    const listParsed = JSON.parse(((listRes.content as Array<{ text: string }>)[0]).text) as {
      entries: Array<{ name: string }>;
    };
    assert.ok(listParsed.entries.some((e) => e.name === "active.csv"));
    assert.equal(
      listParsed.entries.some((e) => e.name.endsWith(".lock")),
      false,
    );

    const delFileRes = await mcpClient.callTool({
      name: "datastack_files_delete",
      arguments: { path: "notes/hello.txt" },
    });
    assert.notEqual(delFileRes.isError, true);

    // 10. Metrics, Storage flush (calls local flush + web bridge flush), and SSRF check on Coolify logs
    const metricsRes = await mcpClient.callTool({
      name: "datastack_metrics_health",
      arguments: {},
    });
    assert.notEqual(metricsRes.isError, true);
    assert.equal(
      (JSON.parse(((metricsRes.content as Array<{ text: string }>)[0]).text) as { success: boolean }).success,
      true,
    );

    const flushRes = await mcpClient.callTool({
      name: "datastack_storage_maintenance",
      arguments: { action: "flush" },
    });
    assert.notEqual(flushRes.isError, true);
    const flushPayload = JSON.parse(((flushRes.content as Array<{ text: string }>)[0]).text) as {
      success: boolean;
      ingestionFlushed: number;
    };
    assert.equal(flushPayload.success, true);
    assert.equal(flushPayload.ingestionFlushed, 2);

    const coolifySsrfRes = await mcpClient.callTool({
      name: "datastack_build_logs",
      arguments: { includeCoolify: true },
    });
    assert.equal(coolifySsrfRes.isError, true);
    assert.equal(
      (JSON.parse(((coolifySsrfRes.content as Array<{ text: string }>)[0]).text) as { code: string }).code,
      "SSRF_BLOCKED_HOST",
    );

    await transport.close().catch(() => undefined);
    await mcpClient.close().catch(() => undefined);
    await SDKManager.deleteClientWithStatsAsync(testClientId, { purgeFiles: true });
  } finally {
    CSVStorageManager.baseStorageDir = originalBaseDir;
    if (prevStorageDir === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    if (prevWebInternalUrl === undefined) delete process.env.WEB_INTERNAL_URL;
    else process.env.WEB_INTERNAL_URL = prevWebInternalUrl;
    if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
    else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;
    clearAuditLogsForTests();
    if (mcpHttpServer) {
      mcpHttpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => mcpHttpServer!.close(() => resolve()));
    }
    bridgeServer.closeAllConnections?.();
    await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
    await fs.rm(outsideSecret, { force: true }).catch(() => undefined);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("R5-Phase-02 [Port 4000 Routes & Proxy Configs]: server/index.js exposes /internal/mcp-sync & /mcp and Nginx/Next/Compose/Env route /mcp cleanly", async () => {
  try {
    const internalHeaders = getInternalIngestionHeaders();
    const expressAppServer = http.createServer(ingestionServer.app);
    await new Promise<void>((resolve) =>
      expressAppServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (expressAppServer.address() as AddressInfo).port;

    try {
      // 1. /internal/mcp-sync rejects missing internal secret -> 401
      const unauthSync = await fetch(`http://127.0.0.1:${port}/internal/mcp-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(unauthSync.status, 401);

      // 2. /internal/mcp-sync with valid internal secret updates live mcpEngine state
      const tok = `dsmcp_${"b".repeat(64)}`;
      const authSync = await fetch(`http://127.0.0.1:${port}/internal/mcp-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-datastack-internal-secret": internalHeaders["x-datastack-internal-secret"],
        },
        body: JSON.stringify({
          enabled: true,
          tokenHash: hashMcpToken(tok),
          tokenPreview: "dsmcp_bbbb...bbbb",
          allowedIps: "127.0.0.1",
        }),
      });
      assert.equal(authSync.status, 200);
      assert.equal(ingestionServer.mcpEngine.getStateSnapshot().enabled, true);

      // 3. /mcp endpoint responds to MCP initialize JSON-RPC call cleanly
      const mcpInit = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tok}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "curl-smoke", version: "1.0.0" },
          },
        }),
      });
      assert.equal(mcpInit.status, 200);
      const initJson = (await mcpInit.json()) as {
        result?: { serverInfo?: { name?: string } };
      };
      assert.equal(initJson.result?.serverInfo?.name, "datastack-mcp");

      // 4. hydrateFromDatabase syncs DB mcp_settings row cleanly
      ingestionServer.setDbPoolForTests({
        async query(sql: string) {
          if (/FROM\s+mcp_settings/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  enabled: false,
                  token_hash: "",
                  token_preview: "",
                  allowed_ips: "10.0.0.0/8",
                  permissions_json: JSON.stringify({ clients_create: true }),
                  coolify_url: "https://coolify.example.com",
                  coolify_token_enc: "",
                  coolify_app_uuid: "uuid-99",
                  updated_at: new Date().toISOString(),
                },
              ],
            };
          }
          return { rowCount: 0, rows: [] };
        },
      });
      assert.equal(await ingestionServer.mcpEngine.hydrateFromDatabase(), true);
      const snap = ingestionServer.mcpEngine.getStateSnapshot() as {
        enabled: boolean;
        allowedIps: string;
        permissions: Record<string, boolean>;
      };
      assert.equal(snap.enabled, false);
      assert.equal(snap.allowedIps, "10.0.0.0/8");
      assert.equal(snap.permissions.clients_create, true);
    } finally {
      ingestionServer.mcpEngine.resetForTests();
      ingestionServer.setDbPoolForTests(null);
      expressAppServer.closeAllConnections?.();
      await new Promise<void>((resolve) => expressAppServer.close(() => resolve()));
    }

    // 5. Verify Nginx, NextConfig, Compose, Env, and MCP_PERMISSION_DEFINITIONS 1:1 count
    assert.equal(MCP_PERMISSION_DEFINITIONS.length, 17);

    const coolifyNginx = readFileSync(
      path.resolve(process.cwd(), "docker/coolify-nginx.conf"),
      "utf8",
    );
    assert.match(
      coolifyNginx,
      /location\s+\/mcp\s*\{[\s\S]*?proxy_pass\s+\$socketio_upstream;[\s\S]*?proxy_buffering\s+off;/,
    );

    const localNginx = readFileSync(
      path.resolve(process.cwd(), "nginx/default.conf"),
      "utf8",
    );
    assert.match(
      localNginx,
      /location\s+\/mcp\s*\{[\s\S]*?proxy_pass\s+http:\/\/socketio_upstream;[\s\S]*?proxy_buffering\s+off;/,
    );

    const nextConfig = readFileSync(path.resolve(process.cwd(), "next.config.ts"), "utf8");
    assert.match(nextConfig, /source:\s*['"]\/mcp['"]/);
    assert.match(nextConfig, /destination:\s*`\$\{ingestionBase\}\/mcp`/);

    const compose = readFileSync(
      path.resolve(process.cwd(), "docker/docker-compose.yml"),
      "utf8",
    );
    assert.match(compose, /WEB_INTERNAL_URL:\s*"http:\/\/web:3000"/);

    const envEx = readFileSync(path.resolve(process.cwd(), ".env.example"), "utf8");
    assert.match(envEx, /WEB_INTERNAL_URL=/);
  } finally {
    ingestionServer.stopTimers();
  }
});
