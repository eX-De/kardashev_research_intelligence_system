from __future__ import annotations

import argparse
import hashlib
import json
import os
from .db_types import DbConnection, DbRow
import sys
import time
import traceback
from dataclasses import replace
from typing import Any, Callable

from .api import (
    artifact_detail,
    artifacts_index,
    export_artifact,
    export_project_to_obsidian,
    generate_paper_reading_report,
    generate_project_index,
    health,
    health_summary,
    inbox,
    job_summary,
    job_history,
    library_paper_detail,
    link_project_note,
    link_project_paper,
    paper_detail,
    paper_library,
    remove_paper_report,
    paper_reports_queue,
    paper_reports_summary,
    project_detail,
    projects,
    receive_experiment_report,
    notifications,
    save_feedback,
    save_project,
    update_library_paper_status,
    update_paper_recommendation,
    unlink_project_note,
    unlink_project_paper,
)
from .arxiv_archive import archive_zero_match_papers
from .arxiv_client import ARXIV_RATE_LIMITED, ArxivRateLimitError, fetch_arxiv
from .arxiv_text import cache_arxiv_full_texts
from .config import load_settings
from .db import (
    clean_unicode,
    connect,
    database_target,
    from_json,
    init_db,
    job_run,
    mark_stale_job_runs,
    to_json,
    update_job_meta,
    utc_now,
)
from .llm import generate_missing_project_judgments
from .knowledge import sync_project_context_documents_from_project_notes
from .obsidian import OBSIDIAN_NOT_CONFIGURED, ObsidianNotConfiguredError, sync_obsidian
from .obsidian_remote import obsidian_remote_enabled
from .paper_reports import ensure_paper_reports_for_recommendations, process_paper_report_queue
from .project_status import run_daily_project_status_sql
from .paper_reader import (
    cancel_reader_report,
    delete_reader_message,
    generate_reader_followup_questions,
    import_reader_pdfs,
    import_reader_urls,
    paper_reader_chat,
    paper_reader_chat_stream,
    paper_reader_detail,
    retry_reader_report,
    save_reader_note_to_obsidian,
)
from .recommendations import sync_project_paper_recommendations
from .reports import generate_daily_report
from .search import prefilter_papers, rank_project_papers, rank_unmatched_papers
from .settings_store import apply_stored_settings, get_app_settings, save_app_settings
from .update_check import check_for_updates, read_update_status, update_notification


def _print_json(payload: dict[str, object]) -> None:
    data = json.dumps(clean_unicode(payload), ensure_ascii=False)
    sys.stdout.buffer.write(data.encode("utf-8", "replace") + b"\n")


WORKER_PROGRESS_EVENT_PREFIX = "KRIS_PROGRESS_EVENT "


def _progress_events_enabled() -> bool:
    return os.environ.get("KRIS_WORKER_PROGRESS_EVENTS") == "1"


def _emit_worker_progress_event(event: str, data: dict[str, Any]) -> None:
    if not _progress_events_enabled():
        return
    payload = json.dumps(
        clean_unicode({"event": event, "data": data}),
        ensure_ascii=False,
    )
    sys.stderr.buffer.write(
        f"{WORKER_PROGRESS_EVENT_PREFIX}{payload}\n".encode("utf-8", "replace")
    )
    sys.stderr.buffer.flush()


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


def _with_db(handler: Callable, cleanup_stale: bool = True):
    settings = load_settings()
    conn = connect()
    init_db(conn)
    if cleanup_stale:
        mark_stale_job_runs(conn)
    settings = apply_stored_settings(conn, settings)
    try:
        return handler(conn, settings)
    finally:
        conn.close()


def _is_postgres_deadlock(exc: Exception) -> bool:
    sqlstate = str(getattr(exc, "sqlstate", "") or "")
    if sqlstate == "40P01":
        return True
    name = exc.__class__.__name__.lower()
    text = str(exc).lower()
    return "deadlock" in name or "deadlock" in text or "死锁" in text


def _with_deadlock_retry(conn, handler: Callable[[], dict[str, int]], *, attempts: int = 3) -> dict[str, int]:
    for attempt in range(1, attempts + 1):
        try:
            return handler()
        except Exception as exc:
            if attempt >= attempts or not _is_postgres_deadlock(exc):
                raise
            try:
                conn.rollback()
            except Exception:
                pass
            time.sleep(0.4 * attempt)
    return handler()


DAILY_STEPS = [
    ("sync_context_sources", "同步上下文来源"),
    ("fetch_arxiv", "抓取 arXiv"),
    ("snapshot", "生成论文快照"),
    ("cache_text", "缓存 PDF/TXT"),
    ("rank_global", "全局论文匹配"),
    ("rank_project", "项目论文匹配"),
    ("judge_project_papers", "项目级判定"),
    ("paper_recommendations", "生成论文推荐"),
    ("paper_reports", "全文报告入队"),
    ("archive_zero_match", "归档未通过论文"),
    ("generate_daily_report_artifact", "生成日报产物"),
]
DAILY_JOB_TYPES = ("run-daily", "resume-daily", "retry-daily")
DAILY_STAGE_COLUMNS = (
    "text_status",
    "embedding_status",
    "global_match_status",
    "project_match_status",
    "judgment_status",
    "recommendation_status",
    "report_status",
    "archive_status",
)
STEP_STAGE_COLUMNS = {
    "cache_text": ("text_status", "embedding_status"),
    "rank_global": ("global_match_status",),
    "rank_project": ("project_match_status",),
    "judge_project_papers": ("judgment_status",),
    "paper_recommendations": ("recommendation_status",),
    "paper_reports": ("report_status",),
    "archive_zero_match": ("archive_status",),
}


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
    _emit_worker_progress_event(
        "daily_run_progress.updated",
        {
            "job_id": job_id,
            "job_type": str(accumulated.get("daily_mode") or "run-daily"),
            "status": progress.get("status"),
            "current": progress.get("current"),
            "total": progress.get("total"),
            "completed": progress.get("completed"),
            "current_key": progress.get("current_key"),
            "current_label": progress.get("current_label"),
            "updated_at": utc_now(),
        },
    )


def _daily_step_error_payload(exc: Exception) -> dict[str, Any] | None:
    if isinstance(exc, ArxivRateLimitError):
        payload = exc.to_payload()
        return {
            "type": ARXIV_RATE_LIMITED,
            "title": str(payload.get("title") or "arXiv 暂时限流"),
            "message": str(payload.get("error") or str(exc)),
            "detail": str(payload.get("detail") or ""),
            "suggested_action": str(payload.get("suggested_action") or ""),
            "retry_after_seconds": payload.get("retry_after_seconds"),
            "attempts": payload.get("attempts"),
            "status_code": payload.get("status_code"),
            "technical_message": str(payload.get("technical_message") or ""),
        }
    return None


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
    _record_daily_step(conn, job_id, step["key"], "running")
    _mark_snapshot_stage_pending(conn, job_id, step["key"])
    _update_daily_progress(conn, job_id, steps, index, "running", accumulated)
    try:
        result = handler()
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        error_payload = _daily_step_error_payload(exc)
        display_error = (error_payload or {}).get("message") or str(exc)
        step["status"] = "failed"
        step["error"] = display_error
        if error_payload:
            step["error_type"] = error_payload["type"]
            step["suggested_action"] = error_payload.get("suggested_action", "")
        step["finished_at"] = utc_now()
        try:
            _record_daily_step(
                conn,
                job_id,
                step["key"],
                "failed",
                error=display_error,
                meta={"error": error_payload} if error_payload else None,
            )
            _update_daily_progress(
                conn,
                job_id,
                steps,
                index,
                "failed",
                accumulated,
                {"error": error_payload} if error_payload else None,
            )
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
        raise
    step["status"] = "completed"
    step["finished_at"] = utc_now()
    step["summary"] = _step_summary(result)
    _record_daily_step(conn, job_id, step["key"], "completed", meta=result)
    _refresh_daily_paper_statuses(conn, job_id, step["key"])
    _update_daily_progress(conn, job_id, steps, index, "running", accumulated)
    return result


def _mark_daily_step_resumed(
    conn,
    job_id: int,
    steps: list[dict[str, Any]],
    index: int,
    accumulated: dict[str, Any],
    resume_job_id: int,
) -> None:
    step = steps[index]
    step["status"] = "completed"
    step["summary"] = f"resumed from job #{resume_job_id}"
    _record_daily_step(conn, job_id, step["key"], "completed", meta={"resumed_from_job_id": resume_job_id})
    _update_daily_progress(conn, job_id, steps, index, "running", accumulated)


def _mark_daily_step_skipped(
    conn,
    job_id: int,
    steps: list[dict[str, Any]],
    index: int,
    accumulated: dict[str, Any],
    summary: str,
) -> None:
    step = steps[index]
    step["status"] = "completed"
    step["summary"] = summary
    _record_daily_step(conn, job_id, step["key"], "skipped", meta={"summary": summary})
    _update_daily_progress(conn, job_id, steps, index, "running", accumulated)


def _completed_daily_step_keys(meta: dict[str, Any]) -> set[str]:
    progress = meta.get("daily_progress") if isinstance(meta, dict) else None
    steps = progress.get("steps", []) if isinstance(progress, dict) else []
    return {
        str(step.get("key"))
        for step in steps
        if isinstance(step, dict) and step.get("status") == "completed" and step.get("key")
    }


def _daily_settings_hash(settings) -> str:
    payload = {
        "arxiv_categories": settings.arxiv_categories,
        "arxiv_daily_lookback_days": settings.arxiv_daily_lookback_days,
        "arxiv_max_results": settings.arxiv_max_results,
        "retry_daily_max_results": settings.retry_daily_max_results,
        "rag_score_threshold": settings.rag_score_threshold,
        "rag_top_k": settings.rag_top_k,
        "rag_searchers": settings.rag_searchers,
        "rag_prefilter_enabled": settings.rag_prefilter_enabled,
        "rag_prefilter_threshold": settings.rag_prefilter_threshold,
        "rag_prefilter_top_k": settings.rag_prefilter_top_k,
        "rag_prefilter_min_keep": settings.rag_prefilter_min_keep,
        "rag_prefilter_max_keep": settings.rag_prefilter_max_keep,
        "llm_embedding_provider_id": settings.llm_embedding_provider_id,
        "llm_embedding_model": settings.llm_embedding_model,
    }
    return hashlib.sha256(to_json(payload).encode("utf-8")).hexdigest()


def _upsert_daily_meta(
    conn,
    job_id: int,
    mode: str,
    settings,
    *,
    arxiv_batch_id: str = "",
    source_job_id: int | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO daily_run_meta(
          job_id, source_job_id, arxiv_batch_id, mode, settings_hash,
          searchers_json, embedding_model, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          source_job_id = excluded.source_job_id,
          arxiv_batch_id = excluded.arxiv_batch_id,
          mode = excluded.mode,
          settings_hash = excluded.settings_hash,
          searchers_json = excluded.searchers_json,
          embedding_model = excluded.embedding_model
        """,
        (
            job_id,
            source_job_id,
            arxiv_batch_id,
            mode,
            _daily_settings_hash(settings),
            to_json(settings.rag_searchers),
            settings.llm_embedding_model,
            utc_now(),
        ),
    )
    conn.commit()


def _record_daily_step(
    conn,
    job_id: int,
    step_key: str,
    status: str,
    *,
    error: str = "",
    meta: dict[str, Any] | None = None,
) -> None:
    now = utc_now()
    started_at = now if status == "running" else None
    finished_at = now if status in {"completed", "failed", "skipped"} else None
    conn.execute(
        """
        INSERT INTO daily_run_steps(job_id, step_key, status, started_at, finished_at, error, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, step_key) DO UPDATE SET
          status = excluded.status,
          started_at = COALESCE(excluded.started_at, daily_run_steps.started_at),
          finished_at = excluded.finished_at,
          error = excluded.error,
          meta_json = excluded.meta_json
        """,
        (job_id, step_key, status, started_at, finished_at, error, to_json(meta or {})),
    )
    conn.commit()


def _mark_snapshot_stage_pending(conn, job_id: int, step_key: str) -> None:
    columns = STEP_STAGE_COLUMNS.get(step_key, ())
    if not columns:
        return
    assignments = ", ".join(f"{column} = 'in_progress'" for column in columns)
    conn.execute(
        f"""
        UPDATE daily_run_papers
        SET {assignments}, updated_at = ?
        WHERE job_id = ? AND selected = 1
        """,
        (utc_now(), job_id),
    )
    conn.commit()


def _reset_in_progress_daily_papers(conn, job_id: int) -> int:
    assignments = ", ".join(
        f"{column} = CASE WHEN {column} = 'in_progress' THEN 'pending' ELSE {column} END"
        for column in DAILY_STAGE_COLUMNS
    )
    result = conn.execute(
        f"""
        UPDATE daily_run_papers
        SET {assignments}, updated_at = ?
        WHERE job_id = ?
          AND selected = 1
          AND (
            text_status = 'in_progress'
            OR embedding_status = 'in_progress'
            OR global_match_status = 'in_progress'
            OR project_match_status = 'in_progress'
            OR judgment_status = 'in_progress'
            OR recommendation_status = 'in_progress'
            OR report_status = 'in_progress'
            OR archive_status = 'in_progress'
          )
        """,
        (utc_now(), job_id),
    )
    conn.commit()
    return int(result.rowcount or 0)


def _latest_prefilter_rows(conn, paper_ids: list[int]) -> dict[int, DbRow]:
    if not paper_ids:
        return {}
    placeholders = ", ".join("?" for _ in paper_ids)
    rows = conn.execute(
        f"""
        SELECT *
        FROM paper_prefilter_runs
        WHERE paper_id IN ({placeholders})
        ORDER BY created_at DESC, id DESC
        """,
        paper_ids,
    ).fetchall()
    latest: dict[int, DbRow] = {}
    for row in rows:
        paper_id = int(row["paper_id"])
        if paper_id not in latest:
            latest[paper_id] = row
    return latest


def _snapshot_stats(conn, job_id: int) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT source, retry_reason, selected, COUNT(*) AS count
        FROM daily_run_papers
        WHERE job_id = ?
        GROUP BY source, retry_reason, selected
        """,
        (job_id,),
    ).fetchall()
    total = 0
    selected = 0
    new_total = 0
    retry_total = 0
    retry_selected = 0
    by_reason: dict[str, int] = {}
    for row in rows:
        count = int(row["count"] or 0)
        total += count
        if int(row["selected"] or 0):
            selected += count
        source = str(row["source"] or "")
        if source == "new_arxiv":
            new_total += count
        else:
            retry_total += count
            if int(row["selected"] or 0):
                retry_selected += count
            reason = str(row["retry_reason"] or source)
            by_reason[f"retry_{reason}_papers"] = by_reason.get(f"retry_{reason}_papers", 0) + count
    return {
        "daily_candidate_papers": total,
        "daily_selected_papers": selected,
        "daily_new_papers": new_total,
        "daily_retry_papers": retry_total,
        "daily_retry_selected_papers": retry_selected,
        "prefilter_passed": selected,
        "prefilter_skipped": total - selected,
        **by_reason,
    }


def _selected_snapshot_papers(conn, job_id: int) -> list[DbRow]:
    return conn.execute(
        """
        SELECT p.*
        FROM daily_run_papers drp
        JOIN arxiv_papers p ON p.id = drp.paper_id
        WHERE drp.job_id = ?
          AND drp.selected = 1
        ORDER BY
          CASE WHEN drp.prefilter_rank IS NULL THEN 1 ELSE 0 END,
          drp.prefilter_rank,
          p.published_at DESC,
          p.id DESC
        """,
        (job_id,),
    ).fetchall()


def _selected_snapshot_paper_ids(conn, job_id: int) -> list[int]:
    return [int(row["id"]) for row in _selected_snapshot_papers(conn, job_id)]


def _unselected_snapshot_paper_ids(conn, job_id: int) -> list[int]:
    return [
        int(row["paper_id"])
        for row in conn.execute(
            """
            SELECT paper_id
            FROM daily_run_papers
            WHERE job_id = ? AND selected = 0
            ORDER BY prefilter_rank, paper_id
            """,
            (job_id,),
        ).fetchall()
    ]


def _mark_daily_archive_statuses(conn, job_id: int, paper_ids: list[int]) -> None:
    if not paper_ids:
        return
    placeholders = ", ".join("?" for _ in paper_ids)
    archived_ids = {
        int(row["id"])
        for row in conn.execute(
            f"""
            SELECT p.id
            FROM arxiv_papers p
            JOIN arxiv_paper_tombstones t ON t.arxiv_id = p.arxiv_id
            WHERE p.id IN ({placeholders})
            """,
            paper_ids,
        ).fetchall()
    }
    now = utc_now()
    for paper_id in paper_ids:
        conn.execute(
            """
            UPDATE daily_run_papers
            SET archive_status = ?, updated_at = ?
            WHERE job_id = ? AND paper_id = ?
            """,
            ("done" if paper_id in archived_ids else "skipped", now, job_id, paper_id),
        )
    conn.commit()


def _archive_daily_filtered_papers(
    conn,
    settings,
    job_id: int,
    selected_paper_ids: list[int],
) -> dict[str, int]:
    zero_match_result = archive_zero_match_papers(conn, settings, selected_paper_ids)
    unselected_paper_ids = _unselected_snapshot_paper_ids(conn, job_id)
    prefilter_result = archive_zero_match_papers(
        conn,
        settings,
        unselected_paper_ids,
        require_text_complete=False,
        reason="prefilter_rejected",
    )
    _mark_daily_archive_statuses(conn, job_id, [*selected_paper_ids, *unselected_paper_ids])
    return {
        **zero_match_result,
        "prefilter_rejected_papers_considered": prefilter_result["zero_match_papers_considered"],
        "prefilter_rejected_papers_archived": prefilter_result["zero_match_papers_archived"],
        "prefilter_rejected_files_deleted": prefilter_result["zero_match_files_deleted"],
        "prefilter_rejected_file_delete_errors": prefilter_result["zero_match_file_delete_errors"],
        "daily_filtered_papers_archived": zero_match_result["zero_match_papers_archived"]
        + prefilter_result["zero_match_papers_archived"],
    }


def _refresh_daily_paper_statuses(conn, job_id: int, step_key: str | None = None) -> None:
    columns = STEP_STAGE_COLUMNS.get(step_key or "", DAILY_STAGE_COLUMNS)
    selected_rows = conn.execute(
        """
        SELECT drp.paper_id, p.text_status, p.text_path
        FROM daily_run_papers drp
        JOIN arxiv_papers p ON p.id = drp.paper_id
        WHERE drp.job_id = ? AND drp.selected = 1
        """,
        (job_id,),
    ).fetchall()
    if not selected_rows:
        return
    paper_ids = [int(row["paper_id"]) for row in selected_rows]
    placeholders = ", ".join("?" for _ in paper_ids)
    chunk_counts = {
        int(row["paper_id"]): int(row["count"] or 0)
        for row in conn.execute(
            f"""
            SELECT paper_id, COUNT(*) AS count
            FROM arxiv_text_chunks
            WHERE paper_id IN ({placeholders})
            GROUP BY paper_id
            """,
            paper_ids,
        ).fetchall()
    }
    missing_embedding_counts = {
        int(row["paper_id"]): int(row["count"] or 0)
        for row in conn.execute(
            f"""
            SELECT c.paper_id, COUNT(*) AS count
            FROM arxiv_text_chunks c
            LEFT JOIN arxiv_chunk_embeddings e ON e.arxiv_chunk_id = c.id
            WHERE c.paper_id IN ({placeholders})
              AND e.arxiv_chunk_id IS NULL
            GROUP BY c.paper_id
            """,
            paper_ids,
        ).fetchall()
    }
    global_match_ids = {
        int(row["paper_id"])
        for row in conn.execute(
            f"""
            SELECT DISTINCT paper_id
            FROM matches
            WHERE paper_id IN ({placeholders})
              AND arxiv_chunk_id IS NOT NULL
            """,
            paper_ids,
        ).fetchall()
    }
    project_match_ids = {
        int(row["paper_id"])
        for row in conn.execute(
            f"""
            SELECT DISTINCT paper_id
            FROM project_paper_matches
            WHERE paper_id IN ({placeholders})
            """,
            paper_ids,
        ).fetchall()
    }
    judgment_ids = {
        int(row["paper_id"])
        for row in conn.execute(
            f"""
            SELECT DISTINCT paper_id
            FROM project_paper_judgments
            WHERE paper_id IN ({placeholders})
            """,
            paper_ids,
        ).fetchall()
    }
    recommendation_ids = {
        int(row["paper_id"])
        for row in conn.execute(
            f"""
            SELECT DISTINCT paper_id
            FROM project_paper_recommendations
            WHERE paper_id IN ({placeholders})
            """,
            paper_ids,
        ).fetchall()
    }
    report_done_ids = {
        int(row["paper_id"])
        for row in conn.execute(
            f"""
            SELECT DISTINCT p.id AS paper_id
            FROM arxiv_papers p
            JOIN paper_sources ps ON ps.source_identifier = p.arxiv_id
            JOIN artifacts af ON af.scope_id = ps.paper_id
            WHERE p.id IN ({placeholders})
              AND af.scope_type = 'paper'
              AND af.artifact_type = 'paper_report'
              AND af.status IN ('done', 'ready')
            """,
            paper_ids,
        ).fetchall()
    }
    tombstone_ids = {
        int(row["id"])
        for row in conn.execute(
            f"""
            SELECT p.id
            FROM arxiv_papers p
            JOIN arxiv_paper_tombstones t ON t.arxiv_id = p.arxiv_id
            WHERE p.id IN ({placeholders})
            """,
            paper_ids,
        ).fetchall()
    }
    now = utc_now()
    for row in selected_rows:
        paper_id = int(row["paper_id"])
        text_status = str(row["text_status"] or "")
        chunk_count = chunk_counts.get(paper_id, 0)
        updates: dict[str, str] = {}
        if "text_status" in columns:
            if text_status == "complete" and str(row["text_path"] or ""):
                updates["text_status"] = "done"
            elif text_status == "failed":
                updates["text_status"] = "failed_retryable"
            else:
                updates["text_status"] = "pending"
        if "embedding_status" in columns:
            if chunk_count and missing_embedding_counts.get(paper_id, 0) == 0:
                updates["embedding_status"] = "done"
            elif chunk_count:
                updates["embedding_status"] = "pending"
            else:
                updates["embedding_status"] = "skipped"
        if "global_match_status" in columns:
            updates["global_match_status"] = "done" if paper_id in global_match_ids else "pending"
        if "project_match_status" in columns:
            updates["project_match_status"] = "done" if paper_id in project_match_ids else "pending"
        if "judgment_status" in columns:
            updates["judgment_status"] = "done" if paper_id in judgment_ids else "pending"
        if "recommendation_status" in columns:
            updates["recommendation_status"] = "done" if paper_id in recommendation_ids else "pending"
        if "report_status" in columns:
            updates["report_status"] = "done" if paper_id in report_done_ids else "pending"
        if "archive_status" in columns:
            updates["archive_status"] = "done" if paper_id in tombstone_ids else "skipped"
        if not updates:
            continue
        assignments = ", ".join(f"{column} = ?" for column in updates)
        conn.execute(
            f"""
            UPDATE daily_run_papers
            SET {assignments}, updated_at = ?
            WHERE job_id = ? AND paper_id = ?
            """,
            [*updates.values(), now, job_id, paper_id],
        )
    conn.commit()


def _latest_resumable_daily_run(conn) -> dict[str, Any] | None:
    latest_completed_id = int(
        conn.execute(
            """
            SELECT COALESCE(MAX(id), 0) AS id
            FROM job_runs
            WHERE job_type IN ('run-daily', 'resume-daily', 'retry-daily')
              AND status = 'completed'
            """
        ).fetchone()["id"]
        or 0
    )
    rows = conn.execute(
        """
        SELECT jr.id, jr.job_type, jr.status, jr.started_at, jr.finished_at, jr.message,
               jr.meta_json, drm.mode, drm.source_job_id, drm.arxiv_batch_id
        FROM job_runs jr
        JOIN daily_run_meta drm ON drm.job_id = jr.id
        WHERE jr.job_type IN ('run-daily', 'resume-daily', 'retry-daily')
          AND jr.status IN ('running', 'failed')
          AND jr.id > ?
          AND EXISTS (
            SELECT 1 FROM daily_run_papers drp
            WHERE drp.job_id = jr.id AND drp.selected = 1
          )
        ORDER BY jr.id DESC
        LIMIT 50
        """,
        (latest_completed_id,),
    ).fetchall()
    for row in rows:
        meta = from_json(row["meta_json"], {})
        if isinstance(meta, dict):
            return {
                "id": int(row["id"]),
                "job_type": row["job_type"],
                "status": row["status"],
                "started_at": row["started_at"],
                "finished_at": row["finished_at"],
                "message": row["message"],
                "meta": {
                    **meta,
                    "mode": row["mode"],
                    "source_job_id": row["source_job_id"],
                    "arxiv_batch_id": row["arxiv_batch_id"],
                },
            }
    return None


def _daily_run_context(conn, job_id: int) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT jr.id, jr.job_type, jr.status, jr.started_at, jr.finished_at, jr.message,
               jr.meta_json, drm.mode, drm.source_job_id, drm.arxiv_batch_id
        FROM job_runs jr
        JOIN daily_run_meta drm ON drm.job_id = jr.id
        WHERE jr.id = ?
          AND jr.job_type IN ('run-daily', 'resume-daily', 'retry-daily')
        """,
        (job_id,),
    ).fetchone()
    if not row:
        return None
    selected_count = int(
        conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM daily_run_papers
            WHERE job_id = ? AND selected = 1
            """,
            (job_id,),
        ).fetchone()["count"]
        or 0
    )
    if not selected_count:
        return None
    meta = from_json(row["meta_json"], {})
    return {
        "id": int(row["id"]),
        "job_type": row["job_type"],
        "status": row["status"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "message": row["message"],
        "meta": {
            **(meta if isinstance(meta, dict) else {}),
            "mode": row["mode"],
            "source_job_id": row["source_job_id"],
            "arxiv_batch_id": row["arxiv_batch_id"],
        },
    }


def _daily_result_from_meta(meta: dict[str, Any], prefix: str) -> dict[str, Any]:
    return {
        key.removeprefix(prefix): value
        for key, value in meta.items()
        if isinstance(key, str) and key.startswith(prefix)
    }


def _selected_papers_from_existing_prefilter(
    conn,
    settings,
    batch_id: str,
) -> tuple[list[Any], dict[str, int]] | None:
    papers, candidate_result = _daily_papers_for_run(conn, settings, batch_id)
    if not papers:
        return [], {
            **candidate_result,
            "prefilter_considered": 0,
            "prefilter_passed": 0,
            "prefilter_skipped": 0,
            "prefilter_fallback": 0,
            "prefilter_capped": 0,
            "prefilter_resume_bypassed": 0,
        }

    placeholders = ", ".join("?" for _ in papers)
    prefilter_rows = conn.execute(
        f"""
        SELECT paper_id, MAX(passed) AS passed
        FROM paper_prefilter_runs
        WHERE paper_id IN ({placeholders})
        GROUP BY paper_id
        """,
        [int(paper["id"]) for paper in papers],
    ).fetchall()
    if len(prefilter_rows) < len(papers):
        return None
    passed_ids = {int(row["paper_id"]) for row in prefilter_rows if int(row["passed"] or 0)}
    selected = [paper for paper in papers if int(paper["id"]) in passed_ids]
    return selected, {
        **candidate_result,
        "prefilter_considered": len(papers),
        "prefilter_passed": len(selected),
        "prefilter_skipped": len(papers) - len(selected),
        "prefilter_fallback": 0,
        "prefilter_capped": 0,
        "prefilter_resume_bypassed": 0,
    }


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

    return list(new_papers), {
        "daily_new_papers": len(new_papers),
        "daily_retry_papers": 0,
        "daily_candidate_papers": len(new_papers),
    }


def _prefilter_daily_papers(conn, settings, batch_id: str, selected_papers: list[Any]) -> dict[str, int]:
    papers, candidate_result = _daily_papers_for_run(conn, settings, batch_id)
    papers, result = prefilter_papers(conn, settings, papers)
    selected_papers[:] = papers
    selected_ids = {int(paper["id"]) for paper in papers}
    rejected_ids = [
        int(paper["id"])
        for paper in _daily_papers_for_run(conn, settings, batch_id)[0]
        if int(paper["id"]) not in selected_ids
    ]
    archive_result = archive_zero_match_papers(
        conn,
        settings,
        rejected_ids,
        require_text_complete=False,
        reason="prefilter_rejected",
    )
    result = {
        **result,
        "daily_selected_papers": len(papers),
        "prefilter_resume_bypassed": 0,
        "prefilter_rejected_papers_archived": archive_result["zero_match_papers_archived"],
    }
    return {**candidate_result, **result}


def _retry_papers_for_run(conn, settings) -> tuple[list[DbRow], dict[int, dict[str, str]], dict[str, int]]:
    selection_limit = max(1, int(getattr(settings, "retry_daily_max_results", 100) or 100))
    candidate_limit = max(selection_limit, selection_limit * 3)
    papers: list[DbRow] = []
    info: dict[int, dict[str, str]] = {}
    seen: set[int] = set()
    counts: dict[str, int] = {}

    def add_rows(rows: list[DbRow], source: str, reason: str) -> None:
        for row in rows:
            if len(papers) >= candidate_limit:
                return
            paper_id = int(row["id"])
            if paper_id in seen:
                continue
            seen.add(paper_id)
            papers.append(row)
            info[paper_id] = {"source": source, "retry_reason": reason}
            key = f"daily_{reason}_papers"
            counts[key] = counts.get(key, 0) + 1

    def remaining_limit() -> int:
        return max(0, candidate_limit - len(papers))

    tombstone_filter = """
      AND NOT EXISTS (
        SELECT 1 FROM arxiv_paper_tombstones t
        WHERE t.arxiv_id = p.arxiv_id
      )
    """
    text_conditions = ["c.id IS NULL"]
    if settings.arxiv_cache_full_text:
        text_conditions.append("(p.text_status != 'complete' OR p.text_path = '')")
    if remaining_limit():
        add_rows(
            conn.execute(
                f"""
                SELECT DISTINCT p.*
                FROM arxiv_papers p
                LEFT JOIN arxiv_text_chunks c ON c.paper_id = p.id
                WHERE ({" OR ".join(text_conditions)})
                  {tombstone_filter}
                ORDER BY p.published_at DESC, p.id DESC
                LIMIT ?
                """,
                (remaining_limit(),),
            ).fetchall(),
            "retry_missing_text",
            "retry_missing_text",
        )
    if remaining_limit():
        add_rows(
            conn.execute(
                f"""
                SELECT DISTINCT p.*
                FROM arxiv_papers p
                JOIN arxiv_text_chunks c ON c.paper_id = p.id
                LEFT JOIN arxiv_chunk_embeddings e ON e.arxiv_chunk_id = c.id
                WHERE e.arxiv_chunk_id IS NULL
                  {tombstone_filter}
                ORDER BY p.published_at DESC, p.id DESC
                LIMIT ?
                """,
                (remaining_limit(),),
            ).fetchall(),
            "retry_missing_embedding",
            "retry_missing_embedding",
        )
    if remaining_limit():
        add_rows(
            conn.execute(
                f"""
                SELECT DISTINCT p.*
                FROM arxiv_papers p
                JOIN arxiv_text_chunks c ON c.paper_id = p.id
                LEFT JOIN matches m ON m.paper_id = p.id AND m.arxiv_chunk_id IS NOT NULL
                WHERE m.id IS NULL
                  {tombstone_filter}
                ORDER BY p.published_at DESC, p.id DESC
                LIMIT ?
                """,
                (remaining_limit(),),
            ).fetchall(),
            "retry_missing_global_match",
            "retry_missing_global_match",
        )
    if remaining_limit():
        add_rows(
            conn.execute(
                f"""
                SELECT DISTINCT p.*
                FROM arxiv_papers p
                JOIN arxiv_text_chunks c ON c.paper_id = p.id
                WHERE EXISTS (
                    SELECT 1
                    FROM project_notes pn
                    JOIN research_projects rp ON rp.id = pn.project_id
                    JOIN research_chunks rc ON rc.note_id = pn.note_id
                    WHERE {run_daily_project_status_sql("rp")}
                    LIMIT 1
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM project_paper_matches ppm
                    JOIN research_projects rp_match ON rp_match.id = ppm.project_id
                    WHERE ppm.paper_id = p.id
                      AND {run_daily_project_status_sql("rp_match")}
                  )
                  {tombstone_filter}
                ORDER BY p.published_at DESC, p.id DESC
                LIMIT ?
                """,
                (remaining_limit(),),
            ).fetchall(),
            "retry_missing_project_match",
            "retry_missing_project_match",
        )
    if remaining_limit():
        add_rows(
            conn.execute(
                f"""
                SELECT DISTINCT p.*
                FROM arxiv_papers p
                JOIN project_paper_matches ppm ON ppm.paper_id = p.id
                JOIN research_projects rp ON rp.id = ppm.project_id
                LEFT JOIN project_paper_judgments j
                  ON j.project_id = ppm.project_id AND j.paper_id = ppm.paper_id
                WHERE j.paper_id IS NULL
                  AND {run_daily_project_status_sql("rp")}
                  {tombstone_filter}
                ORDER BY p.published_at DESC, p.id DESC
                LIMIT ?
                """,
                (remaining_limit(),),
            ).fetchall(),
            "retry_missing_judgment",
            "retry_missing_judgment",
        )
    if remaining_limit():
        add_rows(
            conn.execute(
                f"""
                SELECT DISTINCT p.*
                FROM arxiv_papers p
                JOIN project_paper_judgments j ON j.paper_id = p.id
                JOIN research_projects rp ON rp.id = j.project_id
                LEFT JOIN project_paper_recommendations r
                  ON r.project_id = j.project_id AND r.paper_id = j.paper_id
                WHERE r.paper_id IS NULL
                  AND {run_daily_project_status_sql("rp")}
                  {tombstone_filter}
                ORDER BY p.published_at DESC, p.id DESC
                LIMIT ?
                """,
                (remaining_limit(),),
            ).fetchall(),
            "retry_missing_recommendation",
            "retry_missing_recommendation",
        )
    if remaining_limit():
        add_rows(
            conn.execute(
                f"""
                SELECT DISTINCT p.*
                FROM arxiv_papers p
                JOIN project_paper_recommendations r ON r.paper_id = p.id
                JOIN research_projects rp ON rp.id = r.project_id
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM paper_sources ps
                    JOIN artifacts af ON af.scope_id = ps.paper_id
                    WHERE ps.source_identifier = p.arxiv_id
                      AND af.scope_type = 'paper'
                      AND af.artifact_type = 'paper_report'
                      AND af.status IN ('done', 'ready')
                )
                  AND {run_daily_project_status_sql("rp")}
                  {tombstone_filter}
                ORDER BY p.published_at DESC, p.id DESC
                LIMIT ?
                """,
                (remaining_limit(),),
            ).fetchall(),
            "retry_missing_report",
            "retry_missing_report",
        )
    return papers, info, {
        "daily_new_papers": 0,
        "daily_retry_papers": len(papers),
        "daily_candidate_papers": len(papers),
        **counts,
    }


def _snapshot_daily_papers(
    conn,
    settings,
    job_id: int,
    papers: list[DbRow],
    source_info: dict[int, dict[str, str]] | None = None,
    *,
    selected_limit: int | None = None,
) -> tuple[list[DbRow], dict[str, int]]:
    effective_settings = settings
    if selected_limit is not None:
        capped_limit = max(1, int(selected_limit))
        effective_settings = replace(
            settings,
            rag_prefilter_max_keep=capped_limit,
            rag_prefilter_min_keep=min(int(settings.rag_prefilter_min_keep or 0), capped_limit),
        )
    selected_papers, prefilter_result = prefilter_papers(conn, effective_settings, papers)
    selected_ids = {int(paper["id"]) for paper in selected_papers}
    paper_ids = [int(paper["id"]) for paper in papers]
    latest_prefilter = _latest_prefilter_rows(conn, paper_ids)
    source_info = source_info or {}
    now = utc_now()
    with conn:
        conn.execute("DELETE FROM daily_run_papers WHERE job_id = ?", (job_id,))
        for index, paper in enumerate(papers, start=1):
            paper_id = int(paper["id"])
            info = source_info.get(paper_id, {"source": "new_arxiv", "retry_reason": ""})
            prefilter = latest_prefilter.get(paper_id)
            selected = paper_id in selected_ids
            stage_status = "pending" if selected else "skipped"
            conn.execute(
                """
                INSERT INTO daily_run_papers(
                  job_id, paper_id, source, retry_reason, published_at,
                  prefilter_score, prefilter_rank, prefilter_passed, selected,
                  selection_reason, text_status, embedding_status, global_match_status,
                  project_match_status, judgment_status, recommendation_status,
                  report_status, archive_status, error, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
                """,
                (
                    job_id,
                    paper_id,
                    info.get("source", "new_arxiv"),
                    info.get("retry_reason", ""),
                    str(paper["published_at"] or ""),
                    float(prefilter["score"]) if prefilter and prefilter["score"] is not None else None,
                    int(prefilter["rank"]) if prefilter and prefilter["rank"] is not None else index,
                    int(prefilter["passed"]) if prefilter else 1 if selected else 0,
                    1 if selected else 0,
                    str(prefilter["reason"] if prefilter else "selected" if selected else "not_selected"),
                    stage_status,
                    stage_status,
                    stage_status,
                    stage_status,
                    stage_status,
                    stage_status,
                    stage_status,
                    stage_status,
                    now,
                ),
            )
    _refresh_daily_paper_statuses(conn, job_id)
    return selected_papers, {
        **prefilter_result,
        **_snapshot_stats(conn, job_id),
        "daily_snapshot_job_id": job_id,
    }


def _clone_daily_snapshot(conn, source_job_id: int, target_job_id: int) -> dict[str, int]:
    source_meta = conn.execute(
        "SELECT * FROM daily_run_meta WHERE job_id = ?",
        (source_job_id,),
    ).fetchone()
    if not source_meta:
        raise RuntimeError(f"job #{source_job_id} does not have a daily snapshot")
    now = utc_now()
    with conn:
        conn.execute("DELETE FROM daily_run_papers WHERE job_id = ?", (target_job_id,))
        conn.execute("DELETE FROM daily_run_steps WHERE job_id = ?", (target_job_id,))
        conn.execute(
            """
            INSERT INTO daily_run_papers(
              job_id, paper_id, source, retry_reason, published_at,
              prefilter_score, prefilter_rank, prefilter_passed, selected,
              selection_reason, text_status, embedding_status, global_match_status,
              project_match_status, judgment_status, recommendation_status,
              report_status, archive_status, error, updated_at
            )
            SELECT ?, paper_id, source, retry_reason, published_at,
                   prefilter_score, prefilter_rank, prefilter_passed, selected,
                   selection_reason, text_status, embedding_status, global_match_status,
                   project_match_status, judgment_status, recommendation_status,
                   report_status, archive_status, error, ?
            FROM daily_run_papers
            WHERE job_id = ?
            """,
            (target_job_id, now, source_job_id),
        )
        conn.execute(
            """
            INSERT INTO daily_run_steps(job_id, step_key, status, started_at, finished_at, error, meta_json)
            SELECT ?,
                   step_key,
                   CASE WHEN status IN ('completed', 'skipped') THEN status ELSE 'pending' END,
                   started_at,
                   CASE WHEN status IN ('completed', 'skipped') THEN finished_at ELSE NULL END,
                   CASE WHEN status IN ('completed', 'skipped') THEN error ELSE '' END,
                   meta_json
            FROM daily_run_steps
            WHERE job_id = ?
            """,
            (target_job_id, source_job_id),
        )
    reset = _reset_in_progress_daily_papers(conn, target_job_id)
    return {**_snapshot_stats(conn, target_job_id), "daily_snapshot_job_id": target_job_id, "daily_snapshot_reset_papers": reset}


def _daily_step_status_map(conn, job_id: int) -> dict[str, str]:
    return {
        str(row["step_key"]): str(row["status"])
        for row in conn.execute(
            "SELECT step_key, status FROM daily_run_steps WHERE job_id = ?",
            (job_id,),
        ).fetchall()
    }


def sync_context_sources(conn: DbConnection, settings) -> dict[str, Any]:
    obsidian_enabled = bool(settings.obsidian_vault_path) or obsidian_remote_enabled(settings)
    result = {
        "context_sources_synced": 0,
        "context_sources_skipped": 0,
        "obsidian_enabled": 1 if obsidian_enabled else 0,
    }
    if obsidian_enabled:
        obsidian_result = _with_deadlock_retry(conn, lambda: sync_obsidian(conn, settings))
        for key, value in obsidian_result.items():
            if isinstance(value, bool):
                result[f"obsidian_{key}"] = int(value)
            elif isinstance(value, (int, float)):
                result[f"obsidian_{key}"] = int(value)
        if obsidian_result.get("skipped"):
            result["context_sources_skipped"] += 1
            result["obsidian_skipped"] = True
            result["obsidian_skip_reason"] = str(obsidian_result.get("reason") or OBSIDIAN_NOT_CONFIGURED)
        else:
            result["context_sources_synced"] += 1
    else:
        result["context_sources_skipped"] += 1
        result["obsidian_skipped"] = True
        result["obsidian_skip_reason"] = OBSIDIAN_NOT_CONFIGURED
    linked = sync_project_context_documents_from_project_notes(conn)
    result["project_context_documents_synced"] = linked
    return result


def cmd_init_db(_: argparse.Namespace) -> None:
    settings = load_settings()
    conn = connect()
    init_db(conn)
    database = database_target()
    conn.close()
    _print_json({"ok": True, "message": f"Initialized {database['target']}", "database": database})


def cmd_sync_obsidian(_: argparse.Namespace) -> None:
    def run(conn, settings):
        with job_run(conn, "sync-obsidian") as job_id:
            result = sync_obsidian(conn, settings)
            message = str(result.get("message") or "Obsidian sync completed")
            update_job_meta(conn, job_id, message, result)
        return {"message": message, **result}

    result = _with_db(run)
    _print_json({"ok": True, **result})


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


def cmd_run_daily(args: argparse.Namespace) -> None:
    requested_mode = str(getattr(args, "daily_mode", "run-daily") or "run-daily")
    if bool(getattr(args, "resume", False)):
        requested_mode = "resume-daily"

    def run(conn, settings):
        resume_context = None
        if requested_mode == "resume-daily":
            requested_job_id = int(getattr(args, "job_id", 0) or 0)
            resume_context = _daily_run_context(conn, requested_job_id) if requested_job_id else _latest_resumable_daily_run(conn)
            if not resume_context:
                raise RuntimeError("No resumable daily job with a persisted snapshot was found")

        job_type = requested_mode if requested_mode in DAILY_JOB_TYPES else "run-daily"
        with job_run(conn, job_type) as job_id:
            steps = [
                {"key": key, "label": label, "status": "pending"}
                for key, label in DAILY_STEPS
            ]
            accumulated: dict[str, Any] = {"daily_mode": requested_mode}
            source_job_id = int(resume_context["id"]) if resume_context else None
            if source_job_id:
                accumulated["resumed_from_job_id"] = source_job_id
            _upsert_daily_meta(
                conn,
                job_id,
                requested_mode,
                settings,
                source_job_id=source_job_id,
                arxiv_batch_id=str((resume_context or {}).get("meta", {}).get("arxiv_batch_id") or ""),
            )
            _update_daily_progress(conn, job_id, steps, 0, "running", accumulated)

            if requested_mode == "resume-daily":
                snapshot_result = _clone_daily_snapshot(conn, int(source_job_id or 0), job_id)
                _mark_daily_step_resumed(conn, job_id, steps, 0, accumulated, int(source_job_id or 0))
                _mark_daily_step_resumed(conn, job_id, steps, 1, accumulated, int(source_job_id or 0))
                _mark_daily_step_resumed(conn, job_id, steps, 2, accumulated, int(source_job_id or 0))
                accumulated.update(snapshot_result)
            else:
                sync_result = _run_daily_step(
                    conn,
                    job_id,
                    steps,
                    0,
                    accumulated,
                    lambda: sync_context_sources(conn, settings),
                )
                accumulated.update({f"context_{key}": value for key, value in sync_result.items()})

                if requested_mode == "run-daily":
                    arxiv_result = _run_daily_step(
                        conn,
                        job_id,
                        steps,
                        1,
                        accumulated,
                        lambda: fetch_arxiv(conn, settings),
                    )
                    accumulated.update({f"arxiv_{key}": value for key, value in arxiv_result.items()})
                    arxiv_batch_id = str(arxiv_result.get("batch_id") or "")
                    _upsert_daily_meta(
                        conn,
                        job_id,
                        requested_mode,
                        settings,
                        arxiv_batch_id=arxiv_batch_id,
                    )

                    selected_holder: list[DbRow] = []

                    def build_new_snapshot() -> dict[str, int]:
                        papers, source_stats = _daily_papers_for_run(conn, settings, arxiv_batch_id)
                        selected, snapshot_stats = _snapshot_daily_papers(conn, settings, job_id, papers)
                        selected_holder[:] = selected
                        return {**source_stats, **snapshot_stats}

                    snapshot_result = _run_daily_step(
                        conn,
                        job_id,
                        steps,
                        2,
                        accumulated,
                        build_new_snapshot,
                    )
                    accumulated.update(snapshot_result)
                else:
                    _mark_daily_step_skipped(conn, job_id, steps, 1, accumulated, "retry-daily does not fetch arXiv")

                    selected_holder: list[DbRow] = []

                    def build_retry_snapshot() -> dict[str, int]:
                        papers, source_info, retry_stats = _retry_papers_for_run(conn, settings)
                        selected, snapshot_stats = _snapshot_daily_papers(
                            conn,
                            settings,
                            job_id,
                            papers,
                            source_info,
                            selected_limit=max(1, int(settings.retry_daily_max_results or 100)),
                        )
                        selected_holder[:] = selected
                        return {**retry_stats, **snapshot_stats}

                    snapshot_result = _run_daily_step(
                        conn,
                        job_id,
                        steps,
                        2,
                        accumulated,
                        build_retry_snapshot,
                    )
                    accumulated.update(snapshot_result)

            selected_papers = _selected_snapshot_papers(conn, job_id)
            selected_paper_ids = [int(paper["id"]) for paper in selected_papers]
            prefilter_result = {
                "prefilter_considered": int(accumulated.get("prefilter_considered") or accumulated.get("daily_candidate_papers") or len(selected_papers)),
                "prefilter_passed": int(accumulated.get("prefilter_passed") or len(selected_papers)),
                "prefilter_skipped": int(accumulated.get("prefilter_skipped") or 0),
                "prefilter_fallback": int(accumulated.get("prefilter_fallback") or 0),
                "prefilter_capped": int(accumulated.get("prefilter_capped") or 0),
            }
            status_map = _daily_step_status_map(conn, job_id)

            def run_or_resume(index: int, handler: Callable[[], dict[str, Any]], prefix: str = "") -> dict[str, Any]:
                key = steps[index]["key"]
                if status_map.get(key) in {"completed", "skipped"}:
                    _mark_daily_step_resumed(conn, job_id, steps, index, accumulated, int(source_job_id or job_id))
                    return {}
                result = _run_daily_step(conn, job_id, steps, index, accumulated, handler)
                return {f"{prefix}{name}": value for name, value in result.items()} if prefix else result

            text_result = run_or_resume(
                3,
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
                "text_",
            )
            accumulated.update(text_result)

            rank_result = run_or_resume(
                4,
                lambda: rank_unmatched_papers(
                    conn,
                    settings,
                    papers=selected_papers,
                    prefilter_result=prefilter_result,
                ),
            )
            accumulated.update(rank_result)

            project_rank_result = run_or_resume(
                5,
                lambda: rank_project_papers(conn, settings, papers=selected_papers),
            )
            accumulated.update(project_rank_result)

            explain_result = run_or_resume(
                6,
                lambda: generate_missing_project_judgments(
                    conn,
                    settings,
                    paper_ids=selected_paper_ids,
                ),
            )
            accumulated.update(explain_result)

            recommendation_result = run_or_resume(
                7,
                lambda: sync_project_paper_recommendations(conn, selected_paper_ids),
            )
            accumulated.update(recommendation_result)

            paper_report_result = run_or_resume(
                8,
                lambda: ensure_paper_reports_for_recommendations(conn, selected_paper_ids),
            )
            accumulated.update(paper_report_result)

            archive_result = run_or_resume(
                9,
                lambda: _archive_daily_filtered_papers(conn, settings, job_id, selected_paper_ids),
            )
            accumulated.update(archive_result)

            report_result = run_or_resume(
                10,
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
                **_snapshot_stats(conn, job_id),
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


def cmd_api_delete_paper_report(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: remove_paper_report(conn, int(args.paper_id)))
    _print_json(result)


def cmd_api_paper_reports(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: paper_reports_queue(conn, int(args.limit), query=args.query or ""))
    _print_json(result)


def cmd_api_paper_reports_summary(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: paper_reports_summary(conn))
    _print_json(result)


def cmd_api_paper_library(args: argparse.Namespace) -> None:
    project_id = int(args.project_id) if str(args.project_id or "").strip() else None
    result = _with_db(
        lambda conn, settings: paper_library(
            conn,
            library_status=args.status or None,
            source_type=args.source_type or None,
            project_id=project_id,
            query=args.query or "",
            date_from=args.date_from or "",
            date_to=args.date_to or "",
            limit=int(args.limit),
            offset=int(args.offset),
        )
    )
    _print_json(result)


def cmd_api_paper_library_detail(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: library_paper_detail(conn, int(args.paper_id)))
    _print_json(result)


def cmd_api_paper_library_status(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("paper library status")
    result = _with_db(lambda conn, settings: update_library_paper_status(conn, int(args.paper_id), payload))
    _print_json(result)


def cmd_api_artifacts(args: argparse.Namespace) -> None:
    scope_id = int(args.scope_id) if str(args.scope_id or "").strip() else None
    result = _with_db(
        lambda conn, settings: artifacts_index(
            conn,
            scope_type=args.scope_type or None,
            scope_id=scope_id,
            artifact_type=args.artifact_type or None,
            status=args.status or None,
            limit=int(args.limit),
        )
    )
    _print_json(result)


def cmd_api_artifact(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: artifact_detail(conn, int(args.artifact_id)))
    _print_json(result)


def cmd_api_artifact_export(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("artifact export")
    result = _with_db(lambda conn, settings: export_artifact(conn, settings, int(args.artifact_id), payload))
    _print_json(result)


def cmd_api_experiment_report(_: argparse.Namespace) -> None:
    payload = _read_json_stdin("experiment report")
    result = _with_db(lambda conn, settings: receive_experiment_report(conn, settings, payload))
    _print_json(result)


def cmd_api_reader_papers(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: paper_reports_queue(conn, int(args.limit), query=args.query or ""))
    _print_json(result)


def cmd_api_reader_paper(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: paper_reader_detail(conn, int(args.paper_id)))
    _print_json(result)


def cmd_api_reader_chat(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("paper reader chat")
    result = _with_db(
        lambda conn, settings: paper_reader_chat(conn, settings, int(args.paper_id), payload)
    )
    _print_json(result)


def _print_json_event(event: str, data: dict[str, object]) -> None:
    payload = json.dumps(clean_unicode({"event": event, "data": data}), ensure_ascii=False)
    sys.stdout.buffer.write(payload.encode("utf-8", "replace") + b"\n")
    sys.stdout.buffer.flush()


def cmd_api_reader_chat_stream(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("paper reader streaming chat")
    settings = load_settings()
    conn = connect()
    init_db(conn)
    mark_stale_job_runs(conn)
    settings = apply_stored_settings(conn, settings)

    def emit(event: str, data: dict[str, object]) -> None:
        _print_json_event(event, data)

    try:
        paper_reader_chat_stream(conn, settings, int(args.paper_id), payload, emit)
    except Exception as exc:
        emit("error", {"error": str(exc)})
    finally:
        conn.close()


def cmd_api_reader_upload(_: argparse.Namespace) -> None:
    payload = _read_json_stdin("paper reader upload")
    result = _with_db(lambda conn, settings: import_reader_pdfs(conn, settings, payload))
    _print_json(result)


def cmd_api_reader_urls(_: argparse.Namespace) -> None:
    payload = _read_json_stdin("paper reader urls")
    result = _with_db(lambda conn, settings: import_reader_urls(conn, settings, payload))
    _print_json(result)


def cmd_api_reader_save(args: argparse.Namespace) -> None:
    result = _with_db(
        lambda conn, settings: save_reader_note_to_obsidian(conn, settings, int(args.paper_id))
    )
    _print_json(result)


def cmd_api_reader_followups(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("paper reader follow-up questions")
    result = _with_db(
        lambda conn, settings: generate_reader_followup_questions(conn, settings, int(args.paper_id), payload)
    )
    _print_json(result)


def cmd_api_reader_delete_message(args: argparse.Namespace) -> None:
    result = _with_db(
        lambda conn, settings: delete_reader_message(conn, int(args.paper_id), int(args.message_id))
    )
    _print_json(result)


def cmd_api_reader_cancel(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: cancel_reader_report(conn, int(args.paper_id)))
    _print_json(result)


def cmd_api_reader_retry(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: retry_reader_report(conn, settings, int(args.paper_id)))
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


def cmd_api_project_index(args: argparse.Namespace) -> None:
    payload = _read_json_stdin("project index")
    result = _with_db(lambda conn, settings: generate_project_index(conn, settings, int(args.project_id), payload))
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


def cmd_api_health_summary(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: health_summary(conn, settings))
    _print_json(result)


def cmd_api_jobs_summary(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: job_summary(conn))
    _print_json(result)


def cmd_api_jobs_history(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: job_history(conn, int(args.limit)))
    _print_json(result)


def cmd_api_jobs_cleanup(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: mark_stale_job_runs(conn), cleanup_stale=False)
    _print_json({"ok": True, **result})


DAILY_RUN_SNAPSHOT_TABLES = ("daily_run_papers", "daily_run_steps", "daily_run_meta")


def _delete_run_record(
    conn: DbConnection,
    job_id: int,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> dict[str, object]:
    row = conn.execute(
        """
        SELECT id, job_type, status, started_at, finished_at, message
        FROM job_runs
        WHERE id = ?
        """,
        (job_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Run not found: {job_id}")

    snapshot_counts = {
        table: int(
            conn.execute(
                f"SELECT COUNT(*) AS count FROM {table} WHERE job_id = ?",
                (job_id,),
            ).fetchone()["count"]
        )
        for table in DAILY_RUN_SNAPSHOT_TABLES
    }
    referenced_by_daily_runs = int(
        conn.execute(
            "SELECT COUNT(*) AS count FROM daily_run_meta WHERE source_job_id = ?",
            (job_id,),
        ).fetchone()["count"]
    )
    force_reasons: list[str] = []
    if row["status"] == "running":
        force_reasons.append("run is still marked running")
    if referenced_by_daily_runs:
        force_reasons.append("other daily runs reference this run as their source")

    result: dict[str, object] = {
        "ok": True,
        "dry_run": dry_run,
        "job_id": int(row["id"]),
        "job_type": row["job_type"],
        "status": row["status"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "snapshot_rows": snapshot_counts,
        "referenced_by_daily_runs": referenced_by_daily_runs,
        "products_deleted": 0,
    }
    if dry_run:
        result["would_delete_job_runs"] = 1
        for table, count in snapshot_counts.items():
            result[f"would_delete_{table}"] = count
        result["requires_force"] = bool(force_reasons)
        result["force_reasons"] = force_reasons
        return result

    if force_reasons and not force:
        raise RuntimeError(
            f"Refusing to delete run #{job_id}: {', '.join(force_reasons)}. "
            "Pass --force after confirming the job is not active and source links can be cleared."
        )

    deleted_counts: dict[str, int] = {}
    with conn:
        for table in DAILY_RUN_SNAPSHOT_TABLES:
            deleted_counts[table] = conn.execute(f"DELETE FROM {table} WHERE job_id = ?", (job_id,)).rowcount
        deleted_job_runs = conn.execute("DELETE FROM job_runs WHERE id = ?", (job_id,)).rowcount

    result["deleted_job_runs"] = deleted_job_runs
    for table in DAILY_RUN_SNAPSHOT_TABLES:
        result[f"deleted_{table}"] = deleted_counts.get(table, 0)
    result["force_used"] = force
    return result


def cmd_delete_run(args: argparse.Namespace) -> None:
    job_id = int(args.job_id)
    if job_id <= 0:
        raise RuntimeError("--job-id must be a positive integer")
    result = _with_db(
        lambda conn, settings: _delete_run_record(conn, job_id, force=args.force, dry_run=args.dry_run),
        cleanup_stale=False,
    )
    _print_json(result)


def cmd_api_notifications(args: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: notifications(conn, int(args.limit)))
    _print_json(result)


def _update_status_payload(status: dict[str, Any]) -> dict[str, Any]:
    notification = update_notification(status)
    result = dict(status)
    if notification:
        result["notification"] = notification
    return result


def cmd_api_update_status(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: _update_status_payload(read_update_status(conn)))
    _print_json(result)


def cmd_api_update_check(_: argparse.Namespace) -> None:
    result = _with_db(lambda conn, settings: _update_status_payload(check_for_updates(conn)))
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
    daily.add_argument("--resume", action="store_true")
    daily.set_defaults(func=cmd_run_daily, daily_mode="run-daily")

    resume_daily = sub.add_parser("resume-daily")
    resume_daily.add_argument("--job-id", default="0")
    resume_daily.set_defaults(func=cmd_run_daily, daily_mode="resume-daily", resume=True)

    retry_daily = sub.add_parser("retry-daily")
    retry_daily.set_defaults(func=cmd_run_daily, daily_mode="retry-daily")

    delete_run = sub.add_parser("delete-run")
    delete_run.add_argument("--job-id", required=True)
    delete_run.add_argument("--dry-run", action="store_true")
    delete_run.add_argument("--force", action="store_true")
    delete_run.set_defaults(func=cmd_delete_run)

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

    api_delete_paper_report = sub.add_parser("api-delete-paper-report")
    api_delete_paper_report.add_argument("paper_id")
    api_delete_paper_report.set_defaults(func=cmd_api_delete_paper_report)

    api_paper_reports = sub.add_parser("api-paper-reports")
    api_paper_reports.add_argument("--limit", default="300")
    api_paper_reports.add_argument("--query", default="")
    api_paper_reports.set_defaults(func=cmd_api_paper_reports)

    api_paper_reports_summary = sub.add_parser("api-paper-reports-summary")
    api_paper_reports_summary.set_defaults(func=cmd_api_paper_reports_summary)

    api_paper_library = sub.add_parser("api-paper-library")
    api_paper_library.add_argument("--status", default="")
    api_paper_library.add_argument("--source-type", default="")
    api_paper_library.add_argument("--project-id", default="")
    api_paper_library.add_argument("--query", default="")
    api_paper_library.add_argument("--date-from", default="")
    api_paper_library.add_argument("--date-to", default="")
    api_paper_library.add_argument("--limit", default="100")
    api_paper_library.add_argument("--offset", default="0")
    api_paper_library.set_defaults(func=cmd_api_paper_library)

    api_paper_library_detail = sub.add_parser("api-paper-library-detail")
    api_paper_library_detail.add_argument("paper_id")
    api_paper_library_detail.set_defaults(func=cmd_api_paper_library_detail)

    api_paper_library_status = sub.add_parser("api-paper-library-status")
    api_paper_library_status.add_argument("paper_id")
    api_paper_library_status.set_defaults(func=cmd_api_paper_library_status)

    api_artifacts = sub.add_parser("api-artifacts")
    api_artifacts.add_argument("--scope-type", default="")
    api_artifacts.add_argument("--scope-id", default="")
    api_artifacts.add_argument("--artifact-type", default="")
    api_artifacts.add_argument("--status", default="")
    api_artifacts.add_argument("--limit", default="100")
    api_artifacts.set_defaults(func=cmd_api_artifacts)

    api_artifact = sub.add_parser("api-artifact")
    api_artifact.add_argument("artifact_id")
    api_artifact.set_defaults(func=cmd_api_artifact)

    api_artifact_export = sub.add_parser("api-artifact-export")
    api_artifact_export.add_argument("artifact_id")
    api_artifact_export.set_defaults(func=cmd_api_artifact_export)

    api_experiment_report = sub.add_parser("api-experiment-report")
    api_experiment_report.set_defaults(func=cmd_api_experiment_report)

    api_reader_papers = sub.add_parser("api-reader-papers")
    api_reader_papers.add_argument("--limit", default="300")
    api_reader_papers.add_argument("--query", default="")
    api_reader_papers.set_defaults(func=cmd_api_reader_papers)

    api_reader_paper = sub.add_parser("api-reader-paper")
    api_reader_paper.add_argument("paper_id")
    api_reader_paper.set_defaults(func=cmd_api_reader_paper)

    api_reader_chat = sub.add_parser("api-reader-chat")
    api_reader_chat.add_argument("paper_id")
    api_reader_chat.set_defaults(func=cmd_api_reader_chat)

    api_reader_chat_stream = sub.add_parser("api-reader-chat-stream")
    api_reader_chat_stream.add_argument("paper_id")
    api_reader_chat_stream.set_defaults(func=cmd_api_reader_chat_stream)

    api_reader_upload = sub.add_parser("api-reader-upload")
    api_reader_upload.set_defaults(func=cmd_api_reader_upload)

    api_reader_urls = sub.add_parser("api-reader-urls")
    api_reader_urls.set_defaults(func=cmd_api_reader_urls)

    api_reader_save = sub.add_parser("api-reader-save")
    api_reader_save.add_argument("paper_id")
    api_reader_save.set_defaults(func=cmd_api_reader_save)

    api_reader_followups = sub.add_parser("api-reader-followups")
    api_reader_followups.add_argument("paper_id")
    api_reader_followups.set_defaults(func=cmd_api_reader_followups)

    api_reader_delete_message = sub.add_parser("api-reader-delete-message")
    api_reader_delete_message.add_argument("paper_id")
    api_reader_delete_message.add_argument("message_id")
    api_reader_delete_message.set_defaults(func=cmd_api_reader_delete_message)

    api_reader_cancel = sub.add_parser("api-reader-cancel")
    api_reader_cancel.add_argument("paper_id")
    api_reader_cancel.set_defaults(func=cmd_api_reader_cancel)

    api_reader_retry = sub.add_parser("api-reader-retry")
    api_reader_retry.add_argument("paper_id")
    api_reader_retry.set_defaults(func=cmd_api_reader_retry)

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

    api_project_index = sub.add_parser("api-project-index")
    api_project_index.add_argument("project_id")
    api_project_index.set_defaults(func=cmd_api_project_index)

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

    api_health_summary = sub.add_parser("api-health-summary")
    api_health_summary.set_defaults(func=cmd_api_health_summary)

    api_jobs_summary = sub.add_parser("api-jobs-summary")
    api_jobs_summary.set_defaults(func=cmd_api_jobs_summary)

    api_jobs_history = sub.add_parser("api-jobs-history")
    api_jobs_history.add_argument("--limit", default="20")
    api_jobs_history.set_defaults(func=cmd_api_jobs_history)

    api_jobs_cleanup = sub.add_parser("api-jobs-cleanup")
    api_jobs_cleanup.set_defaults(func=cmd_api_jobs_cleanup)

    api_notifications = sub.add_parser("api-notifications")
    api_notifications.add_argument("--limit", default="5")
    api_notifications.set_defaults(func=cmd_api_notifications)

    api_update_status = sub.add_parser("api-update-status")
    api_update_status.set_defaults(func=cmd_api_update_status)

    api_update_check = sub.add_parser("api-update-check")
    api_update_check.set_defaults(func=cmd_api_update_check)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
        return 0
    except ObsidianNotConfiguredError as exc:
        _print_json({"ok": False, **exc.to_payload()})
        return 1
    except ArxivRateLimitError as exc:
        _print_json({"ok": False, **exc.to_payload()})
        return 1
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        _print_json({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
