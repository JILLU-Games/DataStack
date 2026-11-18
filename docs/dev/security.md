# Security Architecture & Cryptographic Design

This document details the security principles, cryptographic implementations, authentication mechanisms, and attack mitigations enforced across DataStack.

---

## 1. Security Architecture Overview

DataStack follows a defense-in-depth model with strict boundary separation:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Internet / External Clients                     │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │ HTTPS Ingestion (JWT)           │ HTTPS Web Console
                   ▼                                 ▼
         ┌───────────────────┐             ┌───────────────────┐
         │  Port 4000 (Ing)  │             │  Port 3000 (Web)  │
         │  Socket.IO Hand   │             │  Next.js Edge MW  │
         │  JWT Verify       │             │  HMAC Session Ver │
         │  Rate Limiting    │             │  CSRF Origin Ver  │
         └─────────┬─────────┘             └─────────┬─────────┘
                   │                                 │
                   └──────── Authenticated ──────────┘
                         /internal/* Bridge
                     (DATASTACK_INTERNAL_SECRET)
```

---

## 2. Administrator Authentication & Sessions

### Password Storage (`crypto.scrypt`)
Administrator passwords are never stored in plaintext or reversible formats:
- **Salt Generation**: 16 cryptographically secure random bytes generated via `crypto.randomBytes(16)`.
- **Key Derivation Function**: Node.js native `crypto.scryptSync(password, salt, 64)`.
- **Constant-Time Verification**: Hashes are compared using `crypto.timingSafeEqual` to prevent timing side-channel attacks.

### Session Cookies (`datastack_admin_session`)
- **Signing Mechanism**: Signed with WebCrypto HMAC-SHA256 using `DATASTACK_ADMIN_SESSION_SECRET`.
- **Session Payload**:
  ```json
  {
    "userId": 1,
    "email": "admin@example.com",
    "tokenVersion": 1,
    "exp": 1700086400000
  }
  ```
- **Instant Global Invalidation**: Every administrative request validates `tokenVersion` against PostgreSQL. When an operator updates their password or selects **Log Out Other Sessions**, `tokenVersion` increments, instantly invalidating all issued cookies across all devices.
- **Cookie Security Flags**: `HttpOnly; SameSite=Lax; Path=/; Priority=High;` (with `Secure` enforced when `NODE_ENV=production`).

### Brute-Force IP Lockout
To prevent credential stuffing:
- Tracks failed login attempts per composite SHA-256 hash of `normalized_ip + ":" + normalized_email`.
- **Threshold**: 5 consecutive failed attempts locks the composite key for 15 minutes.
- Attempts are recorded in PostgreSQL (`admin_login_attempts`) and survive container restarts.

---

## 3. Client SDK Authentication & Access Control

### HMAC-SHA256 Client JWTs
- Each registered client receives a JWT signed by `DATASTACK_JWT_SECRET`.
- The token payload embeds `{ clientId, name, rateLimit, iat }`.
- Verified on both HTTP REST ingestion (`Authorization: Bearer <TOKEN>`) and Socket.IO handshakes (`auth.token`).

### Instant Credential Revocation & Tombstones
- **Rotation**: Rotating a client token generates a new secret and pushes the update to Port 4000 via `/internal/client-sync`. Active WebSocket sockets using the old token are severed immediately.
- **Revocation**: Setting status to `revoked` immediately halts ingestion with `CLIENT_REVOKED (403)`.
- **Tombstones (`deleted_clients`)**: Deleting a client registers its identifier in `deleted_clients`. Stale, leaked, or intercepted tokens can never be reused to write telemetry.

---

## 4. Cross-Site Request Forgery (CSRF) Mitigation

State-changing HTTP methods (`POST`, `PUT`, `DELETE`, `PATCH`) handled by Next.js App Router are protected in `middleware.ts`:
- Validates the request's `Origin` or `Referer` header against the incoming `Host` or `X-Forwarded-Host`.
- Cross-origin requests attempting to trigger administrative endpoints or manual flushes are rejected with `403 Forbidden` (`CSRF_FAILED`).

---

## 5. Internal Service Bridge Security

Communication between Port 3000 (Web) and Port 4000 (Ingestion Server) is isolated behind a shared secret:
- Header: `x-datastack-internal-secret: <DATASTACK_INTERNAL_SECRET>`.
- The ingestion server verifies incoming headers using `crypto.timingSafeEqual`.
- Unauthorized internal requests are rejected immediately with `403 Forbidden`.

---

## 6. Secret Fail-Closed Enforcement

When running in production (`NODE_ENV=production`):
- All secret keys (`DATASTACK_ADMIN_SESSION_SECRET`, `DATASTACK_JWT_SECRET`, `DATASTACK_ADMIN_SETUP_KEY`, `DATASTACK_INTERNAL_SECRET`) must be explicitly defined and have a minimum length of 32 characters.
- If any secret contains default placeholder strings (e.g., `replace-with-`, `your-secret`), the server halts during bootstrap with a fatal configuration error, preventing accidental deployment with insecure credentials.
