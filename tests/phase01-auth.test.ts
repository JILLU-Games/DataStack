import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as profileGet, PUT as profilePut } from "@/app/api/auth/profile/route";
import { POST as setupPost } from "@/app/api/auth/setup/route";
import { GET as clientsGet, POST as clientsPost } from "@/app/api/clients/route";
import {
  DELETE as clientDelete,
  GET as clientGet,
  PATCH as clientPatch,
} from "@/app/api/clients/[id]/route";
import { GET as dataGet } from "@/app/api/data/route";
import { GET as eventsGet, POST as eventsPost } from "@/app/api/events/route";
import { GET as exportGet } from "@/app/api/export/route";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as metricsGet } from "@/app/api/metrics/route";
import { GET as storageGet, POST as storagePost } from "@/app/api/storage/route";
import { SettingsManager } from "@/core/adminSettings/settingsManager";
import {
  createAdminSessionToken,
  getAdminSessionPayload,
  getAdminSessionSecret,
  getSessionCookieOptions,
} from "@/core/auth/adminSession";
import {
  AdminDatabaseRequiredError,
  consumeAdminLoginAttempt,
  createInitialAdmin,
  getAdminSetupKey,
  isAdminSetupComplete,
  requiresPersistentAdminDatabase,
  resetAdminStateForTests,
  verifyAdminCredentials,
  verifyAdminSetupKey,
  verifyRequestAdminSession,
} from "@/core/auth/adminUsers";
import { AuthService, resolveDefaultJwtSecret } from "@/core/auth/jwt";
import { DatabaseEngine } from "@/core/Database/database";
import { SDKManager } from "@/core/sdk/sdkManager";
import { extractClientIp } from "@/lib/adminAuth";
import { isSameOriginRequest, middleware } from "@/middleware";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
  AuthService.setSecret(resolveDefaultJwtSecret() || "");
}

describe("Phase-01 Auth, Secrets, Revocation & Proxy Hardening", () => {
  beforeEach(() => {
    restoreEnv();
    process.env.INGESTION_INTERNAL_URL = "http://127.0.0.1:1";
    resetAdminStateForTests();
    const g = globalThis as {
      __dataStackClientsMap?: Map<string, unknown>;
      __dataStackDeletedClients?: Set<string>;
    };
    g.__dataStackClientsMap?.clear();
    g.__dataStackDeletedClients?.clear();
  });

  afterEach(() => {
    restoreEnv();
    resetAdminStateForTests();
  });

  after(() => {
    const bufState = (
      globalThis as {
        __dataStackBufferState?: { flushTimer?: ReturnType<typeof setInterval> | null };
      }
    ).__dataStackBufferState;
    if (bufState?.flushTimer) {
      clearInterval(bufState.flushTimer);
      bufState.flushTimer = null;
    }
  });

  it("BUG-01 & BUG-02: fails closed in production when secrets or DB/setup are missing", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.DATASTACK_ADMIN_SESSION_SECRET;
    delete process.env.DATASTACK_ADMIN_SETUP_KEY;
    delete process.env.DATASTACK_JWT_SECRET;
    delete process.env.DATASTACK_ADMIN_PASSWORD;

    assert.equal(getAdminSessionSecret(), null);
    assert.equal(getAdminSetupKey(), null);
    assert.equal(resolveDefaultJwtSecret(), "");
    assert.equal(
      verifyAdminSetupKey("datastack-default-setup-key-32-chars"),
      false,
    );
    assert.equal(await isAdminSetupComplete(), false);

    await assert.rejects(
      () => verifyAdminCredentials("admin@datastack.dev", "admin12345678"),
      /setup/i,
    );

    AuthService.setSecret(resolveDefaultJwtSecret());
    assert.equal(AuthService.isConfigured(), false);
    assert.throws(() => AuthService.generateClientToken({ clientId: "c1" }));
  });

  it("BUG-03: bumps tokenVersion on credential update and rejects old session cookies", async () => {
    delete process.env.DATABASE_URL;
    process.env.DATASTACK_ALLOW_DEMO_ADMIN = "false";
    const created = await createInitialAdmin("owner@datastack.dev", "InitialPass123!");
    assert.equal(created, true);
    assert.equal(await isAdminSetupComplete(), true);

    const secret = getAdminSessionSecret()!;
    const v1Token = await createAdminSessionToken(
      "owner@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
    );

    const checkV1 = await verifyRequestAdminSession(v1Token);
    assert.equal(checkV1.valid, true);

    const updateReq = new NextRequest("http://localhost:3000/api/auth/profile", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: `datastack_admin_session=${v1Token}`,
      },
      body: JSON.stringify({
        email: "owner2@datastack.dev",
        currentPassword: "InitialPass123!",
        newPassword: "UpdatedPass456!",
      }),
    });

    const updateRes = await profilePut(updateReq);
    assert.equal(updateRes.status, 200);
    const setCookie = updateRes.cookies.get("datastack_admin_session")?.value;
    assert.ok(setCookie);

    const newPayload = await getAdminSessionPayload(setCookie!, secret);
    assert.ok(newPayload);
    assert.equal(newPayload!.tokenVersion, 2);

    // Old v1 session must now return 401
    const staleProfileReq = new NextRequest("http://localhost:3000/api/auth/profile", {
      method: "GET",
      headers: { cookie: `datastack_admin_session=${v1Token}` },
    });
    const staleRes = await profileGet(staleProfileReq);
    assert.equal(staleRes.status, 401);

    // New v2 session succeeds
    const freshProfileReq = new NextRequest("http://localhost:3000/api/auth/profile", {
      method: "GET",
      headers: { cookie: `datastack_admin_session=${setCookie}` },
    });
    const freshRes = await profileGet(freshProfileReq);
    assert.equal(freshRes.status, 200);
  });

  it("BUG-04: throttles by composite IP+email without locking out other admin IPs", async () => {
    const secret = "test-throttle-secret-at-least-32-chars-long";
    const targetEmail = "admin@datastack.dev";

    for (let i = 0; i < 5; i++) {
      const dec = await consumeAdminLoginAttempt(targetEmail, secret, "198.51.100.10");
      assert.equal(dec.allowed, true);
    }

    // 6th attempt from attacker IP is blocked
    const blocked = await consumeAdminLoginAttempt(targetEmail, secret, "198.51.100.10");
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 1);

    // Real admin from different IP is still allowed
    const otherIpAllowed = await consumeAdminLoginAttempt(
      targetEmail,
      secret,
      "203.0.113.55",
    );
    assert.equal(otherIpAllowed.allowed, true);

    // Same IP spraying 25 distinct emails triggers IP bucket block on 26th
    for (let i = 0; i < 25; i++) {
      const spray = await consumeAdminLoginAttempt(
        `spray${i}@example.com`,
        secret,
        "198.51.100.99",
      );
      assert.equal(spray.allowed, true);
    }
    const sprayBlocked = await consumeAdminLoginAttempt(
      "spray25@example.com",
      secret,
      "198.51.100.99",
    );
    assert.equal(sprayBlocked.allowed, false);
  });

  it("BUG-05 & BUG-15: redacts tokens in client list, returns 400 on malformed JSON, and blocks deleted/unregistered Bearer tokens", async () => {
    delete process.env.DATABASE_URL;
    await createInitialAdmin("admin@datastack.dev", "AdminPass123!");
    const secret = getAdminSessionSecret()!;
    const adminCookie = await createAdminSessionToken(
      "admin@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
    );

    const createReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `datastack_admin_session=${adminCookie}`,
      },
      body: JSON.stringify({
        clientId: "phase01_probe_client",
        name: "Phase01 Probe",
        rateLimit: 50,
      }),
    });
    const createRes = await clientsPost(createReq);
    assert.equal(createRes.status, 201);
    const createdJson = await createRes.json();
    const clientToken = createdJson.client.token as string;
    assert.ok(clientToken.length > 20);

    // List endpoint must redact full token & secret
    const listReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "GET",
      headers: { cookie: `datastack_admin_session=${adminCookie}` },
    });
    const listRes = await clientsGet(listReq);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    const listed = listJson.clients.find(
      (c: { clientId: string }) => c.clientId === "phase01_probe_client",
    );
    assert.ok(listed);
    assert.equal("token" in listed, false);
    assert.equal("secret" in listed, false);
    assert.equal(listed.tokenPreview, `${clientToken.slice(0, 12)}...`);

    // Single client GET omits token by default, reveals on ?includeToken=true
    const getDefaultRes = await clientGet(
      new NextRequest("http://localhost:3000/api/clients/phase01_probe_client", {
        headers: { cookie: `datastack_admin_session=${adminCookie}` },
      }),
      { params: Promise.resolve({ id: "phase01_probe_client" }) },
    );
    const defaultClient = (await getDefaultRes.json()).client;
    assert.equal("token" in defaultClient, false);

    const getIncludeRes = await clientGet(
      new NextRequest(
        "http://localhost:3000/api/clients/phase01_probe_client?includeToken=true",
        { headers: { cookie: `datastack_admin_session=${adminCookie}` } },
      ),
      { params: Promise.resolve({ id: "phase01_probe_client" }) },
    );
    const includeClient = (await getIncludeRes.json()).client;
    assert.equal(includeClient.token, clientToken);

    // Malformed JSON on POST /api/events returns 400 (not 500)
    const malformedRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${clientToken}`,
          "content-type": "application/json",
        },
        body: "{bad-json",
      }),
    );
    assert.equal(malformedRes.status, 400);

    // Delete client -> subsequent Bearer ingestion fails closed with 403 CLIENT_REVOKED
    const delRes = await clientDelete(
      new NextRequest("http://localhost:3000/api/clients/phase01_probe_client", {
        method: "DELETE",
        headers: { cookie: `datastack_admin_session=${adminCookie}` },
      }),
      { params: Promise.resolve({ id: "phase01_probe_client" }) },
    );
    assert.equal(delRes.status, 200);

    const rejectedRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${clientToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ eventId: "evt_after_delete", data: { ok: 1 } }),
      }),
    );
    assert.equal(rejectedRes.status, 403);

    // Unregistered signed Bearer token also rejected with 403 CLIENT_REVOKED
    const ghostToken = AuthService.generateClientToken({
      clientId: "unregistered_ghost_client",
    });
    const ghostRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ghostToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ eventId: "evt_ghost", data: { ok: 1 } }),
      }),
    );
    assert.equal(ghostRes.status, 403);
  });

  it("BUG-26: validates Origin or Referer against Host / X-Forwarded-Host", () => {
    const reqOriginOk = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        origin: "https://console.example.com",
        "x-forwarded-host": "console.example.com",
      },
    });
    assert.equal(isSameOriginRequest(reqOriginOk), true);

    const reqRefererOk = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        referer: "https://console.example.com/vcon/clients",
        host: "console.example.com",
      },
    });
    assert.equal(isSameOriginRequest(reqRefererOk), true);

    const reqCrossOrigin = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        origin: "https://evil.example.com",
        host: "console.example.com",
      },
    });
    assert.equal(isSameOriginRequest(reqCrossOrigin), false);

    const reqMissingBoth = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "console.example.com",
      },
    });
    assert.equal(isSameOriginRequest(reqMissingBoth), false);
  });

  it("BUG-A02: rejects spoofable x-datastack-admin-client, DataStack-CLI, and cross-site Sec-Fetch-Site headers without same-origin proof", async () => {
    process.env.DATASTACK_ADMIN_SESSION_SECRET = "test-secret-at-least-32-chars-long-for-session";

    // 1. Missing origin/referer -> 403
    const blockedReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: { host: "localhost:3000" },
    });
    const blockedRes = await middleware(blockedReq);
    assert.equal(blockedRes.status, 403);

    // 2. Spoofed x-datastack-admin-client header must still be rejected 403
    const headlessReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "x-datastack-admin-client": "true",
      },
    });
    const headlessRes = await middleware(headlessReq);
    assert.equal(headlessRes.status, 403);

    // 3. Spoofed DataStack-CLI User-Agent + cross-origin must still be rejected 403
    const cliReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "https://evil.example.com",
        "user-agent": "DataStack-CLI/1.0",
      },
    });
    const cliRes = await middleware(cliReq);
    assert.equal(cliRes.status, 403);

    // 4. Genuine same-origin passes CSRF and reaches auth check (401 without cookie)
    const sameOriginReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
      },
    });
    const sameOriginRes = await middleware(sameOriginReq);
    assert.equal(sameOriginRes.status, 401);
  });

  it("BUG-A01: enforces tokenVersion revocation across /api/data, GET /api/events, /api/export, /api/metrics, and /api/storage", async () => {
    delete process.env.DATABASE_URL;
    process.env.DATASTACK_ALLOW_DEMO_ADMIN = "false";
    await createInitialAdmin("owner@datastack.dev", "InitialPass123!");
    const secret = getAdminSessionSecret()!;

    const v1Token = await createAdminSessionToken(
      "owner@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
    );

    const updateRes = await profilePut(
      new NextRequest("http://localhost:3000/api/auth/profile", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${v1Token}`,
        },
        body: JSON.stringify({
          email: "owner@datastack.dev",
          currentPassword: "InitialPass123!",
          newPassword: "RotatedPass456!",
        }),
      }),
    );
    assert.equal(updateRes.status, 200);
    const v2Cookie = updateRes.cookies.get("datastack_admin_session")?.value;
    assert.ok(v2Cookie);

    const endpoints: Array<() => Promise<Response>> = [
      () => dataGet(new NextRequest("http://localhost:3000/api/data", { headers: { cookie: `datastack_admin_session=${v1Token}` } })),
      () => eventsGet(new NextRequest("http://localhost:3000/api/events", { headers: { cookie: `datastack_admin_session=${v1Token}` } })),
      () => exportGet(new NextRequest("http://localhost:3000/api/export?flush=false", { headers: { cookie: `datastack_admin_session=${v1Token}` } })),
      () => metricsGet(new NextRequest("http://localhost:3000/api/metrics", { headers: { cookie: `datastack_admin_session=${v1Token}` } })),
      () => storageGet(new NextRequest("http://localhost:3000/api/storage", { headers: { cookie: `datastack_admin_session=${v1Token}` } })),
      () => storagePost(new NextRequest("http://localhost:3000/api/storage", { method: "POST", headers: { cookie: `datastack_admin_session=${v1Token}` } })),
    ];

    for (const invoke of endpoints) {
      const res = await invoke();
      assert.equal(res.status, 401);
    }

    const okMetrics = await metricsGet(
      new NextRequest("http://localhost:3000/api/metrics", {
        headers: { cookie: `datastack_admin_session=${v2Cookie}` },
      }),
    );
    assert.equal(okMetrics.status, 200);
  });

  it("BUG-A04 & BUG-A05: rejects unregistered clients on /api/health & admin POST /api/events and validates PATCH /api/clients/[id]", async () => {
    delete process.env.DATABASE_URL;
    await createInitialAdmin("admin@datastack.dev", "AdminPass123!");
    const secret = getAdminSessionSecret()!;
    const adminCookie = await createAdminSessionToken(
      "admin@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
    );

    // Public unauthenticated /api/health probe stays 200
    const publicHealth = await healthGet(new NextRequest("http://localhost:3000/api/health"));
    assert.equal(publicHealth.status, 200);

    // Unregistered signed client Bearer token on /api/health -> 403 CLIENT_REVOKED
    const ghostToken = AuthService.generateClientToken({ clientId: "ghost_health_client" });
    const ghostHealth = await healthGet(
      new NextRequest("http://localhost:3000/api/health", {
        headers: { authorization: `Bearer ${ghostToken}` },
      }),
    );
    assert.equal(ghostHealth.status, 403);

    // Admin cookie POST /api/events for unregistered clientId -> 403 CLIENT_REVOKED
    const ghostAdminPost = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${adminCookie}`,
        },
        body: JSON.stringify({ clientId: "unregistered_admin_target", data: { ok: 1 } }),
      }),
    );
    assert.equal(ghostAdminPost.status, 403);

    // Create normalized client and verify mixed-case/unvalidated PATCH checks
    const createdRes = await clientsPost(
      new NextRequest("http://localhost:3000/api/clients", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${adminCookie}`,
        },
        body: JSON.stringify({ clientId: "Norm_Client_01", name: "Normalized", rateLimit: 50 }),
      }),
    );
    assert.equal(createdRes.status, 201);

    // Invalid non-string name -> 400 (not 500)
    const badNameRes = await clientPatch(
      new NextRequest("http://localhost:3000/api/clients/Norm_Client_01", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${adminCookie}`,
        },
        body: JSON.stringify({ name: 12345 }),
      }),
      { params: Promise.resolve({ id: "Norm_Client_01" }) },
    );
    assert.equal(badNameRes.status, 400);

    // Invalid status -> 400
    const badStatusRes = await clientPatch(
      new NextRequest("http://localhost:3000/api/clients/Norm_Client_01", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${adminCookie}`,
        },
        body: JSON.stringify({ status: "suspended" }),
      }),
      { params: Promise.resolve({ id: "Norm_Client_01" }) },
    );
    assert.equal(badStatusRes.status, 400);

    // Valid mixed-case normalized PATCH -> 200
    const goodPatchRes = await clientPatch(
      new NextRequest("http://localhost:3000/api/clients/NORM_CLIENT_01", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${adminCookie}`,
        },
        body: JSON.stringify({ name: "Updated Clean Name", rateLimit: 250 }),
      }),
      { params: Promise.resolve({ id: "NORM_CLIENT_01" }) },
    );
    assert.equal(goodPatchRes.status, 200);
    const patchedJson = await goodPatchRes.json();
    assert.equal(patchedJson.client.clientId, "norm_client_01");
    assert.equal(patchedJson.client.rateLimit, 250);
  });

  it("FORENSIC BUG-01: blocks volatile RAM admin setup in production without DATABASE_URL and returns 409 SETUP_REQUIRED on pre-setup login", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.DATASTACK_ADMIN_PASSWORD;
    process.env.DATASTACK_ADMIN_SESSION_SECRET =
      "prod-session-secret-at-least-32-characters-long";
    process.env.DATASTACK_ADMIN_SETUP_KEY =
      "prod-setup-key-at-least-32-characters-long";

    assert.equal(requiresPersistentAdminDatabase(), true);
    await assert.rejects(
      () => createInitialAdmin("owner@datastack.dev", "StrongPass123!"),
      AdminDatabaseRequiredError,
    );

    const setupRes = await setupPost(
      new NextRequest("http://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          email: "owner@datastack.dev",
          password: "StrongPass123!",
          setupKey: process.env.DATASTACK_ADMIN_SETUP_KEY,
        }),
      }),
    );
    assert.equal(setupRes.status, 503);
    const setupJson = await setupRes.json();
    assert.equal(setupJson.code, "DATABASE_NOT_CONFIGURED");

    const loginRes = await loginPost(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          email: "owner@datastack.dev",
          password: "StrongPass123!",
        }),
      }),
    );
    assert.equal(loginRes.status, 409);
    const loginJson = await loginRes.json();
    assert.equal(loginJson.code, "SETUP_REQUIRED");
  });

  it("FORENSIC BUG-04: throttles POST /api/auth/setup brute-force attempts and checks setup completion before verifying setupKey", async () => {
    delete process.env.DATABASE_URL;
    process.env.DATASTACK_ALLOW_DEMO_ADMIN = "false";
    process.env.DATASTACK_ADMIN_SETUP_KEY =
      "custom-setup-key-at-least-32-characters-long";

    for (let i = 0; i < 5; i++) {
      const badRes = await setupPost(
        new NextRequest("http://localhost:3000/api/auth/setup", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.77",
          },
          body: JSON.stringify({
            email: "admin@datastack.dev",
            password: "StrongPass123!",
            setupKey: "wrong-key-attempt",
          }),
        }),
      );
      assert.equal(badRes.status, 403);
    }

    const throttledRes = await setupPost(
      new NextRequest("http://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.77",
        },
        body: JSON.stringify({
          email: "admin@datastack.dev",
          password: "StrongPass123!",
          setupKey: process.env.DATASTACK_ADMIN_SETUP_KEY,
        }),
      }),
    );
    assert.equal(throttledRes.status, 429);
    assert.ok(Number(throttledRes.headers.get("retry-after")) >= 1);

    // Different IP succeeds and initializes admin
    const okRes = await setupPost(
      new NextRequest("http://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.88",
        },
        body: JSON.stringify({
          email: "admin@datastack.dev",
          password: "StrongPass123!",
          setupKey: process.env.DATASTACK_ADMIN_SETUP_KEY,
        }),
      }),
    );
    assert.equal(okRes.status, 200);

    // Subsequent setup attempt returns 409 even if setupKey is invalid
    const postInitRes = await setupPost(
      new NextRequest("http://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.89",
        },
        body: JSON.stringify({
          email: "other@datastack.dev",
          password: "StrongPass123!",
          setupKey: "completely-invalid-key",
        }),
      }),
    );
    assert.equal(postInitRes.status, 409);
  });

  it("FORENSIC BUG-05: revokes session cookie server-side on logout, ignores spoofed Origin for Secure flag, and allows privacy-stripped same-origin requests", async () => {
    delete process.env.DATABASE_URL;
    process.env.DATASTACK_ALLOW_DEMO_ADMIN = "false";
    await createInitialAdmin("logout-test@datastack.dev", "LogoutPass123!");
    const secret = getAdminSessionSecret()!;
    const sessionToken = await createAdminSessionToken(
      "logout-test@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
    );

    // Valid before logout
    const preLogoutRes = await profileGet(
      new NextRequest("http://localhost:3000/api/auth/profile", {
        headers: { cookie: `datastack_admin_session=${sessionToken}` },
      }),
    );
    assert.equal(preLogoutRes.status, 200);

    // Logout bumps tokenVersion server-side
    const logoutRes = await logoutPost(
      new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: { cookie: `datastack_admin_session=${sessionToken}` },
      }),
    );
    assert.equal(logoutRes.status, 200);

    // Replaying captured pre-logout cookie must return 401
    const replayProfile = await profileGet(
      new NextRequest("http://localhost:3000/api/auth/profile", {
        headers: { cookie: `datastack_admin_session=${sessionToken}` },
      }),
    );
    assert.equal(replayProfile.status, 401);

    // Cookie Secure flag must ignore spoofed https Origin on plain http request
    const spoofedOriginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    const plainOpts = getSessionCookieOptions(spoofedOriginReq, 3600);
    assert.equal(plainOpts.secure, false);
    assert.equal(plainOpts.sameSite, "lax");

    const httpsProxyReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });
    const httpsOpts = getSessionCookieOptions(httpsProxyReq, 3600);
    assert.equal(httpsOpts.secure, true);
    assert.equal(httpsOpts.sameSite, "none");

    // Privacy extension stripping Origin & Referer with Sec-Fetch-Site: same-origin passes CSRF
    const privacySameOriginReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(isSameOriginRequest(privacySameOriginReq), true);

    const crossSiteReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(isSameOriginRequest(crossSiteReq), false);
  });

  it("FORENSIC BUG-06: prevents empty production jwtSecret PG persistence and propagates DB write errors instead of silently swallowing them", async () => {
    const origGetPool = DatabaseEngine.getPool;
    const origEnsureSchema = DatabaseEngine.ensureSchema;
    const settingsGlobals = globalThis as {
      __dataStackAdminSettings?: unknown;
      __dataStackSettingsHydrated?: boolean;
    };
    const queries: string[] = [];

    try {
      // 1. Production with empty jwtSecret must not persist empty jwt_secret row into PG
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.DATASTACK_JWT_SECRET;
      settingsGlobals.__dataStackAdminSettings = undefined;
      settingsGlobals.__dataStackSettingsHydrated = false;

      DatabaseEngine.getPool = (() =>
        ({
          query: async (sql: string) => {
            queries.push(sql);
            return { rowCount: 0, rows: [] };
          },
        }) as unknown as ReturnType<typeof DatabaseEngine.getPool>);
      DatabaseEngine.ensureSchema = async () => true;

      await SettingsManager.getSettingsAsync();
      assert.equal(
        queries.some((sql) => sql.includes("INSERT INTO admin_settings")),
        false,
      );

      // 2. Failing PG write must reject (not silently return 200) and must not mutate RAM
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      process.env.DATASTACK_JWT_SECRET =
        "valid-jwt-secret-at-least-32-characters-long";
      AuthService.setSecret(process.env.DATASTACK_JWT_SECRET);
      settingsGlobals.__dataStackAdminSettings = undefined;
      settingsGlobals.__dataStackSettingsHydrated = false;

      DatabaseEngine.getPool = (() =>
        ({
          query: async (sql: string) => {
            if (sql.includes("INSERT INTO") || sql.includes("UPDATE")) {
              throw new Error("simulated PG outage");
            }
            return { rowCount: 0, rows: [] };
          },
        }) as unknown as ReturnType<typeof DatabaseEngine.getPool>);

      await assert.rejects(
        () => SettingsManager.updateSettingsAsync({ maxEventsPerSec: 777 }),
        /DATABASE_WRITE_FAILED/,
      );

      await assert.rejects(
        () =>
          SDKManager.registerClientAsync({
            clientId: "db_fail_client",
            name: "DB Fail Client",
          }),
        /DATABASE_WRITE_FAILED/,
      );
      assert.equal(SDKManager.getClient("db_fail_client"), undefined);
    } finally {
      DatabaseEngine.getPool = origGetPool;
      DatabaseEngine.ensureSchema = origEnsureSchema;
      settingsGlobals.__dataStackAdminSettings = undefined;
      settingsGlobals.__dataStackSettingsHydrated = false;
    }
  });

  it("R2 PHASE-01 BUG-01: enforces same-origin CSRF check on POST /api/auth/login and POST /api/auth/setup while preserving same-origin and Bearer /api/events", async () => {
    process.env.DATASTACK_ADMIN_SESSION_SECRET =
      "test-secret-at-least-32-chars-long-for-session";

    // Cross-origin POST /api/auth/login -> 403
    const crossLoginRes = await middleware(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "https://evil.example.com",
        },
      }),
    );
    assert.equal(crossLoginRes.status, 403);
    assert.deepEqual(await crossLoginRes.json(), {
      error: "Cross-origin request rejected.",
    });

    // Missing origin/referer/sec-fetch-site POST /api/auth/login -> 403
    const bareLoginRes = await middleware(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { host: "localhost:3000" },
      }),
    );
    assert.equal(bareLoginRes.status, 403);

    // Cross-origin POST /api/auth/setup -> 403
    const crossSetupRes = await middleware(
      new NextRequest("http://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "https://evil.example.com",
        },
      }),
    );
    assert.equal(crossSetupRes.status, 403);

    // Missing origin POST /api/auth/setup -> 403
    const bareSetupRes = await middleware(
      new NextRequest("http://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: { host: "localhost:3000" },
      }),
    );
    assert.equal(bareSetupRes.status, 403);

    // Same-origin POST /api/auth/login passes middleware (200 next)
    const sameOriginLoginRes = await middleware(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
      }),
    );
    assert.equal(sameOriginLoginRes.status, 200);

    // Privacy-stripped same-origin POST /api/auth/login via Sec-Fetch-Site passes middleware
    const privacyLoginRes = await middleware(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          "sec-fetch-site": "same-origin",
        },
      }),
    );
    assert.equal(privacyLoginRes.status, 200);

    // Same-origin POST /api/auth/setup passes middleware (200 next)
    const sameOriginSetupRes = await middleware(
      new NextRequest("http://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
        },
      }),
    );
    assert.equal(sameOriginSetupRes.status, 200);

    // Bearer-authenticated POST /api/events without Origin stays allowed (machine-to-machine SDK)
    const bearerEventsRes = await middleware(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          authorization: "Bearer sdk.jwt.token",
        },
      }),
    );
    assert.equal(bearerEventsRes.status, 200);

    // Non-Bearer cross-origin POST /api/events is rejected 403
    const crossEventsRes = await middleware(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "https://evil.example.com",
        },
      }),
    );
    assert.equal(crossEventsRes.status, 403);

    // Safe GET public API endpoints remain accessible without Origin
    const healthRes = await middleware(
      new NextRequest("http://localhost:3000/api/health", {
        method: "GET",
        headers: { host: "localhost:3000" },
      }),
    );
    assert.equal(healthRes.status, 200);
  });

  it("R2 PHASE-01 BUG-02: extractClientIp trusts X-Real-IP and rightmost X-Forwarded-For hop, blocking spoofed-XFF lockouts on login & setup", async () => {
    // Direct unit assertions on extractClientIp
    assert.equal(
      extractClientIp(
        new NextRequest("http://localhost:3000/api/auth/login", {
          headers: {
            "x-forwarded-for": "1.2.3.4, 203.0.113.9",
            "x-real-ip": "203.0.113.9",
          },
        }),
      ),
      "203.0.113.9",
    );

    assert.equal(
      extractClientIp(
        new NextRequest("http://localhost:3000/api/auth/login", {
          headers: {
            "x-forwarded-for": "1.2.3.4, 198.51.100.50, ",
            "x-real-ip": "   ",
          },
        }),
      ),
      "198.51.100.50",
    );

    assert.equal(
      extractClientIp(new NextRequest("http://localhost:3000/api/auth/login")),
      "unknown",
    );

    // End-to-end brute-force lockout on POST /api/auth/login despite rotating spoofed leftmost XFF
    delete process.env.DATABASE_URL;
    process.env.DATASTACK_ALLOW_DEMO_ADMIN = "false";
    process.env.DATASTACK_ADMIN_SETUP_KEY =
      "phase01-setup-key-at-least-32-characters-long";

    // First verify setup route blocks rotating spoofed leftmost XFF
    for (let i = 0; i < 5; i++) {
      const badSetup = await setupPost(
        new NextRequest("http://localhost:3000/api/auth/setup", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `10.1.0.${i + 1}, 198.51.100.42`,
          },
          body: JSON.stringify({
            email: "admin@datastack.dev",
            password: "StrongPass123!",
            setupKey: "wrong-key",
          }),
        }),
      );
      assert.equal(badSetup.status, 403);
    }

    const blockedSetup = await setupPost(
      new NextRequest("http://localhost:3000/api/auth/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "10.1.0.99, 198.51.100.42",
        },
        body: JSON.stringify({
          email: "admin@datastack.dev",
          password: "StrongPass123!",
          setupKey: process.env.DATASTACK_ADMIN_SETUP_KEY,
        }),
      }),
    );
    assert.equal(blockedSetup.status, 429);

    // Create admin and verify login route blocks rotating spoofed leftmost XFF with X-Real-IP
    await createInitialAdmin("lockout@datastack.dev", "RealPassword123!");
    for (let i = 0; i < 5; i++) {
      const badLogin = await loginPost(
        new NextRequest("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `172.16.0.${i + 1}, 203.0.113.9`,
            "x-real-ip": "203.0.113.9",
          },
          body: JSON.stringify({
            email: "lockout@datastack.dev",
            password: "WrongPassword!",
          }),
        }),
      );
      assert.equal(badLogin.status, 401);
    }

    const blockedLogin = await loginPost(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "172.16.0.99, 203.0.113.9",
          "x-real-ip": "203.0.113.9",
        },
        body: JSON.stringify({
          email: "lockout@datastack.dev",
          password: "RealPassword123!",
        }),
      }),
    );
    assert.equal(blockedLogin.status, 429);
    assert.ok(Number(blockedLogin.headers.get("retry-after")) >= 1);
  });
});
