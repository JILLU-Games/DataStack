# Documentation Manifest (`docs/MANIFEST.md`)

> **Location**: `/docs/MANIFEST.md`  
> **Audience**: Contributors, Maintainers, Technical Writers, and AI Engineering Agents  
> **Last Forensic Verification**: 2026-11-17  
> **Version**: 1.0.0 Production  

---

## 1. Documentation Structure & Directory Mapping

The DataStack documentation suite is strictly organized into functional directories based on audience, abstraction level, and lifecycle stage:

```text
docs/
├── index.md                        # Primary Documentation Hub & Portal Index
├── MANIFEST.md                     # Master Documentation Inventory & Governance (This File)
├── audit-coverage-report.md        # Forensic Codebase Audit Matrix & Coverage Report
├── users/                          # End-User & System Operator Guides
│   ├── index.md                    # User Guide Directory Index
│   ├── getting-started.md          # 5-minute fast-track operator onboarding guide
│   ├── installation.md             # Production Docker Compose, Coolify, and volume guide
│   ├── configuration.md            # Environment variables and platform runtime settings
│   ├── features/                   # In-depth feature guides
│   │   ├── index.md                # Feature guides index
│   │   ├── admin-console.md        # /vcon/ dashboard, monitors, and profile workspace
│   │   ├── client-management.md    # SDK client registration, JWT rotation, and revocation
│   │   ├── data-simulator.md       # Interactive browser telemetry simulator & presets
│   │   ├── partitioned-storage.md  # Daily CSV storage, file rotation, and auto-pruning
│   │   └── data-export.md          # Streaming CSV and JSON dataset export workspace
│   ├── workflows.md                # End-to-end operational workflows and user journeys
│   ├── troubleshooting.md          # Forensic error recovery, connection checks, and diagnostics
│   └── faq.md                      # Comprehensive operational & architectural FAQ
├── dev/                            # Developer, Contributor & Architecture Reference
│   ├── index.md                    # Developer Hub Directory Index
│   ├── architecture.md             # Dual-runtime blueprint, service bridge, Redis queue, and storage
│   ├── codebase-structure.md       # Complete file-by-file module, route, and component inventory
│   ├── local-setup.md              # Contributor workstation setup & dual-terminal development
│   ├── api-reference.md            # Exhaustive REST API & Socket.IO protocol specification
│   ├── database-schema.md          # PostgreSQL tables, columns, constraints, and DDL migrations
│   ├── security.md                 # Security architecture, scrypt, sessions, CSRF, and JWTs
│   ├── building-packaging.md       # Next.js standalone build, Dockerfiles, and packaging
│   ├── testing.md                  # Test suites guide (TypeScript node:test and Python unittest)
│   └── contributing.md             # Contribution rules, multi-IDE memory sync, and PR checklist
└── reference/                      # Authoritative Reference Tables & Glossary
    ├── index.md                    # Reference Hub Directory Index
    ├── configuration-reference.md  # Exhaustive environment variable & setting bounds reference
    ├── dependencies.md             # Complete runtime & development dependencies inventory
    └── glossary.md                 # Domain and technical glossary
```

---

## 2. Comprehensive File Inventory & Purpose Breakdown

### Root Directory
- **`docs/index.md`**: The top-level documentation portal providing role-based navigation, a high-level system component table, and core links.
- **`docs/MANIFEST.md`**: The authoritative index and governance standard for all documentation assets in this repository.
- **`docs/audit-coverage-report.md`**: The forensic verification report documenting inspected modules, verified capabilities, test execution proofs, and zero-hallucination compliance.

---

### User Portal (`docs/users/`)
Audience: System administrators, DevOps operators, integration engineers, and non-technical managers.

| File Path | Document Title | Primary Content & Implementation Basis |
| :--- | :--- | :--- |
| `docs/users/index.md` | User Documentation Hub | Directory map, user role definitions, and core workflow summaries. |
| `docs/users/getting-started.md` | Getting Started | First-time installation, `/vcon/setup` wizard, creating a client, and testing ingestion via `curl` and Python. |
| `docs/users/installation.md` | Installation & Deployment | Multi-container Docker Compose (`docker/docker-compose.yml`), Coolify 1-click PaaS setup, persistent volume mappings (`datastack-data`, `pgdata`, `redisdata`), and reverse proxy requirements. |
| `docs/users/configuration.md` | Configuration Guide | Comprehensive operator guide to configuring secrets in `.env`, initial admin credentials, and tuning runtime limits via `/vcon/settings`. |
| `docs/users/features/index.md` | Features Index | High-level summary of all platform features with direct links to dedicated deep dives. |
| `docs/users/features/admin-console.md` | Admin Console (`/vcon/`) | In-depth walkthrough of `/vcon/dashboard`, live activity preview, memory/buffer gauges, and administrator account management. |
| `docs/users/features/client-management.md` | Client Token Registry | Managing SDK clients (`/vcon/clients`), HMAC-SHA256 JWT issuance, one-click credential rotation, instant socket revocation, and permanent client deletion. |
| `docs/users/features/data-simulator.md` | Data Simulator | In-browser telemetry generation (`/vcon/simulator`), single vs batch dispatch, HTTP vs WebSocket transport, and preset sensor/e-commerce payloads. |
| `docs/users/features/partitioned-storage.md`| Partitioned CSV Storage | Details the `/storage/data/{clientId}/{YYYY-MM-DD}.csv` structure, 100MB file rotation (`-part2.csv`), cooperative lock files, and automated retention pruning. |
| `docs/users/features/data-export.md` | Streaming Data Export | Operational guide to `/vcon/export`, streaming filtered CSV and JSON files, UTC date filtering, and importing into pandas and Excel. |
| `docs/users/workflows.md` | Operational Workflows | Complete step-by-step user journeys: onboarding an admin, onboarding an SDK client, rotating platform JWT secret, and running disaster recovery backups. |
| `docs/users/troubleshooting.md` | Troubleshooting Guide | Diagnostic procedures for rate-limit violations (`429`), payload size rejections (`413`), WebSocket handshake timeouts, and lock cleanup. |
| `docs/users/faq.md` | Frequently Asked Questions | Architectural rationale for CSV over SQL, Redis crash durability, container update rules, and backup commands. |

---

### Developer Portal (`docs/dev/`)
Audience: Backend engineers, frontend developers, platform architects, and open-source contributors.

| File Path | Document Title | Primary Content & Implementation Basis |
| :--- | :--- | :--- |
| `docs/dev/index.md` | Developer Hub | Contributor overview, architecture index, development philosophy, and repository roadmap. |
| `docs/dev/architecture.md` | Architecture Blueprint | Decoupled runtime architecture (Port 3000 Web vs Port 4000 Ingestion), internal bridge protocol, Redis AOF durability, and storage subsystems. |
| `docs/dev/codebase-structure.md` | Codebase Structure | Exhaustive file-by-file inventory of directories, source modules (`core/`, `app/`, `server/`, `components/`), and their relationships. |
| `docs/dev/local-setup.md` | Local Development Setup | Step-by-step workstation setup, Node.js 22 requirements, dual-terminal local workflow, and in-memory vs Docker container modes. |
| `docs/dev/api-reference.md` | API Reference Specification | Complete OpenAPI-style reference for all REST endpoints (`app/api/*`) and Socket.IO real-time events (`server/socket/handlers.js`). |
| `docs/dev/database-schema.md` | Database Schema & Migrations | PostgreSQL control-plane tables (`admin_users`, `client_sdks`, `admin_settings`, etc.), `prisma/schema.prisma` reference, and additive DDL migrations. |
| `docs/dev/security.md` | Security Architecture | In-depth breakdown of `crypto.scrypt` password hashing, WebCrypto HMAC session cookies, brute-force IP lockout, CSRF Origin validation, and JWT verification. |
| `docs/dev/building-packaging.md`| Building & Packaging | Next.js standalone compilation (`.next/standalone`), multi-stage Dockerfiles (`web`, `server`, `proxy`), and production container assembly. |
| `docs/dev/testing.md` | Testing Guide | Guide to running automated TypeScript integration tests (`npx tsx --test`) and Python SDK unit tests (`python3 -m unittest`). |
| `docs/dev/contributing.md` | Contributing Guidelines | Architectural rules, zero-SQL-telemetry enforcement, single-source UI primitives, multi-IDE memory synchronization (`MEMORY.md`), and PR checklist. |

---

### Technical Reference Portal (`docs/reference/`)
Audience: Technical teams requiring strict specifications, boundaries, and definitions.

| File Path | Document Title | Primary Content & Implementation Basis |
| :--- | :--- | :--- |
| `docs/reference/index.md` | Reference Index | Overview of platform specifications, configuration limits, and glossary. |
| `docs/reference/configuration-reference.md` | Configuration Reference | Exhaustive reference table of all environment variables, default values, bounds, and `/vcon/settings` allowlisted keys. |
| `docs/reference/dependencies.md` | Dependency Inventory | Audit of all runtime dependencies, dev tools, and Python client requirements with rationales. |
| `docs/reference/glossary.md` | Technical Glossary | Clear definitions of platform concepts (cooperative locking, sliding-window rate limit, idempotency envelope, etc.). |

---

## 3. Maintenance & Documentation Governance Rules

To ensure documentation remains permanently synchronized with the actual implementation across future pull requests and releases:

### Mandatory Update Triggers
1. **API & Route Changes**: If any endpoint under `app/api/` or Socket.IO event in `server/socket/handlers.js` is added, modified, or removed:
   - Update `docs/dev/api-reference.md`.
   - Update `docs/users/tutorials.md` and `docs/users/workflows.md` if user-facing.
2. **Configuration & Environment Changes**: If any environment variable in `.env.example` or setting in `core/adminSettings/settingsManager.ts` is modified:
   - Update `docs/reference/configuration-reference.md`.
   - Update `docs/users/configuration.md`.
3. **Database Schema Changes**: If any table, column, or constraint in `core/Database/database.ts` or `prisma/schema.prisma` is adjusted:
   - Update `docs/dev/database-schema.md`.
4. **Storage & Ingestion Mechanics**: If batching, locking, rotation, or pruning algorithms in `core/Storage/` or `core/data/` change:
   - Update `docs/dev/architecture.md` and `docs/users/features/partitioned-storage.md`.
5. **Cross-IDE Synchronization**: In compliance with `.ai-rules` and `AGENTS.md`, after every change session, `MEMORY.md` in the root directory must be updated to mirror documentation and code status.

### Zero-Hallucination Authoring Standards
- **Implementation is Truth**: Never document planned or intended behavior as existing capability.
- **Traceable Code References**: Every technical guide must reference verified file paths and actual function/class identifiers.
- **Executable Examples**: All `curl`, Python, TypeScript, and Docker commands must be verified and syntactically valid.
