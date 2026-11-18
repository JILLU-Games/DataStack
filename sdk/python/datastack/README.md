# DataStack Official Python SDK (`datastack`)

[![PyPI version](https://img.shields.io/badge/pypi-v2.2.0-blue.svg)](https://pypi.org/project/datastack/)
[![Python: 3.8+](https://img.shields.io/badge/python-3.8%2B-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../../../LICENSE)
[![Maintained by Vib Tools](https://img.shields.io/badge/Maintained%20by-Vib%20Tools-0f172a)](https://vibtools.top/)

The official production-grade Python SDK for **[DataStack](https://vibtools.top/)** — high-throughput, self-hosted telemetry ingestion and partitioned CSV persistence platform.

---

## Key Capabilities

- **Zero-Boilerplate Auto-Discovery**: Automatically finds and loads `config.datastack.py` in your working directory.
- **Dual-Transport Resilience**: Real-time Socket.IO streaming on Port 4000 with automatic fallback to HTTP REST (`POST /api/events`) on Port 3000.
- **Zero-CPU Heartbeat Monitor**: Background recovery thread sleeps in 0-CPU `IDLE` mode when healthy; wakes only on network disruption.
- **Offline Disk Spooling**: Automatically appends unsent events to `.datastack_spool/spool.jsonl` when offline and replays them atomically upon reconnection.
- **Direct File Streaming**: Stream `.csv`, `.json`, `.jsonl`, and `.ndjson` files with deterministic SHA-256 deduplication and auto-halving on payload limits.
- **Backoff & Rate-Limit Pacing**: Lossless partial-batch retries on `429 RATE_LIMIT_EXCEEDED` with jitter.

---

## Installation

```bash
# From PyPI
pip install datastack

# Or from local repository
pip install ./sdk/python/datastack
```

---

## Quick Example

Create `config.datastack.py` in your project root:
```python
# config.datastack.py
DATASTACK_CONFIG = {
    "SERVER_URL": "http://localhost:4000",
    "API_URL": "http://localhost:3000",
    "CLIENT_TOKEN": "YOUR_SIGNED_CLIENT_JWT",
}
```

Then stream telemetry in Python:
```python
from datastack import DataStack

with DataStack() as client:
    # 1. Single Event
    client.send({"service": "order_worker", "status": "completed", "amount": 99.50})

    # 2. Batch Events
    client.send_batch([
        {"metric": "cpu", "value": 45.2},
        {"metric": "ram_mb", "value": 2048},
    ])

    # 3. Direct File Streaming
    client.send_file("device_logs.csv", chunk_size=250)
```

---

## Documentation Suite

Exhaustive technical documentation is available in the **[`docs/`](./docs/README.md)** directory:

- **[Installation Guide (`docs/INSTALLATION.md`)](./docs/INSTALLATION.md)** — Runtimes, dependencies, and environment verification.
- **[Quickstart (`docs/QUICKSTART.md`)](./docs/QUICKSTART.md)** — 5-minute integration guide.
- **[API Reference (`docs/API_REFERENCE.md`)](./docs/API_REFERENCE.md)** — Complete method signatures, parameters, and return types.
- **[Configuration Reference (`docs/CONFIGURATION.md`)](./docs/CONFIGURATION.md)** — `config.datastack.py`, environment variables, and precedence order.
- **[Practical Examples (`docs/EXAMPLES.md`)](./docs/EXAMPLES.md)** — IoT streaming, FastAPI logging, batch transactions, and file ingestion.
- **[Error Handling (`docs/ERROR_HANDLING.md`)](./docs/ERROR_HANDLING.md)** — Exception hierarchy, status codes, and retry strategies.
- **[Lifecycle & Resilience (`docs/LIFECYCLE.md`)](./docs/LIFECYCLE.md)** — Connection state machine, Heartbeat Monitor, and offline disk spooler.

---

## Author & License

- **Organization**: [Vib Tools](https://vibtools.top/)
- **Author**: Md Anik (`ANIK.D.ART`) — `info@vibtools.top`
- **License**: MIT License
