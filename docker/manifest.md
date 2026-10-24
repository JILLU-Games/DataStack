# Docker Deployment Manifest

## Purpose

Production container definitions for the split architecture:

- `web`: standalone Next.js frontend and admin console on port 3000, running as a non-root user.
- `ingestion`: Express + Socket.IO process on port 4000, running as a non-root user.
- `redis`: private Compose service reserved for the planned shared-buffer integration; current application code does not consume it.
- `postgres`: private Compose service reserved for metadata integration; current application code does not use Prisma at runtime. Collected events must remain in CSV files.

## Build and Run

- Run from the repository root with Docker Engine and the Compose plugin installed.
- Copy `.env.example` to `.env` and provide non-empty deployment values; Compose deliberately has no committed secret defaults.
- Validate and start with `docker compose --env-file .env -f docker/docker-compose.yml config` and `docker compose --env-file .env -f docker/docker-compose.yml up --build -d`.
- Only the web and ingestion ports are published. PostgreSQL and Redis remain private to the Compose network.
- The `datastack-data` named volume persists ingestion CSVs; `pgdata` persists PostgreSQL files.
- The web container does not yet share/read `datastack-data`, and neither Redis nor PostgreSQL is wired into runtime code. Those are later roadmap phases, so cross-process reads and metadata durability are not established by these images.
- Health checks probe the public landing route, ingestion `/health`, Redis ping, and PostgreSQL readiness. These checks do not establish application-level shared-storage readiness.
