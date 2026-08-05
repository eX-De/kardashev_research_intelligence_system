from __future__ import annotations

import unittest

from worker.audit_job_run_mirrors import audit_job_run_mirrors


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _Connection:
    def __init__(self, rows):
        self.rows = rows
        self.statements = []

    def execute(self, sql, params=()):
        self.statements.append((sql, params))
        return _Rows(self.rows)


class WorkerJobRunAuditTests(unittest.TestCase):
    def test_audit_identifies_mirrors_orphans_and_type_mismatches_without_writes(self) -> None:
        conn = _Connection([
            {
                "job_run_id": 1, "job_run_type": "artifact-index", "job_run_status": "completed",
                "meta_json": '{"worker_job":true}', "worker_job_id": 11, "worker_job_type": "artifact-index",
            },
            {
                "job_run_id": 2, "job_run_type": "reader-import-url", "job_run_status": "failed",
                "meta_json": '{"worker_job":true}', "worker_job_id": None, "worker_job_type": None,
            },
            {
                "job_run_id": 3, "job_run_type": "paper-report", "job_run_status": "completed",
                "meta_json": '{"worker_job":true}', "worker_job_id": 13, "worker_job_type": "generate-reports",
            },
            {
                "job_run_id": 4, "job_run_type": "run-daily", "job_run_status": "completed",
                "meta_json": '{"daily_run":true}', "worker_job_id": 14, "worker_job_type": "run-daily",
            },
        ])

        result = audit_job_run_mirrors(conn)

        self.assertTrue(result["read_only"])
        self.assertEqual(result["deletes_performed"], 0)
        self.assertEqual(result["mirror_job_runs"]["count"], 3)
        self.assertEqual(result["orphan_mirrors"]["count"], 1)
        self.assertEqual(result["mismatched_mirrors"]["count"], 1)
        self.assertEqual(len(conn.statements), 1)
        self.assertTrue(conn.statements[0][0].lstrip().upper().startswith("SELECT"))


if __name__ == "__main__":
    unittest.main()
