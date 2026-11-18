# Data Simulator (`/vcon/simulator`)

The DataStack Data Simulator (`/vcon/simulator`) enables operators and developers to validate ingestion pipelines, test rate limits, and inspect buffer flushes directly from the browser without setting up external producer scripts.

---

## 1. Overview & Capabilities

The Simulator allows you to:
- Test ingestion using either **HTTP REST** (`POST /api/events`) or **Socket.IO WebSocket** (`sync_data`).
- Select any active client from your registered client list, or simulate unauthenticated/custom payloads.
- Dispatch single events or high-volume bursts (from 10 to 500 events).
- Select from realistic schema presets or construct custom JSON objects.
- Observe response status, payload transmission size, and round-trip latency in real time.

---

## 2. Telemetry Presets

The simulator includes four industry-standard telemetry presets:

### 1. IoT Temperature Sensor
```json
{
  "sensorId": "temp-north-01",
  "temperature": 23.4,
  "humidity": 45.2,
  "battery": 98,
  "unit": "celsius"
}
```

### 2. E-Commerce Order Checkout
```json
{
  "orderId": "ord_9872134",
  "customerId": "cust_11029",
  "currency": "USD",
  "totalAmount": 149.50,
  "itemCount": 3,
  "paymentMethod": "credit_card"
}
```

### 3. Server System Resource Metrics
```json
{
  "host": "prod-api-worker-03",
  "cpuUsagePercent": 34.2,
  "memoryUsedMb": 1024,
  "memoryTotalMb": 4096,
  "loadAverage": [0.45, 0.62, 0.58]
}
```

### 4. User Audit Trail & Security Event
```json
{
  "actorId": "usr_9912",
  "action": "client_token_rotated",
  "ipAddress": "192.168.1.100",
  "userAgent": "Mozilla/5.0",
  "success": true
}
```

---

## 3. Simulator Workflows

### Testing Single Event Ingestion
1. Select your target **Client** from the dropdown.
2. Select **Single Event** mode.
3. Choose a preset or customize the JSON editor.
4. Click **Send Event**.
5. The output console displays the assigned `eventId`, server response code (`200 OK`), and processing time.

### Testing High-Throughput Batch Flushing
1. Select **Batch Dispatch** mode.
2. Set the burst count (e.g., `500` events).
3. Click **Start Batch**.
4. Observe the batch progress bar.
5. Navigate to `/vcon/dashboard` to verify that the buffer threshold flush automatically triggered, writing the batch to the client's daily CSV partition file on disk.
