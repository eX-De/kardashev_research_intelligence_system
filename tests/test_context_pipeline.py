from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

from worker.config import Settings
from worker.db import from_json, init_db
from worker.knowledge import replace_document_chunks, save_manual_project_context
from worker.obsidian import OBSIDIAN_NOT_CONFIGURED, sync_obsidian
from worker.search import hybrid_search, rank_project_papers


def test_settings() -> Settings:
    return Settings(
        db_path=Path(":memory:"),
        obsidian_vault_path=None,
        obsidian_include_dirs=[],
        obsidian_include_tags=[],
        obsidian_project_center_tags=[],
        obsidian_cli_command="obsidian",
        obsidian_paper_repository_dir="人工智能/论文仓库",
        obsidian_paper_attachment_dir="人工智能/论文仓库/附件",
        obsidian_project_paper_list_name="论文列表.md",
        arxiv_categories=["cs.AI"],
        arxiv_daily_lookback_days=1,
        arxiv_max_results=10,
        arxiv_request_interval_seconds=0,
        arxiv_cache_full_text=True,
        arxiv_pdf_dir=Path(".test-tmp/arxiv_pdfs"),
        arxiv_text_dir=Path(".test-tmp/arxiv_text"),
        retry_daily_max_results=100,
        rag_score_threshold=0.1,
        rag_top_k=3,
        rag_searchers=["keyword_search", "front_page_search"],
        rag_prefilter_enabled=False,
        rag_prefilter_threshold=0.18,
        rag_prefilter_top_k=20,
        rag_prefilter_min_keep=30,
        rag_prefilter_max_keep=50,
        vector_index_backend="sqlite",
        llm_providers=[],
        llm_chat_provider_id="",
        llm_chat_model="",
        llm_embedding_provider_id="",
        llm_embedding_model="",
        embedding_concurrency=2,
    )


class DummyCursor:
    lastrowid = 0
    rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []


class RecordingPostgresConnection:
    dialect = "postgres"

    def __init__(self, conn: sqlite3.Connection | None = None):
        self.conn = conn
        self.statements: list[tuple[str, tuple[object, ...]]] = []

    def execute(self, sql: str, params=()):
        values = tuple(params or ())
        self.statements.append((sql.strip(), values))
        if "pg_advisory" in sql:
            return DummyCursor()
        if self.conn is None:
            return DummyCursor()
        return self.conn.execute(sql, values)

    def commit(self):
        if self.conn is not None:
            self.conn.commit()

    def rollback(self):
        if self.conn is not None:
            self.conn.rollback()


class ContextPipelineTests(unittest.TestCase):
    def test_sync_obsidian_without_vault_returns_structured_skip(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)

        result = sync_obsidian(conn, test_settings())

        self.assertTrue(result["ok"])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], OBSIDIAN_NOT_CONFIGURED)
        self.assertEqual(result["notes_seen"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM obsidian_notes").fetchone()["count"], 0)

    def test_manual_project_context_without_obsidian_is_retrievable_and_rankable(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        settings = test_settings()
        conn.execute(
            """
            INSERT INTO research_projects(name, status, created_at, updated_at)
            VALUES ('Manual Agent Project', 'active', 'now', 'now')
            """
        )
        project_id = int(conn.execute("SELECT id FROM research_projects").fetchone()["id"])

        result = save_manual_project_context(
            conn,
            settings,
            project_id,
            """
            # Agentic Retrieval Planning

            This project studies agentic retrieval planners that evaluate evidence
            chunks before synthesis, especially for project-aware literature triage.
            The context should work without any Obsidian vault configuration.
            """,
        )

        document = conn.execute("SELECT * FROM knowledge_documents").fetchone()
        self.assertEqual(document["source_type"], "manual_project")
        self.assertIn("agentic retrieval planners", document["raw_content"])
        self.assertEqual(int(document["id"]), result["document_id"])
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM obsidian_notes").fetchone()["count"], 0)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) AS count FROM project_context_documents").fetchone()["count"],
            1,
        )
        chunk = conn.execute("SELECT * FROM research_chunks WHERE document_id = ?", (result["document_id"],)).fetchone()
        self.assertIsNone(chunk["note_id"])
        self.assertEqual(chunk["source"], "manual_project")

        hits = hybrid_search(conn, settings, "agentic retrieval planners evidence chunks", 3)
        self.assertTrue(any(int(hit["chunk_id"]) == int(chunk["id"]) for hit in hits))

        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES (
              '2605.17001',
              'Agentic Retrieval Planners for Evidence Aware Synthesis',
              '[]',
              'We evaluate evidence chunks for agentic retrieval planners.',
              '["cs.AI"]',
              '2026-05-17T00:00:00Z',
              '2026-05-17T00:00:00Z',
              'https://arxiv.org/abs/2605.17001',
              'https://arxiv.org/pdf/2605.17001',
              'batch',
              'now'
            )
            """
        )
        paper = conn.execute("SELECT * FROM arxiv_papers").fetchone()
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(
              paper_id, chunk_index, source, page_start, page_end, text,
              token_count, char_count, created_at
            )
            VALUES (
              ?, 0, 'full_text', 1, 1,
              'Agentic retrieval planners evaluate evidence chunks before synthesis for project aware triage.',
              11, 96, 'now'
            )
            """,
            (int(paper["id"]),),
        )
        conn.commit()

        rank_result = rank_project_papers(conn, settings, [paper])
        self.assertEqual(rank_result["project_rank_projects_with_context"], 1)
        self.assertEqual(rank_result["project_paper_matches_created"], 1)
        match = conn.execute("SELECT * FROM project_paper_matches").fetchone()
        self.assertEqual(match["project_id"], project_id)
        self.assertEqual(match["paper_id"], int(paper["id"]))
        self.assertEqual(match["best_obsidian_chunk_id"], int(chunk["id"]))
        evidence = from_json(match["evidence_json"], {})
        self.assertEqual(evidence["project_context"]["source_type"], "manual_project")
        self.assertEqual(evidence["project_context"]["document_id"], int(document["id"]))

    def test_postgres_document_chunk_refresh_uses_advisory_locks_and_split_deletes(self) -> None:
        base = sqlite3.connect(":memory:")
        base.row_factory = sqlite3.Row
        init_db(base)
        base.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Projects/A.md', 'A', '{}', '[]', 'old', 1, 'now')
            """
        )
        note_id = int(base.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        base.execute(
            """
            INSERT INTO knowledge_documents(
              source_type, source_uri, title, raw_content, content_hash,
              metadata_json, indexed_at, created_at, updated_at
            )
            VALUES ('obsidian', 'Projects/A.md', 'A', 'old body', 'old', '{}', 'now', 'now', 'now')
            """
        )
        document_id = int(base.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        base.execute(
            """
            INSERT INTO research_chunks(note_id, document_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, ?, 0, 'A', 'old linked chunk', 3, 'obsidian', 'now')
            """,
            (note_id, document_id),
        )
        base.execute(
            """
            INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 1, 'A', 'old legacy chunk', 3, 'obsidian', 'now')
            """,
            (note_id,),
        )
        base.commit()
        conn = RecordingPostgresConnection(base)

        created, _embedded = replace_document_chunks(
            conn,
            test_settings(),
            document_id=document_id,
            legacy_note_id=note_id,
            source="obsidian",
            chunks=[{"heading": "A", "text": "new chunk text with enough detail", "token_count": 6}],
            embedder=lambda _settings, _text: None,
        )

        self.assertEqual(created, 1)
        advisory = [sql for sql, _params in conn.statements if "pg_advisory_xact_lock" in sql]
        self.assertEqual(len(advisory), 2)
        deletes = [" ".join(sql.lower().split()) for sql, _params in conn.statements if sql.lower().startswith("delete")]
        self.assertEqual(len(deletes), 2)
        self.assertNotIn("document_id = ? or note_id = ?", deletes[0])
        self.assertNotIn("document_id = ? or note_id = ?", deletes[1])
        self.assertEqual(
            base.execute("SELECT COUNT(*) AS count FROM research_chunks WHERE document_id = ?", (document_id,)).fetchone()["count"],
            1,
        )
        self.assertEqual(
            base.execute("SELECT COUNT(*) AS count FROM research_chunks WHERE note_id = ? AND document_id IS NULL", (note_id,)).fetchone()["count"],
            0,
        )

    def test_postgres_sync_obsidian_uses_session_advisory_lock(self) -> None:
        conn = RecordingPostgresConnection()
        settings = Settings(**{**test_settings().__dict__, "obsidian_vault_path": Path("test-vault")})

        with patch("worker.obsidian._sync_obsidian_unlocked", return_value={"notes_seen": 0}) as inner:
            result = sync_obsidian(conn, settings)

        self.assertEqual(result, {"notes_seen": 0})
        inner.assert_called_once()
        statements = [sql for sql, _params in conn.statements]
        self.assertTrue(any("pg_advisory_lock" in sql for sql in statements))
        self.assertTrue(any("pg_advisory_unlock" in sql for sql in statements))


if __name__ == "__main__":
    unittest.main()
