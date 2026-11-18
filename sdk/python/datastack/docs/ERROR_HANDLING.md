# Error Handling & Exception Reference

The DataStack Python SDK implements a structured exception hierarchy distinguishing between fatal configuration/auth errors and transient, auto-recoverable issues.

---

## 1. Exception Hierarchy

All exceptions inherit from `DataStackError`:

```text
DataStackError (Base)
├── DataStackConfigError        (Configuration missing, malformed, or CLIENT_ID mismatch)
├── DataStackAuthError          (Token rejected, client revoked, or rotated)
├── DataStackConnectionError    (Network unreachable, endpoints down, offline)
├── DataStackRateLimitError     (Rate limit exceeded after all retry attempts)
├── DataStackPayloadTooLargeError (Payload exceeds maximum permitted size)
├── DataStackFileError          (File missing, unsupported extension, or corrupted)
└── DataStackOfflineSpoolError  (Disk spool directory unwriteable or disk quota full)
```

---

## 2. Exceptions Specification

### `DataStackConfigError`
- **Raised When**:
  - `CLIENT_TOKEN` is missing or contains placeholder strings.
  - An explicit `CLIENT_ID` does not match the subject claim inside `CLIENT_TOKEN`.
  - `config.datastack.py` contains invalid Python syntax.
- **Retryable**: **No**. Requires modifying configuration files or environment variables.

---

### `DataStackAuthError`
- **Raised When**:
  - The server returns HTTP `401 Unauthorized` or `403 Forbidden`.
  - The WebSocket handshake is rejected with `AUTH_REQUIRED`, `AUTH_INVALID`, `CLIENT_REVOKED`, or `TOKEN_ROTATED`.
- **Special Behavior**: Immediately stops the background Heartbeat Monitor thread to prevent hammering the server with invalid credentials.
- **Retryable**: **No**. The operator must update the client token or re-activate the client in `/vcon/clients`.

---

### `DataStackRateLimitError`
- **Raised When**:
  - The client exceeds its allocated events-per-second quota (`429 RATE_LIMIT_EXCEEDED`).
- **Retryable**: **Yes**. The SDK automatically executes exponential backoff retries with jitter and a minimum 1.05-second pause to allow the 1-second server sliding window to reset. This exception is only raised if all configured retries (`MAX_RETRIES`) are exhausted.

---

### `DataStackPayloadTooLargeError`
- **Raised When**:
  - A single event payload exceeds `maxPayloadSizeKb` (HTTP `413 PAYLOAD_TOO_LARGE`).
- **Special Handling in Batches**: When calling `send_batch()`, the SDK catches this error and automatically divides the batch in half (`chunk // 2`) recursively, retrying each sub-chunk transparently.

---

### `DataStackConnectionError`
- **Raised When**:
  - Both the primary WebSocket (`Port 4000`) and the HTTP fallback API (`Port 3000`) are unreachable, **AND** offline disk spooling is disabled (`OFFLINE_SPOOL_ENABLED=False`).
- **Retryable**: **Yes**.

---

### `DataStackFileError`
- **Raised When**:
  - A file path passed to `send_file()` does not exist or is a directory.
  - The file extension is unsupported (only `.csv`, `.json`, `.jsonl`, `.ndjson` allowed).
  - A JSONL file contains corrupted or unparseable JSON on a specific line number.

---

### `DataStackOfflineSpoolError`
- **Raised When**:
  - The `.datastack_spool/` directory cannot be created due to permission errors.
  - The spool file size exceeds `MAX_SPOOL_SIZE_MB` (default: 50 MB).

---

## 3. Recommended Error Handling Pattern

```python
from datastack import (
    DataStack,
    DataStackAuthError,
    DataStackConfigError,
    DataStackConnectionError,
    DataStackRateLimitError,
    DataStackError,
)

try:
    client = DataStack()
    client.send({"temperature": 23.4})
except DataStackConfigError as exc:
    print(f"Configuration defect: {exc}")
except DataStackAuthError as exc:
    # Token expired, revoked, or rotated
    print(f"Authentication failure: {exc.code} - {exc.message}")
    # Alert operations team to rotate or update CLIENT_TOKEN
except DataStackRateLimitError as exc:
    print(f"Rate limit exceeded after retries: {exc}")
except DataStackConnectionError as exc:
    print(f"Network unreachable and spooling disabled: {exc}")
except DataStackError as exc:
    print(f"Unexpected DataStack error: {exc}")
```
