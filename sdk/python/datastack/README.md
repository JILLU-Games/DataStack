# DataStack Official Python SDK (`datastack`)

> **Production-Grade Python Client for DataStack** — featuring automatic `config.datastack.py` configuration discovery, real-time Socket.IO streaming (`Port 4000`), automatic Heartbeat HTTP fallback (`Port 3000`), offline disk spooling, and direct `.csv`, `.json`, and `.jsonl` file ingestion.

---

## 1. Installation

### Install from Local Repository
```bash
pip install ./sdk/python/datastack
```

### Editable Development Mode
```bash
pip install -e ./sdk/python/datastack
```

### PyPI Package Installation
```bash
pip install datastack
```

---

## 2. Zero-Boilerplate Setup with `config.datastack.py`

Create a file named **`config.datastack.py`** in your Python project's root directory (you can also copy a pre-filled version directly from the DataStack Admin Console at **`/vcon/sdk`**):

```python
# config.datastack.py
DATASTACK_CONFIG = {
    "SERVER_URL": "http://localhost:4000",        # Port 4000 Socket.IO Ingestion Service
    "API_URL": "http://localhost:3000",           # Port 3000 HTTP Fallback & File Ingestion API
    "CLIENT_TOKEN": "YOUR_CLIENT_JWT_TOKEN",      # Provisioned in /vcon/clients
    "AUTO_CONNECT": True,
    "ENABLE_HTTP_FALLBACK": True,
    "HEARTBEAT_INTERVAL_SEC": 5.0,
    "MAX_RETRIES": 3,
    "RETRY_BACKOFF_BASE_SEC": 0.5,
    "BATCH_CHUNK_SIZE": 250,
    "OFFLINE_SPOOL_ENABLED": True,
    "OFFLINE_SPOOL_DIR": ".datastack_spool",
    "MAX_SPOOL_SIZE_MB": 50,
}
```

---

## 3. Quickstart Usage

```python
from datastack import DataStack

# Automatically discovers and loads config.datastack.py and connects!
client = DataStack()

# 1. Push a Single Event
res = client.send({
    "service": "checkout-worker",
    "order_id": "ORD-9921",
    "amount_usd": 149.99,
    "status": "completed",
})
print("Single Event:", res)

# 2. Push a Batch of Events
batch_res = client.send_batch([
    {"data": {"metric": "cpu_load", "value": 0.42}},
    {"data": {"metric": "mem_used_mb", "value": 2048}},
])
print("Batch Result:", batch_res)

# 3. Directly Stream .csv, .json, or .jsonl Files
file_res = client.send_file("monthly_records.csv", chunk_size=250)
print("File Ingestion:", file_res)

# 4. Inspect Connection & Heartbeat Status
print("SDK Status:", client.status())

client.disconnect()
```

---

## 4. Smart Connection State Machine & Auto-Recovery

The DataStack Python SDK maintains a 4-state resilience lifecycle managed by `HeartbeatMonitor`:

1. **`CONNECTED_IDLE` (Primary WebSocket Active — Heartbeat IDLE)**:
   - Events stream over Socket.IO (`Port 4000`) with sub-millisecond overhead.
   - The Heartbeat Monitor sleeps in **IDLE mode** (`heartbeatMode: "IDLE"`), consuming zero network or CPU resources.
2. **`FALLBACK_HTTP` (WebSocket Disconnected — Auto HTTP Fallback Active)**:
   - If the WebSocket connection drops or closes, `send()`, `send_batch()`, and `send_file()` automatically switch to `POST {API_URL}/api/events` so zero application calls fail.
   - Simultaneously, the Heartbeat Monitor wakes up (`heartbeatMode: "ACTIVE_RECOVERY"`), probes and reconnects the WebSocket in the background, verifies the handshake (`ping_verify`), and transitions back to **`CONNECTED_IDLE` (`IDLE` mode)**.
3. **`OFFLINE_SPOOL` (Device Offline — Local Disk Spooling)**:
   - If the client machine loses internet connectivity completely, events are safely appended to `.datastack_spool/spool.jsonl` with deterministic `eventId`s.
   - When the device comes back online, the Heartbeat Monitor detects connectivity, reconnects the WebSocket, replays all spooled events without duplicates, and returns to **`CONNECTED_IDLE` (`IDLE` mode)**.
4. **Structured Error Handling & Auto-Chunking**:
   - **`413 PAYLOAD_TOO_LARGE`**: Batch/file payloads automatically split in half (`chunk // 2`) recursively and retry.
   - **`429 RATE_LIMIT_EXCEEDED`**: Automatically retries with exponential backoff and random jitter.
   - **`401 / 403` (`CLIENT_REVOKED`, `TOKEN_ROTATED`)**: Immediately halts retries and raises `DataStackAuthError`.

---

## 5. Author & License

- **Organization**: [Vib Tools](https://vibtools.top/)
- **Author**: Md Anik (`ANIK.D.ART`) — `info@vibtools.top`
- **License**: MIT License
