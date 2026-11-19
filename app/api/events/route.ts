import { SettingsManager } from '@/core/adminSettings/settingsManager';
import { verifyRequestAdminSession } from '@/core/auth/adminUsers';
import { AuthService } from '@/core/auth/jwt';
import { DataBufferEngine, REDIS_BUFFER_KEY } from '@/core/data/buffer';
import { SDKManager } from '@/core/sdk/sdkManager';
import {
  SecurityEngine,
  getInternalIngestionHeaders,
} from '@/core/Security/security';
import {
  CSVStorageManager,
  type DataEvent,
  type StorageFileMeta,
} from '@/core/Storage/csvStorage';
import { parse } from 'csv-parse';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { requireAdminApiSession } from '@/lib/adminAuth';
import type { BufferedBucket, BufferedSummary } from '@/lib/vconUiHelpers';

const SESSION_COOKIE = 'datastack_admin_session';
const SINGLE_EVENT_ENVELOPE_KEYS = new Set(['eventId', 'timestamp', 'data', 'clientId']);
const MAX_SINGLE_CLIENT_SCAN_FILES = 10;
const MAX_ALL_CLIENTS_PER_CLIENT_FILES = 2;
const MAX_ALL_CLIENTS_TOTAL_SCAN_FILES = 50;

function generateFallbackEventId(): string {
  return `evt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function extractSingleHttpEventData(rawBody: Record<string, unknown>): unknown {
  if (rawBody.data !== undefined) {
    const keys = Object.keys(rawBody);
    if (keys.every((k) => SINGLE_EVENT_ENVELOPE_KEYS.has(k))) {
      return rawBody.data;
    }
    return rawBody;
  }

  const stripped: Record<string, unknown> = {};
  let hasNonEnvelopeKey = false;
  for (const [k, v] of Object.entries(rawBody)) {
    if (k === 'eventId' || k === 'timestamp' || k === 'clientId') {
      continue;
    }
    hasNonEnvelopeKey = true;
    stripped[k] = v;
  }
  return hasNonEnvelopeKey ? stripped : {};
}

function parseTimestampMs(raw: string): number {
  const trimmed = String(raw || '').trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return num < 1e11 ? num * 1000 : num;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function resolveEventUtcDate(rawTimestamp: string): string {
  const ms = parseTimestampMs(rawTimestamp);
  if (Number.isFinite(ms)) {
    const parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function selectRecentPartitionFiles(
  allFiles: StorageFileMeta[],
  normClientId?: string,
  sanitizedDir?: string,
): StorageFileMeta[] {
  const matching = allFiles
    .filter(
      (f) =>
        !normClientId ||
        f.clientId === normClientId ||
        f.clientId === sanitizedDir,
    )
    .sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

  if (normClientId) {
    return matching.slice(0, MAX_SINGLE_CLIENT_SCAN_FILES);
  }

  // Multi-client fair scan: take up to 2 newest partitions per active client (capped at 50 files total)
  // so clients beyond the 5th most-recently-modified file are never silently hidden.
  const perClientCounts = new Map<string, number>();
  const selected: StorageFileMeta[] = [];

  for (const file of matching) {
    const currentCount = perClientCounts.get(file.clientId) ?? 0;
    if (currentCount >= MAX_ALL_CLIENTS_PER_CLIENT_FILES) continue;
    perClientCounts.set(file.clientId, currentCount + 1);
    selected.push(file);
    if (selected.length >= MAX_ALL_CLIENTS_TOTAL_SCAN_FILES) break;
  }

  return selected;
}

async function getPendingBufferedSummary(
  ingestionBaseUrl: string,
  filterClientId?: string,
): Promise<{ events: DataEvent[]; summary: BufferedSummary }> {
  const bufferStats = await DataBufferEngine.getBufferStatsAsync();
  const recentLimit = DataBufferEngine.getRecentLimit();
  const pending: DataEvent[] = [];
  let totalQueued = bufferStats.localBufferSize + bufferStats.redisBufferSize;

  // 1. Read exact unflushed Redis queue (when Redis is enabled & connected)
  const redis = DataBufferEngine.getRedisClient();
  if (redis && bufferStats.redisBufferSize > 0) {
    try {
      const cap = Math.min(recentLimit, bufferStats.redisBufferSize);
      const rawItems = await redis.lrange(REDIS_BUFFER_KEY, 0, cap - 1);
      for (const raw of rawItems) {
        try {
          const parsed = JSON.parse(raw) as DataEvent;
          if (!parsed || !parsed.eventId) continue;
          pending.push(parsed);
        } catch {
          // Skip malformed queued item
        }
      }
    } catch {
      // Fall back to local buffer telemetry
    }
  }

  // 2. Read Port 3000 exact unflushed RAM queue snapshot
  if (bufferStats.localBufferSize > 0) {
    const localPending = DataBufferEngine.getLocalBufferSnapshot(recentLimit);
    pending.push(...localPending);
  }

  // 3. When Redis is not enabled or temporarily disconnected, Port 4000 `/internal/recent` serves its unflushed RAM `bufferQueue`
  if (!bufferStats.redisEnabled || !bufferStats.redisConnected) {
    try {
      const qs = new URLSearchParams({ limit: String(recentLimit) });
      const res = await fetch(`${ingestionBaseUrl}/internal/recent?${qs.toString()}`, {
        headers: getInternalIngestionHeaders(),
        cache: 'no-store',
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.events) && data.events.length > 0) {
          pending.push(...(data.events as DataEvent[]));
          totalQueued += data.events.length;
        }
      }
    } catch {
      // Port 4000 may not be running in isolated single-process dev mode
    }
  }

  const seen = new Set<string>();
  const dedupedAll: DataEvent[] = [];
  const filteredEvents: DataEvent[] = [];
  const bucketMap = new Map<string, BufferedBucket>();
  const sanitizedFilter = filterClientId
    ? CSVStorageManager.sanitizeClientId(filterClientId)
    : undefined;

  for (const evt of pending) {
    if (!evt || !evt.eventId) continue;
    const normEvtClient = SDKManager.normalizeClientId(evt.clientId) || evt.clientId;
    const dedupeKey = `${normEvtClient}:${evt.eventId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    dedupedAll.push(evt);

    const matchesFilter =
      !filterClientId ||
      normEvtClient === filterClientId ||
      evt.clientId === filterClientId ||
      evt.clientId === sanitizedFilter;

    if (matchesFilter) {
      filteredEvents.push(evt);
      const utcDate = resolveEventUtcDate(evt.timestamp);
      const bucketKey = `${normEvtClient}|${utcDate}`;
      const existing = bucketMap.get(bucketKey);
      if (existing) {
        existing.count += 1;
      } else {
        bucketMap.set(bucketKey, {
          clientId: normEvtClient,
          date: utcDate,
          count: 1,
        });
      }
    }
  }

  const effectiveTotalQueued = Math.max(totalQueued, dedupedAll.length);
  const unattributedCount = Math.max(0, effectiveTotalQueued - dedupedAll.length);

  return {
    events: filteredEvents,
    summary: {
      total: filteredEvents.length,
      totalQueued: filterClientId
        ? filteredEvents.length + unattributedCount
        : effectiveTotalQueued,
      unattributedCount,
      truncated: unattributedCount > 0,
      buckets: Array.from(bucketMap.values()),
    },
  };
}

async function getRecentStoredEvents(
  limit: number,
  clientId?: string,
): Promise<DataEvent[]> {
  const normClientId = clientId && clientId !== 'all' ? SDKManager.normalizeClientId(clientId) : undefined;
  const sanitizedDir = normClientId ? CSVStorageManager.sanitizeClientId(normClientId) : undefined;
  const allFiles = await CSVStorageManager.listAllFilesAsync();
  const files = selectRecentPartitionFiles(allFiles, normClientId, sanitizedDir);

  const collected: DataEvent[] = [];

  for (const file of files) {
    const fileTail: DataEvent[] = [];
    const fileStream = createReadStream(file.filePath);
    const parser = fileStream.pipe(
      parse({ columns: true, skip_empty_lines: true, bom: true }),
    );

    try {
      for await (const record of parser as AsyncIterable<
        Record<string, string>
      >) {
        if (!record.eventId) continue;
        if (fileTail.length >= limit) {
          fileTail.shift();
        }
        fileTail.push({
          clientId: record.clientId || file.clientId,
          eventId: record.eventId,
          timestamp: record.timestamp || `${file.date}T00:00:00.000Z`,
          payload: record.payload || '',
        });
      }
    } catch (err) {
      console.warn(`[API /events] Failed reading CSV partition ${file.filePath}:`, err);
    } finally {
      if (!parser.destroyed) parser.destroy();
      if (!fileStream.destroyed) fileStream.destroy();
    }

    if (fileTail.length > 0) {
      collected.push(...fileTail);
    }
  }

  return collected;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminApiSession(req);
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const { searchParams } = new URL(req.url);
    const rawClientId = searchParams.get('clientId');
    const clientId =
      rawClientId && rawClientId !== 'all'
        ? SDKManager.normalizeClientId(rawClientId) || undefined
        : undefined;
    const limit = Math.min(2000, Math.max(1, Number(searchParams.get('limit')) || 50));
    const bufferedOnly = searchParams.get('bufferedOnly') === 'true';
    const includeBufferedSummary =
      bufferedOnly || searchParams.get('includeBufferedSummary') === 'true';

    await SettingsManager.getSettingsAsync();
    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || 'http://127.0.0.1:4000'
    ).replace(/\/$/, '');

    if (bufferedOnly) {
      const pendingResult = await getPendingBufferedSummary(ingestionBaseUrl, clientId);
      const sortedPending = [...pendingResult.events].sort((a, b) => {
        const aMs = parseTimestampMs(a.timestamp);
        const bMs = parseTimestampMs(b.timestamp);
        if (aMs !== bMs) return bMs - aMs;
        return b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0;
      });
      const events = sortedPending.slice(0, limit);
      return NextResponse.json({
        events,
        count: events.length,
        bufferedSummary: pendingResult.summary,
      });
    }

    const bufferedEvents = await DataBufferEngine.getRecentEventsAsync(limit, clientId);
    let socketBufferedEvents: DataEvent[] = [];

    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (clientId) qs.set('clientId', clientId);
      const res = await fetch(`${ingestionBaseUrl}/internal/recent?${qs.toString()}`, {
        headers: getInternalIngestionHeaders(),
        cache: 'no-store',
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.events)) {
          socketBufferedEvents = data.events;
        }
      }
    } catch {
      // Port 4000 may not be running in isolated single-process dev mode
    }

    const [storedEvents, pendingResult] = await Promise.all([
      getRecentStoredEvents(limit, clientId),
      includeBufferedSummary
        ? getPendingBufferedSummary(ingestionBaseUrl, clientId)
        : Promise.resolve(null),
    ]);

    const seenIds = new Set<string>();
    const merged: DataEvent[] = [];

    for (const evt of [...bufferedEvents, ...socketBufferedEvents, ...storedEvents]) {
      if (!evt.eventId) continue;
      const normEvtClient = SDKManager.normalizeClientId(evt.clientId) || evt.clientId;
      const dedupeKey = `${normEvtClient}:${evt.eventId}`;
      if (seenIds.has(dedupeKey)) continue;
      seenIds.add(dedupeKey);
      merged.push(evt);
    }

    merged.sort((a, b) => {
      const aMs = parseTimestampMs(a.timestamp);
      const bMs = parseTimestampMs(b.timestamp);
      if (aMs !== bMs) return bMs - aMs;
      return b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0;
    });
    const events = merged.slice(0, limit);

    return NextResponse.json({
      events,
      count: events.length,
      ...(pendingResult ? { bufferedSummary: pendingResult.summary } : {}),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Events retrieval failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const settings = await SettingsManager.getSettingsAsync();

    // Verify either Client Bearer JWT or Admin Session Cookie
    const authHeader = req.headers.get('authorization');
    const sessionCookie = req.cookies.get(SESSION_COOKIE)?.value;

    let tokenClientId: string | null = null;
    let tokenRateLimit: number | undefined;
    let rawBearerToken: string | null = null;

    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      rawBearerToken = authHeader.slice(7).trim();
      const verified = AuthService.verifyClientToken(rawBearerToken);
      if (!verified.valid || !verified.payload) {
        return NextResponse.json(
          { error: verified.error || 'Invalid client JWT token.' },
          { status: 401 },
        );
      }
      tokenClientId = verified.payload.clientId;
      tokenRateLimit = verified.payload.rateLimit;
    } else {
      const auth = await verifyRequestAdminSession(sessionCookie);
      if (!auth.valid) {
        return NextResponse.json(
          {
            error:
              auth.reason === 'UNAUTHORIZED'
                ? 'Authentication required. Provide a valid Client Bearer JWT or Admin Session.'
                : 'Admin authentication is temporarily unavailable.',
          },
          { status: auth.reason === 'UNAUTHORIZED' ? 401 : 503 },
        );
      }
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON request payload.', code: 'INVALID_JSON' },
        { status: 400 },
      );
    }

    const bodyObj =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    const clientId = SDKManager.normalizeClientId(
      String(tokenClientId || bodyObj.clientId || ''),
    );
    if (!clientId) {
      return NextResponse.json(
        {
          error: 'clientId is required and must belong to a registered client.',
          code: 'VALIDATION_ERROR',
        },
        { status: 400 },
      );
    }

    if (await SDKManager.isClientDeletedAsync(clientId)) {
      return NextResponse.json(
        {
          error: `CLIENT_REVOKED: Client '${clientId}' has been deleted by administrator.`,
          code: 'CLIENT_REVOKED',
        },
        { status: 403 },
      );
    }

    const registeredClient = await SDKManager.getClientAsync(clientId);
    if (!registeredClient) {
      return NextResponse.json(
        {
          error: `CLIENT_REVOKED: Client '${clientId}' registration not found or has been deleted.`,
          code: 'CLIENT_REVOKED',
        },
        { status: 403 },
      );
    }

    if (registeredClient) {
      if (registeredClient.status === 'revoked') {
        return NextResponse.json(
          {
            error: `CLIENT_REVOKED: Client '${clientId}' access has been revoked by administrator.`,
            code: 'CLIENT_REVOKED',
          },
          { status: 403 },
        );
      }
      if (
        rawBearerToken &&
        registeredClient.token &&
        registeredClient.token !== rawBearerToken
      ) {
        return NextResponse.json(
          {
            error: 'TOKEN_ROTATED: Client credentials have been rotated. Use the latest token.',
            code: 'TOKEN_ROTATED',
          },
          { status: 401 },
        );
      }
    }

    const effectiveClientRate =
      registeredClient?.rateLimit ||
      tokenRateLimit ||
      settings.maxEventsPerSec ||
      100;

    // Detect if this is a batch array or direct file-records ingestion request
    const batchItems: unknown[] | null = Array.isArray(body)
      ? body
      : Array.isArray(bodyObj.batch)
        ? (bodyObj.batch as unknown[])
        : Array.isArray(bodyObj.records)
          ? (bodyObj.records as unknown[])
          : bodyObj.data === undefined && Array.isArray(bodyObj.events)
            ? (bodyObj.events as unknown[])
            : null;

    if (batchItems !== null) {
      let processed = 0;
      let rejected = 0;
      let duplicates = 0;
      let hitRateLimit = false;
      let hitPayloadLimit = false;
      const rateLimitedEventIds: string[] = [];
      const oversizedEventIds: string[] = [];
      const errors: string[] = [];

      const batchEvents: DataEvent[] = [];

      for (const item of batchItems) {
        const safeItem =
          item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : { value: item };

        const itemEventId =
          typeof safeItem.eventId === 'string' && safeItem.eventId.trim()
            ? safeItem.eventId.trim()
            : generateFallbackEventId();

        const itemTimestamp =
          typeof safeItem.timestamp === 'string' && safeItem.timestamp.trim()
            ? safeItem.timestamp.trim()
            : new Date().toISOString();

        const itemData = extractSingleHttpEventData(safeItem);

        const val = await SecurityEngine.validateEventAsync(
          clientId,
          itemEventId,
          itemData,
          effectiveClientRate,
        );

        if (!val.allowed) {
          if (val.code === 'DUPLICATE_EVENT') {
            duplicates += 1;
            continue;
          }
          rejected += 1;
          if (val.code === 'RATE_LIMIT_EXCEEDED') {
            hitRateLimit = true;
            rateLimitedEventIds.push(itemEventId);
          }
          if (val.code === 'PAYLOAD_TOO_LARGE') {
            hitPayloadLimit = true;
            oversizedEventIds.push(itemEventId);
          }
          if (errors.length < 5) {
            errors.push(`${itemEventId}: ${val.code || 'REJECTED'} - ${val.reason}`);
          }
          continue;
        }

        batchEvents.push({
          clientId,
          eventId: itemEventId,
          timestamp: itemTimestamp,
          payload:
            typeof itemData === 'string' ? itemData : JSON.stringify(itemData),
        });
        processed += 1;
      }

      if (batchEvents.length > 0) {
        await DataBufferEngine.pushBatchAsync(batchEvents);
      }

      if (processed > 0) {
        await SDKManager.incrementEventCountAsync(clientId, processed);
      }

      // If zero items were processed or deduplicated and all failed due to payload or rate limit, return corresponding status
      if (processed === 0 && duplicates === 0 && rejected > 0) {
        const status = hitPayloadLimit ? 413 : hitRateLimit ? 429 : 400;
        const code = hitPayloadLimit
          ? 'PAYLOAD_TOO_LARGE'
          : hitRateLimit
            ? 'RATE_LIMIT_EXCEEDED'
            : 'BATCH_REJECTED';
        return NextResponse.json(
          {
            success: false,
            accepted: processed,
            processed,
            rejected,
            duplicates,
            code,
            error: errors[0] || 'Batch validation failed',
            errors,
            ...(rateLimitedEventIds.length > 0 ? { rateLimitedEventIds } : {}),
            ...(oversizedEventIds.length > 0 ? { oversizedEventIds } : {}),
          },
          { status },
        );
      }

      return NextResponse.json({
        success: true,
        accepted: processed,
        processed,
        rejected,
        duplicates,
        ...(typeof bodyObj.fileName === 'string'
          ? { fileName: bodyObj.fileName }
          : {}),
        ...(rateLimitedEventIds.length > 0 ? { rateLimitedEventIds } : {}),
        ...(oversizedEventIds.length > 0 ? { oversizedEventIds } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      });
    }

    // Single Event Ingestion (exact envelope parity with Port 4000 WS sync_data)
    const eventId =
      typeof bodyObj.eventId === 'string' && bodyObj.eventId.trim()
        ? bodyObj.eventId.trim()
        : generateFallbackEventId();
    const timestamp =
      typeof bodyObj.timestamp === 'string' && bodyObj.timestamp.trim()
        ? bodyObj.timestamp.trim()
        : new Date().toISOString();
    const data = extractSingleHttpEventData(bodyObj);

    // Validate security (idempotency, rate limit, payload size)
    const val = await SecurityEngine.validateEventAsync(
      clientId,
      eventId,
      data,
      effectiveClientRate,
    );
    if (!val.allowed) {
      if (val.code === 'DUPLICATE_EVENT') {
        return NextResponse.json({
          success: true,
          eventId,
          note: 'DUPLICATE_DROPPED',
        });
      }
      const status = val.code === 'PAYLOAD_TOO_LARGE' ? 413 : 429;
      return NextResponse.json({ error: val.reason, code: val.code }, { status });
    }

    const event = {
      clientId,
      eventId,
      timestamp,
      payload: typeof data === 'string' ? data : JSON.stringify(data),
    };

    await DataBufferEngine.pushAsync(event);
    await SDKManager.incrementEventCountAsync(clientId, 1);

    return NextResponse.json({ success: true, eventId, event });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Event ingestion failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
