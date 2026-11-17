# Admin Settings Engine Manifest

## Purpose
Manages global runtime configuration (`core/adminSettings/settingsManager.ts`), persisting settings to the PostgreSQL `admin_settings` table and applying live updates across backend engines.

## Managed Parameters
- `serverPort` (`4000`) and `webPort` (`3000`)
- `maxEventsPerSec`: Default per-client throughput ceiling (events/sec)
- `maxPayloadSizeKb`: Maximum event payload size in kilobytes
- `batchFlushThreshold`: Number of queued events that triggers an immediate CSV flush
- `batchFlushIntervalMs`: Background timer interval for periodic CSV flushes
- `fileRotationMb`: Maximum CSV partition file size before rotating to `-part2.csv`
- `autoPruneDays`: Retention window in days for automatic CSV partition pruning
- `enableIdempotency`: 5-minute TTL duplicate event filtering toggle
- `jwtSecret`: HMAC secret used to sign and verify Client SDK JWT tokens (updating this automatically re-signs existing client tokens)
