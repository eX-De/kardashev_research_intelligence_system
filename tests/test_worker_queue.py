from __future__ import annotations

import json
import unittest
from unittest.mock import Mock

from worker.queue import (
    cancel_worker_job_before_dispatch,
    claim_next_worker_job,
    cleanup_stale_worker_jobs,
    complete_worker_job,
    fail_worker_job,
    heartbeat_worker,
    heartbeat_worker_job,
    task_event_payload,
)


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
        "cancel_requested_at": None,
        "cancel_reason": "",
        "created_at": "2026-07-06T10:00:00+00:00",
        "updated_at": "2026-07-06T10:01:00+00:00",
        "started_at": "2026-07-06T10:01:00+00:00",
        "finished_at": None,
    }
    row.update(overrides)
    return row


class WorkerQueueTests(unittest.TestCase):
    def test_claim_rolls_back_running_state_when_outbox_insert_fails(self) -> None:
        conn = Mock()
        queued = worker_job_row(status="queued", attempts=0, locked_by="", locked_at=None)
        running = worker_job_row(status="running", attempts=1)
        conn.execute.side_effect = [
            Cursor(row=queued),
            Cursor(row=running),
            Cursor(row={
                "id": 42,
                "job_type": "generate-reports",
                "status": "running",
                "started_at": "2026-07-06T10:00:00+00:00",
                "finished_at": None,
                "message": "Claimed by worker worker-a",
                "pid": None,
                "heartbeat_at": "2026-07-06T10:01:00+00:00",
                "meta_json": "{}",
            }),
            RuntimeError("outbox insert failed"),
        ]

        with self.assertRaisesRegex(RuntimeError, "outbox insert failed"):
            claim_next_worker_job(conn, "worker-a", now="2026-07-06T10:01:00+00:00")

        conn.commit.assert_not_called()
        conn.rollback.assert_called_once_with()

    def test_worker_heartbeat_upserts_idle_instance(self) -> None:
        conn = Mock()
        conn.execute.return_value = Cursor(row={
            "worker_id": "worker-a",
            "status": "idle",
            "started_at": "2026-08-01T10:00:00+00:00",
            "heartbeat_at": "2026-08-01T10:00:05+00:00",
            "current_job_id": None,
            "pid": 123,
            "meta_json": "{}",
        })

        result = heartbeat_worker(
            conn,
            "worker-a",
            started_at="2026-08-01T10:00:00+00:00",
            pid=123,
            now="2026-08-01T10:00:05+00:00",
        )

        self.assertEqual(result["worker_id"], "worker-a")
        self.assertEqual(result["status"], "idle")
        conn.commit.assert_called_once_with()

    def test_worker_job_heartbeat_renews_lock_and_job_run(self) -> None:
        conn = Mock()
        conn.execute.side_effect = [Cursor(row={"job_run_id": 42}), Cursor()]

        renewed = heartbeat_worker_job(
            conn,
            "worker-a",
            7,
            1,
            now="2026-08-01T10:00:05+00:00",
        )

        self.assertTrue(renewed)
        self.assertIn("UPDATE worker_jobs", conn.execute.call_args_list[0].args[0])
        self.assertIn("UPDATE job_runs", conn.execute.call_args_list[1].args[0])
        conn.commit.assert_called_once_with()

    def test_completion_rejects_a_worker_that_lost_its_lease(self) -> None:
        conn = Mock()
        conn.execute.return_value = Cursor(row=None)

        with self.assertRaisesRegex(RuntimeError, "lease lost"):
            complete_worker_job(
                conn,
                7,
                {"ok": True},
                worker_id="worker-old",
                lease_attempt=1,
            )

        params = conn.execute.call_args.args[1]
        self.assertEqual(params[-2:], ("worker-old", 1))
        conn.commit.assert_not_called()
        conn.rollback.assert_called_once_with()

    def test_completion_requires_owner_and_lease_generation(self) -> None:
        conn = Mock()

        with self.assertRaisesRegex(ValueError, "worker_id is required"):
            complete_worker_job(conn, 7, {"ok": True}, worker_id="", lease_attempt=1)
        with self.assertRaisesRegex(ValueError, "lease_attempt"):
            complete_worker_job(conn, 7, {"ok": True}, worker_id="worker-a", lease_attempt=0)

        conn.execute.assert_not_called()

    def test_failure_requires_owner_and_lease_generation(self) -> None:
        conn = Mock()

        with self.assertRaisesRegex(ValueError, "worker_id is required"):
            fail_worker_job(conn, 7, "failed", worker_id="", lease_attempt=1)
        with self.assertRaisesRegex(ValueError, "lease_attempt"):
            fail_worker_job(conn, 7, "failed", worker_id="worker-a", lease_attempt=0)

        conn.execute.assert_not_called()

    def test_pre_dispatch_cancel_is_terminal_and_event_is_in_same_transaction(self) -> None:
        conn = Mock()
        cancelled = worker_job_row(
            status="cancelled",
            locked_by="",
            locked_at=None,
            cancel_requested_at="2026-08-01T10:00:00+00:00",
            cancel_reason="Stopped by user",
            finished_at="2026-08-01T10:00:01+00:00",
        )
        conn.execute.side_effect = [
            Cursor(row=cancelled),
            Cursor(row={
                "id": 42,
                "job_type": "generate-reports",
                "status": "cancelled",
                "started_at": "2026-07-06T10:00:00+00:00",
                "finished_at": "2026-08-01T10:00:01+00:00",
                "message": "Stopped by user",
                "pid": None,
                "heartbeat_at": "2026-08-01T10:00:01+00:00",
                "meta_json": "{}",
            }),
            Cursor(lastrowid=99),
        ]

        result = cancel_worker_job_before_dispatch(
            conn,
            7,
            worker_id="worker-a",
            lease_attempt=1,
            message="Stopped by user",
            now="2026-08-01T10:00:01+00:00",
        )

        self.assertTrue(result["cancelled"])
        self.assertEqual(result["worker_job"]["status"], "cancelled")
        self.assertEqual(conn.execute.call_args_list[2].args[1][0], "task.cancelled")
        conn.commit.assert_called_once_with()

    def test_terminal_transition_rolls_back_when_outbox_insert_fails(self) -> None:
        conn = Mock()
        completed = worker_job_row(
            status="completed",
            result_json=json.dumps({"ok": True}),
            finished_at="2026-08-01T10:00:01+00:00",
        )
        conn.execute.side_effect = [
            Cursor(row=completed),
            Cursor(row={
                "id": 42,
                "job_type": "generate-reports",
                "status": "completed",
                "started_at": "2026-07-06T10:00:00+00:00",
                "finished_at": "2026-08-01T10:00:01+00:00",
                "message": "done",
                "pid": None,
                "heartbeat_at": "2026-08-01T10:00:01+00:00",
                "meta_json": "{}",
            }),
            RuntimeError("outbox insert failed"),
        ]

        with self.assertRaisesRegex(RuntimeError, "outbox insert failed"):
            complete_worker_job(
                conn,
                7,
                {"ok": True},
                worker_id="worker-a",
                lease_attempt=1,
                now="2026-08-01T10:00:01+00:00",
            )

        conn.commit.assert_not_called()
        conn.rollback.assert_called_once_with()

    def test_completion_wins_over_a_cancel_requested_after_dispatch(self) -> None:
        conn = Mock()
        completed = worker_job_row(
            status="completed",
            result_json=json.dumps({"ok": True}),
            cancel_requested_at="2026-08-01T10:00:30+00:00",
            cancel_reason="Too late",
            finished_at="2026-08-01T10:01:00+00:00",
        )
        conn.execute.side_effect = [
            Cursor(row=completed),
            Cursor(row={
                "id": 42, "job_type": "generate-reports", "status": "completed",
                "started_at": None, "finished_at": "2026-08-01T10:01:00+00:00",
                "message": "done", "pid": None, "heartbeat_at": None, "meta_json": "{}",
            }),
            Cursor(lastrowid=99),
        ]

        result = complete_worker_job(
            conn,
            7,
            {"ok": True},
            worker_id="worker-a",
            lease_attempt=1,
            now="2026-08-01T10:01:00+00:00",
        )

        self.assertFalse(result["cancelled"])
        self.assertEqual(result["worker_job"]["status"], "completed")
        self.assertEqual(conn.execute.call_args_list[2].args[1][0], "task.finished")

    def test_failure_wins_over_a_cancel_requested_after_dispatch(self) -> None:
        conn = Mock()
        failed = worker_job_row(
            status="failed",
            error_message="handler failed",
            cancel_requested_at="2026-08-01T10:00:30+00:00",
            cancel_reason="Too late",
            finished_at="2026-08-01T10:01:00+00:00",
        )
        conn.execute.side_effect = [
            Cursor(row=failed),
            Cursor(row={
                "id": 42, "job_type": "generate-reports", "status": "failed",
                "started_at": None, "finished_at": "2026-08-01T10:01:00+00:00",
                "message": "handler failed", "pid": None, "heartbeat_at": None, "meta_json": "{}",
            }),
            Cursor(lastrowid=99),
        ]

        result = fail_worker_job(
            conn,
            7,
            "handler failed",
            worker_id="worker-a",
            lease_attempt=1,
            now="2026-08-01T10:01:00+00:00",
        )

        self.assertFalse(result["cancelled"])
        self.assertEqual(result["worker_job"]["status"], "failed")
        self.assertEqual(conn.execute.call_args_list[2].args[1][0], "task.failed")

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
