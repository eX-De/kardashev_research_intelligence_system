from __future__ import annotations

from typing import Any

from .artifacts import get_artifact
from .config import Settings
from .db import clean_unicode, from_json, to_json, utc_now
from .db_types import DbConnection
from .embeddings import embed_many
from .knowledge import chunk_markdown
from .pgvector_search import ensure_pgvector_indexes
from .search_corpus import artifact_is_searchable, artifact_uses_generic_embedding_index


ARTIFACT_INDEX_JOB = "artifact-index"
ARTIFACT_INDEX_BACKFILL_JOB = "artifact-index-backfill"
POSTGRES_ARTIFACT_INDEX_LOCK_NAMESPACE = 724021


def artifact_index_content_hash(artifact: dict[str, object]) -> str:
    from .artifacts import content_hash

    return content_hash(
        f"{clean_unicode(str(artifact.get('title') or '')).strip()}\n\n"
        f"{clean_unicode(str(artifact.get('content_markdown') or '')).strip()}"
    )


def remove_artifact_index(conn: DbConnection, artifact_id: int, *, commit: bool = True) -> dict[str, object]:
    deleted = conn.execute("DELETE FROM artifact_chunks WHERE artifact_id = ?", (int(artifact_id),))
    if commit:
        conn.commit()
    return {"artifact_id": int(artifact_id), "artifact_chunks_removed": int(deleted.rowcount or 0)}


def _existing_chunks(conn: DbConnection, artifact_id: int) -> list[Any]:
    return conn.execute(
        """
        SELECT id, chunk_index, heading, text, content_hash
        FROM artifact_chunks
        WHERE artifact_id = ?
        ORDER BY chunk_index
        """,
        (int(artifact_id),),
    ).fetchall()


def _model_is_complete(conn: DbConnection, chunk_ids: list[int], model: str) -> bool:
    if not chunk_ids:
        return False
    placeholders = ", ".join("?" for _ in chunk_ids)
    row = conn.execute(
        f"""
        SELECT COUNT(*) AS count
        FROM artifact_chunk_embeddings
        WHERE model = ? AND artifact_chunk_id IN ({placeholders})
        """,
        (model, *chunk_ids),
    ).fetchone()
    return int(row["count"] or 0) == len(chunk_ids)


def index_artifact(conn: DbConnection, settings: Settings, artifact_id: int) -> dict[str, object]:
    artifact = get_artifact(conn, int(artifact_id))
    if not artifact:
        return remove_artifact_index(conn, int(artifact_id))
    artifact_type = str(artifact.get("artifact_type") or "")
    if not artifact_uses_generic_embedding_index(artifact_type):
        removed = remove_artifact_index(conn, int(artifact_id))
        return {**removed, "skipped": True, "reason": "artifact_uses_dedicated_index"}
    if not artifact_is_searchable(artifact_type, artifact.get("status")):
        removed = remove_artifact_index(conn, int(artifact_id))
        return {**removed, "skipped": True, "reason": "artifact_not_searchable"}

    model = clean_unicode(settings.llm_embedding_model).strip()
    provider = settings.embedding_provider()
    if not model or not provider or not provider.api_key or not provider.base_url:
        raise RuntimeError("Embedding provider/model is not configured for artifact indexing")

    digest = artifact_index_content_hash(artifact)
    existing = _existing_chunks(conn, int(artifact_id))
    existing_ids = [int(row["id"]) for row in existing]
    content_unchanged = bool(existing) and all(str(row["content_hash"] or "") == digest for row in existing)
    if content_unchanged and _model_is_complete(conn, existing_ids, model):
        return {
            "artifact_id": int(artifact_id),
            "artifact_type": artifact_type,
            "content_hash": digest,
            "model": model,
            "artifact_chunks_created": 0,
            "artifact_embeddings_created": 0,
            "unchanged": True,
        }

    if content_unchanged:
        chunk_specs = [
            {"heading": row["heading"], "text": row["text"]}
            for row in existing
        ]
    else:
        markdown = clean_unicode(str(artifact.get("content_markdown") or "")).strip()
        title = clean_unicode(str(artifact.get("title") or "")).strip() or "Artifact"
        chunk_specs = chunk_markdown(title, f"# {title}\n\n{markdown}")
    if not chunk_specs:
        removed = remove_artifact_index(conn, int(artifact_id))
        return {**removed, "skipped": True, "reason": "empty_content"}

    embeddings = embed_many(settings, [str(item["text"]) for item in chunk_specs])
    if len(embeddings) != len(chunk_specs) or any(not embedding for embedding in embeddings):
        raise RuntimeError("Artifact embedding returned an empty vector")

    if getattr(conn, "dialect", "") == "postgres":
        conn.execute(
            "SELECT pg_advisory_xact_lock(?, ?)",
            (POSTGRES_ARTIFACT_INDEX_LOCK_NAMESPACE, int(artifact_id)),
        )
    now = utc_now()
    created_chunks = 0
    if content_unchanged:
        chunk_ids = existing_ids
    else:
        conn.execute("DELETE FROM artifact_chunks WHERE artifact_id = ?", (int(artifact_id),))
        chunk_ids = []
        for index, item in enumerate(chunk_specs):
            cursor = conn.execute(
                """
                INSERT INTO artifact_chunks(artifact_id, chunk_index, heading, text, content_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    int(artifact_id),
                    index,
                    clean_unicode(str(item.get("heading") or ""))[:240],
                    clean_unicode(str(item.get("text") or "")).strip(),
                    digest,
                    now,
                ),
            )
            chunk_ids.append(int(cursor.lastrowid))
            created_chunks += 1

    for chunk_id, embedding in zip(chunk_ids, embeddings):
        conn.execute(
            """
            INSERT INTO artifact_chunk_embeddings(artifact_chunk_id, model, embedding_json, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(artifact_chunk_id, model) DO UPDATE SET
              embedding_json = excluded.embedding_json,
              created_at = excluded.created_at
            """,
            (chunk_id, model, to_json(embedding), now),
        )
    conn.commit()
    try:
        pgvector = ensure_pgvector_indexes(
            conn,
            len(embeddings[0]) if embeddings and embeddings[0] else None,
            table="artifact_chunk_embeddings",
            id_column="artifact_chunk_id",
        )
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        pgvector = {"supported": False, "reason": "init_failed", "error": str(exc)[:500]}
    return {
        "artifact_id": int(artifact_id),
        "artifact_type": artifact_type,
        "content_hash": digest,
        "model": model,
        "artifact_chunks_created": created_chunks,
        "artifact_embeddings_created": len(embeddings),
        "unchanged": False,
        "pgvector": pgvector,
    }


def enqueue_artifact_index(conn: DbConnection, settings: Settings, artifact: dict[str, object]) -> dict[str, object]:
    artifact_id = int(artifact["id"])
    artifact_type = str(artifact.get("artifact_type") or "")
    if not artifact_uses_generic_embedding_index(artifact_type):
        return {"queued": False, "reason": "artifact_uses_dedicated_index", "artifact_id": artifact_id}
    action = "index" if artifact_is_searchable(artifact_type, artifact.get("status")) else "remove"
    digest = artifact_index_content_hash(artifact) if action == "index" else ""
    model = clean_unicode(settings.llm_embedding_model).strip()
    rows = conn.execute(
        """
        SELECT id, payload_json
        FROM worker_jobs
        WHERE job_type = ? AND status IN ('queued', 'running')
        ORDER BY id DESC
        """,
        (ARTIFACT_INDEX_JOB,),
    ).fetchall()
    for row in rows:
        payload = from_json(row["payload_json"], {})
        if (
            isinstance(payload, dict)
            and int(payload.get("artifact_id") or 0) == artifact_id
            and str(payload.get("action") or "index") == action
            and str(payload.get("content_hash") or "") == digest
            and str(payload.get("model") or "") == model
        ):
            return {"queued": False, "deduplicated": True, "worker_job_id": int(row["id"]), "artifact_id": artifact_id}

    now = utc_now()
    cursor = conn.execute(
        """
        INSERT INTO worker_jobs(
          job_type, status, priority, payload_json, max_attempts, created_at, updated_at
        ) VALUES (?, 'queued', ?, ?, ?, ?, ?)
        """,
        (
            ARTIFACT_INDEX_JOB,
            15,
            to_json({
                "command": ARTIFACT_INDEX_JOB,
                "source": "artifact-lifecycle",
                "artifact_id": artifact_id,
                "action": action,
                "content_hash": digest,
                "model": model,
            }),
            3,
            now,
            now,
        ),
    )
    conn.commit()
    return {"queued": True, "worker_job_id": int(cursor.lastrowid), "artifact_id": artifact_id, "action": action}


def backfill_artifact_indexes(conn: DbConnection, settings: Settings) -> dict[str, object]:
    rows = conn.execute(
        """
        SELECT * FROM artifacts
        WHERE artifact_type <> 'experiment_report'
        ORDER BY id
        """
    ).fetchall()
    result: dict[str, object] = {"artifacts_considered": len(rows), "artifacts_indexed": 0, "artifacts_unchanged": 0, "artifacts_removed": 0}
    for row in rows:
        artifact = get_artifact(conn, int(row["id"])) or {}
        if not artifact_is_searchable(artifact.get("artifact_type"), artifact.get("status")):
            removed = remove_artifact_index(conn, int(row["id"]))
            result["artifacts_removed"] = int(result["artifacts_removed"]) + int(removed["artifact_chunks_removed"] or 0)
            continue
        indexed = index_artifact(conn, settings, int(row["id"]))
        if indexed.get("unchanged"):
            result["artifacts_unchanged"] = int(result["artifacts_unchanged"]) + 1
        else:
            result["artifacts_indexed"] = int(result["artifacts_indexed"]) + 1
    from .experiment_reports import backfill_experiment_report_indexes

    return {**result, **backfill_experiment_report_indexes(conn, settings)}
