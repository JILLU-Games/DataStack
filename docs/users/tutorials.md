# Usage Tutorials

This document provides hands-on tutorials for sending data to DataStack, integrating client SDKs, and exporting datasets.

---

## Tutorial 1: Sending Events via HTTP REST (`curl`)

The fastest way to send data to DataStack without writing application code is via the HTTP REST API.

### 1. Retrieve Your Client Token
In `/vcon/clients`, register a client (e.g., `bash_script_01`) and copy the generated Bearer JWT token.

### 2. Send a Single Event
```bash
curl -X POST "https://your-domain.example/api/events" \
  -H "Authorization: Bearer YOUR_CLIENT_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "order_1001",
    "timestamp": "2026-11-17T12:00:00Z",
    "data": {
      "item": "Mechanical Keyboard",
      "price": 129.99,
      "status": "completed"
    }
  }'
```

**Expected Response**:
```json
{
  "success": true,
  "eventId": "order_1001",
  "event": {
    "clientId": "bash_script_01",
    "eventId": "order_1001",
    "timestamp": "2026-11-17T12:00:00Z",
    "payload": "{\"item\":\"Mechanical Keyboard\",\"price\":129.99,\"status\":\"completed\"}"
  }
}
```

### 3. Send a Batch of Events
```bash
curl -X POST "https://your-domain.example/api/events" \
  -H "Authorization: Bearer YOUR_CLIENT_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "batch": [
      { "eventId": "evt_01", "data": { "metric": "cpu", "value": 45.2 } },
      { "eventId": "evt_02", "data": { "metric": "ram", "value": 72.8 } }
    ]
  }'
```

---

## Tutorial 2: Integrating the Python Client SDK

DataStack provides an official, pip-installable Python SDK featuring real-time Socket.IO streaming, automatic HTTP fallback, and offline disk spooling.

### 1. Install the SDK
```bash
pip install datastack
# Or install backward-compatible package:
pip install datastack-sdk
```

### 2. Create Configuration (`config.datastack.py`)
In the root of your Python project, create a `config.datastack.py` file:

```python
DATASTACK_CONFIG = {
    "SERVER_URL": "https://your-domain.example",   # WebSocket & proxy endpoint
    "CLIENT_TOKEN": "YOUR_CLIENT_JWT_TOKEN",       # Token from /vcon/clients
    "AUTO_CONNECT": True,
    "ENABLE_HTTP_FALLBACK": True,
    "OFFLINE_SPOOL_ENABLED": True,
}
```

### 3. Stream Telemetry from Python
```python
from datastack import DataStack
import time

# Client automatically discovers and loads config.datastack.py
client = DataStack()

print(f"Connected to DataStack as client: {client.client_id}")

for i in range(5):
    response = client.send(
        data={
            "sensor_id": "temp_probe_04",
            "temperature_celsius": 24.5 + i * 0.2,
            "humidity_percent": 55,
        },
        event_id=f"reading_{i}_{int(time.time())}"
    )
    print(f"Event sent: {response}")
    time.sleep(1)

client.disconnect()
```

---

## Tutorial 3: Streaming Local Files (`send_file`)

If you have offline log files or CSV datasets that need to be ingested into DataStack, use the SDK's built-in file streaming:

```python
from datastack import DataStack

client = DataStack()

# Supports .csv, .json, .jsonl, and .ndjson
result = client.send_file(
    file_path="./daily_orders.csv",
    chunk_size=250,  # Stream in batches of 250 records
    extra_metadata={"imported_by": "nightly_cron", "env": "production"}
)

print(f"File Ingestion Complete:")
print(f"  Processed rows: {result['processed']}")
print(f"  Duplicates skipped: {result['duplicates']}")
print(f"  Chunks sent: {result['chunksSent']}")
```

- **Lossless Handling**: If your server rate limits the file, the SDK automatically pauses and retries.
- **Deduplication**: Rows without an explicit `eventId` receive deterministic SHA-256 IDs, preventing duplicate rows if the script runs twice.

---

## Tutorial 4: Exporting Data for Analysis

You can stream historical partitions for analysis in pandas, Python, or command-line scripts.

### 1. Stream CSV Export via `curl`
```bash
curl -X GET "https://your-domain.example/api/export?format=csv&clientId=bash_script_01" \
  -H "Cookie: datastack_admin_session=YOUR_ADMIN_SESSION_TOKEN" \
  -o export_bash_script.csv
```

### 2. Load Directly into pandas
```python
import pandas as pd
import requests
import io

session_cookie = "YOUR_ADMIN_SESSION_COOKIE"
export_url = "https://your-domain.example/api/export?format=csv&clientId=all"

response = requests.get(
    export_url,
    cookies={"datastack_admin_session": session_cookie},
    stream=True
)

df = pd.read_csv(io.StringIO(response.text))
print("Exported DataFrame:")
print(df.head())
```
