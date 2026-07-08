from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .db import from_json, to_json, utc_now


def _row_to_worker_job(row: Any | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": int(row["id"]),
        "job_run_id": int(row["job_run_id"]) if row["job_run_id"] is not None else None,
        "job_type": row["job_type"],
        "status": row["status"],
        "priority": int(row["priority"] or 0),
        "payload": from_json(row["payload_json"], {}),
        "result": from_json(row["result_json"], {}),
        "error_message": row["error_message"] or "",
        "attempts": int(row["attempts"] or 0),
        "max_attempts": int(row["max_attempts"] or 1),
        "run_after": row["run_after"],
        "locked_by": row["locked_by"] or "",
        "locked_at": row["locked_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


def _row_to_job_run(row: Any | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": int(row["id"]),
        "job_type": row["job_type"],
        "status": row["status"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "message": row["message"] or "",
        "pid": row["pid"],
        "heartbeat_at": row["heartbeat_at"],
        "meta": from_json(row["meta_json"], {}),
    }


def _worker_job_select_columns() -> str:
    return """
      id, job_run_id, job_type, status, priority, payload_json, result_json,
      error_message, attempts, max_attempts, run_after, locked_by, locked_at,
      created_at, updated_at, started_at, finished_at
    """


def _job_run_select_columns() -> str:
    return "id, job_type, status, started_at, finished_at, message, pid, heartbeat_at, meta_json"


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


_TASK_RESULT_MISSING = object()


def _compact_task_result(result: Any) -> Any:
    if not isinstance(result, dict):
        return result if result is not None else None
    summary = {}
    for key in ("ok", "message", "stats", "created", "updated", "skipped", "errors"):
        if key in result:
            summary[key] = result[key]
    return summary or None


def task_event_payload(
    worker_job: dict[str, Any],
    status: str,
    *,
    message: str = "",
    result: Any = _TASK_RESULT_MISSING,
    stale: bool = False,
) -> dict[str, Any]:
    payload = worker_job.get("payload") if isinstance(worker_job.get("payload"), dict) else {}
    args = payload.get("args") if isinstance(payload.get("args"), list) else []
    task = {
        "id": worker_job.get("job_run_id") or worker_job.get("job_id") or worker_job.get("id"),
        "worker_job_id": worker_job.get("worker_job_id") or (
            worker_job.get("id") if worker_job.get("job_run_id") else None
        ),
        "command": payload.get("command") or worker_job.get("command") or worker_job.get("job_type"),
        "source": payload.get("source") or worker_job.get("source") or None,
        "args": [str(item) for item in args],
        "status": status or worker_job.get("status") or "running",
        "started_at": worker_job.get("started_at"),
        "finished_at": worker_job.get("finished_at"),
        "message": message or worker_job.get("message") or worker_job.get("error_message") or None,
    }
    if result is not _TASK_RESULT_MISSING:
        task["result"] = _compact_task_result(result)
    payload_out = {
        "task": {
            key: task[key]
            for key in (
                "id",
                "worker_job_id",
                "command",
                "source",
                "args",
                "status",
                "started_at",
                "finished_at",
                "message",
            )
        }
    }
    if "result" in task:
        payload_out["task"]["result"] = task["result"]
    if stale:
        payload_out["stale"] = True
    return payload_out


def insert_app_event(
    conn: Any,
    event_type: str,
    payload: dict[str, Any],
    *,
    created_at: str | None = None,
    commit: bool = True,
) -> dict[str, Any]:
    created = created_at or utc_now()
    cur = conn.execute(
        """
        INSERT INTO app_events(event_type, payload_json, created_at)
        VALUES (?, ?, ?)
        """,
        (str(event_type), to_json(payload or {}), created),
    )
    if commit:
        conn.commit()
    return {
        "id": int(cur.lastrowid),
        "event_type": str(event_type),
        "payload": payload or {},
        "created_at": created,
        "published_at": None,
    }


def claim_next_worker_job(conn: Any, worker_id: str, *, now: str | None = None) -> dict[str, Any] | None:
    claimed_at = now or utc_now()
    try:
        row = conn.execute(
            f"""
            SELECT {_worker_job_select_columns()}
            FROM worker_jobs
            WHERE status = 'queued'
              AND attempts < max_attempts
              AND (run_after IS NULL OR run_after <= ?)
            ORDER BY priority DESC, run_after NULLS FIRST, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            """,
            (claimed_at,),
        ).fetchone()
        if not row:
            conn.commit()
            return None
        updated = conn.execute(
            f"""
            UPDATE worker_jobs
            SET status = 'running',
                attempts = attempts + 1,
                locked_by = ?,
                locked_at = ?,
                started_at = COALESCE(started_at, ?),
                updated_at = ?
            WHERE id = ?
            RETURNING {_worker_job_select_columns()}
            """,
            (worker_id, claimed_at, claimed_at, claimed_at, int(row["id"])),
        ).fetchone()
        worker_job = _row_to_worker_job(updated)
        job_run = None
        if worker_job and worker_job.get("job_run_id"):
            job_run = conn.execute(
                f"""
                UPDATE job_runs
                SET status = 'running',
                    message = ?,
                    heartbeat_at = ?
                WHERE id = ?
                RETURNING {_job_run_select_columns()}
                """,
                (f"Claimed by worker {worker_id}", claimed_at, int(worker_job["job_run_id"])),
            ).fetchone()
        conn.commit()
        return {"worker_job": worker_job, "job_run": _row_to_job_run(job_run)}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def cleanup_stale_worker_jobs(
    conn: Any,
    *,
    stale_after_seconds: int = 30 * 60,
    limit: int = 100,
    now: str | None = None,
) -> dict[str, int]:
    now_text = now or utc_now()
    parsed_now = _parse_timestamp(now_text) or datetime.now(timezone.utc)
    cutoff = (parsed_now - timedelta(seconds=max(1, int(stale_after_seconds)))).isoformat(timespec="seconds")
    try:
        rows = conn.execute(
            f"""
            SELECT {_worker_job_select_columns()}
            FROM worker_jobs
            WHERE status = 'running'
              AND (locked_at IS NULL OR locked_at < ?)
            ORDER BY locked_at NULLS FIRST, id
            FOR UPDATE SKIP LOCKED
            LIMIT ?
            """,
            (cutoff, max(1, int(limit))),
        ).fetchall()
        result = {
            "stale_worker_jobs_checked": len(rows),
            "stale_worker_jobs_requeued": 0,
            "stale_worker_jobs_failed": 0,
        }
        for row in rows:
            current = _row_to_worker_job(row)
            if not current:
                continue
            attempts = int(current.get("attempts") or 0)
            max_attempts = int(current.get("max_attempts") or 1)
            exhausted = attempts >= max_attempts
            message = (
                f"Marked stale worker job failed after {attempts}/{max_attempts} attempts"
                if exhausted
                else f"Requeued stale worker job after {attempts}/{max_attempts} attempts"
            )
            if exhausted:
                updated = conn.execute(
                    f"""
                    UPDATE worker_jobs
                    SET status = 'failed',
                        error_message = ?,
                        locked_by = '',
                        locked_at = NULL,
                        finished_at = ?,
                        updated_at = ?
                    WHERE id = ?
                    RETURNING {_worker_job_select_columns()}
                    """,
                    (message, now_text, now_text, int(current["id"])),
                ).fetchone()
                worker_job = _row_to_worker_job(updated)
                if worker_job and worker_job.get("job_run_id"):
                    conn.execute(
                        """
                        UPDATE job_runs
                        SET status = 'failed',
                            finished_at = ?,
                            message = ?,
                            heartbeat_at = ?
                        WHERE id = ?
                        """,
                        (now_text, message, now_text, int(worker_job["job_run_id"])),
                    )
                insert_app_event(
                    conn,
                    "task.failed",
                    task_event_payload(worker_job or current, "failed", message=message, stale=True),
                    created_at=now_text,
                    commit=False,
                )
                result["stale_worker_jobs_failed"] += 1
            else:
                updated = conn.execute(
                    f"""
                    UPDATE worker_jobs
                    SET status = 'queued',
                        error_message = '',
                        locked_by = '',
                        locked_at = NULL,
                        updated_at = ?
                    WHERE id = ?
                    RETURNING {_worker_job_select_columns()}
                    """,
                    (now_text, int(current["id"])),
                ).fetchone()
                worker_job = _row_to_worker_job(updated)
                if worker_job and worker_job.get("job_run_id"):
                    conn.execute(
                        """
                        UPDATE job_runs
                        SET status = 'queued',
                            message = ?,
                            heartbeat_at = ?
                        WHERE id = ?
                        """,
                        (message, now_text, int(worker_job["job_run_id"])),
                    )
                insert_app_event(
                    conn,
                    "task.started",
                    task_event_payload(worker_job or current, "queued", message=message, stale=True),
                    created_at=now_text,
                    commit=False,
                )
                result["stale_worker_jobs_requeued"] += 1
        conn.commit()
        return result
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def complete_worker_job(
    conn: Any,
    worker_job_id: int,
    result: dict[str, Any],
    *,
    message: str = "Worker job completed",
    now: str | None = None,
) -> dict[str, Any]:
    finished = now or utc_now()
    try:
        row = conn.execute(
            f"""
            UPDATE worker_jobs
            SET status = 'completed',
                result_json = ?,
                error_message = '',
                finished_at = ?,
                updated_at = ?
            WHERE id = ?
            RETURNING {_worker_job_select_columns()}
            """,
            (to_json(result or {}), finished, finished, int(worker_job_id)),
        ).fetchone()
        worker_job = _row_to_worker_job(row)
        job_run = None
        if worker_job and worker_job.get("job_run_id"):
            job_run = conn.execute(
                f"""
                UPDATE job_runs
                SET status = 'completed',
                    finished_at = ?,
                    message = ?,
                    heartbeat_at = ?
                WHERE id = ?
                RETURNING {_job_run_select_columns()}
                """,
                (finished, message, finished, int(worker_job["job_run_id"])),
            ).fetchone()
        conn.commit()
        return {"worker_job": worker_job, "job_run": _row_to_job_run(job_run)}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def fail_worker_job(conn: Any, worker_job_id: int, error_message: str, *, now: str | None = None) -> dict[str, Any]:
    finished = now or utc_now()
    message = str(error_message or "Worker job failed")
    try:
        row = conn.execute(
            f"""
            UPDATE worker_jobs
            SET status = 'failed',
                error_message = ?,
                finished_at = ?,
                updated_at = ?
            WHERE id = ?
            RETURNING {_worker_job_select_columns()}
            """,
            (message, finished, finished, int(worker_job_id)),
        ).fetchone()
        worker_job = _row_to_worker_job(row)
        job_run = None
        if worker_job and worker_job.get("job_run_id"):
            job_run = conn.execute(
                f"""
                UPDATE job_runs
                SET status = 'failed',
                    finished_at = ?,
                    message = ?,
                    heartbeat_at = ?
                WHERE id = ?
                RETURNING {_job_run_select_columns()}
                """,
                (finished, message, finished, int(worker_job["job_run_id"])),
            ).fetchone()
        conn.commit()
        return {"worker_job": worker_job, "job_run": _row_to_job_run(job_run)}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
