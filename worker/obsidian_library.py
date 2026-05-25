import json
import re
import shutil
from .db_types import DbConnection, DbRow
from pathlib import Path
from typing import Any

from .config import Settings
from .artifacts import export_artifact_to_obsidian
from .db import clean_unicode, from_json, utc_now
from .papers import paper_id_for_arxiv_paper_id


PROJECTS_START = "<!-- research-intelligence:projects:start -->"
PROJECTS_END = "<!-- research-intelligence:projects:end -->"
PAPERS_START = "<!-- research-intelligence:papers:start -->"
PAPERS_END = "<!-- research-intelligence:papers:end -->"
READING_REPORT_START = "<!-- research-intelligence:reading-report:start -->"
READING_REPORT_END = "<!-- research-intelligence:reading-report:end -->"

IMPORTANCE_LABELS = {
    "high": "高",
    "medium": "中",
    "low": "低",
}
IMPORTANCE_ORDER = {
    "high": 0,
    "medium": 1,
    "low": 2,
    "": 3,
}


def _vault(settings: Settings) -> Path:
    if not settings.obsidian_vault_path:
        raise RuntimeError("Obsidian vault path is not configured")
    vault = settings.obsidian_vault_path.expanduser().resolve()
    if not vault.exists() or not vault.is_dir():
        raise RuntimeError("Obsidian vault path does not exist")
    return vault


def _clean_rel(value: str) -> str:
    return clean_unicode(str(value or "")).replace("\\", "/").strip().strip("/")


def _safe_filename(value: str, fallback: str = "paper") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", clean_unicode(value)).strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)
    if len(cleaned) > 150:
        cleaned = cleaned[:150].rstrip(" .")
    return cleaned or fallback


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return clean_unicode(path.read_text(encoding="utf-8", errors="ignore"))


def _split_frontmatter(text: str) -> tuple[dict[str, object], str]:
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return {}, text
    lines = text.splitlines()
    end_index = None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            end_index = index
            break
    if end_index is None:
        return {}, text
    frontmatter: dict[str, object] = {}
    key: str | None = None
    for raw in lines[1:end_index]:
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith("- ") and key:
            values = frontmatter.setdefault(key, [])
            if isinstance(values, list):
                values.append(stripped[2:].strip().strip("'\""))
            continue
        if ":" not in stripped:
            continue
        key_text, value = stripped.split(":", 1)
        key = key_text.strip()
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            frontmatter[key] = [
                item.strip().strip("'\"")
                for item in value[1:-1].split(",")
                if item.strip()
            ]
        elif value:
            frontmatter[key] = value.strip("'\"")
        else:
            frontmatter[key] = []
    body = "\n".join(lines[end_index + 1 :]).strip("\n")
    return clean_unicode(frontmatter), clean_unicode(body)


def _as_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [clean_unicode(str(item)).strip() for item in value if clean_unicode(str(item)).strip()]
    if value is None:
        return []
    text = clean_unicode(str(value)).strip()
    return [text] if text else []


def _yaml_scalar(value: object) -> str:
    text = clean_unicode(str(value or "")).strip()
    if not text:
        return ""
    if re.match(r"^[A-Za-z0-9_./-]+$", text):
        return text
    return json.dumps(text, ensure_ascii=False)


def _serialize_frontmatter(frontmatter: dict[str, object]) -> str:
    preferred = [
        "tags",
        "source_as_link",
        "arxiv_id",
        "link",
        "pdf_link",
        "published_at",
        "projects",
    ]
    keys = [key for key in preferred if key in frontmatter]
    keys.extend(key for key in frontmatter if key not in keys)
    lines = ["---"]
    for key in keys:
        value = frontmatter[key]
        if isinstance(value, list):
            if value:
                lines.append(f"{key}:")
                lines.extend(f"  - {_yaml_scalar(item)}" for item in value)
            else:
                lines.append(f"{key}:")
        else:
            lines.append(f"{key}: {_yaml_scalar(value)}")
    lines.append("---")
    return "\n".join(lines)


def _write_markdown(path: Path, frontmatter: dict[str, object], body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = f"{_serialize_frontmatter(frontmatter)}\n{body.strip()}\n"
    path.write_text(clean_unicode(text), encoding="utf-8")


def _replace_block(body: str, start: str, end: str, block: str, heading: str) -> str:
    start_index = body.find(start)
    end_index = body.find(end)
    if start_index >= 0 and end_index > start_index:
        end_index += len(end)
        return (body[:start_index] + block + body[end_index:]).strip()
    suffix = f"# {heading}\n\n{block}"
    return f"{body.rstrip()}\n\n{suffix}".strip() if body.strip() else suffix


def _wiki_link(rel_path: str, alias: str | None = None) -> str:
    rel = _clean_rel(rel_path)
    target = rel[:-3] if rel.lower().endswith(".md") else rel
    if alias:
        return f"[[{target}|{clean_unicode(alias)}]]"
    return f"[[{target}]]"


def _relative_attachment_link(repo_rel: str, attachment_rel: str) -> str:
    repo = Path(repo_rel)
    attachment = Path(attachment_rel)
    try:
        relative = attachment.relative_to(repo)
        return relative.as_posix()
    except ValueError:
        return attachment.as_posix()


def _paper_note_path(vault: Path, settings: Settings, paper: DbRow) -> tuple[Path, str]:
    repo_rel = _clean_rel(settings.obsidian_paper_repository_dir)
    if not repo_rel:
        raise RuntimeError("Obsidian paper repository dir is not configured")
    repo = (vault / repo_rel).resolve()
    try:
        repo.relative_to(vault)
    except ValueError as exc:
        raise RuntimeError("Obsidian paper repository dir must be inside the vault") from exc
    repo.mkdir(parents=True, exist_ok=True)

    arxiv_id = str(paper["arxiv_id"])
    for path in repo.glob("*.md"):
        frontmatter, _ = _split_frontmatter(_read_text(path))
        if str(frontmatter.get("arxiv_id") or "").strip() == arxiv_id:
            return path, path.relative_to(vault).as_posix()

    filename = f"{_safe_filename(str(paper['title']), arxiv_id)}.md"
    path = repo / filename
    if path.exists():
        return path, path.relative_to(vault).as_posix()
    return path, path.relative_to(vault).as_posix()


def _copy_attachment(vault: Path, settings: Settings, paper: DbRow) -> str:
    source_text = str(paper["pdf_path"] or "").strip()
    if not source_text:
        return ""
    source = Path(source_text)
    if not source.exists() or not source.is_file():
        return ""
    attachment_rel = _clean_rel(settings.obsidian_paper_attachment_dir)
    if not attachment_rel:
        return ""
    attachment_dir = (vault / attachment_rel).resolve()
    try:
        attachment_dir.relative_to(vault)
    except ValueError as exc:
        raise RuntimeError("Obsidian paper attachment dir must be inside the vault") from exc
    attachment_dir.mkdir(parents=True, exist_ok=True)
    suffix = source.suffix or ".pdf"
    target = attachment_dir / f"{_safe_filename(str(paper['arxiv_id']))}{suffix}"
    if not target.exists() or target.stat().st_size != source.stat().st_size:
        shutil.copy2(source, target)
    return target.relative_to(vault).as_posix()


def _project_link(row: DbRow) -> str:
    path = _clean_rel(row["obsidian_project_path"])
    if not path:
        folder = _clean_rel(row["obsidian_folder"] or row["obsidian_output_dir"])
        if folder:
            path = f"{folder}/中心页.md"
    if path:
        return _wiki_link(path, row["project_name"])
    return clean_unicode(str(row["project_name"]))


def _project_block(rows: list[DbRow]) -> str:
    lines = [PROJECTS_START]
    for row in rows:
        reason = clean_unicode(str(row["reason"] or "")).strip()
        lines.append(f"- {_project_link(row)}：{row['relation_type']}")
        if reason:
            lines.append(f"  - 推荐理由：{reason}")
    lines.append(PROJECTS_END)
    return "\n".join(lines)


def _reading_report_block(markdown: str) -> str:
    body = clean_unicode(str(markdown or "")).strip()
    return "\n".join([READING_REPORT_START, body, READING_REPORT_END])


def _paper_body(
    paper: DbRow,
    existing_body: str,
    rows: list[DbRow],
    report_markdown: str = "",
) -> str:
    body = existing_body.strip()
    if not body:
        body = "\n\n".join(
            [
                "# 摘要",
                clean_unicode(str(paper["summary"] or "")).strip() or "暂无摘要。",
            ]
        )
    body = _replace_block(body, PROJECTS_START, PROJECTS_END, _project_block(rows), "项目关联")
    if clean_unicode(str(report_markdown or "")).strip():
        body = _replace_block(
            body,
            READING_REPORT_START,
            READING_REPORT_END,
            _reading_report_block(report_markdown),
            "全文报告",
        )
    return body


def _update_frontmatter(
    frontmatter: dict[str, object],
    paper: DbRow,
    rows: list[DbRow],
    attachment_rel: str,
    repo_rel: str,
) -> dict[str, object]:
    updated = dict(frontmatter)
    importance_values = {f"importance/{label}".lower() for label in IMPORTANCE_LABELS.values()}
    tags = [
        tag
        for tag in _as_list(updated.get("tags"))
        if tag.strip().lower().lstrip("#") not in importance_values
    ]
    importance = min(
        (str(row["importance"] or "") for row in rows),
        key=lambda value: IMPORTANCE_ORDER.get(value, 3),
        default="",
    )
    label = IMPORTANCE_LABELS.get(importance)
    if label:
        tags.append(f"Importance/{label}")
    updated["tags"] = tags

    source_links = _as_list(updated.get("source_as_link"))
    if attachment_rel:
        attachment_link = _relative_attachment_link(repo_rel, attachment_rel)
        pdf_link = _wiki_link(attachment_link, "PDF")
        if pdf_link not in source_links:
            source_links.append(pdf_link)
    updated["source_as_link"] = source_links

    updated["arxiv_id"] = paper["arxiv_id"]
    updated["link"] = paper["link"]
    updated["pdf_link"] = paper["pdf_link"]
    updated["published_at"] = paper["published_at"]
    updated["projects"] = [_project_link(row) for row in rows]
    return updated


def _accepted_rows_for_paper(conn: DbConnection, paper_id: int) -> list[DbRow]:
    return conn.execute(
        """
        SELECT
          r.*,
          rp.name AS project_name,
          rp.obsidian_project_path,
          rp.obsidian_folder,
          rp.obsidian_output_dir
        FROM project_paper_recommendations r
        JOIN research_projects rp ON rp.id = r.project_id
        WHERE r.paper_id = ?
          AND r.state = 'accepted'
        ORDER BY
          CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
          rp.name
        """,
        (paper_id,),
    ).fetchall()


def _reading_report_for_paper(conn: DbConnection, paper_id: int) -> str:
    scope_ids: list[int] = []
    library_paper_id = paper_id_for_arxiv_paper_id(conn, paper_id)
    if library_paper_id is not None:
        scope_ids.append(int(library_paper_id))
    scope_ids.append(int(paper_id))
    for scope_id in dict.fromkeys(scope_ids):
        artifact = conn.execute(
            """
            SELECT content_markdown
            FROM artifacts
            WHERE scope_type = 'paper'
              AND scope_id = ?
              AND artifact_type = 'paper_report'
              AND status IN ('ready', 'done')
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            """,
            (scope_id,),
        ).fetchone()
        if artifact and clean_unicode(str(artifact["content_markdown"] or "")).strip():
            return clean_unicode(str(artifact["content_markdown"] or "")).strip()
    return ""


def export_system_artifact_to_obsidian(
    conn: DbConnection,
    settings: Settings,
    artifact_id: int,
    *,
    relative_path: str | None = None,
) -> dict[str, object]:
    return export_artifact_to_obsidian(conn, settings, artifact_id, relative_path=relative_path)


def _accepted_rows_for_project(conn: DbConnection, project_id: int) -> list[DbRow]:
    return conn.execute(
        """
        SELECT
          r.*,
          p.title,
          p.arxiv_id,
          p.published_at,
          p.link
        FROM project_paper_recommendations r
        JOIN arxiv_papers p ON p.id = r.paper_id
        WHERE r.project_id = ?
          AND r.state = 'accepted'
        ORDER BY
          CASE r.importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
          CASE r.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
          p.published_at DESC
        """,
        (project_id,),
    ).fetchall()


def _project_paper_list_path(vault: Path, settings: Settings, project_id: int, conn: DbConnection) -> tuple[Path, str]:
    project = conn.execute(
        """
        SELECT name, obsidian_project_path, obsidian_folder, obsidian_output_dir
        FROM research_projects
        WHERE id = ?
        """,
        (project_id,),
    ).fetchone()
    if not project:
        raise RuntimeError(f"Project not found: {project_id}")
    folder = _clean_rel(project["obsidian_folder"] or project["obsidian_output_dir"])
    if not folder and project["obsidian_project_path"]:
        folder = Path(_clean_rel(project["obsidian_project_path"])).parent.as_posix()
    if not folder:
        raise RuntimeError(f"Project has no Obsidian folder: {project['name']}")
    filename = _safe_filename(settings.obsidian_project_paper_list_name, "论文列表.md")
    if not filename.lower().endswith(".md"):
        filename += ".md"
    target = (vault / folder / filename).resolve()
    try:
        target.relative_to(vault)
    except ValueError as exc:
        raise RuntimeError("Project paper list path must be inside the vault") from exc
    return target, target.relative_to(vault).as_posix()


def _md_cell(value: object) -> str:
    return clean_unicode(str(value or "")).replace("|", "\\|").replace("\n", " ").strip()


def _project_papers_block(rows: list[DbRow]) -> str:
    lines = [
        PAPERS_START,
        "| 重要性 | 关系 | 论文 | 推荐理由 |",
        "| --- | --- | --- | --- |",
    ]
    for row in rows:
        importance = IMPORTANCE_LABELS.get(str(row["importance"] or ""), "")
        paper_link = _wiki_link(row["obsidian_path"], row["title"]) if row["obsidian_path"] else row["title"]
        lines.append(
            f"| {_md_cell(importance)} | {_md_cell(row['relation_type'])} | {_md_cell(paper_link)} | {_md_cell(row['reason'])} |"
        )
    if not rows:
        lines.append("|  |  |  |  |")
    lines.append(PAPERS_END)
    return "\n".join(lines)


def _sync_project_paper_list(
    conn: DbConnection,
    settings: Settings,
    vault: Path,
    project_id: int,
) -> str:
    target, relative_path = _project_paper_list_path(vault, settings, project_id, conn)
    text = _read_text(target)
    frontmatter, body = _split_frontmatter(text)
    if not body.strip():
        body = "# 论文列表"
    rows = _accepted_rows_for_project(conn, project_id)
    body = _replace_block(body, PAPERS_START, PAPERS_END, _project_papers_block(rows), "论文列表")
    _write_markdown(target, frontmatter, body)
    return relative_path


def sync_accepted_paper_to_obsidian(
    conn: DbConnection,
    settings: Settings,
    paper_id: int,
) -> dict[str, object]:
    vault = _vault(settings)
    paper = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone()
    if not paper:
        raise RuntimeError(f"Paper not found: {paper_id}")
    rows = _accepted_rows_for_paper(conn, paper_id)
    if not rows:
        raise RuntimeError("No accepted project recommendation to sync")

    note_path, note_rel = _paper_note_path(vault, settings, paper)
    attachment_rel = _copy_attachment(vault, settings, paper)
    text = _read_text(note_path)
    frontmatter, body = _split_frontmatter(text)
    repo_rel = _clean_rel(settings.obsidian_paper_repository_dir)
    frontmatter = _update_frontmatter(frontmatter, paper, rows, attachment_rel, repo_rel)
    body = _paper_body(paper, body, rows, _reading_report_for_paper(conn, paper_id))
    _write_markdown(note_path, frontmatter, body)

    now = utc_now()
    conn.execute(
        """
        UPDATE project_paper_recommendations
        SET obsidian_path = ?,
            attachment_path = ?,
            synced_at = ?,
            updated_at = ?
        WHERE paper_id = ?
          AND state = 'accepted'
        """,
        (note_rel, attachment_rel, now, now, paper_id),
    )
    project_paths = []
    for project_id in sorted({int(row["project_id"]) for row in rows}):
        project_paths.append(_sync_project_paper_list(conn, settings, vault, project_id))
    return {
        "obsidian_path": note_rel,
        "attachment_path": attachment_rel,
        "project_paper_lists": project_paths,
    }
