from __future__ import annotations

import json
import os
import socket
import sys
import time
import traceback
from typing import Any

from .config import load_settings
from .db import clean_unicode, connect, init_db
from .queue import (
    claim_next_worker_job,
    cleanup_stale_worker_jobs,
    complete_worker_job,
    fail_worker_job,
    insert_app_event,
    task_event_payload,
)
from .settings_store import apply_stored_settings
from .api import export_artifact, export_project_to_obsidian, generate_paper_reading_report, generate_project_index, project_detail
from .cli import (
    run_cache_arxiv_text_job,
    run_daily_job,
    run_fetch_arxiv_job,
    run_generate_paper_reports_job,
    run_generate_reports_job,
    run_rank_job,
    run_sync_obsidian_job,
)
from .knowledge import save_manual_project_context
from .paper_reader import import_reader_pdfs, import_reader_urls, import_reader_webpages, save_reader_note_to_obsidian
from .artifact_index import index_artifact, remove_artifact_index
from .search_backfill import backfill_search_indexes
from .unified_search import deep_search
from .experiment_reports import index_experiment_report
from .library_search_index import index_library_paper


DISPATCHERS = {
    "sync-obsidian": run_sync_obsidian_job,
    "fetch-arxiv": run_fetch_arxiv_job,
    "cache-arxiv-text": run_cache_arxiv_text_job,
    "rank-papers": run_rank_job,
    "generate-reports": run_generate_reports_job,
}

PROJECT_RESULT_CHANGE_KEYS = (
    "projects_synced",
    "project_notes_synced",
    "project_context_documents_synced",
    "project_paper_matches_created",
    "project_judgments_created",
    "paper_recommendations_created",
    "paper_recommendations_refreshed",
)
PAPER_RESULT_CHANGE_KEYS = (
    "papers_inserted",
    "papers_updated",
    "arxiv_papers_inserted",
    "arxiv_papers_updated",
    "daily_filtered_papers_archived",
    "prefilter_rejected_papers_archived",
    "zero_match_papers_archived",
    "matched_papers",
    "project_paper_matches_created",
    "project_judgments_created",
    "paper_recommendations_created",
    "paper_recommendations_refreshed",
)
PAPER_REPORT_RESULT_CHANGE_KEYS = (
    "paper_reports_queued",
    "paper_reports_requeued",
    "paper_reports_refreshed",
    "paper_reports_done",
    "paper_reports_failed",
    "paper_reports_deleted",
    "paper_reports_removed",
    "paper_reports_cancelled",
)


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        value = int(str(os.environ.get(name, default)).strip())
    except (TypeError, ValueError):
        return default
    return max(minimum, value)


def _worker_id() -> str:
    configured = os.environ.get("KRIS_WORKER_ID", "").strip()
    if configured:
        return configured
    return f"{socket.gethostname()}:{os.getpid()}"


def _payload(worker_job: dict[str, Any]) -> dict[str, Any]:
    payload = worker_job.get("payload")
    return payload if isinstance(payload, dict) else {}


def _args(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("args")
    return [str(item) for item in raw] if isinstance(raw, list) else []


def _arg_value(args: list[str], name: str) -> str:
    for index, item in enumerate(args):
        if item == name and index + 1 < len(args):
            return args[index + 1]
        if item.startswith(f"{name}="):
            return item.split("=", 1)[1]
    return ""


def _optional_int(value: Any) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    return int(text)


def _required_int(value: Any, name: str) -> int:
    parsed = _optional_int(value)
    if not parsed:
        raise RuntimeError(f"{name} is required")
    return parsed


def _result_count(result: dict[str, Any], key: str) -> int:
    try:
        return int(result.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _result_summary(result: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: result.get(key) for key in keys if _result_count(result, key)}


def _compact_project_payload(result: dict[str, Any], fallback_id: int | None = None) -> dict[str, Any]:
    project = result.get("project") if isinstance(result, dict) else {}
    project = project if isinstance(project, dict) else {}
    project_id = project.get("id") or result.get("project_id") or fallback_id
    return {
        "project_id": project_id,
        "id": project_id,
        "name": project.get("name"),
        "status": project.get("status"),
        "updated_at": project.get("updated_at") or result.get("updated_at"),
    }


def _compact_artifact_payload(result: dict[str, Any], key: str = "generated_artifact") -> dict[str, Any] | None:
    artifact = result.get(key) if isinstance(result, dict) else None
    if not isinstance(artifact, dict):
        artifact = result.get("artifact") if isinstance(result, dict) else None
    if not isinstance(artifact, dict):
        return None
    artifact_id = artifact.get("id")
    return {
        "artifact_id": artifact_id,
        "id": artifact_id,
        "artifact_type": artifact.get("artifact_type"),
        "title": artifact.get("title"),
        "scope_type": artifact.get("scope_type"),
        "scope_id": artifact.get("scope_id"),
        "status": artifact.get("status"),
        "updated_at": artifact.get("updated_at") or result.get("updated_at"),
    }


def _publish_project_domain_events(conn: Any, worker_job: dict[str, Any], result: dict[str, Any]) -> None:
    if not isinstance(result, dict):
        return
    job_type = str(worker_job.get("job_type") or "")
    payload = _payload(worker_job)
    project_id = _optional_int(payload.get("project_id"))
    if job_type == "project-index":
        project = _compact_project_payload(result, project_id)
        insert_app_event(conn, "project.updated", {"project": project, "project_id": project["project_id"], "reason": "project_index"})
        artifact = _compact_artifact_payload(result, "generated_artifact")
        if artifact:
            insert_app_event(
                conn,
                "artifact.created",
                {
                    "artifact": artifact,
                    "artifact_id": artifact["artifact_id"],
                    "project_id": artifact["scope_id"] if artifact["scope_type"] == "project" else project["project_id"],
                },
            )
        return
    if job_type == "project-export-obsidian":
        project = _compact_project_payload(result, project_id)
        insert_app_event(conn, "project.updated", {"project": project, "project_id": project["project_id"], "reason": "export_obsidian"})
        return
    if job_type == "project-context":
        project = _compact_project_payload(result, project_id)
        insert_app_event(conn, "project.updated", {"project": project, "project_id": project["project_id"], "reason": "project_context"})
        return

    result_summary = _result_summary(result, PROJECT_RESULT_CHANGE_KEYS)
    if not result_summary:
        return
    project = _compact_project_payload(result, project_id)
    insert_app_event(
        conn,
        "project.updated",
        {
            "project": project,
            "project_id": project["project_id"],
            "reason": "worker_result",
            "job_type": job_type,
            "result": result_summary,
        },
    )


def _publish_artifact_domain_events(conn: Any, worker_job: dict[str, Any], result: dict[str, Any]) -> None:
    if not isinstance(result, dict):
        return
    job_type = str(worker_job.get("job_type") or "")
    if job_type in {"artifact-index", "experiment-report-index"}:
        payload = _payload(worker_job)
        artifact_id = _optional_int(payload.get("artifact_id") or result.get("artifact_id"))
        artifact = _compact_artifact_payload(result, "artifact") or {
            "artifact_id": artifact_id,
            "id": artifact_id,
        }
        insert_app_event(
            conn,
            "artifact.updated",
            {
                "artifact": artifact,
                "artifact_id": artifact_id,
                "reason": "search_index_updated",
                "index_result": {
                    key: result.get(key)
                    for key in (
                        "artifact_chunks_created",
                        "artifact_embeddings_created",
                        "artifact_chunks_removed",
                        "unchanged",
                    )
                    if key in result
                },
            },
        )
        return
    daily_report_artifact_id = _optional_int(result.get("daily_report_artifact_id"))
    if daily_report_artifact_id:
        insert_app_event(
            conn,
            "artifact.updated",
            {
                "artifact": {
                    "artifact_id": daily_report_artifact_id,
                    "id": daily_report_artifact_id,
                    "artifact_type": "daily_report",
                    "title": result.get("daily_report_title"),
                    "scope_type": "system",
                    "scope_id": None,
                    "status": result.get("daily_report_status") or "ready",
                    "updated_at": result.get("updated_at"),
                },
                "artifact_id": daily_report_artifact_id,
                "project_id": None,
                "reason": "daily_report",
                "job_type": job_type,
            },
        )
    if job_type != "artifact-export-obsidian":
        return
    payload = _payload(worker_job)
    artifact_id = _optional_int(payload.get("artifact_id"))
    artifact = _compact_artifact_payload(result, "artifact") or {"artifact_id": artifact_id, "id": artifact_id}
    insert_app_event(
        conn,
        "artifact.updated",
        {
            "artifact": artifact,
            "artifact_id": artifact.get("artifact_id") or artifact_id,
            "project_id": artifact.get("scope_id") if artifact.get("scope_type") == "project" else None,
            "reason": "export_obsidian",
        },
    )


def _publish_reader_domain_events(conn: Any, worker_job: dict[str, Any], result: dict[str, Any]) -> None:
    if not isinstance(result, dict):
        return
    job_type = str(worker_job.get("job_type") or "")
    payload = _payload(worker_job)
    if job_type in {"reader-import-upload", "reader-import-url", "reader-import-web"}:
        imported = result.get("imported") if isinstance(result.get("imported"), list) else []
        source_by_job_type = {
            "reader-import-upload": "upload",
            "reader-import-url": "url",
            "reader-import-web": "web",
        }
        insert_app_event(
            conn,
            "reader.papers.imported",
            {
                "source": source_by_job_type[job_type],
                "imported": [
                    {
                        "paper_id": item.get("paper_id") or item.get("id"),
                        "title": item.get("title"),
                    }
                    for item in imported
                    if isinstance(item, dict) and (item.get("paper_id") or item.get("id"))
                ],
                "imported_count": len(imported),
                "error_count": len(result.get("errors") if isinstance(result.get("errors"), list) else []),
            },
        )
        return
    if job_type == "reader-save-obsidian":
        paper_id = _optional_int(payload.get("paper_id"))
        insert_app_event(
            conn,
            "reader.paper.updated",
            {
                "paper": {
                    "paper_id": paper_id,
                    "id": paper_id,
                    "updated_at": None,
                },
                "paper_id": paper_id,
                "action": "save_obsidian",
            },
        )


def _publish_paper_report_domain_events(conn: Any, worker_job: dict[str, Any], result: dict[str, Any]) -> None:
    if not isinstance(result, dict):
        return
    job_type = str(worker_job.get("job_type") or "")
    if job_type == "paper-report":
        payload = _payload(worker_job)
        paper_id = _optional_int(payload.get("paper_id"))
        report = result.get("paper_report") if isinstance(result.get("paper_report"), dict) else {}
        insert_app_event(
            conn,
            "paper_report.updated",
            {
                "paper": {
                    "paper_id": paper_id,
                    "id": paper_id,
                    "report_status": report.get("status") if isinstance(report, dict) else None,
                    "updated_at": report.get("updated_at") if isinstance(report, dict) else None,
                },
                "paper_id": paper_id,
                "artifact_id": report.get("artifact_id") or report.get("id") if isinstance(report, dict) else None,
                "status": report.get("status") if isinstance(report, dict) else None,
                "project_ids": [],
                "force": bool(payload.get("force")),
            },
        )
        return

    completed_reports = result.get("paper_reports_completed")
    failed_reports = result.get("paper_reports_failures")
    detailed_reports = [
        report
        for reports in (completed_reports, failed_reports)
        if isinstance(reports, list)
        for report in reports
        if isinstance(report, dict)
    ]
    for report in detailed_reports:
        paper_id = _optional_int(report.get("paper_id"))
        artifact_id = _optional_int(report.get("artifact_id"))
        status = clean_unicode(str(report.get("status") or "updated")).strip() or "updated"
        title = clean_unicode(str(report.get("title") or "")).strip()
        updated_at = report.get("updated_at")
        payload = {
            "paper": {
                "paper_id": paper_id,
                "id": paper_id,
                "title": title or None,
                "report_status": status,
                "updated_at": updated_at,
            },
            "paper_report": {
                "artifact_id": artifact_id,
                "paper_id": paper_id,
                "status": status,
                "updated_at": updated_at,
            },
            "paper_id": paper_id,
            "artifact_id": artifact_id,
            "status": status,
            "source_type": report.get("source_type") or None,
            "manual_import": bool(report.get("manual_import")),
            "project_ids": [],
            "job_type": job_type,
        }
        if status == "done" and payload["manual_import"]:
            notification_key = artifact_id or paper_id or "unknown"
            payload["notification"] = {
                "id": f"manual-paper-report-completed-{notification_key}",
                "type": "manual_paper_report_completed",
                "severity": "ok",
                "title": "论文报告生成完成",
                "detail": title or (f"论文 {paper_id}" if paper_id else "手动导入论文"),
                "created_at": updated_at,
                "source": {
                    "paper_id": paper_id,
                    "artifact_id": artifact_id,
                    "source_type": report.get("source_type") or None,
                },
                "channels": ["toast"],
                "requires_action": False,
            }
        insert_app_event(conn, "paper_report.updated", payload)

    report_keys = [key for key in result if str(key).startswith("paper_reports_")]
    result_summary = _result_summary(result, PAPER_REPORT_RESULT_CHANGE_KEYS)
    if not report_keys or not result_summary:
        return
    done = int(result.get("paper_reports_done") or 0)
    failed = int(result.get("paper_reports_failed") or 0)
    queued = int(result.get("paper_reports_queued") or 0) + int(result.get("paper_reports_requeued") or 0)
    deleted = int(result.get("paper_reports_deleted") or 0) + int(result.get("paper_reports_removed") or 0)
    cancelled = int(result.get("paper_reports_cancelled") or 0)
    detailed_done = sum(1 for report in detailed_reports if report.get("status") == "done")
    detailed_failed = sum(1 for report in detailed_reports if report.get("status") == "failed")
    if (
        detailed_reports
        and detailed_done == done
        and detailed_failed == failed
        and not any((queued, deleted, cancelled, int(result.get("paper_reports_refreshed") or 0)))
    ):
        return
    status = "done" if done else "failed" if failed else "queued" if queued else "removed" if deleted else "cancelled" if cancelled else "updated"
    insert_app_event(
        conn,
        "paper_report.updated",
        {
            "paper": {
                "paper_id": None,
                "id": None,
                "report_status": status,
                "updated_at": None,
            },
            "paper_id": None,
            "artifact_id": None,
            "status": status,
            "project_ids": [],
            "job_type": job_type,
            "result": {key: result.get(key) for key in sorted(report_keys)},
        },
    )


def _publish_paper_domain_events(conn: Any, worker_job: dict[str, Any], result: dict[str, Any]) -> None:
    if not isinstance(result, dict):
        return
    result_summary = _result_summary(result, PAPER_RESULT_CHANGE_KEYS)
    if not result_summary:
        return
    insert_app_event(
        conn,
        "papers.changed",
        {
            "paper": {"paper_id": None, "id": None, "updated_at": result.get("updated_at")},
            "paper_id": None,
            "project_ids": [],
            "job_type": str(worker_job.get("job_type") or ""),
            "result": result_summary,
        },
    )


def run_project_context_job(conn: Any, settings: Any, worker_job: dict[str, Any]) -> dict[str, Any]:
    payload = _payload(worker_job)
    project_id = _required_int(payload.get("project_id"), "project_id")
    raw_context = clean_unicode(str(payload.get("raw_context") or payload.get("context") or payload.get("project_context") or "")).strip()
    if not raw_context:
        raise RuntimeError("Project context cannot be empty")
    context_document = save_manual_project_context(
        conn,
        settings,
        project_id,
        raw_context,
        title=clean_unicode(str(payload.get("title") or "")).strip() or None,
        source_uri=clean_unicode(str(payload.get("source_uri") or "")).strip() or None,
        relation=clean_unicode(str(payload.get("relation") or "primary")).strip() or "primary",
        weight=float(payload.get("weight") or 1.0),
    )
    detail = project_detail(conn, project_id)
    detail["context_document"] = context_document
    return detail


def dispatch_worker_job(conn: Any, settings: Any, worker_job: dict[str, Any]) -> dict[str, Any]:
    job_type = str(worker_job.get("job_type") or "")
    job_run_id = int(worker_job["job_run_id"]) if worker_job.get("job_run_id") else None
    payload = _payload(worker_job)
    args = _args(payload)

    if job_type == "artifact-index":
        artifact_id = _required_int(payload.get("artifact_id"), "artifact_id")
        if str(payload.get("action") or "index") == "remove":
            return remove_artifact_index(conn, artifact_id)
        return index_artifact(conn, settings, artifact_id)

    if job_type == "artifact-index-backfill":
        return backfill_search_indexes(conn, settings)

    if job_type == "experiment-report-index":
        artifact_id = _required_int(payload.get("artifact_id"), "artifact_id")
        return index_experiment_report(conn, settings, artifact_id)

    if job_type == "unified-search":
        return deep_search(conn, settings, payload)

    if job_type == "library-paper-index":
        paper_id = _required_int(payload.get("paper_id"), "paper_id")
        return index_library_paper(conn, settings, paper_id)

    if job_type == "generate-paper-reports":
        limit = _optional_int(payload.get("limit")) or _optional_int(_arg_value(args, "--limit"))
        return run_generate_paper_reports_job(conn, settings, limit=limit, job_id=job_run_id)

    if job_type in {"run-daily", "resume-daily", "retry-daily"}:
        requested_job_id = _optional_int(payload.get("job_id")) or _optional_int(_arg_value(args, "--job-id")) or 0
        return run_daily_job(
            conn,
            settings,
            requested_mode=job_type,
            resume=job_type == "resume-daily",
            requested_job_id=requested_job_id,
            job_id=job_run_id,
        )

    if job_type == "project-index":
        project_id = _required_int(payload.get("project_id") or _arg_value(args, "--project-id"), "project_id")
        return generate_project_index(conn, settings, project_id, payload)

    if job_type == "project-export-obsidian":
        project_id = _required_int(payload.get("project_id") or _arg_value(args, "--project-id"), "project_id")
        return export_project_to_obsidian(conn, settings, project_id)

    if job_type == "project-context":
        return run_project_context_job(conn, settings, worker_job)

    if job_type == "artifact-export-obsidian":
        artifact_id = _required_int(payload.get("artifact_id"), "artifact_id")
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        return export_artifact(conn, settings, artifact_id, body)

    if job_type == "reader-import-upload":
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        result = import_reader_pdfs(conn, settings, body)
        if not result.get("ok"):
            errors = result.get("errors") if isinstance(result.get("errors"), list) else []
            first_error = next(
                (str(item.get("error") or "").strip() for item in errors if isinstance(item, dict) and item.get("error")),
                "PDF import failed",
            )
            raise RuntimeError(first_error)
        return result

    if job_type == "reader-import-url":
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        return import_reader_urls(conn, settings, body)

    if job_type == "reader-import-web":
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        result = import_reader_webpages(conn, settings, body)
        if not result.get("ok"):
            errors = result.get("errors") if isinstance(result.get("errors"), list) else []
            first_error = next(
                (str(item.get("error") or "").strip() for item in errors if isinstance(item, dict) and item.get("error")),
                "Webpage import failed",
            )
            raise RuntimeError(first_error)
        return result

    if job_type == "reader-save-obsidian":
        paper_id = _required_int(payload.get("paper_id"), "paper_id")
        return save_reader_note_to_obsidian(conn, settings, paper_id)

    if job_type == "paper-report":
        paper_id = _required_int(payload.get("paper_id"), "paper_id")
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        return generate_paper_reading_report(conn, settings, paper_id, body)

    dispatcher = DISPATCHERS.get(job_type)
    if not dispatcher:
        raise RuntimeError(f"Unsupported worker job type: {job_type}")
    return dispatcher(conn, settings, job_id=job_run_id)


def run_once(worker_id: str) -> dict[str, Any]:
    os.environ.setdefault("KRIS_WORKER_OUTBOX_EVENTS", "1")
    base_settings = load_settings()
    conn = connect()
    try:
        claimed = claim_next_worker_job(conn, worker_id)
        if not claimed:
            return {"claimed": False}
        worker_job = claimed["worker_job"]
        insert_app_event(conn, "task.started", task_event_payload(worker_job, "running"))
        settings = apply_stored_settings(conn, base_settings)
        try:
            result = dispatch_worker_job(conn, settings, worker_job)
        except Exception as exc:
            failed = fail_worker_job(conn, int(worker_job["id"]), str(exc))
            failed_job = failed["worker_job"] or worker_job
            insert_app_event(conn, "task.failed", task_event_payload(failed_job, "failed", message=str(exc)))
            raise
        completed = complete_worker_job(
            conn,
            int(worker_job["id"]),
            result,
            message=str(result.get("message") or f"{worker_job['job_type']} completed"),
        )
        completed_job = completed["worker_job"] or worker_job
        insert_app_event(conn, "task.finished", task_event_payload(completed_job, "completed", result=result))
        _publish_project_domain_events(conn, worker_job, result)
        _publish_artifact_domain_events(conn, worker_job, result)
        _publish_reader_domain_events(conn, worker_job, result)
        _publish_paper_report_domain_events(conn, worker_job, result)
        _publish_paper_domain_events(conn, worker_job, result)
        if str(worker_job.get("job_type") or "") == "unified-search":
            insert_app_event(
                conn,
                "search.completed",
                {
                    "worker_job_id": completed_job.get("id"),
                    "job_id": completed_job.get("job_run_id"),
                    "query": result.get("query"),
                    "result_count": len(result.get("results") or []),
                    "partial": bool((result.get("stats") or {}).get("partial")),
                },
            )
        return {"claimed": True, "worker_job": completed_job, "result": result}
    finally:
        conn.close()


def main() -> int:
    worker_id = _worker_id()
    poll_interval_ms = _env_int("KRIS_WORKER_POLL_INTERVAL_MS", 1000, minimum=100)
    os.environ.setdefault("KRIS_WORKER_OUTBOX_EVENTS", "1")
    if _env_flag("KRIS_WORKER_INIT_DB_ON_START", True):
        load_settings()
        conn = connect()
        try:
            init_db(conn)
            cleanup_stale_worker_jobs(
                conn,
                stale_after_seconds=_env_int("KRIS_WORKER_JOB_STALE_AFTER_SECONDS", 30 * 60, minimum=60),
            )
        finally:
            conn.close()
    print(f"KRIS worker service started: {worker_id}", flush=True)
    while True:
        try:
            result = run_once(worker_id)
            if result.get("claimed"):
                sys.stdout.write(json.dumps(clean_unicode({
                    "event": "worker_job.completed",
                    "worker_id": worker_id,
                    "worker_job_id": result.get("worker_job", {}).get("id"),
                    "job_type": result.get("worker_job", {}).get("job_type"),
                }), ensure_ascii=False) + "\n")
                sys.stdout.flush()
            else:
                time.sleep(poll_interval_ms / 1000)
        except KeyboardInterrupt:
            return 0
        except Exception:
            traceback.print_exc(file=sys.stderr)
            time.sleep(poll_interval_ms / 1000)


if __name__ == "__main__":
    raise SystemExit(main())
