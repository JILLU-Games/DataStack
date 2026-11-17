# Security Engine Manifest

## Purpose
Enforces per-client sliding-window rate limits, payload size bounds, and event idempotency deduplication (`core/Security/security.ts`).

## Key Responsibilities
- **Idempotency Deduplication**: Rejects duplicate `clientId:eventId` pairs within a 5-minute TTL window.
- **Sliding-Window Rate Limiter**: Enforces the lower of the client's configured `rateLimit` and the global `maxEventsPerSec` limit.
- **Payload Size Guard**: Rejects individual event payloads exceeding `maxPayloadSizeBytes` (default `100 KB`).
