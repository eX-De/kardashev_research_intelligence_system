from __future__ import annotations

import hashlib
import json
from .db_types import DbConnection, DbRow
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .arxiv_text import (
    chunk_text,
    download_pdf,
    extract_pdf_text_to_file,
)
from .config import Settings
from .artifacts import PAPER_REPORT_ARTIFACT_TYPE, content_hash, upsert_artifact
from .artifact_index import enqueue_artifact_index
from .library_search_index import enqueue_library_paper_index
from .db import clean_unicode, from_json, utc_now
from .papers import (
    replace_paper_chunks,
    upsert_paper_asset,
)
from .project_status import run_daily_project_status_sql


PAPER_READER_DEFAULT_PROMPT = """请阅读这份研究文档，输出结构化解读：

1. 研究问题和背景
2. 方法和实验设计
3. 主要发现
4. 局限性
5. 对后续研究或应用的启发

请尽量使用中文，保留关键英文术语。"""

PAPER_READER_ANALYSIS_SYSTEM = (
    "You are a research document reading assistant. Read the supplied extracted document text and answer accurately from it."
)

VALID_REPORT_STATUSES = {"queued", "processing", "done", "failed", "cancelled", "removed"}
MANUAL_IMPORT_SOURCE_TYPES = {"upload", "url", "web", "manual"}


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


def _report_source_key(paper_id: int) -> str:
    return f"paper_report:{int(paper_id)}"


def _paper_report_artifact_row(conn: DbConnection, paper_id: int) -> DbRow | None:
    rows = conn.execute(
        """
        SELECT *
        FROM artifacts
        WHERE scope_type = 'paper'
          AND scope_id = ?
          AND artifact_type = ?
        ORDER BY updated_at DESC, id DESC
        """,
        (int(paper_id), PAPER_REPORT_ARTIFACT_TYPE),
    ).fetchall()
    source_key = _report_source_key(paper_id)
    fallback = rows[0] if rows else None
    for row in rows:
        source = from_json(row["source_json"], {})
        if isinstance(source, dict) and source.get("source_key") == source_key:
            return row
    return fallback


def _paper_report_state(
    conn: DbConnection,
    paper_id: int,
    row: DbRow | None = None,
) -> dict[str, Any] | None:
    paper = conn.execute(
        """
        SELECT
          paper.id,
          paper.title,
          paper.arxiv_id,
          COALESCE((
            SELECT source.source_url
            FROM paper_sources source
            WHERE source.paper_id = paper.id AND source.source_url != ''
            ORDER BY source.updated_at DESC, source.id DESC
            LIMIT 1
          ), '') AS link,
          COALESCE((
            SELECT source.source_type
            FROM paper_sources source
            WHERE source.paper_id = paper.id
            ORDER BY source.updated_at DESC, source.id DESC
            LIMIT 1
          ), '') AS source_type
        FROM papers paper
        WHERE paper.id = ?
        """,
        (int(paper_id),),
    ).fetchone()
    if not paper:
        return None
    row = row if row is not None else _paper_report_artifact_row(conn, int(paper_id))
    content = from_json(row["content_json"], {}) if row else {}
    source = from_json(row["source_json"], {}) if row else {}
    if not isinstance(content, dict):
        content = {}
    if not isinstance(source, dict):
        source = {}
    now = utc_now()
    created_at = row["created_at"] if row else now
    updated_at = row["updated_at"] if row else now
    return {
        "artifact_id": int(row["id"]) if row else None,
        "paper_id": int(paper_id),
        "arxiv_id": paper["arxiv_id"],
        "link": paper["link"],
        "source_type": paper["source_type"],
        "title": paper["title"],
        "status": row["status"] if row else "queued",
        "prompt": content.get("prompt") or "",
        "system_prompt": content.get("system_prompt") or "",
        "model_provider_id": row["model_provider_id"] if row else "",
        "model": row["model"] if row else "",
        "source_text_hash": source.get("source_text_hash") or (row["input_hash"] if row else ""),
        "source_project_ids": content.get("source_project_ids") if isinstance(content.get("source_project_ids"), list) else [],
        "report_markdown": row["content_markdown"] if row else "",
        "error_message": content.get("error_message") or "",
        "created_at": created_at,
        "updated_at": updated_at,
        "started_at": content.get("started_at"),
        "finished_at": content.get("finished_at"),
    }


def _save_paper_report_state(
    conn: DbConnection,
    state: dict[str, Any],
    *,
    commit: bool = True,
) -> dict[str, object]:
    content = {
        "paper_id": int(state["paper_id"]),
        "arxiv_id": state.get("arxiv_id") or "",
        "link": state.get("link") or "",
        "prompt": state.get("prompt") or "",
        "system_prompt": state.get("system_prompt") or "",
        "source_project_ids": state.get("source_project_ids") or [],
        "error_message": state.get("error_message") or "",
        "started_at": state.get("started_at"),
        "finished_at": state.get("finished_at"),
    }
    source_key = _report_source_key(int(state["paper_id"]))
    source = {
        "source_key": source_key,
        "generated_from": "paper_report_queue",
        "source_text_hash": state.get("source_text_hash") or "",
    }
    markdown = clean_unicode(str(state.get("report_markdown") or ""))
    artifact = upsert_artifact(
        conn,
        scope_type="paper",
        scope_id=int(state["paper_id"]),
        artifact_type=PAPER_REPORT_ARTIFACT_TYPE,
        title=clean_unicode(str(state.get("title") or f"Paper {state['paper_id']} Full Report")),
        content_markdown=markdown,
        content_json=content,
        status=clean_unicode(str(state.get("status") or "queued")),
        source_json=source,
        source_key=source_key,
        model_provider_id=clean_unicode(str(state.get("model_provider_id") or "")),
        model=clean_unicode(str(state.get("model") or "")),
        input_hash=clean_unicode(str(state.get("source_text_hash") or "")) or content_hash(markdown, content),
        commit=commit,
    )
    state["artifact_id"] = int(artifact["id"]) if artifact else state.get("artifact_id")
    return artifact


def _paper_report_result(state: dict[str, Any]) -> dict[str, object]:
    source_type = clean_unicode(str(state.get("source_type") or "")).strip().lower()
    arxiv_id = clean_unicode(str(state.get("arxiv_id") or "")).strip().lower()
    return {
        "paper_id": int(state["paper_id"]),
        "artifact_id": int(state["artifact_id"]) if state.get("artifact_id") else None,
        "title": clean_unicode(str(state.get("title") or "")).strip(),
        "status": clean_unicode(str(state.get("status") or "")).strip(),
        "source_type": source_type,
        "manual_import": source_type in MANUAL_IMPORT_SOURCE_TYPES or arxiv_id.startswith("reader-"),
        "updated_at": state.get("finished_at") or state.get("updated_at"),
        "error_message": clean_unicode(str(state.get("error_message") or "")).strip(),
    }


def _report_rows_for_queue(
    conn: DbConnection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
    *,
    status: str | None = None,
    for_update: bool = False,
) -> list[dict[str, Any]]:
    params: list[Any] = [PAPER_REPORT_ARTIFACT_TYPE]
    status_clause = ""
    if status is not None:
        status_clause = "AND status = ?"
        params.append(status)
    lock_clause = "FOR UPDATE SKIP LOCKED" if for_update else ""
    rows = conn.execute(
        f"""
        SELECT *
        FROM artifacts
        WHERE scope_type = 'paper'
          AND artifact_type = ?
          AND status != 'removed'
          {status_clause}
        ORDER BY updated_at DESC, id DESC
        {lock_clause}
        """,
        params,
    ).fetchall()
    selected = None if paper_ids is None else {int(paper_id) for paper_id in paper_ids}
    result: list[dict[str, Any]] = []
    for row in rows:
        try:
            paper_id = int(row["scope_id"])
        except (TypeError, ValueError):
            continue
        if selected is not None and paper_id not in selected:
            continue
        state = _paper_report_state(conn, paper_id, row)
        if state:
            result.append(state)
    return result


def _source_projects_for_recommended_papers(
    conn: DbConnection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> dict[int, list[int]]:
    paper_clause = ""
    paper_params: list[Any] = []
    if paper_ids is not None:
        ids = sorted({int(paper_id) for paper_id in paper_ids})
        if not ids:
            paper_clause = "AND 1 = 0"
        else:
            placeholders = ", ".join("?" for _ in ids)
            paper_clause = (
                f"AND (r.paper_id IN ({placeholders}) "
                f"OR r.source_arxiv_paper_id IN ({placeholders}))"
            )
            paper_params = [*ids, *ids]
    rows = conn.execute(
        f"""
        SELECT r.paper_id, r.project_id
        FROM project_paper_recommendations r
        JOIN research_projects rp ON rp.id = r.project_id
        WHERE r.state IN ('pending', 'accepted')
          AND {run_daily_project_status_sql("rp")}
          {paper_clause}
        ORDER BY r.paper_id, r.project_id
        """,
        paper_params,
    ).fetchall()
    projects_by_paper: dict[int, list[int]] = {}
    for row in rows:
        projects_by_paper.setdefault(int(row["paper_id"]), []).append(int(row["project_id"]))
    return projects_by_paper


def ensure_paper_reports_for_recommendations(
    conn: DbConnection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> dict[str, int]:
    projects_by_paper = _source_projects_for_recommended_papers(conn, paper_ids)
    created = 0
    refreshed = 0
    preserved = 0
    for paper_id, project_ids in projects_by_paper.items():
        state = _paper_report_state(conn, paper_id)
        if not state:
            continue
        if not state.get("artifact_id"):
            state.update(
                {
                    "status": "queued",
                    "prompt": PAPER_READER_DEFAULT_PROMPT,
                    "system_prompt": PAPER_READER_ANALYSIS_SYSTEM,
                    "source_project_ids": project_ids,
                    "report_markdown": "",
                    "error_message": "",
                }
            )
            _save_paper_report_state(conn, state, commit=False)
            created += 1
            continue
        if state.get("source_project_ids") != project_ids:
            state["source_project_ids"] = project_ids
            if not state.get("prompt"):
                state["prompt"] = PAPER_READER_DEFAULT_PROMPT
            if not state.get("system_prompt"):
                state["system_prompt"] = PAPER_READER_ANALYSIS_SYSTEM
            _save_paper_report_state(conn, state, commit=False)
            refreshed += 1
        else:
            preserved += 1
    conn.commit()
    return {
        "paper_reports_candidates": len(projects_by_paper),
        "paper_reports_queued": created,
        "paper_reports_refreshed": refreshed,
        "paper_reports_preserved": preserved,
    }


def sync_paper_report_for_recommendation_state(conn: DbConnection, paper_id: int) -> dict[str, int]:
    paper_id = int(paper_id)
    project_ids = _source_projects_for_recommended_papers(conn, [paper_id]).get(paper_id, [])
    state = _paper_report_state(conn, paper_id)
    if not state or not state.get("artifact_id"):
        return {"paper_reports_deleted": 0, "paper_reports_refreshed": 0}

    if not project_ids:
        paper = conn.execute(
            """
            SELECT
              p.arxiv_id,
              COALESCE(source.source_type, '') AS source_type
            FROM papers p
            LEFT JOIN LATERAL (
              SELECT ps.source_type
              FROM paper_sources ps
              WHERE ps.paper_id = p.id
              ORDER BY ps.updated_at DESC, ps.id DESC
              LIMIT 1
            ) source ON TRUE
            WHERE p.id = ?
            """,
            (paper_id,),
        ).fetchone()
        source_project_ids = state.get("source_project_ids") or []
        arxiv_id = str(paper["arxiv_id"] or "") if paper else ""
        source_type = str(paper["source_type"] or "") if paper else ""
        if source_type in {"upload", "url", "web", "manual"} or arxiv_id.startswith("reader-") or not source_project_ids:
            return {"paper_reports_deleted": 0, "paper_reports_refreshed": 0}
        state["status"] = "removed"
        state["finished_at"] = utc_now()
        state["error_message"] = ""
        _save_paper_report_state(conn, state, commit=False)
        return {"paper_reports_deleted": 1, "paper_reports_refreshed": 0}

    state["source_project_ids"] = project_ids
    _save_paper_report_state(conn, state, commit=False)
    return {"paper_reports_deleted": 0, "paper_reports_refreshed": 1}


def _settings_report_prompt(settings: Settings) -> str:
    prompt = clean_unicode(str(settings.paper_reader_default_prompt or "")).strip()
    return prompt or PAPER_READER_DEFAULT_PROMPT


def queue_paper_report(
    conn: DbConnection,
    paper_id: int,
    *,
    force: bool = False,
    prompt: str | None = None,
) -> dict[str, int]:
    if not conn.execute("SELECT id FROM papers WHERE id = ?", (paper_id,)).fetchone():
        raise RuntimeError(f"Paper not found: {paper_id}")
    state = _paper_report_state(conn, paper_id)
    if not state:
        raise RuntimeError(f"Paper not found: {paper_id}")
    prompt_text = clean_unicode(str(prompt or "")).strip() or PAPER_READER_DEFAULT_PROMPT
    if not state.get("artifact_id"):
        state.update(
            {
                "status": "queued",
                "prompt": prompt_text,
                "system_prompt": PAPER_READER_ANALYSIS_SYSTEM,
                "source_project_ids": [],
                "report_markdown": "",
                "error_message": "",
                "started_at": None,
                "finished_at": None,
            }
        )
        _save_paper_report_state(conn, state, commit=False)
        conn.commit()
        return {"paper_reports_queued": 1}
    if str(state.get("status") or "") == "removed":
        state.update(
            {
                "status": "queued",
                "prompt": prompt_text,
                "system_prompt": PAPER_READER_ANALYSIS_SYSTEM,
                "report_markdown": "",
                "error_message": "",
                "started_at": None,
                "finished_at": None,
            }
        )
        _save_paper_report_state(conn, state, commit=False)
        conn.commit()
        return {"paper_reports_queued": 1}
    if force:
        state.update(
            {
                "status": "queued",
                "prompt": prompt_text,
                "system_prompt": PAPER_READER_ANALYSIS_SYSTEM,
                "report_markdown": "",
                "error_message": "",
                "started_at": None,
                "finished_at": None,
            }
        )
        _save_paper_report_state(conn, state, commit=False)
        conn.commit()
        return {"paper_reports_requeued": 1}
    return {"paper_reports_queued": 0}


def paper_report_payload(conn: DbConnection, paper_id: int) -> dict[str, object] | None:
    state = _paper_report_state(conn, paper_id)
    if not state or not state.get("artifact_id"):
        return None
    if str(state["status"] or "") == "removed":
        return None
    return {
        "paper_id": int(state["paper_id"]),
        "artifact_id": state.get("artifact_id"),
        "status": state["status"],
        "prompt": state["prompt"],
        "system_prompt": state["system_prompt"],
        "model_provider_id": state["model_provider_id"],
        "model": state["model"],
        "source_project_ids": state["source_project_ids"],
        "report_markdown": state["report_markdown"],
        "error_message": state["error_message"],
        "created_at": state["created_at"],
        "updated_at": state["updated_at"],
        "started_at": state["started_at"],
        "finished_at": state["finished_at"],
    }


def remove_paper_report_from_queue(conn: DbConnection, paper_id: int) -> dict[str, int]:
    state = _paper_report_state(conn, paper_id)
    if not state or not state.get("artifact_id"):
        return {"paper_reports_removed": 0}
    artifact_id = int(state["artifact_id"] or 0)
    status = str(state["status"] or "")
    if status == "processing":
        raise RuntimeError("Processing reports cannot be removed from the queue")
    now = utc_now()
    state["status"] = "removed"
    state["error_message"] = ""
    state["started_at"] = None
    state["finished_at"] = now
    _save_paper_report_state(conn, state, commit=False)
    conn.commit()
    return {"artifact_id": artifact_id, "paper_reports_removed": 1}


def cancel_paper_report_from_queue(conn: DbConnection, paper_id: int) -> dict[str, int]:
    state = _paper_report_state(conn, paper_id)
    if not state or not state.get("artifact_id"):
        raise RuntimeError("Report queue item was not found")
    status = str(state["status"] or "")
    if status == "queued":
        now = utc_now()
        state["status"] = "cancelled"
        state["error_message"] = ""
        state["finished_at"] = now
        _save_paper_report_state(conn, state, commit=False)
        conn.commit()
        return {"paper_reports_cancelled": 1}
    if status == "processing":
        raise RuntimeError("Processing reports cannot be cancelled")
    return {"paper_reports_cancelled": 0}


def _read_existing_text(path_value: object) -> str:
    path_text = str(path_value or "").strip()
    if not path_text:
        return ""
    path = Path(path_text)
    if not path.exists() or not path.is_file():
        return ""
    return clean_unicode(path.read_text(encoding="utf-8", errors="ignore")).strip()


def _ensure_full_text(conn: DbConnection, settings: Settings, paper_id: int) -> str:
    paper = conn.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
    if not paper:
        raise RuntimeError(f"Paper not found: {paper_id}")
    text_asset = conn.execute(
        """
        SELECT *
        FROM paper_assets
        WHERE paper_id = ? AND asset_type = 'text'
        ORDER BY CASE WHEN status = 'complete' AND path != '' THEN 0 ELSE 1 END,
                 updated_at DESC,
                 id DESC
        LIMIT 1
        """,
        (paper_id,),
    ).fetchone()
    existing_text = _read_existing_text(text_asset["path"] if text_asset else "")
    if existing_text:
        return existing_text

    pdf_asset = conn.execute(
        """
        SELECT *
        FROM paper_assets
        WHERE paper_id = ? AND asset_type = 'pdf'
        ORDER BY CASE WHEN path != '' THEN 0 WHEN url != '' THEN 1 ELSE 2 END,
                 updated_at DESC,
                 id DESC
        LIMIT 1
        """,
        (paper_id,),
    ).fetchone()
    if not pdf_asset:
        raise RuntimeError("Full text and PDF asset are both missing")
    stem = f"paper-{int(paper_id)}"
    pdf_path = Path(str(pdf_asset["path"] or "").strip() or settings.arxiv_pdf_dir / f"{stem}.pdf")
    text_path_value = str(text_asset["path"] or "").strip() if text_asset else ""
    text_path = Path(text_path_value) if text_path_value else settings.arxiv_text_dir / f"{stem}.txt"
    if not pdf_path.exists():
        pdf_url_value = clean_unicode(str(pdf_asset["url"] or "")).strip()
        if not pdf_url_value:
            raise RuntimeError("PDF asset file is missing and has no download URL")
        download_pdf(pdf_url_value, pdf_path)
    char_count = extract_pdf_text_to_file(pdf_path, text_path)
    upsert_paper_asset(
        conn,
        paper_id,
        asset_type="pdf",
        path=str(pdf_path),
        url=str(pdf_asset["url"] or ""),
        status="complete",
    )
    text_asset_id = upsert_paper_asset(
        conn,
        paper_id,
        asset_type="text",
        path=str(text_path),
        status="complete",
        metadata={"char_count": int(char_count)},
    )
    text = _read_existing_text(text_path)
    metadata_text = clean_unicode(
        f"Title: {paper['title']}\n\nAbstract: {paper['abstract']}"
    ).strip()
    chunks = [
        {
            "source": "metadata",
            "page_start": None,
            "page_end": None,
            "text": metadata_text,
            "token_count": max(1, len(metadata_text) // 4),
            "char_count": len(metadata_text),
        },
        *chunk_text(text),
    ]
    replace_paper_chunks(conn, paper_id, chunks, text_asset_id=text_asset_id)
    conn.commit()
    return text


def _analysis_messages(paper_text: str, prompt: str) -> list[dict[str, str]]:
    user_message = (
        "下面是从来源文档中提取并清洗后的完整正文；PDF 文本可能保留分页，网页文本可能保留 Markdown 结构。"
        "请基于这份文本完成用户要求；不要声称无法读取正文，除非文本本身确实缺失。\n\n"
        "请只返回一个 JSON 对象，不要输出 JSON 之外的文字。JSON 字段：\n"
        "- title: 文档正式标题，使用正文中的标题，去掉换行和多余空格。\n"
        "- markdown: 完整中文解读报告，使用 Markdown。\n\n"
        "<paper_text>\n"
        f"{paper_text}\n"
        "</paper_text>\n\n"
        "用户要求：\n"
        f"{prompt}"
    )
    return [
        {"role": "system", "content": PAPER_READER_ANALYSIS_SYSTEM},
        {"role": "user", "content": user_message},
    ]


def _parse_report_generation_response(raw_text: str, fallback_title: str) -> tuple[str, str]:
    text = clean_unicode(str(raw_text or "")).strip()
    fallback_title = " ".join(clean_unicode(str(fallback_title or "")).split())
    if not text:
        raise RuntimeError("Full paper report LLM request failed: empty response")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return fallback_title, text
    if not isinstance(payload, dict):
        raise RuntimeError("Full paper report LLM request failed: JSON response must be an object")
    title = " ".join(
        clean_unicode(str(payload.get("title") or payload.get("paper_title") or fallback_title)).split()
    )
    markdown = clean_unicode(
        str(payload.get("markdown") or payload.get("report_markdown") or payload.get("report") or "")
    ).strip()
    if not markdown:
        raise RuntimeError("Full paper report LLM request failed: JSON response is missing markdown")
    return title or fallback_title, markdown


def mirror_paper_report_artifact(conn: DbConnection, paper_id: int) -> dict[str, object] | None:
    state = _paper_report_state(conn, paper_id)
    if not state or state.get("status") != "done":
        return None
    if not clean_unicode(str(state.get("report_markdown") or "")).strip():
        return None
    return _save_paper_report_state(conn, state, commit=False)


def _call_chat_text(
    settings: Settings,
    messages: list[dict[str, str]],
    response_format: dict[str, object] | None = None,
    provider_id: str | None = None,
    model: str | None = None,
    purpose: str = "LLM chat request",
) -> str:
    provider_id = clean_unicode(str(provider_id or settings.llm_chat_provider_id or "")).strip()
    model = clean_unicode(str(model or settings.llm_chat_model or "")).strip()
    provider = settings.provider(provider_id)
    if not provider or not provider.api_key or not provider.base_url or not model:
        raise RuntimeError(f"{purpose} provider is not fully configured")
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
    }
    if response_format:
        payload["response_format"] = response_format
    request = urllib.request.Request(
        f"{provider.base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {provider.api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Full paper report LLM request failed: {exc}") from exc
    content = (
        body.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )
    text = clean_unicode(str(content or "")).strip()
    if not text:
        raise RuntimeError("Full paper report LLM request failed: empty response")
    return text


def _iter_chat_text_chunks(
    settings: Settings,
    messages: list[dict[str, str]],
    response_format: dict[str, object] | None = None,
    provider_id: str | None = None,
    model: str | None = None,
    purpose: str = "LLM chat stream",
):
    provider_id = clean_unicode(str(provider_id or settings.llm_chat_provider_id or "")).strip()
    model = clean_unicode(str(model or settings.llm_chat_model or "")).strip()
    provider = settings.provider(provider_id)
    if not provider or not provider.api_key or not provider.base_url or not model:
        raise RuntimeError(f"{purpose} provider is not fully configured")
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "stream": True,
    }
    if response_format:
        payload["response_format"] = response_format
    request = urllib.request.Request(
        f"{provider.base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {provider.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            saw_stream_chunk = False
            body_parts: list[bytes] = []
            for raw_line in response:
                body_parts.append(raw_line)
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    parsed = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = parsed.get("choices", [{}])[0].get("delta", {})
                content = clean_unicode(str(delta.get("content") or ""))
                if content:
                    saw_stream_chunk = True
                    yield content
            if not saw_stream_chunk:
                raw = b"".join(body_parts).decode("utf-8", errors="replace").strip()
                if raw.startswith("{"):
                    parsed = json.loads(raw)
                    content = (
                        parsed.get("choices", [{}])[0]
                        .get("message", {})
                        .get("content", "")
                    )
                    text = clean_unicode(str(content or "")).strip()
                    if text:
                        yield text
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{purpose} failed: {exc}") from exc


def _claim_queued_report(
    conn: DbConnection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None,
) -> int | None:
    try:
        conn.execute("BEGIN")
        queued = _report_rows_for_queue(conn, paper_ids, status="queued", for_update=True)
        if not queued:
            conn.commit()
            return None
        state = queued[0]
        state["status"] = "processing"
        state["error_message"] = ""
        state["started_at"] = utc_now()
        _save_paper_report_state(conn, state, commit=False)
        conn.commit()
        return int(state["paper_id"])
    except Exception:
        conn.rollback()
        raise


def _queued_rows(
    conn: DbConnection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None,
    limit: int | None,
) -> list[DbRow]:
    rows = _report_rows_for_queue(conn, paper_ids, status="queued")
    if limit:
        rows = rows[: int(limit)]
    return rows  # type: ignore[return-value]


def process_paper_report_queue(
    conn: DbConnection,
    settings: Settings,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    target = max(1, int(limit)) if limit else None
    considered = 0
    done = 0
    failed = 0
    completed_reports: list[dict[str, object]] = []
    failed_reports: list[dict[str, object]] = []
    while target is None or considered < target:
        paper_id = _claim_queued_report(conn, paper_ids)
        if paper_id is None:
            break
        considered += 1
        try:
            paper_text = _ensure_full_text(conn, settings, paper_id)
            if not paper_text:
                raise RuntimeError("Full paper text is missing")
            text_hash = hashlib.sha256(paper_text.encode("utf-8", "replace")).hexdigest()
            state = _paper_report_state(conn, paper_id)
            if not state:
                raise RuntimeError(f"Paper report queue item not found: {paper_id}")
            prompt = clean_unicode(str(state.get("prompt") or "")).strip() or _settings_report_prompt(settings)
            provider_id = settings.paper_report_provider_id or settings.llm_chat_provider_id
            model = settings.paper_report_model or settings.llm_chat_model
            paper = conn.execute("SELECT title FROM papers WHERE id = ?", (paper_id,)).fetchone()
            current_title = str(paper["title"] if paper else "").strip()
            messages = _analysis_messages(paper_text, prompt)
            raw_response = _call_chat_text(
                settings,
                messages,
                response_format={"type": "json_object"},
                provider_id=provider_id,
                model=model,
                purpose="Full paper report generation",
            )
            generated_title, markdown = _parse_report_generation_response(raw_response, current_title)
            finished = utc_now()
            if generated_title and generated_title != current_title:
                conn.execute(
                    "UPDATE papers SET title = ?, updated_at = ? WHERE id = ?",
                    (generated_title, finished, paper_id),
                )
                state["title"] = generated_title
                enqueue_library_paper_index(conn, settings, paper_id)
            state.update(
                {
                    "status": "done",
                    "prompt": prompt,
                    "system_prompt": PAPER_READER_ANALYSIS_SYSTEM,
                    "model_provider_id": provider_id,
                    "model": model,
                    "source_text_hash": text_hash,
                    "report_markdown": markdown,
                    "error_message": "",
                    "finished_at": finished,
                }
            )
            artifact = _save_paper_report_state(conn, state, commit=False)
            conn.commit()
            enqueue_artifact_index(conn, settings, artifact)
            completed_reports.append(_paper_report_result(state))
            done += 1
        except Exception as exc:
            finished = utc_now()
            original_error = str(exc)[:2000]
            try:
                conn.rollback()
            except Exception:
                pass
            try:
                state = _paper_report_state(conn, paper_id)
                if state is None:
                    raise RuntimeError(f"Paper report queue item not found: {paper_id}")
                state["status"] = "failed"
                state["error_message"] = original_error
                state["finished_at"] = finished
                _save_paper_report_state(conn, state, commit=False)
                conn.commit()
                failed_reports.append(_paper_report_result(state))
            except Exception as record_exc:
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise RuntimeError(
                    f"Paper report failed and failure status could not be recorded: {record_exc}; "
                    f"original error: {original_error}"
                ) from exc
            failed += 1
    return {
        "paper_reports_considered": considered,
        "paper_reports_done": done,
        "paper_reports_failed": failed,
        "paper_reports_completed": completed_reports,
        "paper_reports_failures": failed_reports,
    }


def ensure_report_ready_for_paper(
    conn: DbConnection,
    settings: Settings,
    paper_id: int,
) -> dict[str, object]:
    queue_paper_report(conn, paper_id)
    report = paper_report_payload(conn, paper_id)
    if report and report.get("status") == "done" and str(report.get("report_markdown") or "").strip():
        mirror_paper_report_artifact(conn, paper_id)
        conn.commit()
        return report
    result = process_paper_report_queue(conn, settings, [paper_id])
    report = paper_report_payload(conn, paper_id)
    if report and report.get("status") == "done" and str(report.get("report_markdown") or "").strip():
        mirror_paper_report_artifact(conn, paper_id)
        conn.commit()
        return report
    error = str(report.get("error_message") if report else "") if report else ""
    raise RuntimeError(error or f"Full paper report is not ready for paper {paper_id}")
