# Developer & Contributor Documentation Hub

Welcome to the DataStack Developer Hub. This documentation suite is designed for software engineers, systems programmers, and open-source contributors working on or extending the DataStack platform.

---

## Developer Portals & Architecture Specifications

| Document | Purpose & Scope | Target Audience |
| :--- | :--- | :--- |
| [Architecture Blueprint (`architecture.md`)](./architecture.md) | Deep dive into the dual-runtime architecture (Port 3000 Web vs Port 4000 Ingestion), internal bridge protocol, Redis AOF durability, and storage layout. | Core Contributors, Architects |
| [Codebase Structure (`codebase-structure.md`)](./codebase-structure.md) | File-by-file inventory of directories, source modules (`core/`, `app/`, `server/`, `components/`), and their relationships. | All Developers |
| [Local Development Setup (`local-setup.md`)](./local-setup.md) | Workstation setup, Node.js 22 requirements, dual-terminal local workflow, and in-memory vs Docker container modes. | New Contributors |
| [API Reference Specification (`api-reference.md`)](./api-reference.md) | OpenAPI-style contract reference for all REST endpoints (`app/api/*`) and Socket.IO real-time events (`server/socket/handlers.js`). | Integration Engineers |
| [Database Schema & Migrations (`database-schema.md`)](./database-schema.md) | PostgreSQL control-plane tables, DDL migrations, column definitions, and `prisma/schema.prisma` mirror. | Backend Engineers |
| [Security Architecture (`security.md`)](./security.md) | Cryptographic design: `crypto.scrypt`, WebCrypto HMAC sessions, brute-force IP lockout, CSRF Origin validation, and JWT verification. | Security Engineers |
| [Building & Packaging (`building-packaging.md`)](./building-packaging.md) | Next.js standalone compilation (`.next/standalone`), multi-stage Dockerfiles (`web`, `server`, `proxy`), and production container assembly. | DevOps, Release Engineers |
| [Testing Guide (`testing.md`)](./testing.md) | Guide to automated TypeScript integration tests (`npx tsx --test`) and Python SDK unit tests (`python3 -m unittest`). | QA, Test Engineers |
| [Contributing Guidelines (`contributing.md`)](./contributing.md) | Development rules, zero-SQL-telemetry enforcement, single-source UI primitives, multi-IDE memory synchronization (`MEMORY.md`), and PR checklist. | All Contributors |

---

## Core Engineering Principles

1. **Decoupled Runtime Separation**: Next.js 15 App Router on Port 3000 handles user interaction and REST exports. Express 5 + Socket.IO 4 on Port 4000 handles persistent WebSocket handshakes. Socket.IO is never instantiated inside Next.js serverless handlers.
2. **Zero Per-Row Relational Telemetry**: Telemetry streams are buffered in memory/Redis and flushed to daily CSV partitions under `/app/storage/data/{clientId}/{YYYY-MM-DD}.csv`. PostgreSQL is reserved exclusively for the control plane.
3. **Fail-Closed Security**: In production (`NODE_ENV=production`), missing or placeholder secrets halt startup immediately.
4. **Cooperative File Locking**: Concurrent flushes between Port 3000 and Port 4000 coordinate safely using `.lock` files with automatic stale lock expiration.
