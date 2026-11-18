# MEMORY.md — DataStack Cross-IDE Persistent Project Memory

> **Last Synchronized**: 2026-11-18 10:40:00 UTC  
> **Status**: Production Remediation Complete & Certified (Phases 01–05 100% Verified) (`notes/PHASE_EXECUTION_LOG.md`)  
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
│   ├── layout/                    # MainLayout, Navbar, Sidebar, PageShell, AdminPageHeader, Footer
│   ├── sections/                  # Modular feature sections (DashboardOverview, ClientsTable, DataBrowser, ExportWorkspace, SettingsWorkspace, etc.)
│   └── pwa/                       # PwaLifecycle.tsx service worker registration
├── core/
│   ├── adminSettings/             # settingsManager.ts (DB hydration, Port 4000 sync, unhydrated prune guard)
│   ├── apiEngine/                 # apiService.ts (dashboard metrics & Port 4000 internal bridge queries)
│   ├── auth/                      # adminUsers.ts, adminSession.ts (scrypt, brute-force throttle, tokenVersion), jwt.ts
│   ├── data/                      # buffer.ts (Redis + RAM queue, distributed lock, graceful SIGTERM/SIGINT flush)
│   ├── Database/                  # database.ts (pg.Pool + idempotent DDL + additive ALTER TABLE guards)
│   ├── sdk/                       # sdkManager.ts (DB JWT hydration, client lifecycle, deleted_clients tombstone)
│   ├── Security/                  # security.ts (rate limit, maxPayloadSizeKb, idempotency, internal headers)
│   └── Storage/                   # csvStorage.ts (cooperative lock, rotation, cached streaming row count, prune)
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
├── notes/                         # Production remediation & baseline specifications:
│   ├── README.md                  # Notes document index & navigation hub
│   ├── BASELINE_FREEZE.md         # Baseline system freeze & test verification contract
│   ├── forensic-audit-report.md   # Primary forensic audit report (11 verified findings)
│   ├── PRODUCTION_REMEDIATION_SPECIFICATION.md # Exact code patch references & scope locks
│   ├── PHASED_IMPLEMENTATION_ROADMAP.md # 5-phase execution strategy & validation gates
│   ├── PHASE_EXECUTION_LOG.md     # Living phase progress tracker (Pending Phase 01)
│   ├── ERROR_HANDLING_AUDIT_AND_TAXONOMY.md # Error codes, handlers & defensive taxonomy
│   └── FEATURE_STATE_REGISTRY.md  # Single-source-of-truth feature operational matrix
└── tests/                         # Automated verification suites:
    ├── phase01-auth.test.ts       # Auth fail-closed, tokenVersion, brute-force lockout, Bearer revocation, CSRF
    ├── phase02-sync.test.ts       # Internal bridge auth, settings sync, JWT rotation kick, rate/security metrics
    ├── phase03-storage-buffer.test.ts # Redis durability, cooperative CSV locks, streaming row count, export filters
    ├── phase05_sdk_test.py        # Python SDK WebSocket/HTTP fallback, offline spool, file streaming
    ├── phase06-pwa-landing.test.ts # PWA manifest/icons/sw + navigation routes
    └── phase07-deployment.test.ts # Compose/Redis AOF, Nginx /health, lockfile, prune guard, shutdown flush
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

### Production Phased Remediation Execution
- **Phase 01: Critical Telemetry & Ingestion Flow (COMPLETED — 2026-11-18)**:
  - Simulator WebSocket transport (`/app/vcon/simulator/page.tsx`): Aligned client origin to `http:`/`https:` and event emission to `sync_data` (single) and `batch_sync` (burst) using acknowledgment callbacks, resolving 100% failure rate in simulator WebSocket tests.
  - Storage Workspace manual flush (`/app/vcon/storage/page.tsx`): Integrated response JSON parsing with `warning` toast for partial flushes (HTTP 502 when local buffer is written but Port 4000 returns error) and accurate server error display.
- **Phase 02: Data Filtering, Export UX & Health Probe (COMPLETED — 2026-11-18)**:
  - Settings Workspace (`/components/sections/SettingsWorkspace.tsx`): Dynamically routes health checks to localhost, 127.0.0.1, custom dev ports, or `/api/health` reverse proxy fallback.
  - Export Workspace (`/components/sections/ExportWorkspace.tsx`): Replaced window navigation with blob fetch and in-app error toast on download failure.
  - Partition Filtering (`/core/Storage/csvStorage.ts` & `/app/api/data/route.ts`): Null fallback on unparseable timestamps prevents corrupt historical events from leaking into today's partition query.
- **Phase 03: Security & Usability Uniformity (COMPLETED — 2026-11-18)**:
  - Administrator Email Uniformity (`/.env.example`, `AdminSetup.tsx`, `AdminLogin.tsx`): Standardized email placeholder to `admin@datastack.dev` aligning with backend default and Docker Compose.
  - Headless Automation CSRF Accommodation (`/middleware.ts`): Added `isHeadlessAdminClient` check to allow programmatic callers carrying `x-datastack-admin-client: true` or `user-agent: DataStack-CLI/*` to bypass browser origin checks while preserving admin session cookie authentication and browser CSRF protection.
- **Phase 04: SDK & Codebase Consolidation (COMPLETED — 2026-11-18)**:
  - Python SDK Consolidation (`sdk/python/datastack/` & `sdk-python/`): Verified single source of truth across all submodule shims (`client`, `config`, `exceptions`, `heartbeat`, `spool`) in `tests/phase05_sdk_test.py`.
  - Unified Concurrent Dev Script (`package.json` & `scripts/dev-all.js`): Added `"dev:all": "node scripts/dev-all.js"` with clean SIGINT/SIGTERM shutdown.
  - Landing UI Telemetry Snippet (`components/sections/SdkSection.tsx`): Aligned with realistic `sensor_telemetry` payload matching Simulator and SDK documentation.
- **Phase 05: Final E2E Sign-Off & Verification (COMPLETED — 2026-11-18)**:
  - Full automated regression passed: 24/24 TypeScript tests (`tests/*.test.ts`) and 3/3 Python tests (`tests/phase05_sdk_test.py`).
  - Next.js production build (`compile_applet`) and ESLint (`lint_applet`) passing cleanly with zero errors and zero warnings.
  - 100% of platform features (20 / 20) certified 🟢 Fully Functional in `notes/FEATURE_STATE_REGISTRY.md`.

---

## 5. Known Constraints & Operational Notes for Future Contributors
- Never add per-row telemetry `INSERT` queries to PostgreSQL or add `DROP`/`TRUNCATE` auto-migrations.
- Never move Socket.IO handlers into Next.js `app/api/*` routes.
- When deploying updates to an existing Coolify VPS, always preserve existing `SERVICE_*` environment variables and avoid `docker compose down -v` so `pgdata`, `datastack-data`, and `redisdata` volumes remain intact.
- After any code change, verify with `npm run build`, `npm run lint`, the TS `tests/phase*.test.ts` suite (`npx --yes tsx --test`), and `python3 -m unittest tests/phase05_sdk_test.py`, then synchronize this `MEMORY.md`.
