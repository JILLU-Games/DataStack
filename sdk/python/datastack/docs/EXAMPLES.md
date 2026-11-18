# Practical Usage Examples

This guide provides production-ready code examples covering common telemetry, logging, and data pipeline scenarios.

---

## 1. IoT Edge Sensor Streaming (with Offline Resilience)

Edge devices frequently face intermittent Wi-Fi or cellular drops. The SDK buffers events to local disk (`.datastack_spool/`) when the connection drops, and drains them automatically when restored:

```python
import time
import random
from datastack import DataStack

# Initialize client using config.datastack.py
client = DataStack()

try:
    while True:
        # Simulate reading from hardware sensors
        sensor_reading = {
            "sensor_id": "thermostat-zone-a",
            "temperature_c": round(20.0 + random.uniform(-2.5, 3.0), 2),
            "humidity_percent": round(45.0 + random.uniform(-5.0, 5.0), 1),
            "battery_level": 94,
        }

        # Automatically routes via WebSocket, HTTP fallback, or local disk spool
        res = client.send(sensor_reading)
        print(f"Delivered via {res.get('transport')}: eventId={res.get('eventId')}")

        time.sleep(2.0)
except KeyboardInterrupt:
    print("Shutting down sensor stream...")
finally:
    client.disconnect()
```

---

## 2. Web Application Audit Logging (FastAPI Middleware)

Record HTTP request and response metrics asynchronously from a Python web service:

```python
import time
from fastapi import FastAPI, Request
from datastack import DataStack

app = FastAPI()
datastack_client = DataStack()

@app.middleware("http")
async def datastack_telemetry_middleware(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    duration_ms = round((time.time() - start_time) * 1000, 2)

    # Dispatch audit record to DataStack
    datastack_client.send({
        "eventType": "http_request",
        "method": request.method,
        "path": request.url.path,
        "statusCode": response.status_code,
        "durationMs": duration_ms,
        "clientIp": request.client.host if request.client else "unknown",
    })

    return response

@app.on_event("shutdown")
def on_shutdown():
    datastack_client.disconnect()
```

---

## 3. High-Volume Batch Ingestion (Auto-Splitting on 413)

When emitting high-volume bursts, the SDK automatically splits batches in half if they exceed the server's maximum payload limit:

```python
from datastack import DataStack

client = DataStack()

# Construct a high-volume batch of 1,000 transaction events
transactions = [
    {
        "transactionId": f"tx_{idx:06d}",
        "amount": round(idx * 1.25, 2),
        "currency": "EUR",
        "status": "settled",
    }
    for idx in range(1000)
]

# send_batch handles chunking, rate-limit backoff, and 413 halving automatically
result = client.send_batch(transactions)

print("Batch Ingestion Summary:")
print(f"- Processed Rows: {result['processed']}")
print(f"- Duplicate Rows: {result['duplicates']}")
print(f"- Rejected Rows:  {result['rejected']}")
print(f"- Transport Used: {result['transport']}")

client.disconnect()
```

---

## 4. Bulk CSV File Ingestion with Metadata Tagging

Stream a monthly export or historical log file into DataStack in chunks of 500 rows, injecting tenant metadata:

```python
from datastack import DataStack

client = DataStack()

file_summary = client.send_file(
    "store_sales_2026_11.csv",
    chunk_size=500,
    extra_metadata={
        "ingestedBy": "etl_pipeline_v2",
        "region": "us-east-1",
    }
)

print(f"File {file_summary['fileName']} streamed in {file_summary['chunksSent']} chunks.")
print(f"Total rows successfully ingested: {file_summary['processed']}")

client.disconnect()
```

---

## 5. Explicit Initialization (Without Configuration File)

In dynamic serverless jobs, container environments, or tests where creating `config.datastack.py` is inconvenient:

```python
from datastack import DataStack

client = DataStack(
    server_url="https://ingestion.datastack.example",
    api_url="https://api.datastack.example",
    token="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    auto_connect=True,
    max_retries=5,
    offline_spool_enabled=False,  # Ephemeral container: disable disk spooling
)

client.send({"job": "nightly_cleanup", "status": "success"})
client.disconnect()
```

---

## 6. Inspecting Client Health & Spool Status

Periodically check connection health, Heartbeat mode, and pending offline spool depth:

```python
from datastack import DataStack

client = DataStack()
status = client.status()

print("DataStack Client Health Snapshot:")
print(f"- WebSocket Connected: {status['connectedWebSocket']}")
print(f"- Connection State:    {status['connectionState']}")
print(f"- Heartbeat Mode:      {status['heartbeatMode']}")
print(f"- Pending Spool Count: {status['offlineSpoolPending']}")
print(f"- Spool Disk Bytes:    {status['offlineSpoolBytes']} bytes")

client.disconnect()
```
