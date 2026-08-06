from __future__ import annotations

import json
import os
import signal
import socket
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Any

from .config import load_settings
from .db import clean_unicode, connect, init_db
from .queue import (
    cancel_worker_job_before_dispatch,
    claim_next_worker_job,
    cleanup_stale_worker_jobs,
    complete_worker_job,
    fail_worker_job,
    heartbeat_worker,
    heartbeat_worker_job,
    insert_app_event,
    task_event_payload,
)
from .settings_store import apply_stored_settings
from .job_policy import resolve_worker_job_policy
from .api import export_artifact
from .cli import (
    run_cache_arxiv_text_job,
    run_daily_job,
    run_fetch_arxiv_job,
    run_generate_reports_job,
    run_rank_job,
    run_sync_obsidian_job,
)
from .knowledge import index_knowledge_document
from .paper_reader import import_reader_pdfs, import_reader_urls, import_reader_webpages, save_reader_note_to_obsidian
from .artifact_index import index_artifact, remove_artifact_index
from .search_backfill import backfill_search_indexes
from .experiment_reports import index_experiment_report
from .library_search_index import index_library_paper
from .paper_reports import (
    run_paper_report_worker_job,
    stage_paper_report_terminal_failure,
)


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
READER_IMPORT_NOTIFICATION_LABELS = {
    "reader-import-upload": "PDF 导入",
    "reader-import-url": "URL 导入",
    "reader-import-web": "网页导入",
}

EXPLICIT_WORKER_JOB_TYPES = {
    "artifact-index",
    "artifact-index-backfill",
    "experiment-report-index",
    "library-paper-index",
    "run-daily",
    "resume-daily",
    "retry-daily",
    "knowledge-document-index",
    "artifact-export-obsidian",
    "reader-import-upload",
    "reader-import-url",
    "reader-import-web",
    "reader-save-obsidian",
    "paper-report",
}
SUPPORTED_WORKER_JOB_TYPES = frozenset(DISPATCHERS) | frozenset(EXPLICIT_WORKER_JOB_TYPES)

READER_IMPORT_NOTIFICATION_TYPES = {
    "reader-import-upload": "upload",
    "reader-import-url": "url",
    "reader-import-web": "web",
}


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


def _queue_wait_seconds(worker_job: dict[str, Any], *, now: datetime | None = None) -> float | None:
    created_at = worker_job.get("created_at")
    if not created_at:
        return None
    try:
        created = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    except ValueError:
        return None
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    current = now or datetime.now(timezone.utc)
    return round(max(0.0, (current - created.astimezone(timezone.utc)).total_seconds()), 3)


def _log_job_observation(
    event: str,
    worker_job: dict[str, Any],
    worker_id: str,
    *,
    handler_duration_seconds: float | None = None,
) -> dict[str, Any]:
    observation = {
        "event": event,
        "worker_job_id": worker_job.get("id") or worker_job.get("worker_job_id"),
        "job_type": str(worker_job.get("job_type") or ""),
        "worker_id": worker_id,
        "attempt": int(worker_job.get("attempts") or 0),
        "concurrency_group": str(
            worker_job.get("concurrency_group")
            or resolve_worker_job_policy(str(worker_job.get("job_type") or ""), worker_job.get("payload") or {}).get("concurrency_group")
            or "unclassified"
        ),
        "queue_wait_seconds": _queue_wait_seconds(worker_job),
        "handler_duration_seconds": (
            round(max(0.0, handler_duration_seconds), 3)
            if handler_duration_seconds is not None
            else None
        ),
    }
    sys.stdout.write(json.dumps(clean_unicode(observation), ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return observation


class WorkerHeartbeat:
    def __init__(self, worker_id: str, interval_seconds: int) -> None:
        self.worker_id = worker_id
        self.interval_seconds = max(1, int(interval_seconds))
        self.started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._current_job: tuple[int, int] | None = None
        self._draining = threading.Event()
        self._state_lock = threading.Lock()
        self._beat_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="kris-worker-heartbeat", daemon=True)

    def _snapshot(self) -> tuple[int, int] | None:
        with self._state_lock:
            return self._current_job

    def _beat(self, *, status_override: str = "") -> None:
        if not self._beat_lock.acquire(blocking=False):
            return
        try:
            current_job = self._snapshot()
            current_job_id = current_job[0] if current_job else None
            conn = connect()
            try:
                heartbeat_worker(
                    conn,
                    self.worker_id,
                    status=status_override or (
                        "draining" if self._draining.is_set() else ("running" if current_job_id else "idle")
                    ),
                    started_at=self.started_at,
                    current_job_id=current_job_id,
                    pid=os.getpid(),
                    meta={"service": "worker.service", "draining": self._draining.is_set()},
                    commit=False,
                )
                if current_job:
                    heartbeat_worker_job(
                        conn,
                        self.worker_id,
                        current_job_id,
                        current_job[1],
                        commit=False,
                    )
                conn.commit()
            finally:
                conn.close()
        finally:
            self._beat_lock.release()

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            try:
                self._beat()
            except Exception as exc:
                print(f"KRIS worker heartbeat failed: {exc}", file=sys.stderr, flush=True)

    def start(self) -> None:
        self._beat()
        self._thread.start()

    def set_current_job(self, worker_job: tuple[int, int] | None) -> None:
        with self._state_lock:
            self._current_job = worker_job
        self._beat()

    def begin_draining(self) -> None:
        self._draining.set()

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=self.interval_seconds + 1)
        try:
            self._beat(status_override="stopped")
        except Exception:
            pass


class WorkerStaleRecovery:
    def __init__(self, interval_seconds: int, stale_after_seconds: int) -> None:
        self.interval_seconds = max(1, int(interval_seconds))
        self.stale_after_seconds = max(60, int(stale_after_seconds))
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="kris-worker-stale-recovery", daemon=True)

    def scan_once(self) -> dict[str, int]:
        conn = connect()
        try:
            return cleanup_stale_worker_jobs(conn, stale_after_seconds=self.stale_after_seconds)
        finally:
            conn.close()

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            try:
                self.scan_once()
            except Exception as exc:
                print(f"KRIS worker stale recovery failed: {exc}", file=sys.stderr, flush=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=self.interval_seconds + 1)


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


def _reader_import_result_or_raise(result: dict[str, Any], fallback_message: str) -> dict[str, Any]:
    if result.get("ok"):
        return result
    errors = result.get("errors") if isinstance(result.get("errors"), list) else []
    first_error = next(
        (clean_unicode(str(item.get("error") or "")).strip() for item in errors if isinstance(item, dict) and item.get("error")),
        fallback_message,
    )
    raise RuntimeError(first_error)


def _reader_import_notification(
    worker_job: dict[str, Any],
    *,
    imported_count: int = 0,
    error_count: int = 0,
    error_message: str = "",
) -> dict[str, Any] | None:
    job_type = str(worker_job.get("job_type") or "")
    label = READER_IMPORT_NOTIFICATION_LABELS.get(job_type)
    if not label:
        return None
    worker_job_id = worker_job.get("id") or worker_job.get("worker_job_id") or "unknown"
    notification_data = {
        "import_type": READER_IMPORT_NOTIFICATION_TYPES.get(job_type, "unknown"),
        "imported_count": imported_count,
        "error_count": error_count,
        "error_message": clean_unicode(error_message).strip(),
    }
    if error_message:
        return {
            "id": f"{job_type}-failed-{worker_job_id}",
            "type": "reader_import_failed",
            "severity": "bad",
            "title": f"{label}失败",
            "detail": clean_unicode(error_message).strip() or "导入任务执行失败",
            "data": notification_data,
            "channels": ["toast"],
            "requires_action": False,
        }
    detail = f"成功 {imported_count} 篇"
    if error_count:
        detail += f"，失败 {error_count} 篇"
    return {
        "id": f"{job_type}-completed-{worker_job_id}",
        "type": "reader_import_completed",
        "severity": "warn" if error_count else "ok",
        "title": f"{label}完成",
        "detail": detail,
        "data": notification_data,
        "channels": ["toast"],
        "requires_action": False,
    }


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


def _knowledge_index_domain_events(
    worker_job: dict[str, Any],
    *,
    index_status: str,
    document_id: int | None = None,
    error: str = "",
) -> list[dict[str, Any]]:
    if str(worker_job.get("job_type") or "") != "knowledge-document-index":
        return []
    if index_status == "superseded":
        return []
    payload = _payload(worker_job)
    project_id = _optional_int(payload.get("project_id"))
    resolved_document_id = document_id or _optional_int(payload.get("document_id"))
    return [{
        "event_type": "project.updated",
        "payload": {
            "project": {"project_id": project_id, "id": project_id},
            "project_id": project_id,
            "document_id": resolved_document_id,
            "index_status": index_status,
            "index_error": clean_unicode(error).strip(),
            "reason": "project_context_index",
        },
    }]


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
        errors = result.get("errors") if isinstance(result.get("errors"), list) else []
        source_by_job_type = {
            "reader-import-upload": "upload",
            "reader-import-url": "url",
            "reader-import-web": "web",
        }
        notification = _reader_import_notification(
            worker_job,
            imported_count=len(imported),
            error_count=len(errors),
        )
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
                "error_count": len(errors),
                "notification": notification,
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


def dispatch_worker_job(conn: Any, settings: Any, worker_job: dict[str, Any]) -> dict[str, Any]:
    job_type = str(worker_job.get("job_type") or "")
    job_run_id = int(worker_job["job_run_id"]) if worker_job.get("job_run_id") else None
    payload = _payload(worker_job)
    args = _args(payload)

    if job_type == "artifact-index":
        artifact_id = _required_int(payload.get("artifact_id"), "artifact_id")
        if str(payload.get("action") or "index") == "remove":
            return remove_artifact_index(conn, artifact_id)
        return index_artifact(
            conn,
            settings,
            artifact_id,
            expected_content_hash=clean_unicode(str(payload.get("content_hash") or "")).strip(),
        )

    if job_type == "artifact-index-backfill":
        return backfill_search_indexes(conn, settings)

    if job_type == "experiment-report-index":
        artifact_id = _required_int(payload.get("artifact_id"), "artifact_id")
        return index_experiment_report(conn, settings, artifact_id)

    if job_type == "library-paper-index":
        paper_id = _required_int(payload.get("paper_id"), "paper_id")
        return index_library_paper(conn, settings, paper_id)

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

    if job_type == "knowledge-document-index":
        return index_knowledge_document(
            conn,
            settings,
            document_id=_required_int(payload.get("document_id"), "document_id"),
            project_id=_required_int(payload.get("project_id"), "project_id"),
            expected_content_hash=clean_unicode(str(payload.get("content_hash") or "")).strip(),
        )

    if job_type == "artifact-export-obsidian":
        artifact_id = _required_int(payload.get("artifact_id"), "artifact_id")
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        return export_artifact(conn, settings, artifact_id, body)

    if job_type == "reader-import-upload":
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        result = import_reader_pdfs(conn, settings, body)
        return _reader_import_result_or_raise(result, "PDF import failed")

    if job_type == "reader-import-url":
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        result = import_reader_urls(conn, settings, body)
        return _reader_import_result_or_raise(result, "URL import failed")

    if job_type == "reader-import-web":
        body = payload.get("body") if isinstance(payload.get("body"), dict) else payload
        result = import_reader_webpages(conn, settings, body)
        return _reader_import_result_or_raise(result, "Webpage import failed")

    if job_type == "reader-save-obsidian":
        paper_id = _required_int(payload.get("paper_id"), "paper_id")
        return save_reader_note_to_obsidian(conn, settings, paper_id)

    if job_type == "paper-report":
        return run_paper_report_worker_job(conn, settings, worker_job)

    dispatcher = DISPATCHERS.get(job_type)
    if not dispatcher:
        raise RuntimeError(f"Unsupported worker job type: {job_type}")
    return dispatcher(
        conn,
        settings,
        job_id=job_run_id,
        track_job_run=bool(job_run_id),
    )


def run_once(worker_id: str, on_job_change=None) -> dict[str, Any]:
    os.environ.setdefault("KRIS_WORKER_OUTBOX_EVENTS", "1")
    base_settings = load_settings()
    conn = connect()
    try:
        claimed = claim_next_worker_job(conn, worker_id)
        if not claimed:
            return {"claimed": False}
        worker_job = claimed["worker_job"]
        lease_attempt = int(worker_job.get("attempts") or 1)
        if on_job_change:
            on_job_change((int(worker_job["id"]), lease_attempt))
        handler_started_at = time.perf_counter()
        _log_job_observation("worker_job.running", worker_job, worker_id)
        try:
            settings = apply_stored_settings(conn, base_settings)
            cancellation = cancel_worker_job_before_dispatch(
                conn,
                int(worker_job["id"]),
                worker_id=worker_id,
                lease_attempt=lease_attempt,
            )
            if cancellation.get("cancelled"):
                cancelled_job = cancellation["worker_job"] or worker_job
                _log_job_observation(
                    "worker_job.cancelled",
                    cancelled_job,
                    worker_id,
                    handler_duration_seconds=0,
                )
                return {"claimed": True, "worker_job": cancelled_job, "cancelled": True}
            try:
                result = dispatch_worker_job(conn, settings, worker_job)
            except Exception as exc:
                if str(worker_job.get("job_type") or "") == "paper-report":
                    terminal_status, domain_events = stage_paper_report_terminal_failure(conn, worker_job, exc)
                    if terminal_status == "cancelled":
                        cancelled = cancel_worker_job_before_dispatch(
                            conn,
                            int(worker_job["id"]),
                            worker_id=worker_id,
                            lease_attempt=lease_attempt,
                            message=str(exc) or "Paper report generation cancelled",
                            domain_events=domain_events,
                        )
                        cancelled_job = cancelled["worker_job"] or worker_job
                        _log_job_observation(
                            "worker_job.cancelled",
                            cancelled_job,
                            worker_id,
                            handler_duration_seconds=time.perf_counter() - handler_started_at,
                        )
                        return {"claimed": True, "worker_job": cancelled_job, "cancelled": True}
                    if terminal_status == "superseded":
                        result = {"paper_id": _optional_int(_payload(worker_job).get("paper_id")), "superseded": True}
                        completed = complete_worker_job(
                            conn,
                            int(worker_job["id"]),
                            result,
                            message="paper-report superseded",
                            worker_id=worker_id,
                            lease_attempt=lease_attempt,
                        )
                        return {"claimed": True, "worker_job": completed["worker_job"] or worker_job, "result": result}
                    failed = fail_worker_job(
                        conn,
                        int(worker_job["id"]),
                        str(exc),
                        worker_id=worker_id,
                        lease_attempt=lease_attempt,
                        domain_events=domain_events,
                    )
                    failed_job = failed["worker_job"] or worker_job
                    _log_job_observation(
                        "worker_job.failed",
                        failed_job,
                        worker_id,
                        handler_duration_seconds=time.perf_counter() - handler_started_at,
                    )
                    raise
                notification = _reader_import_notification(worker_job, error_message=str(exc))
                failed = fail_worker_job(
                    conn,
                    int(worker_job["id"]),
                    str(exc),
                    worker_id=worker_id,
                    lease_attempt=lease_attempt,
                    event_extra={"notification": notification} if notification else None,
                    domain_events=_knowledge_index_domain_events(
                        worker_job,
                        index_status=str(getattr(exc, "knowledge_index_status", "failed")),
                        error=str(exc),
                    ),
                )
                failed_job = failed["worker_job"] or worker_job
                _log_job_observation(
                    "worker_job.failed",
                    failed_job,
                    worker_id,
                    handler_duration_seconds=time.perf_counter() - handler_started_at,
                )
                raise
            result_domain_events = result.pop("domain_events", []) if isinstance(result.get("domain_events"), list) else []
            completed = complete_worker_job(
                conn,
                int(worker_job["id"]),
                result,
                message=str(result.get("message") or f"{worker_job['job_type']} completed"),
                worker_id=worker_id,
                lease_attempt=lease_attempt,
                domain_events=[
                    *_knowledge_index_domain_events(
                        worker_job,
                        index_status=str(result.get("index_status") or "ready"),
                        document_id=_optional_int(result.get("document_id")),
                    ),
                    *result_domain_events,
                ],
            )
            completed_job = completed["worker_job"] or worker_job
            _publish_project_domain_events(conn, worker_job, result)
            _publish_artifact_domain_events(conn, worker_job, result)
            _publish_reader_domain_events(conn, worker_job, result)
            _publish_paper_domain_events(conn, worker_job, result)
            _log_job_observation(
                "worker_job.completed",
                completed_job,
                worker_id,
                handler_duration_seconds=time.perf_counter() - handler_started_at,
            )
            return {"claimed": True, "worker_job": completed_job, "result": result}
        finally:
            if on_job_change:
                on_job_change(None)
    finally:
        conn.close()


def main() -> int:
    worker_id = _worker_id()
    poll_interval_ms = _env_int("KRIS_WORKER_POLL_INTERVAL_MS", 1000, minimum=100)
    stale_after_seconds = _env_int("KRIS_WORKER_JOB_STALE_AFTER_SECONDS", 90, minimum=60)
    stale_recovery_interval_seconds = _env_int(
        "KRIS_WORKER_STALE_RECOVERY_INTERVAL_SECONDS",
        30,
        minimum=1,
    )
    os.environ.setdefault("KRIS_WORKER_OUTBOX_EVENTS", "1")
    if _env_flag("KRIS_WORKER_INIT_DB_ON_START", True):
        load_settings()
        conn = connect()
        try:
            init_db(conn)
            cleanup_stale_worker_jobs(
                conn,
                stale_after_seconds=stale_after_seconds,
            )
        finally:
            conn.close()
    heartbeat = WorkerHeartbeat(
        worker_id,
        _env_int("KRIS_WORKER_HEARTBEAT_INTERVAL_SECONDS", 5, minimum=1),
    )
    stale_recovery = WorkerStaleRecovery(stale_recovery_interval_seconds, stale_after_seconds)
    drain_requested = threading.Event()

    def request_drain(signum: int, _frame: Any) -> None:
        if not drain_requested.is_set():
            print(f"KRIS worker drain requested by signal {signum}: {worker_id}", flush=True)
        drain_requested.set()
        heartbeat.begin_draining()

    previous_signal_handlers: dict[signal.Signals, Any] = {}
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        previous_signal_handlers[handled_signal] = signal.getsignal(handled_signal)
        signal.signal(handled_signal, request_drain)
    heartbeat.start()
    stale_recovery.start()
    print(f"KRIS worker service started: {worker_id}", flush=True)
    try:
        while not drain_requested.is_set():
            try:
                result = run_once(worker_id, heartbeat.set_current_job)
                if not result.get("claimed"):
                    drain_requested.wait(poll_interval_ms / 1000)
            except KeyboardInterrupt:
                heartbeat.begin_draining()
                return 0
            except Exception:
                traceback.print_exc(file=sys.stderr)
                drain_requested.wait(poll_interval_ms / 1000)
        return 0
    finally:
        for handled_signal, previous_handler in previous_signal_handlers.items():
            signal.signal(handled_signal, previous_handler)
        stale_recovery.stop()
        heartbeat.stop()


if __name__ == "__main__":
    raise SystemExit(main())
