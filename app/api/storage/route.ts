import { NextRequest, NextResponse } from 'next/server';
import { CSVStorageManager } from '@/core/Storage/csvStorage';
import { DataBufferEngine } from '@/core/data/buffer';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get('clientId') || undefined;

    const stats = CSVStorageManager.getStorageStats();
    let files = CSVStorageManager.listAllFiles();

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
    // 1. Flush local Next.js DataBufferEngine
    const localRes = await DataBufferEngine.flush();

    // 2. Also flush Port 4000 Socket.IO ingestion buffer
    let remoteCount = 0;
    let remoteFiles: string[] = [];
    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || 'http://127.0.0.1:4000'
    ).replace(/\/$/, '');

    try {
      const ingestRes = await fetch(`${ingestionBaseUrl}/internal/flush`, {
        method: 'POST',
        cache: 'no-store',
      });
      if (ingestRes.ok) {
        const ingestData = await ingestRes.json();
        remoteCount = Number(ingestData.flushedCount) || 0;
        if (Array.isArray(ingestData.filesUpdated)) {
          remoteFiles = ingestData.filesUpdated;
        }
      }
    } catch {
      // Port 4000 server may be offline in standalone Next.js dev mode
    }

    const combinedFiles = Array.from(
      new Set([...localRes.files, ...remoteFiles]),
    );

    return NextResponse.json({
      success: true,
      flushedCount: localRes.count + remoteCount,
      filesUpdated: combinedFiles,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Manual flush failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
