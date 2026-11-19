import { SettingsManager } from "@/core/adminSettings/settingsManager";
import { DataBufferEngine } from "@/core/data/buffer";
import { SDKManager } from "@/core/sdk/sdkManager";
import { getInternalIngestionHeaders } from "@/core/Security/security";
import {
  CSVStorageManager,
  type StorageFileMeta,
} from "@/core/Storage/csvStorage";
import { requireAdminApiSession } from "@/lib/adminAuth";
import { parse } from "csv-parse";
import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import path from "node:path";

type ExportFormat = "csv" | "json" | "ndjson";
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
  const fileStream = CSVStorageManager.openPartitionTextStream(file.filePath);
  const parser = fileStream.pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true }),
  );
  fileStream.on("error", (err) => {
    if (!parser.destroyed) parser.destroy(err);
  });

  try {
    for await (const record of parser as AsyncIterable<CsvRecord>) {
      yield record;
    }
  } finally {
    if (!parser.destroyed) parser.destroy();
    if (!fileStream.destroyed) fileStream.destroy();
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
    } else if (format === "csv" && includeHeader) {
      yield `${fields.join(",")}\n`;
    }

    for (const file of files) {
      for await (const record of readFileRecords(file)) {
        if (format === "json" || format === "ndjson") {
          const payload = record.payload ?? "";
          let parsedPayload: unknown = payload;
          try {
            parsedPayload = JSON.parse(payload);
          } catch {
            // Keep non-JSON payloads as strings.
          }
          const serialized = JSON.stringify({
            ...record,
            payload: parsedPayload,
          });
          if (format === "ndjson") {
            yield `${serialized}\n`;
          } else {
            yield `${isFirst ? "" : ","}${serialized}`;
          }
        } else {
          const line = fields
            .map((field) => `"${String(record[field] ?? "").replaceAll('"', '""')}"`)
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
    const fileStream = createReadStream(file.filePath);
    try {
      for await (const chunk of fileStream) {
        yield new Uint8Array(chunk as Buffer);
      }
    } finally {
      if (!fileStream.destroyed) fileStream.destroy();
    }
  }

  return toByteStream(chunks());
}

export async function GET(request: NextRequest) {
  const auth = await requireAdminApiSession(request);
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const { searchParams } = new URL(request.url);
    const from = (searchParams.get("from") || "").trim();
    const to = (searchParams.get("to") || "").trim();
    if (from && to && from > to) {
      return NextResponse.json(
        {
          error: 'Start date ("from") must be on or before end date ("to").',
          code: "INVALID_DATE_RANGE",
        },
        { status: 400 },
      );
    }
    const shouldFlush = searchParams.get("flush") !== "false";

    await SettingsManager.getSettingsAsync();
    if (shouldFlush) {
      try {
        await DataBufferEngine.flush({ waitMs: 2500, throwOnLockTimeout: true });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Pre-export flush failed";
        if (message.includes("FLUSH_LOCK_TIMEOUT")) {
          return NextResponse.json(
            {
              error: message,
              code: "FLUSH_LOCK_TIMEOUT",
            },
            { status: 503 },
          );
        }
        throw err;
      }

      const explicitIngestionUrl = Boolean(process.env.INGESTION_INTERNAL_URL?.trim());
      const ingestionBaseUrl = (
        process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
      ).replace(/\/$/, "");
      try {
        const flushRes = await fetch(`${ingestionBaseUrl}/internal/flush`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getInternalIngestionHeaders(),
          },
          body: JSON.stringify({ waitMs: 2500, throwOnLockTimeout: true }),
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
        if (!flushRes.ok) {
          const errPayload = await flushRes.json().catch(() => ({}));
          const remoteErr =
            typeof errPayload?.error === "string"
              ? errPayload.error
              : `Ingestion flush returned HTTP ${flushRes.status}`;
          if (
            flushRes.status === 503 &&
            errPayload?.code === "FLUSH_LOCK_TIMEOUT"
          ) {
            return NextResponse.json(
              {
                error: remoteErr,
                code: "FLUSH_LOCK_TIMEOUT",
                ingestionStatus: flushRes.status,
              },
              { status: 503 },
            );
          }
          return NextResponse.json(
            {
              error: remoteErr,
              code: "INGESTION_FLUSH_FAILED",
              ingestionStatus: flushRes.status,
            },
            { status: 502 },
          );
        }
      } catch (err: unknown) {
        if (explicitIngestionUrl) {
          const errMsg =
            err instanceof Error ? err.message : "Ingestion server unreachable";
          return NextResponse.json(
            {
              error: `Ingestion server flush failed before export: ${errMsg}`,
              code: "INGESTION_UNREACHABLE",
            },
            { status: 502 },
          );
        }
        // Port 4000 may not be running in isolated single-process dev mode
      }
    }

    const rawClientId = searchParams.get("clientId") || "all";
    const clientId =
      rawClientId === "all"
        ? "all"
        : SDKManager.normalizeClientId(rawClientId) || "all";
    const sanitizedClientId =
      clientId === "all" ? "all" : CSVStorageManager.sanitizeClientId(clientId);
    const filename = searchParams.get("filename") || searchParams.get("file");
    const rawFormat = (searchParams.get("format") || "csv").toLowerCase();
    const format: ExportFormat =
      rawFormat === "json"
        ? "json"
        : rawFormat === "ndjson"
          ? "ndjson"
          : "csv";
    const includeHeader = searchParams.get("includeHeader") !== "false";

    let files = await CSVStorageManager.listAllFilesAsync();
    if (clientId !== "all") {
      files = files.filter(
        (file) => file.clientId === clientId || file.clientId === sanitizedClientId,
      );
    }

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
      const baseStem = file.filename.replace(/\.csv(?:\.gz)?$/i, "");
      const downloadName =
        format === "json"
          ? `${baseStem}.json`
          : format === "ndjson"
            ? `${baseStem}.ndjson`
            : !includeHeader && file.compressed
              ? `${baseStem}.csv`
              : file.filename;
      const bodyStream =
        format === "json" || format === "ndjson" || !includeHeader
          ? makeExportStream([file], format, includeHeader)
          : streamFile(file);
      const contentType =
        format === "json"
          ? "application/json; charset=utf-8"
          : format === "ndjson"
            ? "application/x-ndjson; charset=utf-8"
            : file.compressed && includeHeader
              ? "application/gzip"
              : "text/csv; charset=utf-8";
      return new NextResponse(bodyStream, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${downloadName.replace(/"/g, "")}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    files = files.filter(
      (file) => (!from || file.date >= from) && (!to || file.date <= to),
    );
    const datePart = new Date().toISOString().slice(0, 10);
    const safeClientId = sanitizedClientId === "all" ? "all" : sanitizedClientId;
    const baseName =
      clientId === "all" ? "datastack_export" : `${safeClientId}_export`;

    return new NextResponse(makeExportStream(files, format, includeHeader), {
      status: 200,
      headers: {
        "Content-Type":
          format === "json"
            ? "application/json; charset=utf-8"
            : format === "ndjson"
              ? "application/x-ndjson; charset=utf-8"
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
