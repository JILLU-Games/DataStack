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
