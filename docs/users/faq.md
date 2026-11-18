# Frequently Asked Questions (FAQ) & Troubleshooting

This document answers common operational, configuration, and troubleshooting questions.

---

## General Architecture & Data Storage

### Why does DataStack store events in CSV files instead of PostgreSQL?
Relational databases degrade significantly when handling thousands of concurrent writes per second due to WAL bottlenecks, indexing contention, and connection limits. DataStack separates concerns:
- **PostgreSQL** is used exclusively for administrative accounts, client credentials, and platform configuration.
- **Partitioned CSV Files** (`/storage/data/{clientId}/{YYYY-MM-DD}.csv`) receive high-throughput batched writes sequentially on disk. This enables lightning-fast ingestion, predictable disk space usage, zero SQL table locking, and trivial backup and compression.

### What happens if the server crashes while events are buffered?
DataStack implements multi-layer crash protection:
1. **Redis AOF Durability**: In production with Redis enabled (`--appendonly yes`), incoming events are pushed immediately to a durable Redis queue (`datastack:buffer:events`).
2. **Post-Write Trimming**: The Redis list is trimmed (`LTRIM`) **strictly after** the batch append to the CSV file succeeds on disk. If a crash occurs mid-write, Redis retains the items and flushes them upon reboot.
3. **Graceful Signal Handling**: On `SIGTERM` or `SIGINT` (such as during container updates), DataStack halts new input, awaits the in-flight disk flush, and releases file locks before shutting down.

### How does file rotation and retention pruning work?
- **Rotation (`fileRotationMb`)**: By default, when a daily CSV file reaches `100 MB`, DataStack safely rotates to `{YYYY-MM-DD}-part2.csv`.
- **Retention Pruning (`autoPruneDays`)**: By default, partitions older than 30 days are automatically pruned. To retain all historical records indefinitely, set **Auto Prune Days** to `0` ("Keep all") in `/vcon/settings`.

---

## Networking & Ports

### What ports does DataStack use?
In a standard Docker Compose deployment, the services communicate over an internal network:
- **Port `80`**: Exposed by the Nginx reverse proxy (`proxy` container) to the public or host.
- **Port `3000`**: Internal Next.js web application, Admin Console, and REST API (`web` container).
- **Port `4000`**: Internal Express + Socket.IO real-time ingestion service (`ingestion` container).
- **Port `5432`**: Internal PostgreSQL database (`postgres` container).
- **Port `6379`**: Internal Redis buffer (`redis` container).

You only need to expose Port `80` (or `443` with SSL) through your firewall.

---

## Authentication & Client Security

### How does token rotation work? Does it disconnect active connections?
When you click **Rotate Token** in `/vcon/clients`:
1. A new HMAC-SHA256 token and secret are generated and stored in PostgreSQL.
2. The change is instantly communicated to the Port 4000 ingestion server over the internal authenticated bridge.
3. Any active WebSocket connections using the old token are immediately disconnected with `TOKEN_ROTATED`.
4. Subsequent requests using the old token are rejected with `401 Unauthorized`.

### What does `CLIENT_REVOKED` mean?
If a client registration is marked as `Revoked` or permanently deleted by an administrator, incoming requests are rejected with HTTP status `403 Forbidden` (`CLIENT_REVOKED`). If a WebSocket connection was open, it is kicked immediately.

---

## Troubleshooting Guide

### Issue: "WebSocket ACK timeout" or Handshake Fails
1. **Check Nginx Proxy Headers**: If using an external reverse proxy (like Cloudflare, Traefik, or Caddy) in front of DataStack, ensure `Upgrade` and `Connection: Upgrade` headers are passed through for WebSocket support:
   ```nginx
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```
2. **Verify Port 4000**: In `/vcon/settings`, click **Connections -> Probe**. If the status reports offline, inspect the logs of the `ingestion` container:
   ```bash
   docker compose -f docker/docker-compose.yml logs ingestion
   ```

### Issue: "RATE_LIMIT_EXCEEDED" Errors
Each client has a configurable rate limit (default: 100 events/sec) and a global platform limit. If your client bursts above this rate, the server returns status `429`.
- **Solution**: In `/vcon/clients`, increase the client's rate limit, or in `/vcon/settings`, adjust the global maximum events per second.
- **Python SDK**: The official Python SDK automatically handles rate limits by backing off and retrying remaining events without dropping data.

### Issue: "PAYLOAD_TOO_LARGE" Errors
By default, individual events cannot exceed `100 KB` (`maxPayloadSizeKb`).
- **Solution**: In `/vcon/settings`, increase the **Max Payload Size (KB)** setting to accommodate larger JSON objects.

### How do I back up my collected telemetry data?
All partition files are located in the `datastack-data` volume (`/app/storage/data`). You can create a compressed backup at any time while the containers are running:
```bash
docker run --rm \
  --volumes-from datastack-web-1 \
  -v $(pwd):/backup \
  alpine tar czf /backup/datastack_backup_$(date +%F).tar.gz /app/storage/data
```
