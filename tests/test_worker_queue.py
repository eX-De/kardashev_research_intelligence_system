from __future__ import annotations

import json
import unittest
from unittest.mock import Mock

from worker.queue import cleanup_stale_worker_jobs, task_event_payload


class Cursor:
    def __init__(self, *, row=None, rows=None, lastrowid: int = 1) -> None:
        self._row = row
        self._rows = rows or []
        self.lastrowid = lastrowid

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._row


def worker_job_row(**overrides):
    row = {
        "id": 7,
        "job_run_id": 42,
        "job_type": "generate-reports",
        "status": "running",
        "priority": 0,
        "payload_json": json.dumps({"command": "generate-reports", "source": "manual", "args": ["--limit", "1"]}),
        "result_json": "{}",
        "error_message": "",
        "attempts": 1,
        "max_attempts": 2,
        "run_after": None,
        "locked_by": "worker-a",
        "locked_at": "2026-07-06T10:01:00+00:00",
        "created_at": "2026-07-06T10:00:00+00:00",
        "updated_at": "2026-07-06T10:01:00+00:00",
        "started_at": "2026-07-06T10:01:00+00:00",
        "finished_at": None,
    }
    row.update(overrides)
    return row


class WorkerQueueTests(unittest.TestCase):
    def test_task_event_payload_matches_node_task_contract(self) -> None:
        payload = task_event_payload(
            {
                "id": 7,
                "job_run_id": 42,
                "job_type": "generate-reports",
                "payload": {"command": "generate-reports", "source": "manual", "args": ["--limit", "1"]},
                "started_at": "2026-07-06T10:01:00+00:00",
                "finished_at": "2026-07-06T10:02:00+00:00",
            },
            "completed",
            message="done",
            result={"ok": True, "message": "done", "ignored": "large payload"},
        )

        self.assertEqual(payload["task"]["id"], 42)
        self.assertEqual(payload["task"]["worker_job_id"], 7)
        self.assertEqual(payload["task"]["command"], "generate-reports")
        self.assertEqual(payload["task"]["source"], "manual")
        self.assertEqual(payload["task"]["args"], ["--limit", "1"])
        self.assertEqual(payload["task"]["status"], "completed")
        self.assertNotIn("job_id", payload["task"])
        self.assertEqual(payload["task"]["result"], {"ok": True, "message": "done"})

    def test_cleanup_stale_worker_jobs_commits_status_and_event_together(self) -> None:
        conn = Mock()
        current = worker_job_row()
        updated = worker_job_row(status="queued", locked_by="", locked_at=None, updated_at="2026-07-06T10:03:00+00:00")
        conn.execute.side_effect = [
            Cursor(rows=[current]),
            Cursor(row=updated),
            Cursor(),
            Cursor(lastrowid=99),
        ]

        result = cleanup_stale_worker_jobs(
            conn,
            stale_after_seconds=60,
            now="2026-07-06T10:03:00+00:00",
        )

        self.assertEqual(result["stale_worker_jobs_requeued"], 1)
        conn.commit.assert_called_once_with()
        conn.rollback.assert_not_called()
        insert_params = conn.execute.call_args_list[3].args[1]
        self.assertEqual(insert_params[0], "task.started")
        event_payload = json.loads(insert_params[1])
        self.assertTrue(event_payload["stale"])
        self.assertEqual(event_payload["task"]["id"], 42)
        self.assertEqual(event_payload["task"]["worker_job_id"], 7)
        self.assertEqual(event_payload["task"]["status"], "queued")

    def test_cleanup_stale_worker_jobs_rolls_back_when_event_insert_fails(self) -> None:
        conn = Mock()
        current = worker_job_row()
        updated = worker_job_row(status="queued", locked_by="", locked_at=None, updated_at="2026-07-06T10:03:00+00:00")
        conn.execute.side_effect = [
            Cursor(rows=[current]),
            Cursor(row=updated),
            Cursor(),
            RuntimeError("event insert failed"),
        ]

        with self.assertRaisesRegex(RuntimeError, "event insert failed"):
            cleanup_stale_worker_jobs(
                conn,
                stale_after_seconds=60,
                now="2026-07-06T10:03:00+00:00",
            )

        conn.commit.assert_not_called()
        conn.rollback.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
