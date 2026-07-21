from __future__ import annotations

from typing import Any

from .config import Settings
from .db import clean_unicode, from_json, to_json, utc_now
from .db_types import DbConnection
from .embeddings import embed_many
from .pgvector_search import ensure_pgvector_indexes
from .search_corpus import searchable_library_paper_sql


LIBRARY_PAPER_INDEX_JOB = "library-paper-index"


def _metadata_text(row: Any) -> str:
    parts = [
        row["title"],
        row["abstract"],
        row["authors_json"],
        row["venue"],
        row["user_tags_json"],
        row["user_note"],
    ]
    return "\n\n".join(clean_unicode(str(value or "")).strip() for value in parts if str(value or "").strip())


def enqueue_library_paper_index(
    conn: DbConnection,
    settings: Settings,
    paper_id: int,
) -> dict[str, object]:
    model = clean_unicode(settings.llm_embedding_model).strip()
    if not model:
        return {"queued": False, "reason": "embedding_model_not_configured", "paper_id": int(paper_id)}
    rows = conn.execute(
        """
        SELECT id, payload_json
        FROM worker_jobs
        WHERE job_type = ? AND status IN ('queued', 'running')
        ORDER BY id DESC
        """,
        (LIBRARY_PAPER_INDEX_JOB,),
    ).fetchall()
    for row in rows:
        payload = from_json(row["payload_json"], {})
        if (
            isinstance(payload, dict)
            and int(payload.get("paper_id") or 0) == int(paper_id)
            and str(payload.get("model") or "") == model
        ):
            return {"queued": False, "deduplicated": True, "worker_job_id": int(row["id"]), "paper_id": int(paper_id)}

    now = utc_now()
    cursor = conn.execute(
        """
        INSERT INTO worker_jobs(
          job_type, status, priority, payload_json, max_attempts, created_at, updated_at
        ) VALUES (?, 'queued', ?, ?, ?, ?, ?)
        """,
        (
            LIBRARY_PAPER_INDEX_JOB,
            14,
            to_json(
                {
                    "command": LIBRARY_PAPER_INDEX_JOB,
                    "source": "paper-import",
                    "paper_id": int(paper_id),
                    "model": model,
                }
            ),
            3,
            now,
            now,
        ),
    )
    return {"queued": True, "worker_job_id": int(cursor.lastrowid), "paper_id": int(paper_id)}


def index_library_paper(
    conn: DbConnection,
    settings: Settings,
    paper_id: int,
) -> dict[str, object]:
    model = clean_unicode(settings.llm_embedding_model).strip()
    provider = settings.embedding_provider()
    if not model or not provider or not provider.api_key or not provider.base_url:
        raise RuntimeError("Embedding provider/model is not configured for local paper indexing")
    paper = conn.execute(
        f"""
        SELECT p.id, p.title, p.abstract, p.authors_json, p.venue,
               p.user_tags_json, p.user_note
        FROM papers p
        WHERE p.id = ? AND {searchable_library_paper_sql("p")}
        """,
        (int(paper_id),),
    ).fetchone()
    if not paper:
        raise RuntimeError(f"Searchable library paper not found: {paper_id}")
    chunks = conn.execute(
        "SELECT id, text FROM paper_chunks WHERE paper_id = ? ORDER BY chunk_index, id",
        (int(paper_id),),
    ).fetchall()
    inputs = [_metadata_text(paper), *[clean_unicode(str(row["text"] or "")).strip() for row in chunks]]
    embeddings = embed_many(settings, inputs)
    if not embeddings or not embeddings[0]:
        raise RuntimeError("Paper metadata embedding was empty")
    now = utc_now()
    conn.execute(
        """
        INSERT INTO paper_embeddings(paper_id, model, embedding_json, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(paper_id, model) DO UPDATE SET
          embedding_json = excluded.embedding_json,
          created_at = excluded.created_at
        """,
        (int(paper_id), model, to_json(embeddings[0]), now),
    )
    chunk_embeddings_created = 0
    for row, embedding in zip(chunks, embeddings[1:]):
        if not embedding:
            continue
        conn.execute(
            """
            INSERT INTO paper_chunk_embeddings(paper_chunk_id, model, embedding_json, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(paper_chunk_id, model) DO UPDATE SET
              embedding_json = excluded.embedding_json,
              created_at = excluded.created_at
            """,
            (int(row["id"]), model, to_json(embedding), now),
        )
        chunk_embeddings_created += 1
    conn.commit()
    dimension = len(embeddings[0])
    pgvector: dict[str, object] = {}
    for source, table, id_column in (
        ("library_papers", "paper_embeddings", "paper_id"),
        ("library_paper_chunks", "paper_chunk_embeddings", "paper_chunk_id"),
    ):
        try:
            pgvector[source] = ensure_pgvector_indexes(
                conn,
                dimension,
                table=table,
                id_column=id_column,
            )
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            pgvector[source] = {"supported": False, "reason": "init_failed", "error": str(exc)[:500]}
    return {
        "paper_id": int(paper_id),
        "model": model,
        "paper_embeddings_created": 1,
        "paper_chunk_embeddings_created": chunk_embeddings_created,
        "pgvector": pgvector,
    }


def backfill_library_paper_indexes(conn: DbConnection, settings: Settings) -> dict[str, object]:
    model = clean_unicode(settings.llm_embedding_model).strip()
    provider = settings.embedding_provider()
    if not model or not provider or not provider.api_key or not provider.base_url:
        raise RuntimeError("Embedding provider/model is not configured for local paper indexing")

    papers = conn.execute(
        f"""
        SELECT p.id, p.title, p.abstract, p.authors_json, p.venue,
               p.user_tags_json, p.user_note
        FROM papers p
        WHERE {searchable_library_paper_sql("p")}
        ORDER BY p.id
        """
    ).fetchall()
    missing_papers = []
    for paper in papers:
        existing = conn.execute(
            "SELECT 1 FROM paper_embeddings WHERE paper_id = ? AND model = ?",
            (int(paper["id"]), model),
        ).fetchone()
        if not existing:
            missing_papers.append(paper)

    paper_embeddings = embed_many(settings, [_metadata_text(row) for row in missing_papers]) if missing_papers else []
    paper_embeddings_created = 0
    first_dimension: int | None = None
    for row, embedding in zip(missing_papers, paper_embeddings):
        if not embedding:
            continue
        first_dimension = first_dimension or len(embedding)
        conn.execute(
            """
            INSERT INTO paper_embeddings(paper_id, model, embedding_json, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(paper_id, model) DO UPDATE SET
              embedding_json = excluded.embedding_json,
              created_at = excluded.created_at
            """,
            (int(row["id"]), model, to_json(embedding), utc_now()),
        )
        paper_embeddings_created += 1

    chunks = conn.execute(
        f"""
        SELECT c.id, c.text
        FROM paper_chunks c
        JOIN papers p ON p.id = c.paper_id
        LEFT JOIN paper_chunk_embeddings e
          ON e.paper_chunk_id = c.id AND e.model = ?
        WHERE {searchable_library_paper_sql("p")} AND e.paper_chunk_id IS NULL
        ORDER BY c.id
        """,
        (model,),
    ).fetchall()
    chunk_embeddings = embed_many(settings, [str(row["text"] or "") for row in chunks]) if chunks else []
    chunk_embeddings_created = 0
    for row, embedding in zip(chunks, chunk_embeddings):
        if not embedding:
            continue
        first_dimension = first_dimension or len(embedding)
        conn.execute(
            """
            INSERT INTO paper_chunk_embeddings(paper_chunk_id, model, embedding_json, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(paper_chunk_id, model) DO UPDATE SET
              embedding_json = excluded.embedding_json,
              created_at = excluded.created_at
            """,
            (int(row["id"]), model, to_json(embedding), utc_now()),
        )
        chunk_embeddings_created += 1
    conn.commit()

    pgvector: dict[str, object] = {}
    for source, table, id_column in (
        ("library_papers", "paper_embeddings", "paper_id"),
        ("library_paper_chunks", "paper_chunk_embeddings", "paper_chunk_id"),
    ):
        try:
            pgvector[source] = ensure_pgvector_indexes(
                conn,
                first_dimension,
                table=table,
                id_column=id_column,
            )
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            pgvector[source] = {"supported": False, "reason": "init_failed", "error": str(exc)[:500]}

    return {
        "library_papers_considered": len(papers),
        "library_paper_embeddings_created": paper_embeddings_created,
        "library_paper_chunks_considered": len(chunks),
        "library_paper_chunk_embeddings_created": chunk_embeddings_created,
        "model": model,
        "pgvector": pgvector,
    }
