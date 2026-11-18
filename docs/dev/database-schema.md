# Database Schema & Migrations

This document specifies the PostgreSQL control-plane database schema, table definitions, constraints, and non-destructive additive migration architecture.

---

## 1. Architectural Boundary

> **IMPORTANT ARCHITECTURAL RULE**: PostgreSQL is used **strictly for control-plane metadata** (admin accounts, login throttling, client tokens, and runtime settings).
>
> **Zero Telemetry Writes**: Telemetry events are never written to PostgreSQL. All event data is buffered and persisted directly to daily CSV partitions under `/app/storage/data/{clientId}/{YYYY-MM-DD}.csv`.

---

## 2. Table Specifications

### 2.1 Table: `admin_users`
Stores single-tenant administrator credentials and session token versions.

```sql
CREATE TABLE IF NOT EXISTS admin_users (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email TEXT NOT NULL UNIQUE,
  password_salt BYTEA NOT NULL,
  password_hash BYTEA NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- **`id`**: Enforces a single administrator row constraint (`CHECK (id = 1)`).
- **`email`**: Unique administrator contact and login email.
- **`password_salt`**: Cryptographically secure 16-byte random salt (`crypto.randomBytes(16)`).
- **`password_hash`**: 64-byte scrypt derived hash (`crypto.scryptSync(password, salt, 64)`).
- **`token_version`**: Integer counter embedded into session cookies. Incrementing this immediately invalidates all active sessions globally.

---

### 2.2 Table: `admin_login_attempts`
Tracks failed login attempts for brute-force protection.

```sql
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  key_hash TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL,
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- **`key_hash`**: SHA-256 hash of `normalized_ip + ":" + normalized_email`.
- **`window_started_at`**: Start timestamp of the current 15-minute sliding window.
- **`failed_attempts`**: Count of failed attempts within the window (locks at 5).
- **`blocked_until`**: Timestamp until which further login attempts from this key are rejected.

---

### 2.3 Table: `client_sdks`
Maintains the registry of authorized SDK client credentials and per-client throughput quotas.

```sql
CREATE TABLE IF NOT EXISTS client_sdks (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  token TEXT NOT NULL,
  rate_limit INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active',
  total_events BIGINT NOT NULL DEFAULT 0,
  last_active TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- **`client_id`**: Lowercase slug identifying the producer.
- **`secret`**: 32-character random client secret used for verification.
- **`token`**: Current signed HMAC-SHA256 JWT token.
- **`rate_limit`**: Quota of maximum allowed events per second.
- **`status`**: Current access state (`active` or `revoked`).
- **`total_events`**: Lifetime count of successfully ingested events.

---

### 2.4 Table: `deleted_clients`
Tombstone table preventing reused client IDs or compromised stale tokens from regaining access.

```sql
CREATE TABLE IF NOT EXISTS deleted_clients (
  client_id TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- **`client_id`**: Identifier of permanently removed client. Checked during both HTTP ingestion and Socket.IO handshakes.

---

### 2.5 Table: `admin_settings`
Single-row platform configuration table storing runtime operational parameters.

```sql
CREATE TABLE IF NOT EXISTS admin_settings (
  id TEXT PRIMARY KEY DEFAULT 'default',
  server_port INTEGER NOT NULL DEFAULT 4000,
  web_port INTEGER NOT NULL DEFAULT 3000,
  max_events_per_sec INTEGER NOT NULL DEFAULT 100,
  max_payload_size_kb INTEGER NOT NULL DEFAULT 100,
  batch_flush_threshold INTEGER NOT NULL DEFAULT 500,
  batch_flush_interval_ms INTEGER NOT NULL DEFAULT 2000,
  file_rotation_mb INTEGER NOT NULL DEFAULT 100,
  jwt_secret TEXT NOT NULL,
  enable_idempotency BOOLEAN NOT NULL DEFAULT true,
  auto_prune_days INTEGER NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 3. Migration Architecture

DataStack executes automated, non-destructive schema migrations on application startup via `DatabaseEngine.ensureSchema()`:

1. **`CREATE TABLE IF NOT EXISTS`**: Ensures all tables exist without altering pre-existing data.
2. **`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`**: Adds new columns with backwards-compatible defaults if upgrading from an older version.
3. **No Destructive Operations**: `DROP TABLE`, `DROP COLUMN`, and type truncations are strictly forbidden in production migrations. Existing databases retain all rows and constraints across container updates.
