# DataStack — Actual Implementation / Working-Feature Register

Frozen source HEAD: `d725841ebc828d58cbe90f517da9e600f23c4630`. Date: 2026-11-22.
**Evidence levels**: SOURCE = verified code present; CI PASS = focused automated tests/build passed; LIVE READ = public read-only endpoint observed; NOT VERIFIED = no independent safe live runtime evidence. These are deliberately different. Do NOT infer production DB/S3/MCP health from a public `online` response.

| Capability / feature | Exact representative path | Baseline evidence | Actual live conclusion | Changed by P01/P02/P03 |
|---|---|---|---|---|
| Next.js 15 public landing and app pages | `app/**`, `docker/Dockerfile.web` | Next.js CI build PASS and 22/22 static pages; public landing loads | LIVE READ for landing only | None |
| Console admin authentication/setup | `app/api/auth/**`, `core/auth/adminUsers.ts`, `core/auth/adminSession.ts` | SOURCE + auth regression suite PASS | Admin login NOT live-tested | None |
| Roles / owner-admin-operator-viewer | `core/auth/**`, `components/layout/VconShell.tsx` | SOURCE + RBAC TS tests PASS | NOT live-tested | None |
| SDK registered clients, token issuance/revoke/rotate | `core/sdk/sdkManager.ts`, `app/api/clients/**` | SOURCE + client/auth TS regression PASS | NOT live-tested | None |
| Next.js HTTP event ingestion | `app/api/events/route.ts` | SOURCE + TS tests PASS | No live writes performed | None |
| Express + Socket.IO ingestion | `server/index.js`, `server/socket/handlers.js` | SOURCE + sync/SDK tests PASS | Not live end-to-end verified | None |
| Rate limit, dedupe, payload validation | `server/socket/handlers.js`, `app/api/events/route.ts` | SOURCE + tests PASS | Not live verified | None |
| Redis ingestion queue/fallback | `server/index.js:165-193`, `core/data/buffer.ts` | SOURCE + TS storage tests; R-01 ACK durability risk | Not guaranteed lossless on outage | None |
| CSV partition/rotation/flush | `server/workers/csvWriter.js`, `core/Storage/csvStorage.ts` | SOURCE + regression; ingestion image CI build PASS | R-02 crash replay semantics NOT confirmed | None |
| Compression and S3 archival | `core/Storage/s3Archive.ts`, `core/Storage/csvStorage.ts` | SOURCE + storage tests | No live S3 credentials or archive tests | None |
| Data browser, export CSV/JSON/NDJSON | `app/api/export/route.ts`, `app/api/data/route.ts` | SOURCE + TS tests | NOT live-tested | None |
| Storage quota / disk admission | `core/Storage/csvStorage.ts` | SOURCE + tests; 507 codes | NOT live-tested | None |
| Dashboard, client status, counts | `lib/vconUiHelpers.ts`, `app/vcon/clients/page.tsx` | SOURCE; client status helper tests; stale old regex CI-04 | No live user session proof | None |
| Prometheus and metrics bridge | `app/api/prometheus/route.ts`, `server/index.js` | SOURCE + tests | NOT live authenticated | None |
| Webhook alerts and SSRF/HMAC | `core/alerts/webhookNotifier.ts` | SOURCE + tests | NOT live-tested | None |
| CloudCmd file browser | `server/filesManager.js`, `tests/files-manager.test.ts` | SOURCE; files-manager suite 4 tests PASS | NOT live authenticated | None |
| MCP engine (17 permissions) | `server/mcp/mcpEngine.js`, `app/api/mcp/route.ts` | SOURCE + MCP server suite 3 tests PASS; write flags default false | NOT live connected/authenticated | None |
| Python SDK v2.2 + compat package | `sdk/python/datastack/datastack/**`, `sdk-python/**` | Windows CI **14/14** PASS | No real external SDK session | None |
| Node SDK v2.2 + offline spool | `sdk/node/datastack/**` | Native Windows SDK compile PASS; SDK-specific TS regression PASS | No live external SDK session | None |
| PWA/offline shell | `app/**`, `public/**` | SOURCE + phase06 suite PASS | Browser offline not live-tested | None |
| Docker Compose stack | `docker/docker-compose.yml` | CI config PASS, ingestion image PASS | Deployed app already serves public health; deployed SHA unverified | None |
| Docker web/proxy image | `docker/Dockerfile.web`, `docker/Dockerfile.proxy` | Web layer fail on containerd; proxy unrun | Existing Coolify instance appears online but CI image parity unverified | None |
| Health endpoint | `app/api/health/route.ts` | LIVE READ `status:online` on 2026-11-22T00:01:19Z | Confirmed public API liveness; not end-to-end readiness | None |

## Mandatory post-phase update convention

After EACH P01/P02/P03 close, amend only affected table rows:
- `Feature/capability` (exact added/changed behavior or `UNCHANGED`)
- `Source file/line + new SHA`
- `CI evidence` (run URL, pass/failed count, build exit)
- `Live status` (READ ONLY, AUTHENTICATED VERIFIED, NOT VERIFIED, etc.; no fictitious claims)
- `Compatibility` (UI/auth/SDK/API/storage preserved? test proof)
- `Risk remaining` and next approval.
Do not mark "actual working" simply because a patch compiled. Distinguish source, CI, and actual deployment.
## Change log
- P00: No feature added/modified. `notes/**` documentation only. 0/3 implementation phases completed.
- P01: **CLOSED — 1/3 implementation phases**. CI-01…05 corrected exclusively in package-lock, obsolete bun.lock removal, scoped regression/type tests and Gitea CI harness. **No actual application, UI, backend, API, SDK or production functionality was added, removed or altered.** Gitea #59: committed-lock Linux/Windows clean install PASS; Node SDK builds PASS; all 24 TS suites exit0 with zero timeouts; Next standalone 22/22 pages PASS. One historical #59 test-only declaration TS error fixed; #60 strict TS zero errors and full ESLint PASS. Previous canonical Python SDK 14/14 (#48) preserved but not rerun. No live endpoint mutation or deployment; live data/Redis/S3/MCP actual operational status is not established.
- P02: **BLOCKED pending separate approved runtime remediation**. Three disposable fault-injection tests demonstrated existing behavior: positive ACK on Redis write failure with RAM-only data (R-01), duplicate appended event ID after Redis trim failure and retry in web-side buffer (R-02), and public health 200/online when Redis is down (R-03). These are **diagnostic tests, not production fixes**. Zero app/API/UI/SDK/runtime changes, no live deploy. CI #63. P01 remains closed (1/3 phases complete).
- P03: pending.

## P02 Diagnostic Feature Record — 2026-11-22

- **New production features: NONE.** This phase adds only three disposable failure-injection scenarios across two existing test suites; tests are not production handlers. Existing source/UI/auth/backend/SDK/MCP, Redis/PG/CSV services, Next/Express health interfaces and deployment remain unmodified.
- R-01: existing volatile RAM fallback and WS ACK behavior audited, *not corrected*. Do not mark ACK durability as working merely because a diagnostic test proves current behavior.
- R-02: existing CSV-before-Redis-trim order audited, *not corrected*. Exactly-once replay safety is **NOT VERIFIED**.
- R-03: current public Express health 200 plus `redisConnected:false` is liveness, not dependency readiness. Separate readiness remains **NOT IMPLEMENTED**.
- Gitea disposable CI #63: https://dev.ivib.cc/vibtools/DataStack/actions/runs/63. The previous P01 working results remain valid; no live read/write test or production deploy is included in P02.


## P02 Runtime Candidate Feature Delta — 2026-11-22 (NOT RELEASED)

- **Intended change:** failure cases on socket ingestion report `BUFFER_PERSIST_FAILED` instead of positive ACK when Redis RPUSH rejects; single and batch code paths tested by new disposable assertions. Ordinary success ACK, auth, limits and SDK public interfaces intended unchanged.
- **Intended change:** Redis replay flush on both ingestion/Next paths inspects existing client CSV partitions and filters already-stored event IDs before reappend; safe failure leaves Redis queue untrimmed. This prevents the tested post-append/LTRIM replay duplication but does **not** prove transactionally exactly-once delivery or zero performance impact.
- **No changes:** application UI/UX, auth, SDK, database schema, Docker, environment, public R-03 health, other features and production runtime. No deployment or live verification.
- **Status:** P02 code candidate locally committed, acceptance CI blocked by Gitea unavailability; **NOT CLOSED**, not production-ready. P01 remains only completed phase.


## P02 Final Feature/Compatibility Register — 2026-11-22

Existing UI/UX, admin auth, SDK public signatures, health route, database schema, Docker and deployment: **UNCHANGED**. Only existing Socket.IO single/batch persistence failure ACK/idempotency cleanup, Redis->CSV replay duplicate filtering and disposable tests changed during P02. No new production feature, public endpoint, release or migration. CI #66 terminal SUCCESS (24/24 TS suites, strict types, ESLint, Windows Node SDK, Next production build); final CI #69 pending. Client-facing `BUFFER_PERSIST_FAILED` error is used only for previously incorrectly acknowledged Redis-backed failure; intentionally Redis-free RAM mode is preserved. CSV write content/format unchanged, gzip and rotation replay acceptance covered in final test fixture. All live status values are **NOT VERIFIED / NO DEPLOYMENT**. No guarantee of global exactly-once delivery or hard bound on disk scans; future throughput benchmark/design approval if required. P03 still gated on final P02 close.


### P02 final acceptance correction checkpoint

Gitea #69 node-regression observed one **fixture timeout**, not a proven new production feature defect, caused by altering global `Date.now`. A separate source-proven mixed batch all-duplicate ACK bug was corrected only in `server/socket/handlers.js`, test case added in existing allowed TS file. Revised `acca8be01a31f8d3972564cbaec8fd3117a0b551` pending focused Gitea CI #72. Existing UI/SDK/auth/public health remain unchanged. This is not evidence that production has been deployed or live-tested.


### P02 verified feature-state reconciliation — Gitea #72 SUCCESS

- **P02 R-01: FIXED in source and CI-PASS, conditional scope.** Configured Redis queue RPUSH rejects => `BUFFER_PERSIST_FAILED` negative ACK for single/mixed batches, stale Redis idempotency claim cannot be reported as durable success; clock arithmetic and actual negative ACK retries verified. Intentionally Redis-free RAM mode historical best-effort ACK **preserved**, not a lossless guarantee.
- **P02 R-02: FIXED for verified crash/replay windows**, not global transactionality. Port4000 and Port3000 CSV replay suppresses duplicate same-client/day/eventId across plain, rotated and gz; failed reads prevent trimming; dedicated regression tests PASS. Streaming parser bounded memory, disk read throughput/latency not yet load-tested.
- **P02 R-03: UNCHANGED**: public /health remains backwards-compatible liveness, not a dependency-readiness endpoint. Production live health **NOT VERIFIED**.
- All other runtime features/UI/auth/API/SDK/database/Compose and package dependencies unchanged. **P02 CI ACCEPTED at #72**; code SHA `acca8be01a31f8d3972564cbaec8fd3117a0b551`. Phase closed only after verified 3-way content sync. No P03 implementation or production deployment.

## P03 feature invariance — 2026-11-22

P03 modifies workflow verification and Markdown evidence only, not a product feature. No UI, API, auth, SDK, DB, CSV, Redis, Dockerfile, Compose or deployment change. The P02 regression contract remains 24/24 PASS; corrected Python SDK passes 14/14; all three Docker images build without running them. Read-only npm advisory triage is complete but **not security-clean**.

**CI-08 security disposition:** `npm audit --json` full=26 affected packages (25 moderate, 1 high); runtime=24 (23 moderate, 1 high), **not counts of distinct advisories**. High-severity advisories [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) affect Next 15.5.29's nested `postcss@8.4.31` despite patched root `postcss@8.5.33`; npm recommends major `next@16.4.6`. Direct `cloudcmd@19.24.0` carries moderate transitive issues (`dompurify`, `file-type`, `glob`, `minimatch`, `got`); npm recommends `cloudcmd@17.0.2` downgrade, not a verified safe pin. No speculative package pin, major upgrade or force fix; a separately tested compatible remediation is needed before release.

**Scope / release decision:** only `.gitea/workflows/datastack-ci.yml`, `.gitea/workflows/datastack-docker-ci.yml`, and `notes/001–006` changed. No `package.json`/lock, Dockerfile, application UI/UX, runtime, auth, SDK, database, Compose, production data, secret, shared Docker prune, deployment, migration, tag or release. P03 technical CI and advisory-triage acceptance verified by #77 non-Python jobs plus #78 Python; do **not** mislabel #77 overall as successful. Final phase publication requires one main commit and Gitea/GitHub/GitLab exact tracked tree parity. **Production release NO-GO** while runtime high advisory is unresolved; live production health, throughput and deployment remain unverified.

## P04-S01 blocked security reconciliation report

P04-S01 SEC-01 BLOCKED — 2026-11-22. Approved scoped `overrides.next.postcss=8.5.33` trialed in disposable Windows npm 10.9.8 workspace only. `npm install --package-lock-only` EXIT 0, but `npm ls --package-lock-only postcss --all` EXIT 1 (`ELSPROBLEMS`: Next nested `postcss@8.4.31` invalid; expected 8.5.33); npm dedupe also kept invalid dependency. Read-only `npm audit --omit=dev --json` EXIT 1, runtime high 1/moderate 23/critical 0. Lockfile regeneration caused unrelated churn (91 package entries added, 106 removed, 69 changed, including two lightningcss optional 1.33.0 -> 1.30.1). Fresh minimal Next 15.5.29 fixture with identical override resolves PostCSS 8.5.33, isolating failure to DataStack committed lock graph. `npm ci --dry-run` exit 0 does not prove real clean install. Exact stop rule applied: no dependency patch, no CI acceptance, no main commit, no GitHub/GitLab sync, no release/deploy; production NO-GO. Need separate explicit narrowly scoped lock reconciliation approval.

No change to UI, API, SDK, auth, file manager, CSV, Redis, storage, feature set, Docker, deployment or production data. P03 baseline regressions preserved without claiming retest.

## P04-S01B no-feature-change / gate state — 2026-11-22

Candidate scope proof: PostCSS root 8.5.33 can satisfy Next 15.5.29 when stale nested 8.4.31 removed in a disposable lock, with moderate=22/high=0/critical=0 read-only runtime audit. Not published: regenerated metadata edits exceeded approved lock scope. Existing UI/UX, auth, API, SDK, CSV, Redis, Cloudcmd, Docker and production service behavior remain untouched; **do not claim regression acceptance or security remediation of published code**. Next approval must address exact npm-generated metadata drift and integrity preservation, not feature work.

## P04-S01C feature preservation and verification — 2026-11-22

No feature, UI, backend runtime, public API, auth, database/schema, SDK, CSV storage, Dockerfile or Compose source change. Package manifest scoped override and lockfile one-entry deletion only; Next 15.5.29 and Cloudcmd 19.24.0 preserved. Gitea CI #85 node 24/24, Python 14/14, strict types/lint, Next standalone and 3 Docker images completed SUCCESS. Security runtime audit high/critical 0; moderate advisories still pending separate triage. Windows compatibility QUEUED at checkpoint; no production release, deployment, migration or tag and no accepted main/mirror publication yet.

## P04-S01C FINAL CI acceptance (7/7) — 2026-11-22

Gitea CI #85 https://dev.ivib.cc/vibtools/DataStack/actions/runs/85 COMPLETED/SUCCESS; tested implementation SHA c759be990c032c2474d2d0bad519c643dec11a3a; later changes to candidate are documentation only. All seven jobs terminal SUCCESS: node-regression (Linux committed-lock npm ci and exactly 24/24 TypeScript suites); python-regression (Ran 14 tests, OK); quality (strict tsc and ESLint); production-build (Next 15.5.29 standalone, 22/22 pages); docker-image-build (three isolated BuildKit ingestion/web/proxy images); windows-compatibility (Windows committed-lock npm ci and Node SDK build, job #182, terminal SUCCESS); security-audit (runtime moderate=22 high=0 critical=0; full moderate=24 high=0 critical=0; DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO). Single Gitea acceptance run used, no additional broad reruns.

No product feature, UI, runtime, API, auth, SDK, data format, Docker or deployment change. Only resolved PostCSS dependency and CI security gate. CI fully accepted; publication not yet asserted in these pre-merge notes. Final phase CLOSED requires one squash merge of PR #5 into Gitea main and verified identical tracked content across Gitea/GitHub/GitLab; record actual new SHAs in terminal report. Production release remains NO-GO pending P04-S02 moderate vulnerability triage and separately authorized live readiness verification.

## P04-S02 scoped candidate — 2026-11-22

Baseline Gitea main `2d467ff1494858164a37814f7dbc2b321f510291`, tree `648c76ca496d2c9bf22a16f558c9ba347a45d4f7`. Cloudcmd 19.24.0 -> deepword 11.0.1 -> monaco-editor 0.55.1 pins DOMPurify 3.2.7, vulnerable according to npm advisory inventory. Disposable Windows npm 10.9.8 `npm view dompurify@3.4.18` verified, scoped npm override `overrides.cloudcmd.dompurify=3.4.18` resolves `dompurify@3.4.18` via `npm ls --package-lock-only dompurify --all --depth=5` (exit 0). `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefer-offline` exit 0. npm graph initially changed 67 unrelated metadata entries; deterministically restored exact baseline values after validating unrelated versions, URLs, integrity and dependencies. Final lock has **one changed package entry**, DOMPurify; same-major replacement plus verified registry `resolved` and `integrity`, no other packages added/deleted/changed. Candidate runtime audit affected-package counts **moderate 20/high 0/critical 0** versus baseline **22/0/0**; full candidate **moderate 22/high 0/critical 0** versus baseline **24/0/0**. DOMPurify and Monaco Editor dropped from vulnerable-package inventory. Other moderate packages (got, glob, minimatch, nested file-type, Cloudcmd transitive chain) remain; they require major package changes under current advisory constraints, prohibited by Scope Lock. This is a **pre-acceptance candidate**: do not claim application compatibility, CI PASS, publication, or phase CLOSED before full focused Gitea CI and exact three-remote tree parity.

Feature preservation: Cloudcmd major 19.24.0, Monaco Editor 0.55.1, Next 15.5.29, PostCSS override 8.5.33, runtime APIs/UI/auth/SDK/Redis/CSV/storage and Dockerfiles unchanged. Existing File Manager behavior must be verified by read-only tests.

## P04-S02 final CI acceptance — 2026-11-22

Gitea CI #92 (https://dev.ivib.cc/vibtools/DataStack/actions/runs/92) **COMPLETED / SUCCESS**, all 7/7 jobs terminal success on source commit `a88bc5f4498ea1b11acc0acfeb66b5aa9d6531be`: node-regression real Linux npm ci + 24/24 tests including `tests/files-manager.test.ts` exit 0; Python SDK 14/14; quality strict TypeScript/ESLint; Next.js standalone (22/22 static pages); isolated Docker/BuildKit 3-image verification `DATASTACK_THREE_IMAGES_BUILD_PASS`; Windows committed-lock npm ci + Node SDK compatibility; security-audit `DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO` and `DATASTACK_SECURITY_TRIAGE_INVENTORY_PASS`. Audit full=22 moderate/high=0/critical=0 (baseline 24), runtime=20 moderate/high=0/critical=0 (baseline 22). These are affected package entries, not distinct advisories. No new CI workflow or extra broad CI dispatched.

Exact approved patch: `package.json` scoped `overrides.cloudcmd.dompurify=3.4.18`, preserving `overrides.next.postcss=8.5.33`; npm-generated `package-lock.json` changes solely `node_modules/dompurify` version 3.2.7 -> 3.4.18 and verified `resolved`/SHA512 integrity. Baseline Cloudcmd 19.24.0, Monaco Editor 0.55.1, Next.js 15.5.29, all unrelated locked package versions, URL, hash, dependency and metadata preserved. Gitea published candidate lock bytes match disposable SHA-256 `57c5ea9df9f28be496f8c3202fbc280b0066bf8c216b8d8a3ca98b6f7b942854`. Exact candidate tree diff 420 entries, 8 approved changed files only (`package.json`, `package-lock.json`, notes/001–006), 0 unauthorized paths. No runtime/UI/auth/API/SDK/tests/CI/Dockerfiles/Compose/db/schema/data modifications.

Feature preservation: File Manager test and Monaco-related Next production build PASS; no UI features removed, no editor behavior modified in source. **Residual risk:** 20 moderate runtime affected package entries remain, including Cloudcmd transitive dependencies `got`, `glob`, `minimatch`, nested `file-type` and their parent chains. Current npm audit suggests `cloudcmd@17.0.2` (a major downgrade), explicitly out-of-scope; other transitive fixes need major-version dependency-contract changes. No force/downgrade/unverified override. Security improvement verified but NOT zero vulnerabilities. Production release stays NO-GO; remaining advisory disposition and live readiness need independent scope approval.

**Merge gate:** CI #92 7/7 PASS, approved 8-file patch integrity PASS; main squash merge and Gitea/GitHub/GitLab exact Git content-tree verification required before P04-S02 CLOSED. This note is written before that publication, so final remote commit SHAs shall be appended to the PR closure report after verification. No deployment, migrations, prune, tag, release.
