# DataStack — Error Handling Inventory & Proposed Safety Gates

Source baseline: `d725841ebc828d58cbe90f517da9e600f23c4630`. This is an **implementation inventory**, NOT an independently executed production fault-injection certificate. Existing codes and APIs below are source-grounded.

## Existing handlers: observed code paths

| Failure / scenario | Exact path and lines | Current response / behavior | CI coverage/status |
|---|---|---|---|
| Missing/bad client ID | `app/api/events/route.ts:433-442` | `400 VALIDATION_ERROR` | TS suites; no live write |
| Deleted/missing/revoked client | `app/api/events/route.ts:445-474` | `403 CLIENT_REVOKED` | Auth regression passed in suite |
| Rotated token | `app/api/events/route.ts:476-487` | `401 TOKEN_ROTATED` | Auth/SDK regression coverage |
| Expired client token | `app/api/events/route.ts:489-504` | `401 CLIENT_TOKEN_EXPIRED` + webhook trigger | Python SDK tests pass |
| Disallowed IP | `app/api/events/route.ts:506-526`; `app/api/health/route.ts:82-91` | `403 CLIENT_IP_FORBIDDEN` | Source + TS regression |
| Disk low / client quota exhausted | `core/Storage/csvStorage.ts:1159-1193`; `app/api/events/route.ts:567-589` | `507 DISK_SPACE_LOW` or `STORAGE_QUOTA_EXCEEDED`; webhook | Python 14/14, TS related suite passed except stale UI assertion |
| Duplicate, payload oversize, rate limit | `app/api/events/route.ts:633-681` | dedupe; `413 PAYLOAD_TOO_LARGE`, `429 RATE_LIMIT_EXCEEDED`, `400 BATCH_REJECTED` | Regression suites |
| Socket buffer persistence exception | `server/socket/handlers.js:583-602` | `BUFFER_PERSIST_FAILED` callback **if onBufferPush throws**; success ACK after normal resolution | R-01 requires RAM-fallback failure injection |
| Redis distributed flush lock | `app/api/storage/route.ts:102-127` and :187-197 | `503 FLUSH_LOCK_TIMEOUT` on guarded flush | Existing TS test pass |
| Webhook disabled/blocked/redirect/timeout | `core/alerts/webhookNotifier.ts:94-176` | SSRF URL check, HMAC, timeout, manual redirect policy, per-client cooldown | Source + TS security tests |
| Admin cookie integrity/revocation | `core/auth/adminSession.ts:70-154`; `app/api/auth/**` | HMAC verified session with tokenVersion support; 401/403 boundaries | Auth TS regression passed |
| MCP permissions / filesystem sandbox | `server/mcp/mcpEngine.js:12-50,167-248` | 17 granular permissions; writes disabled default; path jail/symlink rejects | MCP server suite passed |
| Python SDK typed error mapping | `sdk/python/datastack/datastack/exceptions.py:8-84` | Auth/config/quota/payload/file errors mostly non-retryable, connection/rate retryable | Windows Python CI 14/14 |
| Public liveness health | `server/index.js:1939-1956`; `app/api/health/route.ts:95-111` | `online` reflects responder; not full transactional readiness | Public endpoint GET online only |

## Missing / not proven handling — proposals, NOT implemented

| Gate | Existing evidence | Narrow proposed addition | Risk / invariant |
|---|---|---|---|
| EH-01 Durable ACK under Redis loss | `server/index.js:165-193` RAM fallback; `server/socket/handlers.js:583-602` ACK | Test Redis RPUSH failure followed by crash. If confirmed, add reliable negative ACK/persist-queue contract with focused regression. | Preserve SDK fallback/spooling & existing auth/ack fields |
| EH-02 Partial CSV replay duplication | `server/index.js:981-994` write before trim | Crash/replay fault test; clarify at-least-once vs exactly-once and idempotent recovery strategy. | Do not silently drop events or rewrite existing CSV |
| EH-03 Degraded readiness | `/health` source | Keep existing public liveness backward compatible; optionally protected readiness with PG/Redis/disk dependency evidence. | No public status/availability semantic regression |
| EH-04 Docker runner filesystem | CI #50 containerd lstat error | Capture runner snapshotter/storage/logs and BuildKit proof, retry only affected job once on clean isolated builder. | No production Docker prune or volume change |
| EH-05 Linux Python provisioning | CI #45 apt 404 | Use stable Python runner or existing Windows 14/14 job in canonical CI matrix. | No change to Python SDK package semantics |
| EH-06 Supply-chain advisory details | CI #50 24/26 summaries | Generate advisory ID/package/version/production-path inventory, apply compatible pinned patches only when justified. | No blanket major upgrades, no `audit fix --force` |
| EH-07 WebSocket origin/defaults | `server/index.js:1086-1089` | Document access control and test raw WS handshake plus verified JWT behavior; adjust only with repro and approval. | Avoid breaking legitimate SDK cross-origin connection |

## Mandatory error-handling acceptance matrix (disposable only)

- 401 invalid/expired/rotated JWT, 403 revoked/IP forbidden, 400 bad client ID, 413 oversized event, 429 rate limit, 507 quota/disk low, 503 flush-lock timeout: contract and safe error payload tests.
- Verify duplicate rejection across HTTP + Socket.IO, Redis outage/resume, multi-client isolation, process crash and CSV replay boundaries.
- Verify Python/Node SDK retryability: auth and quota failures never endlessly retry/spool; temporary network errors backoff/spool safely.
- Webhooks: URL SSRF/private/cloud metadata reject, redirects rejected, signatures match, bounded timeout/cooldown.
- MCP: disabled by default, read vs write permissions, bearer hashing, IP allowlist, sandbox traversal and symlink reject, no secret emission.
- Do not run these failure injections against `https://data.ivib.cc/`. Use disposable CI fixtures/data directories/Redis containers only.

## P01 dependency-install blocker note (2026-11-22)

Gitea run #58 failed before application error-handling tests because clean npm install found an unresolved transitive lock entry: `@tybys/wasm-util@0.10.5`. No runtime error-handling paths were changed or re-verified in this run. Existing source-level handler inventory remains unchanged; P02 fault-injection gates are **NOT STARTED**.

## Change control

Any new error code, status, SDK public exception or alert flow is **feature/API behavior change**: STOP and request explicit new scope approval. This register is documentation for deciding whether a new handler is warranted, not blanket authorization to add handlers.

## P01 Closure Verification (2026-11-22)

The previous #58 package-lock error was resolved by adding the exact nested optional `@tybys/wasm-util@0.10.5` lock entry without changing the 1293 original locked packages. Gitea #59 clean installs and all **24/24** TypeScript regression suites passed; #59 had a single test-only TS2339 mock-type declaration error, corrected in scope and verified by **#60 strict TypeScript + ESLint PASS**. P01 made **zero changes** to runtime error-handler implementation, response codes, auth, SDK error classification, telemetry behavior or UI. Existing handler inventory remains valid as source observations. P02 R-01…R-03 fault-injection and P03 infrastructure/security remain unverified; do not claim production fault tolerance from P01.


## P02 R-01–R-03 Diagnostic Addendum — 2026-11-22

| Gate | Injected failure / expected observation | Scope / remediation gate |
|---|---|---|
| R-01 Redis durability | Mock `rpush` rejects; in-process websocket `sync_data` ACK may still return `success:true` while the event exists only in RAM. A simulated RAM reset (not killing live services) shows unrecoverable ACKed event if Redis remained empty. | `server/index.js:165-193,1897-1923`, `server/socket/handlers.js:583-602` **READ ONLY**. A correction to ACK/persist/spooling semantics requires explicit approval. |
| R-02 CSV replay | Mock Redis LTRIM fails **after** CSV append. Retrying buffered event may write same `eventId` twice, exposing duplicate amplification under persistent failures. | Test the web-side `DataBufferEngine.flush` CSV-before-trim pattern; direct ingestion writer proof remains separate. Deduplication scheme or exactly-once guarantees require explicit approval. |
| R-03 availability | Redis `llen` rejection leaves Express `/health` online with `redisConnected:false`. Recovery flips the flag while HTTP 200 remains unchanged. | Public 200 is liveness by existing contract; a protected dependency readiness probe/503 is **not implemented** and needs explicit approval. |

Security invariants: do not expose secrets in ACK/errors, keep JWT/auth and 401/403/429/503/507 contracts unchanged, and never run failure-injection against actual Redis, Postgres, production API, live events, or user CSV. Disposable fake Redis and temporary files only. CI #63: https://dev.ivib.cc/vibtools/DataStack/actions/runs/63; results tracked in notes/003.


## P02 Runtime Candidate — Error-path change inventory (pending CI)

| Path | Candidate result | Explicit limitation |
|---|---|---|
| Redis `RPUSH` rejects with configured Redis client | Retains event in volatile RAM as preexisting fallback but returns `BUFFER_PERSIST_FAILED` to Socket.IO via thrown error; **no successful ACK** for that failure; error text does not expose connection details | No-Redis intentional legacy RAM mode unchanged, still not a durable guarantee |
| `sync_data` and `batch_sync` failures | `success:false`, `code:BUFFER_PERSIST_FAILED` and best-effort rollback of previously claimed idempotency keys, negative failure marker for in-process retries | If claim rollback cannot reach Redis and process crashes, durable claim/queue atomicity remains unsolved |
| Redis buffer `LTRIM` rejects after successful CSV append | Subsequent flush checks physically stored CSV IDs and avoids appending matching rows again; Redis is trimmed only after successful check/write | Concurrent independent CSV appenders, compressed archived CSV, corrupt partial rows, and per-flush CSV scan cost require separate proof |
| Legacy public health | **UNCHANGED** HTTP 200 liveness contract and Redis-connected diagnostic field; R-03 readiness is not introduced in this approval | Does not prove full DB/Redis transactional readiness |

Security/API invariants: leave token/JWT/auth/rate limits/quotas/webhooks/MCP/sandbox/UI/SDK unchanged. No production Redis/Postgres/API/CSV mutation. No lockfile/dependency versions or CI workflow changes. CI acceptance remains pending; these are code-level observations, not release certification.


## P02 Final Fault / Recovery Matrix

| Case | Final behavior target and evidence |
|---|---|
| Redis RPUSH rejects with Redis configured | `BUFFER_PERSIST_FAILED` negative ACK, no false durable success; candidate CI #66 verified single/batch, final CI #69 for marker TTL |
| Redis idempotency claim survives failed queue write | Positive-time separate failed marker survives cleanup after +61000ms (below five-minute TTL); two retries remain negative rather than `DUPLICATE_DROPPED` success. Final disposable fixture `tests/phase02-sync.test.ts` |
| Mixed `batch_sync` contains stale claim and a new durable record | Overall response `success:false` with `BUFFER_PERSIST_FAILED`, even if some new records committed; preserve counts and avoid success cover-up |
| Redis deliberately disabled | Historical RAM mode unchanged; distinguish this existing best-effort contract from configured Redis durability |
| CSV append success but Redis LTRIM failure | Replay scans written event IDs and does not duplicate physical row before trim; direct Port4000 and web-buffer regression |
| Rotated / gzip CSV, quoted multiline payload | Streaming CSV parser, exact client/date/eventId match, no duplicate append or data-format change |
| Matching CSV partial/corrupt | Fail closed (no Redis trim); disposable repair allows retry; do not touch real user CSV |
| Public /health & 401/403/429/503/507 | Preserve existing behavior; no new endpoint or error contract beyond already approved BUFFER_PERSIST_FAILED |

**Limitations:** no globally atomic Redis+CSV transaction, stale Redis claim after process crash may require TTL/retry policy, and per-partition scan has data-size-proportional I/O even though memory is streamed. No live production reliability or throughput certification. CI #66 SUCCESS; final CI #69 pending.


### Additional P02 final-acceptance negative ACK case

If a `batch_sync` contains only (a) an uncommitted Redis-claim duplicate and (b) an ordinary already-durable duplicate, the old `processed===0 && duplicates===0 && rejected>0` test did not trigger; success ACK incorrectly masked volatile claim. Narrow correction uses `if (volatileDuplicate)` before the generic aggregate success path, independent of `processed` or `duplicates`. Specific test in `tests/phase02-sync.test.ts` injects Redis RPUSH failure and fake stale claim then includes the existing durable duplicate. All pending-claim ACKs must remain `BUFFER_PERSIST_FAILED`, even if some other events already committed. Terminal CI #72 pending; no global 5-minute clock advancement inside sockets.


### P02 terminal CI #72 error handling acceptance

Gitea #72 **SUCCESS** at verified final code SHA `acca8be01a31f8d3972564cbaec8fd3117a0b551`; all 24 TS suites exit zero including stale claim, mixed batch (both with new durable event and old durable duplicate), Redis-free compatibility, gzip/rotated CSV and corrupt matching CSV fail-closed. `BUFFER_PERSIST_FAILED` is negative-ACK response on configured Redis write failure, rather than success for RAM fallback. Redis-free RAM mode old semantics unchanged. Existing 401/403/429/503/507 tests unaffected and pass within 24 suites. Public /health liveness remains HTTP 200 with `redisConnected:false` during mocked outage; separate readiness endpoint not approved. Remaining risk: no atomic Redis+CSV commit, no global exactly-once guarantee, CSV partition scan disk I/O grows with volume. No live traffic test.

## P03 runner/security defect register — 2026-11-22

- **CI-06:** `python:3.12-slim-bookworm` lacked Node for `actions/checkout@v4` (127). Approved workflow-only correction: `node:22-bookworm-slim` plus Debian Python 3.11 venv and prerequisites; narrow CI #78 **14/14 PASS**.
- **CI-07:** Historical classic Docker `COPY node_modules/@uiw` layer-export failure was not reproduced using disposable BuildKit builder; #77 Compose and 3/3 builds plus image inspect **PASS**; no Dockerfile modifications or shared prune.
- **CI-08:** **CI-08 security disposition:** `npm audit --json` full=26 affected packages (25 moderate, 1 high); runtime=24 (23 moderate, 1 high), **not counts of distinct advisories**. High-severity advisories [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) affect Next 15.5.29's nested `postcss@8.4.31` despite patched root `postcss@8.5.33`; npm recommends major `next@16.4.6`. Direct `cloudcmd@19.24.0` carries moderate transitive issues (`dompurify`, `file-type`, `glob`, `minimatch`, `got`); npm recommends `cloudcmd@17.0.2` downgrade, not a verified safe pin. No speculative package pin, major upgrade or force fix; a separately tested compatible remediation is needed before release.
- **Runtime API errors:** P02's 401/403/429/503/507, `BUFFER_PERSIST_FAILED` negative ACK, Redis/CSV replay behavior and public `/health` shape unchanged; no live production fault claims.

**Scope / release decision:** only `.gitea/workflows/datastack-ci.yml`, `.gitea/workflows/datastack-docker-ci.yml`, and `notes/001–006` changed. No `package.json`/lock, Dockerfile, application UI/UX, runtime, auth, SDK, database, Compose, production data, secret, shared Docker prune, deployment, migration, tag or release. P03 technical CI and advisory-triage acceptance verified by #77 non-Python jobs plus #78 Python; do **not** mislabel #77 overall as successful. Final phase publication requires one main commit and Gitea/GitHub/GitLab exact tracked tree parity. **Production release NO-GO** while runtime high advisory is unresolved; live production health, throughput and deployment remain unverified.

## P04-S01 blocked security reconciliation report

P04-S01 SEC-01 BLOCKED — 2026-11-22. Approved scoped `overrides.next.postcss=8.5.33` trialed in disposable Windows npm 10.9.8 workspace only. `npm install --package-lock-only` EXIT 0, but `npm ls --package-lock-only postcss --all` EXIT 1 (`ELSPROBLEMS`: Next nested `postcss@8.4.31` invalid; expected 8.5.33); npm dedupe also kept invalid dependency. Read-only `npm audit --omit=dev --json` EXIT 1, runtime high 1/moderate 23/critical 0. Lockfile regeneration caused unrelated churn (91 package entries added, 106 removed, 69 changed, including two lightningcss optional 1.33.0 -> 1.30.1). Fresh minimal Next 15.5.29 fixture with identical override resolves PostCSS 8.5.33, isolating failure to DataStack committed lock graph. `npm ci --dry-run` exit 0 does not prove real clean install. Exact stop rule applied: no dependency patch, no CI acceptance, no main commit, no GitHub/GitLab sync, no release/deploy; production NO-GO. Need separate explicit narrowly scoped lock reconciliation approval.

Do not treat successful npm install/dedupe/dry-run as security or compatibility validation. High PostCSS remains reachable through lock graph, no runtime handlers or error codes touched.

## P04-S01B exact failed acceptance condition — 2026-11-22

PostCSS resolution fixed within disposable test copy, with audit high/critical 0, but lockfile metadata integrity requirement **FAIL**: npm wrote 67 unrelated package-entry metadata differences. No API error/ACK behavior touched. Existing peer dependency warning for `@putout/eslint@6.1.1` versus ESLint 9 is non-blocking in the isolated lock generation and not permission to upgrade it. Stop before acceptance CI or source edit; production/main lock and security-audit workflow remain unchanged.

## P04-S01C security gate and error contract — 2026-11-22

SEC-01 candidate remediation verified: Next 15.5.29/Cloudcmd 19.24.0 unchanged, PostCSS 8.5.33 deduped, nested vulnerable PostCSS removed without unrelated dependency integrity/metadata drift. Focused CI #85 read-only audit: full affected packages moderate=24/high=0/critical=0; runtime moderate=22/high=0/critical=0, and `DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO` succeeded. New gate fails on incomplete severity counts and any runtime high/critical. Moderate Cloudcmd transitive issues intentionally remain P04-S02. No JWT/auth, HTTP/socket error codes, Redis durability, CSV replay, SDK/API/UI or production health changes; Windows CI still queued and publication pending.

## P04-S01C FINAL CI acceptance (7/7) — 2026-11-22

Gitea CI #85 https://dev.ivib.cc/vibtools/DataStack/actions/runs/85 COMPLETED/SUCCESS; tested implementation SHA c759be990c032c2474d2d0bad519c643dec11a3a; later changes to candidate are documentation only. All seven jobs terminal SUCCESS: node-regression (Linux committed-lock npm ci and exactly 24/24 TypeScript suites); python-regression (Ran 14 tests, OK); quality (strict tsc and ESLint); production-build (Next 15.5.29 standalone, 22/22 pages); docker-image-build (three isolated BuildKit ingestion/web/proxy images); windows-compatibility (Windows committed-lock npm ci and Node SDK build, job #182, terminal SUCCESS); security-audit (runtime moderate=22 high=0 critical=0; full moderate=24 high=0 critical=0; DATASTACK_RUNTIME_SECURITY_HIGH_CRITICAL_ZERO). Single Gitea acceptance run used, no additional broad reruns.

Security improvement: remove Next nested vulnerable PostCSS and enforce runtime high/critical fail gate. Existing 22 moderate runtime affected-package entries remain, not a security-clean claim for all severities. No change to runtime error codes/auth/API contracts. CI fully accepted; publication not yet asserted in these pre-merge notes. Final phase CLOSED requires one squash merge of PR #5 into Gitea main and verified identical tracked content across Gitea/GitHub/GitLab; record actual new SHAs in terminal report. Production release remains NO-GO pending P04-S02 moderate vulnerability triage and separately authorized live readiness verification.
