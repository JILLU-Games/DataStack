"""
Official DataStack Python SDK Client (`DataStack` / `DataStackClient`).

Features:
- Automatic discovery of `config.datastack.py` in the client app's source/working directory.
- Primary real-time Socket.IO telemetry streaming (`sync_data`, `batch_sync`, `ping_verify`).
- Automatic Heartbeat HTTP Fallback (`POST /api/events`) when WebSocket closes or disconnects.
- Automatic WebSocket reconnection, handshake verification (`ping_verify`), and return to IDLE mode.
- Offline Disk Spooling (`.datastack_spool/spool.jsonl`) when the client device loses internet,
  with automatic paced replay when connectivity returns.
- Direct `.csv`, `.json`, and `.jsonl` file ingestion (`send_file()`) with deterministic SHA-256
  `eventId` deduplication, automatic batch chunking (`413 PAYLOAD_TOO_LARGE` auto-splitting),
  and lossless partial-batch rate-limit retry (`429 RATE_LIMIT_EXCEEDED`).
"""

import base64
import csv
import hashlib
import json
import logging
import random
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Union

try:
    import socketio  # type: ignore
except ImportError:
    socketio = None  # type: ignore

try:
    import requests  # type: ignore
except ImportError:
    requests = None  # type: ignore

from .config import DataStackConfig, load_config
from .exceptions import (
    DataStackAuthError,
    DataStackConfigError,
    DataStackConnectionError,
    DataStackError,
    DataStackFileError,
    DataStackOfflineSpoolError,
    DataStackPayloadTooLargeError,
    DataStackRateLimitError,
)
from .heartbeat import ConnectionState, HeartbeatMonitor
from .spool import DiskSpooler

logger = logging.getLogger("datastack.client")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _make_event_id() -> str:
    return f"evt_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"


def _make_deterministic_file_event_id(
    file_stem: str, row_index: int, record: Any
) -> str:
    raw = f"{file_stem}:{row_index}:{json.dumps(record, sort_keys=True, default=str, ensure_ascii=False)}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    safe_stem = "".join(
        ch if ch.isalnum() or ch in ("_", "-") else "_" for ch in file_stem
    )[:32]
    return f"file_{safe_stem}_{row_index}_{digest}"


def _decode_jwt_client_id(token: str) -> str:
    """Safely extracts `clientId` or `sub` claim from an unverified JWT payload string."""
    try:
        parts = (token or "").split(".")
        if len(parts) != 3:
            return ""
        payload_b64 = parts[1]
        padding = "=" * (-len(payload_b64) % 4)
        raw = base64.urlsafe_b64decode(payload_b64 + padding).decode("utf-8")
        claims = json.loads(raw)
        if isinstance(claims, dict):
            return str(claims.get("clientId") or claims.get("sub") or "").strip()
    except Exception:
        pass
    return ""


class DataStackClient:
    """
    Production-grade DataStack Python Client with `config.datastack.py` auto-loading,
    WebSocket + Heartbeat HTTP Fallback + Offline Spooling + Direct File Streaming.
    """

    def __init__(
        self,
        server_url: Optional[str] = None,
        token: Optional[str] = None,
        api_url: Optional[str] = None,
        config_path: Optional[str] = None,
        auto_connect: Optional[bool] = None,
        reconnection_attempts: Optional[int] = None,
        reconnection_delay: Optional[float] = None,
        client_id: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        if reconnection_attempts is not None and "MAX_RETRIES" not in kwargs:
            kwargs["MAX_RETRIES"] = reconnection_attempts
        if (
            reconnection_delay is not None
            and "HEARTBEAT_INTERVAL_SEC" not in kwargs
        ):
            kwargs["HEARTBEAT_INTERVAL_SEC"] = reconnection_delay

        # If legacy caller passes explicit server_url/token without auto_connect, default auto_connect to False
        # ONLY if config.datastack.py was not used and auto_connect was not explicitly specified.
        self.config: DataStackConfig = load_config(
            config_path=config_path,
            require_token=False,
            SERVER_URL=server_url,
            CLIENT_TOKEN=token,
            API_URL=api_url,
            CLIENT_ID=client_id,
            AUTO_CONNECT=auto_connect,
            **kwargs,
        )

        self.server_url = self.config.server_url
        self.api_url = self.config.api_url
        self.token = self.config.client_token

        configured_client_id = (self.config.client_id or "").strip()
        token_client_id = _decode_jwt_client_id(self.token)
        if (
            configured_client_id
            and token_client_id
            and configured_client_id != token_client_id
        ):
            raise DataStackConfigError(
                f"Configured CLIENT_ID '{configured_client_id}' does not match "
                f"CLIENT_TOKEN subject '{token_client_id}'."
            )
        self.client_id: str = configured_client_id or token_client_id

        self.is_connected = False
        self._lock = threading.RLock()
        self._is_draining_spool = False

        # Offline Disk Spooler
        self.spooler = DiskSpooler(
            spool_dir=self.config.offline_spool_dir,
            max_size_mb=self.config.max_spool_size_mb,
            enabled=self.config.offline_spool_enabled,
        )

        # Heartbeat Monitor (starts in IDLE once connected, wakes on disconnect/offline)
        self.heartbeat = HeartbeatMonitor(
            interval_sec=self.config.heartbeat_interval_sec,
            recovery_callback=self._heartbeat_recovery_step,
        )

        # Socket.IO Client (disable built-in infinite loop so HeartbeatMonitor coordinates fallback + IDLE)
        self.sio = (
            socketio.Client(
                reconnection=False,
                logger=False,
                engineio_logger=False,
            )
            if socketio is not None
            else None
        )
        if self.sio is not None:
            self._register_socket_events()

        if (
            self.config.auto_connect
            and self.token
            and self.token != "REPLACE_WITH_YOUR_CLIENT_JWT_TOKEN"
        ):
            try:
                self.connect()
            except DataStackAuthError:
                raise
            except Exception as exc:
                logger.warning(
                    "[DataStack] Initial connect entered fallback/recovery mode: %s",
                    exc,
                )

    def __enter__(self) -> "DataStackClient":
        if (
            not self.is_connected
            and self.token
            and self.token != "REPLACE_WITH_YOUR_CLIENT_JWT_TOKEN"
        ):
            try:
                self.connect()
            except DataStackAuthError:
                raise
            except Exception:
                pass
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.disconnect()

    def _register_socket_events(self) -> None:
        if self.sio is None:
            return

        @self.sio.event
        def connect() -> None:
            with self._lock:
                self.is_connected = True
            logger.info("[DataStack] WebSocket connected to %s", self.server_url)

        @self.sio.event
        def connect_error(data: Any) -> None:
            with self._lock:
                self.is_connected = False
            msg = str(data)
            if self._is_non_retryable_auth_error(msg):
                self.heartbeat.stop(reason=msg)
            else:
                self.heartbeat.trigger_fallback(reason=f"Socket connect_error: {msg}")

        @self.sio.event
        def disconnect() -> None:
            with self._lock:
                was_connected = self.is_connected
                self.is_connected = False
            if was_connected and self.heartbeat.state != ConnectionState.STOPPED:
                logger.warning(
                    "[DataStack] WebSocket disconnected. Activating Heartbeat HTTP Fallback."
                )
                self.heartbeat.trigger_fallback(reason="WebSocket connection closed")

    @staticmethod
    def _is_non_retryable_auth_error(message: str) -> bool:
        upper = (message or "").upper()
        return any(
            code in upper
            for code in (
                "AUTH_REQUIRED",
                "AUTH_INVALID",
                "CLIENT_REVOKED",
                "TOKEN_ROTATED",
            )
        )

    def _ensure_token_present(self) -> None:
        if not self.token or self.token == "REPLACE_WITH_YOUR_CLIENT_JWT_TOKEN":
            raise DataStackConfigError(
                "Missing CLIENT_TOKEN. Set CLIENT_TOKEN in `config.datastack.py` or pass token='...'."
            )

    def connect(self, wait_timeout: Optional[float] = None) -> bool:
        """
        Establishes the primary WebSocket connection on Port 4000 and verifies the
        handshake via `ping_verify`. If WebSocket is unavailable and `ENABLE_HTTP_FALLBACK`
        is True, automatically enters `FALLBACK_HTTP` (or `OFFLINE_SPOOL` if offline)
        and starts the background Heartbeat Monitor.
        """
        self._ensure_token_present()
        self.heartbeat.start()

        try:
            if self._connect_and_verify_websocket(wait_timeout=wait_timeout):
                self._drain_offline_spool()
                self.heartbeat.set_idle_connected()
                return True
        except DataStackAuthError as auth_err:
            self.heartbeat.stop(reason=str(auth_err))
            raise
        except Exception as exc:
            logger.warning("[DataStack] WebSocket connect failed: %s", exc)

        # WebSocket was not reachable; check if HTTP fallback API is reachable
        if self.config.enable_http_fallback:
            if self._check_http_health():
                self.heartbeat.trigger_fallback(
                    reason="WebSocket unreachable on connect; using HTTP fallback"
                )
                self._drain_offline_spool()
                return True

        if self.config.offline_spool_enabled:
            self.heartbeat.trigger_offline(
                reason="Both WebSocket and HTTP endpoints unreachable on connect"
            )
            return False

        raise DataStackConnectionError(
            f"Unable to connect to DataStack WebSocket ({self.server_url}) or HTTP API ({self.api_url})."
        )

    def disconnect(self) -> None:
        """Gracefully stops the Heartbeat Monitor and disconnects the WebSocket."""
        self.heartbeat.stop(reason="Client closed by application")
        with self._lock:
            self.is_connected = False
            if self.sio is not None and self.sio.connected:
                try:
                    self.sio.disconnect()
                except Exception:
                    pass

    def _connect_and_verify_websocket(
        self, wait_timeout: Optional[float] = None
    ) -> bool:
        if self.sio is None:
            return False

        effective_timeout = (
            float(wait_timeout)
            if wait_timeout is not None
            else self.config.request_timeout_sec
        )

        with self._lock:
            self.is_connected = False
            if self.sio.connected:
                try:
                    self.sio.disconnect()
                except Exception:
                    pass

            try:
                self.sio.connect(
                    self.server_url,
                    auth={"token": self.token},
                    headers={"Authorization": f"Bearer {self.token}"},
                    transports=["websocket", "polling"],
                    wait_timeout=effective_timeout,
                )
                self.is_connected = True
            except Exception as exc:
                self.is_connected = False
                msg = str(exc)
                if self._is_non_retryable_auth_error(msg):
                    raise DataStackAuthError(msg) from exc
                return False

            # Verify handshake & PostgreSQL client status via `ping_verify` while still serialized under RLock
            verified = self._verify_websocket_handshake(timeout=effective_timeout)
            if not verified:
                self.is_connected = False
            return verified

    def _verify_websocket_handshake(
        self, timeout: Optional[float] = None
    ) -> bool:
        if self.sio is None or not self.sio.connected:
            return False

        ack_event = threading.Event()
        result_holder: Dict[str, Any] = {}

        def on_verify(resp: Dict[str, Any]) -> None:
            if isinstance(resp, dict):
                result_holder.update(resp)
            ack_event.set()

        wait_sec = timeout or self.config.request_timeout_sec
        try:
            self.sio.emit("ping_verify", {}, callback=on_verify)
            if not ack_event.wait(timeout=wait_sec):
                return False
        except Exception:
            return False

        if not result_holder.get("success"):
            err_msg = str(
                result_holder.get("error") or "Handshake verification failed"
            )
            if self._is_non_retryable_auth_error(err_msg):
                raise DataStackAuthError(err_msg)
            return False

        return result_holder.get("status") == "VERIFIED"

    def _heartbeat_recovery_step(self) -> bool:
        """
        Invoked periodically by `HeartbeatMonitor` ONLY when not in `CONNECTED_IDLE` mode.
        1. Attempts to reconnect and verify (`ping_verify`) the primary WebSocket.
        2. If WebSocket is verified, drains any offline spooled events and returns True
           so `HeartbeatMonitor` transitions back to `CONNECTED_IDLE` (IDLE mode).
        3. If WebSocket is still down, checks if HTTP fallback (`Port 3000`) is online:
           - If HTTP is online, drains offline spooled events over HTTP and remains in `FALLBACK_HTTP`.
           - If HTTP returns `401/403` auth revocation, stops Heartbeat immediately.
           - If HTTP is also unreachable, sets state to `OFFLINE_SPOOL`.
        """
        self.heartbeat.set_reconnecting()
        try:
            if self._connect_and_verify_websocket():
                self._drain_offline_spool()
                return True
        except DataStackAuthError as auth_err:
            self.heartbeat.stop(reason=str(auth_err))
            return False
        except Exception:
            pass

        # WebSocket still unavailable; check HTTP availability
        try:
            if self.config.enable_http_fallback and self._check_http_health():
                self.heartbeat.trigger_fallback(
                    reason="WebSocket still unavailable; HTTP fallback active"
                )
                self._drain_offline_spool()
                return False
        except DataStackAuthError as auth_err:
            self.heartbeat.stop(reason=str(auth_err))
            return False

        self.heartbeat.trigger_offline(
            reason="Device offline: WebSocket and HTTP endpoints unreachable"
        )
        return False

    def _check_http_health(self) -> bool:
        """
        Probes `GET {API_URL}/api/health` with the client's Bearer JWT token.
        Raises `DataStackAuthError` and halts Heartbeat if client credentials were
        revoked or rotated (`401` / `403`). Returns `True` ONLY on `2xx` with
        `status == 'online'`.
        """
        url = f"{self.api_url}/api/health"
        try:
            status_code, body = self._http_request(
                "GET", url, payload=None, timeout=3.0
            )
        except Exception:
            return False

        err_code = str(body.get("code") or "")
        err_msg = str(body.get("error") or f"HTTP {status_code}")

        if status_code in (401, 403) or self._is_non_retryable_auth_error(
            f"{err_code} {err_msg}"
        ):
            self.heartbeat.stop(reason=err_msg)
            raise DataStackAuthError(err_msg, code=err_code or "AUTH_ERROR")

        return 200 <= status_code < 300 and body.get("status") == "online"

    def _http_request(
        self,
        method: str,
        url: str,
        payload: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> tuple[int, Dict[str, Any]]:
        req_timeout = timeout or self.config.request_timeout_sec
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.client_id:
            headers["X-DataStack-Client-Id"] = self.client_id

        if requests is not None:
            resp = requests.request(
                method=method,
                url=url,
                json=payload,
                headers=headers,
                timeout=req_timeout,
            )
            try:
                body = resp.json() if resp.text else {}
            except Exception:
                body = {"error": resp.text}
            return resp.status_code, (
                body if isinstance(body, dict) else {"data": body}
            )

        # Standard library urllib fallback when `requests` is not installed
        data_bytes = (
            json.dumps(payload, ensure_ascii=False).encode("utf-8")
            if payload is not None
            else None
        )
        req = urllib.request.Request(
            url=url, data=data_bytes, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=req_timeout) as response:
                raw = response.read().decode("utf-8")
                parsed = json.loads(raw) if raw else {}
                return (
                    response.status,
                    parsed if isinstance(parsed, dict) else {"data": parsed},
                )
        except urllib.error.HTTPError as http_err:
            raw_err = http_err.read().decode("utf-8", errors="replace")
            try:
                parsed_err = json.loads(raw_err) if raw_err else {}
            except Exception:
                parsed_err = {"error": raw_err or str(http_err)}
            return (
                http_err.code,
                parsed_err
                if isinstance(parsed_err, dict)
                else {"error": str(parsed_err)},
            )

    def _send_via_http_fallback(
        self, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Sends a single event, batch array (`{ batch: [...] }`), or file records
        (`{ fileName, records: [...] }`) over HTTP `POST {API_URL}/api/events`.
        """
        url = f"{self.api_url}/api/events"
        status_code, body = self._http_request("POST", url, payload=payload)

        if 200 <= status_code < 300 and body.get("success", True):
            return {
                **body,
                "success": True,
                "transport": "HTTP_FALLBACK",
            }

        errors_list = body.get("errors")
        first_err = (
            errors_list[0]
            if isinstance(errors_list, list) and len(errors_list) > 0
            else None
        )
        err_msg = str(body.get("error") or first_err or f"HTTP {status_code}")
        err_code = str(body.get("code") or "")
        combined = f"{err_code} {err_msg}"

        if status_code in (401, 403) or self._is_non_retryable_auth_error(
            combined
        ):
            self.heartbeat.stop(reason=err_msg)
            raise DataStackAuthError(err_msg, code=err_code or "AUTH_ERROR")

        if status_code == 413 or "PAYLOAD_TOO_LARGE" in combined:
            raise DataStackPayloadTooLargeError(err_msg)

        if status_code == 429 or "RATE_LIMIT_EXCEEDED" in combined:
            raise DataStackRateLimitError(err_msg)

        raise DataStackConnectionError(
            f"HTTP fallback error ({status_code}): {err_msg}"
        )

    def _emit_via_websocket(
        self,
        event_name: str,
        payload: Any,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        if self.sio is None or not self.is_connected or not self.sio.connected:
            raise DataStackConnectionError(
                "WebSocket is not currently connected"
            )

        ack_event = threading.Event()
        response_data: Dict[str, Any] = {}

        def ack_callback(res: Dict[str, Any]) -> None:
            if isinstance(res, dict):
                response_data.update(res)
            ack_event.set()

        try:
            self.sio.emit(event_name, payload, callback=ack_callback)
        except Exception as exc:
            self.is_connected = False
            self.heartbeat.trigger_fallback(
                reason=f"WebSocket emit error: {exc}"
            )
            raise DataStackConnectionError(
                f"WebSocket emit failed: {exc}"
            ) from exc

        wait_sec = timeout or self.config.request_timeout_sec
        if not ack_event.wait(timeout=wait_sec):
            self.is_connected = False
            self.heartbeat.trigger_fallback(
                reason=f"WebSocket ACK timeout after {wait_sec}s"
            )
            raise DataStackConnectionError(
                f"WebSocket ACK timed out after {wait_sec}s"
            )

        if not response_data.get("success", False):
            errors_list = response_data.get("errors")
            first_err = (
                errors_list[0]
                if isinstance(errors_list, list) and len(errors_list) > 0
                else None
            )
            err_msg = str(
                response_data.get("error")
                or first_err
                or "WebSocket event rejected"
            )
            err_code = str(response_data.get("code") or "")
            combined = f"{err_code} {err_msg}"

            if self._is_non_retryable_auth_error(combined):
                self.heartbeat.stop(reason=err_msg)
                raise DataStackAuthError(err_msg, code=err_code or "AUTH_ERROR")
            if "PAYLOAD_TOO_LARGE" in combined:
                raise DataStackPayloadTooLargeError(err_msg)
            if "RATE_LIMIT_EXCEEDED" in combined:
                raise DataStackRateLimitError(err_msg)
            raise DataStackError(err_msg, code=err_code or "WS_REJECTED")

        return {
            **response_data,
            "transport": "WEBSOCKET",
        }

    def _execute_with_retry_and_fallback(
        self,
        ws_event: str,
        ws_payload: Any,
        http_payload: Dict[str, Any],
        spool_items: List[Dict[str, Any]],
        timeout: Optional[float] = None,
        allow_spool: bool = True,
    ) -> Dict[str, Any]:
        """
        Core resilient dispatcher:
        1. Attempts WebSocket if connected (`CONNECTED_IDLE`).
        2. On WebSocket failure/disconnect, triggers `HeartbeatMonitor` (`FALLBACK_HTTP`)
           and automatically sends via HTTP `POST /api/events`.
        3. Applies exponential backoff with jitter on `RATE_LIMIT_EXCEEDED` or transient errors.
        4. If both WebSocket and HTTP are unreachable (device offline) and `allow_spool` is True,
           spools events to `.datastack_spool/spool.jsonl` and triggers `OFFLINE_SPOOL`.
        """
        self._ensure_token_present()
        max_attempts = max(1, self.config.max_retries + 1)
        last_exception: Optional[Exception] = None

        for attempt in range(max_attempts):
            if attempt > 0:
                # Use at least 1.0s delay when backing off from RATE_LIMIT_EXCEEDED so the 1s sliding window resets
                base_delay = (
                    max(1.0, self.config.retry_backoff_base_sec)
                    if isinstance(last_exception, DataStackRateLimitError)
                    else self.config.retry_backoff_base_sec
                )
                delay = base_delay * (2 ** (attempt - 1))
                jitter = random.uniform(0.0, 0.2 * delay)
                time.sleep(delay + jitter)

            # 1. Try Primary WebSocket if connected
            if self.is_connected and self.sio is not None and self.sio.connected:
                try:
                    res = self._emit_via_websocket(
                        ws_event, ws_payload, timeout=timeout
                    )
                    if (
                        allow_spool
                        and not self._is_draining_spool
                        and self.spooler.pending_count() > 0
                    ):
                        self._drain_offline_spool()
                    return res
                except (DataStackAuthError, DataStackPayloadTooLargeError):
                    raise
                except DataStackRateLimitError as rl_err:
                    last_exception = rl_err
                    continue
                except Exception as ws_err:
                    last_exception = ws_err
                    self.heartbeat.trigger_fallback(reason=str(ws_err))

            # 2. Try HTTP Fallback (`POST /api/events`)
            if self.config.enable_http_fallback:
                try:
                    res = self._send_via_http_fallback(http_payload)
                    if self.heartbeat.state in (
                        ConnectionState.CONNECTED_IDLE,
                        ConnectionState.OFFLINE_SPOOL,
                    ):
                        self.heartbeat.trigger_fallback(
                            reason="WebSocket not connected; routing via HTTP fallback"
                        )
                    if (
                        allow_spool
                        and not self._is_draining_spool
                        and self.spooler.pending_count() > 0
                    ):
                        self._drain_offline_spool()
                    return res
                except (DataStackAuthError, DataStackPayloadTooLargeError):
                    raise
                except DataStackRateLimitError as rl_err:
                    last_exception = rl_err
                    continue
                except Exception as http_err:
                    last_exception = http_err

        # 3. If rate-limited or payload-rejected after all retries, raise directly
        if isinstance(
            last_exception,
            (DataStackRateLimitError, DataStackPayloadTooLargeError),
        ):
            raise last_exception

        # 4. Device is offline (both WebSocket and HTTP failed): Spool to local disk
        if (
            allow_spool
            and self.config.offline_spool_enabled
            and spool_items
        ):
            spooled_count = self.spooler.enqueue(spool_items)
            self.heartbeat.trigger_offline(
                reason=str(last_exception or "Network unreachable")
            )
            return {
                "success": True,
                "spooled": True,
                "spooledCount": spooled_count,
                "pendingSpoolTotal": self.spooler.pending_count(),
                "transport": "OFFLINE_SPOOL",
            }

        raise DataStackConnectionError(
            f"DataStack delivery failed after {max_attempts} attempts: {last_exception}"
        )

    def _drain_offline_spool(self) -> int:
        """
        Replays any offline spooled events from `.datastack_spool/spool.jsonl`
        once connectivity (WebSocket or HTTP fallback) is restored.
        Routes batches through `_send_formatted_batch_recursive(..., allow_spool=False)`
        and preserves any `unprocessedItems` so zero spooled events are ever lost.
        """
        if not self.config.offline_spool_enabled:
            return 0

        with self._lock:
            if self._is_draining_spool:
                return 0
            self._is_draining_spool = True

        total_flushed = 0
        try:
            while True:
                batch = self.spooler.peek_batch(
                    limit=self.config.batch_chunk_size
                )
                if not batch:
                    break

                res = self._send_formatted_batch_recursive(
                    batch,
                    timeout=self.config.request_timeout_sec,
                    file_name=None,
                    allow_spool=False,
                )
                processed_now = int(res.get("processed", 0))
                duplicates_now = int(res.get("duplicates", 0))
                unprocessed = res.get("unprocessedItems")

                if (
                    not res.get("success", False)
                    and processed_now == 0
                    and duplicates_now == 0
                ):
                    break

                unprocessed_list = (
                    unprocessed if isinstance(unprocessed, list) else []
                )
                self.spooler.ack_and_requeue_front(
                    len(batch), unprocessed_list
                )
                if unprocessed_list:
                    total_flushed += max(0, len(batch) - len(unprocessed_list))
                    break

                total_flushed += len(batch)
        except Exception as exc:
            logger.debug("[DataStack] Spool drain paused: %s", exc)
        finally:
            with self._lock:
                self._is_draining_spool = False

        return total_flushed

    # =========================================================================
    # Public Telemetry Ingestion API
    # =========================================================================

    def send(
        self,
        data: Dict[str, Any],
        event_id: Optional[str] = None,
        timestamp: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Sends a single telemetry event. Automatically falls back to HTTP if WebSocket
        is disconnected, or spools to disk if the device is offline.
        """
        resolved_id = (event_id or "").strip() or _make_event_id()
        resolved_ts = (timestamp or "").strip() or _utc_now_iso()
        envelope: Dict[str, Any] = {
            "eventId": resolved_id,
            "timestamp": resolved_ts,
            "data": data,
        }
        if self.client_id:
            envelope["clientId"] = self.client_id
        return self._execute_with_retry_and_fallback(
            ws_event="sync_data",
            ws_payload=envelope,
            http_payload=envelope,
            spool_items=[envelope],
            timeout=timeout,
            allow_spool=True,
        )

    def sync(
        self,
        data: Dict[str, Any],
        event_id: Optional[str] = None,
        timeout: float = 5.0,
    ) -> Dict[str, Any]:
        """Alias for `send()` preserving backward compatibility."""
        return self.send(data=data, event_id=event_id, timeout=timeout)

    def send_batch(
        self,
        events: Optional[List[Dict[str, Any]]] = None,
        timeout: Optional[float] = None,
        file_name: Optional[str] = None,
        *,
        records: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Sends a batch of events (accepts either `events=[...]` or `records=[...]`).
        - If the batch triggers `413 PAYLOAD_TOO_LARGE`, automatically splits the batch
          in half recursively and retries.
        - If a subset of events in the batch hits `429 RATE_LIMIT_EXCEEDED`
          (`rateLimitedEventIds`), automatically backs off and retries the remaining
          rate-limited events so zero records are dropped.
        """
        source_list = events if events is not None else records
        if not isinstance(source_list, list) or len(source_list) == 0:
            return {"success": True, "processed": 0, "rejected": 0}

        envelope_keys = {"eventId", "timestamp", "data", "clientId"}
        formatted: List[Dict[str, Any]] = []
        for item in source_list:
            safe_item = item if isinstance(item, dict) else {"value": item}
            evt_id = (
                str(safe_item.get("eventId") or "").strip() or _make_event_id()
            )
            evt_ts = (
                str(safe_item.get("timestamp") or "").strip() or _utc_now_iso()
            )
            is_envelope = "data" in safe_item and set(safe_item.keys()).issubset(
                envelope_keys
            )
            evt_data = safe_item["data"] if is_envelope else safe_item
            evt_client_id = (
                str(safe_item.get("clientId") or "").strip() or self.client_id
            )
            entry: Dict[str, Any] = {
                "eventId": evt_id,
                "timestamp": evt_ts,
                "data": evt_data,
            }
            if evt_client_id:
                entry["clientId"] = evt_client_id
            formatted.append(entry)

        return self._send_formatted_batch_recursive(
            formatted,
            timeout=timeout,
            file_name=file_name,
            allow_spool=True,
        )

    def batch_sync(
        self,
        events: Optional[List[Dict[str, Any]]] = None,
        timeout: float = 10.0,
        *,
        records: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Alias for `send_batch()` supporting both `events` and `records` kwargs."""
        return self.send_batch(events=events, records=records, timeout=timeout)

    def _send_formatted_batch_recursive(
        self,
        formatted_batch: List[Dict[str, Any]],
        timeout: Optional[float] = None,
        file_name: Optional[str] = None,
        allow_spool: bool = True,
    ) -> Dict[str, Any]:
        http_payload: Dict[str, Any] = (
            {"fileName": file_name, "records": formatted_batch}
            if file_name
            else {"batch": formatted_batch}
        )
        try:
            res = self._execute_with_retry_and_fallback(
                ws_event="batch_sync",
                ws_payload=formatted_batch,
                http_payload=http_payload,
                spool_items=formatted_batch,
                timeout=timeout,
                allow_spool=allow_spool,
            )
        except DataStackPayloadTooLargeError:
            if len(formatted_batch) <= 1:
                raise
            mid = len(formatted_batch) // 2
            left_res = self._send_formatted_batch_recursive(
                formatted_batch[:mid],
                timeout=timeout,
                file_name=file_name,
                allow_spool=allow_spool,
            )
            right_res = self._send_formatted_batch_recursive(
                formatted_batch[mid:],
                timeout=timeout,
                file_name=file_name,
                allow_spool=allow_spool,
            )
            left_unprocessed = left_res.get("unprocessedItems") or []
            right_unprocessed = right_res.get("unprocessedItems") or []
            combined_unprocessed = [
                *(left_unprocessed if isinstance(left_unprocessed, list) else []),
                *(right_unprocessed if isinstance(right_unprocessed, list) else []),
            ]
            return {
                "success": bool(
                    left_res.get("success", True)
                    and right_res.get("success", True)
                ),
                "processed": int(left_res.get("processed", 0))
                + int(right_res.get("processed", 0)),
                "rejected": int(left_res.get("rejected", 0))
                + int(right_res.get("rejected", 0)),
                "duplicates": int(left_res.get("duplicates", 0))
                + int(right_res.get("duplicates", 0)),
                "spooledCount": int(left_res.get("spooledCount", 0))
                + int(right_res.get("spooledCount", 0)),
                "transport": right_res.get("transport")
                or left_res.get("transport"),
                **(
                    {"unprocessedItems": combined_unprocessed}
                    if len(combined_unprocessed) > 0
                    else {}
                ),
            }

        # Handle partial-batch rate limiting (`rateLimitedEventIds`) so zero rows are dropped
        rate_limited_ids = res.get("rateLimitedEventIds")
        if isinstance(rate_limited_ids, list) and len(rate_limited_ids) > 0:
            pending_id_set = {str(eid) for eid in rate_limited_ids}
            remaining_items = [
                item
                for item in formatted_batch
                if str(item.get("eventId")) in pending_id_set
            ]
            total_processed = int(res.get("processed", 0))
            total_duplicates = int(res.get("duplicates", 0))
            total_spooled = int(res.get("spooledCount", 0))
            last_transport = res.get("transport")

            if self.config.max_retries > 0:
                for _retry_round in range(1, self.config.max_retries + 2):
                    if not remaining_items:
                        break
                    # Wait slightly over 1.0s so the server's 1-second rate-limit window resets
                    wait_delay = max(
                        1.05, self.config.retry_backoff_base_sec
                    ) + random.uniform(0.0, 0.15)
                    time.sleep(wait_delay)

                    sub_http_payload: Dict[str, Any] = (
                        {"fileName": file_name, "records": remaining_items}
                        if file_name
                        else {"batch": remaining_items}
                    )
                    sub_res = self._execute_with_retry_and_fallback(
                        ws_event="batch_sync",
                        ws_payload=remaining_items,
                        http_payload=sub_http_payload,
                        spool_items=remaining_items,
                        timeout=timeout,
                        allow_spool=allow_spool,
                    )
                    total_processed += int(sub_res.get("processed", 0))
                    total_duplicates += int(sub_res.get("duplicates", 0))
                    total_spooled += int(sub_res.get("spooledCount", 0))
                    last_transport = sub_res.get("transport") or last_transport

                    if sub_res.get("spooled"):
                        remaining_items = []
                        break

                    next_rl_ids = sub_res.get("rateLimitedEventIds")
                    if (
                        not isinstance(next_rl_ids, list)
                        or len(next_rl_ids) == 0
                    ):
                        remaining_items = []
                        break
                    next_set = {str(eid) for eid in next_rl_ids}
                    remaining_items = [
                        item
                        for item in remaining_items
                        if str(item.get("eventId")) in next_set
                    ]

            # If any items still remain rate-limited after retries and spooling is allowed, spool them so zero data is lost
            if (
                remaining_items
                and allow_spool
                and self.config.offline_spool_enabled
            ):
                spooled_now = self.spooler.enqueue(remaining_items)
                total_spooled += spooled_now
                remaining_items = []

            oversized_ids = res.get("oversizedEventIds")
            final_rejected = len(remaining_items) + (
                len(oversized_ids) if isinstance(oversized_ids, list) else 0
            )
            out: Dict[str, Any] = {
                "success": final_rejected == 0
                or total_processed > 0
                or total_spooled > 0,
                "processed": total_processed,
                "rejected": final_rejected,
                "duplicates": total_duplicates,
                "spooledCount": total_spooled,
                "transport": last_transport,
            }
            if remaining_items:
                out["unprocessedItems"] = remaining_items
            return out

        return res

    # =========================================================================
    # Direct File Streaming (.csv, .json, .jsonl / .ndjson)
    # =========================================================================

    def send_file(
        self,
        file_path: Union[str, Path],
        chunk_size: Optional[int] = None,
        extra_metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Streams a `.csv`, `.json`, or `.jsonl` (`.ndjson`) file directly to DataStack
        in safe chunks with deterministic SHA-256 idempotency IDs, automatic HTTP fallback,
        partial-batch rate-limit pacing, and offline spooling support.
        """
        path = Path(file_path).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise DataStackFileError(f"File not found: {path}")

        ext = path.suffix.lower()
        if ext not in (".csv", ".json", ".jsonl", ".ndjson"):
            raise DataStackFileError(
                f"Unsupported file extension '{ext}'. Supported formats: .csv, .json, .jsonl, .ndjson"
            )

        effective_chunk = max(
            1, int(chunk_size or self.config.batch_chunk_size)
        )
        total_processed = 0
        total_rejected = 0
        total_duplicates = 0
        total_spooled = 0
        chunks_sent = 0
        last_transport = "WEBSOCKET"

        buffer: List[Dict[str, Any]] = []
        for idx, record in enumerate(self._iter_file_records(path, ext), start=1):
            enriched = (
                {**extra_metadata, **record}
                if extra_metadata and isinstance(record, dict)
                else record
            )
            existing_id = (
                str(enriched.get("eventId") or "").strip()
                if isinstance(enriched, dict)
                else ""
            )
            evt_id = existing_id or _make_deterministic_file_event_id(
                path.stem, idx, enriched
            )
            existing_ts = (
                str(enriched.get("timestamp") or "").strip()
                if isinstance(enriched, dict)
                else ""
            )
            evt_ts = existing_ts or _utc_now_iso()

            file_entry: Dict[str, Any] = {
                "eventId": evt_id,
                "timestamp": evt_ts,
                "data": enriched,
            }
            if self.client_id:
                file_entry["clientId"] = self.client_id
            buffer.append(file_entry)
            if len(buffer) >= effective_chunk:
                res = self.send_batch(buffer, file_name=path.name)
                total_processed += int(res.get("processed", 0))
                total_rejected += int(res.get("rejected", 0))
                total_duplicates += int(res.get("duplicates", 0))
                total_spooled += int(res.get("spooledCount", 0))
                last_transport = str(res.get("transport", last_transport))
                chunks_sent += 1
                buffer = []

        if buffer:
            res = self.send_batch(buffer, file_name=path.name)
            total_processed += int(res.get("processed", 0))
            total_rejected += int(res.get("rejected", 0))
            total_duplicates += int(res.get("duplicates", 0))
            total_spooled += int(res.get("spooledCount", 0))
            last_transport = str(res.get("transport", last_transport))
            chunks_sent += 1

        return {
            "success": True,
            "fileName": path.name,
            "fileType": ext.lstrip("."),
            "chunksSent": chunks_sent,
            "processed": total_processed,
            "rejected": total_rejected,
            "duplicates": total_duplicates,
            "spooledCount": total_spooled,
            "transport": last_transport,
        }

    @staticmethod
    def _iter_file_records(path: Path, ext: str) -> Iterable[Dict[str, Any]]:
        try:
            if ext == ".csv":
                with path.open("r", encoding="utf-8-sig", newline="") as fh:
                    reader = csv.DictReader(fh)
                    for row in reader:
                        yield dict(row)
            elif ext in (".jsonl", ".ndjson"):
                with path.open("r", encoding="utf-8-sig") as fh:
                    for line_no, line in enumerate(fh, start=1):
                        stripped = line.strip()
                        if not stripped:
                            continue
                        try:
                            parsed = json.loads(stripped)
                        except json.JSONDecodeError as exc:
                            raise DataStackFileError(
                                f"Malformed JSONL at line {line_no} in {path.name}: {exc}"
                            ) from exc
                        yield (
                            parsed
                            if isinstance(parsed, dict)
                            else {"value": parsed}
                        )
            elif ext == ".json":
                with path.open("r", encoding="utf-8-sig") as fh:
                    parsed = json.load(fh)
                if isinstance(parsed, list):
                    for item in parsed:
                        yield (
                            item if isinstance(item, dict) else {"value": item}
                        )
                elif isinstance(parsed, dict):
                    if isinstance(parsed.get("records"), list):
                        for item in parsed["records"]:
                            yield (
                                item
                                if isinstance(item, dict)
                                else {"value": item}
                            )
                    elif isinstance(parsed.get("data"), list):
                        for item in parsed["data"]:
                            yield (
                                item
                                if isinstance(item, dict)
                                else {"value": item}
                            )
                    else:
                        yield parsed
                else:
                    yield {"value": parsed}
        except DataStackFileError:
            raise
        except Exception as exc:
            raise DataStackFileError(
                f"Failed reading file '{path.name}': {exc}"
            ) from exc

    def status(self) -> Dict[str, Any]:
        """
        Returns a complete diagnostic snapshot of the SDK connection state,
        Heartbeat Monitor mode (`IDLE` vs `ACTIVE_RECOVERY`), and offline spool queue.
        """
        hb = self.heartbeat.status_snapshot()
        return {
            "connectedWebSocket": self.is_connected,
            "clientId": self.client_id or None,
            "serverUrl": self.server_url,
            "apiUrl": self.api_url,
            "configSource": self.config.config_source_path,
            "connectionState": hb["state"],
            "heartbeatMode": hb["heartbeatMode"],
            "recoveryAttempts": hb["recoveryAttempts"],
            "lastError": hb["lastError"],
            "offlineSpoolPending": self.spooler.pending_count(),
            "offlineSpoolBytes": self.spooler.size_bytes(),
        }


# Convenient alias so developers can write `from datastack import DataStack`
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
