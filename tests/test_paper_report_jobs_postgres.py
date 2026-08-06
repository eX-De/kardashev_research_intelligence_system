from __future__ import annotations

import json
import os
from types import SimpleNamespace
import threading
import unittest
import uuid
from unittest.mock import patch

from worker.db import init_db, to_json, utc_now
from worker import service
from worker.paper_reports import (
    PaperReportCancellationRequested,
    PaperReportSuperseded,
    ensure_paper_report_worker_job,
    run_paper_report_worker_job,
    stage_paper_report_terminal_failure,
)
from worker.pg import connect_postgres
from worker.queue import (
    cancel_worker_job_before_dispatch,
    cleanup_stale_worker_jobs,
    complete_worker_job,
    fail_worker_job,
)


class PaperReportJobPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        database_url = os.environ.get("TEST_DATABASE_URL", "").strip()
        if not database_url:
            raise unittest.SkipTest("TEST_DATABASE_URL is not set; skipping paper-report PostgreSQL tests")
        cls.database_url = database_url
        cls.schema = f"ris_paper_report_worker_{uuid.uuid4().hex}"
        cls.conn = connect_postgres(database_url)
        cls.conn.execute(f'CREATE SCHEMA "{cls.schema}"')
        cls.conn.execute(f'SET search_path TO "{cls.schema}"')
        cls.conn.commit()
        init_db(cls.conn)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.rollback()
        cls.conn.execute("SET search_path TO public")
        cls.conn.execute(f'DROP SCHEMA IF EXISTS "{cls.schema}" CASCADE')
        cls.conn.commit()
        cls.conn.close()

    def setUp(self) -> None:
        self.conn.execute("TRUNCATE app_events, worker_instances, worker_jobs, job_runs, artifacts, papers RESTART IDENTITY CASCADE")
        self.conn.commit()
        self.settings = SimpleNamespace(
            paper_report_provider_id="provider",
            llm_chat_provider_id="provider",
            paper_report_model="model",
            llm_chat_model="model",
            llm_embedding_model="embedding-model",
        )

    def _paper(self, title: str) -> int:
        now = utc_now()
        row = self.conn.execute(
            """
            INSERT INTO papers(canonical_key, title, authors_json, abstract, library_status, reading_state,
                               user_tags_json, created_at, updated_at)
            VALUES (?, ?, '[]', '', 'candidate', 'unread', '[]', ?, ?) RETURNING id
            """,
            (f"manual:{uuid.uuid4().hex}", title, now, now),
        ).fetchone()
        self.conn.commit()
        return int(row["id"])

    def _materialized(self, title: str = "Report paper") -> tuple[int, dict]:
        paper_id = self._paper(title)
        queued = ensure_paper_report_worker_job(
            self.conn,
            paper_id,
            source="test",
            prompt="Summarize",
        )
        row = self.conn.execute("SELECT * FROM worker_jobs WHERE id = ?", (queued["worker_job_id"],)).fetchone()
        job = dict(row)
        job["payload"] = json.loads(job["payload_json"])
        return paper_id, job

    def _mark_running(self, job_id: int, *, attempts: int = 1, locked_at: str | None = None) -> dict:
        when = locked_at or utc_now()
        row = self.conn.execute(
            """
            UPDATE worker_jobs SET status = 'running', locked_by = 'worker-test', attempts = ?,
                                   locked_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE id = ? RETURNING *
            """,
            (attempts, when, when, when, job_id),
        ).fetchone()
        self.conn.commit()
        result = dict(row)
        result["payload"] = json.loads(result["payload_json"])
        return result

    def test_success_and_failure_terminal_state_share_worker_transaction(self) -> None:
        paper_id, queued = self._materialized("Successful paper")
        job = self._mark_running(int(queued["id"]))
        with patch("worker.paper_reports._ensure_full_text", return_value="full text"), patch(
            "worker.paper_reports._call_chat_text",
            return_value=json.dumps({"title": "Successful paper", "markdown": "# Done"}),
        ):
            result = run_paper_report_worker_job(self.conn, self.settings, job)
        observer = connect_postgres(self.database_url)
        observer.execute(f'SET search_path TO "{self.schema}"')
        observer.commit()
        self.assertEqual(observer.execute("SELECT status FROM artifacts WHERE scope_id = ?", (paper_id,)).fetchone()["status"], "processing")
        self.assertEqual(observer.execute("SELECT status FROM worker_jobs WHERE id = ?", (job["id"],)).fetchone()["status"], "running")
        domain_events = result.pop("domain_events")
        complete_worker_job(
            self.conn,
            int(job["id"]),
            result,
            worker_id="worker-test",
            lease_attempt=1,
            domain_events=domain_events,
        )
        self.assertEqual(self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (job["id"],)).fetchone()["status"], "completed")
        events = [row["event_type"] for row in self.conn.execute("SELECT event_type FROM app_events ORDER BY id").fetchall()]
        self.assertIn("task.finished", events)
        self.assertIn("paper_report.updated", events)
        self.assertEqual(observer.execute("SELECT status FROM artifacts WHERE scope_id = ?", (paper_id,)).fetchone()["status"], "done")
        observer.close()

        failed_paper_id, failed_queued = self._materialized("Failed paper")
        failed_job = self._mark_running(int(failed_queued["id"]))
        error = RuntimeError("provider failed")
        with patch("worker.paper_reports._ensure_full_text", return_value="full text"), patch(
            "worker.paper_reports._call_chat_text", side_effect=error
        ):
            with self.assertRaisesRegex(RuntimeError, "provider failed") as raised:
                run_paper_report_worker_job(self.conn, self.settings, failed_job)
        status, failure_events = stage_paper_report_terminal_failure(self.conn, failed_job, raised.exception)
        self.assertEqual(status, "failed")
        fail_worker_job(
            self.conn,
            int(failed_job["id"]),
            str(raised.exception),
            worker_id="worker-test",
            lease_attempt=1,
            domain_events=failure_events,
        )
        self.assertEqual(self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (failed_job["id"],)).fetchone()["status"], "failed")
        artifact = self.conn.execute("SELECT status, content_json FROM artifacts WHERE scope_id = ?", (failed_paper_id,)).fetchone()
        self.assertEqual(artifact["status"], "failed")
        self.assertIn("provider failed", json.loads(artifact["content_json"])["error_message"])

    def test_worker_materializes_legacy_claimed_job_without_artifact(self) -> None:
        paper_id = self._paper("Legacy claimed report")
        now = utc_now()
        row = self.conn.execute(
            """
            INSERT INTO worker_jobs(job_type, status, priority, payload_json, max_attempts,
                                    attempts, locked_by, locked_at, started_at, created_at, updated_at)
            VALUES ('paper-report', 'running', 10, ?, 2, 1, 'worker-test', ?, ?, ?, ?)
            RETURNING *
            """,
            (to_json({"command": "paper-report", "paper_id": paper_id, "body": {"prompt": "Legacy prompt"}}), now, now, now, now),
        ).fetchone()
        self.conn.commit()
        job = dict(row)
        job["payload"] = json.loads(job["payload_json"])
        with patch("worker.paper_reports._ensure_full_text", return_value="full text"), patch(
            "worker.paper_reports._call_chat_text",
            return_value=json.dumps({"title": "Legacy claimed report", "markdown": "# Migrated"}),
        ):
            result = run_paper_report_worker_job(self.conn, self.settings, job)
        domain_events = result.pop("domain_events")
        complete_worker_job(
            self.conn,
            int(job["id"]),
            result,
            worker_id="worker-test",
            lease_attempt=1,
            domain_events=domain_events,
        )
        artifact = self.conn.execute(
            "SELECT status, content_markdown, content_json FROM artifacts WHERE scope_id = ? AND artifact_type = 'paper_report'",
            (paper_id,),
        ).fetchone()
        normalized = self.conn.execute("SELECT status, payload_json, concurrency_key FROM worker_jobs WHERE id = ?", (job["id"],)).fetchone()
        payload = json.loads(normalized["payload_json"])
        content = json.loads(artifact["content_json"])
        self.assertEqual(normalized["status"], "completed")
        self.assertEqual(artifact["status"], "done")
        self.assertEqual(artifact["content_markdown"], "# Migrated")
        self.assertNotIn("dedupe_key", payload)
        self.assertNotIn("concurrency_key", payload)
        self.assertEqual(normalized["concurrency_key"], f"paper:{paper_id}:report")
        self.assertEqual(payload["generation_id"], content["generation_id"])

        duplicate_now = utc_now()
        duplicate = self.conn.execute(
            """
            INSERT INTO worker_jobs(job_type, status, priority, payload_json, max_attempts,
                                    attempts, locked_by, locked_at, started_at, created_at, updated_at)
            VALUES ('paper-report', 'running', 5, ?, 2, 1, 'worker-test', ?, ?, ?, ?)
            RETURNING *
            """,
            (to_json({"command": "paper-report", "paper_id": paper_id}), duplicate_now, duplicate_now, duplicate_now, duplicate_now),
        ).fetchone()
        self.conn.commit()
        duplicate_job = dict(duplicate)
        duplicate_job["payload"] = json.loads(duplicate_job["payload_json"])
        with self.assertRaises(PaperReportSuperseded) as raised:
            run_paper_report_worker_job(self.conn, self.settings, duplicate_job)
        terminal, events = stage_paper_report_terminal_failure(self.conn, duplicate_job, raised.exception)
        self.assertEqual((terminal, events), ("superseded", []))
        self.assertEqual(
            self.conn.execute("SELECT status FROM artifacts WHERE scope_id = ?", (paper_id,)).fetchone()["status"],
            "done",
        )

    def test_service_failure_is_failed_and_running_cancel_never_commits_late_result(self) -> None:
        failed_paper_id, failed_queued = self._materialized("Service failure")
        failure_conn = connect_postgres(self.database_url)
        failure_conn.execute(f'SET search_path TO "{self.schema}"')
        failure_conn.commit()
        with patch("worker.service.connect", return_value=failure_conn), patch(
            "worker.service.load_settings", return_value=self.settings
        ), patch("worker.service.apply_stored_settings", return_value=self.settings), patch(
            "worker.paper_reports._ensure_full_text", return_value="full text"
        ), patch("worker.paper_reports._call_chat_text", side_effect=RuntimeError("service provider failed")):
            with self.assertRaisesRegex(RuntimeError, "service provider failed"):
                service.run_once("failure-worker")
        failed_job = self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (failed_queued["id"],)).fetchone()
        failed_artifact = self.conn.execute("SELECT status FROM artifacts WHERE scope_id = ?", (failed_paper_id,)).fetchone()
        self.assertEqual(failed_job["status"], "failed")
        self.assertEqual(failed_artifact["status"], "failed")

        cancelled_paper_id, cancelled_queued = self._materialized("Service cancellation")
        cancel_conn = connect_postgres(self.database_url)
        cancel_conn.execute(f'SET search_path TO "{self.schema}"')
        cancel_conn.commit()
        provider_entered = threading.Event()
        provider_release = threading.Event()
        outcome: list[object] = []

        def blocked_provider(*_args, **_kwargs):
            provider_entered.set()
            if not provider_release.wait(10):
                raise RuntimeError("provider test timed out")
            return json.dumps({"title": "Service cancellation", "markdown": "# Late result"})

        def run_worker() -> None:
            try:
                outcome.append(service.run_once("cancel-worker"))
            except Exception as exc:  # pragma: no cover - assertion reports unexpected failure
                outcome.append(exc)

        with patch("worker.service.connect", return_value=cancel_conn), patch(
            "worker.service.load_settings", return_value=self.settings
        ), patch("worker.service.apply_stored_settings", return_value=self.settings), patch(
            "worker.paper_reports._ensure_full_text", return_value="full text"
        ), patch("worker.paper_reports._call_chat_text", side_effect=blocked_provider):
            thread = threading.Thread(target=run_worker, daemon=True)
            thread.start()
            self.assertTrue(provider_entered.wait(10))
            now = utc_now()
            # Node cancellation takes the domain advisory lock. It must not wait on the
            # worker-only execution lock held across the provider request.
            self.conn.execute("SET LOCAL statement_timeout = '1000ms'")
            self.conn.execute("SELECT pg_advisory_xact_lock(724023, ?)", (cancelled_paper_id,))
            self.conn.execute(
                "UPDATE worker_jobs SET cancel_requested_at = ?, cancel_reason = 'stop', updated_at = ? WHERE id = ? AND status = 'running'",
                (now, now, cancelled_queued["id"]),
            )
            artifact = self.conn.execute("SELECT id, content_json FROM artifacts WHERE scope_id = ? FOR UPDATE", (cancelled_paper_id,)).fetchone()
            content = json.loads(artifact["content_json"])
            content["finished_at"] = now
            self.conn.execute(
                "UPDATE artifacts SET status = 'cancelled', content_json = ?, updated_at = ? WHERE id = ?",
                (to_json(content), now, artifact["id"]),
            )
            self.conn.commit()
            provider_release.set()
            thread.join(15)
        self.assertFalse(thread.is_alive())
        self.assertFalse(any(isinstance(item, Exception) for item in outcome), outcome)
        self.assertEqual(self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (cancelled_queued["id"],)).fetchone()["status"], "cancelled")
        final_artifact = self.conn.execute("SELECT status, content_markdown FROM artifacts WHERE scope_id = ?", (cancelled_paper_id,)).fetchone()
        self.assertEqual(final_artifact["status"], "cancelled")
        self.assertNotIn("Late result", final_artifact["content_markdown"])

    def test_paper_report_worker_is_claimable(self) -> None:
        paper_id, queued = self._materialized("worker report")
        worker_conn = connect_postgres(self.database_url)
        worker_conn.execute(f'SET search_path TO "{self.schema}"')
        worker_conn.commit()
        with patch("worker.service.connect", return_value=worker_conn), patch(
            "worker.service.load_settings", return_value=self.settings
        ), patch("worker.service.apply_stored_settings", return_value=self.settings), patch(
            "worker.paper_reports._ensure_full_text", return_value="full text"
        ), patch(
            "worker.paper_reports._call_chat_text",
            return_value=json.dumps({"title": "worker report", "markdown": "# worker"}),
        ):
            result = service.run_once("paper-report-worker")
        self.assertTrue(result["claimed"])
        self.assertEqual(int(result["worker_job"]["id"]), int(queued["id"]))
        self.assertEqual(
            self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (queued["id"],)).fetchone()["status"],
            "completed",
        )
        artifact = self.conn.execute(
            "SELECT status, content_markdown FROM artifacts WHERE scope_id = ? AND artifact_type = 'paper_report'",
            (paper_id,),
        ).fetchone()
        self.assertEqual(artifact["status"], "done")
        self.assertEqual(artifact["content_markdown"], "# worker")

    def test_cancel_and_stale_recovery_cannot_leave_processing_or_commit_late_done(self) -> None:
        paper_id, queued = self._materialized("Cancelled paper")
        job = self._mark_running(int(queued["id"]))
        canceller = connect_postgres(self.database_url)
        canceller.execute(f'SET search_path TO "{self.schema}"')
        canceller.commit()

        def cancel_during_provider(*_args, **_kwargs):
            canceller.execute(
                "UPDATE worker_jobs SET cancel_requested_at = ?, cancel_reason = 'stop' WHERE id = ?",
                (utc_now(), job["id"]),
            )
            canceller.commit()
            return json.dumps({"title": "Cancelled paper", "markdown": "# Must not commit"})

        try:
            with patch("worker.paper_reports._ensure_full_text", return_value="full text"), patch(
                "worker.paper_reports._call_chat_text", side_effect=cancel_during_provider
            ):
                with self.assertRaises(PaperReportCancellationRequested) as raised:
                    run_paper_report_worker_job(self.conn, self.settings, job)
        finally:
            canceller.close()
        status, events = stage_paper_report_terminal_failure(self.conn, job, raised.exception)
        self.assertEqual(status, "cancelled")
        cancel_worker_job_before_dispatch(
            self.conn,
            int(job["id"]),
            worker_id="worker-test",
            lease_attempt=1,
            message="stop",
            domain_events=events,
        )
        self.assertEqual(self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (job["id"],)).fetchone()["status"], "cancelled")
        self.assertEqual(self.conn.execute("SELECT status FROM artifacts WHERE scope_id = ?", (paper_id,)).fetchone()["status"], "cancelled")
        self.assertNotIn("# Must not commit", self.conn.execute("SELECT content_markdown FROM artifacts WHERE scope_id = ?", (paper_id,)).fetchone()["content_markdown"])

        stale_paper_id, stale_queued = self._materialized("Stale paper")
        stale_job = self._mark_running(int(stale_queued["id"]), attempts=1, locked_at="2026-01-01T00:00:00+00:00")
        self.conn.execute("UPDATE artifacts SET status = 'processing' WHERE scope_id = ?", (stale_paper_id,))
        self.conn.commit()
        recovered = cleanup_stale_worker_jobs(self.conn, stale_after_seconds=1, now="2026-08-05T10:00:00+00:00")
        self.assertEqual(recovered["stale_worker_jobs_requeued"], 1)
        self.assertEqual(self.conn.execute("SELECT status FROM artifacts WHERE scope_id = ?", (stale_paper_id,)).fetchone()["status"], "queued")

        self._mark_running(int(stale_job["id"]), attempts=2, locked_at="2026-01-01T00:00:00+00:00")
        self.conn.execute("UPDATE artifacts SET status = 'processing' WHERE scope_id = ?", (stale_paper_id,))
        self.conn.commit()
        exhausted = cleanup_stale_worker_jobs(self.conn, stale_after_seconds=1, now="2026-08-05T10:01:00+00:00")
        self.assertEqual(exhausted["stale_worker_jobs_failed"], 1)
        self.assertEqual(self.conn.execute("SELECT status FROM artifacts WHERE scope_id = ?", (stale_paper_id,)).fetchone()["status"], "failed")

        stale_cancel_paper, stale_cancel_queued = self._materialized("Stale cancelled paper")
        stale_cancel_job = self._mark_running(int(stale_cancel_queued["id"]), attempts=1, locked_at="2026-01-01T00:00:00+00:00")
        self.conn.execute(
            "UPDATE worker_jobs SET cancel_requested_at = ?, cancel_reason = 'stale stop' WHERE id = ?",
            ("2026-01-01T00:00:01+00:00", stale_cancel_job["id"]),
        )
        self.conn.execute("UPDATE artifacts SET status = 'processing' WHERE scope_id = ?", (stale_cancel_paper,))
        self.conn.commit()
        cancelled = cleanup_stale_worker_jobs(self.conn, stale_after_seconds=1, now="2026-08-05T10:02:00+00:00")
        self.assertEqual(cancelled["stale_worker_jobs_cancelled"], 1)
        self.assertEqual(self.conn.execute("SELECT status FROM artifacts WHERE scope_id = ?", (stale_cancel_paper,)).fetchone()["status"], "cancelled")
        event_types = [row["event_type"] for row in self.conn.execute("SELECT event_type FROM app_events ORDER BY id").fetchall()]
        self.assertIn("task.started", event_types)
        self.assertIn("task.failed", event_types)
        self.assertIn("task.cancelled", event_types)
        self.assertIn("paper_report.updated", event_types)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) AS count FROM job_runs").fetchone()["count"], 0)

    def test_terminal_outbox_failure_rolls_back_domain_and_worker_terminal_state(self) -> None:
        paper_id, queued = self._materialized("Atomic failure paper")
        job = self._mark_running(int(queued["id"]))
        error = RuntimeError("provider failed atomically")
        self.conn.execute(
            """
            CREATE FUNCTION reject_report_terminal_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.event_type = 'task.failed' THEN RAISE EXCEPTION 'terminal outbox rejected'; END IF;
              RETURN NEW;
            END $$
            """
        )
        self.conn.execute(
            "CREATE TRIGGER reject_report_terminal_outbox BEFORE INSERT ON app_events FOR EACH ROW EXECUTE FUNCTION reject_report_terminal_outbox()"
        )
        self.conn.commit()
        status, events = stage_paper_report_terminal_failure(self.conn, job, error)
        self.assertEqual(status, "failed")
        with self.assertRaises(Exception):
            fail_worker_job(
                self.conn,
                int(job["id"]),
                str(error),
                worker_id="worker-test",
                lease_attempt=1,
                domain_events=events,
            )
        self.assertEqual(self.conn.execute("SELECT status FROM worker_jobs WHERE id = ?", (job["id"],)).fetchone()["status"], "running")
        self.assertEqual(self.conn.execute("SELECT status FROM artifacts WHERE scope_id = ?", (paper_id,)).fetchone()["status"], "queued")


if __name__ == "__main__":
    unittest.main()
