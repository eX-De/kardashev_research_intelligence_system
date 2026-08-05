from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager
from typing import Iterator


_NAMESPACES = {"llm": 78101, "embedding": 78102}
_LOCAL_LOCK = threading.Lock()
_LOCAL: dict[str, dict[str, object]] = {}


def _local_state(kind: str) -> dict[str, object]:
    with _LOCAL_LOCK:
        if kind not in _LOCAL:
            _LOCAL[kind] = {"active": 0, "condition": threading.Condition()}
        return _LOCAL[kind]


@contextmanager
def outbound_request_slot(kind: str, limit: int) -> Iterator[None]:
    """Hold one global request slot for the full outbound request lifetime."""
    normalized = str(kind or "").strip().lower()
    if normalized not in _NAMESPACES:
        raise ValueError(f"Unknown outbound request resource: {kind}")
    configured = max(1, int(limit or 1))
    backend = str(os.getenv("KRIS_RESOURCE_LIMITER_BACKEND", "auto")).strip().lower()
    if backend == "auto":
        from .db import database_url_from_env
        backend = "postgres" if database_url_from_env() else "local"
    if backend in {"local", "sqlite", "test"}:
        state = _local_state(normalized)
        condition = state["condition"]
        assert isinstance(condition, threading.Condition)
        with condition:
            while int(state["active"]) >= configured:
                condition.wait()
            state["active"] = int(state["active"]) + 1
        try:
            yield
        finally:
            with condition:
                state["active"] = int(state["active"]) - 1
                condition.notify_all()
        return

    from .db import connect

    lock_conn = connect()
    acquired_slot: int | None = None
    deadline = time.monotonic() + max(1.0, float(os.getenv("KRIS_RESOURCE_SLOT_WAIT_SECONDS", "300")))
    try:
        while acquired_slot is None:
            namespace = _NAMESPACES[normalized]
            lock_conn.execute("SELECT pg_advisory_lock(?, -1)", (namespace,))
            try:
                occupied = lock_conn.execute(
                    """SELECT COUNT(*) AS count FROM pg_locks
                       WHERE locktype = 'advisory' AND granted AND classid = ?::oid
                         AND objid <> 4294967295::oid""",
                    (namespace,),
                ).fetchone()
                if int(occupied["count"] or 0) < configured:
                    for slot in range(1024):
                        row = lock_conn.execute(
                            "SELECT pg_try_advisory_lock(?, ?) AS acquired",
                            (namespace, slot),
                        ).fetchone()
                        if row and bool(row["acquired"]):
                            acquired_slot = slot
                            break
            finally:
                lock_conn.execute("SELECT pg_advisory_unlock(?, -1)", (namespace,))
            if acquired_slot is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for global {normalized} request slot")
                time.sleep(0.025)
        yield
    finally:
        if acquired_slot is not None:
            try:
                lock_conn.execute("SELECT pg_advisory_unlock(?, ?)", (_NAMESPACES[normalized], acquired_slot))
            except Exception:
                pass
        lock_conn.close()
