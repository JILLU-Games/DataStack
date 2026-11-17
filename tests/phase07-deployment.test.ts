import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { NextRequest } from "next/server";
import { GET as getHealthRoute } from "../app/api/health/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import { DataBufferEngine, type RedisBufferClient } from "../core/data/buffer";

const g = globalThis as typeof globalThis & {
  __dataStackAdminSettings?: unknown;
  __dataStackSettingsHydrated?: boolean;
  __dataStackCorePool?: unknown;
  __dataStackBufferState?: {
    buffer: unknown[];
    flushTimer: ReturnType<typeof setInterval> | null;
  };
};

const prevDbUrl = process.env.DATABASE_URL;
const prevRedisUrl = process.env.REDIS_URL;

after(async () => {
  DataBufferEngine.setRedisClientForTests(undefined);
  await DataBufferEngine.shutdown();

  if (g.__dataStackBufferState?.flushTimer) {
    clearInterval(g.__dataStackBufferState.flushTimer);
    g.__dataStackBufferState.flushTimer = null;
  }

  delete g.__dataStackAdminSettings;
  delete g.__dataStackSettingsHydrated;
  delete g.__dataStackCorePool;

  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;

  if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = prevRedisUrl;

  const testDirs = [
    resolve(process.cwd(), "storage", "data", "phase07_prune_guard"),
    resolve(process.cwd(), "storage", "data", "phase07_shutdown_flush"),
  ];
  for (const dir of testDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("DEPLOY-BLK-01 & 02 & 06: docker-compose.yml persists Redis AOF, configures internal bridge secret, and probes /api/health", () => {
  const compose = readFileSync(resolve(process.cwd(), "docker", "docker-compose.yml"), "utf8");

  assert.match(compose, /command:\s*\["redis-server",\s*"--appendonly",\s*"yes"\]/);
  assert.match(compose, /-\s*redisdata:\/data/);
  assert.match(compose, /^volumes:\r?\n\s+datastack-data:\r?\n\s+pgdata:\r?\n\s+redisdata:/m);

  const internalSecretMatches = compose.match(/^\s+DATASTACK_INTERNAL_SECRET:/gm) ?? [];
  assert.equal(
    internalSecretMatches.length,
    2,
    "Both web and ingestion services must define DATASTACK_INTERNAL_SECRET",
  );

  assert.match(compose, /http:\/\/127\.0\.0\.1:3000\/api\/health/);
  assert.match(compose, /http:\/\/127\.0\.0\.1\/api\/health/);
});

test("DEPLOY-BLK-03 & 05: Dockerfiles guard recursive chown on /app/storage/data and package-lock.json exists for deterministic npm ci", () => {
  const webDockerfile = readFileSync(resolve(process.cwd(), "docker", "Dockerfile.web"), "utf8");
  const serverDockerfile = readFileSync(resolve(process.cwd(), "docker", "Dockerfile.server"), "utf8");

  for (const df of [webDockerfile, serverDockerfile]) {
    assert.equal(df.includes('NODE_UG=\\"$(id -u node):$(id -g node)\\"'), true);
    assert.match(df, /stat -c '%u:%g' \/app\/storage\/data/);
  }

  const lockPath = resolve(process.cwd(), "package-lock.json");
  assert.equal(existsSync(lockPath), true, "package-lock.json must exist");
  const lockJson = JSON.parse(readFileSync(lockPath, "utf8")) as {
    lockfileVersion?: number;
    packages?: Record<string, unknown>;
  };
  assert.equal(lockJson.lockfileVersion, 3);
  assert.ok(lockJson.packages && Object.keys(lockJson.packages).length > 10);
});

test("DEPLOY-BLK-04: Both Nginx configs proxy = /health to socketio_upstream", () => {
  for (const relPath of ["docker/coolify-nginx.conf", "nginx/default.conf"]) {
    const conf = readFileSync(resolve(process.cwd(), relPath), "utf8");
    assert.match(
      conf,
      /location\s*=\s*\/health\s*\{[\s\S]*?proxy_pass\s+http:\/\/socketio_upstream;/,
      `${relPath} must route location = /health to socketio_upstream`,
    );
  }
});

test("DEPLOY-BLK-03 docs: manifest.md and README.md align volume mount path (/app/storage) and include sdk/python/datastack", () => {
  const manifest = readFileSync(resolve(process.cwd(), "docker", "manifest.md"), "utf8");
  const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");

  assert.match(manifest, /`datastack-data` volume at `\/app\/storage`/);
  assert.match(readme, /`datastack-data` Volume\*\*:\s*Mounted at `\/app\/storage`/);
  assert.match(readme, /sdk\/python\/datastack/);
});

test("DEPLOY-BLK-02 & 06 schema/hydration: DDL has additive ADD COLUMN IF NOT EXISTS guards and SDKManager hydrates DB settings", () => {
  const databaseTs = readFileSync(resolve(process.cwd(), "core", "Database", "database.ts"), "utf8");
  const serverJs = readFileSync(resolve(process.cwd(), "server", "index.js"), "utf8");
  const sdkManagerTs = readFileSync(resolve(process.cwd(), "core", "sdk", "sdkManager.ts"), "utf8");

  for (const src of [databaseTs, serverJs]) {
    assert.match(src, /ALTER TABLE client_sdks\s+ADD COLUMN IF NOT EXISTS/);
    assert.match(src, /ALTER TABLE admin_settings\s+ADD COLUMN IF NOT EXISTS/);
  }

  assert.match(sdkManagerTs, /await ensureDbSettingsHydrated\(\);/);
  assert.match(sdkManagerTs, /SettingsManager\.getSettingsAsync\(\)/);
});

test("DEPLOY-BLK-06 prune guard: SettingsManager skips default 30d auto-prune when DATABASE_URL is configured but unhydrated", async () => {
  const clientDir = resolve(process.cwd(), "storage", "data", "phase07_prune_guard");
  mkdirSync(clientDir, { recursive: true });
  const oldCsvPath = resolve(clientDir, "2020-01-01.csv");
  writeFileSync(oldCsvPath, "eventId,timestamp,payload\nold-1,2020-01-01T00:00:00Z,{}\n", "utf8");
  const ancient = new Date("2020-01-02T00:00:00Z");
  utimesSync(oldCsvPath, ancient, ancient);

  delete g.__dataStackAdminSettings;
  g.__dataStackSettingsHydrated = false;
  g.__dataStackCorePool = null;
  process.env.DATABASE_URL = "postgresql://datastack:invalid@127.0.0.1:1/datastack";

  const settings = await SettingsManager.getSettingsAsync();
  assert.equal(settings.autoPruneDays, 30);
  assert.equal(
    existsSync(oldCsvPath),
    true,
    "Historical CSV must NOT be pruned during transient unhydrated DB state",
  );
});

test("DEPLOY-BLK-06 shutdown & health: DataBufferEngine.flushAndShutdownOnSignal flushes RAM events and /api/health reports async buffer stats", async () => {
  delete process.env.DATABASE_URL;
  g.__dataStackCorePool = null;
  g.__dataStackSettingsHydrated = false;

  const clientId = "phase07_shutdown_flush";
  const evtId = `evt-p07-${Date.now()}`;
  DataBufferEngine.setRedisClientForTests(null);

  await DataBufferEngine.pushAsync({
    clientId,
    eventId: evtId,
    timestamp: new Date().toISOString(),
    payload: JSON.stringify({ phase: 7 }),
  });

  await DataBufferEngine.flushAndShutdownOnSignal();

  const clientDir = resolve(process.cwd(), "storage", "data", clientId);
  assert.equal(existsSync(clientDir), true, "Expected CSV directory after shutdown flush");

  const mockRedis: RedisBufferClient = {
    status: "ready",
    async rpush() {
      return 0;
    },
    async lpush() {
      return 0;
    },
    async ltrim() {
      return "OK";
    },
    async lrange() {
      return [];
    },
    async llen() {
      return 7;
    },
    async set() {
      return "OK";
    },
    async eval() {
      return 1;
    },
  };
  DataBufferEngine.setRedisClientForTests(mockRedis);

  const req = new NextRequest("http://localhost:3000/api/health");
  const res = await getHealthRoute(req);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { status: string; bufferSize: number };
  assert.equal(json.status, "online");
  assert.equal(json.bufferSize, 7);
});
