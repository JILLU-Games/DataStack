"""Compatibility re-export of canonical `datastack.config`."""

from . import _ensure_canonical_datastack_on_path

_ensure_canonical_datastack_on_path()

from datastack.config import *  # noqa: E402, F401, F403
