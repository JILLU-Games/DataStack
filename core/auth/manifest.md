# Authentication Engine Manifest

## Purpose
Provides authentication and session security for both Administrator Console users and Client SDK connections (`core/auth/*`).

## Modules
- `jwt.ts`: Signs and verifies Client SDK JWT tokens (`clientId`, `name`, `rateLimit`) using `DATASTACK_JWT_SECRET` or the active `admin_settings.jwt_secret`.
- `adminSession.ts`: WebCrypto HMAC-SHA256 administrator session token signer/verifier (`datastack_admin_session` HTTP-only cookie) compatible with both Next.js Edge Middleware and Node.js route handlers.
- `adminUsers.ts`: PostgreSQL-backed administrator account store (`admin_users`) using `crypto.scrypt` password hashing, timing-safe verification, and brute-force login lockout tracking (`admin_login_attempts`).
