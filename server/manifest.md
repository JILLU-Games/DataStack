# Socket.IO Ingestion Server Manifest (`server/`)

## Purpose
Standalone Express.js and Socket.IO ingestion service running on Port `4000` (`server/index.js`).

## Architecture
- `index.js`: Initializes the HTTP/Socket.IO server, synchronizes runtime settings and client status from PostgreSQL (`admin_settings`, `client_sdks`), schedules periodic and threshold-based buffer flushes, and exposes `GET /health` and `POST /internal/flush`.
- `socket/handlers.js`: Authenticates Socket.IO handshakes via JWT, blocks revoked clients or rotated tokens in real time, validates rate limits, payload sizes, and 5-minute TTL idempotency on `sync_data` and `batch_sync`, and updates client event counters in PostgreSQL.
- `workers/csvWriter.js`: Asynchronous batch CSV writer appending queued events to `/storage/data/{clientId}/{YYYY-MM-DD}.csv` with automatic size-based file rotation (`-part2.csv`).
