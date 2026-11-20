# DataStack Node.js & TypeScript SDK (`@datastack/sdk` v2.2.0)

Official server-side Node.js and TypeScript SDK for **DataStack**. Provides 1:1 transport, fallback, deduplication, and offline spooling parity with the official Python SDK (`sdk/python/datastack`).

---

## Features

- **Primary Real-Time WebSocket Transport (`socket.io-client`)**: Streams single events (`sync_data`) and batches (`batch_sync`) to Port `4000` with explicit server persistence acknowledgments.
- **Automatic HTTP Fallback (`POST /api/events`)**: Seamlessly falls back to Port `3000` REST ingestion whenever the WebSocket transport is disconnected or unreachable.
- **Offline Disk Spooling (`.datastack_spool/spool.jsonl`)**: Persists undelivered events to local disk when both WebSocket and HTTP endpoints are offline, and automatically drains the spool via `flushSpool()` when connectivity recovers.
- **Direct File Ingestion (`sendFile()`)**: Streams `.csv`, `.json`, `.jsonl`, and `.ndjson` files with deterministic SHA-256 `eventId` generation (`file_<stem>_<row>_<hash>`) so retries never duplicate rows.
- **Typed Error Hierarchy (`V2-E12`)**: Distinguishes terminal errors (`DataStackAuthError` for `401 CLIENT_TOKEN_EXPIRED` / `403 CLIENT_IP_FORBIDDEN`, `DataStackQuotaExceededError` for `507 STORAGE_QUOTA_EXCEEDED` / `DISK_SPACE_LOW`, `DataStackConfigError`) from retryable `429 RATE_LIMIT_EXCEEDED` (`DataStackRateLimitError`) and auto-splittable `413 PAYLOAD_TOO_LARGE` (`DataStackPayloadTooLargeError`).
- **Graceful Shutdown Drain (`await client.shutdown(timeoutMs)`)**: Waits for in-flight requests and drains pending spooled records before closing the socket.

---

## Installation

Install from the self-hosted repository path:

```bash
npm install /path/to/datastack/sdk/node/datastack
```

Or import directly inside a monorepo / TypeScript workspace:

```ts
import { DataStack } from './sdk/node/datastack';
```

---

## Configuration (`datastack.config.json` or Constructor Options)

Create `datastack.config.json` in your Node.js project root (or pass options directly to `new DataStack({...})`):

```json
{
  "serverUrl": "http://localhost:4000",
  "apiUrl": "http://localhost:3000",
  "clientToken": "YOUR_SIGNED_CLIENT_JWT_TOKEN",
  "clientId": "my_service_prod",
  "autoConnect": true,
  "enableHttpFallback": true,
  "batchChunkSize": 250,
  "offlineSpoolEnabled": true,
  "offlineSpoolDir": ".datastack_spool"
}
```

---

## Quickstart

```ts
import { DataStack } from '@datastack/sdk';

const client = new DataStack({
  serverUrl: process.env.DATASTACK_SERVER_URL || 'http://localhost:4000',
  apiUrl: process.env.DATASTACK_API_URL || 'http://localhost:3000',
  token: process.env.DATASTACK_CLIENT_TOKEN,
  clientId: 'checkout_api',
});

// 1. Single Event
const res = await client.send({
  event_type: 'order_completed',
  order_id: 'ord_9481',
  amount_usd: 129.99,
});

// 2. Batch Events
const batchRes = await client.sendBatch([
  { metric: 'cpu_load', value: 0.42, host: 'worker-01' },
  { metric: 'mem_used_mb', value: 1840, host: 'worker-01' },
]);

// 3. Direct File Ingestion (.csv, .json, .jsonl, .ndjson)
const fileRes = await client.sendFile('./backfill_events.csv', { chunkSize: 250 });

// 4. Graceful Shutdown Drain
await client.shutdown(5000);
```
