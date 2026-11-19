import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  countMatchingBufferedEvents,
  DEFAULT_EDITABLE_SETTINGS,
  describeSettingsBridgeSync,
  extractContentDispositionFilename,
  formatEventTimeLabel,
  formatSessionExpiryLabel,
  getEventUtcDate,
  getUtcDateRangeForPreset,
  mapBridgeStatusToSocketUiState,
  matchesSelectedClientFolder,
  normalizeEditableSettings,
  parseEventTimestamp,
  resolvePublicEndpoints,
  SETTINGS_LIMITS,
  settingsToNumericDrafts,
  shouldRedirectProfileUnauthorized,
  summarizeHttpBatchResult,
  validateEditableSettingsDraft,
  validateSingleNumericSetting,
} from '../lib/vconUiHelpers';
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from '../core/auth/adminSession';
import {
  createInitialAdmin,
  resetAdminStateForTests,
} from '../core/auth/adminUsers';
import { DataBufferEngine } from '../core/data/buffer';
import { SDKManager } from '../core/sdk/sdkManager';
import { CSVStorageManager } from '../core/Storage/csvStorage';
import { GET as profileGet, PUT as profilePut } from '../app/api/auth/profile/route';
import { DELETE as deleteClientRoute } from '../app/api/clients/[id]/route';
import { GET as eventsGet, POST as eventsPost } from '../app/api/events/route';
import { POST as settingsPost } from '../app/api/settings/route';

test('BUG-D01: normalizeEditableSettings enforces exact /api/settings backend bounds', () => {
  const high = normalizeEditableSettings({
    maxEventsPerSec: 95000,
    maxPayloadSizeKb: 10240,
    batchFlushThreshold: 50000,
    batchFlushIntervalMs: 60000,
    fileRotationMb: 2048,
    enableIdempotency: false,
    autoPruneDays: 3650,
  });

  assert.equal(high.maxEventsPerSec, 95000);
  assert.equal(high.maxPayloadSizeKb, 10240);
  assert.equal(high.batchFlushThreshold, 50000);
  assert.equal(high.batchFlushIntervalMs, 60000);
  assert.equal(high.fileRotationMb, 2048);
  assert.equal(high.enableIdempotency, false);
  assert.equal(high.autoPruneDays, 3650);

  // Zero on positive-min fields clamps to min (1 / 100), while autoPruneDays keeps 0 ("never prune")
  const low = normalizeEditableSettings({
    maxEventsPerSec: 0,
    maxPayloadSizeKb: 0,
    batchFlushThreshold: 0,
    batchFlushIntervalMs: 10,
    fileRotationMb: 0,
    autoPruneDays: 0,
  });

  assert.equal(low.maxEventsPerSec, SETTINGS_LIMITS.maxEventsPerSec.min);
  assert.equal(low.maxPayloadSizeKb, SETTINGS_LIMITS.maxPayloadSizeKb.min);
  assert.equal(low.batchFlushThreshold, SETTINGS_LIMITS.batchFlushThreshold.min);
  assert.equal(low.batchFlushIntervalMs, SETTINGS_LIMITS.batchFlushIntervalMs.min);
  assert.equal(low.fileRotationMb, SETTINGS_LIMITS.fileRotationMb.min);
  assert.equal(low.autoPruneDays, 0);

  // Non-finite falls back to defaults
  const fallback = normalizeEditableSettings({
    maxEventsPerSec: Number.NaN,
    autoPruneDays: Number.NaN,
  });
  assert.equal(fallback.maxEventsPerSec, DEFAULT_EDITABLE_SETTINGS.maxEventsPerSec);
  assert.equal(fallback.autoPruneDays, DEFAULT_EDITABLE_SETTINGS.autoPruneDays);
});

test('BUG-D01 & BUG-D04: bridgeSync feedback and socket UI state accurately distinguish online, auth_error, and offline', () => {
  assert.equal(describeSettingsBridgeSync(undefined).level, 'success');
  assert.equal(describeSettingsBridgeSync({ attempted: true, ok: true }).level, 'success');

  const authFailure = describeSettingsBridgeSync({
    attempted: true,
    ok: false,
    status: 401,
    error: 'Unauthorized internal bridge token',
  });
  assert.equal(authFailure.level, 'error');
  assert.match(authFailure.title, /rejected sync/i);

  const offlineFailure = describeSettingsBridgeSync({
    attempted: true,
    ok: false,
    error: 'connect ECONNREFUSED 127.0.0.1:4000',
  });
  assert.equal(offlineFailure.level, 'warning');
  assert.match(offlineFailure.title, /unreachable/i);

  assert.equal(mapBridgeStatusToSocketUiState('online'), 'online');
  assert.equal(mapBridgeStatusToSocketUiState('auth_error'), 'auth_error');
  assert.equal(mapBridgeStatusToSocketUiState('offline'), 'offline');
  assert.equal(mapBridgeStatusToSocketUiState('error'), 'offline');
  assert.equal(mapBridgeStatusToSocketUiState(undefined), 'offline');
});

test('BUG-D03: getUtcDateRangeForPreset computes deterministic UTC ranges across day boundaries', () => {
  const ref = new Date('2026-11-19T02:15:00.000Z');
  assert.deepEqual(getUtcDateRangeForPreset('today', ref), {
    from: '2026-11-19',
    to: '2026-11-19',
  });
  assert.deepEqual(getUtcDateRangeForPreset('7d', ref), {
    from: '2026-11-13',
    to: '2026-11-19',
  });
  assert.deepEqual(getUtcDateRangeForPreset('30d', ref), {
    from: '2026-10-21',
    to: '2026-11-19',
  });
  assert.deepEqual(getUtcDateRangeForPreset('all', ref), {
    from: '',
    to: '',
  });
});

test('BUG-D03 & BUG-D05: timestamp formatting handles ISO & epoch-ms strings cleanly without Invalid Date', () => {
  const isoParsed = parseEventTimestamp('2026-11-18T12:34:56.000Z');
  assert.ok(isoParsed instanceof Date);
  assert.equal(isoParsed.toISOString(), '2026-11-18T12:34:56.000Z');

  const epochParsed = parseEventTimestamp('1700000000000');
  assert.ok(epochParsed instanceof Date);
  assert.equal(epochParsed.getTime(), 1700000000000);
  assert.notEqual(formatEventTimeLabel('1700000000000'), 'Invalid Date');
  assert.notEqual(formatEventTimeLabel('1700000000000'), '1700000000000');

  assert.equal(parseEventTimestamp('not-a-date'), null);
  assert.equal(formatEventTimeLabel('not-a-date'), 'not-a-date');
  assert.equal(formatEventTimeLabel(''), '—');
});

test('BUG-D03 & BUG-D06: matchesSelectedClientFolder and Content-Disposition parsing handle sanitized folders and quoted filenames', () => {
  assert.equal(matchesSelectedClientFolder('sensor_01', 'all'), true);
  assert.equal(matchesSelectedClientFolder('sensor_01', 'sensor_01'), true);
  assert.equal(matchesSelectedClientFolder('client_dev', 'client@dev'), true);
  assert.equal(matchesSelectedClientFolder('other_client', 'sensor_01'), false);

  assert.equal(
    extractContentDispositionFilename(
      'attachment; filename="datastack_export_sensor_01_2026-11-18.json"',
      'fallback.json'
    ),
    'datastack_export_sensor_01_2026-11-18.json'
  );
  assert.equal(
    extractContentDispositionFilename(null, 'fallback.csv'),
    'fallback.csv'
  );
});

test('FORENSIC BUG-09: parseEventTimestamp and getEventUtcDate handle integer and fractional epoch-seconds with backend parity', () => {
  const intSec = parseEventTimestamp('1735689600');
  assert.ok(intSec instanceof Date);
  assert.equal(intSec.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(getEventUtcDate('1735689600'), '2025-01-01');
  assert.notEqual(formatEventTimeLabel('1735689600'), '1735689600');

  const floatSec = parseEventTimestamp('1735689600.25');
  assert.ok(floatSec instanceof Date);
  assert.equal(floatSec.toISOString(), '2025-01-01T00:00:00.250Z');
  assert.equal(getEventUtcDate('1735689600.25'), '2025-01-01');
  assert.notEqual(formatEventTimeLabel('1735689600.25'), '1735689600.25');

  const msVal = parseEventTimestamp('1735689600500');
  assert.ok(msVal instanceof Date);
  assert.equal(msVal.toISOString(), '2025-01-01T00:00:00.500Z');
});

test('FORENSIC BUG-07: POST /api/events ingests batch and events arrays cleanly with accepted count and Simulator never falsifies counts', async () => {
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const origBaseStorageDir = CSVStorageManager.baseStorageDir;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'datastack-p5-bug07-'));
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  CSVStorageManager.baseStorageDir = tmpDir;
  await DataBufferEngine.shutdown();
  DataBufferEngine.setRedisClientForTests(null);

  try {
    const client = await SDKManager.registerClientAsync({
      clientId: 'p5_sim_client',
      name: 'Phase 05 Simulator Client',
      rateLimit: 500,
    });
    const ts = new Date().toISOString();

    // 1. Canonical { clientId, batch } payload (10 individual events)
    const batchItems = Array.from({ length: 10 }, (_, idx) => ({
      eventId: `p5_batch_${Date.now()}_${idx}`,
      timestamp: ts,
      data: { batch_index: idx + 1, sensor: 's1' },
    }));
    const reqBatch = new NextRequest('http://localhost:3000/api/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({ clientId: client.clientId, batch: batchItems }),
    });
    const resBatch = await eventsPost(reqBatch);
    assert.equal(resBatch.status, 200);
    const batchJson = await resBatch.json();
    assert.equal(batchJson.success, true);
    assert.equal(batchJson.accepted, 10);
    assert.equal(batchJson.processed, 10);
    assert.equal(batchJson.rejected, 0);

    // 2. Alias { clientId, events } payload also ingests individual events (never 1 wrapper event)
    const aliasItems = Array.from({ length: 4 }, (_, idx) => ({
      eventId: `p5_alias_${Date.now()}_${idx}`,
      timestamp: ts,
      data: { alias_index: idx + 1 },
    }));
    const reqAlias = new NextRequest('http://localhost:3000/api/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({ clientId: client.clientId, events: aliasItems }),
    });
    const resAlias = await eventsPost(reqAlias);
    assert.equal(resAlias.status, 200);
    const aliasJson = await resAlias.json();
    assert.equal(aliasJson.accepted, 4);
    assert.equal(aliasJson.processed, 4);

    // 3. summarizeHttpBatchResult never falsifies accepted=10 when server omits accepted/processed
    const fakeSingleRes = summarizeHttpBatchResult(
      true,
      { success: true, eventId: 'evt_wrapper', event: {} },
      10,
    );
    assert.equal(fakeSingleRes.accepted, 0);
    assert.equal(fakeSingleRes.rejected, 10);
    assert.equal(fakeSingleRes.status, 'Rejected');
    assert.equal(fakeSingleRes.level, 'error');

    const partialRes = summarizeHttpBatchResult(
      true,
      { success: true, accepted: 7, processed: 7, rejected: 3, duplicates: 0 },
      10,
    );
    assert.equal(partialRes.accepted, 7);
    assert.equal(partialRes.rejected, 3);
    assert.equal(partialRes.status, 'Rejected');
    assert.equal(partialRes.level, 'warning');

    const okRes = summarizeHttpBatchResult(true, batchJson, 10);
    assert.equal(okRes.accepted, 10);
    assert.equal(okRes.rejected, 0);
    assert.equal(okRes.status, 'Accepted');
    assert.equal(okRes.level, 'success');

    // Verify Simulator source sends canonical `batch:` and uses summarizeHttpBatchResult
    const simSrc = await fs.readFile(
      path.join(process.cwd(), 'app', 'vcon', 'simulator', 'page.tsx'),
      'utf-8',
    );
    assert.match(simSrc, /batch:\s*batchPayload/);
    assert.match(simSrc, /summarizeHttpBatchResult\(/);
    assert.doesNotMatch(simSrc, /res\.ok\s*\?\s*count\s*:\s*0/);
  } finally {
    await DataBufferEngine.flush();
    await DataBufferEngine.shutdown();
    CSVStorageManager.baseStorageDir = origBaseStorageDir;
    if (prevStorageDir === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('FORENSIC BUG-08 & BUG-14: filtered buffered matching, post-flush zeroing, UTC-today attribution, and multi-client GET /api/events scan beyond 5 files', async () => {
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;
  const origBaseStorageDir = CSVStorageManager.baseStorageDir;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'datastack-p5-bug08-14-'));
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  CSVStorageManager.baseStorageDir = tmpDir;
  process.env.INGESTION_INTERNAL_URL = 'http://127.0.0.1:1';
  await DataBufferEngine.shutdown();
  DataBufferEngine.setRedisClientForTests(null);

  try {
    const today = new Date().toISOString().slice(0, 10);
    resetAdminStateForTests();
    await createInitialAdmin('admin@datastack.dev', 'Phase05Pass123!');
    const secret = getAdminSessionSecret()!;
    const adminToken = await createAdminSessionToken(
      'admin@datastack.dev',
      secret,
      Date.now() + 3600_000,
      1,
    );

    // 1. Pure filtered buffer matcher prevents silent empty export downloads on non-matching client/date slices
    const syntheticSummary = {
      total: 8,
      totalQueued: 8,
      unattributedCount: 0,
      truncated: false,
      buckets: [
        { clientId: 'alpha_client', date: today, count: 3 },
        { clientId: 'alpha_client', date: '2025-01-01', count: 5 },
      ],
    };

    const otherClientMatch = countMatchingBufferedEvents(syntheticSummary, {
      clientId: 'beta_client',
    });
    assert.equal(otherClientMatch.matchingCount, 0);
    assert.equal(otherClientMatch.hasPotentialBuffered, false);

    const outOfRangeMatch = countMatchingBufferedEvents(syntheticSummary, {
      clientId: 'alpha_client',
      fromDate: '2024-01-01',
      toDate: '2024-12-31',
    });
    assert.equal(outOfRangeMatch.matchingCount, 0);
    assert.equal(outOfRangeMatch.hasPotentialBuffered, false);

    const todayOnlyMatch = countMatchingBufferedEvents(syntheticSummary, {
      clientId: 'all',
      fromDate: today,
      toDate: today,
    });
    assert.equal(todayOnlyMatch.matchingCount, 3);
    assert.equal(todayOnlyMatch.hasPotentialBuffered, true);

    // 2. Write CSV partitions for 8 distinct clients (plus 6 extra dated files on client_01) to prove BUG-14 scan exceeds old 5-file cap
    for (let d = 1; d <= 6; d += 1) {
      await CSVStorageManager.appendBatch([
        {
          clientId: 'p5_client_01',
          eventId: `evt_c1_old_${d}`,
          timestamp: `2026-10-0${d}T10:00:00.000Z`,
          payload: JSON.stringify({ n: d }),
        },
      ]);
    }
    for (let i = 1; i <= 8; i += 1) {
      const cid = `p5_client_0${i}`;
      await CSVStorageManager.appendBatch([
        {
          clientId: cid,
          eventId: `evt_${cid}_latest`,
          timestamp: `${today}T12:00:0${i}.000Z`,
          payload: JSON.stringify({ client: cid }),
        },
      ]);
    }

    // 3. Push 2 UTC-today buffered events + 3 backdated buffered events into RAM buffer
    await DataBufferEngine.pushBatchAsync([
      {
        clientId: 'p5_buf_client',
        eventId: 'buf_today_1',
        timestamp: `${today}T13:00:01.000Z`,
        payload: '{"kind":"today"}',
      },
      {
        clientId: 'p5_buf_client',
        eventId: 'buf_today_2',
        timestamp: `${today}T13:00:02.000Z`,
        payload: '{"kind":"today"}',
      },
      {
        clientId: 'p5_buf_client',
        eventId: 'buf_old_1',
        timestamp: '2025-02-01T08:00:00.000Z',
        payload: '{"kind":"backdated"}',
      },
      {
        clientId: 'p5_buf_client',
        eventId: 'buf_old_2',
        timestamp: '2025-02-01T08:00:01.000Z',
        payload: '{"kind":"backdated"}',
      },
      {
        clientId: 'p5_buf_client',
        eventId: 'buf_old_3',
        timestamp: '2025-02-01T08:00:02.000Z',
        payload: '{"kind":"backdated"}',
      },
    ]);

    const reqAll = new NextRequest(
      'http://localhost:3000/api/events?limit=25&includeBufferedSummary=true',
      {
        headers: { cookie: `datastack_admin_session=${adminToken}` },
      },
    );
    const resAll = await eventsGet(reqAll);
    assert.equal(resAll.status, 200);
    const allJson = await resAll.json();

    // All 8 disk clients must be represented in GET /api/events (past the old 5-file global cap)
    const seenClients = new Set<string>(
      (allJson.events as Array<{ clientId: string }>).map((e) => e.clientId),
    );
    for (let i = 1; i <= 8; i += 1) {
      assert.ok(
        seenClients.has(`p5_client_0${i}`),
        `Expected p5_client_0${i} to be visible in GET /api/events multi-client scan`,
      );
    }

    // bufferedSummary accurately separates 2 today events from 3 backdated events
    assert.ok(allJson.bufferedSummary);
    assert.equal(allJson.bufferedSummary.total, 5);
    const todayBuffered = countMatchingBufferedEvents(allJson.bufferedSummary, {
      clientId: 'all',
      fromDate: today,
      toDate: today,
    });
    assert.equal(todayBuffered.matchingCount, 2);

    // After flush, GET /api/events?bufferedOnly=true drops to 0 (never double-counting flushed recentEvents)
    await DataBufferEngine.flush();
    const reqBufAfterFlush = new NextRequest(
      'http://localhost:3000/api/events?bufferedOnly=true&limit=1',
      {
        headers: { cookie: `datastack_admin_session=${adminToken}` },
      },
    );
    const resBufAfterFlush = await eventsGet(reqBufAfterFlush);
    assert.equal(resBufAfterFlush.status, 200);
    const bufAfterJson = await resBufAfterFlush.json();
    assert.equal(bufAfterJson.bufferedSummary.total, 0);
    assert.equal(bufAfterJson.bufferedSummary.buckets.length, 0);

    // Verify ExportWorkspace & DashboardOverview refresh caches after export
    const exportSrc = await fs.readFile(
      path.join(process.cwd(), 'components', 'sections', 'ExportWorkspace.tsx'),
      'utf-8',
    );
    assert.match(exportSrc, /countMatchingBufferedEvents\(/);
    assert.match(exportSrc, /await refreshExportData\(\)/);

    const dashSrc = await fs.readFile(
      path.join(process.cwd(), 'components', 'sections', 'DashboardOverview.tsx'),
      'utf-8',
    );
    assert.match(dashSrc, /includeBufferedSummary=true/);
    assert.match(dashSrc, /await refresh\(\)/);
  } finally {
    await DataBufferEngine.flush();
    await DataBufferEngine.shutdown();
    CSVStorageManager.baseStorageDir = origBaseStorageDir;
    if (prevStorageDir === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
    else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('FORENSIC BUG-10: /api/auth/profile returns explicit SESSION_EXPIRED vs INVALID_PASSWORD codes and ProfileWorkspace formats full expiry date+time', async () => {
  const prevDbUrl = process.env.DATABASE_URL;
  const prevDemoFlag = process.env.DATASTACK_ALLOW_DEMO_ADMIN;
  delete process.env.DATABASE_URL;
  process.env.DATASTACK_ALLOW_DEMO_ADMIN = 'false';

  try {
    resetAdminStateForTests();
    await createInitialAdmin('p6-admin@datastack.dev', 'Phase06Pass123!');
    const secret = getAdminSessionSecret()!;
    const validToken = await createAdminSessionToken(
      'p6-admin@datastack.dev',
      secret,
      Date.now() + 30 * 86_400_000,
      1,
    );

    // 1. Missing/expired session on GET & PUT returns 401 with code: SESSION_EXPIRED
    const unauthGet = await profileGet(
      new NextRequest('http://localhost:3000/api/auth/profile'),
    );
    assert.equal(unauthGet.status, 401);
    const unauthGetJson = await unauthGet.json();
    assert.equal(unauthGetJson.code, 'SESSION_EXPIRED');

    const unauthPut = await profilePut(
      new NextRequest('http://localhost:3000/api/auth/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'p6-admin@datastack.dev',
          currentPassword: 'Phase06Pass123!',
        }),
      }),
    );
    assert.equal(unauthPut.status, 401);
    const unauthPutJson = await unauthPut.json();
    assert.equal(unauthPutJson.code, 'SESSION_EXPIRED');
    assert.equal(shouldRedirectProfileUnauthorized(401, unauthPutJson), true);

    // 2. Wrong currentPassword on valid session returns 401 with code: INVALID_PASSWORD (no redirect)
    const wrongPassRes = await profilePut(
      new NextRequest('http://localhost:3000/api/auth/profile', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: `datastack_admin_session=${validToken}`,
        },
        body: JSON.stringify({
          email: 'p6-admin@datastack.dev',
          currentPassword: 'WrongPassword999!',
        }),
      }),
    );
    assert.equal(wrongPassRes.status, 401);
    const wrongPassJson = await wrongPassRes.json();
    assert.equal(wrongPassJson.code, 'INVALID_PASSWORD');
    assert.equal(shouldRedirectProfileUnauthorized(401, wrongPassJson), false);

    // 3. Session expiry label includes calendar date (not time-only)
    const expiryLabel = formatSessionExpiryLabel('2026-12-19T14:30:00.000Z');
    assert.match(expiryLabel, /\d{1,2}/);
    assert.ok(
      expiryLabel.length > 5 && /[A-Za-z]|\d{1,2}\/\d{1,2}/.test(expiryLabel),
      `Expected date+time in session expiry label, got: ${expiryLabel}`,
    );
    assert.equal(formatSessionExpiryLabel(''), 'Active');

    // 4. Dead code `response.status === 401 && !currentPassword` is removed from ProfileWorkspace
    const profileUiSrc = await fs.readFile(
      path.join(process.cwd(), 'components', 'sections', 'ProfileWorkspace.tsx'),
      'utf-8',
    );
    assert.doesNotMatch(profileUiSrc, /response\.status === 401 && !currentPassword/);
    assert.match(profileUiSrc, /shouldRedirectProfileUnauthorized\(/);
    assert.match(profileUiSrc, /formatSessionExpiryLabel\(/);
  } finally {
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    if (prevDemoFlag === undefined) delete process.env.DATASTACK_ALLOW_DEMO_ADMIN;
    else process.env.DATASTACK_ALLOW_DEMO_ADMIN = prevDemoFlag;
    resetAdminStateForTests();
  }
});

test('FORENSIC BUG-11: ClientsTable exposes ?purgeFiles=true opt-in checkbox on delete and omits unused Secret key row', async () => {
  const clientsTableSrc = await fs.readFile(
    path.join(process.cwd(), 'components', 'sections', 'ClientsTable.tsx'),
    'utf-8',
  );
  assert.match(clientsTableSrc, /\?purgeFiles=true/);
  assert.match(clientsTableSrc, /Also purge stored CSV files for this client/);
  assert.doesNotMatch(clientsTableSrc, /label="Secret key"/);
});

test('FORENSIC BUG-12: Settings numeric drafts preserve empty inputs and report explicit validation errors without silent clamping', async () => {
  const validDrafts = settingsToNumericDrafts(DEFAULT_EDITABLE_SETTINGS);
  const okResult = validateEditableSettingsDraft(validDrafts, true);
  assert.equal(okResult.valid, true);
  assert.deepEqual(okResult.values, DEFAULT_EDITABLE_SETTINGS);

  // Empty string returns explicit required error (never resets to 0)
  const emptyCheck = validateSingleNumericSetting('maxEventsPerSec', '');
  assert.equal(emptyCheck.valid, false);
  assert.match(emptyCheck.error, /required/i);

  // Out-of-bounds value returns explicit range error (never silently clamped)
  const invalidDrafts = {
    ...validDrafts,
    batchFlushIntervalMs: '50',
    fileRotationMb: '99999',
  };
  const badResult = validateEditableSettingsDraft(invalidDrafts, false);
  assert.equal(badResult.valid, false);
  assert.equal(badResult.firstInvalidKey, 'batchFlushIntervalMs');
  assert.match(badResult.errors.batchFlushIntervalMs || '', /100/);
  assert.match(badResult.errors.fileRotationMb || '', /2,048|2048/);

  // autoPruneDays = "0" ("never prune") remains explicitly valid
  const zeroPrune = validateSingleNumericSetting('autoPruneDays', '0');
  assert.equal(zeroPrune.valid, true);
  if (zeroPrune.valid) assert.equal(zeroPrune.value, 0);

  const settingsUiSrc = await fs.readFile(
    path.join(process.cwd(), 'components', 'sections', 'SettingsWorkspace.tsx'),
    'utf-8',
  );
  assert.match(settingsUiSrc, /validateEditableSettingsDraft\(/);
  assert.match(settingsUiSrc, /Socket port \(PORT_SOCKET\)/);
  assert.match(settingsUiSrc, /noValidate/);
});

test('FORENSIC BUG-13: resolvePublicEndpoints unifies Settings, Simulator, and SDK Guide URLs across direct dev and port-80 localhost proxies', async () => {
  // 1. Direct Next.js dev on :3000 maps ingestion to :serverPort
  const directDev = resolvePublicEndpoints(
    {
      protocol: 'http:',
      hostname: 'localhost',
      host: 'localhost:3000',
      port: '3000',
      origin: 'http://localhost:3000',
    },
    4000,
  );
  assert.deepEqual(directDev, {
    apiUrl: 'http://localhost:3000',
    serverUrl: 'http://localhost:4000',
    webSocketUrl: 'ws://localhost:4000',
  });

  // 2. Reverse-proxied localhost on port 80 stays same-origin (no bogus :4000)
  const localProxy = resolvePublicEndpoints(
    {
      protocol: 'http:',
      hostname: 'localhost',
      host: 'localhost',
      port: '',
      origin: 'http://localhost',
    },
    4000,
  );
  assert.deepEqual(localProxy, {
    apiUrl: 'http://localhost',
    serverUrl: 'http://localhost',
    webSocketUrl: 'ws://localhost',
  });

  // 3. HTTPS production domain uses wss:// and same-origin
  const prodHttps = resolvePublicEndpoints(
    {
      protocol: 'https:',
      hostname: 'data.example.com',
      host: 'data.example.com',
      port: '',
      origin: 'https://data.example.com',
    },
    4000,
  );
  assert.deepEqual(prodHttps, {
    apiUrl: 'https://data.example.com',
    serverUrl: 'https://data.example.com',
    webSocketUrl: 'wss://data.example.com',
  });

  // All 3 UI pages import and use resolvePublicEndpoints
  for (const rel of [
    path.join('components', 'sections', 'SettingsWorkspace.tsx'),
    path.join('app', 'vcon', 'sdk', 'page.tsx'),
    path.join('app', 'vcon', 'simulator', 'page.tsx'),
  ]) {
    const src = await fs.readFile(path.join(process.cwd(), rel), 'utf-8');
    assert.match(src, /resolvePublicEndpoints\(/, `${rel} must use resolvePublicEndpoints`);
  }
});

test('R2 PHASE-03 BUG-03: POST /api/settings returns normalized bridgeSync contract and describeSettingsBridgeSync handles both synced and attempted/ok shapes', async () => {
  const prevDbUrl = process.env.DATABASE_URL;
  const prevIngestionUrl = process.env.INGESTION_INTERNAL_URL;
  delete process.env.DATABASE_URL;
  process.env.INGESTION_INTERNAL_URL = 'http://127.0.0.1:1';

  try {
    resetAdminStateForTests();
    await createInitialAdmin('p3-settings@datastack.dev', 'Phase03Pass123!');
    const secret = getAdminSessionSecret()!;
    const adminToken = await createAdminSessionToken(
      'p3-settings@datastack.dev',
      secret,
      Date.now() + 3600_000,
      1,
    );

    const res = await settingsPost(
      new NextRequest('http://localhost:3000/api/settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `datastack_admin_session=${adminToken}`,
        },
        body: JSON.stringify({ maxEventsPerSec: 150 }),
      }),
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.bridgeSync, 'POST /api/settings must return bridgeSync status');
    assert.equal(json.bridgeSync.attempted, true);
    assert.equal(json.bridgeSync.ok, false);
    assert.equal(json.bridgeSync.synced, false);

    // describeSettingsBridgeSync must produce a warning for offline bridgeSync from backend
    const uiFeedback = describeSettingsBridgeSync(json.bridgeSync);
    assert.equal(uiFeedback.level, 'warning');
    assert.match(uiFeedback.title, /unreachable/i);

    // Also accepts legacy { synced } shape directly without attempted/ok
    assert.equal(describeSettingsBridgeSync({ synced: true }).level, 'success');
    assert.equal(
      describeSettingsBridgeSync({ synced: false, status: 401 }).level,
      'error',
    );
    assert.equal(
      describeSettingsBridgeSync({ synced: false, error: 'timeout' }).level,
      'warning',
    );

    const settingsUiSrc = await fs.readFile(
      path.join(process.cwd(), 'components', 'sections', 'SettingsWorkspace.tsx'),
      'utf-8',
    );
    assert.match(settingsUiSrc, /data\.bridgeSync\?\.ok \?\? data\.bridgeSync\?\.synced/);
  } finally {
    await DataBufferEngine.shutdown();
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    if (prevIngestionUrl === undefined) delete process.env.INGESTION_INTERNAL_URL;
    else process.env.INGESTION_INTERNAL_URL = prevIngestionUrl;
    resetAdminStateForTests();
  }
});

test('R2 PHASE-03 BUG-04: DELETE /api/clients/[id]?purgeFiles=true returns exact integer purgedFiles count', async () => {
  const prevDbUrl = process.env.DATABASE_URL;
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const origBaseStorageDir = CSVStorageManager.baseStorageDir;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'datastack-r2p3-bug04-'));
  delete process.env.DATABASE_URL;
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  CSVStorageManager.baseStorageDir = tmpDir;

  try {
    resetAdminStateForTests();
    await createInitialAdmin('p3-purge@datastack.dev', 'Phase03Pass123!');
    const secret = getAdminSessionSecret()!;
    const adminToken = await createAdminSessionToken(
      'p3-purge@datastack.dev',
      secret,
      Date.now() + 3600_000,
      1,
    );

    const clientPurge = await SDKManager.registerClientAsync({
      clientId: 'p3_purge_me',
      name: 'Purge Me',
      rateLimit: 100,
    });
    await CSVStorageManager.appendBatch([
      {
        clientId: clientPurge.clientId,
        eventId: 'purge-e1',
        timestamp: '2026-11-18T10:00:00.000Z',
        payload: '{"a":1}',
      },
      {
        clientId: clientPurge.clientId,
        eventId: 'purge-e2',
        timestamp: '2026-11-19T10:00:00.000Z',
        payload: '{"a":2}',
      },
    ]);

    const delPurgeRes = await deleteClientRoute(
      new NextRequest(
        `http://localhost:3000/api/clients/${clientPurge.clientId}?purgeFiles=true`,
        {
          method: 'DELETE',
          headers: { cookie: `datastack_admin_session=${adminToken}` },
        },
      ),
      { params: Promise.resolve({ id: clientPurge.clientId }) },
    );
    assert.equal(delPurgeRes.status, 200);
    const delPurgeJson = await delPurgeRes.json();
    assert.equal(delPurgeJson.success, true);
    assert.equal(delPurgeJson.purgedFiles, 2);

    // Deleting without ?purgeFiles=true returns purgedFiles: 0 and retains CSV files
    const clientKeep = await SDKManager.registerClientAsync({
      clientId: 'p3_keep_files',
      name: 'Keep Files',
      rateLimit: 100,
    });
    await CSVStorageManager.appendBatch([
      {
        clientId: clientKeep.clientId,
        eventId: 'keep-e1',
        timestamp: '2026-11-19T10:00:00.000Z',
        payload: '{"keep":true}',
      },
    ]);
    const delKeepRes = await deleteClientRoute(
      new NextRequest(
        `http://localhost:3000/api/clients/${clientKeep.clientId}`,
        {
          method: 'DELETE',
          headers: { cookie: `datastack_admin_session=${adminToken}` },
        },
      ),
      { params: Promise.resolve({ id: clientKeep.clientId }) },
    );
    assert.equal(delKeepRes.status, 200);
    const delKeepJson = await delKeepRes.json();
    assert.equal(delKeepJson.purgedFiles, 0);
    const remaining = await CSVStorageManager.listAllFilesAsync();
    assert.equal(
      remaining.filter((f) => f.clientId === clientKeep.clientId).length,
      1,
    );
  } finally {
    await DataBufferEngine.shutdown();
    CSVStorageManager.baseStorageDir = origBaseStorageDir;
    if (prevStorageDir === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpDir, { recursive: true, force: true });
    resetAdminStateForTests();
  }
});

test('R2 PHASE-03 BUG-15: /vcon/sdk clears previous client JWT synchronously on switch and guards config copy while loadingToken is true', async () => {
  const sdkSrc = await fs.readFile(
    path.join(process.cwd(), 'app', 'vcon', 'sdk', 'page.tsx'),
    'utf-8',
  );
  assert.match(sdkSrc, /setSelectedClientToken\(''\);\s*\n\s*setLoadingToken\(true\);/);
  const disabledMatches = sdkSrc.match(/disabled=\{loadingToken\}/g) || [];
  assert.ok(
    disabledMatches.length >= 3,
    `Expected Copy Token and both Copy Config buttons to be guarded with disabled={loadingToken}, found ${disabledMatches.length}`,
  );
});

