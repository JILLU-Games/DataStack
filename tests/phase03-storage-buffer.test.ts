import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { NextRequest } from "next/server";
import { GET as getDataRoute } from "../app/api/data/route";
import { GET as getEventsRoute } from "../app/api/events/route";
import { GET as getExportRoute } from "../app/api/export/route";
import { POST as postStorageRoute } from "../app/api/storage/route";
import { ApiEngine } from "../core/apiEngine/apiService";
import {
  DataBufferEngine,
  REDIS_BUFFER_KEY,
  REDIS_FLUSH_LOCK_KEY,
  type RedisBufferClient,
} from "../core/data/buffer";
import { SDKManager } from "../core/sdk/sdkManager";
import { CSVStorageManager, type DataEvent } from "../core/Storage/csvStorage";

const require = createRequire(import.meta.url);
const { CsvWriterWorker } = require("../server/workers/csvWriter") as {
  CsvWriterWorker: new (baseDir?: string, maxFileSize?: number) => {
    baseDir: string;
    writeBatch: (events: DataEvent[]) => Promise<{ written: number; files: string[] }>;
    pruneExpiredPartitions: (days: number) => number;
  };
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
  flushBuffer: () => Promise<{ written: number; files: string[] }>;
  setRedisClientForTests: (client: RedisBufferClient | null | undefined) => void;
  stopTimers: () => void;
}

class FakeRedisClient implements RedisBufferClient {
  public status = "ready";
  public lists = new Map<string, string[]>();
  public strings = new Map<string, { value: string; expiresAt: number }>();

  public async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) || [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  public async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) || [];
    for (const v of values) {
      list.unshift(v);
    }
    this.lists.set(key, list);
    return list.length;
  }

  public async ltrim(key: string, start: number, stop: number): Promise<"OK"> {
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

  public async eval(_script: string, _numKeys: number, key: string, token: string): Promise<number> {
    const existing = this.strings.get(key);
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
    flushTimer: ReturnType<typeof setInterval> | null;
  };
  __dataStackAdminSettings?: unknown;
  __dataStackClientsMap?: Map<string, unknown>;
  __dataStackDeletedClients?: Set<string>;
};

let tmpStorageDir = "";
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

  tmpStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "datastack-phase03-"));
  CSVStorageManager.baseStorageDir = tmpStorageDir;
  CSVStorageManager.clearRowCountCache();
});

beforeEach(async () => {
  DataBufferEngine.setRedisClientForTests(undefined);
  if (g.__dataStackBufferState) {
    g.__dataStackBufferState.buffer = [];
    g.__dataStackBufferState.recentEvents = [];
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
    const errRes = await postStorageRoute(new NextRequest("http://localhost:3000/api/storage", { method: "POST" }));
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
  const standaloneRes = await postStorageRoute(new NextRequest("http://localhost:3000/api/storage", { method: "POST" }));
  assert.equal(standaloneRes.status, 200);
  const standaloneJson = await standaloneRes.json();
  assert.equal(standaloneJson.ingestionFlushed, false);
  assert.match(String(standaloneJson.warning || ""), /unreachable/i);
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
    new NextRequest("http://localhost:3000/api/data?search=unique-findme-id-99&from=2026-11-17&to=2026-11-17"),
  );
  assert.equal(dataByEvent.status, 200);
  const dataEventJson = await dataByEvent.json();
  assert.equal(dataEventJson.total, 1);
  assert.equal(dataEventJson.events[0].eventId, "unique-findme-id-99");

  // 2. Search by clientId substring
  const dataByClient = await getDataRoute(
    new NextRequest("http://localhost:3000/api/data?search=beta_cli"),
  );
  const dataClientJson = await dataByClient.json();
  assert.equal(dataClientJson.total, 1);
  assert.equal(dataClientJson.events[0].clientId, "beta_cli");

  // 3. Export with ?flush=false must NOT drain active buffer
  const noFlushRes = await getExportRoute(
    new NextRequest("http://localhost:3000/api/export?flush=false&format=json"),
  );
  assert.equal(noFlushRes.status, 200);
  assert.equal((await noFlushRes.text()).trim(), "[]");
  assert.equal((await DataBufferEngine.getBufferStatsAsync()).localBufferSize, 2);

  // 4. Default flush writes both 2026-11-17.csv files -> clientId=all + filename must 400 AMBIGUOUS_FILENAME
  const flushExportRes = await getExportRoute(
    new NextRequest("http://localhost:3000/api/export?format=json"),
  );
  assert.equal(flushExportRes.status, 200);
  const flushedPayload = await flushExportRes.json();
  assert.equal(flushedPayload.length, 2);

  const ambiguousRes = await getExportRoute(
    new NextRequest("http://localhost:3000/api/export?clientId=all&filename=2026-11-17.csv"),
  );
  assert.equal(ambiguousRes.status, 400);
  const ambiguousJson = await ambiguousRes.json();
  assert.equal(ambiguousJson.code, "AMBIGUOUS_FILENAME");

  // Disambiguated download with explicit clientId succeeds cleanly
  const specificRes = await getExportRoute(
    new NextRequest("http://localhost:3000/api/export?clientId=alpha_cli&filename=2026-11-17.csv"),
  );
  assert.equal(specificRes.status, 200);
  const csvBody = await specificRes.text();
  assert.match(csvBody, /unique-findme-id-99/);

  // 5. GET /api/events with limit=1 returns latest single stored event cleanly
  const eventsRes = await getEventsRoute(
    new NextRequest("http://localhost:3000/api/events?clientId=alpha_cli&limit=1"),
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
    new NextRequest(`http://localhost:3000/api/data?search=corrupt-ts-event&from=${today}&to=${today}`),
  );
  assert.equal(dateRangeRes.status, 200);
  const dateRangeJson = await dateRangeRes.json();
  assert.equal(dateRangeJson.total, 0, "Corrupt timestamp must NOT match date range");

  // But without from/to date filters, corrupt event is still visible for admin inspection
  const allDataRes = await getDataRoute(
    new NextRequest("http://localhost:3000/api/data?search=corrupt-ts-event"),
  );
  assert.equal(allDataRes.status, 200);
  const allDataJson = await allDataRes.json();
  assert.equal(allDataJson.total, 1, "Corrupt timestamp event must be discoverable in unfiltered search");
});
