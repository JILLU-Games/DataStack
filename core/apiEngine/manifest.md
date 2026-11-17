# API Engine Manifest

## Purpose
Aggregates system health, buffer status, client statistics, and CSV storage metrics for the `/vcon/dashboard` administration console (`core/apiEngine/apiService.ts`).

## Responsibilities
- Queries the Port 4000 ingestion server (`${INGESTION_INTERNAL_URL}/health`) for live `activeSockets` and remote `bufferSize`.
- Combines remote Socket.IO metrics with local `DataBufferEngine`, `CSVStorageManager`, `SDKManager`, `SecurityEngine`, and `DatabaseEngine` health states.
