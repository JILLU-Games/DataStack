import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { Server as SocketIOServer } from 'socket.io';
import {
  DataStack,
  DataStackAuthError,
  DataStackQuotaExceededError,
} from '../sdk/node/datastack';

const require = createRequire(import.meta.url);
const { setupSocketHandlers } = require('../server/socket/handlers.js') as {
  setupSocketHandlers: (
    io: SocketIOServer,
    bufferQueue: Array<Record<string, unknown>>,
    worker: {
      flush?: (rows: Array<Record<string, unknown>>) => Promise<void>;
      checkStorageAdmission?: (
        clientId: string,
        quotaMb: number,
        diskPct: number
      ) => Promise<{ allowed: boolean; code?: string; reason?: string }>;
    },
    options?: Record<string, unknown>
  ) => unknown;
};

const TEST_JWT_SECRET = 'r3-phase03-sdk-parity-jwt-secret-key-32-chars';

function signClientJwt(clientId: string): string {
  return jwt.sign({ clientId, sub: clientId }, TEST_JWT_SECRET, {
    expiresIn: '1h',
  });
}

async function startLiveIngestionSocketServer(options?: {
  verifyClientInDb?: (
    clientId: string,
    token: string,
    forceRefresh: boolean,
    clientIp: string
  ) => Promise<{
    allowed: boolean;
    code?: string;
    reason?: string;
    rateLimit?: number;
    storageQuotaMb?: number;
  }>;
  checkStorageAdmission?: (
    clientId: string,
    quotaMb: number,
    diskPct: number
  ) => Promise<{ allowed: boolean; code?: string; reason?: string }>;
}) {
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
  });
  const bufferQueue: Array<Record<string, unknown>> = [];
  const flushed: Array<Record<string, unknown>> = [];

  setupSocketHandlers(
    io,
    bufferQueue,
    {
      flush: async (rows: Array<Record<string, unknown>>) => {
        flushed.push(...rows);
      },
      checkStorageAdmission:
        options?.checkStorageAdmission ??
        (async () => ({ allowed: true })),
    },
    {
      getRuntimeConfig: () => ({
        jwtSecret: TEST_JWT_SECRET,
        maxEventsPerSec: 200,
        maxPayloadSizeBytes: 100 * 1024,
        batchFlushThreshold: 500,
        enableIdempotency: true,
        diskPauseThresholdPct: 95,
      }),
      verifyClientInDb:
        options?.verifyClientInDb ??
        (async () => ({
          allowed: true,
          rateLimit: 200,
          storageQuotaMb: 0,
        })),
    }
  );

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    io,
    bufferQueue,
    flushed,
    close: async () => {
      await new Promise<void>((resolve) => {
        io.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}

test('R3-Phase-03 (BUG-07): Compiled Node.js SDK dist/index.js loads cleanly via plain CommonJS require() and exports typed package entrypoints', async () => {
  const pkgPath = path.join(
    process.cwd(),
    'sdk',
    'node',
    'datastack',
    'package.json'
  );
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as {
    main: string;
    types: string;
    exports?: { '.': { default: string; types: string } };
    scripts?: { build?: string };
  };

  assert.equal(pkg.main, './dist/index.js');
  assert.equal(pkg.types, './dist/index.d.ts');
  assert.equal(pkg.exports?.['.']?.default, './dist/index.js');
  assert.equal(pkg.exports?.['.']?.types, './dist/index.d.ts');
  assert.ok(pkg.scripts?.build?.includes('tsc'));

  // Verify compiled CommonJS output loads directly via Node require() with zero TypeScript transpilation
  const distPath = path.join(
    process.cwd(),
    'sdk',
    'node',
    'datastack',
    'dist',
    'index.js'
  );
  const loaded = require(distPath) as Record<string, unknown>;
  assert.equal(typeof loaded.DataStack, 'function');
  assert.equal(typeof loaded.DataStackClient, 'function');
  assert.equal(typeof loaded.DataStackAuthError, 'function');
  assert.equal(typeof loaded.DataStackQuotaExceededError, 'function');
  assert.equal(typeof loaded.SDK_VERSION, 'string');

  const dtsPath = path.join(
    process.cwd(),
    'sdk',
    'node',
    'datastack',
    'dist',
    'index.d.ts'
  );
  const dtsContent = await fs.readFile(dtsPath, 'utf8');
  assert.match(dtsContent, /export declare class DataStack/);
});

test('R3-Phase-03 (BUG-02): Live Port 4000 Socket.IO batch_sync accepts Node.js SDK raw Array payload and reports processed + duplicates accurately', async () => {
  const server = await startLiveIngestionSocketServer();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-r3-p03-ws-'));
  let client: DataStack | null = null;

  try {
    const token = signClientJwt('node_ws_batch_client');
    client = new DataStack({
      serverUrl: server.url,
      apiUrl: 'http://127.0.0.1:1', // Unreachable HTTP to prove WS-only delivery
      token,
      autoConnect: false,
      enableHttpFallback: false,
      offlineSpoolEnabled: false,
      heartbeatIntervalMs: 5000,
    });

    await client.connect();
    assert.equal(client.status().connected, true);

    // 1. Live WebSocket sendBatch with explicit eventIds (must send raw Array, NOT { clientId, batch })
    const batchResult = await client.sendBatch([
      { eventId: 'r3_ws_evt_1', metric: 'cpu', value: 41.2 },
      { eventId: 'r3_ws_evt_2', metric: 'mem', value: 68.5 },
      { eventId: 'r3_ws_evt_3', metric: 'disk', value: 52.0 },
    ]);

    assert.equal(batchResult.success, true);
    assert.equal(batchResult.transport, 'websocket');
    assert.equal(batchResult.accepted, 3);
    assert.equal(batchResult.duplicates, 0);
    assert.equal(batchResult.spooled, 0);
    assert.equal(server.bufferQueue.length, 3);

    // 2. Idempotent re-send of 2 duplicates + 1 new event over live WebSocket batch_sync
    const dedupResult = await client.batchSync([
      { eventId: 'r3_ws_evt_1', metric: 'cpu', value: 41.2 },
      { eventId: 'r3_ws_evt_2', metric: 'mem', value: 68.5 },
      { eventId: 'r3_ws_evt_4', metric: 'net', value: 12.8 },
    ]);

    assert.equal(dedupResult.success, true);
    assert.equal(dedupResult.transport, 'websocket');
    assert.equal(dedupResult.accepted, 1);
    assert.equal(dedupResult.duplicates, 2);
    assert.equal(dedupResult.spooled, 0);
    assert.equal(server.bufferQueue.length, 4);

    // 3. Live WebSocket sendFile() + idempotent file re-send (deterministic eventIds)
    const csvFile = path.join(tmpDir, 'telemetry.csv');
    await fs.writeFile(
      csvFile,
      'node,temp\na1,23.5\na2,24.1\n',
      'utf8'
    );

    const fileRes1 = await client.sendFile(csvFile, { chunkSize: 10 });
    assert.equal(fileRes1.success, true);
    assert.equal(fileRes1.totalRows, 2);
    assert.equal(fileRes1.acceptedRows, 2);
    assert.equal(fileRes1.duplicates, 0);
    assert.equal(server.bufferQueue.length, 6);

    const fileRes2 = await client.sendFile(csvFile, { chunkSize: 10 });
    assert.equal(fileRes2.success, true);
    assert.equal(fileRes2.totalRows, 2);
    assert.equal(fileRes2.acceptedRows, 0);
    assert.equal(fileRes2.duplicates, 2);
    assert.equal(server.bufferQueue.length, 6);
  } finally {
    if (client) {
      await client.disconnect();
    }
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R3-Phase-03 (BUG-07): Node.js SDK heartbeatIntervalMs monitor stays zero-CPU in IDLE_WS, activates on drop, recovers via ping_verify, and cleans up on disconnect', async () => {
  const server = await startLiveIngestionSocketServer();
  let client: DataStack | null = null;

  try {
    const token = signClientJwt('node_hb_client');
    client = new DataStack({
      serverUrl: server.url,
      apiUrl: 'http://127.0.0.1:1',
      token,
      autoConnect: false,
      enableHttpFallback: false,
      offlineSpoolEnabled: false,
      heartbeatIntervalMs: 120,
      requestTimeoutMs: 1500,
    });

    assert.equal(client.status().heartbeatActive, false);

    await client.connect();
    // Zero-CPU IDLE_WS parity: heartbeat timer is paused while socket is healthy
    assert.equal(client.status().connected, true);
    assert.equal(client.status().transportState, 'IDLE_WS');
    assert.equal(client.status().heartbeatActive, false);

    // Force server-side disconnect of all sockets -> heartbeat monitor activates immediately
    for (const sock of server.io.sockets.sockets.values()) {
      sock.disconnect(true);
    }

    // Wait briefly to observe disconnect + automatic heartbeat ping_verify recovery
    let sawHeartbeatActive = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const snap = client.status();
      if (snap.heartbeatActive) {
        sawHeartbeatActive = true;
      }
      if (sawHeartbeatActive && snap.connected && !snap.heartbeatActive) {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(sawHeartbeatActive, true);
    assert.equal(client.status().connected, true);
    assert.equal(client.status().transportState, 'IDLE_WS');
    assert.equal(client.status().heartbeatActive, false);

    // Verify recovered WebSocket can immediately send live telemetry
    const afterRecover = await client.send({
      eventId: 'hb_recovered_1',
      status: 'alive',
    });
    assert.equal(afterRecover.success, true);
    assert.equal(afterRecover.transport, 'websocket');
    assert.equal(afterRecover.accepted, 1);

    // Disconnect must stop heartbeat timer cleanly
    await client.disconnect();
    assert.equal(client.status().connected, false);
    assert.equal(client.status().heartbeatActive, false);
  } finally {
    if (client) {
      await client.disconnect();
    }
    await server.close();
  }
});

test('R3-Phase-03 (BUG-07): Single HTTP DUPLICATE_DROPPED reports accepted=0, duplicates=1 and TOKEN_ROTATED / CLIENT_REVOKED fail fast with DataStackAuthError', async () => {
  const token = signClientJwt('node_http_dedup_auth');
  let mode: 'dup' | 'rotated' | 'revoked' = 'dup';
  let fetchCalls = 0;

  const mockFetch: typeof fetch = async () => {
    fetchCalls += 1;
    if (mode === 'dup') {
      return new Response(
        JSON.stringify({
          success: true,
          eventId: 'dup_single_1',
          note: 'DUPLICATE_DROPPED',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (mode === 'rotated') {
      return new Response(
        JSON.stringify({
          success: false,
          code: 'TOKEN_ROTATED',
          error: 'Client token was rotated; issue new credentials',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        code: 'CLIENT_REVOKED',
        error: 'Client credential has been revoked',
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-r3-p03-auth-'));
  const client = new DataStack({
    serverUrl: 'http://127.0.0.1:1',
    apiUrl: 'http://127.0.0.1:3000',
    token,
    autoConnect: false,
    maxRetries: 3,
    offlineSpoolEnabled: true,
    offlineSpoolDir: tmpDir,
    fetchImpl: mockFetch,
  });

  try {
    // 1. Single HTTP DUPLICATE_DROPPED -> accepted: 0, duplicates: 1
    mode = 'dup';
    const dupRes = await client.send({
      eventId: 'dup_single_1',
      metric: 'temp',
      val: 20,
    });
    assert.equal(dupRes.success, true);
    assert.equal(dupRes.accepted, 0);
    assert.equal(dupRes.duplicates, 1);
    assert.equal(dupRes.spooled ?? 0, 0);

    // 2. TOKEN_ROTATED -> immediate DataStackAuthError (401), 0 retries, 0 spooling
    fetchCalls = 0;
    mode = 'rotated';
    await assert.rejects(
      () => client.send({ eventId: 'rot_1', k: 1 }),
      (err: unknown) =>
        err instanceof DataStackAuthError &&
        err.code === 'TOKEN_ROTATED' &&
        err.statusCode === 401
    );
    assert.equal(fetchCalls, 1);
    assert.equal(client.status().spooledCount, 0);

    // 3. CLIENT_REVOKED -> immediate DataStackAuthError (403), 0 retries, 0 spooling
    fetchCalls = 0;
    mode = 'revoked';
    await assert.rejects(
      () => client.sendBatch([{ eventId: 'rev_1', k: 2 }]),
      (err: unknown) =>
        err instanceof DataStackAuthError &&
        err.code === 'CLIENT_REVOKED' &&
        err.statusCode === 403
    );
    assert.equal(fetchCalls, 1);
    assert.equal(client.status().spooledCount, 0);
  } finally {
    await client.disconnect();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R3-Phase-03 (BUG-07): Live WebSocket TOKEN_ROTATED, CLIENT_REVOKED, and STORAGE_QUOTA_EXCEEDED fail fast without spooling', async () => {
  let dbState: 'ok' | 'rotated' | 'revoked' | 'quota' = 'ok';
  const server = await startLiveIngestionSocketServer({
    verifyClientInDb: async () => {
      if (dbState === 'rotated') {
        return {
          allowed: false,
          code: 'TOKEN_ROTATED',
          reason: 'Token rotated by administrator',
        };
      }
      if (dbState === 'revoked') {
        return {
          allowed: false,
          code: 'CLIENT_REVOKED',
          reason: 'Client revoked by administrator',
        };
      }
      return { allowed: true, rateLimit: 200, storageQuotaMb: 10 };
    },
    checkStorageAdmission: async () => {
      if (dbState === 'quota') {
        return {
          allowed: false,
          code: 'STORAGE_QUOTA_EXCEEDED',
          reason: 'Client quota reached 10MB',
        };
      }
      return { allowed: true };
    },
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-r3-p03-ws-err-'));
  const token = signClientJwt('node_ws_errors');
  const client = new DataStack({
    serverUrl: server.url,
    apiUrl: 'http://127.0.0.1:1',
    token,
    autoConnect: false,
    enableHttpFallback: true,
    offlineSpoolEnabled: true,
    offlineSpoolDir: tmpDir,
    heartbeatIntervalMs: 5000,
  });

  try {
    await client.connect();

    // 1. Live WS batch_sync quota exceeded -> DataStackQuotaExceededError (507), 0 spooling
    dbState = 'quota';
    await assert.rejects(
      () => client.sendBatch([{ eventId: 'ws_q_1', v: 1 }]),
      (err: unknown) =>
        err instanceof DataStackQuotaExceededError &&
        err.code === 'STORAGE_QUOTA_EXCEEDED' &&
        err.statusCode === 507
    );
    assert.equal(client.status().spooledCount, 0);

    // 2. Live WS batch_sync TOKEN_ROTATED -> DataStackAuthError (401), 0 spooling
    dbState = 'rotated';
    await assert.rejects(
      () => client.sendBatch([{ eventId: 'ws_rot_1', v: 2 }]),
      (err: unknown) =>
        err instanceof DataStackAuthError &&
        err.code === 'TOKEN_ROTATED' &&
        err.statusCode === 401
    );
    assert.equal(client.status().spooledCount, 0);

    // 3. Reconnect while CLIENT_REVOKED -> connect_error maps to DataStackAuthError (403)
    dbState = 'revoked';
    await assert.rejects(
      () => client.connect(),
      (err: unknown) =>
        err instanceof DataStackAuthError &&
        err.code === 'CLIENT_REVOKED' &&
        err.statusCode === 403
    );
  } finally {
    await client.disconnect();
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
