from __future__ import annotations

import json
import unittest
from pathlib import Path
from unittest.mock import patch

from worker.artifacts import content_hash, generate_project_index_artifact
from worker.api import _project_context_payload


class _Result:
    def __init__(self, *, one=None, rows=None):
        self._one = one
        self._rows = rows or []

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._rows


class _LegacyRendererConnection:
    def __init__(self, payload):
        self.payload = payload

    def execute(self, sql, _params=()):
        if "FROM research_projects" in sql:
            return _Result(one=self.payload["project"])
        if "FROM project_papers" in sql:
            return _Result(rows=self.payload["papers"])
        if "FROM project_context_documents" in sql:
            return _Result(rows=self.payload["documents"])
        raise AssertionError(sql)


class ProjectIndexContractTests(unittest.TestCase):
    def test_legacy_project_context_payload_keeps_node_index_status_shape(self) -> None:
        row = {
            "id": 9,
            "source_type": "manual_project",
            "source_uri": "project:7:manual_context",
            "title": "Context",
            "raw_content": "Raw context",
            "content_hash": "current",
            "index_status": "failed",
            "index_error": "retry",
            "indexed_content_hash": "old",
            "indexed_at": "",
            "updated_at": "now",
            "relation": "primary",
            "weight": 1.0,
            "chunk_count": 2,
        }
        conn = type("Conn", (), {"execute": lambda self, _sql, _params: _Result(rows=[row])})()
        payload = _project_context_payload(conn, 7)[0]
        self.assertEqual(payload["content_hash"], "current")
        self.assertEqual(payload["index_status"], "failed")
        self.assertEqual(payload["index_error"], "retry")
        self.assertEqual(payload["indexed_content_hash"], "old")

    def test_frozen_project_index_hash_uses_python_artifact_contract(self) -> None:
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "project-index-contract.json").read_text(encoding="utf-8")
        )
        expected = fixture["expected"]
        self.assertEqual(fixture["legacy_renderer"], "worker.artifacts.generate_project_index_artifact")
        self.assertTrue(expected["markdown"].endswith("\n"))
        self.assertEqual(
            content_hash(expected["markdown"], expected["content"]),
            expected["input_hash"],
        )
        empty_expected = fixture["empty_expected"]
        self.assertEqual(
            content_hash(empty_expected["markdown"], empty_expected["content"]),
            empty_expected["input_hash"],
        )

    def test_frozen_documents_are_exact_outputs_of_the_legacy_renderer(self) -> None:
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "project-index-contract.json").read_text(encoding="utf-8")
        )
        for input_key, expected_key in (("input", "expected"), ("empty_input", "empty_expected")):
            captured = {}

            def capture(_conn, **kwargs):
                captured.update(kwargs)
                return kwargs

            with patch("worker.artifacts.upsert_artifact", side_effect=capture):
                generate_project_index_artifact(
                    _LegacyRendererConnection(fixture[input_key]),
                    fixture[input_key]["project"]["id"],
                )
            expected = fixture[expected_key]
            self.assertEqual(captured["title"], expected["title"])
            self.assertEqual(captured["content_markdown"], expected["markdown"])
            self.assertEqual(captured["content_json"], expected["content"])
            self.assertEqual(captured["source_json"], {"project_updated_at": expected["source"]["project_updated_at"]})
            self.assertEqual(captured["source_key"], expected["source"]["source_key"])
            self.assertEqual(captured["input_hash"], expected["input_hash"])


if __name__ == "__main__":
    unittest.main()
