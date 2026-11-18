# Getting Started with DataStack

This fast-track tutorial guides you from a fresh server to a fully running DataStack instance collecting live telemetry in under 5 minutes.

---

## Step 1: Deploy with Docker Compose

Clone the repository and copy the environment template:

```bash
git clone https://github.com/vibtoolshq/datastack.git
cd datastack
cp .env.example .env
```

Generate 32+ character secrets for production:
```bash
# Generate random keys in Linux or macOS:
openssl rand -hex 32
```

In `.env`, set your secrets and admin email:
```dotenv
DATASTACK_ADMIN_SESSION_SECRET=your-32-char-session-secret-here
DATASTACK_JWT_SECRET=your-32-char-jwt-secret-here
DATASTACK_ADMIN_SETUP_KEY=your-32-char-setup-key-here
DATASTACK_INTERNAL_SECRET=your-32-char-internal-secret-here
DATASTACK_ADMIN_EMAIL=admin@example.com
```

Launch the stack:
```bash
docker compose -f docker/docker-compose.yml up -d
```

Verify that all 5 services are healthy:
```bash
docker compose -f docker/docker-compose.yml ps
```

---

## Step 2: Complete Initial Administrator Setup

1. Open your browser and navigate to:
   ```text
   http://localhost/vcon/setup
   # Or https://your-domain.example/vcon/setup
   ```
2. Enter:
   - **Administrator Email**: Must match `DATASTACK_ADMIN_EMAIL` (or your chosen admin email).
   - **Administrator Password**: Minimum 8 characters.
   - **Setup Security Key**: Enter the exact string from `DATASTACK_ADMIN_SETUP_KEY`.
3. Click **Complete Initial Setup**. You are automatically logged in and redirected to `/vcon/dashboard`.

---

## Step 3: Register Your First SDK Client

1. In the sidebar, click **Clients** (`/vcon/clients`).
2. Click **+ Register Client**.
3. Fill in the fields:
   - **Client Identifier**: `sensor_gateway_01` (lowercase alphanumeric and underscores).
   - **Client Name**: `Primary Sensor Gateway`.
   - **Rate Limit**: `100` (max events per second).
4. Click **Register Client**.
5. Copy the generated **Bearer JWT Token**. Store it securely.

---

## Step 4: Dispatch Your First Event via `curl`

Send a test telemetry event to the REST ingestion API:

```bash
curl -X POST "http://localhost/api/events" \
  -H "Authorization: Bearer YOUR_GENERATED_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "test_event_001",
    "timestamp": "2026-11-17T12:00:00Z",
    "data": {
      "temperature": 23.4,
      "humidity": 45,
      "status": "ONLINE"
    }
  }'
```

**Expected Response**:
```json
{
  "success": true,
  "eventId": "test_event_001",
  "event": {
    "clientId": "sensor_gateway_01",
    "eventId": "test_event_001",
    "timestamp": "2026-11-17T12:00:00Z",
    "payload": "{\"temperature\":23.4,\"humidity\":45,\"status\":\"ONLINE\"}"
  }
}
```

---

## Step 5: Connect with the Python Client SDK

Install the official Python SDK:
```bash
pip install datastack
```

In your Python project directory, create `config.datastack.py`:
```python
DATASTACK_CONFIG = {
    "SERVER_URL": "http://localhost",
    "CLIENT_TOKEN": "YOUR_GENERATED_JWT_TOKEN",
    "AUTO_CONNECT": True,
}
```

Create `main.py` and run it:
```python
from datastack import DataStack
import time

# Auto-discovers config.datastack.py in the current directory
client = DataStack()

print(f"Connected to DataStack as client: {client.client_id}")

# Stream 5 test events
for i in range(5):
    res = client.send(
        data={"reading_index": i, "voltage": 3.3 + (i * 0.05)},
        event_id=f"reading_{i}_{int(time.time())}"
    )
    print(f"Dispatched event {i}: {res.get('eventId')} via {res.get('transport')}")
    time.sleep(1)

client.disconnect()
```

---

## Step 6: Verify Data in the Admin Console

1. **Dashboard Overview (`/vcon/dashboard`)**:
   - Check the **Active Buffer** gauge — incoming events are queued in Redis / memory.
   - Observe the **Live Activity Stream** updating in real time.
2. **Data Browser (`/vcon/data`)**:
   - Filter by client `sensor_gateway_01`.
   - View your ingested events with exact timestamps and formatted JSON payloads.
3. **Data Export (`/vcon/export`)**:
   - Click **Export Dataset** to download a clean, consolidated CSV file ready for Excel or Python analysis.

---

## Next Steps
- Consult the complete **[Python SDK Documentation](../../sdk/python/datastack/docs/README.md)** for API reference, offline spooling, and file ingestion.
- Learn how to stream files (`.csv`, `.json`, `.jsonl`) with **[Tutorials](./tutorials.md)**.
- Understand storage rotation and auto-pruning in **[Partitioned CSV Storage](./features/partitioned-storage.md)**.
- Explore production deployment and backups in **[Installation Guide](./installation.md)**.
