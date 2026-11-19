import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { NextRequest } from "next/server";
import { GET as getDataRoute } from "../app/api/data/route";
import {
  GET as getEventsRoute,
  POST as postEventsRoute,
} from "../app/api/events/route";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  createInitialAdmin,
  resetAdminStateForTests,
} from "../core/auth/adminUsers";
import {
  DataBufferEngine,
  MAX_REDIS_RECENT_LIMIT,
  resolveRedisRecentLimit,
} from "../core/data/buffer";
import {
  CORE_SCHEMA_ALTER_DDLS,
  CORE_SCHEMA_TABLE_DDLS,
} from "../core/Database/database";
import { SDKManager } from "../core/sdk/sdkManager";
import { CSVStorageManager, type DataEvent } from "../core/Storage/csvStorage";

const g = globalThis as typeof globalThis & {
  __dataStackBufferState?: {
    buffer: DataEvent[];
    recentEvents: DataEvent[];
    deletedClientIds?: Set<string>;
    batchFlushThreshold: number;
  };
  __dataStackAdminSettings?: unknown;
  __dataStackClientsMap?: Map<string, unknown>;
  __dataStackDeletedClients?: Set<string>;
};

let tmpStorageDir = "";
let adminCookieHeader = "";
const origBaseStorageDir = CSVStorageManager.baseStorageDir;
const prevDbUrl = process.env.DATABASE_URL;
const prevRedisUrl = process.env.REDIS_URL;
const prevRecentEnv = process.env.DATASTACK_RECENT_LIMIT;
const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;

before(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  delete process.env.DATASTACK_RECENT_LIMIT;
  process.env.INGESTION_INTERNAL_URL = "http://127.0.0.1:1";

  resetAdminStateForTests();
  await createInitialAdmin("admin@datastack.dev", "Phase04Pass123!");
  const secret = getAdminSessionSecret()!;
  const token = await createAdminSessionToken(
    "admin@datastack.dev",
    secret,
    Date.now() + 3600_000,
    1,
  );
  adminCookieHeader = `datastack_admin_session=${token}`;

  tmpStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "datastack-phase04-"));
  CSVStorageManager.baseStorageDir = tmpStorageDir;
  CSVStorageManager.clearRowCountCache();
});

beforeEach(() => {
  process.env.INGESTION_INTERNAL_URL = "http://127.0.0.1:1";
  DataBufferEngine.setRedisClientForTests(null);
  DataBufferEngine.batchFlushThreshold = 500;
  delete process.env.DATASTACK_RECENT_LIMIT;
  if (g.__dataStackBufferState) {
    g.__dataStackBufferState.buffer = [];
    g.__dataStackBufferState.recentEvents = [];
    g.__dataStackBufferState.deletedClientIds?.clear();
  }
  CSVStorageManager.clearRowCountCache();
  fs.rmSync(tmpStorageDir, { recursive: true, force: true });
  fs.mkdirSync(tmpStorageDir, { recursive: true });
  delete g.__dataStackAdminSettings;
  g.__dataStackClientsMap?.clear();
  g.__dataStackDeletedClients?.clear();
});

after(async () => {
  await DataBufferEngine.shutdown();
  CSVStorageManager.baseStorageDir = origBaseStorageDir;
  CSVStorageManager.clearRowCountCache();
  if (tmpStorageDir) {
    fs.rmSync(tmpStorageDir, { recursive: true, force: true });
  }
  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;

  if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = prevRedisUrl;

  if (prevRecentEnv === undefined) delete process.env.DATASTACK_RECENT_LIMIT;
  else process.env.DATASTACK_RECENT_LIMIT = prevRecentEnv;

  if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
  else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;
});

test("FORENSIC BUG-21 (Part A): HTTP POST /api/events matches WS envelope stripping parity and never fabricates sample telemetry for {}", async () => {
  const client = await SDKManager.registerClientAsync({
    clientId: "phase04_parity",
    name: "Parity Client",
    rateLimit: 100,
  });

  // 1. Empty {} body must store "{}" (NO fake { sample, rand })
  const emptyRes = await postEventsRoute(
    new NextRequest("http://localhost:3000/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(emptyRes.status, 200);
  const emptyJson = await emptyRes.json();
  assert.equal(emptyJson.success, true);
  assert.equal(emptyJson.event.payload, "{}");
  assert.equal(emptyJson.event.payload.includes("sample"), false);
  assert.equal(emptyJson.event.payload.includes("rand"), false);

  // 2. Flat body with envelope keys must strip eventId/timestamp/clientId cleanly
  const flatRes = await postEventsRoute(
    new NextRequest("http://localhost:3000/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({
        eventId: "flat-parity-1",
        timestamp: "2026-11-19T12:00:00.000Z",
        clientId: client.clientId,
        temp: 24.5,
        unit: "C",
      }),
    }),
  );
  assert.equal(flatRes.status, 200);
  const flatJson = await flatRes.json();
  assert.deepEqual(JSON.parse(flatJson.event.payload), { temp: 24.5, unit: "C" });

  // 3. Pure envelope { eventId, timestamp, data } extracts data identically to WS
  const wrappedRes = await postEventsRoute(
    new NextRequest("http://localhost:3000/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({
        eventId: "wrapped-parity-1",
        timestamp: "2026-11-19T12:00:01.000Z",
        data: { pressure: 101.3 },
      }),
    }),
  );
  assert.equal(wrappedRes.status, 200);
  const wrappedJson = await wrappedRes.json();
  assert.deepEqual(JSON.parse(wrappedJson.event.payload), { pressure: 101.3 });

  // 4. Flat payload that contains both `data` and extra domain fields preserves the object identically to WS
  const mixedRes = await postEventsRoute(
    new NextRequest("http://localhost:3000/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({
        eventId: "mixed-parity-1",
        data: "sensor-raw",
        extraMetric: 42,
      }),
    }),
  );
  assert.equal(mixedRes.status, 200);
  const mixedJson = await mixedRes.json();
  assert.deepEqual(JSON.parse(mixedJson.event.payload), {
    eventId: "mixed-parity-1",
    data: "sensor-raw",
    extraMetric: 42,
  });
});

test("FORENSIC BUG-21 (Part B): GET /api/data uses non-blocking async fs.promises with partition pruning and REDIS_RECENT_LIMIT scales boundedly", async () => {
  const dataRouteSrc = fs.readFileSync(
    path.resolve(process.cwd(), "app/api/data/route.ts"),
    "utf8",
  );
  assert.match(dataRouteSrc, /from "node:fs\/promises"/);
  assert.equal(/\breaddirSync\b/.test(dataRouteSrc), false);
  assert.equal(/\blstatSync\b/.test(dataRouteSrc), false);

  // Create an out-of-range corrupt CSV partition and an in-range healthy CSV partition
  const clientDir = CSVStorageManager.ensureClientDir("phase04_async");
  fs.writeFileSync(
    path.join(clientDir, "2026-11-10.csv"),
    '"clientId","eventId","timestamp","payload"\n"phase04_async","bad","2026-11-10T00:00:00Z","unclosed',
    "utf8",
  );
  await CSVStorageManager.appendBatch([
    {
      clientId: "phase04_async",
      eventId: "in-range-1",
      timestamp: "2026-11-19T14:00:00.000Z",
      payload: JSON.stringify({ healthy: true }),
    },
  ]);

  const res = await getDataRoute(
    new NextRequest(
      "http://localhost:3000/api/data?clientId=phase04_async&from=2026-11-19&to=2026-11-19",
      { headers: { cookie: adminCookieHeader } },
    ),
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.total, 1);
  assert.equal(json.events[0].eventId, "in-range-1");

  // Bounded configurable recent limit scaling
  assert.equal(resolveRedisRecentLimit(500), 500);
  assert.equal(resolveRedisRecentLimit(1200), 1200);
  assert.equal(resolveRedisRecentLimit(50000), MAX_REDIS_RECENT_LIMIT);

  process.env.DATASTACK_RECENT_LIMIT = "900";
  assert.equal(DataBufferEngine.getRecentLimit(), 900);
  delete process.env.DATASTACK_RECENT_LIMIT;

  DataBufferEngine.batchFlushThreshold = 650;
  assert.equal(DataBufferEngine.getRecentLimit(), 650);
  const batch600: DataEvent[] = Array.from({ length: 600 }, (_, i) => ({
    clientId: "phase04_recent_scale",
    eventId: `recent-scale-${i}`,
    timestamp: "2026-11-19T15:00:00.000Z",
    payload: JSON.stringify({ i }),
  }));
  await DataBufferEngine.pushBatchAsync(batch600);
  assert.equal(DataBufferEngine.getRecentEvents(650, "phase04_recent_scale").length, 600);
});

test("FORENSIC BUG-23: Client secrets and fallback eventIds use CSPRNG crypto.randomBytes with zero Math.random()", async () => {
  const client = await SDKManager.registerClientAsync({
    clientId: "phase04_csprng",
    name: "CSPRNG Client",
    rateLimit: 100,
  });
  assert.match(client.secret, /^sec_phase04_csprng_[0-9a-f]{32}$/);

  const rotated = await SDKManager.regenerateTokenAsync(client.clientId);
  assert.ok(rotated);
  assert.match(rotated.secret, /^sec_phase04_csprng_[0-9a-f]{32}$/);
  assert.notEqual(rotated.secret, client.secret);

  const res = await postEventsRoute(
    new NextRequest("http://localhost:3000/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rotated.token}`,
      },
      body: JSON.stringify({ metric: "ok" }),
    }),
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.match(json.eventId, /^evt_\d+_[0-9a-f]{12}$/);

  for (const relPath of [
    "core/sdk/sdkManager.ts",
    "app/api/events/route.ts",
    "server/socket/handlers.js",
  ]) {
    const src = fs.readFileSync(path.resolve(process.cwd(), relPath), "utf8");
    assert.equal(
      /\bMath\.random\s*\(/.test(src),
      false,
      `Expected zero Math.random() calls in ${relPath}`,
    );
  }
});

test("FORENSIC BUG-24: Canonical PostgreSQL DDL is unified in database.ts, delegated by adminUsers.ts, and mirrored 1:1 in server/index.js & prisma/schema.prisma", () => {
  const adminUsersSrc = fs.readFileSync(
    path.resolve(process.cwd(), "core/auth/adminUsers.ts"),
    "utf8",
  );
  const serverIndexSrc = fs.readFileSync(
    path.resolve(process.cwd(), "server/index.js"),
    "utf8",
  );
  const prismaSchemaSrc = fs.readFileSync(
    path.resolve(process.cwd(), "prisma/schema.prisma"),
    "utf8",
  );

  // adminUsers.ts must delegate to ensureCoreSchemaOnPool rather than duplicating CREATE TABLE
  assert.match(adminUsersSrc, /ensureCoreSchemaOnPool/);
  assert.equal(/CREATE TABLE IF NOT EXISTS/.test(adminUsersSrc), false);

  // All 5 canonical tables must exist identically in database.ts, server/index.js, and prisma/schema.prisma
  const expectedTables = [
    "client_sdks",
    "admin_settings",
    "deleted_clients",
    "admin_users",
    "admin_login_attempts",
  ];
  const dbTablesText = CORE_SCHEMA_TABLE_DDLS.join("\n");
  for (const table of expectedTables) {
    const createRe = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`);
    assert.match(dbTablesText, createRe, `database.ts missing ${table}`);
    assert.match(serverIndexSrc, createRe, `server/index.js missing ${table}`);
    assert.match(
      prismaSchemaSrc,
      new RegExp(`@@map\\("${table}"\\)`),
      `prisma/schema.prisma missing @@map("${table}")`,
    );
  }

  // All 3 additive ALTER TABLE guards must exist in both database.ts and server/index.js
  const dbAltersText = CORE_SCHEMA_ALTER_DDLS.join("\n");
  for (const alterTable of ["client_sdks", "admin_settings", "admin_users"]) {
    const alterRe = new RegExp(`ALTER TABLE\\s+${alterTable}\\s+ADD COLUMN IF NOT EXISTS`);
    assert.match(dbAltersText, alterRe, `database.ts missing ALTER TABLE ${alterTable}`);
    assert.match(serverIndexSrc, alterRe, `server/index.js missing ALTER TABLE ${alterTable}`);
  }

  // prisma/schema.prisma must explicitly document canonical runtime pg ownership
  assert.match(prismaSchemaSrc, /REFERENCE SCHEMA ONLY/);
  assert.match(prismaSchemaSrc, /core\/Database\/database\.ts/);
});

test("R2 PHASE-03 BUG-11: Flat batch items strip eventId/timestamp/clientId across both HTTP POST /api/events and Socket.IO batch_sync", async () => {
  const client = await SDKManager.registerClientAsync({
    clientId: "phase03_batch_strip",
    name: "Batch Strip Client",
    rateLimit: 200,
  });

  // 1. HTTP POST /api/events batch array
  const httpBatchRes = await postEventsRoute(
    new NextRequest("http://localhost:3000/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({
        batch: [
          {
            eventId: "http-flat-batch-1",
            timestamp: "2026-11-19T12:10:00.000Z",
            clientId: client.clientId,
            sensor: "temp",
            value: 23.4,
          },
          {
            eventId: "http-env-batch-2",
            timestamp: "2026-11-19T12:10:01.000Z",
            data: { sensor: "humidity", value: 60 },
          },
        ],
      }),
    }),
  );
  assert.equal(httpBatchRes.status, 200);
  const httpBatchJson = await httpBatchRes.json();
  assert.equal(httpBatchJson.processed, 2);

  const localSnap = DataBufferEngine.getLocalBufferSnapshot();
  const flatEvt = localSnap.find((e) => e.eventId === "http-flat-batch-1");
  const envEvt = localSnap.find((e) => e.eventId === "http-env-batch-2");
  assert.ok(flatEvt);
  assert.ok(envEvt);
  assert.deepEqual(JSON.parse(flatEvt.payload), { sensor: "temp", value: 23.4 });
  assert.deepEqual(JSON.parse(envEvt.payload), { sensor: "humidity", value: 60 });

  // 2. Socket.IO batch_sync handler
  const require = createRequire(import.meta.url);
  const { setupSocketHandlers } = require("../server/socket/handlers") as {
    setupSocketHandlers: (
      io: unknown,
      bufferQueue: DataEvent[],
      worker: unknown,
      options?: Record<string, unknown>,
    ) => unknown;
  };
  let connectionHandler: ((socket: unknown) => void) | null = null;
  const fakeIo = {
    use: () => undefined,
    on: (evt: string, fn: (socket: unknown) => void) => {
      if (evt === "connection") connectionHandler = fn;
    },
  };
  const wsQueue: DataEvent[] = [];
  setupSocketHandlers(fakeIo, wsQueue, {}, {
    verifyClientInDb: async () => ({ allowed: true, rateLimit: 200 }),
  });
  assert.ok(connectionHandler);

  const listeners = new Map<string, (...args: unknown[]) => Promise<void>>();
  const fakeSocket = {
    data: { clientId: "phase03_batch_strip", token: client.token, rateLimit: 200 },
    join: () => undefined,
    disconnect: () => undefined,
    on: (name: string, fn: (...args: unknown[]) => Promise<void>) => {
      listeners.set(name, fn);
    },
  };
  (connectionHandler as (socket: unknown) => void)(fakeSocket);

  const batchSyncHandler = listeners.get("batch_sync");
  assert.ok(batchSyncHandler);
  let wsAck: Record<string, unknown> | null = null;
  await batchSyncHandler(
    [
      {
        eventId: "ws-flat-batch-1",
        timestamp: "2026-11-19T12:11:00.000Z",
        clientId: "phase03_batch_strip",
        sensor: "pressure",
        value: 101.2,
      },
    ],
    (ack: Record<string, unknown>) => {
      wsAck = ack;
    },
  );
  assert.ok(wsAck);
  assert.equal((wsAck as Record<string, unknown>).success, true);
  assert.equal(wsQueue.length, 1);
  assert.deepEqual(JSON.parse(wsQueue[0].payload), {
    sensor: "pressure",
    value: 101.2,
  });
});

test("R2 PHASE-03 BUG-12: DataBufferEngine.getLocalBufferSnapshot returns exact state.buffer contents for getPendingBufferedSummary", async () => {
  const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;
  process.env.INGESTION_INTERNAL_URL = "http://127.0.0.1:1";
  try {
    // Seed 1 unflushed RAM event directly in buffer while recentEvents contains a DIFFERENT newer flushed item
    await DataBufferEngine.pushAsync({
      clientId: "phase03_buf_exact",
      eventId: "real-unflushed-1",
      timestamp: "2026-11-19T13:00:00.000Z",
      payload: JSON.stringify({ state: "unflushed" }),
    });
    // Simulate a flushed event sitting at the front of recentEvents (which old getRecentEvents slice would wrongly return!)
    g.__dataStackBufferState!.recentEvents.unshift({
      clientId: "other_flushed_client",
      eventId: "already-flushed-99",
      timestamp: "2026-11-19T13:05:00.000Z",
      payload: JSON.stringify({ state: "already-flushed" }),
    });

    const snap = DataBufferEngine.getLocalBufferSnapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].eventId, "real-unflushed-1");

    const res = await getEventsRoute(
      new NextRequest("http://localhost:3000/api/events?bufferedOnly=true&limit=10", {
        headers: { cookie: adminCookieHeader },
      }),
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.events.length, 1);
    assert.equal(json.events[0].eventId, "real-unflushed-1");
    assert.equal(json.bufferedSummary.total, 1);
    assert.equal(json.bufferedSummary.buckets[0].clientId, "phase03_buf_exact");
  } finally {
    if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
    else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;
  }
});

