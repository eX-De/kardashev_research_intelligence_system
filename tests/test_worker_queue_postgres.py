from __future__ import annotations

import os
import unittest
import uuid

from worker.db import init_db, to_json
from worker.cli import _job_context
from worker.pg import connect_postgres
from worker.queue import (
    cancel_worker_job_before_dispatch,
    claim_next_worker_job,
    cleanup_stale_worker_jobs,
    complete_worker_job,
    fail_worker_job,
)


class WorkerQueuePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        database_url = os.environ.get("TEST_DATABASE_URL", "").strip()
        if not database_url:
            raise unittest.SkipTest("TEST_DATABASE_URL is not set; skipping isolated worker queue PostgreSQL tests")
        cls.schema = f"ris_worker_lifecycle_{uuid.uuid4().hex}"
        cls.conn = connect_postgres(database_url)
        cls.conn.execute(f'CREATE SCHEMA "{cls.schema}"')
        cls.conn.execute(f'SET search_path TO "{cls.schema}"')
        cls.conn.commit()
        try:
            init_db(cls.conn)
        except Exception:
            cls.conn.rollback()
            cls.conn.execute("SET search_path TO public")
            cls.conn.execute(f'DROP SCHEMA IF EXISTS "{cls.schema}" CASCADE')
            cls.conn.commit()
            cls.conn.close()
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.rollback()
        cls.conn.execute("SET search_path TO public")
        cls.conn.execute(f'DROP SCHEMA IF EXISTS "{cls.schema}" CASCADE')
        cls.conn.commit()
        cls.conn.close()

    def setUp(self) -> None:
        self.conn.execute("TRUNCATE app_events, worker_instances, worker_jobs, job_runs RESTART IDENTITY CASCADE")
        self.conn.commit()

    def _enqueue(self, *, max_attempts: int = 2) -> int:
        now = "2026-08-05T10:00:00+00:00"
        job_run_id = int(self.conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, message, heartbeat_at, meta_json)
            VALUES (?, 'queued', ?, 'Queued', ?, ?)
            RETURNING id
            """,
            ("generate-reports", now, now, to_json({"worker_job": True})),
        ).fetchone()["id"])
        worker_job_id = int(self.conn.execute(
            """
            INSERT INTO worker_jobs(
              job_run_id, job_type, status, payload_json, max_attempts, created_at, updated_at
            )
            VALUES (?, 'generate-reports', 'queued', ?, ?, ?, ?)
            RETURNING id
            """,
            (job_run_id, to_json({"command": "generate-reports"}), max_attempts, now, now),
        ).fetchone()["id"])
        self.conn.commit()
        return worker_job_id

    def test_worker_runtime_job_context_does_not_create_job_run(self) -> None:
        with _job_context(self.conn, "sync-obsidian", track_job_run=False) as job_run_id:
            self.assertIsNone(job_run_id)
        self.assertEqual(
            int(self.conn.execute("SELECT COUNT(1) AS count FROM job_runs").fetchone()["count"]),
            0,
        )

    def test_stale_worker_is_requeued_and_old_lease_cannot_complete(self) -> None:
        worker_job_id = self._enqueue(max_attempts=2)
        first = claim_next_worker_job(self.conn, "worker-dead", now="2026-08-05T10:01:00+00:00")
        self.assertEqual(first["worker_job"]["attempts"], 1)
        self.conn.execute(
            "UPDATE worker_jobs SET locked_at = ? WHERE id = ?",
            ("2026-08-05T10:01:00+00:00", worker_job_id),
        )
        self.conn.commit()

        recovered = cleanup_stale_worker_jobs(
            self.conn,
            stale_after_seconds=60,
            now="2026-08-05T10:03:00+00:00",
        )
        self.assertEqual(recovered["stale_worker_jobs_requeued"], 1)
        second = claim_next_worker_job(self.conn, "worker-new", now="2026-08-05T10:04:00+00:00")
        self.assertEqual(second["worker_job"]["attempts"], 2)

        with self.assertRaisesRegex(RuntimeError, "lease lost"):
            complete_worker_job(
                self.conn,
                worker_job_id,
                {"ok": True},
                worker_id="worker-dead",
                lease_attempt=1,
            )
        completed = complete_worker_job(
            self.conn,
            worker_job_id,
            {"ok": True},
            worker_id="worker-new",
            lease_attempt=2,
        )
        self.assertEqual(completed["worker_job"]["status"], "completed")
        event_types = [row["event_type"] for row in self.conn.execute(
            "SELECT event_type FROM app_events ORDER BY id"
        ).fetchall()]
        self.assertEqual(event_types, ["task.started", "task.started", "task.started", "task.finished"])

    def _request_running_cancellation(self, worker_job_id: int) -> None:
        self.conn.execute(
            "UPDATE worker_jobs SET cancel_requested_at = ?, cancel_reason = ? WHERE id = ?",
            ("2026-08-05T10:01:30+00:00", "Stopped by user", worker_job_id),
        )
        self.conn.commit()

    def test_pre_dispatch_cancel_request_becomes_cancelled(self) -> None:
        worker_job_id = self._enqueue()
        claimed = claim_next_worker_job(self.conn, "worker-a", now="2026-08-05T10:01:00+00:00")
        self._request_running_cancellation(worker_job_id)

        result = cancel_worker_job_before_dispatch(
            self.conn,
            worker_job_id,
            worker_id="worker-a",
            lease_attempt=int(claimed["worker_job"]["attempts"]),
            now="2026-08-05T10:02:00+00:00",
        )
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["worker_job"]["status"], "cancelled")
        self.assertEqual(
            self.conn.execute("SELECT event_type FROM app_events ORDER BY id DESC LIMIT 1").fetchone()["event_type"],
            "task.cancelled",
        )

    def test_late_cancel_request_cannot_override_successful_handler(self) -> None:
        worker_job_id = self._enqueue()
        claimed = claim_next_worker_job(self.conn, "worker-a", now="2026-08-05T10:01:00+00:00")
        self._request_running_cancellation(worker_job_id)

        result = complete_worker_job(
            self.conn,
            worker_job_id,
            {"ok": True, "side_effect_id": 27},
            worker_id="worker-a",
            lease_attempt=int(claimed["worker_job"]["attempts"]),
            now="2026-08-05T10:02:00+00:00",
        )
        self.assertFalse(result["cancelled"])
        self.assertEqual(result["worker_job"]["status"], "completed")
        self.assertEqual(
            self.conn.execute("SELECT event_type FROM app_events ORDER BY id DESC LIMIT 1").fetchone()["event_type"],
            "task.finished",
        )

    def test_late_cancel_request_cannot_override_handler_failure(self) -> None:
        worker_job_id = self._enqueue()
        claimed = claim_next_worker_job(self.conn, "worker-a", now="2026-08-05T10:01:00+00:00")
        self._request_running_cancellation(worker_job_id)

        result = fail_worker_job(
            self.conn,
            worker_job_id,
            "handler failed after starting",
            worker_id="worker-a",
            lease_attempt=int(claimed["worker_job"]["attempts"]),
            now="2026-08-05T10:02:00+00:00",
        )
        self.assertFalse(result["cancelled"])
        self.assertEqual(result["worker_job"]["status"], "failed")
        self.assertEqual(
            self.conn.execute("SELECT event_type FROM app_events ORDER BY id DESC LIMIT 1").fetchone()["event_type"],
            "task.failed",
        )

    def test_terminal_state_rolls_back_when_outbox_insert_fails(self) -> None:
        worker_job_id = self._enqueue()
        claimed = claim_next_worker_job(self.conn, "worker-a", now="2026-08-05T10:01:00+00:00")
        self.conn.execute(
            """
            CREATE FUNCTION reject_task_finished() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.event_type = 'task.finished' THEN
                RAISE EXCEPTION 'blocked task.finished';
              END IF;
              RETURN NEW;
            END;
            $$;
            """
        )
        self.conn.execute(
            """
            CREATE TRIGGER reject_task_finished_trigger
            BEFORE INSERT ON app_events
            FOR EACH ROW EXECUTE FUNCTION reject_task_finished();
            """
        )
        self.conn.commit()
        try:
            with self.assertRaisesRegex(Exception, "blocked task.finished"):
                complete_worker_job(
                    self.conn,
                    worker_job_id,
                    {"ok": True},
                    worker_id="worker-a",
                    lease_attempt=int(claimed["worker_job"]["attempts"]),
                )
            row = self.conn.execute(
                "SELECT status, locked_by, attempts FROM worker_jobs WHERE id = ?",
                (worker_job_id,),
            ).fetchone()
            self.assertEqual(row["status"], "running")
            self.assertEqual(row["locked_by"], "worker-a")
            self.assertEqual(int(row["attempts"]), 1)
        finally:
            self.conn.execute("DROP TRIGGER IF EXISTS reject_task_finished_trigger ON app_events")
            self.conn.execute("DROP FUNCTION IF EXISTS reject_task_finished()")
            self.conn.commit()


if __name__ == "__main__":
    unittest.main()
