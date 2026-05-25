from __future__ import annotations

import hashlib
import re
from .db_types import DbConnection, DbRow
from typing import Callable, Iterable

from .config import Settings
from .db import clean_unicode, to_json, utc_now
from .embeddings import embed_text

HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
POSTGRES_DOCUMENT_LOCK_NAMESPACE = 724018
POSTGRES_LEGACY_NOTE_LOCK_NAMESPACE = 724019


def content_hash(text: str) -> str:
    return hashlib.sha256(clean_unicode(text).encode("utf-8")).hexdigest()


def chunk_markdown(title: str, raw_content: str, max_chars: int = 1400) -> list[dict[str, object]]:
    body = clean_unicode(raw_content).strip()
    heading = clean_unicode(title).strip() or "Project context"
    parts: list[dict[str, str]] = []
    current: list[str] = []

    for line in body.splitlines():
        match = HEADING_PATTERN.match(line)
        if match and current:
            parts.extend(_split_block(heading, "\n".join(current), max_chars))
            current = []
            heading = clean_unicode(match.group(2).strip()) or heading
        current.append(line)
    if current:
        parts.extend(_split_block(heading, "\n".join(current), max_chars))

    clean_parts: list[dict[str, object]] = []
    seen: set[str] = set()
    for part in parts:
        text = re.sub(r"\s+", " ", str(part["text"])).strip()
        if len(text) < 40 or text in seen:
            continue
        seen.add(text)
        clean_parts.append(
            {
                "heading": clean_unicode(str(part["heading"]))[:240],
                "text": clean_unicode(text),
                "token_count": max(1, len(text.split())),
            }
        )
    return clean_parts


def _split_block(heading: str, text: str, max_chars: int) -> list[dict[str, str]]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[dict[str, str]] = []
    current = ""
    for paragraph in paragraphs:
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            chunks.append({"heading": heading, "text": current})
        current = paragraph[:max_chars]
    if current:
        chunks.append({"heading": heading, "text": current})
    return chunks


def upsert_knowledge_document(
    conn: DbConnection,
    settings: Settings,
    *,
    source_type: str,
    source_uri: str,
    title: str,
    raw_content: str,
    metadata: dict[str, object] | None = None,
    chunks: Iterable[dict[str, object]] | None = None,
    content_hash_value: str | None = None,
    legacy_note_id: int | None = None,
    chunk_source: str | None = None,
    embedder: Callable[[Settings, str], list[float] | None] | None = None,
    commit: bool = True,
) -> dict[str, object]:
    source_type = clean_unicode(source_type).strip()
    source_uri = clean_unicode(source_uri).strip()
    title = clean_unicode(title).strip() or "Untitled"
    raw_content = clean_unicode(raw_content)
    digest = content_hash_value or content_hash(raw_content)
    now = utc_now()
    metadata = metadata or {}

    existing = conn.execute(
        """
        SELECT id, content_hash
        FROM knowledge_documents
        WHERE source_type = ? AND source_uri = ?
        ORDER BY id
        LIMIT 1
        """,
        (source_type, source_uri),
    ).fetchone()
    if existing:
        document_id = int(existing["id"])
        conn.execute(
            """
            UPDATE knowledge_documents
            SET title = ?,
                raw_content = ?,
                content_hash = ?,
                metadata_json = ?,
                indexed_at = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (title, raw_content, digest, to_json(metadata), now, now, document_id),
        )
    else:
        cur = conn.execute(
            """
            INSERT INTO knowledge_documents(
              source_type, source_uri, title, raw_content, content_hash,
              metadata_json, indexed_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (source_type, source_uri, title, raw_content, digest, to_json(metadata), now, now, now),
        )
        document_id = int(cur.lastrowid or 0)
        if not document_id:
            row = conn.execute(
                """
                SELECT id
                FROM knowledge_documents
                WHERE source_type = ? AND source_uri = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (source_type, source_uri),
            ).fetchone()
            document_id = int(row["id"])

    chunk_rows = list(chunks) if chunks is not None else chunk_markdown(title, raw_content)
    needs_chunk_refresh = _document_chunk_count(conn, document_id) == 0
    if existing and existing["content_hash"] != digest:
        needs_chunk_refresh = True
    if legacy_note_id is not None and _legacy_note_chunk_count_without_document(conn, legacy_note_id) > 0:
        needs_chunk_refresh = True

    chunks_created = 0
    embeddings_created = 0
    if needs_chunk_refresh:
        chunks_created, embeddings_created = replace_document_chunks(
            conn,
            settings,
            document_id=document_id,
            chunks=chunk_rows,
            source=chunk_source or source_type,
            legacy_note_id=legacy_note_id,
            embedder=embedder,
        )

    if commit:
        conn.commit()
    return {
        "document_id": document_id,
        "chunks_created": chunks_created,
        "embeddings_created": embeddings_created,
        "content_hash": digest,
        "indexed": 1 if chunks_created else 0,
    }


def replace_document_chunks(
    conn: DbConnection,
    settings: Settings,
    *,
    document_id: int,
    chunks: Iterable[dict[str, object]],
    source: str,
    legacy_note_id: int | None = None,
    embedder: Callable[[Settings, str], list[float] | None] | None = None,
) -> tuple[int, int]:
    if getattr(conn, "dialect", "") == "postgres":
        conn.execute("SELECT pg_advisory_xact_lock(?, ?)", (POSTGRES_DOCUMENT_LOCK_NAMESPACE, int(document_id)))
        if legacy_note_id is not None:
            conn.execute(
                "SELECT pg_advisory_xact_lock(?, ?)",
                (POSTGRES_LEGACY_NOTE_LOCK_NAMESPACE, int(legacy_note_id)),
            )
    if legacy_note_id is not None:
        conn.execute(
            """
            DELETE FROM research_chunks
            WHERE note_id = ?
              AND (document_id IS NULL OR document_id != ?)
            """,
            (legacy_note_id, document_id),
        )
    conn.execute("DELETE FROM research_chunks WHERE document_id = ?", (document_id,))

    now = utc_now()
    created = 0
    embeddings_created = 0
    for index, chunk in enumerate(chunks):
        text = clean_unicode(str(chunk.get("text") or "")).strip()
        if not text:
            continue
        cur = conn.execute(
            """
            INSERT INTO research_chunks(
              note_id, document_id, chunk_index, heading, text, token_count, source, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                legacy_note_id,
                document_id,
                index,
                clean_unicode(str(chunk.get("heading") or ""))[:240],
                text,
                int(chunk.get("token_count") or max(1, len(text.split()))),
                clean_unicode(source),
                now,
            ),
        )
        created += 1
        embedding = (embedder or embed_text)(settings, text)
        if embedding is not None:
            conn.execute(
                """
                INSERT INTO chunk_embeddings(chunk_id, model, embedding_json, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(chunk_id) DO UPDATE SET
                    model = excluded.model,
                    embedding_json = excluded.embedding_json,
                    created_at = excluded.created_at
                """,
                (int(cur.lastrowid), settings.llm_embedding_model, to_json(embedding), now),
            )
            embeddings_created += 1
    return created, embeddings_created


def link_project_context_document(
    conn: DbConnection,
    project_id: int,
    document_id: int,
    *,
    relation: str = "source",
    weight: float = 1.0,
    commit: bool = True,
) -> None:
    now = utc_now()
    conn.execute(
        """
        INSERT INTO project_context_documents(
          project_id, document_id, relation, weight, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, document_id, relation) DO UPDATE SET
          weight = excluded.weight,
          updated_at = excluded.updated_at
        """,
        (project_id, document_id, relation, float(weight), now, now),
    )
    if commit:
        conn.commit()


def save_project_context_document(
    conn: DbConnection,
    settings: Settings,
    project_id: int,
    *,
    title: str,
    raw_content: str,
    source_type: str = "manual_project",
    source_uri: str | None = None,
    relation: str = "source",
    weight: float = 1.0,
    metadata: dict[str, object] | None = None,
    commit: bool = True,
) -> dict[str, object]:
    source_uri = source_uri or f"project:{project_id}:manual_context"
    result = upsert_knowledge_document(
        conn,
        settings,
        source_type=source_type,
        source_uri=source_uri,
        title=title,
        raw_content=raw_content,
        metadata={**(metadata or {}), "project_id": project_id},
        chunk_source=source_type,
        commit=False,
    )
    link_project_context_document(
        conn,
        project_id,
        int(result["document_id"]),
        relation=relation,
        weight=weight,
        commit=False,
    )
    if commit:
        conn.commit()
    return result


def save_manual_project_context(
    conn: DbConnection,
    settings: Settings,
    project_id: int,
    raw_context: str,
    *,
    title: str | None = None,
    source_uri: str | None = None,
    relation: str = "primary",
    weight: float = 1.0,
    commit: bool = True,
) -> dict[str, object]:
    if not clean_unicode(raw_context).strip():
        raise RuntimeError("Project context cannot be empty")
    project = conn.execute(
        "SELECT name FROM research_projects WHERE id = ?",
        (project_id,),
    ).fetchone()
    if not project:
        raise RuntimeError(f"Project not found: {project_id}")
    return save_project_context_document(
        conn,
        settings,
        project_id,
        title=title or f"{project['name']} context",
        raw_content=raw_context,
        source_type="manual_project",
        source_uri=source_uri,
        relation=relation,
        weight=weight,
        metadata={"created_from": "manual_project_context"},
        commit=commit,
    )


def sync_project_context_documents_from_project_notes(conn: DbConnection, *, commit: bool = True) -> int:
    rows = conn.execute(
        """
        SELECT pn.project_id, pn.relation, kd.id AS document_id
        FROM project_notes pn
        JOIN obsidian_notes n ON n.id = pn.note_id
        JOIN knowledge_documents kd
          ON kd.source_type = 'obsidian' AND kd.source_uri = n.path
        """
    ).fetchall()
    synced = 0
    for row in rows:
        link_project_context_document(
            conn,
            int(row["project_id"]),
            int(row["document_id"]),
            relation=str(row["relation"] or "source"),
            weight=1.0,
            commit=False,
        )
        synced += 1
    if commit:
        conn.commit()
    return synced


def _document_chunk_count(conn: DbConnection, document_id: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS count FROM research_chunks WHERE document_id = ?",
        (document_id,),
    ).fetchone()
    return int(row["count"] or 0)


def _legacy_note_chunk_count_without_document(conn: DbConnection, note_id: int) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS count
        FROM research_chunks
        WHERE note_id = ? AND document_id IS NULL
        """,
        (note_id,),
    ).fetchone()
    return int(row["count"] or 0)
