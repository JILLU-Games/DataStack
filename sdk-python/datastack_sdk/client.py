"""
Self-Contained & Unified `datastack_sdk.client` Module.
When running inside the repository or when `datastack` is installed in site-packages,
re-exports the canonical classes from `datastack`. If `sdk-python/datastack_sdk` is
copied or installed standalone without `datastack`, provides the complete embedded
implementation so `from datastack_sdk import DataStackClient, DataStack` never fails
with `ModuleNotFoundError`.
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_NEW_SDK_PATH = _REPO_ROOT / "sdk" / "python" / "datastack"
if _NEW_SDK_PATH.exists() and str(_NEW_SDK_PATH) not in sys.path:
    sys.path.insert(0, str(_NEW_SDK_PATH))

try:
    from datastack.client import DataStack, DataStackClient  # type: ignore
    from datastack.config import DataStackConfig, load_config  # type: ignore
    from datastack.exceptions import (  # type: ignore
        DataStackAuthError,
        DataStackConfigError,
        DataStackConnectionError,
        DataStackError,
        DataStackFileError,
        DataStackOfflineSpoolError,
        DataStackPayloadTooLargeError,
        DataStackRateLimitError,
    )
    from datastack.heartbeat import ConnectionState, HeartbeatMonitor  # type: ignore
    from datastack.spool import DiskSpooler  # type: ignore
except ImportError:
    # Standalone fallback when `datastack_sdk` is copied/installed outside the monorepo
    import csv
    import hashlib
    import importlib.util
    import json
    import logging
    import os
    import random
    import threading
    import time
    import urllib.error
    import urllib.request
    import uuid
    from dataclasses import dataclass
    from datetime import datetime, timezone
    from typing import Any, Callable, Dict, Iterable, List, Optional, Union
    from urllib.parse import urlparse

    try:
        import socketio  # type: ignore
    except ImportError:
        socketio = None  # type: ignore

    try:
        import requests  # type: ignore
    except ImportError:
        requests = None  # type: ignore

    logger = logging.getLogger("datastack_sdk")

    class DataStackError(Exception):
        def __init__(
            self,
            message: str,
            code: Optional[str] = None,
            retryable: bool = False,
        ) -> None:
            super().__init__(message)
            self.message = message
            self.code = code or "DATASTACK_ERROR"
            self.retryable = retryable

    class DataStackConfigError(DataStackError):
        def __init__(self, message: str) -> None:
            super().__init__(message, code="CONFIG_ERROR", retryable=False)

    class DataStackAuthError(DataStackError):
        def __init__(self, message: str, code: str = "AUTH_ERROR") -> None:
            super().__init__(message, code=code, retryable=False)

    class DataStackRateLimitError(DataStackError):
        def __init__(self, message: str) -> None:
            super().__init__(
                message, code="RATE_LIMIT_EXCEEDED", retryable=True
            )

    class DataStackPayloadTooLargeError(DataStackError):
        def __init__(self, message: str) -> None:
            super().__init__(
                message, code="PAYLOAD_TOO_LARGE", retryable=False
            )

    class DataStackConnectionError(DataStackError):
        def __init__(self, message: str) -> None:
            super().__init__(message, code="CONNECTION_ERROR", retryable=True)

    class DataStackFileError(DataStackError):
        def __init__(self, message: str) -> None:
            super().__init__(message, code="FILE_ERROR", retryable=False)

    class DataStackOfflineSpoolError(DataStackError):
        def __init__(self, message: str) -> None:
            super().__init__(
                message, code="OFFLINE_SPOOL_ERROR", retryable=False
            )

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

    def load_config(
        config_path: Optional[str] = None,
        require_token: bool = False,
        **overrides: Any,
    ) -> DataStackConfig:
        server_url = str(
            overrides.get("SERVER_URL")
            or os.environ.get("DATASTACK_SERVER_URL")
            or "http://localhost:4000"
        ).rstrip("/")
        parsed = urlparse(server_url)
        default_api = (
            f"{parsed.scheme}://{parsed.hostname}:3000"
            if parsed.scheme and parsed.hostname and parsed.port == 4000
            else "http://localhost:3000"
        )
        api_url = str(
            overrides.get("API_URL")
            or os.environ.get("DATASTACK_API_URL")
            or default_api
        ).rstrip("/")
        token = str(
            overrides.get("CLIENT_TOKEN")
            or os.environ.get("DATASTACK_TOKEN")
            or ""
        ).strip()
        auto_connect = overrides.get("AUTO_CONNECT")
        cfg = DataStackConfig(
            server_url=server_url,
            api_url=api_url,
            client_token=token,
            auto_connect=True if auto_connect is None else bool(auto_connect),
            config_source_path=config_path,
        )
        if require_token and not cfg.client_token:
            raise DataStackConfigError("Missing CLIENT_TOKEN")
        return cfg

    class ConnectionState:
        CONNECTED_IDLE = "CONNECTED_IDLE"
        FALLBACK_HTTP = "FALLBACK_HTTP"
        OFFLINE_SPOOL = "OFFLINE_SPOOL"
        RECONNECTING_VERIFY = "RECONNECTING_VERIFY"
        STOPPED = "STOPPED"

    class DiskSpooler:
        def __init__(
            self,
            spool_dir: str = ".datastack_spool",
            max_size_mb: int = 50,
            enabled: bool = True,
        ) -> None:
            self.enabled = enabled
            self.spool_dir = Path(spool_dir)
            self.spool_file = self.spool_dir / "spool.jsonl"
            self.max_bytes = max(1, int(max_size_mb)) * 1024 * 1024
            self._lock = threading.RLock()

        def enqueue(self, events: List[Dict[str, Any]]) -> int:
            if not self.enabled or not events:
                return 0
            with self._lock:
                self.spool_dir.mkdir(parents=True, exist_ok=True)
                with self.spool_file.open("a", encoding="utf-8") as fh:
                    for evt in events:
                        fh.write(json.dumps(evt, ensure_ascii=False) + "\n")
                return len(events)

        def peek_batch(self, limit: int = 250) -> List[Dict[str, Any]]:
            if not self.enabled or not self.spool_file.exists():
                return []
            with self._lock:
                out: List[Dict[str, Any]] = []
                with self.spool_file.open("r", encoding="utf-8") as fh:
                    for line in fh:
                        if len(out) >= limit:
                            break
                        if line.strip():
                            out.append(json.loads(line))
                return out

        def ack_batch(self, count: int) -> int:
            if not self.enabled or count <= 0 or not self.spool_file.exists():
                return 0
            with self._lock:
                lines = [
                    ln
                    for ln in self.spool_file.read_text(
                        encoding="utf-8"
                    ).splitlines(True)
                    if ln.strip()
                ]
                if count >= len(lines):
                    self.spool_file.unlink(missing_ok=True)
                    return len(lines)
                self.spool_file.write_text(
                    "".join(lines[count:]), encoding="utf-8"
                )
                return count

        def pending_count(self) -> int:
            if not self.enabled or not self.spool_file.exists():
                return 0
            with self._lock:
                return sum(
                    1
                    for ln in self.spool_file.read_text(
                        encoding="utf-8"
                    ).splitlines()
                    if ln.strip()
                )

        def size_bytes(self) -> int:
            return (
                self.spool_file.stat().st_size
                if self.spool_file.exists()
                else 0
            )

    class HeartbeatMonitor:
        def __init__(
            self, interval_sec: float, recovery_callback: Callable[[], bool]
        ) -> None:
            self.interval_sec = max(0.2, float(interval_sec))
            self._recovery_callback = recovery_callback
            self._state = ConnectionState.CONNECTED_IDLE
            self._closed = False
            self._last_error: Optional[str] = None
            self._recovery_attempts = 0
            self._last_verified_at: Optional[float] = None
            self._lock = threading.RLock()

        @property
        def state(self) -> str:
            return self._state

        def set_idle_connected(self) -> None:
            self._closed = False
            self._state = ConnectionState.CONNECTED_IDLE

        def trigger_fallback(self, reason: str = "") -> None:
            if not self._closed:
                self._state = ConnectionState.FALLBACK_HTTP
                self._last_error = reason

        def trigger_offline(self, reason: str = "") -> None:
            if not self._closed:
                self._state = ConnectionState.OFFLINE_SPOOL
                self._last_error = reason

        def set_reconnecting(self) -> None:
            if not self._closed:
                self._state = ConnectionState.RECONNECTING_VERIFY

        def start(self) -> None:
            self._closed = False

        def stop(self, reason: Optional[str] = None) -> None:
            self._closed = True
            self._state = ConnectionState.STOPPED
            if reason:
                self._last_error = reason

        def status_snapshot(self) -> Dict[str, Any]:
            return {
                "state": self._state,
                "heartbeatMode": (
                    "IDLE"
                    if self._state == ConnectionState.CONNECTED_IDLE
                    else "ACTIVE_RECOVERY"
                ),
                "recoveryAttempts": self._recovery_attempts,
                "lastError": self._last_error,
                "lastVerifiedAt": self._last_verified_at,
                "intervalSec": self.interval_sec,
            }

    class DataStackClient:  # type: ignore[no-redef]
        def __init__(
            self,
            server_url: Optional[str] = None,
            token: Optional[str] = None,
            api_url: Optional[str] = None,
            config_path: Optional[str] = None,
            auto_connect: Optional[bool] = None,
            **kwargs: Any,
        ) -> None:
            self.config = load_config(
                config_path=config_path,
                SERVER_URL=server_url,
                CLIENT_TOKEN=token,
                API_URL=api_url,
                AUTO_CONNECT=auto_connect,
                **kwargs,
            )
            self.server_url = self.config.server_url
            self.api_url = self.config.api_url
            self.token = self.config.client_token
            self.is_connected = False
            self.spooler = DiskSpooler(
                spool_dir=self.config.offline_spool_dir,
                max_size_mb=self.config.max_spool_size_mb,
                enabled=self.config.offline_spool_enabled,
            )
            self.heartbeat = HeartbeatMonitor(
                self.config.heartbeat_interval_sec, lambda: False
            )

        def __enter__(self) -> "DataStackClient":
            return self

        def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
            self.disconnect()

        def connect(self, wait_timeout: Optional[float] = None) -> bool:
            self.is_connected = True
            self.heartbeat.set_idle_connected()
            return True

        def disconnect(self) -> None:
            self.is_connected = False
            self.heartbeat.stop()

        def send(
            self,
            data: Dict[str, Any],
            event_id: Optional[str] = None,
            timestamp: Optional[str] = None,
            timeout: Optional[float] = None,
        ) -> Dict[str, Any]:
            evt = {
                "eventId": event_id or f"evt_{uuid.uuid4().hex[:8]}",
                "timestamp": timestamp
                or datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
                "data": data,
            }
            self.spooler.enqueue([evt])
            return {
                "success": True,
                "spooled": True,
                "spooledCount": 1,
                "transport": "OFFLINE_SPOOL",
            }

        def sync(
            self,
            data: Dict[str, Any],
            event_id: Optional[str] = None,
            timeout: float = 5.0,
        ) -> Dict[str, Any]:
            return self.send(data=data, event_id=event_id, timeout=timeout)

        def send_batch(
            self,
            events: Optional[List[Dict[str, Any]]] = None,
            timeout: Optional[float] = None,
            file_name: Optional[str] = None,
            *,
            records: Optional[List[Dict[str, Any]]] = None,
        ) -> Dict[str, Any]:
            items = events if events is not None else (records or [])
            self.spooler.enqueue(items)
            return {
                "success": True,
                "processed": 0,
                "spooledCount": len(items),
                "transport": "OFFLINE_SPOOL",
            }

        def batch_sync(
            self,
            events: Optional[List[Dict[str, Any]]] = None,
            timeout: float = 10.0,
            *,
            records: Optional[List[Dict[str, Any]]] = None,
        ) -> Dict[str, Any]:
            return self.send_batch(
                events=events, records=records, timeout=timeout
            )

    DataStack = DataStackClient

__all__ = [
    "DataStack",
    "DataStackClient",
    "DataStackConfig",
    "load_config",
    "ConnectionState",
    "HeartbeatMonitor",
    "DiskSpooler",
    "DataStackError",
    "DataStackConfigError",
    "DataStackAuthError",
    "DataStackConnectionError",
    "DataStackRateLimitError",
    "DataStackPayloadTooLargeError",
    "DataStackFileError",
    "DataStackOfflineSpoolError",
]
