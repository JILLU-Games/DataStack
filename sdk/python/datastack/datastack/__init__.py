"""
DataStack Official Python SDK (`datastack`).
Supports automatic `config.datastack.py` configuration discovery, real-time
Socket.IO ingestion (Port 4000), automatic Heartbeat HTTP fallback (Port 3000),
offline disk spooling, and direct `.csv` / `.json` / `.jsonl` file streaming.
"""

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
from .spool import DiskSpooler

try:
    from .client import DataStack, DataStackClient
except ImportError:
    DataStack = None  # type: ignore
    DataStackClient = None  # type: ignore

__version__ = "2.2.0"

__all__ = [
    "DataStack",
    "DataStackClient",
    "DataStackConfig",
    "load_config",
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
