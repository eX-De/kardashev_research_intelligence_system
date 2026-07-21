from __future__ import annotations

import hashlib
import json
import socket
import urllib.error
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from typing import Any, Callable

from .config import Settings
from .db import clean_unicode, from_json, to_json, utc_now
from .db_types import DbConnection, DbRow
from .project_status import run_daily_project_status_sql


PROJECT_JUDGMENT_PROMPT_VERSION = "project_judgment_v1"
PROJECT_JUDGMENT_CANDIDATE_QUALITY_THRESHOLD = 0.40
PROJECT_JUDGMENT_PER_PROJECT_LIMIT = 10
PROJECT_JUDGMENT_MAX_CONCURRENCY = 8
PROJECT_JUDGMENT_REPORT_CONFIDENCE_THRESHOLD = 0.65
PROJECT_JUDGMENT_REPORT_USEFULNESS_THRESHOLD = 0.60
PROJECT_JUDGMENT_REPORT_RELATIONS = {"direct", "indirect"}
PROJECT_JUDGMENT_ACTIONS = {"read", "read_later", "ignore"}
PROJECT_JUDGMENT_RELATIONS = {"direct", "indirect", "weak", "none"}


class ChatJsonError(RuntimeError):
    pass


def _short(value: object, limit: int = 1200) -> str:
    text = " ".join(clean_unicode(str(value or "")).split())
    return text[:limit]


def _score(value: object, fallback: float = 0.0) -> float:
    if isinstance(value, bool):
        score = 1.0 if value else 0.0
    elif isinstance(value, (int, float)):
        score = float(value)
    elif isinstance(value, str):
        text = value.strip().lower()
        labels = {
            "very low": 0.1,
            "very_low": 0.1,
            "low": 0.25,
            "medium": 0.5,
            "moderate": 0.5,
            "mid": 0.5,
            "high": 0.8,
            "very high": 0.9,
            "very_high": 0.9,
        }
        if text in labels:
            score = labels[text]
        else:
            try:
                score = float(text.rstrip("%"))
                if text.endswith("%"):
                    score /= 100
            except ValueError:
                score = fallback
    else:
        score = fallback
    return max(0.0, min(1.0, score))


def _relation_type(value: object) -> str:
    relation = str(value or "none").strip().lower()
    return relation if relation in PROJECT_JUDGMENT_RELATIONS else "none"


def _suggested_action(value: object) -> str:
    action = str(value or "ignore").strip()
    return action if action in PROJECT_JUDGMENT_ACTIONS else "ignore"


def judgment_passes_report_filter(row_or_mapping: DbRow | dict[str, object]) -> bool:
    relation = _relation_type(row_or_mapping["relation_type"])
    action = _suggested_action(row_or_mapping["suggested_action"])
    return (
        relation in PROJECT_JUDGMENT_REPORT_RELATIONS
        and action != "ignore"
        and _score(row_or_mapping["confidence"]) >= PROJECT_JUDGMENT_REPORT_CONFIDENCE_THRESHOLD
        and _score(row_or_mapping["usefulness_score"]) >= PROJECT_JUDGMENT_REPORT_USEFULNESS_THRESHOLD
    )


def call_chat_json(
    settings: Settings,
    prompt: str,
    system: str = "You judge whether papers are useful for a specific research project.",
    response_format: dict[str, object] | None = None,
    timeout_seconds: float = 60,
    raise_errors: bool = False,
    provider_id: str = "",
    model: str = "",
) -> dict[str, object] | None:
    def fail(message: str) -> None:
        if raise_errors:
            raise ChatJsonError(message)
        return None

    selected_provider_id = clean_unicode(str(provider_id or settings.llm_chat_provider_id)).strip()
    selected_model = clean_unicode(str(model or settings.llm_chat_model)).strip()
    provider = settings.provider(selected_provider_id)
    if not provider or not provider.api_key or not provider.base_url or not selected_model:
        return fail("chat provider is not fully configured")
    payload = {
        "model": selected_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.1,
        "response_format": response_format or {"type": "json_object"},
    }
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
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            raw_body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = clean_unicode(exc.read().decode("utf-8", "replace")).strip()
        suffix = f": {detail[:500]}" if detail else ""
        return fail(f"provider returned HTTP {exc.code}{suffix}")
    except (TimeoutError, socket.timeout):
        return fail(f"request timed out after {int(timeout_seconds)}s")
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in str(reason).lower():
            return fail(f"request timed out after {int(timeout_seconds)}s")
        return fail(f"request failed: {reason}")
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        return fail(f"provider response was not valid JSON: {exc}")
    content = (
        body.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )
    if not clean_unicode(str(content or "")).strip():
        return fail("assistant response content was empty")
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        preview = clean_unicode(str(content or "")).strip()[:500]
        return fail(f"assistant response content was not valid JSON: {exc}; content starts with: {preview}")
    if not isinstance(parsed, dict):
        return fail(f"assistant JSON response was {type(parsed).__name__}, expected object")
    return parsed


def _call_chat(settings: Settings, prompt: str) -> dict[str, object] | None:
    return call_chat_json(settings, prompt)


def _paper_filter_clause(paper_ids: list[int] | None) -> tuple[str, list[Any]]:
    if paper_ids is None:
        return "", []
    if not paper_ids:
        return "AND 1 = 0", []
    placeholders = ", ".join("?" for _ in paper_ids)
    return f"AND ppm.paper_id IN ({placeholders})", [*paper_ids]


def _judgment_payload(row: DbRow) -> dict[str, object]:
    evidence = from_json(row["evidence_json"], {})
    return {
        "project": {
            "id": int(row["project_id"]),
            "name": row["project_name"],
            "status": row["project_status"],
            "summary": _short(row["project_summary"], 900),
            "goals": _short(row["project_goals"], 900),
            "keywords": from_json(row["project_keywords_json"], []),
            "note_path": row["note_path"],
            "evidence_heading": row["obsidian_heading"],
            "evidence_text": _short(row["obsidian_text"], 1200),
        },
        "paper": {
            "id": int(row["paper_id"]),
            "arxiv_id": row["arxiv_id"],
            "title": row["paper_title"],
            "link": row["link"],
            "published_at": row["published_at"],
            "categories": from_json(row["categories_json"], []),
            "abstract": _short(row["summary"], 1200),
            "evidence_text": _short(row["arxiv_text"], 1400),
            "page_start": row["page_start"],
            "page_end": row["page_end"],
        },
        "retrieval": {
            "quality_score": round(_score(row["retrieval_quality"]), 4),
            "rank_score": round(_score(row["rank_score"]), 4),
            "match_type": row["match_type"],
            "searchers": from_json(row["searchers_json"], []),
            "evidence": evidence,
        },
    }


def _input_hash(payload: dict[str, object]) -> str:
    raw = to_json({"prompt_version": PROJECT_JUDGMENT_PROMPT_VERSION, "payload": payload})
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _project_judgment_prompt(payload: dict[str, object]) -> str:
    return f"""
只返回 JSON，不要 Markdown fence，不要额外解释。
JSON keys must be exactly: relation_type, relevance_score, usefulness_score, confidence, suggested_action, reason, evidence_mapping, missing_evidence.
JSON 字段名保持英文，但所有可读文本字段值必须使用中文。

你是严格的科研项目论文筛选器。请判断下面这一篇论文是否对这个具体项目有用。

relation_type 必须是 direct、indirect、weak、none 之一：
- direct：论文里的具体机制、实验、数据或指标，直接对应项目正在解决的明确问题。
- indirect：论文不是同一任务，但有明确可迁移的方法或评估设计，且项目证据能说明这个需求存在。
- weak：只是共享 LLM、agent、RAG、embedding、evaluation、multi-agent、fine-tuning 等泛泛术语，或只有远期启发。
- none：没有可靠项目关联。

评分要求：
- relevance_score、usefulness_score、confidence 都必须是 0 到 1 的 JSON number。
- suggested_action 必须是 read、read_later、ignore 之一。
- 如果 relation_type 是 weak 或 none，suggested_action 必须是 ignore，usefulness_score 不得高于 0.4。
- 如果项目证据不能证明项目正在解决对应问题，必须降为 weak 或 none。
- 如果论文证据没有具体方法、实验、数据或指标，必须降低 usefulness_score。
- evidence_mapping 必须列出项目需求、论文机制和匹配理由；没有明确映射时返回空数组。
- missing_evidence 用一句中文说明还缺什么证据；证据充分时返回空字符串。

输入 JSON：
{to_json(payload)}
""".strip()


def _normalize_judgment(response: dict[str, object], fallback_quality: float) -> dict[str, object]:
    relation = _relation_type(response.get("relation_type"))
    relevance = _score(response.get("relevance_score"), fallback_quality)
    usefulness = _score(response.get("usefulness_score"), 0.0)
    confidence = _score(response.get("confidence"), 0.0)
    action = _suggested_action(response.get("suggested_action"))
    if relation in {"weak", "none"}:
        action = "ignore"
        usefulness = min(usefulness, 0.4)
    mapping = response.get("evidence_mapping", [])
    if not isinstance(mapping, list):
        mapping = []
    return {
        "relation_type": relation,
        "relevance_score": relevance,
        "usefulness_score": usefulness,
        "confidence": confidence,
        "suggested_action": action,
        "reason": _short(response.get("reason"), 1200),
        "evidence_mapping": clean_unicode(mapping),
        "missing_evidence": _short(response.get("missing_evidence"), 900),
        "raw": response,
    }


def _candidate_rows(
    conn: DbConnection,
    paper_ids: list[int] | None,
    per_project_limit: int,
) -> list[DbRow]:
    paper_filter, paper_params = _paper_filter_clause(paper_ids)
    rows = conn.execute(
        f"""
        SELECT
          ppm.project_id,
          ppm.paper_id,
          COALESCE(NULLIF(ppm.quality_score, 0), ppm.score) AS retrieval_quality,
          ppm.rank_score,
          ppm.searchers_json,
          ppm.evidence_json,
          ppm.match_type,
          p.arxiv_id,
          p.title AS paper_title,
          p.summary,
          p.link,
          p.published_at,
          p.categories_json,
          ac.page_start,
          ac.page_end,
          ac.text AS arxiv_text,
          c.heading AS obsidian_heading,
          c.text AS obsidian_text,
          n.path AS note_path,
          rp.name AS project_name,
          rp.status AS project_status,
          rp.summary AS project_summary,
          rp.goals AS project_goals,
          rp.keywords_json AS project_keywords_json,
          j.input_hash AS existing_input_hash,
          j.prompt_version AS existing_prompt_version
        FROM project_paper_matches ppm
        JOIN arxiv_papers p ON p.id = ppm.paper_id
        JOIN research_projects rp ON rp.id = ppm.project_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = ppm.best_arxiv_chunk_id
        LEFT JOIN research_chunks c ON c.id = ppm.best_obsidian_chunk_id
        LEFT JOIN obsidian_notes n ON n.id = c.note_id
        LEFT JOIN project_paper_judgments j
          ON j.project_id = ppm.project_id AND j.paper_id = ppm.paper_id
        WHERE COALESCE(NULLIF(ppm.quality_score, 0), ppm.score) >= ?
          AND {run_daily_project_status_sql("rp")}
          {paper_filter}
        ORDER BY ppm.project_id, retrieval_quality DESC, ppm.updated_at DESC
        """,
        (PROJECT_JUDGMENT_CANDIDATE_QUALITY_THRESHOLD, *paper_params),
    ).fetchall()
    kept: list[DbRow] = []
    per_project_counts: dict[int, int] = {}
    for row in rows:
        project_id = int(row["project_id"])
        count = per_project_counts.get(project_id, 0)
        if count >= per_project_limit:
            continue
        per_project_counts[project_id] = count + 1
        kept.append(row)
    return kept


def generate_missing_project_judgments(
    conn: DbConnection,
    settings: Settings,
    paper_ids: list[int] | None = None,
    per_project_limit: int = PROJECT_JUDGMENT_PER_PROJECT_LIMIT,
    progress_callback: Callable[[dict[str, int]], None] | None = None,
) -> dict[str, int]:
    candidates = _candidate_rows(conn, paper_ids, per_project_limit)
    created = 0
    filtered = 0
    skipped = 0
    pending: list[tuple[DbRow, dict[str, object], str]] = []
    configured_concurrency = min(
        max(1, int(settings.project_judgment_concurrency or 3)),
        PROJECT_JUDGMENT_MAX_CONCURRENCY,
    )

    def report_progress(completed: int, effective_concurrency: int) -> None:
        if not progress_callback:
            return
        progress_callback(
            {
                "total": len(candidates),
                "completed": completed,
                "created": created,
                "filtered": filtered,
                "skipped": skipped,
                "concurrency": effective_concurrency,
            }
        )

    for row in candidates:
        payload = _judgment_payload(row)
        input_hash = _input_hash(payload)
        if (
            row["existing_input_hash"] == input_hash
            and row["existing_prompt_version"] == PROJECT_JUDGMENT_PROMPT_VERSION
        ):
            skipped += 1
            continue
        pending.append((row, payload, input_hash))

    effective_concurrency = min(configured_concurrency, len(pending)) if pending else 0
    report_progress(skipped, effective_concurrency)
    if not pending:
        return {
            "project_judgment_candidates": len(candidates),
            "project_judgments_created": created,
            "project_judgments_filtered": filtered,
            "project_judgments_skipped": skipped,
            "project_judgment_concurrency": configured_concurrency,
        }

    with ThreadPoolExecutor(
        max_workers=effective_concurrency,
        thread_name_prefix="project-judgment",
    ) as executor:
        futures: dict[Future[dict[str, object] | None], tuple[DbRow, str]] = {
            executor.submit(_call_chat, settings, _project_judgment_prompt(payload)): (row, input_hash)
            for row, payload, input_hash in pending
        }
        for future in as_completed(futures):
            row, input_hash = futures[future]
            response = future.result()
            if not isinstance(response, dict):
                skipped += 1
            else:
                judgment = _normalize_judgment(response, _score(row["retrieval_quality"]))
                passes = judgment_passes_report_filter(judgment)
                if not passes:
                    filtered += 1
                now = utc_now()
                conn.execute(
                    """
                    INSERT INTO project_paper_judgments(
                      project_id, paper_id, relation_type, relevance_score, usefulness_score,
                      confidence, suggested_action, reason, evidence_mapping_json,
                      missing_evidence, input_hash, prompt_version, raw_json, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id,paper_id) DO UPDATE SET
                      relation_type = excluded.relation_type,
                      relevance_score = excluded.relevance_score,
                      usefulness_score = excluded.usefulness_score,
                      confidence = excluded.confidence,
                      suggested_action = excluded.suggested_action,
                      reason = excluded.reason,
                      evidence_mapping_json = excluded.evidence_mapping_json,
                      missing_evidence = excluded.missing_evidence,
                      input_hash = excluded.input_hash,
                      prompt_version = excluded.prompt_version,
                      raw_json = excluded.raw_json,
                      updated_at = excluded.updated_at
                    """,
                    (
                        int(row["project_id"]),
                        int(row["paper_id"]),
                        judgment["relation_type"],
                        float(judgment["relevance_score"]),
                        float(judgment["usefulness_score"]),
                        float(judgment["confidence"]),
                        judgment["suggested_action"],
                        judgment["reason"],
                        to_json(judgment["evidence_mapping"]),
                        judgment["missing_evidence"],
                        input_hash,
                        PROJECT_JUDGMENT_PROMPT_VERSION,
                        to_json(judgment["raw"]),
                        now,
                        now,
                    ),
                )
                conn.commit()
                created += 1
            report_progress(skipped + created, effective_concurrency)
    return {
        "project_judgment_candidates": len(candidates),
        "project_judgments_created": created,
        "project_judgments_filtered": filtered,
        "project_judgments_skipped": skipped,
        "project_judgment_concurrency": configured_concurrency,
    }
