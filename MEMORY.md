# MEMORY.md — DataStack Cross-IDE Persistent Project Memory

> **Last Synchronized**: 2026-11-20  
> **Status**: **R3 Production Remediation (`BASELINE-2026-11-20-R3`): `3 / 4` Phases Complete (`12 / 16` Bugs Resolved — `R3-Phase-01`, `R3-Phase-02`, & `R3-Phase-03` Verified Complete; `R3-Phase-04` ready for `Proceed to R3-Phase-04`).**  
> **Scope Rule**: Maintain this file accurately across VS Code, Google Antigravity, Cursor, and any other IDE after every modification, feature update, or bug fix (see `.ai-rules` and `AGENTS.md`).

---

## 1. Project Identity & Core Principles
- **Project**: **DataStack** — Self-hosted, real-time telemetry ingestion, admin governance (`/vcon/*`), and partitioned CSV storage/export platform.
- **Runtime Split (CRITICAL)**:
  - **Port `3000` (`web`)**: Next.js 15 App Router — public landing (`/`), PWA lifecycle, `/vcon/*` Admin Console, REST ingestion (`POST /api/events`), metrics/settings/client APIs, and streaming exports (`GET /api/export`).
  - **Port `4000` (`ingestion`)**: Dedicated Node.js Express 5 + Socket.IO server (`server/index.js`) — WebSocket handshakes, JWT client auth, rate limiting, idempotency deduplication, Redis/RAM batching, and CSV flush worker.
  - Socket.IO connections NEVER run inside Next.js serverless routes; they run strictly on Port `4000`.
- **Storage & Database Boundary (CRITICAL)**:
  - **PostgreSQL (`pg` + `prisma/schema.prisma`)**: Stores strictly control-plane metadata (`admin_users`, `admin_login_attempts`, `client_sdks`, `deleted_clients`, `admin_settings`). **Never insert per-row telemetry events into PostgreSQL.**
  - **Partitioned CSV Storage (`/storage/data/{clientId}/{YYYY-MM-DD}.csv`)**: All ingested telemetry events flush in batches to daily partitioned CSV files with cooperative file locking, configurable size rotation (`fileRotationMb`, e.g., `-part2.csv`), and retention pruning (`autoPruneDays`).
  - **Redis (`ioredis`)**: Shared cross-process buffer queue (`datastack:buffer:events`), recent event cache (`datastack:recent:events`), and distributed flush lock (`datastack:flush:lock`). Persisted in Docker via `--appendonly yes` (`redisdata:/data`). Falls back gracefully to local RAM when `REDIS_URL` is omitted.

---

## 2. Tech Stack & Local Setup

### Stack
- **Frontend / Web API**: Next.js `15.4.9` (App Router, `output: "standalone"`), React `19.2.1`, TypeScript `5.9.3`, Tailwind CSS v4 (`@tailwindcss/postcss`), `lucide-react`, `motion`.
- **Ingestion Server**: Node.js `22` / Express `5.3.0`, Socket.IO `4.8.4`.
- **Persistence & Caching**: `pg` `8.23.1` (PostgreSQL 16 in Docker), `ioredis` `6.0.0` (Redis 7 AOF in Docker), `csv-parse` `7.0.3`, `json2csv` `6.0.0-alpha.2`.
- **Auth & Security**: `jsonwebtoken` `9.0.3`, Node `crypto.scrypt` password hashing, WebCrypto HMAC-SHA256 admin session cookies (`middleware.ts`), CSRF `Origin`/`Referer` vs `Host`/`X-Forwarded-Host` checks, `DATASTACK_INTERNAL_SECRET` timing-safe bridge auth between Port `3000` ↔ `4000`.
- **Client SDKs**: Official pip-installable Python SDK in `sdk/python/datastack/` (`datastack`) + backward-compatible wrapper `sdk-python/` (`datastack-sdk`).

### Environment & Setup Commands
1. **Configure Environment**: Copy `.env.example` to `.env` (in production `NODE_ENV=production`, all 4 secrets MUST be 32+ chars: `DATASTACK_ADMIN_SESSION_SECRET`, `DATASTACK_JWT_SECRET`, `DATASTACK_ADMIN_SETUP_KEY`, `DATASTACK_INTERNAL_SECRET`; optional `DATABASE_URL` and `REDIS_URL`).
2. **Install Dependencies**: `npm ci` (or `npm install`) using root `package.json` + `package-lock.json`.
3. **Run Locally (Two Terminals)**:
   - Terminal 1 (Port `3000`): `npm run dev`
   - Terminal 2 (Port `4000`): `npm run server`
4. **Build, Lint & Test Verification**:
   - Build: `npm run build`
   - Lint: `npm run lint` (`eslint .`)
   - TS Test Suite (Phases 01–03, 06, 07): `npx --yes tsx --test tests/phase01-auth.test.ts tests/phase02-sync.test.ts tests/phase03-storage-buffer.test.ts tests/phase06-pwa-landing.test.ts tests/phase07-deployment.test.ts`
   - Python SDK Tests: `python3 -m unittest tests/phase05_sdk_test.py`

---

## 3. Folder Structure & File Architecture

```text
datastack/
├── .ai-rules                      # Universal cross-IDE rules (enforces MEMORY.md sync)
├── AGENTS.md                      # Engineering rules, UI single-source-of-truth & memory sync
├── MEMORY.md                      # Persistent cross-IDE project memory (this file)
├── package.json / package-lock.json
├── middleware.ts                  # /vcon/* auth guard & Origin/X-Forwarded-Host CSRF enforcement
├── app/
│   ├── (landing)/page.tsx         # Public landing page
│   ├── globals.css                # Tailwind v4 + centralized CSS variables (--radius: 0rem, --shadow: none)
│   ├── layout.tsx / not-found.tsx / error.tsx
│   ├── api/
│   │   ├── auth/                  # Admin login, logout, setup (/vcon/setup), profile update
│   │   ├── clients/               # CRUD clients, token regeneration, revocation
│   │   ├── data/                  # Paginated CSV search/query across partitions
│   │   ├── events/                # Authenticated HTTP ingestion (single/batch/file records) & recent list
│   │   ├── export/                # Streaming CSV / JSON filtered export (UTC dates, optional flush=false)
│   │   ├── health/                # Web health + client Bearer token probe + async buffer depth
│   │   ├── metrics/               # Aggregated Port 3000 + Port 4000 + DB + CSV metrics
│   │   ├── settings/              # Allowlisted runtime config get/post + live Port 4000 sync
│   │   └── storage/               # CSV partition listing & manual cross-process buffer flush
│   └── vcon/                      # Protected Admin Console pages:
│       ├── dashboard/ clients/ data/ export/ login/ profile/ sdk/ settings/ setup/ simulator/ storage/
├── components/
│   ├── ui/                        # Single-source-of-truth UI primitives (Button, Input, Table, Modal, Panel, etc.)
│   ├── layout/                    # MainLayout, Navbar, Sidebar, VconShell, PageShell, AdminPageHeader, Footer
│   ├── sections/                  # Modular feature sections (DashboardOverview, ClientsTable, DataBrowser, ExportWorkspace, SettingsWorkspace, etc.)
│   └── pwa/                       # PwaLifecycle.tsx service worker registration
├── lib/
│   ├── adminAuth.ts               # Uniform API session guard (requireAdminApiSession) + proxy-safe extractClientIp()
│   ├── vconCache.ts               # In-memory SWR cache + clearAuthCaches() for logout/SW cleanup
│   └── vconUiHelpers.ts           # Pure Admin UI sync helpers (settings bounds, bridge sync, UTC presets, timestamps)
├── core/
│   ├── adminSettings/             # settingsManager.ts (DB hydration, Port 4000 sync, unhydrated prune guard)
│   ├── apiEngine/                 # apiService.ts (dashboard metrics & Port 4000 internal bridge queries)
│   ├── auth/                      # adminUsers.ts, adminSession.ts (scrypt, brute-force throttle, tokenVersion), jwt.ts
│   ├── data/                      # buffer.ts (Redis + RAM queue, distributed lock, graceful SIGTERM/SIGINT flush)
│   ├── Database/                  # database.ts (pg.Pool + idempotent DDL + additive ALTER TABLE guards)
│   ├── sdk/                       # sdkManager.ts (DB JWT hydration, client lifecycle, deleted_clients tombstone)
│   ├── Security/                  # security.ts (rate limit, maxPayloadSizeKb, idempotency, internal headers)
│   └── Storage/                   # csvStorage.ts (cooperative lock, rotation, cached streaming row count, prune)
├── scripts/
│   ├── dev-all.js                 # Local concurrent Next.js (3000) + Ingestion (4000) dev runner
│   └── start-all.js               # Production concurrent Next.js (`next start`) + Ingestion (`server/index.js`) runner
├── server/
│   ├── index.js                   # Express 5 + Socket.IO (Port 4000), /health, /internal/* bridge, PG sync, graceful exit
│   ├── socket/handlers.js         # Handshake JWT auth, ping_verify, sync_data, batch_sync
│   └── workers/csvWriter.js       # Partitioned CSV batch writer & rotation/pruning worker
├── sdk/python/datastack/          # Official pip-installable Python SDK (`datastack` v2.2.0)
│   ├── datastack/                 # client.py, config.py, heartbeat.py, spool.py, exceptions.py
│   ├── config.datastack.example.py
│   ├── pyproject.toml / setup.py
│   ├── README.md                  # SDK overview, installation, quickstart, docs index
│   └── docs/                      # Production SDK Documentation Suite (LicenX Standard):
│       ├── README.md              # SDK Documentation Hub & architecture overview
│       ├── INSTALLATION.md        # Python runtimes, pip commands, and verification
│       ├── QUICKSTART.md          # 5-minute zero-boilerplate onboarding guide
│       ├── API_REFERENCE.md       # Complete DataStack class & method specifications
│       ├── CONFIGURATION.md       # config.datastack.py & DATASTACK_* environment reference
│       ├── EXAMPLES.md            # IoT streaming, FastAPI, batching, and file ingestion
│       ├── ERROR_HANDLING.md      # Exception hierarchy, 401/403/413/429 codes & retries
│       └── LIFECYCLE.md           # 5-state machine, zero-CPU IDLE mode & offline spooling
├── sdk-python/                    # Backward-compatible re-export package (`datastack-sdk`)
├── docker/
│   ├── docker-compose.yml         # web, ingestion, proxy (Nginx), postgres (pgdata), redis (redisdata AOF)
│   ├── Dockerfile.web             # Multi-stage standalone Next.js build + safe /app/storage ownership check
│   ├── Dockerfile.server          # Multi-stage Port 4000 ingestion server + safe /app/storage ownership check
│   ├── Dockerfile.proxy           # Nginx reverse proxy container
│   └── coolify-nginx.conf         # Routes `/health` & `/socket.io/` -> `ingestion:4000`, `/` -> `web:3000`
├── nginx/default.conf             # Local Nginx proxy config matching coolify-nginx.conf
├── prisma/schema.prisma           # Reference PostgreSQL metadata schema
├── public/                        # PWA manifest.json, sw.js, icons (192, 512, maskable, apple-touch)
├── docs/                          # Comprehensive Production Documentation Suite:
│   ├── index.md                   # Primary documentation hub and portal navigation index
│   ├── MANIFEST.md                # Master documentation inventory & authoring governance
│   ├── audit-coverage-report.md   # Forensic codebase audit matrix & coverage report
│   ├── users/                     # End-User & Operator Guides:
│   │   ├── index.md               # User portal overview & reading pathways
│   │   ├── getting-started.md     # 5-minute fast-track operator onboarding guide
│   │   ├── installation.md        # Production Docker Compose, Coolify & volume guide
│   │   ├── configuration.md       # Environment variables & platform runtime settings
│   │   ├── features/              # Deep-dive guides: admin-console, client-management,
│   │   │                          # data-simulator, partitioned-storage, data-export
│   │   ├── workflows.md           # End-to-end operator journeys & disaster recovery
│   │   ├── troubleshooting.md     # Forensic error recovery, status codes & diagnostics
│   │   └── faq.md                 # Storage architecture & operational questions
│   ├── dev/                       # Developer & Contributor Guides:
│   │   ├── index.md               # Developer hub index & architectural principles
│   │   ├── architecture.md        # Dual-runtime blueprint, service bridge & storage
│   │   ├── codebase-structure.md  # File-by-file module, route & component inventory
│   │   ├── local-setup.md         # Local workstation setup & dual-terminal workflow
│   │   ├── api-reference.md       # Exhaustive REST API & Socket.IO specification
│   │   ├── database-schema.md     # PostgreSQL control plane & DDL migrations
│   │   ├── security.md            # Security architecture, scrypt, sessions & CSRF
│   │   ├── building-packaging.md  # Next.js standalone build & multi-stage Dockerfiles
│   │   ├── testing.md             # Automated test suites guide (node:test + unittest)
│   │   └── contributing.md        # Architectural rules, memory sync & PR checklist
│   └── reference/                 # Technical Reference Portal:
│       ├── index.md               # Technical reference index
│       ├── configuration-reference.md # Complete environment variable & setting bounds
│       ├── dependencies.md        # Runtime & dev dependencies audit with rationales
│       └── glossary.md            # Technical domain terminology & concept glossary
├── notes/                         # Production Remediation Governance & Scope-Lock Suite (`BASELINE-2026-11-20-R3`):
│   ├── README.md                  # Master governance index, 6-step execution workflow & phase approval commands
│   ├── FORENSIC_AUDIT_REPORT.md   # 100% raw-code verified audit (16 bugs: BUG-01..BUG-16) & Demo vs Prod matrix
│   ├── BASELINE_FREEZE.md         # Frozen baseline snapshot (`BASELINE-2026-11-20-R3`) & 1:1 bug alignment
│   ├── PRODUCTION_READINESS_SCOPE_LOCK.md # (Doc 001) Exact bug fix contracts & per-phase Scope Locks (`R3-Phase-01`..`04`)
│   ├── PRODUCTION_ROADMAP.md      # (Doc 002) Dependency-ordered A–Z 4-phase roadmap & burn-down tracker
│   ├── PHASE_EXECUTION_LOG.md     # (Doc 003) Live phase completion log (`0/4` complete in R3 cycle) & zero-drift guardrails
│   ├── ERROR_HANDLING_MATRIX.md   # (Doc 004) Active error-handling catalog & 7 planned fixes (`ERR-R3-01`..`07`)
│   └── ACTUAL_IMPLEMENTATION_STATUS.md # Ground-truth working vs completed-per-phase vs remaining ledger (16 items remaining)
└── tests/                         # Automated verification suites:
    ├── phase01-auth.test.ts       # Auth fail-closed, tokenVersion, brute-force lockout, Bearer revocation, CSRF
    ├── phase02-sync.test.ts       # Internal bridge auth, settings sync, JWT rotation kick, rate/security metrics
    ├── phase03-storage-buffer.test.ts # Redis durability, cooperative CSV locks, streaming row count, export filters
    ├── phase04-ui-sync.test.ts      # UI/API settings bounds, bridge status, UTC presets, timestamp & folder matching
    ├── phase05-packaging.test.ts    # Python/Node packaging parity, PEP 561 py.typed, Node engines & start-all exit
    ├── phase05_sdk_test.py          # Python SDK WebSocket/HTTP fallback, offline spool, file streaming, edge hardening
    ├── phase06-pwa-landing.test.ts  # PWA manifest/icons/sw + navigation routes
    └── phase07-deployment.test.ts   # Compose/Redis AOF, Nginx /health, lockfile, prune guard, shutdown flush
```

---

## 4. Active Features & Development Status

All planned hardening & deployment phases (**Phase-01 through Phase-07**) are **Complete & Verified**:

1. **Admin Authentication & CSRF Hardening (Completed — Phase-01)**
   - Fail-closed secret enforcement in `NODE_ENV=production` (`/vcon/setup` bootstrap via `DATASTACK_ADMIN_SETUP_KEY`).
   - Password hashing via `crypto.scrypt`, session invalidation via DB-backed `tokenVersion`, composite IP+email login lockout (`admin_login_attempts`), and strict `Origin`/`Referer` vs `Host`/`X-Forwarded-Host` CSRF verification.
2. **Real-Time Dual-Runtime Sync (Completed — Phase-02)**
   - Authenticated `/internal/*` bridge between Port `3000` and Port `4000` (`DATASTACK_INTERNAL_SECRET`, backward-compatible Coolify fallback).
   - Live settings & client updates (create/rotate/revoke/delete) propagate immediately; JWT secret rotation re-signs stored client tokens and disconnects active sockets safely.
3. **Redis Durability & Cooperative CSV Storage Engine (Completed — Phase-03)**
   - Shared Redis queue (`datastack:buffer:events`) with distributed flush lock (`NX PX`) where `LTRIM` executes strictly AFTER CSV write confirmation; automatic RAM fallback if Redis disconnects.
   - Cooperative partition file lockfiles (with stale-lock recovery), mtime/size-cached RFC 4180 streaming row counter, and filtered CSV/JSON exports (`GET /api/export`).
4. **Admin Console UI & Data/Export Workspace (Completed — Phase-04)**
   - Built with shared `components/ui/` and `components/layout/` primitives (`0rem` radius, zero shadows, Fluent/Segoe dark & light tokens).
5. **Production Python Client SDK (Completed — Phase-05)**
   - Supports single events (`send()`/`sync()`), auto-splitting/rate-limit-paced batches (`send_batch()`/`batch_sync()`), and direct file ingestion (`send_file()` for `.csv`, `.json`, `.jsonl`, `.ndjson` with SHA-256 deterministic `eventId`).
   - Automatic `config.datastack.py` discovery, WebSocket primary transport -> Heartbeat HTTP fallback -> `.datastack_spool/spool.jsonl` offline spool & auto-drain.
6. **PWA & Landing Integrity (Completed — Phase-06)**
   - Complete `public/manifest.json`, icons, `public/sw.js`, and root-relative navigation links.
7. **Docker / Coolify Deployment & Persistence Hardening (Completed — Phase-07)**
   - Redis AOF persistence (`redisdata:/data`), deterministic `package-lock.json` for `npm ci`, Nginx `location = /health` → `ingestion:4000`, `/api/health` container probes, non-blocking startup ownership check in Dockerfiles, unhydrated-DB `autoPruneDays` safety guard in `SettingsManager`, DB JWT hydration in `SDKManager`, graceful `SIGTERM`/`SIGINT` flush in `DataBufferEngine`, and non-destructive `ADD COLUMN IF NOT EXISTS` DDL guards.

- **Current Remediation Status (2026-11-18)**:
  - **Phase-01 Complete & Verified** (`BUG-A01`, `BUG-A02`, `BUG-A03`, `BUG-A04`, `BUG-A05`, `BUG-E02`):
    - Removed spoofable header/UA CSRF bypasses in `middleware.ts` and rejected `sec-fetch-site: cross-site`.
    - Enforced DB-backed `tokenVersion` session validation across `/vcon/*` layout (`app/vcon/layout.tsx` + `components/layout/VconShell.tsx`) and read/export APIs (`/api/data`, `GET /api/events`, `/api/export`, `/api/metrics`, `/api/storage`).
    - Prevented transient DB errors from triggering false `/vcon/setup` redirects and prevented swallowed `NEXT_REDIRECT` errors on `/`, `/vcon/login`, and `/vcon/setup`.
    - Standardized `SDKManager.normalizeClientId`, blocked deleted/unregistered clients on `/api/health` and Admin `POST /api/events`, hardened `POST /api/clients` & `PATCH /api/clients/[id]` input validation, and excluded `/vcon/*` from Service Worker caching with `CLEAR_AUTH_CACHE` on sign-out.
    - Verified: `26/26` TS tests, `3/3` Python tests, `npm run build` clean, `eslint .` clean, Playwright browser auth/logout E2E clean.
  - **Phase-02 Complete & Verified** (`BUG-B01`–`BUG-B05`):
    - Enforced fail-closed client verification in `server/index.js` (`verifyClientInDb`) backed by PG, deletion tombstones, Redis `datastack:clients:*` mirrors, and normalized `clientId` keys across both runtimes.
    - Added cross-runtime Redis idempotency (`datastack:idem:*`) and fixed-window rate limiting (`datastack:rl:*`) in `core/Security/security.ts` (`validateEventAsync`) and `server/socket/handlers.js` (`validateSingleEventAsync`) with automatic local RAM fallback.
    - Surfaced bridge sync telemetry (`BridgeSyncResult`, `SettingsBridgeSyncStatus`, `runtime.ingestionBridgeStatus`, `POST /api/settings` `bridgeSync`) and normalized `SDKManager.incrementEventCountAsync()`.
    - Fixed Socket `sync_data` flat payload preservation (`extractSingleEventData`), reconciled `PORT_SOCKET`/`PORT` precedence and live `/internal/metrics` ports, and added concurrent production `scripts/start-all.js` for `npm start`.
    - Verified: `29/29` TS tests, `3/3` Python tests, `npm run build` clean, `eslint .` clean, Playwright browser check (`/vcon/dashboard`, `/vcon/settings`, `/api/metrics`) clean with `0` console errors.
  - **Phase-03 Complete & Verified** (`BUG-C01`–`BUG-C06`):
    - Hardened Redis flush lock TTL (`30000ms`), added in-process `activeFlushPromise` coalescing with a `flushDone` identity guard (`core/data/buffer.ts`, `server/index.js`), isolated `redis.rpush` from best-effort `REDIS_RECENT_KEY`, and logged malformed buffered JSON warnings.
    - Enforced `sanitizeClientId()` path containment and `lstat` symlink exclusion, unique lock owner tokens (`${pid}:${ts}:${uuid}`), atomic `rename` stale-lock takeover, owner-verified lock unlock, and structured `JSON.stringify([clientId, date])` partition grouping in `core/Storage/csvStorage.ts` and `server/workers/csvWriter.js`.
    - Fixed trailing newline blank-row prevention (`fileEndsWithNewline`), proactive size-boundary rotation (`-partN.csv`), `StringDecoder('utf8')` streaming row counting, cooperatively locked `pruneExpiredPartitions`, and 1-hour `PRUNE_COOLDOWN_MS` in `core/adminSettings/settingsManager.ts`.
    - Enforced `parser`/`fileStream` destruction in `finally` blocks across `/api/data`, `GET /api/events`, and `/api/export`, error propagation inside `makeExportStream`, `502` surfacing on Port `4000` flush failure in `/api/export`, normalized `clientId` filtering, numeric timestamp sorting (`parseTimestampMs`), and `?format=json` / `?includeHeader=false` parity for `?filename=` exports.
    - Verified: `32/32` TS tests, `3/3` Python tests, `npm run build` clean, `eslint .` clean, Playwright browser check (`/vcon/dashboard`, `/vcon/data`, `/vcon/storage`, `/vcon/export`, `/api/data`, `/api/storage`, `/api/export`) clean with `0` console errors.
  - **Phase-04 Complete & Verified** (`BUG-D01`–`BUG-D07`):
    - Extracted pure UI synchronization helpers in `lib/vconUiHelpers.ts` (`SETTINGS_LIMITS`, `normalizeEditableSettings`, `describeSettingsBridgeSync`, `mapBridgeStatusToSocketUiState`, `parseEventTimestamp`, `formatEventTimeLabel`, `getUtcDateRangeForPreset`, `matchesSelectedClientFolder`, `extractContentDispositionFilename`).
    - Updated `components/sections/SettingsWorkspace.tsx` (`BUG-D01`) to probe `/api/metrics` honestly (removing false `/api/health` fallback), surface `bridgeSync` warning/error toasts on save, align integer bounds with `/api/settings` (`1..100000`, `1..10240`, `0..3650`), and eliminate the startup `serverPort` double-fetch.
    - Updated `app/vcon/storage/page.tsx` (`BUG-D02`) and `components/sections/ExportWorkspace.tsx` (`BUG-D03`) with `cache: 'no-store'`, `401` redirects, UTC preset ranges, normalized client folder filters, and fetch+Blob downloads with `502`/JSON error surfacing.
    - Updated `components/sections/DashboardOverview.tsx` (`BUG-D04`) and `components/sections/DataBrowser.tsx` (`BUG-D05`) with `ingestionBridgeStatus` display, `auth_error` alert banner, safe ISO/epoch-ms timestamp formatting, invalid date-range guard, and Enter-key filter submission.
    - Updated `components/sections/NewClientModal.tsx`, `components/sections/ClientsTable.tsx`, `app/vcon/simulator/page.tsx`, `app/vcon/sdk/page.tsx`, `components/sections/ProfileWorkspace.tsx`, and `components/layout/Sidebar.tsx` (`BUG-D06`, `BUG-D07`) with `1..100000` rate limit parity, live `runtime.serverPort` sync, real HTTP batch ingestion in Simulator, password bounds check, and `datastack:profile-updated` live Sidebar sync.
    - Verified: `37/37` TS tests (`tests/phase04-ui-sync.test.ts`), `3/3` Python tests, `npm run build` clean, `eslint .` clean, Playwright browser check across all Admin Console routes clean with `0` console errors.
  - **Phase-05 Complete & Verified** (`BUG-E01`, `BUG-E03`, `BUG-E04`):
    - Hardened canonical Python SDK (`sdk/python/datastack/datastack/*`): normalized `CLIENT_ID` comparison (`_normalize_client_id`), sanitized ragged CSV extra columns (`restkey="_extra"`), accurate `send_file()` `success` + `unprocessedItems`, partial-batch `rateLimitedEventIds` retry exception fallback, `DataStackConfigError` wrapping for malformed numeric env/config values (`config.py`), concurrent `stop()` vs `set_idle_connected()` race fix + clean thread join (`heartbeat.py`), `os.fsync` + orphan `.tmp` unlink + warning logs (`spool.py`), and PEP 561 `py.typed` marker.
    - Aligned packaging metadata across `sdk/python/datastack/pyproject.toml`, `sdk/python/datastack/setup.py`, and `sdk-python/setup.py`, coordinated child-exit shutdown in `scripts/start-all.js`, and added `engines.node >=20.0.0` in `package.json`.
    - Verified: `39/39` TS tests (`tests/phase05-packaging.test.ts`), `6/6` Python tests (`tests/phase05_sdk_test.py`), `py_compile`, `npm run build`, and `eslint .` clean.
  - **Previous Remediation Cycle (2026-11-18)**: Completed Phases 01–05 (`39/39` TS tests, `6/6` Python tests).
  - **New Production Hardening Cycle (`BASELINE-2026-11-19`)**:
    - Re-audited entire codebase from raw source code (`notes/FORENSIC_AUDIT_REPORT.md`): **29** verified bugs/mismatches (`4` Critical, `8` High, `13` Medium, `4` Low).
    - **Phase-01 Complete & Verified (`2026-11-19`)** (`BUG-01`, `BUG-04`, `BUG-05`, `BUG-06`):
      - Blocked volatile RAM admin creation in production without `DATABASE_URL` (`AdminDatabaseRequiredError`), surfaced production DB warning on `/vcon/setup`, and mapped pre-setup login to `409 SETUP_REQUIRED`.
      - Added brute-force attempt throttling (`429` + `Retry-After`) and completion-first ordering to `POST /api/auth/setup`.
      - Added server-side `token_version` revocation (`revokeAdminSessions()`) on `POST /api/auth/logout`, removed client `Origin` trust from cookie `Secure` flag, and added `sec-fetch-site: same-origin` CSRF fallback.
      - Prevented empty production `jwt_secret` persistence in PG and replaced silent DB write `catch {}` swallows in `SettingsManager` and `SDKManager` with `DATABASE_WRITE_FAILED` propagation and safe RAM rollback.
      - Verified: `43/43` TS tests, `6/6` Python tests, `npm run build`, `eslint .`, and Playwright login/logout revocation check clean.
    - **Phase-02 Complete & Verified (`2026-11-19`)** (`BUG-02`, `BUG-03`, `BUG-17`, `BUG-22`):
      - Protected Port 4000's `inMemoryClientRegistry` from empty Port 3000 `bulk_sync` wipes (`!forceReplace`), exposed `inMemoryClients` on `/internal/metrics`, added non-destructive hydration in `SDKManager` (`listClientsAsync`, `getClientAsync`, `syncAllClientsToIngestionAsync`), and auto-reconciled Port 4000 cold starts in `ApiEngine.getDashboardMetrics()`.
      - Ordered `SettingsManager.updateSettingsAsync()` JWT rotation to sync Port 4000 *before* committing Port 3000 RAM/PG/re-sign, aborting fail-closed (`JWT_ROTATION_BRIDGE_FAILED`) on bridge rejection/prod unreachable, rolling back Port 4000 on PG/re-sign error, and adding a 60s dual-secret grace window in `server/index.js` `requireInternalAuth()`.
      - Added authenticated `POST /internal/security-check` on Port 4000 (backed by zero-copy `validateSingleEventLocal`) so Port 3000 HTTP `SecurityEngine.validateEventAsync()` shares rate limits & idempotency with Port 4000 WS even without Redis, and exposed explicit `securityMode` (`redis_shared` | `bridge_coordinated` | `degraded_local`) in `/api/metrics`.
      - Replaced per-event PG `UPDATE client_sdks` queries on both Port 3000 (`SDKManager`) and Port 4000 (`server/index.js`) with 1s coalescing in-memory deltas flushed via batched `UNNEST` SQL updates (flushed on reads and graceful shutdown).
      - Verified: `47/47` TS tests, `6/6` Python tests, `npm run build`, and `eslint .` clean.
    - **Phase-03 Complete & Verified (`2026-11-19`)** (`BUG-18`, `BUG-19`, `BUG-20`, `BUG-29`):
      - Added bounded Redis flush lock wait/retry, periodic Lua `PEXPIRE` TTL renewal with ownership fencing before `LTRIM`, and explicit `FLUSH_LOCK_TIMEOUT` (`503` on `/internal/flush`) across both `core/data/buffer.ts` and `server/index.js`.
      - Added full deleted-client buffer purge (`DataBufferEngine.purgeClientEventsAsync`, Port 4000 `purgeClientFromLocalBuffer`) plus flush-time and recent-read tombstone filtering so deleted client directories never resurrect on subsequent flushes; ordered `SDKManager.deleteClientAsync()` to purge buffers and sync Port 4000 before deleting disk files.
      - Converted `server/index.js` `onBufferPush` to `async` and awaited it before firing Socket.IO ACK callbacks in `server/socket/handlers.js` (`sync_data` and `batch_sync`), returning `BUFFER_PERSIST_FAILED` on persistence error.
      - Unified canonical CSV storage root resolution via `DATASTACK_STORAGE_DIR` (`resolveDefaultStorageDir()`) across `core/Storage/csvStorage.ts`, `server/workers/csvWriter.js`, `core/sdk/sdkManager.ts`, and `.env.example`.
      - Verified: `51/51` TS tests, `6/6` Python tests, `npm run build`, and `eslint .` clean.
    - **Phase-04 Complete & Verified (`2026-11-19`)** (`BUG-21`, `BUG-23`, `BUG-24`):
      - Aligned HTTP `POST /api/events` single-event envelope stripping 1:1 with Port 4000 WS `sync_data` and eliminated fabricated `{ sample, rand }` telemetry on empty `{}`.
      - Converted `GET /api/data` directory/stat scans to non-blocking async `node:fs/promises` with newest-first date-partition pruning, and scaled `REDIS_RECENT_LIMIT` boundedly (`500..5000`) via `resolveRedisRecentLimit()` / `DATASTACK_RECENT_LIMIT` across Port 3000 & Port 4000.
      - Replaced all `Math.random()` client secrets (`crypto.randomBytes(16)`) and fallback `eventId`s (`crypto.randomBytes(6)`) with CSPRNG across `core/sdk/sdkManager.ts`, `app/api/events/route.ts`, and `server/socket/handlers.js`.
      - Unified canonical PostgreSQL metadata DDL (`CORE_SCHEMA_TABLE_DDLS` + `CORE_SCHEMA_ALTER_DDLS` + `ensureCoreSchemaOnPool()`) in `core/Database/database.ts`, delegated `core/auth/adminUsers.ts` to it, mirrored all 5 tables + 3 additive `ALTER TABLE` guards 1:1 in standalone `server/index.js`, and documented canonical `pg` ownership in `prisma/schema.prisma`.
      - Verified: `55/55` TS tests (`tests/phase04-ingestion-hygiene.test.ts` added), `6/6` Python tests, `npm run build`, and `eslint .` clean.
    - **Phase-05 Complete & Verified (`2026-11-19`)** (`BUG-07`, `BUG-08`, `BUG-09`, `BUG-14`):
      - Fixed Simulator HTTP `Burst 10` to send canonical `{ clientId, batch }` (with `events` batch alias & explicit `accepted` count in `POST /api/events`) and summarize exact server-confirmed counts via `summarizeHttpBatchResult()` without `res.ok ? count : 0` falsification.
      - Fixed `parseEventTimestamp()` & added `getEventUtcDate()` in `lib/vconUiHelpers.ts` for integer and fractional epoch-seconds (`< 1e11 * 1000`) 1:1 with backend CSV parsers.
      - Added pending-queue-only `getPendingBufferedSummary()` (`?bufferedOnly=true` / `?includeBufferedSummary=true`) and fair multi-client partition scanning (`selectRecentPartitionFiles()`, lifting the global 5-file cap) in `GET /api/events`.
      - Updated `ExportWorkspace.tsx` to match buffered events strictly against active client/date filters via `countMatchingBufferedEvents()` (preventing empty filtered header downloads) and refresh `/api/storage`, `/api/metrics`, and `vconCache` immediately post-export; updated `DashboardOverview.tsx` to attribute strictly UTC-today buffered events to `Events today` and call `await refresh()` after Quick Export.
      - Verified: `58/58` TS tests, `6/6` Python tests, `npm run build`, `eslint .`, and Playwright E2E browser check (`/vcon/simulator`, `/vcon/export`, `/vcon/dashboard`, `0` console errors/warnings) clean.
    - **Phase-06 Complete & Verified (`2026-11-19`)** (`BUG-10`, `BUG-11`, `BUG-12`, `BUG-13`, `BUG-15`, `BUG-16`):
      - Returned explicit `SESSION_EXPIRED` / `AUTH_UNAVAILABLE` vs `INVALID_PASSWORD` codes in `/api/auth/profile`, replaced dead `401 && !currentPassword` redirect with `shouldRedirectProfileUnauthorized()`, and formatted `Session Expires` with calendar date + 24h time (`formatSessionExpiryLabel()`).
      - Added opt-in `?purgeFiles=true` checkbox in `ClientsTable.tsx` client deletion modal and removed the misleading unused `Secret key` row from `CredentialsDisplay`.
      - Refactored `SettingsWorkspace.tsx` numeric inputs to string drafts (`NumericSettingDrafts`) validated inline via `validateEditableSettingsDraft()` (`noValidate` submit + tab jump to first invalid field, zero snap-to-`0`, zero silent clamping) and clarified `Socket port (PORT_SOCKET)` as read-only runtime config.
      - Unified public endpoint resolution (`resolvePublicEndpoints()`) across `SettingsWorkspace`, `/vcon/sdk`, and `/vcon/simulator` (consistent on port-80 `localhost` proxies) and updated `SdkSection.tsx` + `/vcon/sdk` with external path/wheel `pip install` guidance.
      - Added pre-hydration `datastack-theme` bootstrap script + `suppressHydrationWarning` in `app/layout.tsx` (zero light-mode FOUC) and theme restoration/toggle in `AdminSetup.tsx`.
      - Upgraded `public/sw.js` (`datastack-cache-v3`) with an uncached `503` HTML offline navigation fallback shell (`buildOfflineShellResponse()`, `Cache-Control: no-store`) for `/vcon/dashboard` and public navigations.
      - Verified: `64/64` TS tests, `6/6` Python tests, `npm run build`, `eslint .`, and Playwright Chromium E2E check (`/vcon/profile`, `/vcon/clients`, `/vcon/settings`, `/vcon/sdk`, Light Mode reload, `0` console errors/warnings) clean.
    - **Fresh Post-Phase-07 Forensic Audit & Baseline Freeze (`BASELINE-2026-11-19-R2`)**:
      - Previous `Phase-07` hardening (`BUG-25`–`BUG-28`) landed in Python SDK (`client.py`), legacy `sdk-python`, `scripts/start-all.js` / `dev-all.js`, `nginx/default.conf`, `server/index.js`, `docker/docker-compose.yml`, and `.env.example`.
      - Conducted a brand-new 100% raw-source-code audit (`notes/FORENSIC_AUDIT_REPORT.md`) identifying **18 verified remaining bugs** (`0` Critical, `6` High, `8` Medium, `4` Low).
      - Frozen baseline (`BASELINE-2026-11-19-R2`) and created the complete 7-document governance & Scope-Lock suite in `notes/` (`README.md`, `BASELINE_FREEZE.md`, `PRODUCTION_READINESS_SCOPE_LOCK.md`, `PRODUCTION_ROADMAP.md`, `PHASE_EXECUTION_LOG.md`, `ERROR_HANDLING_MATRIX.md`, `ACTUAL_IMPLEMENTATION_STATUS.md`).
      - **R2 Phase-01 Complete & Verified (`2026-11-19`)** (`BUG-01`, `BUG-02`):
        - Moved same-origin CSRF enforcement in `middleware.ts` ahead of the public-route early return so `POST /api/auth/login` and `POST /api/auth/setup` reject cross-origin/missing-origin requests with `403` while preserving same-origin browser submissions, `sec-fetch-site: same-origin` fallback, safe `GET` routes, and Bearer `POST /api/events`.
        - Extracted shared reverse-proxy-safe `extractClientIp()` in `lib/adminAuth.ts` (trusting `x-real-ip` first, then rightmost non-empty `x-forwarded-for` hop) and wired it into both `app/api/auth/login/route.ts` and `app/api/auth/setup/route.ts` to block spoofed-XFF brute-force lockout bypasses.
        - Verified: `14/14` `tests/phase01-auth.test.ts` pass, `npm run build`, `npm run lint`, live HTTP `403`/`401` CSRF probes, and Chromium `/vcon/login` → `/vcon/dashboard` E2E (`0` errors).
      - **R2 Phase-02 Complete & Verified (`2026-11-19`)** (`BUG-05`, `BUG-06`, `BUG-07`, `BUG-08`, `BUG-09`, `BUG-10`):
        - Attached `.on('error', ...)` listeners to `DatabaseEngine.getPool()` (`max: 10`) and `server/index.js` `dbPool`, and consolidated `core/auth/adminUsers.ts` onto the shared `DatabaseEngine.getPool()`.
        - Replaced non-atomic Redis `LTRIM`+`LPUSH` client deletion purging in `core/data/buffer.ts` with atomic Lua script `PURGE_CLIENT_LIST_LUA_SCRIPT` (`cjson.decode` + chunked `RPUSH`), and replaced non-atomic Redis `INCR`+`PEXPIRE` rate limiting with atomic Lua script `REDIS_RATE_LIMIT_LUA_SCRIPT` across both `core/Security/security.ts` and `server/socket/handlers.js`.
        - Enforced `throwOnLockTimeout: true` locally and remotely on `POST /internal/flush` in `GET /api/export` and `POST /api/storage`, surfacing explicit `503 FLUSH_LOCK_TIMEOUT`.
        - Added `DataBufferEngine.registerShutdownHook()` and registered `SDKManager.flushPendingClientActivityAsync()` so Port `3000` flushes coalesced `total_events` deltas on `SIGTERM`/`SIGINT`.
        - Wrapped `GET`, `PATCH` (`regenerate_token` & update), and `DELETE` in `app/api/clients/[id]/route.ts` with structured JSON `try/catch` error responses.
        - Verified: `14/14` `tests/phase02-sync.test.ts` pass, `3/3` `R2 PHASE-02` buffer/storage tests pass, `npm run build` pass, `npm run lint` pass (`0` errors).
      - **R2 Phase-03 Complete & Verified (`2026-11-19`)** (`BUG-03`, `BUG-04`, `BUG-11`, `BUG-12`, `BUG-13`, `BUG-15`):
        - Unified `SettingsBridgeSyncStatus` & `POST /api/settings` `bridgeSync` response (`attempted`, `ok`, `synced`, `status`, `error`, `checkedAt`) and updated `describeSettingsBridgeSync()` + `SettingsWorkspace.tsx` so Port `4000` warnings/online state work reliably.
        - Counted regular non-symlink `.csv` files in `SDKManager.purgeClientStorageDir()` (`deleteClientWithStatsAsync()`) and returned exact `purgedFiles` from `DELETE /api/clients/[id]?purgeFiles=true`.
        - Aligned flat batch item metadata stripping (`eventId`, `timestamp`, `clientId`) 1:1 with single-event stripping across HTTP `POST /api/events`, WS `batch_sync`, and Python SDK `send_batch()`/`send_file()`.
        - Exposed `DataBufferEngine.getLocalBufferSnapshot()` for exact Port `3000` RAM pending summary in `getPendingBufferedSummary()`.
        - Added non-blocking `pruneExpiredPartitionsAsync()` off live event loops in `core/Storage/csvStorage.ts` & `server/workers/csvWriter.js` (wired into `settingsManager.ts` & `server/index.js`) and deduplicated `GET /api/storage` to a single `listAllFilesAsync()` scan with accurate client-scoped `stats`.
        - Cleared `selectedClientToken` on `/vcon/sdk` client switch (with loading placeholder + disabled `Copy Config`), added `400 INVALID_DATE_RANGE` for `from > to` in `GET /api/export`, and normalized `clientId` filtering in `ApiEngine.getExportFiles*` & Port `4000` `/internal/recent`.
        - Verified: `21/21` `phase04-*` tests pass, `2/2` `R2 PHASE-03` storage tests pass, `9/9` Python SDK tests pass, Chromium E2E across `/vcon/settings`, `/vcon/clients`, `/vcon/sdk`, `/vcon/storage` (`0` console errors), `npm run build` & `npm run lint` (`0` errors).
      - **R2 Phase-04 Complete & Verified (`2026-11-19`)** (`BUG-14`, `BUG-16`, `BUG-17`, `BUG-18`):
        - Added `from __future__ import annotations`, imported `Tuple`, and replaced PEP 585 `tuple[int, Dict[str, Any]]` with Python `3.8`-safe `Tuple[int, Dict[str, Any]]` in `sdk/python/datastack/datastack/client.py`, verified by a full-package Python `3.8` AST scan test in `tests/phase05_sdk_test.py`.
        - Added unbuffered streaming `location = /api/export` (`proxy_buffering off;`, `proxy_read_timeout 300s;`) targeting `http://nextjs_upstream` in both `nginx/default.conf` and `docker/coolify-nginx.conf`.
        - Removed `eslint: { ignoreDuringBuilds: true }` from `next.config.ts`, set `package.json` `"name": "datastack"`, pruned unused template packages (`@google/genai`, `firebase-tools`), and synchronized `package-lock.json`.
        - Isolated `DATASTACK_DISABLE_LISTEN=1` and live Port `4000` coupling across `tests/phase01-auth.test.ts`, `tests/phase02-sync.test.ts`, `tests/phase03-storage-buffer.test.ts`, `tests/phase04-ingestion-hygiene.test.ts`, and `tests/phase07-deployment.test.ts`.
        - Verified: `83/83` full TS suite pass (with live Port `4000` running, without manual env flags), `10/10` Python SDK tests + `py_compile` pass, `npm run build` (with ESLint active) pass, `npm run lint` (`0` errors, `0` warnings).
      - **Progress**: `4 / 4` phases complete (`18 / 18` bugs resolved — **100% Production Ready**).
    - **Pre-Release Docker & Coolify Deployment Hardening Complete & Verified (`2026-11-19`)** (`DEPLOY-BUG-01`–`05`, audited in `notes/DEPLOYMENT_COOLIFY_AUDIT_REPORT.md`):
      - **`DEPLOY-BUG-01`**: Replaced static `upstream` blocks in `docker/coolify-nginx.conf` with Docker embedded DNS `resolver 127.0.0.11 valid=10s ipv6=off;` and variable `proxy_pass` targets (`$nextjs_upstream` = `http://web:3000`, `$socketio_upstream` = `http://ingestion:4000`), preventing `502 Bad Gateway` stale container IP outages after container restarts/redeploys.
      - **`DEPLOY-BUG-02`**: Refactored Port `4000` startup in `server/index.js` into `startIngestionServer()` awaiting bounded `syncSettingsFromDatabase()` before `server.listen(PORT)` so rotated PG `jwt_secret` and rate-limit settings hydrate prior to `/health: 200` and `/internal/*` bridge traffic.
      - **`DEPLOY-BUG-03`**: Memoized `ensureDatabaseSchema()` per active `dbPool` instance in `server/index.js` (resetting only on pool swap or DDL failure) so 3-second `syncSettingsFromDatabase()` ticks no longer issue 8 `CREATE/ALTER TABLE` DDLs repeatedly.
      - **`DEPLOY-BUG-04`**: Reordered `gracefulShutdown()` in `server/index.js` to close Socket.IO/HTTP ingress first (`closeServerGracefully()`), drain `pendingRedisWrites` and `flushBuffer()`/`flushPendingClientActivity()` with bounded timeouts (`2000ms`/`6000ms`), and close Redis (`quit()` with `2000ms` timeout + `.disconnect()` fallback) and PostgreSQL (`dbPool.end()` bounded `2000ms`); added `stop_grace_period: 20s` to both `web` and `ingestion` in `docker/docker-compose.yml`.
      - **`DEPLOY-BUG-05`**: Clarified Coolify `Base Directory: /` and `Docker Compose Location: /docker/docker-compose.yml` in `docs/users/installation.md` and `README.md`.
      - Verified: `85/85` full TS suite pass (`11/11` in `tests/phase07-deployment.test.ts`), `10/10` Python SDK tests pass, `npm run build` clean, `npm run lint` (`0` errors, `0` warnings).

    - **V2 Baseline Freeze & Governance Planning Complete (`BASELINE-2026-11-19-V2`)**:
      - Froze the clean, Deployment-Hardened runtime state (`85/85` TS tests, `10/10` Python tests, clean `npm run build` & `eslint .`, zero runtime code changes) as **`BASELINE-2026-11-19-V2`**.
      - Created raw-source verified V2 planning & contract documents in `notes/`:
        - `notes/V2_FEATURE_GAP_AUDIT.md` (`V2-FEAT-01`–`V2-FEAT-07` gap analysis + full `/vcon/*` control mapping).
        - `notes/V2_DATABASE_AND_SETTINGS_CONTRACT.md` (zero-loss additive PostgreSQL DDL rules preserving `admin_users` `id = 1 CHECK (id = 1)`, AES-256-GCM DB secret encryption + masked `GET /api/settings`, Port `3000`↔`4000` live sync).
        - `notes/BASELINE_FREEZE.md`, `notes/PRODUCTION_READINESS_SCOPE_LOCK.md` (Doc `001` Scope Locks for `V2-Phase-01`–`04`), `notes/PRODUCTION_ROADMAP.md` (Doc `002`), `notes/PHASE_EXECUTION_LOG.md` (Doc `003`, `0 / 4` V2 phases done), `notes/ERROR_HANDLING_MATRIX.md` (Doc `004`, including `V2-E01`–`V2-E12`), `notes/ACTUAL_IMPLEMENTATION_STATUS.md`, and `notes/README.md`.
      - Roadmap grouped into 4 Scope-Locked V2 Phases (`V2-Phase-01` Archival/Gzip + Quota/Disk Guard; `V2-Phase-02` Webhooks/Alerts + IP Allowlist/Expiry + Prometheus/NDJSON; `V2-Phase-03` Multi-Admin RBAC + Audit Log; `V2-Phase-04` Node.js/TypeScript SDK + `/vcon/sdk` guide).
      - **`V2-Phase-01` Complete & Verified (`2026-11-19`)** (`V2-FEAT-01`, `V2-FEAT-03`, `V2-E01`–`V2-E05`):
        - **AES-256-GCM Secret Vault (`core/Security/secretVault.ts`)**: Deterministic HKDF-SHA256 key derivation (`encryptSecret`, `decryptSecret`, `getMaskedHintFromEncrypted`, `SecretVaultError`) so `s3_secret_access_key_enc` is encrypted at rest in PostgreSQL and never leaked in plaintext by `GET /api/settings` (`hasS3SecretKey` + `s3SecretKeyMask: "••••xxxx"`).
        - **S3 / Cloudflare R2 / MinIO SigV4 Client (`core/Storage/s3Archive.ts`)**: Pure Node `node:crypto` + `fetch` AWS Signature v4 client (`testS3Connection`, `uploadFileToS3`, `buildS3ObjectKey`, `normalizeS3EndpointUrl`) with `POST /api/storage/s3-test` and `POST /api/storage/archive`.
        - **Transparent `.csv.gz` Auto-Compression & Safe Archive-Before-Prune (`core/Storage/csvStorage.ts`, `server/workers/csvWriter.js`)**: Cooperatively locked atomic `.csv` → `.csv.gz` compression (`compressOldPartitionsAsync` / `compressOldPartitions`) excluding today's active UTC partition; transparent `.csv` + `.csv.gz` reading/streaming across `GET /api/data` (surfacing `500 Corrupt .csv.gz partition` on corrupt gzip — `V2-E03`), `GET /api/events`, and `GET /api/export` (`application/gzip` for raw single `.csv.gz` download); fail-safe `beforeDeleteFile` S3 upload hook (`V2-E02`) that never deletes local partitions if S3 upload fails (`502 S3_ARCHIVE_FAILED`).
        - **Per-Client Storage Quota (`storageQuotaMb`) & VPS Disk Pause Guard (`diskPauseThresholdPct`)**: Additive PostgreSQL columns (`client_sdks.storage_quota_mb` + 9 `admin_settings` columns in `core/Database/database.ts`, synced in `server/index.js` while preserving `ddlCount === 8`), `30s` TTL cached `statfs` + directory byte counters, and HTTP `507 Insufficient Storage` (`DISK_SPACE_LOW` / `STORAGE_QUOTA_EXCEEDED` — `V2-E04`, `V2-E05`) on `POST /api/events` and Port `4000` `sync_data`/`batch_sync` while keeping all Admin read/export/settings routes online.
        - **Admin UI Controls (`SettingsWorkspace.tsx`, `NewClientModal.tsx`, `ClientsTable.tsx`, `lib/vconUiHelpers.ts`)**: Added live VPS disk usage bar, `Auto-compress (.csv → .csv.gz)`, `Disk pause threshold (0 or 50–99%)`, full `S3 / R2 off-site archive` configuration with `Test S3 Connection` & `Archive Now`, and per-client `Storage quota (MB, 0 = unlimited)` in modal and table.
        - **Verified**: `89/89` TS tests (`4/4` in `tests/v2-phase01-storage-quotas.test.ts`), `10/10` Python SDK tests, `npm run build` clean, `npm run lint` (`0` errors / `0` warnings), and Chromium E2E across `/vcon/settings` (Storage tab) and `/vcon/clients` (`0` console errors).
      - **`V2-Phase-02` Complete & Verified (`2026-11-19`)** (`V2-FEAT-02`, `V2-FEAT-04`, `V2-FEAT-06`, `V2-E06`–`V2-E09`):
        - **Per-Client IP / CIDR Allowlist & Token Expiration (`core/Security/ipAllowlist.ts`, `core/sdk/sdkManager.ts`, `app/api/clients/**`, `app/api/events/route.ts`, `server/index.js`, `server/socket/handlers.js`)**: Validates and normalizes comma-separated IPv4, IPv4 CIDR (`/0..32`), IPv6, IPv6 CIDR (`/0..128`), IPv4-mapped IPv6 (`::ffff:`), loopback equivalence (`127.0.0.1` ↔ `::1`), and wildcard `*`; validates ISO `expiresAt` timestamps. Enforced across both Port `3000` `POST /api/events` and Port `4000` Socket.IO handshakes/events (`403 CLIENT_IP_FORBIDDEN` — `V2-E07`; `401 CLIENT_TOKEN_EXPIRED` — `V2-E08`), synced live via `/internal/client-sync` and additive PostgreSQL columns (`client_sdks.allowed_ips`, `client_sdks.expires_at`).
        - **Outbound Webhook Alerting (`core/alerts/webhookNotifier.ts`, `core/adminSettings/settingsManager.ts`, `app/api/settings/webhook-test/route.ts`)**: Sends Slack (`text`), Discord (`content`), and structured JSON webhook payloads signed with optional HMAC-SHA256 (`X-DataStack-Signature: sha256=<hex>`) and deduplicated per `event:clientId` via configurable `webhookCooldownSec` (`10..86400s`, default `300s`). Triggers non-blocking alerts on `DISK_SPACE_LOW`, `STORAGE_QUOTA_EXCEEDED`, `S3_ARCHIVE_FAILED`, `CLIENT_IP_FORBIDDEN`, and `CLIENT_TOKEN_EXPIRED`, plus on-demand `POST /api/settings/webhook-test` (`200` on delivery, `502 WEBHOOK_DELIVERY_FAILED` on upstream error — `V2-E06`). `webhook_secret_enc` is encrypted via AES-256-GCM Secret Vault and masked in `GET /api/settings` (`hasWebhookSecret`, `webhookSecretMask`).
        - **Prometheus Scrape Endpoint (`app/api/prometheus/route.ts`)**: `GET /api/prometheus` outputs Prometheus 0.0.4 text exposition format (`datastack_up`, `datastack_ingestion_bridge_up`, `datastack_active_sockets`, `datastack_events_total`, `datastack_buffer_events_total`, `datastack_storage_files_total`, `datastack_storage_bytes_total`, `datastack_storage_rows_total`, `datastack_disk_used_percent`, `datastack_disk_free_bytes`, `datastack_disk_total_bytes`, `datastack_clients_total`, `datastack_client_events_total`, `datastack_client_storage_bytes`). Protected by constant-time SHA-256 Bearer token comparison (`prometheus_metrics_token_enc` encrypted at rest) or active Admin Console session cookie (`401 PROMETHEUS_UNAUTHORIZED` — `V2-E09`).
        - **Streaming `.ndjson` Export (`app/api/export/route.ts`, `components/sections/ExportWorkspace.tsx`)**: Added `format=ndjson` (`Content-Type: application/x-ndjson; charset=utf-8`, `.ndjson` extension) streaming newline-delimited JSON objects across both `.csv` and `.csv.gz` partitions, with `NDJSON` format radio selector in `/vcon/export`.
        - **Admin UI Controls (`SettingsWorkspace.tsx`, `NewClientModal.tsx`, `ClientsTable.tsx`, `lib/vconUiHelpers.ts`)**: Added `Outbound webhook alerts` and `Prometheus metrics (/api/prometheus)` groups under `/vcon/settings` → **Security** tab, and `Allowed IPs / CIDR` + `Token expiration` controls in `/vcon/clients` New/Edit modals and table badges.
        - **Verified**: `93/93` TS tests (`4/4` in `tests/v2-phase02-alerts-ip-prometheus.test.ts`), `10/10` Python SDK tests, `npm run build` clean, `npm run lint` (`0` errors / `0` warnings), and Chromium E2E across `/vcon/settings` (`0` console errors).
      - **`V2-Phase-03` Complete & Verified (`2026-11-19`)** (`V2-FEAT-05`, `V2-E10`–`V2-E11`):
        - **Multi-Admin Role-Based Access Control (`core/Database/database.ts`, `core/auth/adminSession.ts`, `core/auth/adminUsers.ts`, `lib/adminAuth.ts`, `app/api/team/route.ts`, `app/api/team/[id]/route.ts`)**: Added canonical `admin_team_members` table in PostgreSQL (plus in-memory fallback) while preserving `admin_users` (`id = 1 CHECK (id = 1)`) as the immutable Primary Owner (`owner-1`, protected by `400 CANNOT_REVOKE_PRIMARY_OWNER` — `V2-E11`). Supports roles `owner` (rank 3 — full platform settings, secrets & team management), `admin` / `operator` (rank 2 — manage SDK clients, rotate tokens, manual buffer flushes, S3 test/archive), and `viewer` (rank 1 — read-only dashboards, events, clients, settings & exports). Enforced centrally via `requireAdminApiSession(req, { minRole })` returning `403 INSUFFICIENT_ROLE_PERMISSION` (`V2-E10`). Role/status/password changes on any team member immediately bump `token_version` to revoke existing sessions.
        - **Immutable Admin Audit Log (`core/auth/auditLog.ts`, `app/api/audit/route.ts`)**: Added canonical `admin_audit_logs` table in PostgreSQL (plus bounded 1,000-entry in-memory fallback) with automatic secret key redaction. Records governance events (`ADMIN_LOGIN`, `ADMIN_PROFILE_UPDATED`, `ADMIN_PASSWORD_UPDATED`, `TEAM_MEMBER_CREATED`, `TEAM_MEMBER_UPDATED`, `TEAM_MEMBER_REVOKED`, `TEAM_MEMBER_DELETED`, `CLIENT_CREATED`, `CLIENT_UPDATED`, `CLIENT_TOKEN_ROTATED`, `CLIENT_DELETED`, `SETTINGS_UPDATED`, `S3_ARCHIVE_TRIGGERED`, `WEBHOOK_TEST_TRIGGERED`) without ever inserting telemetry events into PostgreSQL. Exposed filterable `GET /api/audit` (`?action=`, `?actor=`, `?q=`, `?limit=`).
        - **Admin Console UI (`components/sections/TeamWorkspace.tsx`, `components/sections/AuditLogViewer.tsx`, `app/vcon/team/page.tsx`, `app/vcon/audit/page.tsx`, `components/layout/Sidebar.tsx`)**: Added `/vcon/team` (Team & RBAC directory, add member modal, role selector, session revocation & deletion) and `/vcon/audit` (filterable governance trail viewer) linked from `Sidebar.tsx`.
        - **Verified**: `97/97` TS tests (`4/4` in `tests/v2-phase03-rbac-audit.test.ts`), `10/10` Python SDK tests, `npm run build` clean, `npm run lint` (`0` errors / `0` warnings), and Chromium E2E across `/vcon/team` and `/vcon/audit` (`0` console errors).
      - **`V2-Phase-04` Complete & Verified (`2026-11-20`)** (`V2-FEAT-07`, `V2-E12`):
        - **Official Node.js / TypeScript Client SDK (`sdk/node/datastack/` — `@datastack/sdk` v2.2.0)**: Created `sdk/node/datastack/package.json`, `types.ts`, `spool.ts`, `index.ts`, and `README.md`. Supports `datastack.config.json` / `DATASTACK_*` env / constructor options with strict `normalizeClientId` vs JWT `clientId`/`sub` verification (`DataStackConfigError` — `V2-E12`), Socket.IO primary streaming (`connect()`, `send()`/`sync()`, `sendBatch()`/`batchSync()`), automatic HTTP `POST /api/events` fallback, recursive `413 PAYLOAD_TOO_LARGE` batch splitting, partial-batch `429 RATE_LIMIT_EXCEEDED` retry, typed terminal error mapping (`401 CLIENT_TOKEN_EXPIRED` & `403 CLIENT_IP_FORBIDDEN` -> `DataStackAuthError`, `507 STORAGE_QUOTA_EXCEEDED` & `DISK_SPACE_LOW` -> `DataStackQuotaExceededError`), durable `.datastack_spool/spool.jsonl` local disk spooling (`DiskSpooler`) & `flushSpool()`, direct `.csv`/`.json`/`.jsonl`/`.ndjson` file ingestion (`sendFile()` with deterministic SHA-256 `eventId` via `makeDeterministicFileEventId`), and graceful `await client.shutdown(timeoutMs)` drain.
        - **Multi-Language SDK Guide (`app/vcon/sdk/page.tsx`)**: Added interactive language tabs (`Python SDK (v2.2.0)`, `Node.js / TypeScript SDK (v2.2.0)`, `HTTP / cURL`) with live client JWT token population and copy-ready `config.datastack.py` / `datastack.config.json` snippets.
        - **Verified**: `101/101` TS tests (`4/4` in `tests/v2-phase04-node-sdk.test.ts`), `10/10` Python SDK tests, `npm run build` clean, and `npm run lint` (`0` errors / `0` warnings).
      - **Post-V2 Full-Codebase Forensic Audit & Baseline Freeze (`BASELINE-2026-11-20-V2-R2`)**:
        - Conducted a 100% raw-source-code forensic audit across all Port 3000 APIs/engines, Port 4000 Socket.IO workers, `/vcon/*` UI pages, and Python/Node SDKs (`notes/FORENSIC_AUDIT_REPORT.md`), identifying **10 verified bugs** (`BUG-V2-AUDIT-01` .. `BUG-V2-AUDIT-10`: `5` High, `4` Medium, `1` Low).
        - Froze the current verified codebase (`102/102` TS tests, `10/10` Python tests, `0` build/lint errors, `0` source code changes) as **`BASELINE-2026-11-20-V2-R2`** in `notes/BASELINE_FREEZE.md`.
        - Prepared the complete 7-document governance & Scope-Lock suite in `notes/`:
          - `notes/FORENSIC_AUDIT_REPORT.md` (`10` verified bugs with verbatim code blocks & line numbers)
          - `notes/BASELINE_FREEZE.md` (1:1 baseline-to-audit mapping)
          - `notes/PRODUCTION_READINESS_SCOPE_LOCK.md` (Doc `001` — exact fix contracts & strict per-phase Scope Locks)
          - `notes/PRODUCTION_ROADMAP.md` (Doc `002` — A–Z 3-phase execution roadmap: `V2-Audit-Phase-01` Auth/Email/Audit, `V2-Audit-Phase-02` Port 4000 Webhooks/IPv6 CIDR/Health/Python SDK, `V2-Audit-Phase-03` UI Disk Usage/Client Expiry/CSV.GZ Badges)
          - `notes/PHASE_EXECUTION_LOG.md` (Doc `003` — `3 / 3` phases completed, `0 / 3` remaining, `10 / 10` bugs resolved)
          - `notes/ERROR_HANDLING_MATRIX.md` (Doc `004` — active error catalog + `ERR-V2-AUDIT-01`..`05` all `5 / 5` completed)
          - `notes/ACTUAL_IMPLEMENTATION_STATUS.md` (ground-truth working vs per-phase delta — `0` remaining items)
          - `notes/README.md` (governance index & 6-step execution protocol)
        - **`V2-Audit-Phase-01` Complete & Verified (`2026-11-20`)** (`BUG-V2-AUDIT-02`, `BUG-V2-AUDIT-03`, `BUG-V2-AUDIT-04`, `ERR-V2-AUDIT-01`):
          - **`BUG-V2-AUDIT-04`**: Updated `revokeAdminSessions(target)` in `core/auth/adminUsers.ts` to accept explicit `{ memberId, email }` and passed `{ memberId: check.session.memberId, email: check.session.email }` from `POST /api/auth/logout` (`app/api/auth/logout/route.ts`), eliminating the multi-admin logout global race condition (`globals.__dataStackLastVerifiedMemberId`).
          - **`BUG-V2-AUDIT-03` (`ERR-V2-AUDIT-01`)**: Enforced cross-table (`admin_users` ↔ `admin_team_members`) and in-memory peer duplicate email checks in `updateAdminAccount()` (`core/auth/adminUsers.ts`) returning `code: 'ADMIN_EMAIL_CONFLICT'`, mapped to HTTP `409 Conflict` in `PUT /api/auth/profile` (`app/api/auth/profile/route.ts`).
          - **`BUG-V2-AUDIT-02`**: Wired all 4 missing audit actions (`ADMIN_LOGOUT` in `POST /api/auth/logout`, `ADMIN_SETUP` in `POST /api/auth/setup`, `STORAGE_FLUSH_TRIGGERED` in `POST /api/storage`, and `CLIENT_REVOKED` when `updates.status === 'revoked'` in `PATCH /api/clients/[id]`) and synchronized `ACTION_FILTER_OPTIONS` in `components/sections/AuditLogViewer.tsx` 1:1 with `AuditActionType` in `core/auth/auditLog.ts` (all 18/18 governance actions active).
          - **Verified**: `103/103` TS tests (`5/5` in `tests/v2-phase03-rbac-audit.test.ts`), `10/10` Python SDK tests, `npm run build` clean, and `npm run lint` (`0` errors / `0` warnings).
        - **`V2-Audit-Phase-02` Complete & Verified (`2026-11-20`)** (`BUG-V2-AUDIT-05`, `BUG-V2-AUDIT-06`, `BUG-V2-AUDIT-08`, `BUG-V2-AUDIT-09`, `ERR-V2-AUDIT-02`..`05`):
          - **`BUG-V2-AUDIT-05` (`ERR-V2-AUDIT-02`)**: Wired outbound HMAC-SHA256 webhook alert dispatching (`triggerWebhookAlert` + `dispatchRejectionWebhook`) on Port 4000 Socket.IO (`server/index.js`, `server/socket/handlers.js`) for `CLIENT_TOKEN_EXPIRED`, `CLIENT_IP_FORBIDDEN`, `DISK_SPACE_LOW`, and `STORAGE_QUOTA_EXCEEDED` across handshake, `sync_data`, `batch_sync`, and `ping_verify`, with AES-256-GCM `decryptVaultSecret` in `syncSettingsFromDatabase()` and live `webhookSecret` propagation in `core/adminSettings/settingsManager.ts`.
          - **`BUG-V2-AUDIT-06` (`ERR-V2-AUDIT-03`)**: Upgraded `isClientIpAllowed()` and `stripIpv6MappedPrefix()` in both `core/Security/ipAllowlist.ts` and `server/index.js` to use Node's built-in `net.BlockList` (`addSubnet`) for all IPv4 (`/0..32`) and IPv6 (`/0..128`) CIDR subnets and normalize `[ipv6]:port`, `ipv4:port`, `%zone`, and `::ffff:`.
          - **`BUG-V2-AUDIT-08` (`ERR-V2-AUDIT-04`)**: Enforced `isClientTokenExpired(registeredClient.expiresAt)` (`401 CLIENT_TOKEN_EXPIRED`) and `isClientIpAllowed(extractClientIp(req), registeredClient.allowedIps)` (`403 CLIENT_IP_FORBIDDEN`) in `GET /api/health` (`app/api/health/route.ts`).
          - **`BUG-V2-AUDIT-09` (`ERR-V2-AUDIT-05`)**: Added `"CLIENT_TOKEN_EXPIRED"` and `"CLIENT_IP_FORBIDDEN"` to `_is_non_retryable_auth_error()` and `_extract_auth_error_code()` in `sdk/python/datastack/datastack/client.py`, immediately raising `DataStackAuthError(msg, code=...)` matching the Node.js SDK 1:1.
          - **Verified**: `104/104` TS tests (`5/5` in `tests/v2-phase02-alerts-ip-prometheus.test.ts`), `11/11` Python SDK tests (`tests/phase05_sdk_test.py`), `npm run build` clean, and `npm run lint` (`0` errors / `0` warnings).
        - **`V2-Audit-Phase-03` Complete & Verified (`2026-11-20`)** (`BUG-V2-AUDIT-01`, `BUG-V2-AUDIT-07`, `BUG-V2-AUDIT-10`):
          - **`BUG-V2-AUDIT-01`**: Aligned `DiskUsageSnapshot` (`core/Storage/csvStorage.ts`), `GET /api/storage` (`app/api/storage/route.ts`), and `SettingsWorkspace.tsx` (`components/sections/SettingsWorkspace.tsx`) with `available: boolean` (`totalBytes > 0`) and `freeBytes: number` (`availableBytes`) so `/vcon/settings` -> Storage -> "VPS disk usage" renders real disk utilization percentage, progress bar, and free/total GiB instead of `"Statfs unavailable"`.
          - **`BUG-V2-AUDIT-07`**: Added `isClientExpired(expiresAt, nowMs)` in `app/vcon/clients/page.tsx` and excluded expired tokens from `onlineCount`, `pendingCount`, and `"online"`/`"pending"` filter tabs (classifying non-revoked expired clients under `"offline"`), matching `ClientsTable.tsx` `"expired"` badges 1:1.
          - **`BUG-V2-AUDIT-10`**: Updated `components/sections/ExportWorkspace.tsx` and `app/vcon/storage/page.tsx` to render a `CSV.GZ` format badge whenever `file.compressed || file.filename.toLowerCase().endsWith('.csv.gz')` is true (`CSV` otherwise).
          - **Verified**: `105/105` TS tests (`4/4` in `tests/v2-phase01-storage-quotas.test.ts`), `11/11` Python SDK tests (`tests/phase05_sdk_test.py`), `npm run build` clean, and `npm run lint` (`0` errors / `0` warnings). All `3 / 3` phases (`10 / 10` bugs) resolved.
      - **R3 Full-Stack Production Remediation (`BASELINE-2026-11-20-R3` — `16` Verified Bugs across `4` Scope-Locked Phases)**:
        - **`R3-Phase-01` Complete & Verified (`2026-11-20`)** (`BUG-01`, `BUG-03`, `BUG-04`, `BUG-06`, `BUG-10`, `BUG-13`, `BUG-15`; `ERR-R3-01`..`ERR-R3-04`):
          - **`BUG-01`**: Aligned Port 4000 `decryptVaultSecret()` (`server/index.js`) 1:1 with `core/Security/secretVault.ts` (`v1:` prefix, `DATASTACK_ADMIN_SESSION_SECRET`, `base64url` decoding, fail-closed `""` + warning) and injected `DATASTACK_ADMIN_SESSION_SECRET` (`SERVICE_REALBASE64_64_ADMINSESSION`) into `docker/docker-compose.yml` `services.ingestion.environment`.
          - **`BUG-03`**: Updated `AuthService.generateClientToken(payload, expiresIn?)` (`core/auth/jwt.ts`) to omit JWT `exp` when `expiresIn` is `null`/`undefined`/`""`, and passed `null` across all 6 minting sites in `core/sdk/sdkManager.ts` so DB `client_sdks.expires_at` (`Never expires`, `>30d`, live extension) is authoritative.
          - **`BUG-04`**: Enforced `requireAdminApiSession(req, { minRole: 'operator' })` on admin-session calls to `POST /api/events` (`app/api/events/route.ts`), returning `403 INSUFFICIENT_ROLE_PERMISSION` for read-only `viewer` accounts.
          - **`BUG-06`**: Wrapped `decryptSecret(settings.webhookSecretEnc)` in `SettingsManager.notifyIngestionSettingsSync()` (`core/adminSettings/settingsManager.ts`) in `try/catch` (`""` fallback + warning) and deferred `decryptSecret` in `POST /api/settings/webhook-test` (`app/api/settings/webhook-test/route.ts`) until neither draft `webhookSecret` nor `clearWebhookSecret` is provided.
          - **`BUG-10`**: Wired non-blocking `ADMIN_LOGIN_LOCKOUT` webhook alert dispatch inside the `429 TOO_MANY_ATTEMPTS` lockout branch of `POST /api/auth/login` (`app/api/auth/login/route.ts`).
          - **`BUG-13`**: Unified Port 4000 `formatOutboundWebhookBody()` (`server/index.js`) with Port 3000 `core/alerts/webhookNotifier.ts` (`instance`, `event`, `severity`, `title`, `message`, `clientId`, `details`, `timestamp`, `text`, `content`).
          - **`BUG-15`**: Tightened `POST /api/storage/s3-test` (`app/api/storage/s3-test/route.ts`) from `operator` to `owner`-only RBAC.
          - **Verified**: `6/6` in `tests/r3-phase01-security-vault-webhooks.test.ts`, `15/15` in `tests/v2-phase01..03`, `40/40` in `tests/phase01/02/07`, `npm run build` clean, `npm run lint` (`0` errors). `0` UI/SDK/CSV files modified.
        - **`R3-Phase-02` Complete & Verified (`2026-11-20`)** (`BUG-05`, `BUG-09`):
          - **`BUG-05`**: Added singleton unref'd periodic maintenance scheduler (`ensureMaintenanceScheduler`, `runScheduledMaintenanceTick`, `stopMaintenanceScheduler`, `stopMaintenanceSchedulerForTests`, `isMaintenanceSchedulerActive`) in `core/adminSettings/settingsManager.ts` with overlap locks (`__dataStackMaintenanceRunning`, `__dataStackArchivePruneInFlight`, `__dataStackCompressInFlight`), cooldown guards, and unhydrated-DB protection so S3 off-site archival + retention pruning and partition compression run unattended on schedule when `enableS3Backup === true`.
          - **`BUG-09`**: Updated `extractDateFromFilename()` in both `core/Storage/csvStorage.ts` and `server/workers/csvWriter.js` to strip `.csv(.gz)` and trailing `-(?:part|gz)\d+` suffixes so `-gzN.csv.gz` and `-partN-gzM.csv.gz` collision files work identically across Port 3000/4000 pruning, S3 archiving, `/api/data`, and `/api/export`.
          - **Verified**: `3/3` in `tests/r3-phase02-storage-scheduler-gzn.test.ts`, `40/40` in `tests/phase03/v2-phase01/phase07/r3-phase01`, `npm run build` clean, `npm run lint` (`0` errors). `0` UI/SDK/Auth/Docker files modified.
        - **`R3-Phase-03` Complete & Verified (`2026-11-20`)** (`BUG-02`, `BUG-07`, `BUG-08`; `ERR-R3-05`, `ERR-R3-06`):
          - **`BUG-02`**: Fixed Node.js SDK (`sdk/node/datastack/index.ts`) WS `batch_sync` to emit a raw `Array` directly (1:1 with Port 4000 `server/socket/handlers.js:595`), parse `ack.processed ?? ack.processedCount ?? ack.accepted` and `ack.duplicates ?? 0` across WS & HTTP batch responses, and propagate `duplicates` through `sendBatch()`, `batchSync()`, and `sendFile()`.
          - **`BUG-07` (`ERR-R3-05`)**: Implemented real `heartbeatIntervalMs` monitor in Node.js SDK (`startHeartbeatMonitor` with `.unref?.()`, zero-CPU `IDLE_WS` pause, automatic `ping_verify` recovery & spool drain, clean timer teardown, `status().heartbeatActive`); fixed single HTTP/WS `DUPLICATE_DROPPED` reporting (`accepted: 0, duplicates: 1`); wired `TOKEN_ROTATED` (`401`) and `CLIENT_REVOKED` (`403`) fast-fail `DataStackAuthError` across WS `connect_error`, `ping_verify`, `sync_data`, `batch_sync`, and HTTP fallback; compiled CommonJS `sdk/node/datastack/dist/{index,types,spool}.{js,d.ts}` via `tsconfig.json` and pointed `package.json` `main`/`types`/`exports` to `./dist/index.js` & `./dist/index.d.ts`.
          - **`BUG-08` (`ERR-R3-06`)**: Added non-retryable `DataStackQuotaExceededError(DataStackError, retryable=False)` in `sdk/python/datastack/datastack/exceptions.py`, re-exported it in both `datastack` and `datastack_sdk`, and wired immediate fail-fast handling for HTTP `507` and WS `STORAGE_QUOTA_EXCEEDED` / `DISK_SPACE_LOW` in `sdk/python/datastack/datastack/client.py` with `0` retries, `0` HTTP fallback after WS quota rejection, and `0` offline spooling.
          - **Verified**: `13/13` Node SDK/packaging tests (`5/5` `tests/r3-phase03-sdk-parity.test.ts` against live Socket.IO handlers + `4/4` `v2-phase04-node-sdk.test.ts` + `4/4` `phase05-packaging.test.ts`), `14/14` Python SDK tests (`3/3` `tests/r3_phase03_python_sdk_test.py` + `11/11` `phase05_sdk_test.py`), `py_compile`, `tsc`, `npm run build` clean, `npm run lint` (`0` errors, `0` warnings). `0` Port 3000/4000/UI/Docker files modified.

---

## 5. Known Constraints & Operational Notes for Future Contributors
- Never add per-row telemetry `INSERT` queries to PostgreSQL or add `DROP`/`TRUNCATE` auto-migrations.
- Never move Socket.IO handlers into Next.js `app/api/*` routes.
- When deploying updates to an existing Coolify VPS, always preserve existing `SERVICE_*` environment variables and avoid `docker compose down -v` so `pgdata`, `datastack-data`, and `redisdata` volumes remain intact.
- After any code change, verify with `npm run build`, `npm run lint`, the TS `tests/phase*.test.ts` suite (`npx --yes tsx --test`), and `python3 -m unittest tests/phase05_sdk_test.py`, then synchronize this `MEMORY.md`.
