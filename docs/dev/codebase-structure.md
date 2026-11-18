# Codebase Structure & Directory Inventory

This document provides a comprehensive, file-by-file architectural inventory of the DataStack codebase, detailing module responsibilities, runtime boundaries, and inter-module dependencies.

---

## 1. High-Level Directory Overview

```text
/
├── app/                  # Next.js 15 App Router: UI pages, layouts, and REST API routes (Port 3000)
├── components/           # Reusable UI primitives and layout shells
├── core/                 # Shared business logic, database connectors, and security engines
├── server/               # Dedicated Express 5 + Socket.IO 4 Ingestion Server (Port 4000)
├── sdk/                  # Official client SDKs (Python, with TypeScript SDK planned)
├── docker/               # Production multi-stage Dockerfiles and Compose configurations
├── nginx/                # Nginx reverse proxy routing and health check configuration
├── prisma/               # Schema mirror documenting PostgreSQL control-plane tables
├── public/               # Static assets, PWA icons, and manifests
├── storage/              # Mounted partition volume for daily CSV files (/storage/data/)
├── tests/                # Automated TypeScript integration and Python SDK test suites
└── docs/                 # Authoritative documentation suite
```

---

## 2. Web Application & REST API (`app/`)

Operating on **Port 3000**, this Next.js 15 App Router subsystem handles operator authentication, dashboard rendering, authenticated HTTP ingestion, and streaming dataset exports.

### Core Entry Points
- `app/layout.tsx`: Root HTML layout importing centralized CSS tokens, fonts, and PWA registration.
- `app/page.tsx`: Public marketing and documentation overview page.
- `app/middleware.ts`: Next.js Edge middleware. Enforces signed HMAC-SHA256 session cookies on `/vcon/*` routes (except `/vcon/login` and `/vcon/setup`) and validates CSRF `Origin`/`Referer` headers against `Host` and `X-Forwarded-Host`.
- `app/globals.css`: Global design tokens, CSS variables, and zero-pill border radius resets.
- `app/manifest.ts`: Web App Manifest generator for PWA installation.
- `app/sw.ts`: Progressive Web App Service Worker script.

### Administration Console Pages (`app/vcon/`)
- `app/vcon/login/page.tsx`: Operator sign-in page with brute-force rate-limiting feedback.
- `app/vcon/setup/page.tsx`: First-time setup wizard accepting `DATASTACK_ADMIN_SETUP_KEY`.
- `app/vcon/dashboard/page.tsx`: Primary operational dashboard displaying dual-runtime health, disk utilization, buffer depth, and recent live telemetry ticker.
- `app/vcon/clients/page.tsx`: Client SDK registry for generating tokens, rotating secrets, and revoking clients.
- `app/vcon/simulator/page.tsx`: Interactive in-browser telemetry generator with single and burst dispatch.
- `app/vcon/storage/page.tsx`: CSV partition inspector and manual buffer flush controls.
- `app/vcon/export/page.tsx`: Filtered streaming CSV and JSON export workspace.
- `app/vcon/settings/page.tsx`: Platform runtime settings manager (rate limits, flush intervals, rotation size).
- `app/vcon/profile/page.tsx`: Administrator credentials, password updates, and session revocation.

### REST API Route Handlers (`app/api/`)
- `app/api/events/route.ts`: Authenticated HTTP ingestion endpoint. Accepts single events, `{ batch: [...] }`, or structured file imports (`{ fileName, records: [...] }`).
- `app/api/events/flush/route.ts`: Forces immediate buffer flushes across both Port 3000 and Port 4000.
- `app/api/export/route.ts`: Streams filtered CSV or JSON datasets directly from disk to the client response.
- `app/api/health/route.ts`: Health check endpoint reporting process uptime and database status.
- `app/api/auth/login/route.ts`: Authenticates admin email and password with `crypto.scrypt` verification and composite IP brute-force tracking.
- `app/api/auth/logout/route.ts`: Clears session cookie and invalidates session token.
- `app/api/auth/me/route.ts`: Returns current operator identity and session validity.
- `app/api/auth/setup/route.ts`: Executes initial admin setup with setup key verification.
- `app/api/auth/change-password/route.ts`: Updates operator password and increments `tokenVersion`.
- `app/api/clients/route.ts`: Registers new SDK clients and lists existing client credentials.
- `app/api/clients/[id]/route.ts`: Updates client rate limits, rotates secrets, revokes, or permanently deletes clients.
- `app/api/settings/route.ts`: Reads and updates platform runtime settings with database persistence.

---

## 3. Core Business Logic Singletons (`core/`)

The `core/` directory contains framework-agnostic TypeScript singletons shared between the Web application and ingestion workers.

| Module | Primary Class / Functions | Responsibility |
| :--- | :--- | :--- |
| `core/Database/database.ts` | `DatabaseEngine` | Manages raw `pg.Pool` PostgreSQL connections, executes non-destructive DDL migrations, and provides an in-memory mock store when `DATABASE_URL` is omitted. |
| `core/auth/adminAuth.ts` | `AdminAuthService` | Enforces `crypto.scrypt` password hashing (64-byte key, 16-byte salt), constant-time string comparison, and composite IP + email failed attempt lockout. |
| `core/auth/jwt.ts` | `AuthService` | Generates and verifies HMAC-SHA256 JWT tokens for SDK clients and WebCrypto HMAC-SHA256 session tokens for administrators. |
| `core/Security/security.ts` | `SecurityEngine` | Implements sliding-window rate limiters, 5-minute idempotency caches, payload size guards, and timing-safe internal secret authentication. |
| `core/data/buffer.ts` | `DataBufferEngine` | Manages in-memory RAM event queues and optional Redis list queues (`datastack:buffer:events`), with threshold and interval auto-flushing. |
| `core/Storage/csvStorage.ts` | `CSVStorageManager` | Handles RFC 4180 CSV serialization, client/date directory partitioning, 100MB file rotation (`-part2.csv`), cooperative `.lock` file handling, and automated retention pruning. |
| `core/sdk/sdkManager.ts` | `SDKManager` | Coordinates client CRUD operations, credential rotation, master secret re-signing, and tombstone checks. |
| `core/adminSettings/settingsManager.ts` | `SettingsManager` | Manages system settings state, synchronizes with PostgreSQL, and notifies Port 4000 via `/internal/settings-sync`. |

---

## 4. Ingestion Server Subsystem (`server/`)

Operating on **Port 4000**, this dedicated Express 5 + Socket.IO 4 service handles high-throughput, persistent WebSocket connections.

- `server/index.js`: Express application entry point. Listens on `PORT_SOCKET` (4000), mounts internal service bridge routes (`/internal/*`), and binds the Socket.IO server.
- `server/socket/handlers.js`: Enforces JWT authentication during the Socket.IO handshake (`io.use()`), handles incoming telemetry events (`sync_data`, `sync_batch`), applies per-client rate limits, deduplicates idempotency envelopes, and supports administrative socket termination.
- `server/workers/csvWriter.js`: Background flusher worker (`CsvWriterWorker`). Periodically polls the buffer queue and flushes batches to partitioned CSV files using cooperative file locks.

---

## 5. Client SDK Subsystem (`sdk/`)

- `sdk/python/datastack/`: Official Python Client Library.
  - `client.py`: Provides `DataStackClient` supporting WebSocket streaming (`connect()`), automatic fallback to HTTP (`send_event()`), offline disk spooling (`.datastack_spool/`), and batch file streaming (`stream_csv()`, `stream_json()`).
  - `__init__.py`: Package entry point exposing `DataStackClient`.
  - `pyproject.toml` & `setup.py`: Packaging specifications.
