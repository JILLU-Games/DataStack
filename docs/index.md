# DataStack Documentation Hub

Welcome to the official, authoritative documentation for **DataStack** — a self-hosted, universal real-time telemetry ingestion engine, administrative governance platform (`/vcon/`), and partitioned CSV persistence system developed by **[Vib Tools](https://vib.tools/)**.

---

## Documentation Portals

DataStack documentation is organized into three specialized portals designed for different audiences:

```text
                                  ┌────────────────────────┐
                                  │  DataStack Docs Hub   │
                                  │      docs/index.md     │
                                  └───────────┬────────────┘
                                              │
                 ┌────────────────────────────┼────────────────────────────┐
                 ▼                            ▼                            ▼
   ┌───────────────────────────┐┌───────────────────────────┐┌───────────────────────────┐
   │       User Portal         ││     Developer Portal      ││     Reference Portal      │
   │       docs/users/         ││        docs/dev/          ││      docs/reference/      │
   ├───────────────────────────┤├───────────────────────────┤├───────────────────────────┤
   │ - Getting Started         ││ - Architecture Blueprint  ││ - Config Variable Bounds  │
   │ - Docker & Coolify Install││ - Codebase Structure Map  ││ - Dependency Inventory   │
   │ - Feature Deep Dives      ││ - REST & Socket.IO APIs   ││ - Technical Glossary      │
   │ - End-to-End Workflows    ││ - Database & DDL Schema   ││ - Error Code Index        │
   │ - Troubleshooting & FAQ   ││ - Security Architecture   ││                           │
   └───────────────────────────┘└───────────────────────────┘└───────────────────────────┘
```

### 1. [End-User & Operator Portal (`docs/users/`)](./users/index.md)
Designed for system administrators, DevOps engineers, and non-technical platform operators:
- **[Getting Started](./users/getting-started.md)**: Zero-to-one walkthrough: deploying DataStack, setting up the administrator account, and dispatching your first telemetry event.
- **[Installation Guide](./users/installation.md)**: Production deployment via Docker Compose and Coolify, persistent volume layouts, and reverse proxy networking.
- **[Configuration Guide](./users/configuration.md)**: Environment variable reference, security secrets setup, and runtime limit tuning.
- **[Feature Guides](./users/features/index.md)**: Detailed guides on the [Admin Console](./users/features/admin-console.md), [Client Token Management](./users/features/client-management.md), [Data Simulator](./users/features/data-simulator.md), [Partitioned Storage](./users/features/partitioned-storage.md), and [Streaming Data Export](./users/features/data-export.md).
- **[Operational Workflows](./users/workflows.md)**: Step-by-step operator workflows for token rotation, client onboarding, data exports, and manual buffer flushes.
- **[Troubleshooting & Diagnostics](./users/troubleshooting.md)**: Forensic troubleshooting procedures for connection drops, rate-limiting (`429`), payload rejections (`413`), and lock recoveries.
- **[Frequently Asked Questions](./users/faq.md)**: In-depth answers regarding CSV storage philosophy, Redis AOF durability, and container updates.

### 2. [Developer & Contributor Portal (`docs/dev/`)](./dev/index.md)
Designed for software engineers, backend architects, and open-source contributors:
- **[Architecture Blueprint](./dev/architecture.md)**: Deep dive into the decoupled dual-runtime model (Port 3000 Web vs Port 4000 Ingestion), the authenticated `/internal/*` service bridge, Redis durability, and cooperative partition file locking.
- **[Codebase Structure](./dev/codebase-structure.md)**: Complete file-by-file inventory of directories, source modules, and UI primitives.
- **[Local Development Setup](./dev/local-setup.md)**: Step-by-step local workstation configuration with dual-terminal development (`npm run dev` + `npm run server`).
- **[API Reference](./dev/api-reference.md)**: Exhaustive REST API specification, headers, request/response JSON schemas, and Socket.IO protocol specification (`sync_data`, `batch_sync`, `ping_verify`).
- **[Database Schema & Models](./dev/database-schema.md)**: PostgreSQL metadata schema definitions (`prisma/schema.prisma`), raw `pg.Pool` execution, and non-destructive `ADD COLUMN IF NOT EXISTS` migrations.
- **[Security Architecture](./dev/security.md)**: Forensic breakdown of password hashing (`scrypt`), WebCrypto HMAC-SHA256 session cookies, brute-force IP lockout, CSRF Origin validation, and client JWT issuance.
- **[Building & Packaging](./dev/building-packaging.md)**: Next.js standalone compilation (`.next/standalone`), multi-stage Docker builds, and Nginx proxy containerization.
- **[Testing Suites](./dev/testing.md)**: Running the automated TypeScript integration suites (`node:test` via `tsx`) and Python SDK unit tests.
- **[Contributing Guidelines](./dev/contributing.md)**: Architectural guardrails, single-source-of-truth UI standards, and the universal multi-IDE persistent memory synchronization rule (`MEMORY.md` & `.ai-rules`).

### 3. [Technical Reference Portal (`docs/reference/`)](./reference/index.md)
Authoritative specification tables and indexes:
- **[Configuration Reference](./reference/configuration-reference.md)**: Complete parameter reference for `.env` variables and runtime `/vcon/settings` bounds.
- **[Dependency Inventory](./reference/dependencies.md)**: Comprehensive audit of all runtime, dev, and optional dependencies.
- **[Technical Glossary](./reference/glossary.md)**: Definitions for platform concepts (partitioned CSV, distributed flush lock, cooperative lock, idempotency key, etc.).
- **[Audit & Coverage Report](./audit-coverage-report.md)**: Forensic codebase audit verification matrix and testing coverage summary.

---

## System Overview at a Glance

| Component | Port | Technology Stack | Primary Purpose |
| :--- | :--- | :--- | :--- |
| **`proxy`** | `80` / `443` | Nginx Alpine | Public ingress routing `/socket.io/` and `/health` to ingestion server, and all other traffic to Next.js. |
| **`web`** | `3000` | Next.js 15, React 19, TypeScript | Public overview, `/vcon/*` admin console, authenticated REST ingestion (`POST /api/events`), and streaming exports (`GET /api/export`). |
| **`ingestion`** | `4000` | Express 5, Socket.IO 4, Node 22 | High-throughput WebSocket ingestion, JWT client verification, per-client sliding-window rate limiting, and Redis queue buffering. |
| **`redis`** | `6379` | Redis 7 Alpine (`--appendonly yes`) | Shared queue (`datastack:buffer:events`), recent event cache, and distributed flush coordinator (`datastack:flush:lock`). |
| **`postgres`**| `5432` | PostgreSQL 16 Alpine | Control-plane storage for admin accounts (`admin_users`), brute-force login attempts (`admin_login_attempts`), and client credentials (`client_sdks`). |
| **`storage`** | Local Mount | Partitioned RFC 4180 CSV | Telemetry persistence root: `/app/storage/data/{clientId}/{YYYY-MM-DD}.csv`. Zero telemetry is inserted into PostgreSQL. |

---

## Governance & Master Manifest

For documentation authoring rules, directory maintenance guidelines, and cross-IDE sync instructions, see the **[Documentation Manifest (`docs/MANIFEST.md`)](./MANIFEST.md)**.
