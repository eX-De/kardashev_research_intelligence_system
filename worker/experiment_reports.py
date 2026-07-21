from __future__ import annotations

from .db_types import DbConnection, DbRow
from typing import Any

from .artifacts import (
    content_hash,
    export_artifact_to_obsidian,
    update_artifact,
    upsert_artifact,
    get_artifact,
)
from .config import Settings
from .db import clean_unicode, from_json, to_json, utc_now
from .knowledge import save_project_context_document
from .obsidian_remote import obsidian_remote_enabled
from .pgvector_search import ensure_pgvector_indexes


EXPERIMENT_REPORT_ARTIFACT_TYPE = "experiment_report"
EXPERIMENT_REPORT_SOURCE_TYPE = "experiment_report"
EXPERIMENT_REPORT_RELATION = "experiment_progress"
VALID_SOURCE_AGENTS = {"codex", "claude-code", "manual"}
EXPERIMENT_REPORT_INDEX_JOB = "experiment-report-index"


def _required_text(payload: dict[str, object], key: str, *, max_chars: int) -> str:
    value = clean_unicode(str(payload.get(key) or "")).strip()
    if not value:
        raise RuntimeError(f"{key} is required")
    if len(value) > max_chars:
        raise RuntimeError(f"{key} must be at most {max_chars} characters")
    return value


def _required_dict(payload: dict[str, object], key: str) -> dict[str, object]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise RuntimeError(f"{key} must be an object")
    return clean_unicode(value)


def _optional_dict(payload: dict[str, object], key: str) -> dict[str, object]:
    value = payload.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise RuntimeError(f"{key} must be an object")
    return clean_unicode(value)


def _project_id(payload: dict[str, object]) -> int:
    raw = payload.get("project_id")
    try:
        project_id = int(str(raw).strip())
    except (TypeError, ValueError) as exc:
        raise RuntimeError("project_id must be a positive integer") from exc
    if project_id <= 0:
        raise RuntimeError("project_id must be a positive integer")
    return project_id


def _source_agent(payload: dict[str, object]) -> str:
    value = clean_unicode(str(payload.get("source_agent") or "manual")).strip() or "manual"
    if value not in VALID_SOURCE_AGENTS:
        allowed = ", ".join(sorted(VALID_SOURCE_AGENTS))
        raise RuntimeError(f"source_agent must be one of: {allowed}")
    return value


def _project_row(conn: DbConnection, project_id: int) -> DbRow:
    row = conn.execute(
        """
        SELECT id, name, obsidian_project_path, obsidian_folder, obsidian_output_dir
        FROM research_projects
        WHERE id = ?
        """,
        (project_id,),
    ).fetchone()
    if not row:
        raise RuntimeError(f"Project not found: {project_id}")
    return row


def _obsidian_export_enabled(settings: Settings) -> bool:
    return bool(settings.obsidian_vault_path) or obsidian_remote_enabled(settings)


def _export_status(status: str, **values: object) -> dict[str, object]:
    return {"status": status, "exported_at": utc_now(), **values}


def enqueue_experiment_report_index(
    conn: DbConnection,
    settings: Settings,
    artifact: dict[str, object],
) -> dict[str, object]:
    artifact_id = int(artifact["id"])
    digest = str(artifact.get("input_hash") or "")
    model = clean_unicode(settings.llm_embedding_model).strip()
    rows = conn.execute(
        """
        SELECT id, payload_json
        FROM worker_jobs
        WHERE job_type = ? AND status IN ('queued', 'running')
        ORDER BY id DESC
        """,
        (EXPERIMENT_REPORT_INDEX_JOB,),
    ).fetchall()
    for row in rows:
        queued = from_json(row["payload_json"], {})
        if (
            isinstance(queued, dict)
            and int(queued.get("artifact_id") or 0) == artifact_id
            and str(queued.get("content_hash") or "") == digest
            and str(queued.get("model") or "") == model
        ):
            return {"queued": False, "deduplicated": True, "worker_job_id": int(row["id"])}
    now = utc_now()
    cursor = conn.execute(
        """
        INSERT INTO worker_jobs(job_type, status, priority, payload_json, max_attempts, created_at, updated_at)
        VALUES (?, 'queued', 15, ?, 3, ?, ?)
        """,
        (
            EXPERIMENT_REPORT_INDEX_JOB,
            to_json({
                "command": EXPERIMENT_REPORT_INDEX_JOB,
                "source": "experiment-report",
                "artifact_id": artifact_id,
                "content_hash": digest,
                "model": model,
            }),
            now,
            now,
        ),
    )
    conn.commit()
    return {"queued": True, "worker_job_id": int(cursor.lastrowid)}


def index_experiment_report(conn: DbConnection, settings: Settings, artifact_id: int) -> dict[str, object]:
    artifact = get_artifact(conn, int(artifact_id))
    if not artifact or str(artifact.get("artifact_type") or "") != EXPERIMENT_REPORT_ARTIFACT_TYPE:
        raise RuntimeError(f"Experiment report artifact not found: {artifact_id}")
    project_id = int(artifact.get("scope_id") or 0)
    if not project_id:
        raise RuntimeError("Experiment report project_id is missing")
    source = artifact.get("source") if isinstance(artifact.get("source"), dict) else {}
    content = artifact.get("content_json") if isinstance(artifact.get("content_json"), dict) else {}
    idempotency_key = clean_unicode(str(source.get("idempotency_key") or f"artifact-{artifact_id}"))
    document = save_project_context_document(
        conn,
        settings,
        project_id,
        title=f"实验进展：{artifact.get('title') or 'Untitled'}",
        raw_content=str(artifact.get("content_markdown") or ""),
        source_type=EXPERIMENT_REPORT_SOURCE_TYPE,
        source_uri=f"project:{project_id}:experiment_report:{idempotency_key}",
        relation=EXPERIMENT_REPORT_RELATION,
        weight=1.0,
        metadata={
            "created_from": "experiment_report",
            "project_id": project_id,
            "artifact_id": int(artifact_id),
            "source_agent": source.get("source_agent") or content.get("source_agent") or "manual",
            "idempotency_key": idempotency_key,
            "received_at": source.get("received_at") or content.get("received_at") or artifact.get("created_at"),
        },
    )
    try:
        pgvector = ensure_pgvector_indexes(conn)
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        pgvector = {"supported": False, "reason": "init_failed", "error": str(exc)[:500]}
    content["knowledge_document"] = {
        "document_id": int(document["document_id"]),
        "chunks_created": int(document["chunks_created"]),
        "embeddings_created": int(document["embeddings_created"]),
        "relation": EXPERIMENT_REPORT_RELATION,
        "source_type": EXPERIMENT_REPORT_SOURCE_TYPE,
        "indexed_at": utc_now(),
    }
    updated = update_artifact(conn, int(artifact_id), content_json=content)
    return {"artifact": updated, "knowledge_document": document, "pgvector": pgvector}


def create_experiment_report(
    conn: DbConnection,
    settings: Settings,
    payload: dict[str, object] | None,
) -> dict[str, object]:
    payload = payload or {}
    if not isinstance(payload, dict):
        raise RuntimeError("payload must be an object")

    project_id = _project_id(payload)
    project = _project_row(conn, project_id)
    title = _required_text(payload, "title", max_chars=240)
    markdown = _required_text(payload, "markdown", max_chars=200_000)
    report_json = _required_dict(payload, "report_json")
    source_agent = _source_agent(payload)
    idempotency_key = _required_text(payload, "idempotency_key", max_chars=240)
    metadata = _optional_dict(payload, "metadata")
    received_at = utc_now()

    content_json: dict[str, object] = {
        "project_id": project_id,
        "project_name": clean_unicode(str(project["name"] or "")),
        "report_json": report_json,
        "source_agent": source_agent,
        "idempotency_key": idempotency_key,
        "metadata": metadata,
        "received_at": received_at,
    }
    source_json = {
        "source": "kris-agent",
        "source_agent": source_agent,
        "project_id": project_id,
        "idempotency_key": idempotency_key,
        "received_at": received_at,
    }
    artifact = upsert_artifact(
        conn,
        scope_type="project",
        scope_id=project_id,
        artifact_type=EXPERIMENT_REPORT_ARTIFACT_TYPE,
        title=title,
        content_markdown=markdown,
        content_json=content_json,
        source_json=source_json,
        source_key=f"experiment_report:{idempotency_key}",
        input_hash=content_hash(markdown, {"report_json": report_json, "metadata": metadata}),
        commit=True,
    )

    obsidian = _export_status("skipped", reason="obsidian_not_configured")
    if _obsidian_export_enabled(settings):
        try:
            exported = export_artifact_to_obsidian(conn, settings, int(artifact["id"]))
            exported_payload = {key: value for key, value in exported.items() if key != "status"}
            obsidian = _export_status("exported", **exported_payload)
        except Exception as exc:  # Export is secondary; report ingestion should still succeed.
            obsidian = _export_status("failed", reason=str(exc))

    content_json["obsidian_export"] = obsidian
    artifact = update_artifact(
        conn,
        int(artifact["id"]),
        content_json=content_json,
        commit=True,
    )
    index_job = enqueue_experiment_report_index(conn, settings, artifact)
    return {
        "ok": True,
        "artifact": artifact,
        "knowledge_document": {"status": "queued", **index_job},
        "obsidian": obsidian,
    }


def backfill_experiment_report_indexes(conn: DbConnection, settings: Settings) -> dict[str, int]:
    """Repair historical experiment reports through their canonical knowledge-document path."""
    rows = conn.execute(
        """
        SELECT id
        FROM artifacts
        WHERE artifact_type = ? AND status = 'ready'
        ORDER BY id
        """,
        (EXPERIMENT_REPORT_ARTIFACT_TYPE,),
    ).fetchall()
    result = {
        "experiment_reports_considered": len(rows),
        "experiment_report_documents_repaired": 0,
        "experiment_report_embeddings_created": 0,
    }
    for row in rows:
        indexed = index_experiment_report(conn, settings, int(row["id"]))
        document = indexed["knowledge_document"]
        if int(document.get("indexed") or 0):
            result["experiment_report_documents_repaired"] += 1
        result["experiment_report_embeddings_created"] += int(document.get("embeddings_created") or 0)
    return result
