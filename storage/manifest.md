# Storage Directory Manifest (`storage/`)

## Purpose
Root storage directory for partitioned CSV event datasets written by the Next.js and Port 4000 ingestion engines.

## Partition Layout
- **File Path**: `/storage/data/{clientId}/{YYYY-MM-DD}.csv`
- **Overflow Rotation**: `/storage/data/{clientId}/{YYYY-MM-DD}-part{N}.csv` when a partition reaches the configured `fileRotationMb` size limit (default `100MB`).
- **CSV Header**: `clientId,eventId,timestamp,payload`
- **Git Policy**: Runtime data files under `storage/data/` are ignored by Git (`.gitignore`).
