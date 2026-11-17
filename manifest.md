# DataStack Platform Root Manifest

## Purpose
Root directory manifest for **DataStack**, an open-source, self-hosted real-time telemetry and event logging platform developed by **[Vib Tools](https://vib.tools/)**.

## Directory & Governance Index
- `app/`: Next.js 15 App Router serving `/` (public overview), `/vcon/*` (administration console), and `/api/*` (REST endpoints for auth, clients, events, data, storage, settings, and streaming export).
- `components/`: Single-source-of-truth UI primitives (`components/ui/`), layout shells (`components/layout/`), and page sections (`components/sections/`).
- `core/`: Backend TypeScript modules (`auth`, `data`, `Database`, `Storage`, `Security`, `sdk`, `adminSettings`, `apiEngine`).
- `server/`: Dedicated Express + Socket.IO ingestion service on Port 4000 (`index.js`, `socket/handlers.js`, `workers/csvWriter.js`).
- `storage/`: Partitioned CSV data directory (`/storage/data/{clientId}/{YYYY-MM-DD}.csv`).
- `sdk/python/datastack/`: Official production Python SDK (`datastack`) featuring `config.datastack.py` auto-discovery, Heartbeat HTTP fallback, offline disk spooling, and direct `.csv`/`.json`/`.jsonl` file ingestion.
- `sdk-python/`: Backward-compatible Python client package (`datastack-sdk`).
- `docker/`: Production Dockerfiles (`Dockerfile.web`, `Dockerfile.server`, `Dockerfile.proxy`), Nginx config, and `docker-compose.yml`.
- `nginx/`: Local Nginx reverse proxy configuration (`default.conf`).
- `README.md`: Comprehensive A–Z project documentation, quickstart, architecture, and deployment guide.
- `AGENTS.md`: Architecture rules and engineering conventions.
- `CONTRIBUTING.md`: Open-source contribution guidelines and local development workflow.
- `SECURITY.md`: Built-in security architecture and vulnerability reporting policy (`support@vibtools.io`).
- `CODE_OF_CONDUCT.md`: Community code of conduct.
- `CHANGELOG.md`: Release history and version notes.
- `LICENSE`: Open-source MIT License (`Copyright (c) 2026 Vib Tools`).
