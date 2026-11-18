# Administration Console (`/vcon/`)

The DataStack Administration Console (`/vcon/`) provides operators and systems engineers with a central interface for observing telemetry ingestion, tracking disk utilization, managing administrator accounts, and tuning ingestion limits.

---

## 1. Authentication & Access

Access the console by visiting:
```text
https://your-domain.example/vcon/login
```

- **Authentication Method**: Signed HTTP-only session cookies (`datastack_admin_session`) using WebCrypto HMAC-SHA256.
- **Session Security**: Session tokens encode the administrator's ID and current `tokenVersion`. Changing a password or clicking **Sign Out** immediately invalidates all active sessions globally.
- **Brute-Force Protection**: IP + Email failed attempt tracking locks out callers for 15 minutes after 5 consecutive failures.

---

## 2. Dashboard Workspace (`/vcon/dashboard`)

The dashboard provides real-time operational visibility:

### Dual-Runtime Health Indicators
- **Web App (Port 3000)**: Displays status, uptime, and database connection state.
- **Ingestion Service (Port 4000)**: Verifies the real-time bridge via `GET /internal/metrics`. Displays active Socket.IO connection counts and server status.

### Metric Gauges & Telemetry Cards
- **Total Ingested Events**: Lifetime count of telemetry events recorded across all registered client partitions.
- **Active Clients**: Number of SDK client credentials currently active and authorized to send data.
- **Total Storage Used**: Total disk footprint of all CSV partitions stored under `/app/storage/data`.
- **Partition Files**: Count of daily partition files currently retained on disk.
- **Unflushed Buffer Depth**: Number of events currently awaiting disk write in local RAM or Redis.
- **Flush Threshold / Interval**: Configured batch write limits (e.g., 500 events or 2000 ms).

### Live Activity Ticker
- Displays a real-time list of recently ingested events across all connected clients.
- Shows timestamp (UTC), client identifier, event ID, and an expandable preview of the JSON payload.
- Auto-refreshes periodically or on-demand.

### Manual Buffer Flush
- Clicking **Flush Buffer** dispatches a request to `/api/events/flush` which synchronously notifies Port 4000 (`POST /internal/flush`) and flushes Port 3000's RAM queue to disk.

---

## 3. Profile & Security Workspace (`/vcon/profile`)

Manage administrator credentials and session tokens:

- **Current Operator Info**: Displays email address and creation timestamp.
- **Password Modification**: Update account passwords with mandatory current password verification. Passwords are encrypted using `crypto.scrypt` (64-byte derived key, 16-byte cryptographically secure random salt).
- **Session Revocation**: Clicking **Log Out Other Sessions** increments the user's `tokenVersion` in PostgreSQL, instantly invalidating any other browsers or cookies.
