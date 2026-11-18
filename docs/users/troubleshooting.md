# Troubleshooting & Forensic Diagnostics

This guide provides systematic troubleshooting instructions for diagnosing and resolving common operational issues, connection failures, and error codes in DataStack.

---

## 1. Quick Diagnostic Checklist

When investigating an issue, verify the following baseline checks:

1. **Check Container Status**:
   ```bash
   docker compose ps
   ```
   All five services (`datastack-web`, `datastack-ingestion`, `datastack-proxy`, `datastack-postgres`, `datastack-redis`) should display `Up` and `(healthy)`.

2. **Check Nginx Proxy Health Endpoint**:
   ```bash
   curl -i http://localhost/health
   # Expected response: HTTP/1.1 200 OK
   # Body: OK
   ```

3. **Check Web Application Status**:
   ```bash
   curl -i http://localhost:3000/api/health
   # Expected response: {"status":"ok","uptime":...}
   ```

4. **Inspect Live Logs**:
   ```bash
   docker compose logs -f --tail=100 datastack-web datastack-ingestion
   ```

---

## 2. Ingestion & API Errors

### HTTP 401 Unauthorized (`INVALID_TOKEN`)
- **Cause**: The client request did not supply an `Authorization` header, or the provided JWT signature is invalid.
- **Resolution**:
  - Ensure the client request header contains: `Authorization: Bearer <TOKEN>`.
  - Check whether the platform JWT secret was recently rotated in `/vcon/settings`. If rotated, copy the newly signed token from `/vcon/clients`.

### HTTP 403 Forbidden (`CLIENT_REVOKED` or `CLIENT_DELETED`)
- **Cause**: The client was marked as `revoked` in `/vcon/clients`, or the client ID exists in the `deleted_clients` tombstone registry.
- **Resolution**:
  - In `/vcon/clients`, verify the client's status. If revoked, click **Activate**.
  - If the client was permanently deleted, register a new client slug.

### HTTP 403 Forbidden (`CSRF_FAILED`)
- **Cause**: State-changing POST/PUT/DELETE requests to administrative routes did not match the required `Origin` or `Referer` headers.
- **Resolution**:
  - When accessing behind a reverse proxy (e.g., Cloudflare, Traefik, Coolify), ensure the proxy forwards the original host header:
    ```nginx
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    ```

### HTTP 413 Payload Too Large (`PAYLOAD_TOO_LARGE`)
- **Cause**: An incoming event payload exceeds `maxPayloadSizeKb` (default: 100 KB).
- **Resolution**:
  - Split large batches into smaller chunks, or increase the payload limit in `/vcon/settings` (up to 10 MB).

### HTTP 429 Too Many Requests (`RATE_LIMIT_EXCEEDED`)
- **Cause**: The client has exceeded its configured rate limit (events/second) or the platform-wide limit.
- **Resolution**:
  - Navigate to `/vcon/clients`, click **Edit Client**, and increase the per-client rate limit.
  - Or in `/vcon/settings`, raise `maxEventsPerSec`.

---

## 3. WebSocket & Socket.IO Connection Issues

### Handshake Fails or Drops Back to Long-Polling
- **Symptoms**: Browser or Python client reports continuous reconnect attempts; delays in data synchronization.
- **Cause**: The upstream reverse proxy is not passing the WebSocket upgrade headers.
- **Resolution**:
  - Verify your reverse proxy configuration includes:
    ```nginx
    location /socket.io/ {
        proxy_pass http://datastack-ingestion:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
    ```

---

## 4. Storage & Filesystem Issues

### Write Delays or Stale Lock Warning in Logs
- **Symptoms**: Log message shows: `Acquiring lock for partition ... timeout`.
- **Cause**: A previous worker process was abruptly terminated (e.g., `kill -9` or OOM) while writing to disk, leaving a `.lock` file behind.
- **Resolution**:
  - DataStack automatically cleans up locks older than 30 seconds.
  - If an immediate manual clear is needed, check for `.lock` files in the partition directory:
    ```bash
    find storage/data -name "*.lock" -type f
    ```
  - Unlink locks older than 60 seconds:
    ```bash
    find storage/data -name "*.lock" -type f -mmin +1 -delete
    ```

### Missing Historical Partitions
- **Cause**: Automated retention pruning (`autoPruneDays`) purges partition files older than the retention threshold.
- **Resolution**:
  - Check the configured value in `/vcon/settings`. Set to `0` if you want all partition files retained indefinitely.
