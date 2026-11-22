import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { NextRequest } from "next/server";
import { io as ioClient } from "socket.io-client";
import { GET as getDataRoute } from "../app/api/data/route";
import { GET as getEventsRoute } from "../app/api/events/route";
import { GET as getExportRoute } from "../app/api/export/route";
import {
  GET as getStorageRoute,
  POST as postStorageRoute,
} from "../app/api/storage/route";
import { ApiEngine } from "../core/apiEngine/apiService";
import {
  DataBufferEngine,
  REDIS_BUFFER_KEY,
  REDIS_FLUSH_LOCK_KEY,
  REDIS_RECENT_KEY,
  type RedisBufferClient,
} from "../core/data/buffer";
import { SDKManager } from "../core/sdk/sdkManager";
import {
  CSVStorageManager,
  resolveDefaultStorageDir as resolveWebStorageDir,
  type DataEvent,
} from "../core/Storage/csvStorage";
import { createAdminSessionToken, getAdminSessionSecret } from "../core/auth/adminSession";
import { createInitialAdmin, resetAdminStateForTests } from "../core/auth/adminUsers";

const require = createRequire(import.meta.url);
const {
  CsvWriterWorker,
  resolveDefaultStorageDir: resolveWorkerStorageDir,
} = require("../server/workers/csvWriter") as {
  CsvWriterWorker: new (baseDir?: string, maxFileSize?: number) => {
    baseDir: string;
    writeBatch: (events: DataEvent[]) => Promise<{ written: number; files: string[] }>;
    pruneExpiredPartitions: (days: number) => number;
    pruneExpiredPartitionsAsync: (days: number) => Promise<number>;
  };
  resolveDefaultStorageDir: () => string;
};

interface IngestionServerModule {
  server: Server;
  io: import("socket.io").Server;
  writer: { baseDir: string };
  bufferQueue: DataEvent[];
  runtimeConfig: {
    batchFlushThreshold: number;
    autoPruneDays: number;
  };
  applyRuntimeSettingsObject: (obj: Record<string, unknown>) => { jwtRotated: boolean };
  flushBuffer: (options?: {
    waitMs?: number;
    lockTtlMs?: number;
    throwOnLockTimeout?: boolean;
  }) => Promise<{ written: number; files: string[]; lockTimedOut?: boolean }>;
  setRedisClientForTests: (client: RedisBufferClient | null | undefined) => void;
  stopTimers: () => void;
}

class FakeRedisClient implements RedisBufferClient {
  public status = "ready";
  public lists = new Map<string, string[]>();
  public strings = new Map<string, { value: string; expiresAt: number }>();
  public sets = new Map<string, Set<string>>();
  public renewCalls = 0;
  public purgeEvalCalls = 0;
  public ltrimCalls = 0;
  public lpushCalls = 0;

  public async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) || [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  public async lpush(key: string, ...values: string[]): Promise<number> {
    this.lpushCalls += 1;
    const list = this.lists.get(key) || [];
    for (const v of values) {
      list.unshift(v);
    }
    this.lists.set(key, list);
    return list.length;
  }

  public async ltrim(key: string, start: number, stop: number): Promise<"OK"> {
    this.ltrimCalls += 1;
    const list = this.lists.get(key) || [];
    const len = list.length;
    const normStart = start < 0 ? Math.max(0, len + start) : start;
    const normStop = stop < 0 ? len + stop : stop;
    if (normStart > normStop || normStart >= len) {
      this.lists.set(key, []);
    } else {
      this.lists.set(key, list.slice(normStart, normStop + 1));
    }
    return "OK";
  }

  public async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) || [];
    const len = list.length;
    if (len === 0) return [];
    const normStart = start < 0 ? Math.max(0, len + start) : start;
    const normStop = stop < 0 ? len + stop : stop;
    if (normStart > normStop || normStart >= len) return [];
    return list.slice(normStart, normStop + 1);
  }

  public async llen(key: string): Promise<number> {
    return (this.lists.get(key) || []).length;
  }

  public async set(
    key: string,
    value: string,
    _pxMode: "PX",
    ttlMs: number,
    _nxMode: "NX",
  ): Promise<string | null> {
    const existing = this.strings.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      return null;
    }
    this.strings.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }

  public async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) || new Set<string>();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }
    this.sets.set(key, set);
    return added;
  }

  public async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    return removed;
  }

  public async sismember(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.has(member) ? 1 : 0;
  }

  public async eval(
    script: string,
    _numKeys: number,
    key: string,
    token: string,
    ttlArg?: string,
  ): Promise<number> {
    if (script.includes("DATASTACK_PURGE_CLIENT_LIST")) {
      this.purgeEvalCalls += 1;
      const list = this.lists.get(key) || [];
      const kept: string[] = [];
      let removed = 0;
      for (const raw of list) {
        try {
          const parsed = JSON.parse(raw) as { clientId?: string };
          const cid = String(parsed?.clientId || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "_");
          if (cid === token) {
            removed += 1;
            continue;
          }
        } catch {
          // keep unparseable items for standard flush cleanup
        }
        kept.push(raw);
      }
      if (removed > 0) {
        this.lists.set(key, kept);
      }
      return removed;
    }

    const existing = this.strings.get(key);
    if (script.includes("pexpire")) {
      if (existing && existing.value === token && existing.expiresAt > Date.now()) {
        const ttlMs = Number(ttlArg);
        existing.expiresAt =
          Date.now() + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 30000);
        this.renewCalls += 1;
        return 1;
      }
      return 0;
    }
    if (existing && existing.value === token) {
      this.strings.delete(key);
      return 1;
    }
    return 0;
  }
}

const g = globalThis as typeof globalThis & {
  __dataStackBufferState?: {
    buffer: DataEvent[];
    recentEvents: DataEvent[];
    deletedClientIds?: Set<string>;
    flushTimer: ReturnType<typeof setInterval> | null;
  };
  __dataStackAdminSettings?: unknown;
  __dataStackClientsMap?: Map<string, unknown>;
  __dataStackDeletedClients?: Set<string>;
};

let tmpStorageDir = "";
let adminCookieHeader = "";
const origBaseStorageDir = CSVStorageManager.baseStorageDir;
const prevDisableListen = process.env.DATASTACK_DISABLE_LISTEN;
const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;
const prevDbUrl = process.env.DATABASE_URL;
const prevRedisUrl = process.env.REDIS_URL;

before(async () => {
  process.env.DATASTACK_DISABLE_LISTEN = "1";
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  delete process.env.INGESTION_INTERNAL_URL;

  resetAdminStateForTests();
  await createInitialAdmin("admin@datastack.dev", "Phase03Pass123!");
  const secret = getAdminSessionSecret()!;
  const token = await createAdminSessionToken("admin@datastack.dev", secret, Date.now() + 3600_000, 1);
  adminCookieHeader = `datastack_admin_session=${token}`;

  tmpStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "datastack-phase03-"));
  CSVStorageManager.baseStorageDir = tmpStorageDir;
  CSVStorageManager.clearRowCountCache();
});

beforeEach(async () => {
  delete process.env.INGESTION_INTERNAL_URL;
  DataBufferEngine.setRedisClientForTests(undefined);
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

  if (prevDisableListen === undefined) delete process.env.DATASTACK_DISABLE_LISTEN;
  else process.env.DATASTACK_DISABLE_LISTEN = prevDisableListen;

  if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
  else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;

  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;

  if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = prevRedisUrl;
});

test("BUG-11: Shared Redis buffer preserves events on CSV error, honors distributed flush lock, avoids double-counting, and falls back to RAM cleanly", async () => {
  const fakeRedis = new FakeRedisClient();
  DataBufferEngine.setRedisClientForTests(fakeRedis);

  const sampleEvents: DataEvent[] = [
    {
      clientId: "phase03_redis",
      eventId: "r-evt-1",
      timestamp: "2026-11-17T10:00:00.000Z",
      payload: JSON.stringify({ seq: 1 }),
    },
    {
      clientId: "phase03_redis",
      eventId: "r-evt-2",
      timestamp: "2026-11-17T10:00:01.000Z",
      payload: JSON.stringify({ seq: 2 }),
    },
  ];

  await DataBufferEngine.pushBatchAsync(sampleEvents);

  assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 2);
  const recentFromRedis = await DataBufferEngine.getRecentEventsAsync(10, "phase03_redis");
  assert.equal(recentFromRedis.length, 2);
  assert.equal(recentFromRedis[0].eventId, "r-evt-2");

  // Lock contention must skip concurrent Redis flush without corrupting queue
  await fakeRedis.set(REDIS_FLUSH_LOCK_KEY, "other-worker-token", "PX", 15000, "NX");
  const skipped = await DataBufferEngine.flush();
  assert.equal(skipped.count, 0);
  assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 2);
  await fakeRedis.eval("", 1, REDIS_FLUSH_LOCK_KEY, "other-worker-token");

  // Crash/error safety: if appendBatch throws before finishing, Redis LTRIM must NOT discard events
  const originalAppend = CSVStorageManager.appendBatch;
  CSVStorageManager.appendBatch = async () => {
    throw new Error("Simulated disk write failure");
  };
  await assert.rejects(() => DataBufferEngine.flush(), /Simulated disk write failure/);
  CSVStorageManager.appendBatch = originalAppend;
  assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 2);

  // Subsequent healthy flush drains Redis list, releases distributed lock, and writes CSV
  const flushed = await DataBufferEngine.flush();
  assert.equal(flushed.count, 2);
  assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 0);
  assert.equal(fakeRedis.strings.has(REDIS_FLUSH_LOCK_KEY), false);

  // Verify Port 4000 /internal/recent & /internal/metrics read shared Redis without double-counting
  const serverMod = require("../server/index.js") as IngestionServerModule;
  const origWriterDir = serverMod.writer.baseDir;
  serverMod.writer.baseDir = tmpStorageDir;
  serverMod.setRedisClientForTests(fakeRedis);
  await new Promise<void>((resolve) => serverMod.server.listen(0, "127.0.0.1", () => resolve()));
  const addr = serverMod.server.address() as AddressInfo;
  process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${addr.port}`;

  try {
    await DataBufferEngine.pushAsync({
      clientId: "phase03_redis",
      eventId: "r-evt-3",
      timestamp: "2026-11-17T10:00:02.000Z",
      payload: JSON.stringify({ seq: 3 }),
    });
    const stats = await DataBufferEngine.getBufferStatsAsync();
    assert.equal(stats.redisEnabled, true);
    assert.equal(stats.redisBufferSize, 1);

    const metrics = await ApiEngine.getDashboardMetrics();
    // Shared Redis count (1) must NOT be counted twice as 2 across Port 3000 + Port 4000
    assert.equal(metrics.bufferStats.currentBufferSize, 1);

    // Clear recent list & buffer via Port 4000 flush
    const flushRes = await serverMod.flushBuffer();
    assert.equal(flushRes.written, 1);
    assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 0);
  } finally {
    serverMod.writer.baseDir = origWriterDir;
    serverMod.setRedisClientForTests(undefined);
    serverMod.stopTimers();
    delete process.env.INGESTION_INTERNAL_URL;
    await new Promise<void>((resolve) => serverMod.io.close(() => serverMod.server.close(() => resolve())));
  }

  // Fallback to local RAM buffer when Redis is disabled (null)
  DataBufferEngine.setRedisClientForTests(null);
  await DataBufferEngine.pushAsync({
    clientId: "phase03_ram",
    eventId: "ram-evt-1",
    timestamp: "2026-11-17T10:01:00.000Z",
    payload: JSON.stringify({ mode: "ram" }),
  });
  const ramStats = await DataBufferEngine.getBufferStatsAsync();
  assert.equal(ramStats.redisEnabled, false);
  assert.equal(ramStats.localBufferSize, 1);
  const ramFlushed = await DataBufferEngine.flush();
  assert.equal(ramFlushed.count, 1);
});

test("BUG-09: Cooperative CSV partition locking serializes concurrent Port 3000 + Port 4000 writers, recovers stale locks, and surfaces Port 4000 flush errors", async () => {
  const worker = new CsvWriterWorker(tmpStorageDir);
  const partitionDate = "2026-11-17";
  const clientId = "phase03_concurrent";

  const batchA: DataEvent[] = Array.from({ length: 15 }, (_, idx) => ({
    clientId,
    eventId: `a-${idx}`,
    timestamp: `${partitionDate}T12:00:00.000Z`,
    payload: JSON.stringify({ writer: "A", idx }),
  }));
  const batchB: DataEvent[] = Array.from({ length: 15 }, (_, idx) => ({
    clientId,
    eventId: `b-${idx}`,
    timestamp: `${partitionDate}T12:00:01.000Z`,
    payload: JSON.stringify({ writer: "B", idx }),
  }));

  await Promise.all([
    CSVStorageManager.appendBatch(batchA),
    worker.writeBatch(batchB),
  ]);

  const csvPath = path.join(tmpStorageDir, clientId, `${partitionDate}.csv`);
  const lockPath = path.join(tmpStorageDir, clientId, `.${partitionDate}.csv.lock`);
  assert.equal(fs.existsSync(lockPath), false, "Lock file must be cleaned up after writes");

  const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  assert.equal(lines[0], '"clientId","eventId","timestamp","payload"');
  assert.equal(lines.length, 31, "Must contain exactly 1 header + 30 complete rows without interleaving");

  // Stale lock recovery (>30s old mtime)
  fs.writeFileSync(lockPath, "999999:0", "utf8");
  const pastTime = new Date(Date.now() - 45_000);
  fs.utimesSync(lockPath, pastTime, pastTime);
  await CSVStorageManager.appendBatch([
    {
      clientId,
      eventId: "after-stale-lock",
      timestamp: `${partitionDate}T12:00:02.000Z`,
      payload: JSON.stringify({ staleRecovered: true }),
    },
  ]);
  assert.equal(fs.existsSync(lockPath), false);
  const files = await CSVStorageManager.listAllFilesAsync();
  assert.equal(files[0].linesCount, 31);

  // Explicit flush error & warning propagation in POST /api/storage
  const failingBridge = createServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: false, error: "Disk permission denied on Port 4000" }));
  });
  await new Promise<void>((resolve) => failingBridge.listen(0, "127.0.0.1", () => resolve()));
  const bridgeAddr = failingBridge.address() as AddressInfo;
  process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${bridgeAddr.port}`;

  try {
    const errRes = await postStorageRoute(new NextRequest("http://localhost:3000/api/storage", { method: "POST", headers: { cookie: adminCookieHeader } }));
    assert.equal(errRes.status, 502);
    const errJson = await errRes.json();
    assert.equal(errJson.success, false);
    assert.equal(errJson.code, "INGESTION_FLUSH_FAILED");
    assert.equal(errJson.ingestionFlushed, false);
  } finally {
    delete process.env.INGESTION_INTERNAL_URL;
    await new Promise<void>((resolve) => failingBridge.close(() => resolve()));
  }

  // When Port 4000 is down and INGESTION_INTERNAL_URL is unset, standalone dev surfaces explicit warning + ingestionFlushed: false
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("http://127.0.0.1:4000/internal/flush")) {
      throw new TypeError("fetch failed (ECONNREFUSED simulated)");
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const standaloneRes = await postStorageRoute(new NextRequest("http://localhost:3000/api/storage", { method: "POST", headers: { cookie: adminCookieHeader } }));
    assert.equal(standaloneRes.status, 200);
    const standaloneJson = await standaloneRes.json();
    assert.equal(standaloneJson.ingestionFlushed, false);
    assert.match(String(standaloneJson.warning || ""), /unreachable/i);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("BUG-10: Cached streaming row counter counts multiline RFC 4180 payloads accurately and avoids repeated disk reads", async () => {
  await CSVStorageManager.appendBatch([
    {
      clientId: "phase03_perf",
      eventId: "multiline-1",
      timestamp: "2026-11-17T08:00:00.000Z",
      payload: JSON.stringify({ note: "line1\nline2\n\"quoted\"\nline4" }),
    },
    {
      clientId: "phase03_perf",
      eventId: "multiline-2",
      timestamp: "2026-11-17T08:00:01.000Z",
      payload: JSON.stringify({ note: "single" }),
    },
  ]);

  const firstStats = await CSVStorageManager.getStorageStatsAsync();
  assert.equal(firstStats.totalRows, 2);

  // Spy on fs.createReadStream to verify repeated dashboard polls hit mtime+size cache with 0 file scans
  const origCreateReadStream = fs.createReadStream;
  let streamReads = 0;
  (fs as unknown as { createReadStream: typeof fs.createReadStream }).createReadStream = ((
    ...args: Parameters<typeof fs.createReadStream>
  ) => {
    streamReads += 1;
    return origCreateReadStream(...args);
  }) as typeof fs.createReadStream;

  try {
    const secondStats = await CSVStorageManager.getStorageStatsAsync();
    assert.equal(secondStats.totalRows, 2);
    assert.equal(streamReads, 0, "Unchanged CSV files must use cached row count");
  } finally {
    (fs as unknown as { createReadStream: typeof fs.createReadStream }).createReadStream =
      origCreateReadStream;
  }

  // Server 3s settings sync must not repeatedly prune when autoPruneDays is unchanged
  const serverMod = require("../server/index.js") as IngestionServerModule;
  const oldPartitionDir = path.join(tmpStorageDir, "phase03_prune_check");
  fs.mkdirSync(oldPartitionDir, { recursive: true });
  fs.writeFileSync(path.join(oldPartitionDir, "2020-01-01.csv"), "h\nr\n", "utf8");
  const prunedCount = CSVStorageManager.pruneExpiredPartitions(30);
  assert.equal(prunedCount, 1);

  serverMod.applyRuntimeSettingsObject({ autoPruneDays: 30 });
  fs.writeFileSync(path.join(oldPartitionDir, "2020-01-02.csv"), "h\nr\n", "utf8");
  // Same autoPruneDays=30 applied again (simulating 3s DB poll) must NOT prune on every tick
  serverMod.applyRuntimeSettingsObject({ autoPruneDays: 30 });
  assert.equal(fs.existsSync(path.join(oldPartitionDir, "2020-01-02.csv")), true);
  serverMod.stopTimers();
});

test("BUG-12: Prisma schema models and mappings align cleanly with runtime SQL DDL and Docker Compose Redis wiring", () => {
  const schemaPath = path.resolve(process.cwd(), "prisma/schema.prisma");
  const schemaText = fs.readFileSync(schemaPath, "utf8");

  assert.match(schemaText, /model ClientSDK[\s\S]*clientId\s+String\s+@id\s+@map\("client_id"\)/);
  assert.match(schemaText, /token\s+String/);
  assert.match(schemaText, /model DeletedClient[\s\S]*@@map\("deleted_clients"\)/);
  assert.match(schemaText, /model AdminUser[\s\S]*tokenVersion\s+Int\s+@default\(1\)\s+@map\("token_version"\)/);
  assert.match(schemaText, /model AdminLoginAttempt[\s\S]*@@map\("admin_login_attempts"\)/);
  assert.match(schemaText, /model AdminSettings[\s\S]*maxEventsPerSec\s+Int\s+@default\(100\)\s+@map\("max_events_per_sec"\)/);
  assert.equal(/model ApiKey\b/.test(schemaText), false);
  assert.equal(/model AuditLog\b/.test(schemaText), false);

  const composeText = fs.readFileSync(path.resolve(process.cwd(), "docker/docker-compose.yml"), "utf8");
  assert.equal((composeText.match(/REDIS_URL:\s*"redis:\/\/redis:6379"/g) || []).length, 2);
  assert.match(composeText, /redis:\s*\n\s*condition:\s*service_healthy/);
});

test("BUG-14: GET /api/data searches eventId & clientId + UTC dates, GET /api/events caps CSV tail, and GET /api/export rejects ambiguous filename & honors ?flush=false", async () => {
  DataBufferEngine.setRedisClientForTests(null);

  await SDKManager.registerClientAsync({ clientId: "alpha_cli", name: "Alpha", rateLimit: 100 });
  await SDKManager.registerClientAsync({ clientId: "beta_cli", name: "Beta", rateLimit: 100 });

  const tsMillis = String(Date.UTC(2026, 10, 17, 15, 0, 0)); // 2026-11-17
  await DataBufferEngine.pushBatchAsync([
    {
      clientId: "alpha_cli",
      eventId: "unique-findme-id-99",
      timestamp: tsMillis,
      payload: JSON.stringify({ temp: 22 }),
    },
    {
      clientId: "beta_cli",
      eventId: "beta-id-1",
      timestamp: "2026-11-17T15:01:00.000Z",
      payload: JSON.stringify({ temp: 33 }),
    },
  ]);

  // 1. Search by eventId with from/to UTC normalization while still buffered
  const dataByEvent = await getDataRoute(
    new NextRequest("http://localhost:3000/api/data?search=unique-findme-id-99&from=2026-11-17&to=2026-11-17", { headers: { cookie: adminCookieHeader } }),
  );
  assert.equal(dataByEvent.status, 200);
  const dataEventJson = await dataByEvent.json();
  assert.equal(dataEventJson.total, 1);
  assert.equal(dataEventJson.events[0].eventId, "unique-findme-id-99");

  // 2. Search by clientId substring
  const dataByClient = await getDataRoute(
    new NextRequest("http://localhost:3000/api/data?search=beta_cli", { headers: { cookie: adminCookieHeader } }),
  );
  const dataClientJson = await dataByClient.json();
  assert.equal(dataClientJson.total, 1);
  assert.equal(dataClientJson.events[0].clientId, "beta_cli");

  // 3. Export with ?flush=false must NOT drain active buffer
  const noFlushRes = await getExportRoute(
    new NextRequest("http://localhost:3000/api/export?flush=false&format=json", { headers: { cookie: adminCookieHeader } }),
  );
  assert.equal(noFlushRes.status, 200);
  assert.equal((await noFlushRes.text()).trim(), "[]");
  assert.equal((await DataBufferEngine.getBufferStatsAsync()).localBufferSize, 2);

  // 4. Default flush writes both 2026-11-17.csv files -> clientId=all + filename must 400 AMBIGUOUS_FILENAME
  const flushExportRes = await getExportRoute(
    new NextRequest("http://localhost:3000/api/export?format=json", { headers: { cookie: adminCookieHeader } }),
  );
  assert.equal(flushExportRes.status, 200);
  const flushedPayload = await flushExportRes.json();
  assert.equal(flushedPayload.length, 2);

  const ambiguousRes = await getExportRoute(
    new NextRequest("http://localhost:3000/api/export?clientId=all&filename=2026-11-17.csv", { headers: { cookie: adminCookieHeader } }),
  );
  assert.equal(ambiguousRes.status, 400);
  const ambiguousJson = await ambiguousRes.json();
  assert.equal(ambiguousJson.code, "AMBIGUOUS_FILENAME");

  // Disambiguated download with explicit clientId succeeds cleanly
  const specificRes = await getExportRoute(
    new NextRequest("http://localhost:3000/api/export?clientId=alpha_cli&filename=2026-11-17.csv", { headers: { cookie: adminCookieHeader } }),
  );
  assert.equal(specificRes.status, 200);
  const csvBody = await specificRes.text();
  assert.match(csvBody, /unique-findme-id-99/);

  // 5. GET /api/events with limit=1 returns latest single stored event cleanly
  const eventsRes = await getEventsRoute(
    new NextRequest("http://localhost:3000/api/events?clientId=alpha_cli&limit=1", { headers: { cookie: adminCookieHeader } }),
  );
  assert.equal(eventsRes.status, 200);
  const eventsJson = await eventsRes.json();
  assert.equal(eventsJson.events.length, 1);
  assert.equal(eventsJson.events[0].eventId, "unique-findme-id-99");

  // 6. SPEC-07: extractSafePartitionDate returns null on corrupt timestamp with null fallback
  assert.equal(CSVStorageManager.extractSafePartitionDate("not-a-timestamp", null), null);
  assert.equal(CSVStorageManager.extractSafePartitionDate("", null), null);
  assert.equal(CSVStorageManager.extractSafePartitionDate("2026-11-17T12:00:00.000Z", null), "2026-11-17");

  // Corrupt timestamp in buffer must NOT leak into today's date range query
  await DataBufferEngine.pushBatchAsync([
    {
      clientId: "alpha_cli",
      eventId: "corrupt-ts-event",
      timestamp: "corrupted_raw_value",
      payload: JSON.stringify({ broken: true }),
    },
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const dateRangeRes = await getDataRoute(
    new NextRequest(`http://localhost:3000/api/data?search=corrupt-ts-event&from=${today}&to=${today}`, { headers: { cookie: adminCookieHeader } }),
  );
  assert.equal(dateRangeRes.status, 200);
  const dateRangeJson = await dateRangeRes.json();
  assert.equal(dateRangeJson.total, 0, "Corrupt timestamp must NOT match date range");

  // But without from/to date filters, corrupt event is still visible for admin inspection
  const allDataRes = await getDataRoute(
    new NextRequest("http://localhost:3000/api/data?search=corrupt-ts-event", { headers: { cookie: adminCookieHeader } }),
  );
  assert.equal(allDataRes.status, 200);
  const allDataJson = await allDataRes.json();
  assert.equal(allDataJson.total, 1, "Corrupt timestamp event must be discoverable in unfiltered search");
});

test("BUG-C01 & BUG-C02: Concurrent in-flight flush coalesces cleanly, Redis recent errors do not duplicate RAM buffer, and lock ownership prevents foreign unlock", async () => {
  const failingRecentRedis = new FakeRedisClient();
  failingRecentRedis.lpush = async () => {
    throw new Error("Transient Redis recent cache write failure");
  };
  DataBufferEngine.setRedisClientForTests(failingRecentRedis);

  await DataBufferEngine.pushAsync({
    clientId: "phase03_coalesce",
    eventId: "coal-1",
    timestamp: "2026-11-18T10:00:00.000Z",
    payload: JSON.stringify({ step: 1 }),
  });

  // rpush succeeded, so local RAM buffer MUST stay empty despite recent cache throw
  const statsAfterPush = await DataBufferEngine.getBufferStatsAsync();
  assert.equal(statsAfterPush.redisBufferSize, 1);
  assert.equal(statsAfterPush.localBufferSize, 0);

  // Coalesce concurrent in-process flushes while appendBatch is in flight
  DataBufferEngine.setRedisClientForTests(null);
  await DataBufferEngine.pushAsync({
    clientId: "phase03_coalesce",
    eventId: "coal-2",
    timestamp: "2026-11-18T10:00:01.000Z",
    payload: JSON.stringify({ step: 2 }),
  });

  const origAppend = CSVStorageManager.appendBatch.bind(CSVStorageManager);
  let releaseGate!: () => void;
  const gatePromise = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let firstEnterGate!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    firstEnterGate = resolve;
  });

  CSVStorageManager.appendBatch = async (evts: DataEvent[]) => {
    firstEnterGate();
    await gatePromise;
    return origAppend(evts);
  };

  try {
    const flushA = DataBufferEngine.flush();
    await enteredPromise;
    const flushB = DataBufferEngine.flush();
    releaseGate();
    const [resA, resB] = await Promise.all([flushA, flushB]);
    assert.equal(resA.count, 1);
    assert.equal(resB.count, 1, "Second concurrent caller must await active flush instead of returning 0");
  } finally {
    CSVStorageManager.appendBatch = origAppend;
  }

  // Partition lock ownership: a new lock file written after initial acquisition must not be unlinked by foreign content
  const partDir = CSVStorageManager.ensureClientDir("phase03_lock_owner");
  const lockPath = path.join(partDir, ".2026-11-18.csv.lock");
  let insideLockChecked = false;
  await CSVStorageManager.withPartitionLock("phase03_lock_owner", "2026-11-18", async () => {
    const ownToken = fs.readFileSync(lockPath, "utf8");
    assert.match(ownToken, /^\d+:\d+:/);
    // Simulate stale takeover replacing lock file with another owner's token
    fs.writeFileSync(lockPath, "other:999:foreign-uuid", "utf8");
    insideLockChecked = true;
  });
  assert.equal(insideLockChecked, true);
  assert.equal(fs.existsSync(lockPath), true, "Original holder must NOT unlink a lock now owned by another token");
  fs.unlinkSync(lockPath);
});

test("BUG-C03 & BUG-C04: Safe newline appends, size rotation overflow, and locked partition pruning with empty directory cleanup", async () => {
  const origMax = CSVStorageManager.maxFileSizeBytes;
  CSVStorageManager.maxFileSizeBytes = 220;

  try {
    // Seed existing partition ending cleanly with trailing newline
    const clientDir = CSVStorageManager.ensureClientDir("phase03_rotate");
    const firstFile = path.join(clientDir, "2026-11-18.csv");
    fs.writeFileSync(
      firstFile,
      '"clientId","eventId","timestamp","payload"\n"phase03_rotate","seed-1","2026-11-18T00:00:00.000Z","{}"\n',
      "utf8",
    );

    // Append batch that stays or overflows limit safely without blank lines
    await CSVStorageManager.appendBatch([
      {
        clientId: "phase03_rotate",
        eventId: "rot-small",
        timestamp: "2026-11-18T00:01:00.000Z",
        payload: JSON.stringify({ a: 1 }),
      },
      {
        clientId: "phase03_rotate",
        eventId: "rot-overflow-with-long-payload-padding-1234567890",
        timestamp: "2026-11-18T00:02:00.000Z",
        payload: JSON.stringify({ data: "x".repeat(160) }),
      },
    ]);

    const files = await CSVStorageManager.listAllFilesAsync();
    const clientFiles = files.filter((f) => f.clientId === "phase03_rotate");
    assert.ok(clientFiles.length >= 2, "Overflowing batch should rotate to -part2.csv");
    for (const f of clientFiles) {
      const lines = fs.readFileSync(f.filePath, "utf8").trimEnd().split("\n");
      assert.equal(lines.some((line) => line === ""), false, "CSV must never contain blank lines from double newline appends");
    }

    // Prune respects active partition lock and deletes unlocked expired partitions
    const lockedOldDir = CSVStorageManager.ensureClientDir("phase03_locked_old");
    fs.writeFileSync(path.join(lockedOldDir, "2020-01-01.csv"), '"h"\n"r"\n', "utf8");
    fs.writeFileSync(path.join(lockedOldDir, ".2020-01-01.csv.lock"), `1:${Date.now()}:active`, "utf8");

    const unlockedOldDir = CSVStorageManager.ensureClientDir("phase03_unlocked_old");
    const unlockedOldCsv = path.join(unlockedOldDir, "2020-01-01.csv");
    fs.writeFileSync(unlockedOldCsv, '"h"\n"r"\n', "utf8");

    const pruned = CSVStorageManager.pruneExpiredPartitions(30);
    assert.equal(pruned, 1, "Only the unlocked expired partition should be pruned");
    assert.equal(fs.existsSync(path.join(lockedOldDir, "2020-01-01.csv")), true);
    assert.equal(fs.existsSync(unlockedOldCsv), false, "Unlocked expired partition should be pruned");
  } finally {
    CSVStorageManager.maxFileSizeBytes = origMax;
  }
});

test("BUG-C05 & BUG-C06: Export honors ?format=json on ?filename=, aborts on corrupt CSV, and /api/data + /api/events sort mixed timestamps & normalize clientId", async () => {
  DataBufferEngine.setRedisClientForTests(null);

  await CSVStorageManager.appendBatch([
    {
      clientId: "phase03_mix",
      eventId: "evt-iso",
      timestamp: "2026-11-18T10:00:00.000Z",
      payload: JSON.stringify({ kind: "iso" }),
    },
    {
      clientId: "phase03_mix",
      eventId: "evt-epoch-newer",
      timestamp: String(Date.parse("2026-11-18T12:00:00.000Z")),
      payload: JSON.stringify({ kind: "epoch" }),
    },
  ]);

  // Normalized clientId query with surrounding spaces matches stored dir and orders epoch-ms newer first
  const dataRes = await getDataRoute(
    new NextRequest("http://localhost:3000/api/data?clientId=%20phase03_mix%20", {
      headers: { cookie: adminCookieHeader },
    }),
  );
  assert.equal(dataRes.status, 200);
  const dataJson = await dataRes.json();
  assert.equal(dataJson.total, 2);
  assert.equal(dataJson.events[0].eventId, "evt-epoch-newer");
  assert.equal(dataJson.events[1].eventId, "evt-iso");

  // GET /api/events orders epoch-ms newer first too
  const eventsRes = await getEventsRoute(
    new NextRequest("http://localhost:3000/api/events?clientId=%20phase03_mix%20&limit=5", {
      headers: { cookie: adminCookieHeader },
    }),
  );
  assert.equal(eventsRes.status, 200);
  const eventsJson = await eventsRes.json();
  assert.equal(eventsJson.events[0].eventId, "evt-epoch-newer");

  // Export ?filename=2026-11-18.csv&format=json returns valid JSON records
  const jsonFileExport = await getExportRoute(
    new NextRequest(
      "http://localhost:3000/api/export?clientId=phase03_mix&filename=2026-11-18.csv&format=json&flush=false",
      { headers: { cookie: adminCookieHeader } },
    ),
  );
  assert.equal(jsonFileExport.status, 200);
  assert.match(jsonFileExport.headers.get("content-type") || "", /application\/json/);
  const parsedExport = await jsonFileExport.json();
  assert.equal(parsedExport.length, 2);

  // Corrupt CSV aborts export stream rather than returning truncated OK JSON
  const corruptDir = CSVStorageManager.ensureClientDir("phase03_corrupt");
  fs.writeFileSync(
    path.join(corruptDir, "2026-11-18.csv"),
    '"clientId","eventId","timestamp","payload"\n"phase03_corrupt","c1","2026-11-18T00:00:00Z","unclosed quote',
    "utf8",
  );
  const corruptExportRes = await getExportRoute(
    new NextRequest(
      "http://localhost:3000/api/export?clientId=phase03_corrupt&format=json&flush=false",
      { headers: { cookie: adminCookieHeader } },
    ),
  );
  await assert.rejects(async () => corruptExportRes.text());
});

test("FORENSIC BUG-18: Redis flush lock waits and retries on contention, throws FLUSH_LOCK_TIMEOUT when requested, and renews TTL via Lua during long flushes", async () => {
  const fakeRedis = new FakeRedisClient();
  DataBufferEngine.setRedisClientForTests(fakeRedis);

  await DataBufferEngine.pushAsync({
    clientId: "phase03_lock",
    eventId: "lock-evt-1",
    timestamp: "2026-11-19T08:00:00.000Z",
    payload: JSON.stringify({ step: "wait-retry" }),
  });

  // 1. Lock held briefly (70ms) -> flush() waits and succeeds instead of silently returning 0
  await fakeRedis.set(REDIS_FLUSH_LOCK_KEY, "other-worker", "PX", 5000, "NX");
  const releaseTimer = setTimeout(() => {
    void fakeRedis.eval("del", 1, REDIS_FLUSH_LOCK_KEY, "other-worker");
  }, 70);
  try {
    const waitedFlush = await DataBufferEngine.flush({ waitMs: 500 });
    assert.equal(waitedFlush.count, 1);
    assert.equal(waitedFlush.lockTimedOut, undefined);
    assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 0);
  } finally {
    clearTimeout(releaseTimer);
  }

  // 2. Lock stays held past waitMs -> throwOnLockTimeout throws explicit FLUSH_LOCK_TIMEOUT
  await DataBufferEngine.pushAsync({
    clientId: "phase03_lock",
    eventId: "lock-evt-2",
    timestamp: "2026-11-19T08:01:00.000Z",
    payload: JSON.stringify({ step: "timeout" }),
  });
  await fakeRedis.set(REDIS_FLUSH_LOCK_KEY, "stuck-worker", "PX", 5000, "NX");
  await assert.rejects(
    () => DataBufferEngine.flush({ waitMs: 60, throwOnLockTimeout: true }),
    /FLUSH_LOCK_TIMEOUT/,
  );
  const nonThrowing = await DataBufferEngine.flush({ waitMs: 40 });
  assert.equal(nonThrowing.count, 0);
  assert.equal(nonThrowing.lockTimedOut, true);
  await fakeRedis.eval("del", 1, REDIS_FLUSH_LOCK_KEY, "stuck-worker");

  // 3. Long flush exceeding lockTtlMs (90ms) renews TTL via Lua pexpire and completes cleanly
  const originalAppend = CSVStorageManager.appendBatch;
  CSVStorageManager.appendBatch = async (events) => {
    await new Promise((resolve) => setTimeout(resolve, 140));
    return originalAppend.call(CSVStorageManager, events);
  };
  fakeRedis.renewCalls = 0;
  try {
    const longFlush = await DataBufferEngine.flush({ lockTtlMs: 90, waitMs: 200 });
    assert.equal(longFlush.count, 1);
    assert.ok(
      fakeRedis.renewCalls >= 1,
      `Expected Lua pexpire TTL renewal calls >= 1, got ${fakeRedis.renewCalls}`,
    );
    assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 0);
    assert.equal(fakeRedis.strings.has(REDIS_FLUSH_LOCK_KEY), false);
  } finally {
    CSVStorageManager.appendBatch = originalAppend;
  }

  // 4. Verify Port 4000 POST /internal/flush returns 503 FLUSH_LOCK_TIMEOUT when requested & renews TTL
  const serverMod = require("../server/index.js") as IngestionServerModule & {
    writer: { baseDir: string; writeBatch: (events: DataEvent[]) => Promise<{ written: number; files: string[] }> };
  };
  const { getInternalIngestionHeaders } = await import("../core/Security/security");
  const origWriterDir = serverMod.writer.baseDir;
  serverMod.writer.baseDir = tmpStorageDir;
  serverMod.setRedisClientForTests(fakeRedis);
  await new Promise<void>((resolve) => serverMod.server.listen(0, "127.0.0.1", () => resolve()));
  const addr = serverMod.server.address() as AddressInfo;

  try {
    await fakeRedis.set(REDIS_FLUSH_LOCK_KEY, "port4000-blocker", "PX", 5000, "NX");
    const timeoutRes = await fetch(`http://127.0.0.1:${addr.port}/internal/flush`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...getInternalIngestionHeaders(),
      },
      body: JSON.stringify({ waitMs: 50, throwOnLockTimeout: true }),
    });
    assert.equal(timeoutRes.status, 503);
    const timeoutJson = await timeoutRes.json();
    assert.equal(timeoutJson.code, "FLUSH_LOCK_TIMEOUT");
    await fakeRedis.eval("del", 1, REDIS_FLUSH_LOCK_KEY, "port4000-blocker");

    await DataBufferEngine.pushAsync({
      clientId: "phase03_lock",
      eventId: "lock-evt-p4000",
      timestamp: "2026-11-19T08:02:00.000Z",
      payload: JSON.stringify({ step: "p4000-renew" }),
    });
    const origWriteBatch = serverMod.writer.writeBatch.bind(serverMod.writer);
    serverMod.writer.writeBatch = async (events: DataEvent[]) => {
      await new Promise((resolve) => setTimeout(resolve, 140));
      return origWriteBatch(events);
    };
    fakeRedis.renewCalls = 0;
    try {
      const p4000Flush = await serverMod.flushBuffer({ lockTtlMs: 90, waitMs: 200 });
      assert.equal(p4000Flush.written, 1);
      assert.ok(
        fakeRedis.renewCalls >= 1,
        `Expected Port 4000 Lua pexpire TTL renewal calls >= 1, got ${fakeRedis.renewCalls}`,
      );
    } finally {
      serverMod.writer.writeBatch = origWriteBatch;
    }
  } finally {
    serverMod.writer.baseDir = origWriterDir;
    serverMod.setRedisClientForTests(undefined);
    serverMod.bufferQueue.length = 0;
    serverMod.stopTimers();
    await new Promise<void>((resolve) => serverMod.server.close(() => resolve()));
  }
});

test("FORENSIC BUG-19: Deleting a client purges RAM, Redis, and Port 4000 buffers so subsequent flushes never resurrect deleted CSV directories", async () => {
  const fakeRedis = new FakeRedisClient();
  DataBufferEngine.setRedisClientForTests(fakeRedis);

  const serverMod = require("../server/index.js") as IngestionServerModule;
  const origWriterDir = serverMod.writer.baseDir;
  serverMod.writer.baseDir = tmpStorageDir;
  serverMod.setRedisClientForTests(fakeRedis);
  await new Promise<void>((resolve) => serverMod.server.listen(0, "127.0.0.1", () => resolve()));
  const addr = serverMod.server.address() as AddressInfo;
  process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${addr.port}`;

  try {
    const victim = await SDKManager.registerClientAsync({
      clientId: "phase03_victim",
      name: "Victim Client",
      rateLimit: 100,
    });
    const survivor = await SDKManager.registerClientAsync({
      clientId: "phase03_survivor",
      name: "Survivor Client",
      rateLimit: 100,
    });

    // Write one initial CSV batch so victim dir exists on disk before delete
    await CSVStorageManager.appendBatch([
      {
        clientId: victim.clientId,
        eventId: "v-disk-1",
        timestamp: "2026-11-19T09:00:00.000Z",
        payload: JSON.stringify({ phase: "initial" }),
      },
    ]);
    const victimDir = path.join(tmpStorageDir, victim.clientId);
    assert.equal(fs.existsSync(victimDir), true);

    // Queue victim + survivor events across Redis, Port 3000 RAM, and Port 4000 local bufferQueue
    await DataBufferEngine.pushBatchAsync([
      {
        clientId: victim.clientId,
        eventId: "v-redis-1",
        timestamp: "2026-11-19T09:01:00.000Z",
        payload: JSON.stringify({ src: "redis" }),
      },
      {
        clientId: survivor.clientId,
        eventId: "s-redis-1",
        timestamp: "2026-11-19T09:01:01.000Z",
        payload: JSON.stringify({ src: "redis" }),
      },
    ]);
    g.__dataStackBufferState?.buffer.push({
      clientId: victim.clientId,
      eventId: "v-ram-1",
      timestamp: "2026-11-19T09:01:02.000Z",
      payload: JSON.stringify({ src: "ram" }),
    });
    serverMod.bufferQueue.push(
      {
        clientId: victim.clientId,
        eventId: "v-p4000-1",
        timestamp: "2026-11-19T09:01:03.000Z",
        payload: JSON.stringify({ src: "port4000" }),
      },
      {
        clientId: survivor.clientId,
        eventId: "s-p4000-1",
        timestamp: "2026-11-19T09:01:04.000Z",
        payload: JSON.stringify({ src: "port4000" }),
      },
    );

    // Delete victim with purgeFiles: true
    const deleted = await SDKManager.deleteClientAsync(victim.clientId, { purgeFiles: true });
    assert.equal(deleted, true);
    assert.equal(fs.existsSync(victimDir), false);

    // Recent events in Redis must also be stripped of victim
    const recentAfterDelete = await fakeRedis.lrange(REDIS_RECENT_KEY, 0, -1);
    assert.equal(
      recentAfterDelete.some((raw) => raw.includes("phase03_victim")),
      false,
    );

    // Flush both Port 3000 and Port 4000 buffers -> victim dir must NOT resurrect, survivor MUST flush
    const webFlush = await DataBufferEngine.flush();
    const workerFlush = await serverMod.flushBuffer();

    assert.equal(
      fs.existsSync(victimDir),
      false,
      "Deleted client directory must never be resurrected by queued buffer flushes",
    );
    assert.equal(webFlush.count + workerFlush.written, 2);
    const survivorFiles = CSVStorageManager.listAllFiles().filter(
      (f) => f.clientId === survivor.clientId,
    );
    assert.equal(survivorFiles.length, 1);
    assert.equal(survivorFiles[0].linesCount, 2);
  } finally {
    serverMod.writer.baseDir = origWriterDir;
    serverMod.setRedisClientForTests(undefined);
    serverMod.bufferQueue.length = 0;
    serverMod.stopTimers();
    await new Promise<void>((resolve) => serverMod.server.close(() => resolve()));
    delete process.env.INGESTION_INTERNAL_URL;
  }
});

test("FORENSIC BUG-20: Socket.IO sync_data and batch_sync ACKs wait until async Redis RPUSH completes", async () => {
  const fakeRedis = new FakeRedisClient();
  const rpushGateControl: { resolve?: () => void } = {};
  let rpushEnteredResolve: (() => void) | null = null;
  let rpushGate = new Promise<void>((resolve) => {
    rpushGateControl.resolve = resolve;
  });
  let rpushEntered = new Promise<void>((resolve) => {
    rpushEnteredResolve = resolve;
  });

  const baseRpush = fakeRedis.rpush.bind(fakeRedis);
  fakeRedis.rpush = async (key: string, ...values: string[]) => {
    if (key === REDIS_BUFFER_KEY) {
      rpushEnteredResolve?.();
      await rpushGate;
    }
    return baseRpush(key, ...values);
  };

  const serverMod = require("../server/index.js") as IngestionServerModule;
  const origWriterDir = serverMod.writer.baseDir;
  serverMod.writer.baseDir = tmpStorageDir;
  serverMod.setRedisClientForTests(fakeRedis);
  await new Promise<void>((resolve) => serverMod.server.listen(0, "127.0.0.1", () => resolve()));
  const addr = serverMod.server.address() as AddressInfo;
  process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${addr.port}`;

  const client = await SDKManager.registerClientAsync({
    clientId: "phase03_sock_ack",
    name: "Socket Ack Durability Client",
    rateLimit: 100,
  });

  const socket = ioClient(`http://127.0.0.1:${addr.port}`, {
    transports: ["websocket"],
    auth: { token: client.token },
    forceNew: true,
    reconnection: false,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (err) => reject(err));
    });

    // 1. sync_data must NOT ACK while rpush is still pending
    let syncAcked = false;
    const syncAckPromise = new Promise<{ success: boolean; eventId?: string }>((resolve) => {
      socket.emit(
        "sync_data",
        {
          eventId: "ack-durability-1",
          timestamp: "2026-11-19T10:00:00.000Z",
          data: { ok: true },
        },
        (ack: { success: boolean; eventId?: string }) => {
          syncAcked = true;
          resolve(ack);
        },
      );
    });

    await rpushEntered;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      syncAcked,
      false,
      "sync_data ACK must NOT fire before Redis RPUSH finishes",
    );

    rpushGateControl.resolve?.();
    const syncAck = await syncAckPromise;
    assert.equal(syncAck.success, true);
    assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 1);

    // 2. batch_sync must also wait for Redis RPUSH before ACK
    rpushGate = new Promise<void>((resolve) => {
      rpushGateControl.resolve = resolve;
    });
    rpushEntered = new Promise<void>((resolve) => {
      rpushEnteredResolve = resolve;
    });

    let batchAcked = false;
    const batchAckPromise = new Promise<{ success: boolean; processed?: number }>((resolve) => {
      socket.emit(
        "batch_sync",
        [
          {
            eventId: "ack-durability-b1",
            timestamp: "2026-11-19T10:00:01.000Z",
            data: { seq: 1 },
          },
          {
            eventId: "ack-durability-b2",
            timestamp: "2026-11-19T10:00:02.000Z",
            data: { seq: 2 },
          },
        ],
        (ack: { success: boolean; processed?: number }) => {
          batchAcked = true;
          resolve(ack);
        },
      );
    });

    await rpushEntered;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      batchAcked,
      false,
      "batch_sync ACK must NOT fire before Redis RPUSH finishes",
    );

    rpushGateControl.resolve?.();
    const batchAck = await batchAckPromise;
    assert.equal(batchAck.success, true);
    assert.equal(batchAck.processed, 2);
    assert.equal(await fakeRedis.llen(REDIS_BUFFER_KEY), 3);
  } finally {
    socket.disconnect();
    serverMod.writer.baseDir = origWriterDir;
    serverMod.setRedisClientForTests(undefined);
    serverMod.bufferQueue.length = 0;
    serverMod.stopTimers();
    await new Promise<void>((resolve) => serverMod.server.close(() => resolve()));
    delete process.env.INGESTION_INTERNAL_URL;
  }
});

test("FORENSIC BUG-29: DATASTACK_STORAGE_DIR resolves canonically across CSVStorageManager, CsvWriterWorker, and SDKManager.purgeClientStorageDir", async () => {
  const prevStorageEnv = process.env.DATASTACK_STORAGE_DIR;
  const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), "datastack-canonical-root-"));
  const prevBaseDir = CSVStorageManager.baseStorageDir;

  try {
    process.env.DATASTACK_STORAGE_DIR = customRoot;
    const webResolved = resolveWebStorageDir();
    const workerResolved = resolveWorkerStorageDir();
    assert.equal(webResolved, path.resolve(customRoot));
    assert.equal(workerResolved, path.resolve(customRoot));
    assert.equal(webResolved, workerResolved);

    const worker = new CsvWriterWorker();
    assert.equal(worker.baseDir, path.resolve(customRoot));

    CSVStorageManager.baseStorageDir = webResolved;
    const client = await SDKManager.registerClientAsync({
      clientId: "phase03_canonical",
      name: "Canonical Storage Client",
      rateLimit: 100,
    });
    await worker.writeBatch([
      {
        clientId: client.clientId,
        eventId: "canon-evt-1",
        timestamp: "2026-11-19T11:00:00.000Z",
        payload: JSON.stringify({ canonical: true }),
      },
    ]);

    const filesBefore = CSVStorageManager.listAllFiles().filter(
      (f) => f.clientId === client.clientId,
    );
    assert.equal(filesBefore.length, 1);
    assert.ok(filesBefore[0].filePath.startsWith(path.resolve(customRoot)));

    const deleted = await SDKManager.deleteClientAsync(client.clientId, { purgeFiles: true });
    assert.equal(deleted, true);
    assert.equal(fs.existsSync(path.join(customRoot, client.clientId)), false);
  } finally {
    CSVStorageManager.baseStorageDir = prevBaseDir;
    if (prevStorageEnv === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageEnv;
    fs.rmSync(customRoot, { recursive: true, force: true });
  }
});

test("R2 PHASE-02 BUG-06: purgeClientEventsAsync uses atomic Redis Lua EVAL instead of non-atomic LTRIM+LPUSH", async () => {
  const fakeRedis = new FakeRedisClient();
  DataBufferEngine.setRedisClientForTests(fakeRedis);

  try {
    await DataBufferEngine.pushBatchAsync([
      {
        clientId: "keep_alpha",
        eventId: "keep-1",
        timestamp: "2026-11-19T12:00:00.000Z",
        payload: JSON.stringify({ seq: 1 }),
      },
      {
        clientId: "delete_me",
        eventId: "del-1",
        timestamp: "2026-11-19T12:00:01.000Z",
        payload: JSON.stringify({ seq: 2 }),
      },
      {
        clientId: "keep_beta",
        eventId: "keep-2",
        timestamp: "2026-11-19T12:00:02.000Z",
        payload: JSON.stringify({ seq: 3 }),
      },
    ]);

    const ltrimBefore = fakeRedis.ltrimCalls;
    const lpushBefore = fakeRedis.lpushCalls;

    const purgeRes = await DataBufferEngine.purgeClientEventsAsync("delete_me");
    assert.equal(purgeRes.removedRedis, 1);
    assert.equal(
      fakeRedis.purgeEvalCalls,
      2,
      "Must purge both buffer & recent lists atomically via Lua EVAL",
    );
    assert.equal(
      fakeRedis.ltrimCalls,
      ltrimBefore,
      "Purge must NOT execute separate non-atomic LTRIM",
    );
    assert.equal(
      fakeRedis.lpushCalls,
      lpushBefore,
      "Purge must NOT execute separate non-atomic LPUSH",
    );

    const remaining = (await fakeRedis.lrange(REDIS_BUFFER_KEY, 0, -1)).map(
      (raw) => (JSON.parse(raw) as DataEvent).eventId,
    );
    assert.deepEqual(remaining, ["keep-1", "keep-2"]);
  } finally {
    DataBufferEngine.setRedisClientForTests(null);
  }
});

test("R2 PHASE-02 BUG-07: GET /api/export and POST /api/storage propagate local and remote FLUSH_LOCK_TIMEOUT as HTTP 503", async () => {
  const origFlush = DataBufferEngine.flush;
  const origIngestionUrl = process.env.INGESTION_INTERNAL_URL;

  try {
    // 1. Local DataBufferEngine.flush() throws FLUSH_LOCK_TIMEOUT -> both routes return 503 FLUSH_LOCK_TIMEOUT
    DataBufferEngine.flush = async (opts) => {
      assert.equal(opts?.throwOnLockTimeout, true);
      throw new Error("FLUSH_LOCK_TIMEOUT: Timed out waiting for distributed Redis flush lock");
    };

    const exportLocalTimeout = await getExportRoute(
      new NextRequest("http://localhost:3000/api/export?format=json", {
        headers: { cookie: adminCookieHeader },
      }),
    );
    assert.equal(exportLocalTimeout.status, 503);
    assert.equal((await exportLocalTimeout.json()).code, "FLUSH_LOCK_TIMEOUT");

    const storageLocalTimeout = await postStorageRoute(
      new NextRequest("http://localhost:3000/api/storage", {
        method: "POST",
        headers: { cookie: adminCookieHeader },
      }),
    );
    assert.equal(storageLocalTimeout.status, 503);
    assert.equal((await storageLocalTimeout.json()).code, "FLUSH_LOCK_TIMEOUT");

    // 2. Local flush succeeds, remote Port 4000 /internal/flush receives throwOnLockTimeout: true and returns 503
    DataBufferEngine.flush = async () => ({ count: 0, files: [] });
    const receivedBodies: Array<Record<string, unknown>> = [];
    const mockBridge = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          receivedBodies.push(JSON.parse(body || "{}"));
        } catch {
          receivedBodies.push({});
        }
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            code: "FLUSH_LOCK_TIMEOUT",
            error: "FLUSH_LOCK_TIMEOUT: Port 4000 lock busy",
          }),
        );
      });
    });

    await new Promise<void>((resolve) => mockBridge.listen(0, "127.0.0.1", () => resolve()));
    const { port } = mockBridge.address() as AddressInfo;
    process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${port}`;

    try {
      const exportRemoteTimeout = await getExportRoute(
        new NextRequest("http://localhost:3000/api/export?format=json", {
          headers: { cookie: adminCookieHeader },
        }),
      );
      assert.equal(exportRemoteTimeout.status, 503);
      assert.equal((await exportRemoteTimeout.json()).code, "FLUSH_LOCK_TIMEOUT");

      const storageRemoteTimeout = await postStorageRoute(
        new NextRequest("http://localhost:3000/api/storage", {
          method: "POST",
          headers: { cookie: adminCookieHeader },
        }),
      );
      assert.equal(storageRemoteTimeout.status, 503);
      assert.equal((await storageRemoteTimeout.json()).code, "FLUSH_LOCK_TIMEOUT");

      assert.equal(receivedBodies.length, 2);
      assert.equal(receivedBodies[0].throwOnLockTimeout, true);
      assert.equal(receivedBodies[1].throwOnLockTimeout, true);
    } finally {
      await new Promise<void>((resolve) => mockBridge.close(() => resolve()));
    }
  } finally {
    DataBufferEngine.flush = origFlush;
    if (origIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
    else process.env.INGESTION_INTERNAL_URL = origIngestionUrl;
  }
});

test("R2 PHASE-02 BUG-08: Port 3000 flushAndShutdownOnSignal flushes pending SDKManager activity deltas before exit", async () => {
  const origFlushActivity = SDKManager.flushPendingClientActivityAsync;
  let activityFlushCount = 0;

  SDKManager.flushPendingClientActivityAsync = async () => {
    activityFlushCount += 1;
    return 1;
  };

  try {
    DataBufferEngine.setRedisClientForTests(null);
    await DataBufferEngine.pushAsync({
      clientId: "phase02_shutdown_cli",
      eventId: "shutdown-evt-1",
      timestamp: "2026-11-19T12:30:00.000Z",
      payload: JSON.stringify({ shutdown: true }),
    });

    await DataBufferEngine.flushAndShutdownOnSignal();

    assert.equal(
      activityFlushCount,
      1,
      "flushAndShutdownOnSignal must flush coalesced SDKManager client activity deltas",
    );
    assert.equal(
      (await DataBufferEngine.getBufferStatsAsync()).localBufferSize,
      0,
      "flushAndShutdownOnSignal must also flush buffered CSV events",
    );
  } finally {
    SDKManager.flushPendingClientActivityAsync = origFlushActivity;
  }
});

test("R2 PHASE-03 BUG-13: GET /api/storage performs a single disk scan with client-scoped stats and async pruners remove expired unlocked files", async () => {
  await CSVStorageManager.appendBatch([
    {
      clientId: "alpha_store",
      eventId: "st-a1",
      timestamp: "2026-11-18T10:00:00.000Z",
      payload: JSON.stringify({ n: 1 }),
    },
    {
      clientId: "alpha_store",
      eventId: "st-a2",
      timestamp: "2026-11-19T10:00:00.000Z",
      payload: JSON.stringify({ n: 2 }),
    },
    {
      clientId: "beta_store",
      eventId: "st-b1",
      timestamp: "2026-11-19T11:00:00.000Z",
      payload: JSON.stringify({ n: 3 }),
    },
  ]);

  let listCalls = 0;
  const origListAsync = CSVStorageManager.listAllFilesAsync.bind(CSVStorageManager);
  CSVStorageManager.listAllFilesAsync = async () => {
    listCalls += 1;
    return origListAsync();
  };

  try {
    const scopedRes = await getStorageRoute(
      new NextRequest("http://localhost:3000/api/storage?clientId=ALPHA_STORE", {
        headers: { cookie: adminCookieHeader },
      }),
    );
    assert.equal(scopedRes.status, 200);
    assert.equal(listCalls, 1, "GET /api/storage must execute listAllFilesAsync strictly once");
    const scopedJson = await scopedRes.json();
    assert.equal(scopedJson.files.length, 2);
    assert.equal(scopedJson.stats.totalFiles, 2);
    assert.equal(scopedJson.stats.totalRows, 2);
    assert.equal(scopedJson.stats.uniqueClients, 1);
  } finally {
    CSVStorageManager.listAllFilesAsync = origListAsync;
  }

  // Non-blocking async pruning on CSVStorageManager (respects active lock)
  const lockedDir = CSVStorageManager.ensureClientDir("async_prune_locked");
  fs.writeFileSync(path.join(lockedDir, "2020-01-01.csv"), '"h"\n"r"\n', "utf8");
  fs.writeFileSync(path.join(lockedDir, ".2020-01-01.csv.lock"), `1:${Date.now()}:active`, "utf8");

  const unlockedDir = CSVStorageManager.ensureClientDir("async_prune_unlocked");
  fs.writeFileSync(path.join(unlockedDir, "2020-01-01.csv"), '"h"\n"r"\n', "utf8");

  const prunedWeb = await CSVStorageManager.pruneExpiredPartitionsAsync(30);
  assert.equal(prunedWeb, 1);
  assert.equal(fs.existsSync(path.join(unlockedDir, "2020-01-01.csv")), false);
  assert.equal(fs.existsSync(path.join(lockedDir, "2020-01-01.csv")), true);
  fs.unlinkSync(path.join(lockedDir, ".2020-01-01.csv.lock"));

  // Non-blocking async pruning on Port 4000 CsvWriterWorker
  const worker = new CsvWriterWorker(tmpStorageDir);
  const workerOldDir = CSVStorageManager.ensureClientDir("worker_async_prune");
  fs.writeFileSync(path.join(workerOldDir, "2019-06-01.csv"), '"h"\n"r"\n', "utf8");
  const prunedWorker = await worker.pruneExpiredPartitionsAsync(30);
  assert.equal(prunedWorker, 2, "Should prune both worker_async_prune and previously locked 2020-01-01 partition");
  assert.equal(fs.existsSync(path.join(workerOldDir, "2019-06-01.csv")), false);
});

test("R2 PHASE-03 BUG-15: GET /api/export rejects inverted date range with 400 and export/recent clientId filters are case-insensitive", async () => {
  await CSVStorageManager.appendBatch([
    {
      clientId: "case_client_01",
      eventId: "case-evt-1",
      timestamp: "2026-11-15T12:00:00.000Z",
      payload: JSON.stringify({ ok: true }),
    },
  ]);

  // 1. Inverted date range returns 400 INVALID_DATE_RANGE
  const badRangeRes = await getExportRoute(
    new NextRequest(
      "http://localhost:3000/api/export?from=2026-11-20&to=2026-11-10&flush=false",
      { headers: { cookie: adminCookieHeader } },
    ),
  );
  assert.equal(badRangeRes.status, 400);
  const badRangeJson = await badRangeRes.json();
  assert.equal(badRangeJson.code, "INVALID_DATE_RANGE");

  // 2. ApiEngine.getExportFiles & getExportFilesAsync match case-insensitively
  const syncMatched = ApiEngine.getExportFiles("CASE_CLIENT_01");
  assert.equal(syncMatched.length, 1);
  assert.equal(syncMatched[0].clientId, "case_client_01");

  const asyncMatched = await ApiEngine.getExportFilesAsync("  CASE_CLIENT_01  ");
  assert.equal(asyncMatched.length, 1);
  assert.equal(asyncMatched[0].clientId, "case_client_01");

  // 3. Port 4000 /internal/recent normalizes clientId filter case-insensitively
  const serverIndexSrc = fs.readFileSync(
    path.resolve(process.cwd(), "server/index.js"),
    "utf8",
  );
  assert.match(serverIndexSrc, /const filterClientId =\s*rawClientId && rawClientId !== 'all' \? normalizeClientId\(rawClientId\) : ''/);
});

