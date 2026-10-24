import { DataBufferEngine } from "@/core/data/buffer";
import { CSVStorageManager } from "@/core/Storage/csvStorage";
import { parse } from "csv-parse";
import { NextRequest, NextResponse } from "next/server";
import { createReadStream, readdirSync, statSync } from "node:fs";
import path from "node:path";

interface DataEvent {
  clientId: string;
  eventId: string;
  timestamp: string;
  payload: string;
  status: "stored" | "buffered";
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId") || "all";
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
      const eventDate = event.timestamp.slice(0, 10);
      if (
        (clientId !== "all" && event.clientId !== clientId) ||
        (from && eventDate < from) ||
        (to && eventDate > to) ||
        (search && !event.payload.toLowerCase().includes(search)) ||
        eventIds.has(event.eventId)
      ) {
        return;
      }

      eventIds.add(event.eventId);
      total += 1;

      let low = 0;
      let high = selectedRows.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (selectedRows[middle].timestamp >= event.timestamp) low = middle + 1;
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
      clientDirs = readdirSync(storageDir);
    } catch {
      clientDirs = [];
    }

    for (const storedClientId of clientDirs) {
      if (clientId !== "all" && storedClientId !== clientId) continue;

      const clientDir = path.join(storageDir, storedClientId);
      if (!statSync(clientDir).isDirectory()) continue;

      let filenames: string[];
      try {
        filenames = readdirSync(clientDir).filter((filename) =>
          /^\d{4}-\d{2}-\d{2}(?:-part\d+)?\.csv$/.test(filename),
        );
      } catch {
        continue;
      }

      for (const filename of filenames) {
        const fileDate = filename.slice(0, 10);
        if ((from && fileDate < from) || (to && fileDate > to)) continue;

        const parser = createReadStream(path.join(clientDir, filename)).pipe(
          parse({ columns: true, skip_empty_lines: true, bom: true }),
        );

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
        } catch {
          parser.destroy();
        }
      }
    }

    for (const event of DataBufferEngine.getRecentEvents(200)) {
      addIfMatching({ ...event, status: "buffered" });
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
