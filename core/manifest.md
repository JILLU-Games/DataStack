# Core Backend Modules Manifest

## Purpose
Core TypeScript backend engines powering authentication, client SDK management, event buffering, CSV partition storage, and PostgreSQL metadata persistence.

## Submodules
- `auth/`: Client JWT signing/verification (`jwt.ts`), WebCrypto HMAC-SHA256 admin session tokens (`adminSession.ts`), and PostgreSQL scrypt admin user/lockout management (`adminUsers.ts`).
- `Database/`: Shared PostgreSQL connection pool (`pg.Pool`), automatic schema initialization (`client_sdks`, `admin_settings`), and live `SELECT 1` health checks (`database.ts`).
- `sdk/`: Client SDK registration, token rotation, status revocation, deletion, and event counters backed by PostgreSQL (`sdkManager.ts`).
- `adminSettings/`: Platform runtime configuration store backed by PostgreSQL with live propagation to security, buffer, and storage engines (`settingsManager.ts`).
- `data/`: In-memory event batching queue with configurable flush threshold and interval timer (`buffer.ts`).
- `Storage/`: Partitioned CSV writer (`/storage/data/{clientId}/{YYYY-MM-DD}.csv`), size-based file rotation (`-part2.csv`), and retention pruning (`csvStorage.ts`).
- `Security/`: Per-client sliding-window rate limiter, 5-minute TTL idempotency deduplication, and payload byte-size validation (`security.ts`).
- `apiEngine/`: Consolidated dashboard metrics aggregator combining local storage stats with Port 4000 `/health` telemetry (`apiService.ts`).
