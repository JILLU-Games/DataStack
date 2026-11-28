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

## FINAL-ACCEPTANCE-02 — One-shot closeout candidate on new Gitea (2026-11-28 UTC)

**Canonical source:** private `https://dev.vib.tools/vibtools/DataStack`, main `4959b69bb25b46a16509bfc4755d13bad87347a9`, tree `37bffae18e2abb6d66a1ae7e1cc6599b48593ee1`. One `final-acceptance-02-closeout` candidate and draft PR #1, unmerged. This supersedes the historical "FINAL-ACCEPTANCE-02 NOT STARTED" statement above; previous FINAL-FIX-01 evidence remains historically valid. **No user features or production state changed.**

**Previous failure RCA and test-only corrections:** CI #9 Node regression had 429/ADMIN_LOGIN_LOCKOUT webhook nondelivery assertion dependent on arbitrary 60ms sleep while the real dispatcher includes async SSRF/DNS validation. Replaced with event-driven awaited mock dispatch and bounded 5s timeout, no login/SSRF/runtime changes; focused Linux Gitea CI **#14 SUCCESS, 6/6 PASS**. CI #11 Windows Python 13/14 used invalid generated Python source for a Windows spool path. Fixed only the `tests/phase05_sdk_test.py` fixture with `repr()` serialization, preserving the SDK parser and config precedence; focused Windows CI **#12 SUCCESS, 14/14 PASS**. Earlier diagnostic CI #13 all SKIPPED due a workflow condition, not PASS; corrected narrowly.

**Security candidate, NOT release acceptance:** Old `dev.ivib.cc` PR #13 exact object `dab4dc93088a769b906c87f43fd1393eb743c209` unavailable on authorized PC and old Git endpoint timed out; no recovery claim. Four approved patch files reconstructed from immutable published older-major packages and official upstream fixes: (1) `got@10.7.0` UNIX-socket redirect guard, upstream `861ccd9ac2237df762a9e2beed7edd88c60782dc`; (2) `glob@10.5.0` abort early-return (v13.0.7 already has this guard), official glob v14.0.2 delta; (3) nested `minimatch@9.0.9/10.2.6` bounded first-phase expansion/dedupe, upstream `77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8`; (4) nested `file-type@16.5.4` ASF tokenizer forward-progress guard, upstream `319abf871b50ba2fa221b4a7050059f1ae096f4f`. Package.json postinstall executes verified, fail-closed, idempotent Git apply; approved Docker dependency stages include Git and patches. `package-lock.json` has not changed. No downgrade, override, arbitrary fork or disabled feature.

Focused Linux source/compatibility CI **#15 SUCCESS** on source SHA `9a3796ceb5ec8cfe9062ce155c7379ecd7c2ed34`: clean npm ci applied all four patches; Node SDK build PASS; webhook 6/6; File Manager/Cloudcmd + four security negative cases **8/8 PASS**. **Native Windows candidate CI #16** dispatched on subsequent workflow-only SHA `d08ffae878dcec65a8e103e3fa476018f778c532`; outcome must be read separately. Version-based npm vulnerability inventory historically runtime 20 Moderate/full 22 Moderate (0 High/Critical); a source backport does **not** make npm audit zero, nor establish a user-approved advisory-specific residual-risk disposition. Mandatory full CI and broader compatibility security review remain pending.

**Hard Docker STOP:** New CI #9 docker job failed closed with `DATASTACK_DOCKER_HOST_NOT_ISOLATED` on shared Actions daemon before Docker image builds. Historical old Gitea #132 also stopped because production-like containers were present. No verified dedicated *non-production* isolated Docker daemon, five-service startup, fixture PostgreSQL/Redis/CSV recovery/restore, or rollback acceptance exists. **Never bypass the guard, test on production workloads, prune or change shared host configuration.** No final consolidated CI/merge/sync/production deployment authorized while mandatory gates fail.

**Current disposition:** one draft PR; Gitea `main` + GitHub/GitLab/clean local backups remain on frozen canonical main with 420/420 parity. Candidate not merged or propagated to backups. **RELEASE CANDIDATE BLOCKED; PRODUCTION NO-GO.** Remaining security residual-risk disposition, safe Docker runner, mandatory disposable acceptance and one final consolidated terminal CI must precede any merge; actual Production GO requires separate live operational authorization.
