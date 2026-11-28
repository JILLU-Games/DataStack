"""
Phase-05 Verification Tests (BUG-18):
- Single Source of Truth between canonical `datastack` (`sdk/python/datastack`)
  and compatibility alias `datastack_sdk` (`sdk-python`).
- `CLIENT_ID` config loading (`config.datastack.py`, `DATASTACK_CLIENT_ID`, kwarg),
  JWT `clientId`/`sub` fallback extraction, and mismatch validation.
- End-to-end propagation of `clientId` & `X-DataStack-Client-Id` into HTTP
  fallback ingestion (`send`, `send_batch`, `send_file`), status snapshot, and
  offline disk spool replay against a local HTTP test server.
"""

import ast
import base64
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List

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
    DataStackAuthError,
    DataStackClient,
    DataStackConfig,
    DataStackConfigError,
    DataStackConnectionError,
    DataStackOfflineSpoolError,
    DiskSpooler,
    HeartbeatMonitor,
    load_config,
)


def _make_jwt(payload: Dict[str, Any]) -> str:
    header = (
        base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
        .decode()
        .rstrip("=")
    )
    body = (
        base64.urlsafe_b64encode(json.dumps(payload).encode())
        .decode()
        .rstrip("=")
    )
    return f"{header}.{body}.testsig"


class Phase05PythonSdkTests(unittest.TestCase):
    def test_single_source_of_truth_identity(self) -> None:
        self.assertIs(datastack_sdk.DataStack, datastack.DataStack)
        self.assertIs(datastack_sdk.DataStackClient, datastack.DataStackClient)
        self.assertIs(datastack_sdk.DataStackConfig, datastack.DataStackConfig)
        self.assertIs(datastack_sdk.load_config, datastack.load_config)
        self.assertIs(
            datastack_sdk.DataStackConfigError, datastack.DataStackConfigError
        )
        self.assertIs(
            datastack_sdk.DataStackOfflineSpoolError,
            datastack.DataStackOfflineSpoolError,
        )
        self.assertIs(datastack_sdk.DiskSpooler, datastack.DiskSpooler)
        self.assertIs(datastack_sdk.HeartbeatMonitor, datastack.HeartbeatMonitor)
        self.assertEqual(datastack_sdk.__version__, datastack.__version__)

        # Submodule shims also resolve to canonical classes
        from datastack_sdk.client import DataStackClient as ShimClient
        from datastack_sdk.config import load_config as shim_load_config
        from datastack_sdk.exceptions import (
            DataStackOfflineSpoolError as ShimSpoolErr,
        )
        from datastack_sdk.heartbeat import HeartbeatMonitor as ShimHeartbeat
        from datastack_sdk.spool import DiskSpooler as ShimSpooler

        self.assertIs(ShimClient, DataStackClient)
        self.assertIs(shim_load_config, load_config)
        self.assertIs(ShimSpoolErr, DataStackOfflineSpoolError)
        self.assertIs(ShimHeartbeat, HeartbeatMonitor)
        self.assertIs(ShimSpooler, DiskSpooler)

    def test_client_id_config_env_and_jwt_validation(self) -> None:
        tok_alpha = _make_jwt({"clientId": "alpha_svc", "sub": "alpha_svc"})

        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_file = Path(tmpdir) / "config.datastack.py"
            cfg_file.write_text(
                f'DATASTACK_CONFIG = {{\n'
                f'    "SERVER_URL": "http://127.0.0.1:49999",\n'
                f'    "API_URL": "http://127.0.0.1:39999",\n'
                f'    "CLIENT_TOKEN": "{tok_alpha}",\n'
                f'    "CLIENT_ID": "alpha_svc",\n'
                f'    "AUTO_CONNECT": False,\n'
                f'    "OFFLINE_SPOOL_DIR": {str(Path(tmpdir) / "spool")!r},\n'
                f'}}\n',
                encoding="utf-8",
            )

            cfg = load_config(config_path=str(cfg_file))
            self.assertIsInstance(cfg, DataStackConfig)
            self.assertEqual(cfg.client_id, "alpha_svc")

            # Matching explicit client_id succeeds
            client = DataStack(config_path=str(cfg_file), auto_connect=False)
            self.assertEqual(client.client_id, "alpha_svc")
            self.assertEqual(client.status()["clientId"], "alpha_svc")
            client.disconnect()

            # Env override matching JWT succeeds; mismatching raises DataStackConfigError
            old_env = os.environ.get("DATASTACK_CLIENT_ID")
            try:
                os.environ["DATASTACK_CLIENT_ID"] = "wrong_svc"
                with self.assertRaises(DataStackConfigError):
                    DataStack(config_path=str(cfg_file), auto_connect=False)
            finally:
                if old_env is None:
                    os.environ.pop("DATASTACK_CLIENT_ID", None)
                else:
                    os.environ["DATASTACK_CLIENT_ID"] = old_env

            # Mismatched kwarg client_id raises DataStackConfigError
            with self.assertRaises(DataStackConfigError):
                DataStack(
                    config_path=str(cfg_file),
                    client_id="mismatch_svc",
                    auto_connect=False,
                )

        # Auto-derives client_id from JWT when CLIENT_ID is omitted
        tok_derived = _make_jwt({"sub": "derived_worker"})
        derived_client = DataStack(
            server_url="http://127.0.0.1:49999",
            api_url="http://127.0.0.1:39999",
            token=tok_derived,
            auto_connect=False,
        )
        self.assertEqual(derived_client.client_id, "derived_worker")
        self.assertEqual(derived_client.status()["clientId"], "derived_worker")
        derived_client.disconnect()

    def test_http_fallback_and_offline_spool_carry_client_id(self) -> None:
        recorded_requests: List[Dict[str, Any]] = []
        tok = _make_jwt({"clientId": "sensor_01", "sub": "sensor_01"})

        class MockHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/api/health":
                    body = json.dumps({"status": "online"}).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length).decode("utf-8")
                parsed = json.loads(raw) if raw else {}
                recorded_requests.append(
                    {
                        "path": self.path,
                        "client_id_header": self.headers.get("X-DataStack-Client-Id"),
                        "auth": self.headers.get("Authorization"),
                        "body": parsed,
                    }
                )
                resp_payload: Dict[str, Any] = {"success": True}
                if isinstance(parsed, dict) and "batch" in parsed:
                    resp_payload["processed"] = len(parsed["batch"])
                    resp_payload["rejected"] = 0
                elif isinstance(parsed, dict) and "records" in parsed:
                    resp_payload["processed"] = len(parsed["records"])
                    resp_payload["rejected"] = 0
                body = json.dumps(resp_payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                spool_dir = Path(tmpdir) / "spool"
                csv_file = Path(tmpdir) / "sample.csv"
                csv_file.write_text("temp,unit\n21.5,C\n22.0,C\n", encoding="utf-8")

                client = DataStack(
                    server_url="http://127.0.0.1:1",  # unreachable WS -> HTTP fallback
                    api_url=f"http://127.0.0.1:{port}",
                    token=tok,
                    client_id="sensor_01",
                    auto_connect=False,
                    request_timeout_sec=1.0,
                    max_retries=0,
                    offline_spool_dir=str(spool_dir),
                )

                # Single event via HTTP fallback
                res_single = client.send({"reading": 42})
                self.assertTrue(res_single.get("success"))
                self.assertEqual(res_single.get("transport"), "HTTP_FALLBACK")

                # Batch events via HTTP fallback
                res_batch = client.send_batch([{"k": "a"}, {"k": "b"}])
                self.assertEqual(res_batch.get("processed"), 2)

                # File ingestion via HTTP fallback
                res_file = client.send_file(csv_file)
                self.assertEqual(res_file.get("processed"), 2)

                client.disconnect()

                self.assertEqual(len(recorded_requests), 3)
                for req in recorded_requests:
                    self.assertEqual(req["path"], "/api/events")
                    self.assertEqual(req["client_id_header"], "sensor_01")
                    self.assertEqual(req["auth"], f"Bearer {tok}")

                self.assertEqual(recorded_requests[0]["body"]["clientId"], "sensor_01")
                self.assertEqual(
                    [r["clientId"] for r in recorded_requests[1]["body"]["batch"]],
                    ["sensor_01", "sensor_01"],
                )
                self.assertEqual(
                    [r["clientId"] for r in recorded_requests[2]["body"]["records"]],
                    ["sensor_01", "sensor_01"],
                )

                # Offline spool check when HTTP is also unreachable
                offline_client = datastack_sdk.DataStackClient(
                    server_url="http://127.0.0.1:1",
                    api_url="http://127.0.0.1:1",
                    token=tok,
                    auto_connect=False,
                    request_timeout_sec=1.0,
                    max_retries=0,
                    offline_spool_dir=str(spool_dir),
                )
                spool_res = offline_client.send({"offline_metric": 99})
                offline_client.disconnect()
                self.assertTrue(spool_res.get("spooled"))
                self.assertEqual(spool_res.get("transport"), "OFFLINE_SPOOL")
                self.assertGreaterEqual(spool_res.get("spooledCount", 0), 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_client_id_normalization_and_invalid_numeric_env(self) -> None:
        tok_norm = _make_jwt({"clientId": "sensor_01", "sub": "sensor_01"})
        # Case/punctuation variations matching server SDKManager.normalizeClientId() must succeed
        client = DataStack(
            server_url="http://127.0.0.1:49999",
            api_url="http://127.0.0.1:39999",
            token=tok_norm,
            client_id="Sensor.01",
            auto_connect=False,
        )
        self.assertEqual(client.client_id, "sensor_01")
        client.disconnect()

        # Invalid numeric env var must raise DataStackConfigError instead of raw ValueError
        old_retries = os.environ.get("DATASTACK_MAX_RETRIES")
        try:
            os.environ["DATASTACK_MAX_RETRIES"] = "not-an-int"
            with self.assertRaises(DataStackConfigError):
                load_config()
        finally:
            if old_retries is None:
                os.environ.pop("DATASTACK_MAX_RETRIES", None)
            else:
                os.environ["DATASTACK_MAX_RETRIES"] = old_retries

    def test_ragged_csv_all_rejected_send_file_and_partial_rl_recovery(self) -> None:
        tok = _make_jwt({"clientId": "csv_worker", "sub": "csv_worker"})
        mode = {"behavior": "reject_oversized"}
        seen_records: List[Dict[str, Any]] = []

        class EdgeHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length).decode("utf-8")
                parsed = json.loads(raw) if raw else {}
                items = parsed.get("records") or parsed.get("batch") or []
                seen_records.extend(items)

                if mode["behavior"] == "reject_oversized":
                    resp = {
                        "success": True,
                        "processed": 0,
                        "rejected": len(items),
                        "duplicates": 0,
                        "oversizedEventIds": [it.get("eventId") for it in items],
                    }
                    status = 200
                else:
                    # First round processes first item, rate-limits second; second round disconnects/429
                    if len(items) > 1:
                        resp = {
                            "success": True,
                            "processed": 1,
                            "rejected": 1,
                            "duplicates": 0,
                            "rateLimitedEventIds": [items[1]["eventId"]],
                        }
                        status = 200
                    else:
                        resp = {
                            "success": False,
                            "code": "RATE_LIMIT_EXCEEDED",
                            "error": "Still limited",
                        }
                        status = 429

                body = json.dumps(resp).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), EdgeHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                # Ragged CSV with extra trailing column (used to crash sort_keys=True with None key)
                ragged_csv = Path(tmpdir) / "ragged.csv"
                ragged_csv.write_text(
                    "sensor,val\ns1,10,extra_trailing_col\n",
                    encoding="utf-8",
                )

                client = DataStack(
                    server_url="http://127.0.0.1:1",
                    api_url=f"http://127.0.0.1:{port}",
                    token=tok,
                    auto_connect=False,
                    request_timeout_sec=1.0,
                    max_retries=0,
                    retry_backoff_base_sec=0.1,
                    offline_spool_enabled=False,
                )

                res_file = client.send_file(ragged_csv)
                self.assertFalse(res_file["success"])
                self.assertEqual(res_file["processed"], 0)
                self.assertEqual(res_file["rejected"], 1)
                self.assertEqual(seen_records[0]["data"]["_extra"], ["extra_trailing_col"])

                # Partial rate-limit where follow-up retry exhausts retries must preserve round-1 processed count
                mode["behavior"] = "partial_rl"
                spool_dir = Path(tmpdir) / "spool"
                rl_client = DataStack(
                    server_url="http://127.0.0.1:1",
                    api_url=f"http://127.0.0.1:{port}",
                    token=tok,
                    auto_connect=False,
                    request_timeout_sec=1.0,
                    max_retries=1,
                    retry_backoff_base_sec=0.1,
                    offline_spool_dir=str(spool_dir),
                )
                rl_res = rl_client.send_batch(
                    [
                        {"eventId": "evt_ok_1", "data": {"n": 1}},
                        {"eventId": "evt_rl_2", "data": {"n": 2}},
                    ]
                )
                self.assertTrue(rl_res["success"])
                self.assertEqual(rl_res["processed"], 1)
                self.assertEqual(rl_res["spooledCount"], 1)
                self.assertEqual(rl_client.spooler.pending_count(), 1)

                client.disconnect()
                rl_client.disconnect()
        finally:
            server.shutdown()
            server.server_close()

    def test_heartbeat_stop_race_and_spooler_clean_ops(self) -> None:
        hb = HeartbeatMonitor(interval_sec=5.0, recovery_callback=lambda: True)
        hb.start()
        hb.trigger_fallback("disconnect")
        hb.stop("shutdown", join_timeout=0.5)
        # Calling set_idle_connected after stop() must NOT resurrect IDLE state
        hb.set_idle_connected()
        self.assertEqual(hb.state, "STOPPED")

        with tempfile.TemporaryDirectory() as tmpdir:
            spool = DiskSpooler(spool_dir=tmpdir, max_size_mb=5, enabled=True)
            spool.enqueue([{"eventId": "a"}, {"eventId": "b"}, {"eventId": "c"}])
            self.assertEqual(spool.pending_count(), 3)
            spool.ack_and_requeue_front(2, [{"eventId": "b_retry"}])
            batch = spool.peek_batch(limit=10)
            self.assertEqual([item["eventId"] for item in batch], ["b_retry", "c"])
            self.assertFalse((Path(tmpdir) / "spool.jsonl.tmp").exists())
            spool.ack_batch(2)
            self.assertEqual(spool.pending_count(), 0)

    def test_bug25_disconnects_leaked_socket_on_failed_ping_verify(self) -> None:
        tok = _make_jwt({"clientId": "cli_bug25_sock"})
        client = DataStack(
            server_url="http://127.0.0.1:4000",
            api_url="http://127.0.0.1:3000",
            token=tok,
            auto_connect=False,
            enable_http_fallback=False,
            offline_spool_enabled=False,
            request_timeout_sec=0.5,
        )

        class FakeSocket:
            def __init__(self) -> None:
                self.connected = False
                self.disconnect_calls = 0

            def connect(self, *args: Any, **kwargs: Any) -> None:
                self.connected = True

            def disconnect(self) -> None:
                self.disconnect_calls += 1
                self.connected = False

        fake_sio = FakeSocket()
        client.sio = fake_sio

        # Case 1: ping_verify returns False -> socket must be disconnected
        client._verify_websocket_handshake = lambda timeout=None: False  # type: ignore[method-assign]
        self.assertFalse(client._connect_and_verify_websocket(wait_timeout=0.5))
        self.assertFalse(client.is_connected)
        self.assertFalse(fake_sio.connected)
        self.assertEqual(fake_sio.disconnect_calls, 1)

        # Case 2: ping_verify raises DataStackAuthError -> socket must be disconnected before re-raising
        def raise_auth(timeout: Any = None) -> bool:
            raise DataStackAuthError("CLIENT_REVOKED")

        client._verify_websocket_handshake = raise_auth  # type: ignore[method-assign]
        with self.assertRaises(DataStackAuthError):
            client._connect_and_verify_websocket(wait_timeout=0.5)
        self.assertFalse(client.is_connected)
        self.assertFalse(fake_sio.connected)
        self.assertEqual(fake_sio.disconnect_calls, 2)
        client.disconnect()

    def test_bug25_strict_auto_connect_and_context_raise_connection_error(self) -> None:
        tok = _make_jwt({"clientId": "cli_bug25_strict"})

        # auto_connect=True with both fallback and offline spool disabled must raise DataStackConnectionError
        with self.assertRaises(DataStackConnectionError):
            DataStack(
                server_url="http://127.0.0.1:1",
                api_url="http://127.0.0.1:1",
                token=tok,
                auto_connect=True,
                enable_http_fallback=False,
                offline_spool_enabled=False,
                request_timeout_sec=0.2,
            )

        # Context manager __enter__ with both fallback and offline spool disabled must also raise
        strict_client = DataStack(
            server_url="http://127.0.0.1:1",
            api_url="http://127.0.0.1:1",
            token=tok,
            auto_connect=False,
            enable_http_fallback=False,
            offline_spool_enabled=False,
            request_timeout_sec=0.2,
        )
        with self.assertRaises(DataStackConnectionError):
            with strict_client:
                pass
        self.assertEqual(strict_client.heartbeat.state, "STOPPED")

    def test_r2_phase03_bug11_flat_batch_and_file_strip_envelope_keys(self) -> None:
        tok = _make_jwt({"clientId": "cli_bug11_strip"})
        captured_batches: List[List[Dict[str, Any]]] = []

        with tempfile.TemporaryDirectory() as tmpdir:
            client = DataStack(
                server_url="http://127.0.0.1:1",
                api_url="http://127.0.0.1:1",
                token=tok,
                auto_connect=False,
                offline_spool_enabled=False,
            )

            def fake_execute(**kwargs: Any) -> Dict[str, Any]:
                ws_payload = kwargs.get("ws_payload")
                if isinstance(ws_payload, list):
                    captured_batches.append(ws_payload)
                    return {
                        "success": True,
                        "processed": len(ws_payload),
                        "rejected": 0,
                        "transport": "HTTP",
                    }
                return {"success": True, "processed": 0, "rejected": 0}

            client._execute_with_retry_and_fallback = fake_execute  # type: ignore[method-assign]

            res_batch = client.send_batch(
                [
                    {
                        "eventId": "py-flat-1",
                        "timestamp": "2026-11-19T12:00:00Z",
                        "clientId": "cli_bug11_strip",
                        "sensor": "temp",
                        "value": 24.5,
                    },
                    {
                        "eventId": "py-env-2",
                        "timestamp": "2026-11-19T12:00:01Z",
                        "data": {"sensor": "humidity", "value": 55},
                    },
                ]
            )
            self.assertTrue(res_batch["success"])
            self.assertEqual(len(captured_batches), 1)
            self.assertEqual(captured_batches[0][0]["eventId"], "py-flat-1")
            self.assertEqual(
                captured_batches[0][0]["data"],
                {"sensor": "temp", "value": 24.5},
            )
            self.assertEqual(
                captured_batches[0][1]["data"],
                {"sensor": "humidity", "value": 55},
            )

            csv_path = Path(tmpdir) / "flat_records.csv"
            csv_path.write_text(
                "eventId,timestamp,clientId,sensor,reading\n"
                "file-flat-1,2026-11-19T13:00:00Z,cli_bug11_strip,pressure,101.3\n",
                encoding="utf-8",
            )
            res_file = client.send_file(csv_path)
            self.assertTrue(res_file["success"])
            self.assertEqual(len(captured_batches), 2)
            self.assertEqual(captured_batches[1][0]["eventId"], "file-flat-1")
            self.assertEqual(
                captured_batches[1][0]["data"],
                {"sensor": "pressure", "reading": "101.3"},
            )

    def test_r2_phase04_bug14_python38_ast_typing_compatibility(self) -> None:
        pkg_dir = CANONICAL_PKG_ROOT / "datastack"
        py_files = sorted(pkg_dir.glob("*.py"))
        self.assertGreater(len(py_files), 0)

        pep585_builtins = {"tuple", "list", "dict", "set", "frozenset", "type"}
        for py_file in py_files:
            src = py_file.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=str(py_file), feature_version=(3, 8))
            has_future_annotations = any(
                isinstance(node, ast.ImportFrom)
                and node.module == "__future__"
                and any(alias.name == "annotations" for alias in node.names)
                for node in tree.body
            )
            if py_file.name == "client.py":
                self.assertTrue(
                    has_future_annotations,
                    "client.py must declare `from __future__ import annotations`",
                )

            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.Subscript)
                    and isinstance(node.value, ast.Name)
                    and node.value.id in pep585_builtins
                ):
                    self.fail(
                        f"{py_file.name}:{node.lineno} uses Python 3.9+ PEP 585 generic `{node.value.id}[...]`"
                    )

    def test_v2_audit_phase02_bug09_fatal_auth_codes_expired_and_ip_forbidden(
        self,
    ) -> None:
        self.assertTrue(
            DataStackClient._is_non_retryable_auth_error(
                "CLIENT_TOKEN_EXPIRED: Client token has expired"
            )
        )
        self.assertTrue(
            DataStackClient._is_non_retryable_auth_error(
                "CLIENT_IP_FORBIDDEN: IP 198.51.100.25 is not permitted"
            )
        )
        self.assertFalse(
            DataStackClient._is_non_retryable_auth_error("Connection reset by peer")
        )

        tok = _make_jwt({"clientId": "cli_audit09"})
        client = DataStack(
            server_url="http://127.0.0.1:4000",
            api_url="http://127.0.0.1:3000",
            token=tok,
            auto_connect=False,
            enable_http_fallback=True,
            offline_spool_enabled=True,
            request_timeout_sec=0.5,
        )

        class FakeFailingAuthSocket:
            def __init__(self, error_msg: str) -> None:
                self.connected = False
                self.error_msg = error_msg

            def connect(self, *args: Any, **kwargs: Any) -> None:
                raise RuntimeError(self.error_msg)

            def disconnect(self) -> None:
                self.connected = False

        # 1. CLIENT_TOKEN_EXPIRED on WebSocket handshake must immediately raise DataStackAuthError with code="CLIENT_TOKEN_EXPIRED"
        client.sio = FakeFailingAuthSocket(
            "CLIENT_TOKEN_EXPIRED: Client token has expired"
        )
        with self.assertRaises(DataStackAuthError) as ctx_exp:
            client._connect_and_verify_websocket(wait_timeout=0.2)
        self.assertEqual(ctx_exp.exception.code, "CLIENT_TOKEN_EXPIRED")

        # 2. CLIENT_IP_FORBIDDEN on WebSocket handshake must immediately raise DataStackAuthError with code="CLIENT_IP_FORBIDDEN"
        client.sio = FakeFailingAuthSocket(
            "CLIENT_IP_FORBIDDEN: IP is not in allowlist"
        )
        with self.assertRaises(DataStackAuthError) as ctx_ip:
            client._connect_and_verify_websocket(wait_timeout=0.2)
        self.assertEqual(ctx_ip.exception.code, "CLIENT_IP_FORBIDDEN")

        client.disconnect()


if __name__ == "__main__":
    unittest.main(verbosity=2)

