from __future__ import annotations

import sqlite3
from typing import Any

from .config import Settings
from .db import utc_now
from .papers import mark_arxiv_paper_archived


def _paper_ids_clause(paper_ids: list[int]) -> tuple[str, list[Any]]:
    placeholders = ", ".join("?" for _ in paper_ids)
    return placeholders, [*paper_ids]


def archive_zero_match_papers(
    conn: sqlite3.Connection,
    settings: Settings,
    paper_ids: list[int] | tuple[int, ...] | set[int],
    *,
    require_text_complete: bool = True,
    reason: str = "no_match",
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
    text_complete_condition = "AND p.text_status = 'complete'" if require_text_complete and settings.arxiv_cache_full_text else ""
    rows = conn.execute(
        f"""
        SELECT p.*
        FROM arxiv_papers p
        WHERE p.id IN ({placeholders})
          {text_complete_condition}
          AND NOT EXISTS (
            SELECT 1 FROM arxiv_paper_tombstones t
            WHERE t.arxiv_id = p.arxiv_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_papers pp
            WHERE pp.paper_id = p.id
              AND NOT (
                pp.relation = 'candidate'
                AND pp.note = 'auto_matched_by_project_context'
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM papers lp
            WHERE lp.arxiv_id = p.arxiv_id
              AND lp.library_status IN ('saved', 'reading', 'read', 'discarded')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM paper_sources ps
            JOIN papers lp ON lp.id = ps.paper_id
            WHERE ps.source_type = 'arxiv'
              AND ps.source_identifier = p.arxiv_id
              AND lp.library_status IN ('saved', 'reading', 'read', 'discarded')
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_feedback uf
            WHERE uf.paper_id = p.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM artifacts af
            WHERE af.scope_type = 'paper'
              AND af.scope_id = p.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM paper_sources ps
            JOIN artifacts af
              ON af.scope_type = 'paper'
             AND af.scope_id = ps.paper_id
            WHERE ps.source_type = 'arxiv'
              AND ps.source_identifier = p.arxiv_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_paper_recommendations r
            WHERE r.paper_id = p.id
              AND r.state IN ('pending', 'accepted')
          )
        """,
        params,
    ).fetchall()

    files_deleted = 0
    file_delete_errors = 0
    now = utc_now()
    for row in rows:
        mark_arxiv_paper_archived(conn, int(row["id"]))

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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
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
                reason,
                row["fetched_batch_id"],
                now,
            ),
        )

    conn.commit()
    return {
        "zero_match_papers_considered": len(selected_ids),
        "zero_match_papers_archived": len(rows),
        "zero_match_files_deleted": files_deleted,
        "zero_match_file_delete_errors": file_delete_errors,
    }
