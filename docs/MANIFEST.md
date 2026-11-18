# Documentation Manifest (`docs/MANIFEST.md`)

> **Location**: `/docs/MANIFEST.md`  
> **Audience**: Contributors, Maintainers, and Documentation Authors  
> **Last Updated**: 2026-11-17  

---

## 1. Directory Purpose & Structure

The `docs/` directory contains the complete official documentation for **DataStack**, structured into distinct audiences to provide clarity, depth, and ease of navigation:

```text
docs/
├── MANIFEST.md               # This document (directory index & governance)
├── users/                    # End-User & Operator Documentation
│   ├── README.md             # User documentation overview & quick links
│   ├── installation.md       # Self-hosting, Docker, and Coolify setup guides
│   ├── features.md           # Guide to /vcon/ console, client tokens, and telemetry
│   ├── tutorials.md          # Step-by-step user tutorials and integration walkthroughs
│   └── faq.md                # Frequently asked questions and troubleshooting
└── dev/                      # Developer & Contributor Documentation
    ├── README.md             # Developer guide overview & roadmap
    ├── architecture.md       # Deep dive into dual-runtime architecture and storage
    ├── setup.md              # Local development environment setup & configuration
    ├── build.md              # Build, compilation, Docker containerization & test suites
    └── contributing.md       # Contribution rules, conventions, and workflow
```

---

## 2. Directory Breakdown

### `docs/users/` (End-Users, System Operators & Administrators)
Designed for non-technical users, platform administrators, and data engineers operating or integrating with a live DataStack deployment:

| File | Purpose | Key Topics Covered |
| :--- | :--- | :--- |
| `README.md` | Entry point for users | Documentation map, navigation guide, and core concepts overview. |
| `installation.md` | Deployment guide | Production Docker Compose, Coolify 1-click deployment, environment variables, reverse proxy setup, and persistent volume management. |
| `features.md` | Feature breakdown | Web console (`/vcon/`), client SDK tokens, real-time event simulation, daily partitioned CSV storage, streaming export, and platform settings. |
| `tutorials.md` | Practical guides | Step-by-step tutorials: first telemetry event, connecting Python applications, viewing live events in the console, and exporting datasets. |
| `faq.md` | Troubleshooting & FAQ | Common questions on data retention, token revocation, port configurations, CSV rotation, and connection diagnostics. |

### `docs/dev/` (Developers, Contributors & System Architects)
Designed for engineers extending the codebase, fixing bugs, writing client SDKs, or contributing to the core platform:

| File | Purpose | Key Topics Covered |
| :--- | :--- | :--- |
| `README.md` | Entry point for devs | Contributor handbook, repository layout, and code navigation. |
| `architecture.md` | Architectural blueprint | Dual-runtime model (Port 3000 Web vs Port 4000 Ingestion), Redis durability queue, partitioned CSV engine with cooperative locks, and PostgreSQL metadata store. |
| `setup.md` | Local development | Prerequisites (Node.js 22, PostgreSQL, Redis), dual-terminal development, environment secrets, and sample configurations. |
| `build.md` | Build & compilation | Next.js standalone compilation (`npm run build`), ESLint validation, Docker multi-stage builds, and running TypeScript (`npx tsx --test`) and Python unit test suites. |
| `contributing.md` | Contribution standards | Multi-IDE memory synchronization (`MEMORY.md` & `.ai-rules`), UI component governance (`components/ui/`), code conventions, and Pull Request checklist. |

---

## 3. Maintenance & Documentation Update Guidelines

Documentation accuracy is a core quality requirement in DataStack. Whenever modifying code or configurations, follow these update rules:

### When to Update `docs/users/`
- **New User-Facing Features**: Whenever adding or altering pages in `/vcon/*` (e.g., changes to export options, client token regeneration, or UI settings), update `docs/users/features.md`.
- **Installation / Deployment Changes**: Whenever modifying `docker/docker-compose.yml`, Dockerfiles, Nginx configurations, or `.env.example`, update `docs/users/installation.md`.
- **API Endpoints & Integration**: If new parameters are added to `POST /api/events` or `GET /api/export`, update `docs/users/tutorials.md` and `docs/users/faq.md`.

### When to Update `docs/dev/`
- **Architectural Changes**: Whenever altering the communication bridge between Port 3000 and Port 4000, changing Redis queues, or altering CSV storage mechanisms, update `docs/dev/architecture.md`.
- **New Dependencies or Scripts**: Whenever adding npm dependencies, changing build targets, or adding test files, update `docs/dev/setup.md` and `docs/dev/build.md`.
- **Contribution Standards**: If code standards, linting rules, or multi-IDE memory rules are revised, update `docs/dev/contributing.md` and sync with `AGENTS.md` and `.ai-rules`.

### Quality & Style Standards
1. **Markdown Formatting**: Use clean GitHub-Flavored Markdown (GFM) with clear headings, bulleted lists, and language-tagged code blocks (e.g. ` ```bash `, ` ```python `).
2. **Absolute vs Relative Links**: Inside markdown files, use relative links to reference other documentation files (e.g., `[Architecture Overview](../dev/architecture.md)`).
3. **No Stale Placeholders**: Avoid unverified configuration keys or generic placeholder URLs; align variables with `.env.example`.
4. **Cross-IDE Sync**: After any documentation update, update `MEMORY.md` in the root directory to maintain synchronization across all IDEs.
