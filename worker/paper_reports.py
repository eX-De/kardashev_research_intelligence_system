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
from .db import clean_unicode, from_json, to_json, utc_now
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
    now = utc_now()
    created = 0
    refreshed = 0
    preserved = 0
    for paper_id, project_ids in projects_by_paper.items():
        source_project_ids_json = to_json(project_ids)
        existing = conn.execute(
            "SELECT source_project_ids_json FROM paper_reading_reports WHERE paper_id = ?",
            (paper_id,),
        ).fetchone()
        if not existing:
            conn.execute(
                """
                INSERT INTO paper_reading_reports(
                  paper_id, status, prompt, system_prompt, source_project_ids_json,
                  created_at, updated_at
                )
                VALUES (?, 'queued', ?, ?, ?, ?, ?)
                """,
                (
                    paper_id,
                    PAPER_READER_DEFAULT_PROMPT,
                    PAPER_READER_ANALYSIS_SYSTEM,
                    source_project_ids_json,
                    now,
                    now,
                ),
            )
            created += 1
            continue
        if from_json(existing["source_project_ids_json"], []) != project_ids:
            conn.execute(
                """
                UPDATE paper_reading_reports
                SET source_project_ids_json = ?,
                    prompt = CASE WHEN prompt = '' THEN ? ELSE prompt END,
                    system_prompt = CASE WHEN system_prompt = '' THEN ? ELSE system_prompt END,
                    updated_at = ?
                WHERE paper_id = ?
                """,
                (
                    source_project_ids_json,
                    PAPER_READER_DEFAULT_PROMPT,
                    PAPER_READER_ANALYSIS_SYSTEM,
                    now,
                    paper_id,
                ),
            )
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
    existing = conn.execute(
        """
        SELECT
          rr.source_project_ids_json,
          p.arxiv_id,
          p.categories_json
        FROM paper_reading_reports rr
        JOIN arxiv_papers p ON p.id = rr.paper_id
        WHERE rr.paper_id = ?
        """,
        (paper_id,),
    ).fetchone()
    if not existing:
        return {"paper_reports_deleted": 0, "paper_reports_refreshed": 0}

    if not project_ids:
        source_project_ids = from_json(existing["source_project_ids_json"], [])
        categories = set(from_json(existing["categories_json"], []))
        arxiv_id = str(existing["arxiv_id"] or "")
        if "reader" in categories or arxiv_id.startswith("reader-") or not source_project_ids:
            return {"paper_reports_deleted": 0, "paper_reports_refreshed": 0}
        deleted = conn.execute(
            "DELETE FROM paper_reading_reports WHERE paper_id = ?",
            (paper_id,),
        ).rowcount
        return {"paper_reports_deleted": int(deleted or 0), "paper_reports_refreshed": 0}

    source_project_ids_json = to_json(project_ids)
    updated = conn.execute(
        """
        UPDATE paper_reading_reports
        SET source_project_ids_json = ?,
            updated_at = ?
        WHERE paper_id = ?
        """,
        (source_project_ids_json, utc_now(), paper_id),
    ).rowcount
    return {"paper_reports_deleted": 0, "paper_reports_refreshed": int(updated or 0)}


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
    existing = conn.execute(
        "SELECT paper_id, status FROM paper_reading_reports WHERE paper_id = ?",
        (paper_id,),
    ).fetchone()
    now = utc_now()
    prompt_text = clean_unicode(str(prompt or "")).strip() or PAPER_READER_DEFAULT_PROMPT
    if not existing:
        conn.execute(
            """
            INSERT INTO paper_reading_reports(
              paper_id, status, prompt, system_prompt, source_project_ids_json,
              created_at, updated_at
            )
            VALUES (?, 'queued', ?, ?, '[]', ?, ?)
            """,
            (paper_id, prompt_text, PAPER_READER_ANALYSIS_SYSTEM, now, now),
        )
        conn.commit()
        return {"paper_reports_queued": 1}
    if str(existing["status"] or "") == "removed":
        conn.execute(
            """
            UPDATE paper_reading_reports
            SET status = 'queued',
                prompt = ?,
                system_prompt = ?,
                report_markdown = '',
                error_message = '',
                started_at = NULL,
                finished_at = NULL,
                updated_at = ?
            WHERE paper_id = ?
            """,
            (prompt_text, PAPER_READER_ANALYSIS_SYSTEM, now, paper_id),
        )
        conn.commit()
        return {"paper_reports_queued": 1}
    if force:
        conn.execute(
            """
            UPDATE paper_reading_reports
            SET status = 'queued',
                prompt = ?,
                system_prompt = ?,
                report_markdown = '',
                error_message = '',
                started_at = NULL,
                finished_at = NULL,
                updated_at = ?
            WHERE paper_id = ?
            """,
            (prompt_text, PAPER_READER_ANALYSIS_SYSTEM, now, paper_id),
        )
        conn.commit()
        return {"paper_reports_requeued": 1}
    return {"paper_reports_queued": 0}


def paper_report_payload(conn: sqlite3.Connection, paper_id: int) -> dict[str, object] | None:
    row = conn.execute(
        """
        SELECT paper_id, status, prompt, system_prompt, model_provider_id, model,
               source_project_ids_json, report_markdown, error_message,
               created_at, updated_at, started_at, finished_at
        FROM paper_reading_reports
        WHERE paper_id = ?
        """,
        (paper_id,),
    ).fetchone()
    if not row:
        return None
    if str(row["status"] or "") == "removed":
        return None
    return {
        "paper_id": int(row["paper_id"]),
        "status": row["status"],
        "prompt": row["prompt"],
        "system_prompt": row["system_prompt"],
        "model_provider_id": row["model_provider_id"],
        "model": row["model"],
        "source_project_ids": from_json(row["source_project_ids_json"], []),
        "report_markdown": row["report_markdown"],
        "error_message": row["error_message"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


def remove_paper_report_from_queue(conn: sqlite3.Connection, paper_id: int) -> dict[str, int]:
    row = conn.execute(
        "SELECT status FROM paper_reading_reports WHERE paper_id = ?",
        (paper_id,),
    ).fetchone()
    if not row:
        return {"paper_reports_removed": 0}
    status = str(row["status"] or "")
    if status == "processing":
        raise RuntimeError("Processing reports cannot be removed from the queue")
    now = utc_now()
    updated = conn.execute(
        """
        UPDATE paper_reading_reports
        SET status = 'removed',
            report_markdown = '',
            error_message = '',
            started_at = NULL,
            finished_at = ?,
            updated_at = ?
        WHERE paper_id = ?
        """,
        (now, now, paper_id),
    ).rowcount
    conn.commit()
    return {"paper_reports_removed": int(updated or 0)}


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
    paper_clause, paper_params = _paper_filter("r", paper_ids)
    try:
        conn.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError as exc:
        if "within a transaction" in str(exc).lower():
            conn.commit()
            conn.execute("BEGIN IMMEDIATE")
        else:
            raise
    row = conn.execute(
        f"""
        SELECT r.paper_id
        FROM paper_reading_reports r
        JOIN arxiv_papers p ON p.id = r.paper_id
        WHERE r.status = 'queued'
          {paper_clause}
        ORDER BY r.updated_at, p.published_at DESC
        LIMIT 1
        """,
        paper_params,
    ).fetchone()
    if not row:
        conn.commit()
        return None
    paper_id = int(row["paper_id"])
    now = utc_now()
    conn.execute(
        """
        UPDATE paper_reading_reports
        SET status = 'processing',
            error_message = '',
            started_at = ?,
            updated_at = ?
        WHERE paper_id = ?
          AND status = 'queued'
        """,
        (now, now, paper_id),
    )
    conn.commit()
    return paper_id


def _queued_rows(
    conn: sqlite3.Connection,
    paper_ids: list[int] | tuple[int, ...] | set[int] | None,
    limit: int | None,
) -> list[sqlite3.Row]:
    paper_clause, paper_params = _paper_filter("r", paper_ids)
    sql = f"""
        SELECT r.paper_id
        FROM paper_reading_reports r
        JOIN arxiv_papers p ON p.id = r.paper_id
        WHERE r.status = 'queued'
          {paper_clause}
        ORDER BY r.updated_at, p.published_at DESC
    """
    params: list[Any] = [*paper_params]
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    return conn.execute(sql, params).fetchall()


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
            report = conn.execute(
                "SELECT prompt FROM paper_reading_reports WHERE paper_id = ?",
                (paper_id,),
            ).fetchone()
            prompt = clean_unicode(str(report["prompt"] if report else "")).strip() or _settings_report_prompt(settings)
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
            conn.execute(
                """
                UPDATE paper_reading_reports
                SET status = 'done',
                    prompt = ?,
                    system_prompt = ?,
                    model_provider_id = ?,
                    model = ?,
                    source_text_hash = ?,
                    report_markdown = ?,
                    error_message = '',
                    finished_at = ?,
                    updated_at = ?
                WHERE paper_id = ?
                """,
                (
                    prompt,
                    PAPER_READER_ANALYSIS_SYSTEM,
                    provider_id,
                    model,
                    text_hash,
                    markdown,
                    finished,
                    finished,
                    paper_id,
                ),
            )
            conn.commit()
            done += 1
        except Exception as exc:
            finished = utc_now()
            conn.execute(
                """
                UPDATE paper_reading_reports
                SET status = 'failed',
                    error_message = ?,
                    finished_at = ?,
                    updated_at = ?
                WHERE paper_id = ?
                """,
                (str(exc)[:2000], finished, finished, paper_id),
            )
            conn.commit()
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
        return report
    result = process_paper_report_queue(conn, settings, [paper_id])
    report = paper_report_payload(conn, paper_id)
    if report and report.get("status") == "done" and str(report.get("report_markdown") or "").strip():
        return report
    error = str(report.get("error_message") if report else "") if report else ""
    raise RuntimeError(error or f"Full paper report is not ready for paper {paper_id}")
