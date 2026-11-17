"""
DataStack Python SDK (`datastack_sdk`)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Official Python client library for DataStack — Self-Hosted Real-Time Telemetry & Event Logging Platform.
"""

from .client import (
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
    DataStackRateLimitError,
    DiskSpooler,
    HeartbeatMonitor,
    load_config,
)

__version__ = "2.2.0"

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
