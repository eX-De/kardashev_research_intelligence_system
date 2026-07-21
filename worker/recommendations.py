from .db_types import DbConnection, DbRow
from typing import Any

from .db import utc_now
from .llm import (
    PROJECT_JUDGMENT_REPORT_CONFIDENCE_THRESHOLD,
    PROJECT_JUDGMENT_REPORT_RELATIONS,
    PROJECT_JUDGMENT_REPORT_USEFULNESS_THRESHOLD,
)
from .project_status import run_daily_project_status_sql
from .papers import promote_arxiv_paper_to_library


VALID_RECOMMENDATION_STATES = {"pending", "accepted", "discarded"}
VALID_IMPORTANCE = {"high", "medium", "low"}


def _paper_filter(
    alias: str,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None,
) -> tuple[str, list[Any]]:
    if paper_ids is None:
        return "", []
    ids = sorted({int(paper_id) for paper_id in paper_ids})
    if not ids:
        return "AND 1 = 0", []
    placeholders = ", ".join("?" for _ in ids)
    return f"AND {alias}.paper_id IN ({placeholders})", ids


def sync_project_paper_recommendations(
    conn: DbConnection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> dict[str, int]:
    paper_clause, paper_params = _paper_filter("j", paper_ids)
    placeholders = ", ".join("?" for _ in PROJECT_JUDGMENT_REPORT_RELATIONS)
    params: list[Any] = [
        *sorted(PROJECT_JUDGMENT_REPORT_RELATIONS),
        PROJECT_JUDGMENT_REPORT_CONFIDENCE_THRESHOLD,
        PROJECT_JUDGMENT_REPORT_USEFULNESS_THRESHOLD,
        *paper_params,
    ]
    rows = conn.execute(
        f"""
        SELECT
          j.project_id,
          j.paper_id,
          j.relation_type,
          j.reason,
          j.input_hash,
          r.state AS existing_state
        FROM project_paper_judgments j
        JOIN arxiv_papers p ON p.id = j.paper_id
        JOIN research_projects rp ON rp.id = j.project_id
        LEFT JOIN project_paper_recommendations r
          ON r.project_id = j.project_id
         AND r.source_arxiv_paper_id = j.paper_id
        WHERE j.relation_type IN ({placeholders})
          AND j.suggested_action != 'ignore'
          AND j.confidence >= ?
          AND j.usefulness_score >= ?
          AND {run_daily_project_status_sql("rp")}
          AND NOT EXISTS (
            SELECT 1 FROM arxiv_paper_tombstones t
            WHERE t.arxiv_id = p.arxiv_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM papers lp
            WHERE lp.arxiv_id = p.arxiv_id
              AND lp.library_status IN ('archived', 'discarded')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM paper_sources ps
            JOIN papers lp ON lp.id = ps.paper_id
            WHERE ps.source_type = 'arxiv'
              AND ps.source_identifier = p.arxiv_id
              AND lp.library_status IN ('archived', 'discarded')
          )
          {paper_clause}
        """,
        params,
    ).fetchall()
    now = utc_now()
    inserted = 0
    refreshed = 0
    preserved = 0
    for row in rows:
        existing_state = str(row["existing_state"] or "")
        library_paper_id = promote_arxiv_paper_to_library(conn, int(row["paper_id"]))
        if library_paper_id is None:
            raise RuntimeError(f"Cannot promote recommendation paper: {row['paper_id']}")
        if existing_state in {"accepted", "discarded"}:
            preserved += 1
        elif existing_state:
            refreshed += 1
        else:
            inserted += 1
        conn.execute(
            """
            INSERT INTO project_paper_recommendations(
              project_id, paper_id, source_arxiv_paper_id, state, importance, relation_type, reason,
              source_judgment_hash, created_at, updated_at
            )
            VALUES (?, ?, ?, 'pending', '', ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, paper_id) DO UPDATE SET
              source_arxiv_paper_id = excluded.source_arxiv_paper_id,
              relation_type = excluded.relation_type,
              reason = excluded.reason,
              source_judgment_hash = excluded.source_judgment_hash,
              updated_at = excluded.updated_at
            """,
            (
                int(row["project_id"]),
                int(library_paper_id),
                int(row["paper_id"]),
                row["relation_type"],
                row["reason"],
                row["input_hash"],
                now,
                now,
            ),
        )
    conn.commit()
    return {
        "paper_recommendation_candidates": len(rows),
        "paper_recommendations_created": inserted,
        "paper_recommendations_refreshed": refreshed,
        "paper_recommendations_preserved": preserved,
    }


def accept_recommendations_for_paper(
    conn: DbConnection,
    paper_id: int,
    project_ids: list[int],
    importance: str,
) -> None:
    if importance not in VALID_IMPORTANCE:
        raise RuntimeError("importance must be high, medium, or low")
    selected_ids = sorted({int(project_id) for project_id in project_ids if int(project_id)})
    if not selected_ids:
        raise RuntimeError("At least one project must be selected")
    if not conn.execute("SELECT id FROM papers WHERE id = ?", (paper_id,)).fetchone():
        raise RuntimeError(f"Paper not found: {paper_id}")
    placeholders = ", ".join("?" for _ in selected_ids)
    rows = conn.execute(
        f"""
        SELECT project_id
        FROM project_paper_recommendations
        WHERE paper_id = ?
          AND project_id IN ({placeholders})
          AND state != 'discarded'
        """,
        (paper_id, *selected_ids),
    ).fetchall()
    found_ids = {int(row["project_id"]) for row in rows}
    missing = [project_id for project_id in selected_ids if project_id not in found_ids]
    if missing:
        raise RuntimeError(f"Recommendation not found for project(s): {missing}")
    now = utc_now()
    conn.execute(
        f"""
        UPDATE project_paper_recommendations
        SET state = 'accepted',
            importance = ?,
            updated_at = ?
        WHERE paper_id = ?
          AND project_id IN ({placeholders})
        """,
        (importance, now, paper_id, *selected_ids),
    )
    conn.execute(
        f"""
        UPDATE project_paper_recommendations
        SET state = 'discarded',
            updated_at = ?
        WHERE paper_id = ?
          AND state = 'pending'
          AND project_id NOT IN ({placeholders})
        """,
        (now, paper_id, *selected_ids),
    )
    for project_id in selected_ids:
        conn.execute(
            """
            INSERT INTO project_papers(project_id, paper_id, relation, note, created_at, updated_at)
            VALUES (?, ?, 'reading', 'accepted_from_recommendation', ?, ?)
            ON CONFLICT(project_id, paper_id) DO UPDATE SET
              relation = CASE
                WHEN project_papers.relation = 'candidate' THEN excluded.relation
                ELSE project_papers.relation
              END,
              note = CASE
                WHEN project_papers.note = 'auto_matched_by_project_context' THEN excluded.note
                ELSE project_papers.note
              END,
              updated_at = excluded.updated_at
            """,
            (project_id, paper_id, now, now),
        )


def discard_recommendations_for_paper(
    conn: DbConnection,
    paper_id: int,
    project_ids: list[int] | None = None,
) -> None:
    if not conn.execute("SELECT id FROM papers WHERE id = ?", (paper_id,)).fetchone():
        raise RuntimeError(f"Paper not found: {paper_id}")
    now = utc_now()
    if project_ids:
        selected_ids = sorted({int(project_id) for project_id in project_ids if int(project_id)})
        placeholders = ", ".join("?" for _ in selected_ids)
        conn.execute(
            f"""
            UPDATE project_paper_recommendations
            SET state = 'discarded',
                updated_at = ?
            WHERE paper_id = ?
              AND state = 'pending'
              AND project_id IN ({placeholders})
            """,
            (now, paper_id, *selected_ids),
        )
        return
    conn.execute(
        """
        UPDATE project_paper_recommendations
        SET state = 'discarded',
            updated_at = ?
        WHERE paper_id = ?
          AND state = 'pending'
        """,
        (now, paper_id),
    )


def project_recommendation_paper_rows(
    conn: DbConnection,
    project_id: int,
    *,
    states: list[str] | tuple[str, ...] | set[str] = ("pending", "accepted"),
    exclude_linked: bool = True,
    limit: int = 80,
) -> list[DbRow]:
    selected_states = [str(state) for state in states if str(state) in VALID_RECOMMENDATION_STATES]
    if not selected_states:
        return []
    state_placeholders = ", ".join("?" for _ in selected_states)
    linked_clause = ""
    if exclude_linked:
        linked_clause = """
          AND NOT EXISTS (
            SELECT 1
            FROM project_papers pp
            WHERE pp.project_id = r.project_id
              AND pp.paper_id = r.paper_id
              AND NOT (
                pp.relation = 'candidate'
                AND pp.note = 'auto_matched_by_project_context'
              )
          )
        """
    row_limit = max(1, min(int(limit or 80), 500))
    return conn.execute(
        f"""
        SELECT
          p.id,
          p.arxiv_id,
          p.title,
          p.published_at,
          COALESCE(text_asset.status, 'pending') AS text_status,
          COALESCE(source.source_url, '') AS link,
          r.state AS recommendation_state,
          r.importance,
          r.relation_type,
          r.reason AS recommendation_reason,
          r.updated_at AS recommendation_updated_at,
          j.relevance_score,
          j.usefulness_score,
          j.confidence
        FROM project_paper_recommendations r
        JOIN papers p ON p.id = r.paper_id
        LEFT JOIN LATERAL (
          SELECT ps.source_url
          FROM paper_sources ps
          WHERE ps.paper_id = p.id
          ORDER BY ps.updated_at DESC, ps.id DESC
          LIMIT 1
        ) source ON TRUE
        LEFT JOIN LATERAL (
          SELECT pa.status
          FROM paper_assets pa
          WHERE pa.paper_id = p.id AND pa.asset_type = 'text'
          ORDER BY pa.updated_at DESC, pa.id DESC
          LIMIT 1
        ) text_asset ON TRUE
        LEFT JOIN project_paper_judgments j
          ON j.project_id = r.project_id AND j.paper_id = r.source_arxiv_paper_id
        WHERE r.project_id = ?
          AND r.state IN ({state_placeholders})
          AND p.library_status NOT IN ('archived', 'discarded')
          {linked_clause}
        ORDER BY
          CASE r.state WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
          CASE r.relation_type WHEN 'direct' THEN 0 WHEN 'indirect' THEN 1 ELSE 2 END,
          COALESCE(j.usefulness_score, 0) DESC,
          COALESCE(j.confidence, 0) DESC,
          p.published_at DESC
        LIMIT ?
        """,
        (int(project_id), *selected_states, row_limit),
    ).fetchall()
