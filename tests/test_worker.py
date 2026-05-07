from __future__ import annotations

import sqlite3
import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from worker.config import LLMProvider, Settings
from worker.api import (
    export_project_to_obsidian,
    link_project_note,
    link_project_paper,
    project_detail,
    projects,
    save_project,
    unlink_project_paper,
    update_paper_recommendation,
)
from worker.arxiv_archive import archive_zero_match_papers
from worker.arxiv_client import fetch_arxiv
from worker.arxiv_text import cache_arxiv_full_texts, download_pdf, extract_pdf_text_to_file, safe_arxiv_filename
from worker.cli import _daily_papers_for_run, _prefilter_daily_papers
from worker.db import clean_unicode, init_db, to_json
from worker.embeddings import ensure_arxiv_chunk_embedding
from worker.llm import _project_judgment_prompt, generate_missing_project_judgments
from worker.obsidian import parse_note
from worker.obsidian import sync_obsidian
from worker.recommendations import sync_project_paper_recommendations
from worker.reports import generate_daily_report
from worker.search import hybrid_search, rank_project_papers, rank_unmatched_papers
from worker.settings_store import apply_stored_settings, get_app_settings, save_app_settings


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
    )


def embedding_settings() -> Settings:
    base = test_settings()
    return Settings(
        **{
            **base.__dict__,
            "llm_providers": [
                LLMProvider(
                    id="test",
                    name="Test",
                    base_url="",
                    api_key="",
                    chat_models=[],
                    embedding_models=["mock-embedding"],
                )
            ],
            "llm_embedding_provider_id": "test",
            "llm_embedding_model": "mock-embedding",
        }
    )


def chat_settings(settings: Settings) -> Settings:
    return Settings(
        **{
            **settings.__dict__,
            "llm_providers": [
                LLMProvider(
                    id="test-chat",
                    name="Test Chat",
                    base_url="https://llm.test/v1",
                    api_key="test-key",
                    chat_models=["test-chat-model"],
                    embedding_models=[],
                )
            ],
            "llm_chat_provider_id": "test-chat",
            "llm_chat_model": "test-chat-model",
        }
    )


class WorkerTests(unittest.TestCase):
    def test_fetch_arxiv_stops_when_page_reaches_lookback_cutoff(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        recent = now.isoformat().replace("+00:00", "Z")
        old = (now - timedelta(days=2)).isoformat().replace("+00:00", "Z")

        def entry(arxiv_id: str, title: str, published: str) -> str:
            return f"""
              <entry>
                <id>https://arxiv.org/abs/{arxiv_id}</id>
                <title>{title}</title>
                <summary>Abstract</summary>
                <published>{published}</published>
                <updated>{published}</updated>
                <author><name>Author</name></author>
                <category term="cs.AI" />
                <link rel="alternate" href="https://arxiv.org/abs/{arxiv_id}" />
                <link title="pdf" href="https://arxiv.org/pdf/{arxiv_id}" />
              </entry>
            """

        feed = f"""
          <feed xmlns="http://www.w3.org/2005/Atom">
            {entry("2605.00001", "Recent", recent)}
            {entry("2604.00001", "Old", old)}
          </feed>
        """
        settings = Settings(**{**test_settings().__dict__, "arxiv_max_results": 250})
        with patch("worker.arxiv_client._fetch_page", return_value=feed) as fetch_page:
            result = fetch_arxiv(conn, settings)

        self.assertEqual(fetch_page.call_count, 1)
        self.assertEqual(result["pages_fetched"], 1)
        self.assertEqual(result["stopped_at_cutoff"], 1)
        self.assertEqual(result["papers_inserted"], 1)
        arxiv_ids = [row["arxiv_id"] for row in conn.execute("SELECT arxiv_id FROM arxiv_papers")]
        self.assertEqual(arxiv_ids, ["2605.00001"])

    def test_fetch_arxiv_skips_tombstoned_papers(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        conn.execute(
            """
            INSERT INTO arxiv_paper_tombstones(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, reason, original_fetched_batch_id, tombstoned_at
            )
            VALUES (
              '2605.00001', 'Ignored', '[]', 'Abstract', '["cs.AI"]', ?, ?,
              'https://arxiv.org/abs/2605.00001', 'https://arxiv.org/pdf/2605.00001',
              'no_match', 'old', 'now'
            )
            """,
            (now, now),
        )
        conn.commit()

        def entry(arxiv_id: str, title: str) -> str:
            return f"""
              <entry>
                <id>https://arxiv.org/abs/{arxiv_id}</id>
                <title>{title}</title>
                <summary>Abstract</summary>
                <published>{now}</published>
                <updated>{now}</updated>
                <author><name>Author</name></author>
                <category term="cs.AI" />
                <link rel="alternate" href="https://arxiv.org/abs/{arxiv_id}" />
                <link title="pdf" href="https://arxiv.org/pdf/{arxiv_id}" />
              </entry>
            """

        feed = f"""
          <feed xmlns="http://www.w3.org/2005/Atom">
            {entry("2605.00001", "Ignored")}
            {entry("2605.00002", "New")}
          </feed>
        """
        with patch("worker.arxiv_client._fetch_page", return_value=feed):
            result = fetch_arxiv(conn, test_settings())

        self.assertEqual(result["papers_seen"], 2)
        self.assertEqual(result["papers_inserted"], 1)
        self.assertEqual(result["papers_tombstone_skipped"], 1)
        arxiv_ids = [row["arxiv_id"] for row in conn.execute("SELECT arxiv_id FROM arxiv_papers")]
        self.assertEqual(arxiv_ids, ["2605.00002"])
        tombstone = conn.execute(
            "SELECT seen_count, last_seen_at FROM arxiv_paper_tombstones WHERE arxiv_id = '2605.00001'"
        ).fetchone()
        self.assertEqual(tombstone["seen_count"], 1)
        self.assertIsNotNone(tombstone["last_seen_at"])

    def test_pdf_download_retries_once_after_429(self) -> None:
        class FakeResponse:
            headers = {"content-type": "application/pdf"}

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self) -> bytes:
                return b"%PDF-" + (b"x" * 1200)

        target = Path.cwd() / ".test-tmp" / "pdf-retry" / "paper.pdf"
        calls = [urllib.error.HTTPError("https://arxiv.org/pdf/2605.00001", 429, "Too Many Requests", {}, BytesIO())]

        def fake_urlopen(*args, **kwargs):
            if calls:
                raise calls.pop(0)
            return FakeResponse()

        with patch("worker.arxiv_text.urllib.request.urlopen", side_effect=fake_urlopen) as urlopen:
            with patch("worker.arxiv_text.time.sleep") as sleep:
                download_pdf("https://arxiv.org/pdf/2605.00001", target)

        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(20)
        self.assertTrue(target.exists())

    def test_daily_papers_skip_previously_completed_papers(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)

        def insert_paper(arxiv_id: str, batch_id: str, text_status: str, text_path: str = "") -> int:
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json, published_at,
                  updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', 'Abstract', '["cs.CL"]',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?,
                  ?, ?, ?, 'now')
                """,
                (
                    arxiv_id,
                    arxiv_id,
                    f"https://arxiv.org/abs/{arxiv_id}",
                    f"https://arxiv.org/pdf/{arxiv_id}",
                    text_path,
                    text_status,
                    batch_id,
                ),
            )
            return int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])

        new_id = insert_paper("2605.00001", "current", "pending")
        completed_old_id = insert_paper("2604.00001", "old", "complete", "paper.txt")
        retry_old_id = insert_paper("2604.00002", "old", "pending")
        missing_chunks_old_id = insert_paper("2604.00003", "old", "complete", "paper-2.txt")
        missing_match_old_id = insert_paper("2604.00004", "old", "complete", "paper-3.txt")
        tombstoned_old_id = insert_paper("2604.00006", "old", "pending")
        conn.execute(
            """
            INSERT INTO arxiv_paper_tombstones(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, reason, original_fetched_batch_id, tombstoned_at
            )
            SELECT arxiv_id, title, authors_json, summary, categories_json, published_at,
                   updated_at, link, pdf_link, 'no_match', fetched_batch_id, 'now'
            FROM arxiv_papers
            WHERE id = ?
            """,
            (tombstoned_old_id,),
        )
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'metadata', 'already chunked', 2, 15, 'now')
            """,
            (completed_old_id,),
        )
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'metadata', 'needs ranking', 2, 13, 'now')
            """,
            (missing_match_old_id,),
        )
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/Done.md', 'Done', '{}', '[]', 'done', 1, 'now')
            """
        )
        note_id = conn.execute("SELECT id FROM obsidian_notes").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'Done', 'already matched context', 3, 'obsidian', 'now')
            """,
            (note_id,),
        )
        chunk_id = conn.execute("SELECT id FROM research_chunks").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO matches(paper_id, arxiv_chunk_id, chunk_id, score, searchers_json, evidence_json, created_at)
            VALUES (?, 1, ?, 0.9, '[]', '{}', 'now')
            """,
            (completed_old_id, chunk_id),
        )
        conn.commit()

        papers, result = _daily_papers_for_run(conn, test_settings(), "current")
        paper_ids = {int(paper["id"]) for paper in papers}

        self.assertEqual(paper_ids, {new_id, retry_old_id, missing_chunks_old_id, missing_match_old_id})
        self.assertEqual(result["daily_new_papers"], 1)
        self.assertEqual(result["daily_retry_papers"], 3)
        self.assertEqual(result["daily_retry_text_papers"], 2)
        self.assertEqual(result["daily_retry_global_match_papers"], 1)
        self.assertEqual(result["daily_candidate_papers"], 4)

    def test_daily_prefilter_bypasses_resume_papers_missing_ranking(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
            )
            VALUES ('2604.00005', 'Cached but unranked', '[]', 'Abstract', '["cs.CL"]',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
              'https://arxiv.org/abs/2604.00005', 'https://arxiv.org/pdf/2604.00005',
              'paper.txt', 'complete', 'old', 'now')
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 'cached text ready for ranking', 5, 29, 'now')
            """,
            (paper_id,),
        )
        conn.commit()
        settings = Settings(
            **{
                **test_settings().__dict__,
                "rag_prefilter_enabled": True,
                "rag_prefilter_min_keep": 0,
                "rag_prefilter_threshold": 0.99,
            }
        )
        selected: list[sqlite3.Row] = []

        result = _prefilter_daily_papers(conn, settings, "current", selected)

        self.assertEqual([int(paper["id"]) for paper in selected], [int(paper_id)])
        self.assertEqual(result["daily_retry_global_match_papers"], 1)
        self.assertEqual(result["prefilter_resume_bypassed"], 1)
        self.assertEqual(result["prefilter_passed"], 1)

    def test_archive_zero_match_papers_keeps_only_tombstone_metadata(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        root = Path.cwd() / ".test-tmp" / "zero-match-archive"
        root.mkdir(parents=True, exist_ok=True)
        pdf_path = root / "paper.pdf"
        text_path = root / "paper.txt"
        pdf_path.write_bytes(b"%PDF- archived")
        text_path.write_text("--- page 1 ---\nNo project relevance.", encoding="utf-8")
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, pdf_path, text_path, text_status,
              fetched_batch_id, created_at
            )
            VALUES (
              '2605.00003', 'No Match', '["Author"]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00003', 'https://arxiv.org/pdf/2605.00003',
              ?, ?, 'complete', 'batch', 'now'
            )
            """,
            (str(pdf_path), str(text_path)),
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 'No project relevance.', 3, 21, 'now')
            """,
            (paper_id,),
        )
        chunk_id = conn.execute("SELECT id FROM arxiv_text_chunks").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_chunk_embeddings(arxiv_chunk_id, model, embedding_json, created_at)
            VALUES (?, 'mock-embedding', '[0.1]', 'now')
            """,
            (chunk_id,),
        )
        conn.execute(
            """
            INSERT INTO arxiv_paper_embeddings(paper_id, model, embedding_json, created_at)
            VALUES (?, 'mock-embedding', '[0.2]', 'now')
            """,
            (paper_id,),
        )
        conn.execute(
            """
            INSERT INTO paper_prefilter_runs(paper_id, model, score, rank, passed, reason, top_chunks_json, created_at)
            VALUES (?, 'prefilter', 0.1, 1, 1, 'kept', '[]', 'now')
            """,
            (paper_id,),
        )
        conn.commit()

        result = archive_zero_match_papers(conn, test_settings(), [int(paper_id)])

        self.assertEqual(result["zero_match_papers_archived"], 1)
        self.assertEqual(result["zero_match_files_deleted"], 2)
        self.assertFalse(pdf_path.exists())
        self.assertFalse(text_path.exists())
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_text_chunks").fetchone()["count"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_chunk_embeddings").fetchone()["count"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_paper_embeddings").fetchone()["count"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM paper_prefilter_runs").fetchone()["count"], 0)
        tombstone = conn.execute("SELECT * FROM arxiv_paper_tombstones").fetchone()
        self.assertEqual(tombstone["arxiv_id"], "2605.00003")
        self.assertEqual(tombstone["title"], "No Match")
        self.assertEqual(tombstone["reason"], "no_match")

    def test_archive_zero_match_papers_keeps_failed_text_for_retry(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_status, fetched_batch_id, created_at
            )
            VALUES (
              '2605.00004', 'Retry Later', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00004', 'https://arxiv.org/pdf/2605.00004',
              'failed', 'batch', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.commit()

        result = archive_zero_match_papers(conn, test_settings(), [int(paper_id)])

        self.assertEqual(result["zero_match_papers_archived"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_paper_tombstones").fetchone()["count"], 0)

    def test_archive_removes_auto_candidates_rejected_by_project_judgment(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        root = Path.cwd() / ".test-tmp" / "judgment-archive"
        root.mkdir(parents=True, exist_ok=True)
        pdf_path = root / "paper.pdf"
        text_path = root / "paper.txt"
        pdf_path.write_bytes(b"%PDF- rejected")
        text_path.write_text("Rejected candidate.", encoding="utf-8")
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              'Agentic RAG', 'active', '[]', 'Research/Agentic RAG/Home.md',
              'Research/Agentic RAG', 'Research/Agentic RAG', 'Status/进行中',
              'obsidian', '["project"]', '[]', '{}', 'now', 'now'
            )
            """
        )
        project_id = conn.execute("SELECT id FROM research_projects").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, pdf_path, text_path, text_status,
              fetched_batch_id, created_at
            )
            VALUES (
              '2605.00009', 'Weak Candidate', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00009', 'https://arxiv.org/pdf/2605.00009',
              ?, ?, 'complete', 'batch', 'now'
            )
            """,
            (str(pdf_path), str(text_path)),
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 'Rejected candidate.', 2, 19, 'now')
            """,
            (paper_id,),
        )
        conn.execute(
            """
            INSERT INTO project_papers(project_id, paper_id, relation, note, created_at, updated_at)
            VALUES (?, ?, 'candidate', 'auto_matched_by_project_context', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.execute(
            """
            INSERT INTO project_paper_judgments(
              project_id, paper_id, relation_type, relevance_score, usefulness_score,
              confidence, suggested_action, reason, evidence_mapping_json,
              missing_evidence, input_hash, prompt_version, raw_json, created_at, updated_at
            )
            VALUES (?, ?, 'weak', 0.2, 0.2, 0.9, 'ignore', '弱相关',
              '[]', '', 'hash', 'test', '{}', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.commit()

        result = archive_zero_match_papers(conn, test_settings(), [int(paper_id)])

        self.assertEqual(result["zero_match_papers_archived"], 1)
        self.assertFalse(pdf_path.exists())
        self.assertFalse(text_path.exists())
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 0)

    def test_archive_keeps_passing_project_judgment(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              'Agentic RAG', 'active', '[]', 'Research/Agentic RAG/Home.md',
              'Research/Agentic RAG', 'Research/Agentic RAG', 'Status/进行中',
              'obsidian', '["project"]', '[]', '{}', 'now', 'now'
            )
            """
        )
        project_id = conn.execute("SELECT id FROM research_projects").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_status, fetched_batch_id, created_at
            )
            VALUES (
              '2605.00010', 'Keep Candidate', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00010', 'https://arxiv.org/pdf/2605.00010',
              'complete', 'batch', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_paper_judgments(
              project_id, paper_id, relation_type, relevance_score, usefulness_score,
              confidence, suggested_action, reason, evidence_mapping_json,
              missing_evidence, input_hash, prompt_version, raw_json, created_at, updated_at
            )
            VALUES (?, ?, 'indirect', 0.7, 0.7, 0.8, 'read', '可用',
              '[]', '', 'hash', 'test', '{}', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.execute(
            """
            INSERT INTO project_paper_recommendations(
              project_id, paper_id, state, importance, relation_type, reason,
              source_judgment_hash, created_at, updated_at
            )
            VALUES (?, ?, 'pending', '', 'indirect', '可用', 'hash', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.commit()

        result = archive_zero_match_papers(conn, test_settings(), [int(paper_id)])

        self.assertEqual(result["zero_match_papers_archived"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 1)

    def test_project_judgment_creates_pending_recommendation_without_importance(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              'Deep Steering', 'active', '[]', '人工智能/个人研究/深度引导/中心页.md',
              '人工智能/个人研究/深度引导', '人工智能/个人研究/深度引导',
              'Status/进行中', 'obsidian', '["project"]', '[]', '{}', 'now', 'now'
            )
            """
        )
        project_id = conn.execute("SELECT id FROM research_projects").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_status, fetched_batch_id, created_at
            )
            VALUES (
              '2605.00011', 'Useful Steering Paper', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00011', 'https://arxiv.org/pdf/2605.00011',
              'complete', 'batch', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_paper_judgments(
              project_id, paper_id, relation_type, relevance_score, usefulness_score,
              confidence, suggested_action, reason, evidence_mapping_json,
              missing_evidence, input_hash, prompt_version, raw_json, created_at, updated_at
            )
            VALUES (?, ?, 'direct', 0.9, 0.8, 0.9, 'read', '项目直接需要该机制。',
              '[]', '', 'hash-direct', 'test', '{}', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.commit()

        result = sync_project_paper_recommendations(conn, [int(paper_id)])

        self.assertEqual(result["paper_recommendations_created"], 1)
        recommendation = conn.execute("SELECT * FROM project_paper_recommendations").fetchone()
        self.assertEqual(recommendation["state"], "pending")
        self.assertEqual(recommendation["importance"], "")
        self.assertEqual(recommendation["relation_type"], "direct")

    def test_accept_recommendation_writes_paper_library_and_project_list(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        vault = Path.cwd() / ".test-tmp" / "recommendation-vault"
        project_folder = vault / "人工智能" / "个人研究" / "深度引导"
        project_folder.mkdir(parents=True, exist_ok=True)
        (project_folder / "中心页.md").write_text("# 深度引导\n", encoding="utf-8")
        pdf_dir = Path.cwd() / ".test-tmp" / "recommendation-pdfs"
        pdf_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = pdf_dir / "2605.00012.pdf"
        pdf_path.write_bytes(b"%PDF- recommendation")
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              '深度引导', 'active', '[]', '人工智能/个人研究/深度引导/中心页.md',
              '人工智能/个人研究/深度引导', '人工智能/个人研究/深度引导',
              'Status/进行中', 'obsidian', '["project"]', '[]', '{}', 'now', 'now'
            )
            """
        )
        selected_project_id = conn.execute("SELECT id FROM research_projects").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              '新的论文检索范式', 'active', '[]', '人工智能/个人研究/新的论文检索范式/中心页.md',
              '人工智能/个人研究/新的论文检索范式', '人工智能/个人研究/新的论文检索范式',
              'Status/进行中', 'obsidian', '["project"]', '[]', '{}', 'now', 'now'
            )
            """
        )
        discarded_project_id = conn.execute(
            "SELECT id FROM research_projects WHERE name = '新的论文检索范式'"
        ).fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, pdf_path, text_status, fetched_batch_id, created_at
            )
            VALUES (
              '2605.00012', 'Useful Control Paper', '[]', 'This paper helps control.',
              '["cs.AI"]', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00012', 'https://arxiv.org/pdf/2605.00012',
              ?, 'complete', 'batch', 'now'
            )
            """,
            (str(pdf_path),),
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        for project_id, relation in ((selected_project_id, "direct"), (discarded_project_id, "indirect")):
            conn.execute(
                """
                INSERT INTO project_paper_recommendations(
                  project_id, paper_id, state, importance, relation_type, reason,
                  source_judgment_hash, created_at, updated_at
                )
                VALUES (?, ?, 'pending', '', ?, '推荐理由', 'hash', 'now', 'now')
                """,
                (project_id, paper_id, relation),
            )
        conn.commit()

        settings = Settings(**{**test_settings().__dict__, "obsidian_vault_path": vault})
        result = update_paper_recommendation(
            conn,
            settings,
            int(paper_id),
            {"action": "accept", "importance": "high", "project_ids": [int(selected_project_id)]},
        )

        self.assertTrue(result["ok"])
        note_path = vault / "人工智能" / "论文仓库" / "Useful Control Paper.md"
        self.assertTrue(note_path.exists())
        note_text = note_path.read_text(encoding="utf-8")
        self.assertIn("Importance/高", note_text)
        self.assertIn("[[人工智能/个人研究/深度引导/中心页|深度引导]]：direct", note_text)
        self.assertNotIn("新的论文检索范式", note_text)
        self.assertTrue((vault / "人工智能" / "论文仓库" / "附件" / "2605.00012.pdf").exists())
        project_list = project_folder / "论文列表.md"
        self.assertTrue(project_list.exists())
        self.assertIn("[[人工智能/论文仓库/Useful Control Paper\\|Useful Control Paper]]", project_list.read_text(encoding="utf-8"))
        relation = conn.execute("SELECT relation FROM project_papers").fetchone()["relation"]
        self.assertEqual(relation, "reading")
        states = {
            int(row["project_id"]): row["state"]
            for row in conn.execute("SELECT project_id, state FROM project_paper_recommendations")
        }
        self.assertEqual(states[int(selected_project_id)], "accepted")
        self.assertEqual(states[int(discarded_project_id)], "discarded")

    def test_parse_note_frontmatter_and_tags(self) -> None:
        vault = Path.cwd() / ".test-tmp" / "vault"
        note = vault / "Research" / "Topic.md"
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text(
            "---\ntitle: Test Topic\ntags: [research, paper, Status/进行中]\n---\n# Heading\nBody #direction #project/foo",
            encoding="utf-8",
        )
        parsed = parse_note(vault, note)
        self.assertEqual(parsed.title, "Test Topic")
        self.assertIn("research", parsed.tags)
        self.assertIn("direction", parsed.tags)
        self.assertIn("status/进行中", parsed.tags)
        self.assertIn("project/foo", parsed.tags)

    def test_clean_unicode_handles_surrogate_values(self) -> None:
        value = {"emoji": "\ud83d\udcaa", "bad": "x\udcaa"}
        cleaned = clean_unicode(value)
        self.assertEqual(cleaned["emoji"], "💪")
        self.assertEqual(cleaned["bad"], "x?")
        payload = to_json(value)
        payload.encode("utf-8")
        self.assertNotIn("\udcaa", payload)

    def test_hybrid_search_keyword_and_front_page(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/a.md', 'Retrieval', '{}', '[]', 'abc', 1, 'now')
            """
        )
        note_id = conn.execute("SELECT id FROM obsidian_notes").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'Hybrid retrieval', 'Hybrid search combines semantic retrieval and keyword retrieval.', 8, 'obsidian', 'now')
            """,
            (note_id,),
        )
        conn.commit()
        hits = hybrid_search(conn, test_settings(), "semantic keyword retrieval", 3)
        self.assertEqual(len(hits), 1)
        self.assertGreater(hits[0]["score"], 0)

    def test_llm_provider_settings_mask_and_preserve_key(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        save_app_settings(
            conn,
            {
                "llm_providers": [
                    {
                        "id": "qwen",
                        "name": "Qwen",
                        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "api_key": "secret",
                        "chat_models": ["qwen-plus"],
                        "embedding_models": ["text-embedding-v4"],
                    }
                ],
                "llm_chat_provider_id": "qwen",
                "llm_chat_model": "qwen-plus",
                "llm_embedding_provider_id": "qwen",
                "llm_embedding_model": "text-embedding-v4",
            },
        )
        applied = apply_stored_settings(conn, test_settings())
        self.assertEqual(applied.chat_provider().api_key, "secret")
        payload = get_app_settings(conn, applied)["settings"]
        self.assertNotIn("api_key", payload["llm_providers"][0])
        self.assertTrue(payload["llm_providers"][0]["api_key_configured"])

        save_app_settings(
            conn,
            {
                "llm_providers": [
                    {
                        "id": "qwen",
                        "name": "Qwen",
                        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                        "chat_models": ["qwen-plus"],
                        "embedding_models": ["text-embedding-v4"],
                    }
                ]
            },
        )
        applied = apply_stored_settings(conn, test_settings())
        self.assertEqual(applied.chat_provider().api_key, "secret")

    def test_run_daily_startup_mode_is_mutually_exclusive_with_scheduler(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        save_app_settings(conn, {"run_daily_on_startup_enabled": True})
        payload = get_app_settings(conn, test_settings())["settings"]
        self.assertTrue(payload["run_daily_on_startup_enabled"])
        self.assertFalse(payload["scheduler_enabled"])

        save_app_settings(conn, {"scheduler_enabled": True})
        payload = get_app_settings(conn, test_settings())["settings"]
        self.assertTrue(payload["scheduler_enabled"])
        self.assertFalse(payload["run_daily_on_startup_enabled"])

    def test_stored_path_settings_remain_paths(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        save_app_settings(
            conn,
            {
                "obsidian_vault_path": ".test-tmp/vault",
                "arxiv_pdf_dir": ".test-tmp/pdfs",
                "arxiv_text_dir": ".test-tmp/texts",
                "obsidian_project_center_tags": ["#Project/Foo"],
            },
        )
        applied = apply_stored_settings(conn, test_settings())
        self.assertIsInstance(applied.obsidian_vault_path, Path)
        self.assertIsInstance(applied.arxiv_pdf_dir, Path)
        self.assertIsInstance(applied.arxiv_text_dir, Path)
        self.assertEqual(applied.obsidian_project_center_tags, ["project/foo"])

    def test_obsidian_project_center_tags_discover_projects_and_sync_status(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        vault = Path.cwd() / ".test-tmp" / "project-discovery-vault"
        project_note = vault / "Research" / "Agentic RAG" / "Home.md"
        project_note.parent.mkdir(parents=True, exist_ok=True)
        project_note.write_text(
            "---\ntitle: Home Page\ntags: [project, Status/进行中]\n---\n# Agentic RAG\nProject center page.",
            encoding="utf-8",
        )
        method_note = vault / "Research" / "Agentic RAG" / "Method.md"
        method_note.write_text(
            "---\ntitle: Method\ntags: [experiment]\n---\n# Method\nProject folder note with retrieval experiments.",
            encoding="utf-8",
        )
        trash_note = vault / "Research" / ".trash" / "Deleted.md"
        trash_note.parent.mkdir(parents=True, exist_ok=True)
        trash_note.write_text(
            "---\ntitle: Deleted Project\ntags: [project, Status/进行中]\n---\n# Deleted\nShould not be indexed.",
            encoding="utf-8",
        )
        settings = Settings(
            **{
                **test_settings().__dict__,
                "obsidian_vault_path": vault,
                "obsidian_include_tags": ["project"],
                "obsidian_project_center_tags": ["project"],
            }
        )

        result = sync_obsidian(conn, settings)
        self.assertEqual(result["notes_seen"], 2)
        self.assertEqual(result["projects_synced"], 1)
        self.assertEqual(result["project_notes_synced"], 2)
        project = projects(conn)["items"][0]
        self.assertEqual(project["name"], "Agentic RAG")
        self.assertEqual(project["status"], "active")
        self.assertEqual(project["obsidian_project_path"], "Research/Agentic RAG/Home.md")
        self.assertEqual(project["obsidian_folder"], "Research/Agentic RAG")
        self.assertEqual(project["obsidian_status_tag"], "Status/进行中")
        self.assertEqual(project["discovery_source"], "obsidian")
        relations = {
            row["relation"]
            for row in conn.execute("SELECT relation FROM project_notes").fetchall()
        }
        self.assertEqual(relations, {"center_page", "folder_member"})

        save_project(
            conn,
            {
                **project,
                "status": "completed",
            },
            settings,
        )
        text = project_note.read_text(encoding="utf-8")
        self.assertIn("Status/已完成", text)
        self.assertNotIn("Status/进行中", text)

    def test_obsidian_include_dirs_accept_backslashes(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        vault = Path.cwd() / ".test-tmp" / "backslash-include-vault"
        project_note = vault / "人工智能" / "个人研究" / "持续学习" / "中心页.md"
        project_note.parent.mkdir(parents=True, exist_ok=True)
        project_note.write_text(
            "---\ntags: [Contents, Project/Research]\n---\n# 持续学习\nProject center page.",
            encoding="utf-8",
        )
        settings = Settings(
            **{
                **test_settings().__dict__,
                "obsidian_vault_path": vault,
                "obsidian_include_dirs": ["人工智能\\个人研究"],
                "obsidian_project_center_tags": ["contents", "project/research"],
            }
        )

        result = sync_obsidian(conn, settings)
        self.assertEqual(result["notes_seen"], 1)
        self.assertEqual(result["projects_synced"], 1)
        project = projects(conn)["items"][0]
        self.assertEqual(project["name"], "持续学习")
        self.assertEqual(project["obsidian_project_path"], "人工智能/个人研究/持续学习/中心页.md")

    def test_project_center_links_papers_and_notes(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        vault = Path.cwd() / ".test-tmp" / "project-vault"
        created = save_project(
            conn,
            {
                "name": "Agentic RAG",
                "status": "active",
                "keywords": ["rag", "agent"],
                "obsidian_project_path": "Projects/Agentic RAG.md",
                "obsidian_output_dir": "Projects/Agentic RAG",
                "source_tags": ["research", "experiment"],
                "arxiv_categories": ["cs.CL", "cs.AI"],
                "automation": {
                    "auto_link_papers": False,
                    "generate_paper_cards": True,
                    "generate_project_digest": True,
                    "sync_experiment_notes": True,
                },
            },
        )
        project_id = created["project"]["id"]
        self.assertEqual(created["project"]["obsidian_project_path"], "Projects/Agentic RAG.md")
        self.assertEqual(created["project"]["source_tags"], ["research", "experiment"])
        self.assertEqual(created["project"]["arxiv_categories"], ["cs.CL", "cs.AI"])
        self.assertTrue(created["project"]["automation"]["generate_paper_cards"])
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/agentic-rag.md', 'Agentic RAG', '{}', '["rag"]', 'abc', 1, 'now')
            """
        )
        note_id = conn.execute("SELECT id FROM obsidian_notes").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('2501.00999', 'Agentic Retrieval', '[]', 'Abstract', '["cs.CL"]',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'https://arxiv.org/abs/2501.00999',
              'https://arxiv.org/pdf/2501.00999', 'batch', 'now')
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.commit()

        detail = project_detail(conn, int(project_id))
        self.assertEqual([paper["id"] for paper in detail["candidate_papers"]], [paper_id])
        self.assertEqual([note["id"] for note in detail["candidate_notes"]], [note_id])

        detail = link_project_paper(
            conn,
            int(project_id),
            {"paper_id": paper_id, "relation": "core"},
        )
        detail = link_project_note(
            conn,
            int(project_id),
            {"note_id": note_id, "relation": "idea"},
        )
        self.assertEqual(detail["project"]["paper_count"], 1)
        self.assertEqual(detail["project"]["note_count"], 1)
        self.assertEqual(detail["papers"][0]["relation"], "core")
        self.assertEqual(detail["notes"][0]["relation"], "idea")
        self.assertEqual(detail["candidate_papers"], [])
        self.assertEqual(detail["candidate_notes"], [])
        self.assertEqual(projects(conn)["items"][0]["paper_count"], 1)

        detail = unlink_project_paper(conn, int(project_id), int(paper_id))
        self.assertEqual(detail["project"]["paper_count"], 0)
        self.assertEqual([paper["id"] for paper in detail["candidate_papers"]], [paper_id])

        link_project_paper(conn, int(project_id), {"paper_id": paper_id, "relation": "core"})
        vault.mkdir(parents=True, exist_ok=True)
        export_settings = Settings(**{**test_settings().__dict__, "obsidian_vault_path": vault})
        exported = export_project_to_obsidian(conn, export_settings, int(project_id))
        exported_path = vault / "Projects" / "Agentic RAG.md"
        self.assertTrue(exported_path.exists())
        exported_text = exported_path.read_text(encoding="utf-8")
        self.assertIn("# Agentic RAG", exported_text)
        self.assertIn("Agentic Retrieval", exported_text)
        self.assertEqual(exported["export"]["obsidian_path"], "Projects/Agentic RAG.md")
        self.assertEqual(exported["artifacts"][0]["artifact_type"], "project_index")
        self.assertEqual(projects(conn)["items"][0]["artifact_count"], 1)

    def test_extract_pdf_text_to_file(self) -> None:
        import fitz

        root = Path.cwd() / ".test-tmp" / "pdf"
        root.mkdir(parents=True, exist_ok=True)
        pdf_path = root / "sample.pdf"
        text_path = root / "sample.txt"
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Full text extraction works")
        doc.save(pdf_path)
        doc.close()

        char_count = extract_pdf_text_to_file(pdf_path, text_path)
        self.assertGreater(char_count, 0)
        self.assertIn("Full text extraction works", text_path.read_text(encoding="utf-8"))
        self.assertEqual(safe_arxiv_filename("hep-th/9901001"), "hep-th_9901001")

    def test_rank_uses_arxiv_text_chunks(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/rag.md', 'RAG', '{}', '[]', 'abc', 1, 'now')
            """
        )
        note_id = conn.execute("SELECT id FROM obsidian_notes").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'RAG', 'Retrieval augmented generation uses evidence chunks for citation grounded explanations.', 9, 'obsidian', 'now')
            """,
            (note_id,),
        )
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('2501.00001', 'Unrelated title', '[]', 'Short abstract', '["cs.CL"]',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'https://arxiv.org/abs/2501.00001',
              'https://arxiv.org/pdf/2501.00001', 'batch', 'now')
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, page_start, page_end, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 3, 3, 'This section studies retrieval augmented generation with evidence chunks.', 9, 70, 'now')
            """,
            (paper_id,),
        )
        conn.commit()

        result = rank_unmatched_papers(conn, test_settings())
        self.assertEqual(result["matched_papers"], 1)
        match = conn.execute("SELECT arxiv_chunk_id, evidence_json FROM matches").fetchone()
        self.assertIsNotNone(match["arxiv_chunk_id"])
        self.assertIn("arxiv_text", match["evidence_json"])

    def test_generate_project_judgments_normalizes_label_confidence(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              'Agentic RAG', 'active', '["retrieval"]', 'Research/Agentic RAG/Home.md',
              'Research/Agentic RAG', 'Research/Agentic RAG', 'Status/进行中',
              'obsidian', '["project"]', '[]', '{}', 'now', 'now'
            )
            """
        )
        project_id = conn.execute("SELECT id FROM research_projects").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/context.md', 'Context', '{}', '[]', 'abc', 1, 'now')
            """
        )
        note_id = conn.execute("SELECT id FROM obsidian_notes").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'Context', 'Useful retrieval evidence.', 3, 'obsidian', 'now')
            """,
            (note_id,),
        )
        chunk_id = conn.execute("SELECT id FROM research_chunks").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_notes(project_id, note_id, relation, note, created_at, updated_at)
            VALUES (?, ?, 'folder_member', '', 'now', 'now')
            """,
            (project_id, note_id),
        )
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('2605.00007', 'LLM confidence label', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00007', 'https://arxiv.org/pdf/2605.00007',
              'batch', 'now')
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 'Paper retrieval evidence.', 3, 25, 'now')
            """,
            (paper_id,),
        )
        arxiv_chunk_id = conn.execute("SELECT id FROM arxiv_text_chunks").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_paper_matches(
              project_id, paper_id, score, rank_score, quality_score,
              best_arxiv_chunk_id, best_obsidian_chunk_id,
              searchers_json, evidence_json, match_type, created_at, updated_at
            )
            VALUES (?, ?, 0.77, 1.0, 0.77, ?, ?, '[]', '{}', 'project_context', 'now', 'now')
            """,
            (project_id, paper_id, arxiv_chunk_id, chunk_id),
        )
        conn.commit()

        with patch(
            "worker.llm._call_chat",
            return_value={
                "relation_type": "direct",
                "relevance_score": 0.8,
                "usefulness_score": 0.7,
                "confidence": "moderate",
                "suggested_action": "read",
                "reason": "项目需要检索证据，论文提供对应机制。",
                "evidence_mapping": [
                    {
                        "project_need": "检索证据",
                        "paper_mechanism": "retrieval evidence",
                        "why_it_matches": "机制直接对应",
                    }
                ],
                "missing_evidence": "",
            },
        ):
            result = generate_missing_project_judgments(conn, test_settings())

        self.assertEqual(result["project_judgments_created"], 1)
        self.assertEqual(result["project_judgments_filtered"], 1)
        judgment = conn.execute("SELECT confidence, suggested_action FROM project_paper_judgments").fetchone()
        self.assertAlmostEqual(float(judgment["confidence"]), 0.5)
        self.assertEqual(judgment["suggested_action"], "read")

    def test_project_judgment_prompt_requires_chinese_values(self) -> None:
        prompt = _project_judgment_prompt(
            {
                "project": {"name": "Agentic RAG", "evidence_text": "needs retrieval evidence"},
                "paper": {"title": "Chinese prompt", "abstract": "Abstract"},
                "retrieval": {"quality_score": 0.7},
            }
        )

        self.assertIn("所有可读文本字段值必须使用中文", prompt)
        self.assertIn("relation_type 必须是 direct、indirect、weak、none", prompt)
        self.assertIn("suggested_action 必须是 read、read_later、ignore", prompt)
        self.assertIn("JSON 字段名保持英文", prompt)

    def test_project_rank_uses_project_folder_chunks(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              'Agentic RAG', 'active', '[]', 'Research/Agentic RAG/Home.md',
              'Research/Agentic RAG', 'Research/Agentic RAG', 'Status/进行中',
              'obsidian', '["project"]', '[]', '{}', 'now', 'now'
            )
            """
        )
        project_id = conn.execute("SELECT id FROM research_projects").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/Agentic RAG/Method.md', 'Method', '{}', '[]', 'abc', 1, 'now')
            """
        )
        note_id = conn.execute("SELECT id FROM obsidian_notes").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_notes(project_id, note_id, relation, note, created_at, updated_at)
            VALUES (?, ?, 'folder_member', '', 'now', 'now')
            """,
            (project_id, note_id),
        )
        conn.execute(
            """
            INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'Retrieval agents', 'Agentic retrieval planners evaluate evidence chunks before synthesis.', 8, 'obsidian', 'now')
            """,
            (note_id,),
        )
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('2501.00003', 'Agentic Retrieval Planning', '[]', 'Abstract', '["cs.CL"]',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'https://arxiv.org/abs/2501.00003',
              'https://arxiv.org/pdf/2501.00003', 'batch', 'now')
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, page_start, page_end, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 2, 2, 'Agentic retrieval planners evaluate evidence chunks and retrieve project context.', 9, 80, 'now')
            """,
            (paper_id,),
        )
        conn.commit()

        result = rank_project_papers(conn, test_settings())
        self.assertEqual(result["project_rank_projects_with_context"], 1)
        self.assertEqual(result["project_paper_matches_created"], 1)
        match = conn.execute("SELECT * FROM project_paper_matches").fetchone()
        self.assertEqual(match["project_id"], project_id)
        self.assertEqual(match["paper_id"], paper_id)
        self.assertGreater(match["score"], 0)
        relation = conn.execute("SELECT relation FROM project_papers").fetchone()["relation"]
        self.assertEqual(relation, "candidate")
        detail = project_detail(conn, int(project_id))
        self.assertEqual(detail["project_matches"][0]["paper_id"], paper_id)
        self.assertEqual(detail["papers"][0]["project_score"], match["score"])
        conn.execute(
            """
            INSERT INTO project_paper_judgments(
              project_id, paper_id, relation_type, relevance_score, usefulness_score,
              confidence, suggested_action, reason, evidence_mapping_json,
              missing_evidence, input_hash, prompt_version, raw_json, created_at, updated_at
            )
            VALUES (?, ?, 'direct', 0.82, 0.78, 0.8, 'read',
              '这篇论文直接讨论 agentic retrieval planning，可用于项目的 evidence selection 设计。',
              '[]', '', 'hash', 'test', '{}', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.commit()

        vault = Path.cwd() / ".test-tmp" / "report-vault"
        (vault / "Research" / "Agentic RAG").mkdir(parents=True, exist_ok=True)
        report_settings = chat_settings(Settings(**{**test_settings().__dict__, "obsidian_vault_path": vault}))
        with patch(
            "worker.reports.call_chat_json",
            return_value={
                "markdown": "\n".join(
                    [
                        "# 今日科研情报日报",
                        "",
                        "## 今日结论",
                        "",
                        "Agentic RAG 今天有一篇值得跟进的候选论文。",
                        "",
                        "## 按项目候选论文",
                        "",
                        "### [[Agentic RAG]]",
                        "",
                        "[2501.00003](https://arxiv.org/abs/2501.00003) Agentic Retrieval Planning 可用于项目的 evidence selection 设计。",
                    ]
                )
            },
        ):
            report_result = generate_daily_report(
                conn,
                report_settings,
                stats={"arxiv_papers_inserted": 1, "project_paper_matches_created": 1},
                paper_ids=[paper_id],
            )
        self.assertEqual(report_result["reports_created"], 1)
        report_path = vault / "Research Intelligence" / "Daily" / f"{date.today().isoformat()}.md"
        self.assertTrue(report_path.exists())
        report_text = report_path.read_text(encoding="utf-8")
        self.assertIn("## 今日结论", report_text)
        self.assertIn("## 按项目候选论文", report_text)
        self.assertIn("Agentic Retrieval Planning", report_text)
        self.assertIn("Agentic RAG", report_text)
        artifact_count = conn.execute(
            "SELECT COUNT(*) AS count FROM project_artifacts WHERE artifact_type = 'paper_usefulness_report'"
        ).fetchone()["count"]
        self.assertEqual(artifact_count, 0)

    def test_daily_report_filters_by_project_judgment_and_writes_project_paragraphs(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              'Agentic RAG', 'active', '[]', 'Research/Agentic RAG/Home.md',
              'Research/Agentic RAG', 'Research/Agentic RAG', 'Status/进行中',
              'obsidian', '["project"]', '[]', '{}', 'now', 'now'
            )
            """
        )
        project_id = conn.execute("SELECT id FROM research_projects").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/Agentic RAG/Method.md', 'Method', '{}', '[]', 'abc', 1, 'now')
            """
        )
        note_id = conn.execute("SELECT id FROM obsidian_notes").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'Planner', 'The project needs retrieval planner state and evidence selection.', 8, 'obsidian', 'now')
            """,
            (note_id,),
        )
        obsidian_chunk_id = conn.execute("SELECT id FROM research_chunks").fetchone()["id"]

        paper_ids = []
        for arxiv_id, title in [
            ("2605.01001", "Keep Planner Paper"),
            ("2605.01002", "Ignored Generic Paper"),
        ]:
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json, published_at,
                  updated_at, link, pdf_link, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', 'Abstract', '["cs.AI"]',
                  '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', ?, ?, 'batch', 'now')
                """,
                (
                    arxiv_id,
                    title,
                    f"https://arxiv.org/abs/{arxiv_id}",
                    f"https://arxiv.org/pdf/{arxiv_id}",
                ),
            )
            paper_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            paper_ids.append(int(paper_id))
            conn.execute(
                """
                INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
                VALUES (?, 0, 'full_text', ?, 5, 50, 'now')
                """,
                (paper_id, f"{title} discusses retrieval planner evidence selection."),
            )
            arxiv_chunk_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            conn.execute(
                """
                INSERT INTO project_paper_matches(
                  project_id, paper_id, score, best_arxiv_chunk_id, best_obsidian_chunk_id,
                  searchers_json, evidence_json, match_type, created_at, updated_at
                )
                VALUES (?, ?, 0.8, ?, ?, '[]', '{}', 'project_context', 'now', 'now')
                """,
                (project_id, paper_id, arxiv_chunk_id, obsidian_chunk_id),
            )

        for paper_id, relation_type, usefulness, confidence, action, reason in [
            (
                paper_ids[0],
                "direct",
                0.82,
                0.82,
                "read",
                "这篇论文直接讨论 retrieval planner state，可用于当前 Agentic RAG 设计。",
            ),
            (
                paper_ids[1],
                "weak",
                0.2,
                0.9,
                "ignore",
                "只是泛泛共享检索词，不值得进入日报。",
            ),
        ]:
            conn.execute(
                """
                INSERT INTO project_paper_judgments(
                  project_id, paper_id, relation_type, relevance_score, usefulness_score,
                  confidence, suggested_action, reason, evidence_mapping_json,
                  missing_evidence, input_hash, prompt_version, raw_json, created_at, updated_at
                )
                VALUES (?, ?, ?, 0.8, ?, ?, ?, ?, '[]', '', ?, 'test', '{}', 'now', 'now')
                """,
                (project_id, paper_id, relation_type, usefulness, confidence, action, reason, f"hash-{paper_id}"),
            )
        conn.commit()

        vault = Path.cwd() / ".test-tmp" / "report-filter-vault"
        vault.mkdir(parents=True, exist_ok=True)
        report_settings = chat_settings(Settings(**{**test_settings().__dict__, "obsidian_vault_path": vault}))
        with patch(
            "worker.reports.call_chat_json",
            return_value={
                "markdown": "\n".join(
                    [
                        "# 今日科研情报日报",
                        "",
                        "## 今日结论",
                        "",
                        "只保留通过项目级判定的候选。",
                        "",
                        "## 按项目候选论文",
                        "",
                        "### [[Agentic RAG]]",
                        "",
                        "**[2605.01001](https://arxiv.org/abs/2605.01001)《Keep Planner Paper》** 这篇论文直接讨论 retrieval planner state。",
                        "",
                        "## 流程状态",
                        "",
                        "- 项目级判定筛掉 1",
                    ]
                )
            },
        ) as call_chat:
            result = generate_daily_report(
                conn,
                report_settings,
                stats={"project_judgments_created": 2, "project_judgments_filtered": 1},
                paper_ids=paper_ids,
            )

        self.assertEqual(result["reports_created"], 1)
        self.assertEqual(result["daily_report_project_matches"], 1)
        prompt = call_chat.call_args.args[1]
        self.assertIn("Keep Planner Paper", prompt)
        self.assertNotIn("Ignored Generic Paper", prompt)
        report_path = vault / "Research Intelligence" / "Daily" / f"{date.today().isoformat()}.md"
        report_text = report_path.read_text(encoding="utf-8")
        self.assertIn("### [[Agentic RAG]]", report_text)
        self.assertIn("**[2605.01001](https://arxiv.org/abs/2605.01001)《Keep Planner Paper》**", report_text)
        self.assertIn("这篇论文直接讨论 retrieval planner state", report_text)
        self.assertIn("项目级判定筛掉 1", report_text)
        self.assertNotIn("Ignored Generic Paper", report_text)

    def test_daily_report_uses_llm_generated_markdown_when_available(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        vault = Path.cwd() / ".test-tmp" / "report-llm-vault"
        vault.mkdir(parents=True, exist_ok=True)
        report_settings = chat_settings(Settings(**{**test_settings().__dict__, "obsidian_vault_path": vault}))

        with patch(
            "worker.reports.call_chat_json",
            return_value={
                "markdown": "\n".join(
                    [
                        "# 2026-05-03 科研情报日报",
                        "",
                        "## 今日结论",
                        "",
                        "这是 LLM 统一生成的完整日报正文。",
                        "",
                        "## 按项目候选论文",
                        "",
                        "没有候选论文时，也由 LLM 解释原因。",
                    ]
                )
            },
        ) as call_chat:
            result = generate_daily_report(conn, report_settings, stats={"arxiv_papers_inserted": 0})

        self.assertEqual(result["reports_created"], 1)
        self.assertEqual(result["daily_report_mode"], "llm")
        call_chat.assert_called_once()
        prompt = call_chat.call_args.args[1]
        self.assertIn("项目级判定认为它为什么相关", prompt)
        self.assertIn("120-220 个中文字符", prompt)
        report_path = vault / "Research Intelligence" / "Daily" / f"{date.today().isoformat()}.md"
        report_text = report_path.read_text(encoding="utf-8")
        self.assertIn("source: research_intelligence_system", report_text)
        self.assertIn("这是 LLM 统一生成的完整日报正文。", report_text)
        self.assertNotIn("暂无项目级候选论文。", report_text)

    def test_arxiv_chunk_embedding_cache_is_reused(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('2501.00002', 'Embedding cache', '[]', 'Abstract', '["cs.CL"]',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'https://arxiv.org/abs/2501.00002',
              'https://arxiv.org/pdf/2501.00002', 'batch', 'now')
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'metadata', 'embedding cache text', 3, 20, 'now')
            """,
            (paper_id,),
        )
        chunk_id = conn.execute("SELECT id FROM arxiv_text_chunks").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_chunk_embeddings(arxiv_chunk_id, model, embedding_json, created_at)
            VALUES (?, 'mock-embedding', '[0.1, 0.2]', 'now')
            """,
            (chunk_id,),
        )
        conn.commit()

        embedding = ensure_arxiv_chunk_embedding(
            conn,
            embedding_settings(),
            int(chunk_id),
            "embedding cache text",
        )
        self.assertEqual(embedding, [0.1, 0.2])

    def test_text_cache_can_be_limited_to_prefiltered_papers(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        root = Path.cwd() / ".test-tmp" / "filtered-cache"
        root.mkdir(parents=True, exist_ok=True)
        paper_ids = []
        for index in range(2):
            text_path = root / f"paper-{index}.txt"
            text_path.write_text(
                f"--- page 1 ---\nFiltered paper {index} full text about retrieval context.",
                encoding="utf-8",
            )
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json, published_at,
                  updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', 'Abstract', '["cs.CL"]',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?,
                  ?, 'complete', 'batch', 'now')
                """,
                (
                    f"2501.0010{index}",
                    f"Paper {index}",
                    f"https://arxiv.org/abs/2501.0010{index}",
                    f"https://arxiv.org/pdf/2501.0010{index}",
                    str(text_path),
                ),
            )
            paper_ids.append(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.commit()

        result = cache_arxiv_full_texts(conn, test_settings(), paper_ids=[int(paper_ids[0])])
        self.assertEqual(result["papers_considered"], 0)
        chunked_paper_ids = {
            int(row["paper_id"])
            for row in conn.execute("SELECT DISTINCT paper_id FROM arxiv_text_chunks").fetchall()
        }
        self.assertEqual(chunked_paper_ids, {int(paper_ids[0])})

    def test_prefilter_skips_below_threshold_but_keeps_minimum(self) -> None:
        from worker.search import prefilter_papers

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        for index in range(2):
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json, published_at,
                  updated_at, link, pdf_link, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', 'Abstract', '["cs.CL"]',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?, 'batch', 'now')
                """,
                (
                    f"2501.0001{index}",
                    f"Paper {index}",
                    f"https://arxiv.org/abs/2501.0001{index}",
                    f"https://arxiv.org/pdf/2501.0001{index}",
                ),
            )
        rows = conn.execute("SELECT * FROM arxiv_papers ORDER BY id").fetchall()
        settings = Settings(
            **{
                **test_settings().__dict__,
                "rag_searchers": ["embedding_search"],
                "rag_prefilter_enabled": True,
                "rag_prefilter_threshold": 0.9,
                "rag_prefilter_min_keep": 1,
                "llm_embedding_model": "mock-embedding",
            }
        )
        for row in rows:
            conn.execute(
                """
                INSERT INTO arxiv_paper_embeddings(paper_id, model, embedding_json, created_at)
                VALUES (?, 'mock-embedding', '[0.1, 0.2]', 'now')
                """,
                (int(row["id"]),),
            )
        conn.commit()

        selected, result = prefilter_papers(conn, settings, list(rows))
        self.assertEqual(len(selected), 1)
        self.assertEqual(result["prefilter_skipped"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM paper_prefilter_runs").fetchone()["count"], 2)

    def test_prefilter_caps_selected_papers_with_max_keep(self) -> None:
        from worker.search import prefilter_papers

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        for index in range(3):
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json, published_at,
                  updated_at, link, pdf_link, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', 'Abstract', '["cs.CL"]',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?, 'batch', 'now')
                """,
                (
                    f"2501.0002{index}",
                    f"Paper {index}",
                    f"https://arxiv.org/abs/2501.0002{index}",
                    f"https://arxiv.org/pdf/2501.0002{index}",
                ),
            )
        rows = conn.execute("SELECT * FROM arxiv_papers ORDER BY id").fetchall()
        settings = Settings(
            **{
                **test_settings().__dict__,
                "rag_prefilter_enabled": False,
                "rag_prefilter_max_keep": 2,
            }
        )

        selected, result = prefilter_papers(conn, settings, list(rows))
        self.assertEqual(len(selected), 2)
        self.assertEqual(result["prefilter_passed"], 2)
        self.assertEqual(result["prefilter_skipped"], 1)
        self.assertEqual(result["prefilter_capped"], 1)


if __name__ == "__main__":
    unittest.main()
