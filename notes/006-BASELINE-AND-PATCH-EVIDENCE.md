# DataStack — Baseline Freeze, Code Proof & Proposed Patch Index

Frozen source baseline SHA: `d725841ebc828d58cbe90f517da9e600f23c4630` (2026-11-22, Asia/Dhaka).
Source verification: exact GitHub/GitLab/Gitea remote `main` and local HEAD matched this SHA. Local working tree clean; local `origin` configured to `MdNurnobi-Dev/DataStack.git`, and its *local tracking ref* was stale (`725d3c5`), so `ahead 5` alone was NOT evidence GitHub `JILLU-Games` was behind. GitHub `JILLU-Games` read-only branch HEAD verified at `d725841ebc828d58cbe90f517da9e600f23c4630`. No force push, ref rewrite or upstream reset authorized.

## A. Proof excerpts (verbatim short source fragments, exact baseline files/lines)

### CI-02 — stale lockfile contract (P01)
`tests/phase07-deployment.test.ts:648-650`:
```ts
test("FINAL-DEPLOY-FIX-01: Single npm lockfile, Dockerfile .runtime-logs ownership parity, 8-table prisma sync, and cold-boot MCP bridge hydration", async () => {
  assert.equal(existsSync(resolve(process.cwd(), "bun.lock")), false, "Stale bun.lock must stay removed");
```
`git ls-files bun.lock` listed the file on baseline. **Patch reference**: check if any build consumer references it; if none, remove exactly `bun.lock` while preserving `package-lock.json`. Re-run this specific test.

### CI-04 — stale UI test expectation (P01)
`tests/v2-phase01-storage-quotas.test.ts:788-804`:
```ts
assert.match(clientsPageSrc, /function isClientExpired\(/);
assert.match(clientsPageSrc, /const expired = !revoked && isClientExpired\(client\.expiresAt,\s*now\)/);
```
`app/vcon/clients/page.tsx:70-85`:
```ts
const counts = useMemo(
  () => summarizeUiClientCounts(clients, now),
  [clients, now],
);
const computedStatus = classifyUiClientStatus(client, now);
```
`lib/vconUiHelpers.ts:717,730,754` exports `isUiClientExpired`, `classifyUiClientStatus`, `summarizeUiClientCounts`.
**Proposed patch shape** (planning-only, not applied):
```diff
--- a/tests/v2-phase01-storage-quotas.test.ts
+++ b/tests/v2-phase01-storage-quotas.test.ts
@@ obsolete regex-based UI expectations, lines 788-804 @@
-    assert.match(clientsPageSrc, /function isClientExpired\(/);
+    assert.match(clientsPageSrc, /summarizeUiClientCounts/);
+    assert.match(clientsPageSrc, /classifyUiClientStatus/);
```
Also **replace the other 3 obsolete implementation-detail regexes** with behavioral assertions against exported helper and page filtering/count data; do not just drop coverage. Exact final diff is generated only during approved P01.

### CI-03 — test-process hang anchor (P01)
`core/data/buffer.ts:347-352,379-391`:
```ts
state.flushTimer = setInterval(() => {
  void this.flush().catch(() => undefined);
}, state.batchFlushIntervalMs);
```
Run #45 suite exit codes 124: `r3-phase04-ui-metrics-rbac`, `r4-phase03-sdk-deploy-auth`, `r5-phase01-mcp-foundation-logs`, `r5-phase03-mcp-ui`. Timer is a **suspect**, not a proven sole root cause. **Patch reference:** instrument open handles and add narrow teardown in four named tests; `core/data/buffer.ts` is **read-only** unless new approval.

### CI-05 — compiler-source proof (P01)
`tsconfig.json:27`:
```json
"include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]
```
Run #45 job 68 examples:
```text
tests/phase01-auth.test.ts(88,17): error TS2540: Cannot assign to 'NODE_ENV' because it is a read-only property.
tests/r5-phase02-mcp-server.test.ts(510,8): error TS18046: 'deniedClientCreate.content' is of type 'unknown'.
tests/v2-phase01-storage-quotas.test.ts(762,64): error TS2554: Expected 0 arguments, but got 1.
```
**Patch reference:** exact 9 test files / line map in `001`. Use correct typings/type guards and current API signatures, not TS ignore or global tsconfig exclusion.

### CI-01 — Windows clean-install lockfile mismatch (P01)
Run #42 job 63:
```text
npm error Missing: @img/sharp-win32-x64@0.35.5 from lock file
npm error Missing: @unrs/resolver-binding-win32-x64-msvc@1.13.0 from lock file
```
Run #45 job 71 showed success **only after temporary runner** `npm install --package-lock-only`, followed by `npm ci` and Node SDK build. **Patch reference:** `package-lock.json` optional/native dependencies, retain pinned package graph; verify unchanged tracked lock under CI on Linux/Windows.

### CI-06 — Python runner packages (P03)
Run #45 job 67:
```text
E: Failed to fetch ... python3.9-venv_3.9.2-1+deb11u7_amd64.deb  404 Not Found
```
`.gitea/workflows/datastack-ci.yml` Python install step uses `apt-get update -qq; apt-get install -y python3 python3-venv python3-pip`. Run #48 job 74 executes 14 tests PASS on Windows. **Patch reference:** CI job Python provisioning only.

### CI-07 — Docker web layer failure (P03)
`docker/Dockerfile.web:13`:
```dockerfile
COPY --from=dependencies /app/node_modules ./node_modules
```
Run #50 job 76:
```text
failed to create diff tar stream: lstat .../app/node_modules/@uiw: no such file or directory
```
`docker/Dockerfile.server` produced tagged ingestion image; Docker Compose `config --no-interpolate --quiet` PASS. **Patch reference:** `.gitea/workflows/datastack-docker-ci.yml` runner/cache/BuildKit; Dockerfile modification conditional on independent reproduction and new approval.

### CI-08 — npm advisory summary (P03)
Run #50 job 76:
```text
24 vulnerabilities (23 moderate, 1 high)
26 vulnerabilities (25 moderate, 1 high)
```
**No evidence of specific advisory IDs yet.** Patch reference `package.json`/`package-lock.json` only after isolated `npm audit --json` with package/CVE/runtime attribution. Never add counts or claim 50 unique advisories.

### R-01 — Redis volatile fallback ACK risk (P02, conditional)
`server/index.js:165-193`:
```js
try {
  bufferLen = await redis.rpush(REDIS_BUFFER_KEY, ...serialized);
  redisConnected = true;
} catch {
  redisConnected = false;
}
// ...
bufferQueue.push(...events);
return bufferQueue.length;
```
`server/socket/handlers.js:583-602`:
```js
bufferQueue.push(event);
try {
  await onBufferPush();
} catch (persistErr) {
  // callback BUFFER_PERSIST_FAILED
}
if (callback) callback({ success: true, eventId });
```
**Potential issue**: a successful ACK does not necessarily mean durable storage after Redis failure; test first. Proposed patch is NOT predetermined.

### R-02 — CSV before Redis trim (P02, conditional)
`server/index.js:981-994`:
```js
const res = await writer.writeBatch(parsedBatch);
// ...
await redis.ltrim(REDIS_BUFFER_KEY, rawItems.length, -1);
```
**Potential issue**: crash after partial write or before list trim may replay buffered rows. Test with injected partial failures and compare event IDs before prescribing exactly-once guarantee.

### R-03 — Health shows service liveness (P02, conditional)
`server/index.js:1939-1955`:
```js
const redisBufferSize = await getRedisBufferLen();
res.json({ status: 'online', /* ... */ redisConnected, /* ... */ });
```
`app/api/health/route.ts:95-105`:
```ts
const bufferStats = await DataBufferEngine.getBufferStatsAsync();
return NextResponse.json({ status: 'online', service: 'DataStack Web API', /* ... */ });
```
**Potential issue**: liveness is not transactional readiness. Preserve existing public endpoint shape and verify separately.

## B. Source-to-patch navigation

- P01: `package-lock.json`; `bun.lock`; `tests/phase07-deployment.test.ts:649`; `tests/v2-phase01-storage-quotas.test.ts:762,783,788-804`; 4 timeout tests; 9 TS test files; `.gitea/workflows/datastack-ci.yml`.
- P02 conditional: `server/index.js:165-193,943-994,1939-1956`, `server/socket/handlers.js:583-602`, `server/workers/csvWriter.js:265-323`, `app/api/health/route.ts:95-111`; associated test files. Read-only until fault reproduction.
- P03: `.gitea/workflows/datastack-ci.yml`, `datastack-python-ci.yml`, `datastack-docker-ci.yml`, `datastack-eslint-ci.yml`; `package.json` / `package-lock.json` only justified dependency changes. Source Dockerfile edits separately approved only if needed.

## C. Documentation baseline update record

This file **freezes the source baseline**, not the future documentation-commit SHA. After adding `notes/**`, record commit SHA and three remote SHAs in `notes/003` and the user-facing result. Subsequent P01 implementation should inspect `git diff d725841ebc828d58cbe90f517da9e600f23c4630..HEAD` and permit only these notes as intervening changes; any unexpected source edits require a new review.

## D. P01 Actual Patch & CI Closure Proof — 2026-11-22

Frozen source baseline remains `d725841ebc828d58cbe90f517da9e600f23c4630`, docs baseline `d8ac96e39dad4ea3b241c1d2f16f959c5215701e`. CI-verified implementation snapshot `7d8eebd3dc867e82113343403b63ce1d4ed20584` (Gitea disposable P01 branch). Permanent main closure is single squash commit containing this note; verify post-push three remote refs/content trees.

### Lock and package integrity evidence (CI-01 / CI-02)

```json
{
  "node_modules/@napi-rs/wasm-runtime/node_modules/@tybys/wasm-util": {
    "version": "0.10.5",
    "resolved": "https://registry.npmjs.org/@tybys/wasm-util/-/wasm-util-0.10.5.tgz",
    "integrity": "sha512-dOGOPxlaNV+G046mZzN+9C0dAcQZeSKcXiVaM0TYy/LM4ttTmgSBDxYfovcYI8Em3+eAbiAYpvWLOv8+ZVRJKA==",
    "optional": true,
    "dependencies": {"tslib": "^2.4.0"}
  }
}
```

The root `@tybys/wasm-util@0.9.0` remains unchanged; 68 optional entries added, 1293 old entries unchanged, none removed/repinned, all added entries with registry tarball and integrity, `package.json` unchanged. `bun.lock` removed after checking no active consumers. Windows and Linux `npm ci --no-audit --no-fund` PASS using committed lock without temporary regeneration.

### Test-only teardown correction (CI-03 / CI-05)

`tests/r5-phase01-mcp-foundation-logs.test.ts` local CommonJS require declaration now explicitly includes `stopTimers`, matching the existing runtime export; `test.after` releases ingestion timers and `DataBufferEngine.shutdown()` without any changes to runtime source:

```ts
const ingestionServer = require("../server/index.js") as {
  setDbPoolForTests: (pool: unknown) => void;
  syncSettingsFromDatabase: () => Promise<boolean>;
  stopTimers: () => void;
};

test.after(async () => {
  ingestionServer.stopTimers();
  SDKManager.stopActivityFlushTimerForTests();
  await DataBufferEngine.shutdown();
});
```

Remaining CI-05 corrections were confined to 9 test file type contracts; CI-04 replaced old `isClientExpired` page regex expectations with `classifyUiClientStatus` + `summarizeUiClientCounts` behavioral assertions. No TS strictness flags disabled, no global `any` blanket suppression, no SDK/API runtime signature changed.

### Exact gate results

- [Run #58](https://dev.ivib.cc/vibtools/DataStack/actions/runs/58): failed at lockfile nested dependency before tests; historical and superseded.
- [Run #59](https://dev.ivib.cc/vibtools/DataStack/actions/runs/59): overall failed because exactly one test mock TypeScript declaration lacked `stopTimers`, but separate job results independently verified **24/24 TypeScript suites exit0**, no timeouts, Linux/Windows committed-lock clean npm installs, Node SDK compilation and Next.js standalone build + 22/22 pages all PASS.
- [Run #60](https://dev.ivib.cc/vibtools/DataStack/actions/runs/60): focused quality-only retry after exact test-type correction, **strict `npx tsc --noEmit` PASS 0 errors** and **`npm run lint` PASS**.
- [Run #48](https://dev.ivib.cc/vibtools/DataStack/actions/runs/48): previous Python SDK 14/14 PASS, no Python source edits or P01 rerun.

Targeted path/diff audit from prior documentation HEAD: 16 scoped code/test/CI paths plus notes `001–006`; `git diff --check` PASS. P02 remaining R-01…R-03 are conditional reliability risks, not confirmed application bugs. P03 Docker/Python-runner/advisory issues still open. No live app, deployment, database, security defaults or user features changed.


## E. P02 Concrete Code/CI Evidence — 2026-11-22

**Frozen previous phase:** P01 Gitea/GitHub commit `667a140c4e9e75382bfdcdbe1d3e9eb96f6e808a`. P02 test-only commit `bbe73d91666641743cbec6cf7203f1694094caef` adds 103 lines across exactly two approved test paths. Gitea CI #63: https://dev.ivib.cc/vibtools/DataStack/actions/runs/63. No application source modification.

### R-01 ACK after Redis RPUSH failure

`server/index.js:171-192`:

```js
try { bufferLen = await redis.rpush(REDIS_BUFFER_KEY, ...serialized); }
catch { redisConnected = false; }
// ... Redis failure path
bufferQueue.push(...events);
return bufferQueue.length;
```

`server/socket/handlers.js:583-602` invokes `await onBufferPush()` and then calls `callback({success:true,eventId})` unless an exception escapes. Test: `tests/phase02-sync.test.ts`, `P02 R-01 diagnostic`, overriding fake Redis `rpush` to reject; check ACK, absent Redis persistence, volatile RAM, and simulated reset. No real process exit.

### R-02 replay after append-before-trim

`core/data/buffer.ts:795-809` and Port-4000 `server/index.js:981-993` order `appendBatch()/writeBatch()` before `redis.ltrim()`. Test: `tests/phase03-storage-buffer.test.ts`, `P02 R-02 diagnostic`; inject the *first* LTRIM failure only after successful append, verify still queued, retry flush and count duplicate `eventId` in appended rows. Web-side representative fault-injection; not a complete ingestion-crash certificate.

### R-03 public status versus dependency readiness

`server/index.js:1926-1957` catches Redis LLEN error, sets `redisConnected=false`, and returns HTTP 200 `status:online`. Test `P02 R-03 diagnostic` mocks LLEN failure and recovery. This preserves existing public shape rather than implementing a readiness endpoint. PG startup fail-closed coverage remains source-only/NOT VERIFIED.

**Patch scope:** modified only `tests/phase02-sync.test.ts` and `tests/phase03-storage-buffer.test.ts` (plus notes/001–006). Original local user-staged P01 work preserved. Runtime files examined read-only. No production host, Redis, DB, CSV, API, service, CI workflow, release, or security setting changed.


### CI #63 observed P02 results

- `P02 R-01 diagnostic: Redis RPUSH failure yields positive WS ACK for volatile RAM-only event` — **ok 15**, test suite `phase02-sync` exit 0. Diagnostic indicates acknowledged event loss on simulated RAM reset when Redis has no record.
- `P02 R-03 diagnostic: Redis query failure leaves public ingestion health 200/online` — **ok 16**, same suite exit 0, Redis flag false while liveness stays online.
- `P02 R-02 diagnostic: post-CSV Redis trim failure replays identical event on retry` — **ok 18**, `phase03-storage-buffer` suite exit 0; duplicate append after retry reproduced on representative web buffer path. **Direct ingestion Port 4000 CSV worker crash coverage remains outstanding** and should be requested in remediation approval before guarantee changes.
- These three diagnostic tests **prove findings, do not close production-readiness**. See Gitea https://dev.ivib.cc/vibtools/DataStack/actions/runs/63; never call run successful until terminal conclusion is confirmed. No server-side source fix applied.
