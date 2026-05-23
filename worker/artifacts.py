from __future__ import annotations

import hashlib
import re
import sqlite3
from pathlib import Path
from typing import Any

from .config import Settings
from .db import clean_unicode, from_json, to_json, utc_now
from .obsidian import ObsidianNotConfiguredError
from .obsidian_remote import (
    obsidian_remote_enabled,
    obsidian_remote_mirror_path,
    obsidian_remote_output_prefix,
    upload_markdown_append_only,
)


ARTIFACT_STATUS_READY = "ready"
PAPER_REPORT_ARTIFACT_TYPE = "paper_report"
LEGACY_ARTIFACT_TABLES = ("paper_reading_reports", "project_artifacts")


def _safe_filename(value: str, fallback: str = "artifact") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", clean_unicode(value)).strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if len(cleaned) > 150:
        cleaned = cleaned[:150].rstrip(" .")
    return cleaned or fallback


def _scope_clause(scope_type: str, scope_id: int | None) -> tuple[str, tuple[object, ...]]:
    if scope_id is None:
        return "scope_type = ? AND scope_id IS NULL", (scope_type,)
    return "scope_type = ? AND scope_id = ?", (scope_type, scope_id)


def _artifact_payload(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": int(row["id"]),
        "scope_type": row["scope_type"],
        "scope_id": int(row["scope_id"]) if row["scope_id"] is not None else None,
        "artifact_type": row["artifact_type"],
        "title": row["title"],
        "content_markdown": row["content_markdown"],
        "content_json": from_json(row["content_json"], {}),
        "status": row["status"],
        "source": from_json(row["source_json"], {}),
        "model_provider_id": row["model_provider_id"],
        "model": row["model"],
        "input_hash": row["input_hash"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def get_artifact(conn: sqlite3.Connection, artifact_id: int) -> dict[str, object] | None:
    row = conn.execute("SELECT * FROM artifacts WHERE id = ?", (int(artifact_id),)).fetchone()
    return _artifact_payload(row) if row else None


def create_artifact(
    conn: sqlite3.Connection,
    *,
    scope_type: str,
    artifact_type: str,
    title: str,
    scope_id: int | None = None,
    content_markdown: str = "",
    content_json: dict[str, object] | list[object] | None = None,
    status: str = ARTIFACT_STATUS_READY,
    source_json: dict[str, object] | list[object] | None = None,
    model_provider_id: str = "",
    model: str = "",
    input_hash: str = "",
    commit: bool = True,
) -> dict[str, object]:
    now = utc_now()
    cur = conn.execute(
        """
        INSERT INTO artifacts(
          scope_type, scope_id, artifact_type, title, content_markdown,
          content_json, status, source_json, model_provider_id, model,
          input_hash, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            clean_unicode(scope_type),
            int(scope_id) if scope_id is not None else None,
            clean_unicode(artifact_type),
            clean_unicode(title),
            clean_unicode(content_markdown),
            to_json(content_json or {}),
            clean_unicode(status),
            to_json(source_json or {}),
            clean_unicode(model_provider_id),
            clean_unicode(model),
            clean_unicode(input_hash),
            now,
            now,
        ),
    )
    if commit:
        conn.commit()
    return get_artifact(conn, int(cur.lastrowid)) or {}


def update_artifact(
    conn: sqlite3.Connection,
    artifact_id: int,
    *,
    title: str | None = None,
    content_markdown: str | None = None,
    content_json: dict[str, object] | list[object] | None = None,
    status: str | None = None,
    source_json: dict[str, object] | list[object] | None = None,
    model_provider_id: str | None = None,
    model: str | None = None,
    input_hash: str | None = None,
    commit: bool = True,
) -> dict[str, object]:
    current = get_artifact(conn, artifact_id)
    if not current:
        raise RuntimeError(f"Artifact not found: {artifact_id}")
    conn.execute(
        """
        UPDATE artifacts
        SET title = ?,
            content_markdown = ?,
            content_json = ?,
            status = ?,
            source_json = ?,
            model_provider_id = ?,
            model = ?,
            input_hash = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            clean_unicode(title if title is not None else current["title"]),
            clean_unicode(content_markdown if content_markdown is not None else current["content_markdown"]),
            to_json(content_json if content_json is not None else current["content_json"]),
            clean_unicode(status if status is not None else current["status"]),
            to_json(source_json if source_json is not None else current["source"]),
            clean_unicode(model_provider_id if model_provider_id is not None else current["model_provider_id"]),
            clean_unicode(model if model is not None else current["model"]),
            clean_unicode(input_hash if input_hash is not None else current["input_hash"]),
            utc_now(),
            int(artifact_id),
        ),
    )
    if commit:
        conn.commit()
    return get_artifact(conn, artifact_id) or {}


def upsert_artifact(
    conn: sqlite3.Connection,
    *,
    scope_type: str,
    artifact_type: str,
    title: str,
    scope_id: int | None = None,
    source_key: str = "",
    content_markdown: str = "",
    content_json: dict[str, object] | list[object] | None = None,
    status: str = ARTIFACT_STATUS_READY,
    source_json: dict[str, object] | list[object] | None = None,
    model_provider_id: str = "",
    model: str = "",
    input_hash: str = "",
    commit: bool = True,
) -> dict[str, object]:
    source_payload: dict[str, object]
    if isinstance(source_json, dict):
        source_payload = dict(source_json)
    else:
        source_payload = {"value": source_json} if source_json is not None else {}
    if source_key:
        source_payload["source_key"] = source_key

    existing_id: int | None = None
    if source_key:
        clause, params = _scope_clause(scope_type, scope_id)
        rows = conn.execute(
            f"""
            SELECT id, source_json
            FROM artifacts
            WHERE {clause}
              AND artifact_type = ?
            ORDER BY updated_at DESC
            """,
            (*params, artifact_type),
        ).fetchall()
        for row in rows:
            source = from_json(row["source_json"], {})
            if isinstance(source, dict) and source.get("source_key") == source_key:
                existing_id = int(row["id"])
                break

    if existing_id is not None:
        return update_artifact(
            conn,
            existing_id,
            title=title,
            content_markdown=content_markdown,
            content_json=content_json if content_json is not None else {},
            status=status,
            source_json=source_payload,
            model_provider_id=model_provider_id,
            model=model,
            input_hash=input_hash,
            commit=commit,
        )
    return create_artifact(
        conn,
        scope_type=scope_type,
        scope_id=scope_id,
        artifact_type=artifact_type,
        title=title,
        content_markdown=content_markdown,
        content_json=content_json if content_json is not None else {},
        status=status,
        source_json=source_payload,
        model_provider_id=model_provider_id,
        model=model,
        input_hash=input_hash,
        commit=commit,
    )


def list_artifacts(
    conn: sqlite3.Connection,
    *,
    scope_type: str | None = None,
    scope_id: int | None = None,
    artifact_type: str | None = None,
    status: str | None = None,
    limit: int = 50,
) -> dict[str, object]:
    conditions: list[str] = []
    params: list[object] = []
    if scope_type:
        conditions.append("scope_type = ?")
        params.append(scope_type)
    if scope_id is not None:
        conditions.append("scope_id = ?")
        params.append(int(scope_id))
    if artifact_type:
        conditions.append("artifact_type = ?")
        params.append(artifact_type)
    if status:
        conditions.append("status = ?")
        params.append(status)
    where = "WHERE " + " AND ".join(conditions) if conditions else ""
    rows = conn.execute(
        f"""
        SELECT *
        FROM artifacts
        {where}
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
        """,
        (*params, max(1, int(limit))),
    ).fetchall()
    return {"items": [_artifact_payload(row) for row in rows]}


def content_hash(markdown: str, content_json: object | None = None) -> str:
    payload = to_json({"markdown": clean_unicode(markdown), "json": content_json or {}})
    return hashlib.sha256(payload.encode("utf-8", "replace")).hexdigest()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    if getattr(conn, "dialect", "") == "postgres":
        row = conn.execute(
            """
            SELECT table_name AS name
            FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name = ?
            """,
            (table,),
        ).fetchone()
        return bool(row)
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return bool(row)


def _count_table(conn: sqlite3.Connection, table: str) -> int:
    if not _table_exists(conn, table):
        return 0
    return int(conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"])


def _row_value(row: sqlite3.Row, key: str, default: object = "") -> object:
    return row[key] if key in row.keys() and row[key] is not None else default


def _legacy_library_paper_id(conn: sqlite3.Connection, legacy_arxiv_paper_id: int) -> int | None:
    from .papers import paper_id_for_arxiv_paper_id

    paper_id = paper_id_for_arxiv_paper_id(conn, int(legacy_arxiv_paper_id))
    return int(paper_id) if paper_id is not None else None


def _migrate_legacy_paper_reading_reports(conn: sqlite3.Connection) -> int:
    rows = conn.execute("SELECT * FROM paper_reading_reports ORDER BY paper_id").fetchall()
    for row in rows:
        legacy_paper_id = int(row["paper_id"])
        library_paper_id = _legacy_library_paper_id(conn, legacy_paper_id)
        paper = conn.execute(
            "SELECT title, arxiv_id, link FROM arxiv_papers WHERE id = ?",
            (legacy_paper_id,),
        ).fetchone()
        title = (
            clean_unicode(str(paper["title"] or "")).strip()
            if paper
            else f"Legacy paper {legacy_paper_id}"
        )
        source_project_ids = from_json(str(_row_value(row, "source_project_ids_json", "[]")), [])
        markdown = clean_unicode(str(_row_value(row, "report_markdown", "")))
        content = {
            "paper_id": library_paper_id,
            "legacy_arxiv_paper_id": legacy_paper_id,
            "arxiv_id": paper["arxiv_id"] if paper else "",
            "link": paper["link"] if paper else "",
            "prompt": _row_value(row, "prompt", ""),
            "system_prompt": _row_value(row, "system_prompt", ""),
            "source_project_ids": source_project_ids,
            "error_message": _row_value(row, "error_message", ""),
            "started_at": _row_value(row, "started_at", None),
            "finished_at": _row_value(row, "finished_at", None),
        }
        source = {
            "legacy_table": "paper_reading_reports",
            "legacy_arxiv_paper_id": legacy_paper_id,
            "source_key": f"paper_report:{legacy_paper_id}",
            "source_text_hash": _row_value(row, "source_text_hash", ""),
            "legacy_created_at": _row_value(row, "created_at", ""),
            "legacy_updated_at": _row_value(row, "updated_at", ""),
        }
        upsert_artifact(
            conn,
            scope_type="paper",
            scope_id=library_paper_id if library_paper_id is not None else legacy_paper_id,
            artifact_type=PAPER_REPORT_ARTIFACT_TYPE,
            title=title,
            content_markdown=markdown,
            content_json=content,
            status=clean_unicode(str(_row_value(row, "status", "queued") or "queued")),
            source_json=source,
            source_key=f"paper_report:{legacy_paper_id}",
            model_provider_id=clean_unicode(str(_row_value(row, "model_provider_id", ""))),
            model=clean_unicode(str(_row_value(row, "model", ""))),
            input_hash=clean_unicode(str(_row_value(row, "source_text_hash", "")))
            or content_hash(markdown, content),
            commit=False,
        )
    return int(
        conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM artifacts
            WHERE scope_type = 'paper'
              AND artifact_type = ?
            """,
            (PAPER_REPORT_ARTIFACT_TYPE,),
        ).fetchone()["count"]
    )


def _migrate_legacy_project_artifacts(conn: sqlite3.Connection) -> int:
    rows = conn.execute("SELECT * FROM project_artifacts ORDER BY id").fetchall()
    for row in rows:
        source = from_json(str(_row_value(row, "source_json", "{}")), {})
        if not isinstance(source, dict):
            source = {"legacy_source_json": _row_value(row, "source_json", "{}")}
        legacy_id = int(row["id"])
        source.update(
            {
                "legacy_table": "project_artifacts",
                "legacy_project_artifact_id": legacy_id,
                "obsidian_path": _row_value(row, "obsidian_path", ""),
            }
        )
        upsert_artifact(
            conn,
            scope_type="project",
            scope_id=int(row["project_id"]),
            artifact_type=clean_unicode(str(_row_value(row, "artifact_type", "project_artifact"))),
            title=clean_unicode(str(_row_value(row, "title", "Project Artifact"))),
            content_markdown="",
            content_json={},
            status=clean_unicode(str(_row_value(row, "status", "planned") or "planned")),
            source_json=source,
            source_key=f"project_artifact:{legacy_id}",
            input_hash=f"legacy:project_artifacts:{legacy_id}",
            commit=False,
        )
    return int(
        conn.execute(
            "SELECT COUNT(*) AS count FROM artifacts WHERE scope_type = 'project'"
        ).fetchone()["count"]
    )


def migrate_legacy_artifact_tables(
    conn: sqlite3.Connection,
    *,
    drop_legacy: bool = False,
) -> dict[str, int]:
    """Move legacy report/artifact rows into artifacts, optionally dropping old tables."""
    stats = {
        "paper_reading_reports_seen": _count_table(conn, "paper_reading_reports"),
        "artifacts_from_paper_reading_reports": 0,
        "project_artifacts_seen": _count_table(conn, "project_artifacts"),
        "artifacts_from_project_artifacts": 0,
        "legacy_artifact_tables_dropped": 0,
    }
    if stats["paper_reading_reports_seen"]:
        stats["artifacts_from_paper_reading_reports"] = _migrate_legacy_paper_reading_reports(conn)
    if stats["project_artifacts_seen"]:
        stats["artifacts_from_project_artifacts"] = _migrate_legacy_project_artifacts(conn)
    if drop_legacy:
        for table in LEGACY_ARTIFACT_TABLES:
            if _table_exists(conn, table):
                conn.execute(f"DROP TABLE IF EXISTS {table}")
                stats["legacy_artifact_tables_dropped"] += 1
    return stats


def generate_project_index_artifact(conn: sqlite3.Connection, project_id: int) -> dict[str, object]:
    project = conn.execute(
        """
        SELECT id, name, status, summary, goals, keywords_json, updated_at
        FROM research_projects
        WHERE id = ?
        """,
        (int(project_id),),
    ).fetchone()
    if not project:
        raise RuntimeError(f"Project not found: {project_id}")
    papers = conn.execute(
        """
        SELECT pp.relation, pp.note, p.arxiv_id, p.title, p.link, p.published_at
        FROM project_papers pp
        JOIN arxiv_papers p ON p.id = pp.paper_id
        WHERE pp.project_id = ?
        ORDER BY pp.updated_at DESC
        """,
        (int(project_id),),
    ).fetchall()
    documents = conn.execute(
        """
        SELECT pcd.relation, pcd.weight, kd.source_type, kd.source_uri, kd.title
        FROM project_context_documents pcd
        JOIN knowledge_documents kd ON kd.id = pcd.document_id
        WHERE pcd.project_id = ?
        ORDER BY pcd.weight DESC, kd.updated_at DESC
        """,
        (int(project_id),),
    ).fetchall()
    keywords = from_json(project["keywords_json"], [])
    lines = [
        f"# {clean_unicode(project['name'])}",
        "",
        f"- Status: {clean_unicode(project['status'])}",
    ]
    if keywords:
        lines.append(f"- Keywords: {', '.join(clean_unicode(str(item)) for item in keywords)}")
    summary = clean_unicode(project["summary"]).strip()
    goals = clean_unicode(project["goals"]).strip()
    if summary:
        lines.extend(["", "## Summary", "", summary])
    if goals:
        lines.extend(["", "## Goals", "", goals])
    lines.extend(["", "## Papers", "", "| Relation | arXiv | Title |", "| --- | --- | --- |"])
    if papers:
        for paper in papers:
            link = clean_unicode(paper["link"] or paper["arxiv_id"])
            arxiv = clean_unicode(paper["arxiv_id"])
            title = clean_unicode(paper["title"]).replace("|", "\\|")
            lines.append(f"| {clean_unicode(paper['relation'])} | [{arxiv}]({link}) | {title} |")
    else:
        lines.append("|  |  |  |")
    lines.extend(["", "## Context Sources", "", "| Relation | Source | Title |", "| --- | --- | --- |"])
    if documents:
        for document in documents:
            source = clean_unicode(document["source_type"])
            uri = clean_unicode(document["source_uri"])
            source_text = f"{source}:{uri}" if uri else source
            source_cell = source_text.replace("|", "\\|")
            title_cell = clean_unicode(document["title"]).replace("|", "\\|")
            lines.append(f"| {clean_unicode(document['relation'])} | {source_cell} | {title_cell} |")
    else:
        lines.append("|  |  |  |")
    markdown = "\n".join(lines).rstrip() + "\n"
    content = {
        "project_id": int(project_id),
        "paper_count": len(papers),
        "context_document_count": len(documents),
    }
    return upsert_artifact(
        conn,
        scope_type="project",
        scope_id=int(project_id),
        artifact_type="project_index",
        title=f"{clean_unicode(project['name'])} Project Index",
        content_markdown=markdown,
        content_json=content,
        source_json={"project_updated_at": project["updated_at"]},
        source_key=f"project_index:{int(project_id)}",
        input_hash=content_hash(markdown, content),
    )


def _vault(settings: Settings) -> Path:
    if not settings.obsidian_vault_path:
        raise ObsidianNotConfiguredError()
    vault = settings.obsidian_vault_path.expanduser().resolve()
    if not vault.exists() or not vault.is_dir():
        raise RuntimeError("Obsidian vault path does not exist")
    return vault


def _default_obsidian_relative_path(
    conn: sqlite3.Connection,
    artifact: dict[str, object],
) -> str:
    artifact_type = str(artifact["artifact_type"])
    title = _safe_filename(str(artifact["title"]))
    if artifact_type == "daily_report":
        source = artifact.get("source") if isinstance(artifact.get("source"), dict) else {}
        report_date = _safe_filename(str(source.get("date") or title), "daily-report")
        return f"Research Intelligence/Daily/{report_date}.md"
    if artifact_type == "project_index" and artifact.get("scope_type") == "project" and artifact.get("scope_id"):
        project = conn.execute(
            """
            SELECT name, obsidian_project_path, obsidian_folder, obsidian_output_dir
            FROM research_projects
            WHERE id = ?
            """,
            (int(artifact["scope_id"]),),
        ).fetchone()
        if project:
            folder = clean_unicode(project["obsidian_folder"] or project["obsidian_output_dir"]).replace("\\", "/").strip("/")
            if not folder and project["obsidian_project_path"]:
                folder = Path(clean_unicode(project["obsidian_project_path"]).replace("\\", "/")).parent.as_posix()
            if folder:
                return f"{folder}/中心页.md"
            return f"Research Intelligence/Projects/{_safe_filename(str(project['name']), 'project')}.md"
    if artifact_type == "experiment_report" and artifact.get("scope_type") == "project" and artifact.get("scope_id"):
        project = conn.execute(
            """
            SELECT name, obsidian_project_path, obsidian_folder, obsidian_output_dir
            FROM research_projects
            WHERE id = ?
            """,
            (int(artifact["scope_id"]),),
        ).fetchone()
        source = artifact.get("source") if isinstance(artifact.get("source"), dict) else {}
        identity = _safe_filename(str(source.get("idempotency_key") or artifact.get("id") or ""), "report")[:48]
        filename = f"{title}-{identity}" if identity else title
        if project:
            folder = clean_unicode(project["obsidian_folder"] or project["obsidian_output_dir"]).replace("\\", "/").strip("/")
            if not folder and project["obsidian_project_path"]:
                folder = Path(clean_unicode(project["obsidian_project_path"]).replace("\\", "/")).parent.as_posix()
            if folder:
                return f"{folder}/实验进展/{filename}.md"
            project_name = _safe_filename(str(project["name"]), "project")
            return f"Research Intelligence/Experiments/{project_name}/{filename}.md"
        return f"Research Intelligence/Experiments/{filename}.md"
    if artifact_type == "paper_report":
        return f"Research Intelligence/Paper Reports/{title}.md"
    return f"Research Intelligence/Artifacts/{artifact_type}/{title}.md"


def _remote_obsidian_relative_path(
    conn: sqlite3.Connection,
    settings: Settings,
    artifact: dict[str, object],
) -> str:
    artifact_type = str(artifact["artifact_type"])
    title = _safe_filename(str(artifact["title"]))
    digest = content_hash(str(artifact.get("content_markdown") or ""), artifact.get("content_json"))[:10]
    suffix = f"{int(artifact['id'])}-{digest}"
    prefix = obsidian_remote_output_prefix(settings)
    if artifact_type == "daily_report":
        source = artifact.get("source") if isinstance(artifact.get("source"), dict) else {}
        report_date = _safe_filename(str(source.get("date") or title), "daily-report")
        return f"{prefix}/Daily/{report_date}-{suffix}.md"
    if artifact_type == "project_index" and artifact.get("scope_type") == "project" and artifact.get("scope_id"):
        project = conn.execute(
            "SELECT name FROM research_projects WHERE id = ?",
            (int(artifact["scope_id"]),),
        ).fetchone()
        name = _safe_filename(str(project["name"] if project else title), "project")
        return f"{prefix}/Projects/{name}-{suffix}.md"
    if artifact_type == "experiment_report" and artifact.get("scope_type") == "project" and artifact.get("scope_id"):
        project = conn.execute(
            "SELECT name FROM research_projects WHERE id = ?",
            (int(artifact["scope_id"]),),
        ).fetchone()
        name = _safe_filename(str(project["name"] if project else "project"), "project")
        return f"{prefix}/Experiments/{name}/{title}-{suffix}.md"
    if artifact_type == "paper_report":
        return f"{prefix}/Paper Reports/{title}-{suffix}.md"
    return f"{prefix}/Artifacts/{artifact_type}/{title}-{suffix}.md"


def _artifact_markdown(artifact: dict[str, object]) -> str:
    frontmatter = "\n".join(
        [
            "---",
            f"title: {clean_unicode(artifact['title'])}",
            f"artifact_id: {artifact['id']}",
            f"artifact_type: {clean_unicode(artifact['artifact_type'])}",
            f"scope_type: {clean_unicode(artifact['scope_type'])}",
            f"exported_at: {utc_now()}",
            "source: research_intelligence_system",
            "---",
            "",
        ]
    )
    return frontmatter + clean_unicode(str(artifact["content_markdown"] or "")).rstrip() + "\n"


def export_artifact_to_obsidian(
    conn: sqlite3.Connection,
    settings: Settings,
    artifact_id: int,
    *,
    relative_path: str | None = None,
) -> dict[str, object]:
    artifact = get_artifact(conn, int(artifact_id))
    if not artifact:
        raise RuntimeError(f"Artifact not found: {artifact_id}")

    markdown = _artifact_markdown(artifact)
    if obsidian_remote_enabled(settings):
        mirror = obsidian_remote_mirror_path(settings).resolve()
        mirror.mkdir(parents=True, exist_ok=True)
        rel = _remote_obsidian_relative_path(conn, settings, artifact)
        target = (mirror / rel).resolve()
        try:
            local_relative = target.relative_to(mirror).as_posix()
        except ValueError as exc:
            raise RuntimeError("Remote artifact export path must be inside the local mirror") from exc
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(markdown, encoding="utf-8")
        remote = upload_markdown_append_only(settings, target, local_relative)
        if str(remote.get("path") or "") != local_relative:
            mirrored_target = (mirror / str(remote["path"])).resolve()
            try:
                mirrored_target.relative_to(mirror)
            except ValueError as exc:
                raise RuntimeError("Remote artifact export path must be inside the local mirror") from exc
            mirrored_target.parent.mkdir(parents=True, exist_ok=True)
            mirrored_target.write_text(markdown, encoding="utf-8")
        return {
            "artifact_id": int(artifact["id"]),
            "target": "obsidian_remote",
            "path": remote["path"],
            "key": remote["key"],
            "status": "synced",
            "append_only": True,
        }

    vault = _vault(settings)
    rel = clean_unicode(relative_path or _default_obsidian_relative_path(conn, artifact)).replace("\\", "/").strip("/")
    if not rel:
        raise RuntimeError("Obsidian artifact export path is empty")
    if not rel.lower().endswith(".md"):
        rel += ".md"
    target = (vault / rel).resolve()
    try:
        relative = target.relative_to(vault).as_posix()
    except ValueError as exc:
        raise RuntimeError("Artifact export path must be inside the configured vault") from exc

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(markdown, encoding="utf-8")

    return {"artifact_id": int(artifact["id"]), "target": "obsidian", "path": relative, "status": "synced"}
