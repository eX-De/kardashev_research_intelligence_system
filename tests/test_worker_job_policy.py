from __future__ import annotations

import json
from pathlib import Path
import unittest

from worker.job_policy import policy_document, resolve_worker_job_policy


class WorkerJobPolicyTests(unittest.TestCase):
    def test_policy_covers_inventory_and_resolves_cross_language_fixture(self) -> None:
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "worker-job-policy-cases.json").read_text(encoding="utf-8")
        )
        self.assertEqual(len(policy_document()["jobs"]), 20)
        for item in fixture["cases"]:
            resolved = resolve_worker_job_policy(item["job_type"], item["payload"])
            self.assertEqual(resolved["concurrency_key"], item["key"], item["job_type"])
            self.assertEqual(resolved["policy_version"], 1)

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


if __name__ == "__main__":
    unittest.main()
