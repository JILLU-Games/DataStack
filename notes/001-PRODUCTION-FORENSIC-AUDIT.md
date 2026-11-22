# DataStack — Production-Readiness Forensic Audit (Documentation Baseline)

Status: **BASELINE FORENSIC SNAPSHOT; P01 VERIFIED AND CLOSED (see closure appendix)**. Date: 2026-11-22 (Asia/Dhaka).
Frozen source HEAD: `d725841ebc828d58cbe90f517da9e600f23c4630`. Local, Gitea `vibtools/DataStack`, GitLab `ivibtools/datastack`, and GitHub `JILLU-Games/DataStack` confirmed at this exact HEAD before writing these notes.
Scope of this document: **evidence-backed CI and source review**, not proof that every production feature works. No Coolify live write, rollback, restart or deployment was conducted. Public GET `https://data.ivib.cc/api/health` returned `status: online`; full DB/Redis/MCP/S3 transaction health is not established.

## Findings classification

- **8 finding groups** from actual CI: **5 code/test/lockfile groups** (CI-01…05) and **3 CI infrastructure/security-review groups** (CI-06…08). **Not 43 separate bugs**: the 43 compiler errors belong to CI-05.
- **2 failing assertions, 4 timeout suites** (24 TypeScript suites in run #45: 18 clean, 6 fail/timeout).
- **3 extra source-observed reliability risks** (R-01…03) have NOT been reproduced as production failures; they require targeted fault injection before any fix or behavior change.
- **Do not equate successful test/source feature with verified production runtime.**

## Eight confirmed findings / blockers

| ID | Severity* | Evidence (run/job) | Exact affected area | Verified observation | Planned phase |
|---|---|---|---|---|---|
| CI-01 | High | Run #42 job 63; #45 job 71 | `package-lock.json`, `package.json`; `.gitea/workflows/datastack-ci.yml` Windows job | Original Windows `npm ci` reports missing platform dependency entries; regenerate lock **only in runner** -> SDK builds. Lock not fixed in repo. | P01 |
| CI-02 | Medium | Run #45 job 66 | `bun.lock` and `tests/phase07-deployment.test.ts:648-649` | Tracked `bun.lock` conflicts with assertion requiring its absence. Validate references before removing. | P01 |
| CI-03 | Medium | Run #45 job 66 | `tests/r3-phase04-ui-metrics-rbac.test.ts`, `tests/r4-phase03-sdk-deploy-auth.test.ts`, `tests/r5-phase01-mcp-foundation-logs.test.ts`, `tests/r5-phase03-mcp-ui.test.ts` | Each suite timed out with exit **124** despite reaching passing assertions; investigate open handles/teardown without changing application timers by default. | P01 |
| CI-04 | Medium | Run #45 job 66 | `tests/v2-phase01-storage-quotas.test.ts:788-804` vs `app/vcon/clients/page.tsx:15-20,70-95` and `lib/vconUiHelpers.ts:717-780` | Old regex expects `function isClientExpired(` in page; production page uses shared `classifyUiClientStatus` and `summarizeUiClientCounts`. Test contract is stale; not proof expiry feature fails. | P01 |
| CI-05 | Medium | Run #45 job 68 | Nine `tests/*.test.ts` files (listed below), `tsconfig.json:27` | `npx tsc --noEmit` produced **43 compiler errors**, despite Next.js production build PASS. Type errors in test sources require focused correction; do not disable strict TypeScript. | P01 |
| CI-06 | Low/CI | Run #45 job 67, run #48 job 74 | `.gitea/workflows/datastack-ci.yml` Python job | Linux Bullseye `apt-get` returned Debian-security 404; separate Windows Python job passed **14/14**. Runner provisioning defect, not SDK regression. | P03 |
| CI-07 | High/CI | Run #50 job 76 | `.gitea/workflows/datastack-docker-ci.yml`, Docker daemon; `docker/Dockerfile.web:13` | Compose validation and ingestion image PASS, then web image layer copy fails with containerd `lstat .../app/node_modules/@uiw: no such file or directory`. Root cause **unconfirmed** (runner snapshot/storage or reproducible build interaction); proxy never built. | P03 |
| CI-08 | Review | Run #50 job 76 | `package.json` / `package-lock.json` / resolved npm graph | npm reports **24 (23 moderate, 1 high)** with `--omit=dev`, **26 (25 moderate, 1 high)** with `--include=dev`. Counts overlap; no CVE list, reachable-exploit assessment or remediation done. | P03 |

*Severity is release-priority triage, NOT a CVSS rating and NOT proof of real-world exploitation.

### CI-05 exact file map (43 total, all inside tests)

| File | Error count | Families / main anchors |
|---|---:|---|
| `tests/phase01-auth.test.ts` | 4 | TS2540; 88,560,773,794 |
| `tests/phase03-storage-buffer.test.ts` | 2 | TS2349; 1158,1202 |
| `tests/r3-phase01-security-vault-webhooks.test.ts` | 6 | TS2353, TS2345; 185,191,202,210,295,430 |
| `tests/r3-phase02-storage-scheduler-gzn.test.ts` | 1 | TS2345; 49 |
| `tests/r4-phase01-security-boot.test.ts` | 3 | TS2345; 102,537,571 |
| `tests/r4-phase02-ingestion-audit-streaming.test.ts` | 9 | TS2345/TS2833; 87,332,335,338,407 |
| `tests/r5-phase02-mcp-server.test.ts` | 12 | TS18046; 510,524,538,549,560,570,581,604,613,635,644,657 |
| `tests/v2-phase01-storage-quotas.test.ts` | 2 | TS2554; 762,783 |
| `tests/v2-phase02-alerts-ip-prometheus.test.ts` | 4 | TS2339; 479,480,490,491 |

No source fix is authorized here. Use typed narrowing and correct test fixtures, not `skipLibCheck`, `any` everywhere, `@ts-ignore`, or changing real API responses merely to make tests compile.

## Three source-observed production reliability risks — CONDITIONAL GATES, not confirmed bugs

| Gate | Source proof | Why verification is required | Phase |
|---|---|---|---|
| R-01 Redis outage ACK durability | `server/index.js:165-193`, `server/socket/handlers.js:583-602` | `redis.rpush` failure falls back to RAM, and `onBufferPush()` can resolve, then Socket.IO ACK success; process crash before flush may lose acknowledged events. Fail-injection test and explicit durability contract required. | P02 |
| R-02 Batch replay duplication | `server/index.js:943-994`, `server/workers/csvWriter.js:265-323` | CSV write precedes Redis list trim. Crash/partial write between these operations can replay already written rows. Validate at-least-once vs exactly-once guarantee before mitigation. | P02 |
| R-03 Liveness ≠ readiness | `server/index.js:1939-1956`; `app/api/health/route.ts:95-111` | Health returns online without full PostgreSQL + Redis + disk transaction proof. Preserve existing `/health` API semantics; consider separate, internal readiness rather than breaking public health. | P02 |

Optional configuration review (not counted among eight): `server/index.js:1086-1089` Socket.IO uses CORS delegate; verify WebSocket origin/access and JWT guard in target deployments before recommending policy changes. `sdk/python/datastack/pyproject.toml:47-51` still references legacy `anik-d-art/datastack` URLs; metadata only, not current release blocker. Do not silently modify either under approved scope.

## CI evidence / original logs

- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/42` — initial Windows lockfile failure (job 63), cancelled after partial node evidence.
- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/45` — 24 suites = 18 clean / 6 fail-or-timeout, 43 TS diagnostics, Next.js production build PASS, Windows diagnostic SDK build PASS; Linux Python apt and Docker-CLI job blocked.
- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/48` — Python SDK 14/14 PASS.
- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/49` — full ESLint PASS.
- `https://dev.ivib.cc/vibtools/DataStack/actions/runs/50` — Compose PASS, Docker ingestion image PASS, web image containerd failure.
- See `notes/006-BASELINE-AND-PATCH-EVIDENCE.md` for precise code/log excerpts and proposed patch anchors.

## Release acceptance rule

NOT production-update-ready until P01, conditional P02 gates, and P03 finish, 24/24 TypeScript suites exit 0, 14/14 Python tests pass, full strict `tsc --noEmit` and ESLint pass, Linux/Windows clean install is reproducible, standalone Next build passes, all 3 Docker images build, security advisories are triaged, and approved **non-mutating** live readiness checks pass. Production deploy is a separate operator-approved action; never automatic from this documentation phase.

## P01 Closure Appendix — 2026-11-22

**Implementation outcome: CI-01…CI-05 resolved within P01 source allowlist; no production app/runtime/UI/SDK changes.** Evidence: Gitea [#59](https://dev.ivib.cc/vibtools/DataStack/actions/runs/59) and focused quality retry [#60](https://dev.ivib.cc/vibtools/DataStack/actions/runs/60). Run #59 overall FAILED because a single test-only `stopTimers` type declaration remained; it was corrected in `tests/r5-phase01-mcp-foundation-logs.test.ts` and strict `tsc --noEmit` plus ESLint then PASSED in #60. The two run results are complementary; neither should be misreported as a single all-green run.

| Finding | Resolution and proof |
|---|---|
| CI-01 | `package-lock.json` gained 68 registry-integrity-verified **optional** entries including nested `@napi-rs/wasm-runtime/node_modules/@tybys/wasm-util@0.10.5`; 1293 original package entries unchanged, no removals or version bumps. Committed-lock `npm ci` PASS on Linux (job 90) and Windows (job 95). |
| CI-02 | Removed obsolete `bun.lock`; `tests/phase07-deployment.test.ts` exit 0. |
| CI-03 | Added suite-specific teardown hooks in four previously hanging suites, without changing core timer/runtime implementation; each exits 0. |
| CI-04 | Replaced stale client-expiry inline-function regex with shared classifier/count behavioral assertions; `tests/v2-phase01-storage-quotas.test.ts` exit 0. |
| CI-05 | 43 historical test-only TypeScript diagnostics corrected; one additional teardown declaration fixed after #59 typecheck failure. Final #60 strict TypeScript PASS (zero errors) and ESLint PASS. |

**Acceptance evidence:** #59 Node SDK build PASS, 24/24 isolated TypeScript suites exit 0 (no timeouts), Windows SDK build PASS, Next.js 15.5.29 standalone production build PASS with 22/22 pages. #60 targeted `tsc --noEmit` and `npm run lint` both PASS. Prior canonical Windows Python SDK 14/14 PASS from [#48](https://dev.ivib.cc/vibtools/DataStack/actions/runs/48); Python source unchanged and not rerun in P01. Docker images and live production behavior NOT verified in P01; P02 runtime reliability risks and P03 infrastructure/security gates remain open.


## P02 Forensic Fault-Injection Update — 2026-11-22

Source freeze for P02: Gitea/GitHub main `667a140c4e9e75382bfdcdbe1d3e9eb96f6e808a`, matching GitLab tracked tree `d53b9e6dd7ff6d291b8bab7b841d8684ef89c703`. R-01/R-02/R-03 originally **risks**, not established production incidents. The diagnostic-only P02 patch adds disposable fixture tests in `tests/phase02-sync.test.ts` (R-01/R-03) and `tests/phase03-storage-buffer.test.ts` (R-02); CI: https://dev.ivib.cc/vibtools/DataStack/actions/runs/63. **Do not interpret diagnostic assertion success as a durability fix.** No runtime code, API, UI, data store, SDK, security policy, deployment or production host has been modified.

- **R-01 durable ACK:** `server/index.js:165-193,1895-1923` catches a failed Redis RPUSH and pushes accepted events into volatile RAM. `server/socket/handlers.js:583-602` then sends `{success:true,eventId}` if `onBufferPush` resolves. In the injected-RPUSH-failure fixture, simulated process-memory reset models loss of the acknowledged event; no actual server is killed. **Potential release blocker: acknowledged data is not necessarily durable.**
- **R-02 CSV/replay:** `server/index.js:981-993` and `core/data/buffer.ts:795-809` write CSV before Redis LTRIM. The fixture injects an LTRIM failure after successful CSV append and retries the same queue; a duplicate eventId write would demonstrate at-least-once rather than exactly-once delivery. This fixture is an analogous web-buffer implementation, **not direct Port-4000 writer fault injection**. **A release decision and exact remediation require independent targeted evidence; do not extrapolate no-duplicates.**
- **R-03 health:** `server/index.js:1926-1957` returns HTTP 200 `status:online` when Redis LLEN fails, while surfacing `redisConnected:false`; the historical route is **liveness**, not dependency readiness. `app/api/health/route.ts:95-111` likewise reports web liveness/buffer and does not prove database/Redis write readiness. A new readiness endpoint or altered public response requires separate approval.

Do not auto-fix source based solely on tests. Runtime code is READ-ONLY under the current approval. Any proven R-01/R-02 risk requiring behavior change needs a new exact method/file approval before application changes. P03 remains independent and unstarted.


## P02 Runtime Remediation Candidate — 2026-11-22 (NOT YET VERIFIED)

Authorized follow-up baseline: Gitea/GitHub `fd57a3518d14bcb8367ce9ab9c3ec306bcfc9898` (GitLab same tree). Local isolated branch `p02-runtime-remediation-20261122`, implementation commit `44eee8877e40d1683f44502c2a0ba3d437a03b88`. Scope: **server/index.js** (`pushEventsToRedisOrFallback`, `flushBuffer`), **server/socket/handlers.js** (sync_data/batch_sync ACK and claim rollback), **core/data/buffer.ts** (`flush`), **tests/phase02-sync.test.ts** and **tests/phase03-storage-buffer.test.ts** only, plus notes/001–006. All other source is unchanged.

**Candidate R-01 behavior:** when a configured Redis client returns an RPUSH error, `pushEventsToRedisOrFallback` retains RAM fallback but throws a sanitized `BUFFER_PERSIST_FAILED` instead of returning a durable-looking buffer count. Socket single/batch ACK returns `success:false`; best-effort Redis idempotency-key removal and bounded in-process negative-ACK marker handle ordinary retries. This is a **candidate** pending tests. When Redis is intentionally absent, historical RAM fallback is deliberately unchanged; it is not a universal durable-ACK guarantee. If Redis claim deletion fails and the server restarts, stale Redis idempotency claims could still misclassify a retry; a full crash-atomic claim/queue protocol is **not established** by this patch.

**Candidate R-02 behavior:** Port 4000 `flushBuffer` and Port 3000 `DataBufferEngine.flush` stream-parse existing CSV/CSV.gz partitions for same-client/date/event IDs before replaying any buffered Redis or RAM batch, dropping already-persisted IDs while retaining Redis queue until the write/check completes. Scan/read/parse exceptions fail closed before LTRIM. In-scope test adds a direct Port 4000 writer + Redis LTRIM-failure/recovery test and updates the existing web-buffer replay fixture. **Not proven globally exactly-once:** cross-process CSV writers outside the Redis flush lock and unknown archival/partial-corruption cases remain; scanning partitions on each flush also has real disk-I/O cost, requiring throughput evaluation before production promotion.

**Candidate acceptance:** one disposable Gitea CI with 24/24 suites, strict TS, lint, Linux/Windows clean npm CI and production build; direct Port4000 replay tests; exact allowlist/diff audit and three-remote tree parity. The Gitea MCP/host was unavailable on the implementation attempt, so this is **NOT PASSED** and the P02 phase remains **BLOCKED / NOT CLOSED**. No live deployment or runtime production mutation.
