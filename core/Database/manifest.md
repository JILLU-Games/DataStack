# Database Engine Manifest

## Purpose
Manages the shared PostgreSQL connection pool (`pg.Pool`), automatic metadata table initialization, and live database health probes (`core/Database/database.ts`).

## Managed PostgreSQL Tables
PostgreSQL is dedicated strictly to platform metadata and security state:
1. `admin_users`: Administrator account credentials (scrypt password hashes).
2. `admin_login_attempts`: Brute-force login attempt counters and lockout timestamps.
3. `client_sdks`: Registered SDK clients, signed JWT tokens, rate limits, status (`active` / `revoked`), and event counters.
4. `admin_settings`: Global runtime settings (`max_events_per_sec`, `max_payload_size_kb`, `batch_flush_threshold`, `batch_flush_interval_ms`, `file_rotation_mb`, `jwt_secret`, `enable_idempotency`, `auto_prune_days`).

## Storage Separation Rule
Collected event streams are **never** inserted per-row into PostgreSQL; they are written exclusively in batches to partitioned CSV files under `/storage/data/{clientId}/{YYYY-MM-DD}.csv`.
