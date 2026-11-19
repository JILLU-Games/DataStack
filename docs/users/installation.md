# Installation & Deployment Guide

This guide explains how to install and self-host DataStack on your own server or cloud VPS.

---

## Prerequisites

Before starting, ensure your system meets the following minimum requirements:
- **Operating System**: Linux (Ubuntu 22.04+, Debian 12+, Alpine), macOS, or Windows WSL2.
- **Docker Engine**: Docker `v24.0+` and Docker Compose `v2.20+`.
- **System Resources**:
  - Minimum: 1 vCPU, 1 GB RAM, 10 GB disk space.
  - Recommended: 2 vCPU, 2–4 GB RAM, SSD storage scaled to your expected data volume.
- **Networking**: Ports `80` (HTTP) and `443` (HTTPS) accessible via your reverse proxy or cloud firewall.

---

## Method 1: Docker Compose (Recommended)

DataStack includes a complete, production-ready Docker Compose stack located in the [`docker/`](../../docker/) directory.

### 1. Clone the Repository
```bash
git clone https://github.com/vibtoolshq/datastack.git
cd datastack
```

### 2. Configure Environment Variables
Copy the example environment configuration:
```bash
cp .env.example .env
```

Generate secure, random 32+ character secrets for production:
```bash
# In Linux / macOS, generate 48-char random hex keys:
openssl rand -hex 32
```

Edit `.env` and fill in the required variables:
```dotenv
# Production Security Secrets (Minimum 32 characters each)
DATASTACK_ADMIN_SESSION_SECRET=your-random-32-plus-char-session-secret-here
DATASTACK_JWT_SECRET=your-random-32-plus-char-client-jwt-secret-here
DATASTACK_ADMIN_SETUP_KEY=your-random-32-plus-char-admin-setup-key-here
DATASTACK_INTERNAL_SECRET=your-random-32-plus-char-internal-service-secret-here

# Administrator Initial Email
DATASTACK_ADMIN_EMAIL=admin@yourcompany.com
```

### 3. Launch the Stack
Run Docker Compose from the project root:
```bash
docker compose -f docker/docker-compose.yml up -d
```

The stack launches 5 containers:
1. **`proxy`**: Nginx reverse proxy exposed on port `80`, routing `/socket.io/` to port `4000` and all other routes to port `3000`.
2. **`web`**: Next.js 15 standalone server running on port `3000`.
3. **`ingestion`**: Dedicated Express + Socket.IO ingestion server running on port `4000`.
4. **`postgres`**: PostgreSQL 16 database storing administrative credentials, SDK client records, and settings.
5. **`redis`**: Redis 7 container running with `--appendonly yes` for crash-resilient queue buffering.

---

## Method 2: Coolify Cloud / Self-Hosted PaaS

DataStack is optimized for deployment via [Coolify](https://coolify.io/):

1. **Create Resource**: In Coolify, click **+ Add Resource** → **Docker Compose**.
2. **Repository Settings**:
   - Point to your DataStack Git repository.
   - Set **Base Directory** to `/` (so Compose build context `..` from `/docker` resolves cleanly to the repository root; if an existing VPS deployment already has saved working Coolify paths, keep its current settings).
   - Set **Docker Compose Location** to `/docker/docker-compose.yml`.
3. **Domain Assignment**:
   - Attach your custom domain (e.g. `https://datastack.yourdomain.com`) to the **`proxy`** service on internal port `80`.
   - Enable automatic SSL/TLS via Coolify's built-in Let's Encrypt integration.
4. **Environment Variables**:
   - Coolify automatically injects generated `SERVICE_*` variables for database and JWT secrets.
5. **Deploy**: Click **Deploy** and monitor the build logs until all 5 services are healthy.

---

## First-Run Administrator Setup (`/vcon/setup`)

Once the stack is running:
1. Open your browser and navigate to:
   ```text
   https://your-domain.example/vcon/setup
   ```
2. You will be prompted to enter:
   - **Administrator Email**: Must match `DATASTACK_ADMIN_EMAIL` or your chosen admin email.
   - **Administrator Password**: Choose a strong password (minimum 8 characters).
   - **Setup Security Key**: Enter the exact value configured in `DATASTACK_ADMIN_SETUP_KEY`.
3. Click **Complete Initial Setup**. You will be securely logged in and redirected to the `/vcon/dashboard` console.

---

## Persistent Storage & Volumes

DataStack uses three named volumes to safeguard your data across container updates:

| Volume Name | Container Path | Purpose |
| :--- | :--- | :--- |
| **`datastack-data`** | `/app/storage` | Contains `/app/storage/data/{clientId}/{YYYY-MM-DD}.csv`. Shared by `web` and `ingestion`. |
| **`pgdata`** | `/var/lib/postgresql/data` | Persists administrative users, client credentials, and settings. |
| **`redisdata`** | `/data` | Persists Redis Append-Only File (`appendonly.aof`) for unflushed event buffers. |

> **IMPORTANT**: When upgrading or redeploying containers, never execute `docker compose down -v`, as the `-v` flag deletes named volumes. Use standard `docker compose down` followed by `docker compose up -d`.
