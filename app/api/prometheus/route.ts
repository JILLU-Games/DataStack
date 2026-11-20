import { SettingsManager } from "@/core/adminSettings/settingsManager";
import { verifyRequestAdminSession } from "@/core/auth/adminUsers";
import { DataBufferEngine } from "@/core/data/buffer";
import { SDKManager } from "@/core/sdk/sdkManager";
import { getInternalIngestionHeaders } from "@/core/Security/security";
import { CSVStorageManager } from "@/core/Storage/csvStorage";
import { ADMIN_SESSION_COOKIE } from "@/lib/adminAuth";
import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

function verifyBearerTokenConstantTime(
  expectedToken: string,
  providedToken: string,
): boolean {
  const expected = expectedToken.trim();
  const provided = providedToken.trim();
  if (!expected || !provided) return false;
  const expectedDigest = createHash("sha256")
    .update(expected, "utf8")
    .digest();
  const providedDigest = createHash("sha256")
    .update(provided, "utf8")
    .digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

function escapePrometheusLabel(raw: string): string {
  return String(raw || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

export async function GET(req: NextRequest) {
  try {
    let authorized = false;

    // 1. Check Bearer token (or ?token= query param) against encrypted Prometheus token
    const authHeader = req.headers.get("authorization") || "";
    const bearerCandidate = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : req.nextUrl.searchParams.get("token")?.trim() || "";

    const promConfig = await SettingsManager.getDecryptedPrometheusConfigAsync();
    if (
      promConfig.enabled &&
      promConfig.token.trim().length > 0 &&
      bearerCandidate.length > 0 &&
      verifyBearerTokenConstantTime(promConfig.token, bearerCandidate)
    ) {
      authorized = true;
    }

    // 2. Fallback: valid Admin Console session cookie
    if (!authorized) {
      const sessionCookie = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
      if (sessionCookie) {
        const adminAuth = await verifyRequestAdminSession(sessionCookie);
        if (adminAuth.valid) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return NextResponse.json(
        {
          error:
            "PROMETHEUS_UNAUTHORIZED: Valid bearer scrape token or admin session required.",
          code: "PROMETHEUS_UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const [clients, allFiles, diskHealth, bufferStats] = await Promise.all([
      SDKManager.listClientsAsync(),
      CSVStorageManager.listAllFilesAsync(),
      CSVStorageManager.getDiskUsageAsync(),
      DataBufferEngine.getBufferStatsAsync(),
    ]);
    const storageStats = CSVStorageManager.formatStorageStats(allFiles);

    let activeSockets = 0;
    let bridgeUp = 0;
    let remoteBufferSize = 0;

    const headers = getInternalIngestionHeaders();
    if (headers["x-datastack-internal-secret"]) {
      const ingestionBaseUrl = (
        process.env.INGESTION_INTERNAL_URL || "http://127.0.0.1:4000"
      ).replace(/\/$/, "");
      try {
        const res = await fetch(`${ingestionBaseUrl}/internal/metrics`, {
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          bridgeUp = 1;
          const data = (await res.json()) as {
            activeSockets?: number;
            bufferSize?: number;
          };
          activeSockets = Math.max(0, Number(data.activeSockets) || 0);
          remoteBufferSize = Math.max(0, Number(data.bufferSize) || 0);
        }
      } catch {
        bridgeUp = 0;
      }
    }

    const totalBufferedEvents =
      bufferStats.localBufferSize +
      (bufferStats.redisEnabled && bufferStats.redisConnected
        ? bufferStats.redisBufferSize
        : remoteBufferSize);

    let activeClientsCount = 0;
    let revokedClientsCount = 0;
    let totalEventsCounter = 0;
    for (const c of clients) {
      totalEventsCounter += Math.max(0, Number(c.totalEvents) || 0);
      if (c.status === "revoked") {
        revokedClientsCount += 1;
      } else {
        activeClientsCount += 1;
      }
    }

    const lines: string[] = [
      "# HELP datastack_up Whether the DataStack control plane is up (1 = healthy).",
      "# TYPE datastack_up gauge",
      "datastack_up 1",
      "# HELP datastack_ingestion_bridge_up Whether the Port 4000 Socket.IO ingestion engine is reachable (1 = reachable, 0 = unreachable).",
      "# TYPE datastack_ingestion_bridge_up gauge",
      `datastack_ingestion_bridge_up ${bridgeUp}`,
      "# HELP datastack_active_sockets Currently connected Socket.IO SDK clients on Port 4000.",
      "# TYPE datastack_active_sockets gauge",
      `datastack_active_sockets ${activeSockets}`,
      "# HELP datastack_events_total Cumulative events ingested across all registered clients.",
      "# TYPE datastack_events_total counter",
      `datastack_events_total ${Math.max(totalEventsCounter, storageStats.totalRows)}`,
      "# HELP datastack_buffer_events_total Total events currently queued in memory or Redis awaiting CSV flush.",
      "# TYPE datastack_buffer_events_total gauge",
      `datastack_buffer_events_total ${totalBufferedEvents}`,
      "# HELP datastack_storage_files_total Total CSV and gzipped CSV partition files on disk.",
      "# TYPE datastack_storage_files_total gauge",
      `datastack_storage_files_total ${storageStats.totalFiles}`,
      "# HELP datastack_storage_bytes_total Total bytes occupied by CSV and gzipped CSV partition files on disk.",
      "# TYPE datastack_storage_bytes_total gauge",
      `datastack_storage_bytes_total ${storageStats.totalBytes}`,
      "# HELP datastack_storage_rows_total Total telemetry rows persisted across all partition files.",
      "# TYPE datastack_storage_rows_total gauge",
      `datastack_storage_rows_total ${storageStats.totalRows}`,
      "# HELP datastack_disk_used_percent Percentage of underlying filesystem capacity currently used.",
      "# TYPE datastack_disk_used_percent gauge",
      `datastack_disk_used_percent ${diskHealth.usedPct}`,
      "# HELP datastack_disk_free_bytes Free bytes available on the underlying storage volume.",
      "# TYPE datastack_disk_free_bytes gauge",
      `datastack_disk_free_bytes ${diskHealth.availableBytes}`,
      "# HELP datastack_disk_total_bytes Total capacity in bytes of the underlying storage volume.",
      "# TYPE datastack_disk_total_bytes gauge",
      `datastack_disk_total_bytes ${diskHealth.totalBytes}`,
      "# HELP datastack_clients_total Number of registered SDK clients partitioned by status.",
      "# TYPE datastack_clients_total gauge",
      `datastack_clients_total{status="active"} ${activeClientsCount}`,
      `datastack_clients_total{status="revoked"} ${revokedClientsCount}`,
      "# HELP datastack_client_events_total Cumulative ingested events per registered client.",
      "# TYPE datastack_client_events_total counter",
    ];

    for (const c of clients) {
      const safeId = escapePrometheusLabel(c.clientId);
      lines.push(
        `datastack_client_events_total{client_id="${safeId}"} ${Math.max(0, Number(c.totalEvents) || 0)}`,
      );
    }

    lines.push(
      "# HELP datastack_client_storage_bytes Disk usage in bytes per registered client.",
      "# TYPE datastack_client_storage_bytes gauge",
    );

    const perClientBytes = new Map<string, number>();
    for (const f of allFiles) {
      perClientBytes.set(
        f.clientId,
        (perClientBytes.get(f.clientId) || 0) + f.sizeBytes,
      );
    }
    for (const c of clients) {
      const safeId = escapePrometheusLabel(c.clientId);
      const usedBytes = perClientBytes.get(c.clientId) || 0;
      lines.push(
        `datastack_client_storage_bytes{client_id="${safeId}"} ${usedBytes}`,
      );
    }

    const body = `${lines.join("\n")}\n`;
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to generate Prometheus metrics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
