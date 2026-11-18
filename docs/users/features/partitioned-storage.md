# Partitioned CSV Storage (`/vcon/storage`)

DataStack achieves sustained high throughput and scale-to-zero operational efficiency by bypassing per-row database inserts. All incoming telemetry streams are appended directly into partitioned CSV files on the local or mounted filesystem.

---

## 1. Storage Architecture & Directory Layout

Telemetry files are partitioned by client identifier and UTC date:

```text
storage/
└── data/
    ├── pos_terminal_01/
    │   ├── 2026-11-16.csv
    │   ├── 2026-11-17.csv
    │   └── 2026-11-17-part2.csv
    └── mobile_app_prod/
        ├── 2026-11-17.csv
        └── 2026-11-17.csv.lock   <-- Temporary cooperative write lock
```

### Partition File Format
Every CSV partition strictly adheres to RFC 4180 standard formatting with UTF-8 encoding:

```csv
clientId,eventId,timestamp,payload
pos_terminal_01,evt_1700000000000_a1b2,2026-11-17T12:00:00.000Z,"{""status"":""ok"",""temp"":23.4}"
pos_terminal_01,evt_1700000001000_c3d4,2026-11-17T12:00:01.000Z,"{""status"":""ok"",""temp"":23.6}"
```

- **Header**: Created automatically if the file does not exist when the first event of the day arrives.
- **Payload Field**: JSON strings are enclosed in double quotes with internal quotes escaped as `""`.
- **Newline**: Strict Unix standard `\n` line delimiters.

---

## 2. File Rotation Mechanism

To ensure partition files remain easy to compress, transfer, and load into memory-constrained analytics tools:

- **Configurable Limit**: Set via `fileRotationMb` in `/vcon/settings` (default: `100 MB`).
- **Rotation Behavior**:
  1. Before appending a batch, the storage engine checks the current file size on disk (`fs.statSync`).
  2. If appending the batch would exceed `fileRotationMb`, DataStack automatically creates the next increment:
     - Part 1: `2026-11-17.csv`
     - Part 2: `2026-11-17-part2.csv`
     - Part 3: `2026-11-17-part3.csv`
  3. Subsequent writes immediately target the active part file.

---

## 3. Cooperative Locking Protocol

Because both the Port 3000 Web server (handling HTTP ingestion) and the Port 4000 Ingestion server (handling WebSocket flushes) access the same storage volume, DataStack enforces a cooperative file locking protocol:

1. **Lock Creation**: Before reading or writing to a partition, the process attempts to create an atomic lock file alongside the CSV: `{filePath}.lock`.
2. **Lock Timeout**: Writers poll every 50ms up to a 10,000ms timeout.
3. **Stale Lock Recovery**: If a process crashes while holding a lock, subsequent processes inspect the lock's `mtime`. Any lock older than 30 seconds is treated as stale, forcefully unlinked, and reclaimed.
4. **Guaranteed Release**: Lock release is wrapped in `finally` blocks to guarantee cleanup after success or error.

---

## 4. Automated Retention Pruning

DataStack manages disk usage through an automated pruning engine:

- **Setting**: `autoPruneDays` (default: `30` days).
- **Pruning Logic**:
  - The engine parses date strings from filenames (`YYYY-MM-DD.csv`).
  - Any partition whose date is older than `Date.now() - (autoPruneDays * 86400000)` is deleted.
  - If a client's folder becomes empty, the folder is safely removed.
- **Disabling Pruning**: Setting `autoPruneDays: 0` in `/vcon/settings` disables automated pruning, retaining all partition history permanently.
- **Safety Guard**: Pruning runs only after database settings are fully hydrated, preventing accidental deletions during container bootstrap.
