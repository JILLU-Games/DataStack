# Docker Deployment Manifest

## Purpose

Production container definitions for the split architecture:

- `web`: standalone Next.js frontend and admin console on port 3000, running as a non-root user.
- `ingestion`: Express + Socket.IO process on port 4000, running as a non-root user.
- `proxy`: Nginx reverse proxy on internal port 80. Coolify routes the public domain to this service; `/socket.io/` is forwarded to ingestion and other paths to web.
- `redis`: private Compose service reserved for the planned shared-buffer integration; current application code does not consume it.
- `postgres`: private Compose service; the first-run admin setup/login helper stores the single bootstrap admin credential in `admin_users` using `pg`. Prisma-backed client/settings/audit metadata is not wired yet. Collected events must remain in CSV files.

## Coolify Compose Deployment

- Create a Git-based Docker Compose application from branch `main`.
- Set Base Directory to `/docker` and Compose Location to `/docker/docker-compose.yml`. Confirm the resolved file remains the repository's `docker/docker-compose.yml`. The `/docker` project directory is required because each service uses `build.context: ..` to reach the repository root; using `/` makes that context escape the checkout.
- Set `DATASTACK_ADMIN_EMAIL` in Coolify. Compose uses generated `SERVICE_HEX_32_DATABASENAME`, `SERVICE_PASSWORD_64_POSTGRES`, `SERVICE_REALBASE64_64_JWT`, `SERVICE_REALBASE64_64_ADMINSESSION`, and `SERVICE_REALBASE64_64_ADMININSTALL`; `DATABASE_URL` is assembled from the generated DB name/password.
- On first visit, copy `SERVICE_REALBASE64_64_ADMININSTALL` from Coolify into `/vcon/setup`, confirm the `DATASTACK_ADMIN_EMAIL` configured in Coolify, choose the first admin password, and keep generated secrets in Coolify. The API enforces the configured email and setup closes after the first account is persisted.
- Add the public domain to service `proxy` at internal port `80`. Coolify manages proxy labels in its normal Compose mode; do not enable Raw Compose mode or add direct host port mappings.
- The `web`, `ingestion`, Redis, and PostgreSQL services are private on the Compose network. Only the proxy is exposed to Coolify's domain proxy.
- The `datastack-data` named volume stores ingestion CSVs; `pgdata` stores PostgreSQL files and the bootstrap admin credential. Compose configures these named volumes for persistence; verify restart/redeploy behavior in the target Coolify runtime before relying on it. Do not delete the volumes or regenerate the DB name for an existing deployment. Back up before DB upgrades. DB password rotation requires changing the DB role as well as the Coolify value.
- The web container does not yet share/read `datastack-data`, and Redis is not wired into runtime code. Prisma-backed client/settings metadata remains future work; cross-process reads and general metadata durability are not established by these images.
- Health checks probe the web landing route, ingestion `/health`, proxy route, Redis ping, and PostgreSQL readiness using the generated `POSTGRES_DB` name. These checks do not establish application-level shared-storage readiness.
