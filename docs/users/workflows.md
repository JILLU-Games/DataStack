# Operational Workflows & User Journeys

This document provides step-by-step procedures for common operational workflows, from first-time administrator onboarding to credential rotation and disaster recovery.

---

## Workflow 1: Initial Administrator Onboarding

When setting up a newly deployed instance:

```text
Deploy Stack ──► Open /vcon/setup ──► Enter Setup Key & Admin Email ──► Create Password ──► Redirect to /vcon/dashboard
```

1. Visit your instance URL at `/vcon/setup` (e.g., `https://your-domain.example/vcon/setup`).
2. If an administrator already exists, DataStack redirects to `/vcon/login`.
3. Provide the required credentials:
   - **Setup Key**: Enter the `DATASTACK_ADMIN_SETUP_KEY` configured in your `.env`.
   - **Admin Email**: Enter the primary operational contact email.
   - **Password**: Enter a strong password (minimum 8 characters, checked against common passwords).
4. Click **Complete Setup**.
5. DataStack hashes the password using `crypto.scrypt`, creates the first row in `admin_users`, establishes a signed session cookie, and redirects to `/vcon/dashboard`.

---

## Workflow 2: Onboarding an External Client Application

Connecting a new producer (Python app, IoT gateway, mobile app, microservice):

```text
/vcon/clients ──► Register Client ──► Copy JWT Token ──► Configure Client App ──► Stream Events
```

1. Navigate to **Clients** (`/vcon/clients`).
2. Click **+ Register Client**.
3. Specify:
   - `Client Identifier`: e.g., `checkout_service_prod`
   - `Client Name`: e.g., `Checkout Service Production`
   - `Rate Limit`: e.g., `250` events/second
4. Click **Register Client**.
5. A modal appears displaying the newly signed HMAC-SHA256 JWT token.
6. **Copy the token** and configure your application environment:
   ```dotenv
   DATASTACK_CLIENT_ID=checkout_service_prod
   DATASTACK_AUTH_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   DATASTACK_SERVER_URL=https://your-domain.example
   ```
7. Start your producer. Events will immediately stream into the system and appear in the live dashboard activity feed.

---

## Workflow 3: Rotating a Client Token

If a client token has leaked or requires routine security rotation:

```text
/vcon/clients ──► Rotate Token ──► Copy New Token ──► Update Client Config ──► Reconnect
```

1. Open `/vcon/clients`.
2. Locate the client row and click **Rotate Token**.
3. Confirm the action in the confirmation modal.
4. DataStack generates a new client secret, signs a fresh JWT, updates PostgreSQL, and notifies Port 4000 via `/internal/client-sync`.
5. Active WebSocket connections using the prior token are disconnected immediately.
6. Copy the new token and update your producer application's environment. Once restarted, the client reconnects with the new token.

---

## Workflow 4: Rotating the Platform JWT Secret

In the event of an infrastructure-wide security review or platform secret compromise:

1. Open `/vcon/settings`.
2. In the **Security & Secrets** card, click **Rotate Platform Secret**.
3. Confirm the security alert.
4. DataStack:
   - Generates a new cryptographically secure 48-character platform JWT secret.
   - Saves the secret to `admin_settings`.
   - Iterates through all registered clients in PostgreSQL and re-signs their tokens using the new master secret (`SDKManager.resignAllClientTokensAsync()`).
   - Pushes the new secret and re-signed tokens to Port 4000 via `/internal/settings-sync`.
5. Navigate to `/vcon/clients` to export or view the refreshed client tokens to distribute to client application teams.

---

## Workflow 5: Backup & Disaster Recovery

DataStack stores state in two distinct layers: PostgreSQL (metadata) and filesystem volumes (telemetry data).

### Backing Up the PostgreSQL Control Plane
```bash
docker exec -t datastack-postgres pg_dump -U datastack datastack_db > datastack_meta_$(date +%F).sql
```

### Backing Up Telemetry Partitions
Telemetry files reside in the named Docker volume `datastack-data` (or mounted host path `./storage/data`).

```bash
# Archive all client partition directories
docker run --rm \
  -v datastack-data:/data:ro \
  -v $(pwd):/backup \
  alpine tar czf /backup/datastack_partitions_$(date +%F).tar.gz -C /data .
```

### Restoring from Backup
1. Stop the ingestion and web containers:
   ```bash
   docker compose down
   ```
2. Restore the database:
   ```bash
   docker compose up -d postgres
   cat datastack_meta_2026-11-17.sql | docker exec -i datastack-postgres psql -U datastack datastack_db
   ```
3. Restore the partition volume:
   ```bash
   docker run --rm \
     -v datastack-data:/data \
     -v $(pwd):/backup \
     alpine tar xzf /backup/datastack_partitions_2026-11-17.tar.gz -C /data
   ```
4. Restart the full stack:
   ```bash
   docker compose up -d
   ```
