from __future__ import annotations

import unittest

from worker.db import to_json
from worker.notifications import (
    _activity_rows,
    _arxiv_rate_limited,
    _daily_run_completed,
    _daily_run_progress,
    _job_failed,
    _job_running,
)


class Cursor:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchall(self):
        return list(self._rows)


class ActivityConnection:
    def __init__(self, rows):
        self.rows = rows
        self.sql = ""
        self.params = ()

    def execute(self, sql, params=()):
        self.sql = str(sql)
        self.params = params
        return Cursor(self.rows)


class NotificationOwnershipTests(unittest.TestCase):
    def test_ordinary_activities_read_worker_jobs_result_and_error_fields(self) -> None:
        conn = ActivityConnection(
            [
                {
                    "id": 31,
                    "job_type": "sync-obsidian",
                    "status": "completed",
                    "created_at": "2026-08-05T09:00:00+00:00",
                    "started_at": "2026-08-05T09:00:01+00:00",
                    "finished_at": "2026-08-05T09:00:05+00:00",
                    "error_message": "",
                    "result_json": to_json({"indexed": 4, "chunks_created": 12}),
                },
                {
                    "id": 32,
                    "job_type": "reader-import-url",
                    "status": "failed",
                    "created_at": "2026-08-05T10:00:00+00:00",
                    "started_at": None,
                    "finished_at": "2026-08-05T10:00:05+00:00",
                    "error_message": "Download failed",
                    "result_json": "{}",
                },
            ]
        )

        activities = _activity_rows(conn)

        self.assertIn("FROM worker_jobs", conn.sql)
        self.assertIn("job_type NOT IN", conn.sql)
        self.assertNotIn("FROM job_runs", conn.sql)
        self.assertEqual(activities[0]["meta"]["indexed"], 4)
        self.assertEqual(activities[1]["message"], "Download failed")
        self.assertEqual(activities[1]["started_at"], "2026-08-05T10:00:00+00:00")

        running = {**activities[0], "status": "running"}
        running_item = _job_running({"activities": [running], "items": []})[0]
        self.assertEqual(
            running_item["source"],
            {"worker_job_id": 31, "job_id": 31, "job_type": "sync-obsidian"},
        )
        failed_item = _job_failed({"activities": [activities[1]], "items": []})[0]
        self.assertIn("Download failed", failed_item["detail"])
        self.assertEqual(failed_item["source"]["worker_job_id"], 32)
        self.assertEqual(failed_item["source"]["job_id"], 32)

    def test_daily_notifications_keep_job_runs_identifiers(self) -> None:
        progress = {"current_key": "fetch_arxiv", "current_label": "抓取 arXiv"}
        running_daily = {
            "id": 41,
            "record_type": "daily_run",
            "job_type": "run-daily",
            "status": "running",
            "started_at": "2026-08-05T08:00:00+00:00",
            "finished_at": None,
            "message": "",
            "meta": {"daily_progress": progress},
        }
        progress_item = _daily_run_progress(
            {"activities": [], "latest_daily_run": running_daily, "items": []}
        )[0]
        self.assertEqual(
            progress_item["source"],
            {"job_run_id": 41, "job_id": 41, "job_type": "run-daily"},
        )

        completed_daily = {
            **running_daily,
            "id": 42,
            "status": "completed",
            "finished_at": "2026-08-05T08:30:00+00:00",
            "meta": {"daily_report_artifact_id": 77, "papers_inserted": 3},
        }
        completed_item = _daily_run_completed({"latest_daily_run": completed_daily})[0]
        self.assertEqual(completed_item["source"]["job_run_id"], 42)
        self.assertEqual(completed_item["source"]["job_id"], 42)
        self.assertEqual(completed_item["source"]["artifact_id"], 77)

    def test_later_success_suppresses_old_arxiv_rate_limit_failure(self) -> None:
        failed = {
            "id": 10,
            "record_type": "worker_job",
            "job_type": "fetch-arxiv",
            "status": "failed",
            "started_at": "2026-06-06T02:00:00+00:00",
            "finished_at": "2026-06-06T02:03:00+00:00",
            "message": "HTTP Error 429: Too Many Requests",
            "meta": {},
        }
        completed = {
            "id": 11,
            "record_type": "worker_job",
            "job_type": "fetch-arxiv",
            "status": "completed",
            "started_at": "2026-06-06T03:00:00+00:00",
            "finished_at": "2026-06-06T03:02:00+00:00",
            "message": "Fetch completed",
            "meta": {},
        }
        items = _arxiv_rate_limited(
            {"activities": [completed, failed], "latest_daily_run": None, "items": []}
        )
        self.assertEqual(items, [])


if __name__ == "__main__":
    unittest.main()
