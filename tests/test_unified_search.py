from __future__ import annotations

import sqlite3
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from worker.artifact_index import enqueue_artifact_index, index_artifact, remove_artifact_index
from worker.search_backfill import backfill_search_indexes
from worker.unified_search import deep_search
from worker.knowledge import chunk_markdown
from worker.library_search_index import enqueue_library_paper_index


class FakeSettings:
    def __init__(self, model: str = "embed-v1") -> None:
        self.llm_embedding_model = model
        self.embedding_concurrency = 1
        self._provider = SimpleNamespace(api_key="key", base_url="https://example.test/v1")

    def embedding_provider(self):
        return self._provider


def connection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, scope_type TEXT, scope_id INTEGER,
          artifact_type TEXT, title TEXT, content_markdown TEXT, content_json TEXT DEFAULT '{}',
          status TEXT, source_json TEXT DEFAULT '{}', model_provider_id TEXT DEFAULT '',
          model TEXT DEFAULT '', input_hash TEXT DEFAULT '', created_at TEXT, updated_at TEXT
        );
        CREATE TABLE artifact_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id INTEGER, chunk_index INTEGER,
          heading TEXT, text TEXT, content_hash TEXT, created_at TEXT,
          UNIQUE(artifact_id, chunk_index)
        );
        CREATE TABLE artifact_chunk_embeddings (
          artifact_chunk_id INTEGER, model TEXT, embedding_json TEXT, created_at TEXT,
          PRIMARY KEY(artifact_chunk_id, model)
        );
        CREATE TABLE worker_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT, status TEXT, priority INTEGER,
          payload_json TEXT, result_json TEXT DEFAULT '{}', error_message TEXT DEFAULT '', attempts INTEGER DEFAULT 0,
          max_attempts INTEGER, run_after TEXT, locked_by TEXT DEFAULT '', locked_at TEXT,
          created_at TEXT, updated_at TEXT, started_at TEXT, finished_at TEXT, job_run_id INTEGER
        );
        """
    )
    return conn


class ArtifactIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = connection()
        self.conn.execute(
            """
            INSERT INTO artifacts(scope_type, scope_id, artifact_type, title, content_markdown, status, created_at, updated_at)
            VALUES ('system', NULL, 'daily_report', 'Daily', '# Finding\n\nA sufficiently long research finding for indexing and semantic retrieval.', 'ready', '2026-01-01', '2026-01-01')
            """
        )
        self.conn.commit()

    def tearDown(self) -> None:
        self.conn.close()

    @patch("worker.artifact_index.embed_many", return_value=[[1.0, 0.0]])
    def test_content_hash_is_idempotent_and_model_change_reuses_chunks(self, mocked_embed) -> None:
        first = index_artifact(self.conn, FakeSettings("embed-v1"), 1)
        self.assertEqual(first["artifact_chunks_created"], 1)
        self.assertEqual(first["artifact_embeddings_created"], 1)

        second = index_artifact(self.conn, FakeSettings("embed-v1"), 1)
        self.assertTrue(second["unchanged"])
        self.assertEqual(mocked_embed.call_count, 1)

        third = index_artifact(self.conn, FakeSettings("embed-v2"), 1)
        self.assertEqual(third["artifact_chunks_created"], 0)
        self.assertEqual(mocked_embed.call_count, 2)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM artifact_chunks").fetchone()[0], 1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM artifact_chunk_embeddings").fetchone()[0], 2)

    def test_stale_removal_and_queue_delivery_are_idempotent(self) -> None:
        artifact = {
            "id": 1, "artifact_type": "daily_report", "title": "Daily",
            "content_markdown": "body", "status": "ready",
        }
        first = enqueue_artifact_index(self.conn, FakeSettings(), artifact)
        second = enqueue_artifact_index(self.conn, FakeSettings(), artifact)
        self.assertTrue(first["queued"])
        self.assertTrue(second["deduplicated"])
        self.conn.execute("INSERT INTO artifact_chunks(artifact_id, chunk_index, heading, text, content_hash, created_at) VALUES (1, 0, '', 'text', 'hash', 'now')")
        removed = remove_artifact_index(self.conn, 1)
        self.assertEqual(removed["artifact_chunks_removed"], 1)

    def test_library_paper_index_queue_is_deduplicated_per_model(self) -> None:
        first = enqueue_library_paper_index(self.conn, FakeSettings("embed-v1"), 7)
        second = enqueue_library_paper_index(self.conn, FakeSettings("embed-v1"), 7)
        third = enqueue_library_paper_index(self.conn, FakeSettings("embed-v2"), 7)

        self.assertTrue(first["queued"])
        self.assertTrue(second["deduplicated"])
        self.assertTrue(third["queued"])
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM worker_jobs WHERE job_type = 'library-paper-index'").fetchone()[0],
            2,
        )

    def test_markdown_chunking_keeps_long_paragraph_tail(self) -> None:
        body = " ".join([*(f"token{i:04d}" for i in range(600)), "TAIL_SENTINEL"])
        chunks = chunk_markdown("Long", body, max_chars=200)
        self.assertGreater(len(chunks), 2)
        self.assertIn("TAIL_SENTINEL", " ".join(str(chunk["text"]) for chunk in chunks))
        self.assertTrue(all(len(str(chunk["text"])) <= 200 for chunk in chunks))

    @patch("worker.artifact_index.embed_many", return_value=[[1.0, 0.0]])
    def test_completed_paper_report_uses_generic_artifact_index(self, _embed) -> None:
        self.conn.execute(
            "UPDATE artifacts SET artifact_type = 'paper_report', status = 'done' WHERE id = 1"
        )
        self.conn.commit()
        result = index_artifact(self.conn, FakeSettings(), 1)
        self.assertEqual(result["artifact_embeddings_created"], 1)


class UnifiedDeepSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.conn = connection()
        self.conn.executescript(
            """
            CREATE TABLE arxiv_papers (
              id INTEGER PRIMARY KEY, arxiv_id TEXT, title TEXT, authors_json TEXT DEFAULT '[]',
              summary TEXT, categories_json TEXT DEFAULT '[]', updated_at TEXT
            );
            CREATE TABLE papers (
              id INTEGER PRIMARY KEY, arxiv_id TEXT DEFAULT '', title TEXT DEFAULT '', abstract TEXT DEFAULT '',
              authors_json TEXT DEFAULT '[]', venue TEXT DEFAULT '', user_tags_json TEXT DEFAULT '[]',
              user_note TEXT DEFAULT '', library_status TEXT DEFAULT 'candidate', updated_at TEXT DEFAULT ''
            );
            CREATE TABLE paper_sources (paper_id INTEGER, source_identifier TEXT);
            CREATE TABLE paper_reader_messages (
              id INTEGER PRIMARY KEY, paper_id INTEGER, library_paper_id INTEGER, content TEXT, created_at TEXT
            );
            CREATE TABLE arxiv_paper_embeddings (paper_id INTEGER, model TEXT, embedding_json TEXT);
            CREATE TABLE arxiv_text_chunks (id INTEGER PRIMARY KEY, paper_id INTEGER, chunk_index INTEGER DEFAULT 0, text TEXT, page_start INTEGER, page_end INTEGER);
            CREATE TABLE arxiv_chunk_embeddings (arxiv_chunk_id INTEGER, model TEXT, embedding_json TEXT);
            CREATE TABLE paper_chunks (id INTEGER PRIMARY KEY, paper_id INTEGER, chunk_index INTEGER DEFAULT 0, text TEXT, page_start INTEGER, page_end INTEGER);
            CREATE TABLE paper_embeddings (paper_id INTEGER, model TEXT, embedding_json TEXT);
            CREATE TABLE paper_chunk_embeddings (paper_chunk_id INTEGER, model TEXT, embedding_json TEXT);
            CREATE TABLE knowledge_documents (
              id INTEGER PRIMARY KEY, source_type TEXT, title TEXT DEFAULT '', raw_content TEXT DEFAULT '',
              metadata_json TEXT, updated_at TEXT DEFAULT ''
            );
            CREATE TABLE research_chunks (id INTEGER PRIMARY KEY, document_id INTEGER, text TEXT);
            CREATE TABLE chunk_embeddings (chunk_id INTEGER, model TEXT, embedding_json TEXT);
            CREATE TABLE project_context_documents (project_id INTEGER, document_id INTEGER);
            CREATE TABLE research_projects (
              id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active',
              summary TEXT DEFAULT '', goals TEXT DEFAULT '', keywords_json TEXT DEFAULT '[]', updated_at TEXT
            );
            INSERT INTO arxiv_papers(id, arxiv_id, title, summary, updated_at)
            VALUES (1, '2601.00001', 'Vector paper', 'semantic retrieval', '2026-01-02');
            INSERT INTO papers(id, arxiv_id, title, abstract, updated_at)
            VALUES (11, '2601.00001', 'Vector paper', 'semantic retrieval', '2026-01-02');
            INSERT INTO paper_embeddings VALUES (11, 'embed-v1', '[1, 0]');
            INSERT INTO paper_chunks(id, paper_id, text, page_start, page_end)
            VALUES (110, 11, 'full paper evidence', 2, 3);
            INSERT INTO paper_chunk_embeddings VALUES (110, 'embed-v1', '[0.95, 0.05]');
            INSERT INTO arxiv_paper_embeddings VALUES (1, 'embed-v1', '[1, 0]');
            INSERT INTO arxiv_text_chunks(id, paper_id, text, page_start, page_end)
            VALUES (10, 1, 'full paper evidence', 2, 3);
            INSERT INTO arxiv_chunk_embeddings VALUES (10, 'embed-v1', '[0.95, 0.05]');
            INSERT INTO artifacts VALUES (2, 'system', NULL, 'daily_report', 'Daily insight', 'daily body', '{}', 'ready', '{}', '', '', '', '2026-01-01', '2026-01-03');
            INSERT INTO artifact_chunks VALUES (20, 2, 0, 'Daily insight', 'daily semantic evidence', 'h1', '2026-01-03');
            INSERT INTO artifact_chunk_embeddings VALUES (20, 'embed-v1', '[0.9, 0.1]', '2026-01-03');
            INSERT INTO artifacts VALUES (3, 'project', 7, 'project_chat_profile', 'Project profile', 'profile body', '{}', 'ready', '{}', '', '', '', '2026-01-01', '2026-01-04');
            INSERT INTO artifact_chunks VALUES (30, 3, 0, 'Project profile', 'project semantic evidence', 'h2', '2026-01-04');
            INSERT INTO artifact_chunk_embeddings VALUES (30, 'embed-v1', '[0.85, 0.15]', '2026-01-04');
            INSERT INTO research_projects(id, name, updated_at) VALUES (7, 'Search project', '2026-01-04');
            INSERT INTO artifacts VALUES (4, 'project', 7, 'experiment_report', 'Experiment', 'experiment body', '{}', 'ready', '{}', '', '', '', '2026-01-01', '2026-01-05');
            INSERT INTO knowledge_documents(id, source_type, title, raw_content, metadata_json, updated_at)
            VALUES (40, 'experiment_report', 'Experiment', 'experiment semantic evidence', '{"artifact_id": 4, "project_id": 7}', '2026-01-05');
            INSERT INTO research_chunks VALUES (41, 40, 'experiment semantic evidence');
            INSERT INTO chunk_embeddings VALUES (41, 'embed-v1', '[0.8, 0.2]');
            """
        )

    def tearDown(self) -> None:
        self.conn.close()

    @patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={})
    @patch("worker.unified_search.embed_text", return_value=[1.0, 0.0])
    def test_one_query_embedding_aggregates_all_business_entities(self, mocked_embed, _mocked_indexes) -> None:
        result = deep_search(
            self.conn,
            FakeSettings(),
            {"query": "semantic", "types": ["paper", "artifact", "project"], "limit": 20},
        )
        self.assertEqual(mocked_embed.call_count, 1)
        keys = {(item["entity_type"], item["entity_id"]) for item in result["results"]}
        self.assertIn(("paper", 11), keys)
        self.assertIn(("artifact", 2), keys)
        self.assertIn(("artifact", 4), keys)
        self.assertIn(("project", 7), keys)
        paper = next(item for item in result["results"] if item["entity_type"] == "paper")
        self.assertEqual(len(paper["evidence"]), 2)
        self.assertEqual(paper["href"], "/papers/library/11")
        self.assertFalse(result["stats"]["partial"])

    @patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={})
    @patch("worker.unified_search.embed_text", return_value=[1.0, 0.0])
    def test_keyword_recall_adds_unembedded_entities_to_deep_results(self, _embed, _indexes) -> None:
        self.conn.executescript(
            """
            INSERT INTO arxiv_papers(id, arxiv_id, title, summary, updated_at)
            VALUES (2, '2601.00002', '论文检索方法', '关键词候选', '2026-01-06');
            INSERT INTO papers(id, title, abstract, updated_at)
            VALUES (14, '论文检索方法', '关键词入库论文', '2026-01-06');
            INSERT INTO artifacts VALUES (5, 'system', NULL, 'daily_report', '论文检索日报', '关键词产物', '{}', 'ready', '{}', '', '', '', '2026-01-01', '2026-01-07');
            INSERT INTO research_projects(id, name, keywords_json, updated_at)
            VALUES (8, '新的论文检索范式', '["论文", "检索"]', '2026-01-08');
            """
        )

        result = deep_search(
            self.conn,
            FakeSettings(),
            {"query": "论文检索", "types": ["paper", "artifact", "project"], "limit": 20},
        )

        keys = {(item["entity_type"], item["entity_id"]) for item in result["results"]}
        self.assertNotIn(("paper", 2), keys)
        self.assertIn(("paper", 14), keys)
        self.assertIn(("artifact", 5), keys)
        self.assertIn(("project", 8), keys)
        project = next(item for item in result["results"] if item["entity_type"] == "project" and item["entity_id"] == 8)
        self.assertIn("title", project["matched_by"])
        self.assertNotIn("semantic", project["matched_by"])
        self.assertEqual(project["evidence"], [])
        self.assertGreaterEqual(result["stats"]["retrieval_counts"]["keyword"], 3)

    @patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={})
    @patch("worker.unified_search.embed_text", return_value=[1.0, 0.0])
    def test_keyword_and_semantic_hits_merge_into_one_entity(self, _embed, _indexes) -> None:
        result = deep_search(
            self.conn,
            FakeSettings(),
            {"query": "Search project", "types": ["project"], "limit": 20},
        )

        projects = [item for item in result["results"] if item["entity_type"] == "project" and item["entity_id"] == 7]
        self.assertEqual(len(projects), 1)
        self.assertIn("title", projects[0]["matched_by"])
        self.assertIn("semantic", projects[0]["matched_by"])
        self.assertEqual(result["stats"]["retrieval_counts"]["fused"], 1)

    @patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={})
    @patch("worker.unified_search.embed_text", return_value=[1.0, 0.0])
    def test_deep_search_filters_final_fusion_scores_below_point_four(self, _embed, _indexes) -> None:
        self.conn.execute("DELETE FROM paper_embeddings")
        self.conn.execute("DELETE FROM paper_chunk_embeddings")
        self.conn.execute(
            "INSERT INTO papers(id, title, abstract, updated_at) VALUES (16, 'Weak neighbor', 'unrelated content', '2026-01-09')"
        )
        self.conn.execute(
            "INSERT INTO paper_embeddings VALUES (16, 'embed-v1', '[0.3, 0.9539392014]')"
        )

        result = deep_search(
            self.conn,
            FakeSettings(),
            {"query": "completely different", "types": ["paper"], "limit": 20},
        )

        self.assertEqual(result["results"], [])
        self.assertEqual(result["stats"]["score_threshold"], 0.4)
        self.assertEqual(result["stats"]["filtered_by_score_threshold"], 1)

    @patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={})
    @patch("worker.unified_search.embed_text", return_value=[1.0, 0.0])
    @patch("worker.unified_search._library_paper_results", side_effect=RuntimeError("paper source down"))
    def test_source_failure_preserves_other_results(self, _failed_source, _embed, _indexes) -> None:
        result = deep_search(
            self.conn,
            FakeSettings(),
            {"query": "semantic", "types": ["paper", "artifact"], "limit": 20},
        )
        self.assertTrue(result["stats"]["partial"])
        self.assertEqual(result["stats"]["partial_failures"][0]["source"], "library_papers")
        self.assertIn(("paper", 11), {(item["entity_type"], item["entity_id"]) for item in result["results"]})

    @patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={})
    @patch("worker.unified_search.embed_text", return_value=[1.0, 0.0])
    def test_local_papers_and_non_obsidian_project_context_share_deep_corpus(self, _embed, _indexes) -> None:
        self.conn.executescript(
            """
            INSERT INTO papers(id, title, abstract, user_note, updated_at)
            VALUES (12, 'Simulating Human Memory with Language Models', 'memory simulation', '人类记忆', '2026-01-09');
            INSERT INTO paper_embeddings VALUES (12, 'embed-v1', '[1, 0]');
            INSERT INTO paper_chunks(id, paper_id, text, page_start, page_end)
            VALUES (120, 12, 'human memory full text', 4, 5);
            INSERT INTO paper_chunk_embeddings VALUES (120, 'embed-v1', '[0.98, 0.02]');

            INSERT INTO knowledge_documents(id, source_type, title, raw_content, metadata_json, updated_at)
            VALUES (50, 'manual_project', 'Memory context', '人类记忆研究上下文', '{"project_id": 7}', '2026-01-10');
            INSERT INTO project_context_documents VALUES (7, 50);
            INSERT INTO research_chunks VALUES (51, 50, 'human memory project evidence');
            INSERT INTO chunk_embeddings VALUES (51, 'embed-v1', '[0.97, 0.03]');

            INSERT INTO knowledge_documents(id, source_type, title, raw_content, metadata_json, updated_at)
            VALUES (60, 'obsidian', 'Obsidian memory', '人类记忆 private vault', '{}', '2026-01-11');
            INSERT INTO project_context_documents VALUES (7, 60);
            INSERT INTO research_chunks VALUES (61, 60, 'obsidian-only semantic evidence');
            INSERT INTO chunk_embeddings VALUES (61, 'embed-v1', '[1, 0]');
            """
        )

        result = deep_search(
            self.conn,
            FakeSettings(),
            {"query": "人类记忆", "types": ["paper", "project"], "limit": 20},
        )
        local = next(item for item in result["results"] if item["entity_type"] == "paper" and item["entity_id"] == 12)
        self.assertEqual(local["href"], "/papers/library/12")
        project = next(item for item in result["results"] if item["entity_type"] == "project" and item["entity_id"] == 7)
        self.assertTrue(any(hit["source_type"] == "manual_project" for hit in project["evidence"]))
        self.assertFalse(any(hit["source_type"] == "obsidian" for hit in project["evidence"]))

    @patch("worker.search_backfill.backfill_artifact_indexes", return_value={"artifacts_considered": 4})
    @patch("worker.search_backfill.ensure_missing_note_chunk_embeddings", return_value={"note_chunk_embeddings_created": 2})
    @patch("worker.search_backfill.backfill_library_paper_indexes", return_value={"library_papers_considered": 5})
    def test_search_backfill_orchestrates_every_non_obsidian_corpus(
        self, _library, knowledge, _artifacts
    ) -> None:
        result = backfill_search_indexes(self.conn, FakeSettings())
        self.assertNotIn("arxiv_papers_considered", result)
        self.assertNotIn("arxiv_chunk_embeddings_created", result)
        self.assertEqual(result["library_papers_considered"], 5)
        self.assertEqual(result["note_chunk_embeddings_created"], 2)
        self.assertEqual(result["artifacts_considered"], 4)
        self.assertEqual(knowledge.call_args.kwargs["excluded_source_types"], {"obsidian"})

    @patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={})
    @patch("worker.unified_search.embed_text", return_value=[1.0, 0.0])
    def test_imported_reader_paper_is_canonicalized_to_one_library_link(self, _embed, _indexes) -> None:
        self.conn.executescript(
            """
            INSERT INTO arxiv_papers(id, arxiv_id, title, summary, updated_at)
            VALUES (3, 'reader-upload-deadbeef', 'Imported memory paper', 'reader import', '2026-01-12');
            INSERT INTO papers(id, title, abstract, updated_at)
            VALUES (13, 'Imported memory paper', 'reader import', '2026-01-12');
            INSERT INTO paper_sources VALUES (13, 'reader-upload-deadbeef');
            """
        )
        result = deep_search(
            self.conn,
            FakeSettings(),
            {"query": "Imported memory paper", "types": ["paper"], "limit": 20},
        )
        imported = [item for item in result["results"] if item["title"] == "Imported memory paper"]
        self.assertEqual(len(imported), 1)
        self.assertEqual(imported[0]["entity_id"], 13)
        self.assertEqual(imported[0]["href"], "/papers/library/13")

    @patch("worker.unified_search._ensure_search_pgvector_indexes", return_value={})
    @patch("worker.unified_search.embed_text", return_value=[1.0, 0.0])
    def test_arxiv_rows_are_excluded_while_library_reader_messages_remain_searchable(self, _embed, _indexes) -> None:
        self.conn.execute("DELETE FROM paper_embeddings")
        self.conn.execute("DELETE FROM paper_chunk_embeddings")
        self.conn.execute(
            "INSERT INTO papers(id, title, abstract, library_status, updated_at) VALUES (15, 'Archived secret', 'Archived secret', 'archived', '2026-01-13')"
        )
        self.conn.execute("INSERT INTO paper_embeddings VALUES (15, 'embed-v1', '[1, 0]')")
        self.conn.execute(
            "INSERT INTO paper_reader_messages VALUES (70, 1, 11, 'Reader secret', '2026-01-13')"
        )
        statements: list[str] = []
        self.conn.set_trace_callback(statements.append)
        result = deep_search(
            self.conn,
            FakeSettings(),
            {"query": "Reader secret", "types": ["paper"], "limit": 20},
        )
        self.conn.set_trace_callback(None)
        self.assertEqual([(item["entity_id"], item["href"]) for item in result["results"]], [(11, "/papers/library/11")])
        self.assertFalse(any("arxiv" in source for source in result["stats"]["searched_sources"]))
        self.assertFalse(any(" arxiv_" in statement.lower() for statement in statements))


if __name__ == "__main__":
    unittest.main()
