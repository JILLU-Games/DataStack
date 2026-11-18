# Feature Guide

This document provides a comprehensive tour of DataStack's features and capabilities available in the administration console (`/vcon/`).

---

## 1. The Administration Console (`/vcon/`)

The DataStack Admin Console provides a clean, zero-clutter workspace for monitoring telemetry, registering client applications, inspecting stored partitions, and configuring platform limits.

Access the console by signing in at:
```text
https://your-domain.example/vcon/login
```

### Dashboard Overview (`/vcon/dashboard`)
The primary operational cockpit displays:
- **System Health**: Dual-runtime connectivity indicators for both Port 3000 (Web API) and Port 4000 (Express/Socket.IO ingestion service).
- **Storage Metrics**: Total CSV partition file count, active client directories, and total disk usage.
- **Buffer Gauges**: Active unflushed events currently buffered in memory and Redis, alongside flush intervals.
- **Live Activity Stream**: Real-time ticker showing recently ingested events with timestamps and payload previews.

---

## 2. Client SDK Registry & Security (`/vcon/clients`)

DataStack enforces strict authentication for all incoming telemetry streams.

### Registering a New Client
1. Navigate to **Clients** (`/vcon/clients`) and click **+ Register Client**.
2. Provide:
   - **Client Identifier**: Unique lowercase alphanumeric slug (e.g., `pos_terminal_01`, `mobile_app_prod`).
   - **Client Name**: Human-readable label (e.g., `Point of Sale Terminal #1`).
   - **Rate Limit**: Maximum allowed events per second for this client (default: `100 events/sec`).
3. Click **Register Client**. DataStack instantly signs a dedicated HMAC-SHA256 JWT token.
4. **Copy the Token**: Store the generated token securely in your client application's environment or configuration file.

### Credential Rotation & Access Control
- **Rotate Token**: Click **Rotate Token** to generate a new secret and token. The old token is immediately invalidated, and active WebSocket connections using the old credential are disconnected.
- **Revoke Access**: Set the client status to `Revoked`. Incoming HTTP requests and WebSocket handshakes will immediately be blocked with `CLIENT_REVOKED (403)`.
- **Permanent Deletion**: Deleting a client removes it from PostgreSQL and adds it to `deleted_clients` to ensure stale tokens can never be reused. You can optionally purge historical CSV archives.

---

## 3. Data Simulator (`/vcon/simulator`)

The built-in Data Simulator allows operators to test telemetry ingestion, rate limits, and buffer flushes without writing code:
- **Single Event**: Send ad-hoc JSON payloads with custom event IDs.
- **Batch Generator**: Trigger bursts of 10 to 500 events to observe real-time buffer threshold flushing.
- **Preset Schemas**: Pre-configured mock payloads for IoT temperature sensors, e-commerce transactions, server metrics, and user journey events.

---

## 4. Partitioned CSV Storage & Retention (`/vcon/storage`)

DataStack eliminates the performance overhead of per-row database inserts by streaming events directly into structured, partitioned CSV files on disk:
- **Directory Layout**: `/app/storage/data/{clientId}/{YYYY-MM-DD}.csv`
- **CSV Schema**: Each file contains 4 clean columns:
  ```csv
  clientId,eventId,timestamp,payload
  pos_terminal_01,evt_1700000000_a1b2,2026-11-17T12:00:00Z,"{""status"":""ok""}"
  ```
- **Size-Based Rotation**: When a partition reaches the configured threshold (default: `100 MB`), DataStack automatically closes the file and continues writing to `{YYYY-MM-DD}-part2.csv`.
- **Automated Retention Pruning**: Configure `autoPruneDays` (e.g., `30` days). DataStack automatically removes expired partition files, or set to `0` ("Keep all") to retain historical archives indefinitely.
- **Manual Buffer Flush**: Force an immediate flush of both in-memory and Redis buffers to disk with a single click.

---

## 5. Streaming Data Export (`/vcon/export`)

The Export Workspace provides fast, low-memory streaming extraction of telemetry data for data science and analytics:
- **Client Filter**: Export all clients or filter by a specific client ID.
- **Date Range**: Filter records within precise UTC start and end dates.
- **Formats**:
  - **CSV**: Clean RFC 4180 streaming CSV output with BOM support for direct import into Microsoft Excel, pandas, or DuckDB.
  - **JSON**: Formatted JSON array stream.
- **Non-Blocking Streaming**: Large multi-gigabyte partitions stream directly from disk to the client browser without buffering the full dataset in server RAM.

---

## 6. Platform Runtime Settings (`/vcon/settings`)

Fine-tune ingestion rules with instant cross-process propagation:
- **Max Events Per Second**: Global ingestion rate ceiling.
- **Max Payload Size (KB)**: Maximum permitted size per event payload (default: `100 KB`).
- **Batch Flush Threshold**: Number of buffered events that triggers an immediate write to disk (default: `500 events`).
- **Batch Flush Interval**: Maximum elapsed time before flushing pending events to disk (default: `2000 ms`).
- **Idempotency Protection**: Deduplicates events with identical `eventId` values within a 5-minute sliding window.
- **Connection Probing**: Test the live internal bridge between the Web console and the Port 4000 ingestion service.
