from __future__ import annotations

import sqlite3
import unittest

from worker.artifact_index import enqueue_artifact_index
from worker.db import from_json
from worker.experiment_reports import enqueue_experiment_report_index
from worker.library_search_index import enqueue_library_paper_index


class FakeSettings:
    llm_embedding_model = "embed-v1"


def connection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE worker_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_run_id INTEGER,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT NOT NULL DEFAULT '{}',
          error_message TEXT NOT NULL DEFAULT '',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 1,
          concurrency_group TEXT NOT NULL DEFAULT '',
          concurrency_key TEXT NOT NULL DEFAULT '',
          policy_version INTEGER NOT NULL DEFAULT 0,
          run_after TEXT,
          locked_by TEXT NOT NULL DEFAULT '',
          locked_at TEXT,
          cancel_requested_at TEXT,
          cancel_reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE TABLE app_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          published_at TEXT
        );
        """
    )
    return conn


class ChildEnqueueTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = connection()

    def tearDown(self) -> None:
        self.conn.close()

    def test_all_child_enqueue_paths_emit_stable_queued_task_identity(self) -> None:
        settings = FakeSettings()
        results = [
            enqueue_artifact_index(
                self.conn,
                settings,
                {
                    "id": 10,
                    "artifact_type": "daily_report",
                    "title": "Daily",
                    "content_markdown": "Body",
                    "status": "ready",
                },
            ),
            enqueue_experiment_report_index(
                self.conn,
                settings,
                {"id": 11, "input_hash": "experiment-hash"},
            ),
            enqueue_library_paper_index(self.conn, settings, 12),
        ]
        self.conn.commit()

        job_ids = [int(result["worker_job_id"]) for result in results]
        rows = self.conn.execute(
            "SELECT event_type, payload_json FROM app_events ORDER BY id"
        ).fetchall()
        self.assertEqual(len(rows), 3)
        for row, worker_job_id in zip(rows, job_ids, strict=True):
            payload = from_json(row["payload_json"], {})
            task = payload["task"]
            self.assertEqual(row["event_type"], "task.started")
            self.assertEqual(task["status"], "queued")
            self.assertEqual(task["worker_job_id"], worker_job_id)
            self.assertIsNone(task["job_run_id"])
            self.assertEqual(task["id"], worker_job_id)

        stored = self.conn.execute(
            "SELECT id, job_run_id FROM worker_jobs ORDER BY id"
        ).fetchall()
        self.assertEqual([int(row["id"]) for row in stored], job_ids)
        self.assertTrue(all(row["job_run_id"] is None for row in stored))

    def test_outbox_failure_rolls_back_child_worker_job(self) -> None:
        self.conn.executescript(
            """
            CREATE TRIGGER reject_task_event
            BEFORE INSERT ON app_events
            BEGIN
              SELECT RAISE(ABORT, 'outbox unavailable');
            END;
            """
        )

        with self.assertRaisesRegex(sqlite3.IntegrityError, "outbox unavailable"):
            enqueue_artifact_index(
                self.conn,
                FakeSettings(),
                {
                    "id": 20,
                    "artifact_type": "daily_report",
                    "title": "Daily",
                    "content_markdown": "Body",
                    "status": "ready",
                },
            )

        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM worker_jobs").fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM app_events").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
