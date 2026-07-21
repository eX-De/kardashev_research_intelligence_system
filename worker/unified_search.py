from __future__ import annotations

import time
from typing import Any

from .config import Settings
from .db import clean_unicode, from_json
from .db_types import DbConnection
from .embeddings import cosine, embed_text
from .pgvector_search import ensure_pgvector_indexes, pgvector_embedding_search
from .search import tokenize
from .search_corpus import artifact_searchable_sql, searchable_library_paper_sql


VALID_ENTITY_TYPES = frozenset({"paper", "artifact", "project"})
DEFAULT_SEARCH_LIMIT = 30
MAX_SEARCH_LIMIT = 100
MIN_DEEP_SEARCH_SCORE = 0.4


def _types(value: object) -> set[str]:
    values = value if isinstance(value, list) else str(value or "").split(",")
    selected = {str(item).strip() for item in values if str(item).strip() in VALID_ENTITY_TYPES}
    return selected or set(VALID_ENTITY_TYPES)


def _limit(value: object) -> int:
    try:
        return max(1, min(int(value or DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT))
    except (TypeError, ValueError):
        return DEFAULT_SEARCH_LIMIT


def _json_vector_hits(
    conn: DbConnection,
    table: str,
    id_column: str,
    model: str,
    query_embedding: list[float],
    top_k: int,
    allowed_ids: set[int] | None = None,
) -> list[tuple[int, float]]:
    rows = conn.execute(
        f"SELECT {id_column}, embedding_json FROM {table} WHERE model = ?",
        (model,),
    ).fetchall()
    hits: list[tuple[int, float]] = []
    for row in rows:
        item_id = int(row[id_column])
        if allowed_ids is not None and item_id not in allowed_ids:
            continue
        values = from_json(row["embedding_json"], [])
        if not isinstance(values, list) or not values:
            continue
        score = max(0.0, min(1.0, cosine(query_embedding, [float(value) for value in values])))
        if score > 0:
            hits.append((item_id, score))
    hits.sort(key=lambda item: item[1], reverse=True)
    return hits[:top_k]


def _semantic_hits(
    conn: DbConnection,
    *,
    source: str,
    table: str,
    id_column: str,
    model: str,
    query_embedding: list[float],
    top_k: int,
    allowed_ids: set[int] | None = None,
) -> list[tuple[int, float]]:
    vector_hits = pgvector_embedding_search(
        conn,
        query_embedding,
        allowed_ids,
        top_k,
        table=table,
        id_column=id_column,
        model=model,
    )
    if vector_hits:
        return [(int(hit.chunk_id), float(hit.score)) for hit in vector_hits]
    return _json_vector_hits(conn, table, id_column, model, query_embedding, top_k, allowed_ids)


def _ensure_search_pgvector_indexes(conn: DbConnection, dimensions: int) -> dict[str, object]:
    results: dict[str, object] = {}
    for source, table, id_column in (
        ("knowledge", "chunk_embeddings", "chunk_id"),
        ("artifact", "artifact_chunk_embeddings", "artifact_chunk_id"),
        ("library_paper", "paper_embeddings", "paper_id"),
        ("library_paper_chunk", "paper_chunk_embeddings", "paper_chunk_id"),
    ):
        try:
            results[source] = ensure_pgvector_indexes(
                conn,
                dimensions,
                table=table,
                id_column=id_column,
            )
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            results[source] = {"supported": False, "reason": "init_failed", "error": str(exc)[:500]}
    return results


def _lexical_score(query: str, title: str, text: str) -> tuple[float, list[str]]:
    needle = query.strip().lower()
    title_text = clean_unicode(title).lower()
    body_text = clean_unicode(text).lower()
    matched: list[str] = []
    score = 0.0
    if needle and title_text == needle:
        matched.append("title")
        score = 1.0
    elif needle and title_text.startswith(needle):
        matched.append("title")
        score = 0.96
    elif needle and needle in title_text:
        matched.append("title")
        score = 0.90
    query_terms = set(tokenize(query))
    if query_terms:
        title_terms = set(tokenize(title_text))
        body_terms = set(tokenize(body_text))
        title_overlap = len(query_terms & title_terms) / len(query_terms)
        body_overlap = len(query_terms & body_terms) / len(query_terms)
        if title_overlap:
            if "title" not in matched:
                matched.append("title")
            score = max(score, 0.82 + (0.08 * title_overlap))
        if body_overlap:
            matched.append("keyword")
            score = max(score, 0.55 + (0.13 * body_overlap))
    elif needle and needle in body_text:
        matched.append("keyword")
        score = max(score, 0.68)
    return min(1.0, score), matched


def _snippet(text: object, limit: int = 360) -> str:
    value = " ".join(clean_unicode(str(text or "")).split())
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _date_allowed(updated_at: object, filters: dict[str, object]) -> bool:
    value = str(updated_at or "")[:10]
    date_from = str(filters.get("date_from") or "")[:10]
    date_to = str(filters.get("date_to") or "")[:10]
    return not ((date_from and value and value < date_from) or (date_to and value and value > date_to))


def _add_candidate(
    candidates: dict[tuple[str, int], dict[str, object]],
    *,
    query: str,
    entity_type: str,
    entity_id: int,
    title: str,
    snippet: str,
    semantic_score: float,
    source_type: str,
    project_id: int | None,
    updated_at: object,
    href: str,
    evidence: dict[str, object] | None = None,
    identity_namespace: str = "",
) -> None:
    key = (f"{entity_type}:{identity_namespace}" if identity_namespace else entity_type, int(entity_id))
    lexical_score, lexical_matches = _lexical_score(query, title, snippet)
    candidate = candidates.get(key)
    hit = {
        "source_type": source_type,
        "snippet": _snippet(snippet),
        "semantic_score": round(float(semantic_score), 6),
        **(evidence or {}),
    }
    if candidate is None:
        candidates[key] = {
            "entity_type": entity_type,
            "entity_id": int(entity_id),
            "title": clean_unicode(title),
            "snippet": _snippet(snippet),
            "semantic_score": float(semantic_score),
            "lexical_score": lexical_score,
            "matched_by": {"semantic", *lexical_matches},
            "source_type": source_type,
            "project_id": project_id,
            "updated_at": updated_at,
            "href": href,
            "hits": [hit],
        }
        return
    candidate["matched_by"].add("semantic")
    candidate["matched_by"].update(lexical_matches)
    candidate["hits"].append(hit)
    candidate["lexical_score"] = max(float(candidate["lexical_score"]), lexical_score)
    if semantic_score > float(candidate["semantic_score"]):
        candidate["semantic_score"] = float(semantic_score)
        candidate["snippet"] = _snippet(snippet)
        candidate["source_type"] = source_type


def _add_lexical_candidate(
    candidates: dict[tuple[str, int], dict[str, object]],
    *,
    query: str,
    entity_type: str,
    entity_id: int,
    title: str,
    snippet: str,
    source_type: str,
    project_id: int | None,
    updated_at: object,
    href: str,
    identity_namespace: str = "",
) -> None:
    lexical_score, lexical_matches = _lexical_score(query, title, snippet)
    if lexical_score <= 0:
        return
    key = (f"{entity_type}:{identity_namespace}" if identity_namespace else entity_type, int(entity_id))
    candidate = candidates.get(key)
    if candidate is None:
        candidates[key] = {
            "entity_type": entity_type,
            "entity_id": int(entity_id),
            "title": clean_unicode(title),
            "snippet": _snippet(snippet),
            "semantic_score": 0.0,
            "lexical_score": lexical_score,
            "matched_by": set(lexical_matches),
            "source_type": source_type,
            "project_id": project_id,
            "updated_at": updated_at,
            "href": href,
            "hits": [],
        }
        return
    previous_score = float(candidate["lexical_score"])
    candidate["lexical_score"] = max(previous_score, lexical_score)
    candidate["matched_by"].update(lexical_matches)
    if lexical_score > previous_score:
        candidate["snippet"] = _snippet(snippet)
        candidate["source_type"] = source_type


def _library_paper_lexical_results(
    conn: DbConnection,
    _model: str,
    query: str,
    _vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    if int(filters.get("project_id") or 0):
        return
    needle = query.lower()
    pattern = f"%{needle}%"
    rows = conn.execute(
        f"""
        SELECT p.id, p.title, p.abstract, p.authors_json, p.venue,
               p.user_tags_json, p.user_note, p.updated_at
        FROM papers p
        WHERE {searchable_library_paper_sql("p")} AND (
          LOWER(COALESCE(p.title, '')) LIKE ? OR LOWER(COALESCE(p.abstract, '')) LIKE ? OR
          LOWER(COALESCE(p.authors_json, '')) LIKE ? OR LOWER(COALESCE(p.venue, '')) LIKE ? OR
          LOWER(COALESCE(p.user_tags_json, '')) LIKE ? OR LOWER(COALESCE(p.user_note, '')) LIKE ?
        )
        ORDER BY CASE
          WHEN LOWER(COALESCE(p.title, '')) = ? THEN 0
          WHEN LOWER(COALESCE(p.title, '')) LIKE ? THEN 1
          WHEN LOWER(COALESCE(p.title, '')) LIKE ? THEN 2
          ELSE 3
        END, p.updated_at DESC
        LIMIT ?
        """,
        (pattern, pattern, pattern, pattern, pattern, pattern, needle, f"{needle}%", pattern, top_k),
    ).fetchall()
    for row in rows:
        if not _date_allowed(row["updated_at"], filters):
            continue
        paper_id = int(row["id"])
        _add_lexical_candidate(
            candidates,
            query=query,
            entity_type="paper",
            entity_id=paper_id,
            title=str(row["title"]),
            snippet=" ".join(str(row[key] or "") for key in ("abstract", "authors_json", "venue", "user_tags_json", "user_note")),
            source_type="library_paper",
            project_id=None,
            updated_at=row["updated_at"],
            href=f"/papers/library/{paper_id}",
            identity_namespace="library",
        )


def _library_paper_fulltext_lexical_results(
    conn: DbConnection,
    _model: str,
    query: str,
    _vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    if int(filters.get("project_id") or 0):
        return
    rows = conn.execute(
        f"""
        SELECT c.id, c.paper_id, c.text, c.page_start, c.page_end,
               p.title, p.updated_at
        FROM paper_chunks c
        JOIN papers p ON p.id = c.paper_id
        WHERE {searchable_library_paper_sql("p")} AND LOWER(COALESCE(c.text, '')) LIKE ?
        ORDER BY p.updated_at DESC, c.chunk_index
        LIMIT ?
        """,
        (f"%{query.lower()}%", top_k),
    ).fetchall()
    for row in rows:
        if not _date_allowed(row["updated_at"], filters):
            continue
        paper_id = int(row["paper_id"])
        _add_lexical_candidate(
            candidates,
            query=query,
            entity_type="paper",
            entity_id=paper_id,
            title=str(row["title"]),
            snippet=str(row["text"]),
            source_type="library_paper_chunk",
            project_id=None,
            updated_at=row["updated_at"],
            href=f"/papers/library/{paper_id}",
            identity_namespace="library",
        )


def _library_paper_reader_message_lexical_results(
    conn: DbConnection,
    _model: str,
    query: str,
    _vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    if int(filters.get("project_id") or 0):
        return
    rows = conn.execute(
        f"""
        SELECT m.id, m.content, m.created_at, p.id AS paper_id, p.title
        FROM paper_reader_messages m
        JOIN papers p ON p.id = m.library_paper_id
        WHERE {searchable_library_paper_sql("p")}
          AND LOWER(COALESCE(m.content, '')) LIKE ?
        ORDER BY m.created_at DESC
        LIMIT ?
        """,
        (f"%{query.lower()}%", top_k),
    ).fetchall()
    for row in rows:
        if not _date_allowed(row["created_at"], filters):
            continue
        paper_id = int(row["paper_id"])
        _add_lexical_candidate(
            candidates,
            query=query,
            entity_type="paper",
            entity_id=paper_id,
            title=str(row["title"]),
            snippet=str(row["content"]),
            source_type="paper_reader_message",
            project_id=None,
            updated_at=row["created_at"],
            href=f"/papers/library/{paper_id}",
            identity_namespace="library",
        )


def _artifact_lexical_results(
    conn: DbConnection,
    _model: str,
    query: str,
    _vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    needle = query.lower()
    prefix = f"{needle}%"
    pattern = f"%{needle}%"
    params: list[object] = [pattern, pattern]
    clauses = [
        artifact_searchable_sql("a"),
        "a.artifact_type <> 'project_chat_profile'",
        "(LOWER(COALESCE(a.title, '')) LIKE ? OR LOWER(COALESCE(a.content_markdown, '')) LIKE ?)",
    ]
    project_filter = int(filters.get("project_id") or 0)
    if project_filter:
        clauses.append("a.scope_type = 'project' AND a.scope_id = ?")
        params.append(project_filter)
    artifact_types = sorted({str(item).strip() for item in (filters.get("artifact_types") or []) if str(item).strip()})
    if artifact_types:
        clauses.append(f"a.artifact_type IN ({', '.join('?' for _ in artifact_types)})")
        params.extend(artifact_types)
    params.extend([needle, prefix, pattern, top_k])
    rows = conn.execute(
        f"""
        SELECT a.id, a.artifact_type, a.title, a.content_markdown,
               a.scope_type, a.scope_id, a.updated_at
        FROM artifacts a
        WHERE {' AND '.join(clauses)}
        ORDER BY CASE
          WHEN LOWER(COALESCE(a.title, '')) = ? THEN 0
          WHEN LOWER(COALESCE(a.title, '')) LIKE ? THEN 1
          WHEN LOWER(COALESCE(a.title, '')) LIKE ? THEN 2
          ELSE 3
        END, a.updated_at DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    for row in rows:
        if not _date_allowed(row["updated_at"], filters):
            continue
        artifact_id = int(row["id"])
        project_id = int(row["scope_id"] or 0) if str(row["scope_type"] or "") == "project" else 0
        _add_lexical_candidate(
            candidates,
            query=query,
            entity_type="artifact",
            entity_id=artifact_id,
            title=str(row["title"]),
            snippet=str(row["content_markdown"]),
            source_type=str(row["artifact_type"]),
            project_id=project_id or None,
            updated_at=row["updated_at"],
            href=f"/artifacts/{artifact_id}",
        )


def _project_lexical_results(
    conn: DbConnection,
    _model: str,
    query: str,
    _vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    needle = query.lower()
    prefix = f"{needle}%"
    pattern = f"%{needle}%"
    params: list[object] = [pattern, pattern, pattern, pattern, pattern, pattern]
    clauses = [
        """(
          LOWER(COALESCE(rp.name, '')) LIKE ? OR
          LOWER(COALESCE(rp.summary, '')) LIKE ? OR
          LOWER(COALESCE(rp.goals, '')) LIKE ? OR
          LOWER(COALESCE(rp.keywords_json, '')) LIKE ? OR
          EXISTS (
            SELECT 1 FROM artifacts profile
            WHERE profile.artifact_type = 'project_chat_profile'
              AND profile.scope_type = 'project' AND profile.scope_id = rp.id
              AND profile.status = 'ready'
              AND (LOWER(COALESCE(profile.title, '')) LIKE ? OR LOWER(COALESCE(profile.content_markdown, '')) LIKE ?)
          )
        )"""
    ]
    project_filter = int(filters.get("project_id") or 0)
    if project_filter:
        clauses.append("rp.id = ?")
        params.append(project_filter)
    params.extend([needle, prefix, pattern, top_k])
    rows = conn.execute(
        f"""
        SELECT rp.id, rp.name, rp.summary, rp.goals, rp.keywords_json, rp.updated_at,
               COALESCE((
                 SELECT profile.content_markdown FROM artifacts profile
                 WHERE profile.artifact_type = 'project_chat_profile'
                   AND profile.scope_type = 'project' AND profile.scope_id = rp.id
                   AND profile.status = 'ready'
                 ORDER BY profile.updated_at DESC, profile.id DESC LIMIT 1
               ), '') AS profile_content
        FROM research_projects rp
        WHERE {' AND '.join(clauses)}
        ORDER BY CASE
          WHEN LOWER(COALESCE(rp.name, '')) = ? THEN 0
          WHEN LOWER(COALESCE(rp.name, '')) LIKE ? THEN 1
          WHEN LOWER(COALESCE(rp.name, '')) LIKE ? THEN 2
          ELSE 3
        END, rp.updated_at DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    for row in rows:
        if not _date_allowed(row["updated_at"], filters):
            continue
        project_id = int(row["id"])
        snippet = " ".join(
            str(row[key] or "").strip()
            for key in ("summary", "goals", "keywords_json", "profile_content")
            if str(row[key] or "").strip()
        )
        _add_lexical_candidate(
            candidates,
            query=query,
            entity_type="project",
            entity_id=project_id,
            title=str(row["name"]),
            snippet=snippet,
            source_type="project",
            project_id=project_id,
            updated_at=row["updated_at"],
            href=f"/projects/{project_id}",
        )


def _library_paper_results(
    conn: DbConnection,
    model: str,
    query: str,
    vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    if int(filters.get("project_id") or 0):
        return
    searchable_ids = {
        int(row["id"])
        for row in conn.execute(
            f"SELECT id FROM papers p WHERE {searchable_library_paper_sql('p')}"
        ).fetchall()
    }
    if not searchable_ids:
        return
    hits = _semantic_hits(
        conn, source="library_paper", table="paper_embeddings", id_column="paper_id",
        model=model, query_embedding=vector, top_k=top_k, allowed_ids=searchable_ids,
    )
    scores = {item_id: score for item_id, score in hits}
    if not scores:
        return
    ids = sorted(scores)
    rows = conn.execute(
        f"""
        SELECT p.id, p.title, p.abstract, p.authors_json, p.venue,
               p.user_tags_json, p.user_note, p.updated_at
        FROM papers p
        WHERE p.id IN ({', '.join('?' for _ in ids)})
          AND {searchable_library_paper_sql("p")}
        """,
        ids,
    ).fetchall()
    for row in rows:
        if not _date_allowed(row["updated_at"], filters):
            continue
        paper_id = int(row["id"])
        _add_candidate(
            candidates,
            query=query,
            entity_type="paper",
            entity_id=paper_id,
            title=str(row["title"]),
            snippet=" ".join(str(row[key] or "") for key in ("abstract", "authors_json", "venue", "user_tags_json", "user_note")),
            semantic_score=scores[paper_id],
            source_type="library_paper",
            project_id=None,
            updated_at=row["updated_at"],
            href=f"/papers/library/{paper_id}",
            identity_namespace="library",
        )


def _library_paper_chunk_results(
    conn: DbConnection,
    model: str,
    query: str,
    vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    if int(filters.get("project_id") or 0):
        return
    searchable_chunk_ids = {
        int(row["id"])
        for row in conn.execute(
            f"""
            SELECT c.id
            FROM paper_chunks c
            JOIN papers p ON p.id = c.paper_id
            WHERE {searchable_library_paper_sql('p')}
            """
        ).fetchall()
    }
    if not searchable_chunk_ids:
        return
    hits = _semantic_hits(
        conn, source="library_paper_chunk", table="paper_chunk_embeddings", id_column="paper_chunk_id",
        model=model, query_embedding=vector, top_k=top_k, allowed_ids=searchable_chunk_ids,
    )
    scores = {item_id: score for item_id, score in hits}
    if not scores:
        return
    ids = sorted(scores)
    rows = conn.execute(
        f"""
        SELECT c.id, c.paper_id, c.text, c.page_start, c.page_end,
               p.title, p.updated_at
        FROM paper_chunks c
        JOIN papers p ON p.id = c.paper_id
        WHERE c.id IN ({', '.join('?' for _ in ids)})
          AND {searchable_library_paper_sql("p")}
        """,
        ids,
    ).fetchall()
    for row in rows:
        if not _date_allowed(row["updated_at"], filters):
            continue
        paper_id = int(row["paper_id"])
        _add_candidate(
            candidates,
            query=query,
            entity_type="paper",
            entity_id=paper_id,
            title=str(row["title"]),
            snippet=str(row["text"]),
            semantic_score=scores[int(row["id"])],
            source_type="library_paper_chunk",
            project_id=None,
            updated_at=row["updated_at"],
            href=f"/papers/library/{paper_id}",
            evidence={"page_start": row["page_start"], "page_end": row["page_end"]},
            identity_namespace="library",
        )


def _artifact_results(
    conn: DbConnection,
    model: str,
    query: str,
    vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    hits = _semantic_hits(
        conn, source="artifact", table="artifact_chunk_embeddings", id_column="artifact_chunk_id",
        model=model, query_embedding=vector, top_k=top_k,
    )
    scores = {item_id: score for item_id, score in hits}
    if not scores:
        return
    ids = sorted(scores)
    placeholders = ", ".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT c.id, c.text, a.id AS artifact_id, a.artifact_type, a.title,
               a.scope_type, a.scope_id, a.status, a.updated_at, rp.name AS project_name
        FROM artifact_chunks c
        JOIN artifacts a ON a.id = c.artifact_id
        LEFT JOIN research_projects rp ON rp.id = a.scope_id AND a.scope_type = 'project'
        WHERE c.id IN ({placeholders}) AND {artifact_searchable_sql("a")}
        """,
        ids,
    ).fetchall()
    artifact_types = {str(item).strip() for item in (filters.get("artifact_types") or []) if str(item).strip()}
    project_filter = int(filters.get("project_id") or 0)
    for row in rows:
        artifact_type = str(row["artifact_type"])
        if artifact_types and artifact_type not in artifact_types:
            continue
        if project_filter and int(row["scope_id"] or 0) != project_filter:
            continue
        if not _date_allowed(row["updated_at"], filters):
            continue
        is_project = artifact_type == "project_chat_profile"
        entity_id = int(row["scope_id"] or 0) if is_project else int(row["artifact_id"])
        if not entity_id:
            continue
        _add_candidate(
            candidates, query=query, entity_type="project" if is_project else "artifact", entity_id=entity_id,
            title=str(row["project_name"] or row["title"]) if is_project else str(row["title"]),
            snippet=str(row["text"]), semantic_score=scores[int(row["id"])],
            source_type=artifact_type, project_id=int(row["scope_id"] or 0) or None,
            updated_at=row["updated_at"], href=f"/projects/{entity_id}" if is_project else f"/artifacts/{entity_id}",
        )


def _knowledge_lexical_results(
    conn: DbConnection,
    _model: str,
    query: str,
    _vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    pattern = f"%{query.lower()}%"
    rows = conn.execute(
        """
        SELECT kd.id, kd.source_type, kd.title, kd.raw_content, kd.metadata_json,
               kd.updated_at, pcd.project_id
        FROM knowledge_documents kd
        LEFT JOIN project_context_documents pcd ON pcd.document_id = kd.id
        WHERE kd.source_type <> 'obsidian'
          AND (LOWER(COALESCE(kd.title, '')) LIKE ? OR LOWER(COALESCE(kd.raw_content, '')) LIKE ?)
        ORDER BY kd.updated_at DESC
        LIMIT ?
        """,
        (pattern, pattern, top_k),
    ).fetchall()
    project_filter = int(filters.get("project_id") or 0)
    artifact_types = {str(item).strip() for item in (filters.get("artifact_types") or []) if str(item).strip()}
    for row in rows:
        if not _date_allowed(row["updated_at"], filters):
            continue
        metadata = from_json(row["metadata_json"], {})
        metadata = metadata if isinstance(metadata, dict) else {}
        source_type = str(row["source_type"] or "")
        if source_type == "experiment_report":
            if "artifact" not in _types(filters.get("selected_types")):
                continue
            if artifact_types and source_type not in artifact_types:
                continue
            artifact_id = int(metadata.get("artifact_id") or 0)
            if not artifact_id:
                continue
            artifact = conn.execute(
                "SELECT id, title, scope_id, status, updated_at FROM artifacts WHERE id = ? AND artifact_type = 'experiment_report'",
                (artifact_id,),
            ).fetchone()
            if not artifact or str(artifact["status"] or "") != "ready":
                continue
            artifact_project_id = int(artifact["scope_id"] or 0) or None
            if project_filter and artifact_project_id != project_filter:
                continue
            _add_lexical_candidate(
                candidates, query=query, entity_type="artifact", entity_id=artifact_id,
                title=str(artifact["title"]), snippet=str(row["raw_content"]), source_type=source_type,
                project_id=artifact_project_id, updated_at=artifact["updated_at"], href=f"/artifacts/{artifact_id}",
            )
            continue
        if "project" not in _types(filters.get("selected_types")):
            continue
        project_id = int(row["project_id"] or metadata.get("project_id") or 0)
        if not project_id or (project_filter and project_id != project_filter):
            continue
        project = conn.execute(
            "SELECT name, updated_at FROM research_projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if not project:
            continue
        _add_lexical_candidate(
            candidates, query=query, entity_type="project", entity_id=project_id,
            title=str(project["name"]), snippet=str(row["raw_content"]), source_type=source_type,
            project_id=project_id, updated_at=row["updated_at"], href=f"/projects/{project_id}",
        )


def _knowledge_results(
    conn: DbConnection,
    model: str,
    query: str,
    vector: list[float],
    top_k: int,
    candidates: dict[tuple[str, int], dict[str, object]],
    filters: dict[str, object],
) -> None:
    hits = _semantic_hits(
        conn, source="knowledge", table="chunk_embeddings", id_column="chunk_id",
        model=model, query_embedding=vector, top_k=top_k,
    )
    scores = {item_id: score for item_id, score in hits}
    if not scores:
        return
    ids = sorted(scores)
    placeholders = ", ".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT c.id, c.text, kd.id AS document_id, kd.source_type, kd.metadata_json,
               kd.updated_at, pcd.project_id AS linked_project_id
        FROM research_chunks c
        JOIN knowledge_documents kd ON kd.id = c.document_id
        LEFT JOIN project_context_documents pcd ON pcd.document_id = kd.id
        WHERE c.id IN ({placeholders}) AND kd.source_type <> 'obsidian'
        """,
        ids,
    ).fetchall()
    project_filter = int(filters.get("project_id") or 0)
    artifact_types = {str(item).strip() for item in (filters.get("artifact_types") or []) if str(item).strip()}
    for row in rows:
        metadata = from_json(row["metadata_json"], {})
        metadata = metadata if isinstance(metadata, dict) else {}
        source_type = str(row["source_type"] or "")
        if source_type == "experiment_report":
            if "artifact" not in _types(filters.get("selected_types")):
                continue
            if artifact_types and source_type not in artifact_types:
                continue
            artifact_id = int(metadata.get("artifact_id") or 0)
            if not artifact_id:
                continue
            artifact = conn.execute(
                "SELECT id, title, scope_id, status, updated_at FROM artifacts WHERE id = ? AND artifact_type = 'experiment_report'",
                (artifact_id,),
            ).fetchone()
            if not artifact or str(artifact["status"] or "") != "ready":
                continue
            project_id = int(artifact["scope_id"] or 0) or None
            if project_filter and project_id != project_filter:
                continue
            if not _date_allowed(artifact["updated_at"], filters):
                continue
            _add_candidate(
                candidates, query=query, entity_type="artifact", entity_id=artifact_id,
                title=str(artifact["title"]), snippet=str(row["text"]), semantic_score=scores[int(row["id"])],
                source_type=source_type, project_id=project_id, updated_at=artifact["updated_at"],
                href=f"/artifacts/{artifact_id}",
            )
            continue
        if "project" not in _types(filters.get("selected_types")):
            continue
        project_id = int(row["linked_project_id"] or metadata.get("project_id") or 0)
        if not project_id or (project_filter and project_id != project_filter):
            continue
        project = conn.execute("SELECT name, updated_at FROM research_projects WHERE id = ?", (project_id,)).fetchone()
        if not project or not _date_allowed(row["updated_at"], filters):
            continue
        _add_candidate(
            candidates, query=query, entity_type="project", entity_id=project_id,
            title=str(project["name"]), snippet=str(row["text"]), semantic_score=scores[int(row["id"])],
            source_type=source_type, project_id=project_id, updated_at=row["updated_at"],
            href=f"/projects/{project_id}",
        )


def deep_search(conn: DbConnection, settings: Settings, payload: dict[str, object]) -> dict[str, object]:
    started = time.perf_counter()
    try:
        timeout_ms = max(1_000, min(int(payload.get("timeout_ms") or 60_000), 120_000))
    except (TypeError, ValueError):
        timeout_ms = 60_000
    deadline = started + (timeout_ms / 1000)
    query = clean_unicode(str(payload.get("query") or payload.get("q") or "")).strip()
    if not query:
        raise RuntimeError("Search query is required")
    limit = _limit(payload.get("limit"))
    selected_types = _types(payload.get("types"))
    filters = payload.get("filters") if isinstance(payload.get("filters"), dict) else {}
    filters = {**filters}
    filters["selected_types"] = sorted(selected_types)
    if payload.get("project_id") is not None:
        filters["project_id"] = payload.get("project_id")
    if payload.get("artifact_types") is not None:
        raw = payload.get("artifact_types")
        filters["artifact_types"] = raw if isinstance(raw, list) else str(raw or "").split(",")
    for key in ("date_from", "date_to"):
        if payload.get(key):
            filters[key] = payload.get(key)

    model = clean_unicode(settings.llm_embedding_model).strip()
    if not model:
        raise RuntimeError("Embedding model is not configured")
    query_embedding = embed_text(settings, query)
    if not query_embedding:
        raise RuntimeError("Query embedding returned no vector")

    try:
        _ensure_search_pgvector_indexes(conn, len(query_embedding))
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass

    candidates: dict[tuple[str, int], dict[str, object]] = {}
    partial_failures: list[dict[str, str]] = []
    searched_sources: list[str] = []
    top_k = max(limit * 4, 40)
    source_calls: list[tuple[str, Any]] = []
    if "paper" in selected_types:
        source_calls.append(("library_paper_keywords", _library_paper_lexical_results))
        source_calls.append(("library_paper_fulltext_keywords", _library_paper_fulltext_lexical_results))
        source_calls.append(("library_paper_reader_message_keywords", _library_paper_reader_message_lexical_results))
        source_calls.append(("library_papers", _library_paper_results))
        source_calls.append(("library_paper_chunks", _library_paper_chunk_results))
    if "artifact" in selected_types:
        source_calls.append(("artifact_keywords", _artifact_lexical_results))
    if "project" in selected_types:
        source_calls.append(("project_keywords", _project_lexical_results))
    if selected_types & {"artifact", "project"}:
        source_calls.append(("artifact_chunks", _artifact_results))
    if selected_types & {"artifact", "project"}:
        source_calls.append(("knowledge_keywords", _knowledge_lexical_results))
        source_calls.append(("non_obsidian_knowledge", _knowledge_results))
    for source, loader in source_calls:
        if time.perf_counter() >= deadline:
            partial_failures.append({"source": source, "error": f"search timeout after {timeout_ms} ms"})
            continue
        try:
            loader(conn, model, query, query_embedding, top_k, candidates, filters)
            searched_sources.append(source)
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            partial_failures.append({"source": source, "error": str(exc)[:500]})

    results: list[dict[str, object]] = []
    retrieval_counts = {"keyword": 0, "semantic": 0, "fused": 0}
    filtered_by_score_threshold = 0
    for candidate in candidates.values():
        if candidate["entity_type"] not in selected_types:
            continue
        hit_count = len(candidate["hits"])
        semantic_score = float(candidate["semantic_score"])
        lexical_score = float(candidate["lexical_score"])
        has_semantic = semantic_score > 0
        has_lexical = lexical_score > 0
        if has_semantic:
            retrieval_counts["semantic"] += 1
        if has_lexical:
            retrieval_counts["keyword"] += 1
        if has_semantic and has_lexical:
            retrieval_counts["fused"] += 1
        semantic_component = 0.86 * semantic_score
        fusion_bonus = 0.04 * min(semantic_score, lexical_score) if has_semantic and has_lexical else 0.0
        score = min(
            1.0,
            max(semantic_component, lexical_score)
            + fusion_bonus
            + min(0.06, max(0, hit_count - 1) * 0.02),
        )
        if score < MIN_DEEP_SEARCH_SCORE:
            filtered_by_score_threshold += 1
            continue
        ordered_hits = sorted(candidate["hits"], key=lambda item: float(item["semantic_score"]), reverse=True)[:3]
        results.append({
            **{key: value for key, value in candidate.items() if key not in {"semantic_score", "lexical_score", "hits"}},
            "score": round(score, 6),
            "matched_by": sorted(candidate["matched_by"]),
            "evidence": ordered_hits,
        })
    results.sort(key=lambda item: (float(item["score"]), str(item.get("updated_at") or "")), reverse=True)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return {
        "mode": "deep",
        "query": query,
        "results": results[:limit],
        "stats": {
            "query_embedding_model": model,
            "searched_sources": searched_sources,
            "retrieval_counts": retrieval_counts,
            "score_threshold": MIN_DEEP_SEARCH_SCORE,
            "filtered_by_score_threshold": filtered_by_score_threshold,
            "partial_failures": partial_failures,
            "partial": bool(partial_failures),
            "elapsed_ms": elapsed_ms,
        },
    }
