from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any, Iterable, Sequence


CHUNK_EMBEDDING_TABLE = "chunk_embeddings"
CHUNK_ID_COLUMN = "chunk_id"
EMBEDDING_JSON_COLUMN = "embedding_json"
EMBEDDING_VECTOR_COLUMN = "embedding_vector"
HNSW_INDEX_NAME = "idx_chunk_embeddings_embedding_vector_hnsw"
IVFFLAT_INDEX_NAME = "idx_chunk_embeddings_embedding_vector_ivfflat"


@dataclass(frozen=True)
class PgvectorSearchHit:
    chunk_id: int
    score: float
    distance: float
    searcher: str = "embedding_search"


def ensure_pgvector_indexes(conn: Any, dimensions: int | None = None) -> dict[str, object]:
    """Install pgvector storage for note chunk embeddings.

    The original JSON embedding column is left intact. The vector column is a
    derived retrieval column and can be rebuilt by rerunning this function.
    """
    if not _is_postgres(conn):
        return {"supported": False, "reason": "non_postgres", "index_method": None}

    normalized_dimensions = _validate_dimensions(dimensions) if dimensions is not None else _infer_dimensions(conn)
    vector_type = _vector_type_sql(normalized_dimensions)
    column_added = False
    column_altered = False

    try:
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        current_type = _embedding_vector_type(conn)
        if current_type is None:
            conn.execute(f"ALTER TABLE {CHUNK_EMBEDDING_TABLE} ADD COLUMN {EMBEDDING_VECTOR_COLUMN} {vector_type}")
            column_added = True
        else:
            _ensure_vector_column_type(current_type)
            if normalized_dimensions is not None and not _vector_type_matches(current_type, normalized_dimensions):
                conn.execute(
                    f"""
                    ALTER TABLE {CHUNK_EMBEDDING_TABLE}
                    ALTER COLUMN {EMBEDDING_VECTOR_COLUMN}
                    TYPE {vector_type}
                    USING {EMBEDDING_VECTOR_COLUMN}::{vector_type}
                    """
                )
                column_altered = True

        backfill = conn.execute(
            f"""
            UPDATE {CHUNK_EMBEDDING_TABLE}
            SET {EMBEDDING_VECTOR_COLUMN} = {EMBEDDING_JSON_COLUMN}::{vector_type}
            WHERE {EMBEDDING_VECTOR_COLUMN} IS NULL
              AND NULLIF({EMBEDDING_JSON_COLUMN}, '') IS NOT NULL
            """
        )
        backfilled = int(getattr(backfill, "rowcount", 0) or 0)
        conn.commit()
    except Exception:
        _rollback_quietly(conn)
        raise

    index_method = None
    index_error = ""
    if normalized_dimensions is not None:
        index_method, index_error = _ensure_vector_index(conn)

    return {
        "supported": True,
        "reason": "",
        "dimensions": normalized_dimensions,
        "column_added": column_added,
        "column_altered": column_altered,
        "embeddings_backfilled": backfilled,
        "index_method": index_method,
        "index_error": index_error,
    }


def pgvector_embedding_search(
    conn: Any,
    query_embedding: Sequence[float],
    chunk_ids: Iterable[int] | None,
    top_k: int,
) -> list[PgvectorSearchHit]:
    """Search only the provided chunk ids with pgvector cosine distance."""
    if not _is_postgres(conn) or top_k <= 0:
        return []
    scoped_chunk_ids = _normalize_chunk_ids(chunk_ids)
    if not scoped_chunk_ids:
        return []
    vector = _coerce_embedding(query_embedding)
    if not vector:
        return []

    try:
        if not _pgvector_search_ready(conn):
            return []
        vector_literal = _vector_literal(vector)
        rows = conn.execute(
            f"""
            SELECT
              {CHUNK_ID_COLUMN},
              {EMBEDDING_VECTOR_COLUMN} <=> CAST(? AS vector) AS distance
            FROM {CHUNK_EMBEDDING_TABLE}
            WHERE {CHUNK_ID_COLUMN} = ANY(CAST(? AS integer[]))
              AND {EMBEDDING_VECTOR_COLUMN} IS NOT NULL
            ORDER BY distance ASC
            LIMIT ?
            """,
            (vector_literal, scoped_chunk_ids, int(top_k)),
        ).fetchall()
    except Exception:
        _rollback_quietly(conn)
        return []

    hits: list[PgvectorSearchHit] = []
    for row in rows:
        distance_value = _row_value(row, "distance")
        if distance_value is None:
            continue
        distance = float(distance_value)
        if not math.isfinite(distance):
            continue
        score = max(0.0, min(1.0, 1.0 - distance))
        hits.append(
            PgvectorSearchHit(
                chunk_id=int(_row_value(row, CHUNK_ID_COLUMN)),
                score=score,
                distance=distance,
            )
        )
    return sorted(hits, key=lambda hit: hit.distance)[: int(top_k)]


def _ensure_vector_index(conn: Any) -> tuple[str | None, str]:
    try:
        conn.execute(
            f"""
            CREATE INDEX IF NOT EXISTS {HNSW_INDEX_NAME}
            ON {CHUNK_EMBEDDING_TABLE}
            USING hnsw ({EMBEDDING_VECTOR_COLUMN} vector_cosine_ops)
            WHERE {EMBEDDING_VECTOR_COLUMN} IS NOT NULL
            """
        )
        conn.commit()
        return "hnsw", ""
    except Exception as exc:
        _rollback_quietly(conn)
        hnsw_error = str(exc)

    try:
        conn.execute(
            f"""
            CREATE INDEX IF NOT EXISTS {IVFFLAT_INDEX_NAME}
            ON {CHUNK_EMBEDDING_TABLE}
            USING ivfflat ({EMBEDDING_VECTOR_COLUMN} vector_cosine_ops)
            WITH (lists = 100)
            WHERE {EMBEDDING_VECTOR_COLUMN} IS NOT NULL
            """
        )
        conn.commit()
        return "ivfflat", hnsw_error
    except Exception as exc:
        _rollback_quietly(conn)
        return None, f"{hnsw_error}; ivfflat: {exc}"


def _pgvector_search_ready(conn: Any) -> bool:
    return _pgvector_extension_installed(conn) and _column_exists(
        conn,
        CHUNK_EMBEDDING_TABLE,
        EMBEDDING_VECTOR_COLUMN,
    )


def _pgvector_extension_installed(conn: Any) -> bool:
    row = conn.execute(
        """
        SELECT EXISTS (
          SELECT 1
          FROM pg_extension
          WHERE extname = 'vector'
        ) AS installed
        """
    ).fetchone()
    return bool(_row_value(row, "installed", False))


def _column_exists(conn: Any, table: str, column: str) -> bool:
    row = conn.execute(
        """
        SELECT 1 AS present
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ?
          AND column_name = ?
        LIMIT 1
        """,
        (table, column),
    ).fetchone()
    return row is not None


def _embedding_vector_type(conn: Any) -> str | None:
    row = conn.execute(
        """
        SELECT format_type(a.atttypid, a.atttypmod) AS data_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = ?
          AND a.attname = ?
          AND NOT a.attisdropped
        LIMIT 1
        """,
        (CHUNK_EMBEDDING_TABLE, EMBEDDING_VECTOR_COLUMN),
    ).fetchone()
    value = _row_value(row, "data_type")
    return str(value) if value else None


def _infer_dimensions(conn: Any) -> int | None:
    try:
        row = conn.execute(
            f"""
            SELECT jsonb_array_length({EMBEDDING_JSON_COLUMN}::jsonb) AS dimensions
            FROM {CHUNK_EMBEDDING_TABLE}
            WHERE NULLIF({EMBEDDING_JSON_COLUMN}, '') IS NOT NULL
            ORDER BY {CHUNK_ID_COLUMN}
            LIMIT 1
            """
        ).fetchone()
    except Exception:
        _rollback_quietly(conn)
        return None
    value = _row_value(row, "dimensions")
    return _validate_dimensions(value) if value is not None else None


def _validate_dimensions(dimensions: object) -> int:
    value = int(dimensions)
    if value <= 0:
        raise ValueError("pgvector dimensions must be positive")
    return value


def _vector_type_sql(dimensions: int | None) -> str:
    return f"vector({dimensions})" if dimensions is not None else "vector"


def _ensure_vector_column_type(current_type: str) -> None:
    normalized = _normalize_type_name(current_type)
    if normalized != "vector" and not normalized.startswith("vector("):
        raise RuntimeError(f"{CHUNK_EMBEDDING_TABLE}.{EMBEDDING_VECTOR_COLUMN} is {current_type}, not vector")


def _vector_type_matches(current_type: str, dimensions: int) -> bool:
    return _normalize_type_name(current_type) == f"vector({dimensions})"


def _normalize_type_name(value: str) -> str:
    return value.strip().lower().replace(" ", "")


def _normalize_chunk_ids(chunk_ids: Iterable[int] | None) -> list[int]:
    if chunk_ids is None:
        return []
    try:
        return sorted({int(chunk_id) for chunk_id in chunk_ids})
    except (TypeError, ValueError):
        return []


def _coerce_embedding(embedding: Sequence[float]) -> list[float]:
    values: list[float] = []
    try:
        for value in embedding:
            number = float(value)
            if not math.isfinite(number):
                return []
            values.append(number)
    except (TypeError, ValueError):
        return []
    return values


def _vector_literal(embedding: Sequence[float]) -> str:
    return "[" + ",".join(repr(float(value)) for value in embedding) + "]"


def _is_postgres(conn: Any) -> bool:
    return str(getattr(conn, "dialect", "") or "") == "postgres"


def _row_value(row: Any, key: str, default: Any = None) -> Any:
    if row is None:
        return default
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        pass
    try:
        return getattr(row, key)
    except AttributeError:
        pass
    try:
        return row[0]
    except (IndexError, TypeError, KeyError):
        return default


def _rollback_quietly(conn: Any) -> None:
    try:
        conn.rollback()
    except Exception:
        pass
