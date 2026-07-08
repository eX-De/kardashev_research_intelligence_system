from __future__ import annotations

import os
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from worker import cli


class FakeConnection:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


@contextmanager
def without_lifecycle_env():
    names = (
        "KRIS_WORKER_TIMING_LOG",
    )
    previous = {name: os.environ.get(name) for name in names}
    try:
        for name in names:
            os.environ.pop(name, None)
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@contextmanager
def patched_db_lifecycle(stale_result: dict[str, object] | None = None):
    conn = FakeConnection()
    base_settings = object()
    stored_settings = object()
    with patch("worker.cli.load_settings", return_value=base_settings) as load_settings, \
        patch("worker.cli.connect", return_value=conn) as connect, \
        patch("worker.cli.init_db") as init_db, \
        patch(
            "worker.cli.mark_stale_job_runs",
            return_value=stale_result or {"stale_jobs_marked": 0},
        ) as mark_stale, \
        patch("worker.cli.apply_stored_settings", return_value=stored_settings) as apply_settings:
        yield SimpleNamespace(
            conn=conn,
            base_settings=base_settings,
            stored_settings=stored_settings,
            load_settings=load_settings,
            connect=connect,
            init_db=init_db,
            mark_stale=mark_stale,
            apply_settings=apply_settings,
        )


class WorkerCliLifecycleTests(unittest.TestCase):
    def test_with_db_skips_schema_init_and_stale_cleanup_by_default(self) -> None:
        with without_lifecycle_env(), patched_db_lifecycle() as lifecycle:
            result = cli._with_db(lambda conn, settings: {"same_context": (conn, settings)})

        self.assertEqual(result["same_context"], (lifecycle.conn, lifecycle.stored_settings))
        lifecycle.load_settings.assert_called_once_with()
        lifecycle.connect.assert_called_once_with()
        lifecycle.apply_settings.assert_called_once_with(lifecycle.conn, lifecycle.base_settings)
        lifecycle.init_db.assert_not_called()
        lifecycle.mark_stale.assert_not_called()
        self.assertTrue(lifecycle.conn.closed)

    def test_with_db_runs_explicit_schema_init_and_stale_cleanup(self) -> None:
        with without_lifecycle_env(), patched_db_lifecycle() as lifecycle:
            cli._with_db(lambda conn, settings: {"ok": True}, init_schema=True, cleanup_stale=True)

        lifecycle.init_db.assert_called_once_with(lifecycle.conn)
        lifecycle.mark_stale.assert_called_once_with(lifecycle.conn)
        self.assertTrue(lifecycle.conn.closed)

    def test_api_jobs_cleanup_invokes_single_explicit_stale_scan(self) -> None:
        with without_lifecycle_env(), patched_db_lifecycle({"stale_jobs_marked": 2}) as lifecycle, \
            patch("worker.cli._print_json") as print_json:
            cli.cmd_api_jobs_cleanup(SimpleNamespace())

        lifecycle.init_db.assert_not_called()
        lifecycle.mark_stale.assert_called_once_with(lifecycle.conn)
        print_json.assert_called_once_with({"ok": True, "stale_jobs_marked": 2})
        self.assertTrue(lifecycle.conn.closed)


if __name__ == "__main__":
    unittest.main()
