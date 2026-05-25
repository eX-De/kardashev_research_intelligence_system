from __future__ import annotations

import unittest
from pathlib import Path

from helpers import connect_test_db
from worker.arxiv_archive import archive_zero_match_papers
from worker.api import library_paper_detail as api_library_paper_detail
from worker.arxiv_text import replace_arxiv_chunks_for_paper
from worker.config import Settings
from worker.paper_reports import queue_paper_report
from worker.papers import (
    list_paper_library,
    paper_id_for_arxiv_paper_id,
    paper_library_detail,
    set_arxiv_paper_library_status,
    upsert_paper_from_arxiv,
)


def test_settings() -> Settings:
    return Settings(
        obsidian_vault_path=None,
        obsidian_include_dirs=[],
        obsidian_include_tags=[],
        obsidian_project_center_tags=[],
        obsidian_cli_command="obsidian",
        obsidian_paper_repository_dir="Papers",
        obsidian_paper_attachment_dir="Papers/attachments",
        obsidian_project_paper_list_name="papers.md",
        arxiv_categories=["cs.AI"],
        arxiv_daily_lookback_days=1,
        arxiv_max_results=10,
        arxiv_request_interval_seconds=0,
        arxiv_cache_full_text=True,
        arxiv_pdf_dir=Path(".test-tmp/paper-library/pdfs"),
        arxiv_text_dir=Path(".test-tmp/paper-library/text"),
        retry_daily_max_results=100,
        rag_score_threshold=0.1,
        rag_top_k=3,
        rag_searchers=["keyword_search"],
        rag_prefilter_enabled=False,
        rag_prefilter_threshold=0.18,
        rag_prefilter_top_k=20,
        rag_prefilter_min_keep=30,
        rag_prefilter_max_keep=50,
        llm_providers=[],
        llm_chat_provider_id="",
        llm_chat_model="",
        llm_embedding_provider_id="",
        llm_embedding_model="",
        embedding_concurrency=2,
    )


def _conn():
    return connect_test_db()


def _insert_arxiv_paper(conn, arxiv_id: str = "2605.10001") -> int:
    conn.execute(
        """
        INSERT INTO arxiv_papers(
          arxiv_id, title, authors_json, summary, categories_json, published_at,
          updated_at, link, pdf_link, text_status, fetched_batch_id, created_at
        )
        VALUES (?, 'Library Paper', '["Ada"]', 'Abstract text', '["cs.AI"]',
          '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', ?, ?, 'complete', 'batch', 'now')
        """,
        (arxiv_id, f"https://arxiv.org/abs/{arxiv_id}", f"https://arxiv.org/pdf/{arxiv_id}"),
    )
    return int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])


class PaperLibraryTests(unittest.TestCase):
    def test_arxiv_mirror_status_flow_and_chunks(self) -> None:
        conn = _conn()
        arxiv_paper_id = _insert_arxiv_paper(conn)
        row = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (arxiv_paper_id,)).fetchone()

        long_term_id = upsert_paper_from_arxiv(conn, row)
        replace_arxiv_chunks_for_paper(
            conn,
            row,
            "--- page 1 ---\nFull text about agents, retrieval, planning, evaluation, and long-term memory systems.",
        )
        set_arxiv_paper_library_status(conn, arxiv_paper_id, "saved")
        upsert_paper_from_arxiv(conn, row, library_status="candidate")
        set_arxiv_paper_library_status(conn, arxiv_paper_id, "reading")
        set_arxiv_paper_library_status(conn, arxiv_paper_id, "read")
        conn.commit()

        detail = paper_library_detail(conn, long_term_id)
        self.assertEqual(detail["paper"]["library_status"], "read")
        self.assertEqual(detail["paper"]["reading_state"], "read")
        self.assertEqual(detail["paper"]["arxiv_id"], "2605.10001")
        self.assertEqual([source["source_type"] for source in detail["sources"]], ["arxiv"])
        self.assertGreaterEqual(len(detail["assets"]), 1)
        self.assertGreaterEqual(len(detail["chunks"]), 2)

        listed = list_paper_library(conn, library_status="read")
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["items"][0]["id"], long_term_id)

    def test_library_list_does_not_create_library_papers_from_arxiv_cache(self) -> None:
        conn = connect_test_db()
        _insert_arxiv_paper(conn, "2605.19999")
        conn.commit()

        listed = list_paper_library(conn, limit=1)
        paper_count = conn.execute("SELECT COUNT(*) AS count FROM papers").fetchone()["count"]
        conn.close()

        self.assertEqual(listed["total"], 0)
        self.assertEqual(listed["items"], [])
        self.assertEqual(paper_count, 0)

    def test_library_default_list_excludes_archived_and_discarded_papers(self) -> None:
        conn = _conn()
        archived_arxiv_id = _insert_arxiv_paper(conn, "2605.20001")
        discarded_arxiv_id = _insert_arxiv_paper(conn, "2605.20002")
        set_arxiv_paper_library_status(conn, archived_arxiv_id, "archived")
        set_arxiv_paper_library_status(conn, discarded_arxiv_id, "discarded")
        conn.commit()

        listed = list_paper_library(conn)
        archived = list_paper_library(conn, library_status="archived")
        discarded = list_paper_library(conn, library_status="discarded")

        self.assertEqual(listed["total"], 0)
        self.assertEqual(archived["total"], 1)
        self.assertEqual(discarded["total"], 1)

    def test_library_list_filters_by_publication_date_and_paginates(self) -> None:
        conn = _conn()
        for arxiv_id, published_at in (
            ("2605.30001", "2026-05-01T00:00:00Z"),
            ("2605.30002", "2026-05-10T00:00:00Z"),
            ("2605.30003", "2026-05-20T00:00:00Z"),
        ):
            row_id = _insert_arxiv_paper(conn, arxiv_id)
            conn.execute(
                "UPDATE arxiv_papers SET published_at = ?, updated_at = ? WHERE id = ?",
                (published_at, published_at, row_id),
            )
        for row in conn.execute("SELECT * FROM arxiv_papers ORDER BY published_at DESC").fetchall():
            upsert_paper_from_arxiv(conn, row)
        conn.commit()

        filtered = list_paper_library(conn, date_from="2026-05-05", date_to="2026-05-20", limit=1)
        second_page = list_paper_library(
            conn,
            date_from="2026-05-05",
            date_to="2026-05-20",
            limit=1,
            offset=1,
        )

        self.assertEqual(filtered["total"], 2)
        self.assertEqual([item["arxiv_id"] for item in filtered["items"]], ["2605.30003"])
        self.assertEqual([item["arxiv_id"] for item in second_page["items"]], ["2605.30002"])

    def test_library_list_does_not_retouch_existing_mirrored_papers(self) -> None:
        conn = _conn()
        for arxiv_id, published_at in (
            ("2605.31001", "2026-05-02T00:00:00Z"),
            ("2605.31002", "2026-05-01T00:00:00Z"),
        ):
            row_id = _insert_arxiv_paper(conn, arxiv_id)
            conn.execute(
                "UPDATE arxiv_papers SET published_at = ?, updated_at = ? WHERE id = ?",
                (published_at, published_at, row_id),
            )
        conn.commit()

        for row in conn.execute("SELECT * FROM arxiv_papers ORDER BY published_at DESC").fetchall():
            upsert_paper_from_arxiv(conn, row)
        conn.execute("UPDATE papers SET updated_at = '2026-05-18T00:00:00Z'")
        conn.commit()

        first = list_paper_library(conn, limit=2)
        second = list_paper_library(conn, limit=2)
        timestamps = conn.execute("SELECT DISTINCT updated_at FROM papers").fetchall()

        self.assertEqual([item["arxiv_id"] for item in first["items"]], ["2605.31001", "2605.31002"])
        self.assertEqual([item["arxiv_id"] for item in second["items"]], ["2605.31001", "2605.31002"])
        self.assertEqual([row["updated_at"] for row in timestamps], ["2026-05-18T00:00:00Z"])

    def test_library_detail_exposes_existing_paper_report_link_target(self) -> None:
        conn = _conn()
        arxiv_paper_id = _insert_arxiv_paper(conn, "2605.32001")
        row = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (arxiv_paper_id,)).fetchone()
        library_paper_id = upsert_paper_from_arxiv(conn, row)
        queue_paper_report(conn, arxiv_paper_id, prompt="Summarize")

        detail = api_library_paper_detail(conn, library_paper_id)

        self.assertEqual(detail["legacy_arxiv_paper_id"], arxiv_paper_id)
        self.assertEqual(detail["paper_report"]["paper_id"], arxiv_paper_id)
        self.assertEqual(detail["paper_report"]["status"], "queued")

    def test_archive_zero_match_soft_archives_candidate_library_paper(self) -> None:
        conn = _conn()
        arxiv_paper_id = _insert_arxiv_paper(conn, "2605.20003")
        conn.commit()

        result = archive_zero_match_papers(conn, test_settings(), [arxiv_paper_id])

        self.assertEqual(result["zero_match_papers_archived"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 1)
        self.assertEqual(conn.execute("SELECT library_status FROM papers").fetchone()["library_status"], "archived")
        self.assertEqual(list_paper_library(conn)["total"], 0)
        self.assertEqual(list_paper_library(conn, library_status="archived")["total"], 1)

    def test_archive_zero_match_skips_saved_library_paper(self) -> None:
        conn = _conn()
        arxiv_paper_id = _insert_arxiv_paper(conn, "2605.10002")
        paper_id = paper_id_for_arxiv_paper_id(conn, arxiv_paper_id)
        self.assertIsNotNone(paper_id)
        set_arxiv_paper_library_status(conn, arxiv_paper_id, "saved")
        conn.commit()

        result = archive_zero_match_papers(conn, test_settings(), [arxiv_paper_id])

        self.assertEqual(result["zero_match_papers_archived"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 1)
        self.assertEqual(conn.execute("SELECT library_status FROM papers").fetchone()["library_status"], "saved")

    def test_archive_zero_match_skips_paper_artifact(self) -> None:
        conn = _conn()
        arxiv_paper_id = _insert_arxiv_paper(conn, "2605.10003")
        paper_id = paper_id_for_arxiv_paper_id(conn, arxiv_paper_id)
        self.assertIsNotNone(paper_id)
        conn.execute(
            """
            INSERT INTO artifacts(scope_type, scope_id, artifact_type, title, content_markdown, status, created_at, updated_at)
            VALUES ('paper', ?, 'paper_report', 'Report', '# Report', 'done', 'now', 'now')
            """,
            (paper_id,),
        )
        conn.commit()

        result = archive_zero_match_papers(conn, test_settings(), [arxiv_paper_id])

        self.assertEqual(result["zero_match_papers_archived"], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM arxiv_papers").fetchone()["count"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM artifacts").fetchone()["count"], 1)


if __name__ == "__main__":
    unittest.main()
