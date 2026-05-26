from __future__ import annotations

from .db_types import DbConnection
from collections.abc import Callable
from typing import Any

from .db import from_json


NotificationBuilder = Callable[[dict[str, Any]], list[dict[str, Any]]]
REGISTERED_NOTIFICATION_BUILDERS: list[dict[str, Any]] = []

JOB_TITLES = {
    "run-daily": "每日流程",
    "resume-daily": "恢复每日流程",
    "retry-daily": "历史论文补跑",
    "fetch-arxiv": "arXiv 抓取",
    "cache-arxiv-text": "论文正文缓存",
    "generate-paper-reports": "全文报告生成",
    "generate-reports": "每日总报告生成",
    "sync-obsidian": "Obsidian 同步",
    "rank-papers": "论文匹配",
}
DAILY_JOB_TYPES = {"run-daily", "resume-daily", "retry-daily"}


def register_notification_builder(event_type: str, description: str) -> Callable[[NotificationBuilder], NotificationBuilder]:
    def decorator(builder: NotificationBuilder) -> NotificationBuilder:
        REGISTERED_NOTIFICATION_BUILDERS.append(
            {"type": event_type, "description": description, "builder": builder}
        )
        return builder

    return decorator


def _job_title(job_type: str) -> str:
    return JOB_TITLES.get(job_type, job_type or "任务")


def _meta_number(meta: dict[str, Any], keys: list[str]) -> int:
    for key in keys:
        value = int(meta.get(key) or 0)
        if value:
            return value
    return 0


def _safe_int(value: Any) -> int | None:
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _notification(
    notification_id: str,
    notification_type: str,
    severity: str,
    title: str,
    detail: str,
    *,
    created_at: str | None = None,
    source: dict[str, Any] | None = None,
    channels: list[str] | None = None,
    requires_action: bool = False,
    progress: dict[str, Any] | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": notification_id,
        "type": notification_type,
        "severity": severity,
        "title": title,
        "detail": detail,
        "created_at": created_at,
        "source": source or {},
        "channels": channels or ["list"],
        "requires_action": requires_action,
    }
    if progress:
        item["progress"] = progress
    return item


def _activity_time(item: dict[str, Any]) -> str:
    return str(item.get("finished_at") or item.get("started_at") or "")


def _notification_sort_key(item: dict[str, Any]) -> tuple[int, str, int]:
    active_types = {
        "daily_run_recoverable",
        "daily_run_progress",
        "job_running",
        "paper_report_queue_processing",
    }
    severity_rank = {"bad": 3, "warn": 2, "ok": 1, "info": 1, "neutral": 0}
    is_active = 1 if item.get("type") in active_types else 0
    return (
        is_active,
        str(item.get("created_at") or ""),
        severity_rank.get(str(item.get("severity") or ""), 0),
    )


def _activity_rows(conn: DbConnection, limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, job_type, status, started_at, finished_at, message, meta_json
        FROM job_runs
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "job_type": row["job_type"],
            "status": row["status"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "message": row["message"],
            "meta": from_json(row["meta_json"], {}),
        }
        for row in rows
    ]


def _paper_report_stats(conn: DbConnection) -> dict[str, int]:
    stats = {"queued": 0, "processing": 0, "done": 0, "failed": 0, "total": 0}
    for row in conn.execute(
        """
        SELECT status, COUNT(*) AS count
        FROM artifacts
        WHERE scope_type = 'paper'
          AND artifact_type = 'paper_report'
          AND status != 'removed'
        GROUP BY status
        """
    ).fetchall():
        status = str(row["status"] or "")
        count = int(row["count"] or 0)
        stats[status] = count
        stats["total"] += count
    return stats


def _experiment_report_rows(conn: DbConnection, limit: int = 5) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, scope_id, title, source_json, updated_at
        FROM artifacts
        WHERE artifact_type = 'experiment_report'
          AND status != 'removed'
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
        """,
        (max(1, int(limit or 5)),),
    ).fetchall()
    items = []
    for row in rows:
        source_raw = from_json(row["source_json"], {})
        source = source_raw if isinstance(source_raw, dict) else {}
        project_id = _safe_int(source.get("project_id")) or _safe_int(row["scope_id"])
        source_agent = str(source.get("source_agent") or source.get("source") or "").strip()
        items.append(
            {
                "id": int(row["id"]),
                "project_id": project_id,
                "title": row["title"],
                "source_agent": source_agent,
                "updated_at": row["updated_at"],
            }
        )
    return items


def _completed(activities: list[dict[str, Any]], predicate: Callable[[dict[str, Any], dict[str, Any]], bool]) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in activities
            if item["status"] == "completed" and predicate(item.get("meta") or {}, item)
        ),
        None,
    )


def _recoverable_daily_run(conn: DbConnection) -> dict[str, Any] | None:
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
    row = conn.execute(
        """
        SELECT jr.id, jr.job_type, jr.status, jr.started_at, jr.finished_at, jr.message,
               jr.meta_json, drm.mode, drm.source_job_id, drm.arxiv_batch_id
        FROM job_runs jr
        JOIN daily_run_meta drm ON drm.job_id = jr.id
        WHERE jr.job_type IN ('run-daily', 'resume-daily', 'retry-daily')
          AND jr.status = 'failed'
          AND jr.id > ?
          AND EXISTS (
            SELECT 1 FROM daily_run_papers drp
            WHERE drp.job_id = jr.id AND drp.selected = 1
          )
        ORDER BY jr.id DESC
        LIMIT 1
        """,
        (latest_completed_id,),
    ).fetchone()
    if not row:
        return None
    meta = from_json(row["meta_json"], {})
    return {
        "id": int(row["id"]),
        "job_type": row["job_type"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "message": row["message"],
        "meta": meta if isinstance(meta, dict) else {},
    }


def _daily_recovery_payload(job: dict[str, Any]) -> dict[str, Any]:
    progress = job.get("meta", {}).get("daily_progress")
    progress = progress if isinstance(progress, dict) else {}
    steps = progress.get("steps") if isinstance(progress.get("steps"), list) else []
    failed_step = next(
        (step for step in steps if isinstance(step, dict) and step.get("status") == "failed"),
        None,
    )
    completed = int(progress.get("completed") or sum(
        1 for step in steps if isinstance(step, dict) and step.get("status") == "completed"
    ))
    total = int(progress.get("total") or len(steps) or 0)
    return {
        "resumable": True,
        "job_id": int(job["id"]),
        "failed_step": str((failed_step or {}).get("key") or progress.get("current_key") or ""),
        "failed_label": str((failed_step or {}).get("label") or progress.get("current_label") or "未知阶段"),
        "completed": completed,
        "total": total,
        "recommended_action": "resume-daily",
    }


@register_notification_builder("daily_run_progress", "每日流程运行中的步骤进度")
def _daily_run_progress(context: dict[str, Any]) -> list[dict[str, Any]]:
    running_daily = next(
        (
            item
            for item in context["activities"]
            if item["job_type"] in DAILY_JOB_TYPES and item["status"] == "running"
        ),
        None,
    )
    progress = (running_daily or {}).get("meta", {}).get("daily_progress")
    if not running_daily or not progress:
        return []
    current = progress.get("current_label") or "准备中"
    return [
        _notification(
            "daily-run-progress",
            "daily_run_progress",
            "info",
            "每日流程运行中",
            current,
            created_at=running_daily["started_at"],
            source={"job_id": running_daily["id"], "job_type": running_daily["job_type"]},
            progress=progress,
        )
    ]


@register_notification_builder("daily_run_recoverable", "可恢复的失败每日流程")
def _daily_run_recoverable(context: dict[str, Any]) -> list[dict[str, Any]]:
    if any(item.get("type") == "daily_run_progress" for item in context["items"]):
        return []
    recoverable = _recoverable_daily_run(context["conn"])
    if not recoverable:
        return []
    recovery = _daily_recovery_payload(recoverable)
    step_label = recovery["failed_label"]
    count = f"{recovery['completed']}/{recovery['total']}" if recovery["total"] else f"{recovery['completed']} 步"
    return [
        _notification(
            f"daily-run-recoverable-{recoverable['id']}",
            "daily_run_recoverable",
            "warn",
            "每日流程可继续",
            f"上次流程失败在：{step_label}，已完成 {count}，建议继续上次流程。",
            created_at=_activity_time(recoverable),
            source={
                "job_id": recoverable["id"],
                "job_type": recoverable["job_type"],
                "recovery": recovery,
            },
            requires_action=True,
        )
    ]


@register_notification_builder("job_running", "非每日流程任务运行中")
def _job_running(context: dict[str, Any]) -> list[dict[str, Any]]:
    if any(item.get("type") == "daily_run_progress" for item in context["items"]):
        return []
    running = next((item for item in context["activities"] if item["status"] == "running"), None)
    if not running:
        return []
    return [
        _notification(
            f"job-running-{running['id']}",
            "job_running",
            "info",
            "任务运行中",
            _job_title(running["job_type"]),
            created_at=running["started_at"],
            source={"job_id": running["id"], "job_type": running["job_type"]},
        )
    ]


@register_notification_builder("job_failed", "最近失败任务")
def _job_failed(context: dict[str, Any]) -> list[dict[str, Any]]:
    if any(item.get("type") == "daily_run_recoverable" for item in context["items"]):
        return []
    failed = next(
        (
            item
            for item in context["activities"]
            if item["status"] == "failed"
            and not any(
                later["job_type"] == item["job_type"]
                and later["status"] == "completed"
                and later["id"] > item["id"]
                for later in context["activities"]
            )
        ),
        None,
    )
    if not failed:
        return []
    return [
        _notification(
            f"job-failed-{failed['id']}",
            "job_failed",
            "bad",
            "任务失败",
            f"{_job_title(failed['job_type'])} · {failed['message'] or '未记录错误信息'}",
            created_at=_activity_time(failed),
            source={"job_id": failed["id"], "job_type": failed["job_type"]},
        )
    ]


@register_notification_builder("daily_run_completed", "每日流程完成摘要")
def _daily_run_completed(context: dict[str, Any]) -> list[dict[str, Any]]:
    completed_daily = _completed(
        context["activities"],
        lambda _meta, item: item["job_type"] in DAILY_JOB_TYPES,
    )
    if not completed_daily:
        return []
    meta = completed_daily.get("meta") or {}
    parts = []
    new_papers = _meta_number(meta, ["arxiv_papers_inserted", "papers_inserted"])
    project_matches = _meta_number(meta, ["project_paper_matches_created", "daily_report_project_matches"])
    archived = _meta_number(meta, ["zero_match_papers_archived"])
    filtered = _meta_number(meta, ["project_judgments_filtered"])
    paper_reports = _meta_number(meta, ["paper_reports_done"])
    if new_papers:
        parts.append(f"{new_papers} 篇新论文")
    if project_matches:
        parts.append(f"{project_matches} 条项目候选")
    if paper_reports:
        parts.append(f"{paper_reports} 篇全文报告")
    if archived:
        parts.append(f"{archived} 篇 0 命中归档")
    if filtered:
        parts.append(f"{filtered} 条项目判定筛掉")
    if meta.get("daily_report_path"):
        parts.append(f"日报 {meta['daily_report_path']}")
    return [
        _notification(
            f"daily-run-completed-{completed_daily['id']}",
            "daily_run_completed",
            "ok",
            "每日流程已完成",
            "，".join(parts) if parts else completed_daily["message"] or "流程已完成",
            created_at=completed_daily["finished_at"],
            source={"job_id": completed_daily["id"], "job_type": completed_daily["job_type"]},
        )
    ]


@register_notification_builder("arxiv_papers_arrived", "新 arXiv 论文入库")
def _arxiv_papers_arrived(context: dict[str, Any]) -> list[dict[str, Any]]:
    paper_job = _completed(
        context["activities"],
        lambda meta, _item: _meta_number(meta, ["arxiv_papers_inserted", "papers_inserted"]) > 0,
    )
    if not paper_job:
        return []
    count = _meta_number(paper_job["meta"], ["arxiv_papers_inserted", "papers_inserted"])
    return [
        _notification(
            f"arxiv-papers-arrived-{paper_job['id']}",
            "arxiv_papers_arrived",
            "info",
            "新论文到了",
            f"{count} 篇新 arXiv 论文已入库",
            created_at=paper_job["finished_at"],
            source={"job_id": paper_job["id"], "job_type": paper_job["job_type"]},
        )
    ]


@register_notification_builder("obsidian_sync_completed", "Obsidian 同步完成")
def _obsidian_sync_completed(context: dict[str, Any]) -> list[dict[str, Any]]:
    sync_job = _completed(
        context["activities"],
        lambda meta, item: _meta_number(meta, ["sync_indexed", "indexed"]) > 0 or item["job_type"] == "sync-obsidian",
    )
    if not sync_job:
        return []
    indexed = _meta_number(sync_job["meta"], ["sync_indexed", "indexed"])
    chunks = _meta_number(sync_job["meta"], ["sync_chunks_created", "chunks_created"])
    detail = (
        f"{indexed} 篇笔记更新，{chunks} 个 chunk 入库"
        if indexed
        else "Obsidian 同步完成"
    )
    return [
        _notification(
            f"obsidian-sync-completed-{sync_job['id']}",
            "obsidian_sync_completed",
            "ok",
            "Obsidian 已同步",
            detail,
            created_at=sync_job["finished_at"],
            source={"job_id": sync_job["id"], "job_type": sync_job["job_type"]},
        )
    ]


@register_notification_builder("paper_text_cached", "PDF/TXT 缓存完成")
def _paper_text_cached(context: dict[str, Any]) -> list[dict[str, Any]]:
    text_job = _completed(
        context["activities"],
        lambda meta, _item: _meta_number(meta, ["text_pdfs_downloaded", "pdfs_downloaded", "text_texts_extracted", "texts_extracted"]) > 0,
    )
    if not text_job:
        return []
    parts = []
    pdf_count = _meta_number(text_job["meta"], ["text_pdfs_downloaded", "pdfs_downloaded"])
    text_count = _meta_number(text_job["meta"], ["text_texts_extracted", "texts_extracted"])
    failed_count = _meta_number(text_job["meta"], ["text_texts_failed", "texts_failed"])
    if pdf_count:
        parts.append(f"{pdf_count} 个 PDF 已缓存")
    if text_count:
        parts.append(f"{text_count} 篇已转 TXT")
    if failed_count:
        parts.append(f"{failed_count} 篇失败")
    return [
        _notification(
            f"paper-text-cached-{text_job['id']}",
            "paper_text_cached",
            "ok",
            "论文正文已缓存",
            "，".join(parts),
            created_at=text_job["finished_at"],
            source={"job_id": text_job["id"], "job_type": text_job["job_type"]},
        )
    ]


@register_notification_builder("paper_matching_completed", "论文匹配完成")
def _paper_matching_completed(context: dict[str, Any]) -> list[dict[str, Any]]:
    rank_job = _completed(
        context["activities"],
        lambda meta, _item: _meta_number(meta, ["matched_papers"]) > 0 or _meta_number(meta, ["project_paper_matches_created"]) > 0,
    )
    if not rank_job:
        return []
    count = _meta_number(rank_job["meta"], ["matched_papers", "project_paper_matches_created"])
    return [
        _notification(
            f"paper-matching-completed-{rank_job['id']}",
            "paper_matching_completed",
            "info",
            "论文匹配完成",
            f"{count} 条匹配结果",
            created_at=rank_job["finished_at"],
            source={"job_id": rank_job["id"], "job_type": rank_job["job_type"]},
        )
    ]


@register_notification_builder("paper_report_queue_processing", "全文报告队列处理中")
def _paper_report_queue_processing(context: dict[str, Any]) -> list[dict[str, Any]]:
    stats = context["paper_report_stats"]
    if not stats.get("processing"):
        return []
    return [
        _notification(
            "paper-report-queue-processing",
            "paper_report_queue_processing",
            "info",
            "全文报告生成中",
            f"{stats['processing']} 篇处理中，{stats['queued']} 篇排队中",
        )
    ]


@register_notification_builder("paper_report_queue_failed", "全文报告生成失败积压")
def _paper_report_queue_failed(context: dict[str, Any]) -> list[dict[str, Any]]:
    failed = context["paper_report_stats"].get("failed", 0)
    if not failed:
        return []
    return [
        _notification(
            "paper-report-queue-failed",
            "paper_report_queue_failed",
            "bad",
            "全文报告生成失败",
            f"{failed} 篇报告失败，需要在报告队列中重试或检查 LLM/PDF/TXT 配置。",
        )
    ]


@register_notification_builder("paper_report_queue_backlog", "全文报告队列排队积压")
def _paper_report_queue_backlog(context: dict[str, Any]) -> list[dict[str, Any]]:
    queued = context["paper_report_stats"].get("queued", 0)
    if not queued:
        return []
    return [
        _notification(
            "paper-report-queue-backlog",
            "paper_report_queue_backlog",
            "warn",
            "全文报告等待生成",
            f"{queued} 篇论文正在排队，server 运行时会按配置并发自动生成。",
        )
    ]


@register_notification_builder("paper_report_completed", "最近全文报告生成完成")
def _paper_report_completed(context: dict[str, Any]) -> list[dict[str, Any]]:
    report_job = _completed(
        context["activities"],
        lambda meta, item: item["job_type"] == "generate-paper-reports" and _meta_number(meta, ["paper_reports_done"]) > 0,
    )
    if not report_job:
        return []
    count = _meta_number(report_job["meta"], ["paper_reports_done"])
    return [
        _notification(
            f"paper-report-completed-{report_job['id']}",
            "paper_report_completed",
            "ok",
            "全文报告已生成",
            f"{count} 篇全文报告完成",
            created_at=report_job["finished_at"],
            source={"job_id": report_job["id"], "job_type": report_job["job_type"]},
        )
    ]


@register_notification_builder("experiment_report_arrived", "KRIS agent 实验报告到达")
def _experiment_report_arrived(context: dict[str, Any]) -> list[dict[str, Any]]:
    items = []
    for report in context["experiment_reports"]:
        project_id = report["project_id"]
        source_agent = report["source_agent"] or "unknown"
        updated_at = report["updated_at"] or ""
        detail_parts = [str(report["title"] or "未命名实验报告")]
        if project_id:
            detail_parts.append(f"项目 {project_id}")
        if source_agent:
            detail_parts.append(f"来源 {source_agent}")
        if updated_at:
            detail_parts.append(f"更新于 {updated_at}")
        items.append(
            _notification(
                f"experiment-report-arrived-{report['id']}",
                "experiment_report_arrived",
                "info",
                "收到实验报告",
                " · ".join(detail_parts),
                created_at=updated_at,
                source={
                    "artifact_id": report["id"],
                    "project_id": project_id,
                    "source_agent": source_agent,
                },
                channels=["list"],
            )
        )
    return items


def notifications(conn: DbConnection, limit: int = 5) -> dict[str, Any]:
    context: dict[str, Any] = {
        "conn": conn,
        "activities": _activity_rows(conn, 20),
        "paper_report_stats": _paper_report_stats(conn),
        "experiment_reports": _experiment_report_rows(conn, min(max(1, int(limit or 5)), 10)),
        "items": [],
    }
    for entry in REGISTERED_NOTIFICATION_BUILDERS:
        built = entry["builder"](context)
        context["items"].extend(built)
    items = sorted(context["items"], key=_notification_sort_key, reverse=True)[: max(1, int(limit or 5))]
    if not items:
        items = [
            _notification(
                "empty",
                "empty",
                "neutral",
                "暂无通知",
                "没有新的任务完成、论文到达或实验同步事件。",
            )
        ]
    return {
        "items": items,
        "registered_builders": [
            {"type": entry["type"], "description": entry["description"]}
            for entry in REGISTERED_NOTIFICATION_BUILDERS
        ],
    }
