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

VECTOR_TABLES = {
    "knowledge": ("chunk_embeddings", "chunk_id"),
    "artifact": ("artifact_chunk_embeddings", "artifact_chunk_id"),
    "paper": ("arxiv_paper_embeddings", "paper_id"),
    "paper_chunk": ("arxiv_chunk_embeddings", "arxiv_chunk_id"),
    "library_paper": ("paper_embeddings", "paper_id"),
    "library_paper_chunk": ("paper_chunk_embeddings", "paper_chunk_id"),
}


@dataclass(frozen=True)
class PgvectorSearchHit:
    chunk_id: int
    score: float
    distance: float
    searcher: str = "embedding_search"


def ensure_pgvector_indexes(
    conn: Any,
    dimensions: int | None = None,
    *,
    table: str = CHUNK_EMBEDDING_TABLE,
    id_column: str = CHUNK_ID_COLUMN,
) -> dict[str, object]:
    """Install pgvector storage for note chunk embeddings.

    The original JSON embedding column is left intact. The vector column is a
    derived retrieval column and can be rebuilt by rerunning this function.
    """
    if not _is_postgres(conn):
        return {"supported": False, "reason": "non_postgres", "index_method": None}

    table, id_column = _validated_table(table, id_column)
    normalized_dimensions = _validate_dimensions(dimensions) if dimensions is not None else _infer_dimensions(conn, table, id_column)
    vector_type = _vector_type_sql(normalized_dimensions)
    column_added = False
    column_altered = False

    try:
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        current_type = _embedding_vector_type(conn, table)
        if current_type is None:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {EMBEDDING_VECTOR_COLUMN} {vector_type}")
            column_added = True
        else:
            _ensure_vector_column_type(current_type)
            if normalized_dimensions is not None and not _vector_type_matches(current_type, normalized_dimensions):
                conn.execute(
                    f"""
                    ALTER TABLE {table}
                    ALTER COLUMN {EMBEDDING_VECTOR_COLUMN}
                    TYPE {vector_type}
                    USING {EMBEDDING_VECTOR_COLUMN}::{vector_type}
                    """
                )
                column_altered = True

        backfill = conn.execute(
            f"""
            UPDATE {table}
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
        index_method, index_error = _ensure_vector_index(conn, table)

    return {
        "supported": True,
        "reason": "",
        "dimensions": normalized_dimensions,
        "column_added": column_added,
        "column_altered": column_altered,
        "embeddings_backfilled": backfilled,
        "index_method": index_method,
        "index_error": index_error,
        "table": table,
    }


def ensure_all_pgvector_indexes(conn: Any, dimensions: int | None = None) -> dict[str, object]:
    results: dict[str, object] = {}
    for source, (table, id_column) in VECTOR_TABLES.items():
        try:
            results[source] = ensure_pgvector_indexes(
                conn,
                dimensions,
                table=table,
                id_column=id_column,
            )
        except Exception as exc:
            _rollback_quietly(conn)
            results[source] = {"supported": False, "reason": "init_failed", "error": str(exc)[:500], "table": table}
    return results


def pgvector_embedding_search(
    conn: Any,
    query_embedding: Sequence[float],
    chunk_ids: Iterable[int] | None,
    top_k: int,
    *,
    table: str = CHUNK_EMBEDDING_TABLE,
    id_column: str = CHUNK_ID_COLUMN,
    model: str = "",
) -> list[PgvectorSearchHit]:
    """Search only the provided chunk ids with pgvector cosine distance."""
    if not _is_postgres(conn) or top_k <= 0:
        return []
    table, id_column = _validated_table(table, id_column)
    scoped_chunk_ids = _normalize_chunk_ids(chunk_ids) if chunk_ids is not None else None
    if scoped_chunk_ids == []:
        return []
    vector = _coerce_embedding(query_embedding)
    if not vector:
        return []

    try:
        if not _pgvector_search_ready(conn, table):
            return []
        vector_literal = _vector_literal(vector)
        filters = [f"{EMBEDDING_VECTOR_COLUMN} IS NOT NULL"]
        filter_params: list[object] = []
        if scoped_chunk_ids is not None:
            filters.append(f"{id_column} = ANY(CAST(? AS integer[]))")
            filter_params.append(scoped_chunk_ids)
        if model:
            filters.append("model = ?")
            filter_params.append(model)
        rows = conn.execute(
            f"""
            SELECT
              {id_column},
              {EMBEDDING_VECTOR_COLUMN} <=> CAST(? AS vector) AS distance
            FROM {table}
            WHERE {' AND '.join(filters)}
            ORDER BY distance ASC
            LIMIT ?
            """,
            (vector_literal, *filter_params, int(top_k)),
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
                chunk_id=int(_row_value(row, id_column)),
                score=score,
                distance=distance,
            )
        )
    return sorted(hits, key=lambda hit: hit.distance)[: int(top_k)]


def _ensure_vector_index(conn: Any, table: str) -> tuple[str | None, str]:
    hnsw_index = f"idx_{table}_embedding_vector_hnsw"
    ivfflat_index = f"idx_{table}_embedding_vector_ivfflat"
    try:
        conn.execute(
            f"""
            CREATE INDEX IF NOT EXISTS {hnsw_index}
            ON {table}
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
            CREATE INDEX IF NOT EXISTS {ivfflat_index}
            ON {table}
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


def _pgvector_search_ready(conn: Any, table: str) -> bool:
    return _pgvector_extension_installed(conn) and _column_exists(
        conn,
        table,
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


def _embedding_vector_type(conn: Any, table: str) -> str | None:
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
        (table, EMBEDDING_VECTOR_COLUMN),
    ).fetchone()
    value = _row_value(row, "data_type")
    return str(value) if value else None


def _infer_dimensions(conn: Any, table: str, id_column: str) -> int | None:
    try:
        row = conn.execute(
            f"""
            SELECT jsonb_array_length({EMBEDDING_JSON_COLUMN}::jsonb) AS dimensions
            FROM {table}
            WHERE NULLIF({EMBEDDING_JSON_COLUMN}, '') IS NOT NULL
            ORDER BY {id_column}
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


def _validated_table(table: str, id_column: str) -> tuple[str, str]:
    allowed = set(VECTOR_TABLES.values())
    pair = (str(table), str(id_column))
    if pair not in allowed:
        raise ValueError(f"Unsupported embedding table: {table}.{id_column}")
    return pair
