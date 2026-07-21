from __future__ import annotations

from .artifact_index import backfill_artifact_indexes
from .config import Settings
from .db_types import DbConnection
from .embeddings import (
    ensure_missing_note_chunk_embeddings,
)
from .library_search_index import backfill_library_paper_indexes


def backfill_search_indexes(conn: DbConnection, settings: Settings) -> dict[str, object]:
    model = str(settings.llm_embedding_model or "").strip()
    if not model:
        raise RuntimeError("Embedding model is not configured")

    library = backfill_library_paper_indexes(conn, settings)
    knowledge = ensure_missing_note_chunk_embeddings(
        conn,
        settings,
        excluded_source_types={"obsidian"},
    )
    artifacts = backfill_artifact_indexes(conn, settings)
    return {
        "model": model,
        **library,
        **knowledge,
        **artifacts,
    }
