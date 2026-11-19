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
import { io as ioClient, type Socket } from "socket.io-client";
import { DELETE as deleteClientRoute, PATCH as patchClientRoute } from "../app/api/clients/[id]/route";
import { GET as clientsGet, POST as clientsPost } from "../app/api/clients/route";
import { GET as dataGet } from "../app/api/data/route";
import { GET as eventsGet, POST as eventsPost } from "../app/api/events/route";
import { GET as exportGet } from "../app/api/export/route";
import { GET as settingsGet, POST as settingsPost } from "../app/api/settings/route";
import { POST as archivePost } from "../app/api/storage/archive/route";
import { GET as storageGet } from "../app/api/storage/route";
import { POST as s3TestPost } from "../app/api/storage/s3-test/route";
import { SettingsManager } from "../core/adminSettings/settingsManager";
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
  decryptSecret,
  encryptSecret,
  getMaskedHintFromEncrypted,
  SecretVaultError,
} from "../core/Security/secretVault";
import { CSVStorageManager } from "../core/Storage/csvStorage";
import {
  buildS3ObjectKey,
  normalizeS3EndpointUrl,
  testS3Connection,
  uploadFileToS3,
} from "../core/Storage/s3Archive";
import {
  DEFAULT_EDITABLE_SETTINGS,
  settingsToNumericDrafts,
  validateEditableSettingsDraft,
  validateSingleNumericSetting,
} from "../lib/vconUiHelpers";

const require = createRequire(import.meta.url);

async function makeAdminCookie(): Promise<string> {
  resetAdminStateForTests();
  await createInitialAdmin("v2-p1@datastack.dev", "V2Phase01Pass!");
  const secret = getAdminSessionSecret()!;
  const token = await createAdminSessionToken(
    "v2-p1@datastack.dev",
    secret,
    Date.now() + 3600_000,
    1,
  );
  return `datastack_admin_session=${token}`;
}

test("V2-Phase-01 [Vault]: encryptSecret/decryptSecret AES-256-GCM roundtrip, tamper detection & masked hints", () => {
  const secretA = "test-master-secret-key-at-least-32-characters";
  const secretB = "different-master-secret-key-at-least-32-chars";

  const encrypted = encryptSecret("r2_secret_value_987654321", secretA);
  assert.ok(encrypted.startsWith("v1:"));
  assert.equal(decryptSecret(encrypted, secretA), "r2_secret_value_987654321");
  assert.equal(getMaskedHintFromEncrypted(encrypted, secretA), "••••4321");

  // Tampered ciphertext throws SecretVaultError (V2-E01)
  const parts = encrypted.split(":");
  const flippedChar = parts[3].startsWith("A") ? "B" : "A";
  const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${flippedChar}${parts[3].slice(1)}`;
  assert.throws(
    () => decryptSecret(tampered, secretA),
    (err: unknown) =>
      err instanceof SecretVaultError && err.code === "SECRET_VAULT_DECRYPT_FAILED",
  );

  // Wrong master key throws SecretVaultError
  assert.throws(
    () => decryptSecret(encrypted, secretB),
    (err: unknown) =>
      err instanceof SecretVaultError && err.code === "SECRET_VAULT_DECRYPT_FAILED",
  );

  // Too-short master secret rejects key derivation
  assert.throws(
    () => encryptSecret("hello", "short"),
    (err: unknown) =>
      err instanceof SecretVaultError && err.code === "SECRET_VAULT_KEY_UNAVAILABLE",
  );
});

test("V2-Phase-01 [S3 SigV4]: buildS3ObjectKey, normalizeS3EndpointUrl, testS3Connection & uploadFileToS3 against mock S3 server", async () => {
  assert.equal(
    buildS3ObjectKey("/datastack/", "client_01", "2026-10-01.csv.gz"),
    "datastack/client_01/2026-10-01.csv.gz",
  );
  assert.equal(
    normalizeS3EndpointUrl("", "us-east-1").url.origin,
    "https://s3.us-east-1.amazonaws.com",
  );

  const requests: Array<{
    method: string;
    url: string;
    auth: string;
    bodyLen: number;
  }> = [];
  let failUploads = false;

  const mockS3 = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method || "",
        url: req.url || "",
        auth: String(req.headers.authorization || ""),
        bodyLen: body.byteLength,
      });
      if (req.method === "PUT" && failUploads) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Simulated S3 outage");
        return;
      }
      if (req.method === "PUT") {
        res.writeHead(200, { etag: '"mock-etag-1"' });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("<ListBucketResult></ListBucketResult>");
    });
  });

  await new Promise<void>((resolve) => mockS3.listen(0, "127.0.0.1", resolve));
  const addr = mockS3.address() as AddressInfo;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-v2-s3-"));

  try {
    const samplePath = path.join(tmpDir, "2026-10-01.csv.gz");
    const gzData = zlib.gzipSync(
      Buffer.from('clientId,eventId,timestamp,payload\n"c1","e1","2026-10-01T00:00:00Z","{}"\n'),
    );
    await fs.writeFile(samplePath, gzData);

    const cfg = {
      endpoint: `http://127.0.0.1:${addr.port}`,
      region: "auto",
      bucket: "ds-archive",
      prefix: "datastack/",
      accessKeyId: "AKIA_TEST_123",
      secretAccessKey: "secret_access_key_xyz_999",
    };

    const probe = await testS3Connection(cfg);
    assert.equal(probe.ok, true);
    assert.equal(probe.status, 200);
    assert.match(requests[0].auth, /^AWS4-HMAC-SHA256 Credential=AKIA_TEST_123\//);
    assert.match(requests[0].url, /^\/ds-archive\?list-type=2&max-keys=1$/);

    const uploadOk = await uploadFileToS3(
      cfg,
      samplePath,
      "datastack/c1/2026-10-01.csv.gz",
    );
    assert.equal(uploadOk.ok, true);
    assert.equal(uploadOk.etag, '"mock-etag-1"');
    assert.equal(requests[1].method, "PUT");
    assert.equal(requests[1].url, "/ds-archive/datastack/c1/2026-10-01.csv.gz");
    assert.equal(requests[1].bodyLen, gzData.byteLength);

    failUploads = true;
    const uploadErr = await uploadFileToS3(
      cfg,
      samplePath,
      "datastack/c1/2026-10-01.csv.gz",
    );
    assert.equal(uploadErr.ok, false);
    assert.equal(uploadErr.code, "S3_ARCHIVE_FAILED");
    assert.match(uploadErr.error || "", /HTTP 500/);
  } finally {
    await new Promise<void>((resolve) => mockS3.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("V2-Phase-01 [Compression, Export, S3 Safe Prune V2-E02, Corrupt Gzip V2-E03]", async () => {
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const prevDbUrl = process.env.DATABASE_URL;
  const origBaseStorageDir = CSVStorageManager.baseStorageDir;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-v2-gz-"));
  delete process.env.DATABASE_URL;
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  CSVStorageManager.baseStorageDir = tmpDir;
  CSVStorageManager.clearRowCountCache();
  CSVStorageManager.clearQuotaCaches();

  const uploadedKeys: string[] = [];
  let failNextUpload = false;
  const mockS3 = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      if (req.method === "PUT") {
        if (failNextUpload) {
          res.writeHead(502);
          res.end("Upstream error");
          return;
        }
        uploadedKeys.push(req.url || "");
        res.writeHead(200, { etag: '"ok"' });
        res.end("");
        return;
      }
      res.writeHead(200);
      res.end("<OK/>");
    });
  });

  await new Promise<void>((resolve) => mockS3.listen(0, "127.0.0.1", resolve));
  const s3Addr = mockS3.address() as AddressInfo;

  try {
    const cookie = await makeAdminCookie();
    const today = new Date().toISOString().slice(0, 10);
    const oldDate = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
    await SettingsManager.updateSettings({
      autoPruneDays: 90,
      compressAfterDays: 0,
      enableS3Backup: false,
      diskPauseThresholdPct: 0,
    });

    // 1. Write 2 old rows (45 days ago) and 1 today row
    await CSVStorageManager.appendBatch([
      {
        clientId: "v2_alpha",
        eventId: "evt_old_1",
        timestamp: `${oldDate}T10:00:00.000Z`,
        payload: '{"stage":"old","seq":1}',
      },
      {
        clientId: "v2_alpha",
        eventId: "evt_old_2",
        timestamp: `${oldDate}T11:00:00.000Z`,
        payload: '{"stage":"old","seq":2}',
      },
      {
        clientId: "v2_alpha",
        eventId: "evt_today_1",
        timestamp: `${today}T09:00:00.000Z`,
        payload: '{"stage":"live","seq":3}',
      },
    ]);

    // 2. Compress partitions older than 30 days -> ${oldDate}.csv becomes .csv.gz; today stays .csv
    const compressed = await CSVStorageManager.compressOldPartitionsAsync(30);
    assert.equal(compressed, 1);

    const files = await CSVStorageManager.listAllFilesAsync();
    assert.equal(files.length, 2);
    const gzMeta = files.find((f) => f.filename === `${oldDate}.csv.gz`);
    assert.ok(gzMeta, `Expected compressed ${oldDate}.csv.gz partition`);
    assert.equal(gzMeta.linesCount, 2);
    assert.equal(gzMeta.compressed, true);

    // Original uncompressed ${oldDate}.csv was removed after atomic rename
    const legacyCsv = path.join(tmpDir, "v2_alpha", `${oldDate}.csv`);
    await assert.rejects(() => fs.stat(legacyCsv));

    // 3. Verify GET /api/data reads .csv.gz transparently
    const dataRes = await dataGet(
      new NextRequest(
        `http://localhost:3000/api/data?clientId=v2_alpha&from=${oldDate}&to=${oldDate}`,
        { headers: { cookie } },
      ),
    );
    assert.equal(dataRes.status, 200);
    const dataJson = await dataRes.json();
    assert.equal(dataJson.total, 2);
    assert.equal(dataJson.events.length, 2);
    assert.equal(dataJson.events[0].eventId, "evt_old_2");
    assert.equal(dataJson.events[1].eventId, "evt_old_1");

    // 4. Verify GET /api/events reads compressed partition seamlessly
    const evRes = await eventsGet(
      new NextRequest("http://localhost:3000/api/events?clientId=v2_alpha&limit=10", {
        headers: { cookie },
      }),
    );
    assert.equal(evRes.status, 200);
    const evJson = await evRes.json();
    const ids = (evJson.events as Array<{ eventId: string }>).map((e) => e.eventId);
    assert.ok(ids.includes("evt_old_1"));
    assert.ok(ids.includes("evt_today_1"));

    // 5. Verify GET /api/export CSV, JSON, and raw single .csv.gz download
    const exportCsvRes = await exportGet(
      new NextRequest(
        `http://localhost:3000/api/export?clientId=v2_alpha&from=${oldDate}&to=${oldDate}&format=csv`,
        { headers: { cookie } },
      ),
    );
    assert.equal(exportCsvRes.status, 200);
    const exportedCsvText = await exportCsvRes.text();
    assert.match(exportedCsvText, /evt_old_1/);
    assert.match(exportedCsvText, /evt_old_2/);

    const exportJsonRes = await exportGet(
      new NextRequest(
        `http://localhost:3000/api/export?clientId=v2_alpha&from=${oldDate}&to=${oldDate}&format=json`,
        { headers: { cookie } },
      ),
    );
    assert.equal(exportJsonRes.status, 200);
    const exportedJson = await exportJsonRes.json();
    assert.equal(exportedJson.length, 2);

    const exportSingleGzRes = await exportGet(
      new NextRequest(
        `http://localhost:3000/api/export?clientId=v2_alpha&file=${oldDate}.csv.gz`,
        { headers: { cookie } },
      ),
    );
    assert.equal(exportSingleGzRes.status, 200);
    assert.equal(exportSingleGzRes.headers.get("content-type"), "application/gzip");
    const downloadedBuf = Buffer.from(await exportSingleGzRes.arrayBuffer());
    assert.match(zlib.gunzipSync(downloadedBuf).toString("utf8"), /evt_old_1/);

    // 6. Save S3 settings via POST /api/settings and verify GET /api/settings masks secret (zero plaintext leak)
    const saveRes = await settingsPost(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          compressAfterDays: 30,
          autoPruneDays: 60,
          diskPauseThresholdPct: 92,
          enableS3Backup: true,
          s3Endpoint: `http://127.0.0.1:${s3Addr.port}`,
          s3Region: "auto",
          s3Bucket: "prod-vault",
          s3Prefix: "archive-test/",
          s3AccessKeyId: "AKIA_V2_KEY",
          s3SecretAccessKey: "super_secret_v2_token_7788",
        }),
      }),
    );
    assert.equal(saveRes.status, 200);

    const getRes = await settingsGet(
      new NextRequest("http://localhost:3000/api/settings", { headers: { cookie } }),
    );
    assert.equal(getRes.status, 200);
    const getText = await getRes.text();
    assert.doesNotMatch(getText, /super_secret_v2_token_7788/);
    const parsedSettings = JSON.parse(getText).settings;
    assert.equal(parsedSettings.hasS3SecretKey, true);
    assert.equal(parsedSettings.s3SecretKeyMask, "••••7788");
    assert.equal(parsedSettings.compressAfterDays, 30);
    assert.equal(parsedSettings.diskPauseThresholdPct, 92);

    // 7. POST /api/storage/s3-test succeeds with saved credentials
    const s3TestRes = await s3TestPost(
      new NextRequest("http://localhost:3000/api/storage/s3-test", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({}),
      }),
    );
    assert.equal(s3TestRes.status, 200);
    assert.equal((await s3TestRes.json()).success, true);

    // 8. V2-E02: When S3 upload fails, POST /api/storage/archive returns 502 and NEVER deletes local partition
    failNextUpload = true;
    const failArchiveRes = await archivePost(
      new NextRequest("http://localhost:3000/api/storage/archive", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ pruneAfterUpload: true, olderThanDays: 30 }),
      }),
    );
    assert.equal(failArchiveRes.status, 502);
    const failArchiveJson = await failArchiveRes.json();
    assert.equal(failArchiveJson.code, "S3_ARCHIVE_FAILED");
    assert.equal(failArchiveJson.prunedCount, 0);
    // File MUST still exist on disk!
    await fs.stat(gzMeta.filePath);

    // 9. When S3 upload succeeds with pruneAfterUpload: false, local file stays + uploadedKeys receives .csv.gz
    failNextUpload = false;
    const okArchiveRes = await archivePost(
      new NextRequest("http://localhost:3000/api/storage/archive", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ pruneAfterUpload: false, olderThanDays: 30 }),
      }),
    );
    assert.equal(okArchiveRes.status, 200);
    const okArchiveJson = await okArchiveRes.json();
    assert.equal(okArchiveJson.archivedCount, 1);
    assert.equal(okArchiveJson.prunedCount, 0);
    assert.deepEqual(uploadedKeys, [`/prod-vault/archive-test/v2_alpha/${oldDate}.csv.gz`]);
    await fs.stat(gzMeta.filePath);

    // 10. V2-E03: Corrupt .csv.gz cleanly surfaces error in /api/data instead of crashing
    await fs.writeFile(
      path.join(tmpDir, "v2_alpha", "2024-01-01.csv.gz"),
      Buffer.from("not-valid-gzip-bytes"),
    );
    const corruptDataRes = await dataGet(
      new NextRequest(
        "http://localhost:3000/api/data?clientId=v2_alpha&from=2024-01-01&to=2024-01-01",
        { headers: { cookie } },
      ),
    );
    assert.equal(corruptDataRes.status, 500);
    const corruptJson = await corruptDataRes.json();
    assert.match(corruptJson.error || "", /Corrupt|\.gz/i);
  } finally {
    await new Promise<void>((resolve) => mockS3.close(() => resolve()));
    await DataBufferEngine.shutdown();
    CSVStorageManager.baseStorageDir = origBaseStorageDir;
    CSVStorageManager.clearRowCountCache();
    CSVStorageManager.clearQuotaCaches();
    if (prevStorageDir === undefined) delete process.env.DATASTACK_STORAGE_DIR;
    else process.env.DATASTACK_STORAGE_DIR = prevStorageDir;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    await fs.rm(tmpDir, { recursive: true, force: true });
    resetAdminStateForTests();
  }
});

test("V2-Phase-01 [Quotas V2-E04 & V2-E05]: HTTP POST /api/events + Port 4000 Socket.IO enforce disk threshold & per-client storageQuotaMb while keeping Admin reads online", async () => {
  const prevStorageDir = process.env.DATASTACK_STORAGE_DIR;
  const prevDbUrl = process.env.DATABASE_URL;
  const prevDisableListen = process.env.DATASTACK_DISABLE_LISTEN;
  const origBaseStorageDir = CSVStorageManager.baseStorageDir;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "datastack-v2-quota-"));

  delete process.env.DATABASE_URL;
  process.env.DATASTACK_STORAGE_DIR = tmpDir;
  CSVStorageManager.baseStorageDir = tmpDir;
  process.env.DATASTACK_DISABLE_LISTEN = "1";
  CSVStorageManager.clearQuotaCaches();
  await DataBufferEngine.shutdown();
  DataBufferEngine.setRedisClientForTests(null);

  const serverMod = require("../server/index.js") as {
    server: http.Server;
    io: { close: (cb: () => void) => void };
    writer: {
      baseDir: string;
      setStatfsOverrideForTests: (
        fn: ((dir: string) => Promise<{ blocks: number; bavail: number; bsize: number }>) | null,
      ) => void;
      clearQuotaCaches: () => void;
    };
    runtimeConfig: { diskPauseThresholdPct: number };
    setDbPoolForTests: (pool: unknown) => void;
    stopTimers: () => void;
  };
  const origWriterBaseDir = serverMod.writer.baseDir;
  serverMod.writer.baseDir = tmpDir;
  serverMod.writer.clearQuotaCaches();

  const openSockets: Socket[] = [];
  let listeningUrl = "";

  try {
    const cookie = await makeAdminCookie();

    // 1. Validate UI helper & API validation for diskPauseThresholdPct (0 or 50..99)
    assert.equal(validateSingleNumericSetting("diskPauseThresholdPct", "0").valid, true);
    assert.equal(validateSingleNumericSetting("diskPauseThresholdPct", "95").valid, true);
    assert.equal(validateSingleNumericSetting("diskPauseThresholdPct", "25").valid, false);
    const fullDraft = settingsToNumericDrafts(DEFAULT_EDITABLE_SETTINGS);
    assert.equal(validateEditableSettingsDraft(fullDraft, true).valid, true);

    const badPctRes = await settingsPost(
      new NextRequest("http://localhost:3000/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ diskPauseThresholdPct: 25 }),
      }),
    );
    assert.equal(badPctRes.status, 400);

    await SettingsManager.updateSettingsAsync({ diskPauseThresholdPct: 90 });

    // 2. Register client via /api/clients with 1 MB quota & edit quota via PATCH /api/clients/[id]
    const createRes = await clientsPost(
      new NextRequest("http://localhost:3000/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          clientId: "quota_client",
          name: "Quota Client",
          rateLimit: 200,
          storageQuotaMb: 2,
        }),
      }),
    );
    assert.equal(createRes.status, 201);
    const createdClient = (await createRes.json()).client;
    assert.equal(createdClient.storageQuotaMb, 2);

    const patchRes = await patchClientRoute(
      new NextRequest("http://localhost:3000/api/clients/quota_client", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ storageQuotaMb: 1 }),
      }),
      { params: Promise.resolve({ id: "quota_client" }) },
    );
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).client.storageQuotaMb, 1);

    const listRes = await clientsGet(
      new NextRequest("http://localhost:3000/api/clients", { headers: { cookie } }),
    );
    const listed = (await listRes.json()).clients.find(
      (c: { clientId: string }) => c.clientId === "quota_client",
    );
    assert.equal(listed.storageQuotaMb, 1);

    // Seed 1.1 MB into client dir to breach 1 MB quota (V2-E05)
    const clientDir = path.join(tmpDir, "quota_client");
    await fs.mkdir(clientDir, { recursive: true });
    await fs.writeFile(
      path.join(clientDir, "2026-10-10.csv"),
      Buffer.alloc(Math.ceil(1.1 * 1024 * 1024), "x"),
    );
    CSVStorageManager.clearQuotaCaches("quota_client");

    const httpQuotaRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${createdClient.token}`,
        },
        body: JSON.stringify({ eventId: "q_evt_1", data: { ok: true } }),
      }),
    );
    assert.equal(httpQuotaRes.status, 507);
    assert.equal((await httpQuotaRes.json()).code, "STORAGE_QUOTA_EXCEEDED");

    // Now test global VPS disk threshold >= 90% (V2-E04) across HTTP + Socket.IO
    await patchClientRoute(
      new NextRequest("http://localhost:3000/api/clients/quota_client", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ storageQuotaMb: 0 }),
      }),
      { params: Promise.resolve({ id: "quota_client" }) },
    );
    CSVStorageManager.setStatfsOverrideForTests(async () => ({
      blocks: 1000,
      bavail: 50, // 95% used >= 90% threshold
      bsize: 4096,
    }));

    const httpDiskRes = await eventsPost(
      new NextRequest("http://localhost:3000/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${createdClient.token}`,
        },
        body: JSON.stringify({ eventId: "q_evt_2", data: { ok: true } }),
      }),
    );
    assert.equal(httpDiskRes.status, 507);
    assert.equal((await httpDiskRes.json()).code, "DISK_SPACE_LOW");

    // Admin read/storage/export MUST remain 100% operational while ingestion is paused!
    const storageRes = await storageGet(
      new NextRequest("http://localhost:3000/api/storage", { headers: { cookie } }),
    );
    assert.equal(storageRes.status, 200);
    const storageJson = await storageRes.json();
    assert.equal(storageJson.diskUsage.usedPct, 95);

    // Port 4000 Socket.IO enforcement for DISK_SPACE_LOW & STORAGE_QUOTA_EXCEEDED
    let mockQuotaMb = 0;
    serverMod.runtimeConfig.diskPauseThresholdPct = 90;
    serverMod.setDbPoolForTests({
      query: async (sql: string) => {
        if (sql.includes("FROM client_sdks")) {
          return {
            rowCount: 1,
            rows: [
              {
                client_id: "quota_client",
                token: createdClient.token,
                status: "active",
                rate_limit: 200,
                storage_quota_mb: mockQuotaMb,
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    });
    serverMod.writer.setStatfsOverrideForTests(async () => ({
      blocks: 1000,
      bavail: 50, // 95% used
      bsize: 4096,
    }));

    await new Promise<void>((resolve) =>
      serverMod.server.listen(0, "127.0.0.1", resolve),
    );
    const addr = serverMod.server.address() as AddressInfo;
    listeningUrl = `http://127.0.0.1:${addr.port}`;

    const socket = ioClient(listeningUrl, {
      auth: { token: createdClient.token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 3000,
    });
    openSockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("connect_error", reject);
    });

    const singleDiskAck = await new Promise<{
      success: boolean;
      code?: string;
    }>((resolve, reject) => {
      socket.timeout(3000).emit("sync_data", { data: { k: 1 } }, (err: unknown, ack: { success: boolean; code?: string }) => {
        if (err) reject(err);
        else resolve(ack);
      });
    });
    assert.equal(singleDiskAck.success, false);
    assert.equal(singleDiskAck.code, "DISK_SPACE_LOW");

    // Relax disk threshold & activate per-client 1 MB quota in Socket.IO worker
    serverMod.writer.setStatfsOverrideForTests(async () => ({
      blocks: 1000,
      bavail: 800, // 20% used
      bsize: 4096,
    }));
    serverMod.writer.clearQuotaCaches();
    mockQuotaMb = 1;
    // Wait out 2s verifyClientInDb cache or update query response cleanly
    await new Promise((r) => setTimeout(r, 2100));

    const batchQuotaAck = await new Promise<{
      success: boolean;
      code?: string;
      rejected?: number;
    }>((resolve, reject) => {
      socket.timeout(3000).emit(
        "batch_sync",
        [{ eventId: "b1", data: { k: 1 } }],
        (err: unknown, ack: { success: boolean; code?: string; rejected?: number }) => {
          if (err) reject(err);
          else resolve(ack);
        },
      );
    });
    assert.equal(batchQuotaAck.success, false);
    assert.equal(batchQuotaAck.code, "STORAGE_QUOTA_EXCEEDED");
    assert.equal(batchQuotaAck.rejected, 1);

    // Clean delete route check
    const delRes = await deleteClientRoute(
      new NextRequest("http://localhost:3000/api/clients/quota_client?purgeFiles=true", {
        method: "DELETE",
        headers: { cookie },
      }),
      { params: Promise.resolve({ id: "quota_client" }) },
    );
    assert.equal(delRes.status, 200);
  } finally {
    for (const s of openSockets) {
      try {
        s.disconnect();
      } catch {
        // ignore
      }
    }
    serverMod.writer.setStatfsOverrideForTests(null);
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
    CSVStorageManager.setStatfsOverrideForTests(null);
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
