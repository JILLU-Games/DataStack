"""
Smart Heartbeat Monitor & Connection State Machine (`HeartbeatMonitor`).

Lifecycle States:
- `CONNECTED_IDLE`: WebSocket (Port 4000) is connected and verified. Heartbeat sleeps in IDLE mode.
- `FALLBACK_HTTP`: WebSocket disconnected. Client automatically sends events via HTTP (`POST /api/events`)
  while Heartbeat actively probes to reconnect and verify WebSocket, then returns to `CONNECTED_IDLE`.
- `OFFLINE_SPOOL`: Device is completely offline. Events spool to disk (`.datastack_spool/spool.jsonl`).
  Heartbeat monitors network restoration, reconnects, replays spooled events, and returns to `CONNECTED_IDLE`.
- `RECONNECTING_VERIFY`: Heartbeat is verifying handshake (`ping_verify`) and draining spooled events.
- `STOPPED`: Client was closed intentionally or halted due to non-retryable auth revocation.
"""

import logging
import threading
import time
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("datastack.heartbeat")


class ConnectionState:
    CONNECTED_IDLE = "CONNECTED_IDLE"
    FALLBACK_HTTP = "FALLBACK_HTTP"
    OFFLINE_SPOOL = "OFFLINE_SPOOL"
    RECONNECTING_VERIFY = "RECONNECTING_VERIFY"
    STOPPED = "STOPPED"


class HeartbeatMonitor:
    """
    Background recovery thread that sleeps in zero-CPU IDLE mode while WebSocket is
    healthy (`CONNECTED_IDLE`) and wakes up automatically when WebSocket disconnects
    or when the client device goes offline.
    """

    def __init__(
        self,
        interval_sec: float,
        recovery_callback: Callable[[], bool],
    ) -> None:
        self.interval_sec = max(0.2, float(interval_sec))
        self._recovery_callback = recovery_callback
        self._state = ConnectionState.CONNECTED_IDLE
        self._closed = False
        self._last_error: Optional[str] = None
        self._recovery_attempts = 0
        self._last_verified_at: Optional[float] = None

        self._lock = threading.RLock()
        self._wake_event = threading.Event()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    @property
    def is_idle(self) -> bool:
        with self._lock:
            return self._state == ConnectionState.CONNECTED_IDLE

    def set_idle_connected(self) -> None:
        """
        Marks the connection as healthy (`CONNECTED_IDLE`) and puts the Heartbeat
        Monitor into IDLE mode (`_wake_event.clear()`).
        """
        with self._lock:
            self._closed = False
            self._state = ConnectionState.CONNECTED_IDLE
            self._recovery_attempts = 0
            self._last_error = None
            self._last_verified_at = time.time()
            self._wake_event.clear()

    def trigger_fallback(self, reason: str = "WebSocket disconnected") -> None:
        """
        Transitions to `FALLBACK_HTTP` and wakes up the Heartbeat Monitor thread
        to repair the WebSocket connection in the background.
        """
        with self._lock:
            if self._closed:
                return
            self._state = ConnectionState.FALLBACK_HTTP
            self._last_error = reason
            self._ensure_thread_started()
            self._wake_event.set()

    def trigger_offline(self, reason: str = "Device offline") -> None:
        """
        Transitions to `OFFLINE_SPOOL` when both WebSocket and HTTP fallback are
        unreachable, waking the Heartbeat Monitor to watch for network return.
        """
        with self._lock:
            if self._closed:
                return
            self._state = ConnectionState.OFFLINE_SPOOL
            self._last_error = reason
            self._ensure_thread_started()
            self._wake_event.set()

    def set_reconnecting(self) -> None:
        with self._lock:
            if not self._closed:
                self._state = ConnectionState.RECONNECTING_VERIFY

    def start(self) -> None:
        with self._lock:
            self._closed = False
            self._stop_event.clear()
            self._ensure_thread_started()

    def stop(self, reason: Optional[str] = None) -> None:
        with self._lock:
            self._closed = True
            self._state = ConnectionState.STOPPED
            if reason:
                self._last_error = reason
            self._stop_event.set()
            self._wake_event.set()

    def status_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "state": self._state,
                "heartbeatMode": (
                    "IDLE"
                    if self._state == ConnectionState.CONNECTED_IDLE
                    else "ACTIVE_RECOVERY"
                    if self._state
                    in (
                        ConnectionState.FALLBACK_HTTP,
                        ConnectionState.OFFLINE_SPOOL,
                        ConnectionState.RECONNECTING_VERIFY,
                    )
                    else "STOPPED"
                ),
                "recoveryAttempts": self._recovery_attempts,
                "lastError": self._last_error,
                "lastVerifiedAt": self._last_verified_at,
                "intervalSec": self.interval_sec,
            }

    def _ensure_thread_started(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="DataStack-HeartbeatMonitor",
            daemon=True,
        )
        self._thread.start()

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            # Wait in zero-CPU IDLE mode until woken by a disconnect or offline trigger
            self._wake_event.wait()
            if self._stop_event.is_set():
                break

            # Wait for the heartbeat interval before probing
            if self._stop_event.wait(self.interval_sec):
                break

            if not self._wake_event.is_set():
                continue

            with self._lock:
                if self._closed or self._state == ConnectionState.STOPPED:
                    break
                if (
                    self._state == ConnectionState.CONNECTED_IDLE
                    or not self._wake_event.is_set()
                ):
                    continue
                self._recovery_attempts += 1

            try:
                recovered_to_idle = self._recovery_callback()
                if recovered_to_idle:
                    self.set_idle_connected()
                    logger.info(
                        "[DataStack Heartbeat] WebSocket reconnected & verified. Returning to IDLE mode."
                    )
            except Exception as exc:
                with self._lock:
                    self._last_error = str(exc)
                logger.debug("[DataStack Heartbeat] Recovery probe failed: %s", exc)
