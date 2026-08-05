from __future__ import annotations

import os
import threading
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from worker.db import init_db
from worker.paper_reader import paper_reader_chat_stream
from worker.pg import connect_postgres
from worker.compute_contract import ComputeRequestCancelled
from worker.unified_search import deep_search


class ComputeServicePostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.database_url = os.environ.get("TEST_DATABASE_URL", "").strip()
        if not cls.database_url:
            raise unittest.SkipTest("TEST_DATABASE_URL is not set; skipping compute PostgreSQL integration tests")
        cls.schema = f"ris_compute_{uuid.uuid4().hex}"
        cls.conn = connect_postgres(cls.database_url)
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
        self.conn.execute("TRUNCATE paper_reader_messages, papers, worker_jobs, job_runs RESTART IDENTITY CASCADE")
        self.paper_id = int(self.conn.execute(
            """
            INSERT INTO papers(canonical_key, title, created_at, updated_at)
            VALUES ('compute-paper', 'Compute Paper', '2026-08-05T10:00:00Z', '2026-08-05T10:00:00Z')
            RETURNING id
            """
        ).fetchone()["id"])
        self.conn.commit()

    def test_chat_network_wait_has_no_open_transaction_and_cancel_has_no_late_assistant(self) -> None:
        entered_stream = threading.Event()
        release_stream = threading.Event()
        cancelled = threading.Event()
        errors: list[Exception] = []
        backend_pid = int(self.conn.execute("SELECT pg_backend_pid() AS id").fetchone()["id"])
        self.conn.commit()

        def chunks(*_args, **_kwargs):
            entered_stream.set()
            self.assertTrue(release_stream.wait(5))
            yield "late answer"

        def run() -> None:
            try:
                with (
                    patch("worker.paper_reader._ensure_full_text", return_value="Paper text"),
                    patch("worker.paper_reader._reference_paper_contexts", return_value=[]),
                    patch("worker.paper_reader._report_seed_messages", return_value=[]),
                    patch("worker.paper_reader.project_chat_profiles_for_paper", return_value=[]),
                    patch("worker.paper_reader._reader_chat_model", return_value=("test", "model")),
                    patch("worker.paper_reader._iter_chat_text_chunks", side_effect=chunks),
                ):
                    paper_reader_chat_stream(
                        self.conn,
                        SimpleNamespace(),
                        self.paper_id,
                        {"message": "Explain"},
                        lambda _event, _data: None,
                        cancelled=cancelled.is_set,
                    )
            except Exception as exc:
                errors.append(exc)

        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(entered_stream.wait(5))

        monitor = connect_postgres(self.database_url)
        try:
            monitor.execute(f'SET search_path TO "{self.schema}"')
            state = monitor.execute(
                "SELECT state FROM pg_stat_activity WHERE pid = ?",
                (backend_pid,),
            ).fetchone()["state"]
            counts = monitor.execute(
                "SELECT role, COUNT(*) AS count FROM paper_reader_messages GROUP BY role ORDER BY role"
            ).fetchall()
            job_counts = monitor.execute(
                "SELECT (SELECT COUNT(*) FROM worker_jobs) AS worker_jobs, (SELECT COUNT(*) FROM job_runs) AS job_runs"
            ).fetchone()
        finally:
            monitor.close()

        self.assertEqual(state, "idle")
        self.assertEqual([(row["role"], int(row["count"])) for row in counts], [("user", 1)])
        self.assertEqual((int(job_counts["worker_jobs"]), int(job_counts["job_runs"])), (0, 0))

        cancelled.set()
        release_stream.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(errors[0], ComputeRequestCancelled)
        messages = self.conn.execute("SELECT role, content FROM paper_reader_messages ORDER BY id").fetchall()
        self.assertEqual([(row["role"], row["content"]) for row in messages], [("user", "Explain")])

    def test_deep_search_starts_while_daily_is_running_without_creating_job_records(self) -> None:
        daily_run_id = int(self.conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, message)
            VALUES ('run-daily', 'running', '2026-08-05T10:00:00Z', 'running')
            RETURNING id
            """
        ).fetchone()["id"])
        self.conn.execute(
            """
            INSERT INTO worker_jobs(
              job_run_id, job_type, status, payload_json, locked_by,
              created_at, updated_at, started_at
            )
            VALUES (?, 'run-daily', 'running', '{}', 'daily-worker',
                    '2026-08-05T10:00:00Z', '2026-08-05T10:00:00Z', '2026-08-05T10:00:00Z')
            """,
            (daily_run_id,),
        )
        self.conn.commit()
        before = self.conn.execute(
            "SELECT (SELECT COUNT(*) FROM worker_jobs) AS worker_jobs, (SELECT COUNT(*) FROM job_runs) AS job_runs"
        ).fetchone()

        with (
            patch("worker.unified_search.embed_text", return_value=[1.0, 0.0]),
            patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={}),
            patch("worker.unified_search._library_paper_reader_message_lexical_results"),
        ):
            result = deep_search(
                self.conn,
                SimpleNamespace(llm_embedding_model="test-embedding"),
                {"query": "retrieval", "types": ["conversation"], "limit": 10},
            )
        after = self.conn.execute(
            "SELECT (SELECT COUNT(*) FROM worker_jobs) AS worker_jobs, (SELECT COUNT(*) FROM job_runs) AS job_runs"
        ).fetchone()
        self.conn.commit()

        self.assertEqual(result["mode"], "deep")
        self.assertEqual(result["results"], [])
        self.assertEqual((int(before["worker_jobs"]), int(before["job_runs"])), (1, 1))
        self.assertEqual((int(after["worker_jobs"]), int(after["job_runs"])), (1, 1))


if __name__ == "__main__":
    unittest.main()
