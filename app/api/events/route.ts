import { SettingsManager } from '@/core/adminSettings/settingsManager';
import { verifyRequestAdminSession } from '@/core/auth/adminUsers';
import { AuthService } from '@/core/auth/jwt';
import { DataBufferEngine } from '@/core/data/buffer';
import { SDKManager } from '@/core/sdk/sdkManager';
import {
  SecurityEngine,
  getInternalIngestionHeaders,
} from '@/core/Security/security';
import { CSVStorageManager, type DataEvent } from '@/core/Storage/csvStorage';
import { parse } from 'csv-parse';
import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';

const SESSION_COOKIE = 'datastack_admin_session';

async function getRecentStoredEvents(
  limit: number,
  clientId?: string,
): Promise<DataEvent[]> {
  const allFiles = await CSVStorageManager.listAllFilesAsync();
  const files = allFiles
    .filter((f) => !clientId || clientId === 'all' || f.clientId === clientId)
    .slice(0, 5);

  const collected: DataEvent[] = [];

  for (const file of files) {
    const fileTail: DataEvent[] = [];
    const parser = createReadStream(file.filePath).pipe(
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
    } catch {
      parser.destroy();
    }

    if (fileTail.length > 0) {
      collected.push(...fileTail);
    }
  }

  return collected;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get('clientId') || undefined;
    const limit = Math.min(2000, Math.max(1, Number(searchParams.get('limit')) || 50));

    await SettingsManager.getSettingsAsync();
    const bufferedEvents = await DataBufferEngine.getRecentEventsAsync(limit, clientId);
    let socketBufferedEvents: DataEvent[] = [];
    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || 'http://127.0.0.1:4000'
    ).replace(/\/$/, '');

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

    const storedEvents = await getRecentStoredEvents(limit, clientId);

    const seenIds = new Set<string>();
    const merged: DataEvent[] = [];

    for (const evt of [...bufferedEvents, ...socketBufferedEvents, ...storedEvents]) {
      if (!evt.eventId) continue;
      const dedupeKey = `${evt.clientId}:${evt.eventId}`;
      if (seenIds.has(dedupeKey)) continue;
      seenIds.add(dedupeKey);
      merged.push(evt);
    }

    merged.sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
    const events = merged.slice(0, limit);

    return NextResponse.json({ events, count: events.length });
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

    const clientId = String(
      tokenClientId || bodyObj.clientId || 'py_telemetry_agent_01',
    )
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');

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
    if (rawBearerToken && !registeredClient) {
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
          : null;

    if (batchItems !== null) {
      const envelopeKeys = new Set(['eventId', 'timestamp', 'data', 'clientId']);
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
            : `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const itemTimestamp =
          typeof safeItem.timestamp === 'string' && safeItem.timestamp.trim()
            ? safeItem.timestamp.trim()
            : new Date().toISOString();

        const isEnvelope =
          safeItem.data !== undefined &&
          Object.keys(safeItem).every((k) => envelopeKeys.has(k));
        const itemData = isEnvelope ? safeItem.data : safeItem;

        const val = SecurityEngine.validateEvent(
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
        SDKManager.incrementEventCount(clientId, processed);
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

    // Single Event Ingestion
    const eventId =
      typeof bodyObj.eventId === 'string' && bodyObj.eventId.trim()
        ? bodyObj.eventId.trim()
        : `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const timestamp =
      typeof bodyObj.timestamp === 'string' && bodyObj.timestamp.trim()
        ? bodyObj.timestamp.trim()
        : new Date().toISOString();
    const data =
      bodyObj.data !== undefined
        ? bodyObj.data
        : Object.keys(bodyObj).length > 0
          ? bodyObj
          : { sample: 'Realtime event via DataStack API', rand: Math.random() };

    // Validate security (idempotency, rate limit, payload size)
    const val = SecurityEngine.validateEvent(
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
    SDKManager.incrementEventCount(clientId, 1);

    return NextResponse.json({ success: true, eventId, event });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Event ingestion failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
