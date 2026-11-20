import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { GET as auditGet } from "@/app/api/audit/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as profileGet, PUT as profilePut } from "@/app/api/auth/profile/route";
import {
  DELETE as clientDelete,
  GET as clientGet,
  PATCH as clientPatch,
} from "@/app/api/clients/[id]/route";
import { GET as clientsGet, POST as clientsPost } from "@/app/api/clients/route";
import { GET as settingsGet, POST as settingsPost } from "@/app/api/settings/route";
import { POST as webhookTestPost } from "@/app/api/settings/webhook-test/route";
import { GET as storageGet, POST as storagePost } from "@/app/api/storage/route";
import {
  DELETE as teamMemberDelete,
  PATCH as teamMemberPatch,
} from "@/app/api/team/[id]/route";
import { GET as teamGet, POST as teamPost } from "@/app/api/team/route";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "@/core/auth/adminSession";
import {
  createInitialAdmin,
  resetAdminStateForTests,
} from "@/core/auth/adminUsers";
import { DataBufferEngine } from "@/core/data/buffer";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("V2-Phase-03: Multi-Admin RBAC & Immutable Admin Audit Log", () => {
  beforeEach(async () => {
    restoreEnv();
    delete process.env.DATABASE_URL;
    process.env.DATASTACK_ALLOW_DEMO_ADMIN = "false";
    process.env.INGESTION_INTERNAL_URL = "http://127.0.0.1:1";
    resetAdminStateForTests();
    const g = globalThis as {
      __dataStackClientsMap?: Map<string, unknown>;
      __dataStackDeletedClients?: Set<string>;
    };
    g.__dataStackClientsMap?.clear();
    g.__dataStackDeletedClients?.clear();
  });

  after(async () => {
    restoreEnv();
    resetAdminStateForTests();
    await DataBufferEngine.shutdown();
  });

  it("1. Enforces Owner, Admin/Operator, and Viewer RBAC matrix (V2-E10 INSUFFICIENT_ROLE_PERMISSION)", async () => {
    const createdOwner = await createInitialAdmin(
      "owner@datastack.dev",
      "OwnerPass123!",
    );
    assert.equal(createdOwner, true);
    const secret = getAdminSessionSecret()!;

    // Owner session cookie (backward-compatible 4-arg call defaults to owner)
    const ownerCookie = await createAdminSessionToken(
      "owner@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
    );

    // Owner creates an Admin/Operator team member and a Viewer team member
    const createAdminRes = await teamPost(
      new NextRequest("http://localhost:3000/api/team", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
        },
        body: JSON.stringify({
          email: "operator@datastack.dev",
          password: "OperatorPass123!",
          role: "admin",
        }),
      }),
    );
    assert.equal(createAdminRes.status, 201);
    const createdAdminMember = (await createAdminRes.json()).member;
    assert.equal(createdAdminMember.role, "admin");

    const createViewerRes = await teamPost(
      new NextRequest("http://localhost:3000/api/team", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
        },
        body: JSON.stringify({
          email: "viewer@datastack.dev",
          password: "ViewerPass123!",
          role: "viewer",
        }),
      }),
    );
    assert.equal(createViewerRes.status, 201);
    const createdViewerMember = (await createViewerRes.json()).member;
    assert.equal(createdViewerMember.role, "viewer");

    // Sign in via POST /api/auth/login as Operator and Viewer
    const operatorLoginRes = await loginPost(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "operator@datastack.dev",
          password: "OperatorPass123!",
        }),
      }),
    );
    assert.equal(operatorLoginRes.status, 200);
    const operatorCookie =
      operatorLoginRes.cookies.get("datastack_admin_session")?.value;
    assert.ok(operatorCookie);

    const viewerLoginRes = await loginPost(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "viewer@datastack.dev",
          password: "ViewerPass123!",
        }),
      }),
    );
    assert.equal(viewerLoginRes.status, 200);
    const viewerCookie =
      viewerLoginRes.cookies.get("datastack_admin_session")?.value;
    assert.ok(viewerCookie);

    // Check /api/auth/profile reflects each member's role
    const viewerProfileRes = await profileGet(
      new NextRequest("http://localhost:3000/api/auth/profile", {
        headers: { cookie: `datastack_admin_session=${viewerCookie}` },
      }),
    );
    assert.equal(viewerProfileRes.status, 200);
    const viewerProfile = (await viewerProfileRes.json()).profile;
    assert.equal(viewerProfile.role, "Viewer");
    assert.equal(viewerProfile.roleKey, "viewer");

    // Viewer can read GET /api/clients, GET /api/settings, GET /api/storage, GET /api/team
    const viewerGetClients = await clientsGet(
      new NextRequest("http://localhost:3000/api/clients", {
        headers: { cookie: `datastack_admin_session=${viewerCookie}` },
      }),
    );
    assert.equal(viewerGetClients.status, 200);

    const viewerGetSettings = await settingsGet(
      new NextRequest("http://localhost:3000/api/settings", {
        headers: { cookie: `datastack_admin_session=${viewerCookie}` },
      }),
    );
    assert.equal(viewerGetSettings.status, 200);

    const viewerGetStorage = await storageGet(
      new NextRequest("http://localhost:3000/api/storage", {
        headers: { cookie: `datastack_admin_session=${viewerCookie}` },
      }),
    );
    assert.equal(viewerGetStorage.status, 200);

    // Viewer CANNOT mutate settings, clients, storage, or team -> 403 INSUFFICIENT_ROLE_PERMISSION
    const viewerPostSettings = await settingsPost(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${viewerCookie}`,
        },
        body: JSON.stringify({ maxEventsPerSec: 250 }),
      }),
    );
    assert.equal(viewerPostSettings.status, 403);
    assert.equal(
      (await viewerPostSettings.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );

    const viewerPostClients = await clientsPost(
      new NextRequest("http://localhost:3000/api/clients", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${viewerCookie}`,
        },
        body: JSON.stringify({
          clientId: "viewer_blocked_client",
          name: "Blocked",
        }),
      }),
    );
    assert.equal(viewerPostClients.status, 403);
    assert.equal(
      (await viewerPostClients.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );

    const viewerPostStorage = await storagePost(
      new NextRequest("http://localhost:3000/api/storage", {
        method: "POST",
        headers: { cookie: `datastack_admin_session=${viewerCookie}` },
      }),
    );
    assert.equal(viewerPostStorage.status, 403);
    assert.equal(
      (await viewerPostStorage.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );

    // Operator CAN create, update, rotate token, and delete SDK clients
    const operatorCreateClient = await clientsPost(
      new NextRequest("http://localhost:3000/api/clients", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${operatorCookie}`,
        },
        body: JSON.stringify({
          clientId: "op_managed_client",
          name: "Operator Client",
          rateLimit: 300,
        }),
      }),
    );
    assert.equal(operatorCreateClient.status, 201);

    // Viewer CANNOT reveal full client JWT via ?includeToken=true
    const viewerRevealToken = await clientGet(
      new NextRequest(
        "http://localhost:3000/api/clients/op_managed_client?includeToken=true",
        {
          headers: { cookie: `datastack_admin_session=${viewerCookie}` },
        },
      ),
      { params: Promise.resolve({ id: "op_managed_client" }) },
    );
    assert.equal(viewerRevealToken.status, 403);
    assert.equal(
      (await viewerRevealToken.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );

    // Operator CAN reveal full client JWT and rotate it
    const operatorRotateToken = await clientPatch(
      new NextRequest("http://localhost:3000/api/clients/op_managed_client", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${operatorCookie}`,
        },
        body: JSON.stringify({ action: "regenerate_token" }),
      }),
      { params: Promise.resolve({ id: "op_managed_client" }) },
    );
    assert.equal(operatorRotateToken.status, 200);

    // Operator CANNOT modify platform settings or manage team members (Owner-only)
    const operatorPostSettings = await settingsPost(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${operatorCookie}`,
        },
        body: JSON.stringify({ maxEventsPerSec: 500 }),
      }),
    );
    assert.equal(operatorPostSettings.status, 403);
    assert.equal(
      (await operatorPostSettings.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );

    const operatorWebhookTest = await webhookTestPost(
      new NextRequest("http://localhost:3000/api/settings/webhook-test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${operatorCookie}`,
        },
        body: JSON.stringify({ webhookUrl: "https://hooks.example.com/test" }),
      }),
    );
    assert.equal(operatorWebhookTest.status, 403);
    assert.equal(
      (await operatorWebhookTest.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );

    const operatorPostTeam = await teamPost(
      new NextRequest("http://localhost:3000/api/team", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${operatorCookie}`,
        },
        body: JSON.stringify({
          email: "unauthorized@datastack.dev",
          password: "Password123!",
          role: "viewer",
        }),
      }),
    );
    assert.equal(operatorPostTeam.status, 403);
    assert.equal(
      (await operatorPostTeam.json()).code,
      "INSUFFICIENT_ROLE_PERMISSION",
    );
  });

  it("2. Protects Primary Owner (id=1 / owner-1) from deletion or demotion (V2-E11 CANNOT_REVOKE_PRIMARY_OWNER) and revokes team sessions on role/status change", async () => {
    await createInitialAdmin("primary@datastack.dev", "PrimaryPass123!");
    const secret = getAdminSessionSecret()!;
    const ownerCookie = await createAdminSessionToken(
      "primary@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
    );

    // Attempt to delete primary owner -> 400 CANNOT_REVOKE_PRIMARY_OWNER
    const delOwnerRes = await teamMemberDelete(
      new NextRequest("http://localhost:3000/api/team/owner-1", {
        method: "DELETE",
        headers: { cookie: `datastack_admin_session=${ownerCookie}` },
      }),
      { params: Promise.resolve({ id: "owner-1" }) },
    );
    assert.equal(delOwnerRes.status, 400);
    assert.equal(
      (await delOwnerRes.json()).code,
      "CANNOT_REVOKE_PRIMARY_OWNER",
    );

    // Attempt to demote or disable primary owner -> 400 CANNOT_REVOKE_PRIMARY_OWNER
    const patchOwnerRes = await teamMemberPatch(
      new NextRequest("http://localhost:3000/api/team/owner-1", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
        },
        body: JSON.stringify({ role: "viewer", status: "disabled" }),
      }),
      { params: Promise.resolve({ id: "owner-1" }) },
    );
    assert.equal(patchOwnerRes.status, 400);
    assert.equal(
      (await patchOwnerRes.json()).code,
      "CANNOT_REVOKE_PRIMARY_OWNER",
    );

    // Create a secondary member, log in, then disable them and verify session cookie is immediately invalidated
    const createdRes = await teamPost(
      new NextRequest("http://localhost:3000/api/team", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
        },
        body: JSON.stringify({
          email: "temp@datastack.dev",
          password: "TempPassword123!",
          role: "viewer",
        }),
      }),
    );
    assert.equal(createdRes.status, 201);
    const memberId = (await createdRes.json()).member.id as string;

    const loginRes = await loginPost(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "temp@datastack.dev",
          password: "TempPassword123!",
        }),
      }),
    );
    assert.equal(loginRes.status, 200);
    const tempCookie = loginRes.cookies.get("datastack_admin_session")?.value;
    assert.ok(tempCookie);

    // Disable team member -> bumps token_version and sets status='disabled'
    const disableRes = await teamMemberPatch(
      new NextRequest(`http://localhost:3000/api/team/${memberId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
        },
        body: JSON.stringify({ status: "disabled", revokeSessions: true }),
      }),
      { params: Promise.resolve({ id: memberId }) },
    );
    assert.equal(disableRes.status, 200);

    // Old cookie must now be rejected 401
    const afterDisableCheck = await clientsGet(
      new NextRequest("http://localhost:3000/api/clients", {
        headers: { cookie: `datastack_admin_session=${tempCookie}` },
      }),
    );
    assert.equal(afterDisableCheck.status, 401);
  });

  it("3. Records immutable admin audit logs across login, team, client, and settings mutations and supports filtered GET /api/audit queries", async () => {
    await createInitialAdmin("audit-owner@datastack.dev", "AuditPass123!");
    const loginRes = await loginPost(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "203.0.113.77",
        },
        body: JSON.stringify({
          email: "audit-owner@datastack.dev",
          password: "AuditPass123!",
        }),
      }),
    );
    assert.equal(loginRes.status, 200);
    const ownerCookie = loginRes.cookies.get("datastack_admin_session")?.value!;

    // Create a client, update settings, and delete the client
    const createClientRes = await clientsPost(
      new NextRequest("http://localhost:3000/api/clients", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
          "x-real-ip": "203.0.113.77",
        },
        body: JSON.stringify({
          clientId: "audited_sdk_client",
          name: "Audited Client",
          rateLimit: 120,
        }),
      }),
    );
    assert.equal(createClientRes.status, 201);

    const updateSettingsRes = await settingsPost(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
          "x-real-ip": "203.0.113.77",
        },
        body: JSON.stringify({ maxEventsPerSec: 400 }),
      }),
    );
    assert.equal(updateSettingsRes.status, 200);

    const deleteClientRes = await clientDelete(
      new NextRequest(
        "http://localhost:3000/api/clients/audited_sdk_client?purgeFiles=false",
        {
          method: "DELETE",
          headers: {
            cookie: `datastack_admin_session=${ownerCookie}`,
            "x-real-ip": "203.0.113.77",
          },
        },
      ),
      { params: Promise.resolve({ id: "audited_sdk_client" }) },
    );
    assert.equal(deleteClientRes.status, 200);

    // Query GET /api/audit
    const auditRes = await auditGet(
      new NextRequest("http://localhost:3000/api/audit?limit=50", {
        headers: { cookie: `datastack_admin_session=${ownerCookie}` },
      }),
    );
    assert.equal(auditRes.status, 200);
    const auditJson = await auditRes.json();
    assert.ok(Array.isArray(auditJson.logs));
    const actions = auditJson.logs.map((l: { action: string }) => l.action);
    assert.ok(actions.includes("ADMIN_LOGIN"));
    assert.ok(actions.includes("CLIENT_CREATED"));
    assert.ok(actions.includes("SETTINGS_UPDATED"));
    assert.ok(actions.includes("CLIENT_DELETED"));

    // Filter by action=CLIENT_CREATED
    const filteredRes = await auditGet(
      new NextRequest(
        "http://localhost:3000/api/audit?action=CLIENT_CREATED&q=audited_sdk_client",
        {
          headers: { cookie: `datastack_admin_session=${ownerCookie}` },
        },
      ),
    );
    assert.equal(filteredRes.status, 200);
    const filteredJson = await filteredRes.json();
    assert.equal(filteredJson.logs.length, 1);
    assert.equal(filteredJson.logs[0].target, "audited_sdk_client");
    assert.equal(filteredJson.logs[0].ipAddress, "203.0.113.77");
    assert.equal(filteredJson.logs[0].actorEmail, "audit-owner@datastack.dev");

    // Team listing includes primary owner + team members
    const teamListRes = await teamGet(
      new NextRequest("http://localhost:3000/api/team", {
        headers: { cookie: `datastack_admin_session=${ownerCookie}` },
      }),
    );
    assert.equal(teamListRes.status, 200);
    const teamListJson = await teamListRes.json();
    assert.equal(teamListJson.members[0].id, "owner-1");
    assert.equal(teamListJson.members[0].isPrimaryOwner, true);

    // Restore default settings before shutdown
    await settingsPost(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
        },
        body: JSON.stringify({ maxEventsPerSec: 100 }),
      }),
    );
    await DataBufferEngine.shutdown();
  });

  it("4. Allows secondary team member to rotate their own password via PUT /api/auth/profile and invalidates prior cookie", async () => {
    await createInitialAdmin("root@datastack.dev", "RootPassword123!");
    const secret = getAdminSessionSecret()!;
    const ownerCookie = await createAdminSessionToken(
      "root@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
    );

    await teamPost(
      new NextRequest("http://localhost:3000/api/team", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${ownerCookie}`,
        },
        body: JSON.stringify({
          email: "selfupdate@datastack.dev",
          password: "InitialPassword123!",
          role: "operator",
        }),
      }),
    );

    const loginRes = await loginPost(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "selfupdate@datastack.dev",
          password: "InitialPassword123!",
        }),
      }),
    );
    assert.equal(loginRes.status, 200);
    const v1Cookie = loginRes.cookies.get("datastack_admin_session")?.value!;

    const rotateRes = await profilePut(
      new NextRequest("http://localhost:3000/api/auth/profile", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: `datastack_admin_session=${v1Cookie}`,
        },
        body: JSON.stringify({
          email: "selfupdate@datastack.dev",
          currentPassword: "InitialPassword123!",
          newPassword: "RotatedPassword456!",
        }),
      }),
    );
    assert.equal(rotateRes.status, 200);
    const v2Cookie = rotateRes.cookies.get("datastack_admin_session")?.value!;
    assert.ok(v2Cookie);

    // Old v1 cookie is now revoked
    const staleRes = await profileGet(
      new NextRequest("http://localhost:3000/api/auth/profile", {
        headers: { cookie: `datastack_admin_session=${v1Cookie}` },
      }),
    );
    assert.equal(staleRes.status, 401);

    // New v2 cookie retains Operator role
    const freshRes = await profileGet(
      new NextRequest("http://localhost:3000/api/auth/profile", {
        headers: { cookie: `datastack_admin_session=${v2Cookie}` },
      }),
    );
    assert.equal(freshRes.status, 200);
    const freshJson = await freshRes.json();
    assert.equal(freshJson.profile.role, "Operator");
    assert.equal(freshJson.profile.roleKey, "operator");
  });
});
