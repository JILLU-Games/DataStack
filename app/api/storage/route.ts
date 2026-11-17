import { NextRequest, NextResponse } from 'next/server';
import { SettingsManager } from '@/core/adminSettings/settingsManager';
import { getInternalIngestionHeaders } from '@/core/Security/security';
import { CSVStorageManager } from '@/core/Storage/csvStorage';
import { DataBufferEngine } from '@/core/data/buffer';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get('clientId') || undefined;

    const [stats, allFiles] = await Promise.all([
      CSVStorageManager.getStorageStatsAsync(),
      CSVStorageManager.listAllFilesAsync(),
    ]);
    let files = allFiles;

    if (clientId && clientId !== 'all') {
      files = files.filter((f) => f.clientId === clientId);
    }

    return NextResponse.json({ stats, files });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Storage stats failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(_req: NextRequest) {
  try {
    await SettingsManager.getSettingsAsync();

    // 1. Flush local / shared Next.js DataBufferEngine
    const localRes = await DataBufferEngine.flush();

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
        headers: getInternalIngestionHeaders(),
        cache: 'no-store',
        signal: AbortSignal.timeout(2500),
      });
      if (!ingestRes.ok) {
        const errPayload = await ingestRes.json().catch(() => ({}));
        const remoteErr =
          typeof errPayload?.error === 'string'
            ? errPayload.error
            : `Ingestion flush returned HTTP ${ingestRes.status}`;
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
