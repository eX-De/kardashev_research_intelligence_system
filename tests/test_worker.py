from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path

from worker.config import LLMProvider, Settings
from worker.api import (
    export_project_to_obsidian,
    link_project_note,
    link_project_paper,
    project_detail,
    projects,
    save_project,
    unlink_project_paper,
)
from worker.arxiv_text import cache_arxiv_full_texts, extract_pdf_text_to_file, safe_arxiv_filename
from worker.db import clean_unicode, init_db, to_json
from worker.embeddings import ensure_arxiv_chunk_embedding
from worker.obsidian import parse_note
from worker.obsidian import sync_obsidian
from worker.reports import generate_project_paper_reports
from worker.search import hybrid_search, rank_project_papers, rank_unmatched_papers
from worker.settings_store import apply_stored_settings, get_app_settings, save_app_settings


def test_settings() -> Settings:
    return Settings(
        db_path=Path(":memory:"),
        obsidian_vault_path=None,
        obsidian_include_dirs=[],
        obsidian_include_tags=[],
        obsidian_project_center_tags=[],
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


class WorkerTests(unittest.TestCase):
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
            "---\ntitle: Agentic RAG\ntags: [project, Status/进行中]\n---\n# Agentic RAG\nProject center page.",
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

        vault = Path.cwd() / ".test-tmp" / "report-vault"
        (vault / "Research" / "Agentic RAG").mkdir(parents=True, exist_ok=True)
        report_settings = Settings(**{**test_settings().__dict__, "obsidian_vault_path": vault})
        report_result = generate_project_paper_reports(conn, report_settings)
        self.assertEqual(report_result["reports_created"], 1)
        report_path = vault / "Research" / "Agentic RAG" / "Papers" / "2501.00003 - Agentic Retrieval Planning.md"
        self.assertTrue(report_path.exists())
        report_text = report_path.read_text(encoding="utf-8")
        self.assertIn("## 结论", report_text)
        self.assertIn("## 具体有用在哪", report_text)
        self.assertIn("Agentic Retrieval Planning", report_text)
        artifact = conn.execute(
            "SELECT artifact_type, obsidian_path, status FROM project_artifacts WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        self.assertEqual(artifact["artifact_type"], "paper_usefulness_report")
        self.assertEqual(artifact["status"], "synced")

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


if __name__ == "__main__":
    unittest.main()
