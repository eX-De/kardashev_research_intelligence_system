from __future__ import annotations

from .db_types import DbConnection

from .db import clean_unicode, from_json, utc_now
from .config import Settings
from .artifacts import (
    export_artifact_to_obsidian,
    get_artifact,
    update_artifact,
)
from .experiment_reports import create_experiment_report
from .paper_reports import paper_report_payload
































































def paper_detail(conn: DbConnection, paper_id: int) -> dict[str, object]:
    paper = conn.execute(
        """
        SELECT
          p.*,
          p.abstract AS summary,
          COALESCE(source.source_url, '') AS link,
          COALESCE(source.metadata_json::jsonb -> 'categories', '[]'::jsonb)::text AS categories_json,
          COALESCE(pdf_asset.url, '') AS pdf_link,
          COALESCE(pdf_asset.path, '') AS pdf_path,
          COALESCE(text_asset.path, '') AS text_path,
          COALESCE(text_asset.status, 'pending') AS text_status,
          text_asset.updated_at AS text_extracted_at,
          COALESCE(text_asset.error_message, '') AS text_error,
          COALESCE((text_asset.metadata_json::jsonb ->> 'char_count')::bigint, 0) AS text_char_count
        FROM papers p
        LEFT JOIN LATERAL (
          SELECT ps.source_url, ps.metadata_json
          FROM paper_sources ps
          WHERE ps.paper_id = p.id
          ORDER BY ps.updated_at DESC, ps.id DESC
          LIMIT 1
        ) source ON TRUE
        LEFT JOIN LATERAL (
          SELECT pa.url, pa.path
          FROM paper_assets pa
          WHERE pa.paper_id = p.id AND pa.asset_type = 'pdf'
          ORDER BY pa.updated_at DESC, pa.id DESC
          LIMIT 1
        ) pdf_asset ON TRUE
        LEFT JOIN LATERAL (
          SELECT pa.path, pa.status, pa.error_message, pa.metadata_json, pa.updated_at
          FROM paper_assets pa
          WHERE pa.paper_id = p.id AND pa.asset_type = 'text'
          ORDER BY pa.updated_at DESC, pa.id DESC
          LIMIT 1
        ) text_asset ON TRUE
        WHERE p.id = ?
        """,
        (paper_id,),
    ).fetchone()
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
          COALESCE(n.title, kd.title) AS note_title,
          COALESCE(n.path, kd.source_uri) AS note_path,
          kd.source_type AS context_source_type,
          kd.id AS context_document_id
        FROM matches m
        JOIN research_chunks c ON c.id = m.chunk_id
        LEFT JOIN obsidian_notes n ON n.id = c.note_id
        LEFT JOIN knowledge_documents kd ON kd.id = c.document_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = m.arxiv_chunk_id
        WHERE m.paper_id IN (
          SELECT source_arxiv_paper_id
          FROM project_paper_recommendations
          WHERE paper_id = ? AND source_arxiv_paper_id IS NOT NULL
          UNION
          SELECT ap.id
          FROM paper_sources ps
          JOIN arxiv_papers ap ON ap.arxiv_id = ps.source_identifier
          WHERE ps.paper_id = ?
        )
        ORDER BY m.score DESC
        """,
        (paper_id, paper_id),
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
        WHERE j.paper_id IN (
          SELECT source_arxiv_paper_id
          FROM project_paper_recommendations
          WHERE paper_id = ? AND source_arxiv_paper_id IS NOT NULL
          UNION
          SELECT ap.id
          FROM paper_sources ps
          JOIN arxiv_papers ap ON ap.arxiv_id = ps.source_identifier
          WHERE ps.paper_id = ?
        )
        ORDER BY
          CASE j.relation_type WHEN 'direct' THEN 0 WHEN 'indirect' THEN 1 WHEN 'weak' THEN 2 ELSE 3 END,
          j.usefulness_score DESC,
          j.confidence DESC
        """,
        (paper_id, paper_id),
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
          ON j.project_id = r.project_id AND j.paper_id = r.source_arxiv_paper_id
        WHERE r.paper_id = ?
        ORDER BY
          CASE r.state WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
          CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
          COALESCE(j.usefulness_score, 0) DESC,
          rp.name
        """,
        (paper_id,),
    ).fetchall()
    linked_project_rows = conn.execute(
        """
        SELECT
          pp.project_id,
          rp.name AS project_name,
          rp.obsidian_project_path,
          rp.obsidian_folder,
          pp.relation,
          pp.note,
          pp.updated_at
        FROM project_papers pp
        JOIN research_projects rp ON rp.id = pp.project_id
        WHERE pp.paper_id = ?
          AND NOT (
            pp.relation = 'candidate'
            AND pp.note = 'auto_matched_by_project_context'
          )
        ORDER BY pp.updated_at DESC, rp.name
        """,
        (paper_id,),
    ).fetchall()
    return {
        "paper": {
                "id": int(paper["id"]),
                "library_paper_id": int(paper["id"]),
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
        "linked_projects": [
            {
                "project_id": int(row["project_id"]),
                "project_name": row["project_name"],
                "obsidian_project_path": row["obsidian_project_path"],
                "obsidian_folder": row["obsidian_folder"],
                "relation": row["relation"],
                "note": row["note"],
                "updated_at": row["updated_at"],
            }
            for row in linked_project_rows
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
                "context_source_type": row["context_source_type"],
                "context_document_id": int(row["context_document_id"]) if row["context_document_id"] is not None else None,
            }
            for row in evidence_rows
        ],
        "feedback": [
            {"status": row["status"], "note": row["note"], "updated_at": row["updated_at"]}
            for row in feedback
        ],
    }


















def export_artifact(
    conn: DbConnection,
    settings: Settings,
    artifact_id: int,
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    payload = payload or {}
    result = export_artifact_to_obsidian(
        conn,
        settings,
        artifact_id,
        relative_path=clean_unicode(str(payload.get("relative_path") or "")).strip() or None,
    )
    artifact = get_artifact(conn, artifact_id)
    if artifact:
        content = artifact["content_json"] if isinstance(artifact.get("content_json"), dict) else {}
        content = dict(content)
        content["obsidian_export"] = {**result, "status": result.get("status") or "synced", "exported_at": utc_now()}
        artifact = update_artifact(conn, artifact_id, content_json=content, commit=False)
    conn.commit()
    return {"ok": True, "export": result, "artifact": artifact or get_artifact(conn, artifact_id)}


def receive_experiment_report(
    conn: DbConnection,
    settings: Settings,
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    return create_experiment_report(conn, settings, payload or {})
