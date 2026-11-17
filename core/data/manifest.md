# Data Buffer Engine Manifest

## Purpose
In-memory event batching engine (`core/data/buffer.ts`) that queues incoming events and flushes them in batches to partitioned CSV files on disk.

## Key Responsibilities
- Queues validated events in memory to avoid per-event disk I/O overhead.
- Automatically flushes queued batches to `CSVStorageManager.appendBatch()` when the queue reaches `batchFlushThreshold` (`500` events) or when the periodic flush timer (`batchFlushIntervalMs`, default `2000ms`) fires.
- Supports dynamic timer rescheduling via `setFlushInterval(intervalMs)` when updated in `/vcon/settings`.
