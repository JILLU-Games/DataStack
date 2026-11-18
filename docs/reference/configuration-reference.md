# Complete Configuration Reference

This document provides the exhaustive specification for every environment variable, `.env` parameter, and runtime database setting supported by DataStack.

---

## 1. Environment Variables (`.env`)

Environment variables are loaded on container or process boot.

| Variable Name | Type | Production Requirement | Default Value (Dev) | Description & Constraints |
| :--- | :--- | :--- | :--- | :--- |
| `NODE_ENV` | String | **Required** | `development` | Runtime mode. Must be set to `production` in live deployments to enforce fail-closed security and secure cookies. |
| `DATASTACK_ADMIN_SESSION_SECRET` | String | **Required** | Fallback key | Cryptographic secret for signing WebCrypto HMAC-SHA256 operator session cookies. Min length: 32 chars. |
| `DATASTACK_JWT_SECRET` | String | **Required** | Fallback key | Master HMAC-SHA256 secret used to sign and verify client SDK authentication tokens. Min length: 32 chars. |
| `DATASTACK_ADMIN_SETUP_KEY` | String | **Required** | Fallback key | One-time secret key required to access `/vcon/setup` and create the initial administrator account. Min length: 32 chars. |
| `DATASTACK_INTERNAL_SECRET` | String | Recommended | SHA-256 of JWT secret | Shared secret authorizing internal IPC between Port 3000 and Port 4000 via `x-datastack-internal-secret`. Min length: 32 chars. |
| `DATASTACK_ADMIN_EMAIL` | String | Optional | `admin@example.com` | Default admin contact email used during development or bootstrap. |
| `DATASTACK_ALLOW_DEMO_ADMIN` | Boolean | Strictly Forbidden in Prod | `false` | When `true`, displays demo credentials on login screen. Throws fatal error if enabled in production. |
| `DATABASE_URL` | String | Recommended | `undefined` | PostgreSQL connection string (`postgresql://user:pass@host:5432/dbname`). If omitted, in-memory mock mode is activated. |
| `REDIS_URL` | String | Optional | `undefined` | Redis connection URI (`redis://host:6379`). Enables multi-worker buffer queuing and distributed flush locks. |
| `PORT` | Integer | Optional | `3000` | Port for the Next.js 15 web application and REST API. |
| `PORT_SOCKET` | Integer | Optional | `4000` | Port for the Express 5 + Socket.IO ingestion service. |
| `INGESTION_INTERNAL_URL` | String | Optional | `http://127.0.0.1:4000` | Base URL used by Port 3000 to send bridge notifications to Port 4000 (`/internal/*`). |

---

## 2. Runtime Platform Settings (`admin_settings` Table)

Runtime settings are persisted in PostgreSQL (`admin_settings` row with `id = 'default'`), configurable via `/vcon/settings`, and synchronized instantly across processes.

| Parameter Key | Storage Column | Type | Default | Range / Constraints | Functional Impact |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `serverPort` | `server_port` | Integer | `4000` | `1024` – `65535` | Ingestion service port reported across the cluster. |
| `webPort` | `web_port` | Integer | `3000` | `1024` – `65535` | Web dashboard port reported across the cluster. |
| `maxEventsPerSec` | `max_events_per_sec` | Integer | `100` | `1` – `10,000` | Global ingestion rate limit ceiling. Exceeding events receive HTTP `429` or socket error. |
| `maxPayloadSizeKb` | `max_payload_size_kb` | Integer | `100` | `1` – `10,240` (10 MB) | Maximum permitted size in KB for any single event. Larger payloads rejected with HTTP `413`. |
| `batchFlushThreshold` | `batch_flush_threshold` | Integer | `500` | `10` – `50,000` | Buffer queue depth that triggers an immediate synchronous flush to disk. |
| `batchFlushIntervalMs` | `batch_flush_interval_ms` | Integer | `2000` | `200` – `60,000` (60s) | Maximum age in milliseconds before pending events in queue are written to disk. |
| `fileRotationMb` | `file_rotation_mb` | Integer | `100` | `5` – `1,024` (1 GB) | Partition size threshold on disk. When exceeded, output continues to `{YYYY-MM-DD}-part2.csv`. |
| `enableIdempotency` | `enable_idempotency` | Boolean | `true` | `true` / `false` | Enables 5-minute sliding-window deduplication for events carrying an `eventId`. |
| `autoPruneDays` | `auto_prune_days` | Integer | `30` | `0` – `3,650` | Purges partition files older than this day threshold. Setting to `0` retains archives indefinitely. |
| `jwtSecret` | `jwt_secret` | String | `.env` value | Min 16 chars | Master JWT signing secret. Rotating triggers automated re-signing of all client tokens. |
| `updatedAt` | `updated_at` | DateTime | `now()` | ISO 8601 string | Timestamp recording the last administrative modification of platform settings. |
