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
    DataStackClient,
    DataStackConfig,
    DataStackConfigError,
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
                f'    "OFFLINE_SPOOL_DIR": "{Path(tmpdir) / "spool"}",\n'
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
