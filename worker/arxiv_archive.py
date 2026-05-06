from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from .config import Settings
from .db import utc_now


def _delete_cached_file(path_text: str) -> tuple[int, int]:
    if not path_text:
        return 0, 0
    path = Path(path_text)
    try:
        if path.is_file() or path.is_symlink():
            path.unlink()
            return 1, 0
    except OSError:
        return 0, 1
    return 0, 0


def _paper_ids_clause(paper_ids: list[int]) -> tuple[str, list[Any]]:
    placeholders = ", ".join("?" for _ in paper_ids)
    return placeholders, [*paper_ids]


def archive_zero_match_papers(
    conn: sqlite3.Connection,
    settings: Settings,
    paper_ids: list[int] | tuple[int, ...] | set[int],
) -> dict[str, int]:
    selected_ids = sorted({int(paper_id) for paper_id in paper_ids})
    if not selected_ids:
        return {
            "zero_match_papers_considered": 0,
            "zero_match_papers_archived": 0,
            "zero_match_files_deleted": 0,
            "zero_match_file_delete_errors": 0,
        }

    placeholders, params = _paper_ids_clause(selected_ids)
    text_complete_condition = "AND p.text_status = 'complete'" if settings.arxiv_cache_full_text else ""
    rows = conn.execute(
        f"""
        SELECT p.*
        FROM arxiv_papers p
        WHERE p.id IN ({placeholders})
          {text_complete_condition}
          AND NOT EXISTS (
            SELECT 1 FROM matches m
            WHERE m.paper_id = p.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_paper_matches ppm
            WHERE ppm.paper_id = p.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_papers pp
            WHERE pp.paper_id = p.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_feedback uf
            WHERE uf.paper_id = p.id
          )
        """,
        params,
    ).fetchall()

    files_deleted = 0
    file_delete_errors = 0
    now = utc_now()
    for row in rows:
        for key in ("pdf_path", "text_path"):
            deleted, failed = _delete_cached_file(str(row[key] or ""))
            files_deleted += deleted
            file_delete_errors += failed

        conn.execute(
            """
            INSERT INTO arxiv_paper_tombstones(
              arxiv_id,
              title,
              authors_json,
              summary,
              categories_json,
              published_at,
              updated_at,
              link,
              pdf_link,
              reason,
              original_fetched_batch_id,
              seen_count,
              last_seen_at,
              tombstoned_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'no_match', ?, 0, NULL, ?)
            ON CONFLICT(arxiv_id) DO UPDATE SET
              title = excluded.title,
              authors_json = excluded.authors_json,
              summary = excluded.summary,
              categories_json = excluded.categories_json,
              published_at = excluded.published_at,
              updated_at = excluded.updated_at,
              link = excluded.link,
              pdf_link = excluded.pdf_link,
              reason = excluded.reason,
              original_fetched_batch_id = excluded.original_fetched_batch_id,
              tombstoned_at = excluded.tombstoned_at
            """,
            (
                row["arxiv_id"],
                row["title"],
                row["authors_json"],
                row["summary"],
                row["categories_json"],
                row["published_at"],
                row["updated_at"],
                row["link"],
                row["pdf_link"],
                row["fetched_batch_id"],
                now,
            ),
        )
        conn.execute(
            """
            DELETE FROM arxiv_chunk_embeddings
            WHERE arxiv_chunk_id IN (
              SELECT id FROM arxiv_text_chunks
              WHERE paper_id = ?
            )
            """,
            (int(row["id"]),),
        )
        for table in (
            "paper_prefilter_runs",
            "arxiv_paper_embeddings",
            "llm_explanations",
            "matches",
            "project_paper_matches",
            "project_papers",
            "arxiv_text_chunks",
        ):
            conn.execute(f"DELETE FROM {table} WHERE paper_id = ?", (int(row["id"]),))
        conn.execute("DELETE FROM arxiv_papers WHERE id = ?", (int(row["id"]),))

    conn.commit()
    return {
        "zero_match_papers_considered": len(selected_ids),
        "zero_match_papers_archived": len(rows),
        "zero_match_files_deleted": files_deleted,
        "zero_match_file_delete_errors": file_delete_errors,
    }
