import { NextRequest, NextResponse } from 'next/server';
import { SettingsManager } from '@/core/adminSettings/settingsManager';
import { SDKManager } from '@/core/sdk/sdkManager';
import { getInternalIngestionHeaders } from '@/core/Security/security';
import { CSVStorageManager } from '@/core/Storage/csvStorage';
import { DataBufferEngine } from '@/core/data/buffer';
import { requireAdminApiSession } from '@/lib/adminAuth';

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
        ? SDKManager.normalizeClientId(rawClientId)
        : undefined;
    const sanitizedClientId = clientId
      ? CSVStorageManager.sanitizeClientId(clientId)
      : undefined;

    const allFiles = await CSVStorageManager.listAllFilesAsync();
    let files = allFiles;

    if (clientId) {
      files = allFiles.filter((f) => {
        const normFolder = SDKManager.normalizeClientId(f.clientId);
        return (
          normFolder === clientId ||
          f.clientId === clientId ||
          f.clientId === sanitizedClientId
        );
      });
    }

    const stats = CSVStorageManager.formatStorageStats(files);

    return NextResponse.json({ stats, files });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Storage stats failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdminApiSession(req);
  if (!auth.valid) {
    return auth.response;
  }

  try {
    await SettingsManager.getSettingsAsync();

    // 1. Flush local / shared Next.js DataBufferEngine
    const localRes = await DataBufferEngine.flush({
      waitMs: 2500,
      throwOnLockTimeout: true,
    });

    // 2. Also flush Port 4000 Socket.IO ingestion buffer
    let remoteCount = 0;
    let remoteFiles: string[] = [];
    let ingestionFlushed = false;
    let warning: string | undefined;
    const explicitIngestionUrl = Boolean(process.env.INGESTION_INTERNAL_URL?.trim());
    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || 'http://127.0.0.1:4000'
    ).replace(/\/$/, '');

    try {
      const ingestRes = await fetch(`${ingestionBaseUrl}/internal/flush`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getInternalIngestionHeaders(),
        },
        body: JSON.stringify({ waitMs: 2500, throwOnLockTimeout: true }),
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
      });
      if (!ingestRes.ok) {
        const errPayload = await ingestRes.json().catch(() => ({}));
        const remoteErr =
          typeof errPayload?.error === 'string'
            ? errPayload.error
            : `Ingestion flush returned HTTP ${ingestRes.status}`;
        if (
          ingestRes.status === 503 &&
          errPayload?.code === 'FLUSH_LOCK_TIMEOUT'
        ) {
          return NextResponse.json(
            {
              success: false,
              error: remoteErr,
              code: 'FLUSH_LOCK_TIMEOUT',
              flushedCount: localRes.count,
              filesUpdated: localRes.files,
              ingestionFlushed: false,
              ingestionStatus: ingestRes.status,
            },
            { status: 503 },
          );
        }
        return NextResponse.json(
          {
            success: false,
            error: remoteErr,
            code: 'INGESTION_FLUSH_FAILED',
            flushedCount: localRes.count,
            filesUpdated: localRes.files,
            ingestionFlushed: false,
            ingestionStatus: ingestRes.status,
          },
          { status: 502 },
        );
      }

      ingestionFlushed = true;
      const ingestData = await ingestRes.json();
      remoteCount = Number(ingestData.flushedCount) || 0;
      if (Array.isArray(ingestData.filesUpdated)) {
        remoteFiles = ingestData.filesUpdated;
      }
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error ? err.message : 'Ingestion server unreachable';
      if (explicitIngestionUrl) {
        return NextResponse.json(
          {
            success: false,
            error: `Ingestion server flush failed: ${errMsg}`,
            code: 'INGESTION_UNREACHABLE',
            flushedCount: localRes.count,
            filesUpdated: localRes.files,
            ingestionFlushed: false,
          },
          { status: 502 },
        );
      }
      warning = `Port 4000 ingestion server is unreachable (${errMsg}); flushed Next.js buffer only.`;
    }

    const combinedFiles = Array.from(
      new Set([...localRes.files, ...remoteFiles]),
    );

    return NextResponse.json({
      success: true,
      flushedCount: localRes.count + remoteCount,
      filesUpdated: combinedFiles,
      ingestionFlushed,
      ...(warning ? { warning } : {}),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Manual flush failed';
    if (message.includes('FLUSH_LOCK_TIMEOUT')) {
      return NextResponse.json(
        {
          success: false,
          error: message,
          code: 'FLUSH_LOCK_TIMEOUT',
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
