# Client SDK Registry & Management (`/vcon/clients`)

DataStack enforces strict authentication for all telemetry sources. The **Client Management** workspace (`/vcon/clients`) allows operators to register client applications, generate and rotate JWT credentials, adjust per-client rate limits, and revoke access instantly.

---

## 1. Registering an SDK Client

To onboard a new application or telemetry producer:

1. Navigate to **Clients** (`/vcon/clients`) and click **+ Register Client**.
2. Complete the form:
   - **Client Identifier (`clientId`)**: A unique lowercase slug (e.g., `pos_terminal_01`, `mobile_app_prod`, `fleet_vehicle_42`). Allowed characters: `a-z`, `0-9`, `_`, `-`.
   - **Client Name**: Human-readable label (e.g., `Point of Sale Terminal #1`).
   - **Rate Limit (Events/sec)**: Maximum allowed throughput for this specific client (default: `100`).
3. Click **Register Client**.
4. **Copy the Generated Token**:
   - DataStack generates a cryptographically random 32-character client secret.
   - Using `DATASTACK_JWT_SECRET`, DataStack signs an HMAC-SHA256 JWT payload containing:
     ```json
     {
       "clientId": "pos_terminal_01",
       "name": "Point of Sale Terminal #1",
       "rateLimit": 100,
       "iat": 1700000000
     }
     ```
   - Store this token in your client's environment or configuration.

---

## 2. Managing Client Credentials & Lifecycle

### Rotating Client Tokens
If a client secret or JWT token is compromised or needs routine rotation:
1. Locate the client in the table and click **Rotate Token**.
2. Confirm the prompt.
3. DataStack generates a fresh client secret, signs a new JWT, and updates PostgreSQL.
4. **Instant Disconnection**: Port 3000 calls `POST /internal/client-sync`. The Port 4000 ingestion server immediately severs all active WebSocket connections holding the old token. The client must reconnect using the newly generated token.

### Revoking Access
To temporarily pause ingestion from a specific client without deleting its history:
1. Click the status dropdown or action button and select **Revoke**.
2. The client status changes to `revoked`.
3. Port 4000 immediately rejects new handshakes and terminates existing connections with `CLIENT_REVOKED (403)`.
4. HTTP requests to `POST /api/events` with this token are rejected with `403 Forbidden`.

### Restoring Access
1. Select a revoked client and click **Activate**.
2. Handshakes and HTTP ingestion are instantly permitted again.

### Deleting a Client
When an application is permanently decommissioned:
1. Click **Delete Client**.
2. Choose whether to:
   - **Keep Historical Data**: Retains `/app/storage/data/{clientId}/` on disk for future analytics and export.
   - **Purge Historical Data**: Deletes the partition folder and all CSV files for this client permanently.
3. **Tombstone Protection**: DataStack records the client ID and secret in the `deleted_clients` PostgreSQL table. Even if someone attempts to reuse an old signed JWT, the ingestion server checks the tombstone list and rejects the request.
