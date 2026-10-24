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

Docker Compose builds the standalone Next.js web image and the separate Socket.IO ingestion image. Docker Engine with the Compose plugin is required.

1. Copy `.env.example` to `.env` and set unique values for `DATASTACK_JWT_SECRET`, `DATASTACK_ADMIN_SESSION_SECRET`, `DATASTACK_ADMIN_EMAIL`, `DATASTACK_ADMIN_PASSWORD`, `DATABASE_URL`, and `POSTGRES_PASSWORD`. Keep `.env` private and out of source control.
   `DATABASE_URL` must use the `postgres` service host and a password matching `POSTGRES_PASSWORD`.
2. From the repository root, validate and start the stack:

```powershell
docker compose --env-file .env -f docker/docker-compose.yml config
docker compose --env-file .env -f docker/docker-compose.yml up --build -d
```

The web console is published on port 3000 and the ingestion service on port 4000. Redis and PostgreSQL are private to the Compose network. CSV files written by the ingestion container persist in the `datastack-data` named volume; PostgreSQL metadata persists in `pgdata`.

The current web process still has a separate in-memory buffer and container-local storage view. Redis and Prisma/PostgreSQL are not yet used by application code, and the web process does not yet read the ingestion volume. Cross-process event visibility and shared storage are Phase P4 work; metadata persistence is Phase P5 work. Do not treat this Compose stack as production-ready until those phases and runtime checks are complete.
