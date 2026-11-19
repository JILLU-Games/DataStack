"""
Auto-Discovery Configuration Loader for `config.datastack.py`.
"""

import importlib.util
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from .exceptions import DataStackConfigError

CONFIG_FILENAME = "config.datastack.py"


@dataclass
class DataStackConfig:
    server_url: str = "http://localhost:4000"
    api_url: str = "http://localhost:3000"
    client_token: str = ""
    client_id: str = ""
    auto_connect: bool = True
    enable_http_fallback: bool = True
    heartbeat_interval_sec: float = 5.0
    request_timeout_sec: float = 8.0
    max_retries: int = 3
    retry_backoff_base_sec: float = 0.5
    batch_chunk_size: int = 250
    offline_spool_enabled: bool = True
    offline_spool_dir: str = ".datastack_spool"
    max_spool_size_mb: int = 50
    config_source_path: Optional[str] = None


def _derive_default_api_url(server_url: str) -> str:
    """
    If API_URL is not explicitly set, infer Port 3000 on the same host when SERVER_URL
    uses Port 4000, or fall back to http://localhost:3000.
    """
    try:
        parsed = urlparse(server_url)
        if parsed.scheme and parsed.hostname:
            if parsed.port == 4000:
                return f"{parsed.scheme}://{parsed.hostname}:3000"
            return f"{parsed.scheme}://{parsed.netloc}"
    except Exception:
        pass
    return "http://localhost:3000"


def _candidate_config_paths(explicit_path: Optional[str] = None) -> List[Path]:
    candidates: List[Path] = []

    if explicit_path:
        p = Path(explicit_path).expanduser().resolve()
        if p.is_dir():
            candidates.append(p / CONFIG_FILENAME)
        else:
            candidates.append(p)

    env_path = os.environ.get("DATASTACK_CONFIG_PATH", "").strip()
    if env_path:
        ep = Path(env_path).expanduser().resolve()
        if ep.is_dir():
            candidates.append(ep / CONFIG_FILENAME)
        else:
            candidates.append(ep)

    # Search current working directory and up to 3 parent levels
    try:
        cwd = Path.cwd().resolve()
        candidates.append(cwd / CONFIG_FILENAME)
        for parent in list(cwd.parents)[:3]:
            candidates.append(parent / CONFIG_FILENAME)
    except Exception:
        pass

    # Search main entry script directory
    try:
        if sys.argv and sys.argv[0]:
            script_dir = Path(sys.argv[0]).resolve().parent
            candidates.append(script_dir / CONFIG_FILENAME)
            for parent in list(script_dir.parents)[:2]:
                candidates.append(parent / CONFIG_FILENAME)
    except Exception:
        pass

    # Deduplicate while preserving order
    seen = set()
    unique: List[Path] = []
    for c in candidates:
        key = str(c)
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique


def _load_python_config_file(file_path: Path) -> Dict[str, Any]:
    try:
        spec = importlib.util.spec_from_file_location(
            "datastack_user_config", str(file_path)
        )
        if spec is None or spec.loader is None:
            raise DataStackConfigError(
                f"Unable to load configuration specification from {file_path}"
            )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        raw: Dict[str, Any] = {}
        if hasattr(module, "DATASTACK_CONFIG") and isinstance(
            getattr(module, "DATASTACK_CONFIG"), dict
        ):
            raw.update(getattr(module, "DATASTACK_CONFIG"))

        # Also support top-level module variables (e.g., SERVER_URL = "...", CLIENT_TOKEN = "...")
        for attr in dir(module):
            if attr.isupper() and attr != "DATASTACK_CONFIG":
                raw[attr] = getattr(module, attr)

        return raw
    except DataStackConfigError:
        raise
    except Exception as exc:
        raise DataStackConfigError(
            f"Failed to parse {file_path}: {exc}"
        ) from exc


def load_config(
    config_path: Optional[str] = None,
    require_token: bool = False,
    **overrides: Any,
) -> DataStackConfig:
    """
    Discovers and loads `config.datastack.py` from the client application's
    directory, merges environment variables (`DATASTACK_*`), and applies
    any explicit keyword overrides.
    """
    file_values: Dict[str, Any] = {}
    resolved_source: Optional[str] = None

    for candidate in _candidate_config_paths(config_path):
        if candidate.is_file():
            file_values = _load_python_config_file(candidate)
            resolved_source = str(candidate)
            break

    if config_path and not resolved_source:
        raise DataStackConfigError(
            f"Explicitly requested config file was not found: {config_path}"
        )

    # Normalize keys to uppercase for lookup
    normalized_file = {str(k).upper(): v for k, v in file_values.items()}
    normalized_overrides = {
        str(k).upper(): v for k, v in overrides.items() if v is not None
    }

    def pick(keys: List[str], env_keys: List[str], default: Any) -> Any:
        for k in keys:
            if k in normalized_overrides:
                return normalized_overrides[k]
        for ek in env_keys:
            env_val = os.environ.get(ek)
            if env_val is not None and str(env_val).strip() != "":
                return env_val
        for k in keys:
            if k in normalized_file and normalized_file[k] is not None:
                return normalized_file[k]
        return default

    def to_bool(val: Any, default: bool) -> bool:
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.strip().lower() in ("1", "true", "yes", "on")
        if val is None:
            return default
        return bool(val)

    def to_float(val: Any, name: str) -> float:
        try:
            return float(val)
        except (TypeError, ValueError) as exc:
            raise DataStackConfigError(
                f"Invalid numeric configuration for '{name}': {val!r}"
            ) from exc

    def to_int(val: Any, name: str) -> int:
        try:
            return int(val)
        except (TypeError, ValueError) as exc:
            raise DataStackConfigError(
                f"Invalid integer configuration for '{name}': {val!r}"
            ) from exc

    server_url = str(
        pick(
            ["SERVER_URL", "SOCKET_URL", "WS_URL"],
            ["DATASTACK_SERVER_URL", "DATASTACK_SOCKET_URL"],
            "http://localhost:4000",
        )
    ).rstrip("/")

    default_api = _derive_default_api_url(server_url)
    api_url = str(
        pick(
            ["API_URL", "HTTP_URL", "WEB_URL"],
            ["DATASTACK_API_URL", "DATASTACK_HTTP_URL"],
            default_api,
        )
    ).rstrip("/")

    client_token = str(
        pick(
            ["CLIENT_TOKEN", "TOKEN", "JWT_TOKEN", "API_TOKEN"],
            ["DATASTACK_CLIENT_TOKEN", "DATASTACK_TOKEN"],
            "",
        )
    ).strip()

    client_id = str(
        pick(
            ["CLIENT_ID"],
            ["DATASTACK_CLIENT_ID"],
            "",
        )
    ).strip()

    cfg = DataStackConfig(
        server_url=server_url,
        api_url=api_url,
        client_token=client_token,
        client_id=client_id,
        auto_connect=to_bool(
            pick(["AUTO_CONNECT"], ["DATASTACK_AUTO_CONNECT"], True), True
        ),
        enable_http_fallback=to_bool(
            pick(
                ["ENABLE_HTTP_FALLBACK", "HTTP_FALLBACK"],
                ["DATASTACK_ENABLE_HTTP_FALLBACK"],
                True,
            ),
            True,
        ),
        heartbeat_interval_sec=max(
            1.0,
            to_float(
                pick(
                    ["HEARTBEAT_INTERVAL_SEC", "HEARTBEAT_INTERVAL"],
                    ["DATASTACK_HEARTBEAT_INTERVAL_SEC"],
                    5.0,
                ),
                "HEARTBEAT_INTERVAL_SEC",
            ),
        ),
        request_timeout_sec=max(
            1.0,
            to_float(
                pick(
                    ["REQUEST_TIMEOUT_SEC", "TIMEOUT"],
                    ["DATASTACK_REQUEST_TIMEOUT_SEC"],
                    8.0,
                ),
                "REQUEST_TIMEOUT_SEC",
            ),
        ),
        max_retries=max(
            0,
            to_int(
                pick(
                    ["MAX_RETRIES", "RETRIES"],
                    ["DATASTACK_MAX_RETRIES"],
                    3,
                ),
                "MAX_RETRIES",
            ),
        ),
        retry_backoff_base_sec=max(
            0.1,
            to_float(
                pick(
                    ["RETRY_BACKOFF_BASE_SEC"],
                    ["DATASTACK_RETRY_BACKOFF_BASE_SEC"],
                    0.5,
                ),
                "RETRY_BACKOFF_BASE_SEC",
            ),
        ),
        batch_chunk_size=max(
            1,
            to_int(
                pick(
                    ["BATCH_CHUNK_SIZE", "CHUNK_SIZE"],
                    ["DATASTACK_BATCH_CHUNK_SIZE"],
                    250,
                ),
                "BATCH_CHUNK_SIZE",
            ),
        ),
        offline_spool_enabled=to_bool(
            pick(
                ["OFFLINE_SPOOL_ENABLED"],
                ["DATASTACK_OFFLINE_SPOOL_ENABLED"],
                True,
            ),
            True,
        ),
        offline_spool_dir=str(
            pick(
                ["OFFLINE_SPOOL_DIR", "SPOOL_DIR"],
                ["DATASTACK_OFFLINE_SPOOL_DIR"],
                ".datastack_spool",
            )
        ),
        max_spool_size_mb=max(
            1,
            to_int(
                pick(
                    ["MAX_SPOOL_SIZE_MB"],
                    ["DATASTACK_MAX_SPOOL_SIZE_MB"],
                    50,
                ),
                "MAX_SPOOL_SIZE_MB",
            ),
        ),
        config_source_path=resolved_source,
    )

    if require_token and (
        not cfg.client_token
        or cfg.client_token == "REPLACE_WITH_YOUR_CLIENT_JWT_TOKEN"
    ):
        raise DataStackConfigError(
            "DataStack CLIENT_TOKEN is missing. Add your token to `config.datastack.py`, "
            "set DATASTACK_TOKEN in your environment, or pass token='...' to DataStack()."
        )

    return cfg
