# Local Development Setup

This guide walks contributors through configuring and running DataStack locally on your development workstation.

---

## 1. Prerequisites

Ensure the following tools are installed:
- **Node.js**: Version `22.x` (LTS recommended)
- **Package Manager**: `npm` (v10+)
- **Python**: Version `3.10+` (optional, for developing and testing the Python client SDK)
- **Docker & Docker Compose**: Optional, useful for running local PostgreSQL and Redis instances.

---

## 2. Clone & Install Dependencies

```bash
git clone https://github.com/vibtoolshq/datastack.git
cd datastack

# Install root dependencies deterministically using the committed lockfile
npm ci
```

---

## 3. Environment Configuration

Copy the example environment configuration:
```bash
cp .env.example .env
```

### Local Development Defaults
In local development (`NODE_ENV=development`), DataStack includes built-in fallbacks:
- If `DATABASE_URL` is omitted, DataStack operates seamlessly in **In-Memory Mock Mode**, allowing you to test the full UI, client registration, and REST endpoints without running PostgreSQL.
- If `REDIS_URL` is omitted, DataStack uses an **in-memory RAM buffer queue**, persisting directly to `./storage/data`.

For full production parity during development, you can spin up local PostgreSQL and Redis containers:
```bash
docker run --name datastack-postgres -e POSTGRES_USER=datastack -e POSTGRES_PASSWORD=password -e POSTGRES_DB=datastack_db -p 5432:5432 -d postgres:16-alpine
docker run --name datastack-redis -p 6379:6379 -d redis:7-alpine redis-server --appendonly yes
```

Then update your `.env`:
```dotenv
DATABASE_URL=postgresql://datastack:password@127.0.0.1:5432/datastack_db
REDIS_URL=redis://127.0.0.1:6379
PORT=3000
PORT_SOCKET=4000
INGESTION_INTERNAL_URL=http://127.0.0.1:4000
DATASTACK_ADMIN_EMAIL=admin@example.com
```

---

## 4. Running the Development Servers

DataStack requires two concurrent runtime processes. Open two terminal tabs in the project root:

### Terminal 1: Web Console & REST API (Port 3000)
```bash
npm run dev
```
Starts the Next.js 15 development server with Fast Refresh at `http://localhost:3000`.

### Terminal 2: Ingestion Server (Port 4000)
```bash
npm run server
```
Starts the dedicated Express 5 + Socket.IO ingestion service at `http://localhost:4000`.

---

## 5. First-Time Setup in Development

1. Open `http://localhost:3000/vcon/setup` in your browser.
2. Complete the setup wizard using your `DATASTACK_ADMIN_SETUP_KEY` from `.env`.
3. In `/vcon/clients`, register a test client application to generate your first JWT token.
4. In `/vcon/simulator`, test sending live events and observe the buffer counter in `/vcon/dashboard`.

---

## 6. Python SDK Development

If you are modifying the Python SDK in `sdk/python/datastack/`:

```bash
cd sdk/python/datastack
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
pip install -r ../../../tests/requirements.txt  # If running SDK test suites
```
