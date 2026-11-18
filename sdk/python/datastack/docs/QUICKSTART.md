# Quickstart Guide

Get up and running with the DataStack Python SDK in under 5 minutes.

---

## 1. Prerequisites

1. A running DataStack instance (local dev or production server).
2. A signed client token obtained from the Admin Console at **`/vcon/clients`** or **`/vcon/sdk`**.

---

## 2. Step 1: Create `config.datastack.py`

Place a `config.datastack.py` file in your application root directory (next to your main entry script). The SDK automatically searches your current working directory and up to three parent levels.

```python
# config.datastack.py
DATASTACK_CONFIG = {
    "SERVER_URL": "http://localhost:4000",       # Port 4000 WebSocket Ingestion Server
    "API_URL": "http://localhost:3000",          # Port 3000 REST API & HTTP Fallback
    "CLIENT_TOKEN": "YOUR_SIGNED_CLIENT_JWT",    # Provisioned in /vcon/clients
    "CLIENT_ID": "pos_terminal_01",              # Optional (auto-derived from JWT if omitted)
    "AUTO_CONNECT": True,
}
```

---

## 3. Step 2: Push Your First Telemetry Event

Create `main.py` and run it:

```python
from datastack import DataStack

# Automatically discovers config.datastack.py, connects, and verifies handshake
client = DataStack()

# Push a single event
response = client.send({
    "service": "checkout_worker",
    "orderId": "ORD-98214",
    "amount": 49.95,
    "currency": "USD",
    "status": "completed",
})

print("Ingestion Result:", response)
# Output:
# {'status': 'ok', 'eventId': 'evt_1700000000000_a1b2c3d4', 'transport': 'WEBSOCKET'}

# Graceful cleanup
client.disconnect()
```

---

## 4. Step 3: High-Volume Batch Streaming

Send multiple records in a single network round-trip. If the batch exceeds the server's maximum payload limit (`413 PAYLOAD_TOO_LARGE`), the SDK automatically splits the batch in half recursively:

```python
from datastack import DataStack

client = DataStack()

metrics_batch = [
    {"host": "worker-01", "cpu": 42.1, "mem_mb": 1024},
    {"host": "worker-02", "cpu": 68.4, "mem_mb": 2048},
    {"host": "worker-03", "cpu": 15.2, "mem_mb": 512},
]

result = client.send_batch(metrics_batch)
print(f"Processed: {result['processed']}, Duplicates: {result['duplicates']}")

client.disconnect()
```

---

## 5. Step 4: Direct File Ingestion

Stream an entire `.csv`, `.json`, `.jsonl`, or `.ndjson` dataset directly from disk. Records are assigned deterministic SHA-256 event IDs to guarantee idempotent delivery without memory bloat:

```python
from datastack import DataStack

client = DataStack()

# Stream records in chunks of 250 rows
summary = client.send_file("device_logs.csv", chunk_size=250)
print(f"File: {summary['fileName']}, Processed {summary['processed']} rows.")

client.disconnect()
```

---

## 6. Context Manager (Auto-Cleanup)

Use Python's `with` statement to guarantee clean disconnection when execution completes:

```python
from datastack import DataStack

with DataStack() as client:
    client.send({"action": "system_startup", "timestamp_utc": "2026-11-17T12:00:00Z"})
    print("Status:", client.status()["connectionState"])
# Client disconnects cleanly here automatically
```
