import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { GET as profileGet, PUT as profilePut } from "@/app/api/auth/profile/route";
import { GET as clientsGet, POST as clientsPost } from "@/app/api/clients/route";
import {
  DELETE as clientDelete,
  GET as clientGet,
} from "@/app/api/clients/[id]/route";
import { POST as eventsPost } from "@/app/api/events/route";
import {
  createAdminSessionToken,
  getAdminSessionPayload,
  getAdminSessionSecret,
} from "@/core/auth/adminSession";
import {
  consumeAdminLoginAttempt,
  createInitialAdmin,
  getAdminSetupKey,
  isAdminSetupComplete,
  resetAdminStateForTests,
  verifyAdminCredentials,
  verifyAdminSetupKey,
  verifyRequestAdminSession,
} from "@/core/auth/adminUsers";
import { AuthService, resolveDefaultJwtSecret } from "@/core/auth/jwt";
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
    resetAdminStateForTests();
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
    process.env.NODE_ENV = "production";
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

  it("SPEC-08: allows headless scripts with x-datastack-admin-client or DataStack-CLI to bypass browser CSRF check", async () => {
    process.env.DATASTACK_ADMIN_SESSION_SECRET = "test-secret-at-least-32-chars-long-for-session";

    // 1. Without headless header or origin -> 403 CSRF rejected
    const blockedReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "localhost:3000",
      },
    });
    const blockedRes = await middleware(blockedReq);
    assert.equal(blockedRes.status, 403);
    const blockedJson = await blockedRes.json();
    assert.match(blockedJson.error, /cross-origin/i);

    // 2. With x-datastack-admin-client header -> bypasses CSRF (reaches auth check, returns 401 Unauthorized if no cookie)
    const headlessReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "x-datastack-admin-client": "true",
      },
    });
    const headlessRes = await middleware(headlessReq);
    assert.equal(headlessRes.status, 401);
    const headlessJson = await headlessRes.json();
    assert.match(headlessJson.error, /authentication required/i);

    // 3. With DataStack-CLI User-Agent -> bypasses CSRF
    const cliReq = new NextRequest("http://localhost:3000/api/clients", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "user-agent": "DataStack-CLI/1.0",
      },
    });
    const cliRes = await middleware(cliReq);
    assert.equal(cliRes.status, 401);
  });
});
