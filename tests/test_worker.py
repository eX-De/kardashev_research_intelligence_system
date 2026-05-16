from __future__ import annotations

import sqlite3
import base64
import json
import threading
import time
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
    paper_reports_queue,
    project_detail,
    projects,
    remove_paper_report,
    save_project,
    unlink_project_paper,
    update_paper_recommendation,
)
from worker.arxiv_archive import archive_zero_match_papers
from worker.arxiv_client import _fetch_page, fetch_arxiv
from worker.arxiv_text import cache_arxiv_full_texts, download_pdf, extract_pdf_text_to_file, safe_arxiv_filename
from worker.cli import (
    _daily_papers_for_run,
    _delete_run_record,
    _latest_resumable_daily_run,
    _prefilter_daily_papers,
    _retry_papers_for_run,
    _selected_papers_from_existing_prefilter,
    _snapshot_daily_papers,
)
from worker.db import clean_unicode, init_db, mark_stale_job_runs, to_json
from worker.embeddings import (
    ensure_arxiv_chunk_embedding,
    ensure_arxiv_paper_embeddings,
    ensure_missing_note_chunk_embeddings,
    ensure_missing_arxiv_chunk_embeddings,
)
from worker.llm import _project_judgment_prompt, generate_missing_project_judgments
from worker.obsidian import parse_note
from worker.obsidian import sync_obsidian
from worker.paper_reports import (
    PAPER_READER_DEFAULT_PROMPT,
    ensure_paper_reports_for_recommendations,
    process_paper_report_queue,
)
from worker.paper_reader import (
    cancel_reader_report,
    delete_reader_message,
    generate_reader_followup_questions,
    import_reader_pdfs,
    import_reader_pdf,
    import_reader_urls,
    paper_reader_chat,
    paper_reader_chat_stream,
    save_reader_note_to_obsidian,
    retry_reader_report,
)
from worker.reminders import reminders
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
    def test_init_db_skips_schema_script_when_schema_is_current(self) -> None:
        class TrackingConnection(sqlite3.Connection):
            executescript_calls = 0

            def executescript(self, sql: str):
                self.executescript_calls += 1
                return super().executescript(sql)

        conn = sqlite3.connect(":memory:", factory=TrackingConnection)
        conn.row_factory = sqlite3.Row
        init_db(conn)
        self.assertEqual(conn.executescript_calls, 1)

        init_db(conn)
        self.assertEqual(conn.executescript_calls, 1)

    def test_mark_stale_legacy_job_runs_preserves_resume_meta(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, message, meta_json)
            VALUES ('run-daily', 'running', '2000-01-01T00:00:00+00:00', 'Daily run 4/11', ?)
            """,
            (to_json({"arxiv_batch_id": "batch-1"}),),
        )
        conn.commit()

        result = mark_stale_job_runs(conn, legacy_stale_after_seconds=1)
        row = conn.execute("SELECT status, finished_at, message, meta_json FROM job_runs").fetchone()
        meta = json.loads(row["meta_json"])

        self.assertEqual(result["stale_jobs_marked"], 1)
        self.assertEqual(row["status"], "failed")
        self.assertIn("Marked stale", row["message"])
        self.assertEqual(meta["arxiv_batch_id"], "batch-1")
        self.assertIn("stale", meta)
        self.assertTrue(row["finished_at"])

    def test_delete_run_record_removes_snapshot_only(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, finished_at, message, meta_json)
            VALUES ('run-daily', 'failed', '2026-05-08T00:00:00+00:00', '2026-05-08T00:05:00+00:00', 'failed', '{}')
            """
        )
        job_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json,
              published_at, updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('2605.00050', 'Kept Paper', '[]', 'summary', '["cs.AI"]',
                    '2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z',
                    'https://arxiv.org/abs/2605.00050', 'https://arxiv.org/pdf/2605.00050',
                    'batch-1', 'now')
            """
        )
        paper_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO daily_run_meta(job_id, arxiv_batch_id, mode, settings_hash, searchers_json, embedding_model, created_at)
            VALUES (?, 'batch-1', 'run-daily', 'hash', '[]', '', 'now')
            """,
            (job_id,),
        )
        conn.execute(
            """
            INSERT INTO daily_run_steps(job_id, step_key, status, started_at, finished_at, meta_json)
            VALUES (?, 'snapshot', 'completed', 'now', 'now', '{}')
            """,
            (job_id,),
        )
        conn.execute(
            """
            INSERT INTO daily_run_papers(job_id, paper_id, source, published_at, selected, updated_at)
            VALUES (?, ?, 'new_arxiv', '2026-05-08T00:00:00Z', 1, 'now')
            """,
            (job_id, paper_id),
        )
        conn.execute(
            """
            INSERT INTO paper_prefilter_runs(paper_id, model, score, rank, passed, reason, top_chunks_json, created_at)
            VALUES (?, 'prefilter', 0.9, 1, 1, 'kept', '[]', 'now')
            """,
            (paper_id,),
        )
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/DeleteRun.md', 'Delete Run', '{}', '[]', 'hash', 1, 'now')
            """
        )
        note_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
            VALUES (?, 0, 'Context', 'matched context', 2, 'obsidian', 'now')
            """,
            (note_id,),
        )
        chunk_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO matches(paper_id, chunk_id, score, searchers_json, evidence_json, created_at)
            VALUES (?, ?, 0.8, '["embedding_search"]', '{}', 'now')
            """,
            (paper_id, chunk_id),
        )
        conn.execute(
            """
            INSERT INTO paper_reading_reports(paper_id, status, created_at, updated_at)
            VALUES (?, 'done', 'now', 'now')
            """,
            (paper_id,),
        )
        conn.commit()

        result = _delete_run_record(conn, job_id)

        self.assertEqual(result["deleted_job_runs"], 1)
        self.assertEqual(result["deleted_daily_run_meta"], 1)
        self.assertEqual(result["deleted_daily_run_steps"], 1)
        self.assertEqual(result["deleted_daily_run_papers"], 1)
        self.assertEqual(result["products_deleted"], 0)
        for table in ("job_runs", "daily_run_meta", "daily_run_steps", "daily_run_papers"):
            count = conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"]
            self.assertEqual(count, 0)
        for table in ("arxiv_papers", "paper_prefilter_runs", "matches", "paper_reading_reports"):
            count = conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"]
            self.assertEqual(count, 1)

    def test_delete_run_record_dry_run_does_not_delete(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, meta_json)
            VALUES ('run-daily', 'failed', '2026-05-08T00:00:00+00:00', '{}')
            """
        )
        job_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO daily_run_meta(job_id, arxiv_batch_id, mode, settings_hash, searchers_json, embedding_model, created_at)
            VALUES (?, 'batch-1', 'run-daily', 'hash', '[]', '', 'now')
            """,
            (job_id,),
        )
        conn.commit()

        result = _delete_run_record(conn, job_id, dry_run=True)

        self.assertTrue(result["dry_run"])
        self.assertEqual(result["would_delete_job_runs"], 1)
        self.assertEqual(result["would_delete_daily_run_meta"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM job_runs").fetchone()["count"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM daily_run_meta").fetchone()["count"], 1)

    def test_delete_run_record_refuses_running_without_force(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, meta_json)
            VALUES ('run-daily', 'running', '2026-05-08T00:00:00+00:00', '{}')
            """
        )
        job_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.commit()

        with self.assertRaisesRegex(RuntimeError, "running"):
            _delete_run_record(conn, job_id)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM job_runs").fetchone()["count"], 1)

        result = _delete_run_record(conn, job_id, force=True)

        self.assertEqual(result["deleted_job_runs"], 1)
        self.assertTrue(result["force_used"])
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM job_runs").fetchone()["count"], 0)

    def test_latest_resumable_daily_run_ignores_failures_before_completion(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, finished_at, meta_json)
            VALUES ('run-daily', 'failed', '2026-05-08T00:00:00+00:00', '2026-05-08T00:10:00+00:00', ?)
            """,
            (to_json({"arxiv_batch_id": "old-batch"}),),
        )
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, finished_at, meta_json)
            VALUES ('run-daily', 'completed', '2026-05-08T00:20:00+00:00', '2026-05-08T00:30:00+00:00', ?)
            """,
            (to_json({"arxiv_batch_id": "completed-batch"}),),
        )
        conn.commit()

        self.assertIsNone(_latest_resumable_daily_run(conn))

    def test_latest_resumable_daily_run_uses_persisted_snapshot(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, finished_at, meta_json)
            VALUES ('run-daily', 'failed', '2026-05-08T00:00:00+00:00', '2026-05-08T00:10:00+00:00', '{}')
            """
        )
        job_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json,
              published_at, updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('2605.00001', 'Paper', '[]', 'summary', '["cs.CL"]',
                    '2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z',
                    'https://arxiv.org/abs/2605.00001', 'https://arxiv.org/pdf/2605.00001',
                    'batch-1', 'now')
            """
        )
        paper_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO daily_run_meta(job_id, arxiv_batch_id, mode, settings_hash, searchers_json, embedding_model, created_at)
            VALUES (?, 'batch-1', 'run-daily', 'hash', '[]', '', 'now')
            """,
            (job_id,),
        )
        conn.execute(
            """
            INSERT INTO daily_run_papers(job_id, paper_id, source, published_at, selected, updated_at)
            VALUES (?, ?, 'new_arxiv', '2026-05-08T00:00:00Z', 1, 'now')
            """,
            (job_id, paper_id),
        )
        conn.commit()

        result = _latest_resumable_daily_run(conn)

        self.assertIsNotNone(result)
        self.assertEqual(result["id"], job_id)
        self.assertEqual(result["meta"]["arxiv_batch_id"], "batch-1")

    def test_fetch_page_retries_429(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b"<feed />"

        error = urllib.error.HTTPError(
            url="https://export.arxiv.org/api/query",
            code=429,
            msg="Too Many Requests",
            hdrs={"Retry-After": "1"},
            fp=None,
        )

        with patch("worker.arxiv_client.urllib.request.urlopen", side_effect=[error, Response()]):
            with patch("worker.arxiv_client.time.sleep") as sleep:
                self.assertEqual(_fetch_page("cat:cs.CL", 0, 1), "<feed />")
                sleep.assert_called_once_with(1)

    def test_fetch_page_retries_timeout(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b"<feed />"

        with patch("worker.arxiv_client.urllib.request.urlopen", side_effect=[TimeoutError("timed out"), Response()]):
            with patch("worker.arxiv_client.time.sleep") as sleep:
                self.assertEqual(_fetch_page("cat:cs.CL", 0, 1), "<feed />")
                sleep.assert_called_once_with(30)

    def test_resume_prefilter_reconstructs_selected_papers(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        now = "2026-05-08T00:00:00Z"
        for arxiv_id, title in (("2605.00001", "Passed"), ("2605.00002", "Skipped")):
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json,
                  published_at, updated_at, link, pdf_link, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', 'summary', '["cs.CL"]', ?, ?, ?, ?, 'batch-1', ?)
                """,
                (
                    arxiv_id,
                    title,
                    now,
                    now,
                    f"https://arxiv.org/abs/{arxiv_id}",
                    f"https://arxiv.org/pdf/{arxiv_id}",
                    now,
                ),
            )
        rows = conn.execute("SELECT id, arxiv_id FROM arxiv_papers ORDER BY arxiv_id").fetchall()
        conn.execute(
            """
            INSERT INTO paper_prefilter_runs(
              paper_id, model, score, rank, passed, reason, top_chunks_json, created_at
            )
            VALUES (?, 'model', 0.9, 1, 1, 'score', '[]', ?)
            """,
            (int(rows[0]["id"]), now),
        )
        conn.execute(
            """
            INSERT INTO paper_prefilter_runs(
              paper_id, model, score, rank, passed, reason, top_chunks_json, created_at
            )
            VALUES (?, 'model', 0.1, 2, 0, 'below_threshold', '[]', ?)
            """,
            (int(rows[1]["id"]), now),
        )
        conn.commit()

        result = _selected_papers_from_existing_prefilter(conn, test_settings(), "batch-1")

        self.assertIsNotNone(result)
        selected, stats = result
        self.assertEqual([paper["arxiv_id"] for paper in selected], ["2605.00001"])
        self.assertEqual(stats["prefilter_passed"], 1)
        self.assertEqual(stats["prefilter_skipped"], 1)

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

    def test_daily_papers_only_use_current_batch(self) -> None:
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

        self.assertEqual(paper_ids, {new_id})
        self.assertEqual(result["daily_new_papers"], 1)
        self.assertEqual(result["daily_retry_papers"], 0)
        self.assertEqual(result["daily_candidate_papers"], 1)

    def test_retry_daily_papers_collect_historical_gaps(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)

        def insert_paper(arxiv_id: str, text_status: str, text_path: str = "") -> int:
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json, published_at,
                  updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', 'Abstract', '["cs.CL"]',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?,
                  ?, ?, 'old', 'now')
                """,
                (
                    arxiv_id,
                    arxiv_id,
                    f"https://arxiv.org/abs/{arxiv_id}",
                    f"https://arxiv.org/pdf/{arxiv_id}",
                    text_path,
                    text_status,
                ),
            )
            return int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])

        missing_text_id = insert_paper("2604.10001", "pending")
        missing_embedding_id = insert_paper("2604.10002", "complete", "paper.txt")
        tombstoned_id = insert_paper("2604.10003", "pending")
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 'chunk missing embedding', 3, 23, 'now')
            """,
            (missing_embedding_id,),
        )
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
            (tombstoned_id,),
        )
        conn.commit()

        papers, info, result = _retry_papers_for_run(conn, test_settings())
        paper_ids = {int(paper["id"]) for paper in papers}

        self.assertIn(missing_text_id, paper_ids)
        self.assertIn(missing_embedding_id, paper_ids)
        self.assertNotIn(tombstoned_id, paper_ids)
        self.assertEqual(info[missing_text_id]["retry_reason"], "retry_missing_text")
        self.assertEqual(info[missing_embedding_id]["retry_reason"], "retry_missing_embedding")
        self.assertEqual(result["daily_new_papers"], 0)
        self.assertEqual(result["daily_retry_papers"], 2)

    def test_retry_daily_does_not_pull_papers_for_inactive_project_match_gaps(self) -> None:
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
              'Paused Project', 'paused', '[]', 'Research/Paused/Home.md',
              'Research/Paused', 'Research/Paused', 'Status/搁置',
              'manual', '[]', '[]', '{}', 'now', 'now'
            )
            """
        )
        project_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/Paused/Method.md', 'Paused Method', '{}', '[]', 'paused', 1, 'now')
            """
        )
        note_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
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
            VALUES (?, 0, 'Paused', 'project context', 2, 'obsidian', 'now')
            """,
            (note_id,),
        )
        chunk_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
            )
            VALUES (
              '2605.09002', 'Retry Inactive Project Paper', '[]', 'Abstract', '["cs.CL"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.09002', 'https://arxiv.org/pdf/2605.09002',
              'paper.txt', 'complete', 'old', 'now'
            )
            """
        )
        paper_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 'complete text', 2, 13, 'now')
            """,
            (paper_id,),
        )
        arxiv_chunk_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO arxiv_chunk_embeddings(arxiv_chunk_id, model, embedding_json, created_at)
            VALUES (?, '', '[]', 'now')
            """,
            (arxiv_chunk_id,),
        )
        conn.execute(
            """
            INSERT INTO matches(paper_id, arxiv_chunk_id, chunk_id, score, searchers_json, evidence_json, created_at)
            VALUES (?, ?, ?, 0.9, '[]', '{}', 'now')
            """,
            (paper_id, arxiv_chunk_id, chunk_id),
        )
        conn.commit()

        papers, _, result = _retry_papers_for_run(conn, test_settings())

        self.assertEqual(papers, [])
        self.assertEqual(result["daily_retry_papers"], 0)

    def test_snapshot_daily_papers_persists_selection(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, meta_json)
            VALUES ('run-daily', 'running', 'now', '{}')
            """
        )
        job_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        for arxiv_id in ("2605.20001", "2605.20002"):
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json,
                  published_at, updated_at, link, pdf_link, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', 'summary', '["cs.CL"]',
                        '2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z',
                        ?, ?, 'batch-1', 'now')
                """,
                (
                    arxiv_id,
                    arxiv_id,
                    f"https://arxiv.org/abs/{arxiv_id}",
                    f"https://arxiv.org/pdf/{arxiv_id}",
                ),
            )
        papers = conn.execute("SELECT * FROM arxiv_papers ORDER BY arxiv_id").fetchall()
        settings = Settings(
            **{
                **test_settings().__dict__,
                "rag_prefilter_enabled": False,
                "rag_prefilter_max_keep": 1,
            }
        )

        selected, result = _snapshot_daily_papers(conn, settings, job_id, list(papers))
        rows = conn.execute(
            "SELECT paper_id, selected, source FROM daily_run_papers WHERE job_id = ? ORDER BY paper_id",
            (job_id,),
        ).fetchall()

        self.assertEqual(len(selected), 1)
        self.assertEqual(result["daily_candidate_papers"], 2)
        self.assertEqual(result["daily_selected_papers"], 1)
        self.assertEqual([int(row["selected"]) for row in rows], [1, 0])
        self.assertEqual({row["source"] for row in rows}, {"new_arxiv"})

    def test_daily_prefilter_does_not_bypass_historical_retry_papers(self) -> None:
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

        self.assertEqual([int(paper["id"]) for paper in selected], [])
        self.assertEqual(result["daily_retry_papers"], 0)
        self.assertEqual(result["prefilter_resume_bypassed"], 0)
        self.assertEqual(result["prefilter_passed"], 0)

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

    def test_paper_report_queue_uses_paper_reader_prompt_and_full_text(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        text_dir = Path.cwd() / ".test-tmp" / "paper-report-text"
        text_dir.mkdir(parents=True, exist_ok=True)
        text_path = text_dir / "2605.00013.txt"
        text_path.write_text("--- page 1 ---\nFull paper body for report.", encoding="utf-8")
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
              arxiv_categories_json, automation_json, created_at, updated_at
            )
            VALUES (
              'Paper Reports', 'active', '[]', 'Research/Paper Reports/中心页.md',
              'Research/Paper Reports', 'Research/Paper Reports', 'Status/进行中',
              'manual', '[]', '[]', '{}', 'now', 'now'
            )
            """
        )
        project_id = conn.execute("SELECT id FROM research_projects").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
            )
            VALUES (
              '2605.00013', 'Full Report Paper', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00013', 'https://arxiv.org/pdf/2605.00013',
              ?, 'complete', 'batch', 'now'
            )
            """,
            (str(text_path),),
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_paper_judgments(
              project_id, paper_id, relation_type, relevance_score, usefulness_score,
              confidence, suggested_action, reason, evidence_mapping_json,
              missing_evidence, input_hash, prompt_version, raw_json, created_at, updated_at
            )
            VALUES (?, ?, 'direct', 0.9, 0.8, 0.9, 'read', '需要阅读。',
              '[]', '', 'hash-report', 'test', '{}', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.commit()
        sync_project_paper_recommendations(conn, [int(paper_id)])

        result = ensure_paper_reports_for_recommendations(conn, [int(paper_id)])

        self.assertEqual(result["paper_reports_queued"], 1)
        captured: dict[str, object] = {}

        def fake_chat(
            _: Settings,
            messages: list[dict[str, str]],
            response_format: dict[str, object] | None = None,
            **kwargs,
        ) -> str:
            captured["messages"] = messages
            captured["response_format"] = response_format
            captured["kwargs"] = kwargs
            return json.dumps(
                {
                    "title": "Model Extracted Paper Title",
                    "markdown": "# 全文报告\n\n完整报告内容",
                },
                ensure_ascii=False,
            )

        with patch("worker.paper_reports._call_chat_text", side_effect=fake_chat):
            process_result = process_paper_report_queue(conn, chat_settings(test_settings()), [int(paper_id)])

        self.assertEqual(process_result["paper_reports_done"], 1)
        report = conn.execute("SELECT * FROM paper_reading_reports WHERE paper_id = ?", (paper_id,)).fetchone()
        paper = conn.execute("SELECT title FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone()
        self.assertEqual(report["status"], "done")
        self.assertEqual(report["prompt"], PAPER_READER_DEFAULT_PROMPT)
        self.assertEqual(report["report_markdown"], "# 全文报告\n\n完整报告内容")
        self.assertEqual(paper["title"], "Model Extracted Paper Title")
        self.assertEqual(captured["kwargs"]["provider_id"], "test-chat")
        self.assertEqual(captured["kwargs"]["model"], "test-chat-model")
        self.assertEqual(captured["response_format"], {"type": "json_object"})
        queue = paper_reports_queue(conn)
        self.assertEqual(queue["items"][0]["title"], "Model Extracted Paper Title")
        messages = captured["messages"]
        self.assertEqual(messages[0]["content"], "You are a research paper reading assistant. Read the supplied full PDF text and answer accurately from it.")
        self.assertIn("请只返回一个 JSON 对象", messages[1]["content"])
        self.assertIn("--- page 1 ---\nFull paper body for report.", messages[1]["content"])
        self.assertTrue(messages[1]["content"].endswith(PAPER_READER_DEFAULT_PROMPT))

    def test_paper_reader_chat_uses_original_prompt_and_persists_messages(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        text_dir = Path.cwd() / ".test-tmp" / "paper-reader-chat"
        text_dir.mkdir(parents=True, exist_ok=True)
        text_path = text_dir / "2605.00016.txt"
        text_path.write_text("--- page 1 ---\nMethod details for chat.", encoding="utf-8")
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
            )
            VALUES (
              '2605.00016', 'Reader Chat Paper', '[]', 'Abstract for chat', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00016', 'https://arxiv.org/pdf/2605.00016',
              ?, 'complete', 'batch', 'now'
            )
            """,
            (str(text_path),),
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, report_markdown,
              error_message, created_at, updated_at, finished_at
            )
            VALUES (?, 'done', ?, 'system', '# 报告\n\n已有解读报告', '', 'now', 'now', 'now')
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT),
        )
        conn.commit()
        captured: dict[str, object] = {}

        def fake_chat(
            _: Settings,
            messages: list[dict[str, str]],
            response_format: dict[str, object] | None = None,
            **kwargs,
        ) -> str:
            captured["messages"] = messages
            captured["response_format"] = response_format
            captured["kwargs"] = kwargs
            return "基于全文的回答"

        with patch("worker.paper_reader._call_chat_text", side_effect=fake_chat):
            result = paper_reader_chat(
                conn,
                Settings(
                    **{
                        **chat_settings(test_settings()).__dict__,
                        "reader_chat_provider_id": "test-chat",
                        "reader_chat_model": "reader-chat-dedicated",
                    }
                ),
                int(paper_id),
                {"message": "这篇论文的方法是什么？"},
            )

        self.assertEqual(len(result["reader_messages"]), 4)
        self.assertEqual(result["reader_messages"][0]["role"], "user")
        self.assertEqual(result["reader_messages"][0]["source"], "analysis_prompt")
        self.assertEqual(result["reader_messages"][0]["content"], PAPER_READER_DEFAULT_PROMPT)
        self.assertEqual(result["reader_messages"][1]["role"], "assistant")
        self.assertEqual(result["reader_messages"][1]["source"], "analysis_report")
        self.assertIn("已有解读报告", result["reader_messages"][1]["content"])
        self.assertEqual(result["reader_messages"][2]["role"], "user")
        self.assertEqual(result["reader_messages"][3]["role"], "assistant")
        self.assertEqual(result["reader_messages"][3]["model"], "reader-chat-dedicated")
        messages = captured["messages"]
        self.assertIsNone(captured["response_format"])
        self.assertEqual(captured["kwargs"]["provider_id"], "test-chat")
        self.assertEqual(captured["kwargs"]["model"], "reader-chat-dedicated")
        self.assertEqual(
            messages[0]["content"],
            "You are a research paper reading assistant. Answer from the supplied full PDF text whenever possible.",
        )
        self.assertEqual(messages[1], {"role": "user", "content": PAPER_READER_DEFAULT_PROMPT})
        self.assertEqual(messages[2]["role"], "assistant")
        self.assertIn("已有解读报告", messages[2]["content"])
        self.assertIn("后续对话都应优先基于这份文本回答。", messages[3]["content"])
        self.assertIn("--- page 1 ---\nMethod details for chat.", messages[3]["content"])
        self.assertEqual(messages[4]["content"], "我已收到完整 PDF 解析文本。")
        self.assertEqual(messages[-1]["content"], "这篇论文的方法是什么？")

    def test_import_reader_pdf_creates_report_queue_item_and_chunks(self) -> None:
        try:
            import fitz
        except ImportError:
            self.skipTest("PyMuPDF not installed")
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        source_dir = Path.cwd() / ".test-tmp" / "reader-import-source"
        source_dir.mkdir(parents=True, exist_ok=True)
        source_pdf = source_dir / "reader-upload.pdf"
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Reader import extraction works")
        doc.save(source_pdf)
        doc.close()

        result = import_reader_pdf(
            conn,
            test_settings(),
            {
                "filename": "reader-upload.pdf",
                "content_base64": base64.b64encode(source_pdf.read_bytes()).decode("ascii"),
            },
        )

        paper_id = int(result["paper"]["id"])
        report = conn.execute("SELECT * FROM paper_reading_reports WHERE paper_id = ?", (paper_id,)).fetchone()
        self.assertIsNotNone(report)
        self.assertEqual(report["status"], "queued")
        paper = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone()
        self.assertTrue(str(paper["arxiv_id"]).startswith("reader-upload-"))
        self.assertEqual(paper["text_status"], "complete")
        self.assertIn("Reader import extraction works", Path(paper["text_path"]).read_text(encoding="utf-8"))
        self.assertGreater(
            conn.execute("SELECT COUNT(*) AS count FROM arxiv_text_chunks WHERE paper_id = ?", (paper_id,)).fetchone()["count"],
            0,
        )

    def test_import_reader_url_downloads_direct_pdf_and_queues_report(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)

        def fake_download(_: str, destination: Path) -> None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"%PDF- fake")

        def fake_extract(_: Path, text_path: Path) -> int:
            text_path.parent.mkdir(parents=True, exist_ok=True)
            text_path.write_text("--- page 1 ---\nURL import text.", encoding="utf-8")
            return 28

        with patch("worker.paper_reader.download_pdf", side_effect=fake_download):
            with patch("worker.paper_reader.extract_pdf_text_to_file", side_effect=fake_extract):
                result = import_reader_urls(
                    conn,
                    test_settings(),
                    {"urls": "https://example.test/paper.pdf"},
                )

        self.assertEqual(len(result["imported"]), 1)
        paper_id = int(result["imported"][0]["paper_id"])
        report = conn.execute("SELECT * FROM paper_reading_reports WHERE paper_id = ?", (paper_id,)).fetchone()
        self.assertEqual(report["status"], "queued")
        paper = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone()
        self.assertTrue(str(paper["arxiv_id"]).startswith("reader-url-"))
        self.assertEqual(paper["pdf_link"], "https://example.test/paper.pdf")

    def test_import_reader_pdfs_batches_uploads(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)

        def fake_extract(_: Path, text_path: Path) -> int:
            text_path.parent.mkdir(parents=True, exist_ok=True)
            text_path.write_text("--- page 1 ---\nBatch import text.", encoding="utf-8")
            return 34

        payload = {
            "files": [
                {
                    "filename": "batch-a.pdf",
                    "content_base64": base64.b64encode(b"%PDF- batch-a").decode("ascii"),
                },
                {
                    "filename": "batch-b.pdf",
                    "content_base64": base64.b64encode(b"%PDF- batch-b").decode("ascii"),
                },
            ]
        }
        with patch("worker.paper_reader.extract_pdf_text_to_file", side_effect=fake_extract):
            result = import_reader_pdfs(conn, test_settings(), payload)

        self.assertTrue(result["ok"])
        self.assertEqual(len(result["imported"]), 2)
        self.assertEqual(result["errors"], [])
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 2)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM paper_reading_reports").fetchone()["count"], 2)

    def test_reader_save_writes_report_and_chat_to_obsidian(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        vault = Path.cwd() / ".test-tmp" / "reader-save-vault"
        vault.mkdir(parents=True, exist_ok=True)
        pdf_dir = Path.cwd() / ".test-tmp" / "reader-save-pdfs"
        pdf_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = pdf_dir / "reader-save.pdf"
        pdf_path.write_bytes(b"%PDF- reader save")
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, pdf_path, text_status, fetched_batch_id, created_at
            )
            VALUES (
              'reader-upload-save', 'Reader Save Paper', '[]', 'Reader save abstract.', '["reader"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              '', '', ?, 'complete', 'reader-import', 'now'
            )
            """,
            (str(pdf_path),),
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, report_markdown,
              error_message, created_at, updated_at, finished_at
            )
            VALUES (?, 'done', ?, 'system', '# 报告\n\n保存这份解读', '', 'now', 'now', 'now')
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT),
        )
        conn.execute(
            """
            INSERT INTO paper_reader_messages(paper_id, role, content, source, created_at)
            VALUES (?, 'user', '解释贡献。', 'chat', 'now')
            """,
            (paper_id,),
        )
        conn.execute(
            """
            INSERT INTO paper_reader_messages(paper_id, role, content, source, model, created_at)
            VALUES (?, 'assistant', '贡献是统一阅读器。', 'chat', 'test-chat-model', 'now')
            """,
            (paper_id,),
        )
        conn.commit()

        captured: dict[str, object] = {}

        def fake_chat(
            _: Settings,
            messages: list[dict[str, str]],
            response_format: dict[str, object] | None = None,
            **kwargs,
        ) -> str:
            captured["messages"] = messages
            captured["response_format"] = response_format
            captured["kwargs"] = kwargs
            return json.dumps(
                {
                    "tags": ["Paper/普通", "Concept/统一阅读器"],
                    "task": "Integrated paper reading",
                    "TLDR": "统一阅读器整合报告和追问。",
                    "aliases": ["RIS"],
                    "body": (
                        "# Reader Save Paper\n\n"
                        "## 研究问题和背景\n\n"
                        "保存这份解读。\n\n"
                        "## 对话补充\n\n"
                        "贡献是统一阅读器。"
                    ),
                },
                ensure_ascii=False,
            )

        with patch("worker.paper_reader._call_chat_text", side_effect=fake_chat):
            result = save_reader_note_to_obsidian(
                conn,
                Settings(
                    **{
                        **chat_settings(test_settings()).__dict__,
                        "obsidian_vault_path": vault,
                        "reader_smart_save_provider_id": "test-chat",
                        "reader_smart_save_model": "smart-save-dedicated",
                    }
                ),
                int(paper_id),
            )

        note = vault / result["obsidian_path"]
        text = note.read_text(encoding="utf-8")
        messages = captured["messages"]
        self.assertEqual(captured["response_format"], {"type": "json_object"})
        self.assertEqual(captured["kwargs"]["provider_id"], "test-chat")
        self.assertEqual(captured["kwargs"]["model"], "smart-save-dedicated")
        self.assertEqual(
            messages[0]["content"],
            "You are a careful research note editor. Produce precise, well-structured Markdown notes for Obsidian.",
        )
        self.assertIn("JSON 必须包含 tags、task、TLDR、aliases、body 五个字段。", messages[1]["content"])
        self.assertIn("保存这份解读", messages[1]["content"])
        self.assertIn("贡献是统一阅读器。", messages[1]["content"])
        self.assertIn("tags:", text)
        self.assertIn("Paper/普通", text)
        self.assertIn("Concept/统一阅读器", text)
        self.assertIn('task: "Integrated paper reading"', text)
        self.assertIn('TLDR: "统一阅读器整合报告和追问。"', text)
        self.assertIn("aliases:", text)
        self.assertIn("RIS", text)
        self.assertIn("保存这份解读", text)
        self.assertIn("贡献是统一阅读器。", text)
        self.assertNotIn("## User now", text)
        self.assertTrue((vault / result["attachment_path"]).exists())

    def test_reader_followup_questions_use_selected_text_prompt(self) -> None:
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
              'reader-followup', 'Reader Followup Paper', '[]', 'Followup abstract.', '["reader"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              '', '', 'complete', 'reader-import', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO paper_reader_messages(paper_id, role, content, source, model, created_at)
            VALUES (?, 'assistant', '关键术语 X 代表统一阅读器中的追问生成机制。', 'chat', 'test-chat-model', 'now')
            """,
            (paper_id,),
        )
        anchor_id = conn.execute("SELECT id FROM paper_reader_messages").fetchone()["id"]
        conn.commit()
        captured: dict[str, object] = {}

        def fake_chat(
            _: Settings,
            messages: list[dict[str, str]],
            response_format: dict[str, object] | None = None,
            **kwargs,
        ) -> str:
            captured["messages"] = messages
            captured["response_format"] = response_format
            captured["kwargs"] = kwargs
            return json.dumps(
                {
                    "questions": [
                        "请解释 X",
                        "X 如何触发？",
                        "X 依赖哪些上下文？",
                        "X 的输出是什么？",
                    ]
                },
                ensure_ascii=False,
            )

        with patch("worker.paper_reader._call_chat_text", side_effect=fake_chat):
            result = generate_reader_followup_questions(
                conn,
                Settings(
                    **{
                        **chat_settings(test_settings()).__dict__,
                        "reader_question_provider_id": "test-chat",
                        "reader_question_model": "question-dedicated",
                    }
                ),
                int(paper_id),
                {
                    "selected_text": "关键术语 X",
                    "anchor_message_id": int(anchor_id),
                    "context_text": "关键术语 X 代表统一阅读器中的追问生成机制。",
                },
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["questions"][0], "请解释 X")
        self.assertEqual(len(result["questions"]), 4)
        self.assertEqual(result["model"]["model"], "question-dedicated")
        messages = captured["messages"]
        self.assertEqual(captured["response_format"], {"type": "json_object"})
        self.assertEqual(captured["kwargs"]["provider_id"], "test-chat")
        self.assertEqual(captured["kwargs"]["model"], "question-dedicated")
        self.assertEqual(
            messages[0]["content"],
            "You generate concise, high-value follow-up questions for research paper reading conversations.",
        )
        self.assertIn("JSON 必须包含 questions 字段", messages[1]["content"])
        self.assertIn("<selected_text>\n关键术语 X\n</selected_text>", messages[1]["content"])
        self.assertIn("<message_context_window>", messages[1]["content"])

    def test_reader_message_delete_cancel_and_retry_report(self) -> None:
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
              'reader-control', 'Reader Control Paper', '[]', 'Control abstract.', '["reader"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              '', '', 'complete', 'reader-import', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, report_markdown,
              error_message, created_at, updated_at
            )
            VALUES (?, 'queued', ?, 'system', '', '', 'now', 'now')
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT),
        )
        conn.execute(
            """
            INSERT INTO paper_reader_messages(paper_id, role, content, source, created_at)
            VALUES (?, 'assistant', '可删除消息。', 'chat', 'now')
            """,
            (paper_id,),
        )
        message_id = conn.execute("SELECT id FROM paper_reader_messages").fetchone()["id"]
        conn.commit()

        deleted = delete_reader_message(conn, int(paper_id), int(message_id))
        self.assertTrue(deleted["ok"])
        self.assertEqual(deleted["reader_messages"], [])

        cancelled = cancel_reader_report(conn, int(paper_id))
        self.assertEqual(cancelled["paper_report"]["status"], "cancelled")

        retried = retry_reader_report(conn, test_settings(), int(paper_id))
        self.assertEqual(retried["paper_report"]["status"], "queued")

    def test_paper_reader_chat_stream_emits_chunks_and_persists_answer(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        text_dir = Path.cwd() / ".test-tmp" / "paper-reader-stream"
        text_dir.mkdir(parents=True, exist_ok=True)
        text_path = text_dir / "stream.txt"
        text_path.write_text("--- page 1 ---\nStream paper text.", encoding="utf-8")
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
            )
            VALUES (
              'reader-stream', 'Reader Stream Paper', '[]', 'Stream abstract.', '["reader"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              '', '', ?, 'complete', 'reader-import', 'now'
            )
            """,
            (str(text_path),),
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.commit()
        captured: dict[str, object] = {}

        def fake_chunks(_: Settings, messages: list[dict[str, str]], **kwargs):
            captured["messages"] = messages
            captured["kwargs"] = kwargs
            yield "第一段"
            yield "第二段"

        events: list[tuple[str, dict[str, object]]] = []
        settings = Settings(
            **{
                **chat_settings(test_settings()).__dict__,
                "reader_chat_provider_id": "test-chat",
                "reader_chat_model": "reader-stream-model",
            }
        )
        with patch("worker.paper_reader._iter_chat_text_chunks", side_effect=fake_chunks):
            paper_reader_chat_stream(
                conn,
                settings,
                int(paper_id),
                {"message": "流式解释。"},
                lambda event, data: events.append((event, data)),
            )

        self.assertEqual([event for event, _ in events], ["start", "chunk", "chunk", "done"])
        self.assertEqual(events[1][1]["text"], "第一段")
        self.assertEqual(events[2][1]["text"], "第二段")
        self.assertEqual(captured["kwargs"]["provider_id"], "test-chat")
        self.assertEqual(captured["kwargs"]["model"], "reader-stream-model")
        messages = conn.execute("SELECT role, content, model FROM paper_reader_messages ORDER BY id").fetchall()
        self.assertEqual([row["role"] for row in messages], ["user", "assistant"])
        self.assertEqual(messages[1]["content"], "第一段第二段")
        self.assertEqual(messages[1]["model"], "reader-stream-model")

    def test_paper_reports_queue_api_lists_statuses(self) -> None:
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
              '2605.00014', 'Queued Report Paper', '["A"]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00014', 'https://arxiv.org/pdf/2605.00014',
              'complete', 'batch', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, report_markdown,
              error_message, created_at, updated_at, finished_at
            )
            VALUES (?, 'done', ?, 'system', '# 全文报告\n\n队列报告内容', '', 'now', 'now', 'now')
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT),
        )
        conn.commit()

        result = paper_reports_queue(conn)

        self.assertEqual(result["stats"]["done"], 1)
        self.assertEqual(result["stats"]["total"], 1)
        self.assertEqual(result["items"][0]["paper_id"], paper_id)
        self.assertEqual(result["items"][0]["status"], "done")
        self.assertIn("队列报告内容", result["items"][0]["report_excerpt"])

    def test_remove_paper_report_hides_single_queue_item_without_requeueing(self) -> None:
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
              'Queue Delete Project', 'active', '[]', 'Research/Delete.md',
              'Research', 'Research', 'Status/进行中',
              'manual', '[]', '[]', '{}', 'now', 'now'
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
              '2605.00017', 'Queue Delete Paper', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00017', 'https://arxiv.org/pdf/2605.00017',
              'complete', 'batch', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_paper_recommendations(
              project_id, paper_id, state, importance, relation_type, reason,
              source_judgment_hash, created_at, updated_at
            )
            VALUES (?, ?, 'pending', '', 'direct', '仍然推荐但从队列隐藏', 'hash', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, source_project_ids_json,
              report_markdown, error_message, created_at, updated_at
            )
            VALUES (?, 'queued', ?, 'system', ?, '', '', 'now', 'now')
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT, to_json([int(project_id)])),
        )
        conn.commit()

        result = remove_paper_report(conn, int(paper_id))

        self.assertTrue(result["ok"])
        self.assertEqual(result["paper_reports_removed"], 1)
        status = conn.execute("SELECT status FROM paper_reading_reports WHERE paper_id = ?", (paper_id,)).fetchone()["status"]
        self.assertEqual(status, "removed")
        queue = paper_reports_queue(conn)
        self.assertEqual(queue["stats"]["total"], 0)
        self.assertEqual(queue["items"], [])

    def test_discard_recommendation_removes_report_queue_entry(self) -> None:
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
              'Discard Project', 'active', '[]', 'Research/Discard.md',
              'Research', 'Research', 'Status/进行中',
              'manual', '[]', '[]', '{}', 'now', 'now'
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
              '2605.00018', 'Discard Report Paper', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00018', 'https://arxiv.org/pdf/2605.00018',
              'complete', 'batch', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_paper_recommendations(
              project_id, paper_id, state, importance, relation_type, reason,
              source_judgment_hash, created_at, updated_at
            )
            VALUES (?, ?, 'pending', '', 'direct', '不再需要', 'hash', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, source_project_ids_json,
              report_markdown, error_message, created_at, updated_at
            )
            VALUES (?, 'queued', ?, 'system', ?, '', '', 'now', 'now')
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT, to_json([int(project_id)])),
        )
        conn.commit()

        result = update_paper_recommendation(
            conn,
            test_settings(),
            int(paper_id),
            {"action": "discard"},
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["paper_reports_deleted"], 1)
        state = conn.execute("SELECT state FROM project_paper_recommendations").fetchone()["state"]
        self.assertEqual(state, "discarded")
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM paper_reading_reports").fetchone()["count"], 0)
        queue = paper_reports_queue(conn)
        self.assertEqual(queue["stats"]["total"], 0)
        self.assertEqual(queue["items"], [])

    def test_discard_recommendation_preserves_reader_import_report(self) -> None:
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
              'Reader Project', 'active', '[]', 'Research/Reader.md',
              'Research', 'Research', 'Status/进行中',
              'manual', '[]', '[]', '{}', 'now', 'now'
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
              'reader-upload-abc123', 'Manual Reader Paper', '[]', 'Manual import', '["reader"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              '', '', 'complete', 'reader', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO project_paper_recommendations(
              project_id, paper_id, state, importance, relation_type, reason,
              source_judgment_hash, created_at, updated_at
            )
            VALUES (?, ?, 'pending', '', 'direct', '手动导入保留', 'hash', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, source_project_ids_json,
              report_markdown, error_message, created_at, updated_at
            )
            VALUES (?, 'queued', ?, 'system', ?, '', '', 'now', 'now')
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT, to_json([int(project_id)])),
        )
        conn.commit()

        result = update_paper_recommendation(
            conn,
            test_settings(),
            int(paper_id),
            {"action": "discard"},
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["paper_reports_deleted"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM paper_reading_reports").fetchone()["count"], 1)
        state = conn.execute("SELECT state FROM project_paper_recommendations").fetchone()["state"]
        self.assertEqual(state, "discarded")

    def test_reminder_registry_includes_paper_report_queue_events(self) -> None:
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
              '2605.00015', 'Reminder Report Paper', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.00015', 'https://arxiv.org/pdf/2605.00015',
              'complete', 'batch', 'now'
            )
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, report_markdown,
              error_message, created_at, updated_at
            )
            VALUES (?, 'queued', ?, 'system', '', '', 'now', 'now')
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT),
        )
        conn.commit()

        result = reminders(conn, limit=10)

        registered = {event["type"] for event in result["registered_events"]}
        item_types = {item["type"] for item in result["items"]}
        self.assertIn("daily_run_completed", registered)
        self.assertIn("paper_report_queue_backlog", registered)
        self.assertIn("paper_report_queue_backlog", item_types)

    def test_reminders_hide_superseded_failure_and_sort_by_latest_event(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, finished_at, message, meta_json)
            VALUES ('run-daily', 'failed', ?, ?, ?, '{}')
            """,
            (
                "2026-05-07T05:30:00+00:00",
                "2026-05-07T05:35:20+00:00",
                "OBSIDIAN_VAULT_PATH does not exist",
            ),
        )
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, finished_at, message, meta_json)
            VALUES ('run-daily', 'completed', ?, ?, '', '{}')
            """,
            (
                "2026-05-07T05:40:00+00:00",
                "2026-05-07T05:56:19+00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO job_runs(job_type, status, started_at, finished_at, message, meta_json)
            VALUES ('generate-paper-reports', 'completed', ?, ?, '', ?)
            """,
            (
                "2026-05-07T15:30:00+00:00",
                "2026-05-07T15:32:11+00:00",
                to_json({"paper_reports_done": 1}),
            ),
        )
        conn.commit()

        result = reminders(conn, limit=5)
        item_types = [item["type"] for item in result["items"]]

        self.assertEqual(item_types[0], "paper_report_completed")
        self.assertIn("daily_run_completed", item_types)
        self.assertNotIn("job_failed", item_types)

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
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, model_provider_id, model,
              source_text_hash, source_project_ids_json, report_markdown,
              error_message, created_at, updated_at, finished_at
            )
            VALUES (
              ?, 'done', ?, 'system', 'test-chat', 'test-model',
              'hash', '[]', '# 全文报告\n\n完整报告内容',
              '', 'now', 'now', 'now'
            )
            """,
            (paper_id, PAPER_READER_DEFAULT_PROMPT),
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
        self.assertIn("完整报告内容", note_text)
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

    def test_worker_concurrency_settings_are_configurable(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)

        save_app_settings(conn, {"paper_report_queue_concurrency": 3, "embedding_concurrency": 4})
        payload = get_app_settings(conn, test_settings())["settings"]
        applied = apply_stored_settings(conn, test_settings())

        self.assertEqual(payload["paper_report_queue_concurrency"], 3)
        self.assertEqual(payload["embedding_concurrency"], 4)
        self.assertEqual(applied.embedding_concurrency, 4)

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

    def test_sync_obsidian_backfills_missing_chunk_embeddings_for_skipped_notes(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        vault = Path.cwd() / ".test-tmp" / "embedding-backfill-vault"
        note = vault / "Research" / "Stable.md"
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text("# Stable\nExisting note chunk should receive embedding later.", encoding="utf-8")
        settings = Settings(
            **{
                **embedding_settings().__dict__,
                "obsidian_vault_path": vault,
                "obsidian_include_dirs": ["Research"],
                "embedding_concurrency": 2,
            }
        )

        with patch("worker.obsidian.embed_text", return_value=None):
            first = sync_obsidian(conn, settings)

        self.assertEqual(first["notes_indexed"], 1)
        self.assertEqual(first["embeddings_created"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM chunk_embeddings").fetchone()["count"], 0)

        with patch("worker.embeddings.embed_text", return_value=[0.1, 0.2]):
            second = sync_obsidian(conn, settings)

        self.assertEqual(second["notes_indexed"], 0)
        self.assertEqual(second["notes_skipped"], 1)
        self.assertEqual(second["note_chunk_embeddings_created"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM chunk_embeddings").fetchone()["count"], 1)

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
        conn.execute(
            """
            INSERT INTO project_papers(project_id, paper_id, relation, note, created_at, updated_at)
            VALUES (?, ?, 'candidate', 'auto_matched_by_project_context', 'now', 'now')
            """,
            (project_id, paper_id),
        )
        conn.commit()

        detail = project_detail(conn, int(project_id))
        self.assertEqual(detail["project"]["paper_count"], 0)
        self.assertEqual(detail["papers"], [])
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

    def test_run_daily_project_pipeline_skips_paused_and_archived_projects(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        project_ids: list[int] = []
        obsidian_chunk_ids: list[int] = []
        for status in ("paused", "archived"):
            conn.execute(
                """
                INSERT INTO research_projects(
                  name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
                  obsidian_folder, obsidian_status_tag, discovery_source, source_tags_json,
                  arxiv_categories_json, automation_json, created_at, updated_at
                )
                VALUES (?, ?, '[]', ?, ?, ?, '', 'manual', '[]', '[]', '{}', 'now', 'now')
                """,
                (
                    f"Inactive {status}",
                    status,
                    f"Research/Inactive {status}/Home.md",
                    f"Research/Inactive {status}",
                    f"Research/Inactive {status}",
                ),
            )
            project_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            project_ids.append(project_id)
            conn.execute(
                """
                INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
                VALUES (?, ?, '{}', '[]', ?, 1, 'now')
                """,
                (f"Research/Inactive {status}/Method.md", f"Inactive {status}", f"sha-{status}"),
            )
            note_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
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
                VALUES (?, 0, 'Inactive Method', 'Paused archived projects should not rank daily papers.', 8, 'obsidian', 'now')
                """,
                (note_id,),
            )
            obsidian_chunk_ids.append(int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]))

        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_status, fetched_batch_id, created_at
            )
            VALUES (
              '2605.09001', 'Inactive Project Paper', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z',
              'https://arxiv.org/abs/2605.09001', 'https://arxiv.org/pdf/2605.09001',
              'complete', 'batch', 'now'
            )
            """
        )
        paper_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
            VALUES (?, 0, 'full_text', 'Paused archived projects should not rank daily papers.', 8, 60, 'now')
            """,
            (paper_id,),
        )
        arxiv_chunk_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        conn.commit()

        rank_result = rank_project_papers(conn, test_settings(), papers=conn.execute("SELECT * FROM arxiv_papers").fetchall())
        self.assertEqual(rank_result["project_rank_projects_considered"], 0)
        self.assertEqual(rank_result["project_paper_matches_created"], 0)

        for project_id, obsidian_chunk_id in zip(project_ids, obsidian_chunk_ids):
            conn.execute(
                """
                INSERT INTO project_paper_matches(
                  project_id, paper_id, score, rank_score, quality_score,
                  best_arxiv_chunk_id, best_obsidian_chunk_id, searchers_json,
                  evidence_json, match_type, created_at, updated_at
                )
                VALUES (?, ?, 0.9, 0.9, 0.9, ?, ?, '[]', '{}', 'project_context', 'now', 'now')
                """,
                (project_id, paper_id, arxiv_chunk_id, obsidian_chunk_id),
            )
        conn.commit()

        with patch("worker.llm._call_chat", side_effect=AssertionError("inactive project should not be judged")):
            judgment_result = generate_missing_project_judgments(conn, test_settings(), [paper_id])
        self.assertEqual(judgment_result["project_judgment_candidates"], 0)
        self.assertEqual(judgment_result["project_judgments_created"], 0)

        for project_id in project_ids:
            conn.execute(
                """
                INSERT INTO project_paper_judgments(
                  project_id, paper_id, relation_type, relevance_score, usefulness_score,
                  confidence, suggested_action, reason, evidence_mapping_json,
                  missing_evidence, input_hash, prompt_version, raw_json, created_at, updated_at
                )
                VALUES (?, ?, 'direct', 0.9, 0.85, 0.9, 'read',
                  'Inactive project judgment should not create daily recommendations.',
                  '[]', '', ?, 'test', '{}', 'now', 'now')
                """,
                (project_id, paper_id, f"hash-{project_id}"),
            )
        conn.commit()

        recommendation_result = sync_project_paper_recommendations(conn, [paper_id])
        self.assertEqual(recommendation_result["paper_recommendation_candidates"], 0)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) AS count FROM project_paper_recommendations").fetchone()["count"],
            0,
        )

        conn.execute(
            """
            INSERT INTO project_paper_recommendations(
              project_id, paper_id, state, importance, relation_type, reason,
              source_judgment_hash, created_at, updated_at
            )
            VALUES (?, ?, 'pending', '', 'direct', 'old inactive recommendation', 'old-hash', 'now', 'now')
            """,
            (project_ids[0], paper_id),
        )
        conn.commit()

        report_queue_result = ensure_paper_reports_for_recommendations(conn, [paper_id])
        self.assertEqual(report_queue_result["paper_reports_candidates"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM paper_reading_reports").fetchone()["count"], 0)

        vault = Path.cwd() / ".test-tmp" / "inactive-project-report-vault"
        vault.mkdir(parents=True, exist_ok=True)
        report_settings = chat_settings(Settings(**{**test_settings().__dict__, "obsidian_vault_path": vault}))
        with patch(
            "worker.reports.call_chat_json",
            return_value={"markdown": "# 今日科研情报日报\n\n## 今日结论\n\n无活跃项目候选。"},
        ) as call_chat:
            daily_report_result = generate_daily_report(
                conn,
                report_settings,
                stats={"project_paper_matches_created": 2},
                paper_ids=[paper_id],
            )
        self.assertEqual(daily_report_result["daily_report_project_matches"], 0)
        self.assertNotIn("Inactive Project Paper", call_chat.call_args.args[1])

        archive_result = archive_zero_match_papers(conn, test_settings(), [paper_id])
        self.assertEqual(archive_result["zero_match_papers_archived"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 0)

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
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM project_papers").fetchone()["count"], 0)
        detail = project_detail(conn, int(project_id))
        self.assertEqual(detail["project_matches"][0]["paper_id"], paper_id)
        self.assertEqual(detail["papers"], [])
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
        self.assertEqual(call_chat.call_args.kwargs["response_format"], {"type": "json_object"})
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

    def test_missing_arxiv_chunk_embeddings_use_configured_concurrency(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('2501.00003', 'Parallel embedding', '[]', 'Abstract', '["cs.CL"]',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'https://arxiv.org/abs/2501.00003',
              'https://arxiv.org/pdf/2501.00003', 'batch', 'now')
            """
        )
        paper_id = conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"]
        for index in range(6):
            conn.execute(
                """
                INSERT INTO arxiv_text_chunks(paper_id, chunk_index, source, text, token_count, char_count, created_at)
                VALUES (?, ?, 'full_text', ?, 3, 20, 'now')
                """,
                (paper_id, index, f"parallel embedding text {index}"),
            )
        conn.commit()
        settings = Settings(**{**embedding_settings().__dict__, "embedding_concurrency": 3})
        active = 0
        max_active = 0
        lock = threading.Lock()

        def fake_embed_text(_settings: Settings, text: str) -> list[float]:
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            return [float(len(text))]

        with patch("worker.embeddings.embed_text", side_effect=fake_embed_text):
            result = ensure_missing_arxiv_chunk_embeddings(conn, settings)

        self.assertGreater(max_active, 1)
        self.assertEqual(result["arxiv_chunk_embeddings_created"], 6)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) AS count FROM arxiv_chunk_embeddings").fetchone()["count"],
            6,
        )

    def test_arxiv_paper_embeddings_use_configured_concurrency(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        for index in range(6):
            conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json, published_at,
                  updated_at, link, pdf_link, fetched_batch_id, created_at
                )
                VALUES (?, ?, '[]', ?, '["cs.CL"]',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?,
                  'batch', 'now')
                """,
                (
                    f"2501.10{index:03d}",
                    f"Parallel paper {index}",
                    f"Abstract text {index}",
                    f"https://arxiv.org/abs/2501.10{index:03d}",
                    f"https://arxiv.org/pdf/2501.10{index:03d}",
                ),
            )
        conn.commit()
        papers = conn.execute("SELECT * FROM arxiv_papers ORDER BY id").fetchall()
        settings = Settings(**{**embedding_settings().__dict__, "embedding_concurrency": 3})
        active = 0
        max_active = 0
        lock = threading.Lock()

        def fake_embed_text(_settings: Settings, text: str) -> list[float]:
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            return [float(len(text))]

        with patch("worker.embeddings.embed_text", side_effect=fake_embed_text):
            embeddings = ensure_arxiv_paper_embeddings(conn, settings, list(papers))

        self.assertGreater(max_active, 1)
        self.assertEqual(len([value for value in embeddings.values() if value]), 6)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) AS count FROM arxiv_paper_embeddings").fetchone()["count"],
            6,
        )

    def test_missing_note_chunk_embeddings_use_configured_concurrency(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_db(conn)
        conn.execute(
            """
            INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
            VALUES ('Research/Parallel.md', 'Parallel', '{}', '[]', 'sha', 1, 'now')
            """
        )
        note_id = conn.execute("SELECT id FROM obsidian_notes").fetchone()["id"]
        for index in range(6):
            conn.execute(
                """
                INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
                VALUES (?, ?, 'Parallel', ?, 3, 'obsidian', 'now')
                """,
                (note_id, index, f"parallel note chunk {index}"),
            )
        conn.commit()
        settings = Settings(**{**embedding_settings().__dict__, "embedding_concurrency": 3})
        active = 0
        max_active = 0
        lock = threading.Lock()

        def fake_embed_text(_settings: Settings, text: str) -> list[float]:
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            return [float(len(text))]

        with patch("worker.embeddings.embed_text", side_effect=fake_embed_text):
            result = ensure_missing_note_chunk_embeddings(conn, settings)

        self.assertGreater(max_active, 1)
        self.assertEqual(result["note_chunk_embeddings_created"], 6)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) AS count FROM chunk_embeddings").fetchone()["count"],
            6,
        )

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
