"""
Thread-Safe Offline Disk Spooler (`DiskSpooler`).
Persists unsent telemetry events to `.datastack_spool/spool.jsonl` when a client
device loses network connectivity completely, and drains them in deterministic
batches once the Heartbeat Monitor restores connectivity.
"""

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from .exceptions import DataStackOfflineSpoolError

logger = logging.getLogger("datastack.spool")


class DiskSpooler:
    """
    Append-only JSONL disk queue with atomic batch drainage and size cap protection.
    """

    def __init__(
        self,
        spool_dir: str = ".datastack_spool",
        max_size_mb: int = 50,
        enabled: bool = True,
    ) -> None:
        self.enabled = enabled
        self.spool_dir = Path(spool_dir)
        self.spool_file = self.spool_dir / "spool.jsonl"
        self.max_bytes = max(1, int(max_size_mb)) * 1024 * 1024
        self._lock = threading.RLock()

    def _ensure_dir(self) -> None:
        try:
            self.spool_dir.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            raise DataStackOfflineSpoolError(
                f"Cannot create offline spool directory '{self.spool_dir}': {exc}"
            ) from exc

    def enqueue(self, events: List[Dict[str, Any]]) -> int:
        """
        Appends one or more formatted events (`{eventId, timestamp, data}`)
        to `.datastack_spool/spool.jsonl`. Returns count of spooled events.
        """
        if not self.enabled or not events:
            return 0

        with self._lock:
            self._ensure_dir()
            current_size = (
                self.spool_file.stat().st_size if self.spool_file.exists() else 0
            )

            lines: List[str] = []
            added_bytes = 0
            for evt in events:
                serialized = json.dumps(evt, ensure_ascii=False) + "\n"
                encoded_len = len(serialized.encode("utf-8"))
                if current_size + added_bytes + encoded_len > self.max_bytes:
                    raise DataStackOfflineSpoolError(
                        f"Offline spool limit ({self.max_bytes // (1024 * 1024)} MB) "
                        f"reached at '{self.spool_file}'."
                    )
                lines.append(serialized)
                added_bytes += encoded_len

            try:
                with self.spool_file.open("a", encoding="utf-8") as fh:
                    fh.writelines(lines)
                    fh.flush()
            except Exception as exc:
                raise DataStackOfflineSpoolError(
                    f"Failed writing to offline spool file '{self.spool_file}': {exc}"
                ) from exc

            return len(lines)

    def peek_batch(self, limit: int = 250) -> List[Dict[str, Any]]:
        """
        Reads up to `limit` spooled events from the front of the spool file
        without removing them until `ack_batch()` confirms delivery.
        """
        if not self.enabled:
            return []

        with self._lock:
            if not self.spool_file.exists():
                return []

            batch: List[Dict[str, Any]] = []
            try:
                with self.spool_file.open("r", encoding="utf-8") as fh:
                    for line in fh:
                        if len(batch) >= limit:
                            break
                        stripped = line.strip()
                        if not stripped:
                            continue
                        try:
                            parsed = json.loads(stripped)
                            if isinstance(parsed, dict):
                                batch.append(parsed)
                        except json.JSONDecodeError:
                            continue
            except Exception:
                return []

            return batch

    def ack_batch(self, count: int) -> int:
        """
        Removes the first `count` non-empty lines from the spool file atomically
        after the Heartbeat Monitor confirms they have been ingested by DataStack.
        """
        if not self.enabled or count <= 0:
            return 0

        with self._lock:
            if not self.spool_file.exists():
                return 0

            tmp_file = self.spool_dir / "spool.jsonl.tmp"
            try:
                with self.spool_file.open("r", encoding="utf-8") as fh:
                    all_lines = [ln for ln in fh if ln.strip()]

                if count >= len(all_lines):
                    self.spool_file.unlink(missing_ok=True)
                    return len(all_lines)

                remaining = all_lines[count:]
                with tmp_file.open("w", encoding="utf-8") as fh:
                    fh.writelines(remaining)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(str(tmp_file), str(self.spool_file))
                return count
            except Exception as exc:
                tmp_file.unlink(missing_ok=True)
                logger.warning("[DataStack Spool] ack_batch failed: %s", exc)
                return 0

    def ack_and_requeue_front(
        self,
        acked_count: int,
        unprocessed: Optional[List[Dict[str, Any]]] = None,
    ) -> int:
        """
        Atomically removes `acked_count` head lines from `spool.jsonl` while
        preserving any `unprocessed` events at the FRONT of the queue in a single
        atomic `os.replace()` write (FIFO safe, zero crash-window data loss).
        """
        if not self.enabled or acked_count <= 0:
            return 0

        with self._lock:
            if not self.spool_file.exists():
                return 0

            tmp_file = self.spool_dir / "spool.jsonl.tmp"
            try:
                with self.spool_file.open("r", encoding="utf-8") as fh:
                    all_lines = [ln for ln in fh if ln.strip()]

                consumed = min(acked_count, len(all_lines))
                tail_lines = all_lines[consumed:]
                head_lines = [
                    json.dumps(evt, ensure_ascii=False) + "\n"
                    for evt in (unprocessed or [])
                ]
                combined = head_lines + tail_lines

                if not combined:
                    self.spool_file.unlink(missing_ok=True)
                    return consumed

                self._ensure_dir()
                with tmp_file.open("w", encoding="utf-8") as fh:
                    fh.writelines(combined)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(str(tmp_file), str(self.spool_file))
                return max(0, consumed - len(head_lines))
            except Exception as exc:
                tmp_file.unlink(missing_ok=True)
                logger.warning(
                    "[DataStack Spool] ack_and_requeue_front failed: %s", exc
                )
                return 0

    def pending_count(self) -> int:
        """Returns the number of queued events waiting in the disk spool."""
        if not self.enabled:
            return 0

        with self._lock:
            if not self.spool_file.exists():
                return 0
            try:
                with self.spool_file.open("r", encoding="utf-8") as fh:
                    return sum(1 for ln in fh if ln.strip())
            except Exception:
                return 0

    def size_bytes(self) -> int:
        """Returns current disk usage of the spool file in bytes."""
        with self._lock:
            if not self.spool_file.exists():
                return 0
            try:
                return self.spool_file.stat().st_size
            except Exception:
                return 0
