# Platform Configuration Guide

This guide covers all environment variables, initial administrator bootstrap secrets, runtime tuning parameters, and synchronization behaviors across the DataStack architecture.

---

## 1. Environment Variables Overview

DataStack reads runtime configuration from system environment variables (or a root `.env` file). In development, safe fallback values are used. In production (`NODE_ENV=production`), all security keys must be explicitly configured with at least 32 cryptographically secure characters.

```dotenv
# Security & Session Secrets (REQUIRED in production, min 32 characters)
DATASTACK_ADMIN_SESSION_SECRET=your-32-plus-char-session-secret-here
DATASTACK_JWT_SECRET=your-32-plus-char-client-jwt-secret-here
DATASTACK_ADMIN_SETUP_KEY=your-32-plus-char-bootstrap-setup-key-here
DATASTACK_INTERNAL_SECRET=your-32-plus-char-internal-service-secret

# Administrator Account Initial Bootstrap
DATASTACK_ADMIN_EMAIL=admin@example.com

# PostgreSQL Persistence (recommended for production metadata)
DATABASE_URL=postgresql://datastack:password@postgres:5432/datastack_db

# Shared Redis Buffer (optional; enables cluster buffer queue & distributed locks)
REDIS_URL=redis://redis:6379

# Service Networking & Ports
PORT=3000
PORT_SOCKET=4000
INGESTION_INTERNAL_URL=http://127.0.0.1:4000
```

---

## 2. Environment Variables Specification

### Security & Authentication

| Variable | Required in Prod | Default (Dev) | Description |
| :--- | :--- | :--- | :--- |
| `DATASTACK_ADMIN_SESSION_SECRET` | **Yes** | Built-in fallback | Used by WebCrypto HMAC-SHA256 to sign and verify operator session cookies (`datastack_admin_session`). Must be ≥ 32 characters. |
| `DATASTACK_JWT_SECRET` | **Yes** | Built-in fallback | Master signing secret used to generate and verify HMAC-SHA256 JWT tokens for registered SDK clients. |
| `DATASTACK_ADMIN_SETUP_KEY` | **Yes** | Built-in fallback | Secret key required to complete the initial admin onboarding wizard at `/vcon/setup`. |
| `DATASTACK_INTERNAL_SECRET` | Recommended | Derived from JWT | Secret used for authenticated HTTP communication between Port 3000 and the Port 4000 ingestion server via `x-datastack-internal-secret`. If omitted, automatically derived via SHA-256 of `DATASTACK_JWT_SECRET`. |
| `DATASTACK_ALLOW_DEMO_ADMIN` | No | `false` | When set to `true`, enables quick demo credentials on the login screen (`admin@example.com`). Strictly prohibited in production. |

### PostgreSQL Database

| Variable | Required in Prod | Default (Dev) | Description |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | Recommended | `undefined` | PostgreSQL connection URI (`postgresql://user:pass@host:port/dbname`). If omitted, DataStack operates in an in-memory mock mode. |

### Redis Shared Buffer

| Variable | Required in Prod | Default (Dev) | Description |
| :--- | :--- | :--- | :--- |
| `REDIS_URL` | Optional | `undefined` | Redis connection URI (`redis://host:6379`). When present, events are queued in Redis list `datastack:buffer:events`, surviving container restarts and enabling multi-worker flush locking. |

### Service Networking

| Variable | Required in Prod | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | No | `3000` | Port for the Next.js 15 Web Application and REST API. |
| `PORT_SOCKET` | No | `4000` | Port for the Express 5 + Socket.IO ingestion service. |
| `INGESTION_INTERNAL_URL` | No | `http://127.0.0.1:4000` | Internal URL used by Port 3000 to send bridge notifications to Port 4000 (`/internal/*`). |

---

## 3. Platform Runtime Settings (`/vcon/settings`)

In addition to environment variables, operators can adjust platform operational thresholds at runtime through the **Settings Workspace** (`/vcon/settings`).

These settings are stored in PostgreSQL (`admin_settings` table) and broadcast in real time to the Port 4000 ingestion service via `/internal/settings-sync`.

| Parameter | Type | Default | Permitted Range | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `maxEventsPerSec` | Number | `100` | `1` – `10,000` | Ingestion rate ceiling. Events exceeding this limit receive `RATE_LIMIT_EXCEEDED (429)`. |
| `maxPayloadSizeKb` | Number | `100` | `1` – `10,240` (10 MB) | Maximum permitted size in kilobytes for any single event payload. Oversized payloads receive `PAYLOAD_TOO_LARGE (413)`. |
| `batchFlushThreshold` | Number | `500` | `10` – `50,000` | Queue depth threshold that triggers an immediate write of buffered events to CSV files on disk. |
| `batchFlushIntervalMs` | Number | `2000` | `200` – `60,000` (60s) | Maximum duration pending events can remain buffered in memory/Redis before being flushed to disk. |
| `fileRotationMb` | Number | `100` | `5` – `1,024` (1 GB) | File size threshold per daily CSV partition. Once reached, DataStack writes to `{YYYY-MM-DD}-part2.csv`. |
| `enableIdempotency` | Boolean | `true` | `true` / `false` | Enables 5-minute sliding-window deduplication based on client-provided `eventId`. |
| `autoPruneDays` | Number | `30` | `0` – `3,650` | Automatically purges daily CSV partition files older than this value. Setting to `0` disables pruning and keeps all archives indefinitely. |
| `jwtSecret` | String | `.env` value | ≥ 16 characters | Master JWT signing secret. Rotating this value automatically re-signs all active SDK client credentials and notifies Port 4000. |

---

## 4. Cross-Process Synchronization Rules

When settings are modified in `/vcon/settings`:

1. **Database Persistence**: If PostgreSQL is configured, settings are written to `admin_settings WHERE id = 'default'`.
2. **Web Process Hydration**: Port 3000 updates its local singleton instances (`SecurityEngine`, `DataBufferEngine`, `CSVStorageManager`).
3. **Bridge Notification**: Port 3000 issues an authenticated HTTP `POST` to `${INGESTION_INTERNAL_URL}/internal/settings-sync` carrying the `x-datastack-internal-secret` header.
4. **Ingestion Reload**: Port 4000 receives the updated thresholds and immediately applies them to its socket handlers and background flusher worker without requiring a process restart.
