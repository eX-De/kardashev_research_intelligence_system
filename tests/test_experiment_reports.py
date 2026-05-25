from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from helpers import connect_test_db
from worker.config import Settings
from worker.experiment_reports import create_experiment_report


def test_settings(*, vault: Path | None = None) -> Settings:
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
        llm_providers=[],
        llm_chat_provider_id="",
        llm_chat_model="",
        llm_embedding_provider_id="",
        llm_embedding_model="",
        embedding_concurrency=2,
    )


def insert_project(conn, *, output_dir: str = "") -> int:
    conn.execute(
        """
        INSERT INTO research_projects(name, status, obsidian_output_dir, created_at, updated_at)
        VALUES ('Experiment Project', 'active', ?, 'now', 'now')
        """,
        (output_dir,),
    )
    return int(conn.execute("SELECT id FROM research_projects").fetchone()["id"])


def payload(project_id: int, *, key: str = "report-1", title: str = "First run") -> dict[str, object]:
    return {
        "project_id": project_id,
        "title": title,
        "markdown": (
            "## 本次任务\n\n"
            "实现实验报告接收并确认它可以进入项目上下文。\n\n"
            "## 代码与实现概要\n\n"
            "新增 API、产物和知识文档写入路径，便于后续论文匹配读取。\n\n"
            "## 结果\n\n"
            "报告已被保存并切块。"
        ),
        "report_json": {
            "task_summary": "实现实验报告接收",
            "code_summary": "新增 API 和知识文档写入",
            "goal": "让实验进展成为项目上下文",
            "what_changed": ["新增接收接口"],
            "results": ["保存为产物", "写入知识文档"],
            "conclusion": "流程可行",
            "next_actions": ["接入 UI"],
        },
        "source_agent": "codex",
        "idempotency_key": key,
        "metadata": {"workspace": "D:/coding/example"},
    }


class ExperimentReportTests(unittest.TestCase):
    def test_experiment_report_creates_artifact_and_project_context_document(self) -> None:
        conn = connect_test_db()
        project_id = insert_project(conn)

        result = create_experiment_report(conn, test_settings(), payload(project_id))

        self.assertTrue(result["ok"])
        self.assertEqual(result["artifact"]["artifact_type"], "experiment_report")
        self.assertEqual(result["artifact"]["scope_type"], "project")
        self.assertEqual(result["artifact"]["scope_id"], project_id)
        self.assertEqual(result["obsidian"]["status"], "skipped")

        document = conn.execute("SELECT * FROM knowledge_documents").fetchone()
        self.assertEqual(document["source_type"], "experiment_report")
        self.assertIn("代码与实现概要", document["raw_content"])

        link = conn.execute("SELECT * FROM project_context_documents").fetchone()
        self.assertEqual(link["project_id"], project_id)
        self.assertEqual(link["document_id"], int(document["id"]))
        self.assertEqual(link["relation"], "experiment_progress")

        chunk = conn.execute("SELECT * FROM research_chunks WHERE document_id = ?", (document["id"],)).fetchone()
        self.assertIsNotNone(chunk)
        self.assertEqual(chunk["source"], "experiment_report")

    def test_experiment_report_idempotency_updates_existing_artifact_and_document(self) -> None:
        conn = connect_test_db()
        project_id = insert_project(conn)

        create_experiment_report(conn, test_settings(), payload(project_id, key="same-key", title="Initial"))
        updated = payload(project_id, key="same-key", title="Updated")
        updated["markdown"] = str(updated["markdown"]) + "\n\n## 下一步计划\n\n更新后的计划需要继续验证。"
        create_experiment_report(conn, test_settings(), updated)

        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM artifacts").fetchone()["count"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) AS count FROM knowledge_documents").fetchone()["count"], 1)
        artifact = conn.execute("SELECT * FROM artifacts").fetchone()
        self.assertEqual(artifact["title"], "Updated")
        self.assertIn("更新后的计划", artifact["content_markdown"])
        content = json.loads(artifact["content_json"])
        self.assertEqual(content["idempotency_key"], "same-key")

    def test_experiment_report_exports_to_obsidian_when_vault_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            conn = connect_test_db()
            project_id = insert_project(conn, output_dir="Projects/Experiment Project")

            result = create_experiment_report(conn, test_settings(vault=vault), payload(project_id, key="export-key"))

            self.assertEqual(result["obsidian"]["status"], "exported")
            export_path = Path(str(result["obsidian"]["path"]))
            target = vault / export_path
            self.assertTrue(target.exists())
            self.assertIn("实现实验报告接收", target.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
