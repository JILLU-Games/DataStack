import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";

process.env.DATASTACK_DISABLE_LISTEN = "1";

import { POST as loginPost } from "../app/api/auth/login/route";
import { POST as eventsPost } from "../app/api/events/route";
import { POST as webhookTestPost } from "../app/api/settings/webhook-test/route";
import { POST as s3TestPost } from "../app/api/storage/s3-test/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import {
  clearWebhookCooldownCacheForTests,
  formatOutboundWebhookBody as formatPort3000WebhookBody,
} from "../core/alerts/webhookNotifier";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  clearAdminLoginAttempts,
  createAdminTeamMemberAsync,
  createInitialAdmin,
  deleteAdminTeamMemberAsync,
  listAdminTeamMembersAsync,
  resetAdminStateForTests,
} from "../core/auth/adminUsers";
import { AuthService } from "../core/auth/jwt";
import { DataBufferEngine } from "../core/data/buffer";
import { SDKManager } from "../core/sdk/sdkManager";
import { encryptSecret } from "../core/Security/secretVault";

const require = createRequire(import.meta.url);
const ingestionServer = require("../server/index.js") as {
  decryptVaultSecret: (ciphertext: string) => string;
  formatOutboundWebhookBody: (
    url: string,
    payload: Record<string, unknown>,
    timestamp?: string,
  ) => string;
  triggerWebhookAlert: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{ dispatched: boolean; status?: number; reason?: string }>;
  applyRuntimeSettingsObject: (settingsObj: Record<string, unknown>) => {
    jwtRotated: boolean;
  };
  runtimeConfig: Record<string, unknown>;
  clearWebhookCooldownCacheForTests: () => void;
  stopTimers: () => void;
};

test.after(async () => {
  ingestionServer.stopTimers();
  SDKManager.stopActivityFlushTimerForTests();
  await DataBufferEngine.shutdown();
  resetAdminStateForTests();
});

test("R3-Phase-01 [BUG-01]: Port 3000 encryptSecret() decrypts 1:1 on Port 4000 & Docker Compose passes DATASTACK_ADMIN_SESSION_SECRET", async () => {
  const prevSecret = process.env.DATASTACK_ADMIN_SESSION_SECRET;
  const prevNodeEnv = process.env.NODE_ENV;
  const testMaster = "r3-phase01-vault-master-secret-at-least-32-chars!!";
  try {
    process.env.DATASTACK_ADMIN_SESSION_SECRET = testMaster;
    const plaintext = "whsec_live_prod_hmac_99887766";
    const encrypted = encryptSecret(plaintext);
    assert.ok(encrypted.startsWith("v1:"), "Port 3000 vault must emit v1: prefix");

    // 1. Cross-runtime decryption matches 1:1
    assert.equal(ingestionServer.decryptVaultSecret(encrypted), plaintext);

    // 2. applyRuntimeSettingsObject hydrates plaintext webhookSecret from DB webhookSecretEnc
    ingestionServer.applyRuntimeSettingsObject({ webhookSecretEnc: encrypted });
    assert.equal(ingestionServer.runtimeConfig.webhookSecret, plaintext);

    // 3. Wrong master secret fails closed to "" (never leaks raw ciphertext as HMAC key)
    process.env.DATASTACK_ADMIN_SESSION_SECRET =
      "wrong-master-secret-that-is-32-chars-long-000";
    assert.equal(ingestionServer.decryptVaultSecret(encrypted), "");

    // 4. Legacy / unrecognized ciphertext format fails closed to "" (never returned verbatim)
    assert.equal(
      ingestionServer.decryptVaultSecret("enc:v1:invalid:payload"),
      "",
    );
    assert.equal(
      ingestionServer.decryptVaultSecret("plaintext-not-vault-format"),
      "",
    );

    // 5. Production mode without DATASTACK_ADMIN_SESSION_SECRET fails closed to ""
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.DATASTACK_ADMIN_SESSION_SECRET;
    assert.equal(ingestionServer.decryptVaultSecret(encrypted), "");

    // 6. Docker Compose passes DATASTACK_ADMIN_SESSION_SECRET to ingestion container
    const composeContent = fs.readFileSync(
      path.resolve(process.cwd(), "docker/docker-compose.yml"),
      "utf8",
    );
    const ingestionSection = composeContent.slice(
      composeContent.indexOf("  ingestion:"),
      composeContent.indexOf("  proxy:"),
    );
    assert.match(
      ingestionSection,
      /DATASTACK_ADMIN_SESSION_SECRET:\s*"\$\{SERVICE_REALBASE64_64_ADMINSESSION:/,
      "docker/docker-compose.yml ingestion service must receive DATASTACK_ADMIN_SESSION_SECRET",
    );
  } finally {
    if (prevSecret === undefined) {
      delete process.env.DATASTACK_ADMIN_SESSION_SECRET;
    } else {
      process.env.DATASTACK_ADMIN_SESSION_SECRET = prevSecret;
    }
    (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
  }
});

test("R3-Phase-01 [BUG-03]: Client SDK JWTs omit hardcoded 30d exp so Never-Expires and >30d clients stay valid", async () => {
  const clientId = `r3_jwt_longlived_${Date.now()}`;
  const farFutureIso = new Date(Date.now() + 180 * 86_400_000).toISOString();

  // 1. Explicit expiresIn still works when caller requests bounded JWT
  const boundedToken = AuthService.generateClientToken(
    { clientId: "bounded_test" },
    "1h",
  );
  const boundedDecoded = jwt.decode(boundedToken) as jwt.JwtPayload;
  assert.equal(typeof boundedDecoded.exp, "number");

  // 2. Registered client with expiresAt = null ("Never expires") has NO hardcoded 30d exp
  const neverClient = await SDKManager.registerClientAsync({
    clientId,
    name: "Long-Lived Telemetry Client",
    rateLimit: 100,
    expiresAt: null,
  });
  try {
    const decodedNever = jwt.decode(neverClient.token) as jwt.JwtPayload;
    assert.equal(
      decodedNever.exp,
      undefined,
      "Never-expires client token must not embed a hardcoded 30d JWT exp claim",
    );
    assert.equal(AuthService.verifyClientToken(neverClient.token).valid, true);

    // 3. Updating expiresAt to >30d future keeps the existing token valid without rotation
    const updated = await SDKManager.updateClientAsync(clientId, {
      expiresAt: farFutureIso,
    });
    assert.ok(updated);
    assert.equal(updated.expiresAt, farFutureIso);
    assert.equal(updated.token, neverClient.token);

    // 4. Regenerated token also omits hardcoded 30d exp
    const rotated = await SDKManager.regenerateTokenAsync(clientId);
    assert.ok(rotated);
    const decodedRotated = jwt.decode(rotated.token) as jwt.JwtPayload;
    assert.equal(decodedRotated.exp, undefined);
  } finally {
    await SDKManager.deleteClientAsync(clientId);
  }
});

test("R3-Phase-01 [BUG-04 & BUG-15]: Viewer blocked (403) on POST /api/events and Operator blocked (403) on POST /api/storage/s3-test", async () => {
  resetAdminStateForTests();
  await createInitialAdmin("r3-owner@datastack.dev", "OwnerPassword123!");
  const sessionSecret = getAdminSessionSecret()!;
  const suffix = Date.now();
  const viewerEmail = `r3viewer_${suffix}@datastack.dev`;
  const operatorEmail = `r3operator_${suffix}@datastack.dev`;
  const clientId = `r3_rbac_client_${suffix}`;

  const viewer = await createAdminTeamMemberAsync({
    email: viewerEmail,
    password: "ViewerPassword123!",
    role: "viewer",
  });
  const operator = await createAdminTeamMemberAsync({
    email: operatorEmail,
    password: "OperatorPassword123!",
    role: "operator",
  });
  await SDKManager.registerClientAsync({
    clientId,
    name: "RBAC Test Client",
    rateLimit: 50,
  });

  try {
    const viewerToken = await createAdminSessionToken(
      viewer.email,
      sessionSecret,
      Date.now() + 3600_000,
      viewer.tokenVersion,
      viewer.role,
      viewer.id,
    );
    const operatorToken = await createAdminSessionToken(
      operator.email,
      sessionSecret,
      Date.now() + 3600_000,
      operator.tokenVersion,
      operator.role,
      operator.id,
    );

    // BUG-04: Viewer CANNOT ingest events via POST /api/events
    const viewerIngestRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${viewerToken}`,
        },
        body: JSON.stringify({ clientId, data: { metric: 1 } }),
      }),
    );
    assert.equal(viewerIngestRes.status, 403);
    assert.equal(
      (await viewerIngestRes.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );

    // Operator CAN ingest events via POST /api/events
    const operatorIngestRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${operatorToken}`,
        },
        body: JSON.stringify({ clientId, data: { metric: 2 } }),
      }),
    );
    assert.equal(operatorIngestRes.status, 200);

    // BUG-15: Operator CANNOT call POST /api/storage/s3-test (Owner-only)
    const operatorS3TestRes = await s3TestPost(
      new NextRequest("http://localhost:3000/api/storage/s3-test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${operatorToken}`,
        },
        body: JSON.stringify({ s3Endpoint: "http://127.0.0.1:9999" }),
      }),
    );
    assert.equal(operatorS3TestRes.status, 403);
    assert.equal(
      (await operatorS3TestRes.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );
  } finally {
    await SDKManager.deleteClientAsync(clientId);
    await deleteAdminTeamMemberAsync(viewer.id);
    await deleteAdminTeamMemberAsync(operator.id);
  }
});

test("R3-Phase-01 [BUG-06]: Locked webhook secret does not break unrelated settings saves or draft/clear webhook tests", async () => {
  resetAdminStateForTests();
  await createInitialAdmin("r3-owner2@datastack.dev", "OwnerPassword123!");
  const prevSecret = process.env.DATASTACK_ADMIN_SESSION_SECRET;
  const origFetch = global.fetch;
  const members = await listAdminTeamMembersAsync();
  const owner = members.find((m) => m.role === "owner") || members[0];
  assert.ok(owner, "Bootstrap owner member must exist for test");

  try {
    // 1. Encrypt webhook secret under key A
    process.env.DATASTACK_ADMIN_SESSION_SECRET =
      "key-alpha-32-characters-long-for-rotation-test";
    await SettingsManager.updateSettingsAsync({
      enableWebhookAlerts: true,
      webhookUrl: "https://hooks.example.com/r3-test",
      webhookSecret: "old_secret_under_key_alpha",
    });

    // 2. Rotate DATASTACK_ADMIN_SESSION_SECRET to key B (making stored webhookSecretEnc locked)
    process.env.DATASTACK_ADMIN_SESSION_SECRET =
      "key-beta-32-characters-long-for-rotation-test!";

    const ownerToken = await createAdminSessionToken(
      owner.email,
      getAdminSessionSecret()!,
      Date.now() + 3600_000,
      owner.tokenVersion,
      owner.role,
      owner.id,
    );

    let capturedTestHeaders: Record<string, string> = {};
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/internal/settings-sync")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("hooks.example.com")) {
        capturedTestHeaders = (init?.headers as Record<string, string>) || {};
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // Saving an unrelated setting MUST NOT throw SecretVaultError
    const updated = await SettingsManager.updateSettingsAsync({
      maxEventsPerSec: 150,
    });
    assert.equal(updated.maxEventsPerSec, 150);

    // Testing a brand-new draft webhookSecret MUST succeed without decrypting the old locked secret
    const draftRes = await webhookTestPost(
      new NextRequest("http://localhost:3000/api/settings/webhook-test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerToken}`,
        },
        body: JSON.stringify({
          webhookUrl: "https://hooks.example.com/r3-test",
          webhookSecret: "brand_new_draft_secret_1234",
        }),
      }),
    );
    assert.equal(draftRes.status, 200);
    assert.ok(
      capturedTestHeaders["X-DataStack-Signature"]?.startsWith("sha256="),
      "Draft secret must sign outbound test webhook",
    );

    // Testing with clearWebhookSecret: true MUST also succeed without touching locked secret
    capturedTestHeaders = {};
    const clearRes = await webhookTestPost(
      new NextRequest("http://localhost:3000/api/settings/webhook-test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerToken}`,
        },
        body: JSON.stringify({
          webhookUrl: "https://hooks.example.com/r3-test",
          clearWebhookSecret: true,
        }),
      }),
    );
    assert.equal(clearRes.status, 200);
    assert.equal(capturedTestHeaders["X-DataStack-Signature"], undefined);
  } finally {
    global.fetch = origFetch;
    if (prevSecret === undefined) {
      delete process.env.DATASTACK_ADMIN_SESSION_SECRET;
    } else {
      process.env.DATASTACK_ADMIN_SESSION_SECRET = prevSecret;
    }
    await SettingsManager.updateSettingsAsync({
      enableWebhookAlerts: false,
      webhookUrl: "",
      clearWebhookSecret: true,
    });
  }
});

test("R3-Phase-01 [BUG-10]: Brute-force 429 admin login lockout dispatches ADMIN_LOGIN_LOCKOUT webhook alert", async () => {
  resetAdminStateForTests();
  await createInitialAdmin("r3-owner3@datastack.dev", "OwnerPassword123!");
  const origFetch = global.fetch;
  const email = `lockout_probe_${Date.now()}@datastack.dev`;
  const testIp = "198.51.100.42";
  const dispatchedBodies: Array<Record<string, unknown>> = [];

  try {
    clearWebhookCooldownCacheForTests();
    await SettingsManager.updateSettingsAsync({
      enableWebhookAlerts: true,
      webhookUrl: "https://hooks.example.com/lockout-alert",
      webhookSecret: "lockout_hmac_secret_123456",
      webhookCooldownSec: 0,
    });

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("hooks.example.com/lockout-alert")) {
        const parsed = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        dispatchedBodies.push(parsed);
        return new Response("ok", { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    let lastStatus = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await loginPost(
        new NextRequest("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-real-ip": testIp,
          },
          body: JSON.stringify({ email, password: "definitely-wrong-password" }),
        }),
      );
      lastStatus = res.status;
    }

    assert.equal(lastStatus, 429);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.ok(
      dispatchedBodies.length >= 1,
      "Expected ADMIN_LOGIN_LOCKOUT webhook alert to be dispatched on 429",
    );
    assert.equal(dispatchedBodies[0].event, "ADMIN_LOGIN_LOCKOUT");
    assert.equal(dispatchedBodies[0].severity, "warning");
    assert.equal(dispatchedBodies[0].instance, "DataStack");
  } finally {
    global.fetch = origFetch;
    await clearAdminLoginAttempts(email, getAdminSessionSecret()!, testIp);
    await SettingsManager.updateSettingsAsync({
      enableWebhookAlerts: false,
      webhookUrl: "",
      clearWebhookSecret: true,
    });
  }
});

test("R3-Phase-01 [BUG-13]: Port 4000 outbound webhook payload schema matches Port 3000 1:1 (including custom Discord proxies)", async () => {
  const fixedTs = "2026-11-20T12:00:00.000Z";
  const payload = {
    event: "DISK_SPACE_LOW" as const,
    severity: "critical" as const,
    title: "VPS Disk Threshold Reached",
    message: "Disk usage reached 96%.",
    clientId: "iot_edge_01",
    details: { usedPct: 96 },
    timestamp: fixedTs,
  };

  const port3000Json = JSON.parse(formatPort3000WebhookBody(payload));
  const port4000Json = JSON.parse(
    ingestionServer.formatOutboundWebhookBody(
      "https://discord-proxy.internal.company/webhooks/123",
      payload,
      fixedTs,
    ),
  );

  assert.deepEqual(port4000Json, port3000Json);
  assert.equal(port4000Json.instance, "DataStack");
  assert.equal(port4000Json.title, "VPS Disk Threshold Reached");
  assert.equal(typeof port4000Json.text, "string");
  assert.equal(typeof port4000Json.content, "string");

  // Also verify end-to-end Port 4000 HMAC signature uses decrypted secret cleanly
  ingestionServer.clearWebhookCooldownCacheForTests();
  let capturedBody = "";
  let capturedSig = "";
  const secret = "hmac_parity_secret_2026";
  await ingestionServer.triggerWebhookAlert(payload, {
    enableWebhookAlerts: true,
    webhookUrl: "https://custom-webhook.example.com/ingest",
    webhookSecret: secret,
    bypassCooldown: true,
    fetchImpl: async (
      _url: string,
      init: { body: string; headers: Record<string, string> },
    ) => {
      capturedBody = init.body;
      capturedSig = init.headers["X-DataStack-Signature"];
      return { ok: true, status: 200 };
    },
  });

  const expectedSig = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(capturedBody, "utf8")
    .digest("hex")}`;
  assert.equal(capturedSig, expectedSig);
});
