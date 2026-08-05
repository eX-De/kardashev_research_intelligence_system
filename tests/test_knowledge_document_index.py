from __future__ import annotations

import os
import threading
import time
import unittest
import uuid
from types import SimpleNamespace

from worker.db import init_db
from worker.knowledge import content_hash, index_knowledge_document
from worker.pg import PgConnection


class KnowledgeDocumentIndexPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        database_url = os.environ.get("TEST_DATABASE_URL", "").strip().strip("\"'")
        if not database_url:
            raise unittest.SkipTest("TEST_DATABASE_URL is not set; skipping PostgreSQL integration test")
        try:
            import psycopg
        except ImportError as exc:
            raise unittest.SkipTest(str(exc)) from exc
        cls.psycopg = psycopg
        cls.database_url = database_url
        cls.schema = f"test_context_index_{uuid.uuid4().hex[:12]}"
        admin = psycopg.connect(database_url, autocommit=True)
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
        raw = cls.psycopg.connect(cls.database_url, options=f"-c search_path={cls.schema}")
        return PgConnection(raw)

    def setUp(self) -> None:
        self.conn = self.connect()
        self.settings = SimpleNamespace(llm_embedding_model="test-embedding")

    def tearDown(self) -> None:
        self.conn.close()

    def seed(self, raw_content: str = "Project context " * 8) -> tuple[int, int, str]:
        now = "2026-08-05T00:00:00+00:00"
        project = self.conn.execute(
            "INSERT INTO research_projects(name, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
            ("Context project", now, now),
        )
        project_id = int(project.lastrowid)
        digest = content_hash(raw_content)
        document = self.conn.execute(
            """
            INSERT INTO knowledge_documents(
              source_type, source_uri, title, raw_content, content_hash, metadata_json,
              index_status, index_error, indexed_content_hash, indexed_at, created_at, updated_at
            ) VALUES ('manual_project', ?, 'Context', ?, ?, '{}', 'pending', '', '', '', ?, ?)
            """,
            (f"project:{project_id}:manual_context", raw_content, digest, now, now),
        )
        document_id = int(document.lastrowid)
        self.conn.execute(
            """
            INSERT INTO project_context_documents(project_id, document_id, relation, weight, created_at, updated_at)
            VALUES (?, ?, 'primary', 1.0, ?, ?)
            """,
            (project_id, document_id, now, now),
        )
        self.conn.commit()
        return project_id, document_id, digest

    def test_success_commits_only_matching_hash(self) -> None:
        project_id, document_id, digest = self.seed()
        result = index_knowledge_document(
            self.conn,
            self.settings,
            document_id=document_id,
            project_id=project_id,
            expected_content_hash=digest,
            embedder=lambda _settings, _text: [0.1, 0.2],
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT index_status, indexed_content_hash FROM knowledge_documents WHERE id = ?",
            (document_id,),
        ).fetchone()
        self.assertEqual(result["index_status"], "ready")
        self.assertEqual(row["index_status"], "ready")
        self.assertEqual(row["indexed_content_hash"], digest)
        self.assertGreater(self.conn.execute("SELECT COUNT(*) AS count FROM research_chunks WHERE document_id = ?", (document_id,)).fetchone()["count"], 0)

    def test_embedding_failure_has_no_partial_chunks_and_marks_matching_hash_failed(self) -> None:
        project_id, document_id, digest = self.seed()

        def fail(_settings, _text):
            raise RuntimeError("embedding failed")

        with self.assertRaisesRegex(RuntimeError, "embedding failed"):
            index_knowledge_document(
                self.conn,
                self.settings,
                document_id=document_id,
                project_id=project_id,
                expected_content_hash=digest,
                embedder=fail,
            )
        self.conn.commit()
        row = self.conn.execute("SELECT index_status, index_error FROM knowledge_documents WHERE id = ?", (document_id,)).fetchone()
        self.assertEqual(row["index_status"], "failed")
        self.assertIn("embedding failed", row["index_error"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) AS count FROM research_chunks WHERE document_id = ?", (document_id,)).fetchone()["count"], 0)

    def test_new_hash_saved_during_embedding_supersedes_old_work(self) -> None:
        project_id, document_id, digest = self.seed()
        embedding_started = threading.Event()
        continue_embedding = threading.Event()
        outcome: dict[str, object] = {}

        def embed(_settings, _text):
            embedding_started.set()
            self.assertTrue(continue_embedding.wait(5))
            return [0.3]

        worker_conn = self.connect()

        def run_worker() -> None:
            try:
                outcome.update(index_knowledge_document(
                    worker_conn,
                    self.settings,
                    document_id=document_id,
                    project_id=project_id,
                    expected_content_hash=digest,
                    embedder=embed,
                ))
                worker_conn.commit()
            finally:
                worker_conn.close()

        thread = threading.Thread(target=run_worker)
        thread.start()
        self.assertTrue(embedding_started.wait(5))
        new_raw = "Newer project context " * 8
        new_digest = content_hash(new_raw)
        self.conn.execute(
            """
            UPDATE knowledge_documents
            SET raw_content = ?, content_hash = ?, index_status = 'pending', index_error = '', indexed_content_hash = ''
            WHERE id = ?
            """,
            (new_raw, new_digest, document_id),
        )
        self.conn.execute("DELETE FROM research_chunks WHERE document_id = ?", (document_id,))
        self.conn.commit()
        continue_embedding.set()
        thread.join(10)
        self.assertFalse(thread.is_alive())
        row = self.conn.execute("SELECT content_hash, index_status FROM knowledge_documents WHERE id = ?", (document_id,)).fetchone()
        self.assertTrue(outcome["superseded"])
        self.assertEqual(row["content_hash"], new_digest)
        self.assertEqual(row["index_status"], "pending")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) AS count FROM research_chunks WHERE document_id = ?", (document_id,)).fetchone()["count"], 0)

    def test_document_advisory_lock_serializes_two_indexers(self) -> None:
        project_id, document_id, digest = self.seed()
        first_entered = threading.Event()
        release_first = threading.Event()
        second_entered = threading.Event()
        errors: list[BaseException] = []

        def run(name: str) -> None:
            conn = self.connect()
            try:
                def embed(_settings, _text):
                    if name == "first":
                        first_entered.set()
                        self.assertTrue(release_first.wait(5))
                    else:
                        second_entered.set()
                    return [0.4]

                index_knowledge_document(
                    conn,
                    self.settings,
                    document_id=document_id,
                    project_id=project_id,
                    expected_content_hash=digest,
                    embedder=embed,
                )
                conn.commit()
            except BaseException as exc:
                errors.append(exc)
            finally:
                conn.close()

        first = threading.Thread(target=run, args=("first",))
        second = threading.Thread(target=run, args=("second",))
        first.start()
        self.assertTrue(first_entered.wait(5))
        second.start()
        time.sleep(0.2)
        self.assertFalse(second_entered.is_set())
        release_first.set()
        first.join(10)
        second.join(10)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertTrue(second_entered.is_set())


if __name__ == "__main__":
    unittest.main()
