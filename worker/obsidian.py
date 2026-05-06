from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .db import clean_unicode, to_json, utc_now
from .embeddings import embed_text

TAG_PATTERN = re.compile(r"(?<![\w/])#([^\s#]+)")
HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
PROJECT_STATUS_TAGS = {
    "active": "Status/进行中",
    "completed": "Status/已完成",
    "paused": "Status/搁置",
    "planned": "Status/计划中",
}
STATUS_TAG_TO_PROJECT_STATUS = {
    value.lower(): key for key, value in PROJECT_STATUS_TAGS.items()
}
SKIPPED_DIR_NAMES = {".trash"}


@dataclass
class ParsedNote:
    path: str
    title: str
    frontmatter: dict[str, object]
    tags: list[str]
    body: str
    sha256: str
    mtime: float


def _normalize_rel(path: Path) -> str:
    return clean_unicode(path.as_posix().lstrip("./"))


def _normalize_include_dir(path: str) -> str:
    return clean_unicode(path.strip().replace("\\", "/").strip("/"))


def normalize_tag(value: object) -> str:
    return clean_unicode(str(value or "")).strip().lstrip("#").strip(".,;:!?，。；：").lower()


def _is_skipped_rel_path(rel: str) -> bool:
    return any(part.lower() in SKIPPED_DIR_NAMES for part in rel.split("/"))


def _iter_markdown_files(vault: Path):
    def ignore_walk_error(_: OSError) -> None:
        return None

    for root, dirs, files in os.walk(vault, topdown=True, onerror=ignore_walk_error):
        dirs[:] = [dirname for dirname in dirs if dirname.lower() not in SKIPPED_DIR_NAMES]
        root_path = Path(root)
        for filename in files:
            if not filename.lower().endswith(".md"):
                continue
            path = root_path / filename
            try:
                rel = _normalize_rel(path.relative_to(vault))
            except (OSError, ValueError):
                continue
            if _is_skipped_rel_path(rel):
                continue
            yield path


def _parse_frontmatter(text: str) -> tuple[dict[str, object], str]:
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
    key = None
    for raw in lines[1:end_index]:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("- ") and key:
            current = frontmatter.setdefault(key, [])
            if isinstance(current, list):
                current.append(line[2:].strip().strip("'\""))
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            frontmatter[key] = [
                part.strip().strip("'\"")
                for part in value[1:-1].split(",")
                if part.strip()
            ]
        elif value:
            frontmatter[key] = value.strip("'\"")
        else:
            frontmatter[key] = []
    body = "\n".join(lines[end_index + 1 :])
    return frontmatter, body


def _frontmatter_tags(frontmatter: dict[str, object]) -> set[str]:
    raw = frontmatter.get("tags", [])
    if isinstance(raw, str):
        values = [raw]
    elif isinstance(raw, list):
        values = [str(item) for item in raw]
    else:
        values = []
    return {normalize_tag(value) for value in values if normalize_tag(value)}


def _frontmatter_tag_values(frontmatter: dict[str, object]) -> list[str]:
    raw = frontmatter.get("tags", [])
    if isinstance(raw, str):
        values = [raw]
    elif isinstance(raw, list):
        values = [str(item) for item in raw]
    else:
        values = []
    return [value.lstrip("#").strip() for value in values if str(value).strip()]


def _body_title(path: Path, body: str, frontmatter: dict[str, object]) -> str:
    title = frontmatter.get("title")
    if isinstance(title, str) and title.strip():
        return clean_unicode(title.strip())
    match = HEADING_PATTERN.search(body)
    if match:
        return clean_unicode(match.group(2).strip())
    return clean_unicode(path.stem)


def parse_note(vault: Path, path: Path) -> ParsedNote:
    text = clean_unicode(path.read_text(encoding="utf-8", errors="ignore"))
    frontmatter, body = _parse_frontmatter(text)
    frontmatter = clean_unicode(frontmatter)
    body = clean_unicode(body)
    body_tags = {normalize_tag(match.group(1)) for match in TAG_PATTERN.finditer(body)}
    tags = sorted(body_tags | _frontmatter_tags(frontmatter))
    stat = path.stat()
    return ParsedNote(
        path=_normalize_rel(path.relative_to(vault)),
        title=_body_title(path, body, frontmatter),
        frontmatter=frontmatter,
        tags=tags,
        body=body,
        sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        mtime=stat.st_mtime,
    )


def _is_included(path: Path, vault: Path, settings: Settings) -> bool:
    rel = _normalize_rel(path.relative_to(vault))
    if settings.obsidian_include_dirs:
        allowed = False
        for include_dir in settings.obsidian_include_dirs:
            prefix = _normalize_include_dir(include_dir)
            if rel == prefix or rel.startswith(prefix + "/"):
                allowed = True
                break
        if not allowed:
            return False
    parsed = parse_note(vault, path)
    if settings.obsidian_include_tags:
        return bool(set(parsed.tags) & set(settings.obsidian_include_tags))
    return True


def discover_notes(settings: Settings) -> list[ParsedNote]:
    vault = settings.obsidian_vault_path
    if not vault:
        raise RuntimeError("OBSIDIAN_VAULT_PATH is not configured")
    if not vault.exists():
        raise RuntimeError(f"OBSIDIAN_VAULT_PATH does not exist: {vault}")

    parsed_notes: list[ParsedNote] = []
    for path in _iter_markdown_files(vault):
        rel = _normalize_rel(path.relative_to(vault))
        if settings.obsidian_include_dirs:
            allowed = any(
                rel == _normalize_include_dir(include) or rel.startswith(_normalize_include_dir(include) + "/")
                for include in settings.obsidian_include_dirs
            )
            if not allowed:
                continue
        try:
            note = parse_note(vault, path)
        except OSError:
            continue
        parsed_notes.append(note)

    project_folders: set[str] = set()
    for note in parsed_notes:
        if _project_center_match(note, settings):
            parent = Path(note.path).parent
            project_folders.add("" if str(parent) == "." else parent.as_posix())

    notes: list[ParsedNote] = []
    for note in parsed_notes:
        in_project_folder = any(
            not folder or note.path.startswith(folder + "/")
            for folder in project_folders
        )
        if (
            settings.obsidian_include_tags
            and not (set(note.tags) & set(settings.obsidian_include_tags))
            and not _project_center_match(note, settings)
            and not in_project_folder
        ):
            continue
        notes.append(note)
    return notes


def project_status_from_note(note: ParsedNote) -> tuple[str, str]:
    for tag in _frontmatter_tags(note.frontmatter):
        if tag in STATUS_TAG_TO_PROJECT_STATUS:
            return STATUS_TAG_TO_PROJECT_STATUS[tag], PROJECT_STATUS_TAGS[STATUS_TAG_TO_PROJECT_STATUS[tag]]
    for tag in note.tags:
        if tag in STATUS_TAG_TO_PROJECT_STATUS:
            return STATUS_TAG_TO_PROJECT_STATUS[tag], PROJECT_STATUS_TAGS[STATUS_TAG_TO_PROJECT_STATUS[tag]]
    return "planned", PROJECT_STATUS_TAGS["planned"]


def status_tag_for_project_status(status: str) -> str:
    return PROJECT_STATUS_TAGS.get(status, PROJECT_STATUS_TAGS["planned"])


def update_markdown_status_tag(vault: Path, rel_path: str, status: str) -> None:
    target = (vault / rel_path).resolve()
    vault_root = vault.resolve()
    try:
        target.relative_to(vault_root)
    except ValueError as exc:
        raise RuntimeError("Project center page must be inside the configured vault") from exc
    text = clean_unicode(target.read_text(encoding="utf-8", errors="ignore"))
    status_tag = status_tag_for_project_status(status)
    status_tags = {tag.lower() for tag in PROJECT_STATUS_TAGS.values()}

    if text.startswith("---\n") or text.startswith("---\r\n"):
        lines = text.splitlines()
        end_index = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    else:
        lines = text.splitlines()
        end_index = None

    if end_index is None:
        body = text
        front_lines: list[str] = []
        tail_lines: list[str] = body.splitlines()
    else:
        front_lines = lines[1:end_index]
        tail_lines = lines[end_index + 1 :]

    kept_front: list[str] = []
    existing_tags: list[str] = []
    index = 0
    while index < len(front_lines):
        line = front_lines[index]
        if line.strip().startswith("tags:"):
            _, value = line.split(":", 1)
            value = value.strip()
            if value.startswith("[") and value.endswith("]"):
                existing_tags.extend(part.strip().strip("'\"") for part in value[1:-1].split(",") if part.strip())
            elif value:
                existing_tags.append(value.strip("'\""))
            index += 1
            while index < len(front_lines) and front_lines[index].lstrip().startswith("- "):
                existing_tags.append(front_lines[index].split("- ", 1)[1].strip().strip("'\""))
                index += 1
            continue
        kept_front.append(line)
        index += 1

    next_tags = [
        tag.lstrip("#").strip()
        for tag in existing_tags
        if normalize_tag(tag) not in status_tags
    ]
    if status_tag not in next_tags:
        next_tags.append(status_tag)

    new_lines = ["---", *kept_front, "tags:"]
    new_lines.extend(f"  - {tag}" for tag in next_tags)
    new_lines.append("---")
    new_lines.extend(tail_lines)
    target.write_text(clean_unicode("\n".join(new_lines).rstrip() + "\n"), encoding="utf-8")


def chunk_note(note: ParsedNote, max_chars: int = 1400) -> list[dict[str, object]]:
    parts: list[dict[str, object]] = []
    body = note.body.strip()
    heading = note.title

    front_summary = []
    for key in ("summary", "abstract", "aliases"):
        value = note.frontmatter.get(key)
        if value:
            front_summary.append(f"{key}: {value}")
    if front_summary:
        text = f"{note.title}\n" + "\n".join(front_summary)
        parts.append({"heading": note.title, "text": text[:max_chars]})

    current: list[str] = []
    for line in body.splitlines():
        match = HEADING_PATTERN.match(line)
        if match and current:
            parts.extend(_split_block(heading, "\n".join(current), max_chars))
            current = []
            heading = match.group(2).strip()
        current.append(line)
    if current:
        parts.extend(_split_block(heading, "\n".join(current), max_chars))

    clean_parts = []
    seen = set()
    for part in parts:
        text = re.sub(r"\s+", " ", str(part["text"])).strip()
        if len(text) < 40 or text in seen:
            continue
        seen.add(text)
        clean_parts.append(
            {
                "heading": str(part["heading"])[:240],
                "text": text,
                "token_count": max(1, len(text.split())),
            }
        )
    return clean_parts


def _split_block(heading: str, text: str, max_chars: int) -> list[dict[str, str]]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[dict[str, str]] = []
    current = ""
    for paragraph in paragraphs:
        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            chunks.append({"heading": heading, "text": current})
        current = paragraph[:max_chars]
    if current:
        chunks.append({"heading": heading, "text": current})
    return chunks


def _project_center_match(note: ParsedNote, settings: Settings) -> bool:
    required = {normalize_tag(tag) for tag in settings.obsidian_project_center_tags if normalize_tag(tag)}
    return bool(required) and required.issubset(set(note.tags))


def _project_name_from_center_note(note: ParsedNote) -> str:
    parent = Path(note.path).parent
    if str(parent) == ".":
        return note.title
    return clean_unicode(parent.name.strip()) or note.title


def _sync_project_from_note(
    conn: sqlite3.Connection,
    note: ParsedNote,
    note_id: int,
    settings: Settings,
) -> bool:
    if not _project_center_match(note, settings):
        return False
    status, status_tag = project_status_from_note(note)
    now = utc_now()
    path = Path(note.path)
    folder = "" if str(path.parent) == "." else path.parent.as_posix()
    project_name = _project_name_from_center_note(note)
    center_tags = [normalize_tag(tag) for tag in settings.obsidian_project_center_tags if normalize_tag(tag)]
    keywords = [
        tag
        for tag in note.tags
        if tag not in set(center_tags) and not tag.startswith("status/")
    ]
    existing = conn.execute(
        """
        SELECT id FROM research_projects
        WHERE obsidian_note_id = ? OR obsidian_project_path = ?
        ORDER BY CASE WHEN obsidian_note_id = ? THEN 0 ELSE 1 END
        LIMIT 1
        """,
        (note_id, note.path, note_id),
    ).fetchone()
    payload = (
        project_name,
        status,
        to_json(keywords),
        note.path,
        folder,
        note_id,
        folder,
        status_tag,
        "obsidian",
        to_json(center_tags),
        now,
    )
    if existing:
        conn.execute(
            """
            UPDATE research_projects
            SET name = ?,
                status = ?,
                keywords_json = ?,
                obsidian_project_path = ?,
                obsidian_output_dir = ?,
                obsidian_note_id = ?,
                obsidian_folder = ?,
                obsidian_status_tag = ?,
                discovery_source = ?,
                source_tags_json = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (*payload, int(existing["id"])),
        )
    else:
        conn.execute(
            """
            INSERT INTO research_projects(
              name, status, keywords_json, obsidian_project_path, obsidian_output_dir,
              obsidian_note_id, obsidian_folder, obsidian_status_tag, discovery_source,
              source_tags_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (*payload, now),
        )
    return True


def _sync_project_folder_memberships(conn: sqlite3.Connection) -> int:
    projects = conn.execute(
        """
        SELECT id, obsidian_note_id, obsidian_folder
        FROM research_projects
        WHERE discovery_source = 'obsidian'
          AND (obsidian_note_id IS NOT NULL OR obsidian_folder != '')
        """
    ).fetchall()
    synced = 0
    now = utc_now()
    for project in projects:
        project_id = int(project["id"])
        center_note_id = int(project["obsidian_note_id"]) if project["obsidian_note_id"] is not None else None
        folder = str(project["obsidian_folder"] or "").strip("/")
        conn.execute(
            """
            DELETE FROM project_notes
            WHERE project_id = ? AND relation IN ('center_page', 'folder_member')
            """,
            (project_id,),
        )
        if folder:
            notes = conn.execute(
                """
                SELECT id, path
                FROM obsidian_notes
                WHERE path LIKE ?
                ORDER BY path
                """,
                (f"{folder}/%",),
            ).fetchall()
        elif center_note_id:
            notes = conn.execute(
                """
                SELECT id, path
                FROM obsidian_notes
                WHERE id = ?
                """,
                (center_note_id,),
            ).fetchall()
        else:
            notes = []
        for note in notes:
            relation = "center_page" if center_note_id and int(note["id"]) == center_note_id else "folder_member"
            conn.execute(
                """
                INSERT INTO project_notes(project_id, note_id, relation, note, created_at, updated_at)
                VALUES (?, ?, ?, '', ?, ?)
                ON CONFLICT(project_id, note_id) DO UPDATE SET
                  relation = CASE
                    WHEN project_notes.relation IN ('center_page', 'folder_member')
                    THEN excluded.relation
                    ELSE project_notes.relation
                  END,
                  updated_at = excluded.updated_at
                """,
                (project_id, int(note["id"]), relation, now, now),
            )
            synced += 1
    return synced


def sync_obsidian(conn: sqlite3.Connection, settings: Settings) -> dict[str, int]:
    notes = discover_notes(settings)
    indexed = 0
    skipped = 0
    projects_synced = 0
    project_notes_synced = 0
    chunks_created = 0
    embeddings_created = 0

    for note in notes:
        existing = conn.execute(
            "SELECT id, sha256 FROM obsidian_notes WHERE path = ?",
            (note.path,),
        ).fetchone()
        if existing and existing["sha256"] == note.sha256:
            if _sync_project_from_note(conn, note, int(existing["id"]), settings):
                projects_synced += 1
                conn.commit()
            skipped += 1
            continue

        now = utc_now()
        if existing:
            note_id = int(existing["id"])
            conn.execute("DELETE FROM research_chunks WHERE note_id = ?", (note_id,))
            conn.execute(
                """
                UPDATE obsidian_notes
                SET title = ?, frontmatter_json = ?, tags_json = ?, sha256 = ?, mtime = ?, indexed_at = ?
                WHERE id = ?
                """,
                (
                    note.title,
                    to_json(note.frontmatter),
                    to_json(note.tags),
                    note.sha256,
                    note.mtime,
                    now,
                    note_id,
                ),
            )
        else:
            cur = conn.execute(
                """
                INSERT INTO obsidian_notes(path, title, frontmatter_json, tags_json, sha256, mtime, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    note.path,
                    note.title,
                    to_json(note.frontmatter),
                    to_json(note.tags),
                    note.sha256,
                    note.mtime,
                    now,
                ),
            )
            note_id = int(cur.lastrowid)

        if _sync_project_from_note(conn, note, note_id, settings):
            projects_synced += 1

        for index, chunk in enumerate(chunk_note(note)):
            cur = conn.execute(
                """
                INSERT INTO research_chunks(note_id, chunk_index, heading, text, token_count, source, created_at)
                VALUES (?, ?, ?, ?, ?, 'obsidian', ?)
                """,
                (
                    note_id,
                    index,
                    chunk["heading"],
                    chunk["text"],
                    chunk["token_count"],
                    now,
                ),
            )
            chunks_created += 1
            embedding = embed_text(settings, str(chunk["text"]))
            if embedding is not None:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO chunk_embeddings(chunk_id, model, embedding_json, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (int(cur.lastrowid), settings.llm_embedding_model, to_json(embedding), now),
                )
                embeddings_created += 1
        indexed += 1
        conn.commit()

    project_notes_synced = _sync_project_folder_memberships(conn)
    conn.commit()

    return {
        "notes_seen": len(notes),
        "notes_indexed": indexed,
        "notes_skipped": skipped,
        "projects_synced": projects_synced,
        "project_notes_synced": project_notes_synced,
        "chunks_created": chunks_created,
        "embeddings_created": embeddings_created,
    }
