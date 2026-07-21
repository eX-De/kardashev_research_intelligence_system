from __future__ import annotations

import unittest
from pathlib import Path
from threading import Lock
from time import sleep
from unittest.mock import patch

from helpers import connect_test_db
from worker.artifacts import upsert_artifact
from worker.cli import DAILY_STEPS, run_daily_job
from worker.config import LLMProvider, Settings
from worker.db import from_json, init_db
from worker.knowledge import save_manual_project_context
from worker.project_chat_profiles import (
    PROJECT_CHAT_PROFILE_ARTIFACT_TYPE,
    PROJECT_CHAT_PROFILE_VERSION,
    _generate_profiles,
    _profile_prompt,
    project_chat_profiles_for_paper,
    refresh_project_chat_profiles,
)
from worker.papers import promote_arxiv_paper_to_library
from worker.settings_store import apply_stored_settings, get_app_settings, save_app_settings


def test_settings() -> Settings:
    return Settings(
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


def profile_settings() -> Settings:
    base = test_settings()
    return Settings(
        **{
            **base.__dict__,
            "llm_providers": [
                LLMProvider(
                    id="profile-provider",
                    name="Profile Provider",
                    base_url="https://profile.test/v1",
                    api_key="profile-key",
                    chat_models=["profile-model"],
                    embedding_models=[],
                )
            ],
            "llm_chat_provider_id": "profile-provider",
            "llm_chat_model": "default-chat-model",
            "project_chat_profile_provider_id": "profile-provider",
            "project_chat_profile_model": "profile-model",
        }
    )


def profile_response(summary: str = "项目研究如何将研究上下文用于论文筛选和阅读决策。") -> dict[str, object]:
    return {
        "summary": summary,
        "goals": ["提高项目相关论文的筛选质量"],
        "current_approach": ["结合项目笔记与论文证据进行判断"],
        "constraints": ["只依据已有项目资料"],
        "current_findings": ["项目资料需要与论文阅读上下文保持同步"],
        "open_questions": ["如何控制项目上下文的 token 预算"],
        "keywords": ["project-aware retrieval", "research intelligence"],
    }


class ProjectChatProfileContractTests(unittest.TestCase):
    def test_prompt_requests_a_complete_self_contained_summary(self) -> None:
        prompt = _profile_prompt({"project": {"id": 1}, "context_documents": []})

        self.assertIn("完整、自包含", prompt)
        self.assertIn("800-1600 字", prompt)
        self.assertIn("最多 10 条", prompt)

    def test_profile_generation_honors_concurrency_without_sharing_database_work(self) -> None:
        lock = Lock()
        active = 0
        maximum_active = 0

        def fake_chat(*args, **kwargs):
            nonlocal active, maximum_active
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
            sleep(0.05)
            with lock:
                active -= 1
            return profile_response()

        pending = [
            {
                "project": {"id": index, "name": f"Project {index}"},
                "prompt_payload": {"project": {"id": index}, "context_documents": []},
            }
            for index in range(3)
        ]
        with patch("worker.project_chat_profiles.call_chat_json", side_effect=fake_chat):
            completed = _generate_profiles(
                profile_settings(),
                pending,
                "profile-provider",
                "profile-model",
                max_workers=2,
            )

        self.assertEqual(len(completed), 3)
        self.assertEqual(maximum_active, 2)
        self.assertTrue(all(profile is not None and error is None for _, profile, error in completed))


class ProjectChatProfileTests(unittest.TestCase):
    def _seed_project_context(self, conn) -> tuple[int, int]:
        conn.execute(
            """
            INSERT INTO research_projects(name, status, summary, goals, keywords_json, created_at, updated_at)
            VALUES ('Project A', 'active', '面向科研情报的项目感知阅读。', '提升筛选与解释质量', '["RAG"]', 'now', 'now')
            """
        )
        project_id = int(conn.execute("SELECT id FROM research_projects").fetchone()["id"])
        document = save_manual_project_context(
            conn,
            test_settings(),
            project_id,
            """
            # Project A context

            The project uses evidence-aware retrieval to decide whether a new paper
            can improve a research workflow. Current work compares project notes with
            methods and experiments reported in candidate papers.
            """,
        )
        return project_id, int(document["document_id"])

    def test_refresh_excludes_paused_and_archived_projects(self) -> None:
        conn = connect_test_db()
        init_db(conn)
        for name, status in (("Active", "active"), ("Paused", "paused"), ("Archived", "archived")):
            conn.execute(
                """
                INSERT INTO research_projects(name, status, created_at, updated_at)
                VALUES (?, ?, 'now', 'now')
                """,
                (name, status),
            )
        conn.commit()

        result = refresh_project_chat_profiles(conn, test_settings())

        self.assertEqual(result["project_chat_profiles_considered"], 1)
        self.assertEqual(result["project_chat_profiles_skipped"], 1)

    def test_refresh_is_incremental_and_uses_configured_model(self) -> None:
        conn = connect_test_db()
        init_db(conn)
        project_id, document_id = self._seed_project_context(conn)
        settings = profile_settings()

        with patch("worker.project_chat_profiles.call_chat_json", return_value=profile_response()) as call:
            first = refresh_project_chat_profiles(conn, settings)

        self.assertEqual(first["project_chat_profiles_created"], 1)
        self.assertEqual(first["project_chat_profiles_updated"], 0)
        self.assertEqual(call.call_args.kwargs["provider_id"], "profile-provider")
        self.assertEqual(call.call_args.kwargs["model"], "profile-model")
        artifact = conn.execute(
            """
            SELECT * FROM artifacts
            WHERE scope_type = 'project' AND scope_id = ? AND artifact_type = ?
            """,
            (project_id, PROJECT_CHAT_PROFILE_ARTIFACT_TYPE),
        ).fetchone()
        self.assertIsNotNone(artifact)
        self.assertEqual(artifact["model_provider_id"], "profile-provider")
        self.assertEqual(artifact["model"], "profile-model")
        self.assertIn("研究上下文", from_json(artifact["content_json"], {})["summary"])

        with patch("worker.project_chat_profiles.call_chat_json") as call:
            unchanged = refresh_project_chat_profiles(conn, settings)
        self.assertEqual(unchanged["project_chat_profiles_unchanged"], 1)
        call.assert_not_called()

        conn.execute(
            """
            UPDATE knowledge_documents
            SET raw_content = ?, content_hash = ?, updated_at = 'later'
            WHERE id = ?
            """,
            ("Updated context: prioritize reproducible evaluation evidence.", "updated-context-hash", document_id),
        )
        conn.commit()
        with patch(
            "worker.project_chat_profiles.call_chat_json",
            return_value=profile_response("项目目前优先验证可复现评估证据。"),
        ) as call:
            updated = refresh_project_chat_profiles(conn, settings)
        self.assertEqual(updated["project_chat_profiles_updated"], 1)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) AS count FROM artifacts WHERE scope_type = 'project' AND scope_id = ? AND artifact_type = ?",
                (project_id, PROJECT_CHAT_PROFILE_ARTIFACT_TYPE),
            ).fetchone()["count"],
            1,
        )

    def test_refresh_limits_parallel_model_requests_to_configured_concurrency(self) -> None:
        conn = connect_test_db()
        init_db(conn)
        for index in range(3):
            row = conn.execute(
                """
                INSERT INTO research_projects(name, status, summary, created_at, updated_at)
                VALUES (?, 'active', ?, 'now', 'now')
                RETURNING id
                """,
                (f"Concurrent Project {index}", f"Project material {index}"),
            ).fetchone()
            save_manual_project_context(
                conn,
                test_settings(),
                int(row["id"]),
                f"Context for concurrent project {index} with enough research detail.",
            )
        conn.commit()

        settings = Settings(**{**profile_settings().__dict__, "project_chat_profile_concurrency": 2})
        lock = Lock()
        active = 0
        maximum_active = 0

        def fake_chat(*args, **kwargs):
            nonlocal active, maximum_active
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
            sleep(0.05)
            with lock:
                active -= 1
            return profile_response()

        with patch("worker.project_chat_profiles.call_chat_json", side_effect=fake_chat) as call:
            result = refresh_project_chat_profiles(conn, settings)

        self.assertEqual(call.call_count, 3)
        self.assertEqual(maximum_active, 2)
        self.assertEqual(result["project_chat_profile_concurrency"], 2)
        self.assertEqual(result["project_chat_profiles_created"], 3)

    def test_one_profile_failure_does_not_fail_the_incremental_stage(self) -> None:
        conn = connect_test_db()
        init_db(conn)
        self._seed_project_context(conn)

        with patch("worker.project_chat_profiles.call_chat_json", side_effect=RuntimeError("provider unavailable")):
            result = refresh_project_chat_profiles(conn, profile_settings())

        self.assertEqual(result["project_chat_profiles_failed"], 1)
        self.assertEqual(result["project_chat_profiles_created"], 0)
        self.assertEqual(len(result["project_chat_profile_errors"]), 1)
        self.assertEqual(
            conn.execute(
                "SELECT COUNT(*) AS count FROM artifacts WHERE artifact_type = ?",
                (PROJECT_CHAT_PROFILE_ARTIFACT_TYPE,),
            ).fetchone()["count"],
            0,
        )

    def test_paper_profiles_include_linked_and_live_recommended_projects_only(self) -> None:
        conn = connect_test_db()
        init_db(conn)
        conn.execute(
            """
            INSERT INTO arxiv_papers(
              arxiv_id, title, authors_json, summary, categories_json, published_at,
              updated_at, link, pdf_link, fetched_batch_id, created_at
            )
            VALUES ('profile-paper', 'Profile Paper', '[]', '', '[]', 'now', 'now', '', '', 'test', 'now')
            """
        )
        legacy_paper_id = int(conn.execute("SELECT id FROM arxiv_papers").fetchone()["id"])
        paper_id = int(promote_arxiv_paper_to_library(conn, legacy_paper_id) or 0)
        project_ids: list[int] = []
        for index in range(4):
            conn.execute(
                """
                INSERT INTO research_projects(name, status, keywords_json, created_at, updated_at)
                VALUES (?, 'active', '[]', 'now', 'now')
                """,
                (f"Project {index}",),
            )
            project_id = int(conn.execute("SELECT MAX(id) AS id FROM research_projects").fetchone()["id"])
            project_ids.append(project_id)
            upsert_artifact(
                conn,
                scope_type="project",
                scope_id=project_id,
                artifact_type=PROJECT_CHAT_PROFILE_ARTIFACT_TYPE,
                title=f"Project {index} summary",
                content_markdown=f"# Project {index}\n\n完整摘要 {index}",
                source_json={"profile_version": PROJECT_CHAT_PROFILE_VERSION},
                source_key=f"project_chat_profile:{project_id}",
            )
        conn.execute(
            """
            INSERT INTO project_papers(project_id, paper_id, relation, note, created_at, updated_at)
            VALUES (?, ?, 'core', '', 'now', 'now'),
                   (?, ?, 'candidate', 'auto_matched_by_project_context', 'now', 'now')
            """,
            (project_ids[0], legacy_paper_id, project_ids[3], legacy_paper_id),
        )
        conn.execute(
            """
            INSERT INTO project_paper_recommendations(
              project_id, paper_id, state, importance, relation_type, reason,
              obsidian_path, attachment_path, source_judgment_hash, created_at, updated_at
            )
            VALUES (?, ?, 'pending', 'medium', 'direct', '', '', '', '', 'now', 'now'),
                   (?, ?, 'discarded', 'medium', 'direct', '', '', '', '', 'now', 'now')
            """,
            (project_ids[1], legacy_paper_id, project_ids[2], legacy_paper_id),
        )
        conn.commit()

        profiles = project_chat_profiles_for_paper(conn, paper_id)

        self.assertEqual({profile["project_id"] for profile in profiles}, {project_ids[0], project_ids[1]})
        self.assertTrue(all("完整摘要" in str(profile["content_markdown"]) for profile in profiles))

        conn.execute(
            "DELETE FROM project_papers WHERE project_id = ? AND paper_id = ?",
            (project_ids[0], legacy_paper_id),
        )
        conn.commit()

        profiles = project_chat_profiles_for_paper(conn, paper_id)
        self.assertEqual({profile["project_id"] for profile in profiles}, {project_ids[1]})

        conn.execute(
            "UPDATE project_paper_recommendations SET state = 'discarded' WHERE paper_id = ?",
            (legacy_paper_id,),
        )
        conn.commit()

        self.assertEqual(project_chat_profiles_for_paper(conn, paper_id), [])

    def test_profile_model_settings_round_trip_to_worker(self) -> None:
        conn = connect_test_db()
        init_db(conn)
        save_app_settings(
            conn,
            {
                "project_chat_profile_provider_id": "profile-provider",
                "project_chat_profile_model": "profile-model",
                "project_chat_profile_concurrency": 3,
            },
        )

        applied = apply_stored_settings(conn, test_settings())
        payload = get_app_settings(conn, applied)["settings"]

        self.assertEqual(applied.project_chat_profile_provider_id, "profile-provider")
        self.assertEqual(applied.project_chat_profile_model, "profile-model")
        self.assertEqual(applied.project_chat_profile_concurrency, 3)
        self.assertEqual(payload["project_chat_profile_provider_id"], "profile-provider")
        self.assertEqual(payload["project_chat_profile_model"], "profile-model")
        self.assertEqual(payload["project_chat_profile_concurrency"], 3)

    def test_daily_pipeline_runs_profile_stage_after_context_sync(self) -> None:
        self.assertEqual(
            [key for key, _ in DAILY_STEPS][:2],
            ["sync_context_sources", "refresh_project_chat_profiles"],
        )
        conn = connect_test_db()
        init_db(conn)
        settings = test_settings()
        profile_result = {"project_chat_profiles_considered": 0, "project_chat_profiles_created": 0}

        with (
            patch("worker.cli.sync_context_sources", return_value={}),
            patch("worker.cli.refresh_project_chat_profiles", return_value=profile_result) as refresh,
            patch("worker.cli._retry_papers_for_run", return_value=([], {}, {})),
            patch("worker.cli.cache_arxiv_full_texts", return_value={}),
            patch("worker.cli.rank_unmatched_papers", return_value={}),
            patch("worker.cli.rank_project_papers", return_value={}),
            patch("worker.cli.generate_missing_project_judgments", return_value={}),
            patch("worker.cli.sync_project_paper_recommendations", return_value={}),
            patch("worker.cli.ensure_paper_reports_for_recommendations", return_value={}),
            patch("worker.cli._archive_daily_filtered_papers", return_value={}),
            patch("worker.cli.generate_daily_report", return_value={}),
        ):
            run_daily_job(conn, settings, requested_mode="retry-daily")

        refresh.assert_called_once_with(conn, settings)
        row = conn.execute(
            """
            SELECT status FROM daily_run_steps
            WHERE step_key = 'refresh_project_chat_profiles'
            ORDER BY job_id DESC
            LIMIT 1
            """
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["status"], "completed")


if __name__ == "__main__":
    unittest.main()
