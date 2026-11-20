import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as prometheusGet } from "../app/api/prometheus/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import { ApiEngine } from "../core/apiEngine/apiService";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  createInitialAdmin,
  resetAdminStateForTests,
} from "../core/auth/adminUsers";
import { SDKManager } from "../core/sdk/sdkManager";
import {
  classifyUiClientStatus,
  formatDateForLocalInput,
  getVconRoleCapabilities,
  isUiClientExpired,
  shouldRedirectSimulatorUnauthorized,
  summarizeUiClientCounts,
} from "../lib/vconUiHelpers";

async function makeOwnerCookie(): Promise<string> {
  resetAdminStateForTests();
  await createInitialAdmin("r3-p4-owner@datastack.dev", "R3Phase04Pass!");
  const secret = getAdminSessionSecret()!;
  const token = await createAdminSessionToken(
    "r3-p4-owner@datastack.dev",
    secret,
    Date.now() + 3600_000,
    1,
    "owner",
  );
  return `datastack_admin_session=${token}`;
}

test("R3-Phase-04 [BUG-11 / ERR-R3-07]: shouldRedirectSimulatorUnauthorized separates client 401s from admin session 401s", async () => {
  // Non-401 statuses never redirect
  assert.equal(shouldRedirectSimulatorUnauthorized(200, {}), false);
  assert.equal(shouldRedirectSimulatorUnauthorized(400, { code: "UNAUTHORIZED" }), false);
  assert.equal(shouldRedirectSimulatorUnauthorized(403, { code: "FORBIDDEN" }), false);
  assert.equal(shouldRedirectSimulatorUnauthorized(500, null), false);

  // Client token 401 codes stay on /vcon/simulator and show inline response
  for (const clientCode of [
    "CLIENT_TOKEN_EXPIRED",
    "client_token_expired",
    "TOKEN_ROTATED",
    "AUTH_INVALID",
    "CLIENT_REVOKED",
    "CLIENT_IP_FORBIDDEN",
    "CLIENT_UNAUTHORIZED",
  ]) {
    assert.equal(
      shouldRedirectSimulatorUnauthorized(401, {
        code: clientCode,
        error: "Client rejected",
      }),
      false,
      `Expected no redirect for client code ${clientCode}`,
    );
  }

  // Admin session 401 codes or uncoded 401 responses redirect to /vcon/login
  assert.equal(
    shouldRedirectSimulatorUnauthorized(401, { code: "UNAUTHORIZED" }),
    true,
  );
  assert.equal(
    shouldRedirectSimulatorUnauthorized(401, { code: "SESSION_EXPIRED" }),
    true,
  );
  assert.equal(shouldRedirectSimulatorUnauthorized(401, {}), true);
  assert.equal(shouldRedirectSimulatorUnauthorized(401, null), true);

  // Verify simulator page wires shouldRedirectSimulatorUnauthorized in both send handlers
  const simSource = await fs.readFile(
    path.join(process.cwd(), "app/vcon/simulator/page.tsx"),
    "utf8",
  );
  assert.ok(simSource.includes("shouldRedirectSimulatorUnauthorized"));
  assert.equal(
    simSource.includes("if (res.status === 401) {\n        window.location.assign"),
    false,
    "Simulator must parse JSON and evaluate shouldRedirectSimulatorUnauthorized before redirecting",
  );
});

test("R3-Phase-04 [BUG-12]: formatDateForLocalInput preserves local timezone round-trip without UTC offset drift", async () => {
  assert.equal(formatDateForLocalInput(null), "");
  assert.equal(formatDateForLocalInput(undefined), "");
  assert.equal(formatDateForLocalInput(""), "");
  assert.equal(formatDateForLocalInput("not-a-valid-date"), "");

  // Round-trip multiple UTC instants across winter/summer DST boundaries
  for (const iso of [
    "2026-01-15T08:30:00.000Z",
    "2026-07-20T23:45:00.000Z",
    "2026-11-20T14:05:00.000Z",
  ]) {
    const formatted = formatDateForLocalInput(iso);
    assert.match(formatted, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const roundTripped = new Date(formatted).toISOString();
    assert.equal(
      roundTripped,
      iso,
      `Round-trip local datetime-local value for ${iso} drifted to ${roundTripped}`,
    );
  }

  // Verify ClientsTable uses formatDateForLocalInput instead of toISOString().slice(0, 16)
  const clientsTableSource = await fs.readFile(
    path.join(process.cwd(), "components/sections/ClientsTable.tsx"),
    "utf8",
  );
  assert.ok(clientsTableSource.includes("formatDateForLocalInput(client.expiresAt)"));
  assert.equal(
    clientsTableSource.includes("toISOString().slice(0, 16)"),
    false,
    "ClientsTable must not format datetime-local using UTC toISOString().slice(0, 16)",
  );
});

test("R3-Phase-04 [BUG-14]: expired clients are separated in UI helpers, ApiEngine.getDashboardMetrics, and /api/prometheus", async () => {
  const nowMs = Date.parse("2026-11-20T12:00:00.000Z");

  assert.equal(isUiClientExpired(null, nowMs), false);
  assert.equal(isUiClientExpired("2026-11-20T12:05:00.000Z", nowMs), false);
  assert.equal(isUiClientExpired("2026-11-20T12:00:00.000Z", nowMs), true);
  assert.equal(isUiClientExpired("2026-11-19T00:00:00.000Z", nowMs), true);

  const sampleClients = [
    { status: "active", isOnline: true, lastConnectedAt: "2026-11-20T11:59:00.000Z", expiresAt: null },
    { status: "active", isOnline: false, lastConnectedAt: "2026-11-20T10:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" },
    { status: "active", isOnline: false, lastConnectedAt: null, expiresAt: null },
    { status: "active", isOnline: false, lastConnectedAt: "2026-11-19T10:00:00.000Z", expiresAt: "2026-11-19T12:00:00.000Z" },
    { status: "active", isOnline: true, lastConnectedAt: "2026-11-20T11:58:00.000Z", expiresAt: "2026-11-20T11:00:00.000Z" },
    { status: "revoked", isOnline: false, lastConnectedAt: null, expiresAt: "2026-11-10T00:00:00.000Z" },
  ];

  assert.equal(classifyUiClientStatus(sampleClients[0], nowMs), "online");
  assert.equal(classifyUiClientStatus(sampleClients[1], nowMs), "offline");
  assert.equal(classifyUiClientStatus(sampleClients[2], nowMs), "pending");
  assert.equal(classifyUiClientStatus(sampleClients[3], nowMs), "expired");
  assert.equal(classifyUiClientStatus(sampleClients[4], nowMs), "expired");
  assert.equal(classifyUiClientStatus(sampleClients[5], nowMs), "revoked");

  const summary = summarizeUiClientCounts(sampleClients, nowMs);
  assert.deepEqual(summary, {
    total: 6,
    online: 1,
    offline: 1,
    pending: 1,
    expired: 2,
    revoked: 1,
  });

  // Live integration: ApiEngine.getDashboardMetrics() & GET /api/prometheus
  const activeClient = SDKManager.registerClient("r3p4_active_client");
  const expiredClient = SDKManager.registerClient("r3p4_expired_client", {
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  const revokedClient = SDKManager.registerClient("r3p4_revoked_client");
  SDKManager.revokeClient(revokedClient.id);

  const prevSettings = SettingsManager.getSettings();
  try {
    SettingsManager.updateSettings({ enablePrometheusMetrics: true });
    const metrics = await ApiEngine.getDashboardMetrics();
    assert.ok(
      metrics.expiredClients >= 1,
      `Expected expiredClients >= 1, got ${metrics.expiredClients}`,
    );
    assert.equal(
      metrics.activeClients + metrics.expiredClients <= metrics.totalClients,
      true,
      "activeClients + expiredClients must not exceed totalClients",
    );

    // Check Prometheus output counts active vs expired vs revoked
    const cookie = await makeOwnerCookie();
    const req = new NextRequest("http://localhost:3000/api/prometheus", {
      headers: { cookie },
    });
    const res = await prometheusGet(req);
    assert.equal(res.status, 200);
    const body = await res.text();
    const activeMatch = body.match(/datastack_clients_total\{status="active"\}\s+(\d+)/);
    const expiredMatch = body.match(/datastack_clients_total\{status="expired"\}\s+(\d+)/);
    const revokedMatch = body.match(/datastack_clients_total\{status="revoked"\}\s+(\d+)/);
    assert.ok(activeMatch, "Prometheus must expose status=\"active\" gauge");
    assert.ok(expiredMatch, "Prometheus must expose status=\"expired\" gauge");
    assert.ok(revokedMatch, "Prometheus must expose status=\"revoked\" gauge");
    assert.equal(Number(activeMatch[1]), metrics.activeClients);
    assert.equal(Number(expiredMatch[1]), metrics.expiredClients);
    assert.ok(Number(expiredMatch[1]) >= 1);
    assert.ok(Number(revokedMatch[1]) >= 1);
  } finally {
    SDKManager.deleteClient(activeClient.id);
    SDKManager.deleteClient(expiredClient.id);
    SDKManager.deleteClient(revokedClient.id);
    SettingsManager.updateSettings({
      enablePrometheusMetrics: prevSettings.enablePrometheusMetrics,
    });
  }
});

test("R3-Phase-04 [BUG-16]: RBAC role capabilities and UI surface wiring across VconShell and Admin pages", async () => {
  assert.deepEqual(getVconRoleCapabilities("owner"), {
    role: "owner",
    canAdminSettings: true,
    canManageTeam: true,
    canOperate: true,
    isReadOnly: false,
  });
  assert.deepEqual(getVconRoleCapabilities("admin"), {
    role: "admin",
    canAdminSettings: false,
    canManageTeam: false,
    canOperate: true,
    isReadOnly: false,
  });
  assert.deepEqual(getVconRoleCapabilities("operator"), {
    role: "operator",
    canAdminSettings: false,
    canManageTeam: false,
    canOperate: true,
    isReadOnly: false,
  });
  assert.deepEqual(getVconRoleCapabilities("viewer"), {
    role: "viewer",
    canAdminSettings: false,
    canManageTeam: false,
    canOperate: false,
    isReadOnly: true,
  });
  // Fail-closed default for unknown/missing roles
  assert.deepEqual(getVconRoleCapabilities("unknown_role"), {
    role: "viewer",
    canAdminSettings: false,
    canManageTeam: false,
    canOperate: false,
    isReadOnly: true,
  });

  // Static audit confirming all 6 UI surfaces + layout/shell wire the verified role context
  const filesToCheck: Array<{ rel: string; patterns: string[] }> = [
    { rel: "app/vcon/layout.tsx", patterns: ["role={auth.session.role}"] },
    { rel: "components/layout/VconShell.tsx", patterns: ["export function useVconRole()", "VconRoleContext.Provider"] },
    { rel: "components/sections/SettingsWorkspace.tsx", patterns: ["useVconRole()", "canAdminSettings", "canOperate", "Read-only configuration"] },
    { rel: "components/sections/ClientsTable.tsx", patterns: ["useVconRole()", "canManage"] },
    { rel: "app/vcon/clients/page.tsx", patterns: ["useVconRole()", "canOperate", "summarizeUiClientCounts", "Expired"] },
    { rel: "components/sections/DashboardOverview.tsx", patterns: ["useVconRole()", "canOperate", "isUiClientExpired"] },
    { rel: "app/vcon/storage/page.tsx", patterns: ["useVconRole()", "canOperate", "Read-only"] },
    { rel: "app/vcon/simulator/page.tsx", patterns: ["useVconRole()", "canOperate", "Read-only"] },
  ];

  for (const check of filesToCheck) {
    const content = await fs.readFile(path.join(process.cwd(), check.rel), "utf8");
    for (const pattern of check.patterns) {
      assert.ok(
        content.includes(pattern),
        `Expected ${check.rel} to contain "${pattern}"`,
      );
    }
  }
});
