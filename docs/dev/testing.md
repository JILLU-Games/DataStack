# Automated Testing Guide

This guide details the automated test suites, execution commands, coverage domains, and verification standards for DataStack.

---

## 1. Test Architecture

DataStack utilizes a lightweight, native test architecture built upon the Node.js native test runner (`node:test`) and Python's `unittest` framework:

- **Zero Heavy Test Framework Bloat**: Tests run using `npx tsx --test`, executing directly against TypeScript source modules without requiring Jest or Mocha.
- **Fast Execution**: The complete TypeScript suite executes in under 2 seconds.
- **Isolation**: Each test suite initializes mock stores or clean temporary directories, guaranteeing zero side effects on production data.

---

## 2. Running TypeScript Test Suites

To run all TypeScript test suites in sequence:

```bash
npx --yes tsx --test tests/phase01-auth.test.ts \
                     tests/phase02-sync.test.ts \
                     tests/phase03-storage-buffer.test.ts \
                     tests/phase06-pwa-landing.test.ts \
                     tests/phase07-deployment.test.ts
```

### Test Suite Coverage Breakdown

#### 1. `tests/phase01-auth.test.ts` (Security & Authentication)
- **Production Secret Fail-Closed**: Verifies that empty, short (<32 chars), or placeholder secrets halt execution.
- **Session Cookie Invalidation**: Asserts that incrementing `tokenVersion` immediately causes session rejection.
- **Brute-Force Rate Limiting**: Validates that 5 failed login attempts lock out the composite IP + Email key for 15 minutes.
- **Client Token Redaction**: Ensures client secrets and raw tokens are omitted from public audit responses.
- **CSRF Origin Verification**: Tests that mismatched Origin/Referer headers return `403 Forbidden`.

#### 2. `tests/phase02-sync.test.ts` (Dual-Runtime Synchronization)
- **Internal Secret Security**: Tests timing-safe header validation on `/internal/*` routes.
- **Settings Synchronization**: Validates that updating settings in Port 3000 propagates instantly to Port 4000.
- **Client Revocation**: Confirms that revoking a client immediately severs active WebSocket connections.
- **JWT Secret Rotation**: Asserts that all client tokens are re-signed and old tokens are rejected.

#### 3. `tests/phase03-storage-buffer.test.ts` (Storage & Durability)
- **Redis Queue Durability**: Tests RAM queue fallback and Redis list buffering.
- **Batch Threshold & Interval**: Verifies that threshold count (500) and interval time (2000ms) trigger flushes.
- **Cooperative Locking**: Proves that `.lock` files prevent concurrent write collisions and that stale locks (>30s) are safely reclaimed.
- **Streaming Export**: Verifies non-blocking streaming CSV and JSON exports with client and date filtering.

#### 4. `tests/phase06-pwa-landing.test.ts` (PWA & Client Shell)
- **Web App Manifest**: Validates manifest schema, icons, and display modes.
- **Service Worker Lifecycle**: Tests cache strategies and offline shell handling.

#### 5. `tests/phase07-deployment.test.ts` (Containerization & Deployment Health)
- **Docker Compose Configuration**: Audits volume mounts (`datastack-data`, `pgdata`, `redisdata`).
- **Nginx Reverse Proxy**: Verifies routing rules for `/`, `/socket.io/`, and `/health`.
- **Unhydrated DB Auto-Pruning Guard**: Confirms that partition pruning is deferred until database settings are fully hydrated.

---

## 3. Running Python SDK Test Suites

The Python SDK includes a dedicated integration test suite verifying WebSocket streaming, heartbeat pings, HTTP fallbacks, and offline disk spooling:

```bash
python3 -m unittest tests/phase05_sdk_test.py
```

### Verified Behaviors:
- WebSocket connection and JWT handshake authentication.
- Offline spooling to local disk directory (`.datastack_spool/`) during network disruption.
- Automatic drain and delivery of spooled events when connectivity is restored.
- Streaming large `.csv` and `.json` files in chunks.

---

## 4. Continuous Integration Checklist

Before opening a pull request:
1. `npm run lint` must exit with `0` errors and `0` warnings.
2. `npm run build` must compile the Next.js standalone bundle successfully.
3. All 5 TypeScript test suites must pass (`23/23 tests passing`).
4. Python SDK test suite must pass (`3/3 tests passing`).
