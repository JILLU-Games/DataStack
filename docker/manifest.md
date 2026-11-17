# Docker & Coolify Deployment Manifest

## Purpose
Production container definitions and orchestration for DataStack's multi-service architecture (`docker/`):

- `web` (`Dockerfile.web`): Standalone Next.js 15 frontend, `/vcon/*` admin console, and REST API on port `3000` (runs as non-root user).
- `ingestion` (`Dockerfile.server`): Express + Socket.IO real-time ingestion server on port `4000` (runs as non-root user).
- `proxy` (`Dockerfile.proxy` + `coolify-nginx.conf`): Nginx reverse proxy on internal port `80`, forwarding `/socket.io/` to `ingestion:4000` and web traffic to `web:3000`.
- `postgres`: PostgreSQL 16 service with persistent `pgdata` volume storing `admin_users`, `admin_login_attempts`, `client_sdks`, and `admin_settings`.
- `redis`: Redis 7 service with persistent `redisdata` volume.

## Shared Volumes & Networking
- Both `web` and `ingestion` mount the `datastack-data` volume at `/app/storage/data`, ensuring CSV partitions written by either process are immediately visible across the platform.
- Both `web` and `ingestion` connect to `postgres` via `DATABASE_URL` over the private Compose network, synchronizing client registrations, revocation status, and runtime settings automatically.
- `web` communicates with `ingestion` via `INGESTION_INTERNAL_URL="http://ingestion:4000"` for live health metrics and manual buffer flushes.
