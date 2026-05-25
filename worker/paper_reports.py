from __future__ import annotations

import hashlib
import json
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .arxiv_text import (
    download_pdf,
    extract_pdf_text_to_file,
    pdf_url,
    replace_arxiv_chunks_for_paper,
    safe_arxiv_filename,
)
from .config import Settings
from .artifacts import PAPER_REPORT_ARTIFACT_TYPE, content_hash, upsert_artifact
from .db import clean_unicode, from_json, utc_now
from .papers import paper_id_for_arxiv_paper_id
from .project_status import run_daily_project_status_sql


PAPER_READER_DEFAULT_PROMPT = """请阅读这篇论文 PDF，输出结构化解读：

1. 研究问题和背景
2. 方法和实验设计
3. 主要发现
4. 局限性
5. 对后续研究或应用的启发

请尽量使用中文，保留关键英文术语。"""

PAPER_READER_ANALYSIS_SYSTEM = (
    "You are a research paper reading assistant. Read the supplied full PDF text and answer accurately from it."
)

VALID_REPORT_STATUSES = {"queued", "processing", "done", "failed", "cancelled", "removed"}


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


def _paper_report_artifact_row(conn: sqlite3.Connection, paper_id: int) -> sqlite3.Row | None:
    library_paper_id = paper_id_for_arxiv_paper_id(conn, int(paper_id))
    if library_paper_id is None:
        return None
    rows = conn.execute(
        """
        SELECT *
        FROM artifacts
        WHERE scope_type = 'paper'
          AND scope_id = ?
          AND artifact_type = ?
        ORDER BY updated_at DESC, id DESC
        """,
        (int(library_paper_id), PAPER_REPORT_ARTIFACT_TYPE),
    ).fetchall()
    source_key = _report_source_key(paper_id)
    fallback = rows[0] if rows else None
    for row in rows:
        source = from_json(row["source_json"], {})
        if isinstance(source, dict) and source.get("source_key") == source_key:
            return row
    return fallback


def _paper_report_state(
    conn: sqlite3.Connection,
    paper_id: int,
    row: sqlite3.Row | None = None,
) -> dict[str, Any] | None:
    paper = conn.execute("SELECT title, arxiv_id, link FROM arxiv_papers WHERE id = ?", (int(paper_id),)).fetchone()
    if not paper:
        return None
    library_paper_id = paper_id_for_arxiv_paper_id(conn, int(paper_id))
    if library_paper_id is None:
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
        "library_paper_id": int(library_paper_id),
        "arxiv_id": paper["arxiv_id"],
        "link": paper["link"],
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
    conn: sqlite3.Connection,
    state: dict[str, Any],
    *,
    commit: bool = True,
) -> dict[str, object]:
    content = {
        "paper_id": int(state["library_paper_id"]),
        "legacy_arxiv_paper_id": int(state["paper_id"]),
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
        "legacy_arxiv_paper_id": int(state["paper_id"]),
        "source_text_hash": state.get("source_text_hash") or "",
    }
    markdown = clean_unicode(str(state.get("report_markdown") or ""))
    artifact = upsert_artifact(
        conn,
        scope_type="paper",
        scope_id=int(state["library_paper_id"]),
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


def _report_rows_for_queue(
    conn: sqlite3.Connection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT *
        FROM artifacts
        WHERE scope_type = 'paper'
          AND artifact_type = ?
          AND status != 'removed'
        ORDER BY updated_at DESC, id DESC
        """,
        (PAPER_REPORT_ARTIFACT_TYPE,),
    ).fetchall()
    selected = None if paper_ids is None else {int(paper_id) for paper_id in paper_ids}
    result: list[dict[str, Any]] = []
    for row in rows:
        source = from_json(row["source_json"], {})
        content = from_json(row["content_json"], {})
        legacy_id = None
        if isinstance(source, dict):
            legacy_id = source.get("legacy_arxiv_paper_id")
        if legacy_id is None and isinstance(content, dict):
            legacy_id = content.get("legacy_arxiv_paper_id")
        try:
            paper_id = int(legacy_id)
        except (TypeError, ValueError):
            paper_id = _legacy_paper_id_for_library_paper(conn, int(row["scope_id"] or 0))
        if paper_id is None:
            continue
        if selected is not None and paper_id not in selected:
            continue
        state = _paper_report_state(conn, paper_id, row)
        if state:
            result.append(state)
    return result


def _legacy_paper_id_for_library_paper(conn: sqlite3.Connection, library_paper_id: int) -> int | None:
    row = conn.execute(
        """
        SELECT ap.id
        FROM arxiv_papers ap
        JOIN paper_sources ps ON ps.source_identifier = ap.arxiv_id
        WHERE ps.paper_id = ?
        ORDER BY ap.id
        LIMIT 1
        """,
        (int(library_paper_id),),
    ).fetchone()
    return int(row["id"]) if row else None


def _source_projects_for_recommended_papers(
    conn: sqlite3.Connection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
) -> dict[int, list[int]]:
    paper_clause, paper_params = _paper_filter("r", paper_ids)
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
    conn: sqlite3.Connection,
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


def sync_paper_report_for_recommendation_state(conn: sqlite3.Connection, paper_id: int) -> dict[str, int]:
    project_ids = _source_projects_for_recommended_papers(conn, [paper_id]).get(int(paper_id), [])
    state = _paper_report_state(conn, paper_id)
    if not state or not state.get("artifact_id"):
        return {"paper_reports_deleted": 0, "paper_reports_refreshed": 0}

    if not project_ids:
        paper = conn.execute(
            "SELECT arxiv_id, categories_json FROM arxiv_papers WHERE id = ?",
            (int(paper_id),),
        ).fetchone()
        source_project_ids = state.get("source_project_ids") or []
        categories = set(from_json(paper["categories_json"], [])) if paper else set()
        arxiv_id = str(paper["arxiv_id"] or "") if paper else ""
        if "reader" in categories or arxiv_id.startswith("reader-") or not source_project_ids:
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
    conn: sqlite3.Connection,
    paper_id: int,
    *,
    force: bool = False,
    prompt: str | None = None,
) -> dict[str, int]:
    if not conn.execute("SELECT id FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone():
        raise RuntimeError(f"Paper not found: {paper_id}")
    ensure_paper_reports_for_recommendations(conn, [paper_id])
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


def paper_report_payload(conn: sqlite3.Connection, paper_id: int) -> dict[str, object] | None:
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


def remove_paper_report_from_queue(conn: sqlite3.Connection, paper_id: int) -> dict[str, int]:
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


def cancel_paper_report_from_queue(conn: sqlite3.Connection, paper_id: int) -> dict[str, int]:
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


def _read_existing_text(paper: sqlite3.Row) -> str:
    path_text = str(paper["text_path"] or "").strip()
    if not path_text:
        return ""
    path = Path(path_text)
    if not path.exists() or not path.is_file():
        return ""
    return clean_unicode(path.read_text(encoding="utf-8", errors="ignore")).strip()


def _ensure_full_text(conn: sqlite3.Connection, settings: Settings, paper_id: int) -> str:
    paper = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone()
    if not paper:
        raise RuntimeError(f"Paper not found: {paper_id}")
    existing_text = _read_existing_text(paper)
    if existing_text:
        return existing_text

    stem = safe_arxiv_filename(str(paper["arxiv_id"]))
    pdf_path = Path(str(paper["pdf_path"] or "").strip() or settings.arxiv_pdf_dir / f"{stem}.pdf")
    text_path = Path(str(paper["text_path"] or "").strip() or settings.arxiv_text_dir / f"{stem}.txt")
    if not pdf_path.exists():
        download_pdf(pdf_url(paper), pdf_path)
    char_count = extract_pdf_text_to_file(pdf_path, text_path)
    conn.execute(
        """
        UPDATE arxiv_papers
        SET pdf_path = ?,
            text_path = ?,
            text_extracted_at = ?,
            text_status = 'complete',
            text_error = '',
            text_char_count = ?
        WHERE id = ?
        """,
        (str(pdf_path), str(text_path), utc_now(), char_count, paper_id),
    )
    refreshed = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone()
    text = _read_existing_text(refreshed)
    replace_arxiv_chunks_for_paper(conn, refreshed, text)
    conn.commit()
    return text


def _analysis_messages(paper_text: str, prompt: str) -> list[dict[str, str]]:
    user_message = (
        "下面是 PyMuPDF 从论文 PDF 中解析出的完整文本，按页保留。"
        "请基于这份文本完成用户要求；不要声称无法读取正文，除非文本本身确实缺失。\n\n"
        "请只返回一个 JSON 对象，不要输出 JSON 之外的文字。JSON 字段：\n"
        "- title: 论文正式标题，使用论文正文中的标题，去掉换行和多余空格。\n"
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


def mirror_paper_report_artifact(conn: sqlite3.Connection, paper_id: int) -> dict[str, object] | None:
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
    conn: sqlite3.Connection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None,
) -> int | None:
    if getattr(conn, "dialect", "") == "postgres":
        conn.execute("BEGIN")
        queued = [row for row in _report_rows_for_queue(conn, paper_ids) if row.get("status") == "queued"]
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
    try:
        conn.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError as exc:
        if "within a transaction" in str(exc).lower():
            conn.commit()
            conn.execute("BEGIN IMMEDIATE")
        else:
            raise
    queued = [row for row in _report_rows_for_queue(conn, paper_ids) if row.get("status") == "queued"]
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


def _queued_rows(
    conn: sqlite3.Connection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None,
    limit: int | None,
) -> list[sqlite3.Row]:
    rows = [row for row in _report_rows_for_queue(conn, paper_ids) if row.get("status") == "queued"]
    if limit:
        rows = rows[: int(limit)]
    return rows  # type: ignore[return-value]


def process_paper_report_queue(
    conn: sqlite3.Connection,
    settings: Settings,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None = None,
    limit: int | None = None,
) -> dict[str, int]:
    target = max(1, int(limit)) if limit else None
    considered = 0
    done = 0
    failed = 0
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
            paper = conn.execute("SELECT title FROM arxiv_papers WHERE id = ?", (paper_id,)).fetchone()
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
                    "UPDATE arxiv_papers SET title = ? WHERE id = ?",
                    (generated_title, paper_id),
                )
                state["title"] = generated_title
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
            _save_paper_report_state(conn, state, commit=False)
            conn.commit()
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
    }


def ensure_report_ready_for_paper(
    conn: sqlite3.Connection,
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
