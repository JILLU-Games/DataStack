"""
Backward-Compatible `datastack_sdk.client` Wrapper.
Delegates to the unified production SDK implementation in `sdk/python/datastack/datastack`
so existing applications importing `from datastack_sdk import DataStackClient` gain
automatic `config.datastack.py` discovery, Heartbeat HTTP fallback, offline spooling,
and `send_file()` support.
"""

import sys
from pathlib import Path

# Resolve `sdk/python/datastack` from the repository root if not installed in site-packages
_REPO_ROOT = Path(__file__).resolve().parents[2]
_NEW_SDK_PATH = _REPO_ROOT / "sdk" / "python" / "datastack"
if _NEW_SDK_PATH.exists() and str(_NEW_SDK_PATH) not in sys.path:
    sys.path.insert(0, str(_NEW_SDK_PATH))

from datastack.client import DataStack, DataStackClient  # noqa: E402
from datastack.config import DataStackConfig, load_config  # noqa: E402
from datastack.exceptions import (  # noqa: E402
    DataStackAuthError,
    DataStackConfigError,
    DataStackConnectionError,
    DataStackError,
    DataStackFileError,
    DataStackOfflineSpoolError,
    DataStackPayloadTooLargeError,
    DataStackRateLimitError,
)
from datastack.heartbeat import ConnectionState, HeartbeatMonitor  # noqa: E402
from datastack.spool import DiskSpooler  # noqa: E402

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
