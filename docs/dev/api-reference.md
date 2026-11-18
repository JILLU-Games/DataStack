# API Reference Specification

This document provides the authoritative API specification for all DataStack REST HTTP endpoints (`app/api/*`) and real-time Socket.IO WebSocket protocol events (`server/socket/handlers.js`).

---

## 1. REST API Specification (Port 3000)

### 1.1 Ingestion Endpoints

#### `POST /api/events`
Ingests telemetry events over authenticated HTTP.

- **Authentication**: `Authorization: Bearer <CLIENT_JWT_TOKEN>`
- **Content-Type**: `application/json`
- **Supported Payload Shapes**:

##### Single Event Mode
```json
{
  "eventId": "evt_custom_12345",
  "payload": {
    "temperature": 23.4,
    "status": "normal"
  }
}
```

##### Batch Array Mode
```json
{
  "batch": [
    { "eventId": "evt_1", "payload": { "val": 10 } },
    { "eventId": "evt_2", "payload": { "val": 20 } }
  ]
}
```

##### File / Structured Record Mode
```json
{
  "fileName": "sensor_logs.csv",
  "records": [
    { "val": 10 },
    { "val": 20 }
  ]
}
```

- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "accepted": 1,
      "buffered": true
    }
    ```
  - `401 Unauthorized`: Missing or invalid client JWT.
  - `403 Forbidden`: Client status is `revoked` or client ID is recorded in `deleted_clients`.
  - `413 Payload Too Large`: Total payload exceeds `maxPayloadSizeKb`.
  - `429 Too Many Requests`: Client or global rate limit exceeded.

---

#### `POST /api/events/flush`
Forces an immediate write of all buffered RAM and Redis events to disk.

- **Authentication**: Operator Session Cookie (`datastack_admin_session`)
- **Responses**:
  - `200 OK`:
    ```json
    {
      "success": true,
      "flushed": 150
    }
    ```

---

### 1.2 Export Endpoints

#### `GET /api/export`
Streams filtered CSV or JSON records directly from disk partitions to the caller.

- **Authentication**: Operator Session Cookie (`datastack_admin_session`)
- **Query Parameters**:
  - `clientId` (string, optional): Specific client identifier or `all` (default: `all`).
  - `from` (string, optional): Inclusive start date filter (`YYYY-MM-DD`).
  - `to` (string, optional): Inclusive end date filter (`YYYY-MM-DD`).
  - `format` (string, optional): `csv` (default) or `json`.
  - `includeHeader` (boolean, optional): Whether to output CSV headers (default: `true`).
  - `flush` (boolean, optional): Whether to flush pending memory/Redis buffers before streaming (default: `true`).
  - `filename` (string, optional): Specific single partition filename (e.g., `2026-11-17.csv`).
- **Response Headers**:
  - `Content-Type`: `text/csv; charset=utf-8` or `application/json; charset=utf-8`
  - `Content-Disposition`: `attachment; filename="datastack_export_YYYY-MM-DD.csv"`
  - `Cache-Control`: `no-store`
  - `Transfer-Encoding`: `chunked`

---

### 1.3 System Health & Diagnostics

#### `GET /api/health`
Returns process uptime and database connection status.

- **Authentication**: None (Public)
- **Responses**:
  - `200 OK`:
    ```json
    {
      "status": "ok",
      "uptime": 12450.2,
      "timestamp": "2026-11-17T12:00:00.000Z",
      "database": "connected"
    }
    ```

---

### 1.4 Operator Authentication Endpoints

#### `POST /api/auth/login`
Authenticates administrator credentials and establishes session cookie.

- **Request Body**:
  ```json
  {
    "email": "admin@example.com",
    "password": "strongPassword123!"
  }
  ```
- **Responses**:
  - `200 OK`: Sets `datastack_admin_session` cookie (HttpOnly, SameSite=Lax, Secure in production).
  - `401 Unauthorized`: Invalid credentials.
  - `429 Too Many Requests`: IP temporarily blocked due to 5 failed attempts in 15 minutes.

---

#### `POST /api/auth/logout`
Terminates the operator session and clears the cookie.

---

#### `GET /api/auth/me`
Returns current authenticated administrator profile.

- **Responses**:
  - `200 OK`: `{"authenticated": true, "user": {"id": "...", "email": "..."}}`
  - `401 Unauthorized`: `{"authenticated": false}`

---

#### `POST /api/auth/setup`
Completes first-time installation wizard.

- **Request Body**:
  ```json
  {
    "setupKey": "CONFIGURED_SETUP_KEY",
    "email": "admin@example.com",
    "password": "strongPassword123!"
  }
  ```

---

#### `POST /api/auth/change-password`
Updates operator password and increments `tokenVersion`.

- **Request Body**:
  ```json
  {
    "currentPassword": "oldPassword",
    "newPassword": "newPassword123!"
  }
  ```

---

### 1.5 Client Registry Endpoints

#### `GET /api/clients`
Lists all registered SDK clients and rate limits.

#### `POST /api/clients`
Registers a new SDK client application.
- **Request Body**:
  ```json
  {
    "clientId": "pos_terminal_01",
    "name": "Point of Sale 1",
    "rateLimit": 100
  }
  ```

#### `PUT /api/clients/[id]`
Updates client rate limits, rotates secret tokens, or revokes access.

#### `DELETE /api/clients/[id]`
Deletes client from registry, moves ID to `deleted_clients` tombstone, and optionally purges storage files.

---

### 1.6 Settings Endpoints

#### `GET /api/settings`
Returns public platform runtime limits and buffer configurations.

#### `PUT /api/settings`
Updates platform limits and notifies Port 4000 ingestion service.

---

## 2. Socket.IO Real-Time Protocol Specification (Port 4000)

### Handshake Authentication
Clients connect via Socket.IO v4 client with a valid JWT token passed in the `auth` object or handshake `query`:

```javascript
const socket = io("https://your-domain.example", {
  path: "/socket.io/",
  auth: {
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
});
```

If the token is invalid, expired, revoked, or belongs to a tombstone client, the handshake is rejected immediately with an authentication error.

---

### Socket Events & Messages

#### Event: `sync_data`
Transmits a single telemetry event.

- **Message Body**:
  ```json
  {
    "eventId": "evt_client_9812",
    "payload": {
      "metric": "cpu",
      "value": 42.1
    }
  }
  ```
- **Acknowledgment Callback**:
  - Success: `{"status": "ok", "eventId": "evt_client_9812"}`
  - Error: `{"error": "Rate limit exceeded", "code": 429}`

---

#### Event: `sync_batch`
Transmits an array of events in a single payload.

- **Message Body**:
  ```json
  {
    "events": [
      { "eventId": "evt_1", "payload": { "val": 1 } },
      { "eventId": "evt_2", "payload": { "val": 2 } }
    ]
  }
  ```
- **Acknowledgment Callback**:
  - Success: `{"status": "ok", "acceptedCount": 2}`

---

#### Event: `heartbeat`
Keep-alive ping to measure latency and maintain connection health.

- **Message Body**: `{"timestamp": 1700000000000}`
- **Acknowledgment Callback**: `{"status": "ok", "pong": true, "serverTime": 1700000000010}`

---

## 3. Internal Service Bridge Specification (`/internal/*`)

All internal endpoints on Port 4000 require the header:
`x-datastack-internal-secret: <DATASTACK_INTERNAL_SECRET>`

- `GET /internal/metrics`: Returns connected socket count, active buffer queue depth, and memory stats.
- `POST /internal/settings-sync`: Pushes updated limits and secrets to Port 4000.
- `POST /internal/client-sync`: Pushes rotated, revoked, or deleted client updates.
- `POST /internal/flush`: Dispatches synchronous buffer flush to disk.
- `GET /internal/recent`: Fetches latest unwritten queue items for dashboard live activity streams.
