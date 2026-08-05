from __future__ import annotations

from datetime import datetime, timedelta, timezone
import threading
from typing import Any

from .db import from_json, to_json, utc_now
from .job_policy import policy_aging_seconds, resolve_worker_job_policy, worker_job_policy


_LOCAL_CLAIM_LOCK = threading.RLock()


def _sync_stale_paper_report_domain(
    conn: Any,
    worker_job: dict[str, Any],
    status: str,
    message: str,
    now: str,
) -> None:
    if str(worker_job.get("job_type") or "") != "paper-report":
        return
    payload = worker_job.get("payload") if isinstance(worker_job.get("payload"), dict) else {}
    paper_id = int(payload.get("paper_id") or 0)
    if paper_id <= 0:
        return
    generation_id = str(payload.get("generation_id") or "").strip()
    row = conn.execute(
        """
        SELECT id, title, content_json, created_at
        FROM artifacts
        WHERE scope_type = 'paper' AND scope_id = ? AND artifact_type = 'paper_report'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1 FOR UPDATE
        """,
        (paper_id,),
    ).fetchone()
    if not row:
        return
    content = from_json(row["content_json"], {})
    if not isinstance(content, dict):
        content = {}
    if generation_id and str(content.get("generation_id") or "") != generation_id:
        return
    content["error_message"] = message if status == "failed" else ""
    if status == "queued":
        content["started_at"] = None
        content["finished_at"] = None
    else:
        content["finished_at"] = now
    conn.execute(
        "UPDATE artifacts SET status = ?, content_json = ?, updated_at = ? WHERE id = ?",
        (status, to_json(content), now, int(row["id"])),
    )
    report = {
        "paper_id": paper_id,
        "artifact_id": int(row["id"]),
        "status": status,
        "error_message": content.get("error_message") or "",
        "updated_at": now,
    }
    insert_app_event(
        conn,
        "paper_report.updated",
        {
            "paper": {
                "paper_id": paper_id,
                "id": paper_id,
                "title": row["title"] or None,
                "report_status": status,
                "updated_at": now,
            },
            "paper_report": report,
            "paper_id": paper_id,
            "artifact_id": int(row["id"]),
            "status": status,
            "project_ids": [],
            "stale": True,
        },
        created_at=now,
        commit=False,
    )


def _row_to_worker_job(row: Any | None) -> dict[str, Any] | None:
    if not row:
        return None
    def optional(key: str, default: Any = None) -> Any:
        try:
            return row[key]
        except (KeyError, IndexError):
            return default
    payload = from_json(row["payload_json"], {})
    try:
        fallback_policy = resolve_worker_job_policy(str(row["job_type"] or ""), payload)
    except RuntimeError:
        fallback_policy = {}
    return {
        "id": int(row["id"]),
        "job_run_id": int(row["job_run_id"]) if row["job_run_id"] is not None else None,
        "job_type": row["job_type"],
        "status": row["status"],
        "priority": int(row["priority"] or 0),
        "payload": payload,
        "result": from_json(row["result_json"], {}),
        "error_message": row["error_message"] or "",
        "attempts": int(row["attempts"] or 0),
        "max_attempts": int(row["max_attempts"] or 1),
        "concurrency_group": optional("concurrency_group", fallback_policy.get("concurrency_group", "")) or "",
        "concurrency_key": optional("concurrency_key", fallback_policy.get("concurrency_key", "")) or "",
        "policy_version": int(optional("policy_version", fallback_policy.get("policy_version", 0)) or 0),
        "run_after": row["run_after"],
        "locked_by": row["locked_by"] or "",
        "locked_at": row["locked_at"],
        "cancel_requested_at": row["cancel_requested_at"],
        "cancel_reason": row["cancel_reason"] or "",
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
      concurrency_group, concurrency_key, policy_version,
      cancel_requested_at, cancel_reason, created_at, updated_at, started_at, finished_at
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


def _required_worker_id(worker_id: str) -> str:
    normalized = str(worker_id or "").strip()
    if not normalized:
        raise ValueError("worker_id is required")
    return normalized


def _required_lease_attempt(lease_attempt: int) -> int:
    normalized = int(lease_attempt or 0)
    if normalized < 1:
        raise ValueError("lease_attempt must be a positive integer")
    return normalized


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
    worker_job_id = worker_job.get("worker_job_id") or worker_job.get("id")
    job_run_id = worker_job.get("job_run_id") or worker_job.get("job_id")
    task = {
        "id": job_run_id or worker_job_id,
        "worker_job_id": worker_job_id,
        "job_run_id": job_run_id,
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
                "job_run_id",
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


def enqueue_worker_job(
    conn: Any,
    job_type: str,
    payload: dict[str, Any],
    *,
    message: str | None = None,
    now: str | None = None,
    commit: bool = False,
) -> dict[str, Any]:
    """Insert a child job and its queued outbox event in one transaction."""
    queued_at = now or utc_now()
    normalized_job_type = str(job_type or "").strip()
    if not normalized_job_type:
        raise ValueError("job_type is required")
    resolved = resolve_worker_job_policy(normalized_job_type, payload)
    try:
        if resolved.get("deduplicate_active") and resolved.get("concurrency_key"):
            if getattr(conn, "dialect", "") == "postgres":
                conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                    (f"worker-enqueue:{resolved['concurrency_key']}",),
                )
            existing_row = conn.execute(
                f"""
                SELECT {_worker_job_select_columns()}
                FROM worker_jobs
                WHERE job_type = ? AND concurrency_key = ? AND status IN ('queued', 'running')
                ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, id
                LIMIT 1
                """,
                (normalized_job_type, str(resolved["concurrency_key"])),
            ).fetchone()
            existing = _row_to_worker_job(existing_row)
            if existing:
                existing["deduplicated"] = True
                if commit:
                    conn.commit()
                return existing
        row = conn.execute(
            f"""
            INSERT INTO worker_jobs(
              job_run_id, job_type, status, priority, payload_json, max_attempts,
              concurrency_group, concurrency_key, policy_version, created_at, updated_at
            ) VALUES (NULL, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING {_worker_job_select_columns()}
            """,
            (
                normalized_job_type,
                int(resolved["priority"]),
                to_json(payload or {}),
                int(resolved["default_max_attempts"]),
                str(resolved["concurrency_group"]),
                str(resolved["concurrency_key"]),
                int(resolved["policy_version"]),
                queued_at,
                queued_at,
            ),
        ).fetchone()
        worker_job = _row_to_worker_job(row)
        if not worker_job:
            raise RuntimeError(f"Failed to enqueue worker job: {normalized_job_type}")
        worker_job["deduplicated"] = False
        insert_app_event(
            conn,
            "task.started",
            task_event_payload(
                worker_job,
                "queued",
                message=message or f"{normalized_job_type} queued",
            ),
            created_at=queued_at,
            commit=False,
        )
        if commit:
            conn.commit()
        return worker_job
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def rebind_worker_job_policy(
    conn: Any, worker_job_id: int, job_type: str, payload: dict[str, Any], *, now: str | None = None,
    status_scope: str = "queued",
) -> bool:
    if status_scope not in {"queued", "active"}:
        raise ValueError(f"Unsupported worker job policy rebind scope: {status_scope}")
    resolved = resolve_worker_job_policy(job_type, payload)
    status_filter = "AND status = 'queued'" if status_scope == "queued" else "AND status IN ('queued', 'running')"
    changed = conn.execute(
        f"""
        UPDATE worker_jobs
        SET payload_json = ?, priority = ?, max_attempts = ?, concurrency_group = ?,
            concurrency_key = ?, policy_version = ?, updated_at = ?
        WHERE id = ? {status_filter}
        RETURNING id
        """,
        (
            to_json(payload or {}), int(resolved["priority"]), int(resolved["default_max_attempts"]),
            str(resolved["concurrency_group"]), str(resolved["concurrency_key"]),
            int(resolved["policy_version"]), now or utc_now(), int(worker_job_id),
        ),
    ).fetchone()
    return bool(changed)


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


def heartbeat_worker(
    conn: Any,
    worker_id: str,
    *,
    status: str = "idle",
    started_at: str | None = None,
    current_job_id: int | None = None,
    pid: int | None = None,
    meta: dict[str, Any] | None = None,
    now: str | None = None,
    commit: bool = True,
) -> dict[str, Any]:
    heartbeat_at = now or utc_now()
    started = started_at or heartbeat_at
    row = conn.execute(
        """
        INSERT INTO worker_instances(
          worker_id, status, started_at, heartbeat_at, current_job_id, pid, meta_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET
          status = EXCLUDED.status,
          heartbeat_at = EXCLUDED.heartbeat_at,
          current_job_id = EXCLUDED.current_job_id,
          pid = EXCLUDED.pid,
          meta_json = EXCLUDED.meta_json
        RETURNING worker_id, status, started_at, heartbeat_at, current_job_id, pid, meta_json
        """,
        (
            str(worker_id),
            str(status or "idle"),
            started,
            heartbeat_at,
            current_job_id,
            pid,
            to_json(meta or {}),
        ),
    ).fetchone()
    if commit:
        conn.commit()
    return {
        "worker_id": row["worker_id"],
        "status": row["status"],
        "started_at": row["started_at"],
        "heartbeat_at": row["heartbeat_at"],
        "current_job_id": int(row["current_job_id"]) if row["current_job_id"] is not None else None,
        "pid": int(row["pid"]) if row["pid"] is not None else None,
        "meta": from_json(row["meta_json"], {}),
    }


def heartbeat_worker_job(
    conn: Any,
    worker_id: str,
    worker_job_id: int,
    lease_attempt: int,
    *,
    now: str | None = None,
    commit: bool = True,
) -> bool:
    heartbeat_at = now or utc_now()
    normalized_worker_id = _required_worker_id(worker_id)
    normalized_lease_attempt = _required_lease_attempt(lease_attempt)
    row = conn.execute(
        """
        UPDATE worker_jobs
        SET locked_at = ?, updated_at = ?
        WHERE id = ?
          AND status = 'running'
          AND locked_by = ?
          AND attempts = ?
        RETURNING job_run_id
        """,
        (
            heartbeat_at,
            heartbeat_at,
            int(worker_job_id),
            normalized_worker_id,
            normalized_lease_attempt,
        ),
    ).fetchone()
    if row and row["job_run_id"] is not None:
        conn.execute(
            "UPDATE job_runs SET heartbeat_at = ? WHERE id = ?",
            (heartbeat_at, int(row["job_run_id"])),
        )
    if commit:
        conn.commit()
    return bool(row)


def claim_next_worker_job(conn: Any, worker_id: str, *, now: str | None = None) -> dict[str, Any] | None:
    claimed_at = now or utc_now()
    normalized_worker_id = _required_worker_id(worker_id)
    is_postgres = getattr(conn, "dialect", "") == "postgres"
    is_sqlite = conn.__class__.__module__ == "sqlite3"
    if not is_postgres:
        _LOCAL_CLAIM_LOCK.acquire()
    try:
        def candidates():
            if not is_postgres and not is_sqlite:
                item = conn.execute(
                    f"""SELECT {_worker_job_select_columns()} FROM worker_jobs
                    WHERE status = 'queued' AND cancel_requested_at IS NULL AND attempts < max_attempts
                      AND (run_after IS NULL OR run_after <= ?)
                    ORDER BY priority DESC, run_after NULLS FIRST, id LIMIT 1""",
                    (claimed_at,),
                ).fetchone()
                if item:
                    yield item
                return
            if not is_postgres:
                for item in conn.execute(
                f"""
                SELECT {_worker_job_select_columns()} FROM worker_jobs
                WHERE status = 'queued' AND cancel_requested_at IS NULL AND attempts < max_attempts
                  AND (run_after IS NULL OR run_after <= ?)
                ORDER BY (priority + CAST(((julianday(?) - julianday(created_at)) * 86400) / ? AS INTEGER)) DESC,
                         priority DESC, id
                """,
                    (claimed_at, claimed_at, policy_aging_seconds()),
                ).fetchall():
                    yield item
                return
            offset = 0
            while True:
                page = conn.execute(
                    f"""
                    SELECT {_worker_job_select_columns()}
                    FROM worker_jobs
                    WHERE status = 'queued' AND cancel_requested_at IS NULL AND attempts < max_attempts
                      AND (run_after IS NULL OR run_after <= ?)
                    ORDER BY (priority + FLOOR(EXTRACT(EPOCH FROM (?::timestamptz - NULLIF(created_at, '')::timestamptz)) / ?)) DESC,
                             priority DESC, run_after NULLS FIRST, id
                    LIMIT 100 OFFSET ?
                    """,
                    (claimed_at, claimed_at, policy_aging_seconds(), offset),
                ).fetchall()
                if not page:
                    break
                yield from page
                offset += len(page)
                if len(page) < 100:
                    break
        row = None
        for candidate in candidates():
            candidate_job = _row_to_worker_job(candidate) or {}
            group = str(candidate_job.get("concurrency_group") or "")
            key = str(candidate_job.get("concurrency_key") or "")
            try:
                policy = worker_job_policy(str(candidate_job.get("job_type") or ""))
            except RuntimeError:
                continue
            if not is_postgres and not is_sqlite:
                row = candidate
                break
            if not is_postgres:
                occupied = conn.execute(
                    "SELECT COUNT(*) AS count FROM worker_jobs WHERE status = 'running' AND concurrency_group = ?",
                    (group,),
                ).fetchone()
                duplicate = key and conn.execute(
                    "SELECT 1 AS present FROM worker_jobs WHERE status = 'running' AND concurrency_key = ? LIMIT 1",
                    (key,),
                ).fetchone()
                if int(occupied["count"] or 0) < int(policy["max_running"]) and not duplicate:
                    row = candidate
                    break
                continue
            conn.execute("SAVEPOINT claim_candidate")
            def abandon_candidate() -> None:
                conn.execute("ROLLBACK TO SAVEPOINT claim_candidate")
                conn.execute("RELEASE SAVEPOINT claim_candidate")
            conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 76103))",
                (f"worker-group:{group}",),
            )
            if key:
                conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(?, 76104))",
                    (f"worker-key:{key}",),
                )
            locked = conn.execute(
                f"SELECT {_worker_job_select_columns()} FROM worker_jobs WHERE id = ? AND status = 'queued' FOR UPDATE SKIP LOCKED",
                (int(candidate["id"]),),
            ).fetchone()
            if not locked:
                abandon_candidate()
                continue
            occupied = conn.execute(
                "SELECT COUNT(*) AS count FROM worker_jobs WHERE status = 'running' AND concurrency_group = ?",
                (group,),
            ).fetchone()
            if int(occupied["count"] or 0) >= int(policy["max_running"]):
                abandon_candidate()
                continue
            if key:
                duplicate = conn.execute(
                    "SELECT 1 AS present FROM worker_jobs WHERE status = 'running' AND concurrency_key = ? LIMIT 1",
                    (key,),
                ).fetchone()
                if duplicate:
                    abandon_candidate()
                    continue
            conn.execute("RELEASE SAVEPOINT claim_candidate")
            row = locked
            break
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
              AND status = 'queued'
              AND cancel_requested_at IS NULL
            RETURNING {_worker_job_select_columns()}
            """,
            (normalized_worker_id, claimed_at, claimed_at, claimed_at, int(row["id"])),
        ).fetchone()
        worker_job = _row_to_worker_job(updated)
        if not worker_job:
            conn.rollback()
            return None
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
                (f"Claimed by worker {normalized_worker_id}", claimed_at, int(worker_job["job_run_id"])),
            ).fetchone()
        insert_app_event(
            conn,
            "task.started",
            task_event_payload(
                worker_job,
                "running",
                message=f"Claimed by worker {normalized_worker_id}",
            ),
            created_at=claimed_at,
            commit=False,
        )
        conn.commit()
        return {"worker_job": worker_job, "job_run": _row_to_job_run(job_run)}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise

    finally:
        if not is_postgres:
            _LOCAL_CLAIM_LOCK.release()


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
            LIMIT ?
            """,
            (cutoff, max(1, int(limit))),
        ).fetchall()
        result = {
            "stale_worker_jobs_checked": len(rows),
            "stale_worker_jobs_requeued": 0,
            "stale_worker_jobs_failed": 0,
            "stale_worker_jobs_cancelled": 0,
        }
        for row in rows:
            preview = _row_to_worker_job(row)
            if not preview:
                continue
            preview_payload = preview.get("payload") if isinstance(preview.get("payload"), dict) else {}
            if preview.get("job_type") == "paper-report":
                paper_id = int(preview_payload.get("paper_id") or 0)
                if paper_id > 0 and getattr(conn, "dialect", "") == "postgres":
                    conn.execute("SELECT pg_advisory_xact_lock(724023, ?)", (paper_id,))
            locked = conn.execute(
                f"""
                SELECT {_worker_job_select_columns()}
                FROM worker_jobs
                WHERE id = ? AND status = 'running'
                  AND (locked_at IS NULL OR locked_at < ?)
                FOR UPDATE SKIP LOCKED
                """,
                (int(preview["id"]), cutoff),
            ).fetchone()
            current = _row_to_worker_job(locked)
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
            if current.get("cancel_requested_at"):
                message = str(current.get("cancel_reason") or "Worker job cancelled")
                updated = conn.execute(
                    f"""
                    UPDATE worker_jobs
                    SET status = 'cancelled',
                        error_message = '',
                        locked_by = '',
                        locked_at = NULL,
                        finished_at = ?,
                        updated_at = ?
                    WHERE id = ?
                      AND status = 'running'
                      AND attempts = ?
                    RETURNING {_worker_job_select_columns()}
                    """,
                    (now_text, now_text, int(current["id"]), attempts),
                ).fetchone()
                worker_job = _row_to_worker_job(updated)
                if not worker_job:
                    continue
                if worker_job.get("job_run_id"):
                    conn.execute(
                        """
                        UPDATE job_runs
                        SET status = 'cancelled', finished_at = ?, message = ?, heartbeat_at = ?
                        WHERE id = ?
                        """,
                        (now_text, message, now_text, int(worker_job["job_run_id"])),
                    )
                _sync_stale_paper_report_domain(conn, worker_job, "cancelled", message, now_text)
                insert_app_event(
                    conn,
                    "task.cancelled",
                    task_event_payload(worker_job, "cancelled", message=message, stale=True),
                    created_at=now_text,
                    commit=False,
                )
                result["stale_worker_jobs_cancelled"] += 1
            elif exhausted:
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
                _sync_stale_paper_report_domain(conn, worker_job or current, "failed", message, now_text)
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
                _sync_stale_paper_report_domain(conn, worker_job or current, "queued", message, now_text)
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


def _cancel_owned_worker_job(
    conn: Any,
    worker_job_id: int,
    worker_id: str,
    lease_attempt: int,
    *,
    message: str,
    now: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        f"""
        UPDATE worker_jobs
        SET status = 'cancelled',
            error_message = '',
            locked_by = '',
            locked_at = NULL,
            finished_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'running'
          AND locked_by = ?
          AND attempts = ?
          AND cancel_requested_at IS NOT NULL
        RETURNING {_worker_job_select_columns()}
        """,
        (now, now, int(worker_job_id), worker_id, lease_attempt),
    ).fetchone()
    return _row_to_worker_job(row)


def _update_job_run_terminal(
    conn: Any,
    worker_job: dict[str, Any],
    status: str,
    message: str,
    now: str,
) -> dict[str, Any] | None:
    if not worker_job.get("job_run_id"):
        return None
    row = conn.execute(
        f"""
        UPDATE job_runs
        SET status = ?, finished_at = ?, message = ?, heartbeat_at = ?
        WHERE id = ?
        RETURNING {_job_run_select_columns()}
        """,
        (status, now, message, now, int(worker_job["job_run_id"])),
    ).fetchone()
    return _row_to_job_run(row)


def cancel_worker_job_before_dispatch(
    conn: Any,
    worker_job_id: int,
    *,
    worker_id: str,
    lease_attempt: int,
    message: str = "Worker job cancelled",
    domain_events: list[dict[str, Any]] | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    finished = now or utc_now()
    normalized_worker_id = _required_worker_id(worker_id)
    normalized_lease_attempt = _required_lease_attempt(lease_attempt)
    normalized_message = str(message or "Worker job cancelled")
    try:
        worker_job = _cancel_owned_worker_job(
            conn,
            worker_job_id,
            normalized_worker_id,
            normalized_lease_attempt,
            message=normalized_message,
            now=finished,
        )
        if not worker_job:
            current = conn.execute(
                """
                SELECT status, locked_by, attempts, cancel_requested_at
                FROM worker_jobs
                WHERE id = ?
                """,
                (int(worker_job_id),),
            ).fetchone()
            if (
                current
                and current["status"] == "running"
                and str(current["locked_by"] or "") == normalized_worker_id
                and int(current["attempts"] or 0) == normalized_lease_attempt
                and not current["cancel_requested_at"]
            ):
                conn.rollback()
                return {"worker_job": None, "job_run": None, "cancelled": False}
            raise RuntimeError(f"Worker job lease lost before dispatch: {worker_job_id}")
        job_run = _update_job_run_terminal(conn, worker_job, "cancelled", normalized_message, finished)
        insert_app_event(
            conn,
            "task.cancelled",
            task_event_payload(worker_job, "cancelled", message=normalized_message),
            created_at=finished,
            commit=False,
        )
        for event in domain_events or []:
            insert_app_event(
                conn,
                str(event.get("event_type") or ""),
                event.get("payload") if isinstance(event.get("payload"), dict) else {},
                created_at=finished,
                commit=False,
            )
        conn.commit()
        return {"worker_job": worker_job, "job_run": job_run, "cancelled": True}
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
    worker_id: str,
    lease_attempt: int,
    message: str = "Worker job completed",
    domain_events: list[dict[str, Any]] | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    finished = now or utc_now()
    normalized_worker_id = _required_worker_id(worker_id)
    normalized_lease_attempt = _required_lease_attempt(lease_attempt)
    try:
        row = conn.execute(
            f"""
            UPDATE worker_jobs
            SET status = 'completed',
                result_json = ?,
                error_message = '',
                locked_by = '',
                locked_at = NULL,
                finished_at = ?,
                updated_at = ?
            WHERE id = ?
              AND status = 'running'
              AND locked_by = ?
              AND attempts = ?
            RETURNING {_worker_job_select_columns()}
            """,
            (
                to_json(result or {}),
                finished,
                finished,
                int(worker_job_id),
                normalized_worker_id,
                normalized_lease_attempt,
            ),
        ).fetchone()
        worker_job = _row_to_worker_job(row)
        if not worker_job:
            raise RuntimeError(f"Worker job lease lost before completion: {worker_job_id}")
        job_run = _update_job_run_terminal(conn, worker_job, "completed", message, finished)
        insert_app_event(
            conn,
            "task.finished",
            task_event_payload(worker_job, "completed", message=message, result=result),
            created_at=finished,
            commit=False,
        )
        for event in domain_events or []:
            insert_app_event(
                conn,
                str(event.get("event_type") or ""),
                event.get("payload") if isinstance(event.get("payload"), dict) else {},
                created_at=finished,
                commit=False,
            )
        conn.commit()
        return {"worker_job": worker_job, "job_run": job_run, "cancelled": False}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def fail_worker_job(
    conn: Any,
    worker_job_id: int,
    error_message: str,
    *,
    worker_id: str,
    lease_attempt: int,
    event_extra: dict[str, Any] | None = None,
    domain_events: list[dict[str, Any]] | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    finished = now or utc_now()
    message = str(error_message or "Worker job failed")
    normalized_worker_id = _required_worker_id(worker_id)
    normalized_lease_attempt = _required_lease_attempt(lease_attempt)
    try:
        row = conn.execute(
            f"""
            UPDATE worker_jobs
            SET status = 'failed',
                error_message = ?,
                locked_by = '',
                locked_at = NULL,
                finished_at = ?,
                updated_at = ?
            WHERE id = ?
              AND status = 'running'
              AND locked_by = ?
              AND attempts = ?
            RETURNING {_worker_job_select_columns()}
            """,
            (
                message,
                finished,
                finished,
                int(worker_job_id),
                normalized_worker_id,
                normalized_lease_attempt,
            ),
        ).fetchone()
        worker_job = _row_to_worker_job(row)
        if not worker_job:
            raise RuntimeError(f"Worker job lease lost before failure: {worker_job_id}")
        job_run = _update_job_run_terminal(conn, worker_job, "failed", message, finished)
        event_payload = task_event_payload(worker_job, "failed", message=message)
        if event_extra:
            event_payload.update(event_extra)
        insert_app_event(conn, "task.failed", event_payload, created_at=finished, commit=False)
        for event in domain_events or []:
            insert_app_event(
                conn,
                str(event.get("event_type") or ""),
                event.get("payload") if isinstance(event.get("payload"), dict) else {},
                created_at=finished,
                commit=False,
            )
        conn.commit()
        return {"worker_job": worker_job, "job_run": job_run, "cancelled": False}
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
