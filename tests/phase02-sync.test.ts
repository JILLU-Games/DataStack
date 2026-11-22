import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import { io as ioClient, type Socket } from "socket.io-client";
import {
  DELETE as deleteClientRoute,
  GET as getClientRoute,
  PATCH as patchClientRoute,
} from "../app/api/clients/[id]/route";
import { POST as postEventsRoute } from "../app/api/events/route";
import { GET as getSettingsRoute, POST as postSettingsRoute } from "../app/api/settings/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import { AuthService } from "../core/auth/jwt";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  createInitialAdmin,
  isAdminDatabaseConfigured,
  resetAdminStateForTests,
} from "../core/auth/adminUsers";
import { ApiEngine } from "../core/apiEngine/apiService";
import { DataBufferEngine, type RedisBufferClient } from "../core/data/buffer";
import { DatabaseEngine } from "../core/Database/database";
import { SDKManager } from "../core/sdk/sdkManager";
import {
  SecurityEngine,
  getInternalIngestionHeaders,
} from "../core/Security/security";

const require = createRequire(import.meta.url);

interface IngestionServerModule {
  server: import("node:http").Server;
  io: import("socket.io").Server;
  bufferQueue: Array<{ clientId: string; eventId: string; timestamp: string; payload: string }>;
  runtimeConfig: {
    jwtSecret: string;
    maxEventsPerSec: number;
    maxPayloadSizeBytes: number;
    batchFlushThreshold: number;
    batchFlushIntervalMs: number;
    fileRotationMb: number;
    enableIdempotency: boolean;
    autoPruneDays: number;
  };
  verifyClientInDb: (
    clientId: string,
    token: string,
    bypass?: boolean,
  ) => Promise<{ allowed: boolean; reason?: string; rateLimit?: number }>;
  recordClientActivity: (clientId: string, count?: number) => void;
  flushPendingClientActivity: () => Promise<number>;
  setRedisClientForTests: (client: unknown) => void;
  setDbPoolForTests: (pool: unknown) => void;
  stopTimers: () => void;
}

const g = globalThis as typeof globalThis & {
  __dataStackBufferState?: {
    flushTimer: ReturnType<typeof setInterval> | null;
  };
  __dataStackAdminSettings?: unknown;
  __dataStackClientsMap?: Map<string, unknown>;
  __dataStackDeletedClients?: Set<string>;
  __dataStackSyncedSocketEvents?: Map<string, number>;
  __dataStackPendingClientActivity?: Map<string, unknown>;
  __dataStackCorePool?: unknown;
  __dataStackCoreSchema?: Promise<void>;
};

let serverMod: IngestionServerModule;
let ingestionUrl = "";
const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;
const prevDisableListen = process.env.DATASTACK_DISABLE_LISTEN;
const prevDbUrl = process.env.DATABASE_URL;
const prevInternalSecret = process.env.DATASTACK_INTERNAL_SECRET;
const openSockets: Socket[] = [];

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = ioClient(ingestionUrl, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 3000,
    });
    openSockets.push(client);
    const onConnect = () => {
      cleanup();
      resolve(client);
    };
    const onError = (err: Error) => {
      cleanup();
      client.disconnect();
      reject(err);
    };
    function cleanup() {
      client.off("connect", onConnect);
      client.off("connect_error", onError);
    }
    client.on("connect", onConnect);
    client.on("connect_error", onError);
  });
}

function emitWithAck<T = unknown>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (err: unknown, res: T) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

async function createAdminCookieHeader(): Promise<string> {
  resetAdminStateForTests();
  await createInitialAdmin("admin@datastack.dev", "InitialAdminPass123!");
  const secret = getAdminSessionSecret();
  assert.ok(secret, "Expected admin session secret in test environment");
  const token = await createAdminSessionToken(
    "admin@datastack.dev",
    secret,
    Date.now() + 3600_000,
    1,
  );
  return `datastack_admin_session=${token}`;
}

before(async () => {
  process.env.DATASTACK_DISABLE_LISTEN = "1";
  delete process.env.DATABASE_URL;
  delete process.env.DATASTACK_INTERNAL_SECRET;
  delete g.__dataStackAdminSettings;
  g.__dataStackClientsMap?.clear();
  g.__dataStackDeletedClients?.clear();
  g.__dataStackSyncedSocketEvents?.clear();
  resetAdminStateForTests();

  serverMod = require("../server/index.js") as IngestionServerModule;
  await new Promise<void>((resolve) => {
    serverMod.server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = serverMod.server.address() as AddressInfo;
  ingestionUrl = `http://127.0.0.1:${addr.port}`;
  process.env.INGESTION_INTERNAL_URL = ingestionUrl;
});

after(async () => {
  for (const sock of openSockets) {
    try {
      sock.disconnect();
    } catch {
      // ignore
    }
  }
  if (serverMod) {
    serverMod.stopTimers();
    await new Promise<void>((resolve) => {
      serverMod.io.close(() => {
        serverMod.server.close(() => resolve());
      });
    });
  }
  if (g.__dataStackBufferState?.flushTimer) {
    clearInterval(g.__dataStackBufferState.flushTimer);
    g.__dataStackBufferState.flushTimer = null;
  }
  SDKManager.stopActivityFlushTimerForTests();

  if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
  else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;

  if (prevDisableListen === undefined) delete process.env.DATASTACK_DISABLE_LISTEN;
  else process.env.DATASTACK_DISABLE_LISTEN = prevDisableListen;

  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;

  if (prevInternalSecret === undefined) delete process.env.DATASTACK_INTERNAL_SECRET;
  else process.env.DATASTACK_INTERNAL_SECRET = prevInternalSecret;
});

test("BUG-13: Port 4000 /internal/* rejects unauthenticated callers and accepts valid internal secret while /health remains public", async () => {
  const healthRes = await fetch(`${ingestionUrl}/health`);
  assert.equal(healthRes.status, 200);

  for (const [method, path, body] of [
    ["GET", "/internal/metrics", undefined],
    ["POST", "/internal/flush", {}],
    ["GET", "/internal/recent", undefined],
    ["POST", "/internal/client-sync", { clientId: "x", action: "registered" }],
    ["POST", "/internal/settings-sync", { maxEventsPerSec: 120 }],
    ["POST", "/internal/security-check", { clientId: "x", eventId: "auth_chk_1", payloadBytes: 12 }],
  ] as const) {
    const noAuth = await fetch(`${ingestionUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(noAuth.status, 401, `${method} ${path} must reject missing secret`);

    const wrongAuth = await fetch(`${ingestionUrl}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        "x-datastack-internal-secret": "wrong-secret-value",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(wrongAuth.status, 401, `${method} ${path} must reject wrong secret`);

    const validAuth = await fetch(`${ingestionUrl}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...getInternalIngestionHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(validAuth.status, 200, `${method} ${path} must accept valid internal secret`);
  }
});

test("BUG-06: POST /api/settings validates allowlisted bounds, syncs Port 4000 immediately, preserves autoPruneDays=0, and disconnects sockets on JWT rotation", async () => {
  const unauthGet = await getSettingsRoute(new NextRequest("http://localhost:3000/api/settings"));
  assert.equal(unauthGet.status, 401);

  const cookieHeader = await createAdminCookieHeader();

  const badJsonReq = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: "{bad-json",
  });
  const badJsonRes = await postSettingsRoute(badJsonReq);
  assert.equal(badJsonRes.status, 400);

  const unsupportedReq = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ serverPort: 9999 }),
  });
  assert.equal((await postSettingsRoute(unsupportedReq)).status, 400);

  const weakSecretReq = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ jwtSecret: "too-short" }),
  });
  assert.equal((await postSettingsRoute(weakSecretReq)).status, 400);

  const validUpdateReq = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({
      maxEventsPerSec: 42,
      autoPruneDays: 0,
      enableIdempotency: true,
    }),
  });
  const validUpdateRes = await postSettingsRoute(validUpdateReq);
  assert.equal(validUpdateRes.status, 200);
  const updatedJson = await validUpdateRes.json();
  assert.equal(updatedJson.settings.maxEventsPerSec, 42);
  assert.equal(updatedJson.settings.autoPruneDays, 0);
  assert.equal(serverMod.runtimeConfig.maxEventsPerSec, 42);
  assert.equal(serverMod.runtimeConfig.autoPruneDays, 0);

  // Register client & open WebSocket before JWT rotation
  const client = await SDKManager.registerClientAsync({
    clientId: "phase02_jwt_rot",
    name: "Phase02 Rotation",
    rateLimit: 50,
  });
  const oldToken = client.token;
  const socket = await connectSocket(oldToken);
  assert.equal(socket.connected, true);

  const disconnectedPromise = new Promise<string>((resolve) => {
    socket.once("disconnect", (reason) => resolve(reason));
  });

  const newSecret = "phase02-rotated-production-secret-key-minimum-32-chars";
  const rotateReq = new NextRequest("http://localhost:3000/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ jwtSecret: newSecret }),
  });
  const rotateRes = await postSettingsRoute(rotateReq);
  assert.equal(rotateRes.status, 200);
  assert.equal(serverMod.runtimeConfig.jwtSecret, newSecret);

  const disconnectReason = await Promise.race([
    disconnectedPromise,
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("Expected socket disconnect on JWT rotation")), 2000),
    ),
  ]);
  assert.ok(disconnectReason.length > 0);

  // Old JWT token must fail handshake after rotation
  await assert.rejects(() => connectSocket(oldToken), /AUTH_INVALID|jwt|signature/i);

  // New resigned client token must succeed cleanly
  const refreshedClient = SDKManager.getClient("phase02_jwt_rot");
  assert.ok(refreshedClient && refreshedClient.token !== oldToken);
  const reconnected = await connectSocket(refreshedClient.token);
  assert.equal(reconnected.connected, true);
  reconnected.disconnect();
});

test("BUG-07: In-memory client registry, socket event counting, token rotation & revocation enforce cleanly on Port 4000", async () => {
  const client = await SDKManager.registerClientAsync({
    clientId: "phase02_mem_client",
    name: "Phase02 Memory Sync",
    rateLimit: 25,
  });

  const socket = await connectSocket(client.token);
  const ack = await emitWithAck<{ success: boolean; eventId: string }>(
    socket,
    "sync_data",
    { eventId: "evt-mem-1", data: { ok: true } },
  );
  assert.equal(ack.success, true);

  const listFirst = await SDKManager.listClientsAsync();
  const syncedFirst = listFirst.find((c) => c.clientId === "phase02_mem_client");
  assert.ok(syncedFirst);
  assert.equal(syncedFirst.totalEvents, 1);
  assert.ok(syncedFirst.lastActive);

  // Polling again must NOT double-count socket activity
  const listSecond = await SDKManager.listClientsAsync();
  const syncedSecond = listSecond.find((c) => c.clientId === "phase02_mem_client");
  assert.equal(syncedSecond?.totalEvents, 1);

  // Advance across JWT iat 1-second boundary before regenerating client token
  await new Promise((r) => setTimeout(r, 1100));

  // Regenerating client token must kick active socket and reject old token
  const rotatedClient = await SDKManager.regenerateTokenAsync("phase02_mem_client");
  assert.ok(rotatedClient && rotatedClient.token !== client.token);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(socket.connected, false);
  await assert.rejects(() => connectSocket(client.token), /TOKEN_ROTATED/);

  // New token works; revoking kicks and rejects
  const socket2 = await connectSocket(rotatedClient.token);
  assert.equal(socket2.connected, true);
  await SDKManager.updateClientAsync("phase02_mem_client", { status: "revoked" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(socket2.connected, false);
  await assert.rejects(() => connectSocket(rotatedClient.token), /CLIENT_REVOKED/);
});

test("BUG-08: Rate-limit error reports effectiveRateLimit and ApiEngine aggregates Port 3000 + Port 4000 security metrics", async () => {
  await SettingsManager.updateSettingsAsync({ maxEventsPerSec: 3, enableIdempotency: true });

  const rlClientId = "phase02_rl_msg";
  let lastError = "";
  for (let i = 0; i < 5; i += 1) {
    const res = SecurityEngine.validateEvent(rlClientId, `rl-evt-${i}`, { i }, 100);
    if (!res.allowed && res.code === "RATE_LIMIT_EXCEEDED") {
      lastError = res.reason || "";
      break;
    }
  }
  assert.match(lastError, /Rate limit of 3 events\/sec exceeded/);

  const client = await SDKManager.registerClientAsync({
    clientId: "phase02_stats_client",
    name: "Phase02 Stats Client",
    rateLimit: 50,
  });
  await new Promise((r) => setTimeout(r, 80));

  const socket = await connectSocket(client.token);
  await emitWithAck(socket, "sync_data", { eventId: "evt-stats-ws-1", data: { a: 1 } });
  socket.disconnect();

  const metrics = await ApiEngine.getDashboardMetrics();
  assert.ok(
    metrics.securityStats.activeIdempotencyKeys >= 2,
    `Expected aggregated idempotency keys >= 2 (HTTP + WS), got ${metrics.securityStats.activeIdempotencyKeys}`,
  );
  assert.ok(
    metrics.securityStats.rateLimitedClientsCount >= 2,
    `Expected aggregated rateLimitedClientsCount >= 2, got ${metrics.securityStats.rateLimitedClientsCount}`,
  );
});

function createSharedMockRedis(): RedisBufferClient {
  const kv = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();

  return {
    status: "ready",
    async get(key: string) {
      return kv.has(key) ? kv.get(key)! : null;
    },
    async incr(key: string) {
      const next = (Number(kv.get(key)) || 0) + 1;
      kv.set(key, String(next));
      return next;
    },
    async pexpire() {
      return 1;
    },
    async set(key: string, value: string, _px?: "PX", _ttlMs?: number, nxMode?: "NX") {
      if (nxMode === "NX" && kv.has(key)) return null;
      kv.set(key, value);
      return "OK";
    },
    async hget(key: string, field: string) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hset(key: string, field: string, value: string) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)!.set(field, value);
      return 1;
    },
    async hdel(key: string, ...fields: string[]) {
      let deleted = 0;
      const h = hashes.get(key);
      if (!h) return 0;
      for (const f of fields) {
        if (h.delete(f)) deleted += 1;
      }
      return deleted;
    },
    async sismember(key: string, member: string) {
      return sets.get(key)?.has(member) ? 1 : 0;
    },
    async sadd(key: string, ...members: string[]) {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const m of members) sets.get(key)!.add(m);
      return members.length;
    },
    async srem(key: string, ...members: string[]) {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) {
        if (s.delete(m)) removed += 1;
      }
      return removed;
    },
    async rpush(key: string, ...values: string[]) {
      const list = lists.get(key) ?? [];
      list.push(...values);
      lists.set(key, list);
      return list.length;
    },
    async lpush(key: string, ...values: string[]) {
      const list = lists.get(key) ?? [];
      list.unshift(...values);
      lists.set(key, list);
      return list.length;
    },
    async ltrim(key: string, start: number, stop: number) {
      const list = lists.get(key) ?? [];
      const len = list.length;
      const end = stop < 0 ? len + stop : stop;
      lists.set(key, list.slice(start, end + 1));
      return "OK";
    },
    async lrange(key: string, start: number, stop: number) {
      const list = lists.get(key) ?? [];
      const len = list.length;
      const end = stop < 0 ? len + stop : stop;
      return list.slice(start, end + 1);
    },
    async llen(key: string) {
      return (lists.get(key) ?? []).length;
    },
    async eval(script: string, _numKeys: number, ...args: string[]) {
      if (script.includes("DATASTACK_RATE_LIMIT_INCR")) {
        const key = args[0];
        const next = (Number(kv.get(key)) || 0) + 1;
        kv.set(key, String(next));
        return next;
      }
      if (script.includes("DATASTACK_PURGE_CLIENT_LIST")) {
        const [key, target] = args;
        const list = lists.get(key) ?? [];
        const kept: string[] = [];
        let removed = 0;
        for (const raw of list) {
          try {
            const parsed = JSON.parse(raw) as { clientId?: string };
            const cid = String(parsed?.clientId || "")
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9_-]/g, "_");
            if (cid === target) {
              removed += 1;
              continue;
            }
          } catch {
            // preserve unparseable entries
          }
          kept.push(raw);
        }
        if (removed > 0) lists.set(key, kept);
        return removed;
      }
      return 1;
    },
  };
}

test("BUG-B01: Port 4000 verifyClientInDb fails closed for unregistered/empty clients even without DB", async () => {
  const emptyCheck = await serverMod.verifyClientInDb("", "any-token", true);
  assert.equal(emptyCheck.allowed, false);
  assert.match(emptyCheck.reason || "", /CLIENT_REVOKED/);

  const ghostCheck = await serverMod.verifyClientInDb("Unregistered Ghost", "any-token", true);
  assert.equal(ghostCheck.allowed, false);
  assert.match(ghostCheck.reason || "", /CLIENT_REVOKED/);

  const ghostToken = AuthService.generateClientToken({ clientId: "never_registered_ws" });
  await assert.rejects(() => connectSocket(ghostToken), /CLIENT_REVOKED/);
});

test("BUG-B02 & BUG-B04: Shared Redis idempotency/rate-limit across Port 3000+4000 and flat sync_data payload parity", async () => {
  const mockRedis = createSharedMockRedis();
  DataBufferEngine.setRedisClientForTests(mockRedis);
  serverMod.setRedisClientForTests(mockRedis);

  try {
    await SettingsManager.updateSettingsAsync({
      maxEventsPerSec: 3,
      enableIdempotency: true,
    });

    const client = await SDKManager.registerClientAsync({
      clientId: "phase02_redis_parity",
      name: "Phase02 Redis Parity",
      rateLimit: 3,
    });

    // 1. Flat sync_data payload (no .data wrapper) preserves fields cleanly (BUG-B04)
    serverMod.bufferQueue.length = 0;
    const socket = await connectSocket(client.token);
    const flatAck = await emitWithAck<{ success: boolean; eventId: string }>(
      socket,
      "sync_data",
      { eventId: "evt_shared_flat_1", metric: "voltage", value: 3.3 },
    );
    assert.equal(flatAck.success, true);

    const bufferedItems = await mockRedis.lrange("datastack:buffer:events", 0, -1);
    const storedFlat = bufferedItems
      .map((raw) => JSON.parse(raw) as { eventId: string; payload: string })
      .find((e) => e.eventId === "evt_shared_flat_1");
    assert.ok(storedFlat, "Flat sync_data event must be buffered in Redis");
    const parsedFlat = JSON.parse(storedFlat.payload) as Record<string, unknown>;
    assert.equal(parsedFlat.metric, "voltage");
    assert.equal(parsedFlat.value, 3.3);

    // 2. Replaying same eventId over HTTP POST /api/events triggers shared DUPLICATE_EVENT (BUG-B02)
    const replayHttpRes = await postEventsRoute(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.token}`,
        },
        body: JSON.stringify({
          eventId: "evt_shared_flat_1",
          data: { metric: "voltage", value: 3.3 },
        }),
      }),
    );
    assert.equal(replayHttpRes.status, 200);
    const replayHttpJson = await replayHttpRes.json();
    assert.equal(replayHttpJson.note, "DUPLICATE_DROPPED");

    // 3. Cross-runtime shared per-second rate-limit: 1 WS already consumed quota; 2 HTTP pass, 3rd hits 429 (BUG-B02)
    const ok2 = await postEventsRoute(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.token}`,
        },
        body: JSON.stringify({ eventId: "evt_rl_shared_2", data: { n: 2 } }),
      }),
    );
    const ok3 = await postEventsRoute(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.token}`,
        },
        body: JSON.stringify({ eventId: "evt_rl_shared_3", data: { n: 3 } }),
      }),
    );
    assert.equal(ok2.status, 200);
    assert.equal(ok3.status, 200);

    const limited4 = await postEventsRoute(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.token}`,
        },
        body: JSON.stringify({ eventId: "evt_rl_shared_4", data: { n: 4 } }),
      }),
    );
    assert.equal(limited4.status, 429);
    socket.disconnect();
  } finally {
    DataBufferEngine.setRedisClientForTests(undefined);
    serverMod.setRedisClientForTests(undefined);
  }
});

test("BUG-B03 & BUG-B05: Surfacing bridge sync failures, live runtime ports, normalized counter & production start script", async () => {
  const cookieHeader = await createAdminCookieHeader();
  const res = await postSettingsRoute(
    new NextRequest("http://localhost:3000/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ maxEventsPerSec: 120 }),
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.bridgeSync?.synced, true);

  // Mismatched secret on remote Port 4000 must surface auth_error on dashboard metrics
  const http = await import("node:http");
  const rejectServer = http.createServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, code: "UNAUTHORIZED" }));
  });
  await new Promise<void>((resolveListen) => rejectServer.listen(0, "127.0.0.1", resolveListen));
  const rejectAddr = rejectServer.address() as AddressInfo;
  const savedIngestionUrl = process.env.INGESTION_INTERNAL_URL;
  process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${rejectAddr.port}`;
  try {
    const metrics = await ApiEngine.getDashboardMetrics();
    assert.equal(metrics.runtime.ingestionBridgeStatus, "auth_error");
    assert.match(metrics.runtime.ingestionBridgeError || "", /HTTP 401/);
  } finally {
    process.env.INGESTION_INTERNAL_URL = savedIngestionUrl;
    await new Promise<void>((resolveClose) => rejectServer.close(() => resolveClose()));
  }

  // Normalized totalEvents counter updates cleanly
  const normClient = await SDKManager.registerClientAsync({
    clientId: "Mixed.Case.Counter",
    name: "Counter Check",
    rateLimit: 100,
  });
  await SDKManager.incrementEventCountAsync("MIXED.CASE.COUNTER", 3);
  const fetched = await SDKManager.getClientAsync(normClient.clientId);
  assert.equal(fetched?.totalEvents, 3);

  // Production start script runs dual-runtime launcher
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.scripts?.start, "node scripts/start-all.js");
  assert.equal(pkg.scripts?.["start:server"], "node server/index.js");
});

test("FORENSIC BUG-02: Empty Port 3000 bulk_sync preserves Port 4000 registry and hydrates Port 3000 non-destructively", async () => {
  const survivor = await SDKManager.registerClientAsync({
    clientId: "phase02_survivor_client",
    name: "Survivor Client",
    rateLimit: 40,
  });

  // Verify Port 4000 knows survivor before simulated Port 3000 restart
  const preCheck = await serverMod.verifyClientInDb(survivor.clientId, survivor.token, true);
  assert.equal(preCheck.allowed, true);

  // Simulate Port 3000 cold restart without PostgreSQL (local map cleared)
  g.__dataStackClientsMap?.clear();
  assert.equal(SDKManager.getClient(survivor.clientId), undefined);

  // Calling syncAllClientsToIngestionAsync() with an empty Port 3000 map must NOT wipe Port 4000
  const syncRes = await SDKManager.syncAllClientsToIngestionAsync();
  assert.equal(syncRes.synced, true);

  const postCheck = await serverMod.verifyClientInDb(survivor.clientId, survivor.token, true);
  assert.equal(postCheck.allowed, true, "Port 4000 registry must NOT be wiped by empty Port 3000 bulk_sync");

  // Port 3000 should also have hydrated non-destructively from Port 4000
  const hydratedAfterBulk = SDKManager.getClient(survivor.clientId);
  assert.ok(hydratedAfterBulk, "Port 3000 should hydrate preserved client after empty bulk_sync");
  assert.equal(hydratedAfterBulk.token, survivor.token);

  // Also test cold hydration via getClientAsync & listClientsAsync after clearing map again
  g.__dataStackClientsMap?.clear();
  const hydratedViaGet = await SDKManager.getClientAsync(survivor.clientId);
  assert.ok(hydratedViaGet, "getClientAsync should non-destructively hydrate from Port 4000");
  assert.equal(hydratedViaGet.clientId, survivor.clientId);
});

test("FORENSIC BUG-17: JWT rotation coordinates Port 4000 first, aborts on bridge rejection without split-brain, and supports rotation grace", async () => {
  const originalSecret = AuthService.getSecret();
  const http = await import("node:http");

  // 1. If Port 4000 rejects /internal/settings-sync with 503, Port 3000 MUST abort rotation cleanly
  const rejectServer = http.createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, code: "BRIDGE_REJECTED" }));
  });
  await new Promise<void>((r) => rejectServer.listen(0, "127.0.0.1", r));
  const rejectPort = (rejectServer.address() as AddressInfo).port;
  const savedUrl = process.env.INGESTION_INTERNAL_URL;
  process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${rejectPort}`;

  try {
    await assert.rejects(
      () =>
        SettingsManager.updateSettingsAsync({
          jwtSecret: "aborted-rotation-secret-must-never-commit-32-chars",
        }),
      /JWT_ROTATION_BRIDGE_FAILED/,
    );
    assert.equal(
      AuthService.getSecret(),
      originalSecret,
      "Port 3000 AuthService secret must remain unchanged when Port 4000 rejects rotation",
    );
    assert.equal(
      SettingsManager.getSettings().jwtSecret,
      originalSecret,
      "SettingsManager secret must remain unchanged after aborted rotation",
    );
  } finally {
    process.env.INGESTION_INTERNAL_URL = savedUrl;
    await new Promise<void>((r) => rejectServer.close(() => r()));
  }

  // 2. Successful rotation updates both runtimes AND keeps previous secret valid on Port 4000 bridge grace window
  const rotatedSecret = "phase02-bug17-coordinated-rotation-secret-32-chars";
  await SettingsManager.updateSettingsAsync({ jwtSecret: rotatedSecret });
  assert.equal(AuthService.getSecret(), rotatedSecret);
  assert.equal(serverMod.runtimeConfig.jwtSecret, rotatedSecret);

  const graceHeaders = getInternalIngestionHeaders(originalSecret);
  const graceMetricsRes = await fetch(`${ingestionUrl}/internal/metrics`, {
    headers: graceHeaders,
  });
  assert.equal(
    graceMetricsRes.status,
    200,
    "Port 4000 internal auth must accept previous secret during rotation grace window",
  );

  // 3. New secret also works on internal bridge
  const currentMetricsRes = await fetch(`${ingestionUrl}/internal/metrics`, {
    headers: getInternalIngestionHeaders(rotatedSecret),
  });
  assert.equal(currentMetricsRes.status, 200);

  // 4. If PG write fails AFTER Port 4000 accepts the new secret, BOTH Port 3000 & Port 4000 roll back cleanly
  const prevDbUrlLocal = process.env.DATABASE_URL;
  const prevPoolLocal = g.__dataStackCorePool;
  const prevSchemaLocal = g.__dataStackCoreSchema;
  process.env.DATABASE_URL = "postgres://mock:mock@127.0.0.1:5432/mock";
  g.__dataStackCoreSchema = Promise.resolve();
  g.__dataStackCorePool = {
    async query(sql: string) {
      if (sql.includes("INSERT INTO admin_settings")) {
        throw new Error("Simulated PG disk full during rotation");
      }
      return { rowCount: 0, rows: [] };
    },
  };
  try {
    await assert.rejects(
      () =>
        SettingsManager.updateSettingsAsync({
          jwtSecret: "rolled-back-secret-after-pg-failure-32-chars-min",
        }),
      /DATABASE_WRITE_FAILED/,
    );
    assert.equal(
      AuthService.getSecret(),
      rotatedSecret,
      "Port 3000 must roll back to previous secret after DB write failure",
    );
    assert.equal(
      serverMod.runtimeConfig.jwtSecret,
      rotatedSecret,
      "Port 4000 must roll back to previous secret after Port 3000 DB write failure",
    );
  } finally {
    if (prevDbUrlLocal === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrlLocal;
    g.__dataStackCorePool = prevPoolLocal;
    g.__dataStackCoreSchema = prevSchemaLocal;
  }
});

test("FORENSIC BUG-03: Without Redis, WS and HTTP share idempotency and rate limits via Port 4000 /internal/security-check", async () => {
  // Explicitly ensure Redis is disabled
  DataBufferEngine.setRedisClientForTests(null);
  serverMod.setRedisClientForTests(null);

  try {
    await SettingsManager.updateSettingsAsync({
      maxEventsPerSec: 3,
      enableIdempotency: true,
    });

    const client = await SDKManager.registerClientAsync({
      clientId: "phase02_no_redis_sec",
      name: "No-Redis Shared Security",
      rateLimit: 3,
    });

    const socket = await connectSocket(client.token);
    const wsAck = await emitWithAck<{ success: boolean; eventId: string }>(
      socket,
      "sync_data",
      { eventId: "evt_noredis_shared_1", data: { step: 1 } },
    );
    assert.equal(wsAck.success, true);

    // Same eventId over HTTP POST /api/events MUST be deduplicated via Port 4000 bridge check
    const dupHttpRes = await postEventsRoute(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.token}`,
        },
        body: JSON.stringify({
          eventId: "evt_noredis_shared_1",
          data: { step: 1 },
        }),
      }),
    );
    assert.equal(dupHttpRes.status, 200);
    const dupJson = await dupHttpRes.json();
    assert.equal(
      dupJson.note,
      "DUPLICATE_DROPPED",
      "HTTP replay of WS eventId must be dropped even without Redis",
    );

    // Rate-limit parity without Redis: WS consumed 1 of 3; 2 HTTP pass, 3rd returns 429
    const http2 = await postEventsRoute(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.token}`,
        },
        body: JSON.stringify({ eventId: "evt_noredis_rl_2", data: { step: 2 } }),
      }),
    );
    const http3 = await postEventsRoute(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.token}`,
        },
        body: JSON.stringify({ eventId: "evt_noredis_rl_3", data: { step: 3 } }),
      }),
    );
    assert.equal(http2.status, 200);
    assert.equal(http3.status, 200);

    const http4 = await postEventsRoute(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${client.token}`,
        },
        body: JSON.stringify({ eventId: "evt_noredis_rl_4", data: { step: 4 } }),
      }),
    );
    assert.equal(http4.status, 429, "Combined WS+HTTP quota must enforce 429 without Redis");

    // Metrics explicitly surface bridge_coordinated securityMode
    const metrics = await ApiEngine.getDashboardMetrics();
    assert.equal(metrics.securityStats.mode, "bridge_coordinated");
    assert.equal(metrics.runtime.securityMode, "bridge_coordinated");

    socket.disconnect();
  } finally {
    DataBufferEngine.setRedisClientForTests(undefined);
    serverMod.setRedisClientForTests(undefined);
  }
});

test("FORENSIC BUG-22: High-frequency client event increments coalesce into batched UNNEST SQL updates on both Port 3000 and Port 4000", async () => {
  const sdkQueries: Array<{ sql: string; params: unknown[] }> = [];
  const serverQueries: Array<{ sql: string; params: unknown[] }> = [];

  const mockSdkPool = {
    async query(sql: string, params: unknown[] = []) {
      sdkQueries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
  const mockServerPool = {
    async query(sql: string, params: unknown[] = []) {
      serverQueries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };

  const prevDatabaseUrl = process.env.DATABASE_URL;
  const prevCorePool = g.__dataStackCorePool;
  const prevCoreSchema = g.__dataStackCoreSchema;

  process.env.DATABASE_URL = "postgres://mock:mock@127.0.0.1:5432/mock";
  g.__dataStackCorePool = mockSdkPool;
  g.__dataStackCoreSchema = Promise.resolve();
  g.__dataStackPendingClientActivity?.clear();
  serverMod.setDbPoolForTests(mockServerPool);

  try {
    // 1. Port 3000 SDKManager: 25 rapid increments across 2 clients -> 0 immediate per-event queries, 1 batched UNNEST query on flush
    for (let i = 0; i < 15; i += 1) {
      await SDKManager.incrementEventCountAsync("batch_client_a", 1);
    }
    for (let i = 0; i < 10; i += 1) {
      await SDKManager.incrementEventCountAsync("batch_client_b", 2);
    }

    const preFlushUpdates = sdkQueries.filter((q) =>
      q.sql.includes("UPDATE client_sdks"),
    );
    assert.equal(
      preFlushUpdates.length,
      0,
      "Per-event increments must coalesce in memory instead of firing immediate per-row SQL",
    );

    const flushedSdkClients = await SDKManager.flushPendingClientActivityAsync();
    assert.equal(flushedSdkClients, 2);

    const postFlushSdkUpdates = sdkQueries.filter((q) =>
      q.sql.includes("UPDATE client_sdks"),
    );
    assert.equal(
      postFlushSdkUpdates.length,
      1,
      "25 increments across 2 clients must execute exactly ONE batched UPDATE query",
    );
    assert.match(postFlushSdkUpdates[0].sql, /UNNEST\(\$1::text\[\]\)/);
    assert.deepEqual(postFlushSdkUpdates[0].params[0], [
      "batch_client_a",
      "batch_client_b",
    ]);
    assert.deepEqual(postFlushSdkUpdates[0].params[1], [15, 20]);

    // 2. Port 4000 server/index.js: 30 rapid recordClientActivity calls -> 1 batched UNNEST query on flush
    for (let i = 0; i < 20; i += 1) {
      serverMod.recordClientActivity("ws_batch_a", 1);
    }
    for (let i = 0; i < 10; i += 1) {
      serverMod.recordClientActivity("ws_batch_b", 3);
    }
    assert.equal(
      serverQueries.length,
      0,
      "Port 4000 recordClientActivity must coalesce instead of running per-event SQL",
    );

    const flushedServerClients = await serverMod.flushPendingClientActivity();
    assert.equal(flushedServerClients, 2);
    assert.equal(
      serverQueries.length,
      1,
      "30 Port 4000 activity events must coalesce into ONE batched UPDATE query",
    );
    assert.match(serverQueries[0].sql, /UNNEST\(\$1::text\[\]\)/);
    assert.deepEqual(serverQueries[0].params[0], ["ws_batch_a", "ws_batch_b"]);
    assert.deepEqual(serverQueries[0].params[1], [20, 30]);
  } finally {
    SDKManager.stopActivityFlushTimerForTests();
    g.__dataStackPendingClientActivity?.clear();
    serverMod.setDbPoolForTests(null);
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    g.__dataStackCorePool = prevCorePool;
    g.__dataStackCoreSchema = prevCoreSchema;
  }
});

test("R2 PHASE-02 BUG-05: PG pools attach safe error listeners and Port 3000 shares a single unified DatabaseEngine pool", async () => {
  const prevDbUrl = process.env.DATABASE_URL;
  const prevCorePool = g.__dataStackCorePool;
  const origConsoleError = console.error;
  const loggedErrors: string[] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map((a) => String(a)).join(" "));
  };

  try {
    process.env.DATABASE_URL = "postgres://unit:test@127.0.0.1:5432/datastack_unit";
    g.__dataStackCorePool = undefined;

    const pool = DatabaseEngine.getPool();
    assert.ok(pool, "DatabaseEngine.getPool() must instantiate a pool when DATABASE_URL is set");
    assert.ok(
      pool.listenerCount("error") >= 1,
      "DatabaseEngine PG pool must attach at least one 'error' listener",
    );
    assert.equal(
      isAdminDatabaseConfigured(),
      true,
      "adminUsers must delegate to the shared DatabaseEngine.getPool()",
    );

    // Emitting an idle client error must log safely instead of throwing an uncaught EventEmitter crash
    assert.doesNotThrow(() => {
      pool.emit("error", new Error("simulated idle PG restart"));
    });
    assert.ok(
      loggedErrors.some((msg) => msg.includes("simulated idle PG restart")),
      "Pool error listener must log unexpected idle pool errors",
    );

    // Static verification that adminUsers.ts has zero independent `new Pool` and server/index.js attaches dbPool.on('error')
    const adminUsersSrc = readFileSync(
      resolve(process.cwd(), "core", "auth", "adminUsers.ts"),
      "utf8",
    );
    assert.equal(/\bnew Pool\s*\(/.test(adminUsersSrc), false);

    const serverSrc = readFileSync(
      resolve(process.cwd(), "server", "index.js"),
      "utf8",
    );
    assert.match(serverSrc, /dbPool\.on\(\s*['"]error['"]/);

    await pool.end().catch(() => undefined);
  } finally {
    console.error = origConsoleError;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    g.__dataStackCorePool = prevCorePool;
  }
});

test("R2 PHASE-02 BUG-09: Redis rate-limiting uses atomic single-roundtrip Lua EVAL on both Port 3000 and Port 4000", async () => {
  const baseRedis = createSharedMockRedis();
  let evalRateLimitCalls = 0;
  let separateIncrCalls = 0;
  let separatePexpireCalls = 0;

  const instrumentedRedis: RedisBufferClient = {
    ...baseRedis,
    async incr(key: string) {
      separateIncrCalls += 1;
      return baseRedis.incr!(key);
    },
    async pexpire(key: string, ttlMs: number) {
      separatePexpireCalls += 1;
      return baseRedis.pexpire!(key, ttlMs);
    },
    async eval(script: string, numKeys: number, ...args: string[]) {
      if (script.includes("DATASTACK_RATE_LIMIT_INCR")) {
        evalRateLimitCalls += 1;
        assert.equal(args[1], "2000", "Atomic Lua rate-limit script must pass 2000ms TTL");
      }
      return baseRedis.eval(script, numKeys, ...args);
    },
  };

  DataBufferEngine.setRedisClientForTests(instrumentedRedis);
  serverMod.setRedisClientForTests(instrumentedRedis);

  try {
    await SettingsManager.updateSettingsAsync({
      maxEventsPerSec: 2,
      enableIdempotency: true,
    });
    const client = await SDKManager.registerClientAsync({
      clientId: "phase02_lua_rl_client",
      name: "Lua RL Client",
      rateLimit: 2,
    });

    // 1 event via Port 3000 HTTP SecurityEngine
    const http1 = await SecurityEngine.validateEventAsync(
      client.clientId,
      "lua_rl_1",
      { v: 1 },
      client.rateLimit,
    );
    assert.equal(http1.allowed, true);

    // 2nd event via Port 4000 Socket.IO handler (allowed) + 3rd event (rate limited)
    const socket = await connectSocket(client.token);
    const ws2 = await emitWithAck<{ success: boolean; code?: string }>(
      socket,
      "sync_data",
      { eventId: "lua_rl_2", data: { v: 2 } },
    );
    assert.equal(ws2.success, true);

    const ws3 = await emitWithAck<{ success: boolean; code?: string }>(
      socket,
      "sync_data",
      { eventId: "lua_rl_3", data: { v: 3 } },
    );
    assert.equal(ws3.success, false);
    assert.equal(ws3.code, "RATE_LIMIT_EXCEEDED");

    socket.disconnect();

    assert.equal(
      evalRateLimitCalls,
      3,
      "All 3 rate-limit checks across Port 3000 & Port 4000 must execute atomic Lua EVAL",
    );
    assert.equal(
      separateIncrCalls,
      0,
      "Separate non-atomic redis.incr must NOT be called when redis.eval is available",
    );
    assert.equal(
      separatePexpireCalls,
      0,
      "Separate non-atomic redis.pexpire must NOT be called when redis.eval is available",
    );
  } finally {
    DataBufferEngine.setRedisClientForTests(undefined);
    serverMod.setRedisClientForTests(undefined);
    await SettingsManager.updateSettingsAsync({ maxEventsPerSec: 100 });
  }
});

test("R2 PHASE-02 BUG-10: GET, PATCH (regenerate_token), and DELETE /api/clients/[id] catch DB errors and return structured JSON", async () => {
  const secret = getAdminSessionSecret()!;
  const adminToken = await createAdminSessionToken(
    "admin@datastack.dev",
    secret,
    Date.now() + 3600_000,
    1,
  );
  const cookieHeader = `datastack_admin_session=${adminToken}`;

  const origGet = SDKManager.getClientAsync;
  const origRegen = SDKManager.regenerateTokenAsync;
  const origDeleteWithStats = SDKManager.deleteClientWithStatsAsync;

  try {
    SDKManager.getClientAsync = async () => {
      throw new Error("DATABASE_READ_FAILED: simulated pg read outage");
    };
    const getRes = await getClientRoute(
      new NextRequest("http://localhost:3000/api/clients/broken_client", {
        method: "GET",
        headers: { cookie: cookieHeader },
      }),
      { params: Promise.resolve({ id: "broken_client" }) },
    );
    assert.equal(getRes.status, 503);
    const getJson = await getRes.json();
    assert.equal(getJson.code, "DATABASE_READ_FAILED");
    assert.match(getJson.error, /simulated pg read outage/);

    SDKManager.regenerateTokenAsync = async () => {
      throw new Error("DATABASE_WRITE_FAILED: simulated token rotation DB failure");
    };
    const regenRes = await patchClientRoute(
      new NextRequest("http://localhost:3000/api/clients/broken_client", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
        },
        body: JSON.stringify({ action: "regenerate_token" }),
      }),
      { params: Promise.resolve({ id: "broken_client" }) },
    );
    assert.equal(regenRes.status, 503);
    const regenJson = await regenRes.json();
    assert.equal(regenJson.code, "DATABASE_WRITE_FAILED");
    assert.match(regenJson.error, /simulated token rotation DB failure/);

    SDKManager.deleteClientWithStatsAsync = async () => {
      throw new Error("DATABASE_WRITE_FAILED: simulated delete DB failure");
    };
    const delRes = await deleteClientRoute(
      new NextRequest("http://localhost:3000/api/clients/broken_client", {
        method: "DELETE",
        headers: { cookie: cookieHeader },
      }),
      { params: Promise.resolve({ id: "broken_client" }) },
    );
    assert.equal(delRes.status, 503);
    const delJson = await delRes.json();
    assert.equal(delJson.code, "DATABASE_WRITE_FAILED");
    assert.match(delJson.error, /simulated delete DB failure/);
  } finally {
    SDKManager.getClientAsync = origGet;
    SDKManager.regenerateTokenAsync = origRegen;
    SDKManager.deleteClientWithStatsAsync = origDeleteWithStats;
  }
});

test("P02 R-01 diagnostic: Redis RPUSH failure yields positive WS ACK for volatile RAM-only event", async () => {
  // Disposable test-only fixture: no production Redis, service, or storage state.
  const previousThreshold = serverMod.runtimeConfig.batchFlushThreshold;
  const previousRam = serverMod.bufferQueue.slice();
  const failingRedis = createSharedMockRedis();
  failingRedis.rpush = async () => {
    throw new Error("P02 injected Redis RPUSH outage");
  };
  serverMod.setRedisClientForTests(failingRedis);
  serverMod.runtimeConfig.batchFlushThreshold = 100_000;
  serverMod.bufferQueue.length = 0;
  let socket: Socket | undefined;
  try {
    const client = await SDKManager.registerClientAsync({
      clientId: "p02_redis_rpush_failure",
      name: "P02 Redis RPUSH Failure",
      rateLimit: 100,
    });
    socket = await connectSocket(client.token);
    const ack = await emitWithAck<{ success: boolean; eventId?: string; code?: string }>(
      socket, "sync_data",
      { eventId: "p02-ack-before-crash-001", data: { value: 42 } },
    );
    const committedRows = await failingRedis.lrange("datastack:buffer:events", 0, -1);
    const volatileRows = serverMod.bufferQueue.filter((e) => e.eventId === "p02-ack-before-crash-001");
    assert.equal(ack.success, false, "P02 remediation must reject non-durable ACK");
    assert.equal(ack.code, "BUFFER_PERSIST_FAILED");
    const sameIdRetry = await emitWithAck<{ success: boolean; code?: string }>(
      socket, "sync_data",
      { eventId: "p02-ack-before-crash-001", data: { value: 42 } },
    );
    assert.equal(sameIdRetry.success, false,
      "Pending idempotency claims must not return false positive duplicate ACK");
    assert.equal(sameIdRetry.code, "BUFFER_PERSIST_FAILED");
    assert.equal(committedRows.length, 0, "Fake Redis has no durable event");
    assert.equal(volatileRows.length, 1, "Acknowledged event is RAM-only");
    // Crash model: restart loses RAM but fake Redis survives. No actual process is killed.
    serverMod.bufferQueue.length = 0;
    assert.equal((await failingRedis.lrange("datastack:buffer:events", 0, -1)).length, 0);
    // A new event may ACK only after Redis actually resumes persistence.
    const healthyRedis = createSharedMockRedis();
    serverMod.setRedisClientForTests(healthyRedis);
    const recovered = await emitWithAck<{ success: boolean; eventId?: string }>(
      socket, "sync_data",
      { eventId: "p02-ack-recovered-002", data: { value: 43 } },
    );
    assert.equal(recovered.success, true);
    assert.equal((await healthyRedis.lrange("datastack:buffer:events", 0, -1)).length, 1);
  } finally {
    socket?.disconnect();
    serverMod.setRedisClientForTests(undefined);
    serverMod.runtimeConfig.batchFlushThreshold = previousThreshold;
    serverMod.bufferQueue.splice(0, serverMod.bufferQueue.length, ...previousRam);
  }
});

test("P02 R-03 diagnostic: Redis query failure leaves public ingestion health 200/online", async () => {
  const redis = createSharedMockRedis();
  redis.llen = async () => { throw new Error("P02 simulated Redis health outage"); };
  serverMod.setRedisClientForTests(redis);
  try {
    const res = await fetch(`${ingestionUrl}/health`);
    assert.equal(res.status, 200, "Legacy liveness status remains backwards-compatible");
    const body = await res.json() as { status: string; redisConnected: boolean; redisBufferSize: number };
    assert.equal(body.status, "online");
    assert.equal(body.redisConnected, false, "Redis failure is represented only in the payload");
    assert.equal(body.redisBufferSize, 0);
    const healthyRedis = createSharedMockRedis();
    serverMod.setRedisClientForTests(healthyRedis);
    const recovered = await fetch(`${ingestionUrl}/health`);
    const recoveredBody = await recovered.json() as { redisConnected: boolean };
    assert.equal(recovered.status, 200);
    assert.equal(recoveredBody.redisConnected, true);
  } finally {
    serverMod.setRedisClientForTests(undefined);
  }
});

test("P02 R-01: batch_sync rejects non-durable Redis writes and pending duplicate claims", async () => {
  const previousThreshold = serverMod.runtimeConfig.batchFlushThreshold;
  const previousQueue = serverMod.bufferQueue.slice();
  const failingRedis = createSharedMockRedis();
  failingRedis.rpush = async () => { throw new Error("P02 injected batch Redis outage"); };
  serverMod.setRedisClientForTests(failingRedis);
  serverMod.runtimeConfig.batchFlushThreshold = 100_000;
  serverMod.bufferQueue.length = 0;
  let socket: Socket | undefined;
  const payload = [
    { eventId: "p02-batch-volatile-1", data: { value: 1 } },
    { eventId: "p02-batch-volatile-2", data: { value: 2 } },
  ];
  try {
    const client = await SDKManager.registerClientAsync({
      clientId: "p02_redis_batch_failure",
      name: "P02 Redis Batch Failure",
      rateLimit: 100,
    });
    socket = await connectSocket(client.token);
    const ack = await emitWithAck<{ success: boolean; code?: string; processed?: number }>(
      socket, "batch_sync", payload,
    );
    assert.equal(ack.success, false);
    assert.equal(ack.code, "BUFFER_PERSIST_FAILED");
    assert.equal(ack.processed, 0);
    assert.equal((await failingRedis.lrange("datastack:buffer:events", 0, -1)).length, 0);
    const retry = await emitWithAck<{ success: boolean; code?: string }>(
      socket, "batch_sync", payload,
    );
    assert.equal(retry.success, false);
    assert.equal(retry.code, "BUFFER_PERSIST_FAILED");
  } finally {
    socket?.disconnect();
    serverMod.setRedisClientForTests(undefined);
    serverMod.runtimeConfig.batchFlushThreshold = previousThreshold;
    serverMod.bufferQueue.splice(0, serverMod.bufferQueue.length, ...previousQueue);
  }
});

test("P02 FINAL R-01: stale Redis claim never becomes positive ACK after cleanup window", async () => {
  // Source proof at candidate 76cd972: a failure marker is -Date.now();
  // cleanupMaps compares now - negativeTimestamp > TTL, which expires immediately
  // on the first scheduled cleanup even though a Redis idempotency claim remains.
  const previousThreshold = serverMod.runtimeConfig.batchFlushThreshold;
  const previousQueue = serverMod.bufferQueue.slice();
  const redis = createSharedMockRedis(); // intentionally no DEL: simulate stuck Redis claim
  redis.rpush = async () => { throw new Error("Injected Redis queue outage"); };
  serverMod.setRedisClientForTests(redis);
  serverMod.runtimeConfig.batchFlushThreshold = 100_000;
  serverMod.bufferQueue.length = 0;

  let socket: Socket | undefined;
  try {
    const client = await SDKManager.registerClientAsync({
      clientId: "p02_stale_claim_cleanup", name: "P02 Stale Claim", rateLimit: 100,
    });
    socket = await connectSocket(client.token);
    const payload = { eventId: "p02-stale-claim-1", data: { value: 1 } };
    const first = await emitWithAck<{ success: boolean; code?: string }>(socket, "sync_data", payload);
    assert.equal(first.success, false);
    assert.equal(first.code, "BUFFER_PERSIST_FAILED");

    // Verify TTL arithmetic without overriding the global clock (Socket.IO timeouts).
    // Also keep two real socket retries to prove pending claims stay negative.
    // Do not mutate process timestamps or wait for wall-clock TTL.
    const stamped = Date.now();
    const cleanupClock = stamped + 61_000;
    assert.equal(cleanupClock - (-stamped) > 300_000, true, "Old negative marker expired prematurely");
    assert.equal(cleanupClock - stamped < 300_000, true, "Five-minute TTL should still be active");
    const handlerSource = readFileSync(require.resolve("../server/socket/handlers.js"), "utf8");
    assert.ok(handlerSource.includes('idempotencyMap.set(`\\u0000failed-persist:${claimKey}`, Date.now());'));
    assert.equal(handlerSource.includes("idempotencyMap.set(claimKey, -Date.now());"), false);
    const retry1 = await emitWithAck<{ success: boolean; code?: string }>(socket, "sync_data", payload);
    const retry2 = await emitWithAck<{ success: boolean; code?: string }>(socket, "sync_data", payload);
    assert.equal(retry1.success, false);
    assert.equal(retry1.code, "BUFFER_PERSIST_FAILED");
    assert.equal(retry2.success, false, "Cleanup must not convert a volatile claim into DUPLICATE_DROPPED success");
    assert.equal(retry2.code, "BUFFER_PERSIST_FAILED");
    assert.equal((await redis.lrange("datastack:buffer:events", 0, -1)).length, 0);
  } finally {

    socket?.disconnect();
    serverMod.setRedisClientForTests(undefined);
    serverMod.runtimeConfig.batchFlushThreshold = previousThreshold;
    serverMod.bufferQueue.splice(0, serverMod.bufferQueue.length, ...previousQueue);
  }
});

test("P02 FINAL R-01: mixed batch with stale volatile claim never ACKs success", async () => {
  const previousThreshold = serverMod.runtimeConfig.batchFlushThreshold;
  const previousQueue = serverMod.bufferQueue.slice();
  const redis = createSharedMockRedis();
  const originalRpush = redis.rpush.bind(redis);
  redis.rpush = async () => { throw new Error("Injected Redis outage before batch recovery"); };
  serverMod.setRedisClientForTests(redis);
  serverMod.runtimeConfig.batchFlushThreshold = 100_000;
  serverMod.bufferQueue.length = 0;
  let socket: Socket | undefined;
  try {
    const client = await SDKManager.registerClientAsync({
      clientId: "p02_mixed_batch_claim", name: "P02 Mixed Batch Claim", rateLimit: 100,
    });
    socket = await connectSocket(client.token);
    const pending = { eventId: "p02-mixed-pending-01", data: { v: 1 } };
    const first = await emitWithAck<{ success: boolean; code?: string }>(
      socket, "sync_data", pending,
    );
    assert.equal(first.success, false);
    // Simulated process RAM loss: Redis idempotency key survives; queue does not.
    serverMod.bufferQueue.length = 0;
    redis.rpush = originalRpush;
    const mixed = await emitWithAck<{ success: boolean; code?: string; processed?: number }>(
      socket, "batch_sync", [pending, { eventId: "p02-mixed-durable-02", data: { v: 2 } }],
    );
    assert.equal(mixed.success, false, "Mixed batch cannot falsely ACK the volatile duplicate");
    assert.equal(mixed.code, "BUFFER_PERSIST_FAILED");
    assert.equal(mixed.processed, 1, "A distinct new event can commit without masking the failed claim");
    const rows = await redis.lrange("datastack:buffer:events", 0, -1);
    assert.equal(rows.length, 1);
    assert.equal((JSON.parse(rows[0]) as { eventId: string }).eventId, "p02-mixed-durable-02");
  } finally {
    socket?.disconnect();
    serverMod.setRedisClientForTests(undefined);
    serverMod.runtimeConfig.batchFlushThreshold = previousThreshold;
    serverMod.bufferQueue.splice(0, serverMod.bufferQueue.length, ...previousQueue);
  }
});

test("P02 FINAL R-01 compatibility: deliberately Redis-free RAM mode remains unchanged", async () => {
  const threshold = serverMod.runtimeConfig.batchFlushThreshold;
  const queue = serverMod.bufferQueue.slice();
  serverMod.setRedisClientForTests(null);
  serverMod.runtimeConfig.batchFlushThreshold = 100_000;
  serverMod.bufferQueue.length = 0;
  let socket: Socket | undefined;
  try {
    const client = await SDKManager.registerClientAsync({
      clientId: "p02_redis_free_compat", name: "P02 Redis-free Compatibility", rateLimit: 100,
    });
    socket = await connectSocket(client.token);
    const ack = await emitWithAck<{ success: boolean; eventId?: string }>(
      socket, "sync_data", { eventId: "p02-ram-compat-001", data: { value: 1 } },
    );
    assert.equal(ack.success, true, "Preserve historical RAM-mode acceptance contract");
    assert.equal(serverMod.bufferQueue.some((e) => e.eventId === "p02-ram-compat-001"), true);
  } finally {
    socket?.disconnect();
    serverMod.setRedisClientForTests(undefined);
    serverMod.runtimeConfig.batchFlushThreshold = threshold;
    serverMod.bufferQueue.splice(0, serverMod.bufferQueue.length, ...queue);
  }
});

test("P02 FINAL R-01: pending claim plus durable duplicate must reject whole batch", async () => {
  const previousThreshold = serverMod.runtimeConfig.batchFlushThreshold;
  const previousQueue = serverMod.bufferQueue.slice();
  const redis = createSharedMockRedis();
  const healthyRpush = redis.rpush.bind(redis);
  serverMod.setRedisClientForTests(redis);
  serverMod.runtimeConfig.batchFlushThreshold = 100_000;
  serverMod.bufferQueue.length = 0;
  let socket: Socket | undefined;
  try {
    const client = await SDKManager.registerClientAsync({
      clientId: "p02_mixed_only_duplicates", name: "P02 Failed and Durable Duplicate", rateLimit: 100,
    });
    socket = await connectSocket(client.token);
    const durable = { eventId: "p02-durable-duplicate", data: { v: 10 } };
    const pending = { eventId: "p02-failed-duplicate", data: { v: 20 } };
    const first = await emitWithAck<{ success: boolean }>(socket, "sync_data", durable);
    assert.equal(first.success, true);
    redis.rpush = async () => { throw new Error("Injected Redis failure for second event"); };
    const rejected = await emitWithAck<{ success: boolean; code?: string }>(
      socket, "sync_data", pending,
    );
    assert.equal(rejected.success, false);
    assert.equal(rejected.code, "BUFFER_PERSIST_FAILED");
    serverMod.bufferQueue.length = 0; // simulate volatile queue lost across restart
    redis.rpush = healthyRpush;
    const mixed = await emitWithAck<{
      success: boolean; code?: string; processed?: number; duplicates?: number;
    }>(socket, "batch_sync", [pending, durable]);
    assert.equal(mixed.processed, 0);
    assert.equal(mixed.duplicates, 1);
    assert.equal(mixed.success, false,
      "Existing durable duplicate cannot mask a non-durable pending claim");
    assert.equal(mixed.code, "BUFFER_PERSIST_FAILED");
    assert.equal((await redis.lrange("datastack:buffer:events", 0, -1)).length, 1);
  } finally {
    socket?.disconnect();
    serverMod.setRedisClientForTests(undefined);
    serverMod.runtimeConfig.batchFlushThreshold = previousThreshold;
    serverMod.bufferQueue.splice(0, serverMod.bufferQueue.length, ...previousQueue);
  }
});
