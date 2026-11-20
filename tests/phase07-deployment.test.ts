import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { NextRequest } from "next/server";
import { GET as getHealthRoute } from "../app/api/health/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import { DataBufferEngine, type RedisBufferClient } from "../core/data/buffer";

const require = createRequire(import.meta.url);

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
const prevDisableListen = process.env.DATASTACK_DISABLE_LISTEN;
process.env.DATASTACK_DISABLE_LISTEN = "1";

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

  if (prevDisableListen === undefined) delete process.env.DATASTACK_DISABLE_LISTEN;
  else process.env.DATASTACK_DISABLE_LISTEN = prevDisableListen;

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

test("DEPLOY-BLK-04: Both Nginx configs proxy = /health to ingestion upstream", () => {
  const defaultConf = readFileSync(resolve(process.cwd(), "nginx/default.conf"), "utf8");
  assert.match(
    defaultConf,
    /location\s*=\s*\/health\s*\{[\s\S]*?proxy_pass\s+http:\/\/socketio_upstream;/,
    "nginx/default.conf must route location = /health to socketio_upstream",
  );

  const coolifyConf = readFileSync(resolve(process.cwd(), "docker/coolify-nginx.conf"), "utf8");
  assert.match(
    coolifyConf,
    /location\s*=\s*\/health\s*\{[\s\S]*?proxy_pass\s+\$socketio_upstream;/,
    "docker/coolify-nginx.conf must route location = /health to $socketio_upstream",
  );
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

test("BUG-28: nginx/default.conf aligns Socket.IO directives and server/index.js enforces configurable DATASTACK_CORS_ORIGINS", () => {
  const nginxDefault = readFileSync(resolve(process.cwd(), "nginx", "default.conf"), "utf8");
  assert.match(
    nginxDefault,
    /location \/socket\.io\/ \{[\s\S]*proxy_read_timeout 86400s;[\s\S]*proxy_send_timeout 86400s;[\s\S]*proxy_buffering off;/,
    "nginx/default.conf must disable proxy_buffering and set 86400s read/send timeouts on /socket.io/",
  );

  const compose = readFileSync(resolve(process.cwd(), "docker", "docker-compose.yml"), "utf8");
  assert.match(compose, /DATASTACK_CORS_ORIGINS:\s*"\$\{DATASTACK_CORS_ORIGINS:-\}"/);

  const envExample = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
  assert.match(envExample, /DATASTACK_CORS_ORIGINS=/);

  const serverSrc = readFileSync(resolve(process.cwd(), "server", "index.js"), "utf8");
  assert.equal(
    serverSrc.includes("origin: '*'"),
    false,
    "server/index.js must not hardcode wildcard origin: '*'",
  );

  process.env.DATASTACK_DISABLE_LISTEN = "1";
  const ingestionServer = require("../server/index.js") as {
    isOriginAllowedByCors: (origin: string | undefined, raw?: string) => boolean;
    corsOriginDelegate: (
      origin: string | undefined,
      cb: (err: Error | null, allow: boolean) => void,
    ) => void;
    stopTimers: () => void;
  };

  try {
    // Default / empty / wildcard allows any origin
    assert.equal(ingestionServer.isOriginAllowedByCors("https://any.example.com", ""), true);
    assert.equal(ingestionServer.isOriginAllowedByCors("https://any.example.com", "*"), true);

    // Non-browser / SDK calls (no Origin header) remain allowed even with strict allowlist
    const strictList = "https://console.example.com, https://admin.example.com/";
    assert.equal(ingestionServer.isOriginAllowedByCors(undefined, strictList), true);
    assert.equal(ingestionServer.isOriginAllowedByCors("", strictList), true);

    // Allowed origins (with trailing slash normalization) pass
    assert.equal(ingestionServer.isOriginAllowedByCors("https://console.example.com", strictList), true);
    assert.equal(ingestionServer.isOriginAllowedByCors("https://console.example.com/", strictList), true);
    assert.equal(ingestionServer.isOriginAllowedByCors("https://admin.example.com", strictList), true);

    // Disallowed browser origins are rejected cleanly
    assert.equal(ingestionServer.isOriginAllowedByCors("https://evil.example.com", strictList), false);

    // Delegate callback respects live process.env.DATASTACK_CORS_ORIGINS without throwing
    const prevCors = process.env.DATASTACK_CORS_ORIGINS;
    try {
      process.env.DATASTACK_CORS_ORIGINS = "https://allowed.datastack.dev";
      let delegateErr: Error | null = null;
      let delegateAllowed = true;
      ingestionServer.corsOriginDelegate("https://blocked.datastack.dev", (err, allow) => {
        delegateErr = err;
        delegateAllowed = allow;
      });
      assert.equal(delegateErr, null);
      assert.equal(delegateAllowed, false);

      ingestionServer.corsOriginDelegate("https://allowed.datastack.dev", (err, allow) => {
        delegateErr = err;
        delegateAllowed = allow;
      });
      assert.equal(delegateErr, null);
      assert.equal(delegateAllowed, true);
    } finally {
      if (prevCors === undefined) delete process.env.DATASTACK_CORS_ORIGINS;
      else process.env.DATASTACK_CORS_ORIGINS = prevCors;
    }
  } finally {
    ingestionServer.stopTimers();
  }
});

test("R2 PHASE-04 BUG-16 & BUG-17: Nginx disables buffering on /api/export, next.config enforces ESLint during builds, and package.json prunes unused template deps", () => {
  const nginxDefault = readFileSync(resolve(process.cwd(), "nginx/default.conf"), "utf8");
  assert.match(
    nginxDefault,
    /location\s*=\s*\/api\/export\s*\{[\s\S]*?proxy_pass\s+http:\/\/nextjs_upstream;[\s\S]*?proxy_buffering\s+off;[\s\S]*?proxy_read_timeout\s+300s;/,
    "nginx/default.conf must disable proxy_buffering and extend proxy_read_timeout on location = /api/export",
  );

  const coolifyConf = readFileSync(resolve(process.cwd(), "docker/coolify-nginx.conf"), "utf8");
  assert.match(
    coolifyConf,
    /location\s*=\s*\/api\/export\s*\{[\s\S]*?proxy_pass\s+\$nextjs_upstream;[\s\S]*?proxy_buffering\s+off;[\s\S]*?proxy_read_timeout\s+300s;/,
    "docker/coolify-nginx.conf must disable proxy_buffering and extend proxy_read_timeout on location = /api/export",
  );

  const nextConfig = readFileSync(resolve(process.cwd(), "next.config.ts"), "utf8");
  assert.equal(
    /ignoreDuringBuilds\s*:\s*true/.test(nextConfig),
    false,
    "next.config.ts must not ignore ESLint errors during builds",
  );

  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(pkg.name, "datastack");
  assert.equal("@google/genai" in (pkg.dependencies ?? {}), false);
  assert.equal("firebase-tools" in (pkg.devDependencies ?? {}), false);
});

test("DEPLOY-BUG-01 & 05: coolify-nginx.conf resolves Docker DNS dynamically and Coolify docs align Base Directory /", () => {
  const coolifyConf = readFileSync(resolve(process.cwd(), "docker", "coolify-nginx.conf"), "utf8");
  assert.match(coolifyConf, /resolver\s+127\.0\.0\.11\s+valid=10s\s+ipv6=off;/);
  assert.match(coolifyConf, /set\s+\$nextjs_upstream\s+"http:\/\/web:3000";/);
  assert.match(coolifyConf, /set\s+\$socketio_upstream\s+"http:\/\/ingestion:4000";/);
  assert.equal(/\bupstream\s+\w+\s*\{/.test(coolifyConf), false, "coolify-nginx.conf must not define static upstream blocks");

  const compose = readFileSync(resolve(process.cwd(), "docker", "docker-compose.yml"), "utf8");
  const graceMatches = compose.match(/^\s+stop_grace_period:\s*20s/gm) ?? [];
  assert.equal(graceMatches.length, 2, "web and ingestion must set stop_grace_period: 20s");

  const installDoc = readFileSync(resolve(process.cwd(), "docs", "users", "installation.md"), "utf8");
  const readmeDoc = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
  assert.match(installDoc, /\*\*Base Directory\*\*\s+to\s+`\/`/);
  assert.match(readmeDoc, /\*\*Base Directory\*\*\s+to\s+`\/`\s+and\s+\*\*Docker Compose Location\*\*\s+to\s+`\/docker\/docker-compose\.yml`/);
});

test("DEPLOY-BUG-02, 03 & 04: Port 4000 memoizes schema DDLs, hydrates rotated JWT before listening, and drains buffers gracefully", async () => {
  const serverSrc = readFileSync(resolve(process.cwd(), "server", "index.js"), "utf8");
  assert.match(
    serverSrc,
    /async function startIngestionServer\(\)[\s\S]*syncSettingsFromDatabase\(\)[\s\S]*server\.listen\(PORT/,
    "startIngestionServer must await bounded syncSettingsFromDatabase() before server.listen(PORT)",
  );
  assert.match(
    serverSrc,
    /async function gracefulShutdown\([\s\S]*await closeServerGracefully\(\);[\s\S]*Promise\.allSettled\(\[flushBuffer\(\),\s*flushPendingClientActivity\(\)\]\)/,
    "gracefulShutdown must close HTTP/Socket.IO ingress before flushing buffers",
  );

  process.env.DATASTACK_DISABLE_LISTEN = "1";
  const ingestionServer = require("../server/index.js") as {
    runtimeConfig: { jwtSecret: string };
    bufferQueue: Array<{ clientId: string; eventId: string; timestamp: string; payload: string }>;
    setDbPoolForTests: (pool: unknown) => void;
    setRedisClientForTests: (client: unknown) => void;
    ensureDatabaseSchema: () => Promise<boolean>;
    syncSettingsFromDatabase: () => Promise<boolean>;
    gracefulShutdown: (signal: string, options?: { exit?: boolean }) => Promise<void>;
    stopTimers: () => void;
  };

  const prevJwt = ingestionServer.runtimeConfig.jwtSecret;
  let ddlCount = 0;
  let selectCount = 0;
  let failDdl = true;
  let poolEnded = false;
  const rotatedSecret = "rotated-production-jwt-secret-value-over-32-chars";

  const mockPool = {
    async query(sql: string) {
      const normalized = sql.trim().toUpperCase();
      if (normalized.startsWith("CREATE TABLE") || normalized.startsWith("ALTER TABLE")) {
        ddlCount += 1;
        if (failDdl) {
          throw new Error("transient startup PG failure");
        }
        return { rowCount: 0, rows: [] };
      }
      if (normalized.includes("FROM ADMIN_SETTINGS")) {
        selectCount += 1;
        return {
          rowCount: 1,
          rows: [
            {
              max_events_per_sec: 250,
              max_payload_size_kb: 128,
              batch_flush_threshold: 100,
              batch_flush_interval_ms: 2000,
              file_rotation_mb: 50,
              enable_idempotency: true,
              auto_prune_days: 45,
              jwt_secret: rotatedSecret,
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    async end() {
      poolEnded = true;
    },
  };

  let redisQuitCalled = false;
  const mockRedis = {
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
      return 0;
    },
    async set() {
      return "OK";
    },
    async eval() {
      return 1;
    },
    async sismember() {
      return 0;
    },
    async quit() {
      redisQuitCalled = true;
      return "OK";
    },
  };

  try {
    ingestionServer.setDbPoolForTests(mockPool);
    // 1. Transient DDL error must return false and allow retry
    const failedSync = await ingestionServer.syncSettingsFromDatabase();
    assert.equal(failedSync, false);
    assert.equal(ddlCount, 1);

    // 2. Recovery runs 8 DDLs once and hydrates rotated jwt_secret; repeated calls do zero extra DDLs
    failDdl = false;
    ddlCount = 0;
    assert.equal(await ingestionServer.syncSettingsFromDatabase(), true);
    assert.equal(ddlCount, 8);
    assert.equal(selectCount, 1);
    assert.equal(ingestionServer.runtimeConfig.jwtSecret, rotatedSecret);

    assert.equal(await ingestionServer.syncSettingsFromDatabase(), true);
    assert.equal(await ingestionServer.syncSettingsFromDatabase(), true);
    assert.equal(ddlCount, 8, "Repeated 3s sync ticks must NOT re-run CREATE/ALTER DDL statements");
    assert.equal(selectCount, 3);

    // 3. Graceful shutdown flushes buffered events, quits Redis, and closes PostgreSQL pool cleanly
    ingestionServer.setRedisClientForTests(mockRedis);
    ingestionServer.bufferQueue.push({
      clientId: "phase07_shutdown_flush",
      eventId: `evt-graceful-${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: JSON.stringify({ ok: true }),
    });
    await ingestionServer.gracefulShutdown("SIGTERM", { exit: false });
    assert.equal(ingestionServer.bufferQueue.length, 0, "gracefulShutdown must drain RAM queue to CSV");
    assert.equal(redisQuitCalled, true, "gracefulShutdown must invoke redis.quit()");
    assert.equal(poolEnded, true, "gracefulShutdown must close PostgreSQL pool");
  } finally {
    ingestionServer.runtimeConfig.jwtSecret = prevJwt;
    ingestionServer.setDbPoolForTests(null);
    ingestionServer.setRedisClientForTests(undefined);
    ingestionServer.stopTimers();
  }
});

test("V2-Deploy-Fix-01 (DEPLOY-V2-BUG-01, 02 & 03): middleware permits GET /api/prometheus Bearer scrapes, Port 4000 blocks unhydrated DB pruning, and prisma/schema.prisma mirrors all 7 V2 tables", async () => {
  // 1. DEPLOY-V2-BUG-01: middleware.ts allows GET /api/prometheus without a browser cookie so route handler can verify Bearer token
  const { middleware } = await import("../middleware");
  const { NextRequest } = await import("next/server");

  const promReq = new NextRequest("http://localhost:3000/api/prometheus", {
    method: "GET",
    headers: {
      authorization: "Bearer prom_scrape_token_123",
    },
  });
  const promMwRes = await middleware(promReq);
  assert.notEqual(
    promMwRes.status,
    401,
    "middleware.ts must not block GET /api/prometheus with 401 before route handler verifies Bearer token",
  );
  assert.equal(promMwRes.headers.get("x-middleware-next"), "1");

  // Meanwhile, protected admin APIs like GET /api/metrics still require admin session cookie in middleware
  const prevSecret = process.env.DATASTACK_ADMIN_SESSION_SECRET;
  process.env.DATASTACK_ADMIN_SESSION_SECRET =
    "test-session-secret-32-characters-minimum-length";
  try {
    const metricsReq = new NextRequest("http://localhost:3000/api/metrics", {
      method: "GET",
    });
    const metricsMwRes = await middleware(metricsReq);
    assert.equal(metricsMwRes.status, 401);
  } finally {
    if (prevSecret === undefined) {
      delete process.env.DATASTACK_ADMIN_SESSION_SECRET;
    } else {
      process.env.DATASTACK_ADMIN_SESSION_SECRET = prevSecret;
    }
  }

  // 2. DEPLOY-V2-BUG-02: Port 4000 isDbReadyForMaintenance() is false when dbPool is configured but unhydrated
  const prevDisableListen = process.env.DATASTACK_DISABLE_LISTEN;
  process.env.DATASTACK_DISABLE_LISTEN = "1";
  const ingestionServer = require("../server/index.js") as {
    setDbPoolForTests: (pool: unknown) => void;
    isDbReadyForMaintenance: () => boolean;
    syncSettingsFromDatabase: () => Promise<boolean>;
    stopTimers: () => void;
  };
  if (prevDisableListen === undefined) {
    delete process.env.DATASTACK_DISABLE_LISTEN;
  } else {
    process.env.DATASTACK_DISABLE_LISTEN = prevDisableListen;
  }

  try {
    // Without dbPool (in-memory mode), maintenance is ready immediately
    ingestionServer.setDbPoolForTests(null);
    assert.equal(ingestionServer.isDbReadyForMaintenance(), true);

    // With dbPool attached but before hydration succeeds, maintenance is blocked
    let shouldFailDb = true;
    const fakePool = {
      async query(sql: string) {
        if (shouldFailDb) {
          throw new Error("DB starting up");
        }
        if (/SELECT\s+max_events_per_sec/i.test(sql)) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    ingestionServer.setDbPoolForTests(fakePool);
    assert.equal(
      ingestionServer.isDbReadyForMaintenance(),
      false,
      "Port 4000 must block background pruning while DATABASE_URL pool is unhydrated",
    );
    assert.equal(await ingestionServer.syncSettingsFromDatabase(), false);
    assert.equal(ingestionServer.isDbReadyForMaintenance(), false);

    // Once DB hydrates, maintenance becomes ready
    shouldFailDb = false;
    assert.equal(await ingestionServer.syncSettingsFromDatabase(), true);
    assert.equal(ingestionServer.isDbReadyForMaintenance(), true);
  } finally {
    ingestionServer.setDbPoolForTests(null);
    ingestionServer.stopTimers();
  }

  // 3. DEPLOY-V2-BUG-03: prisma/schema.prisma mirrors all 7 V2 tables and V2 columns
  const prismaSrc = readFileSync(
    resolve(process.cwd(), "prisma/schema.prisma"),
    "utf8",
  );
  for (const table of [
    "client_sdks",
    "admin_settings",
    "deleted_clients",
    "admin_users",
    "admin_login_attempts",
    "admin_team_members",
    "admin_audit_logs",
  ]) {
    assert.match(
      prismaSrc,
      new RegExp(`@@map\\("${table}"\\)`),
      `prisma/schema.prisma must map ${table}`,
    );
  }
  for (const col of [
    "storage_quota_mb",
    "allowed_ips",
    "expires_at",
    "compress_after_days",
    "enable_s3_backup",
    "s3_secret_access_key_enc",
    "disk_pause_threshold_pct",
    "enable_webhook_alerts",
    "webhook_secret_enc",
    "enable_prometheus_metrics",
    "prometheus_metrics_token_enc",
  ]) {
    assert.match(
      prismaSrc,
      new RegExp(`@map\\("${col}"\\)`),
      `prisma/schema.prisma must map V2 column ${col}`,
    );
  }
});

