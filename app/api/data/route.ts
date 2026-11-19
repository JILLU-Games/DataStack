import { SettingsManager } from "@/core/adminSettings/settingsManager";
import { DataBufferEngine } from "@/core/data/buffer";
import { SDKManager } from "@/core/sdk/sdkManager";
import { getInternalIngestionHeaders } from "@/core/Security/security";
import { CSVStorageManager } from "@/core/Storage/csvStorage";
import { requireAdminApiSession } from "@/lib/adminAuth";
import { parse } from "csv-parse";
import { NextRequest, NextResponse } from "next/server";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

interface DataEvent {
  clientId: string;
  eventId: string;
  timestamp: string;
  payload: string;
  status: "stored" | "buffered";
}

function parseTimestampMs(raw: string): number {
  const trimmed = String(raw || "").trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return num < 1e11 ? num * 1000 : num;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function compareEventsDesc(a: DataEvent, b: DataEvent): number {
  const aMs = parseTimestampMs(a.timestamp);
  const bMs = parseTimestampMs(b.timestamp);
  if (aMs !== bMs) {
    return bMs - aMs;
  }
  return b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdminApiSession(request);
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const { searchParams } = new URL(request.url);
    const rawClientId = searchParams.get("clientId") || "all";
    const clientId =
      rawClientId === "all"
        ? "all"
        : SDKManager.normalizeClientId(rawClientId) || "all";
    const sanitizedClientId =
      clientId === "all" ? "all" : CSVStorageManager.sanitizeClientId(clientId);
    const from = searchParams.get("from") || "";
    const to = searchParams.get("to") || "";
    const search = (searchParams.get("search") || "").toLowerCase();
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(searchParams.get("pageSize")) || 12),
    );
    const offset = (page - 1) * pageSize;
    const selectedRows: DataEvent[] = [];
    const eventIds = new Set<string>();
    let total = 0;

    const addIfMatching = (event: DataEvent) => {
      const eventDate = CSVStorageManager.extractSafePartitionDate(event.timestamp, null);
      const normEventClient = SDKManager.normalizeClientId(event.clientId) || event.clientId;
      const dedupeKey = `${normEventClient}:${event.eventId}`;
      const matchesClient =
        clientId === "all" ||
        normEventClient === clientId ||
        CSVStorageManager.sanitizeClientId(normEventClient) === sanitizedClientId;
      const matchesSearch =
        !search ||
        event.payload.toLowerCase().includes(search) ||
        event.eventId.toLowerCase().includes(search) ||
        event.clientId.toLowerCase().includes(search);

      if (
        !matchesClient ||
        ((from || to) && (!eventDate || (from && eventDate < from) || (to && eventDate > to))) ||
        !matchesSearch ||
        eventIds.has(dedupeKey)
      ) {
        return;
      }

      eventIds.add(dedupeKey);
      total += 1;

      let low = 0;
      let high = selectedRows.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareEventsDesc(selectedRows[middle], event) <= 0) low = middle + 1;
        else high = middle;
      }

      if (low < offset + pageSize) {
        selectedRows.splice(low, 0, event);
        if (selectedRows.length > offset + pageSize) selectedRows.pop();
      }
    };

    const storageDir = CSVStorageManager.baseStorageDir;
    let clientDirs: string[] = [];
    try {
      clientDirs = await readdir(storageDir);
    } catch {
      clientDirs = [];
    }

    for (const storedClientId of clientDirs) {
      if (
        clientId !== "all" &&
        storedClientId !== clientId &&
        storedClientId !== sanitizedClientId
      ) {
        continue;
      }

      const clientDir = path.join(storageDir, storedClientId);
      let dirLstat;
      try {
        dirLstat = await lstat(clientDir);
      } catch {
        continue;
      }
      if (dirLstat.isSymbolicLink() || !dirLstat.isDirectory()) continue;

      let filenames: string[];
      try {
        filenames = (await readdir(clientDir))
          .filter((filename) => {
            if (!/^\d{4}-\d{2}-\d{2}(?:-part\d+)?(?:-gz\d+)?\.csv(?:\.gz)?$/.test(filename)) {
              return false;
            }
            const fileDate = CSVStorageManager.extractDateFromFilename(filename);
            if ((from && fileDate < from) || (to && fileDate > to)) {
              return false;
            }
            return true;
          })
          .sort((a, b) => b.localeCompare(a));
      } catch {
        continue;
      }

      for (const filename of filenames) {
        const fileDate = CSVStorageManager.extractDateFromFilename(filename);

        const filePath = path.join(clientDir, filename);
        let fileLstat;
        try {
          fileLstat = await lstat(filePath);
        } catch {
          continue;
        }
        if (fileLstat.isSymbolicLink() || !fileLstat.isFile()) continue;

        const fileStream = CSVStorageManager.openPartitionTextStream(filePath);
        const parser = fileStream.pipe(
          parse({ columns: true, skip_empty_lines: true, bom: true }),
        );
        fileStream.on("error", (err) => {
          if (!parser.destroyed) parser.destroy(err);
        });

        try {
          for await (const record of parser as AsyncIterable<
            Record<string, string>
          >) {
            const event = {
              clientId: record.clientId || storedClientId,
              eventId: record.eventId || "",
              timestamp: record.timestamp || `${fileDate}T00:00:00.000Z`,
              payload: record.payload || "",
              status: "stored" as const,
            };
            if (event.eventId) addIfMatching(event);
          }
        } catch (err) {
          console.warn(`[API /data] Failed reading partition ${filePath}:`, err);
          if (filename.endsWith(".csv.gz")) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(`Corrupt .csv.gz partition (${filename}): ${detail}`);
          }
        } finally {
          if (!parser.destroyed) parser.destroy();
          if (!fileStream.destroyed) fileStream.destroy();
        }
      }
    }

    await SettingsManager.getSettingsAsync();
    const recentWindowLimit = DataBufferEngine.getRecentLimit();

    for (const event of await DataBufferEngine.getRecentEventsAsync(
      recentWindowLimit,
      clientId,
    )) {
      addIfMatching({ ...event, status: "buffered" });
    }

    const ingestionBaseUrl = (
      process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
    ).replace(/\/$/, "");
    try {
      const qs = new URLSearchParams({ limit: String(recentWindowLimit) });
      if (clientId && clientId !== "all") {
        qs.set("clientId", clientId);
      }
      const res = await fetch(
        `${ingestionBaseUrl}/internal/recent?${qs.toString()}`,
        {
          headers: getInternalIngestionHeaders(),
          cache: "no-store",
          signal: AbortSignal.timeout(1000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.events)) {
          for (const evt of data.events) {
            if (evt && evt.eventId) {
              addIfMatching({
                clientId: String(evt.clientId || ""),
                eventId: String(evt.eventId),
                timestamp: String(evt.timestamp || new Date().toISOString()),
                payload:
                  typeof evt.payload === "string"
                    ? evt.payload
                    : JSON.stringify(evt.payload ?? {}),
                status: "buffered",
              });
            }
          }
        }
      }
    } catch {
      // Port 4000 may not be running in isolated single-process dev mode
    }

    return NextResponse.json({
      events: selectedRows.slice(offset),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Data retrieval failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
