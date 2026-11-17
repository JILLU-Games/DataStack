"""Compatibility re-export of canonical `datastack.heartbeat`."""

from . import _ensure_canonical_datastack_on_path

_ensure_canonical_datastack_on_path()

from datastack.heartbeat import *  # noqa: E402, F401, F403
