# API Reference Specification

This document provides the exhaustive specification for all public classes, methods, parameters, and return structures in the DataStack Python SDK.

---

## 1. Primary Client: `DataStack` / `DataStackClient`

Import path:
```python
from datastack import DataStack, DataStackClient
# Both identifiers point to the same underlying class.
```

### Constructor: `__init__(...)`

```python
DataStack(
    server_url: Optional[str] = None,
    token: Optional[str] = None,
    api_url: Optional[str] = None,
    config_path: Optional[str] = None,
    auto_connect: Optional[bool] = None,
    reconnection_attempts: Optional[int] = None,
    reconnection_delay: Optional[float] = None,
    client_id: Optional[str] = None,
    **kwargs: Any,
)
```

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `server_url` | `str` | `None` (loads from config or `http://localhost:4000`) | URL for Port 4000 Socket.IO ingestion service. |
| `token` | `str` | `None` (loads from config or env) | Signed HMAC-SHA256 client JWT token. |
| `api_url` | `str` | `None` (inferred from `server_url` or `http://localhost:3000`) | URL for Port 3000 REST API and automatic HTTP fallback. |
| `config_path` | `str` | `None` | Path to a specific Python configuration file. |
| `auto_connect` | `bool` | `None` (defaults to `True` if config loaded) | Whether to connect immediately during initialization. |
| `reconnection_attempts` | `int` | `None` (alias for `MAX_RETRIES`, default: `3`) | Maximum number of retry attempts for transient errors. |
| `reconnection_delay` | `float`| `None` (alias for `HEARTBEAT_INTERVAL_SEC`) | Delay in seconds between reconnection probes. |
| `client_id` | `str` | `None` | Explicit client identifier slug (must match JWT `sub`/`clientId`). |
| `**kwargs` | `Any` | — | Any configuration overrides passed to `load_config()`. |

---

### Core Public Methods

#### `connect(wait_timeout: Optional[float] = None) -> bool`
Establishes the primary WebSocket connection to Port 4000 and verifies the handshake via `ping_verify`.
- **Behavior**:
  - If WebSocket succeeds: Drains any offline spooled events and transitions the Heartbeat Monitor to `CONNECTED_IDLE` (zero-CPU IDLE mode).
  - If WebSocket fails and `enable_http_fallback` is `True`: Checks HTTP API health. If online, enters `FALLBACK_HTTP` and starts background recovery.
  - If both are unreachable and `offline_spool_enabled` is `True`: Enters `OFFLINE_SPOOL`.
- **Returns**: `True` if connected to WebSocket or HTTP fallback is operational; `False` if offline.
- **Raises**: `DataStackAuthError` if credentials are rejected (`401`/`403`).

---

#### `disconnect() -> None`
Stops the background Heartbeat Monitor thread and gracefully closes any active Socket.IO connection.

---

#### `send(data: Dict[str, Any], event_id: Optional[str] = None, timestamp: Optional[str] = None, timeout: Optional[float] = None) -> Dict[str, Any]`
Sends a single telemetry event.

- **Parameters**:
  - `data` (`Dict[str, Any]`): Arbitrary JSON-serializable dictionary containing the event payload.
  - `event_id` (`str`, optional): Unique event identifier for idempotency. Auto-generated (`evt_<timestamp>_<uuid>`) if omitted.
  - `timestamp` (`str`, optional): ISO 8601 UTC timestamp. Auto-generated (`_utc_now_iso()`) if omitted.
  - `timeout` (`float`, optional): Timeout in seconds for waiting for server acknowledgment.
- **Returns**: Dictionary with delivery details:
  ```python
  {
      "status": "ok",
      "eventId": "evt_1700000000000_a1b2c3d4",
      "transport": "WEBSOCKET"  # or "HTTP_FALLBACK" or "OFFLINE_SPOOL"
  }
  ```

---

#### `sync(...) -> Dict[str, Any]`
Backward-compatible alias for `send()`.
```python
client.sync(data={"status": "active"}, timeout=5.0)
```

---

#### `send_batch(events: Optional[List[Dict[str, Any]]] = None, timeout: Optional[float] = None, file_name: Optional[str] = None, *, records: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]`
Transmits a list of event dictionaries in a single network round-trip.

- **Parameters**:
  - `events` (`List[Dict[str, Any]]`): List of event dictionaries (accepts either raw data dicts or wrapped envelopes `{eventId, timestamp, data}`).
  - `records`: Keyword-only alias for `events`.
  - `timeout`: Network ACK timeout.
  - `file_name` (optional): Source filename if sending structured file records.
- **Built-in Auto-Recovery**:
  - **Auto-Splitting on `413 PAYLOAD_TOO_LARGE`**: Recursively halves the batch (`chunk // 2`) and sends each half.
  - **Lossless Partial Rate-Limit Retry**: If the server returns `rateLimitedEventIds`, the SDK automatically waits 1.05s for the 1-second sliding window to reset and retries only the throttled items.
- **Returns**:
  ```python
  {
      "success": True,
      "processed": 500,
      "rejected": 0,
      "duplicates": 0,
      "spooledCount": 0,
      "transport": "WEBSOCKET"
  }
  ```

---

#### `batch_sync(...) -> Dict[str, Any]`
Backward-compatible alias for `send_batch()`. Accepts either `events` or `records`.

---

#### `send_file(file_path: Union[str, Path], chunk_size: Optional[int] = None, extra_metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]`
Streams a local file directly into DataStack in deterministic chunks.

- **Supported File Types**: `.csv`, `.json`, `.jsonl`, `.ndjson`.
- **Parameters**:
  - `file_path`: Path to local data file.
  - `chunk_size`: Rows per batch chunk (defaults to `BATCH_CHUNK_SIZE`, default: 250).
  - `extra_metadata`: Optional key-value dictionary merged into every record.
- **Features**:
  - Deterministic SHA-256 event ID generation (`file_{stem}_{row}_{hash}`) preventing duplicates on re-runs.
  - UTF-8 with Byte Order Mark (`utf-8-sig`) support.
- **Returns**:
  ```python
  {
      "success": True,
      "fileName": "transactions.csv",
      "fileType": "csv",
      "chunksSent": 4,
      "processed": 1000,
      "rejected": 0,
      "duplicates": 0,
      "spooledCount": 0,
      "transport": "WEBSOCKET"
  }
  ```

---

#### `status() -> Dict[str, Any]`
Returns a diagnostic snapshot of the client instance:

```python
{
    "connectedWebSocket": True,
    "clientId": "pos_terminal_01",
    "serverUrl": "http://localhost:4000",
    "apiUrl": "http://localhost:3000",
    "configSource": "/path/to/config.datastack.py",
    "connectionState": "CONNECTED_IDLE",
    "heartbeatMode": "IDLE",  # "IDLE" or "ACTIVE_RECOVERY"
    "recoveryAttempts": 0,
    "lastError": None,
    "offlineSpoolPending": 0,
    "offlineSpoolBytes": 0
}
```

---

## 2. Configuration Class: `DataStackConfig`

Dataclass storing resolved SDK settings:

```python
from datastack import DataStackConfig

@dataclass
class DataStackConfig:
    server_url: str = "http://localhost:4000"
    api_url: str = "http://localhost:3000"
    client_token: str = ""
    client_id: str = ""
    auto_connect: bool = True
    enable_http_fallback: bool = True
    heartbeat_interval_sec: float = 5.0
    request_timeout_sec: float = 8.0
    max_retries: int = 3
    retry_backoff_base_sec: float = 0.5
    batch_chunk_size: int = 250
    offline_spool_enabled: bool = True
    offline_spool_dir: str = ".datastack_spool"
    max_spool_size_mb: int = 50
    config_source_path: Optional[str] = None
```

---

## 3. Configuration Loader: `load_config`

```python
from datastack import load_config

config: DataStackConfig = load_config(
    config_path=None,
    require_token=False,
    **overrides
)
```
Discovers `config.datastack.py`, layers environment variables (`DATASTACK_*`), and merges keyword overrides.
