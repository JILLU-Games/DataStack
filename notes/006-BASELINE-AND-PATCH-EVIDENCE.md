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

## P04-S04 — Baseline and exact evidence (2026-11-23)

Approved baseline Gitea main 986ac1fcb2cced4cb5b330429084b9206f84a791, tracked tree 118fae01fb48c9435907aa5b696e78eba3cc8d36 (420 entries). Disposable Windows Node 22.23.2/npm 10.9.8 copied byte-exact published package.json/package-lock.json; lock SHA-256 57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854. Live registry.npmjs.org upstream metadata inspected 17 parent package names (all fetches passed) and 17 parent/dependency constraint assertions exit 0.

Four direct npm audit GHSA roots remain: got GHSA-pfrx-2q88-qq97 (patched >=11.8.5), glob GHSA-3g3m-2fjr-6pw4 (patched >=14.0.2), minimatch GHSA-g3hv-75wg-m249 (patched >=11.0.1), file-type GHSA-5v7r-6r5c-r473 (patched >=21.3.1). Latest supported upstream parent metadata: @cloudcmd/dropbox 5.0.3 -> dropbox-stream ^3, dropbox-stream 3.2.0 -> got ^10.6.0; console-io 15.0.4 -> spawnify ^8, spawnify 8.0.1 -> glob ^10.3.3; inly 5.0.1 -> glob ^10.3.10/onezip ^6, onezip 6.1.1 -> glob ^10.3.10, onezip 7.0.3 -> glob ^13.0.6; glob 10.5.0 -> minimatch ^9.0.4, glob 13.0.7 -> minimatch ^10.2.2; join-io 5.0.0 -> ponse ^6, restbox 4.0.1 -> ponse ^7, ponse 6.0.0 and 7.0.0 -> file-type ^16.2.0. Root file-type 21.3.4 already patched; nested file-type 16.5.4 remains. Latest @cloudcmd/fileop 9.1.1 still pins inly ^5 and onezip ^7: no advisory improvement. Cloudcmd latest 19.24.0 unchanged. Latest glob 14.0.6 uses minimatch ^11.0.5, incompatible with existing parent ranges. None of these latest parent releases supports a patched leaf major.

Current fresh npm audit --omit=dev --json: runtime affected package entries moderate=20, high=0, critical=0; npm audit --json: full moderate=22, high=0, critical=0. Both audit commands exit 1 due documented moderate advisories, not audit parser errors. Baseline audited lock SHA-256 unchanged; no dependency patch or npm installation. Historical unchanged-code Gitea CI #92 remains 7/7 SUCCESS (not a new P04-S04 CI).

Provenance: isolated temp directory DataStack-P04-S04-20261123, Git source SHA 986ac1fcb2cced4cb5b330429084b9206f84a791; npm registry packuments sampled as of 2026-11-23. Four advisory links https://github.com/advisories/GHSA-pfrx-2q88-qq97 ; https://github.com/advisories/GHSA-3g3m-2fjr-6pw4 ; https://github.com/advisories/GHSA-g3hv-75wg-m249 ; https://github.com/advisories/GHSA-5v7r-6r5c-r473 . Newer @cloudcmd/fileop 9.1.1 is not a security candidate because dependency ranges remain unchanged.

P04-S04: FORENSIC DISPOSITION COMPLETE, COMPATIBLE SECURITY REMEDIATION BLOCKED by approved Scope Lock. Parent-documented support is mandatory before major transitive upgrade; upstream has no supporting releases. No unsupported leaf overrides, forced npm audit fix, Cloudcmd downgrade, UI/feature/API/auth/SDK/test/CI/Docker/Compose/DB/production changes. Exact publication is notes/001-006 ONLY; package manifest, lock and runtime byte-exact baseline. No new broad CI because no candidate. No deployment, migration, shared prune, tag or release. Production NO-GO. Do not mark four advisories resolved or claim zero moderate. Any parent patch/fork, compatibility adapter, or operational risk acceptance requires separate exact user approval.

## P04-S05 — Evidence and source references (2026-11-23)

Baseline Gitea main f1e04f0689374f401d2f6fd1f97dbc010e2a5015, tracked tree ceb44222e85f3aa64c3e8fcfca1d335cc4a9c6b3, 420 entries. Existing P04-S04 forensic PR #8 records Cloudcmd 19.24.0 and vulnerability constraints. P04-S05 is STATIC SOURCE / UPSTREAM PACKAGE / ADVISORY review only. Runtime affected packages: moderate=20, high=0, critical=0; full audit: moderate=22, high=0, critical=0 (last verified unchanged dependency graph). No live deployment, traffic, runtime exploitation or production session inspection. Source read-only; inherited accepted CI #92 is historical, not new P04-S05 test evidence.

DataStack source-level facts: server/index.js:2530-2538 mounts Cloudcmd File Manager on ingestion port 4000; server/filesManager.js:975-1075 mounts securityGuard first, then Cloudcmd middleware at /vcon/files-engine. server/filesManager.js:664-704 locks root, sets terminal:false, console:false, dropbox:false, packer:zip, zip:true, editor:edward, disabled import/export and config UI. HTTP middleware 711-851 validates admin session, CSRF for unsafe methods, viewer-write denial, path traversal and *.lock; PUT JSON mutation body limit 512KiB at 767-800, NOT a general upload size limit. Socket namespaces 854-973 independently gate session/write/editor events. docker/coolify-nginx.conf:60-73 forwards /vcon/files-engine to ingestion; Docker Compose exposes 4000 internally (source config, NOT verified live firewall). UI components/sections/FilesManagerWorkspace.tsx:24-26,123-133,196-204 show iframe, browsing, editing, upload/download and ZIP/UNZIP. Existing tests/files-manager.test.ts:66-278 exercise auth 401, viewer 403, CSRF, path lockdown, PUT CRUD/rename, ZIP/UNZIP and GET download on an ephemeral localhost server; NOT hostile payload/fuzz or a deployed validation.

Upstream package-source inspection (registry tarball sources, disposable only): cloudcmd@19.24.0 server/cloudcmd.js:211-287 calls config('console') && konsole, config('terminal') && terminal and config('dropbox') && restbox, confirming those integrations are gated under the DataStack configured false values; restafary/HTTP File Manager and editors remain mounted. dropbox-stream@3.2.0 api.js:91 invokes got.stream.post when its Dropbox API function runs; no DataStack-enabled Dropbox call established. spawnify@8.0.1 lib/spawnify.js imports glob, but console disabled; onezip@7.0.3 bin/onezip.js:73 and inly@5.0.1 bin/inly.js:46 use glob in inspected CLI entrypoints, not proof that their library runtime calls have the same glob invocation. Nested ponse@6.0.0/7.0.0 lib/ponse.js:221 calls filetype.fromFile during sendFile(); restbox@4.0.1 uses ponse helpers but Dropbox route conditional; join-io@5.0.0 inspected join.js invokes ponse.getPathName/setHeader/sendError, not sendFile. Cloudcmd main ponse@8.0.2 uses already patched root file-type@21.3.4. No end-to-end DataStack HTTP handler -> vulnerable nested file-type parser demonstrated. Avoid asserting unreachable; dynamic imports, alternate paths, and actual deployed settings remain unverified.

### Advisory-specific risk matrix
- got / GHSA-pfrx-2q88-qq97: malicious response redirect to Unix socket; ancestor @cloudcmd/dropbox -> dropbox-stream@3.2.0 -> got@10.7.0. Dropbox false and route gated; currently no direct invocation proven; risk conditional if integration reenabled, actual run-time policy differs or an alternate path invokes it. No vulnerability fixed.
- glob / GHSA-3g3m-2fjr-6pw4: aborted async walk may continue filesystem traversal after abort; installed via spawnify/inly/onezip parent chains. Need actual vulnerable glob() with AbortSignal; no such invocation found in inspected DataStack route source and sampled upstream library entrypoints. Conditional/unverified, not classified zero exposure.
- minimatch / GHSA-g3hv-75wg-m249: attacker-controlled glob pattern together with optimizationLevel >=2 can amplify processing; installed via glob 10/13. No attacker-supplied glob pattern or optimizationLevel=2 reached in inspected DataStack handlers; conditional/unverified without dynamic path tracing.
- file-type / GHSA-5v7r-6r5c-r473: crafted ASF/WMV/WMA input causes event-loop infinite-loop in affected parser; nested file-type@16.5.4 via ponse@6/7. Upstream ponse.sendFile() calls filetype.fromFile() but its DataStack-mounted invocation not established; Cloudcmd core ponse@8 is patched file-type@21.3.4. Authentication & root restrictions reduce accessible sources but do not guarantee malicious content is impossible. Potential high availability impact if nested vulnerable sendFile invoked on untrusted data. No live exploit test performed.

Risk treatment (PROPOSED, NOT APPLIED): preserve existing disabled Dropbox/terminal/console, mandatory auth and viewer RBAC; inspect effective live config and public exposure only with separately approved READ-ONLY live access. Prefer upstream-compatible backports to got 10, glob 10/13, minimatch 9/10, file-type 16 or maintained vetted forks with identical public API; require independent security review and clean npm lock integrity before approval. For possible file-type parsing DoS, consider a narrowly scoped input/media validation or worker isolation with hard time limit, but any runtime implementation requires separate user permission, tests, and explicit feature-preservation contract. For glob and minimatch investigate exact dynamic patterns/AbortSignal use without feeding hostile payload to production; for got confirm configured Dropbox routes and egress at live edge. Request upstream fixes from maintainers (outside this repo) only when authorized. Existing role/path guards are defense-in-depth, not formal risk acceptance.

Evidence/reference URLs and source paths: https://github.com/advisories/GHSA-pfrx-2q88-qq97 (UNIX socket redirect); https://github.com/advisories/GHSA-3g3m-2fjr-6pw4 (post-abort FS traversal); https://github.com/advisories/GHSA-g3hv-75wg-m249 (attacker-controlled minimatch optimizationLevel >=2); https://github.com/advisories/GHSA-5v7r-6r5c-r473 (crafted ASF subheader size zero). DataStack files: server/filesManager.js:664-704,711-851,854-973,975-1075; server/index.js:2530-2538; tests/files-manager.test.ts:66-278; docker/coolify-nginx.conf:60-73; components/sections/FilesManagerWorkspace.tsx:24-26,123-133,196-204. Upstream checked registry tarballs Cloudcmd19.24.0/ponse6+7/dropbox-stream3.2.0/inly5.0.1/onezip7.0.3/spawnify8.0.1/restbox4.0.1/join-io5.0.0. Exact engine invocation of malicious input or live deployment remains UNVERIFIED; no crafted payload run.

P04-S05 STATIC FORENSIC/RISK ASSESSMENT COMPLETE, EXPLOITABILITY NOT PROVEN AND REMEDIATION NOT IMPLEMENTED. No feature, runtime, UI, auth, API, SDK, dependency, lockfile, test, CI, Docker/Compose, secrets, DB or production edit permitted. Only six approved notes may be changed. No fresh broad Gitea CI because source/lock never changes. 20 affected Moderate runtime nodes persist and cannot be declared safe/unreachable based on static evidence; release remains NO-GO. A future narrowly approved risk-treatment patch phase must specify exact file-level exception(s), unchanged feature contracts, isolated adversarial smoke tests and CI acceptance; the alternative is a separately approved monitored risk-acceptance decision. Neither is silently authorized.

## P04-S06 — Exact experiment provenance / audit evidence (2026-11-23)

Approved baseline main 79fae037c5920514062c6fbbb3d7eb8133f6449d, 420-entry tree 6aad5a613822c8b119cd558778b7cb7372b4b248. Approved dependency versions unchanged: Cloudcmd 19.24.0, Next 15.5.29, PostCSS 8.5.33, DOMPurify 3.4.18. P04-S05 PR #9 static risk findings respected. Four known direct advisories: got GHSA-pfrx-2q88-qq97, glob GHSA-3g3m-2fjr-6pw4, minimatch GHSA-g3hv-75wg-m249, file-type GHSA-5v7r-6r5c-r473.

Isolation: two authorized disposable Windows sessions used after first execution connector became unavailable. The completed controlled run used temp-cloned Gitea baseline with native Windows Node 26.12.0/npm 11.20.0 and a separately installed Node 22.23.5 runtime via npm exec (no source edits). Clean committed-lock npm ci installed 1,278 packages (exit 0), npm ls cloudcmd/got/glob/minimatch/file-type integrity exit 0; git status remained clean. Baseline lock SHA256 AAA2147F736B33F02109E2FECA2209DC17E1016882B2948A0E16AA2344B4D020. Fresh npm audit runtime: 20 affected Moderate package entries/0 High/0 Critical; full: 22 Moderate/0 High/0 Critical, audit exit 1 due existing Moderate findings.

Dynamic test: external disposable CommonJS Module._load instrumentation logged project-root LOAD events for got (via dropbox-stream/api.js), glob (via spawnify/lib/spawnify.js), minimatch (via glob's CommonJS modules), and nested file-type (via restbox/node_modules/ponse and join-io/node_modules/ponse). Feature-disabled Dropbox can still cause its library to LOAD; LOAD is NOT function invocation or reachable exploit. No corresponding monitored vulnerable CALL events recorded before test stopped, and ESM/dynamically imported functions are outside this CommonJS hook's complete coverage. Tracer was NOT committed to the repo, only temporary tooling. Module-load evidence is not end-to-end proof of exploitability or safety.

Focused existing tests/files-manager.test.ts on Windows: native Node 26.12.0 instrumented result 3/4 PASS, 1 FAIL; supported Node 22.23.5 instrumented result 3/4 PASS, 1 FAIL; Node 22.23.5 without instrumentation ALSO 3/4 PASS, 1 FAIL. Identical first failing assertion tests/files-manager.test.ts:154: authenticated PUT /vcon/files-engine/api/v1/fs/client-alpha/note.csv returned HTTP 404, expected 200. GET status/HTML and preliminary checks passed, but full CRUD/ZIP/UNZIP dynamic operations after that point were NOT exercised. Uninstrumented repro rules out tracer as sole cause; Windows-specific reason or environment/proxy path root cause NOT established. Historical Gitea CI #92 Linux File Manager PASS remains prior evidence only, not new P04-S06 acceptance.

Exact proof artifacts (kept only in authorized disposable TEMP, not committed): Windows Node22 instrumented test output SHA256 06A2C47FD72BD694D688471886773CD606333BC19AD20ECCD3AA47A352107406; Node22 uninstrumented test SHA256 1455B0985170EFAA8243333455307B519F71F3593053648422FA022138236F7B; Node22 trace JSONL SHA256 190419547599F09E5A623F280D151D8A8AF45D11E1415CB7A95DC4E6F393CCEB. Raw trace contains only watched CJS module names/locations, not input payloads. Native Node26 instrumented test log SHA256 E57F4898B05515F0311BFA2AEA9570AA8E1A4BA1DB266C4BE2632E8945A69A3C. Gitea CI #92 https://dev.ivib.cc/vibtools/DataStack/actions/runs/92 is unchanged historical Linux evidence. Advisory URLs https://github.com/advisories/GHSA-pfrx-2q88-qq97 ; https://github.com/advisories/GHSA-3g3m-2fjr-6pw4 ; https://github.com/advisories/GHSA-g3hv-75wg-m249 ; https://github.com/advisories/GHSA-5v7r-6r5c-r473 . No Gitea CI dispatched for this notes-only phase.

P04-S06 forensic reachability/disposition COMPLETE but compatible security remediation BLOCKED: P04-S04's latest upstream parent contracts do not accept patched leaf majors, and no publisher-authenticated, vetted, API-compatible older-major backport with exact published integrity and verified regression evidence was established. No unverified override, package or lock patch, npm audit fix --force, app/SDK/test/CI/Docker/Compose/UI/DB/prod change. No new broad Gitea CI because no approved dependency candidate. Only approved notes/001–006 may be committed and mirrored; no deployment, migration, prune, tag, release. Production remains NO-GO; 20 runtime Moderate package entries unresolved. Do not claim full dynamic reachability verification, File Manager compatibility PASS, fixed advisories, or zero exposure.

## WF-01 — Gitea-first / PC backup-only (2026-11-23; candidate, CI pending)

Approved baseline Gitea `d9d1c2f4b2b102599c687090ea56345d58e00d14`, tracked Git tree `98a7e07b1cbc8b6669ffc728b3d68a87f602bfa4` (420 entries); previous P04-S06 PR #10 closed, last accepted CI #92 7/7 PASS on earlier P04-S02 source. Exact WF-01 write allowlist: `.gitea/workflows/datastack-ci.yml`, `notes/002-PRODUCTION-UPDATE-ROADMAP.md`, `notes/003-PHASE-STATUS-LOG.md`, `notes/006-BASELINE-AND-PATCH-EVIDENCE.md`; all other tracked paths read-only. No P04-S07 application defect fix authorized in WF-01.

Runner read-only preflight: Gitea CI #92 logged `coolify-linux-runner` on `ubuntu-latest` and `windows-rdp-runner` on `windows-latest`. An independent remote inventory found online RDP host `WIN-IK7N6SD2UBU`, `C:\gitea-runner\act_runner.exe` and running `act_runner.exe` (PID 6708), matching prior verified dedicated Windows runner identification rather than the user's personal PC. No runner config, service, label or location modified. Linux production-host isolation / Docker socket remains a separately documented operational risk; no cleanup or destructive daemon operation authorized.

CI trigger design: retain manual `workflow_dispatch` and existing main-workflow-file push trigger; add `pull_request_target` for opened/reopened/synchronize targeting main with notes-only/Markdown-only filtering. The workflow is read from the trusted base branch; every heavy job is fail-closed unless `head.repo.full_name == github.repository` and PR base is main. Fork PR code is never checked out or executed on self-hosted runners by this workflow. Same-repo PR jobs explicitly checkout their head SHA with `persist-credentials: false`; GITEA_TOKEN permission reduced to `contents: read`. This is a trusted internal PR/candidate acceptance gate, not an authorization to execute arbitrary untrusted forks. Docs-only changes are manual review without redundant broad CI. No changes to the seven job scripts or existing tests/build behavior.

Gitea API version reported `28.4.0` during preflight. `main` branch unprotected at baseline; branch protection is proposed only, not applied: require verified full CI and human approval before merge, disable unreviewed direct main writes after separately approved protection configuration. Existing unmerged WIP P02 PR #4 must not be merged. Personal PC stays fetch/pull backup-only; no local npm, Python, tests, Docker, builds, resets, cleans or packages.

Candidate state: no acceptance PASS or mirror sync claimed yet. Next gate: one focused Gitea workflow dispatch on this exact candidate after remote runner safety confirmation, inspect terminal seven-job result and exact four-path patch, then squash once into Gitea main with `[skip ci]` to avoid duplicate full-CI trigger, sync GitHub/GitLab and compare 420 tracked objects. If acceptance fails or remote isolation becomes uncertain, STOP without main merge. Production NO-GO: Windows File Manager PUT 404, 20 runtime Moderate dependency entries and live acceptance remain unresolved.

## FINAL-FIX-01 — consolidated Windows FM fix + residual dependency security disposition (candidate)

WF-01 prerequisite CLOSED: Gitea PR #11 merged, Gitea CI #107 terminal 7/7 PASS; frozen Gitea main `1e2cd31aefc5cd8425e44624a96095d40c917223`, Git tree `e2957792d719eef3f61b49539ed749ac25be5cf9`; verified Gitea/GitHub/GitLab exact 420/420 objects (0 mismatch). This phase's source boundary is `server/filesManager.js` mount/router Windows root only, `tests/files-manager.test.ts`, `.gitea/workflows/datastack-ci.yml` Windows compatibility job, and these three notes. package.json/package-lock.json and all ingestion/Redis/SDK/runtime/Compose files are untouched because no separate reproduced regression or vetted compatible package remedy exists.

Reproduction on verified dedicated Windows Actions host `WIN-IK7N6SD2UBU` (not personal PC), isolated new TEMP clone at exact baseline. `npm ci --no-audit --no-fund` exit 0, 1,278 packages. Native Windows Node 26.12.0 focused tests/files-manager.test.ts: 3/4 PASS, 1 FAIL at :154 HTTP PUT returned 404. Independent disposable request-response instrumentation captured HTTP 404 body ENOENT from mkdir attempting `C:\<checkout>\C:\<temporary-root>\client-alpha`, so this is not auth, prefix, or proxy status. Source-grounded upstream `restafary@13` `server/handle-dot-dir.js` incorrectly handles Windows drive-absolute `root` by joining it to CWD when it does not start with `/`; `redzip` downstream mkdir fails. Root cause reproduced without tracing or production data.

Scoped workaround in `mountFilesManager`: Windows only, convert embedded Cloudcmd config root into explicit cwd-relative path on the same drive; retain securityGuard's and exported storage absolute root. For different-volume roots, fail closed at Cloudcmd initialization with existing 503 unavailable response; no guessed cross-volume bypass. `buildCloudCmdConfig`, Linux behavior, API paths, UI, auth/CSRF, lockfile and other features unchanged. Exact external disposable patch verified native Windows full File Manager suite 4/4 PASS, 0 FAIL including authenticated CRUD/rename/ZIP/UNZIP/download/delete, viewer RBAC, CSRF, lockfile, traversal and config-lock checks. Linux regression and CI candidate acceptance are not claimed yet. Add focused native Windows execution to existing Gitea Windows job; other CI jobs remain unchanged.

Security STOP boundary: original audited runtime 20 Moderate affected packages (0 High, 0 Critical), full 22 Moderate (0 High, 0 Critical), including Cloudcmd got/glob/minimatch/nested file-type. The prior P04-S06 publisher/authenticity and older-major compatibility investigation did not establish an acceptable backport. Newly reviewed upstream Cloudcmd v19.24.1 changes only `@cloudcmd/fileop` dependency declaration vs v19.24.0, not proof of remediation for these four chains. No unverified upgrade, incompatible override, arbitrary fork, package or lockfile change; dependency remediation remains BLOCKED. Under approved stop rule, FINAL-ACCEPTANCE-02 and production readiness must NOT be claimed until an independently vetted compatible security remedy or explicit approved risk disposition exists.

Candidate CLOSEOUT ACCEPTANCE at tested source SHA `36a1c5bf01cf240cac1493eb956112368aea7d62`: Gitea CI #113 completed SUCCESS with all 7/7 jobs (node-regression, python-regression, quality, production-build, docker-image-build, windows-compatibility, security-audit); Node 24/24 suites, Linux Python 14/14, TypeScript/ESLint, Next production build, Docker Compose validation and all 3 images PASS; native Windows File Manager authenticated CRUD/ZIP/security 4/4 PASS. Independent Gitea Windows ESLint CI #119 terminal SUCCESS and Windows Python SDK CI #120 terminal SUCCESS (14/14). Exact commit SHA matched all runs. Final six-file diff tree audit: `server/filesManager.js`, `tests/files-manager.test.ts`, `.gitea/workflows/datastack-ci.yml`, and these three notes; ZERO unauthorized changes; 420 tracked entries maintained. Original source/test/CI blobs unchanged by this **notes-only** evidence amendment; existing accepted CI can be reused without repeat full build. Security-audit #113: runtime 20 Moderate, 0 High, 0 Critical; full 22 Moderate, 0 High, 0 Critical. These are unresolved, NOT accepted: `got`, `glob`, `minimatch`, `file-type` Cloudcmd dependency chains. Distinguish successful severity gate from security closure. Standalone Windows ESLint installer emitted peer-warning for @putout/eslint requiring eslint >=10 (root eslint 9), but lint succeeded. Windows Actions cleanup logged host miscellaneous cache timeout AFTER completed-success job; runner configuration not touched. PR #12 Gitea merge/three-remote sync still PENDING at this evidence checkpoint. FINAL-ACCEPTANCE-02 and production readiness remain STOP/BLOCKED pending proven compatible security remediation or separate **explicit** residual-risk approval. No live operations or release.
## FINAL-FIX-01 — Accepted merge, three-remote parity and security STOP (2026-11-23)

**Accepted Gitea closeout:** PR #12 squash merged into Gitea main `8da1f6a852261ae727a9ae8291ca521466cf0a5b`; original tested source SHA `36a1c5bf01cf240cac1493eb956112368aea7d62`; CI #113 (7/7 terminal SUCCESS), standalone Windows ESLint #119 (SUCCESS) and Windows Python SDK #120 (14/14 SUCCESS). Before merge, an evidence-only candidate commit `3bf2fbca58cb48560f1c22621950ff33cda5eb02` modified exactly notes/002, notes/003, notes/006; the already-tested runtime, test and workflow blobs were byte-identical. PR diff exactly six approved files and 0 unauthorized files. No duplicate CI dispatched. Windows File Manager 4/4 PASS, Node 24/24 suites PASS, Linux/Windows Python 14/14, lint/typecheck/Next/three Docker images PASS. No feature/UI/API/auth/SDK/DB/Redis/CSV/Docker configuration changes outside the accepted Windows root adapter and tests.

**Mirror proof, before this notes-only final evidence:** Gitea commit `8da1f6a852261ae727a9ae8291ca521466cf0a5b`, GitHub `JILLU-Games/DataStack` main `209c958084e81d2a618420fb6b1096ff25d0f1b1`, GitLab `ivibtools/datastack` main `727cfb5836366df82a9dd6a1476ed83187e5a7f9`; exact Git tree `800fd6500c51ac58a52f8dbc6b769022e3c24dd5` on all three remotes, 420 tracked entries each; per-file blob SHA/mode differences 0. This final notes-only commit must also be mirrored and re-verified; its new Git tree differs because only these three notes are appended.

**Security evidence, unwaived:** Accepted Gitea CI #113 npm audit inventories: runtime 20 Moderate, 0 High, 0 Critical affected package entries; full 22 Moderate, 0 High, 0 Critical. The security job passes its 0-High/0-Critical gate, NOT the unresolved Moderate inventory. Known four leaf advisory chains are (1) `got@10.7.0` / GHSA-pfrx-2q88-qq97 (patched 11.8.5), (2) `glob` / GHSA-3g3m-2fjr-6pw4 (patched 14.0.2), (3) `minimatch` / GHSA-g3hv-75wg-m249 (patched 11.0.1), (4) nested `file-type@16.5.4` / GHSA-5v7r-6r5c-r473 (patched 21.3.1). Counts describe affected packages, not 20 unique advisories. See notes/001–006 P04-S03–S06 for exact ancestor constraints, transitive package integrity, prior disposable static/runtime trace and advisory provenance. Previous LOAD instrumentation does not prove vulnerable-function CALL reachability, and absent proof does not mean zero exposure. Auth and disabled Dropbox/terminal reduce some exposure but do not eliminate dependencies or prove safety.

**Remediation decision:** Current Cloudcmd `19.24.0` transitive parents do not declare compatibility with the patched major leaf versions. Reviewed upstream `19.24.1` alters `@cloudcmd/fileop` dependency requirement, with no demonstrated compatible security backport for all four chains. No publisher-authenticated, exact-integrity, regression-validated same-API backport or safe parent remediation candidate established. Do NOT downgrade to cloudcmd 17.0.2, force npm audit fix, add unsupported overrides, or alter runtime/lockfile speculatively. `package.json` and `package-lock.json` unchanged by FINAL-FIX-01. No security candidate means no new full CI dispatch. Security closure = **BLOCKED**, no residual risk acceptance. Explicit next authorization required: a narrowly reviewed parent/older-major backport scope exception with isolated compatibility proof, OR separate, package/advisory-specific explicit residual-risk acceptance with documented compensating controls and exposure review. Neither is implied here.

**Gate result:** FINAL-FIX-01 Windows compatibility closeout DONE. FINAL-ACCEPTANCE-02 NOT STARTED because the approved STOP rule is triggered at unresolved security disposition. RELEASE CANDIDATE NOT READY, Production NO-GO. No production/test data mutation, personal-PC processing, runner changes, deployment, tag, release, migrations or destructive cleanup; old WIP PR #4 untouched.

## FINAL-ACCEPTANCE-02 — One-shot closeout candidate on new Gitea (2026-11-28 UTC)

**Canonical source:** private `https://dev.vib.tools/vibtools/DataStack`, main `4959b69bb25b46a16509bfc4755d13bad87347a9`, tree `37bffae18e2abb6d66a1ae7e1cc6599b48593ee1`. One `final-acceptance-02-closeout` candidate and draft PR #1, unmerged. This supersedes the historical "FINAL-ACCEPTANCE-02 NOT STARTED" statement above; previous FINAL-FIX-01 evidence remains historically valid. **No user features or production state changed.**

**Previous failure RCA and test-only corrections:** CI #9 Node regression had 429/ADMIN_LOGIN_LOCKOUT webhook nondelivery assertion dependent on arbitrary 60ms sleep while the real dispatcher includes async SSRF/DNS validation. Replaced with event-driven awaited mock dispatch and bounded 5s timeout, no login/SSRF/runtime changes; focused Linux Gitea CI **#14 SUCCESS, 6/6 PASS**. CI #11 Windows Python 13/14 used invalid generated Python source for a Windows spool path. Fixed only the `tests/phase05_sdk_test.py` fixture with `repr()` serialization, preserving the SDK parser and config precedence; focused Windows CI **#12 SUCCESS, 14/14 PASS**. Earlier diagnostic CI #13 all SKIPPED due a workflow condition, not PASS; corrected narrowly.

**Security candidate, NOT release acceptance:** Old `dev.ivib.cc` PR #13 exact object `dab4dc93088a769b906c87f43fd1393eb743c209` unavailable on authorized PC and old Git endpoint timed out; no recovery claim. Four approved patch files reconstructed from immutable published older-major packages and official upstream fixes: (1) `got@10.7.0` UNIX-socket redirect guard, upstream `861ccd9ac2237df762a9e2beed7edd88c60782dc`; (2) `glob@10.5.0` abort early-return (v13.0.7 already has this guard), official glob v14.0.2 delta; (3) nested `minimatch@9.0.9/10.2.6` bounded first-phase expansion/dedupe, upstream `77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8`; (4) nested `file-type@16.5.4` ASF tokenizer forward-progress guard, upstream `319abf871b50ba2fa221b4a7050059f1ae096f4f`. Package.json postinstall executes verified, fail-closed, idempotent Git apply; approved Docker dependency stages include Git and patches. `package-lock.json` has not changed. No downgrade, override, arbitrary fork or disabled feature.

Focused Linux source/compatibility CI **#15 SUCCESS** on source SHA `9a3796ceb5ec8cfe9062ce155c7379ecd7c2ed34`: clean npm ci applied all four patches; Node SDK build PASS; webhook 6/6; File Manager/Cloudcmd + four security negative cases **8/8 PASS**. **Native Windows candidate CI #16** dispatched on subsequent workflow-only SHA `d08ffae878dcec65a8e103e3fa476018f778c532`; outcome must be read separately. Version-based npm vulnerability inventory historically runtime 20 Moderate/full 22 Moderate (0 High/Critical); a source backport does **not** make npm audit zero, nor establish a user-approved advisory-specific residual-risk disposition. Mandatory full CI and broader compatibility security review remain pending.

**Hard Docker STOP:** New CI #9 docker job failed closed with `DATASTACK_DOCKER_HOST_NOT_ISOLATED` on shared Actions daemon before Docker image builds. Historical old Gitea #132 also stopped because production-like containers were present. No verified dedicated *non-production* isolated Docker daemon, five-service startup, fixture PostgreSQL/Redis/CSV recovery/restore, or rollback acceptance exists. **Never bypass the guard, test on production workloads, prune or change shared host configuration.** No final consolidated CI/merge/sync/production deployment authorized while mandatory gates fail.

**Current disposition:** one draft PR; Gitea `main` + GitHub/GitLab/clean local backups remain on frozen canonical main with 420/420 parity. Candidate not merged or propagated to backups. **RELEASE CANDIDATE BLOCKED; PRODUCTION NO-GO.** Remaining security residual-risk disposition, safe Docker runner, mandatory disposable acceptance and one final consolidated terminal CI must precede any merge; actual Production GO requires separate live operational authorization.

## FINAL-ACCEPTANCE-02 — 2026-11-28 10:41 UTC evidence checkpoint

This supersedes earlier pending Windows CI statements; it is not a new phase or release acceptance.

- Frozen authoritative main remains `4959b69bb25b46a16509bfc4755d13bad87347a9`, tree `37bffae18e2abb6d66a1ae7e1cc6599b48593ee1`. Existing draft PR #1, branch `final-acceptance-02-closeout`, remains unmerged. Previous approved candidate `7eb9e7f705276a129cf3b9c2dc0bab999ffc3c8d`, tree `1c1e74ef55e8d2060f2502c1236957c6ea2fe23a`.
- Windows #16 and #17 failed at got patch application; #17 normalized the wrong boundary (installed source rather than patch transport). Diagnostic [run #18/job #59](https://dev.vib.tools/vibtools/DataStack/actions/runs/18/jobs/59), commit `44dc5bd32e1e4085d0d4082e32ed1e9536932918`, completed with expected diagnostic failure after extracting 1,278 locked packages without scripts. Windows system Git `core.autocrlf=true` caused checked-out patches to have 16/91/155/63 CRLF lines respectively (got/glob/minimatch/file-type), while all nine target source files and committed patch blobs had zero CRLF. Raw exact apply checks failed 4/4; normalized LF checks and original Git blob checks passed 4/4. Normalized patch SHA-256 equaled committed blob SHA-256 in every case.
- Corrective commit `2650337f64b20d1b0071fec0ff196b5af5d29a39`, tree `898390f4a4eb1a331a410b47e202e4b2fc1c44e5`, modifies only package.json, existing CI workflow and File Manager test fixture. It normalizes UTF-8 patch transport to LF and passes through stdin, with exact forward/reverse Git checks, no whitespace relaxation and no installed-source line-ending rewrite. The negative got redirect fixture uses a unique nonexistent socket instead of a real Docker socket. Four patch blobs, lockfile and application code unchanged. Exact candidate delta 3 paths; total main-to-candidate diff still 16 approved paths, no deletes.
- Combined focused [run #19](https://dev.vib.tools/vibtools/DataStack/actions/runs/19) dispatched on that exact corrective commit. Linux job #61, Windows #66, audit #67; four unrelated jobs skipped intentionally. At this checkpoint execution is in progress, NOT a final acceptance result. New checks require all four postinstall idempotence markers, official npm registry tarball SHA-512 validation and byte-for-byte patched-source comparison on Linux, plus native Windows clean install/SDK/File Manager and current npm advisory inventory. Existing accepted #12 Windows Python 14/14, #14 webhook 6/6, #15 Linux clean install/4 patches/SDK/webhook 6/6/File Manager 8/8 are preserved as historical evidence.
- Advisory provenance: got GHSA-pfrx-2q88-qq97, upstream sindresorhus/got commit 861ccd9ac2237df762a9e2beed7edd88c60782dc; glob GHSA-3g3m-2fjr-6pw4, isaacs/node-glob 4682e8c9babee1b385202ede36389634e12076d7; minimatch GHSA-g3hv-75wg-m249, isaacs/minimatch 77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8; file-type GHSA-5v7r-6r5c-r473, sindresorhus/file-type 319abf871b50ba2fa221b4a7050059f1ae096f4f. Locked ancestry: cloudcmd -> @cloudcmd/dropbox -> dropbox-stream -> got 10.7.0; inly/onezip/spawnify -> glob 10.5.0 and onezip -> glob 13.0.7; those glob versions -> minimatch 9.0.9 and 10.2.6; restbox/join-io -> ponse -> two nested file-type 16.5.4. Root file-type 21.3.4 outside that advisory; glob 13.0.7 already has relevant abort returns. Cloudcmd 19.24.6 upstream manifest still retains several implicated dependency ranges and changes restbox major version, so not a verified safe replacement. No dependency upgrade. Lock has 1,360 entries, only 91 with integrity and resolved metadata; targeted entries lack integrity metadata. New CI verifies official tarballs and all patched target bytes; does not imply whole-tree cryptographic lock integrity.
- Advisory-specific residual dispositions remain OPEN pending terminal #19 and assessment. Version-based npm audit flags are not equivalent to exploitability or backport failure; do not claim zero findings. Prior runtime 20 Moderate/full 22 Moderate, zero High/Critical are historical only.
- Docker mandatory gate remains BLOCKED: #9 job #13 and historical #132 fail closed on occupied/shared Docker daemon. No verified independent non-production Docker runner is available through authorized Gitea controls; user explicitly prohibits Home VPS access and requires MyPC backup/sync only. No guard bypass, host reconfiguration, Docker runtime tests, service startup, backups/restores, rollback or final consolidated CI. No production action, tag, release, merge or backup candidate sync. Continue within the same existing draft PR once terminal evidence and genuine isolated runner are available; residual-risk acceptance and live deployment are separate decisions. RELEASE CANDIDATE BLOCKED / PRODUCTION NO-GO.

## FINAL-ACCEPTANCE-02 — Run #19 focused verification result

Exact tested commit `2650337f64b20d1b0071fec0ff196b5af5d29a39` / tree `898390f4a4eb1a331a410b47e202e4b2fc1c44e5`. [Run #19](https://dev.vib.tools/vibtools/DataStack/actions/runs/19) status at capture: **SUCCESS**. Job states: node-regression #61 success; python-regression #62 skipped; quality #63 skipped; production-build #64 skipped; docker-image-build #65 skipped; windows-compatibility #66 success; security-audit #67 success. This is focused cross-platform acceptance, not the final consolidated gate.

- Linux #61 SUCCESS: clean npm ci, all four exact patch applications and idempotence markers, six registry package-version tarballs SHA-512 checked, nine patched source files byte-identical to independently reconstructed tarball+patch outputs, and two existing nested glob walker files byte-identical to official glob 13.0.7 tarball. Node SDK build SUCCESS; lockout/security webhook 6/6 and File Manager/security 8/8 PASS, zero failures. Source integrity evidence includes got, glob, minimatch and file-type, both CJS/ESM where applicable.
- Windows #66: native committed-lock clean install (1,278 packages) SUCCESS, all four patch CRLF normalization and application markers and all four second-run idempotence markers verified; Node SDK compilation SUCCESS; native File Manager CRUD/ZIP/UNZIP/auth/RBAC/CSRF/revocation/traversal and four advisory-specific regression tests 8/8 PASS, zero failed/skipped. Root cause correction accepted at focused test boundary. No npm version/lockfile change.
- Fresh npm audit #67 SUCCESS: runtime 20 Moderate / 0 High / 0 Critical; full 22 Moderate / 0 High / 0 Critical. Runtime inventory has four direct advisory IDs and 16 propagated vulnerable package entries, not 20 distinct vulnerabilities. Full adds build/development-only GHSA-rj75-hqrm-r3gf (`postcss-selector-parser` via `@tailwindcss/typography`), outside four targeted backports; retain for explicit separate disposition. Suggested Cloudcmd 17.0.1 major downgrade is not an accepted fix. All four targeted advisories are **source-backport mitigated with focused Windows/Linux regression and verified Linux target-source integrity**, still version-flagged, not final risk accepted. Whole-lock integrity metadata gap remains separately recorded; no claim of full supply-chain integrity or zero vulnerabilities. Explicit residual-risk authorization is required before final release if version findings remain.
- Mandatory Docker/recovery/rollback and full consolidated CI remain NOT RUN/BLOCKED because there is no verified authorized independently isolated nonproduction Docker daemon. Keep fail-closed isolation guard and draft PR #1. Frozen main and backups unchanged, no deployment/tag/release/force/production mutation. No Home VPS access; MyPC backup/sync only. No new phase or PR. RELEASE CANDIDATE BLOCKED / PRODUCTION NO-GO.

## FINAL-ACCEPTANCE-02 GitHub-hosted closeout checkpoint — 2026-11-28

This supersedes the previous isolated-daemon availability blocker; historical evidence remains intact. Approved GitHub-hosted exception: exact audited non-force candidate branch transfer to JILLU-Games/DataStack; Gitea remains canonical. Both mains remain frozen at 4959b69bb25b46a16509bfc4755d13bad87347a9 (tree 37bffae18e2abb6d66a1ae7e1cc6599b48593ee1).

- Implementation a023a7148b84dd929cf76e8abbaf861bc2e37a31 / df0a344418a6819fc4a9373e5d732861ad8130c4 added the approved hosted workflow and two fixture harnesses, scoped parser 6.1.5 override, and eight targeted lock integrity entries (seven existing security package entries plus parser). No unrelated version or runtime source changes. First GitHub run 46139296671 terminal FAILURE: 24/24 Linux Node suites, 14/14 Python, security PASS; invalid test-only lint directive and Windows cross-drive fixture failed; three images, five healthy services, auth HTTP/WS/FM, Redis ACK/AOF queue and cleanup PASS; post-restart export HTTP 500. Artifact 15260604532 SHA256 e35e136fddedf1747c2b6a99297a53a190d4fc0b1296ad45bcaf0d20ae4a4f3e verified.
- Corrections adb95949da644f4c8049ac9aa0e13773bd4e5e24 (remove invalid lint comment), 055c7ad40e1123793005fac700d61a2cf0c829a2 (same-drive Windows fixture, production guard and assertions preserved), and 55bc7ee4de4aaf4852ecc518312b7888c3d4fea4 (bounded sanitized diagnostic, no bypass). Exact tested corrected tree 76f6e4b368ec60c19ca1f9ee414567d4c86412bf, Gitea/GitHub 432/432 recursive path/blob/mode/type match. Six changed files relative to approved candidate d16b59c0bdf26a7bfca343b3e2964e7eab47992a, all allowlisted.
- Second run 46139859242 on corrected SHA terminal FAILURE, five mandatory functional jobs SUCCESS: Linux Node 24/24 (140963166721); Linux Python 14/14 (140963166662); Windows npm/SDK, File Manager 8/8 and Python 14/14 (140963166652); TypeScript/ESLint, typography output parity, Next.js standalone build (140963166481); fresh security audit (140963166681). Docker job 140963166709 and final gate 140964211195 FAILURE. https://github.com/JILLU-Games/DataStack/actions/runs/46139859242
- Security: full and runtime each 20 Moderate, zero High/Critical; selector parser GHSA-rj75-hqrm-r3gf absent and generated typography component parity PASS. Four runtime roots remain version-flagged (got GHSA-pfrx-2q88-qq97, glob GHSA-3g3m-2fjr-6pw4, minimatch GHSA-g3hv-75wg-m249, file-type GHSA-5v7r-6r5c-r473), source-backport mitigated, tested patch idempotence and targeted byte integrity; sixteen propagated package entries. Explicit residual-risk disposition not authorized. No claim of entire lock cryptographic coverage or zero vulnerability.
- Docker second run reproduced verified isolation, candidate 3/3 image builds, five healthy services, authenticated HTTP/WS and File Manager, Redis ACK and AOF queue survival. Stage restarted: GET /api/export HTTP 500, error "g is not a constructor"; queued=1, lock TTL=-2, fixture CSV 268 bytes mode 644 UID/GID 1000/1000; owned-resource cleanup PASS. Artifact 15261157341 downloaded and SHA256 verified de3ca8970c250ca61d67a88734fa95fe51479af295fd234434d793678303b936. Redis-to-export recovery FAIL; CSV/GZIP replay, PostgreSQL backup/restore, rollback, final volume checks NOT REACHED. No evidence of data loss in ACK queue; not a full durability pass.
- Static investigation points to Next.js bundled replay/flush constructor path in core/data/buffer.ts (dynamic node:stream Writable and CSV parser among candidates); exact constructor and stack unconfirmed. app/api/export/route.ts calls DataBufferEngine.flush and returns caught error as HTTP 500. Both runtime files are outside approved write scope. No speculative runtime fix, no additional CI loop. Obtain narrow scope for verified root cause and focused regression; remaining release gates and residual disposition required. Existing Gitea draft PR #1 remains unmerged; temporary [skip ci] marker prevents duplicate Gitea CI while GitHub qualification in use. No production deployment, tags/releases, force, Home VPS or production mutation. MyPC only Git sync/backup. Main backup sync deferred until all mandatory gates and explicit residual disposition PASS. **RELEASE CANDIDATE BLOCKED / PRODUCTION NO-GO.**
