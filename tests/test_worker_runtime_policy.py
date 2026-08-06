from __future__ import annotations

import unittest
from unittest.mock import patch

from worker.db import _seed_worker_runtime_policy, postgres_schema_sql
from worker.runtime_policy import RuntimePolicyError, load_runtime_policy, merge_runtime_policy


class _Cursor:
    def __init__(self, *, row=None, rows=None):
        self._row = row
        self._rows = rows or []

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class _SeedConnection:
    def __init__(self, stored=None):
        self.stored = stored or {}
        self.inserted = None
        self.deleted_keys = []
        self.pruned_editable_groups = []

    def execute(self, sql, params=()):
        normalized = " ".join(str(sql).split())
        if normalized.startswith("SELECT 1 FROM worker_runtime_policy"):
            return _Cursor(row={"present": 1} if self.inserted else None)
        if normalized.startswith("SELECT key, value_json FROM app_settings"):
            return _Cursor(rows=[{"key": key, "value_json": value} for key, value in self.stored.items()])
        if normalized.startswith("INSERT INTO worker_runtime_policy"):
            self.inserted = params
            return _Cursor()
        if normalized.startswith("DELETE FROM worker_group_limit_overrides"):
            self.pruned_editable_groups.append(tuple(params[0]) if params else ())
            return _Cursor()
        if normalized.startswith("DELETE FROM app_settings"):
            self.deleted_keys.extend(params[0])
            for key in params[0]:
                self.stored.pop(key, None)
            return _Cursor()
        raise AssertionError(normalized)


class _SnapshotConnection:
    def __init__(self, rows):
        self.rows = rows
        self.calls = 0

    def execute(self, sql, params=()):
        self.calls += 1
        if "LEFT JOIN worker_group_limit_overrides" not in str(sql):
            raise AssertionError(sql)
        return _Cursor(rows=self.rows)


class WorkerRuntimePolicyTests(unittest.TestCase):
    def test_schema_declares_runtime_constraints(self) -> None:
        schema = postgres_schema_sql()
        self.assertIn("CREATE TABLE IF NOT EXISTS worker_runtime_policy", schema)
        self.assertIn("CHECK (singleton_id = 1)", schema)
        self.assertIn("embedding_concurrency <= global_embedding_request_concurrency", schema)
        self.assertIn("CREATE TABLE IF NOT EXISTS worker_group_limit_overrides", schema)
        self.assertIn("max_running INTEGER NULL", schema)

    def test_seed_uses_stored_values_clamps_local_limits_and_is_idempotent(self) -> None:
        conn = _SeedConnection({
            "worker_process_count": "1",
            "global_llm_request_concurrency": "2",
            "global_embedding_request_concurrency": "3",
            "embedding_concurrency": "12",
            "project_judgment_concurrency": "4",
            "project_chat_profile_concurrency": "7",
        })
        with patch("worker.db.utc_now", return_value="2026-08-06T00:00:00+00:00"):
            result = _seed_worker_runtime_policy(conn)
        self.assertTrue(result["created"])
        self.assertEqual(conn.inserted, (1, 2, 3, 3, 2, 2, "2026-08-06T00:00:00+00:00"))
        self.assertEqual(conn.stored, {})
        self.assertIn("paper_report_queue_concurrency", conn.deleted_keys)
        self.assertNotIn("arxiv", conn.pruned_editable_groups[-1])
        self.assertNotIn("ingest", conn.pruned_editable_groups[-1])
        self.assertIn("artifact-index", conn.pruned_editable_groups[-1])
        self.assertEqual(_seed_worker_runtime_policy(conn), {"created": False, "corrections": []})

    def test_revision_mismatch_and_unknown_group_are_fail_closed(self) -> None:
        row = {
            "revision": 3, "worker_process_count": 1,
            "global_llm_request_concurrency": 4, "global_embedding_request_concurrency": 4,
            "embedding_concurrency": 2, "project_judgment_concurrency": 3,
            "project_chat_profile_concurrency": 2,
        }
        with self.assertRaisesRegex(RuntimePolicyError, "revision mismatch"):
            merge_runtime_policy(row, [{
                "concurrency_group": "reader-import", "max_running": 2, "policy_revision": 2,
            }])
        with self.assertRaisesRegex(RuntimePolicyError, "unknown worker group"):
            merge_runtime_policy(row, [{
                "concurrency_group": "missing", "max_running": 2, "policy_revision": 3,
            }])

    def test_atomic_reader_handles_zero_and_multiple_overrides_and_rejects_mismatch(self) -> None:
        runtime = {
            "revision": 3, "worker_process_count": 1,
            "global_llm_request_concurrency": 4, "global_embedding_request_concurrency": 4,
            "embedding_concurrency": 2, "project_judgment_concurrency": 3,
            "project_chat_profile_concurrency": 2,
        }
        empty = _SnapshotConnection([{
            **runtime, "concurrency_group": None, "max_running": None, "policy_revision": None,
        }])
        snapshot = load_runtime_policy(empty)
        self.assertEqual(empty.calls, 1)
        self.assertEqual(snapshot["groups"]["reader-import"]["source"], "default")

        multiple = _SnapshotConnection([
            {**runtime, "concurrency_group": "artifact-index", "max_running": None, "policy_revision": 3},
            {**runtime, "concurrency_group": "reader-import", "max_running": 3, "policy_revision": 3},
        ])
        snapshot = load_runtime_policy(multiple)
        self.assertEqual(multiple.calls, 1)
        self.assertIsNone(snapshot["groups"]["artifact-index"]["max_running"])
        self.assertEqual(snapshot["groups"]["reader-import"]["max_running"], 3)

        mismatch = _SnapshotConnection([{
            **runtime, "concurrency_group": "reader-import", "max_running": 3, "policy_revision": 2,
        }])
        with self.assertRaisesRegex(RuntimePolicyError, "revision mismatch"):
            load_runtime_policy(mismatch)
        self.assertEqual(mismatch.calls, 1)


if __name__ == "__main__":
    unittest.main()
