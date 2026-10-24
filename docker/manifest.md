# Docker Deployment Manifest

## Purpose

Production container definitions for the split architecture:

- `web`: standalone Next.js frontend and admin console on port 3000, running as a non-root user.
- `ingestion`: Express + Socket.IO process on port 4000, running as a non-root user.
- `proxy`: Nginx reverse proxy on internal port 80. Coolify routes the public domain to this service; `/socket.io/` is forwarded to ingestion and other paths to web.
- `redis`: private Compose service reserved for the planned shared-buffer integration; current application code does not consume it.
- `postgres`: private Compose service reserved for metadata integration; current application code does not use Prisma at runtime. Collected events must remain in CSV files.

## Coolify Compose Deployment

- Create a Git-based Docker Compose application from branch `main`.
- Set Base Directory to repository root `/` and Compose Location to `docker/docker-compose.yml`.
- Set every required interpolated variable in Coolify: JWT/admin secrets and credentials, `DATABASE_URL`, and `POSTGRES_PASSWORD`.
- Add the public domain to service `proxy` at internal port `80`. Coolify manages proxy labels in its normal Compose mode; do not enable Raw Compose mode or add direct host port mappings.
- The `web`, `ingestion`, Redis, and PostgreSQL services are private on the Compose network. Only the proxy is exposed to Coolify's domain proxy.
- The `datastack-data` named volume persists ingestion CSVs; `pgdata` persists PostgreSQL files.
- The web container does not yet share/read `datastack-data`, and neither Redis nor PostgreSQL is wired into runtime code. Those are later roadmap phases, so cross-process reads and metadata durability are not established by these images.
- Health checks probe the web landing route, ingestion `/health`, proxy route, Redis ping, and PostgreSQL readiness. These checks do not establish application-level shared-storage readiness.
