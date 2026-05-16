from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from .db import clean_unicode, from_json, to_json, utc_now
from .config import Settings
from .obsidian import status_tag_for_project_status, update_markdown_status_tag
from .obsidian_library import sync_accepted_paper_to_obsidian
from .paper_reports import (
    ensure_paper_reports_for_recommendations,
    ensure_report_ready_for_paper,
    paper_report_payload,
    process_paper_report_queue,
    queue_paper_report,
    remove_paper_report_from_queue,
    sync_paper_report_for_recommendation_state,
)
from .recommendations import (
    accept_recommendations_for_paper,
    discard_recommendations_for_paper,
    sync_project_paper_recommendations,
)
from .reminders import reminders


VALID_FEEDBACK = {"relevant", "not_relevant", "read_later", "read", "favorite"}
PROJECT_STATUSES = {"planned", "active", "completed", "paused", "exploring", "writing", "archived"}
PROJECT_PAPER_RELATIONS = {"candidate", "reading", "core", "background", "rejected"}
PROJECT_NOTE_RELATIONS = {"source", "idea", "method", "result", "todo", "center_page", "folder_member"}
DEFAULT_PROJECT_AUTOMATION = {
    "auto_link_papers": False,
    "generate_paper_cards": True,
    "generate_project_digest": True,
    "sync_experiment_notes": True,
}


def _csv_payload(value: object) -> list[str]:
    if isinstance(value, list):
        return [clean_unicode(str(item)).strip() for item in value if clean_unicode(str(item)).strip()]
    return [clean_unicode(part).strip() for part in str(value or "").split(",") if clean_unicode(part).strip()]


def _tag_payload(value: object) -> list[str]:
    return [item.lstrip("#").lower() for item in _csv_payload(value)]


def _bool_payload(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _automation_payload(value: object) -> dict[str, bool]:
    raw = value if isinstance(value, dict) else {}
    return {
        key: _bool_payload(raw.get(key), default)
        for key, default in DEFAULT_PROJECT_AUTOMATION.items()
    }


def _row_value(row: sqlite3.Row, key: str, default: object = "") -> object:
    if key not in row.keys():
        return default
    value = row[key]
    return default if value is None else clean_unicode(value)


def _project_row(row: sqlite3.Row) -> dict[str, object]:
    automation = {
        **DEFAULT_PROJECT_AUTOMATION,
        **from_json(str(_row_value(row, "automation_json", "{}")), {}),
    }
    return {
        "id": int(row["id"]),
        "name": row["name"],
        "status": row["status"],
        "summary": _row_value(row, "summary", ""),
        "goals": _row_value(row, "goals", ""),
        "keywords": from_json(str(_row_value(row, "keywords_json", "[]")), []),
        "obsidian_project_path": _row_value(row, "obsidian_project_path", ""),
        "obsidian_output_dir": _row_value(row, "obsidian_output_dir", ""),
        "obsidian_note_id": _row_value(row, "obsidian_note_id", None),
        "obsidian_folder": _row_value(row, "obsidian_folder", ""),
        "obsidian_status_tag": _row_value(row, "obsidian_status_tag", ""),
        "discovery_source": _row_value(row, "discovery_source", "manual"),
        "source_tags": from_json(str(_row_value(row, "source_tags_json", "[]")), []),
        "arxiv_categories": from_json(str(_row_value(row, "arxiv_categories_json", "[]")), []),
        "automation": automation,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "paper_count": int(row["paper_count"] or 0) if "paper_count" in row.keys() else 0,
        "note_count": int(row["note_count"] or 0) if "note_count" in row.keys() else 0,
        "artifact_count": int(row["artifact_count"] or 0) if "artifact_count" in row.keys() else 0,
        "latest_artifact_at": _row_value(row, "latest_artifact_at", ""),
    }


def projects(conn: sqlite3.Connection) -> dict[str, object]:
    rows = conn.execute(
        """
        SELECT
          p.*,
          COUNT(DISTINCT pp.paper_id) AS paper_count,
          COUNT(DISTINCT pn.note_id) AS note_count,
          COUNT(DISTINCT pa.id) AS artifact_count,
          MAX(pa.updated_at) AS latest_artifact_at
        FROM research_projects p
        LEFT JOIN project_papers pp
          ON pp.project_id = p.id
         AND NOT (
           pp.relation = 'candidate'
           AND pp.note = 'auto_matched_by_project_context'
         )
        LEFT JOIN project_notes pn ON pn.project_id = p.id
        LEFT JOIN project_artifacts pa ON pa.project_id = p.id
        GROUP BY p.id
        ORDER BY
          CASE p.status
            WHEN 'active' THEN 1
            WHEN 'exploring' THEN 2
            WHEN 'writing' THEN 3
            WHEN 'paused' THEN 4
            ELSE 5
          END,
          p.updated_at DESC
        """
    ).fetchall()
    return {"items": [_project_row(row) for row in rows]}


def project_detail(conn: sqlite3.Connection, project_id: int) -> dict[str, object]:
    row = conn.execute(
        """
        SELECT
          p.*,
          COUNT(DISTINCT pp.paper_id) AS paper_count,
          COUNT(DISTINCT pn.note_id) AS note_count
        FROM research_projects p
        LEFT JOIN project_papers pp
          ON pp.project_id = p.id
         AND NOT (
           pp.relation = 'candidate'
           AND pp.note = 'auto_matched_by_project_context'
         )
        LEFT JOIN project_notes pn ON pn.project_id = p.id
        WHERE p.id = ?
        GROUP BY p.id
        """,
        (project_id,),
    ).fetchone()
    if not row:
        raise RuntimeError(f"Project not found: {project_id}")
    papers = conn.execute(
        """
        SELECT
          p.id,
          p.arxiv_id,
          p.title,
          p.link,
          pp.relation,
          pp.note,
          pp.updated_at,
          COALESCE(NULLIF(ppm.quality_score, 0), ppm.score) AS project_score
        FROM project_papers pp
        JOIN arxiv_papers p ON p.id = pp.paper_id
        LEFT JOIN project_paper_matches ppm
          ON ppm.project_id = pp.project_id AND ppm.paper_id = pp.paper_id
        WHERE pp.project_id = ?
          AND NOT (
            pp.relation = 'candidate'
            AND pp.note = 'auto_matched_by_project_context'
          )
        ORDER BY COALESCE(ppm.score, 0) DESC, pp.updated_at DESC
        """,
        (project_id,),
    ).fetchall()
    notes = conn.execute(
        """
        SELECT n.id, n.path, n.title, pn.relation, pn.note, pn.updated_at
        FROM project_notes pn
        JOIN obsidian_notes n ON n.id = pn.note_id
        WHERE pn.project_id = ?
        ORDER BY pn.updated_at DESC
        """,
        (project_id,),
    ).fetchall()
    candidate_papers = conn.execute(
        """
        SELECT
          p.id,
          p.arxiv_id,
          p.title,
          p.published_at,
          p.text_status,
          MAX(m.score) AS score
        FROM arxiv_papers p
        LEFT JOIN matches m ON m.paper_id = p.id
        WHERE NOT EXISTS (
          SELECT 1 FROM project_papers pp
          WHERE pp.project_id = ? AND pp.paper_id = p.id
            AND NOT (
              pp.relation = 'candidate'
              AND pp.note = 'auto_matched_by_project_context'
            )
        )
        GROUP BY p.id
        ORDER BY score DESC, p.published_at DESC
        LIMIT 80
        """,
        (project_id,),
    ).fetchall()
    candidate_notes = conn.execute(
        """
        SELECT n.id, n.path, n.title, n.tags_json, COUNT(c.id) AS chunk_count
        FROM obsidian_notes n
        LEFT JOIN research_chunks c ON c.note_id = n.id
        WHERE NOT EXISTS (
          SELECT 1 FROM project_notes pn
          WHERE pn.project_id = ? AND pn.note_id = n.id
        )
        GROUP BY n.id
        ORDER BY n.indexed_at DESC
        LIMIT 80
        """,
        (project_id,),
    ).fetchall()
    artifacts = conn.execute(
        """
        SELECT id, artifact_type, title, obsidian_path, status, source_json, updated_at
        FROM project_artifacts
        WHERE project_id = ?
        ORDER BY updated_at DESC
        """,
        (project_id,),
    ).fetchall()
    project_matches = conn.execute(
        """
        SELECT
          ppm.paper_id,
          ppm.score,
          ppm.rank_score,
          COALESCE(NULLIF(ppm.quality_score, 0), ppm.score) AS quality_score,
          ppm.best_arxiv_chunk_id,
          ppm.best_obsidian_chunk_id,
          ppm.searchers_json,
          ppm.evidence_json,
          ppm.match_type,
          ppm.updated_at,
          p.arxiv_id,
          p.title,
          p.link,
          p.published_at,
          ac.chunk_index AS arxiv_chunk_index,
          ac.source AS arxiv_chunk_source,
          ac.page_start AS arxiv_page_start,
          ac.page_end AS arxiv_page_end,
          ac.text AS arxiv_text,
          c.heading AS obsidian_heading,
          c.text AS obsidian_text,
          n.title AS note_title,
          n.path AS note_path,
          j.relation_type,
          j.relevance_score,
          j.usefulness_score,
          j.confidence AS judgment_confidence,
          j.suggested_action,
          j.reason AS judgment_reason,
          j.evidence_mapping_json,
          j.missing_evidence,
          j.updated_at AS judgment_updated_at
        FROM project_paper_matches ppm
        JOIN arxiv_papers p ON p.id = ppm.paper_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = ppm.best_arxiv_chunk_id
        LEFT JOIN research_chunks c ON c.id = ppm.best_obsidian_chunk_id
        LEFT JOIN obsidian_notes n ON n.id = c.note_id
        LEFT JOIN project_paper_judgments j
          ON j.project_id = ppm.project_id AND j.paper_id = ppm.paper_id
        WHERE ppm.project_id = ?
        ORDER BY quality_score DESC, ppm.updated_at DESC
        LIMIT 80
        """,
        (project_id,),
    ).fetchall()
    return {
        "project": _project_row(row),
        "papers": [
            {
                "id": int(paper["id"]),
                "arxiv_id": paper["arxiv_id"],
                "title": paper["title"],
                "link": paper["link"],
                "relation": paper["relation"],
                "note": paper["note"],
                "project_score": float(paper["project_score"] or 0),
                "updated_at": paper["updated_at"],
            }
            for paper in papers
        ],
        "notes": [
            {
                "id": int(note["id"]),
                "path": note["path"],
                "title": note["title"],
                "relation": note["relation"],
                "note": note["note"],
                "updated_at": note["updated_at"],
            }
            for note in notes
        ],
        "candidate_papers": [
            {
                "id": int(paper["id"]),
                "arxiv_id": paper["arxiv_id"],
                "title": paper["title"],
                "published_at": paper["published_at"],
                "text_status": paper["text_status"],
                "score": float(paper["score"] or 0),
            }
            for paper in candidate_papers
        ],
        "candidate_notes": [
            {
                "id": int(note["id"]),
                "path": note["path"],
                "title": note["title"],
                "tags": from_json(note["tags_json"], []),
                "chunk_count": int(note["chunk_count"] or 0),
            }
            for note in candidate_notes
        ],
        "artifacts": [
            {
                "id": int(artifact["id"]),
                "artifact_type": artifact["artifact_type"],
                "title": artifact["title"],
                "obsidian_path": artifact["obsidian_path"],
                "status": artifact["status"],
                "source": from_json(artifact["source_json"], {}),
                "updated_at": artifact["updated_at"],
            }
            for artifact in artifacts
        ],
        "project_matches": [
            {
                "paper_id": int(match["paper_id"]),
                "arxiv_id": match["arxiv_id"],
                "title": match["title"],
                "link": match["link"],
                "published_at": match["published_at"],
                "score": float(match["score"] or 0),
                "best_arxiv_chunk_id": int(match["best_arxiv_chunk_id"])
                if match["best_arxiv_chunk_id"] is not None
                else None,
                "best_obsidian_chunk_id": int(match["best_obsidian_chunk_id"])
                if match["best_obsidian_chunk_id"] is not None
                else None,
                "searchers": from_json(match["searchers_json"], []),
                "evidence": from_json(match["evidence_json"], {}),
                "match_type": match["match_type"],
                "updated_at": match["updated_at"],
                "arxiv_chunk_index": match["arxiv_chunk_index"],
                "arxiv_chunk_source": match["arxiv_chunk_source"],
                "arxiv_page_start": match["arxiv_page_start"],
                "arxiv_page_end": match["arxiv_page_end"],
                "arxiv_text": match["arxiv_text"],
                "obsidian_heading": match["obsidian_heading"],
                "obsidian_text": match["obsidian_text"],
                "note_title": match["note_title"],
                "note_path": match["note_path"],
                "rank_score": float(match["rank_score"] or 0),
                "quality_score": float(match["quality_score"] or 0),
                "judgment": None
                if match["relation_type"] is None
                else {
                    "relation_type": match["relation_type"],
                    "relevance_score": float(match["relevance_score"] or 0),
                    "usefulness_score": float(match["usefulness_score"] or 0),
                    "confidence": float(match["judgment_confidence"] or 0),
                    "suggested_action": match["suggested_action"],
                    "reason": match["judgment_reason"],
                    "evidence_mapping": from_json(match["evidence_mapping_json"], []),
                    "missing_evidence": match["missing_evidence"],
                    "updated_at": match["judgment_updated_at"],
                },
            }
            for match in project_matches
        ],
    }


def _sync_project_status_to_obsidian(
    settings: Settings | None,
    obsidian_project_path: str,
    status: str,
) -> str:
    status_tag = status_tag_for_project_status(status)
    if settings and settings.obsidian_vault_path and obsidian_project_path:
        update_markdown_status_tag(settings.obsidian_vault_path, obsidian_project_path, status)
    return status_tag


def save_project(
    conn: sqlite3.Connection,
    payload: dict[str, object],
    settings: Settings | None = None,
) -> dict[str, object]:
    name = clean_unicode(str(payload.get("name") or "")).strip()
    if not name:
        raise RuntimeError("Project name is required")
    status = clean_unicode(str(payload.get("status") or "active")).strip()
    if status not in PROJECT_STATUSES:
        raise RuntimeError(f"Invalid project status: {status}")
    summary = clean_unicode(str(payload.get("summary") or "")).strip()
    goals = clean_unicode(str(payload.get("goals") or "")).strip()
    keywords = _csv_payload(payload.get("keywords", []))
    obsidian_project_path = clean_unicode(str(payload.get("obsidian_project_path") or "")).strip().replace("\\", "/")
    obsidian_output_dir = clean_unicode(str(payload.get("obsidian_output_dir") or "")).strip().replace("\\", "/")
    obsidian_folder = clean_unicode(str(payload.get("obsidian_folder") or "")).strip().replace("\\", "/")
    discovery_source = clean_unicode(str(payload.get("discovery_source") or "manual")).strip() or "manual"
    source_tags = _tag_payload(payload.get("source_tags", []))
    arxiv_categories = _csv_payload(payload.get("arxiv_categories", []))
    automation = _automation_payload(payload.get("automation", {}))
    obsidian_status_tag = status_tag_for_project_status(status)
    now = utc_now()
    project_id = payload.get("id")
    if project_id:
        existing = conn.execute(
            "SELECT obsidian_project_path, obsidian_folder, discovery_source FROM research_projects WHERE id = ?",
            (int(project_id),),
        ).fetchone()
        if existing:
            if not obsidian_project_path:
                obsidian_project_path = existing["obsidian_project_path"] or ""
            if not obsidian_folder:
                obsidian_folder = existing["obsidian_folder"] or ""
            discovery_source = existing["discovery_source"] or discovery_source
        obsidian_status_tag = _sync_project_status_to_obsidian(settings, obsidian_project_path, status)
        conn.execute(
            """
            UPDATE research_projects
            SET
              name = ?,
              status = ?,
              summary = ?,
              goals = ?,
              keywords_json = ?,
              obsidian_project_path = ?,
              obsidian_output_dir = ?,
              obsidian_folder = ?,
              obsidian_status_tag = ?,
              discovery_source = ?,
              source_tags_json = ?,
              arxiv_categories_json = ?,
              automation_json = ?,
              updated_at = ?
            WHERE id = ?
            """,
            (
                name,
                status,
                summary,
                goals,
                to_json(keywords),
                obsidian_project_path,
                obsidian_output_dir,
                obsidian_folder,
                obsidian_status_tag,
                discovery_source,
                to_json(source_tags),
                to_json(arxiv_categories),
                to_json(automation),
                now,
                int(project_id),
            ),
        )
    else:
        cur = conn.execute(
            """
            INSERT INTO research_projects(
              name, status, summary, goals, keywords_json, obsidian_project_path,
              obsidian_output_dir, obsidian_folder, obsidian_status_tag, discovery_source,
              source_tags_json, arxiv_categories_json, automation_json,
              created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name,
                status,
                summary,
                goals,
                to_json(keywords),
                obsidian_project_path,
                obsidian_output_dir,
                obsidian_folder,
                obsidian_status_tag,
                discovery_source,
                to_json(source_tags),
                to_json(arxiv_categories),
                to_json(automation),
                now,
                now,
            ),
        )
        project_id = int(cur.lastrowid)
    conn.commit()
    return project_detail(conn, int(project_id))


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" .")
    return cleaned or "project"


def _resolve_vault_markdown_path(settings: Settings, project: dict[str, object]) -> tuple[Path, str]:
    if not settings.obsidian_vault_path:
        raise RuntimeError("Obsidian vault path is not configured")
    vault = settings.obsidian_vault_path.expanduser().resolve()
    if not vault.exists() or not vault.is_dir():
        raise RuntimeError("Obsidian vault path does not exist")
    configured = str(project.get("obsidian_project_path") or "").strip()
    if not configured:
        output_dir = str(project.get("obsidian_output_dir") or "").strip().strip("/\\")
        filename = f"{_safe_filename(str(project['name']))}.md"
        configured = str(Path(output_dir) / filename) if output_dir else str(Path("Projects") / filename)
    target = Path(configured).expanduser()
    if not target.suffix:
        target = target.with_suffix(".md")
    resolved = target.resolve() if target.is_absolute() else (vault / target).resolve()
    try:
        relative = resolved.relative_to(vault)
    except ValueError as exc:
        raise RuntimeError("Project Obsidian path must be inside the configured vault") from exc
    return resolved, relative.as_posix()


def _md_cell(value: object) -> str:
    return clean_unicode(str(value or "")).replace("|", "\\|").replace("\n", " ").strip()


def _project_markdown(detail: dict[str, object]) -> str:
    project = detail["project"]
    papers = detail.get("papers", [])
    notes = detail.get("notes", [])
    generated_at = utc_now()
    keywords = ", ".join(project.get("keywords", []))
    source_tags = ", ".join(project.get("source_tags", []))
    arxiv_categories = ", ".join(project.get("arxiv_categories", []))
    lines = [
        "---",
        f"title: {_md_cell(project['name'])}",
        f"project_status: {_md_cell(project['status'])}",
        f"generated_at: {generated_at}",
        "source: research_intelligence_system",
        "---",
        "",
        f"# {_md_cell(project['name'])}",
        "",
        "## 自动化配置",
        "",
        f"- 状态: {_md_cell(project['status'])}",
        f"- 关键词: {_md_cell(keywords)}",
        f"- Obsidian 源标签: {_md_cell(source_tags)}",
        f"- arXiv 分类: {_md_cell(arxiv_categories)}",
        f"- 输出目录: {_md_cell(project.get('obsidian_output_dir'))}",
        "",
        "## 论文",
        "",
        "| 关系 | arXiv | 标题 |",
        "| --- | --- | --- |",
    ]
    if papers:
        for paper in papers:
            lines.append(
                f"| {_md_cell(paper['relation'])} | {_md_cell(paper['arxiv_id'])} | {_md_cell(paper['title'])} |"
            )
    else:
        lines.append("|  |  |  |")
    lines.extend(
        [
            "",
            "## Obsidian 笔记",
            "",
            "| 关系 | 路径 | 标题 |",
            "| --- | --- | --- |",
        ]
    )
    if notes:
        for note in notes:
            lines.append(
                f"| {_md_cell(note['relation'])} | {_md_cell(note['path'])} | {_md_cell(note['title'])} |"
            )
    else:
        lines.append("|  |  |  |")
    lines.append("")
    return "\n".join(lines)


def export_project_to_obsidian(
    conn: sqlite3.Connection,
    settings: Settings,
    project_id: int,
) -> dict[str, object]:
    detail = project_detail(conn, project_id)
    target, relative_path = _resolve_vault_markdown_path(settings, detail["project"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_project_markdown(detail), encoding="utf-8")
    now = utc_now()
    conn.execute(
        """
        INSERT INTO project_artifacts(
          project_id, artifact_type, title, obsidian_path, status, source_json, created_at, updated_at
        )
        VALUES (?, 'project_index', 'Project index', ?, 'synced', ?, ?, ?)
        ON CONFLICT(project_id, artifact_type, obsidian_path) DO UPDATE SET
          status = excluded.status,
          source_json = excluded.source_json,
          updated_at = excluded.updated_at
        """,
        (
            project_id,
            relative_path,
            to_json({"paper_count": len(detail.get("papers", [])), "note_count": len(detail.get("notes", []))}),
            now,
            now,
        ),
    )
    conn.commit()
    updated = project_detail(conn, project_id)
    updated["export"] = {"obsidian_path": relative_path, "status": "synced"}
    return updated


def _relation(value: object, allowed: set[str], default: str) -> str:
    relation = str(value or default).strip()
    if relation not in allowed:
        raise RuntimeError(f"Invalid relation: {relation}")
    return relation


def link_project_paper(conn: sqlite3.Connection, project_id: int, payload: dict[str, object]) -> dict[str, object]:
    paper_id = int(payload.get("paper_id") or 0)
    if not paper_id:
        raise RuntimeError("paper_id is required")
    relation = _relation(payload.get("relation"), PROJECT_PAPER_RELATIONS, "candidate")
    note = str(payload.get("note") or "").strip()
    now = utc_now()
    conn.execute(
        """
        INSERT INTO project_papers(project_id, paper_id, relation, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, paper_id) DO UPDATE SET
          relation = excluded.relation,
          note = excluded.note,
          updated_at = excluded.updated_at
        """,
        (project_id, paper_id, relation, note, now, now),
    )
    conn.commit()
    return project_detail(conn, project_id)


def unlink_project_paper(conn: sqlite3.Connection, project_id: int, paper_id: int) -> dict[str, object]:
    conn.execute(
        "DELETE FROM project_papers WHERE project_id = ? AND paper_id = ?",
        (project_id, paper_id),
    )
    conn.commit()
    return project_detail(conn, project_id)


def link_project_note(conn: sqlite3.Connection, project_id: int, payload: dict[str, object]) -> dict[str, object]:
    note_id = int(payload.get("note_id") or 0)
    if not note_id:
        raise RuntimeError("note_id is required")
    relation = _relation(payload.get("relation"), PROJECT_NOTE_RELATIONS, "source")
    note = str(payload.get("note") or "").strip()
    now = utc_now()
    conn.execute(
        """
        INSERT INTO project_notes(project_id, note_id, relation, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, note_id) DO UPDATE SET
          relation = excluded.relation,
          note = excluded.note,
          updated_at = excluded.updated_at
        """,
        (project_id, note_id, relation, note, now, now),
    )
    conn.commit()
    return project_detail(conn, project_id)


def unlink_project_note(conn: sqlite3.Connection, project_id: int, note_id: int) -> dict[str, object]:
    conn.execute(
        "DELETE FROM project_notes WHERE project_id = ? AND note_id = ?",
        (project_id, note_id),
    )
    conn.commit()
    return project_detail(conn, project_id)


def inbox(conn: sqlite3.Connection) -> dict[str, object]:
    sync_project_paper_recommendations(conn)
    ensure_paper_reports_for_recommendations(conn)
    rows = conn.execute(
        """
        WITH pending_recommendations AS (
          SELECT
            r.*,
            COUNT(*) OVER (PARTITION BY r.paper_id) AS project_count,
            ROW_NUMBER() OVER (
              PARTITION BY r.paper_id
              ORDER BY
                CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
                r.updated_at DESC
            ) AS rn
          FROM project_paper_recommendations r
          WHERE r.state = 'pending'
        )
        SELECT
          p.id,
          p.arxiv_id,
          p.title,
          p.authors_json,
          p.categories_json,
          p.published_at,
          p.link,
          r.project_id,
          rp.name AS project_name,
          r.relation_type,
          r.reason,
          r.project_count,
          j.usefulness_score,
          j.confidence,
          rr.status AS report_status,
          rr.error_message AS report_error,
          rr.updated_at AS report_updated_at
        FROM arxiv_papers p
        JOIN pending_recommendations r ON r.paper_id = p.id AND r.rn = 1
        JOIN research_projects rp ON rp.id = r.project_id
        LEFT JOIN project_paper_judgments j
          ON j.project_id = r.project_id AND j.paper_id = r.paper_id
        LEFT JOIN paper_reading_reports rr ON rr.paper_id = p.id
        ORDER BY
          CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
          COALESCE(j.usefulness_score, 0) DESC,
          j.confidence DESC,
          p.published_at DESC
        LIMIT 100
        """,
    ).fetchall()
    items = []
    for row in rows:
        items.append(
            {
                "id": int(row["id"]),
                "arxiv_id": row["arxiv_id"],
                "title": row["title"],
                "authors": from_json(row["authors_json"], []),
                "categories": from_json(row["categories_json"], []),
                "published_at": row["published_at"],
                "link": row["link"],
                "score": float(row["usefulness_score"] or 0),
                "project_id": int(row["project_id"]),
                "project_name": row["project_name"],
                "relation_type": row["relation_type"],
                "confidence": float(row["confidence"] or 0),
                "reason": row["reason"],
                "project_count": int(row["project_count"] or 1),
                "report_status": row["report_status"] or "",
                "report_error": row["report_error"] or "",
                "report_updated_at": row["report_updated_at"],
                "feedback_status": "",
            }
        )
    return {"items": items}


def paper_reports_queue(conn: sqlite3.Connection, limit: int = 300) -> dict[str, object]:
    sync_project_paper_recommendations(conn)
    ensure_paper_reports_for_recommendations(conn)
    stats = {"queued": 0, "processing": 0, "done": 0, "failed": 0, "total": 0}
    for row in conn.execute(
        "SELECT status, COUNT(*) AS count FROM paper_reading_reports WHERE status != 'removed' GROUP BY status"
    ).fetchall():
        status = str(row["status"] or "")
        count = int(row["count"] or 0)
        stats[status] = count
        stats["total"] += count
    row_limit = max(1, min(int(limit or 300), 1000))
    rows = conn.execute(
        """
        WITH rec_projects AS (
          SELECT
            r.paper_id,
            COUNT(*) AS project_count,
            group_concat(DISTINCT rp.name) AS project_names,
            group_concat(DISTINCT r.relation_type) AS relation_types
          FROM project_paper_recommendations r
          JOIN research_projects rp ON rp.id = r.project_id
          WHERE r.state IN ('pending', 'accepted')
          GROUP BY r.paper_id
        )
        SELECT
          rr.paper_id,
          rr.status,
          rr.model_provider_id,
          rr.model,
          rr.report_markdown,
          rr.error_message,
          rr.created_at,
          rr.updated_at,
          rr.started_at,
          rr.finished_at,
          p.arxiv_id,
          p.title,
          p.authors_json,
          p.categories_json,
          p.published_at,
          p.link,
          p.text_status,
          COALESCE(rp.project_count, 0) AS project_count,
          COALESCE(rp.project_names, '') AS project_names,
          COALESCE(rp.relation_types, '') AS relation_types
        FROM paper_reading_reports rr
        JOIN arxiv_papers p ON p.id = rr.paper_id
        LEFT JOIN rec_projects rp ON rp.paper_id = rr.paper_id
        WHERE rr.status != 'removed'
        ORDER BY
          CASE rr.status
            WHEN 'processing' THEN 0
            WHEN 'queued' THEN 1
            WHEN 'failed' THEN 2
            WHEN 'done' THEN 3
            ELSE 4
          END,
          rr.updated_at DESC,
          p.published_at DESC
        LIMIT ?
        """,
        (row_limit,),
    ).fetchall()
    return {
        "stats": stats,
        "items": [
            {
                "paper_id": int(row["paper_id"]),
                "id": int(row["paper_id"]),
                "status": row["status"],
                "title": row["title"],
                "arxiv_id": row["arxiv_id"],
                "authors": from_json(row["authors_json"], []),
                "categories": from_json(row["categories_json"], []),
                "published_at": row["published_at"],
                "link": row["link"],
                "text_status": row["text_status"],
                "project_count": int(row["project_count"] or 0),
                "project_names": [
                    name for name in str(row["project_names"] or "").split(",") if name
                ],
                "relation_types": [
                    relation for relation in str(row["relation_types"] or "").split(",") if relation
                ],
                "model_provider_id": row["model_provider_id"],
                "model": row["model"],
                "error_message": row["error_message"],
                "report_excerpt": clean_unicode(str(row["report_markdown"] or "")).strip()[:500],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "started_at": row["started_at"],
                "finished_at": row["finished_at"],
            }
            for row in rows
        ],
    }


def remove_paper_report(conn: sqlite3.Connection, paper_id: int) -> dict[str, object]:
    result = remove_paper_report_from_queue(conn, paper_id)
    return {"ok": True, "paper_id": paper_id, **result}


def paper_detail(conn: sqlite3.Connection, paper_id: int) -> dict[str, object]:
    sync_project_paper_recommendations(conn, [paper_id])
    ensure_paper_reports_for_recommendations(conn, [paper_id])
    paper = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone()
    if not paper:
        raise RuntimeError(f"Paper not found: {paper_id}")
    evidence_rows = conn.execute(
        """
        SELECT
          m.chunk_id,
          m.arxiv_chunk_id,
          m.score,
          m.searchers_json,
          m.evidence_json,
          ac.chunk_index AS arxiv_chunk_index,
          ac.source AS arxiv_chunk_source,
          ac.page_start AS arxiv_page_start,
          ac.page_end AS arxiv_page_end,
          ac.text AS arxiv_text,
          c.heading,
          c.text,
          n.title AS note_title,
          n.path AS note_path
        FROM matches m
        JOIN research_chunks c ON c.id = m.chunk_id
        JOIN obsidian_notes n ON n.id = c.note_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = m.arxiv_chunk_id
        WHERE m.paper_id = ?
        ORDER BY m.score DESC
        """,
        (paper_id,),
    ).fetchall()
    judgment_rows = conn.execute(
        """
        SELECT
          j.project_id,
          rp.name AS project_name,
          j.relation_type,
          j.relevance_score,
          j.usefulness_score,
          j.confidence,
          j.suggested_action,
          j.reason,
          j.evidence_mapping_json,
          j.missing_evidence,
          j.updated_at
        FROM project_paper_judgments j
        JOIN research_projects rp ON rp.id = j.project_id
        WHERE j.paper_id = ?
        ORDER BY
          CASE j.relation_type WHEN 'direct' THEN 0 WHEN 'indirect' THEN 1 WHEN 'weak' THEN 2 ELSE 3 END,
          j.usefulness_score DESC,
          j.confidence DESC
        """,
        (paper_id,),
    ).fetchall()
    feedback = conn.execute(
        "SELECT status, note, updated_at FROM user_feedback WHERE paper_id = ? ORDER BY updated_at DESC",
        (paper_id,),
    ).fetchall()
    recommendation_rows = conn.execute(
        """
        SELECT
          r.project_id,
          rp.name AS project_name,
          rp.obsidian_project_path,
          rp.obsidian_folder,
          r.state,
          r.importance,
          r.relation_type,
          r.reason,
          r.obsidian_path,
          r.attachment_path,
          r.source_judgment_hash,
          r.synced_at,
          r.updated_at,
          j.relevance_score,
          j.usefulness_score,
          j.confidence
        FROM project_paper_recommendations r
        JOIN research_projects rp ON rp.id = r.project_id
        LEFT JOIN project_paper_judgments j
          ON j.project_id = r.project_id AND j.paper_id = r.paper_id
        WHERE r.paper_id = ?
        ORDER BY
          CASE r.state WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
          CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
          COALESCE(j.usefulness_score, 0) DESC,
          rp.name
        """,
        (paper_id,),
    ).fetchall()
    return {
        "paper": {
            "id": int(paper["id"]),
            "arxiv_id": paper["arxiv_id"],
            "title": paper["title"],
            "authors": from_json(paper["authors_json"], []),
            "summary": paper["summary"],
            "categories": from_json(paper["categories_json"], []),
            "published_at": paper["published_at"],
            "updated_at": paper["updated_at"],
            "link": paper["link"],
            "pdf_link": paper["pdf_link"],
            "pdf_path": paper["pdf_path"],
            "text_path": paper["text_path"],
            "text_status": paper["text_status"],
            "text_extracted_at": paper["text_extracted_at"],
            "text_error": paper["text_error"],
            "text_char_count": int(paper["text_char_count"] or 0),
        },
        "explanation": None,
        "project_judgments": [
            {
                "project_id": int(row["project_id"]),
                "project_name": row["project_name"],
                "relation_type": row["relation_type"],
                "relevance_score": float(row["relevance_score"] or 0),
                "usefulness_score": float(row["usefulness_score"] or 0),
                "confidence": float(row["confidence"] or 0),
                "suggested_action": row["suggested_action"],
                "reason": row["reason"],
                "evidence_mapping": from_json(row["evidence_mapping_json"], []),
                "missing_evidence": row["missing_evidence"],
                "updated_at": row["updated_at"],
            }
            for row in judgment_rows
        ],
        "project_recommendations": [
            {
                "project_id": int(row["project_id"]),
                "project_name": row["project_name"],
                "obsidian_project_path": row["obsidian_project_path"],
                "obsidian_folder": row["obsidian_folder"],
                "state": row["state"],
                "importance": row["importance"],
                "relation_type": row["relation_type"],
                "reason": row["reason"],
                "obsidian_path": row["obsidian_path"],
                "attachment_path": row["attachment_path"],
                "source_judgment_hash": row["source_judgment_hash"],
                "synced_at": row["synced_at"],
                "updated_at": row["updated_at"],
                "relevance_score": float(row["relevance_score"] or 0),
                "usefulness_score": float(row["usefulness_score"] or 0),
                "confidence": float(row["confidence"] or 0),
            }
            for row in recommendation_rows
        ],
        "paper_report": paper_report_payload(conn, paper_id),
        "evidence": [
            {
                "chunk_id": int(row["chunk_id"]),
                "arxiv_chunk_id": int(row["arxiv_chunk_id"]) if row["arxiv_chunk_id"] is not None else None,
                "score": float(row["score"]),
                "searchers": from_json(row["searchers_json"], []),
                "match_evidence": from_json(row["evidence_json"], {}),
                "arxiv_chunk_index": row["arxiv_chunk_index"],
                "arxiv_chunk_source": row["arxiv_chunk_source"],
                "arxiv_page_start": row["arxiv_page_start"],
                "arxiv_page_end": row["arxiv_page_end"],
                "arxiv_text": row["arxiv_text"],
                "heading": row["heading"],
                "text": row["text"],
                "note_title": row["note_title"],
                "note_path": row["note_path"],
            }
            for row in evidence_rows
        ],
        "feedback": [
            {"status": row["status"], "note": row["note"], "updated_at": row["updated_at"]}
            for row in feedback
        ],
    }


def save_feedback(conn: sqlite3.Connection, paper_id: int, status: str, note: str = "") -> dict[str, object]:
    if status not in VALID_FEEDBACK:
        raise RuntimeError(f"Invalid feedback status: {status}")
    if not conn.execute("SELECT id FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone():
        raise RuntimeError(f"Paper not found: {paper_id}")
    now = utc_now()
    conn.execute(
        """
        INSERT INTO user_feedback(paper_id, status, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(paper_id, status) DO UPDATE SET
          note = excluded.note,
          updated_at = excluded.updated_at
        """,
        (paper_id, status, note, now, now),
    )
    conn.commit()
    return {"ok": True, "paper_id": paper_id, "status": status}


def update_paper_recommendation(
    conn: sqlite3.Connection,
    settings: Settings,
    paper_id: int,
    payload: dict[str, object],
) -> dict[str, object]:
    sync_project_paper_recommendations(conn, [paper_id])
    action = str(payload.get("action") or "").strip().lower()
    if action == "accept":
        raw_project_ids = payload.get("project_ids", [])
        project_ids = [int(project_id) for project_id in raw_project_ids] if isinstance(raw_project_ids, list) else []
        importance = str(payload.get("importance") or "").strip().lower()
        ensure_report_ready_for_paper(conn, settings, paper_id)
        accept_recommendations_for_paper(conn, paper_id, project_ids, importance)
        sync_result = sync_accepted_paper_to_obsidian(conn, settings, paper_id)
        conn.commit()
        detail = paper_detail(conn, paper_id)
        detail["ok"] = True
        detail["sync"] = sync_result
        return detail
    if action == "discard":
        raw_project_ids = payload.get("project_ids")
        project_ids = [int(project_id) for project_id in raw_project_ids] if isinstance(raw_project_ids, list) else None
        discard_recommendations_for_paper(conn, paper_id, project_ids)
        report_result = sync_paper_report_for_recommendation_state(conn, paper_id)
        conn.commit()
        return {"ok": True, "paper_id": paper_id, "action": "discard", **report_result}
    raise RuntimeError("action must be accept or discard")


def generate_paper_reading_report(
    conn: sqlite3.Connection,
    settings: Settings,
    paper_id: int,
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    payload = payload or {}
    queue_paper_report(
        conn,
        paper_id,
        force=bool(payload.get("force")),
        prompt=settings.paper_reader_default_prompt,
    )
    result = process_paper_report_queue(conn, settings, [paper_id])
    detail = paper_detail(conn, paper_id)
    detail["ok"] = True
    detail["paper_report_result"] = result
    return detail


def job_history(conn: sqlite3.Connection, limit: int = 20) -> dict[str, object]:
    rows = conn.execute(
        """
        SELECT id, job_type, status, started_at, finished_at, message, pid, heartbeat_at, meta_json
        FROM job_runs
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return {
        "items": [
            {
                "id": int(row["id"]),
                "job_type": row["job_type"],
                "status": row["status"],
                "started_at": row["started_at"],
                "finished_at": row["finished_at"],
                "message": row["message"],
                "pid": row["pid"] if "pid" in row.keys() else None,
                "heartbeat_at": row["heartbeat_at"] if "heartbeat_at" in row.keys() else None,
                "meta": from_json(row["meta_json"], {}),
            }
            for row in rows
        ]
    }


def health(conn: sqlite3.Connection, settings: Settings) -> dict[str, object]:
    def count(table: str) -> int:
        return int(conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"])

    latest_job = conn.execute(
        """
        SELECT job_type, status, started_at, finished_at, message
        FROM job_runs
        ORDER BY id DESC
        LIMIT 1
        """
    ).fetchone()
    vault = settings.obsidian_vault_path
    vault_path = str(vault or "")
    vault_exists = bool(vault and Path(vault).exists())
    return {
        "database": {
            "ok": True,
            "path": str(settings.db_path),
        },
        "obsidian": {
            "configured": bool(vault),
            "path": vault_path,
            "exists": vault_exists,
            "status": "ok" if vault_exists else "missing" if vault else "not_configured",
            "cli_command": settings.obsidian_cli_command,
            "paper_repository_dir": settings.obsidian_paper_repository_dir,
            "paper_attachment_dir": settings.obsidian_paper_attachment_dir,
        },
        "llm": {
            "configured": any(provider.api_key for provider in settings.llm_providers),
            "providers": [
                {
                    "id": provider.id,
                    "name": provider.name,
                    "base_url": provider.base_url,
                    "api_key_configured": bool(provider.api_key),
                    "chat_models": provider.chat_models,
                    "embedding_models": provider.embedding_models,
                }
                for provider in settings.llm_providers
            ],
            "chat_provider_id": settings.llm_chat_provider_id,
            "chat_model": settings.llm_chat_model,
            "embedding_provider_id": settings.llm_embedding_provider_id,
            "embedding_model": settings.llm_embedding_model,
        },
        "counts": {
            "notes": count("obsidian_notes"),
            "projects": count("research_projects"),
            "project_artifacts": count("project_artifacts"),
            "project_paper_matches": count("project_paper_matches"),
            "project_paper_judgments": count("project_paper_judgments"),
            "project_paper_recommendations": count("project_paper_recommendations"),
            "paper_reading_reports": count("paper_reading_reports"),
            "chunks": count("research_chunks"),
            "papers": count("arxiv_papers"),
            "paper_embeddings": count("arxiv_paper_embeddings"),
            "paper_texts": int(
                conn.execute(
                    "SELECT COUNT(*) AS count FROM arxiv_papers WHERE text_status = 'complete'"
                ).fetchone()["count"]
            ),
            "paper_chunks": count("arxiv_text_chunks"),
            "paper_chunk_embeddings": count("arxiv_chunk_embeddings"),
            "prefilter_runs": count("paper_prefilter_runs"),
            "matches": count("matches"),
            "feedback": count("user_feedback"),
        },
        "latest_job": None
        if not latest_job
        else {
            "job_type": latest_job["job_type"],
            "status": latest_job["status"],
            "started_at": latest_job["started_at"],
            "finished_at": latest_job["finished_at"],
            "message": latest_job["message"],
        },
    }
