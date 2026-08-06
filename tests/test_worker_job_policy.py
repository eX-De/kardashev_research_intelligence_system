from __future__ import annotations

import json
from pathlib import Path
import unittest

from worker.job_policy import policy_document, resolve_worker_job_policy, worker_group_policies
from worker.runtime_policy import RuntimePolicyError, merge_runtime_policy


class WorkerJobPolicyTests(unittest.TestCase):
    def test_group_defaults_keep_arxiv_serial_and_raise_safe_capacity_groups(self) -> None:
        groups = worker_group_policies()
        self.assertEqual(groups["arxiv"], {"limit_mode": "invariant", "default_max_running": 1})
        self.assertEqual(groups["ingest"], {"limit_mode": "invariant", "default_max_running": 1})
        self.assertEqual(groups["daily"], {"limit_mode": "invariant", "default_max_running": 1})
        self.assertNotIn("llm", groups)
        report_policy = policy_document()["jobs"]["generate-reports"]
        self.assertEqual(
            {key: report_policy[key] for key in ("concurrency_group", "limit_mode", "default_max_running")},
            {"concurrency_group": "daily", "limit_mode": "invariant", "default_max_running": 1},
        )
        for group in ("artifact-index", "library-paper-index", "knowledge-index"):
            self.assertEqual(groups[group], {"limit_mode": "capacity", "default_max_running": 8})
        for group in ("reader-import", "paper-report"):
            self.assertEqual(groups[group], {"limit_mode": "capacity", "default_max_running": 4})

    def test_policy_covers_inventory_and_resolves_cross_language_fixture(self) -> None:
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "worker-job-policy-cases.json").read_text(encoding="utf-8")
        )
        self.assertEqual(len(policy_document()["jobs"]), 18)
        for item in fixture["cases"]:
            resolved = resolve_worker_job_policy(item["job_type"], item["payload"])
            self.assertEqual(resolved["concurrency_key"], item["key"], item["job_type"])
            self.assertEqual(resolved["policy_version"], 3)
        with self.assertRaisesRegex(RuntimeError, "No worker job policy"):
            resolve_worker_job_policy("rank-papers", {})

    def test_reader_url_key_is_a_canonical_set_hash(self) -> None:
        left = resolve_worker_job_policy("reader-import-url", {
            "body": {"urls": ["HTTPS://Example.test:443/paper?b=2&a=1#part", "https://b.test/x", "https://b.test/x"]}
        })
        right = resolve_worker_job_policy("reader-import-url", {
            "body": {"urls": ["https://b.test/x", "https://example.test/paper?a=1&b=2"]}
        })
        self.assertEqual(left["concurrency_key"], right["concurrency_key"])
        self.assertRegex(left["concurrency_key"], r"^reader-import:[a-f0-9]{64}$")
        self.assertTrue(left["deduplicate_active"])
        self.assertEqual(
            resolve_worker_job_policy("reader-import-url", {"body": {"url": "https://EXAMPLE.com:443"}})["concurrency_key"],
            resolve_worker_job_policy("reader-import-url", {"body": {"url": "https://example.com/"}})["concurrency_key"],
        )
        expected_edges = {
            "https://e.com/?B=1&a=2": "reader-import:e5107bdc8a5f940e331ff28da8dfb06584e9afed8fc083b7ecc68da504b9ff4c",
            "https://example.com/论文": "reader-import:7cc0bc0ab6f4f629dcfe9114d10f913a9a324c524583acd1d6a9dafa0e7eb97a",
            "https://例子.test/a": "reader-import:2d470871db71a97b9d7a57e5a97c74ea235a243dff1448b96b73e6ec8fa81c7b",
        }
        for url, expected in expected_edges.items():
            self.assertEqual(resolve_worker_job_policy("reader-import-url", {"body": {"url": url}})["concurrency_key"], expected)
        with self.assertRaisesRegex(RuntimeError, "No worker job policy"):
            resolve_worker_job_policy("unknown-job", {})

    def test_runtime_policy_merge_matches_shared_fixture_and_rejects_invariant_override(self) -> None:
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "worker-job-policy-cases.json").read_text(encoding="utf-8")
        )["runtime"]
        snapshot = merge_runtime_policy(fixture["row"], fixture["overrides"])
        for group, expected in fixture["expected_groups"].items():
            for field, value in expected.items():
                self.assertEqual(snapshot["groups"][group][field], value, f"{group}.{field}")
        with self.assertRaisesRegex(RuntimePolicyError, "does not allow overrides"):
            merge_runtime_policy(fixture["row"], [{
                "concurrency_group": "daily", "max_running": 2, "policy_revision": 7,
            }])


if __name__ == "__main__":
    unittest.main()
