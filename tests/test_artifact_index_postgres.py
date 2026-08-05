from __future__ import annotations

import os
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from worker.artifact_index import artifact_index_content_hash, index_artifact
from worker.artifacts import get_artifact
from worker.db import init_db
from worker.pg import PgConnection


class ArtifactIndexConcurrencyPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.database_url = os.environ.get("TEST_DATABASE_URL", "").strip().strip("\"'")
        if not cls.database_url:
            raise unittest.SkipTest("TEST_DATABASE_URL is not set; skipping artifact-index PostgreSQL test")
        try:
            import psycopg
        except ImportError as exc:
            raise unittest.SkipTest(str(exc)) from exc
        cls.psycopg = psycopg
        cls.schema = f"test_artifact_index_{uuid.uuid4().hex[:12]}"
        admin = psycopg.connect(cls.database_url, autocommit=True)
        try:
            admin.execute(f'CREATE SCHEMA "{cls.schema}"')
        finally:
            admin.close()
        conn = cls.connect()
        try:
            init_db(conn)
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls) -> None:
        if not hasattr(cls, "schema"):
            return
        admin = cls.psycopg.connect(cls.database_url, autocommit=True)
        try:
            admin.execute(f'DROP SCHEMA IF EXISTS "{cls.schema}" CASCADE')
        finally:
            admin.close()

    @classmethod
    def connect(cls) -> PgConnection:
        return PgConnection(cls.psycopg.connect(cls.database_url, options=f"-c search_path={cls.schema}"))

    def test_old_job_cannot_overwrite_chunks_after_artifact_changes(self) -> None:
        conn = self.connect()
        other = self.connect()
        settings = SimpleNamespace(
            llm_embedding_model="embed-v1",
            embedding_provider=lambda: SimpleNamespace(api_key="key", base_url="https://example.test/v1"),
        )
        try:
            now = "2026-08-05T00:00:00+00:00"
            inserted = conn.execute(
                """
                INSERT INTO artifacts(
                  scope_type, scope_id, artifact_type, title, content_markdown, content_json,
                  status, source_json, input_hash, created_at, updated_at
                ) VALUES ('project', 1, 'project_index', 'Index', 'old project index content with enough words for a searchable chunk', '{}', 'ready', '{}', 'old', ?, ?)
                """,
                (now, now),
            )
            artifact_id = int(inserted.lastrowid)
            conn.commit()
            old_digest = artifact_index_content_hash(get_artifact(conn, artifact_id) or {})

            def update_while_embedding(_settings, texts):
                other.execute(
                    "UPDATE artifacts SET content_markdown = 'newest project index content with enough words for a searchable chunk', input_hash = 'newest', updated_at = ? WHERE id = ?",
                    ("2026-08-05T00:01:00+00:00", artifact_id),
                )
                other.commit()
                return [[1.0, 0.0] for _ in texts]

            with patch("worker.artifact_index.embed_many", side_effect=update_while_embedding):
                stale = index_artifact(conn, settings, artifact_id, expected_content_hash=old_digest)
            self.assertTrue(stale.get("superseded"), stale)
            self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM artifact_chunks").fetchone()["count"], 0)

            newest = get_artifact(conn, artifact_id) or {}
            newest_digest = artifact_index_content_hash(newest)
            with patch("worker.artifact_index.embed_many", side_effect=lambda _settings, texts: [[0.0, 1.0] for _ in texts]):
                indexed = index_artifact(conn, settings, artifact_id, expected_content_hash=newest_digest)
            self.assertFalse(indexed["unchanged"])
            hashes = conn.execute("SELECT DISTINCT content_hash FROM artifact_chunks WHERE artifact_id = ?", (artifact_id,)).fetchall()
            self.assertEqual([row["content_hash"] for row in hashes], [newest_digest])
        finally:
            other.close()
            conn.close()


if __name__ == "__main__":
    unittest.main()
