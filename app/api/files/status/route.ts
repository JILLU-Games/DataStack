import { requireAdminApiSession } from '@/lib/adminAuth';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function resolveIngestionBaseUrl(): string {
  return (process.env.INGESTION_INTERNAL_URL || 'http://127.0.0.1:4000').replace(
    /\/+$/,
    '',
  );
}

function resolveFilesProxyStatus(req: NextRequest): {
  proxyMode: 'nginx' | 'standalone';
  wsSupported: boolean;
  wsHint: string | null;
} {
  const configuredMode = process.env.DATASTACK_PROXY_MODE?.trim().toLowerCase();
  const hasReverseProxyHeaders = Boolean(
    req.headers.get('x-forwarded-host') ||
      req.headers.get('x-real-ip') ||
      req.headers.get('x-forwarded-proto'),
  );
  if (configuredMode === 'nginx' || hasReverseProxyHeaders) {
    return {
      proxyMode: 'nginx',
      wsSupported: true,
      wsHint: null,
    };
  }
  return {
    proxyMode: 'standalone',
    wsSupported: false,
    wsHint:
      'Direct Next.js HTTP rewrite active without Nginx WebSocket proxying. Files Manager operates over HTTP polling.',
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminApiSession(req);
  if (!auth.valid) {
    return auth.response;
  }

  const role = auth.auth.session.role || 'owner';
  const readOnly = role === 'viewer';
  const proxyInfo = resolveFilesProxyStatus(req);
  const targetUrl = `${resolveIngestionBaseUrl()}/vcon/files-engine/_status`;

  try {
    const cookieHeader = req.headers.get('cookie') || '';
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: cookieHeader ? { cookie: cookieHeader } : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });

    if (upstream.status === 401) {
      return NextResponse.json(
        { ok: false, offline: false, error: 'Authentication required.' },
        { status: 401, headers: { 'Cache-Control': 'no-store, private' } },
      );
    }

    const payload = (await upstream.json().catch(() => ({}))) as {
      ok?: boolean;
      engine?: string;
      role?: string;
      readOnly?: boolean;
      error?: string;
    };

    if (upstream.ok && payload.ok) {
      return NextResponse.json(
        {
          ok: true,
          offline: false,
          engine: payload.engine || 'cloudcmd',
          role: payload.role || role,
          readOnly: Boolean(payload.readOnly ?? readOnly),
          ...proxyInfo,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store, private' } },
      );
    }

    return NextResponse.json(
      {
        ok: false,
        offline: true,
        role,
        readOnly,
        ...proxyInfo,
        error:
          payload.error ||
          `Files Manager engine returned HTTP ${upstream.status}. Ensure the Port 4000 ingestion server is running.`,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store, private' } },
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        offline: true,
        role,
        readOnly,
        ...proxyInfo,
        error:
          'Files Manager engine on Port 4000 is not reachable. Start both services with "npm run dev" / "npm run dev:all" or Docker Compose.',
      },
      { status: 200, headers: { 'Cache-Control': 'no-store, private' } },
    );
  }
}
