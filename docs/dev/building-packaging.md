# Building, Packaging & Production Containers

This guide outlines compilation commands, linter checks, test suite execution, and Docker container packaging for DataStack.

---

## 1. Production Web Compilation

DataStack uses Next.js 15 App Router configured for **Standalone Output** (`output: "standalone"` in `next.config.ts`), which bundles only the required Node.js runtime files into `.next/standalone`.

### Compiling the Web App
```bash
npm run build
```

### Build Verification Checklist
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

## 3. Docker Container Builds

DataStack provides optimized, multi-stage Dockerfiles under `docker/`:

### 1. Build the Web Container (Port 3000)
```bash
docker build -f docker/Dockerfile.web -t datastack-web:latest .
```
- **Base**: `node:22-alpine`.
- **Stage 1 (Builder)**: Installs dependencies deterministically (`npm ci`) and runs `npm run build`.
- **Stage 2 (Runner)**: Copies `.next/standalone`, public assets, and sets non-root user `nextjs` (UID 1001).

### 2. Build the Ingestion Container (Port 4000)
```bash
docker build -f docker/Dockerfile.server -t datastack-ingestion:latest .
```
- **Base**: `node:22-alpine`.
- Installs production dependencies and runs `node server/index.js` under a dedicated non-root user.

### 3. Build the Nginx Proxy Container (Port 80)
```bash
docker build -f docker/Dockerfile.proxy -t datastack-proxy:latest .
```
- **Base**: `nginx:1.27-alpine`.
- Mounts custom reverse proxy configuration (`nginx/nginx.conf`) routing `/` to Port 3000 and `/socket.io/` to Port 4000.

### 4. Build & Run the Entire Stack with Compose
```bash
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml up -d
```

Verify container health:
```bash
docker compose -f docker/docker-compose.yml ps
```
All containers (`web`, `ingestion`, `proxy`, `postgres`, `redis`) should display `(healthy)`.
