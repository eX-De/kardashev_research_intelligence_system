from __future__ import annotations

import json
import sqlite3
import unittest

from worker.db import init_db, to_json
from worker.migrations import migrate_system_first_sqlite, validate_system_first_migration


class SystemFirstModelTests(unittest.TestCase):
    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        return conn

    def test_system_first_tables_exist_and_chunks_accept_documents(self) -> None:
        conn = self._conn()
        tables = {
            row["name"]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        for table in (
            "knowledge_documents",
            "project_context_documents",
            "research_chunks",
            "papers",
            "paper_sources",
            "paper_assets",
            "paper_chunks",
            "artifacts",
        ):
            self.assertIn(table, tables)

        cur = conn.execute(
            """
            INSERT INTO knowledge_documents(
              source_type, source_uri, title, raw_content, content_hash,
              metadata_json, indexed_at, created_at, updated_at
            )
            VALUES ('manual_project', 'project:1', 'Manual Context', 'body', 'hash', '{}', 'now', 'now', 'now')
            """
        )
        document_id = int(cur.lastrowid)
        conn.execute(
            """
            INSERT INTO research_chunks(document_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'Context', 'body', 1, 'manual_project', 'now')
            """,
            (document_id,),
        )
        row = conn.execute("SELECT note_id, document_id FROM research_chunks").fetchone()
        self.assertIsNone(row["note_id"])
        self.assertEqual(row["document_id"], document_id)

    def test_system_first_migration_preserves_counts_and_key_mappings(self) -> None:
        conn = self._conn()
        self._seed_legacy_rows(conn)

        first = migrate_system_first_sqlite(conn, drop_legacy_artifact_tables=True)
        second = migrate_system_first_sqlite(conn, drop_legacy_artifact_tables=True)
        counts = validate_system_first_migration(conn)

        self.assertEqual(first["obsidian_notes_seen"], 1)
        self.assertEqual(second["knowledge_documents_from_obsidian"], 1)
        self.assertEqual(counts["knowledge_documents_obsidian"], 1)
        self.assertEqual(counts["research_chunks_with_document"], 2)
        self.assertEqual(counts["papers_arxiv"], 1)
        self.assertEqual(counts["paper_sources_arxiv"], 1)
        self.assertEqual(counts["arxiv_text_chunks"], 2)
        self.assertEqual(counts["paper_chunks"], 2)
        self.assertEqual(first["paper_reading_reports_seen"], 1)
        self.assertEqual(counts["paper_reading_reports"], 0)
        self.assertEqual(counts["paper_report_artifacts"], 1)
        self.assertEqual(first["project_artifacts_seen"], 1)
        self.assertEqual(counts["project_artifacts"], 0)
        self.assertEqual(counts["project_artifact_artifacts"], 1)
        legacy_tables = {
            row["name"]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        }
        self.assertNotIn("paper_reading_reports", legacy_tables)
        self.assertNotIn("project_artifacts", legacy_tables)

        document = conn.execute("SELECT * FROM knowledge_documents").fetchone()
        self.assertEqual(document["source_type"], "obsidian")
        self.assertEqual(document["source_uri"], "Research/Agentic RAG.md")
        self.assertEqual(document["content_hash"], "note-sha")
        self.assertIn("Planner context", document["raw_content"])
        self.assertEqual(json.loads(document["metadata_json"])["legacy_obsidian_note_id"], 1)

        chunk_documents = {
            row["document_id"]
            for row in conn.execute("SELECT document_id FROM research_chunks").fetchall()
        }
        self.assertEqual(chunk_documents, {document["id"]})
        relations = {
            row["relation"]
            for row in conn.execute("SELECT relation FROM project_context_documents").fetchall()
        }
        self.assertEqual(relations, {"source", "center_page"})

        paper = conn.execute("SELECT * FROM papers").fetchone()
        self.assertEqual(paper["canonical_key"], "arxiv:2605.00001")
        self.assertEqual(paper["title"], "Agentic Retrieval")
        self.assertEqual(paper["abstract"], "Paper summary")
        self.assertEqual(paper["year"], 2026)
        self.assertEqual(paper["arxiv_id"], "2605.00001")
        self.assertEqual(paper["library_status"], "candidate")

        source = conn.execute("SELECT * FROM paper_sources").fetchone()
        self.assertEqual(source["paper_id"], paper["id"])
        self.assertEqual(source["source_type"], "arxiv")
        self.assertEqual(source["source_identifier"], "2605.00001")
        self.assertEqual(source["source_url"], "https://arxiv.org/abs/2605.00001")
        self.assertEqual(source["fetched_batch_id"], "batch-1")
        self.assertEqual(json.loads(source["metadata_json"])["categories"], ["cs.AI"])

        assets = {
            row["asset_type"]: row
            for row in conn.execute("SELECT * FROM paper_assets ORDER BY asset_type").fetchall()
        }
        self.assertEqual(assets["pdf"]["path"], "data/papers/2605.00001.pdf")
        self.assertEqual(assets["pdf"]["url"], "https://arxiv.org/pdf/2605.00001")
        self.assertEqual(assets["pdf"]["status"], "available")
        self.assertEqual(assets["text"]["path"], "data/text/2605.00001.txt")
        self.assertEqual(assets["text"]["status"], "done")

        paper_chunks = conn.execute("SELECT * FROM paper_chunks ORDER BY chunk_index").fetchall()
        self.assertEqual([row["text"] for row in paper_chunks], ["chunk zero", "chunk one"])
        self.assertEqual({row["asset_id"] for row in paper_chunks}, {assets["text"]["id"]})

        report = conn.execute(
            "SELECT * FROM artifacts WHERE scope_type = 'paper' AND artifact_type = 'paper_report'"
        ).fetchone()
        self.assertEqual(report["scope_id"], paper["id"])
        self.assertEqual(report["content_markdown"], "# Report")
        self.assertEqual(report["model_provider_id"], "openai")
        self.assertEqual(report["model"], "gpt-test")
        self.assertEqual(report["input_hash"], "hash-text")

        project_artifact = conn.execute(
            "SELECT * FROM artifacts WHERE scope_type = 'project'"
        ).fetchone()
        self.assertEqual(project_artifact["scope_id"], 1)
        self.assertEqual(project_artifact["artifact_type"], "project_index")
        self.assertEqual(project_artifact["title"], "Project Index")
        self.assertEqual(
            json.loads(project_artifact["source_json"])["obsidian_path"],
            "Research/Agentic RAG/Index.md",
        )

    def _seed_legacy_rows(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE paper_reading_reports (
              paper_id INTEGER PRIMARY KEY REFERENCES arxiv_papers(id) ON DELETE CASCADE,
              status TEXT NOT NULL DEFAULT 'queued',
              prompt TEXT NOT NULL DEFAULT '',
              system_prompt TEXT NOT NULL DEFAULT '',
              model_provider_id TEXT NOT NULL DEFAULT '',
              model TEXT NOT NULL DEFAULT '',
              source_text_hash TEXT NOT NULL DEFAULT '',
              source_project_ids_json TEXT NOT NULL DEFAULT '[]',
              report_markdown TEXT NOT NULL DEFAULT '',
              error_message TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE project_artifacts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
              artifact_type TEXT NOT NULL,
              title TEXT NOT NULL,
              obsidian_path TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'planned',
              source_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(project_id, artifact_type, obsidian_path)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO obsidian_notes(
              id, path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at
            )
            VALUES (
              1, 'Research/Agentic RAG.md', 'Agentic RAG',
              '{"project": true}', '["project"]', 'note-sha', 1, '2026-05-17T00:00:00+00:00'
            )
            """
        )
        for index, text in enumerate(("Planner context", "Evidence context")):
            conn.execute(
                """
                INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
                VALUES (1, ?, 'Context', ?, 2, 'obsidian', '2026-05-17T00:00:00+00:00')
                """,
                (index, text),
            )
        conn.execute(
            """
            INSERT INTO research_projects(
              id, name, status, summary, goals, keywords_json, obsidian_note_id,
              created_at, updated_at
            )
            VALUES (
              1, 'Agentic RAG', 'active', 'summary', 'goals', '["rag"]', 1,
              '2026-05-17T00:00:00+00:00', '2026-05-17T00:00:00+00:00'
            )
            """
        )
        conn.execute(
            """
            INSERT INTO project_notes(project_id, note_id, relation, note, created_at, updated_at)
            VALUES (1, 1, 'source', '', '2026-05-17T00:00:00+00:00', '2026-05-17T00:00:00+00:00')
            """
        )
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              id, arxiv_id, title, authors_json, summary, categories_json,
              published_at, updated_at, link, pdf_link, pdf_path, text_path,
              text_extracted_at, text_status, text_error, text_char_count,
              fetched_batch_id, created_at
            )
            VALUES (
              1, '2605.00001', 'Agentic Retrieval', '["A. Author"]', 'Paper summary',
              '["cs.AI"]', '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z',
              'https://arxiv.org/abs/2605.00001', 'https://arxiv.org/pdf/2605.00001',
              'data/papers/2605.00001.pdf', 'data/text/2605.00001.txt',
              '2026-05-03T00:00:00Z', 'done', '', 19, 'batch-1',
              '2026-05-17T00:00:00+00:00'
            )
            """
        )
        for index, text in enumerate(("chunk zero", "chunk one")):
            conn.execute(
                """
                INSERT INTO arxiv_text_chunks(
                  paper_id, chunk_index, source, page_start, page_end, text,
                  token_count, char_count, created_at
                )
                VALUES (1, ?, 'full_text', ?, ?, ?, 2, ?, '2026-05-17T00:00:00+00:00')
                """,
                (index, index + 1, index + 1, text, len(text)),
            )
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, model_provider_id, model,
              source_text_hash, source_project_ids_json, report_markdown,
              error_message, created_at, updated_at, started_at, finished_at
            )
            VALUES (
              1, 'done', 'prompt', 'system', 'openai', 'gpt-test', 'hash-text',
              '[1]', '# Report', '', '2026-05-17T00:00:00+00:00',
              '2026-05-17T01:00:00+00:00', '2026-05-17T00:30:00+00:00',
              '2026-05-17T01:00:00+00:00'
            )
            """
        )
        conn.execute(
            """
            INSERT INTO project_artifacts(
              id, project_id, artifact_type, title, obsidian_path, status,
              source_json, created_at, updated_at
            )
            VALUES (
              1, 1, 'project_index', 'Project Index', 'Research/Agentic RAG/Index.md',
              'published', ?, '2026-05-17T00:00:00+00:00',
              '2026-05-17T01:00:00+00:00'
            )
            """,
            (to_json({"kind": "index"}),),
        )
        conn.commit()


if __name__ == "__main__":
    unittest.main()
