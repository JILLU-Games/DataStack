import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { NextRequest } from "next/server";

process.env.DATASTACK_DISABLE_LISTEN = "1";

import { GET as auditGet } from "../app/api/audit/route";
import { POST as settingsPost } from "../app/api/settings/route";
import { POST as webhookTestPost } from "../app/api/settings/webhook-test/route";
import { POST as s3TestPost } from "../app/api/storage/s3-test/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
import {
  clearWebhookCooldownCacheForTests,
  dispatchWebhookAlertAsync,
} from "../core/alerts/webhookNotifier";
import {
  createAdminSessionToken,
  getAdminSessionSecret,
} from "../core/auth/adminSession";
import {
  createInitialAdmin,
  createAdminTeamMemberAsync,
  resetAdminStateForTests,
  revokeAdminSessions,
  updateAdminTeamMemberAsync,
  deleteAdminTeamMemberAsync,
} from "../core/auth/adminUsers";
import {
  clearAuditLogsForTests,
  listAdminAuditLogsWithStatusAsync,
  recordAdminAuditLogAsync,
} from "../core/auth/auditLog";
import { DataBufferEngine } from "../core/data/buffer";
import { SDKManager } from "../core/sdk/sdkManager";
import { getInternalIngestionHeaders } from "../core/Security/security";
import {
  checkIpAddressAllowed,
  validateOutboundUrlAsync,
  validateOutboundUrlSync,
} from "../core/Security/ssrfGuard";
import { testS3Connection, uploadFileToS3 } from "../core/Storage/s3Archive";
import * as instrumentationHook from "../instrumentation";

const require = createRequire(import.meta.url);
const filesManager = require("../server/filesManager.js") as {
  authenticateFilesRequest: (params: {
    cookieHeader?: string;
    dbPool?: unknown;
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
  }) => Promise<{
    valid: boolean;
    status?: number;
    code?: string;
    error?: string;
    session?: { email: string; role: string; memberId: string; tokenVersion: number };
  }>;
  syncInMemoryAdminSessionState: (payload: Record<string, unknown>) => boolean;
  clearInMemoryAdminSessionStateForTests: () => void;
};

const ingestionServer = require("../server/index.js") as {
  app: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  setDbPoolForTests: (pool: unknown) => void;
  syncSettingsFromDatabase: () => Promise<boolean>;
  validateOutboundWebhookUrlAsync: (
    rawUrl: string,
    options?: Record<string, unknown>,
  ) => Promise<{ allowed: boolean; code?: string; error?: string; url?: string }>;
  triggerWebhookAlert: (
    payload: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{ dispatched: boolean; status?: number; code?: string; reason?: string; error?: string }>;
  clearWebhookCooldownCacheForTests: () => void;
  stopTimers: () => void;
};

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function createOwnerCookie(email = "r4p1-owner@datastack.dev"): Promise<string> {
  resetAdminStateForTests();
  await createInitialAdmin(email, "OwnerPassword123!");
  const secret = getAdminSessionSecret();
  const token = await createAdminSessionToken(
    email,
    secret,
    Date.now() + 3600_000,
    1,
    "owner",
    "owner-1",
  );
  return `datastack_admin_session=${token}`;
}

test.after(async () => {
  SettingsManager.stopMaintenanceSchedulerForTests();
  SDKManager.stopActivityFlushTimerForTests();
  ingestionServer.stopTimers();
  ingestionServer.setDbPoolForTests(null);
  filesManager.clearInMemoryAdminSessionStateForTests();
  await DataBufferEngine.shutdown();
  clearAuditLogsForTests();
  resetAdminStateForTests();
  restoreEnv();
});

test("R4-Phase-01 [AUDIT-01 / ERR-R4-01]: ssrfGuard blocks loopback, RFC1918, metadata, internal hostnames, non-HTTP(S), DNS rebinding & redirects while respecting explicit opt-in", async () => {
  delete process.env.DATASTACK_ALLOW_PRIVATE_URLS;

  const blockedTargets = [
    "http://127.0.0.1:4000/internal/settings-sync",
    "http://localhost:3000/api/health",
    "http://sub.localhost/hook",
    "http://[::1]:4000/",
    "http://[::ffff:127.0.0.1]/secret",
    "http://10.0.0.5:9000/bucket",
    "http://172.16.4.2/hook",
    "http://192.168.1.50/hook",
    "http://0.0.0.0/",
    "http://ingestion:4000/internal",
    "http://postgres.internal:5432/",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "file:///etc/passwd",
    "ftp://files.example.com/archive",
    "https://user:pass@hooks.example.com/hook",
  ];

  for (const target of blockedTargets) {
    const res = validateOutboundUrlSync(target, { fieldName: "Outbound URL" });
    assert.equal(res.allowed, false, `Expected ${target} to be blocked`);
    assert.equal(res.code, "SSRF_BLOCKED_HOST", `Expected SSRF_BLOCKED_HOST for ${target}`);
  }

  // Public HTTPS host passes sync + safe DNS lookup
  const okPublic = await validateOutboundUrlAsync("https://hooks.example.com/v1/alert", {
    fieldName: "Webhook URL",
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(okPublic.allowed, true);

  // DNS rebinding hostname resolving to 127.0.0.1 or 169.254.169.254 is blocked
  const rebindLoopback = await validateOutboundUrlAsync("https://rebind.example.com/hook", {
    fieldName: "Webhook URL",
    dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  assert.equal(rebindLoopback.allowed, false);
  assert.equal(rebindLoopback.code, "SSRF_BLOCKED_HOST");

  const rebindMeta = await validateOutboundUrlAsync("https://rebind-meta.example.com/hook", {
    fieldName: "Webhook URL",
    dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }],
  });
  assert.equal(rebindMeta.allowed, false);
  assert.equal(rebindMeta.code, "SSRF_BLOCKED_HOST");

  // Explicit opt-in allows RFC1918/loopback/single-label internal LAN hosts, YET ALWAYS blocks cloud metadata 169.254.169.254 & metadata.google.internal
  assert.equal(checkIpAddressAllowed("127.0.0.1", true).allowed, true);
  assert.equal(checkIpAddressAllowed("192.168.1.25", true).allowed, true);
  assert.equal(checkIpAddressAllowed("169.254.169.254", true).allowed, false);
  assert.equal(checkIpAddressAllowed("fe80::1", true).allowed, false);
  assert.equal(
    validateOutboundUrlSync("http://minio:9000", {
      allowPrivate: true,
    }).allowed,
    true,
  );
  assert.equal(
    validateOutboundUrlSync("http://169.254.169.254/latest/meta-data/", {
      allowPrivate: true,
    }).allowed,
    false,
  );
  assert.equal(
    validateOutboundUrlSync("http://metadata.google.internal/", {
      allowPrivate: true,
    }).allowed,
    false,
  );
});

test("R4-Phase-01 [AUDIT-01 / ERR-R4-01]: API routes (/api/settings, /api/settings/webhook-test, /api/storage/s3-test), Port 4000 triggerWebhookAlert & redirect:manual block SSRF", async () => {
  delete process.env.DATABASE_URL;
  delete process.env.DATASTACK_ALLOW_PRIVATE_URLS;
  clearWebhookCooldownCacheForTests();
  ingestionServer.clearWebhookCooldownCacheForTests();

  const cookie = await createOwnerCookie("r4-ssrf-owner@datastack.dev");

  // 1. POST /api/settings rejects private webhookUrl & private s3Endpoint with 400 SSRF_BLOCKED_HOST
  const badWebhookSave = await settingsPost(
    new NextRequest("http://localhost:3000/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ webhookUrl: "http://127.0.0.1:4000/internal/client-sync" }),
    }),
  );
  assert.equal(badWebhookSave.status, 400);
  assert.equal((await badWebhookSave.json()).code, "SSRF_BLOCKED_HOST");

  const badS3Save = await settingsPost(
    new NextRequest("http://localhost:3000/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ s3Endpoint: "http://169.254.169.254/latest/meta-data" }),
    }),
  );
  assert.equal(badS3Save.status, 400);
  assert.equal((await badS3Save.json()).code, "SSRF_BLOCKED_HOST");

  // 2. POST /api/settings/webhook-test rejects loopback/metadata with 400 SSRF_BLOCKED_HOST
  const badWebhookTest = await webhookTestPost(
    new NextRequest("http://localhost:3000/api/settings/webhook-test", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ webhookUrl: "http://localhost:4000/health" }),
    }),
  );
  assert.equal(badWebhookTest.status, 400);
  assert.equal((await badWebhookTest.json()).code, "SSRF_BLOCKED_HOST");

  // 3. POST /api/storage/s3-test rejects internal/RFC1918 host with 400 SSRF_BLOCKED_HOST
  const badS3Test = await s3TestPost(
    new NextRequest("http://localhost:3000/api/storage/s3-test", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        s3Endpoint: "http://10.0.0.12:9000",
        s3Bucket: "test-bucket",
        s3AccessKeyId: "AKIA_TEST",
        s3SecretAccessKey: "secret_key_test",
      }),
    }),
  );
  assert.equal(badS3Test.status, 400);
  assert.equal((await badS3Test.json()).code, "SSRF_BLOCKED_HOST");

  // 4. Port 4000 triggerWebhookAlert & validateOutboundWebhookUrlAsync block loopback & metadata
  const p4Blocked = await ingestionServer.triggerWebhookAlert(
    {
      event: "CLIENT_IP_FORBIDDEN",
      severity: "warning",
      title: "Probe",
      message: "Test",
    },
    {
      enableWebhookAlerts: true,
      webhookUrl: "http://127.0.0.1:4000/internal/client-sync",
      bypassCooldown: true,
    },
  );
  assert.equal(p4Blocked.dispatched, false);
  assert.equal(p4Blocked.code, "SSRF_BLOCKED_HOST");

  // 5. redirect: 'manual' blocks HTTP 302 redirects across webhookNotifier, S3, and Port 4000
  let targetHitAfterRedirect = false;
  const redirectServer = http.createServer((req, res) => {
    if (req.url && req.url.startsWith("/bounce")) {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    targetHitAfterRedirect = true;
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
  const addr = redirectServer.address() as AddressInfo;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-r4-ssrf-redir-"));
  const gzPath = path.join(tmpDir, "2026-11-20.csv.gz");
  await fs.writeFile(gzPath, zlib.gzipSync(Buffer.from("clientId,eventId,timestamp,payload\n")));

  try {
    process.env.DATASTACK_ALLOW_PRIVATE_URLS = "true";

    const whRedirect = await dispatchWebhookAlertAsync(
      {
        event: "TEST_ALERT",
        severity: "info",
        title: "Redirect check",
        message: "Must not follow 302",
      },
      {
        enabled: true,
        webhookUrl: `http://127.0.0.1:${addr.port}/bounce`,
        webhookSecret: "",
        cooldownSec: 0,
      },
      { bypassCooldown: true },
    );
    assert.equal(whRedirect.ok, false);
    assert.equal(whRedirect.code, "SSRF_BLOCKED_HOST");

    const s3ProbeRedir = await testS3Connection({
      endpoint: `http://127.0.0.1:${addr.port}/bounce`,
      region: "auto",
      bucket: "bkt",
      prefix: "",
      accessKeyId: "AKIA",
      secretAccessKey: "SEC",
    });
    assert.equal(s3ProbeRedir.ok, false);
    assert.equal(s3ProbeRedir.code, "SSRF_BLOCKED_HOST");

    const s3PutRedir = await uploadFileToS3(
      {
        endpoint: `http://127.0.0.1:${addr.port}/bounce`,
        region: "auto",
        bucket: "bkt",
        prefix: "",
        accessKeyId: "AKIA",
        secretAccessKey: "SEC",
      },
      gzPath,
      "c/2026-11-20.csv.gz",
    );
    assert.equal(s3PutRedir.ok, false);
    assert.equal(s3PutRedir.code, "SSRF_BLOCKED_HOST");

    const p4Redirect = await ingestionServer.triggerWebhookAlert(
      {
        event: "DISK_SPACE_LOW",
        severity: "warning",
        title: "Redirect check",
        message: "Must not follow 302",
      },
      {
        enableWebhookAlerts: true,
        webhookUrl: `http://127.0.0.1:${addr.port}/bounce`,
        allowPrivate: true,
        bypassCooldown: true,
      },
    );
    assert.equal(p4Redirect.dispatched, false);
    assert.equal(p4Redirect.code, "SSRF_BLOCKED_HOST");
    assert.equal(targetHitAfterRedirect, false);
  } finally {
    delete process.env.DATASTACK_ALLOW_PRIVATE_URLS;
    await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("R4-Phase-01 [AUDIT-03 / ERR-R4-02]: Port 4000 ensureDatabaseSchema creates all 7 tables including admin_team_members and admin_audit_logs", async () => {
  const executedSql: string[] = [];
  const mockPool = {
    async query(sql: string) {
      executedSql.push(sql);
      if (sql.includes("FROM admin_settings")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };

  try {
    ingestionServer.setDbPoolForTests(mockPool);
    const synced = await ingestionServer.syncSettingsFromDatabase();
    assert.equal(synced, true);

    const createStatements = executedSql.filter((s) => /CREATE TABLE IF NOT EXISTS/i.test(s));
    assert.equal(createStatements.length, 7, "Port 4000 must create all 7 tables");
    const joined = createStatements.join("\n");
    for (const tableName of [
      "client_sdks",
      "admin_settings",
      "deleted_clients",
      "admin_users",
      "admin_login_attempts",
      "admin_team_members",
      "admin_audit_logs",
    ]) {
      assert.ok(
        joined.includes(tableName),
        `Port 4000 schema missing table ${tableName}`,
      );
    }
  } finally {
    ingestionServer.setDbPoolForTests(null);
  }
});

test("R4-Phase-01 [AUDIT-04 / ERR-R4-03]: Next.js instrumentation.register() boots maintenance scheduler unattended on nodejs runtime and survives unreachable DB", async () => {
  delete process.env.DATABASE_URL;
  const prevDisable = process.env.DATASTACK_DISABLE_LISTEN;
  const prevRuntime = process.env.NEXT_RUNTIME;
  SettingsManager.stopMaintenanceSchedulerForTests();

  try {
    // 1. Edge runtime does NOT start Node maintenance scheduler
    process.env.NEXT_RUNTIME = "edge";
    delete process.env.DATASTACK_DISABLE_LISTEN;
    await instrumentationHook.register();
    assert.equal(SettingsManager.isMaintenanceSchedulerActive(), false);

    // 2. Node.js runtime starts maintenance scheduler automatically on boot
    process.env.NEXT_RUNTIME = "nodejs";
    await instrumentationHook.register();
    assert.equal(SettingsManager.isMaintenanceSchedulerActive(), true);

    // 3. Even if DB fails during boot hydration, bootstrapMaintenanceSchedulerOnBoot catches error cleanly without crashing
    SettingsManager.stopMaintenanceSchedulerForTests();
    process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/unreachable";
    const bootRes = await SettingsManager.bootstrapMaintenanceSchedulerOnBoot();
    assert.equal(bootRes.schedulerActive, true);
    assert.equal(bootRes.hydrated, false);
  } finally {
    SettingsManager.stopMaintenanceSchedulerForTests();
    delete process.env.DATABASE_URL;
    if (prevDisable === undefined) delete process.env.DATASTACK_DISABLE_LISTEN;
    else process.env.DATASTACK_DISABLE_LISTEN = prevDisable;
    if (prevRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = prevRuntime;
  }
});

test("R4-Phase-01 [AUDIT-09 / ERR-R4-04 & ERR-R4-05]: Fail-loud audit DB degraded warnings + no-DB Files Manager session revocation sync", async () => {
  delete process.env.DATABASE_URL;
  clearAuditLogsForTests();
  filesManager.clearInMemoryAdminSessionStateForTests();

  const cookie = await createOwnerCookie("r4-audit-owner@datastack.dev");
  const globals = globalThis as typeof globalThis & {
    __dataStackCorePool?: unknown;
  };
  const prevPool = globals.__dataStackCorePool;

  // 1. Simulate PostgreSQL failure on audit write + read -> must log console.warn and expose degraded metadata & header
  const failingPool = {
    async query(sql: string) {
      if (/CREATE TABLE|ALTER TABLE/i.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM admin_users")) {
        return {
          rowCount: 1,
          rows: [
            {
              email: "r4-audit-owner@datastack.dev",
              created_at: new Date(),
              token_version: 1,
            },
          ],
        };
      }
      if (sql.includes("admin_audit_logs")) {
        throw new Error("simulated PG outage");
      }
      return { rowCount: 0, rows: [] };
    },
  };

  try {
    process.env.DATABASE_URL = "postgresql://mock:mock@127.0.0.1:5432/mock";
    globals.__dataStackCorePool = failingPool;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await recordAdminAuditLogAsync({
        actorEmail: "r4-audit-owner@datastack.dev",
        actorRole: "owner",
        action: "SETTINGS_UPDATED",
        target: "admin_settings",
      });
      const listResult = await listAdminAuditLogsWithStatusAsync({ limit: 10 });
      assert.equal(listResult.storageMode, "memory");
      assert.equal(listResult.degraded, true);
      assert.equal(listResult.code, "AUDIT_STORAGE_DEGRADED");
      assert.match(listResult.warning || "", /PostgreSQL/i);
      assert.ok(
        warnings.some((w) => w.includes("[DataStack Audit]")),
        "Expected console.warn fail-loud audit log",
      );

      // Verify GET /api/audit surfaces degraded status & header
      const apiRes = await auditGet(
        new NextRequest("http://localhost:3000/api/audit?limit=10", {
          headers: { cookie },
        }),
      );
      assert.equal(apiRes.status, 200);
      assert.equal(apiRes.headers.get("X-DataStack-Audit-Degraded"), "1");
      const apiJson = await apiRes.json();
      assert.equal(apiJson.degraded, true);
      assert.equal(apiJson.code, "AUDIT_STORAGE_DEGRADED");
      assert.equal(apiJson.storageMode, "memory");
    } finally {
      console.warn = origWarn;
    }
  } finally {
    delete process.env.DATABASE_URL;
    globals.__dataStackCorePool = prevPool;
  }

  // 2. Verify no-DB (!dbPool) Files Manager session revocation via Port 4000 /internal/admin-session-sync bridge
  const testBridgeServer = http.createServer(ingestionServer.app);
  await new Promise<void>((resolve) => testBridgeServer.listen(0, "127.0.0.1", resolve));
  const bridgePort = (testBridgeServer.address() as AddressInfo).port;
  process.env.INGESTION_INTERNAL_URL = `http://127.0.0.1:${bridgePort}`;

  try {
    // Reject unauthenticated POST /internal/admin-session-sync
    const unauthSync = await fetch(
      `http://127.0.0.1:${bridgePort}/internal/admin-session-sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId: "owner-1", minTokenVersion: 99 }),
      },
    );
    assert.equal(unauthSync.status, 401);

    // Owner session v1 works before logout/revocation
    const secret = getAdminSessionSecret();
    const ownerTokenV1 = await createAdminSessionToken(
      "r4-audit-owner@datastack.dev",
      secret,
      Date.now() + 3600_000,
      1,
      "owner",
      "owner-1",
    );
    const beforeLogout = await filesManager.authenticateFilesRequest({
      cookieHeader: `datastack_admin_session=${ownerTokenV1}`,
      dbPool: null,
    });
    assert.equal(beforeLogout.valid, true);

    // Calling revokeAdminSessions syncs minTokenVersion=2 to Port 4000 bridge -> v1 Files Manager cookie is rejected
    const nextVer = await revokeAdminSessions({
      memberId: "owner-1",
      email: "r4-audit-owner@datastack.dev",
    });
    assert.ok(nextVer >= 2);
    const afterLogout = await filesManager.authenticateFilesRequest({
      cookieHeader: `datastack_admin_session=${ownerTokenV1}`,
      dbPool: null,
    });
    assert.equal(afterLogout.valid, false);
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.code, "SESSION_REVOKED");

    // Team member disable/delete also revokes no-DB Files Manager session immediately
    const opMember = await createAdminTeamMemberAsync({
      email: "r4-op@datastack.dev",
      password: "OperatorPassword123!",
      role: "operator",
    });
    const opTokenV1 = await createAdminSessionToken(
      opMember.email,
      secret,
      Date.now() + 3600_000,
      opMember.tokenVersion,
      opMember.role,
      opMember.id,
    );
    const opBefore = await filesManager.authenticateFilesRequest({
      cookieHeader: `datastack_admin_session=${opTokenV1}`,
      dbPool: null,
    });
    assert.equal(opBefore.valid, true);

    await updateAdminTeamMemberAsync(opMember.id, { status: "disabled" });
    const opAfterDisable = await filesManager.authenticateFilesRequest({
      cookieHeader: `datastack_admin_session=${opTokenV1}`,
      dbPool: null,
    });
    assert.equal(opAfterDisable.valid, false);
    assert.equal(opAfterDisable.code, "SESSION_REVOKED");

    await deleteAdminTeamMemberAsync(opMember.id);

    // Also verify authenticated /internal/admin-session-sync endpoint returns 200 & synced=true
    const authSyncRes = await fetch(
      `http://127.0.0.1:${bridgePort}/internal/admin-session-sync`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getInternalIngestionHeaders(),
        },
        body: JSON.stringify({
          memberId: "adm_manual_test",
          email: "manual@datastack.dev",
          minTokenVersion: 5,
          disabled: true,
        }),
      },
    );
    assert.equal(authSyncRes.status, 200);
    const authSyncJson = (await authSyncRes.json()) as { success: boolean; synced: boolean };
    assert.equal(authSyncJson.success, true);
    assert.equal(authSyncJson.synced, true);
  } finally {
    delete process.env.INGESTION_INTERNAL_URL;
    filesManager.clearInMemoryAdminSessionStateForTests();
    await new Promise<void>((resolve) => testBridgeServer.close(() => resolve()));
  }
});
