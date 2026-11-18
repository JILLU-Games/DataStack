# Build, Compilation & Testing Guide

This guide outlines compilation commands, linter checks, test suite execution, and Docker container packaging.

---

## 1. Production Web Compilation

DataStack uses Next.js 15 App Router configured for **Standalone Output** (`output: "standalone"` in `next.config.ts`), which bundles only the required Node.js runtime files into `.next/standalone`.

### Compiling the Application:
```bash
npm run build
```

### Build Verification Checklist:
- Compiles TypeScript without type errors (`tsc --noEmit`).
- Generates serverless routes and static assets under `.next/`.
- Prepares standalone bundle under `.next/standalone/server.js`.

---

## 2. Code Quality & Linting

DataStack uses ESLint 9 with `eslint-config-next`:

```bash
npm run lint
```

Ensure this command exits cleanly (`code: 0`) with zero warnings or errors prior to committing code or opening a pull request.

---

## 3. Automated Test Suites

DataStack includes comprehensive, fast-executing automated test suites verifying security, synchronization, storage durability, PWA compliance, and deployment health.

### Running TypeScript Integration & Unit Tests
Run the test runner using `npx --yes tsx --test`:

```bash
# Run all core test suites
npx --yes tsx --test tests/phase01-auth.test.ts \
                     tests/phase02-sync.test.ts \
                     tests/phase03-storage-buffer.test.ts \
                     tests/phase06-pwa-landing.test.ts \
                     tests/phase07-deployment.test.ts
```

#### What These Tests Verify:
- **`phase01-auth.test.ts`**: Secret fail-closed checks, `tokenVersion` session invalidation, brute-force IP throttling, client token redaction, and CSRF Origin validation.
- **`phase02-sync.test.ts`**: Port 3000 ↔ Port 4000 internal secret authentication, settings propagation, instant client revocation, and JWT rotation disconnection.
- **`phase03-storage-buffer.test.ts`**: Redis AOF durability, distributed flush locking, cooperative partition `.lock` files, streaming row counting, and filtered CSV export.
- **`phase06-pwa-landing.test.ts`**: Web App Manifest validity, Service Worker registration, and navigation integrity.
- **`phase07-deployment.test.ts`**: Docker Compose configuration, Redis AOF persistence, Nginx `/health` proxying, deterministic lockfile parity, startup ownership checks, and unhydrated-DB auto-prune guards.

### Running Python SDK Unit Tests
```bash
python3 -m unittest tests/phase05_sdk_test.py
```
Verifies Python SDK WebSocket streaming, Heartbeat HTTP fallback, disk spooling (`.datastack_spool/`), and `.csv`/`.json` file streaming.

---

## 4. Docker Container Builds

To test production containerization locally:

### 1. Build the Web Container (Port 3000)
```bash
docker build -f docker/Dockerfile.web -t datastack-web:latest .
```

### 2. Build the Ingestion Container (Port 4000)
```bash
docker build -f docker/Dockerfile.server -t datastack-ingestion:latest .
```

### 3. Build the Nginx Proxy Container (Port 80)
```bash
docker build -f docker/Dockerfile.proxy -t datastack-proxy:latest .
```

### 4. Build & Run the Entire Stack with Compose
```bash
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d
```
Verify container health with:
```bash
docker compose -f docker/docker-compose.yml ps
```
All containers (`web`, `ingestion`, `proxy`, `postgres`, `redis`) should display `(healthy)`.
