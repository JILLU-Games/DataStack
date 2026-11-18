# Developer & Contributor Guide

Welcome to the **DataStack Developer Documentation**. This section contains in-depth architectural specifications, development workflows, compilation instructions, and contribution conventions for engineers working on the DataStack codebase.

---

## Developer Documentation Index

Explore the core technical guides:

### 1. [Architecture Blueprint](./architecture.md)
Detailed breakdown of DataStack's decoupled dual-runtime model:
- **Port 3000 (`web`)**: Next.js 15 App Router, React 19, serverless REST API, streaming CSV/JSON export.
- **Port 4000 (`ingestion`)**: Dedicated Express 5 + Socket.IO real-time ingestion server.
- **Internal Service Bridge**: Authenticated `/internal/*` communication via `DATASTACK_INTERNAL_SECRET`.
- **Storage Subsystem**: In-memory and Redis-backed buffering, cooperative partition file locking, and streaming row counters.
- **PostgreSQL Control-Plane**: Schema provisioning and metadata storage rules (`pg.Pool` + `prisma/schema.prisma`).

### 2. [Local Development Setup](./setup.md)
Instructions for configuring your local machine:
- Prerequisites (Node.js 22, npm, PostgreSQL 16, Redis 7).
- Environment variable configuration (`.env.example`).
- Dual-terminal local workflow (`npm run dev` + `npm run server`).
- Database schema initialization.

### 3. [Build, Compilation & Testing](./build.md)
Standard build and testing commands:
- Compiling Next.js standalone output (`npm run build`).
- Code quality and linting (`npm run lint`).
- Running the comprehensive TypeScript test suite with `node:test` and `tsx`.
- Executing Python SDK unit tests.
- Docker multi-stage container builds.

### 4. [Contribution Rules & Conventions](./contributing.md)
Guidelines for submitting pull requests and modifying code:
- **Universal Multi-IDE Memory Rule** (`MEMORY.md` & `.ai-rules`).
- Single-source-of-truth UI primitives in `components/ui/` (`0rem` radius, zero shadows).
- Architectural guardrails (zero telemetry rows in PostgreSQL, no Socket.IO in Next.js).
- Pull Request and code review checklist.

---

## High-Level Repository Layout

```text
datastack/
├── app/                  # Next.js 15 App Router (Frontend, /vcon/*, and /api/*)
├── components/           # UI primitives (ui/), layout shells (layout/), and sections (sections/)
├── core/                 # Backend TypeScript modules (auth, Database, data, Storage, Security, sdk)
├── server/               # Dedicated Port 4000 Express + Socket.IO service & CSV batch worker
├── sdk/python/datastack/ # Official pip-installable Python SDK
├── sdk-python/           # Backward-compatible Python SDK wrapper
├── storage/data/         # Partitioned CSV telemetry storage root
├── docker/               # Production Dockerfiles, Nginx proxy configs, and docker-compose.yml
├── nginx/                # Local Nginx development configuration
├── tests/                # Automated test suites (phase01 - phase07)
└── docs/                 # User and developer documentation
```
