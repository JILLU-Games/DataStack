# DataStack — Self-Hosted Universal Realtime Data Collection Platform

DataStack is a high-throughput, self-hosted data collection platform designed for high-frequency event ingestion over WebSockets with buffered batch persistence to CSV.

## Architecture

| Process                 | Port | Role                                                                     |
| :---------------------- | :--- | :----------------------------------------------------------------------- |
| **Next.js App Router**  | 3000 | Frontend UI, `/vcon/*` admin console, streaming CSV export `/api/export` |
| **Express + Socket.IO** | 4000 | WebSocket handshake, JWT client auth, event intake                       |
| **CSV Writer Worker**   | —    | In-memory buffer flush to CSV (`500 rows / 2s`)                          |

## Data Persistence

- **CSV Storage Path**: `/storage/data/{clientId}/{YYYY-MM-DD}.csv`
- **Schema**: `clientId, eventId, timestamp(ISO), payload(JSON)`
- **Rotation Rule**: Per-day OR 100MB threshold (whichever triggers first).
- **PostgreSQL**: Reserved for SDK client registration and admin settings. Runtime persistence is not wired yet; collected data is never inserted into PostgreSQL.

## Python SDK

Install the client:

```bash
pip install ./sdk-python
```

Usage:

```python
from datastack_sdk import DataStackClient

client = DataStackClient(server_url="http://localhost:4000", token="JWT_TOKEN")
if client.connect():
    client.sync({"metric": "load", "value": 42})
    client.disconnect()
```

## Running the Platform

```bash
# Terminal 1: Web Interface & Admin Console
npm run dev

# Terminal 2: Express Socket.IO Ingestion Engine
npm run server
```

## Production Containers

## Coolify Deployment

The repository includes a Docker Compose stack for a Coolify Git-based Docker Compose application. Coolify must be installed on a VPS with a domain and HTTPS configured.

1. In Coolify, add a Docker Compose application from `https://gitlab.com/ivibtools/datastack.git`, branch `main`.
2. Set Base Directory to `/` and Docker Compose Location to `docker/docker-compose.yml`.
3. Add the required variables in the Coolify application's Environment Variables: `DATASTACK_JWT_SECRET`, `DATASTACK_ADMIN_SESSION_SECRET`, `DATASTACK_ADMIN_EMAIL`, `DATASTACK_ADMIN_PASSWORD`, `DATABASE_URL`, and `POSTGRES_PASSWORD`. Use unique secrets; `DATABASE_URL` must use host `postgres`, database `datastack_db`, user `datastack`, and a password matching `POSTGRES_PASSWORD`.
4. In Domains, add the public HTTPS domain to service `proxy` on internal port `80`. Do not expose `web`, `ingestion`, Redis, or PostgreSQL directly. Coolify supplies proxy labels for the selected service.
5. Deploy and check service health and runtime logs in Coolify.

The proxy sends `/` to Next.js and `/socket.io/` to the Socket.IO service over the private Compose network. The Settings page uses the current origin for a deployed WebSocket URL; local development on port 3000 still displays port 4000.

The `datastack-data` named volume persists CSVs written by ingestion. The web process does not yet read that volume; Redis and Prisma/PostgreSQL are not yet used by application code. Cross-process event visibility/shared storage remains Phase P4 work and metadata persistence remains Phase P5 work. Coolify deployment does not resolve those production-readiness gaps, and this stack has not yet been built or deployed on a Coolify VPS from this environment.
