"""
DataStack Python SDK Compatibility Alias (`datastack_sdk`).
Re-exports all canonical symbols from `sdk/python/datastack` (`datastack`)
so both `from datastack import DataStack` and legacy
`from datastack_sdk import DataStackClient` share a single source of truth.
"""

import sys
from pathlib import Path


def _ensure_canonical_datastack_on_path() -> None:
    try:
        import datastack  # noqa: F401
        return
    except ImportError:
        repo_canonical = (
            Path(__file__).resolve().parents[2] / "sdk" / "python" / "datastack"
        )
        if repo_canonical.is_dir() and str(repo_canonical) not in sys.path:
            sys.path.insert(0, str(repo_canonical))

    try:
        import datastack  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "datastack-sdk requires the canonical 'datastack>=2.2.0' package. "
            "Install it via `pip install ./sdk/python/datastack` or install "
            "`datastack>=2.2.0` from your package index."
        ) from exc


_ensure_canonical_datastack_on_path()

from datastack import (  # noqa: E402, F401
    ConnectionState,
    DataStack,
    DataStackAuthError,
    DataStackClient,
    DataStackConfig,
    DataStackConfigError,
    DataStackConnectionError,
    DataStackError,
    DataStackFileError,
    DataStackOfflineSpoolError,
    DataStackPayloadTooLargeError,
    DataStackQuotaExceededError,
    DataStackRateLimitError,
    DiskSpooler,
    HeartbeatMonitor,
    __version__,
    load_config,
)

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
    "DataStackQuotaExceededError",
    "DataStackFileError",
    "DataStackOfflineSpoolError",
]
