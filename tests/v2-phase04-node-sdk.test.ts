import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DataStack,
  DataStackAuthError,
  DataStackConfigError,
  DataStackFileError,
  DataStackQuotaExceededError,
  SDK_VERSION,
  makeDeterministicFileEventId,
} from '../sdk/node/datastack';

function makeFakeJwt(clientId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ clientId, iat: 1700000000 })).toString('base64url');
  return `${header}.${payload}.fakesignature`;
}

test('V2-Phase-04 (1): Node.js / TypeScript SDK packaging metadata, JWT clientId verification, and V2-E12 config validation', async () => {
  const pkgRaw = await fs.readFile(
    path.join(process.cwd(), 'sdk', 'node', 'datastack', 'package.json'),
    'utf8'
  );
  const pkg = JSON.parse(pkgRaw) as {
    name: string;
    version: string;
    engines?: { node?: string };
  };
  assert.equal(pkg.name, '@datastack/sdk');
  assert.equal(pkg.version, '2.2.0');
  assert.equal(SDK_VERSION, '2.2.0');
  assert.equal(pkg.engines?.node, '>=20.0.0');

  const token = makeFakeJwt('billing_service');

  // Mismatched clientId vs JWT token claim must throw DataStackConfigError (V2-E12)
  assert.throws(
    () =>
      new DataStack({
        serverUrl: 'http://localhost:4000',
        apiUrl: 'http://localhost:3000',
        token,
        clientId: 'different_service',
        autoConnect: false,
      }),
    (err: unknown) =>
      err instanceof DataStackConfigError &&
      err.code === 'INVALID_SDK_CONFIG' &&
      /does not match JWT token subject/i.test(err.message)
  );

  // Invalid serverUrl scheme must throw DataStackConfigError
  assert.throws(
    () =>
      new DataStack({
        serverUrl: 'ftp://invalid-endpoint',
        apiUrl: 'http://localhost:3000',
        token,
        autoConnect: false,
      }),
    (err: unknown) => err instanceof DataStackConfigError
  );

  // Matching normalized clientId succeeds
  const client = new DataStack({
    serverUrl: 'http://localhost:4000',
    apiUrl: 'http://localhost:3000',
    token,
    clientId: '  BILLING_SERVICE  ',
    autoConnect: false,
    offlineSpoolEnabled: false,
  });
  assert.equal(client.clientId, 'billing_service');

  // Empty payload after metadata stripping throws DataStackConfigError
  await assert.rejects(
    () => client.send({ eventId: 'evt_only_meta', timestamp: '2026-11-20T00:00:00Z' }),
    (err: unknown) => err instanceof DataStackConfigError
  );
});

test('V2-Phase-04 (2): HTTP fallback single/batch send, recursive 413 batch splitting, 429 partial retry, and terminal V2-E12 error mapping', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-node-sdk-http-'));
  try {
    const token = makeFakeJwt('checkout_api');
    const calls: Array<{ body: Record<string, unknown> }> = [];
    let simulateMode:
      | 'ok'
      | 'split_413'
      | 'partial_429'
      | 'expired_401'
      | 'ip_403'
      | 'quota_507' = 'ok';
    let partial429Count = 0;

    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      calls.push({ body });

      if (simulateMode === 'expired_401') {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'CLIENT_TOKEN_EXPIRED',
            error: 'Client credential has expired',
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (simulateMode === 'ip_403') {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'CLIENT_IP_FORBIDDEN',
            error: 'Client IP not in allowlist',
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (simulateMode === 'quota_507') {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'STORAGE_QUOTA_EXCEEDED',
            error: 'Client storage quota exceeded',
          }),
          { status: 507, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const batch = Array.isArray(body.batch)
        ? (body.batch as Array<{ eventId: string; data: Record<string, unknown> }>)
        : null;

      if (simulateMode === 'split_413' && batch && batch.length > 2) {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'PAYLOAD_TOO_LARGE',
            error: 'Batch exceeds maxPayloadSizeKb',
          }),
          { status: 413, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (simulateMode === 'partial_429' && batch && partial429Count === 0) {
        partial429Count += 1;
        const rateLimitedIds = [batch[batch.length - 1].eventId];
        return new Response(
          JSON.stringify({
            success: true,
            accepted: batch.length - 1,
            rateLimitedEventIds: rateLimitedIds,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          eventId: body.eventId || 'evt_ok',
          accepted: batch ? batch.length : 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new DataStack({
      serverUrl: 'http://localhost:4000',
      apiUrl: 'http://localhost:3000',
      token,
      autoConnect: false,
      offlineSpoolDir: tmpDir,
      fetchImpl: mockFetch,
    });

    // 1. Single event via HTTP fallback
    const singleRes = await client.send({
      event_type: 'payment_authorized',
      amount: 99.5,
    });
    assert.equal(singleRes.success, true);
    assert.equal(singleRes.transport, 'http');
    assert.equal(singleRes.accepted, 1);

    // 2. Recursive 413 PAYLOAD_TOO_LARGE splitting (4 items -> split into 2 + 2)
    simulateMode = 'split_413';
    const splitRes = await client.sendBatch([
      { seq: 1 },
      { seq: 2 },
      { seq: 3 },
      { seq: 4 },
    ]);
    assert.equal(splitRes.success, true);
    assert.equal(splitRes.accepted, 4);

    // 3. Partial 429 RATE_LIMIT_EXCEEDED retry
    simulateMode = 'partial_429';
    const retryRes = await client.sendBatch([
      { item: 'a' },
      { item: 'b' },
      { item: 'c' },
    ]);
    assert.equal(retryRes.success, true);
    assert.equal(retryRes.accepted, 3);

    // 4. Terminal error mapping (401 CLIENT_TOKEN_EXPIRED, 403 CLIENT_IP_FORBIDDEN, 507 STORAGE_QUOTA_EXCEEDED)
    simulateMode = 'expired_401';
    await assert.rejects(
      () => client.send({ test: 'expired' }),
      (err: unknown) =>
        err instanceof DataStackAuthError &&
        err.code === 'CLIENT_TOKEN_EXPIRED' &&
        err.statusCode === 401
    );

    simulateMode = 'ip_403';
    await assert.rejects(
      () => client.send({ test: 'ip_blocked' }),
      (err: unknown) =>
        err instanceof DataStackAuthError &&
        err.code === 'CLIENT_IP_FORBIDDEN' &&
        err.statusCode === 403
    );

    simulateMode = 'quota_507';
    await assert.rejects(
      () => client.send({ test: 'quota_full' }),
      (err: unknown) =>
        err instanceof DataStackQuotaExceededError &&
        err.code === 'STORAGE_QUOTA_EXCEEDED' &&
        err.statusCode === 507
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('V2-Phase-04 (3): Offline disk spooling (.datastack_spool/spool.jsonl), flushSpool replay, and graceful shutdown drain', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-node-sdk-spool-'));
  try {
    const token = makeFakeJwt('iot_gateway');
    let networkOnline = false;
    const deliveredEvents: Array<Record<string, unknown>> = [];

    const mockFetch: typeof fetch = async (_input, init) => {
      if (!networkOnline) {
        throw new Error('ECONNREFUSED: Network unreachable');
      }
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      if (Array.isArray(body.batch)) {
        for (const item of body.batch as Array<Record<string, unknown>>) {
          deliveredEvents.push(item);
        }
        return new Response(
          JSON.stringify({
            success: true,
            accepted: body.batch.length,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      deliveredEvents.push(body);
      return new Response(
        JSON.stringify({
          success: true,
          accepted: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new DataStack({
      serverUrl: 'http://localhost:4000',
      apiUrl: 'http://localhost:3000',
      token,
      autoConnect: false,
      offlineSpoolEnabled: true,
      offlineSpoolDir: tmpDir,
      fetchImpl: mockFetch,
    });

    // While offline, events spool to disk
    const s1 = await client.send({ sensor: 'pressure', kpa: 101.3 });
    assert.equal(s1.success, true);
    assert.equal(s1.transport, 'spool');
    assert.equal(s1.spooled, 1);

    const s2 = await client.sendBatch([
      { sensor: 'temp', c: 22.1 },
      { sensor: 'temp', c: 22.4 },
    ]);
    assert.equal(s2.success, true);
    assert.equal(s2.transport, 'spool');
    assert.equal(s2.spooled, 2);
    assert.equal(client.status().spooledCount, 3);

    // Network comes back online -> shutdown(5000) automatically drains the spool
    networkOnline = true;
    const shutdownRes = await client.shutdown(5000);
    assert.equal(shutdownRes.drained, true);
    assert.equal(shutdownRes.remainingInFlight, 0);
    assert.equal(shutdownRes.remainingSpooled, 0);
    assert.equal(deliveredEvents.length, 3);
    assert.equal(client.status().spooledCount, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('V2-Phase-04 (4): Direct file ingestion (sendFile for .csv, .json, .jsonl) with deterministic SHA-256 eventId and /vcon/sdk multi-language tabs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-node-sdk-files-'));
  try {
    const token = makeFakeJwt('batch_importer');
    const receivedBatches: Array<Array<{ eventId: string; data: Record<string, unknown> }>> = [];

    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as {
        batch?: Array<{ eventId: string; data: Record<string, unknown> }>;
      };
      if (Array.isArray(body.batch)) {
        receivedBatches.push(body.batch);
      }
      return new Response(
        JSON.stringify({
          success: true,
          accepted: body.batch?.length ?? 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new DataStack({
      serverUrl: 'http://localhost:4000',
      apiUrl: 'http://localhost:3000',
      token,
      autoConnect: false,
      offlineSpoolEnabled: false,
      fetchImpl: mockFetch,
    });

    // 1. CSV file ingestion
    const csvPath = path.join(tmpDir, 'sensors.csv');
    await fs.writeFile(
      csvPath,
      'device,reading,status\ndev_01,42.5,OK\ndev_02,19.8,WARN\n',
      'utf8'
    );
    const csvRes = await client.sendFile(csvPath, { chunkSize: 10 });
    assert.equal(csvRes.success, true);
    assert.equal(csvRes.totalRows, 2);
    assert.equal(csvRes.acceptedRows, 2);
    assert.equal(receivedBatches[0][0].eventId, makeDeterministicFileEventId('sensors', 0, {
      device: 'dev_01',
      reading: '42.5',
      status: 'OK',
    }));

    // 2. JSONL file ingestion
    const jsonlPath = path.join(tmpDir, 'events.jsonl');
    await fs.writeFile(
      jsonlPath,
      '{"event":"login","user":"u1"}\n{"event":"logout","user":"u1"}\n',
      'utf8'
    );
    const jsonlRes = await client.sendFile(jsonlPath);
    assert.equal(jsonlRes.success, true);
    assert.equal(jsonlRes.totalRows, 2);
    assert.equal(jsonlRes.acceptedRows, 2);

    // 3. Unsupported extension throws DataStackFileError
    const badPath = path.join(tmpDir, 'notes.txt');
    await fs.writeFile(badPath, 'hello', 'utf8');
    await assert.rejects(
      () => client.sendFile(badPath),
      (err: unknown) => err instanceof DataStackFileError
    );

    // 4. Verify /vcon/sdk page includes Python SDK, Node.js / TypeScript SDK, and HTTP / cURL tabs
    const sdkPageSrc = await fs.readFile(
      path.join(process.cwd(), 'app', 'vcon', 'sdk', 'page.tsx'),
      'utf8'
    );
    assert.match(sdkPageSrc, /Python SDK \(v2\.2\.0\)/);
    assert.match(sdkPageSrc, /Node\.js \/ TypeScript SDK \(v2\.2\.0\)/);
    assert.match(sdkPageSrc, /@datastack\/sdk/);
    assert.match(sdkPageSrc, /datastack\.config\.json/);
    assert.match(sdkPageSrc, /await client\.shutdown\(5000\)/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
