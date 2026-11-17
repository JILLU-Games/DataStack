# CSV Storage Engine Manifest

## Purpose
Partitioned CSV file storage engine (`core/Storage/csvStorage.ts`) responsible for writing, rotating, inspecting, and pruning collected event datasets on disk.

## Storage Conventions
- **Path Pattern**: `/storage/data/{clientId}/{YYYY-MM-DD}.csv`
- **Columns**: `clientId,eventId,timestamp,payload`
- **Size & Daily Rotation**: Creates a new daily file per client and rotates to `{YYYY-MM-DD}-part2.csv` when a file reaches `maxFileSizeBytes` (configurable via `fileRotationMb`, default `100MB`).
- **Retention Pruning**: `pruneExpiredPartitions(autoPruneDays)` automatically removes daily CSV partitions older than the configured retention period.
