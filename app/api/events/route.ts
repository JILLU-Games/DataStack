import { SettingsManager } from '@/core/adminSettings/settingsManager';
import { verifyAdminSessionToken } from '@/core/auth/adminSession';
import { AuthService } from '@/core/auth/jwt';
import { DataBufferEngine } from '@/core/data/buffer';
import { SDKManager } from '@/core/sdk/sdkManager';
import { SecurityEngine } from '@/core/Security/security';
import { CSVStorageManager, type DataEvent } from '@/core/Storage/csvStorage';
import { parse } from 'csv-parse';
import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';

const SESSION_COOKIE = 'datastack_admin_session';

async function getRecentStoredEvents(
  limit: number,
  clientId?: string,
): Promise<DataEvent[]> {
  const files = CSVStorageManager.listAllFiles()
    .filter((f) => !clientId || clientId === 'all' || f.clientId === clientId)
    .slice(0, 5);

  const collected: DataEvent[] = [];

  for (const file of files) {
    const fileEvents: DataEvent[] = [];
    const parser = createReadStream(file.filePath).pipe(
      parse({ columns: true, skip_empty_lines: true, bom: true }),
    );

    try {
      for await (const record of parser as AsyncIterable<
        Record<string, string>
      >) {
        if (!record.eventId) continue;
        fileEvents.push({
          clientId: record.clientId || file.clientId,
          eventId: record.eventId,
          timestamp: record.timestamp || `${file.date}T00:00:00.000Z`,
          payload: record.payload || '',
        });
      }
    } catch {
      parser.destroy();
    }

    if (fileEvents.length > 0) {
      collected.push(...fileEvents.slice(-limit));
    }
  }

  return collected;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get('clientId') || undefined;
    const limit = Math.min(200, Math.max(1, Number(searchParams.get('limit')) || 50));

    const bufferedEvents = DataBufferEngine.getRecentEvents(limit, clientId);
    const storedEvents = await getRecentStoredEvents(limit, clientId);

    const seenIds = new Set<string>();
    const merged: DataEvent[] = [];

    for (const evt of [...bufferedEvents, ...storedEvents]) {
      if (!evt.eventId || seenIds.has(evt.eventId)) continue;
      seenIds.add(evt.eventId);
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
    const sessionSecret =
      process.env.DATASTACK_ADMIN_SESSION_SECRET ||
      'datastack-admin-session-default-secret-32-chars';
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
      const isAdmin = Boolean(
        sessionSecret &&
          sessionCookie &&
          (await verifyAdminSessionToken(sessionCookie, sessionSecret)),
      );
      if (!isAdmin) {
        return NextResponse.json(
          { error: 'Authentication required. Provide a valid Client Bearer JWT or Admin Session.' },
          { status: 401 },
        );
      }
    }

    const body = await req.json();
    const clientId = String(
      tokenClientId || body.clientId || 'py_telemetry_agent_01',
    )
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');

    const registeredClient = await SDKManager.getClientAsync(clientId);
    if (registeredClient) {
      if (registeredClient.status === 'revoked') {
        return NextResponse.json(
          { error: `Client '${clientId}' access has been revoked by administrator.` },
          { status: 403 },
        );
      }
      if (
        rawBearerToken &&
        registeredClient.token &&
        registeredClient.token !== rawBearerToken
      ) {
        return NextResponse.json(
          { error: 'Client credentials have been rotated. Use the latest token.' },
          { status: 401 },
        );
      }
    }

    const eventId =
      body.eventId ||
      `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = body.timestamp || new Date().toISOString();
    const data =
      body.data !== undefined
        ? body.data
        : { sample: 'Realtime event via DataStack API', rand: Math.random() };

    const effectiveClientRate =
      registeredClient?.rateLimit ||
      tokenRateLimit ||
      settings.maxEventsPerSec ||
      100;

    // Validate security (idempotency, rate limit, payload size)
    const val = SecurityEngine.validateEvent(
      clientId,
      eventId,
      data,
      effectiveClientRate,
    );
    if (!val.allowed) {
      const status = val.code === 'PAYLOAD_TOO_LARGE' ? 413 : 429;
      return NextResponse.json({ error: val.reason, code: val.code }, { status });
    }

    const event = {
      clientId,
      eventId,
      timestamp,
      payload: typeof data === 'string' ? data : JSON.stringify(data),
    };

    DataBufferEngine.push(event);
    SDKManager.incrementEventCount(clientId, 1);

    return NextResponse.json({ success: true, event });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Event ingestion failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
