# Changelog

All notable changes to **DataStack** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-11-17

### Added
- **Decoupled Dual-Runtime Architecture**:
  - Next.js 15 App Router (**Port 3000**) serving the public overview, `/vcon/*` administration console, authenticated REST ingestion (`POST /api/events`), and streaming dataset exports (`GET /api/export`).
  - Dedicated Express + Socket.IO server (**Port 4000**) handling persistent WebSocket handshakes, `sync_data` single-event intake, and `batch_sync` batch ingestion.
- **PostgreSQL Control-Plane Persistence (`pg.Pool`)**:
  - Automatic schema provisioning and persistence for `admin_users`, `admin_login_attempts`, `client_sdks`, and `admin_settings`.
  - Live `SELECT 1` database health checks integrated into `/api/metrics` and `/vcon/dashboard`.
- **Partitioned CSV Storage & Retention Engine**:
  - In-memory batch buffering (`DataBufferEngine` and Port 4000 queue) flushing to `/storage/data/{clientId}/{YYYY-MM-DD}.csv` on threshold (`batchFlushThreshold`) or timer (`batchFlushIntervalMs`).
  - Automatic size-based file rotation (`{YYYY-MM-DD}-part2.csv`) at configurable `fileRotationMb` thresholds.
  - Automatic retention pruning (`CSVStorageManager.pruneExpiredPartitions(autoPruneDays)`) for expired daily CSV partitions.
- **Client SDK Registry & Security Governance**:
  - Per-client HMAC-SHA256 JWT token issuance, one-click key rotation, live revocation (`CLIENT_REVOKED`), and permanent client deletion (`DELETE /api/clients/[id]`).
  - Per-client sliding-window rate limiting, payload byte-size guards (`maxPayloadSizeKb`), and 5-minute TTL idempotency deduplication with automatic memory cleanup.
  - Automatic bulk client token re-signing (`SDKManager.resignAllClientTokensAsync()`) when the platform `jwtSecret` is updated in `/vcon/settings`.
- **Administrator Authentication & Session Hardening**:
  - First-run setup flow (`/vcon/setup`) guarded by `DATASTACK_ADMIN_SETUP_KEY`.
  - Node.js `crypto.scrypt` password hashing, timing-safe credential verification, and 5-attempt / 15-minute brute-force login lockout.
  - WebCrypto HMAC-SHA256 session cookies (`8h` standard / `30d` Remember me) with preserved session TTL on profile updates (`PUT /api/auth/profile`).
- **Official Python SDK (`datastack-sdk` v1.0.0)**:
  - Pip-installable `DataStackClient` with JWT handshake authentication, automatic reconnection, and `threading.Event` acknowledgment synchronization for `sync()` and `batch_sync()`.
- **Docker Compose & Coolify Production Stack**:
  - Multi-stage Dockerfiles (`Dockerfile.web`, `Dockerfile.server`, `Dockerfile.proxy`), Nginx WebSocket/HTTP reverse proxy, and shared `datastack-data` and `pgdata` volumes.
