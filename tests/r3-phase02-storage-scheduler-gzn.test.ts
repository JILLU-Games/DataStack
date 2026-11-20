import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { NextRequest } from "next/server";

import { GET as dataGet } from "../app/api/data/route";
import { GET as exportGet } from "../app/api/export/route";
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
import { CSVStorageManager } from "../core/Storage/csvStorage";

const { CsvWriterWorker } = require("../server/workers/csvWriter.js");

const ORIGINAL_STORAGE_DIR = CSVStorageManager.baseStorageDir;
const ORIGINAL_DB_URL = process.env.DATABASE_URL;
const ORIGINAL_SESSION_SECRET = process.env.DATASTACK_ADMIN_SESSION_SECRET;
const ORIGINAL_JWT_SECRET = process.env.DATASTACK_JWT_SECRET;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeGzipCsv(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(content, "utf8")));
}

async function createOwnerCookie(): Promise<string> {
  delete process.env.DATABASE_URL;
  const sessionSecret = getAdminSessionSecret();
  resetAdminStateForTests();
  const ownerEmail = "owner-r3p2@datastack.local";
  await createInitialAdmin(ownerEmail, "StrongPassword123!");
  const token = await createAdminSessionToken(
    ownerEmail,
    sessionSecret,
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
  await DataBufferEngine.shutdown();
  CSVStorageManager.baseStorageDir = ORIGINAL_STORAGE_DIR;
  CSVStorageManager.clearRowCountCache();
  CSVStorageManager.clearQuotaCaches();
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
  if (ORIGINAL_SESSION_SECRET === undefined) {
    delete process.env.DATASTACK_ADMIN_SESSION_SECRET;
  } else {
    process.env.DATASTACK_ADMIN_SESSION_SECRET = ORIGINAL_SESSION_SECRET;
  }
  if (ORIGINAL_JWT_SECRET === undefined) delete process.env.DATASTACK_JWT_SECRET;
  else process.env.DATASTACK_JWT_SECRET = ORIGINAL_JWT_SECRET;
  resetAdminStateForTests();
});

test("R3-Phase-02 BUG-09: Port 3000 and Port 4000 extractDateFromFilename parse -gzN and -partN-gzN identically", () => {
  const tmpDir = makeTempDir("datastack-r3p2-date-");
  const worker = new CsvWriterWorker(tmpDir);
  try {
    const cases: Array<[string, string]> = [
      ["2026-10-01.csv", "2026-10-01"],
      ["2026-10-01.csv.gz", "2026-10-01"],
      ["2026-10-01-part2.csv", "2026-10-01"],
      ["2026-10-01-part12.csv.gz", "2026-10-01"],
      ["2026-10-01-gz2.csv.gz", "2026-10-01"],
      ["2026-10-01-part2-gz3.csv.gz", "2026-10-01"],
      ["2026-10-01-gz2-part3.csv.gz", "2026-10-01"],
      ["not-a-date.csv.gz", "not-a-date"],
    ];

    for (const [filename, expected] of cases) {
      assert.equal(
        CSVStorageManager.extractDateFromFilename(filename),
        expected,
        `Port 3000 mismatch for ${filename}`,
      );
      assert.equal(
        worker.extractDateFromFilename(filename),
        expected,
        `Port 4000 mismatch for ${filename}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("R3-Phase-02 BUG-09: -gzN collision files work in /api/data (to filter + fallback timestamp), /api/export (to filter), and Port 3000/4000 pruning", async () => {
  const tmpDir = makeTempDir("datastack-r3p2-gzn-");
  const cookie = await createOwnerCookie();
  SettingsManager.updateSettings({
    autoPruneDays: 0,
    compressAfterDays: 0,
    enableS3Backup: false,
  });
  CSVStorageManager.baseStorageDir = tmpDir;
  CSVStorageManager.clearRowCountCache();
  CSVStorageManager.clearQuotaCaches();

  try {
    const clientDir = path.join(tmpDir, "gzn_client");
    const targetDate = "2025-02-15";
    const gz2Path = path.join(clientDir, `${targetDate}-gz2.csv.gz`);
    const partGzPath = path.join(clientDir, `${targetDate}-part2-gz3.csv.gz`);

    // Row in -gz2 intentionally omits timestamp to verify valid ISO fallback (`2025-02-15T00:00:00.000Z`)
    writeGzipCsv(
      gz2Path,
      `clientId,eventId,timestamp,payload\ngzn_client,evt_gz2_1,,"{""src"":""gz2""}"\n`,
    );
    writeGzipCsv(
      partGzPath,
      `clientId,eventId,timestamp,payload\ngzn_client,evt_part_gz3_1,${targetDate}T12:30:00.000Z,"{""src"":""part-gz3""}"\n`,
    );

    // 1. /api/data with exact to=2025-02-15 MUST return BOTH events with valid ISO timestamps
    const dataRes = await dataGet(
      new NextRequest(
        `http://localhost:3000/api/data?clientId=gzn_client&from=${targetDate}&to=${targetDate}`,
        { headers: { cookie } },
      ),
    );
    assert.equal(dataRes.status, 200);
    const dataJson = (await dataRes.json()) as {
      total: number;
      events: Array<{ eventId: string; timestamp: string }>;
    };
    assert.equal(dataJson.total, 2);
    const gz2Evt = dataJson.events.find((e) => e.eventId === "evt_gz2_1");
    assert.ok(gz2Evt, "evt_gz2_1 must not be excluded by to= filter");
    assert.equal(gz2Evt.timestamp, `${targetDate}T00:00:00.000Z`);
    assert.ok(
      dataJson.events.some((e) => e.eventId === "evt_part_gz3_1"),
      "evt_part_gz3_1 must not be excluded by to= filter",
    );

    // 2. /api/export with exact to=2025-02-15 MUST include BOTH -gzN files
    const exportRes = await exportGet(
      new NextRequest(
        `http://localhost:3000/api/export?clientId=gzn_client&from=${targetDate}&to=${targetDate}&format=json&flush=false`,
        { headers: { cookie } },
      ),
    );
    assert.equal(exportRes.status, 200);
    const exported = JSON.parse(await exportRes.text()) as Array<{
      eventId: string;
    }>;
    assert.equal(exported.length, 2);
    assert.ok(exported.some((e) => e.eventId === "evt_gz2_1"));
    assert.ok(exported.some((e) => e.eventId === "evt_part_gz3_1"));

    // 3. Port 3000 pruneExpiredPartitionsAsync deletes -gzN collision files older than cutoff
    const pruned3000 = await CSVStorageManager.pruneExpiredPartitionsAsync(7);
    assert.equal(pruned3000, 2);
    assert.equal(fs.existsSync(gz2Path), false);
    assert.equal(fs.existsSync(partGzPath), false);

    // 4. Port 4000 CsvWriterWorker.pruneExpiredPartitionsAsync also deletes -gzN collision files
    writeGzipCsv(
      gz2Path,
      `clientId,eventId,timestamp,payload\ngzn_client,evt_gz2_2,${targetDate}T00:00:00.000Z,"{}"\n`,
    );
    const worker = new CsvWriterWorker(tmpDir);
    const pruned4000 = await worker.pruneExpiredPartitionsAsync(7);
    assert.equal(pruned4000, 1);
    assert.equal(fs.existsSync(gz2Path), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("R3-Phase-02 BUG-05: Singleton periodic scheduler automatically archives expired files (including -gzN) to S3 and prunes locally, with overlap and unhydrated-DB guards", async () => {
  const tmpDir = makeTempDir("datastack-r3p2-s3sched-");
  delete process.env.DATABASE_URL;
  process.env.DATASTACK_ADMIN_SESSION_SECRET =
    "r3-phase02-test-session-secret-0123456789abcdef";
  CSVStorageManager.baseStorageDir = tmpDir;
  CSVStorageManager.clearRowCountCache();
  CSVStorageManager.clearQuotaCaches();
  SettingsManager.stopMaintenanceSchedulerForTests();

  const uploadedPaths: string[] = [];
  let failS3 = false;

  const mockS3 = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (failS3) {
        res.statusCode = 500;
        res.end("S3 temporary error");
        return;
      }
      if (req.method === "PUT") {
        uploadedPaths.push(req.url || "");
        res.statusCode = 200;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.end();
    });
  });

  await new Promise<void>((resolve) => mockS3.listen(0, "127.0.0.1", resolve));
  const addr = mockS3.address();
  assert.ok(addr && typeof addr === "object");

  try {
    // Configure S3 backup + autoPruneDays (cooldown will be reset so scheduled timer runs)
    await SettingsManager.updateSettingsAsync({
      enableS3Backup: true,
      autoPruneDays: 7,
      compressAfterDays: 0,
      s3Endpoint: `http://127.0.0.1:${addr.port}`,
      s3Region: "auto",
      s3Bucket: "sched-bucket",
      s3Prefix: "auto-archive/",
      s3AccessKeyId: "AKIA_SCHED_TEST",
      s3SecretAccessKey: "super_secret_sched_key_9999",
    });

    assert.equal(
      SettingsManager.isMaintenanceSchedulerActive(),
      true,
      "Scheduler must auto-bootstrap on settings access/update",
    );

    // Confirm singleton guard returns false when called again with no interval change
    assert.equal(SettingsManager.ensureMaintenanceScheduler(), false);

    // Plant expired files AFTER initial save so ONLY the scheduled timer can archive+prune them
    const clientDir = path.join(tmpDir, "sched_client");
    fs.mkdirSync(clientDir, { recursive: true });
    const oldCsv = path.join(clientDir, "2024-11-01.csv");
    const oldGz2 = path.join(clientDir, "2024-11-01-gz2.csv.gz");
    const todayDate = new Date().toISOString().slice(0, 10);
    const todayCsv = path.join(clientDir, `${todayDate}.csv`);

    fs.writeFileSync(
      oldCsv,
      `clientId,eventId,timestamp,payload\nsched_client,evt_old_csv,2024-11-01T00:00:00.000Z,"{}"\n`,
    );
    writeGzipCsv(
      oldGz2,
      `clientId,eventId,timestamp,payload\nsched_client,evt_old_gz2,2024-11-01T01:00:00.000Z,"{}"\n`,
    );
    fs.writeFileSync(
      todayCsv,
      `clientId,eventId,timestamp,payload\nsched_client,evt_today,${todayDate}T00:00:00.000Z,"{}"\n`,
    );

    // Expire prune cooldown and start a fast 30ms test interval to verify real timer firing
    const globals = globalThis as typeof globalThis & {
      __dataStackLastPruneMeta?: { days: number; ranAtMs: number };
      __dataStackMaintenanceRunning?: boolean;
      __dataStackSettingsHydrated?: boolean;
    };
    globals.__dataStackLastPruneMeta = {
      days: 7,
      ranAtMs: Date.now() - 2 * 60 * 60 * 1000,
    };
    SettingsManager.ensureMaintenanceScheduler(30);

    // Wait up to 1.5s for scheduled timer tick to upload to S3 and prune both expired files
    const deadline = Date.now() + 1500;
    while (
      Date.now() < deadline &&
      (fs.existsSync(oldCsv) || fs.existsSync(oldGz2))
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }

    SettingsManager.stopMaintenanceSchedulerForTests();

    assert.equal(fs.existsSync(oldCsv), false, "Expired .csv must be pruned after S3 upload");
    assert.equal(fs.existsSync(oldGz2), false, "Expired -gz2.csv.gz must be pruned after S3 upload");
    assert.equal(fs.existsSync(todayCsv), true, "Today's partition must remain intact");
    assert.ok(
      uploadedPaths.some((u) => u.includes("/sched-bucket/auto-archive/sched_client/2024-11-01.csv")),
      `Expected 2024-11-01.csv S3 upload, got: ${uploadedPaths.join(", ")}`,
    );
    assert.ok(
      uploadedPaths.some((u) => u.includes("/sched-bucket/auto-archive/sched_client/2024-11-01-gz2.csv.gz")),
      `Expected 2024-11-01-gz2.csv.gz S3 upload, got: ${uploadedPaths.join(", ")}`,
    );

    // Verify fail-safe when S3 returns 500: local expired file MUST NOT be deleted
    failS3 = true;
    const failCsv = path.join(clientDir, "2024-10-15.csv");
    fs.writeFileSync(
      failCsv,
      `clientId,eventId,timestamp,payload\nsched_client,evt_fail_s3,2024-10-15T00:00:00.000Z,"{}"\n`,
    );
    await SettingsManager.runScheduledMaintenanceTick({ forcePrune: true });
    assert.equal(
      fs.existsSync(failCsv),
      true,
      "Fail-safe: local file must NEVER be deleted when S3 upload fails",
    );

    // Verify overlap guard blocks concurrent execution
    globals.__dataStackMaintenanceRunning = true;
    const overlapResult = await SettingsManager.runScheduledMaintenanceTick({
      forcePrune: true,
    });
    globals.__dataStackMaintenanceRunning = false;
    assert.equal(overlapResult.ran, false);
    assert.equal(overlapResult.skippedReason, "ALREADY_RUNNING");

    // Verify unhydrated-DB guard skips maintenance when DATABASE_URL is configured but unhydrated
    process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/unreachable";
    globals.__dataStackSettingsHydrated = false;
    const unhydratedResult = await SettingsManager.runScheduledMaintenanceTick({
      forcePrune: true,
      skipDbSync: true,
    });
    delete process.env.DATABASE_URL;
    assert.equal(unhydratedResult.ran, false);
    assert.equal(unhydratedResult.skippedReason, "DB_UNHYDRATED");
  } finally {
    SettingsManager.stopMaintenanceSchedulerForTests();
    await new Promise<void>((resolve) => mockS3.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
