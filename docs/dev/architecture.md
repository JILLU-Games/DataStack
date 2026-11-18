# Architecture Blueprint

This document details the architectural principles, runtime boundaries, and subsystems powering DataStack.

---

## 1. Core Architectural Principles

DataStack is designed around three foundational engineering constraints:

1. **Decoupled Runtimes**: Long-lived WebSocket connections require stateful, persistent event loops, while modern administrative consoles benefit from serverless, SSR App Router paradigms. DataStack strictly decouples these into **Port 3000** (Web & REST API) and **Port 4000** (Real-Time Ingestion).
2. **Zero Per-Row Database Writes**: Telemetry streams are never inserted per-row into relational tables. Events are buffered in memory and Redis, then flushed in sequential batches directly to daily partitioned CSV files on disk.
3. **Control-Plane vs Data-Plane Isolation**: PostgreSQL is strictly reserved for the control plane (user authentication, client token registry, rate limits, and platform configuration). The data plane resides entirely on disk in partitioned CSV files.

---

## 2. Dual-Runtime Architecture

```text
               ┌────────────────────────────────────────────────────────┐
               │              Nginx Reverse Proxy (Port 80)              │
               └───────────────┬────────────────────────┬───────────────┘
                               │                        │
                   /socket.io/ │                        │ / & /api/*
                               ▼                        ▼
     ┌───────────────────────────────────┐    ┌───────────────────────────────────┐
     │ Ingestion Service (Port 4000)     │    │ Web & Admin Console (Port 3000)   │
     │ Express 5 + Socket.IO 4           │    │ Next.js 15 App Router + React 19  │
     ├───────────────────────────────────┤    ├───────────────────────────────────┤
     │ - WebSocket Handshake Auth (JWT)  │    │ - Public Landing & PWA Lifecycle  │
     │ - Real-time Rate Limiting         │    │ - /vcon/* Admin Console           │
     │ - 5-min Sliding Window Idempotency│    │ - Authenticated HTTP Ingestion    │
     │ - Memory & Redis Batch Buffer     │    │ - Streaming CSV / JSON Export     │
     │ - CsvWriterWorker Flusher         │    │ - Session Auth & Brute-Force Guard│
     └─────────────────┬─────────────────┘    └─────────────────┬─────────────────┘
                       │                                        │
                       │     Authenticated /internal/* Bridge    │
                       └────────────────◄═══════════════════════┘
                                  (DATASTACK_INTERNAL_SECRET)
```

### Port 3000 (`web`): Next.js 15 App Router
- **Role**: Serves the user interface and HTTP REST endpoints.
- **Key Modules**:
  - `middleware.ts`: Authenticates `/vcon/*` routes using signed WebCrypto session cookies, and enforces CSRF protection by validating `Origin`/`Referer` headers against `Host` and `X-Forwarded-Host`.
  - `app/api/events/route.ts`: Accepts HTTP ingestion for single events, arrays (`{ batch: [...] }`), or structured file imports (`{ fileName, records: [...] }`).
  - `app/api/export/route.ts`: Streams filtered CSV or JSON files directly from disk partitions to the client browser without buffering entire datasets in server RAM.

### Port 4000 (`ingestion`): Dedicated Ingestion Server
- **Role**: High-throughput Socket.IO WebSocket server (`server/index.js`).
- **Key Modules**:
  - `server/socket/handlers.js`: Enforces client JWT authentication, sliding-window rate limits (per-client and global), payload size validation, and idempotency deduplication.
  - `server/workers/csvWriter.js`: Flushes buffered batches to daily partitioned CSV files with file rotation and cooperative locking.

---

## 3. Internal Service Bridge (`/internal/*`)

Because Port 3000 and Port 4000 operate as separate processes, administrative actions in `/vcon/` must synchronize with the real-time ingestion service instantly:

- **Security**: All `/internal/*` routes require a shared, timing-safe authentication header: `x-datastack-internal-secret`.
- **Secret Derivation**: `DATASTACK_INTERNAL_SECRET` can be explicitly defined in `.env` or is automatically derived from the active JWT secret via SHA-256.

### Bridge Endpoints:
1. `GET /internal/metrics`: Aggregates active Socket.IO connections, buffer depths, and security stats for the `/vcon/dashboard`.
2. `POST /internal/settings-sync`: Pushes updated rate limits, payload sizes, flush thresholds, or rotated JWT secrets instantly to Port 4000.
3. `POST /internal/client-sync`: Pushes registered, rotated, revoked, or deleted client updates. If a client is revoked, Port 4000 immediately kicks all active sockets for that client.
4. `POST /internal/flush`: Triggers an immediate write of Port 4000's buffer to disk when an admin initiates a manual flush or export.
5. `GET /internal/recent`: Fetches recently buffered events from Port 4000's queue so `/vcon/data` displays zero-latency activity.

---

## 4. Storage Subsystem & Durability

### Data Ingestion Flow:
1. **Push**: Events enter via WebSocket (`sync_data`) or HTTP (`POST /api/events`).
2. **Buffer Queue**: Events are written to the Redis queue (`datastack:buffer:events`) with local RAM fallback.
3. **Batch Flush Condition**: A flush triggers when:
   - Buffer size reaches `batchFlushThreshold` (default: 500 events), OR
   - Time elapsed reaches `batchFlushIntervalMs` (default: 2000 ms), OR
   - A manual flush or export is requested.
4. **Distributed Flush Lock**: In multi-process deployments, workers acquire `datastack:flush:lock` in Redis (`SET lockToken PX 15000 NX`) to prevent concurrent writes.
5. **Safe Trim**: Redis queue items are trimmed (`LTRIM`) **strictly after** the batch append operation confirms success on disk.

### Cooperative Partition File Locking
When writing to `/storage/data/{clientId}/{YYYY-MM-DD}.csv`:
- The writer creates a cooperative `.lock` file alongside the partition (`{file}.lock`).
- Stale locks (older than 10 seconds) created by crashed processes are automatically cleared.
- This prevents race conditions when both Port 3000 and Port 4000 flush to the same client partition simultaneously.

---

## 5. PostgreSQL Metadata Subsystem

PostgreSQL persistence is managed via raw `pg.Pool` connections (`core/Database/database.ts`), mirrored by the reference schema in `prisma/schema.prisma`.

### Managed Tables:
1. `admin_users`: Stores admin credentials with `crypto.scrypt` password hashing and a `token_version` column for instant session invalidation.
2. `admin_login_attempts`: Tracks failed login attempts per composite IP + Email hash with 15-minute brute-force lockout.
3. `client_sdks`: Stores registered client metadata, hashed secrets, signed tokens, rate limits, status (`active`/`revoked`), and total event counters.
4. `deleted_clients`: Tombstone table ensuring deleted client IDs and tokens can never be revived or accepted.
5. `admin_settings`: Single-row configuration storing platform limits, ports, thresholds, and secrets.

### Non-Destructive Migrations
On startup, `DatabaseEngine.ensureSchema()` runs non-destructive `CREATE TABLE IF NOT EXISTS` and additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` DDL statements, guaranteeing seamless upgrades on existing production databases without data loss.
