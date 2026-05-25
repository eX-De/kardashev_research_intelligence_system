from __future__ import annotations

import json
import unittest
from pathlib import Path
from unittest.mock import patch

from helpers import connect_test_db
from worker.config import LLMProvider, Settings
from worker.api import export_artifact
from worker.artifacts import upsert_artifact
from worker.obsidian import OBSIDIAN_NOT_CONFIGURED, ObsidianNotConfiguredError
from worker.paper_reports import process_paper_report_queue, queue_paper_report
from worker.papers import paper_id_for_arxiv_paper_id, upsert_manual_paper
from worker.reports import generate_daily_report


def settings(*, vault: Path | None = None) -> Settings:
    return Settings(
        obsidian_vault_path=vault,
        obsidian_include_dirs=[],
        obsidian_include_tags=[],
        obsidian_project_center_tags=[],
        obsidian_cli_command="obsidian",
        obsidian_paper_repository_dir="Papers",
        obsidian_paper_attachment_dir="Papers/attachments",
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
        rag_searchers=["keyword_search"],
        rag_prefilter_enabled=False,
        rag_prefilter_threshold=0.18,
        rag_prefilter_top_k=20,
        rag_prefilter_min_keep=30,
        rag_prefilter_max_keep=50,
        llm_providers=[
            LLMProvider(
                id="test-chat",
                name="Test Chat",
                base_url="https://llm.test/v1",
                api_key="test-key",
                chat_models=["test-chat-model"],
                embedding_models=[],
            )
        ],
        llm_chat_provider_id="test-chat",
        llm_chat_model="test-chat-model",
        llm_embedding_provider_id="",
        llm_embedding_model="",
        embedding_concurrency=2,
    )


class ArtifactTests(unittest.TestCase):
    def test_artifact_export_without_obsidian_vault_raises_structured_error(self) -> None:
        conn = connect_test_db()
        artifact = upsert_artifact(
            conn,
            scope_type="system",
            artifact_type="daily_report",
            title="No Vault Report",
            content_markdown="# Report\n\nNo vault.",
            source_key="test:no-vault-report",
        )

        with self.assertRaises(ObsidianNotConfiguredError) as caught:
            export_artifact(conn, settings(), int(artifact["id"]))

        self.assertEqual(caught.exception.reason, OBSIDIAN_NOT_CONFIGURED)
        self.assertEqual(caught.exception.to_payload()["code"], OBSIDIAN_NOT_CONFIGURED)

    def test_daily_report_creates_artifact_without_obsidian_vault(self) -> None:
        conn = connect_test_db()

        with patch(
            "worker.reports.call_chat_json",
            return_value={
                "markdown": "# 今日科研情报日报\n\n## 今日结论\n\n无 Obsidian 时仍然生成系统内日报。"
            },
        ):
            result = generate_daily_report(conn, settings(), stats={"arxiv_papers_inserted": 0})

        self.assertEqual(result["reports_created"], 1)
        self.assertEqual(result["daily_reports_created"], 1)
        self.assertFalse(result["daily_report_exported"])
        self.assertEqual(result["daily_report_path"], "")
        artifact = conn.execute("SELECT * FROM artifacts WHERE id = ?", (result["daily_report_artifact_id"],)).fetchone()
        self.assertIsNotNone(artifact)
        self.assertEqual(artifact["scope_type"], "system")
        self.assertIsNone(artifact["scope_id"])
        self.assertEqual(artifact["artifact_type"], "daily_report")
        self.assertIn("无 Obsidian 时仍然生成系统内日报", artifact["content_markdown"])
        source = json.loads(artifact["source_json"])
        self.assertEqual(source["source_key"][:13], "daily_report:")

    def test_generated_paper_report_is_mirrored_to_artifact(self) -> None:
        conn = connect_test_db()
        upsert_manual_paper(conn, title="Existing Library Paper", abstract="Keeps paper ids from matching legacy ids.")
        text_dir = Path.cwd() / ".test-tmp" / "artifact-paper-report"
        text_dir.mkdir(parents=True, exist_ok=True)
        text_path = text_dir / "paper.txt"
        text_path.write_text("--- page 1 ---\nFull paper body for artifact mirroring.", encoding="utf-8")
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, text_path, text_status, fetched_batch_id, created_at
            )
            VALUES ('2605.99999', 'Artifact Mirror Paper', '[]', 'Abstract', '["cs.AI"]',
              '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z',
              'https://arxiv.org/abs/2605.99999', 'https://arxiv.org/pdf/2605.99999',
              ?, 'complete', 'batch', 'now')
            """,
            (str(text_path),),
        )
        paper_id = int(conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"])
        queue_paper_report(conn, paper_id, prompt="Summarize")
        queued = conn.execute("SELECT id, content_json FROM artifacts WHERE artifact_type = 'paper_report'").fetchone()
        content = json.loads(queued["content_json"])
        content["source_project_ids"] = [7]
        conn.execute("UPDATE artifacts SET content_json = ? WHERE id = ?", (json.dumps(content), queued["id"]))
        conn.commit()

        with patch(
            "worker.paper_reports._call_chat_text",
            return_value=json.dumps(
                {"title": "Artifact Mirror Paper", "markdown": "# 全文报告\n\nArtifact markdown body."},
                ensure_ascii=False,
            ),
        ):
            result = process_paper_report_queue(conn, settings(), [paper_id])

        self.assertEqual(result["paper_reports_done"], 1)
        library_paper_id = paper_id_for_arxiv_paper_id(conn, paper_id)
        self.assertIsNotNone(library_paper_id)
        self.assertNotEqual(library_paper_id, paper_id)
        artifact = conn.execute(
            """
            SELECT *
            FROM artifacts
            WHERE scope_type = 'paper'
              AND scope_id = ?
              AND artifact_type = 'paper_report'
            """,
            (library_paper_id,),
        ).fetchone()
        self.assertIsNotNone(artifact)
        self.assertEqual(artifact["title"], "Artifact Mirror Paper")
        self.assertIn("Artifact markdown body", artifact["content_markdown"])
        content = json.loads(artifact["content_json"])
        self.assertEqual(content["paper_id"], library_paper_id)
        self.assertEqual(content["legacy_arxiv_paper_id"], paper_id)
        self.assertEqual(content["source_project_ids"], [7])
        self.assertEqual(json.loads(artifact["source_json"])["source_key"], f"paper_report:{paper_id}")


if __name__ == "__main__":
    unittest.main()
