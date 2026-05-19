from __future__ import annotations

import hashlib
import sqlite3
from typing import Any

from .artifacts import migrate_legacy_artifact_tables
from .db import from_json, to_json, utc_now


def migrate_system_first_sqlite(
    conn: sqlite3.Connection,
    *,
    drop_legacy_artifact_tables: bool = False,
) -> dict[str, int]:
    """Copy legacy SQLite data into the system-first tables."""
    stats: dict[str, int] = {}
    note_documents = _migrate_obsidian_notes(conn)
    stats["obsidian_notes_seen"] = _count(conn, "obsidian_notes")
    stats["knowledge_documents_from_obsidian"] = len(note_documents)
    stats["research_chunks_linked_to_documents"] = _link_research_chunks(conn, note_documents)
    stats["project_context_documents_from_project_notes"] = _migrate_project_notes(
        conn,
        note_documents,
    )
    stats["project_context_documents_from_project_obsidian_note"] = (
        _migrate_project_obsidian_note_links(conn, note_documents)
    )

    paper_ids = _migrate_arxiv_papers(conn)
    stats["arxiv_papers_seen"] = _count(conn, "arxiv_papers")
    stats["papers_from_arxiv"] = len(paper_ids)
    stats["paper_sources_from_arxiv"] = _count_where(
        conn,
        "paper_sources",
        "source_type = 'arxiv'",
    )
    stats["paper_assets_from_arxiv"] = _count_paper_assets_for_sources(conn, "arxiv")
    stats["paper_chunks_from_arxiv"] = _migrate_arxiv_text_chunks(conn, paper_ids)

    stats.update(
        migrate_legacy_artifact_tables(
            conn,
            drop_legacy=drop_legacy_artifact_tables,
        )
    )
    conn.commit()
    return stats


def validate_system_first_migration(conn: sqlite3.Connection) -> dict[str, int]:
    """Return old/new row counts useful for migration smoke checks."""
    return {
        "obsidian_notes": _count(conn, "obsidian_notes"),
        "knowledge_documents_obsidian": _count_where(
            conn,
            "knowledge_documents",
            "source_type = 'obsidian'",
        ),
        "research_chunks": _count(conn, "research_chunks"),
        "research_chunks_with_document": _count_where(
            conn,
            "research_chunks",
            "document_id IS NOT NULL",
        ),
        "project_notes": _count(conn, "project_notes"),
        "project_context_documents": _count(conn, "project_context_documents"),
        "arxiv_papers": _count(conn, "arxiv_papers"),
        "papers_arxiv": _count_where(conn, "papers", "canonical_key LIKE 'arxiv:%'"),
        "paper_sources_arxiv": _count_where(conn, "paper_sources", "source_type = 'arxiv'"),
        "arxiv_text_chunks": _count(conn, "arxiv_text_chunks"),
        "paper_chunks": _count(conn, "paper_chunks"),
        "paper_reading_reports": _count(conn, "paper_reading_reports"),
        "paper_report_artifacts": _count_where(
            conn,
            "artifacts",
            "scope_type = 'paper' AND artifact_type = 'paper_report'",
        ),
        "project_artifacts": _count(conn, "project_artifacts"),
        "project_artifact_artifacts": _count_where(conn, "artifacts", "scope_type = 'project'"),
    }


def _migrate_obsidian_notes(conn: sqlite3.Connection) -> dict[int, int]:
    note_documents: dict[int, int] = {}
    for note in conn.execute("SELECT * FROM obsidian_notes ORDER BY id").fetchall():
        note_id = int(note["id"])
        chunks = conn.execute(
            """
            SELECT heading, text
            FROM research_chunks
            WHERE note_id = ?
            ORDER BY chunk_index
            """,
            (note_id,),
        ).fetchall()
        raw_content = "\n\n".join(_chunk_markdown(chunk) for chunk in chunks)
        metadata = {
            "legacy_obsidian_note_id": note_id,
            "frontmatter": from_json(note["frontmatter_json"], {}),
            "tags": from_json(note["tags_json"], []),
            "mtime": note["mtime"],
        }
        document_id = _upsert_knowledge_document(
            conn,
            source_type="obsidian",
            source_uri=str(note["path"] or ""),
            title=str(note["title"] or ""),
            raw_content=raw_content,
            content_hash=str(note["sha256"] or "") or _sha256(raw_content),
            metadata=metadata,
            indexed_at=str(note["indexed_at"] or utc_now()),
            created_at=str(note["indexed_at"] or utc_now()),
            updated_at=str(note["indexed_at"] or utc_now()),
        )
        note_documents[note_id] = document_id
    return note_documents


def _link_research_chunks(conn: sqlite3.Connection, note_documents: dict[int, int]) -> int:
    linked = 0
    for note_id, document_id in note_documents.items():
        cursor = conn.execute(
            """
            UPDATE research_chunks
            SET document_id = ?
            WHERE note_id = ? AND (document_id IS NULL OR document_id != ?)
            """,
            (document_id, note_id, document_id),
        )
        linked += int(cursor.rowcount or 0)
    return _count_where(conn, "research_chunks", "document_id IS NOT NULL")


def _migrate_project_notes(conn: sqlite3.Connection, note_documents: dict[int, int]) -> int:
    for row in conn.execute("SELECT * FROM project_notes ORDER BY project_id, note_id").fetchall():
        document_id = note_documents.get(int(row["note_id"]))
        if not document_id:
            continue
        _upsert_project_context_document(
            conn,
            project_id=int(row["project_id"]),
            document_id=document_id,
            relation=str(row["relation"] or "source"),
            weight=1.0,
            created_at=str(row["created_at"] or utc_now()),
            updated_at=str(row["updated_at"] or utc_now()),
        )
    return _count(conn, "project_context_documents")


def _migrate_project_obsidian_note_links(
    conn: sqlite3.Connection,
    note_documents: dict[int, int],
) -> int:
    inserted = 0
    rows = conn.execute(
        """
        SELECT id, obsidian_note_id, created_at, updated_at
        FROM research_projects
        WHERE obsidian_note_id IS NOT NULL
        ORDER BY id
        """
    ).fetchall()
    for row in rows:
        document_id = note_documents.get(int(row["obsidian_note_id"]))
        if not document_id:
            continue
        before = _count(conn, "project_context_documents")
        _upsert_project_context_document(
            conn,
            project_id=int(row["id"]),
            document_id=document_id,
            relation="center_page",
            weight=1.0,
            created_at=str(row["created_at"] or utc_now()),
            updated_at=str(row["updated_at"] or utc_now()),
        )
        inserted += max(0, _count(conn, "project_context_documents") - before)
    return inserted


def _migrate_arxiv_papers(conn: sqlite3.Connection) -> dict[int, int]:
    paper_ids: dict[int, int] = {}
    for row in conn.execute("SELECT * FROM arxiv_papers ORDER BY id").fetchall():
        legacy_id = int(row["id"])
        arxiv_id = str(row["arxiv_id"] or "")
        canonical_key = f"arxiv:{arxiv_id}"
        published_at = str(row["published_at"] or "")
        updated_at = str(row["updated_at"] or "")
        created_at = str(row["created_at"] or utc_now())
        paper_id = _upsert_paper(
            conn,
            canonical_key=canonical_key,
            title=str(row["title"] or ""),
            authors_json=str(row["authors_json"] or "[]"),
            abstract=str(row["summary"] or ""),
            published_at=published_at,
            updated_at=updated_at,
            year=_year_from_timestamp(published_at),
            venue="arXiv",
            arxiv_id=arxiv_id,
            created_at=created_at,
        )
        paper_ids[legacy_id] = paper_id
        _upsert_paper_source(
            conn,
            paper_id=paper_id,
            source_type="arxiv",
            source_identifier=arxiv_id,
            source_url=str(row["link"] or ""),
            metadata={
                "legacy_arxiv_paper_id": legacy_id,
                "categories": from_json(row["categories_json"], []),
                "pdf_link": row["pdf_link"],
                "published_at": published_at,
                "updated_at": updated_at,
            },
            fetched_batch_id=str(row["fetched_batch_id"] or ""),
            created_at=created_at,
            updated_at=updated_at or created_at,
        )
        _migrate_arxiv_assets(conn, row, paper_id)
    return paper_ids


def _migrate_arxiv_assets(conn: sqlite3.Connection, row: sqlite3.Row, paper_id: int) -> None:
    now = utc_now()
    legacy_id = int(row["id"])
    if row["pdf_path"] or row["pdf_link"]:
        _upsert_paper_asset(
            conn,
            paper_id=paper_id,
            asset_type="pdf",
            path=str(row["pdf_path"] or ""),
            url=str(row["pdf_link"] or ""),
            status="available" if row["pdf_path"] else "remote",
            error_message="",
            metadata={"legacy_arxiv_paper_id": legacy_id},
            created_at=str(row["created_at"] or now),
            updated_at=str(row["text_extracted_at"] or row["created_at"] or now),
        )
    has_chunks = bool(
        conn.execute(
            "SELECT 1 FROM arxiv_text_chunks WHERE paper_id = ? LIMIT 1",
            (legacy_id,),
        ).fetchone()
    )
    if row["text_path"] or row["text_status"] != "pending" or has_chunks:
        _upsert_paper_asset(
            conn,
            paper_id=paper_id,
            asset_type="text",
            path=str(row["text_path"] or ""),
            url="",
            status=str(row["text_status"] or "pending"),
            error_message=str(row["text_error"] or ""),
            metadata={
                "legacy_arxiv_paper_id": legacy_id,
                "text_extracted_at": row["text_extracted_at"],
                "text_char_count": row["text_char_count"],
            },
            created_at=str(row["created_at"] or now),
            updated_at=str(row["text_extracted_at"] or row["created_at"] or now),
        )


def _migrate_arxiv_text_chunks(conn: sqlite3.Connection, paper_ids: dict[int, int]) -> int:
    for row in conn.execute("SELECT * FROM arxiv_text_chunks ORDER BY paper_id, chunk_index").fetchall():
        paper_id = paper_ids.get(int(row["paper_id"]))
        if not paper_id:
            continue
        asset_id = _paper_asset_id(conn, paper_id, "text")
        existing = conn.execute(
            """
            SELECT id FROM paper_chunks
            WHERE paper_id = ? AND chunk_index = ? AND source = ?
            """,
            (paper_id, int(row["chunk_index"]), str(row["source"] or "full_text")),
        ).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE paper_chunks
                SET asset_id = ?, page_start = ?, page_end = ?, text = ?,
                    token_count = ?, char_count = ?, created_at = ?
                WHERE id = ?
                """,
                (
                    asset_id,
                    row["page_start"],
                    row["page_end"],
                    row["text"],
                    row["token_count"],
                    row["char_count"],
                    row["created_at"],
                    existing["id"],
                ),
            )
            continue
        conn.execute(
            """
            INSERT INTO paper_chunks(
              paper_id, asset_id, chunk_index, source, page_start, page_end,
              text, token_count, char_count, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                paper_id,
                asset_id,
                row["chunk_index"],
                row["source"],
                row["page_start"],
                row["page_end"],
                row["text"],
                row["token_count"],
                row["char_count"],
                row["created_at"],
            ),
        )
    return _count(conn, "paper_chunks")


def _migrate_paper_reading_reports(
    conn: sqlite3.Connection,
    paper_ids: dict[int, int],
) -> int:
    for row in conn.execute("SELECT * FROM paper_reading_reports ORDER BY paper_id").fetchall():
        paper_id = paper_ids.get(int(row["paper_id"]))
        if not paper_id:
            continue
        paper = conn.execute("SELECT title FROM papers WHERE id = ?", (paper_id,)).fetchone()
        input_hash = str(row["source_text_hash"] or "") or f"legacy:paper_reading_reports:{row['paper_id']}"
        _upsert_artifact(
            conn,
            scope_type="paper",
            scope_id=paper_id,
            artifact_type="paper_report",
            title=f"Paper report: {paper['title'] if paper else row['paper_id']}",
            content_markdown=str(row["report_markdown"] or ""),
            content_json=to_json(
                {
                    "prompt": row["prompt"],
                    "system_prompt": row["system_prompt"],
                    "error_message": row["error_message"],
                    "source_project_ids": from_json(row["source_project_ids_json"], []),
                    "started_at": row["started_at"],
                    "finished_at": row["finished_at"],
                }
            ),
            status=str(row["status"] or "queued"),
            source_json=to_json(
                {
                    "legacy_table": "paper_reading_reports",
                    "legacy_paper_id": row["paper_id"],
                    "source_text_hash": row["source_text_hash"],
                }
            ),
            model_provider_id=str(row["model_provider_id"] or ""),
            model=str(row["model"] or ""),
            input_hash=input_hash,
            created_at=str(row["created_at"] or utc_now()),
            updated_at=str(row["updated_at"] or utc_now()),
        )
    return _count_where(conn, "artifacts", "scope_type = 'paper' AND artifact_type = 'paper_report'")


def _migrate_project_artifacts(conn: sqlite3.Connection) -> int:
    for row in conn.execute("SELECT * FROM project_artifacts ORDER BY id").fetchall():
        source = from_json(row["source_json"], {})
        if not isinstance(source, dict):
            source = {"legacy_source_json": row["source_json"]}
        source.update(
            {
                "legacy_table": "project_artifacts",
                "legacy_project_artifact_id": row["id"],
                "obsidian_path": row["obsidian_path"],
            }
        )
        _upsert_artifact(
            conn,
            scope_type="project",
            scope_id=int(row["project_id"]),
            artifact_type=str(row["artifact_type"] or ""),
            title=str(row["title"] or ""),
            content_markdown="",
            content_json=to_json({}),
            status=str(row["status"] or "planned"),
            source_json=to_json(source),
            model_provider_id="",
            model="",
            input_hash=f"legacy:project_artifacts:{row['id']}",
            created_at=str(row["created_at"] or utc_now()),
            updated_at=str(row["updated_at"] or utc_now()),
        )
    return _count_where(conn, "artifacts", "scope_type = 'project'")


def _upsert_knowledge_document(
    conn: sqlite3.Connection,
    *,
    source_type: str,
    source_uri: str,
    title: str,
    raw_content: str,
    content_hash: str,
    metadata: dict[str, Any],
    indexed_at: str,
    created_at: str,
    updated_at: str,
) -> int:
    row = conn.execute(
        """
        SELECT id FROM knowledge_documents
        WHERE source_type = ? AND source_uri = ?
        """,
        (source_type, source_uri),
    ).fetchone()
    if row:
        conn.execute(
            """
            UPDATE knowledge_documents
            SET title = ?, raw_content = ?, content_hash = ?, metadata_json = ?,
                indexed_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (title, raw_content, content_hash, to_json(metadata), indexed_at, updated_at, row["id"]),
        )
        return int(row["id"])
    cursor = conn.execute(
        """
        INSERT INTO knowledge_documents(
          source_type, source_uri, title, raw_content, content_hash,
          metadata_json, indexed_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source_type,
            source_uri,
            title,
            raw_content,
            content_hash,
            to_json(metadata),
            indexed_at,
            created_at,
            updated_at,
        ),
    )
    return int(cursor.lastrowid)


def _upsert_project_context_document(
    conn: sqlite3.Connection,
    *,
    project_id: int,
    document_id: int,
    relation: str,
    weight: float,
    created_at: str,
    updated_at: str,
) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO project_context_documents(
          project_id, document_id, relation, weight, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (project_id, document_id, relation, weight, created_at, updated_at),
    )
    conn.execute(
        """
        UPDATE project_context_documents
        SET weight = ?, updated_at = ?
        WHERE project_id = ? AND document_id = ? AND relation = ?
        """,
        (weight, updated_at, project_id, document_id, relation),
    )


def _upsert_paper(
    conn: sqlite3.Connection,
    *,
    canonical_key: str,
    title: str,
    authors_json: str,
    abstract: str,
    published_at: str,
    updated_at: str,
    year: int | None,
    venue: str,
    arxiv_id: str,
    created_at: str,
) -> int:
    row = conn.execute(
        "SELECT id FROM papers WHERE canonical_key = ?",
        (canonical_key,),
    ).fetchone()
    if row:
        conn.execute(
            """
            UPDATE papers
            SET title = ?, authors_json = ?, abstract = ?, published_at = ?,
                year = ?, venue = ?, arxiv_id = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                authors_json,
                abstract,
                published_at,
                year,
                venue,
                arxiv_id,
                updated_at,
                row["id"],
            ),
        )
        return int(row["id"])
    cursor = conn.execute(
        """
        INSERT INTO papers(
          canonical_key, title, authors_json, abstract, published_at,
          year, venue, arxiv_id, library_status, reading_state, user_tags_json,
          user_note, saved_at, last_read_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 'unread', '[]', '', NULL, NULL, ?, ?)
        """,
        (
            canonical_key,
            title,
            authors_json,
            abstract,
            published_at,
            year,
            venue,
            arxiv_id,
            created_at,
            updated_at or created_at,
        ),
    )
    return int(cursor.lastrowid)


def _upsert_paper_source(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    source_type: str,
    source_identifier: str,
    source_url: str,
    metadata: dict[str, Any],
    fetched_batch_id: str,
    created_at: str,
    updated_at: str,
) -> int:
    row = conn.execute(
        """
        SELECT id FROM paper_sources
        WHERE paper_id = ? AND source_type = ? AND source_identifier = ?
        """,
        (paper_id, source_type, source_identifier),
    ).fetchone()
    if row:
        conn.execute(
            """
            UPDATE paper_sources
            SET source_url = ?, metadata_json = ?, fetched_batch_id = ?, updated_at = ?
            WHERE id = ?
            """,
            (source_url, to_json(metadata), fetched_batch_id, updated_at, row["id"]),
        )
        return int(row["id"])
    cursor = conn.execute(
        """
        INSERT INTO paper_sources(
          paper_id, source_type, source_identifier, source_url, metadata_json,
          fetched_batch_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            paper_id,
            source_type,
            source_identifier,
            source_url,
            to_json(metadata),
            fetched_batch_id,
            created_at,
            updated_at,
        ),
    )
    return int(cursor.lastrowid)


def _upsert_paper_asset(
    conn: sqlite3.Connection,
    *,
    paper_id: int,
    asset_type: str,
    path: str,
    url: str,
    status: str,
    error_message: str,
    metadata: dict[str, Any],
    created_at: str,
    updated_at: str,
) -> int:
    row = conn.execute(
        """
        SELECT id FROM paper_assets
        WHERE paper_id = ? AND asset_type = ? AND path = ? AND url = ?
        """,
        (paper_id, asset_type, path, url),
    ).fetchone()
    if row:
        conn.execute(
            """
            UPDATE paper_assets
            SET status = ?, error_message = ?, metadata_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, error_message, to_json(metadata), updated_at, row["id"]),
        )
        return int(row["id"])
    cursor = conn.execute(
        """
        INSERT INTO paper_assets(
          paper_id, asset_type, path, url, status, error_message,
          metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            paper_id,
            asset_type,
            path,
            url,
            status,
            error_message,
            to_json(metadata),
            created_at,
            updated_at,
        ),
    )
    return int(cursor.lastrowid)


def _upsert_artifact(
    conn: sqlite3.Connection,
    *,
    scope_type: str,
    scope_id: int | None,
    artifact_type: str,
    title: str,
    content_markdown: str,
    content_json: str,
    status: str,
    source_json: str,
    model_provider_id: str,
    model: str,
    input_hash: str,
    created_at: str,
    updated_at: str,
) -> int:
    row = conn.execute(
        """
        SELECT id FROM artifacts
        WHERE scope_type = ? AND scope_id = ? AND artifact_type = ? AND input_hash = ?
        """,
        (scope_type, scope_id, artifact_type, input_hash),
    ).fetchone()
    if row:
        conn.execute(
            """
            UPDATE artifacts
            SET title = ?, content_markdown = ?, content_json = ?, status = ?,
                source_json = ?, model_provider_id = ?, model = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                title,
                content_markdown,
                content_json,
                status,
                source_json,
                model_provider_id,
                model,
                updated_at,
                row["id"],
            ),
        )
        return int(row["id"])
    cursor = conn.execute(
        """
        INSERT INTO artifacts(
          scope_type, scope_id, artifact_type, title, content_markdown,
          content_json, status, source_json, model_provider_id, model,
          input_hash, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            scope_type,
            scope_id,
            artifact_type,
            title,
            content_markdown,
            content_json,
            status,
            source_json,
            model_provider_id,
            model,
            input_hash,
            created_at,
            updated_at,
        ),
    )
    return int(cursor.lastrowid)


def _paper_asset_id(conn: sqlite3.Connection, paper_id: int, asset_type: str) -> int | None:
    row = conn.execute(
        """
        SELECT id FROM paper_assets
        WHERE paper_id = ? AND asset_type = ?
        ORDER BY id
        LIMIT 1
        """,
        (paper_id, asset_type),
    ).fetchone()
    return int(row["id"]) if row else None


def _count(conn: sqlite3.Connection, table: str) -> int:
    if not _table_exists(conn, table):
        return 0
    return int(conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"])


def _count_where(conn: sqlite3.Connection, table: str, where: str) -> int:
    if not _table_exists(conn, table):
        return 0
    return int(
        conn.execute(f"SELECT COUNT(*) AS count FROM {table} WHERE {where}").fetchone()["count"]
    )


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return bool(row)


def _count_paper_assets_for_sources(conn: sqlite3.Connection, source_type: str) -> int:
    return int(
        conn.execute(
            """
            SELECT COUNT(DISTINCT pa.id) AS count
            FROM paper_assets pa
            JOIN paper_sources ps ON ps.paper_id = pa.paper_id
            WHERE ps.source_type = ?
            """,
            (source_type,),
        ).fetchone()["count"]
    )


def _chunk_markdown(row: sqlite3.Row) -> str:
    heading = str(row["heading"] or "").strip()
    text = str(row["text"] or "").strip()
    if heading:
        return f"# {heading}\n\n{text}" if text else f"# {heading}"
    return text


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _year_from_timestamp(value: str) -> int | None:
    if len(value) < 4:
        return None
    try:
        return int(value[:4])
    except ValueError:
        return None
