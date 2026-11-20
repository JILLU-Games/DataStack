import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { io as ioClient, type Socket } from "socket.io-client";
import { PATCH as patchClientRoute } from "../app/api/clients/[id]/route";
import { POST as clientsPost } from "../app/api/clients/route";
import { POST as eventsPost } from "../app/api/events/route";
import { GET as exportGet } from "../app/api/export/route";
import { GET as healthGet } from "../app/api/health/route";
import { GET as prometheusGet } from "../app/api/prometheus/route";
import { POST as settingsPost } from "../app/api/settings/route";
import { POST as webhookTestPost } from "../app/api/settings/webhook-test/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import {
  buildWebhookSignature,
  clearWebhookCooldownCacheForTests,
  dispatchWebhookAlertAsync,
  formatOutboundWebhookBody,
} from "../core/alerts/webhookNotifier";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  createInitialAdmin,
  resetAdminStateForTests,
} from "../core/auth/adminUsers";
import { DataBufferEngine } from "../core/data/buffer";
import { SDKManager } from "../core/sdk/sdkManager";
import {
  isClientIpAllowed,
  isClientTokenExpired,
  validateAllowedIpsInput,
  validateClientExpiresAtInput,
} from "../core/Security/ipAllowlist";
import { CSVStorageManager } from "../core/Storage/csvStorage";
import {
  DEFAULT_ALERTING_SETTINGS,
  DEFAULT_EDITABLE_SETTINGS,
  normalizeAlertingSettings,
  settingsToNumericDrafts,
  validateEditableSettingsDraft,
  validateSingleNumericSetting,
} from "../lib/vconUiHelpers";

const require = createRequire(import.meta.url);

async function makeAdminCookie(): Promise<string> {
  resetAdminStateForTests();
  await createInitialAdmin("v2-p2@datastack.dev", "V2Phase02Pass!");
  const secret = getAdminSessionSecret()!;
  const token = await createAdminSessionToken(
    "v2-p2@datastack.dev",
    secret,
    Date.now() + 3600_000,
    1,
  );
  return `datastack_admin_session=${token}`;
}

test("V2-Phase-02 [IP Allowlist & Token Expiry]: validateAllowedIpsInput, isClientIpAllowed (IPv4/IPv6/CIDR) & isClientTokenExpired", () => {
  // Valid empty or wildcard
  assert.deepEqual(validateAllowedIpsInput(""), { valid: true, normalized: "" });
  assert.deepEqual(validateAllowedIpsInput("  "), { valid: true, normalized: "" });
  assert.deepEqual(validateAllowedIpsInput("*"), { valid: true, normalized: "*" });

  // Valid comma-separated IPv4, IPv4 CIDR, IPv6, IPv6 CIDR
  const validList = validateAllowedIpsInput(
    "203.0.113.10, 10.0.0.0/8, ::ffff:192.0.2.5, 2001:db8::/32, 203.0.113.10",
  );
  assert.equal(validList.valid, true);
  if (validList.valid) {
    assert.equal(
      validList.normalized,
      "203.0.113.10, 10.0.0.0/8, 192.0.2.5, 2001:db8::/32",
    );
  }

  // Invalid IP or CIDR prefix rejected
  const badCidr = validateAllowedIpsInput("10.0.0.0/33");
  assert.equal(badCidr.valid, false);
  const badIp = validateAllowedIpsInput("999.888.777.666");
  assert.equal(badIp.valid, false);

  // Matching behavior
  assert.equal(isClientIpAllowed("198.51.100.77", ""), true);
  assert.equal(isClientIpAllowed("198.51.100.77", "*"), true);
  assert.equal(
    isClientIpAllowed("203.0.113.10", "203.0.113.10, 10.0.0.0/8"),
    true,
  );
  assert.equal(
    isClientIpAllowed("::ffff:203.0.113.10", "203.0.113.10, 10.0.0.0/8"),
    true,
  );
  assert.equal(
    isClientIpAllowed("10.24.99.1", "203.0.113.10, 10.0.0.0/8"),
    true,
  );
  assert.equal(
    isClientIpAllowed("192.168.1.50", "203.0.113.10, 10.0.0.0/8"),
    false,
  );
  // Loopback equivalence between 127.0.0.1 and ::1
  assert.equal(isClientIpAllowed("::1", "127.0.0.1"), true);
  assert.equal(isClientIpAllowed("127.0.0.1", "::1"), true);

  // BUG-V2-AUDIT-06: IPv6 CIDR (/0..128) BlockList matching & bracketed/port/zone normalization
  assert.equal(
    isClientIpAllowed("2001:db8:abcd:0012::1", "2001:db8::/32"),
    true,
  );
  assert.equal(
    isClientIpAllowed("[2001:db8:abcd:0012::99]:8443", "2001:db8::/32"),
    true,
  );
  assert.equal(
    isClientIpAllowed("2001:db9::1", "2001:db8::/32"),
    false,
  );
  assert.equal(
    isClientIpAllowed("fe80::1ff:fe23:4567:890a%eth0", "fe80::/64"),
    true,
  );
  assert.equal(
    isClientIpAllowed("203.0.113.10:54321", "203.0.113.0/24"),
    true,
  );

  // Expiration validation & evaluation
  assert.deepEqual(validateClientExpiresAtInput(null), {
    valid: true,
    iso: null,
  });
  assert.deepEqual(validateClientExpiresAtInput(""), {
    valid: true,
    iso: null,
  });
  const validExp = validateClientExpiresAtInput("2030-06-15T12:00:00.000Z");
  assert.equal(validExp.valid, true);
  if (validExp.valid) {
    assert.equal(validExp.iso, "2030-06-15T12:00:00.000Z");
  }
  const badExp = validateClientExpiresAtInput("not-a-timestamp");
  assert.equal(badExp.valid, false);

  const nowMs = Date.parse("2026-11-19T12:00:00.000Z");
  assert.equal(isClientTokenExpired(null, nowMs), false);
  assert.equal(isClientTokenExpired("2026-11-19T12:00:01.000Z", nowMs), false);
  assert.equal(isClientTokenExpired("2026-11-19T12:00:00.000Z", nowMs), true);
  assert.equal(isClientTokenExpired("2026-11-19T11:59:59.000Z", nowMs), true);
});

test("V2-Phase-02 [Webhook Notifier & /api/settings/webhook-test]: HMAC-SHA256 signing, cooldown suppression & V2-E06 error handling", async () => {
  clearWebhookCooldownCacheForTests();
  const receivedRequests: Array<{
    headers: http.IncomingHttpHeaders;
    body: string;
    json: Record<string, unknown>;
  }> = [];
  let responseStatus = 200;

  const mockWebhookServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(bodyStr);
      } catch {
        // ignore
      }
      receivedRequests.push({
        headers: req.headers,
        body: bodyStr,
        json: parsed,
      });
      res.writeHead(responseStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: responseStatus < 400 }));
    });
  });

  await new Promise<void>((resolve) => mockWebhookServer.listen(0, "127.0.0.1", resolve));
  const port = (mockWebhookServer.address() as AddressInfo).port;
  const webhookUrl = `http://127.0.0.1:${port}/hooks/datastack`;

  try {
    // 1. Format & signature verification
    const formattedJsonStr = formatOutboundWebhookBody({
      event: "DISK_SPACE_LOW",
      severity: "critical",
      title: "Disk Threshold Reached",
      message: "VPS disk is at 95.4%.",
      clientId: "svc_alpha",
      timestamp: "2026-11-19T12:00:00.000Z",
      details: { usedPct: 95.4 },
    });
    const formatted = JSON.parse(formattedJsonStr) as {
      text: string;
      content: string;
    };
    assert.ok(formatted.text.includes("DISK_SPACE_LOW"));
    assert.equal(formatted.content, formatted.text);

    const sig = buildWebhookSignature(formattedJsonStr, "webhook_secret_xyz");
    assert.ok(sig.startsWith("sha256="));

    // 2. Cooldown deduplication test
    const first = await dispatchWebhookAlertAsync(
      {
        event: "STORAGE_QUOTA_EXCEEDED",
        severity: "warning",
        title: "Client Quota Exceeded",
        message: "Quota reached for svc_alpha",
        clientId: "svc_alpha",
      },
      {
        enabled: true,
        webhookUrl,
        webhookSecret: "webhook_secret_xyz",
        cooldownSec: 120,
      },
    );
    assert.equal(first.ok, true);
    assert.equal(receivedRequests.length, 1);
    assert.equal(
      receivedRequests[0].headers["x-datastack-event"],
      "STORAGE_QUOTA_EXCEEDED",
    );
    assert.equal(
      receivedRequests[0].headers["x-datastack-signature"],
      buildWebhookSignature(receivedRequests[0].body, "webhook_secret_xyz"),
    );

    // Duplicate event for same client within cooldown window is suppressed
    const second = await dispatchWebhookAlertAsync(
      {
        event: "STORAGE_QUOTA_EXCEEDED",
        severity: "warning",
        title: "Client Quota Exceeded",
        message: "Quota reached again for svc_alpha",
        clientId: "svc_alpha",
      },
      {
        enabled: true,
        webhookUrl,
        webhookSecret: "webhook_secret_xyz",
        cooldownSec: 120,
      },
    );
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "COOLDOWN_ACTIVE");
    assert.equal(receivedRequests.length, 1);

    // 3. Test POST /api/settings/webhook-test route (200 & 502 WEBHOOK_DELIVERY_FAILED V2-E06)
    const adminCookie = await makeAdminCookie();
    const okTestReq = new NextRequest("http://localhost:3000/api/settings/webhook-test", {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        webhookUrl,
        webhookSecret: "test_route_hmac_secret",
      }),
    });
    const okTestRes = await webhookTestPost(okTestReq);
    assert.equal(okTestRes.status, 200);
    const okTestData = await okTestRes.json();
    assert.equal(okTestData.success, true);
    assert.equal(receivedRequests.length, 2);
    assert.equal(receivedRequests[1].headers["x-datastack-event"], "TEST_ALERT");

    // Simulate upstream 500 error -> 502 WEBHOOK_DELIVERY_FAILED (V2-E06)
    responseStatus = 500;
    const failTestReq = new NextRequest("http://localhost:3000/api/settings/webhook-test", {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        webhookUrl,
      }),
    });
    const failTestRes = await webhookTestPost(failTestReq);
    assert.equal(failTestRes.status, 502);
    const failTestData = await failTestRes.json();
    assert.equal(failTestData.code, "WEBHOOK_DELIVERY_FAILED");
  } finally {
    await new Promise<void>((resolve) => mockWebhookServer.close(() => resolve()));
    await DataBufferEngine.shutdown();
    resetAdminStateForTests();
  }
});

test("V2-Phase-02 [HTTP & Socket Ingestion Security]: Per-client IP allowlist (403 V2-E07) & Token expiration (401 V2-E08)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-v2-p2-sec-"));
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const prevDisableListen = process.env.DATASTACK_DISABLE_LISTEN;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  process.env.DATASTACK_DISABLE_LISTEN = "1";
  delete process.env.DATABASE_URL;

  const origBaseStorageDir = CSVStorageManager.baseStorageDir;
  CSVStorageManager.baseStorageDir = tmpDir;
  CSVStorageManager.clearQuotaCaches();
  clearWebhookCooldownCacheForTests();

  const serverMod = require("../server/index.js") as {
    server: http.Server;
    io: { close: (cb: () => void) => void };
    writer: { baseDir: string; clearQuotaCaches: () => void };
    verifyClientInDb: (
      clientId: string,
      token: string,
      bypassCache?: boolean,
      clientIp?: string,
    ) => Promise<{ ok: boolean; reason?: string }>;
    setDbPoolForTests: (pool: unknown) => void;
    stopTimers: () => void;
  };
  const origWriterBaseDir = serverMod.writer.baseDir;
  serverMod.writer.baseDir = tmpDir;
  serverMod.writer.clearQuotaCaches();

  const openSockets: Socket[] = [];

  try {
    const adminCookie = await makeAdminCookie();

    // 1. Create client with strict IP allowlist (only 10.10.0.0/16) and future expiration
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    const createRes = await clientsPost(
      new NextRequest("http://localhost:3000/api/clients", {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId: "ip_restricted_svc",
          name: "IP Restricted Client",
          rateLimit: 100,
          storageQuotaMb: 0,
          allowedIps: "10.10.0.0/16",
          expiresAt: futureIso,
        }),
      }),
    );
    assert.equal(createRes.status, 201);
    const createData = await createRes.json();
    const client = createData.client;
    assert.equal(client.allowedIps, "10.10.0.0/16");
    assert.equal(client.expiresAt, futureIso);

    // 2. Request from forbidden IP 192.168.1.25 -> 403 CLIENT_IP_FORBIDDEN (V2-E07)
    const forbiddenIpRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${client.token}`,
          "content-type": "application/json",
          "x-forwarded-for": "192.168.1.25",
        },
        body: JSON.stringify({
          eventId: "evt_ip_denied",
          data: { step: 1 },
        }),
      }),
    );
    assert.equal(forbiddenIpRes.status, 403);
    const forbiddenIpJson = await forbiddenIpRes.json();
    assert.equal(forbiddenIpJson.code, "CLIENT_IP_FORBIDDEN");

    // 3. Request from allowed CIDR IP 10.10.42.9 -> 200 OK
    const allowedIpRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${client.token}`,
          "content-type": "application/json",
          "x-forwarded-for": "10.10.42.9",
        },
        body: JSON.stringify({
          eventId: "evt_ip_allowed",
          data: { step: 2 },
        }),
      }),
    );
    assert.equal(allowedIpRes.status, 200);

    // 4. Patch client with past expiresAt -> 401 CLIENT_TOKEN_EXPIRED (V2-E08)
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const patchRes = await patchClientRoute(
      new NextRequest(
        `http://localhost:3000/api/clients/${encodeURIComponent(client.clientId)}`,
        {
          method: "PATCH",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            expiresAt: pastIso,
          }),
        },
      ),
      { params: Promise.resolve({ id: client.clientId }) },
    );
    assert.equal(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.equal(patchData.client.expiresAt, pastIso);

    const expiredRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${client.token}`,
          "content-type": "application/json",
          "x-forwarded-for": "10.10.42.9",
        },
        body: JSON.stringify({
          eventId: "evt_expired",
          data: { step: 3 },
        }),
      }),
    );
    assert.equal(expiredRes.status, 401);
    const expiredJson = await expiredRes.json();
    assert.equal(expiredJson.code, "CLIENT_TOKEN_EXPIRED");

    // 5. Verify Port 4000 Socket.IO server enforces IP allowlist & token expiry
    let mockExpiresAt: string | null = pastIso;
    const mockAllowedIps = "10.10.0.0/16";
    serverMod.setDbPoolForTests({
      query: async (sql: string) => {
        if (sql.includes("FROM client_sdks")) {
          return {
            rowCount: 1,
            rows: [
              {
                client_id: client.clientId,
                token: client.token,
                status: "active",
                rate_limit: 100,
                storage_quota_mb: 0,
                allowed_ips: mockAllowedIps,
                expires_at: mockExpiresAt,
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    });

    const expiredCheck = await serverMod.verifyClientInDb(
      client.clientId,
      client.token,
      true,
      "10.10.42.9",
    );
    assert.equal(expiredCheck.allowed, false);
    assert.equal(expiredCheck.code, "CLIENT_TOKEN_EXPIRED");

    // Clear expiration, keep IP allowlist 10.10.0.0/16, and check 127.0.0.1
    mockExpiresAt = null;
    const ipForbiddenCheck = await serverMod.verifyClientInDb(
      client.clientId,
      client.token,
      true,
      "127.0.0.1",
    );
    assert.equal(ipForbiddenCheck.allowed, false);
    assert.equal(ipForbiddenCheck.code, "CLIENT_IP_FORBIDDEN");

    // Start Port 4000 server on ephemeral port and verify Socket.IO handshake from 127.0.0.1 is rejected with CLIENT_IP_FORBIDDEN
    await new Promise<void>((resolve) =>
      serverMod.server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port4000 = (serverMod.server.address() as AddressInfo).port;

    const socketError = await new Promise<string>((resolve) => {
      const sock: Socket = ioClient(`http://127.0.0.1:${port4000}`, {
        auth: { clientId: client.clientId, token: client.token },
        transports: ["websocket"],
        reconnection: false,
        timeout: 3000,
      });
      openSockets.push(sock);
      sock.on("connect_error", (err) => {
        sock.disconnect();
        resolve(err.message);
      });
      sock.on("connect", () => {
        sock.disconnect();
        resolve("CONNECTED_UNEXPECTEDLY");
      });
    });
    assert.ok(socketError.includes("CLIENT_IP_FORBIDDEN"));
  } finally {
    for (const s of openSockets) {
      try {
        s.disconnect();
      } catch {
        // ignore
      }
    }
    serverMod.writer.baseDir = origWriterBaseDir;
    serverMod.writer.clearQuotaCaches();
    serverMod.setDbPoolForTests(null);
    serverMod.stopTimers();
    await new Promise<void>((resolve) => {
      serverMod.io.close(() => {
        if (serverMod.server.listening) {
          serverMod.server.close(() => resolve());
        } else {
          resolve();
        }
      });
    });
    SDKManager.stopActivityFlushTimerForTests();
    CSVStorageManager.clearQuotaCaches();
    await DataBufferEngine.shutdown();
    CSVStorageManager.baseStorageDir = origBaseStorageDir;
    if (prevStorageDir === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    if (prevDisableListen === undefined) delete process.env.DATASTACK_DISABLE_LISTEN;
    else process.env.DATASTACK_DISABLE_LISTEN = prevDisableListen;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpDir, { recursive: true, force: true });
    resetAdminStateForTests();
  }
});

test("V2-Phase-02 [Prometheus Metrics & NDJSON Streaming Export]: GET /api/prometheus (V2-FEAT-04 / V2-E09) & GET /api/export?format=ndjson (V2-FEAT-06)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-v2-p2-prom-"));
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  delete process.env.DATABASE_URL;

  const origBaseStorageDir = CSVStorageManager.baseStorageDir;
  CSVStorageManager.baseStorageDir = tmpDir;
  CSVStorageManager.clearQuotaCaches();

  try {
    const adminCookie = await makeAdminCookie();

    // 1. Unauthenticated scrape when Prometheus is disabled -> 401 PROMETHEUS_UNAUTHORIZED (V2-E09)
    const unauthPromRes = await prometheusGet(
      new NextRequest("http://localhost:3000/api/prometheus"),
    );
    assert.equal(unauthPromRes.status, 401);
    const unauthPromJson = await unauthPromRes.json();
    assert.equal(unauthPromJson.code, "PROMETHEUS_UNAUTHORIZED");

    // 2. Configure Webhook & Prometheus settings via POST /api/settings
    const saveSettingsRes = await settingsPost(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enableWebhookAlerts: true,
          webhookUrl: "https://hooks.example.com/datastack",
          webhookSecret: "super_secret_webhook_hmac_9988",
          webhookCooldownSec: 180,
          enablePrometheusMetrics: true,
          prometheusMetricsToken: "prom_scrape_bearer_token_7766",
        }),
      }),
    );
    assert.equal(saveSettingsRes.status, 200);
    const savedData = await saveSettingsRes.json();
    assert.equal(savedData.settings.enableWebhookAlerts, true);
    assert.equal(savedData.settings.webhookCooldownSec, 180);
    assert.equal(savedData.settings.hasWebhookSecret, true);
    assert.equal(savedData.settings.webhookSecretMask, "••••9988");
    assert.equal("webhookSecretEnc" in savedData.settings, false);
    assert.equal(savedData.settings.enablePrometheusMetrics, true);
    assert.equal(savedData.settings.hasPrometheusToken, true);
    assert.equal(savedData.settings.prometheusTokenMask, "••••7766");
    assert.equal("prometheusMetricsTokenEnc" in savedData.settings, false);

    // 3. Wrong Bearer token -> 401 PROMETHEUS_UNAUTHORIZED (V2-E09)
    const wrongTokenRes = await prometheusGet(
      new NextRequest("http://localhost:3000/api/prometheus", {
        headers: {
          authorization: "Bearer wrong_token_value",
        },
      }),
    );
    assert.equal(wrongTokenRes.status, 401);

    // 4. Valid Bearer token -> 200 Prometheus text exposition format
    const validTokenRes = await prometheusGet(
      new NextRequest("http://localhost:3000/api/prometheus", {
        headers: {
          authorization: "Bearer prom_scrape_bearer_token_7766",
        },
      }),
    );
    assert.equal(validTokenRes.status, 200);
    assert.ok(
      validTokenRes.headers
        .get("content-type")
        ?.includes("text/plain; version=0.0.4"),
    );
    const metricsBody = await validTokenRes.text();
    assert.ok(metricsBody.includes("datastack_up 1"));
    assert.ok(metricsBody.includes("datastack_events_total"));
    assert.ok(metricsBody.includes("datastack_storage_bytes_total"));
    assert.ok(metricsBody.includes("datastack_disk_used_percent"));

    // 5. Seed events and export as streaming NDJSON (GET /api/export?format=ndjson) (V2-FEAT-06)
    await CSVStorageManager.appendBatch([
      {
        clientId: "client_ndjson",
        eventId: "evt_nd_1",
        timestamp: "2026-11-19T10:00:00.000Z",
        payload: JSON.stringify({ action: "purchase", amount: 49 }),
      },
      {
        clientId: "client_ndjson",
        eventId: "evt_nd_2",
        timestamp: "2026-11-19T10:01:00.000Z",
        payload: JSON.stringify({ action: "refund", amount: 12 }),
      },
    ]);

    const ndjsonRes = await exportGet(
      new NextRequest(
        "http://localhost:3000/api/export?format=ndjson&clientId=client_ndjson",
        {
          headers: { cookie: adminCookie },
        },
      ),
    );
    assert.equal(ndjsonRes.status, 200);
    assert.ok(
      ndjsonRes.headers
        .get("content-type")
        ?.includes("application/x-ndjson"),
    );
    const disposition = ndjsonRes.headers.get("content-disposition") || "";
    assert.ok(
      disposition.includes("client_ndjson_export_") &&
        disposition.endsWith('.ndjson"'),
    );
    const ndjsonText = await ndjsonRes.text();
    const lines = ndjsonText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].clientId, "client_ndjson");
    assert.equal(lines[0].eventId, "evt_nd_1");
    assert.deepEqual(lines[0].payload, { action: "purchase", amount: 49 });
    assert.equal(lines[1].eventId, "evt_nd_2");
    assert.deepEqual(lines[1].payload, { action: "refund", amount: 12 });

    // 6. Verify UI helper validation for webhookCooldownSec & normalizeAlertingSettings
    assert.equal(
      validateSingleNumericSetting("webhookCooldownSec", "5").valid,
      false,
    );
    assert.equal(
      validateSingleNumericSetting("webhookCooldownSec", "300").valid,
      true,
    );
    const drafts = settingsToNumericDrafts(DEFAULT_EDITABLE_SETTINGS);
    const validatedDraft = validateEditableSettingsDraft(drafts, true);
    assert.equal(validatedDraft.valid, true);
    assert.deepEqual(validatedDraft.values, DEFAULT_EDITABLE_SETTINGS);
    assert.deepEqual(
      normalizeAlertingSettings(undefined),
      DEFAULT_ALERTING_SETTINGS,
    );
  } finally {
    await SettingsManager.updateSettingsAsync({
      enableWebhookAlerts: false,
      webhookUrl: "",
      clearWebhookSecret: true,
      webhookCooldownSec: 300,
      enablePrometheusMetrics: false,
      clearPrometheusToken: true,
    });
    SDKManager.stopActivityFlushTimerForTests();
    await DataBufferEngine.shutdown();
    CSVStorageManager.clearQuotaCaches();
    CSVStorageManager.baseStorageDir = origBaseStorageDir;
    if (prevStorageDir === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpDir, { recursive: true, force: true });
    resetAdminStateForTests();
  }
});

test("V2-Audit-Phase-02 [BUG-V2-AUDIT-05, BUG-V2-AUDIT-06, BUG-V2-AUDIT-08]: Port 4000 outbound webhook alerts, IPv6 CIDR parity & GET /api/health expiry/IP checks", async () => {
  const prevDisableListen = process.env.DATASTACK_DISABLE_LISTEN;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.DATASTACK_DISABLE_LISTEN = "1";
  delete process.env.DATABASE_URL;

  const serverIndex = require("../server/index.js");
  const { Server: SocketIOServer } = require("socket.io");
  const { setupSocketHandlers } = require("../server/socket/handlers.js");

  // 1. BUG-V2-AUDIT-06: Port 4000 isClientIpAllowed supports IPv6 CIDR (/0..128) and semicolon delimiters
  assert.equal(
    serverIndex.isClientIpAllowed("2001:db8:1234::5", "10.0.0.0/8; 2001:db8::/32"),
    true,
  );
  assert.equal(
    serverIndex.isClientIpAllowed("[2001:db8:9999::1]:9443", "2001:db8::/32"),
    true,
  );
  assert.equal(
    serverIndex.isClientIpAllowed("2001:db9::1", "2001:db8::/32"),
    false,
  );
  assert.equal(
    serverIndex.isClientIpAllowed("fe80::1234%eth0", "fe80::/64"),
    true,
  );

  // 2. BUG-V2-AUDIT-05: Port 4000 Socket.IO outbound webhook alerts with HMAC-SHA256 signature
  const receivedPort4000Webhooks: Array<{
    headers: http.IncomingHttpHeaders;
    body: string;
    json: Record<string, unknown>;
  }> = [];

  const mockWebhookServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(bodyStr);
      } catch {
        parsed = {};
      }
      receivedPort4000Webhooks.push({
        headers: req.headers,
        body: bodyStr,
        json: parsed,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) =>
    mockWebhookServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const webhookPort = (mockWebhookServer.address() as AddressInfo).port;
  const webhookUrl = `http://127.0.0.1:${webhookPort}/socket-hook`;

  const testHttpServer = http.createServer();
  const testIo = new SocketIOServer(testHttpServer);

  const forbiddenClient = await SDKManager.registerClientAsync({
    clientId: "audit05_forbidden_sock",
    name: "Audit05ForbiddenSocketClient",
    rateLimit: 100,
    storageQuotaMb: 0,
    allowedIps: "203.0.113.99",
    expiresAt: null,
  });

  setupSocketHandlers(testIo, [], serverIndex.writer, {
    getRuntimeConfig: () => serverIndex.runtimeConfig,
    verifyClientInDb: async (cid: string, _tok: string, _bypass: boolean, ip: string) => {
      if (cid === forbiddenClient.clientId && !serverIndex.isClientIpAllowed(ip, "203.0.113.99")) {
        return {
          allowed: false,
          code: "CLIENT_IP_FORBIDDEN",
          reason: `CLIENT_IP_FORBIDDEN: IP ${ip} is not allowed for ${cid}`,
        };
      }
      return { allowed: true, rateLimit: 100 };
    },
    triggerWebhookAlert: serverIndex.triggerWebhookAlert,
  });

  await new Promise<void>((resolve) =>
    testHttpServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const socketPort = (testHttpServer.address() as AddressInfo).port;

  try {
    serverIndex.clearWebhookCooldownCacheForTests();
    serverIndex.applyRuntimeSettingsObject({
      enableWebhookAlerts: true,
      webhookUrl,
      webhookSecret: "port4000_shared_hmac_secret",
      webhookCooldownSec: 60,
    });

    // Attempt Socket.IO connection from 127.0.0.1 (not in 203.0.113.99 allowlist)
    const sock: Socket = ioClient(`http://127.0.0.1:${socketPort}`, {
      auth: { token: forbiddenClient.token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 2000,
    });

    const connectErr = await new Promise<Error>((resolve, reject) => {
      sock.on("connect", () => {
        sock.disconnect();
        reject(new Error("Expected Socket.IO handshake rejection for forbidden IP"));
      });
      sock.on("connect_error", (err) => {
        sock.disconnect();
        resolve(err);
      });
    });

    assert.ok(connectErr.message.includes("CLIENT_IP_FORBIDDEN"));

    // Wait briefly for asynchronous webhook alert dispatch
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(receivedPort4000Webhooks.length, 1);
    assert.equal(
      receivedPort4000Webhooks[0].headers["x-datastack-event"],
      "CLIENT_IP_FORBIDDEN",
    );
    const expectedSig = buildWebhookSignature(
      receivedPort4000Webhooks[0].body,
      "port4000_shared_hmac_secret",
    );
    assert.equal(
      receivedPort4000Webhooks[0].headers["x-datastack-signature"],
      expectedSig,
    );
    assert.equal(
      receivedPort4000Webhooks[0].json.clientId,
      forbiddenClient.clientId,
    );

    // 3. BUG-V2-AUDIT-08: GET /api/health enforces CLIENT_TOKEN_EXPIRED (401) and CLIENT_IP_FORBIDDEN (403)
    const expiredHealthClient = await SDKManager.registerClientAsync({
      clientId: "audit08_expired_health",
      name: "Audit08ExpiredHealthClient",
      rateLimit: 100,
      storageQuotaMb: 0,
      allowedIps: "",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const expiredHealthRes = await healthGet(
      new NextRequest("http://localhost:3000/api/health", {
        headers: {
          authorization: `Bearer ${expiredHealthClient.token}`,
        },
      }),
    );
    assert.equal(expiredHealthRes.status, 401);
    const expiredHealthBody = await expiredHealthRes.json();
    assert.equal(expiredHealthBody.code, "CLIENT_TOKEN_EXPIRED");

    const forbiddenHealthRes = await healthGet(
      new NextRequest("http://localhost:3000/api/health", {
        headers: {
          authorization: `Bearer ${forbiddenClient.token}`,
          "x-real-ip": "198.51.100.44",
        },
      }),
    );
    assert.equal(forbiddenHealthRes.status, 403);
    const forbiddenHealthBody = await forbiddenHealthRes.json();
    assert.equal(forbiddenHealthBody.code, "CLIENT_IP_FORBIDDEN");
  } finally {
    serverIndex.applyRuntimeSettingsObject({
      enableWebhookAlerts: false,
      webhookUrl: "",
      webhookSecret: "",
      webhookCooldownSec: 300,
    });
    serverIndex.stopTimers();
    SDKManager.stopActivityFlushTimerForTests();
    await DataBufferEngine.shutdown();
    await new Promise<void>((resolve) => {
      testIo.close(() => resolve());
    });
    await new Promise<void>((resolve) =>
      mockWebhookServer.close(() => resolve()),
    );
    resetAdminStateForTests();
    if (prevDisableListen === undefined) delete process.env.DATASTACK_DISABLE_LISTEN;
    else process.env.DATASTACK_DISABLE_LISTEN = prevDisableListen;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  }
});
