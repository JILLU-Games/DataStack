# Security Policy

**DataStack** is maintained by **[Vib Tools](https://vib.tools/)** with a focus on security-conscious engineering, clear operational boundaries, and user control.

---

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `1.0.x` (Current `main`) | :white_check_mark: Supported |
| `< 1.0.0` | :x: Not Supported |

---

## Built-In Security Architecture

DataStack implements multiple layers of defense across both the Next.js Web/Admin runtime (**Port 3000**) and the Express + Socket.IO Ingestion service (**Port 4000**):

1. **Administrator Authentication & Brute-Force Protection**
   - Administrator passwords are salted and hashed using Node.js `crypto.scrypt` (`N=16384, r=8, p=1, keylen=64`) and verified using `crypto.timingSafeEqual`.
   - Failed login attempts are tracked in PostgreSQL (`admin_login_attempts`), locking sign-in for 15 minutes after 5 failed attempts within a 15-minute window.
   - Initial setup (`/vcon/setup`) requires a one-time `DATASTACK_ADMIN_SETUP_KEY` and closes permanently once the administrator account is created.
2. **Session & CSRF Protection**
   - Administrator sessions use WebCrypto HMAC-SHA256 signed `HttpOnly`, `SameSite=Lax` cookies (`datastack_admin_session`).
   - Next.js Edge Middleware (`middleware.ts`) enforces same-origin `Origin`, `Host`, and `X-Forwarded-Host` verification on state-changing requests.
3. **Client SDK Authentication & Live Revocation**
   - Every Socket.IO connection and HTTP `POST /api/events` request requires a valid signed Client JWT token (or active Admin Session Cookie).
   - Both Port 3000 and Port 4000 verify client status against PostgreSQL (`client_sdks`), immediately rejecting revoked clients (`403 CLIENT_REVOKED`) or superseded rotated tokens (`401 TOKEN_ROTATED`).
4. **Rate Limiting, Payload Guards & Idempotency**
   - Per-client sliding-window rate limits (`client.rateLimit` capped by global `maxEventsPerSec`) protect against excessive event volume.
   - Event payloads exceeding `maxPayloadSizeKb` (default `100 KB`) are rejected prior to buffering.
   - A 5-minute TTL idempotency window deduplicates repeated `clientId:eventId` submissions.

---

## Reporting a Vulnerability

Please **do not** report sensitive security vulnerabilities in public GitHub issues.

Instead, report suspected security issues privately to the Vib Tools security and support team:

- **Security & Support Email**: [support@vibtools.io](mailto:support@vibtools.io)
- **General Contact**: [hello@vibtools.io](mailto:hello@vibtools.io)
- **Website**: [https://vib.tools/](https://vib.tools/)

### What to Include in Your Report
1. A clear description of the vulnerability and the affected component (`web`, `ingestion`, `sdk-python`, or `docker`).
2. Step-by-step reproduction instructions or a minimal proof-of-concept.
3. The potential impact and any suggested remediation.

We review all legitimate reports promptly and work with reporters to verify and resolve issues before public disclosure.
