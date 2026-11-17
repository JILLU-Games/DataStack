import { SettingsManager } from "@/core/adminSettings/settingsManager";
import { DataBufferEngine } from "@/core/data/buffer";
import { getInternalIngestionHeaders } from "@/core/Security/security";
import {
  CSVStorageManager,
  type StorageFileMeta,
} from "@/core/Storage/csvStorage";
import { parse } from "csv-parse";
import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import path from "node:path";

type ExportFormat = "csv" | "json";
type CsvRecord = Record<string, string>;
type StreamChunk = string | Uint8Array;

function toByteStream(chunks: AsyncIterable<StreamChunk>) {
  const iterator = chunks[Symbol.asyncIterator]();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(
            typeof result.value === "string"
              ? encoder.encode(result.value)
              : result.value,
          );
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function* readFileRecords(
  file: StorageFileMeta,
): AsyncGenerator<CsvRecord> {
  const parser = createReadStream(file.filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true }),
  );

  try {
    for await (const record of parser as AsyncIterable<CsvRecord>) {
      yield record;
    }
  } catch {
    parser.destroy();
  }
}

function makeExportStream(
  files: StorageFileMeta[],
  format: ExportFormat,
  includeHeader: boolean,
) {
  const fields = ["clientId", "eventId", "timestamp", "payload"];
  const chunks = (async function* () {
    let isFirst = true;

    if (format === "json") {
      yield "[";
    } else if (includeHeader) {
      yield `${fields.join(",")}\n`;
    }

    for (const file of files) {
      for await (const record of readFileRecords(file)) {
        if (format === "json") {
          const payload = record.payload ?? "";
          let parsedPayload: unknown = payload;
          try {
            parsedPayload = JSON.parse(payload);
          } catch {
            // Keep non-JSON payloads as strings.
          }
          yield `${isFirst ? "" : ","}${JSON.stringify({ ...record, payload: parsedPayload })}`;
        } else {
          const line = fields
            .map((field) => `"${(record[field] ?? "").replaceAll('"', '""')}"`)
            .join(",");
          yield `${line}\n`;
        }
        isFirst = false;
      }
    }

    if (format === "json") yield "]";
  })();

  return toByteStream(chunks);
}

function streamFile(file: StorageFileMeta) {
  async function* chunks() {
    for await (const chunk of createReadStream(file.filePath)) {
      yield new Uint8Array(chunk);
    }
  }

  return toByteStream(chunks());
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const shouldFlush = searchParams.get("flush") !== "false";

    await SettingsManager.getSettingsAsync();
    if (shouldFlush) {
      await DataBufferEngine.flush();
      const ingestionBaseUrl = (
        process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
      ).replace(/\/$/, "");
      try {
        await fetch(`${ingestionBaseUrl}/internal/flush`, {
          method: "POST",
          headers: getInternalIngestionHeaders(),
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        // Port 4000 may not be running in isolated single-process dev mode
      }
    }

    const clientId = searchParams.get("clientId") || "all";
    const filename = searchParams.get("filename");
    const from = searchParams.get("from") || "";
    const to = searchParams.get("to") || "";
    const format: ExportFormat =
      searchParams.get("format") === "json" ? "json" : "csv";
    const includeHeader = searchParams.get("includeHeader") !== "false";

    let files = await CSVStorageManager.listAllFilesAsync();
    if (clientId !== "all")
      files = files.filter((file) => file.clientId === clientId);

    if (filename) {
      const safeFilename = path.basename(filename);
      const matches = files.filter(
        (candidate) => candidate.filename === safeFilename,
      );
      if (matches.length === 0) {
        return NextResponse.json(
          { error: "CSV file not found" },
          { status: 404 },
        );
      }
      if (matches.length > 1) {
        return NextResponse.json(
          {
            error:
              "Ambiguous filename matches multiple clients. Specify clientId.",
            code: "AMBIGUOUS_FILENAME",
            matchingClients: matches.map((m) => m.clientId),
          },
          { status: 400 },
        );
      }
      const file = matches[0];
      return new NextResponse(streamFile(file), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${file.filename}"`,
        },
      });
    }

    files = files.filter(
      (file) => (!from || file.date >= from) && (!to || file.date <= to),
    );
    const datePart = new Date().toISOString().slice(0, 10);
    const safeClientId = clientId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const baseName =
      clientId === "all" ? "datastack_export" : `${safeClientId}_export`;

    return new NextResponse(makeExportStream(files, format, includeHeader), {
      status: 200,
      headers: {
        "Content-Type":
          format === "json"
            ? "application/json; charset=utf-8"
            : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${baseName}_${datePart}.${format}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
