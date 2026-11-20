"""
R3-Phase-03 Verification Tests (BUG-08 / ERR-R3-06):
- `DataStackQuotaExceededError` exported from both canonical `datastack`
  and compatibility alias `datastack_sdk` with `retryable=False`.
- HTTP 507 (`STORAGE_QUOTA_EXCEEDED` and `DISK_SPACE_LOW`) immediately raises
  `DataStackQuotaExceededError` with 0 retries and 0 offline disk spool entries.
- WebSocket ACK (`STORAGE_QUOTA_EXCEEDED` and `DISK_SPACE_LOW`) immediately
  raises `DataStackQuotaExceededError` with 0 retries, 0 HTTP fallback calls,
  and 0 offline disk spool entries for both single `send()` and `send_batch()`.
"""

import base64
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict

REPO_ROOT = Path(__file__).resolve().parents[1]
CANONICAL_PKG_ROOT = REPO_ROOT / "sdk" / "python" / "datastack"
COMPAT_PKG_ROOT = REPO_ROOT / "sdk-python"

for p in (str(CANONICAL_PKG_ROOT), str(COMPAT_PKG_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

import datastack  # noqa: E402
import datastack_sdk  # noqa: E402
from datastack import (  # noqa: E402
    DataStack,
    DataStackError,
    DataStackQuotaExceededError,
)


def _make_jwt(client_id: str) -> str:
    header = (
        base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
        .decode()
        .rstrip("=")
    )
    body = (
        base64.urlsafe_b64encode(
            json.dumps({"clientId": client_id, "sub": client_id}).encode()
        )
        .decode()
        .rstrip("=")
    )
    return f"{header}.{body}.testsig"


class R3Phase03PythonQuotaTests(unittest.TestCase):
    def test_quota_exception_exports_and_non_retryable_flag(self) -> None:
        self.assertIs(
            datastack_sdk.DataStackQuotaExceededError,
            datastack.DataStackQuotaExceededError,
        )
        self.assertIn("DataStackQuotaExceededError", datastack.__all__)
        self.assertIn("DataStackQuotaExceededError", datastack_sdk.__all__)

        err = DataStackQuotaExceededError("Quota full")
        self.assertIsInstance(err, DataStackError)
        self.assertFalse(err.retryable)
        self.assertEqual(err.code, "STORAGE_QUOTA_EXCEEDED")

    def test_http_507_quota_and_disk_low_fail_fast_without_retry_or_spool(self) -> None:
        state = {"code": "STORAGE_QUOTA_EXCEEDED", "calls": 0}
        tok = _make_jwt("py_quota_http")

        class QuotaHttpHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                _ = self.rfile.read(length)
                state["calls"] += 1
                body = json.dumps(
                    {
                        "success": False,
                        "code": state["code"],
                        "error": f"Storage blocked ({state['code']})",
                    }
                ).encode("utf-8")
                self.send_response(507)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), QuotaHttpHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                spool_dir = Path(tmpdir) / "spool"
                client = DataStack(
                    server_url="http://127.0.0.1:1",
                    api_url=f"http://127.0.0.1:{port}",
                    token=tok,
                    auto_connect=False,
                    max_retries=3,
                    retry_backoff_base_sec=0.05,
                    request_timeout_sec=1.0,
                    offline_spool_enabled=True,
                    offline_spool_dir=str(spool_dir),
                )

                # 1. HTTP 507 STORAGE_QUOTA_EXCEEDED -> 1 call (0 retries), 0 spooled
                state["code"] = "STORAGE_QUOTA_EXCEEDED"
                state["calls"] = 0
                with self.assertRaises(DataStackQuotaExceededError) as ctx1:
                    client.send({"sensor": "temp", "val": 100})
                self.assertEqual(ctx1.exception.code, "STORAGE_QUOTA_EXCEEDED")
                self.assertFalse(ctx1.exception.retryable)
                self.assertEqual(state["calls"], 1)
                self.assertEqual(client.spooler.pending_count(), 0)

                # 2. HTTP 507 DISK_SPACE_LOW on send_batch -> 1 call (0 retries), 0 spooled
                state["code"] = "DISK_SPACE_LOW"
                state["calls"] = 0
                with self.assertRaises(DataStackQuotaExceededError) as ctx2:
                    client.send_batch([{"sensor": "a", "v": 1}, {"sensor": "b", "v": 2}])
                self.assertEqual(ctx2.exception.code, "DISK_SPACE_LOW")
                self.assertFalse(ctx2.exception.retryable)
                self.assertEqual(state["calls"], 1)
                self.assertEqual(client.spooler.pending_count(), 0)

                client.disconnect()
        finally:
            server.shutdown()
            server.server_close()

    def test_ws_ack_quota_and_disk_low_fail_fast_without_http_fallback_or_spool(
        self,
    ) -> None:
        tok = _make_jwt("py_quota_ws")

        with tempfile.TemporaryDirectory() as tmpdir:
            spool_dir = Path(tmpdir) / "spool"
            client = DataStack(
                server_url="http://127.0.0.1:4000",
                api_url="http://127.0.0.1:3000",
                token=tok,
                auto_connect=False,
                max_retries=3,
                retry_backoff_base_sec=0.05,
                enable_http_fallback=True,
                offline_spool_enabled=True,
                offline_spool_dir=str(spool_dir),
            )

            http_fallback_calls = {"count": 0}

            def fail_if_http_called(*args: Any, **kwargs: Any) -> Dict[str, Any]:
                http_fallback_calls["count"] += 1
                raise AssertionError(
                    "HTTP fallback must NOT be called after WS DataStackQuotaExceededError"
                )

            client._send_via_http_fallback = fail_if_http_called  # type: ignore[method-assign]

            ws_mode = {"code": "STORAGE_QUOTA_EXCEEDED", "calls": 0}

            class FakeQuotaSocket:
                connected = True

                def emit(
                    self, event: str, payload: Any, callback: Any = None
                ) -> None:
                    ws_mode["calls"] += 1
                    if callback is not None:
                        callback(
                            {
                                "success": False,
                                "code": ws_mode["code"],
                                "error": f"WS rejected due to {ws_mode['code']}",
                            }
                        )

                def disconnect(self) -> None:
                    self.connected = False

            client.sio = FakeQuotaSocket()
            client.is_connected = True

            # 1. Single send WS STORAGE_QUOTA_EXCEEDED
            ws_mode["code"] = "STORAGE_QUOTA_EXCEEDED"
            ws_mode["calls"] = 0
            with self.assertRaises(DataStackQuotaExceededError) as ctx_ws1:
                client.send({"k": "v1"})
            self.assertEqual(ctx_ws1.exception.code, "STORAGE_QUOTA_EXCEEDED")
            self.assertFalse(ctx_ws1.exception.retryable)
            self.assertEqual(ws_mode["calls"], 1)
            self.assertEqual(http_fallback_calls["count"], 0)
            self.assertEqual(client.spooler.pending_count(), 0)

            # 2. Batch send WS DISK_SPACE_LOW
            ws_mode["code"] = "DISK_SPACE_LOW"
            ws_mode["calls"] = 0
            with self.assertRaises(DataStackQuotaExceededError) as ctx_ws2:
                client.send_batch([{"k": "v2"}, {"k": "v3"}])
            self.assertEqual(ctx_ws2.exception.code, "DISK_SPACE_LOW")
            self.assertFalse(ctx_ws2.exception.retryable)
            self.assertEqual(ws_mode["calls"], 1)
            self.assertEqual(http_fallback_calls["count"], 0)
            self.assertEqual(client.spooler.pending_count(), 0)

            client.disconnect()


if __name__ == "__main__":
    unittest.main(verbosity=2)
