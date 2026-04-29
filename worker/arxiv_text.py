from __future__ import annotations

import re
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import Settings
from .db import utc_now
from .embeddings import ensure_missing_arxiv_chunk_embeddings


def safe_arxiv_filename(arxiv_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", arxiv_id).strip("_")


def pdf_url(row: sqlite3.Row) -> str:
    if row["pdf_link"]:
        return str(row["pdf_link"])
    return f"https://arxiv.org/pdf/{row['arxiv_id']}"


def download_pdf(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "research-intelligence-system/0.1"},
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        content_type = response.headers.get("content-type", "")
        body = response.read()
    if len(body) < 1000 or "html" in content_type.lower():
        raise RuntimeError(f"Downloaded content does not look like a PDF: {content_type}")
    destination.write_bytes(body)


def extract_pdf_text_to_file(pdf_path: Path, text_path: Path) -> int:
    try:
        import fitz
    except ImportError as exc:
        raise RuntimeError("PyMuPDF is required. Install it with: pip install PyMuPDF") from exc

    text_path.parent.mkdir(parents=True, exist_ok=True)
    parts: list[str] = []
    with fitz.open(pdf_path) as doc:
        for page_number, page in enumerate(doc, start=1):
            page_text = page.get_text("text").strip()
            if page_text:
                parts.append(f"\n\n--- page {page_number} ---\n{page_text}")
    text = "\n".join(parts).strip()
    text_path.write_text(text, encoding="utf-8")
    return len(text)


def _token_count(text: str) -> int:
    return max(1, len(text.split()))


def _page_blocks(text: str) -> list[tuple[int | None, str]]:
    matches = list(re.finditer(r"--- page (\d+) ---", text))
    if not matches:
        return [(None, text)]
    blocks: list[tuple[int | None, str]] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        page_text = text[start:end].strip()
        if page_text:
            blocks.append((int(match.group(1)), page_text))
    return blocks


def chunk_text(
    text: str,
    *,
    max_chars: int = 1800,
    overlap_chars: int = 180,
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    current = ""
    page_start: int | None = None
    page_end: int | None = None

    def flush() -> None:
        nonlocal current, page_start, page_end
        cleaned = re.sub(r"\s+", " ", current).strip()
        if len(cleaned) >= 40:
            chunks.append(
                {
                    "source": "full_text",
                    "page_start": page_start,
                    "page_end": page_end,
                    "text": cleaned,
                    "token_count": _token_count(cleaned),
                    "char_count": len(cleaned),
                }
            )
        current = cleaned[-overlap_chars:] if overlap_chars and cleaned else ""
        page_start = page_end

    for page, page_text in _page_blocks(text):
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n", page_text) if part.strip()]
        if not paragraphs:
            paragraphs = [page_text]
        for paragraph in paragraphs:
            candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
            if len(candidate) > max_chars and current:
                flush()
                candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
            current = candidate[: max_chars * 2]
            page_start = page if page_start is None else page_start
            page_end = page
            if len(current) >= max_chars:
                flush()
    if current:
        flush()
    return chunks


def replace_arxiv_chunks_for_paper(
    conn: sqlite3.Connection,
    paper: sqlite3.Row,
    text: str | None = None,
) -> int:
    conn.execute("DELETE FROM arxiv_text_chunks WHERE paper_id = ?", (int(paper["id"]),))
    now = utc_now()
    chunks: list[dict[str, Any]] = []
    metadata_text = f"Title: {paper['title']}\n\nAbstract: {paper['summary']}".strip()
    chunks.append(
        {
            "source": "metadata",
            "page_start": None,
            "page_end": None,
            "text": metadata_text,
            "token_count": _token_count(metadata_text),
            "char_count": len(metadata_text),
        }
    )
    if text is None:
        text = paper_full_text_excerpt(paper, max_chars=2_000_000)
    if text:
        chunks.extend(chunk_text(text))
    for index, chunk in enumerate(chunks):
        conn.execute(
            """
            INSERT INTO arxiv_text_chunks(
              paper_id, chunk_index, source, page_start, page_end, text, token_count, char_count, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(paper["id"]),
                index,
                chunk["source"],
                chunk["page_start"],
                chunk["page_end"],
                chunk["text"],
                chunk["token_count"],
                chunk["char_count"],
                now,
            ),
        )
    return len(chunks)


def ensure_arxiv_chunks(
    conn: sqlite3.Connection,
    limit: int | None = None,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> dict[str, int]:
    selected_ids = [int(paper_id) for paper_id in paper_ids or []]
    if paper_ids is not None and not selected_ids:
        return {"papers_chunked": 0, "arxiv_chunks_created": 0}
    sql = """
        SELECT p.*
        FROM arxiv_papers p
        LEFT JOIN arxiv_text_chunks c ON c.paper_id = p.id
        WHERE c.id IS NULL
    """
    params: list[Any] = []
    if selected_ids:
        placeholders = ", ".join("?" for _ in selected_ids)
        sql += f" AND p.id IN ({placeholders})"
        params.extend(selected_ids)
    sql += """
        GROUP BY p.id
        ORDER BY p.published_at DESC
    """
    if limit:
        sql += " LIMIT ?"
        params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    chunks_created = 0
    for row in rows:
        chunks_created += replace_arxiv_chunks_for_paper(conn, row)
    conn.commit()
    return {"papers_chunked": len(rows), "arxiv_chunks_created": chunks_created}


def cache_arxiv_full_texts(
    conn: sqlite3.Connection,
    settings: Settings,
    limit: int | None = None,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> dict[str, int]:
    if not settings.arxiv_cache_full_text:
        return {"papers_considered": 0, "pdfs_downloaded": 0, "texts_extracted": 0, "texts_failed": 0}

    selected_ids = [int(paper_id) for paper_id in paper_ids or []]
    if paper_ids is not None and not selected_ids:
        return {
            "papers_considered": 0,
            "pdfs_downloaded": 0,
            "texts_extracted": 0,
            "texts_failed": 0,
            "papers_chunked": 0,
            "arxiv_chunks_created": 0,
            "arxiv_chunk_embeddings_created": 0,
            "arxiv_chunk_embeddings_skipped": 0,
        }

    row_limit = limit or settings.arxiv_max_results
    sql = """
        SELECT id, arxiv_id, pdf_link, pdf_path, text_path, text_status
        FROM arxiv_papers
        WHERE text_status != 'complete' OR text_path = ''
        ORDER BY published_at DESC
    """
    params: list[Any] = []
    if selected_ids:
        placeholders = ", ".join("?" for _ in selected_ids)
        sql = f"""
        SELECT id, arxiv_id, pdf_link, pdf_path, text_path, text_status
        FROM arxiv_papers
        WHERE (text_status != 'complete' OR text_path = '')
          AND id IN ({placeholders})
        ORDER BY published_at DESC
        """
        params.extend(selected_ids)
    if row_limit and not selected_ids:
        sql += " LIMIT ?"
        params.append(row_limit)
    rows = conn.execute(sql, params).fetchall()

    downloaded = 0
    extracted = 0
    failed = 0
    for index, row in enumerate(rows):
        if index > 0:
            time.sleep(settings.arxiv_request_interval_seconds)
        stem = safe_arxiv_filename(row["arxiv_id"])
        pdf_path = Path(row["pdf_path"]) if row["pdf_path"] else settings.arxiv_pdf_dir / f"{stem}.pdf"
        text_path = Path(row["text_path"]) if row["text_path"] else settings.arxiv_text_dir / f"{stem}.txt"
        try:
            if not pdf_path.exists():
                download_pdf(pdf_url(row), pdf_path)
                downloaded += 1
            char_count = extract_pdf_text_to_file(pdf_path, text_path)
            conn.execute(
                """
                UPDATE arxiv_papers
                SET pdf_path = ?, text_path = ?, text_extracted_at = ?, text_status = 'complete',
                    text_error = '', text_char_count = ?
                WHERE id = ?
                """,
                (str(pdf_path), str(text_path), utc_now(), char_count, int(row["id"])),
            )
            refreshed = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (int(row["id"]),)).fetchone()
            replace_arxiv_chunks_for_paper(
                conn,
                refreshed,
                text_path.read_text(encoding="utf-8", errors="ignore"),
            )
            extracted += 1
        except (OSError, RuntimeError, urllib.error.URLError, TimeoutError) as exc:
            conn.execute(
                """
                UPDATE arxiv_papers
                SET pdf_path = ?, text_path = ?, text_status = 'failed', text_error = ?
                WHERE id = ?
                """,
                (str(pdf_path), str(text_path), str(exc)[:1000], int(row["id"])),
            )
            failed += 1
        conn.commit()

    chunk_result = ensure_arxiv_chunks(
        conn,
        row_limit if not selected_ids else None,
        paper_ids=selected_ids if paper_ids is not None else None,
    )
    embedding_result = ensure_missing_arxiv_chunk_embeddings(
        conn,
        settings,
        row_limit * 80 if not selected_ids else None,
        paper_ids=selected_ids if paper_ids is not None else None,
    )

    return {
        "papers_considered": len(rows),
        "pdfs_downloaded": downloaded,
        "texts_extracted": extracted,
        "texts_failed": failed,
        **chunk_result,
        **embedding_result,
    }


def paper_full_text_excerpt(row: sqlite3.Row, max_chars: int = 12000) -> str:
    text_path = row["text_path"] if "text_path" in row.keys() else ""
    if not text_path:
        return ""
    path = Path(text_path)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="ignore")[:max_chars]
