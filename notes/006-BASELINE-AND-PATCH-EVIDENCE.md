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


## F. P02 Remediation Candidate Patch Proof — 2026-11-22

Base: Gitea/GitHub published P02 diagnostic tree `fd57a3518d14bcb8367ce9ab9c3ec306bcfc9898`; GitLab distinct commit, same previous tree. Local candidate commit `44eee8877e40d1683f44502c2a0ba3d437a03b88` on isolated worktree. Initial exact delta: 5 approved source/test paths, 310 insertions and 22 deletions, no application UI, Python SDK, auth, public health route, CI or deployment edit. `git diff --check` and `node --check` on JS files PASS.

- `server/index.js:pushEventsToRedisOrFallback`: catch RPUSH failure, keep previous RAM buffering, throw sanitized `BUFFER_PERSIST_FAILED`; no positive ACK for that branch.
- `server/socket/handlers.js:sync_data/batch_sync`: negative ACK and best-effort claimed idempotency-key rollback with negative retry guard, no change to legitimate duplicate success path or existing auth/limits/error codes.
- `server/index.js:flushBuffer` and `core/data/buffer.ts:flush`: scoped streaming CSV/CSV.gz read-before-reappend (parsing quoted/multiline rows), exact client/date/event ID match; failures abort before Redis LTRIM. No changes to `server/workers/csvWriter.js`.
- `tests/phase02-sync.test.ts`: R-01 single/batch outage and duplicate claim ACK negative, successful recovery ACK, and unchanged R-03 liveness.
- `tests/phase03-storage-buffer.test.ts`: web-side replay verifies exactly one physically stored row; new direct Port 4000 writer Redis-trim failure/recovery proof. All tests on fake Redis and disposable temp CSV paths.

**Unverified:** Gitea P02 implementation acceptance was unavailable due inaccessible host/connector. Local `npm ci` not confirmed successful. Do not invent a CI run ID or claim full PASS. Full cross-process transactional exactly-once and all Redis claim crash windows are out of proof scope and may require exact additional approval. The streaming dedupe scan changes I/O cost per flush; performance validation before production is required.


### Blocked acceptance evidence — actual tool outcomes

- JS syntax: local `node --check server/index.js` and `node --check server/socket/handlers.js` PASS.
- Source scope: local `git diff --check` PASS; only the five allowed P02 runtime/test paths changed before notes updates.
- Gitea: connection returned `UNAVAILABLE: McpServerError: Connection failed`; Git remote `dev.ivib.cc` unresponsive. No Gitea CI run ID exists for candidate `44eee8877e40d1683f44502c2a0ba3d437a03b88`.
- Local Windows npm: `npm ci` failed `ETARGET yaml@2.9.1` and cleanup `EPERM` in the isolated worktree, **not** a TypeScript/test result. Dependency changes are out of P02 scope.
- Therefore neither TS typecheck nor regression-suite remediation acceptance is established; keep P02 BLOCKED and do not advance P03 or alter any protected runtime/source beyond this approval.


## F. P02 Final Acceptance Patch Index (current source/CI proof)

- Published diagnosis Gitea/GitHub main: `fd57a3518d14bcb8367ce9ab9c3ec306bcfc9898`; previous GitLab main same tracked tree.
- Runtime candidate: `76cd972bdeea9ef07b4b38e9d8b5b5ed3312ca5b`; Gitea [CI #66](https://dev.ivib.cc/vibtools/DataStack/actions/runs/66) **terminal SUCCESS** across node 24/24, strict TS, lint, Next standalone and Windows Node SDK.
- Exact supplemental commit: `bf525f0d4e5e4781de7fddd2f5e7d3d602a80532` (3 changed files: `server/socket/handlers.js`, `tests/phase02-sync.test.ts`, `tests/phase03-storage-buffer.test.ts`). Compared with published diagnosis, final candidate also includes runtime `server/index.js`, `core/data/buffer.ts`, and previously modified tests, all authorized, plus `notes/001–006`.
- **R-01 arithmetic reproduction** before patch: `const marker=-t; const now=t+61000; now-marker > 300000` is true, while `now-t > 300000` is false. `server/socket/handlers.js:142-158` `cleanupMaps` expires old negative marker; `validateSingleEventAsync:293-317` sees retained Redis idempotency claim; `sync_data` returned duplicate success. Final marker is `\u0000failed-persist:<clientId>:<eventId>` with positive timestamp, corrected age check, cleanup after true TTL, clear marker after durable ACK. Mixed batches reject overall positive ACK while a failed claim remains.
- **R-02:** `server/index.js:843-897,1043-1058`, `core/data/buffer.ts:652-711,855-872`: stream-parsed same-day client CSV/CSV.gz replay suppression, then Redis trim. Focused tests inject direct Port4000 LTRIM crash and compressed part2 quoted/multiline replay; malformed matching partition causes safe no-trim, fixture repair recovers. Memory streamed, partition disk-I/O remains proportional; not globally exactly-once.
- **Compat:** Redis-free RAM ACK and old public /health unchanged; other HTTP/Socket auth, SDK and quota routes unaffected.
- Final [Gitea CI #69](https://dev.ivib.cc/vibtools/DataStack/actions/runs/69) dispatched against exact supplemental commit; until terminal result, phase stays pending and no remote publish.


### Final P02 CI #69 failure and exact retry patch

- CI #69: `phase02-sync.test.ts` subtest `stale Redis claim never becomes positive ACK after cleanup window` `ERR_TEST_FAILURE: operation has timed out` after replacing the **global** `Date.now` during Socket.IO ACK. This cannot support a server-failure claim; it was a test harness flaw. Other new replay/compatibility assertions PASS and quality/Windows jobs separately passed.
- Discovered source branch in `server/socket/handlers.js`: `if (volatileDuplicate && processed > 0)` allowed an overall `success:true` response with pending non-durable claim and already-durable duplicate when `processed=0,duplicates>0`. Revised `if (volatileDuplicate)` blocks every mixed response with an uncommitted claim; new test reproduces the exact combination.
- Test no longer overrides Date.now; independent simulated arithmetic proves the original negative-marker expiry mistake; live ACK checks run on real clock. Supplemental commit `acca8be01a31f8d3972564cbaec8fd3117a0b551`; [CI #72](https://dev.ivib.cc/vibtools/DataStack/actions/runs/72) must pass before P02 closure. No modification of package/dependency files, test CI workflow, public API, UI or production.


## G. P02 Final Acceptance — authoritative terminal CI / Scope Lock proof

- Source baseline published diagnosis `fd57a3518d14bcb8367ce9ab9c3ec306bcfc9898`. Fixed runtime candidate `76cd972bdeea9ef07b4b38e9d8b5b5ed3312ca5b`, previous #66 SUCCESS. Final corrected **source/test** SHA `acca8be01a31f8d3972564cbaec8fd3117a0b551` fully verified in [Gitea #72](https://dev.ivib.cc/vibtools/DataStack/actions/runs/72), **terminal COMPLETED SUCCESS**, Node `CI_SUITE_SUMMARY total=24 failed=0`. CI job conclusions: node-regression SUCCESS, quality SUCCESS, windows-compatibility SUCCESS, production-build SUCCESS; python-regression and docker-image-build SKIPPED by narrow dispatch.
- Exact reproducible Redis idempotency bug: old `-Date.now()` failed timestamp ages incorrectly at +61000ms, while 300000ms Redis claim TTL has not elapsed. New `\u0000failed-persist:${claimKey}` positive timestamp marker and corrected TTL comparison isolate the failed claim. Live Socket.IO retries remain negative ACK; no process-wide clock monkeypatch. Mixed all-duplicate batch also rejects pending claim instead of sending global positive ACK.
- CSV fault evidence: `tests/phase03-storage-buffer.test.ts` after CSV append but before Redis LTRIM, direct Port4000 writer, rotated `.csv.gz`, JSON multiline-quoted payload, corrupt matching partition no-trim/recovery all PASS. Test assertions cannot prove a global exactly-once protocol or live throughput cap. Full-partition scan is streaming bounded-memory, but data-size-linear disk I/O.
- Historical #69 failed one test-only global Date.now-induced Socket.IO timeout, **not** a demonstrated runtime regression; corrected #72 PASS. No secret or credential introduction, no production data access.
- Final audit `git diff --check` PASS and source JS syntax checks PASS; exact tracked source diff from diagnosis = 11 allowlisted files (3 runtime + 2 test + 6 notes); no unrelated UI/auth/SDK/public health, DB schema, package metadata, Docker, CI workflow or live deployment.
- Git release gate: final docs-only commits after tested source SHA add **no source/test differences**. Gitea PR #3 squashed into one `[skip ci]` main commit; GitHub/GitLab tracked Git trees must match Gitea before final CLOSED. If GitLab commit SHA differs because of parent history, compare tree SHA not commit SHA. Store exact remote SHAs/trees in phase close operator report; do not invent them before push.

## H. P03 exact audit and terminal evidence — 2026-11-22

Baseline Gitea/GitHub `48fb277079b380fdbf1e58cd2da40afeed0b03ee`; GitLab baseline same tracked tree `41a169eec0c05ce19bc4acc29d7a8cfe1f8dd90d` (317/317 blobs). Final P03 workflow candidate `549d575653b68c29f97e2f78036646f2e2035719`. [Gitea CI #77](https://dev.ivib.cc/vibtools/DataStack/actions/runs/77): overall **FAILURE** because the initial Python-only checkout lacked Node (exit 127), **not** an SDK regression. Its other six jobs terminal **SUCCESS**: Node `CI_SUITE_SUMMARY total=24 failed=0`, strict TS+ESLint, Next standalone build, Windows SDK, Compose + isolated BuildKit ingestion/web/proxy image build `DATASTACK_THREE_IMAGES_BUILD_PASS`, read-only advisory inventory `DATASTACK_SECURITY_TRIAGE_INVENTORY_PASS`. Narrow [Python-only CI #78](https://dev.ivib.cc/vibtools/DataStack/actions/runs/78) terminal **SUCCESS**: Node-capable Bookworm container, Python 3.11 isolated venv, `Ran 14 tests in 3.959s`, `OK`, `DATASTACK_PYTHON_14_OF_14_PASS`. The other six jobs were deliberately skipped in #78.

**Docker evidence:** separate BuildKit `docker-container` builder with owned-builder cleanup, `--no-cache --load`, actual Compose `config --no-interpolate --quiet`, ingestion/web/proxy Dockerfiles *read-only*, three tags inspected; old `@uiw` error absent. **Python evidence:** only Node-capable image change within workflow, Python 3.11 venv with all 14 tests; Python SDK source unchanged.

**CI-08 security disposition:** `npm audit --json` full=26 affected packages (25 moderate, 1 high); runtime=24 (23 moderate, 1 high), **not counts of distinct advisories**. High-severity advisories [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) affect Next 15.5.29's nested `postcss@8.4.31` despite patched root `postcss@8.5.33`; npm recommends major `next@16.4.6`. Direct `cloudcmd@19.24.0` carries moderate transitive issues (`dompurify`, `file-type`, `glob`, `minimatch`, `got`); npm recommends `cloudcmd@17.0.2` downgrade, not a verified safe pin. No speculative package pin, major upgrade or force fix; a separately tested compatible remediation is needed before release.

**Exact allowlist audit:** pre-documentation candidate diff had only two approved workflow files; final publication includes six approved `notes/001–006` updates. Workflow checks: no trailing whitespace, no `docker ... prune`, no `npm audit fix --force`, all 3 Dockerfile paths present, no runtime or dependency lock changes. Check three-remote tracked tree parity before marking phase CLOSED.

**Scope / release decision:** only `.gitea/workflows/datastack-ci.yml`, `.gitea/workflows/datastack-docker-ci.yml`, and `notes/001–006` changed. No `package.json`/lock, Dockerfile, application UI/UX, runtime, auth, SDK, database, Compose, production data, secret, shared Docker prune, deployment, migration, tag or release. P03 technical CI and advisory-triage acceptance verified by #77 non-Python jobs plus #78 Python; do **not** mislabel #77 overall as successful. Final phase publication requires one main commit and Gitea/GitHub/GitLab exact tracked tree parity. **Production release NO-GO** while runtime high advisory is unresolved; live production health, throughput and deployment remain unverified.

## I. P04-S01 approved baseline and source proof — 2026-11-22

Baseline commit `fac0934a00e6c15902738a3ffafb11b5ec2f0ac3`, content tree `12818ba732f5abdc42af46d83278b13b6be4eafd`. P03 CI #77 `AUDIT_COUNTS runtime {moderate:23,high:1,critical:0,total:24}` (affected packages). Lockfile line proof `package-lock.json:10552-10560` Next `15.5.29` pinned nested postcss `8.4.31`; `10602-10603` resolved nested copy `8.4.31`; `11427-11428` root `8.5.33`. Gitea candidate branch `p04-s01-postcss-security-20261122`, no runtime changes. Approved exact write boundaries are only `package.json` scoped PostCSS override, npm-generated lockfile, `.gitea/workflows/datastack-ci.yml` security-audit block and notes/001–006. Acceptance pending.

## P04-S01 blocked security reconciliation report

P04-S01 SEC-01 BLOCKED — 2026-11-22. Approved scoped `overrides.next.postcss=8.5.33` trialed in disposable Windows npm 10.9.8 workspace only. `npm install --package-lock-only` EXIT 0, but `npm ls --package-lock-only postcss --all` EXIT 1 (`ELSPROBLEMS`: Next nested `postcss@8.4.31` invalid; expected 8.5.33); npm dedupe also kept invalid dependency. Read-only `npm audit --omit=dev --json` EXIT 1, runtime high 1/moderate 23/critical 0. Lockfile regeneration caused unrelated churn (91 package entries added, 106 removed, 69 changed, including two lightningcss optional 1.33.0 -> 1.30.1). Fresh minimal Next 15.5.29 fixture with identical override resolves PostCSS 8.5.33, isolating failure to DataStack committed lock graph. `npm ci --dry-run` exit 0 does not prove real clean install. Exact stop rule applied: no dependency patch, no CI acceptance, no main commit, no GitHub/GitLab sync, no release/deploy; production NO-GO. Need separate explicit narrowly scoped lock reconciliation approval.

Baseline tree `12818ba732f5abdc42af46d83278b13b6be4eafd`; npm `audit --omit=dev` includes affected node `node_modules/next/node_modules/postcss` and high GHSAs above. This proof lives in notes, not a change to repository dependencies; no patch is accepted.

## K. P04-S01B reproducible candidate proof / unaccepted patch — 2026-11-22

**Baseline:** Gitea main `fac0934a00e6c15902738a3ffafb11b5ec2f0ac3`, tree `12818ba732f5abdc42af46d83278b13b6be4eafd`. Gitea source path `package-lock.json:10552-10603` includes Next 15.5.29 and nested PostCSS 8.4.31; root PostCSS 8.5.33. Connected Windows npm 10.9.8 temp probe downloads baseline manifest/lock; exact approved exception deletes `node_modules/next/node_modules/postcss` entry **in disposable copy only** and adds manifest `overrides.next.postcss=8.5.33`. `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefer-offline`: exit 0. `npm ls --package-lock-only postcss --all --depth=4`: exit 0; Next uses PostCSS 8.5.33 deduped and no nested 8.4.31. `npm audit --omit=dev --json` exits 1 for remaining **moderates**; counts `{moderate:22,high:0,critical:0,total:22}`; `postcss` no longer appears as vulnerable package. Zero unrelated version changes and exactly 1 removed stale nested package; **67 other package entries changed metadata**: `dev` 36, `libc` 29, 2 `dependencies` JSON order differences (field frequencies can overlap). Must preserve unrelated version AND metadata per user's approval. **STOP**: candidate not committed to repo; no real clean npm ci, no Gitea CI acceptance or workflow gate change, no main merge or 3-mirror sync. P04-S01B remains BLOCKED, released baseline still vulnerable/high=1 and production NO-GO. A future separate exact approved strategy for metadata preservation or bounded exceptions is necessary.

## L. P04-S01C candidate exact patch, CI and scope proof — 2026-11-22

- Baseline: Gitea main `fac0934a00e6c15902738a3ffafb11b5ec2f0ac3`, tree `12818ba732f5abdc42af46d83278b13b6be4eafd`; P04 notes branch `p04-s01-postcss-security-20261122`. Approved patch commit `c759be990c032c2474d2d0bad519c643dec11a3a`. PR [#5](https://dev.ivib.cc/vibtools/DataStack/pulls/5) draft pending full acceptance.
- Exact patch diff from Gitea source commit: `package.json` append only `overrides.next.postcss = 8.5.33`; `package-lock.json` delete only 26 lines for `node_modules/next/node_modules/postcss@8.4.31`; `.gitea/workflows/datastack-ci.yml:security-audit` insert 10-line runtime high/critical failure/verification gate. No changes outside 3 source/config files plus notes/001–006.
- **Generated lock preservation proof:** remove stale entry in disposable npm lock copy; regenerate using npm 10.9.8; restore 67 unrelated metadata entries byte-exactly to baseline. Structural comparison final versus baseline `added=0 removed=1 changedExistingEntries=0`; all unrelated versions, resolved URLs, integrity hashes and dependency metadata identical. `npm ls --package-lock-only postcss --all --depth=4` exit 0, Next 15.5.29 resolves root PostCSS 8.5.33. Final lockfile SHA-256 `e6b5b362877627085dc04c9ded03c019971e07ef9f4af1e78057d58961a1c091`; downloaded Gitea branch lock bytes match. Linux Gitea runner actual `npm ci` SUCCESS, followed by 24 suites. Connected Windows scratch `npm ci` completion not independently verified; Windows Gitea job outstanding.
- Gitea CI [#85](https://dev.ivib.cc/vibtools/DataStack/actions/runs/85) on source commit `c759be99`: node-regression 24/24 + SDK SUCCESS; Python 14/14 SUCCESS; quality strict TS/ESLint SUCCESS; Next 22/22 static pages + standalone SUCCESS; isolated BuildKit 3-image build SUCCESS; security-audit SUCCESS `AUDIT_COUNTS full {moderate:24,high:0,critical:0}`, `AUDIT_COUNTS runtime {moderate:22,high:0,critical:0}`, `DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO`, `DATASTACK_SECURITY_TRIAGE_INVENTORY_PASS`. Windows-compatibility QUEUED at checkpoint: no full terminal acceptance yet. No main or mirror changes, no deployment, migration, shared Docker prune, tag or release. Production NO-GO pending 7/7 and remote parity, moderate advisories/live verification.

## P04-S01C FINAL CI acceptance (7/7) — 2026-11-22

Gitea CI #85 https://dev.ivib.cc/vibtools/DataStack/actions/runs/85 COMPLETED/SUCCESS; tested implementation SHA c759be990c032c2474d2d0bad519c643dec11a3a; later changes to candidate are documentation only. All seven jobs terminal SUCCESS: node-regression (Linux committed-lock npm ci and exactly 24/24 TypeScript suites); python-regression (Ran 14 tests, OK); quality (strict tsc and ESLint); production-build (Next 15.5.29 standalone, 22/22 pages); docker-image-build (three isolated BuildKit ingestion/web/proxy images); windows-compatibility (Windows committed-lock npm ci and Node SDK build, job #182, terminal SUCCESS); security-audit (runtime moderate=22 high=0 critical=0; full moderate=24 high=0 critical=0; DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO). Single Gitea acceptance run used, no additional broad reruns.

Scope: exactly nine approved paths: package.json scoped next->postcss 8.5.33 override; package-lock.json removes only old nested postcss@8.4.31 entry; existing .gitea/workflows/datastack-ci.yml security-audit job high/critical rejection; notes/001–006 evidence. Other package metadata, versions, integrity and resolved URLs match baseline. Next.js 15.5.29 and Cloudcmd 19.24.0 preserved. Final candidate package-lock SHA256 e6b5b362877627085dc04c9ded03c019971e07ef9f4af1e78057d58961a1c091 (verified byte-for-byte with Gitea). No API, auth, SDK, UI, application runtime, database, Compose, Dockerfile, tests or production data changes, deployment, migration, prune, tag, release.

Exact job IDs: 177 Node, 178 Python, 179 quality, 180 Next production, 181 Docker three images, 182 Windows compatibility, 183 security-audit; all seven completed/success, run #85 overall completed/success. CI fully accepted; publication not yet asserted in these pre-merge notes. Final phase CLOSED requires one squash merge of PR #5 into Gitea main and verified identical tracked content across Gitea/GitHub/GitLab; record actual new SHAs in terminal report. Production release remains NO-GO pending P04-S02 moderate vulnerability triage and separately authorized live readiness verification.

## P04-S02 scoped candidate — 2026-11-22

Baseline Gitea main `2d467ff1494858164a37814f7dbc2b321f510291`, tree `648c76ca496d2c9bf22a16f558c9ba347a45d4f7`. Cloudcmd 19.24.0 -> deepword 11.0.1 -> monaco-editor 0.55.1 pins DOMPurify 3.2.7, vulnerable according to npm advisory inventory. Disposable Windows npm 10.9.8 `npm view dompurify@3.4.18` verified, scoped npm override `overrides.cloudcmd.dompurify=3.4.18` resolves `dompurify@3.4.18` via `npm ls --package-lock-only dompurify --all --depth=5` (exit 0). `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefer-offline` exit 0. npm graph initially changed 67 unrelated metadata entries; deterministically restored exact baseline values after validating unrelated versions, URLs, integrity and dependencies. Final lock has **one changed package entry**, DOMPurify; same-major replacement plus verified registry `resolved` and `integrity`, no other packages added/deleted/changed. Candidate runtime audit affected-package counts **moderate 20/high 0/critical 0** versus baseline **22/0/0**; full candidate **moderate 22/high 0/critical 0** versus baseline **24/0/0**. DOMPurify and Monaco Editor dropped from vulnerable-package inventory. Other moderate packages (got, glob, minimatch, nested file-type, Cloudcmd transitive chain) remain; they require major package changes under current advisory constraints, prohibited by Scope Lock. This is a **pre-acceptance candidate**: do not claim application compatibility, CI PASS, publication, or phase CLOSED before full focused Gitea CI and exact three-remote tree parity.

Patch provenance: npm registry DOMPurify 3.4.18 tarball URL and integrity SHA512 in npm-generated entry, unchanged other package metadata after deterministic baseline restoration. New graph root overrides change only Cloudcmd-specific DOMPurify. One focused acceptance run pending.

## P04-S02 final CI acceptance — 2026-11-22

Gitea CI #92 (https://dev.ivib.cc/vibtools/DataStack/actions/runs/92) **COMPLETED / SUCCESS**, all 7/7 jobs terminal success on source commit `a88bc5f4498ea1b11acc0acfeb66b5aa9d6531be`: node-regression real Linux npm ci + 24/24 tests including `tests/files-manager.test.ts` exit 0; Python SDK 14/14; quality strict TypeScript/ESLint; Next.js standalone (22/22 static pages); isolated Docker/BuildKit 3-image verification `DATASTACK_THREE_IMAGES_BUILD_PASS`; Windows committed-lock npm ci + Node SDK compatibility; security-audit `DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO` and `DATASTACK_SECURITY_TRIAGE_INVENTORY_PASS`. Audit full=22 moderate/high=0/critical=0 (baseline 24), runtime=20 moderate/high=0/critical=0 (baseline 22). These are affected package entries, not distinct advisories. No new CI workflow or extra broad CI dispatched.

Exact approved patch: `package.json` scoped `overrides.cloudcmd.dompurify=3.4.18`, preserving `overrides.next.postcss=8.5.33`; npm-generated `package-lock.json` changes solely `node_modules/dompurify` version 3.2.7 -> 3.4.18 and verified `resolved`/SHA512 integrity. Baseline Cloudcmd 19.24.0, Monaco Editor 0.55.1, Next.js 15.5.29, all unrelated locked package versions, URL, hash, dependency and metadata preserved. Gitea published candidate lock bytes match disposable SHA-256 `57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854`. Exact candidate tree diff 420 entries, 8 approved changed files only (`package.json`, `package-lock.json`, notes/001–006), 0 unauthorized paths. No runtime/UI/auth/API/SDK/tests/CI/Dockerfiles/Compose/db/schema/data modifications.

Detailed proof: final DOMPurify npm registry URL `https://registry.npmjs.org/dompurify/-/dompurify-3.4.18.tgz` with integrity `sha512-ofe3wI/uNm68HInABYFJYqQxRw1EaKAjNdrFVKqjUY+UZurvNd2L/HuQe097s/4RivWiZyP6tT7aoT8atjfhwg==`. Confirmed isolated npm ls override Cloudcmd -> Deepword -> Monaco Editor -> DOMPurify 3.4.18, isolated npm audit runtime 20/0/0 and full 22/0/0, Gitea acceptance matches. **Residual risk:** 20 moderate runtime affected package entries remain, including Cloudcmd transitive dependencies `got`, `glob`, `minimatch`, nested `file-type` and their parent chains. Current npm audit suggests `cloudcmd@17.0.2` (a major downgrade), explicitly out-of-scope; other transitive fixes need major-version dependency-contract changes. No force/downgrade/unverified override. Security improvement verified but NOT zero vulnerabilities. Production release stays NO-GO; remaining advisory disposition and live readiness need independent scope approval.

**Merge gate:** CI #92 7/7 PASS, approved 8-file patch integrity PASS; main squash merge and Gitea/GitHub/GitLab exact Git content-tree verification required before P04-S02 CLOSED. This note is written before that publication, so final remote commit SHAs shall be appended to the PR closure report after verification. No deployment, migrations, prune, tag, release.

## P04-S03 — Exact advisory/registry/lockfile provenance (2026-11-23)

Gitea main a9ad7700638bea5a7a815c6582721ba517744087, tree 1a0790d0d5922a2df5d529d60a1f106651a3654f. P04-S02 remains accepted (CI #92 7/7 PASS); all approved Cloudcmd 19.24.0, Next 15.5.29, PostCSS 8.5.33 and DOMPurify 3.4.18 locks preserved. Windows disposable npm 10.9.8/Node 22.23.2 inspection downloaded the exact Gitea package.json/package-lock.json; original lock SHA-256 57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854. `npm ls --package-lock-only cloudcmd got glob minimatch file-type dompurify --all --depth=5` exit 0. Fresh `npm audit --omit=dev --json` reports runtime moderate=20/high=0/critical=0, full `npm audit --json` moderate=22/high=0/critical=0; npm audit exit 1 because existing moderates, not a tool failure. Counts are affected package nodes, not distinct advisories.

Four direct npm audit advisories explain inherited runtime findings: got `GHSA-pfrx-2q88-qq97` (<11.8.5, first patched 11.8.5), glob `GHSA-3g3m-2fjr-6pw4` (>=9 <=14.0.1, patched 14.0.2), minimatch `GHSA-g3hv-75wg-m249` (>=7 <11.0.1, patched 11.0.1), file-type `GHSA-5v7r-6r5c-r473` (>=13 <21.3.1, patched 21.3.1). Registry confirmed availability of got@11.8.5, glob@14.0.2, minimatch@11.0.1; file-type@21.3.4 is already present as a patched root copy, while its two nested vulnerable copies are 16.5.4. Specific constrained parents: @cloudcmd/dropbox@5.0.3 -> dropbox-stream@3.2.0 -> got `^10.6.0` (locked 10.7.0); console-io@15.0.4 -> spawnify@8.0.1 -> glob `^10.3.3` (locked 10.5.0) -> minimatch `^9.0.4` (locked 9.0.9); inly@5.0.1 -> glob `^10.3.10` and onezip@6.1.1 -> glob `^10.3.10`; Cloudcmd -> onezip@7.0.3 -> glob `^13.0.6` (locked 13.0.7) -> minimatch `^10.2.2` (locked 10.2.6); dword/edward -> join-io@5.0.0 -> ponse@6.0.0 -> file-type `^16.2.0` (locked 16.5.4); restbox@4.0.1 -> ponse@7.0.0 -> file-type `^16.2.0` (locked 16.5.4). Patch version for each lies outside its parent semver major; no compliant same-major security upgrade exists for these vulnerable leaves. npm suggests Cloudcmd 17.0.2 downgrade, specifically forbidden. No forced override was attempted since each candidate violates approved compatibility boundary.

**Reproduction commands (disposable Windows):** `npm ls --package-lock-only cloudcmd got glob minimatch file-type dompurify --all --depth=5` exit=0; `npm audit --omit=dev --json` exit=1 with 20 moderate, 0 high, 0 critical; `npm audit --json` exit=1 with 22 moderate, 0 high, 0 critical; registry `npm view got@11.8.5 version`, `npm view glob@14.0.2 version`, `npm view minimatch@11.0.1 version` all resolved. GHSA advisory reference links: https://github.com/advisories/GHSA-pfrx-2q88-qq97, https://github.com/advisories/GHSA-3g3m-2fjr-6pw4, https://github.com/advisories/GHSA-g3hv-75wg-m249, https://github.com/advisories/GHSA-5v7r-6r5c-r473. Registry `file-type@21.3.4` confirms root is already patched; nested `file-type@16.5.4` is incompatible with allowed same-major upgrade.

**STOP RULE:** **P04-S03 disposition: FORENSIC REVIEW COMPLETE / TARGETED REMEDIATION BLOCKED BY APPROVED SCOPE.** No package.json, package-lock.json, runtime, UI, File Manager, Monaco Editor, tests, SDK, CI, Dockerfile, Compose, database, secrets or production file edits. No npm install or `npm ci` required for unmodified baseline, no extra Gitea CI dispatched: accepted unchanged baseline retains Gitea CI #92 7/7 including real Linux/Windows npm ci, File Manager regression, SDKs and 3 Docker images. No claim of newly fixed advisories or zero Moderate. Only notes/001–006 publication is permitted; no dependency patch, tag, release, deployment, migration, prune or live change. Production remains NO-GO, pending separately approved parent dependency migration with full compatibility acceptance or a formal risk-disposition decision.

**Change audit:** notes/001–006 only. All dependency and program Git blobs must remain byte-exact baseline. No new CI because no dependency changes to test; no false PASS/fix claim.

