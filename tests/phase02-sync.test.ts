import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import { io as ioClient, type Socket } from "socket.io-client";
import { GET as getSettingsRoute, POST as postSettingsRoute } from "../app/api/settings/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  createInitialAdmin,
  resetAdminStateForTests,
} from "../core/auth/adminUsers";
import { ApiEngine } from "../core/apiEngine/apiService";
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
