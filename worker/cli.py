from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import Any, Callable

from .api import (
    export_project_to_obsidian,
    generate_paper_reading_report,
    health,
    inbox,
    job_history,
    link_project_note,
    link_project_paper,
    paper_detail,
    paper_reports_queue,
    project_detail,
    projects,
    reminders,
    save_feedback,
    save_project,
    update_paper_recommendation,
    unlink_project_note,
    unlink_project_paper,
)
from .arxiv_archive import archive_zero_match_papers
from .arxiv_client import fetch_arxiv
from .arxiv_text import cache_arxiv_full_texts
from .config import load_settings
from .db import clean_unicode, connect, init_db, job_run, update_job_meta, utc_now
from .llm import generate_missing_project_judgments
from .obsidian import sync_obsidian
from .paper_reports import ensure_paper_reports_for_recommendations, process_paper_report_queue
from .recommendations import sync_project_paper_recommendations
from .reports import generate_daily_report
from .search import prefilter_papers, rank_project_papers, rank_unmatched_papers
from .settings_store import apply_stored_settings, get_app_settings, save_app_settings


def _print_json(payload: dict[str, object]) -> None:
    data = json.dumps(clean_unicode(payload), ensure_ascii=False)
    sys.stdout.buffer.write(data.encode("utf-8", "replace") + b"\n")


def _read_json_stdin(context: str) -> dict[str, object]:
    raw = sys.stdin.buffer.read()
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON {context} payload: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise RuntimeError(f"Invalid UTF-8 {context} payload: {exc}") from exc


def _with_db(handler: Callable):
    settings = load_settings()
    conn = connect(settings.db_path)
    init_db(conn)
    settings = apply_stored_settings(conn, settings)
    try:
        return handler(conn, settings)
    finally:
        conn.close()


DAILY_STEPS = [
    ("sync_obsidian", "同步 Obsidian"),
    ("fetch_arxiv", "抓取 arXiv"),
    ("prefilter", "摘要粗筛"),
    ("cache_text", "缓存 PDF/TXT"),
    ("rank_global", "全局论文匹配"),
    ("rank_project", "项目论文匹配"),
    ("judge_project_papers", "项目级判定"),
    ("paper_recommendations", "生成论文推荐"),
    ("paper_reports", "生成全文报告"),
    ("archive_zero_match", "归档未通过论文"),
    ("reports", "生成每日总报告"),
]
DAILY_RETRY_PAPER_LIMIT = 50


def _daily_progress(
    steps: list[dict[str, Any]],
    index: int,
    status: str,
) -> dict[str, Any]:
    current = steps[index] if 0 <= index < len(steps) else steps[-1]
    completed = sum(1 for step in steps if step["status"] == "completed")
    return {
        "status": status,
        "total": len(steps),
        "current": min(index + 1, len(steps)),
        "completed": completed,
        "current_key": current["key"],
        "current_label": current["label"],
        "steps": steps,
    }


def _step_summary(result: dict[str, Any]) -> str:
    priority = [
        ("notes_indexed", "notes"),
        ("projects_synced", "projects"),
        ("papers_inserted", "new papers"),
        ("prefilter_passed", "passed"),
        ("prefilter_skipped", "skipped"),
        ("texts_extracted", "texts"),
        ("matched_papers", "matched papers"),
        ("project_paper_matches_created", "project matches"),
        ("zero_match_papers_archived", "zero-match archived"),
        ("project_judgments_created", "project judgments"),
        ("project_judgments_filtered", "filtered by judgments"),
        ("paper_recommendations_created", "paper recommendations"),
        ("paper_recommendations_refreshed", "recommendations refreshed"),
        ("paper_reports_queued", "paper reports queued"),
        ("paper_reports_done", "full reports"),
        ("paper_reports_failed", "report failures"),
        ("reports_created", "daily reports"),
        ("reports_failed", "report failures"),
    ]
    parts = []
    for key, label in priority:
        value = int(result.get(key) or 0)
        if value:
            parts.append(f"{value} {label}")
    return ", ".join(parts[:3]) or "completed"


def _update_daily_progress(
    conn,
    job_id: int,
    steps: list[dict[str, Any]],
    index: int,
    status: str,
    accumulated: dict[str, Any],
    extra: dict[str, Any] | None = None,
) -> None:
    progress = _daily_progress(steps, index, status)
    if extra:
        progress.update(clean_unicode(extra))
    message = f"Daily run {progress['current']}/{progress['total']} · {progress['current_label']}"
    if status == "completed":
        message = "Daily run completed"
    elif status == "failed":
        message = f"Daily run failed at {progress['current_label']}"
    update_job_meta(conn, job_id, message, {**accumulated, "daily_progress": progress})


def _run_daily_step(
    conn,
    job_id: int,
    steps: list[dict[str, Any]],
    index: int,
    accumulated: dict[str, Any],
    handler: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    step = steps[index]
    step["status"] = "running"
    step["started_at"] = utc_now()
    _update_daily_progress(conn, job_id, steps, index, "running", accumulated)
    try:
        result = handler()
    except Exception as exc:
        step["status"] = "failed"
        step["error"] = str(exc)
        step["finished_at"] = utc_now()
        _update_daily_progress(conn, job_id, steps, index, "failed", accumulated)
        raise
    step["status"] = "completed"
    step["finished_at"] = utc_now()
    step["summary"] = _step_summary(result)
    _update_daily_progress(conn, job_id, steps, index, "running", accumulated)
    return result


def _cache_text_progress_callback(
    conn,
    job_id: int,
    steps: list[dict[str, Any]],
    accumulated: dict[str, Any],
) -> Callable[[dict[str, Any]], None]:
    def callback(progress: dict[str, Any]) -> None:
        _update_daily_progress(
            conn,
            job_id,
            steps,
            3,
            "running",
            accumulated,
            {"cache_text_progress": progress},
        )

    return callback


def _daily_papers_for_run(conn, settings, batch_id: str) -> tuple[list[Any], dict[str, int]]:
    new_papers = conn.execute(
        """
        SELECT *
        FROM arxiv_papers p
        WHERE fetched_batch_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM arxiv_paper_tombstones t
            WHERE t.arxiv_id = p.arxiv_id
          )
        ORDER BY published_at DESC
        """,
        (batch_id,),
    ).fetchall()

    retry_limit = min(max(0, settings.arxiv_max_results), DAILY_RETRY_PAPER_LIMIT)
    retry_papers: list[Any] = []
    retry_seen_ids: set[int] = {int(paper["id"]) for paper in new_papers}
    retry_counts = {
        "daily_retry_text_papers": 0,
        "daily_retry_global_match_papers": 0,
        "daily_retry_project_match_papers": 0,
        "daily_retry_judgment_papers": 0,
    }

    def add_retry_papers(rows: list[Any], count_key: str) -> None:
        for row in rows:
            if len(retry_papers) >= retry_limit:
                return
            paper_id = int(row["id"])
            if paper_id in retry_seen_ids:
                continue
            retry_seen_ids.add(paper_id)
            retry_papers.append(row)
            retry_counts[count_key] += 1

    retry_conditions = ["c.id IS NULL"]
    if settings.arxiv_cache_full_text:
        retry_conditions.append("(p.text_status != 'complete' OR p.text_path = '')")
    if retry_limit:
        add_retry_papers(conn.execute(
            f"""
            SELECT DISTINCT p.*
            FROM arxiv_papers p
            LEFT JOIN arxiv_text_chunks c ON c.paper_id = p.id
            WHERE p.fetched_batch_id != ?
              AND NOT EXISTS (
                SELECT 1 FROM arxiv_paper_tombstones t
                WHERE t.arxiv_id = p.arxiv_id
              )
              AND ({" OR ".join(retry_conditions)})
            ORDER BY p.published_at DESC
            LIMIT ?
            """,
            (batch_id, retry_limit),
        ).fetchall(), "daily_retry_text_papers")
        add_retry_papers(conn.execute(
            """
            SELECT DISTINCT p.*
            FROM arxiv_papers p
            JOIN arxiv_text_chunks c ON c.paper_id = p.id
            LEFT JOIN matches m ON m.paper_id = p.id AND m.arxiv_chunk_id IS NOT NULL
            WHERE p.fetched_batch_id != ?
              AND NOT EXISTS (
                SELECT 1 FROM arxiv_paper_tombstones t
                WHERE t.arxiv_id = p.arxiv_id
              )
              AND m.id IS NULL
            ORDER BY p.published_at DESC
            LIMIT ?
            """,
            (batch_id, retry_limit),
        ).fetchall(), "daily_retry_global_match_papers")
        add_retry_papers(conn.execute(
            """
            SELECT DISTINCT p.*
            FROM arxiv_papers p
            JOIN arxiv_text_chunks c ON c.paper_id = p.id
            WHERE p.fetched_batch_id != ?
              AND NOT EXISTS (
                SELECT 1 FROM arxiv_paper_tombstones t
                WHERE t.arxiv_id = p.arxiv_id
              )
              AND EXISTS (
                SELECT 1
                FROM project_notes pn
                JOIN research_chunks rc ON rc.note_id = pn.note_id
                LIMIT 1
              )
              AND NOT EXISTS (
                SELECT 1 FROM project_paper_matches ppm
                WHERE ppm.paper_id = p.id
              )
            ORDER BY p.published_at DESC
            LIMIT ?
            """,
            (batch_id, retry_limit),
        ).fetchall(), "daily_retry_project_match_papers")
        add_retry_papers(conn.execute(
            """
                SELECT DISTINCT p.*
                FROM arxiv_papers p
                JOIN project_paper_matches ppm ON ppm.paper_id = p.id
                LEFT JOIN project_paper_judgments j
                  ON j.project_id = ppm.project_id AND j.paper_id = ppm.paper_id
                WHERE p.fetched_batch_id != ?
                  AND NOT EXISTS (
                    SELECT 1 FROM arxiv_paper_tombstones t
                    WHERE t.arxiv_id = p.arxiv_id
                  )
                  AND j.paper_id IS NULL
                ORDER BY p.published_at DESC
                LIMIT ?
                """,
            (batch_id, retry_limit),
        ).fetchall(), "daily_retry_judgment_papers")

    seen_ids: set[int] = set()
    papers: list[Any] = []
    for paper in [*new_papers, *retry_papers]:
        paper_id = int(paper["id"])
        if paper_id in seen_ids:
            continue
        seen_ids.add(paper_id)
        papers.append(paper)

    return papers, {
        "daily_new_papers": len(new_papers),
        "daily_retry_papers": len(retry_papers),
        "daily_candidate_papers": len(papers),
        **retry_counts,
    }


def _prefilter_daily_papers(conn, settings, batch_id: str, selected_papers: list[Any]) -> dict[str, int]:
    papers, candidate_result = _daily_papers_for_run(conn, settings, batch_id)
    new_papers = [paper for paper in papers if str(paper["fetched_batch_id"]) == batch_id]
    resume_papers = [paper for paper in papers if str(paper["fetched_batch_id"]) != batch_id]
    papers, result = prefilter_papers(conn, settings, new_papers)
    selected_papers[:] = [*papers, *resume_papers]
    result = {
        **result,
        "prefilter_passed": int(result.get("prefilter_passed") or 0) + len(resume_papers),
        "prefilter_resume_bypassed": len(resume_papers),
    }
    return {**candidate_result, **result}


def cmd_init_db(_: argparse.Namespace) -> None:
    settings = load_settings()
    conn = connect(settings.db_path)
    init_db(conn)
    conn.close()
    _print_json({"ok": True, "message": f"Initialized {settings.db_path}"})


def cmd_sync_obsidian(_: argparse.Namespace) -> None:
    def run(conn, settings):
        with job_run(conn, "sync-obsidian") as job_id:
            result = sync_obsidian(conn, settings)
            update_job_meta(conn, job_id, "Obsidian sync completed", result)
        return result

    result = _with_db(run)
    _print_json({"ok": True, "message": "Obsidian sync completed", **result})


def cmd_fetch_arxiv(_: argparse.Namespace) -> None:
    def run(conn, settings):
        with job_run(conn, "fetch-arxiv") as job_id:
            result = fetch_arxiv(conn, settings)
            selected_papers: list[Any] = []
            prefilter_result = _prefilter_daily_papers(
                conn,
                settings,
                str(result.get("batch_id") or ""),
                selected_papers,
            )
            result.update(prefilter_result)
            result.update(
                {
                    f"text_{key}": value
                    for key, value in cache_arxiv_full_texts(
                        conn,
                        settings,
                        paper_ids=[int(paper["id"]) for paper in selected_papers],
                    ).items()
                }
            )
            update_job_meta(conn, job_id, "arXiv fetch and filtered text cache completed", result)
        return result

    result = _with_db(run)
    _print_json({"ok": True, "message": "arXiv fetch and filtered text cache completed", **result})


def cmd_cache_arxiv_text(_: argparse.Namespace) -> None:
    def run(conn, settings):
        with job_run(conn, "cache-arxiv-text") as job_id:
            result = cache_arxiv_full_texts(conn, settings)
            update_job_meta(conn, job_id, "arXiv PDF text cache completed", result)
        return result

    result = _with_db(run)
    _print_json({"ok": True, "message": "arXiv PDF text cache completed", **result})


def cmd_rank(_: argparse.Namespace) -> None:
    def run(conn, settings):
        with job_run(conn, "rank-papers") as job_id:
            result = rank_unmatched_papers(conn, settings)
            result.update(rank_project_papers(conn, settings))
            result.update(generate_missing_project_judgments(conn, settings))
            result.update(sync_project_paper_recommendations(conn))
            result.update(ensure_paper_reports_for_recommendations(conn))
            result.update(process_paper_report_queue(conn, settings))
            update_job_meta(conn, job_id, "Ranking completed", result)
        return result

    result = _with_db(run)
    _print_json({"ok": True, "message": "Ranking completed", **result})


def cmd_generate_reports(_: argparse.Namespace) -> None:
    def run(conn, settings):
        with job_run(conn, "generate-reports") as job_id:
            result = generate_daily_report(conn, settings)
            update_job_meta(conn, job_id, "Daily research report generated", result)
        return result

    result = _with_db(run)
    _print_json({"ok": True, "message": "Daily research report generated", **result})


def cmd_generate_paper_reports(args: argparse.Namespace) -> None:
    limit = int(args.limit) if str(args.limit or "").strip() else None

    def run(conn, settings):
        with job_run(conn, "generate-paper-reports") as job_id:
            result = ensure_paper_reports_for_recommendations(conn)
            result.update(process_paper_report_queue(conn, settings, limit=limit))
            update_job_meta(conn, job_id, "Full paper reports generated", result)
        return result

    result = _with_db(run)
    _print_json({"ok": True, "message": "Full paper reports generated", **result})


def cmd_run_daily(_: argparse.Namespace) -> None:
    def run(conn, settings):
        with job_run(conn, "run-daily") as job_id:
            steps = [
                {"key": key, "label": label, "status": "pending"}
                for key, label in DAILY_STEPS
            ]
            accumulated: dict[str, Any] = {}
            _update_daily_progress(conn, job_id, steps, 0, "running", accumulated)

            sync_result = _run_daily_step(
                conn,
                job_id,
                steps,
                0,
                accumulated,
                lambda: sync_obsidian(conn, settings),
            )
            accumulated.update({f"sync_{key}": value for key, value in sync_result.items()})

            arxiv_result = _run_daily_step(
                conn,
                job_id,
                steps,
                1,
                accumulated,
                lambda: fetch_arxiv(conn, settings),
            )
            accumulated.update({f"arxiv_{key}": value for key, value in arxiv_result.items()})

            selected_papers: list[Any] = []
            prefilter_result = _run_daily_step(
                conn,
                job_id,
                steps,
                2,
                accumulated,
                lambda: _prefilter_daily_papers(
                    conn,
                    settings,
                    str(arxiv_result.get("batch_id") or ""),
                    selected_papers,
                ),
            )
            accumulated.update(prefilter_result)
            selected_paper_ids = [int(paper["id"]) for paper in selected_papers]

            text_result = _run_daily_step(
                conn,
                job_id,
                steps,
                3,
                accumulated,
                lambda: cache_arxiv_full_texts(
                    conn,
                    settings,
                    paper_ids=selected_paper_ids,
                    progress_callback=_cache_text_progress_callback(
                        conn,
                        job_id,
                        steps,
                        accumulated,
                    ),
                ),
            )
            accumulated.update({f"text_{key}": value for key, value in text_result.items()})

            rank_result = _run_daily_step(
                conn,
                job_id,
                steps,
                4,
                accumulated,
                lambda: rank_unmatched_papers(
                    conn,
                    settings,
                    papers=selected_papers,
                    prefilter_result=prefilter_result,
                ),
            )
            accumulated.update(rank_result)

            project_rank_result = _run_daily_step(
                conn,
                job_id,
                steps,
                5,
                accumulated,
                lambda: rank_project_papers(conn, settings, papers=selected_papers),
            )
            accumulated.update(project_rank_result)

            explain_result = _run_daily_step(
                conn,
                job_id,
                steps,
                6,
                accumulated,
                lambda: generate_missing_project_judgments(
                    conn,
                    settings,
                    paper_ids=selected_paper_ids,
                ),
            )
            accumulated.update(explain_result)

            recommendation_result = _run_daily_step(
                conn,
                job_id,
                steps,
                7,
                accumulated,
                lambda: sync_project_paper_recommendations(conn, selected_paper_ids),
            )
            accumulated.update(recommendation_result)

            paper_report_result = _run_daily_step(
                conn,
                job_id,
                steps,
                8,
                accumulated,
                lambda: {
                    **ensure_paper_reports_for_recommendations(conn, selected_paper_ids),
                    **process_paper_report_queue(conn, settings, selected_paper_ids),
                },
            )
            accumulated.update(paper_report_result)

            archive_result = _run_daily_step(
                conn,
                job_id,
                steps,
                9,
                accumulated,
                lambda: archive_zero_match_papers(conn, settings, selected_paper_ids),
            )
            accumulated.update(archive_result)

            report_result = _run_daily_step(
                conn,
                job_id,
                steps,
                10,
                accumulated,
                lambda: generate_daily_report(
                    conn,
                    settings,
                    stats=accumulated,
                    paper_ids=selected_paper_ids,
                ),
            )
            accumulated.update(report_result)

            result = {
                **accumulated,
                "daily_progress": _daily_progress(steps, len(steps) - 1, "completed"),
            }
            update_job_meta(conn, job_id, "Daily run completed", result)
        return result

    result = _with_db(run)
    _print_json({"ok": True, "message": "Daily run completed", **result})


def cmd_api_inbox(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: inbox(conn))
    _print_json(result)


def cmd_api_paper(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: paper_detail(conn, int(args.paper_id)))
    _print_json(result)


def cmd_api_feedback(args: argparse.Namespace) -> None:
    result = _with_db(
        lambda conn, settings: save_feedback(conn, int(args.paper_id), args.status, args.note)
    )
    _print_json(result)


def cmd_api_paper_recommendation(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("paper recommendation")
    result = _with_db(
        lambda conn, settings: update_paper_recommendation(conn, settings, int(args.paper_id), payload)
    )
    _print_json(result)


def cmd_api_paper_report(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("paper report")
    result = _with_db(
        lambda conn, settings: generate_paper_reading_report(conn, settings, int(args.paper_id), payload)
    )
    _print_json(result)


def cmd_api_paper_reports(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: paper_reports_queue(conn, int(args.limit)))
    _print_json(result)


def cmd_api_projects(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: projects(conn))
    _print_json(result)


def cmd_api_project(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: project_detail(conn, int(args.project_id)))
    _print_json(result)


def cmd_api_project_save(_: argparse.Namespace) -> None:
    payload = _read_json_stdin("project")
    result = _with_db(lambda conn, settings: save_project(conn, payload, settings))
    _print_json(result)


def cmd_api_project_export(args: argparse.Namespace) -> None:
    result = _with_db(
        lambda conn, settings: export_project_to_obsidian(conn, settings, int(args.project_id))
    )
    _print_json(result)


def cmd_api_project_link_paper(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("project paper")
    result = _with_db(lambda conn, settings: link_project_paper(conn, int(args.project_id), payload))
    _print_json(result)


def cmd_api_project_unlink_paper(args: argparse.Namespace) -> None:
    result = _with_db(
        lambda conn, settings: unlink_project_paper(conn, int(args.project_id), int(args.paper_id))
    )
    _print_json(result)


def cmd_api_project_link_note(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("project note")
    result = _with_db(lambda conn, settings: link_project_note(conn, int(args.project_id), payload))
    _print_json(result)


def cmd_api_project_unlink_note(args: argparse.Namespace) -> None:
    result = _with_db(
        lambda conn, settings: unlink_project_note(conn, int(args.project_id), int(args.note_id))
    )
    _print_json(result)


def cmd_api_settings(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: get_app_settings(conn, settings))
    _print_json(result)


def cmd_api_settings_save(_: argparse.Namespace) -> None:
    payload = _read_json_stdin("settings")

    def run(conn, settings):
        save_app_settings(conn, payload)
        updated_settings = apply_stored_settings(conn, settings)
        return get_app_settings(conn, updated_settings)

    result = _with_db(run)
    _print_json(result)


def cmd_api_health(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: health(conn, settings))
    _print_json(result)


def cmd_api_jobs_history(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: job_history(conn, int(args.limit)))
    _print_json(result)


def cmd_api_reminders(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: reminders(conn, int(args.limit)))
    _print_json(result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="research-intelligence-worker")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init-db")
    init.set_defaults(func=cmd_init_db)

    sync = sub.add_parser("sync-obsidian")
    sync.set_defaults(func=cmd_sync_obsidian)

    fetch = sub.add_parser("fetch-arxiv")
    fetch.set_defaults(func=cmd_fetch_arxiv)

    cache_text = sub.add_parser("cache-arxiv-text")
    cache_text.set_defaults(func=cmd_cache_arxiv_text)

    rank = sub.add_parser("rank-papers")
    rank.set_defaults(func=cmd_rank)

    reports = sub.add_parser("generate-reports")
    reports.set_defaults(func=cmd_generate_reports)

    paper_reports = sub.add_parser("generate-paper-reports")
    paper_reports.add_argument("--limit", default="")
    paper_reports.set_defaults(func=cmd_generate_paper_reports)

    daily = sub.add_parser("run-daily")
    daily.set_defaults(func=cmd_run_daily)

    api_inbox = sub.add_parser("api-inbox")
    api_inbox.set_defaults(func=cmd_api_inbox)

    api_paper = sub.add_parser("api-paper")
    api_paper.add_argument("paper_id")
    api_paper.set_defaults(func=cmd_api_paper)

    api_feedback = sub.add_parser("api-feedback")
    api_feedback.add_argument("paper_id")
    api_feedback.add_argument("--status", required=True)
    api_feedback.add_argument("--note", default="")
    api_feedback.set_defaults(func=cmd_api_feedback)

    api_paper_recommendation = sub.add_parser("api-paper-recommendation")
    api_paper_recommendation.add_argument("paper_id")
    api_paper_recommendation.set_defaults(func=cmd_api_paper_recommendation)

    api_paper_report = sub.add_parser("api-paper-report")
    api_paper_report.add_argument("paper_id")
    api_paper_report.set_defaults(func=cmd_api_paper_report)

    api_paper_reports = sub.add_parser("api-paper-reports")
    api_paper_reports.add_argument("--limit", default="300")
    api_paper_reports.set_defaults(func=cmd_api_paper_reports)

    api_projects = sub.add_parser("api-projects")
    api_projects.set_defaults(func=cmd_api_projects)

    api_project = sub.add_parser("api-project")
    api_project.add_argument("project_id")
    api_project.set_defaults(func=cmd_api_project)

    api_project_save = sub.add_parser("api-project-save")
    api_project_save.set_defaults(func=cmd_api_project_save)

    api_project_export = sub.add_parser("api-project-export")
    api_project_export.add_argument("project_id")
    api_project_export.set_defaults(func=cmd_api_project_export)

    api_project_link_paper = sub.add_parser("api-project-link-paper")
    api_project_link_paper.add_argument("project_id")
    api_project_link_paper.set_defaults(func=cmd_api_project_link_paper)

    api_project_unlink_paper = sub.add_parser("api-project-unlink-paper")
    api_project_unlink_paper.add_argument("project_id")
    api_project_unlink_paper.add_argument("paper_id")
    api_project_unlink_paper.set_defaults(func=cmd_api_project_unlink_paper)

    api_project_link_note = sub.add_parser("api-project-link-note")
    api_project_link_note.add_argument("project_id")
    api_project_link_note.set_defaults(func=cmd_api_project_link_note)

    api_project_unlink_note = sub.add_parser("api-project-unlink-note")
    api_project_unlink_note.add_argument("project_id")
    api_project_unlink_note.add_argument("note_id")
    api_project_unlink_note.set_defaults(func=cmd_api_project_unlink_note)

    api_settings = sub.add_parser("api-settings")
    api_settings.set_defaults(func=cmd_api_settings)

    api_settings_save = sub.add_parser("api-settings-save")
    api_settings_save.set_defaults(func=cmd_api_settings_save)

    api_health = sub.add_parser("api-health")
    api_health.set_defaults(func=cmd_api_health)

    api_jobs_history = sub.add_parser("api-jobs-history")
    api_jobs_history.add_argument("--limit", default="20")
    api_jobs_history.set_defaults(func=cmd_api_jobs_history)

    api_reminders = sub.add_parser("api-reminders")
    api_reminders.add_argument("--limit", default="5")
    api_reminders.set_defaults(func=cmd_api_reminders)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        _print_json({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
