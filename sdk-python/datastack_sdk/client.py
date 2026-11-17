import time
import uuid
import logging
import threading
from typing import Any, Dict, List, Optional
import socketio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("DataStackClient")

class DataStackClient:
    """
    DataStack Universal Realtime Data Collection Client
    Syncs telemetry and event payloads via Socket.IO to port 4000
    """
    def __init__(
        self,
        server_url: str = "http://localhost:4000",
        token: str = "",
        reconnection_attempts: int = 5,
        reconnection_delay: int = 1,
    ):
        self.server_url = server_url.rstrip("/")
        self.token = token
        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=reconnection_attempts,
            reconnection_delay=reconnection_delay,
            logger=False,
            engineio_logger=False,
        )
        self._register_handlers()
        self.is_connected = False

    def _register_handlers(self):
        @self.sio.event
        def connect():
            self.is_connected = True
            logger.info(f"Connected to DataStack Engine at {self.server_url}")

        @self.sio.event
        def disconnect():
            self.is_connected = False
            logger.warning("Disconnected from DataStack Engine")

        @self.sio.event
        def connect_error(data):
            self.is_connected = False
            logger.error(f"DataStack Connection Error: {data}")

    def connect(self, wait_timeout: int = 5) -> bool:
        """
        Connects to DataStack Socket.IO server with JWT token in handshake auth
        """
        try:
            self.sio.connect(
                self.server_url,
                auth={"token": self.token},
                wait_timeout=wait_timeout,
                transports=["websocket", "polling"],
            )
            return True
        except Exception as e:
            logger.error(f"Failed to connect to DataStack: {e}")
            return False

    def sync(
        self,
        data: Any,
        event_id: Optional[str] = None,
        timeout: float = 5.0,
    ) -> Dict[str, Any]:
        """
        Sync single event payload in realtime.
        Blocks until the server ack callback fires or timeout expires.
        """
        if not self.is_connected:
            raise ConnectionError("DataStack client is not connected. Call connect() first.")

        evt_id = event_id or f"evt_{uuid.uuid4().hex[:12]}"
        iso_timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        payload = {
            "eventId": evt_id,
            "timestamp": iso_timestamp,
            "data": data,
        }

        ack_event = threading.Event()
        response: Dict[str, Any] = {
            "success": False,
            "eventId": evt_id,
            "error": "Timeout waiting for server acknowledgment",
        }

        def on_ack(res):
            nonlocal response
            if isinstance(res, dict):
                response = res
            ack_event.set()

        try:
            self.sio.emit("sync_data", payload, callback=on_ack)
            ack_event.wait(timeout=timeout)
            return response
        except Exception as e:
            logger.error(f"Sync error for event {evt_id}: {e}")
            return {"success": False, "eventId": evt_id, "error": str(e)}

    def batch_sync(
        self,
        records: List[Dict[str, Any]],
        timeout: float = 10.0,
    ) -> Dict[str, Any]:
        """
        Sync list of records in a single batch.
        Blocks until the server ack callback fires or timeout expires.
        """
        if not self.is_connected:
            raise ConnectionError("DataStack client is not connected.")

        batch_payload = []
        for r in records:
            batch_payload.append({
                "eventId": r.get("eventId") or f"evt_{uuid.uuid4().hex[:12]}",
                "timestamp": r.get("timestamp") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "data": r.get("data", r),
            })

        ack_event = threading.Event()
        response: Dict[str, Any] = {
            "success": False,
            "processed": 0,
            "error": "Timeout waiting for server batch acknowledgment",
        }

        def on_ack(res):
            nonlocal response
            if isinstance(res, dict):
                response = res
            ack_event.set()

        try:
            self.sio.emit("batch_sync", batch_payload, callback=on_ack)
            ack_event.wait(timeout=timeout)
            return response
        except Exception as e:
            logger.error(f"Batch sync error: {e}")
            return {"success": False, "error": str(e)}

    def disconnect(self):
        """Disconnects socket connection"""
        if self.is_connected:
            self.sio.disconnect()
