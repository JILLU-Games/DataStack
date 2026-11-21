import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { NextRequest } from "next/server";

process.env.DATASTACK_DISABLE_LISTEN = "1";

import { GET as auditGet } from "../app/api/audit/route";
import { PATCH as clientPatch } from "../app/api/clients/[id]/route";
import { GET as dataGet } from "../app/api/data/route";
import { POST as eventsPost } from "../app/api/events/route";
import { GET as exportGet } from "../app/api/export/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  createInitialAdmin,
  resetAdminStateForTests,
} from "../core/auth/adminUsers";
import {
  clearAuditLogsForTests,
  listAdminAuditLogsWithStatusAsync,
} from "../core/auth/auditLog";
import { DataBufferEngine } from "../core/data/buffer";
import { SDKManager } from "../core/sdk/sdkManager";
import { getInternalIngestionHeaders } from "../core/Security/security";
import { CSVStorageManager } from "../core/Storage/csvStorage";
import { uploadFileToS3 } from "../core/Storage/s3Archive";

const require = createRequire(import.meta.url);
const express = require("express");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const { setupSocketHandlers } = require("../server/socket/handlers");
const filesManager = require("../server/filesManager.js") as {
  createFilesSecurityMiddleware: (opts: {
    rootDir: string;
    getDbPool?: () => unknown;
    env?: NodeJS.ProcessEnv;
  }) => (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
  flushPendingFilesAuditLogsForTests: () => Promise<void>;
  clearInMemoryAdminSessionStateForTests: () => void;
};

const ingestionServer = require("../server/index.js") as {
  app: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  io: {
    on: (ev: string, cb: (socket: unknown) => void) => void;
    close: (cb?: () => void) => void;
  };
  server: http.Server;
  stopTimers: () => void;
  setDbPoolForTests: (pool: unknown) => void;
  writer: { baseDir: string };
};

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STORAGE_DIR = CSVStorageManager.baseStorageDir;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function createOwnerCookie(
  email = "r4p2-owner@datastack.dev",
): Promise<string> {
  resetAdminStateForTests();
  await createInitialAdmin(email, "OwnerPassword123!");
  const secret = getAdminSessionSecret();
  const token = await createAdminSessionToken(
    email,
    secret,
    Date.now() + 3600_000,
    1,
    "owner",
    "owner-1",
  );
  return `datastack_admin_session=${token}`;
}

test.after(async () => {
  CSVStorageManager.baseStorageDir = ORIGINAL_STORAGE_DIR;
  CSVStorageManager.clearRowCountCache();
  CSVStorageManager.clearQuotaCaches();
  SettingsManager.stopMaintenanceSchedulerForTests();
  SDKManager.stopActivityFlushTimerForTests();
  ingestionServer.stopTimers();
  ingestionServer.setDbPoolForTests(null);
  filesManager.clearInMemoryAdminSessionStateForTests();
  await DataBufferEngine.shutdown();
  clearAuditLogsForTests();
  resetAdminStateForTests();
  restoreEnv();
});

test("R4-Phase-02 AUDIT-05 / ERR-R4-06: HTTP & Socket.IO enforce DATASTACK_MAX_BATCH_ITEMS cap", async () => {
  const prevStorage = CSVStorageManager.baseStorageDir;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ds-r4p2-batch-"));
  CSVStorageManager.baseStorageDir = tmpDir;
  CSVStorageManager.clearRowCountCache();
  CSVStorageManager.clearQuotaCaches();
  process.env.DATASTACK_MAX_BATCH_ITEMS = "3";

  let httpServer: http.Server | null = null;
  let io: InstanceType<typeof Server> | null = null;
  let socket: ReturnType<typeof ioClient> | null = null;

  const runId = `${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

  try {
    const client = await SDKManager.registerClientAsync({
      clientId: "r4p2-batch-client",
      name: "Batch Limit Client",
      rateLimit: 500,
    });

    // 1. HTTP POST /api/events rejects 4-item array before per-item checks
    const overBatchReq = new NextRequest("http://127.0.0.1:3000/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify([
        { eventId: `${runId}-b1`, data: { step: 1 } },
        { eventId: `${runId}-b2`, data: { step: 2 } },
        { eventId: `${runId}-b3`, data: { step: 3 } },
        { eventId: `${runId}-b4`, data: { step: 4 } },
      ]),
    });
    const overRes = await eventsPost(overBatchReq);
    assert.equal(overRes.status, 400);
    const overJson = await overRes.json();
    assert.equal(overJson.success, false);
    assert.equal(overJson.code, "BATCH_LIMIT_EXCEEDED");
    assert.equal(overJson.rejected, 4);
    assert.equal(overJson.maxBatchItems, 3);

    // 2. HTTP POST /api/events accepts 3-item records array
    const okBatchReq = new NextRequest("http://127.0.0.1:3000/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({
        records: [
          { eventId: `${runId}-b1`, data: { step: 1 } },
          { eventId: `${runId}-b2`, data: { step: 2 } },
          { eventId: `${runId}-b3`, data: { step: 3 } },
        ],
      }),
    });
    const okRes = await eventsPost(okBatchReq);
    assert.equal(okRes.status, 200);
    const okJson = await okRes.json();
    assert.equal(okJson.success, true);
    assert.equal(okJson.accepted, 3);
    assert.equal(okJson.rejected, 0);

    // 3. Socket.IO batch_sync rejects 4-item array and accepts 3-item array
    httpServer = http.createServer();
    io = new Server(httpServer);
    const bufferQueue: unknown[] = [];
    setupSocketHandlers(io, bufferQueue, null, {
      getRuntimeConfig: () => ({
        jwtSecret: "datastack-jwt-default-secret-key-32-chars-long",
        maxEventsPerSec: 500,
        maxPayloadSizeBytes: 100 * 1024,
        enableIdempotency: true,
      }),
      verifyClientInDb: async () => ({ allowed: true, rateLimit: 500 }),
    });

    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;

    socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: client.token },
      transports: ["websocket"],
    });
    await new Promise<void>((resolve, reject) => {
      socket!.on("connect", () => resolve());
      socket!.on("connect_error", reject);
    });

    const overAck = await new Promise<Record<string, unknown>>((resolve) => {
      socket!.emit(
        "batch_sync",
        [
          { eventId: "s1", data: { i: 1 } },
          { eventId: "s2", data: { i: 2 } },
          { eventId: "s3", data: { i: 3 } },
          { eventId: "s4", data: { i: 4 } },
        ],
        resolve,
      );
    });
    assert.equal(overAck.success, false);
    assert.equal(overAck.code, "BATCH_LIMIT_EXCEEDED");
    assert.equal(overAck.rejected, 4);
    assert.equal(overAck.maxBatchItems, 3);
    assert.equal(bufferQueue.length, 0);

    const okAck = await new Promise<Record<string, unknown>>((resolve) => {
      socket!.emit(
        "batch_sync",
        [
          { eventId: `${runId}-s1`, data: { i: 1 } },
          { eventId: `${runId}-s2`, data: { i: 2 } },
          { eventId: `${runId}-s3`, data: { i: 3 } },
        ],
        resolve,
      );
    });
    assert.equal(okAck.success, true);
    assert.equal(okAck.processed, 3);
    assert.equal(okAck.rejected, 0);
    assert.equal(bufferQueue.length, 3);

    // 4. Lower bound clamping to 1 when DATASTACK_MAX_BATCH_ITEMS=0
    process.env.DATASTACK_MAX_BATCH_ITEMS = "0";
    const clampAck = await new Promise<Record<string, unknown>>((resolve) => {
      socket!.emit(
        "batch_sync",
        [
          { eventId: `${runId}-c1`, data: { i: 1 } },
          { eventId: `${runId}-c2`, data: { i: 2 } },
        ],
        resolve,
      );
    });
    assert.equal(clampAck.success, false);
    assert.equal(clampAck.code, "BATCH_LIMIT_EXCEEDED");
    assert.equal(clampAck.maxBatchItems, 1);
  } finally {
    delete process.env.DATASTACK_MAX_BATCH_ITEMS;
    if (socket) socket.disconnect();
    if (io) await new Promise<void>((resolve) => io!.close(() => resolve()));
    if (httpServer) httpServer.close();
    await DataBufferEngine.shutdown();
    await SDKManager.deleteClientWithStatsAsync("r4p2-batch-client", {
      purgeFiles: false,
    }).catch(() => undefined);
    CSVStorageManager.baseStorageDir = prevStorage;
    CSVStorageManager.clearRowCountCache();
    CSVStorageManager.clearQuotaCaches();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("R4-Phase-02 AUDIT-06: Governance audit logging for /api/export, Files Manager HTTP mutations (RAM + PG), and UI filters", async () => {
  const prevStorage = CSVStorageManager.baseStorageDir;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ds-r4p2-audit-"));
  CSVStorageManager.baseStorageDir = tmpDir;
  CSVStorageManager.clearRowCountCache();
  CSVStorageManager.clearQuotaCaches();
  clearAuditLogsForTests();

  let mockServer: http.Server | null = null;
  let pgServer: http.Server | null = null;

  try {
    const cookie = await createOwnerCookie("audit-owner@datastack.dev");
    const partitionDir = path.join(tmpDir, "export-client");
    await fsp.mkdir(partitionDir, { recursive: true });
    await fsp.writeFile(
      path.join(partitionDir, "2026-11-20.csv"),
      'clientId,eventId,timestamp,payload\n"export-client","evt-1","2026-11-20T10:00:00.000Z","{""ok"":true}"\n',
      "utf8",
    );

    // 1. Filtered-range export audit log
    const rangeRes = await exportGet(
      new NextRequest(
        "http://127.0.0.1:3000/api/export?clientId=export-client&format=csv&flush=false",
        { headers: { Cookie: cookie } },
      ),
    );
    assert.equal(rangeRes.status, 200);
    await rangeRes.text();

    // 2. Single-file export audit log
    const singleRes = await exportGet(
      new NextRequest(
        "http://127.0.0.1:3000/api/export?clientId=export-client&filename=2026-11-20.csv&format=json&flush=false",
        { headers: { Cookie: cookie } },
      ),
    );
    assert.equal(singleRes.status, 200);
    await singleRes.text();

    // Verify /api/audit filters DATA_EXPORT_DOWNLOADED
    const auditRes = await auditGet(
      new NextRequest(
        "http://127.0.0.1:3000/api/audit?action=DATA_EXPORT_DOWNLOADED&limit=10",
        { headers: { Cookie: cookie } },
      ),
    );
    assert.equal(auditRes.status, 200);
    const auditJson = await auditRes.json();
    assert.equal(auditJson.logs.length, 2);
    assert.equal(auditJson.logs[0].action, "DATA_EXPORT_DOWNLOADED");
    assert.equal(auditJson.logs[0].metadata.mode, "single_file");
    assert.equal(auditJson.logs[1].metadata.mode, "filtered_range");

    // 3. Files Manager HTTP mutations -> RAM fallback
    clearAuditLogsForTests();
    const ramApp = express();
    ramApp.use(
      "/vcon/files-engine",
      filesManager.createFilesSecurityMiddleware({
        rootDir: tmpDir,
        getDbPool: () => null,
      }),
    );
    ramApp.put("/vcon/files-engine/api/v1/fs/sample.csv", (_req: express.Request, res: express.Response) => {
      res.status(200).json({ ok: true });
    });
    ramApp.put("/vcon/files-engine/api/v1/rename", (_req: express.Request, res: express.Response) => {
      res.status(200).json({ ok: true });
    });
    ramApp.delete("/vcon/files-engine/api/v1/fs/sample.csv", (_req: express.Request, res: express.Response) => {
      res.status(403).json({ ok: false }); // non-2xx should NOT emit mutation audit
    });

    mockServer = http.createServer(ramApp);
    await new Promise<void>((resolve) => mockServer!.listen(0, "127.0.0.1", resolve));
    const ramPort = (mockServer.address() as AddressInfo).port;
    const originHeaders = {
      Cookie: cookie,
      Origin: `http://127.0.0.1:${ramPort}`,
      Host: `127.0.0.1:${ramPort}`,
      "Content-Type": "application/json",
    };

    const putRes = await fetch(
      `http://127.0.0.1:${ramPort}/vcon/files-engine/api/v1/fs/sample.csv`,
      { method: "PUT", headers: originHeaders, body: "hello" },
    );
    assert.equal(putRes.status, 200);

    const renameRes = await fetch(
      `http://127.0.0.1:${ramPort}/vcon/files-engine/api/v1/rename`,
      {
        method: "PUT",
        headers: originHeaders,
        body: JSON.stringify({ from: "/sample.csv", to: "/renamed.csv" }),
      },
    );
    assert.equal(renameRes.status, 200);

    const failDelRes = await fetch(
      `http://127.0.0.1:${ramPort}/vcon/files-engine/api/v1/fs/sample.csv`,
      { method: "DELETE", headers: originHeaders },
    );
    assert.equal(failDelRes.status, 403);

    await filesManager.flushPendingFilesAuditLogsForTests();
    const { logs: fmRamLogs } = await listAdminAuditLogsWithStatusAsync({
      action: "FILES_MANAGER_MUTATION",
    });
    assert.equal(fmRamLogs.length, 2);
    assert.equal(fmRamLogs[0].target, "/renamed.csv");
    assert.equal(fmRamLogs[0].metadata.from, "/sample.csv");
    assert.equal(fmRamLogs[1].target, "/sample.csv");

    // 4. Files Manager HTTP mutation -> mock PostgreSQL pool
    const pgInserts: Array<{ sql: string; params: unknown[] }> = [];
    const mockDbPool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/FROM\s+admin_users\b/i.test(sql)) {
          return {
            rows: [{ email: "audit-owner@datastack.dev", token_version: 1 }],
          };
        }
        if (/FROM\s+admin_team_members\b/i.test(sql)) {
          return { rows: [] };
        }
        pgInserts.push({ sql, params });
        return { rows: [] };
      },
    };
    const pgApp = express();
    pgApp.use(
      "/vcon/files-engine",
      filesManager.createFilesSecurityMiddleware({
        rootDir: tmpDir,
        getDbPool: () => mockDbPool,
      }),
    );
    pgApp.delete("/vcon/files-engine/api/v1/fs/obsolete.csv", (_req: express.Request, res: express.Response) => {
      res.status(200).json({ ok: true });
    });

    pgServer = http.createServer(pgApp);
    await new Promise<void>((resolve) => pgServer!.listen(0, "127.0.0.1", resolve));
    const pgPort = (pgServer.address() as AddressInfo).port;
    const pgDel = await fetch(
      `http://127.0.0.1:${pgPort}/vcon/files-engine/api/v1/fs/obsolete.csv`,
      {
        method: "DELETE",
        headers: {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${pgPort}`,
          Host: `127.0.0.1:${pgPort}`,
        },
      },
    );
    assert.equal(pgDel.status, 200);
    await filesManager.flushPendingFilesAuditLogsForTests();

    assert.equal(pgInserts.length, 1);
    assert.match(pgInserts[0].sql, /INSERT INTO admin_audit_logs/i);
    assert.equal(pgInserts[0].params[3], "FILES_MANAGER_MUTATION");
    assert.equal(pgInserts[0].params[4], "/obsolete.csv");

    // 5. AuditLogViewer filter options expose both new action types
    const viewerSrc = await fsp.readFile(
      path.join(process.cwd(), "components/sections/AuditLogViewer.tsx"),
      "utf8",
    );
    assert.ok(viewerSrc.includes("FILES_MANAGER_MUTATION"));
    assert.ok(viewerSrc.includes("DATA_EXPORT_DOWNLOADED"));
  } finally {
    if (mockServer) mockServer.close();
    if (pgServer) pgServer.close();
    clearAuditLogsForTests();
    CSVStorageManager.baseStorageDir = prevStorage;
    CSVStorageManager.clearRowCountCache();
    CSVStorageManager.clearQuotaCaches();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("R4-Phase-02 AUDIT-07 / ERR-R4-07: GET /api/data isolates corrupt .csv.gz partitions and serves healthy data", async () => {
  const prevStorage = CSVStorageManager.baseStorageDir;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ds-r4p2-corrupt-"));
  CSVStorageManager.baseStorageDir = tmpDir;
  CSVStorageManager.clearRowCountCache();
  CSVStorageManager.clearQuotaCaches();

  try {
    const cookie = await createOwnerCookie("data-owner@datastack.dev");
    const healthyDir = path.join(tmpDir, "healthy-app");
    const corruptDir = path.join(tmpDir, "corrupt-app");
    await fsp.mkdir(healthyDir, { recursive: true });
    await fsp.mkdir(corruptDir, { recursive: true });

    await fsp.writeFile(
      path.join(healthyDir, "2026-11-20.csv"),
      'clientId,eventId,timestamp,payload\n"healthy-app","ok-1","2026-11-20T12:00:00.000Z","{""status"":""alive""}"\n',
      "utf8",
    );
    await fsp.writeFile(
      path.join(corruptDir, "2026-11-20.csv.gz"),
      Buffer.from("corrupted-not-gzip-bytes-123456"),
    );

    const res = await dataGet(
      new NextRequest(
        "http://127.0.0.1:3000/api/data?from=2026-11-20&to=2026-11-20&page=1&pageSize=25",
        {
          headers: { Cookie: cookie },
        },
      ),
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.total, 1);
    assert.equal(json.events.length, 1);
    assert.equal(json.events[0].eventId, "ok-1");
    assert.equal(json.warnings, 1);
    assert.ok(Array.isArray(json.corruptPartitions));
    assert.equal(json.corruptPartitions.length, 1);
    assert.equal(json.corruptPartitions[0].clientId, "corrupt-app");
    assert.equal(json.corruptPartitions[0].filename, "2026-11-20.csv.gz");
    assert.equal(json.corruptPartitions[0].code, "CORRUPT_GZIP_PARTITION");
  } finally {
    CSVStorageManager.baseStorageDir = prevStorage;
    CSVStorageManager.clearRowCountCache();
    CSVStorageManager.clearQuotaCaches();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("R4-Phase-02 AUDIT-10 & AUDIT-11: PATCH redacts secret/token and /internal/client-sync disconnects selectively", async () => {
  const cookie = await createOwnerCookie("clients-owner@datastack.dev");
  const client = await SDKManager.registerClientAsync({
    clientId: "r4p2-selective-client",
    name: "Initial Client Name",
    rateLimit: 100,
    storageQuotaMb: 50,
    allowedIps: "127.0.0.1",
  });

  // 1. AUDIT-10: PATCH metadata update must omit secret & full token
  const metaPatchRes = await clientPatch(
    new NextRequest(`http://127.0.0.1:3000/api/clients/${client.clientId}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed Client", rateLimit: 250 }),
    }),
    { params: Promise.resolve({ id: client.clientId }) },
  );
  assert.equal(metaPatchRes.status, 200);
  const metaPatchJson = await metaPatchRes.json();
  assert.equal(metaPatchJson.client.name, "Renamed Client");
  assert.equal(metaPatchJson.client.rateLimit, 250);
  assert.equal("secret" in metaPatchJson.client, false);
  assert.equal("token" in metaPatchJson.client, false);
  assert.equal(typeof metaPatchJson.client.tokenPreview, "string");
  assert.ok(metaPatchJson.client.tokenPreview.endsWith("..."));

  // 2. AUDIT-10: regenerate_token includes rotated token while still redacting secret
  const regenRes = await clientPatch(
    new NextRequest(`http://127.0.0.1:3000/api/clients/${client.clientId}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "regenerate_token" }),
    }),
    { params: Promise.resolve({ id: client.clientId }) },
  );
  assert.equal(regenRes.status, 200);
  const regenJson = await regenRes.json();
  assert.equal("secret" in regenJson.client, false);
  assert.equal(typeof regenJson.client.token, "string");
  assert.notEqual(regenJson.client.token, client.token);

  // 3. AUDIT-11: Live Socket.IO client stays connected on metadata update, disconnects on security update
  await new Promise<void>((resolve) =>
    ingestionServer.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (ingestionServer.server.address() as AddressInfo).port;
  const internalHeaders = {
    "Content-Type": "application/json",
    ...getInternalIngestionHeaders(),
  };

  let sock: ReturnType<typeof ioClient> | null = null;
  try {
    // Seed ingestion server registry via /internal/client-sync registered
    const regSyncRes = await fetch(
      `http://127.0.0.1:${port}/internal/client-sync`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          action: "registered",
          clientId: client.clientId,
          client: {
            ...regenJson.client,
            token: regenJson.client.token,
            status: "active",
            allowedIps: "127.0.0.1",
            expiresAt: null,
          },
        }),
      },
    );
    assert.equal(regSyncRes.status, 200);

    sock = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: regenJson.client.token },
      transports: ["websocket"],
    });
    await new Promise<void>((resolve, reject) => {
      sock!.on("connect", () => resolve());
      sock!.on("connect_error", reject);
    });

    // Metadata-only update: socket MUST remain connected
    const metadataSyncRes = await fetch(
      `http://127.0.0.1:${port}/internal/client-sync`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          action: "updated",
          clientId: client.clientId,
          client: {
            ...regenJson.client,
            name: "Hot Metadata Update",
            rateLimit: 400,
            storageQuotaMb: 200,
            token: regenJson.client.token,
            status: "active",
            allowedIps: "127.0.0.1",
            expiresAt: null,
          },
        }),
      },
    );
    assert.equal(metadataSyncRes.status, 200);
    const metadataSyncJson = await metadataSyncRes.json();
    assert.equal(metadataSyncJson.disconnected, false);
    assert.equal(sock.connected, true);

    // AllowedIps narrowing away from 127.0.0.1 MUST disconnect live socket
    const disconnectPromise = new Promise<string>((resolve) => {
      sock!.once("disconnect", resolve);
    });
    const ipSyncRes = await fetch(
      `http://127.0.0.1:${port}/internal/client-sync`,
      {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          action: "updated",
          clientId: client.clientId,
          client: {
            ...regenJson.client,
            token: regenJson.client.token,
            status: "active",
            allowedIps: "203.0.113.50",
            expiresAt: null,
          },
        }),
      },
    );
    assert.equal(ipSyncRes.status, 200);
    const ipSyncJson = await ipSyncRes.json();
    assert.equal(ipSyncJson.disconnected, true);
    await disconnectPromise;
    assert.equal(sock.connected, false);
  } finally {
    if (sock) sock.disconnect();
    await new Promise<void>((resolve) => ingestionServer.io.close(() => resolve()));
    await SDKManager.deleteClientWithStatsAsync("r4p2-selective-client", {
      purgeFiles: false,
    }).catch(() => undefined);
  }
});

test("R4-Phase-02 AUDIT-12 / ERR-R4-08: Streaming S3 upload & streaming .csv.gz row counter", async () => {
  process.env.DATASTACK_ALLOW_PRIVATE_URLS = "true";
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ds-r4p2-stream-"));

  let s3Server: http.Server | null = null;
  try {
    // 1. Multi-chunk (>256 KB) .csv and .csv.gz partitions for row counting & S3 upload
    const totalRows = 3200;
    const lines = ["clientId,eventId,timestamp,payload"];
    for (let i = 0; i < totalRows; i += 1) {
      lines.push(
        `"stream-client","evt-${i}","2026-11-20T00:00:00.000Z","{""seq"":${i},""padding"":""0123456789abcdef0123456789abcdef0123456789abcdef""}"`,
      );
    }
    const rawCsv = `${lines.join("\n")}\n`;
    assert.ok(Buffer.byteLength(rawCsv, "utf8") > 256 * 1024);

    const csvPath = path.join(tmpDir, "2026-11-20.csv");
    const gzPath = path.join(tmpDir, "2026-11-20.csv.gz");
    await fsp.writeFile(csvPath, rawCsv, "utf8");
    await fsp.writeFile(gzPath, zlib.gzipSync(Buffer.from(rawCsv, "utf8")));

    assert.equal(
      await CSVStorageManager.countCsvDataRowsStreamAsync(csvPath),
      totalRows,
    );
    assert.equal(
      await CSVStorageManager.countCsvDataRowsStreamAsync(gzPath),
      totalRows,
    );

    const corruptGz = path.join(tmpDir, "corrupt.csv.gz");
    await fsp.writeFile(corruptGz, Buffer.from("invalid-gzip-data"));
    await assert.rejects(() =>
      CSVStorageManager.countCsvDataRowsStreamAsync(corruptGz),
    );

    // 2. Streaming PUT via uploadFileToS3 with exact content-length & SHA-256 verification
    let failNextUpload = false;
    const receivedUploads: Array<{
      url: string;
      contentLength: string | undefined;
      sha256: string | undefined;
      body: Buffer;
    }> = [];

    s3Server = http.createServer((req, res) => {
      if (failNextUpload) {
        req.resume();
        res.destroy(new Error("Simulated mid-upload S3 reset"));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedUploads.push({
          url: req.url || "",
          contentLength: req.headers["content-length"],
          sha256: req.headers["x-amz-content-sha256"] as string | undefined,
          body: Buffer.concat(chunks),
        });
        res.writeHead(200, { ETag: '"stream-etag-ok"' });
        res.end();
      });
    });

    await new Promise<void>((resolve) => s3Server!.listen(0, "127.0.0.1", resolve));
    const s3Port = (s3Server.address() as AddressInfo).port;
    const s3Config = {
      endpoint: `http://127.0.0.1:${s3Port}`,
      region: "auto",
      bucket: "datastack-test-bucket",
      prefix: "archive",
      accessKeyId: "test-ak",
      secretAccessKey: "test-sk",
    };

    const csvRes = await uploadFileToS3(
      s3Config,
      csvPath,
      "archive/stream-client/2026-11-20.csv",
    );
    assert.equal(csvRes.ok, true);
    assert.equal(csvRes.etag, '"stream-etag-ok"');

    const gzRes = await uploadFileToS3(
      s3Config,
      gzPath,
      "archive/stream-client/2026-11-20.csv.gz",
    );
    assert.equal(gzRes.ok, true);

    assert.equal(receivedUploads.length, 2);
    const expectedCsvBuf = await fsp.readFile(csvPath);
    const expectedCsvHash = crypto
      .createHash("sha256")
      .update(expectedCsvBuf)
      .digest("hex");
    assert.equal(
      receivedUploads[0].contentLength,
      String(expectedCsvBuf.length),
    );
    assert.equal(receivedUploads[0].sha256, expectedCsvHash);
    assert.ok(receivedUploads[0].body.equals(expectedCsvBuf));

    const expectedGzBuf = await fsp.readFile(gzPath);
    assert.equal(
      receivedUploads[1].contentLength,
      String(expectedGzBuf.length),
    );
    assert.ok(receivedUploads[1].body.equals(expectedGzBuf));

    // 3. Failure mid-upload returns S3_ARCHIVE_FAILED cleanly
    failNextUpload = true;
    const failRes = await uploadFileToS3(
      s3Config,
      csvPath,
      "archive/stream-client/fail.csv",
    );
    assert.equal(failRes.ok, false);
    assert.equal(failRes.code, "S3_ARCHIVE_FAILED");
  } finally {
    delete process.env.DATASTACK_ALLOW_PRIVATE_URLS;
    if (s3Server) s3Server.close();
    await fsp.rm(tmpDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(tmpDir), false);
  }
});
