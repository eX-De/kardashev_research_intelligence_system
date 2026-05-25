import unittest
from unittest.mock import patch

from helpers import connect_test_db
from worker.cli import _run_daily_step, _with_deadlock_retry
from worker.db import from_json, job_run
from worker.paper_reports import paper_report_payload, process_paper_report_queue, queue_paper_report


class AbortSimConnection:
    dialect = "postgres"

    def __init__(self, conn):
        self.conn = conn
        self.aborted = False
        self.events: list[str] = []

    def execute(self, sql: str, params=()):
        if self.aborted:
            raise RuntimeError("current transaction is aborted, commands ignored until end of transaction block")
        try:
            cursor = self.conn.execute(sql, tuple(params or ()))
        except Exception:
            self.aborted = True
            raise
        normalized = " ".join(sql.lower().split())
        if "update job_runs" in normalized and "status = 'failed'" in normalized:
            self.events.append("job_failed_update")
        if "update artifacts" in normalized and "failed" in {str(item) for item in tuple(params or ())}:
            self.events.append("paper_report_failed_update")
        if "daily_run_steps" in normalized and len(tuple(params or ())) >= 3 and tuple(params or ())[2] == "failed":
            self.events.append("daily_step_failed_update")
        return cursor

    def commit(self):
        if self.aborted:
            raise RuntimeError("current transaction is aborted, commands ignored until end of transaction block")
        self.conn.commit()

    def rollback(self):
        self.events.append("rollback")
        self.aborted = False
        self.conn.rollback()

    def close(self):
        self.conn.close()


def _base_conn():
    return connect_test_db()


class TransactionRecoveryTests(unittest.TestCase):
    def test_deadlock_retry_rolls_back_before_retrying(self) -> None:
        class FakeDeadlock(Exception):
            sqlstate = "40P01"

        base = _base_conn()
        conn = AbortSimConnection(base)
        calls = 0

        def handler():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise FakeDeadlock("deadlock detected")
            return {"ok": 1}

        result = _with_deadlock_retry(conn, handler, attempts=2)

        self.assertEqual(result, {"ok": 1})
        self.assertEqual(calls, 2)
        self.assertIn("rollback", conn.events)

    def test_job_run_rolls_back_before_recording_failure(self) -> None:
        base = _base_conn()
        conn = AbortSimConnection(base)
        holder: dict[str, int] = {}

        with self.assertRaises(Exception):
            with job_run(conn, "test-job") as job_id:
                holder["job_id"] = job_id
                conn.execute("SELECT * FROM missing_table")

        row = base.execute("SELECT status, message FROM job_runs WHERE id = ?", (holder["job_id"],)).fetchone()
        self.assertEqual(row["status"], "failed")
        self.assertIn("missing_table", row["message"])
        self.assertLess(conn.events.index("rollback"), conn.events.index("job_failed_update"))

    def test_daily_step_rolls_back_before_recording_failed_step(self) -> None:
        base = _base_conn()
        base.execute(
            "INSERT INTO job_runs(job_type, status, started_at) VALUES ('daily', 'running', 'now')"
        )
        job_id = int(base.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        base.commit()
        conn = AbortSimConnection(base)
        steps = [{"key": "sync_context_sources", "label": "同步上下文来源", "status": "pending"}]

        with self.assertRaises(Exception):
            _run_daily_step(conn, job_id, steps, 0, {}, lambda: conn.execute("SELECT * FROM missing_table"))

        row = base.execute(
            "SELECT status, error FROM daily_run_steps WHERE job_id = ? AND step_key = 'sync_context_sources'",
            (job_id,),
        ).fetchone()
        self.assertEqual(row["status"], "failed")
        self.assertIn("missing_table", row["error"])
        job = base.execute("SELECT meta_json FROM job_runs WHERE id = ?", (job_id,)).fetchone()
        self.assertEqual(from_json(job["meta_json"], {})["daily_progress"]["status"], "failed")
        self.assertLess(conn.events.index("rollback"), conn.events.index("daily_step_failed_update"))

    def test_paper_report_queue_rolls_back_before_recording_failed_report(self) -> None:
        base = _base_conn()
        base.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_status, fetched_batch_id, created_at
            )
            VALUES ('2605.90001', 'Broken Report Paper', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z',
              'https://arxiv.org/abs/2605.90001', 'https://arxiv.org/pdf/2605.90001',
              'complete', 'batch', 'now')
            """
        )
        paper_id = int(base.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        queue_paper_report(base, paper_id)
        base.commit()
        conn = AbortSimConnection(base)

        def fail_with_aborted_transaction(conn_arg, _settings, _paper_id):
            conn_arg.execute("SELECT * FROM missing_table")

        with patch("worker.paper_reports._ensure_full_text", side_effect=fail_with_aborted_transaction):
            result = process_paper_report_queue(conn, object(), [paper_id])

        self.assertEqual(result["paper_reports_failed"], 1)
        report = paper_report_payload(base, paper_id)
        self.assertEqual(report["status"], "failed")
        self.assertIn("missing_table", report["error_message"])
        self.assertLess(conn.events.index("rollback"), conn.events.index("paper_report_failed_update"))


if __name__ == "__main__":
    unittest.main()
