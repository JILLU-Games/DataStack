# DataStack Python SDK Documentation

Welcome to the official developer documentation for the **DataStack Python SDK** (`datastack`).

This documentation suite provides a complete, compact technical reference for installing, configuring, operating, and troubleshooting the SDK in production environments.

---

## 1. Documentation Index

| Guide | Description | Target Audience |
| :--- | :--- | :--- |
| **[Installation (`INSTALLATION.md`)](./INSTALLATION.md)** | Supported Python runtimes, package installation, virtual environments, and dependency requirements. | All Developers |
| **[Quickstart (`QUICKSTART.md`)](./QUICKSTART.md)** | 5-minute zero-boilerplate integration guide using `config.datastack.py`. | Getting Started |
| **[API Reference (`API_REFERENCE.md`)](./API_REFERENCE.md)** | Full specification of `DataStack`, public methods, parameter types, defaults, and return schemas. | Integration Engineers |
| **[Configuration Guide (`CONFIGURATION.md`)](./CONFIGURATION.md)** | Auto-discovery rules, configuration keys, environment variables (`DATASTACK_*`), and precedence order. | DevOps & Systems Engineers |
| **[Practical Examples (`EXAMPLES.md`)](./EXAMPLES.md)** | Real-world patterns: IoT sensor streaming, batch transactions, CSV/JSON file ingestion, and context managers. | Application Developers |
| **[Error Handling (`ERROR_HANDLING.md`)](./ERROR_HANDLING.md)** | Exception hierarchy, error codes (`401`, `403`, `413`, `429`), retry backoff, and non-retryable errors. | Production Support & QA |
| **[Lifecycle & Resilience (`LIFECYCLE.md`)](./LIFECYCLE.md)** | Smart Heartbeat Monitor, connection state machine, zero-CPU IDLE mode, and offline disk spooling. | Systems Architects |

---

## 2. Architecture at a Glance

The DataStack Python SDK is built around a resilient dual-transport and auto-recovery architecture:

```text
                       ┌────────────────────────────┐
                       │    DataStack Python SDK    │
                       └──────────────┬─────────────┘
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            │ Primary Transport                                 │ Auto Fallback
            ▼                                                   ▼
┌───────────────────────┐                           ┌───────────────────────┐
│ Socket.IO Ingestion   │                           │ HTTP REST Fallback    │
│ Port 4000 (WebSocket) │                           │ Port 3000 (/api/events│
└───────────┬───────────┘                           └───────────┬───────────┘
            │                                                   │
            └─────────────────────────┬─────────────────────────┘
                                      │ Both Unreachable (Offline)
                                      ▼
                        ┌───────────────────────────┐
                        │   Offline Disk Spooler    │
                        │ (.datastack_spool/*.jsonl)│
                        └───────────────────────────┘
```

1. **Primary Real-Time Streaming (Port 4000)**: Events emit via Socket.IO WebSocket (`sync_data`, `batch_sync`). Once connected and verified (`ping_verify`), the background Heartbeat Monitor transitions to **zero-CPU IDLE mode**.
2. **Automatic HTTP Fallback (Port 3000)**: If the WebSocket disconnects, all calls seamlessly route through `POST /api/events` while the Heartbeat Monitor probes background reconnection.
3. **Offline Disk Spooling**: If the device loses internet entirely, events are safely persisted to `.datastack_spool/spool.jsonl` and automatically replayed in order once connectivity returns.
