# Features Guide

Welcome to the DataStack Feature Documentation. This section details the complete feature set of the DataStack high-throughput telemetry platform.

---

## Feature Index

| Feature Document | Purpose & Capabilities | Primary Navigation Path |
| :--- | :--- | :--- |
| [Admin Console (`admin-console.md`)](./admin-console.md) | System health monitoring, dual-runtime status, memory/buffer gauges, and administrator account management. | `/vcon/dashboard`, `/vcon/profile` |
| [Client Management (`client-management.md`)](./client-management.md) | Client SDK registration, HMAC-SHA256 JWT generation, credential rotation, socket revocation, and tombstone deletion. | `/vcon/clients` |
| [Data Simulator (`data-simulator.md`)](./data-simulator.md) | Browser-based event generation, single vs. burst testing, WebSocket/HTTP transport modes, and telemetry payload presets. | `/vcon/simulator` |
| [Partitioned CSV Storage (`partitioned-storage.md`)](./partitioned-storage.md) | Daily client directory partitioning, 100MB rotation (`-part2.csv`), cooperative lock files, and automated retention pruning. | `/vcon/storage` |
| [Data Export (`data-export.md`)](./data-export.md) | Streaming CSV/JSON extraction, date range filters, client filtering, Excel/pandas compatibility, and non-blocking reads. | `/vcon/export` |

---

## Architecture Summary

Every feature in DataStack follows a strict separation of concerns:
- **Control Plane**: Handled on Port 3000 via Next.js 15 App Router and PostgreSQL metadata tables (`admin_users`, `client_sdks`, `admin_settings`).
- **Data Plane**: Handled on Port 4000 via Express 5, Socket.IO 4, and persistent append-only CSV partitions under `/app/storage/data/{clientId}/{YYYY-MM-DD}.csv`.
- **Zero SQL Insertions**: Telemetry events never create rows in relational tables, ensuring predictable query performance and infinite scale-to-zero storage efficiency.
