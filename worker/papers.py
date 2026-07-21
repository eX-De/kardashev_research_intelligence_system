from __future__ import annotations

import hashlib
import re
from .db_types import DbConnection, DbRow
from typing import Any

from .db import clean_unicode, from_json, to_json, utc_now


VALID_LIBRARY_STATUSES = {"candidate", "saved", "reading", "read", "archived", "discarded"}
ARCHIVE_PROTECTED_STATUSES = {"saved", "reading", "read"}
DEFAULT_HIDDEN_LIBRARY_STATUSES = {"archived", "discarded"}
SOURCE_TYPES = {"arxiv", "url", "upload", "web", "manual"}


def _row_value(row: Any, key: str, default: Any = "") -> Any:
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    if hasattr(row, key):
        return getattr(row, key)
    try:
        if key in row.keys():
            return row[key]
    except (AttributeError, KeyError, TypeError):
        pass
    return default


def _text(value: Any) -> str:
    return clean_unicode(str(value or "")).strip()


def _same_text(left: Any, right: Any) -> bool:
    return _text(left) == _text(right)


def _json_list(value: Any) -> list[str]:
    if isinstance(value, str):
        parsed = from_json(value, None)
        if isinstance(parsed, list):
            return [_text(item) for item in parsed if _text(item)]
        return [_text(value)] if _text(value) else []
    if isinstance(value, (list, tuple)):
        return [_text(item) for item in value if _text(item)]
    return []


def _year_from_timestamp(value: str) -> int | None:
    match = re.match(r"^(\d{4})", _text(value))
    if not match:
        return None
    year = int(match.group(1))
    return year if 1000 <= year <= 9999 else None


def _hash_key(*parts: str) -> str:
    digest = hashlib.sha256("\n".join(parts).encode("utf-8", "replace")).hexdigest()[:24]
    return f"hash:{digest}"


def _canonical_key(source_type: str, source_identifier: str, *, arxiv_id: str = "", doi: str = "") -> str:
    if _text(doi):
        return f"doi:{_text(doi).lower()}"
    if _text(arxiv_id):
        return f"arxiv:{_text(arxiv_id).lower()}"
    identifier = _text(source_identifier)
    if identifier:
        return f"{source_type}:{identifier.lower()}"
    return _hash_key(source_type, utc_now())


def _reading_state_for_status(status: str, existing: str = "") -> str:
    if status == "reading":
        return "reading"
    if status == "read":
        return "read"
    if status in {"candidate", "saved"}:
        return "unread"
    return existing or "unread"


def _normalized_status(status: str) -> str:
    value = _text(status) or "candidate"
    if value not in VALID_LIBRARY_STATUSES:
        raise RuntimeError(f"Invalid library status: {value}")
    return value


def _source_type(value: str) -> str:
    source_type = _text(value) or "manual"
    if source_type not in SOURCE_TYPES:
        raise RuntimeError(f"Invalid paper source type: {source_type}")
    return source_type


def _paper_payload(row: DbRow) -> dict[str, object]:
    return {
        "id": int(row["id"]),
        "canonical_key": row["canonical_key"],
        "title": row["title"],
        "authors": from_json(row["authors_json"], []),
        "abstract": row["abstract"],
        "published_at": row["published_at"],
        "updated_at": row["updated_at"],
        "year": int(row["year"]) if row["year"] is not None else None,
        "venue": row["venue"],
        "doi": row["doi"],
        "arxiv_id": row["arxiv_id"],
        "library_status": row["library_status"],
        "reading_state": row["reading_state"],
        "user_tags": from_json(row["user_tags_json"], []),
        "user_note": row["user_note"],
        "saved_at": row["saved_at"],
        "last_read_at": row["last_read_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def upsert_paper(
    conn: DbConnection,
    *,
    source_type: str,
    source_identifier: str = "",
    source_url: str = "",
    title: str,
    authors: list[str] | tuple[str, ...] | str | None = None,
    abstract: str = "",
    published_at: str = "",
    updated_at: str = "",
    venue: str = "",
    doi: str = "",
    arxiv_id: str = "",
    library_status: str = "candidate",
    metadata: dict[str, object] | None = None,
    fetched_batch_id: str = "",
) -> int:
    source_type = _source_type(source_type)
    library_status = _normalized_status(library_status)
    source_identifier = _text(source_identifier)
    source_url = _text(source_url)
    arxiv_id = _text(arxiv_id)
    doi = _text(doi)
    canonical_key = _canonical_key(source_type, source_identifier, arxiv_id=arxiv_id, doi=doi)
    now = utc_now()
    existing = conn.execute(
        "SELECT * FROM papers WHERE canonical_key = ? OR (arxiv_id != '' AND arxiv_id = ?)",
        (canonical_key, arxiv_id),
    ).fetchone()

    authors_json = to_json(_json_list(authors or []))
    clean_title = _text(title) or "Untitled paper"
    clean_abstract = _text(abstract)
    clean_published_at = _text(published_at)
    year = _year_from_timestamp(clean_published_at)

    if existing:
        paper_id = int(existing["id"])
        existing_status = _text(existing["library_status"]) or "candidate"
        next_status = existing_status if library_status == "candidate" and existing_status != "candidate" else library_status
        saved_at = existing["saved_at"]
        if next_status in ARCHIVE_PROTECTED_STATUSES and not saved_at:
            saved_at = now
        last_read_at = existing["last_read_at"]
        if next_status == "read" and not last_read_at:
            last_read_at = now
        reading_state = _reading_state_for_status(next_status, _text(existing["reading_state"]))
        clean_venue = _text(venue)
        next_year = year if year is not None else existing["year"]
        changed = not (
            _same_text(existing["title"], clean_title)
            and _same_text(existing["authors_json"], authors_json)
            and _same_text(existing["abstract"], clean_abstract)
            and _same_text(existing["published_at"], clean_published_at)
            and existing["year"] == next_year
            and _same_text(existing["venue"], clean_venue)
            and _same_text(existing["doi"], doi)
            and _same_text(existing["arxiv_id"], arxiv_id)
            and _same_text(existing["library_status"], next_status)
            and _same_text(existing["reading_state"], reading_state)
            and _same_text(existing["saved_at"], saved_at)
            and _same_text(existing["last_read_at"], last_read_at)
        )
        if changed:
            conn.execute(
                """
                UPDATE papers
                SET title = ?,
                    authors_json = ?,
                    abstract = ?,
                    published_at = ?,
                    year = COALESCE(?, year),
                    venue = ?,
                    doi = ?,
                    arxiv_id = ?,
                    library_status = ?,
                    reading_state = ?,
                    saved_at = ?,
                    last_read_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    clean_title,
                    authors_json,
                    clean_abstract,
                    clean_published_at,
                    year,
                    clean_venue,
                    doi,
                    arxiv_id,
                    next_status,
                    reading_state,
                    saved_at,
                    last_read_at,
                    now,
                    paper_id,
                ),
            )
    else:
        saved_at = now if library_status in ARCHIVE_PROTECTED_STATUSES else None
        last_read_at = now if library_status == "read" else None
        cursor = conn.execute(
            """
            INSERT INTO papers(
              canonical_key, title, authors_json, abstract, published_at,
              year, venue, doi, arxiv_id, library_status, reading_state,
              user_tags_json, user_note, saved_at, last_read_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '', ?, ?, ?, ?)
            """,
            (
                canonical_key,
                clean_title,
                authors_json,
                clean_abstract,
                clean_published_at,
                year,
                _text(venue),
                doi,
                arxiv_id,
                library_status,
                _reading_state_for_status(library_status),
                saved_at,
                last_read_at,
                now,
                now,
            ),
        )
        paper_id = int(cursor.lastrowid)

    upsert_paper_source(
        conn,
        paper_id,
        source_type=source_type,
        source_identifier=source_identifier,
        source_url=source_url,
        metadata=metadata or {},
        fetched_batch_id=fetched_batch_id,
    )
    return paper_id


def upsert_paper_source(
    conn: DbConnection,
    paper_id: int,
    *,
    source_type: str,
    source_identifier: str = "",
    source_url: str = "",
    metadata: dict[str, object] | None = None,
    fetched_batch_id: str = "",
) -> int:
    source_type = _source_type(source_type)
    now = utc_now()
    source_identifier = _text(source_identifier)
    row = conn.execute(
        """
        SELECT id
        FROM paper_sources
        WHERE paper_id = ? AND source_type = ? AND source_identifier = ?
        """,
        (int(paper_id), source_type, source_identifier),
    ).fetchone()
    if row:
        source_id = int(row["id"])
        conn.execute(
            """
            UPDATE paper_sources
            SET source_url = ?,
                metadata_json = ?,
                fetched_batch_id = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (_text(source_url), to_json(metadata or {}), _text(fetched_batch_id), now, source_id),
        )
        return source_id
    cursor = conn.execute(
        """
        INSERT INTO paper_sources(
          paper_id, source_type, source_identifier, source_url, metadata_json,
          fetched_batch_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(paper_id),
            source_type,
            source_identifier,
            _text(source_url),
            to_json(metadata or {}),
            _text(fetched_batch_id),
            now,
            now,
        ),
    )
    return int(cursor.lastrowid)


def upsert_paper_asset(
    conn: DbConnection,
    paper_id: int,
    *,
    asset_type: str,
    path: str = "",
    url: str = "",
    status: str = "pending",
    error_message: str = "",
    metadata: dict[str, object] | None = None,
) -> int:
    now = utc_now()
    asset_type = _text(asset_type)
    path = _text(path)
    url = _text(url)
    row = conn.execute(
        """
        SELECT id
        FROM paper_assets
        WHERE paper_id = ?
          AND asset_type = ?
          AND (
            (? != '' AND path = ?)
            OR (? != '' AND url = ?)
            OR (path = '' AND url = '' AND ? = '' AND ? = '')
          )
        ORDER BY id
        LIMIT 1
        """,
        (int(paper_id), asset_type, path, path, url, url, path, url),
    ).fetchone()
    if row:
        asset_id = int(row["id"])
        conn.execute(
            """
            UPDATE paper_assets
            SET path = ?,
                url = ?,
                status = ?,
                error_message = ?,
                metadata_json = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (path, url, _text(status) or "pending", _text(error_message), to_json(metadata or {}), now, asset_id),
        )
        return asset_id
    cursor = conn.execute(
        """
        INSERT INTO paper_assets(
          paper_id, asset_type, path, url, status, error_message, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(paper_id),
            asset_type,
            path,
            url,
            _text(status) or "pending",
            _text(error_message),
            to_json(metadata or {}),
            now,
            now,
        ),
    )
    return int(cursor.lastrowid)


def upsert_paper_from_arxiv(
    conn: DbConnection,
    paper: Any,
    *,
    fetched_batch_id: str = "",
    library_status: str = "candidate",
) -> int:
    arxiv_id = _text(_row_value(paper, "arxiv_id"))
    requested_status = _normalized_status(library_status)
    source_type = "arxiv"
    long_term_arxiv_id = arxiv_id
    if arxiv_id.startswith("reader-upload-"):
        source_type = "upload"
        long_term_arxiv_id = ""
    elif arxiv_id.startswith("reader-url-"):
        source_type = "url"
        long_term_arxiv_id = ""
    elif arxiv_id.startswith("reader-web-"):
        source_type = "web"
        long_term_arxiv_id = ""
    link = _text(_row_value(paper, "link")) or (
        f"https://arxiv.org/abs/{arxiv_id}" if source_type == "arxiv" and arxiv_id else ""
    )
    pdf_link = _text(_row_value(paper, "pdf_link")) or (
        f"https://arxiv.org/pdf/{arxiv_id}" if source_type == "arxiv" and arxiv_id else ""
    )
    categories = _json_list(_row_value(paper, "categories", _row_value(paper, "categories_json", [])))
    batch_id = _text(fetched_batch_id) or _text(_row_value(paper, "fetched_batch_id"))
    if requested_status == "candidate" and arxiv_id:
        tombstone = conn.execute(
            "SELECT 1 FROM arxiv_paper_tombstones WHERE arxiv_id = ?",
            (arxiv_id,),
        ).fetchone()
        if tombstone:
            requested_status = "archived"
    paper_id = upsert_paper(
        conn,
        source_type=source_type,
        source_identifier=arxiv_id,
        source_url=link,
        title=_text(_row_value(paper, "title")),
        authors=_row_value(paper, "authors", _row_value(paper, "authors_json", [])),
        abstract=_text(_row_value(paper, "summary", _row_value(paper, "abstract", ""))),
        published_at=_text(_row_value(paper, "published_at")),
        updated_at=_text(_row_value(paper, "updated_at")),
        arxiv_id=long_term_arxiv_id,
        library_status=requested_status,
        metadata={"categories": categories, "pdf_link": pdf_link, "arxiv_updated_at": _text(_row_value(paper, "updated_at"))},
        fetched_batch_id=batch_id,
    )
    if pdf_link:
        upsert_paper_asset(conn, paper_id, asset_type="pdf", url=pdf_link, status="pending")
    _sync_assets_from_arxiv_row(conn, paper_id, paper)
    return paper_id


def upsert_imported_paper(
    conn: DbConnection,
    *,
    source_type: str,
    source_identifier: str,
    title: str,
    abstract: str = "",
    source_url: str = "",
    pdf_url: str = "",
    pdf_path: str = "",
    text_path: str = "",
    text_status: str = "pending",
    text_error: str = "",
    text_char_count: int = 0,
    arxiv_id: str = "",
    library_status: str = "saved",
    metadata: dict[str, object] | None = None,
    fetched_batch_id: str = "reader-import",
) -> int:
    metadata_payload = dict(metadata or {})
    if pdf_url:
        metadata_payload["pdf_link"] = pdf_url
    paper_id = upsert_paper(
        conn,
        source_type=source_type,
        source_identifier=source_identifier,
        source_url=source_url,
        title=title,
        authors=[],
        abstract=abstract,
        arxiv_id=arxiv_id,
        library_status=library_status,
        metadata=metadata_payload,
        fetched_batch_id=fetched_batch_id,
    )
    if pdf_url or pdf_path:
        upsert_paper_asset(conn, paper_id, asset_type="pdf", path=pdf_path, url=pdf_url, status="complete" if pdf_path else "pending")
    if text_path or text_status != "pending" or text_error:
        upsert_paper_asset(
            conn,
            paper_id,
            asset_type="text",
            path=text_path,
            status=text_status,
            error_message=text_error,
            metadata={"char_count": int(text_char_count or 0)},
        )
    return paper_id


def upsert_manual_paper(
    conn: DbConnection,
    *,
    title: str,
    authors: list[str] | tuple[str, ...] | str | None = None,
    abstract: str = "",
    doi: str = "",
    url: str = "",
    library_status: str = "saved",
    metadata: dict[str, object] | None = None,
) -> int:
    identifier = _text(doi) or _text(url) or _hash_key(title, abstract)
    return upsert_paper(
        conn,
        source_type="manual",
        source_identifier=identifier,
        source_url=url,
        title=title,
        authors=authors,
        abstract=abstract,
        doi=doi,
        library_status=library_status,
        metadata=metadata or {},
    )


def _sync_assets_from_arxiv_row(conn: DbConnection, paper_id: int, row: Any) -> tuple[int | None, int | None]:
    pdf_asset_id = None
    text_asset_id = None
    pdf_path = _text(_row_value(row, "pdf_path"))
    pdf_url = _text(_row_value(row, "pdf_link"))
    if pdf_path or pdf_url:
        pdf_asset_id = upsert_paper_asset(
            conn,
            paper_id,
            asset_type="pdf",
            path=pdf_path,
            url=pdf_url,
            status="complete" if pdf_path else "pending",
        )
    text_path = _text(_row_value(row, "text_path"))
    text_status = _text(_row_value(row, "text_status")) or "pending"
    text_error = _text(_row_value(row, "text_error"))
    if text_path or text_status != "pending" or text_error:
        text_asset_id = upsert_paper_asset(
            conn,
            paper_id,
            asset_type="text",
            path=text_path,
            status=text_status,
            error_message=text_error,
            metadata={"char_count": int(_row_value(row, "text_char_count", 0) or 0)},
        )
    return pdf_asset_id, text_asset_id


def replace_paper_chunks(
    conn: DbConnection,
    paper_id: int,
    chunks: list[dict[str, Any]],
    *,
    text_asset_id: int | None = None,
) -> int:
    conn.execute("DELETE FROM paper_chunks WHERE paper_id = ?", (int(paper_id),))
    now = utc_now()
    for index, chunk in enumerate(chunks):
        source = _text(chunk.get("source")) or "full_text"
        asset_id = text_asset_id if source == "full_text" else None
        conn.execute(
            """
            INSERT INTO paper_chunks(
              paper_id, asset_id, chunk_index, source, page_start, page_end,
              text, token_count, char_count, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(paper_id),
                asset_id,
                index,
                source,
                chunk.get("page_start"),
                chunk.get("page_end"),
                _text(chunk.get("text")),
                int(chunk.get("token_count") or 0),
                int(chunk.get("char_count") or 0),
                now,
            ),
        )
    return len(chunks)


def replace_paper_chunks_for_arxiv_paper(
    conn: DbConnection,
    arxiv_paper: DbRow,
    chunks: list[dict[str, Any]],
) -> int:
    paper_id = upsert_paper_from_arxiv(conn, arxiv_paper)
    _pdf_asset_id, text_asset_id = _sync_assets_from_arxiv_row(conn, paper_id, arxiv_paper)
    return replace_paper_chunks(conn, paper_id, chunks, text_asset_id=text_asset_id)


def replace_existing_paper_chunks_for_arxiv_paper(
    conn: DbConnection,
    arxiv_paper: DbRow,
    chunks: list[dict[str, Any]],
) -> int:
    arxiv_id = _text(_row_value(arxiv_paper, "arxiv_id"))
    paper_id = paper_id_for_arxiv_id(conn, arxiv_id)
    if paper_id is None:
        return 0
    upsert_paper_from_arxiv(conn, arxiv_paper)
    _pdf_asset_id, text_asset_id = _sync_assets_from_arxiv_row(conn, paper_id, arxiv_paper)
    return replace_paper_chunks(conn, paper_id, chunks, text_asset_id=text_asset_id)


def _copy_arxiv_embeddings_to_library_paper(
    conn: DbConnection,
    paper_id: int,
    arxiv_paper_id: int,
) -> None:
    conn.execute(
        """
        INSERT INTO paper_embeddings(paper_id, model, embedding_json, created_at)
        SELECT ?, model, embedding_json, created_at
        FROM arxiv_paper_embeddings
        WHERE paper_id = ?
        ON CONFLICT(paper_id, model) DO UPDATE SET
          embedding_json = excluded.embedding_json,
          created_at = excluded.created_at
        """,
        (int(paper_id), int(arxiv_paper_id)),
    )
    conn.execute(
        """
        INSERT INTO paper_chunk_embeddings(paper_chunk_id, model, embedding_json, created_at)
        SELECT pc.id, source_embedding.model, source_embedding.embedding_json, source_embedding.created_at
        FROM paper_chunks pc
        JOIN arxiv_text_chunks source_chunk
          ON source_chunk.paper_id = ?
         AND source_chunk.chunk_index = pc.chunk_index
        JOIN arxiv_chunk_embeddings source_embedding
          ON source_embedding.arxiv_chunk_id = source_chunk.id
        WHERE pc.paper_id = ?
        ON CONFLICT(paper_chunk_id, model) DO UPDATE SET
          embedding_json = excluded.embedding_json,
          created_at = excluded.created_at
        """,
        (int(arxiv_paper_id), int(paper_id)),
    )


def mirror_arxiv_paper(
    conn: DbConnection,
    arxiv_paper: DbRow,
    *,
    library_status: str = "candidate",
) -> int:
    paper_id = upsert_paper_from_arxiv(conn, arxiv_paper, library_status=library_status)
    chunks = conn.execute(
        """
        SELECT chunk_index, source, page_start, page_end, text, token_count, char_count
        FROM arxiv_text_chunks
        WHERE paper_id = ?
        ORDER BY chunk_index
        """,
        (int(arxiv_paper["id"]),),
    ).fetchall()
    if chunks:
        replace_paper_chunks_for_arxiv_paper(conn, arxiv_paper, [dict(row) for row in chunks])
    _copy_arxiv_embeddings_to_library_paper(conn, paper_id, int(arxiv_paper["id"]))
    return paper_id


def mirror_arxiv_papers(
    conn: DbConnection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
    *,
    limit: int | None = None,
) -> dict[str, int]:
    params: list[Any] = []
    sql = "SELECT * FROM arxiv_papers"
    if paper_ids is not None:
        selected = sorted({int(paper_id) for paper_id in paper_ids})
        if not selected:
            return {"papers_mirrored": 0}
        placeholders = ", ".join("?" for _ in selected)
        sql += f" WHERE id IN ({placeholders})"
        params.extend(selected)
    sql += " ORDER BY published_at DESC"
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()
    for row in rows:
        mirror_arxiv_paper(conn, row)
    return {"papers_mirrored": len(rows)}


def paper_id_for_arxiv_id(conn: DbConnection, arxiv_id: str) -> int | None:
    arxiv_id = _text(arxiv_id)
    if not arxiv_id:
        return None
    row = conn.execute(
        "SELECT id FROM papers WHERE arxiv_id = ? OR canonical_key = ?",
        (arxiv_id, f"arxiv:{arxiv_id.lower()}"),
    ).fetchone()
    if row:
        return int(row["id"])
    row = conn.execute(
        """
        SELECT p.id
        FROM papers p
        JOIN paper_sources s ON s.paper_id = p.id
        WHERE s.source_type = 'arxiv' AND s.source_identifier = ?
        ORDER BY p.id
        LIMIT 1
        """,
        (arxiv_id,),
    ).fetchone()
    return int(row["id"]) if row else None


def paper_id_for_arxiv_paper_id(conn: DbConnection, arxiv_paper_id: int) -> int | None:
    row = conn.execute("SELECT arxiv_id FROM arxiv_papers WHERE id = ?", (int(arxiv_paper_id),)).fetchone()
    if not row:
        return None
    return paper_id_for_arxiv_id(conn, str(row["arxiv_id"]))


def promote_arxiv_paper_to_library(
    conn: DbConnection,
    arxiv_paper_id: int,
    *,
    library_status: str = "candidate",
) -> int | None:
    row = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (int(arxiv_paper_id),)).fetchone()
    if not row:
        return None
    return mirror_arxiv_paper(conn, row, library_status=library_status)


def set_library_status(
    conn: DbConnection,
    paper_id: int,
    status: str,
    *,
    user_note: str | None = None,
    user_tags: list[str] | tuple[str, ...] | None = None,
) -> dict[str, object]:
    status = _normalized_status(status)
    row = conn.execute("SELECT * FROM papers WHERE id = ?", (int(paper_id),)).fetchone()
    if not row:
        raise RuntimeError(f"Paper not found: {paper_id}")
    now = utc_now()
    saved_at = row["saved_at"]
    if status in ARCHIVE_PROTECTED_STATUSES and not saved_at:
        saved_at = now
    last_read_at = row["last_read_at"]
    if status == "read":
        last_read_at = now
    reading_state = _reading_state_for_status(status, _text(row["reading_state"]))
    updates = [
        "library_status = ?",
        "reading_state = ?",
        "saved_at = ?",
        "last_read_at = ?",
        "updated_at = ?",
    ]
    params: list[Any] = [status, reading_state, saved_at, last_read_at, now]
    if user_note is not None:
        updates.append("user_note = ?")
        params.append(_text(user_note))
    if user_tags is not None:
        updates.append("user_tags_json = ?")
        params.append(to_json(_json_list(list(user_tags))))
    params.append(int(paper_id))
    conn.execute(f"UPDATE papers SET {', '.join(updates)} WHERE id = ?", params)
    return {"ok": True, "paper_id": int(paper_id), "library_status": status, "reading_state": reading_state}


def set_arxiv_paper_library_status(conn: DbConnection, arxiv_paper_id: int, status: str) -> dict[str, object]:
    paper_id = paper_id_for_arxiv_paper_id(conn, int(arxiv_paper_id))
    if paper_id is None:
        paper_id = promote_arxiv_paper_to_library(conn, int(arxiv_paper_id), library_status=status)
    if paper_id is None:
        raise RuntimeError(f"arXiv paper not found: {arxiv_paper_id}")
    return set_library_status(conn, paper_id, status)


def mark_paper_candidate(conn: DbConnection, paper_id: int) -> dict[str, object]:
    return set_library_status(conn, paper_id, "candidate")


def mark_paper_saved(conn: DbConnection, paper_id: int) -> dict[str, object]:
    return set_library_status(conn, paper_id, "saved")


def mark_paper_reading(conn: DbConnection, paper_id: int) -> dict[str, object]:
    return set_library_status(conn, paper_id, "reading")


def mark_paper_read(conn: DbConnection, paper_id: int) -> dict[str, object]:
    return set_library_status(conn, paper_id, "read")


def mark_paper_archived(conn: DbConnection, paper_id: int) -> dict[str, object]:
    return set_library_status(conn, paper_id, "archived")


def mark_paper_discarded(conn: DbConnection, paper_id: int) -> dict[str, object]:
    return set_library_status(conn, paper_id, "discarded")


def mark_arxiv_paper_archived(conn: DbConnection, arxiv_paper_id: int) -> dict[str, object] | None:
    paper_id = paper_id_for_arxiv_paper_id(conn, int(arxiv_paper_id))
    if paper_id is None:
        return None
    return mark_paper_archived(conn, paper_id)


def prune_unqualified_arxiv_library_papers(conn: DbConnection) -> dict[str, object]:
    """Remove automatic arXiv mirrors that have no library-worthy relationship.

    The discovery corpus remains in ``arxiv_papers``.  We only remove the
    user-library projection when it has no pending/accepted recommendation and
    no evidence of an explicit user action.
    """
    rows = conn.execute(
        """
        SELECT DISTINCT lp.id
        FROM papers lp
        JOIN paper_sources source
          ON source.paper_id = lp.id
         AND source.source_type = 'arxiv'
        JOIN arxiv_papers ap ON ap.arxiv_id = source.source_identifier
        WHERE lp.library_status IN ('candidate', 'archived')
          AND lp.reading_state = 'unread'
          AND COALESCE(lp.user_note, '') = ''
          AND COALESCE(NULLIF(TRIM(lp.user_tags_json), ''), '[]') = '[]'
          AND lp.saved_at IS NULL
          AND lp.last_read_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM paper_sources other_source
            WHERE other_source.paper_id = lp.id
              AND other_source.source_type != 'arxiv'
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_paper_recommendations recommendation
            WHERE recommendation.paper_id = lp.id
              AND recommendation.state IN ('pending', 'accepted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_papers project_paper
            WHERE project_paper.paper_id = lp.id
              AND NOT (
                project_paper.relation = 'candidate'
                AND project_paper.note = 'auto_matched_by_project_context'
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_feedback feedback
            WHERE feedback.paper_id = lp.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM paper_reader_messages message
            WHERE message.library_paper_id = lp.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM artifacts artifact
            WHERE artifact.scope_type = 'paper'
              AND artifact.scope_id = lp.id
          )
        ORDER BY lp.id
        """
    ).fetchall()
    paper_ids = [int(row["id"]) for row in rows]
    for paper_id in paper_ids:
        conn.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
    conn.commit()
    return {"unqualified_library_papers_removed": len(paper_ids)}


def arxiv_paper_has_protected_library_status(conn: DbConnection, arxiv_paper_id: int) -> bool:
    row = conn.execute(
        """
        SELECT p.library_status
        FROM arxiv_papers ap
        JOIN papers p ON p.arxiv_id = ap.arxiv_id
        WHERE ap.id = ?
          AND p.library_status IN ('saved', 'reading', 'read', 'discarded')
        LIMIT 1
        """,
        (int(arxiv_paper_id),),
    ).fetchone()
    return bool(row)


def list_paper_library(
    conn: DbConnection,
    *,
    library_status: str | None = None,
    source_type: str | None = None,
    project_id: int | None = None,
    query: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = 100,
    offset: int = 0,
) -> dict[str, object]:
    clauses: list[str] = []
    params: list[Any] = []
    if library_status:
        clauses.append("p.library_status = ?")
        params.append(_normalized_status(library_status))
    else:
        placeholders = ", ".join("?" for _ in DEFAULT_HIDDEN_LIBRARY_STATUSES)
        clauses.append(f"p.library_status NOT IN ({placeholders})")
        params.extend(sorted(DEFAULT_HIDDEN_LIBRARY_STATUSES))
    if source_type:
        clauses.append("EXISTS (SELECT 1 FROM paper_sources s WHERE s.paper_id = p.id AND s.source_type = ?)")
        params.append(_source_type(source_type))
    if query:
        clauses.append("(LOWER(p.title) LIKE ? OR LOWER(p.abstract) LIKE ? OR LOWER(p.arxiv_id) LIKE ?)")
        needle = f"%{_text(query).lower()}%"
        params.extend([needle, needle, needle])
    clean_date_from = _text(date_from)[:10]
    if clean_date_from:
        clauses.append("p.published_at != '' AND substr(p.published_at, 1, 10) >= ?")
        params.append(clean_date_from)
    clean_date_to = _text(date_to)[:10]
    if clean_date_to:
        clauses.append("p.published_at != '' AND substr(p.published_at, 1, 10) <= ?")
        params.append(clean_date_to)
    if project_id is not None:
        clauses.append(
            """
            EXISTS (
              SELECT 1
              FROM project_papers pp
              WHERE pp.paper_id = p.id
                AND pp.project_id = ?
                AND NOT (pp.relation = 'candidate' AND pp.note = 'auto_matched_by_project_context')
            )
            """
        )
        params.append(int(project_id))
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    row_limit = max(1, min(int(limit or 100), 500))
    row_offset = max(0, int(offset or 0))
    rows = conn.execute(
        f"""
        SELECT
          p.*,
          (
            SELECT COUNT(*)
            FROM paper_assets a
            WHERE a.paper_id = p.id
          ) AS asset_count,
          (
            SELECT COUNT(*)
            FROM paper_chunks c
            WHERE c.paper_id = p.id
          ) AS chunk_count,
          (
            SELECT COUNT(*)
            FROM artifacts af
            WHERE af.scope_type = 'paper' AND af.scope_id = p.id
          ) AS artifact_count
        FROM papers p
        {where}
        ORDER BY
          CASE p.library_status
            WHEN 'reading' THEN 0
            WHEN 'saved' THEN 1
            WHEN 'candidate' THEN 2
            WHEN 'read' THEN 3
            WHEN 'archived' THEN 4
            ELSE 5
          END,
          p.updated_at DESC,
          p.published_at DESC
        LIMIT ? OFFSET ?
        """,
        (*params, row_limit, row_offset),
    ).fetchall()
    total = conn.execute(f"SELECT COUNT(*) AS count FROM papers p {where}", params).fetchone()["count"]
    items = []
    for row in rows:
        payload = _paper_payload(row)
        payload.update(
            {
                "asset_count": int(row["asset_count"] or 0),
                "chunk_count": int(row["chunk_count"] or 0),
                "artifact_count": int(row["artifact_count"] or 0),
            }
        )
        items.append(payload)
    return {"items": items, "total": int(total or 0), "limit": row_limit, "offset": row_offset}


def paper_library_detail(conn: DbConnection, paper_id: int) -> dict[str, object]:
    row = conn.execute("SELECT * FROM papers WHERE id = ?", (int(paper_id),)).fetchone()
    if not row:
        raise RuntimeError(f"Paper not found: {paper_id}")
    paper = _paper_payload(row)
    sources = conn.execute(
        """
        SELECT id, source_type, source_identifier, source_url, metadata_json, fetched_batch_id, created_at, updated_at
        FROM paper_sources
        WHERE paper_id = ?
        ORDER BY source_type, id
        """,
        (int(paper_id),),
    ).fetchall()
    assets = conn.execute(
        """
        SELECT id, asset_type, path, url, status, error_message, metadata_json, created_at, updated_at
        FROM paper_assets
        WHERE paper_id = ?
        ORDER BY asset_type, id
        """,
        (int(paper_id),),
    ).fetchall()
    chunks = conn.execute(
        """
        SELECT id, asset_id, chunk_index, source, page_start, page_end, text, token_count, char_count, created_at
        FROM paper_chunks
        WHERE paper_id = ?
        ORDER BY chunk_index
        LIMIT 50
        """,
        (int(paper_id),),
    ).fetchall()
    linked_projects: list[dict[str, object]] = []
    project_rows = conn.execute(
        """
        SELECT pp.project_id, rp.name AS project_name, pp.relation, pp.note, pp.updated_at
        FROM project_papers pp
        JOIN research_projects rp ON rp.id = pp.project_id
        WHERE pp.paper_id = ?
          AND NOT (pp.relation = 'candidate' AND pp.note = 'auto_matched_by_project_context')
        ORDER BY pp.updated_at DESC
        """,
        (int(paper_id),),
    ).fetchall()
    linked_projects = [
        {
            "project_id": int(project["project_id"]),
            "project_name": project["project_name"],
            "relation": project["relation"],
            "note": project["note"],
            "updated_at": project["updated_at"],
        }
        for project in project_rows
    ]
    artifacts = conn.execute(
        """
        SELECT id, artifact_type, title, status, updated_at
        FROM artifacts
        WHERE scope_type = 'paper' AND scope_id = ?
        ORDER BY updated_at DESC
        """,
        (int(paper_id),),
    ).fetchall()
    return {
        "paper": paper,
        "sources": [
            {
                "id": int(source["id"]),
                "source_type": source["source_type"],
                "source_identifier": source["source_identifier"],
                "source_url": source["source_url"],
                "metadata": from_json(source["metadata_json"], {}),
                "fetched_batch_id": source["fetched_batch_id"],
                "created_at": source["created_at"],
                "updated_at": source["updated_at"],
            }
            for source in sources
        ],
        "assets": [
            {
                "id": int(asset["id"]),
                "asset_type": asset["asset_type"],
                "path": asset["path"],
                "url": asset["url"],
                "status": asset["status"],
                "error_message": asset["error_message"],
                "metadata": from_json(asset["metadata_json"], {}),
                "created_at": asset["created_at"],
                "updated_at": asset["updated_at"],
            }
            for asset in assets
        ],
        "chunks": [
            {
                "id": int(chunk["id"]),
                "asset_id": int(chunk["asset_id"]) if chunk["asset_id"] is not None else None,
                "chunk_index": int(chunk["chunk_index"]),
                "source": chunk["source"],
                "page_start": chunk["page_start"],
                "page_end": chunk["page_end"],
                "text": chunk["text"],
                "token_count": int(chunk["token_count"] or 0),
                "char_count": int(chunk["char_count"] or 0),
                "created_at": chunk["created_at"],
            }
            for chunk in chunks
        ],
        "linked_projects": linked_projects,
        "artifacts": [
            {
                "id": int(artifact["id"]),
                "artifact_type": artifact["artifact_type"],
                "title": artifact["title"],
                "status": artifact["status"],
                "updated_at": artifact["updated_at"],
            }
            for artifact in artifacts
        ],
    }
