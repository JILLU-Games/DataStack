# Admin Console (`/vcon/*`) Manifest

## Purpose
The `/vcon/*` routes provide the administration interface for managing DataStack clients, inspecting event streams, configuring runtime parameters, and exporting stored CSV datasets.

## Routes
- `dashboard/page.tsx`: Live ingestion metrics, active Socket.IO connection count, buffer utilization, and recent events table.
- `clients/page.tsx`: Client SDK registration, JWT credential issuance, key rotation, status revocation, and permanent client deletion.
- `data/page.tsx`: Paginated CSV event browser with client filtering, keyword search, and JSON payload inspection.
- `export/page.tsx`: Dataset export builder with date-range presets (`Today`, `7d`, `30d`, `All`) and streaming CSV/JSON downloads.
- `storage/page.tsx`: On-disk CSV partition inspector (`/storage/data/{clientId}/{YYYY-MM-DD}.csv`) with manual buffer flush controls.
- `settings/page.tsx`: Runtime configuration for rate limits, payload size bounds, buffer thresholds, file rotation size, retention pruning (`autoPruneDays`), and JWT secret.
- `mcp/page.tsx`: Owner-only Streamable HTTP MCP server (`/mcp`) settings, Bearer token provisioning/rotation/revocation, 17-tool permission controls, AI client setup snippets, and Coolify build log configuration.
- `sdk/page.tsx`: Python SDK integration guide that populates ready-to-run code snippets with any registered client's signed JWT token.
- `simulator/page.tsx`: Browser-based event generator for testing single and batch event ingestion pipelines.
- `profile/page.tsx`: Administrator email and password management with current-password verification.
- `login/page.tsx`: Administrator sign-in screen with brute-force lockout protection and optional 30-day session persistence.
- `setup/page.tsx`: First-run administrator initialization screen protected by `DATASTACK_ADMIN_SETUP_KEY`.
