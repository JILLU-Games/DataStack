# Technical Glossary

This glossary defines technical terms, architectural concepts, and domain language used throughout the DataStack platform and documentation.

---

### Control Plane
The administrative and configuration layer of DataStack. Handled on **Port 3000** (Next.js 15), the control plane manages administrator authentication, SDK client credential issuance, rate limits, and runtime limits. State is stored in PostgreSQL.

### Data Plane
The high-throughput telemetry ingestion and storage subsystem. Handled on **Port 4000** (Express 5 + Socket.IO 4), the data plane handles persistent client connections, in-memory/Redis buffering, and writes to partitioned CSV files on disk.

### Cooperative Locking
A lightweight filesystem locking protocol used to coordinate writes between independent processes (Port 3000 Web and Port 4000 Ingestion). Writers create a companion `{partition}.csv.lock` file before writing. If a writer crashes, locks older than 30 seconds are treated as stale and automatically unlinked.

### Sliding-Window Rate Limiting
A rate limiting algorithm implemented in `core/Security/security.ts`. Tracks the number of events received per client within the current one-second sliding window. Exceeding events are rejected with HTTP 429 or Socket.IO error messages.

### Idempotency Envelope
A deduplication safeguard that tracks client-provided `eventId` values within a 5-minute sliding window. If an event with the same ID arrives multiple times (due to client retries or network replays), duplicate writes to disk are prevented.

### Partitioned CSV Storage
The core data storage model of DataStack. Telemetry streams are organized into directories by client identifier, with records partitioned into daily files named `YYYY-MM-DD.csv` conforming to RFC 4180 standard formatting.

### File Rotation
The automatic division of daily CSV files when disk size exceeds `fileRotationMb` (default 100 MB). The active partition seamlessly transitions to `{YYYY-MM-DD}-part2.csv`, preventing unwieldy file sizes.

### Internal Service Bridge (`/internal/*`)
The private inter-process communication protocol between Port 3000 and Port 4000. Guarded by `DATASTACK_INTERNAL_SECRET`, it allows administrative changes in `/vcon/` (such as client revocations or secret rotations) to take effect in Port 4000 without restarting services.

### Token Versioning (`tokenVersion`)
A security mechanism in `admin_users` and session cookies. An integer counter is embedded in each signed session cookie. Updating an operator password or selecting "Log Out Other Sessions" increments this number in PostgreSQL, instantly invalidating all active sessions across all devices.

### Tombstone Registry (`deleted_clients`)
A PostgreSQL audit table storing identifiers of permanently deleted clients. Ensures that previously signed JWT tokens or stale producer credentials can never be reused to send data.

### Standalone Output
A Next.js build configuration mode (`output: "standalone"` in `next.config.ts`) that bundles only required production dependencies into `.next/standalone`, enabling lightweight, fast-starting Docker containers without bulky `node_modules` folders.

### Offline Spooling
A reliability feature of the Python SDK. If the server is unreachable or network connectivity drops, telemetry events are buffered to a local disk directory (`.datastack_spool/`) and automatically drained to the server once connectivity is restored.
