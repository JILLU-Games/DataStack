# Configuration Guide

The DataStack Python SDK features a zero-boilerplate auto-discovery configuration system supporting Python configuration files (`config.datastack.py`), environment variables (`DATASTACK_*`), and explicit runtime overrides.

---

## 1. Configuration Auto-Discovery

When instantiating `DataStack()` without arguments, the SDK locates `config.datastack.py` using this search order:

1. **Explicit Path**: If `config_path="path/to/config.py"` is passed to the constructor.
2. **Environment Variable**: `DATASTACK_CONFIG_PATH`.
3. **Current Working Directory**: The directory from which the application is run, searching upwards through up to 3 parent directories.
4. **Entry Script Directory**: The directory containing `sys.argv[0]`, searching upwards through up to 2 parent directories.

---

## 2. Configuration Precedence

Settings are resolved using strict layered precedence:

```text
Explicit Keyword Arguments > Environment Variables > config.datastack.py > Built-in Defaults
```

If a setting is defined in multiple places, the higher precedence layer wins.

---

## 3. Configuration Reference Table

| Key in `config.datastack.py` | Environment Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `SERVER_URL` | `DATASTACK_SERVER_URL` | `str` | `http://localhost:4000` | Port 4000 Socket.IO ingestion service URL. |
| `API_URL` | `DATASTACK_API_URL` | `str` | `http://localhost:3000` | Port 3000 REST API and automatic HTTP fallback URL. |
| `CLIENT_TOKEN` | `DATASTACK_CLIENT_TOKEN` | `str` | `""` | Signed HMAC-SHA256 client JWT token provisioned in `/vcon/clients`. |
| `CLIENT_ID` | `DATASTACK_CLIENT_ID` | `str` | `""` | Unique client identifier slug. If omitted, automatically extracted from JWT `clientId` or `sub` claim. |
| `AUTO_CONNECT` | `DATASTACK_AUTO_CONNECT` | `bool` | `True` | Automatically connect and verify WebSocket handshake during initialization. |
| `ENABLE_HTTP_FALLBACK` | `DATASTACK_ENABLE_HTTP_FALLBACK` | `bool` | `True` | Seamlessly route events via HTTP `POST /api/events` when WebSocket is disconnected. |
| `HEARTBEAT_INTERVAL_SEC` | `DATASTACK_HEARTBEAT_INTERVAL_SEC` | `float` | `5.0` | Probing frequency in seconds when recovering disconnected connections. |
| `REQUEST_TIMEOUT_SEC` | `DATASTACK_REQUEST_TIMEOUT_SEC` | `float` | `8.0` | Per-request timeout in seconds for server responses and handshakes. |
| `MAX_RETRIES` | `DATASTACK_MAX_RETRIES` | `int` | `3` | Maximum number of exponential backoff retry attempts for rate-limited or transient errors. |
| `RETRY_BACKOFF_BASE_SEC` | `DATASTACK_RETRY_BACKOFF_BASE_SEC` | `float` | `0.5` | Initial backoff delay in seconds for retry attempts (scaled exponentially with jitter). |
| `BATCH_CHUNK_SIZE` | `DATASTACK_BATCH_CHUNK_SIZE` | `int` | `250` | Default number of records per batch when streaming files via `send_file()`. |
| `OFFLINE_SPOOL_ENABLED` | `DATASTACK_OFFLINE_SPOOL_ENABLED` | `bool` | `True` | Enable saving events to local disk when the device loses network connectivity entirely. |
| `OFFLINE_SPOOL_DIR` | `DATASTACK_OFFLINE_SPOOL_DIR` | `str` | `.datastack_spool` | Local filesystem directory path where `spool.jsonl` is written. |
| `MAX_SPOOL_SIZE_MB` | `DATASTACK_MAX_SPOOL_SIZE_MB` | `int` | `50` | Maximum disk size in megabytes allocated for offline event buffering before rejecting new writes. |

---

## 4. Configuration Formats

### Standard Dictionary Format (`DATASTACK_CONFIG`)
```python
# config.datastack.py
DATASTACK_CONFIG = {
    "SERVER_URL": "https://ingestion.datastack.example",
    "API_URL": "https://api.datastack.example",
    "CLIENT_TOKEN": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "BATCH_CHUNK_SIZE": 500,
    "MAX_SPOOL_SIZE_MB": 100,
}
```

### Module-Level Variables Format
```python
# config.datastack.py
SERVER_URL = "https://ingestion.datastack.example"
API_URL = "https://api.datastack.example"
CLIENT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## 5. Client ID Validation Rule

To prevent misattribution:
- If `CLIENT_ID` is explicitly specified in your configuration or constructor, it **must match** the `clientId` or `sub` claim inside your signed `CLIENT_TOKEN`.
- If there is a mismatch, the SDK raises `DataStackConfigError` immediately on initialization.
- If `CLIENT_ID` is omitted, the SDK automatically extracts the subject claim from the token.
