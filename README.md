# DataStack — Open-Source Self-Hosted Real-Time Telemetry & Event Logging Platform

> **Practical software for real workflows.** Stream structured events over WebSockets and REST, buffer batches in memory, and persist clean, portable CSV datasets with full operational control.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Next.js 15](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![Socket.IO 4.8](https://img.shields.io/badge/Socket.IO-4.8-010101)](https://socket.io/)
[![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-336791)](https://www.postgresql.org/)
[![Python SDK](https://img.shields.io/badge/Python_SDK-3.8%2B-3776AB)](./sdk-python)
[![Built by Vib Tools](https://img.shields.io/badge/Maintained%20by-Vib%20Tools-0f172a)](https://vib.tools/)

**DataStack** is a free, open-source, self-hosted real-time data collection and telemetry logging platform developed by **[Vib Tools](https://vib.tools/)**. It is designed for developers, technical teams, operators, and researchers who need a fast, inspectable, and maintainable system to collect structured JSON events over **Socket.IO WebSockets** and **HTTP REST APIs**, buffer them in memory, and persist them into daily and size-rotated **CSV partitions** without the complexity of heavyweight log clusters or per-row database bottlenecks.

---

## Table of Contents

1. [Why DataStack?](#why-datastack)
2. [Complete A–Z Feature Overview](#complete-az-feature-overview)
3. [System Architecture](#system-architecture)
4. [Admin Console (`/vcon/*`) Guide](#admin-console-vcon-guide)
5. [Quick Start (Local Development)](#quick-start-local-development)
6. [Environment Variables](#environment-variables)
7. [Python SDK (`datastack-sdk`)](#python-sdk-datastack-sdk)
8. [HTTP REST & WebSocket API Reference](#http-rest--websocket-api-reference)
9. [Docker Compose & Coolify Deployment](#docker-compose--coolify-deployment)
10. [Repository Structure](#repository-structure)
11. [Contributing & Security](#contributing--security)
12. [Author & Contact Information (Vib Tools)](#author--contact-information-vib-tools)
13. [License](#license)

---

## Why DataStack?

Many teams need to collect high-frequency telemetry, service heartbeats, IoT sensor readings, or structured operational events, but face two extremes:
- Inserting thousands of events per second row-by-row into a relational database creates lock contention and storage bloat.
- Deploying distributed log clusters introduces high infrastructure costs and operational overhead.

**DataStack solves this with a focused, transparent architecture:**
- **Zero Per-Row Database Inserts**: Incoming events are validated in memory, queued in a batch buffer, and appended in batches to partitioned CSV files (`/storage/data/{clientId}/{YYYY-MM-DD}.csv`).
- **PostgreSQL for Control-Plane Metadata Only**: PostgreSQL (`pg`) is dedicated strictly to administrator authentication (`admin_users`), brute-force login protection (`admin_login_attempts`), SDK client credentials (`client_sdks`), and platform configuration (`admin_settings`).
- **Portable, Inspectable Datasets**: Collected data lives in standard CSV partitions that can be searched in the browser, exported as streaming CSV or JSON archives, or loaded directly into Python, Pandas, DuckDB, R, or Excel.

---

## Complete A–Z Feature Overview

### 1. Real-Time Ingestion Engine (Port 4000 & Port 3000)
- **Dedicated Socket.IO Server (`Port 4000`)**: Handles persistent WebSocket connections (`sync_data` for single events and `batch_sync` for batch arrays) completely decoupled from Next.js serverless routes.
- **Authenticated HTTP Ingestion (`POST /api/events`)**: Supports standard HTTP POST ingestion authenticated via either a Client Bearer JWT token (`Authorization: Bearer <token>`) or an active Administrator Session Cookie.
- **Sub-Millisecond In-Memory Batching**: Queues incoming events in memory and flushes to disk automatically when reaching `batchFlushThreshold` (default `500` events) or on a periodic timer (`batchFlushIntervalMs`, default `2000ms`).
- **On-Demand Cross-Process Buffer Flush**: Clicking **Flush Buffer** in `/vcon/storage` (`POST /api/storage`) or triggering an export (`GET /api/export`) flushes both the Next.js buffer and the Port 4000 Socket.IO buffer immediately.

### 2. Partitioned CSV Storage & Lifecycle Management
- **Client & Date Partitioning**: Stores events under `/storage/data/{clientId}/{YYYY-MM-DD}.csv` with a consistent 4-column schema: `clientId,eventId,timestamp,payload`.
- **Automatic Size-Based File Rotation**: Automatically rotates active daily partitions to `{YYYY-MM-DD}-part2.csv`, `-part3.csv`, etc. when a file reaches `fileRotationMb` (default `100 MB`).
- **Automated Retention Pruning (`autoPruneDays`)**: Automatically removes expired daily CSV partitions older than the configured retention window (default `30` days).
- **Streaming CSV & JSON Exports**: Streams filtered datasets across any client and date range (`Today`, `7d`, `30d`, `All`, or custom dates) in either `.csv` or parsed `.json` format (`GET /api/export`).

### 3. Client SDK Management & Access Governance
- **Per-Client JWT Credentials**: Issue unique `clientId`, secret key, and signed HMAC-SHA256 JWT tokens from `/vcon/clients`.
- **Configurable Per-Client Rate Limiting**: Enforce per-second sliding-window rate limits customized for each client (`client.rateLimit` capped by global `maxEventsPerSec`).
- **Payload Size Guard**: Rejects oversized event payloads exceeding `maxPayloadSizeKb` (default `100 KB`) before buffering.
- **5-Minute TTL Idempotency Deduplication**: Prevents duplicate event ingestion for identical `clientId:eventId` pairs within a 5-minute sliding window with automatic memory cleanup.
- **Live Key Rotation, Revocation & Deletion**: Rotate client JWT tokens, temporarily revoke/reactivate client access (`403 CLIENT_REVOKED`), or permanently delete client registrations with immediate enforcement across both HTTP and Socket.IO engines.
- **Automatic Token Re-Signing**: Updating the platform `jwtSecret` in `/vcon/settings` automatically re-signs active client tokens in PostgreSQL so client credentials stay synchronized.

### 4. Security & Administrator Authentication
- **First-Run Installation Setup (`/vcon/setup`)**: Protected by a one-time installation key (`DATASTACK_ADMIN_SETUP_KEY`); permanently locks once the initial administrator account is created in PostgreSQL.
- **Scrypt Password Hashing & Timing-Safe Verification**: Administrator passwords are hashed with Node.js `crypto.scrypt` (`N=16384, r=8, p=1`) and verified using `timingSafeEqual`.
- **Brute-Force Login Lockout**: Tracks failed login attempts in PostgreSQL (`admin_login_attempts`), locking sign-in for 15 minutes after 5 failed attempts within a 15-minute window and returning a `Retry-After` header.
- **WebCrypto HMAC-SHA256 Sessions**: Issues `HttpOnly`, `SameSite=Lax` session cookies (`8 hours` standard or `30 days` with **Remember me**), preserving remaining session lifetime across profile updates.
- **Edge CSRF Protection**: Next.js Middleware (`middleware.ts`) enforces same-origin `Origin` / `Host` / `X-Forwarded-Host` verification on state-changing requests.

---

## System Architecture

```text
+-----------------------------------------------------------------------+
|                        External SDK & HTTP Clients                    |
|        Python SDK (datastack-sdk)  |  Browser Simulator / REST        |
+------------------------------------+----------------------------------+
                                     |
                     +---------------+---------------+
                     | Nginx Reverse Proxy (Port 80) |
                     +---------------+---------------+
                                     |
             +-----------------------+-----------------------+
             | (/socket.io/*)                                | (/* & /api/*)
             v                                               v
+------------------------------------+   +------------------------------------+
|  Port 4000: Socket.IO Ingestion    |   |  Port 3000: Next.js 15 App Router  |
|  - JWT Handshake & Live Revocation |   |  - /vcon/* Admin Console UI        |
|  - Rate Limit & Payload Guard      |   |  - POST /api/events REST Ingestion |
|  - 5-Min TTL Idempotency Map       |   |  - GET /api/export CSV/JSON Stream |
|  - In-Memory Batch Queue           |   |  - Edge Middleware Auth & CSRF     |
+-----------------+------------------+   +-----------------+------------------+
                  |                                        |
                  +-------------------+--------------------+
                                      |
          +---------------------------+---------------------------+
          |                                                       |
          v                                                       v
+------------------------------------+   +------------------------------------+
|  Shared CSV Volume (storage/data)  |   |  PostgreSQL 16 Metadata Database   |
|  /storage/data/{clientId}/         |   |  - admin_users                     |
|    {YYYY-MM-DD}.csv                |   |  - admin_login_attempts            |
|    {YYYY-MM-DD}-part2.csv          |   |  - client_sdks                     |
+------------------------------------+   |  - admin_settings                  |
                                         +------------------------------------+
```

---

## Admin Console (`/vcon/*`) Guide

| Route | View Name | Key Capabilities |
| :--- | :--- | :--- |
| `/vcon/dashboard` | **Dashboard** | View total stored rows, active Socket.IO connections, disk usage, buffered event counts, registered clients, and live recent events. |
| `/vcon/clients` | **Clients** | Register new SDK clients, copy signed JWT tokens, inspect per-client event counters and last-seen timestamps, rotate keys, revoke access, or delete clients. |
| `/vcon/data` | **Data Browser** | Search and filter persisted CSV rows by client and keyword, paginate through records, and inspect formatted JSON payloads. |
| `/vcon/export` | **Export** | Build custom exports filtered by client and date range (`Today`, `7d`, `30d`, `All`), preview row/byte counts, and stream `.csv` or `.json` downloads. |
| `/vcon/storage` | **Storage** | Monitor disk usage, total CSV partition files, active rotation rules (`100MB / Daily`), and trigger an immediate manual buffer flush. |
| `/vcon/settings` | **Settings** | Tune rate limits (`maxEventsPerSec`), payload size limits (`maxPayloadSizeKb`), flush thresholds, file rotation size, retention days (`autoPruneDays`), idempotency, and JWT secret. |
| `/vcon/sdk` | **Python SDK** | Select any registered client from the dropdown to generate a ready-to-run Python snippet pre-populated with that client's signed JWT token. |
| `/vcon/simulator` | **Simulator** | Emit single events or configurable batch test payloads directly from the browser to verify ingestion, rate limits, and CSV flushing. |
| `/vcon/profile` | **Admin Profile** | Update the administrator email address or password with current-password verification. |

---

## Quick Start (Local Development)

### Prerequisites
- **Node.js** `20+` and `npm`
- **PostgreSQL** `15+` (optional for local development; required for persistent multi-process production state)
- **Python** `3.8+` (optional, for using `datastack-sdk`)

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/vibtoolshq/datastack.git
cd datastack
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

### 3. Run the Platform

```bash
# Terminal 1: Start Next.js Web UI & Admin Console (Port 3000)
npm run dev

# Terminal 2: Start Express + Socket.IO Ingestion Service (Port 4000)
npm run server
```

Visit `http://localhost:3000` for the overview page or `http://localhost:3000/vcon/dashboard` for the Admin Console.

---

## Environment Variables

All environment variables are documented in [`.env.example`](./.env.example):

| Variable | Default / Example | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Next.js web and admin console port |
| `PORT_SOCKET` | `4000` | Express + Socket.IO ingestion server port |
| `DATABASE_URL` | `postgresql://user:pass@localhost:5432/datastack` | PostgreSQL connection string for control-plane tables |
| `DATASTACK_JWT_SECRET` | 32+ char secret | HMAC secret used to sign and verify Client SDK JWT tokens |
| `DATASTACK_ADMIN_SESSION_SECRET` | 32+ char secret | HMAC secret used to sign administrator session cookies |
| `DATASTACK_ADMIN_EMAIL` | `admin@datastack.dev` | Default administrator email pre-filled during initial setup |
| `DATASTACK_ADMIN_SETUP_KEY` | Random secret key | One-time installation key required at `/vcon/setup` |
| `INGESTION_INTERNAL_URL` | `http://127.0.0.1:4000` | Internal URL used by Next.js to query Port 4000 `/health` and `/internal/flush` |

---

## Python SDK (`sdk/python/datastack/`)

The official production Python SDK is located in [`./sdk/python/datastack`](./sdk/python/datastack) (with full backward compatibility in [`./sdk-python`](./sdk-python)). It provides zero-boilerplate `config.datastack.py` auto-discovery, low-latency Socket.IO streaming, automatic Heartbeat HTTP fallback (`POST /api/events`), offline disk spooling (`.datastack_spool/spool.jsonl`), and direct `.csv`, `.json`, and `.jsonl` file ingestion.

### Installation

```bash
# Install from local repository
pip install ./sdk/python/datastack

# Or install from PyPI release
pip install datastack
```

### 1. Drop `config.datastack.py` into Your Project Root

You can copy a pre-populated `config.datastack.py` directly from **`/vcon/sdk`**:

```python
# config.datastack.py
DATASTACK_CONFIG = {
    "SERVER_URL": "http://localhost:4000",        # Port 4000 Socket.IO Ingestion Service
    "API_URL": "http://localhost:3000",           # Port 3000 HTTP Fallback & File Ingestion API
    "CLIENT_TOKEN": "YOUR_SIGNED_CLIENT_JWT_TOKEN",
    "AUTO_CONNECT": True,
    "ENABLE_HTTP_FALLBACK": True,
    "HEARTBEAT_INTERVAL_SEC": 5.0,
    "MAX_RETRIES": 3,
    "BATCH_CHUNK_SIZE": 250,
    "OFFLINE_SPOOL_ENABLED": True,
    "OFFLINE_SPOOL_DIR": ".datastack_spool",
}
```

### 2. Stream Events, Batches, and `.csv` / `.json` Files

```python
from datastack import DataStack

# Automatically discovers config.datastack.py and connects
client = DataStack()

# 1. Send a single event (WebSocket primary -> Auto HTTP Fallback -> Offline Spool)
ack = client.send({
    "event_type": "sensor_reading",
    "device_id": "env-node-04",
    "temperature_c": 24.2,
    "humidity_pct": 56.8,
})
print("Single event ack:", ack)

# 2. Send a batch of events
batch_ack = client.send_batch([
    {"metric": "cpu_usage", "value": 38.4, "unit": "%"},
    {"metric": "memory_used_mb", "value": 2048, "unit": "MB"},
])
print("Batch ack:", batch_ack)

# 3. Directly stream a .csv, .json, or .jsonl file in chunks
file_ack = client.send_file("monthly_telemetry.csv", chunk_size=250)
print("File ingestion ack:", file_ack)

# 4. Inspect connection state & Heartbeat IDLE status
print("SDK status:", client.status())

client.disconnect()
```

---

## HTTP REST & WebSocket API Reference

### WebSocket Events (Port 4000)
Connect with Socket.IO handshake auth: `auth: { token: "<CLIENT_JWT_TOKEN>" }`.

- **`sync_data`**: Emit `{ eventId?, timestamp?, data }` -> Callback returns `{ success: true, eventId }` or `{ success: false, error }`.
- **`batch_sync`**: Emit `[{ eventId?, timestamp?, data }, ...]` -> Callback returns `{ success: true, processed, rejected, errors? }`.
- **`ping_verify`**: Emit `{}` -> Verifies live client status in PostgreSQL and returns `{ success: true, status: "VERIFIED", clientId, rateLimit, maxPayloadSizeBytes, serverTime }`.

### REST Endpoints (Port 3000)

| Method & Endpoint | Auth Required | Description |
| :--- | :--- | :--- |
| `POST /api/events` | Client Bearer JWT or Admin Cookie | Ingest a single event, `{ batch: [...] }`, or `{ fileName, records: [...] }` over HTTP |
| `GET /api/events` | Admin Session Cookie | List recent buffered and persisted events |
| `GET /api/clients` | Admin Session Cookie | List registered SDK clients and their signed JWT tokens |
| `POST /api/clients` | Admin Session Cookie | Register a new SDK client (`clientId`, `name`, `rateLimit`) |
| `PATCH /api/clients/[id]` | Admin Session Cookie | Rotate client token (`action: "regenerate_token"`) or update status/rate limit |
| `DELETE /api/clients/[id]` | Admin Session Cookie | Permanently delete a client registration |
| `GET /api/data` | Admin Session Cookie | Query paginated CSV records (`clientId`, `search`, `page`, `limit`) |
| `GET /api/export` | Admin Session Cookie | Stream filtered dataset export (`clientId`, `from`, `to`, `format=csv\|json`) |
| `GET /api/storage` | Admin Session Cookie | Get CSV partition file list and disk usage statistics |
| `POST /api/storage` | Admin Session Cookie | Flush both Next.js and Port 4000 buffers to disk immediately |
| `GET / PUT /api/settings` | Admin Session Cookie | Read or update platform runtime settings |
| `GET /api/metrics` | Admin Session Cookie | Consolidated system health, buffer, storage, and Socket.IO metrics |

---

## Docker Compose & Coolify Deployment

DataStack includes a production-ready Docker Compose stack in [`docker/docker-compose.yml`](./docker/docker-compose.yml):

- **`proxy`**: Nginx reverse proxy on internal port `80` routing `/socket.io/` to `ingestion:4000` and all other traffic to `web:3000`.
- **`web`**: Standalone Next.js 15 container on port `3000` (runs as non-root user).
- **`ingestion`**: Express + Socket.IO container on port `4000` (runs as non-root user).
- **`postgres`**: PostgreSQL 16 with persistent `pgdata` volume.
- **`redis`**: Redis 7 with persistent `redisdata` volume.
- **`datastack-data` Volume**: Mounted at `/app/storage` (persisting `/app/storage/data/{clientId}/{YYYY-MM-DD}.csv`) in both `web` and `ingestion` so CSV partitions are shared seamlessly across containers.

### Coolify Deployment Steps
1. Create a **Docker Compose** resource in Coolify pointing to your repository.
2. Set **Base Directory** to `/` and **Docker Compose Location** to `/docker/docker-compose.yml`.
3. Attach your HTTPS domain to the `proxy` service on port `80`.
4. Deploy the stack, open `https://your-domain.example/vcon/setup`, and enter your administrator email, password (8+ characters), and the generated `SERVICE_REALBASE64_64_ADMININSTALL` key from Coolify's environment variables.

---

## Repository Structure

```text
datastack/
├── app/                  # Next.js 15 App Router (landing page, /vcon/* console, /api/* routes)
├── components/
│   ├── layout/           # Shared layout shells (MainLayout, Navbar, Sidebar, PageShell, SettingsPanel)
│   ├── sections/         # Modular page sections (Hero, Features, ClientsTable, ExportWorkspace, etc.)
│   └── ui/               # Single-source-of-truth UI primitives (Button, Input, Table, Modal, StatStrip)
├── core/                 # Backend TypeScript modules (auth, Database, sdk, adminSettings, data, Storage, Security)
├── server/               # Dedicated Port 4000 Express + Socket.IO service & CSV batch worker
├── sdk/                  # Official pip-installable Python SDK (`./sdk/python/datastack`)
├── sdk-python/           # Backward-compatible Python client package (`datastack-sdk`)
├── storage/              # Partitioned CSV storage root (/storage/data/{clientId}/{YYYY-MM-DD}.csv)
├── docker/               # Production Dockerfiles, Nginx config, and docker-compose.yml
├── nginx/                # Local Nginx reverse proxy configuration
├── AGENTS.md             # Architecture conventions and engineering rules
├── CONTRIBUTING.md       # Contributor guidelines and development workflow
├── SECURITY.md           # Security architecture and vulnerability reporting policy
├── CODE_OF_CONDUCT.md    # Community standards and expectations
├── CHANGELOG.md          # Release history and version notes
└── LICENSE               # Open-Source MIT License
```

---

## Contributing & Security

- **Contributing**: Contributions, bug reports, and focused pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes.
- **Security Policy**: To report a security vulnerability privately, please follow [SECURITY.md](./SECURITY.md) and contact **support@vibtools.io**.
- **Code of Conduct**: Participation in this project is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## Author & Contact Information (Vib Tools)

**DataStack** is developed and maintained by **[Vib Tools](https://vib.tools/)** — a software organization building practical desktop applications, self-hosted software, automation tooling, developer utilities, reusable frameworks, and open-source projects for real workflows.

| Channel | Details |
| :--- | :--- |
| **Organization / Author** | **Vib Tools** (`vibtools`) |
| **Official Website** | [https://vib.tools/](https://vib.tools/) |
| **GitHub Organization** | [https://github.com/vibtoolshq](https://github.com/vibtoolshq) |
| **GitLab Organization** | [https://gitlab.com/vibtools](https://gitlab.com/vibtools) |
| **General Inquiries** | [hello@vibtools.io](mailto:hello@vibtools.io) |
| **Technical & Product Support** | [support@vibtools.io](mailto:support@vibtools.io) |
| **Phone / WhatsApp** | `+880 1795-470603` (GMT+6 / Asia-Dhaka) |
| **Head Office** | Vib Tools HQ, 5660 Kochakata, Nageswari, Kurigram, Rangpur, Bangladesh |

### Official Social & Community Profiles
- **X (Twitter)**: [https://x.com/vibtools](https://x.com/vibtools)
- **Facebook**: [https://www.facebook.com/vib.tools](https://www.facebook.com/vib.tools)
- **Instagram**: [https://www.instagram.com/vib.tools/](https://www.instagram.com/vib.tools/)
- **Reddit**: [https://www.reddit.com/user/VibTools/](https://www.reddit.com/user/VibTools/)
- **TikTok**: [https://www.tiktok.com/@vibtools](https://www.tiktok.com/@vibtools)

---

## License

Copyright © 2026 [Vib Tools](https://vib.tools/). Released under the **[MIT License](./LICENSE)**.
