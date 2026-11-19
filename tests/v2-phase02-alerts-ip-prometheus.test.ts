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
import { GET as clientsGet, POST as clientsPost } from "../app/api/clients/route";
import { POST as eventsPost } from "../app/api/events/route";
import { GET as exportGet } from "../app/api/export/route";
import { GET as prometheusGet } from "../app/api/prometheus/route";
import { GET as settingsGet, POST as settingsPost } from "../app/api/settings/route";
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

  // Expiration validation & evaluation
  assert.deepEqual(validateClientExpiresAtInput(null), {
    valid: true,
    normalized: null,
  });
  assert.deepEqual(validateClientExpiresAtInput(""), {
    valid: true,
    normalized: null,
  });
  const validExp = validateClientExpiresAtInput("2030-06-15T12:00:00.000Z");
  assert.equal(validExp.valid, true);
  if (validExp.valid) {
    assert.equal(validExp.normalized, "2030-06-15T12:00:00.000Z");
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
    const formatted = formatOutboundWebhookBody({
      event: "DISK_SPACE_LOW",
      severity: "critical",
      title: "Disk Threshold Reached",
      message: "VPS disk is at 95.4%.",
      clientId: "svc_alpha",
      timestamp: "2026-11-19T12:00:00.000Z",
      details: { usedPct: 95.4 },
    });
    assert.ok(formatted.text.includes("DISK_SPACE_LOW"));
    assert.equal(formatted.content, formatted.text);

    const bodyJson = JSON.stringify(formatted);
    const sig = buildWebhookSignature(bodyJson, "webhook_secret_xyz");
    assert.ok(sig.startsWith("sha256="));

    // 2. Cooldown deduplication test
    const first = await dispatchWebhookAlertAsync(
      {
        enabled: true,
        url: webhookUrl,
        secret: "webhook_secret_xyz",
        cooldownSec: 120,
      },
      {
        event: "CLIENT_QUOTA_EXCEEDED",
        severity: "warning",
        title: "Client Quota Exceeded",
        message: "Quota reached for svc_alpha",
        clientId: "svc_alpha",
      },
    );
    assert.equal(first.ok, true);
    assert.equal(receivedRequests.length, 1);
    assert.equal(
      receivedRequests[0].headers["x-datastack-event"],
      "CLIENT_QUOTA_EXCEEDED",
    );
    assert.equal(
      receivedRequests[0].headers["x-datastack-signature"],
      buildWebhookSignature(receivedRequests[0].body, "webhook_secret_xyz"),
    );

    // Duplicate event for same client within cooldown window is suppressed
    const second = await dispatchWebhookAlertAsync(
      {
        enabled: true,
        url: webhookUrl,
        secret: "webhook_secret_xyz",
        cooldownSec: 120,
      },
      {
        event: "CLIENT_QUOTA_EXCEEDED",
        severity: "warning",
        title: "Client Quota Exceeded",
        message: "Quota reached again for svc_alpha",
        clientId: "svc_alpha",
      },
    );
    assert.equal(second.ok, true);
    assert.equal(second.suppressedByCooldown, true);
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
  }
});

test("V2-Phase-02 [HTTP & Socket Ingestion Security]: Per-client IP allowlist (403 V2-E07) & Token expiration (401 V2-E08)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-v2-p2-sec-"));
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  CSVStorageManager.resetForTests(tmpDir);
  await CSVStorageManager.initializeAsync();
  clearWebhookCooldownCacheForTests();

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
          name: "IP Restricted Client",
          rateLimit: 100,
          storageQuotaMb: 0,
          allowedIps: "10.10.0.0/16",
          expiresAt: futureIso,
        }),
      }),
    );
    assert.equal(createRes.status, 200);
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
          payload: { step: 1 },
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
          payload: { step: 2 },
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
          payload: { step: 3 },
        }),
      }),
    );
    assert.equal(expiredRes.status, 401);
    const expiredJson = await expiredRes.json();
    assert.equal(expiredJson.code, "CLIENT_TOKEN_EXPIRED");

    // 5. Verify Port 4000 Socket.IO server enforces IP allowlist & token expiry
    process.env.DATASTACK_DISABLE_LISTEN = "1";
    const ingestionApp = require("../server/index.js");

    // Sync expired client to Port 4000 in-memory cache and verify verifyClientInDb returns CLIENT_TOKEN_EXPIRED
    await new Promise<void>((resolve) =>
      ingestionApp.server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port4000 = (ingestionApp.server.address() as AddressInfo).port;

    try {
      const expiredCheck = await ingestionApp.verifyClientInDb(
        client.clientId,
        client.token,
        true,
        "10.10.42.9",
      );
      assert.equal(expiredCheck.ok, false);
      assert.equal(expiredCheck.reason, "CLIENT_TOKEN_EXPIRED");

      // Clear expiration via PATCH, keep IP allowlist 10.10.0.0/16, and check Socket.IO handshake from 127.0.0.1
      await patchClientRoute(
        new NextRequest(
          `http://localhost:3000/api/clients/${encodeURIComponent(client.clientId)}`,
          {
            method: "PATCH",
            headers: {
              cookie: adminCookie,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              expiresAt: null,
            }),
          },
        ),
        { params: Promise.resolve({ id: client.clientId }) },
      );

      const ipForbiddenCheck = await ingestionApp.verifyClientInDb(
        client.clientId,
        client.token,
        true,
        "127.0.0.1",
      );
      assert.equal(ipForbiddenCheck.ok, false);
      assert.equal(ipForbiddenCheck.reason, "CLIENT_IP_FORBIDDEN");

      // Socket.IO connection from 127.0.0.1 should fail handshake with CLIENT_IP_FORBIDDEN
      const socketError = await new Promise<string>((resolve) => {
        const sock: Socket = ioClient(`http://127.0.0.1:${port4000}`, {
          auth: { clientId: client.clientId, token: client.token },
          transports: ["websocket"],
          reconnection: false,
        });
        sock.on("connect_error", (err) => {
          sock.close();
          resolve(err.message);
        });
        sock.on("connect", () => {
          sock.close();
          resolve("CONNECTED_UNEXPECTEDLY");
        });
      });
      assert.ok(socketError.includes("CLIENT_IP_FORBIDDEN"));
    } finally {
      await new Promise<void>((resolve) =>
        ingestionApp.server.close(() => resolve()),
      );
    }
  } finally {
    await DataBufferEngine.flushAllAsync();
    SDKManager.stopActivityFlushTimerForTests();
    if (prevStorageDir === undefined) {
      delete process.env.DATASTACK_STORAGE_DIR;
    } else {
      process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    }
    CSVStorageManager.resetForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("V2-Phase-02 [Prometheus Metrics & NDJSON Streaming Export]: GET /api/prometheus (V2-FEAT-04 / V2-E09) & GET /api/export?format=ndjson (V2-FEAT-06)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-v2-p2-prom-"));
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  CSVStorageManager.resetForTests(tmpDir);
  await CSVStorageManager.initializeAsync();

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
    await CSVStorageManager.appendBatchAsync("client_ndjson", [
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
    assert.ok(
      ndjsonRes.headers
        .get("content-disposition")
        ?.includes("datastack-client_ndjson.ndjson"),
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
    await DataBufferEngine.flushAllAsync();
    SDKManager.stopActivityFlushTimerForTests();
    await SettingsManager.updateSettingsAsync({
      enableWebhookAlerts: false,
      webhookUrl: "",
      clearWebhookSecret: true,
      webhookCooldownSec: 300,
      enablePrometheusMetrics: false,
      clearPrometheusToken: true,
    });
    if (prevStorageDir === undefined) {
      delete process.env.DATASTACK_STORAGE_DIR;
    } else {
      process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    }
    CSVStorageManager.resetForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
