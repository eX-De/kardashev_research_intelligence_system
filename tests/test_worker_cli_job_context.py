from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from worker.cli import _job_context


class WorkerCliJobContextTests(unittest.TestCase):
    def test_worker_runtime_can_disable_implicit_job_run_creation(self) -> None:
        conn = Mock()
        with patch("worker.cli.job_run") as create_job_run:
            with _job_context(conn, "sync-obsidian", track_job_run=False) as job_run_id:
                self.assertIsNone(job_run_id)
        create_job_run.assert_not_called()

    def test_direct_cli_keeps_default_job_run_tracking(self) -> None:
        conn = Mock()
        context = Mock()
        with patch("worker.cli.job_run", return_value=context) as create_job_run:
            self.assertIs(_job_context(conn, "sync-obsidian"), context)
        create_job_run.assert_called_once_with(conn, "sync-obsidian")


if __name__ == "__main__":
    unittest.main()
