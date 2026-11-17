"""
config.datastack.py — Official DataStack Python SDK Configuration File
======================================================================
Place a copy of this file named `config.datastack.py` in the root directory
of your Python application. When you initialize `DataStack()`, the SDK will
automatically discover and load these settings.
"""

DATASTACK_CONFIG = {
    # Port 4000 Dedicated Socket.IO Ingestion Service URL
    "SERVER_URL": "http://localhost:4000",

    # Port 3000 Next.js Web & HTTP Fallback Ingestion API URL
    "API_URL": "http://localhost:3000",

    # Client JWT Token generated from the DataStack Admin Console (/vcon/clients)
    "CLIENT_TOKEN": "REPLACE_WITH_YOUR_CLIENT_JWT_TOKEN",

    # Optional explicit client identifier override (defaults to JWT sub/clientId)
    "CLIENT_ID": "",

    # Automatically connect on DataStack() instantiation
    "AUTO_CONNECT": True,

    # Automatically switch to HTTP POST /api/events when WebSocket disconnects
    "ENABLE_HTTP_FALLBACK": True,

    # Heartbeat interval (in seconds) when probing to repair WebSocket or recover from offline state
    "HEARTBEAT_INTERVAL_SEC": 5.0,

    # Socket & HTTP request timeout in seconds
    "REQUEST_TIMEOUT_SEC": 8.0,

    # Maximum retry attempts on transient network errors or 429 RATE_LIMIT_EXCEEDED
    "MAX_RETRIES": 3,

    # Base delay (in seconds) for exponential backoff with jitter
    "RETRY_BACKOFF_BASE_SEC": 0.5,

    # Default records per batch when streaming .csv / .json / .jsonl files via send_file()
    "BATCH_CHUNK_SIZE": 250,

    # Offline Disk Spooling: safely persist events to disk when device is completely offline
    "OFFLINE_SPOOL_ENABLED": True,

    # Local directory path for offline event spooling
    "OFFLINE_SPOOL_DIR": ".datastack_spool",

    # Maximum disk spool file size in megabytes (MB)
    "MAX_SPOOL_SIZE_MB": 50,
}
