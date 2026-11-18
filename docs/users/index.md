# DataStack User & Operator Guide

Welcome to the **DataStack User & Operator Documentation**. This portal contains comprehensive guides for deploying, configuring, operating, and integrating applications with DataStack.

---

## Guide Directory

```text
docs/users/
├── index.md                    # This directory index
├── getting-started.md          # 5-minute setup and quickstart tutorial
├── installation.md             # Production Docker Compose & Coolify deployment
├── configuration.md            # Secrets, environment variables & settings reference
├── features/                   # Detailed functional walkthroughs
│   ├── index.md                # Features directory index
│   ├── admin-console.md        # /vcon/ dashboard, monitors, and profile workspace
│   ├── client-management.md    # SDK client registration, JWT rotation, and revocation
│   ├── data-simulator.md       # Interactive browser telemetry simulator & presets
│   ├── partitioned-storage.md  # Daily CSV storage, file rotation, and auto-pruning
│   └── data-export.md          # Streaming CSV and JSON dataset export workspace
├── workflows.md                # Step-by-step user journeys & operations
├── troubleshooting.md          # Forensic error recovery & diagnostics
└── faq.md                      # Frequently asked questions & storage architecture
```

---

## Core Reading Pathways

Choose the pathway that matches your immediate goal:

### Pathway 1: "I want to self-host DataStack on my VPS"
1. Start with **[Installation & Deployment](./installation.md)** for Docker Compose or Coolify setup.
2. Review **[Configuration Guide](./configuration.md)** to generate 32+ character secrets.
3. Follow **[Getting Started](./getting-started.md)** to run the `/vcon/setup` wizard and log in.

### Pathway 2: "I want to connect my Python application"
1. Review **[Client Token Management](./features/client-management.md)** to generate a client JWT token.
2. Read **[Tutorial: Python SDK Integration](./getting-started.md#step-4-connect-with-the-python-sdk)** to set up `config.datastack.py`.
3. Check **[Troubleshooting](./troubleshooting.md)** if you encounter rate limits or connection drops.

### Pathway 3: "I want to inspect or export collected data"
1. Read **[Partitioned CSV Storage](./features/partitioned-storage.md)** to understand directory and file layouts.
2. Read **[Streaming Data Export](./features/data-export.md)** to extract datasets via browser or `curl`.
3. Follow the **[Data Analysis Workflow](./workflows.md#workflow-3-exporting-and-analyzing-data)** to load records into pandas or Excel.

---

## Platform Philosophy

DataStack is built to solve the **"High-Velocity Telemetry Dilemma"**:
- **Why not PostgreSQL for everything?** Inserting thousands of events per second into relational database tables causes index thrashing, lock contention, and WAL exhaustion.
- **The DataStack Solution**: PostgreSQL is used strictly for administrative accounts and client credentials. Ingested events flow through in-memory and Redis buffers directly into organized, daily partitioned CSV files (`/app/storage/data/{clientId}/{YYYY-MM-DD}.csv`).
- **The Benefit**: Virtually unlimited ingestion throughput, zero SQL lock contention, deterministic storage costs, and instant portability.
