from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from typing import Iterable
import sqlite3

from .config import Settings
from .db import from_json, to_json, utc_now


def cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def embed_text(settings: Settings, text: str) -> list[float] | None:
    provider = settings.embedding_provider()
    if not provider or not provider.api_key or not provider.base_url or not settings.llm_embedding_model:
        return None
    payload = {
        "model": settings.llm_embedding_model,
        "input": text[:8000],
    }
    request = urllib.request.Request(
        f"{provider.base_url}/embeddings",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {provider.api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Embedding request failed: {exc}") from exc
    data = body.get("data") or []
    if not data:
        return None
    embedding = data[0].get("embedding")
    if not isinstance(embedding, list):
        return None
    return [float(value) for value in embedding]


def embed_many(settings: Settings, texts: Iterable[str]) -> list[list[float] | None]:
    return [embed_text(settings, text) for text in texts]


def ensure_arxiv_chunk_embedding(
    conn: sqlite3.Connection,
    settings: Settings,
    arxiv_chunk_id: int,
    text: str,
) -> list[float] | None:
    if not settings.llm_embedding_model:
        return None
    existing = conn.execute(
        """
        SELECT embedding_json
        FROM arxiv_chunk_embeddings
        WHERE arxiv_chunk_id = ? AND model = ?
        """,
        (arxiv_chunk_id, settings.llm_embedding_model),
    ).fetchone()
    if existing:
        values = from_json(existing["embedding_json"], [])
        return [float(value) for value in values] if values else None

    embedding = embed_text(settings, text)
    if embedding is None:
        return None
    conn.execute(
        """
        INSERT OR REPLACE INTO arxiv_chunk_embeddings(arxiv_chunk_id, model, embedding_json, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (arxiv_chunk_id, settings.llm_embedding_model, to_json(embedding), utc_now()),
    )
    conn.commit()
    return embedding


def ensure_missing_arxiv_chunk_embeddings(
    conn: sqlite3.Connection,
    settings: Settings,
    limit: int | None = None,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> dict[str, int]:
    if not settings.llm_embedding_model:
        return {"arxiv_chunk_embeddings_created": 0, "arxiv_chunk_embeddings_skipped": 0}
    selected_ids = [int(paper_id) for paper_id in paper_ids or []]
    if paper_ids is not None and not selected_ids:
        return {"arxiv_chunk_embeddings_created": 0, "arxiv_chunk_embeddings_skipped": 0}
    sql = """
        SELECT c.id, c.text
        FROM arxiv_text_chunks c
        LEFT JOIN arxiv_chunk_embeddings e
          ON e.arxiv_chunk_id = c.id AND e.model = ?
        WHERE e.arxiv_chunk_id IS NULL
    """
    params: list[object] = [settings.llm_embedding_model]
    if selected_ids:
        placeholders = ", ".join("?" for _ in selected_ids)
        sql += f" AND c.paper_id IN ({placeholders})"
        params.extend(selected_ids)
    sql += " ORDER BY c.id"
    if limit:
        sql += " LIMIT ?"
        params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    created = 0
    skipped = 0
    for row in rows:
        embedding = embed_text(settings, row["text"])
        if embedding is None:
            skipped += 1
            continue
        conn.execute(
            """
            INSERT OR REPLACE INTO arxiv_chunk_embeddings(arxiv_chunk_id, model, embedding_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (int(row["id"]), settings.llm_embedding_model, to_json(embedding), utc_now()),
        )
        created += 1
    conn.commit()
    return {"arxiv_chunk_embeddings_created": created, "arxiv_chunk_embeddings_skipped": skipped}


def ensure_arxiv_paper_embedding(
    conn: sqlite3.Connection,
    settings: Settings,
    paper: sqlite3.Row,
) -> list[float] | None:
    if not settings.llm_embedding_model:
        return None
    existing = conn.execute(
        """
        SELECT embedding_json
        FROM arxiv_paper_embeddings
        WHERE paper_id = ? AND model = ?
        """,
        (int(paper["id"]), settings.llm_embedding_model),
    ).fetchone()
    if existing:
        values = from_json(existing["embedding_json"], [])
        return [float(value) for value in values] if values else None

    text = f"{paper['title']}\n\n{paper['summary']}"
    embedding = embed_text(settings, text)
    if embedding is None:
        return None
    conn.execute(
        """
        INSERT OR REPLACE INTO arxiv_paper_embeddings(paper_id, model, embedding_json, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (int(paper["id"]), settings.llm_embedding_model, to_json(embedding), utc_now()),
    )
    conn.commit()
    return embedding
