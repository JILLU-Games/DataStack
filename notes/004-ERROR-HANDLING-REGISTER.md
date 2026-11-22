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
