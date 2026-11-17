"""
Structured Exception Hierarchy for the DataStack Python SDK.
"""

from typing import Optional


class DataStackError(Exception):
    """Base exception for all DataStack SDK errors."""

    def __init__(
        self,
        message: str,
        code: Optional[str] = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code or "DATASTACK_ERROR"
        self.retryable = retryable


class DataStackConfigError(DataStackError):
    """Raised when `config.datastack.py` or required credentials are missing or invalid."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="CONFIG_ERROR", retryable=False)


class DataStackAuthError(DataStackError):
    """
    Raised when authentication fails (`AUTH_REQUIRED`, `AUTH_INVALID`,
    `CLIENT_REVOKED`, or `TOKEN_ROTATED`). Non-retryable until credentials are updated.
    """

    def __init__(self, message: str, code: str = "AUTH_ERROR") -> None:
        super().__init__(message, code=code, retryable=False)


class DataStackRateLimitError(DataStackError):
    """Raised when `RATE_LIMIT_EXCEEDED` persists after all backoff retries."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="RATE_LIMIT_EXCEEDED", retryable=True)


class DataStackPayloadTooLargeError(DataStackError):
    """Raised when a single event exceeds the server's `maxPayloadSizeKb` limit."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="PAYLOAD_TOO_LARGE", retryable=False)


class DataStackConnectionError(DataStackError):
    """Raised when both WebSocket and HTTP fallback are unreachable and offline spooling is disabled."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="CONNECTION_ERROR", retryable=True)


class DataStackFileError(DataStackError):
    """Raised when a file passed to `send_file()` is missing, unsupported, or malformed."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="FILE_ERROR", retryable=False)


class DataStackOfflineSpoolError(DataStackError):
    """Raised when the local offline disk spool directory is full or unwriteable."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="OFFLINE_SPOOL_ERROR", retryable=False)
