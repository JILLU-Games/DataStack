# SDK Management Engine Manifest

## Purpose
Manages Client SDK registrations, JWT credentials, throughput rate limits, and activity counters (`core/sdk/sdkManager.ts`) backed by PostgreSQL (`client_sdks`).

## Key Responsibilities
- Registers new clients with unique secret keys and signed JWT tokens.
- Persists client status (`active` / `revoked`), per-client `rateLimit`, `totalEvents`, and `lastActive` timestamps in PostgreSQL `client_sdks`.
- Supports one-click credential rotation (`regenerateTokenAsync`), status toggling (`updateClientAsync`), permanent removal (`deleteClientAsync`), and bulk token re-signing (`resignAllClientTokensAsync`) when the platform JWT secret is updated.
