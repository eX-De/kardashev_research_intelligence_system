from __future__ import annotations

import re
from .db_types import DbConnection, DbRow
from datetime import date
from pathlib import Path
from typing import Any

from .config import Settings
from .artifacts import content_hash, export_artifact_to_obsidian, upsert_artifact
from .db import clean_unicode, from_json, to_json, utc_now
from .llm import (
    ChatJsonError,
    PROJECT_JUDGMENT_REPORT_CONFIDENCE_THRESHOLD,
    PROJECT_JUDGMENT_REPORT_USEFULNESS_THRESHOLD,
    call_chat_json,
)
from .project_status import run_daily_project_status_sql
from .obsidian_remote import obsidian_remote_enabled


DAILY_REPORT_DIR = Path("Research Intelligence") / "Daily"
DAILY_REPORT_LIMIT = 40
DAILY_REPORT_LLM_TIMEOUT_SECONDS = 300


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", clean_unicode(value)).strip(" .")
    return cleaned or "report"


def _short(value: object, limit: int = 900) -> str:
    text = re.sub(r"\s+", " ", clean_unicode(str(value or ""))).strip()
    return text[:limit]


def _float(value: object) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _paper_filter(
    paper_ids: list[int] | None,
    table_alias: str = "p",
    extra_conditions: list[str] | None = None,
    extra_params: list[Any] | None = None,
) -> tuple[str, list[Any]]:
    conditions = list(extra_conditions or [])
    params: list[Any] = list(extra_params or [])
    if paper_ids is None:
        if not conditions:
            return "", []
        return "WHERE " + " AND ".join(conditions), params
    if not paper_ids:
        return "WHERE 1 = 0", []
    placeholders = ", ".join("?" for _ in paper_ids)
    conditions.insert(0, f"{table_alias}.id IN ({placeholders})")
    return "WHERE " + " AND ".join(conditions), [*paper_ids, *params]


def _report_judgment_condition(alias: str = "j") -> str:
    return (
        f"{alias}.relation_type IN ('direct', 'indirect') "
        f"AND {alias}.suggested_action != 'ignore' "
        f"AND {alias}.confidence >= ? "
        f"AND {alias}.usefulness_score >= ?"
    )


def _resolve_daily_report_path(settings: Settings, report_date: str) -> tuple[Path, str]:
    if not settings.obsidian_vault_path:
        raise RuntimeError("Obsidian vault path is not configured")
    vault = settings.obsidian_vault_path.expanduser().resolve()
    if not vault.exists() or not vault.is_dir():
        raise RuntimeError("Obsidian vault path does not exist")
    relative = DAILY_REPORT_DIR / f"{_safe_filename(report_date)}.md"
    target = (vault / relative).resolve()
    try:
        rel_path = target.relative_to(vault).as_posix()
    except ValueError as exc:
        raise RuntimeError("Daily report path must be inside the configured vault") from exc
    return target, rel_path


def _daily_report_relative_path(report_date: str) -> str:
    return (DAILY_REPORT_DIR / f"{_safe_filename(report_date)}.md").as_posix()


def _project_match_rows(
    conn: DbConnection,
    paper_ids: list[int] | None,
    limit: int,
) -> list[DbRow]:
    where, params = _paper_filter(
        paper_ids,
        "p",
        [_report_judgment_condition("j"), run_daily_project_status_sql("rp")],
        [PROJECT_JUDGMENT_REPORT_CONFIDENCE_THRESHOLD, PROJECT_JUDGMENT_REPORT_USEFULNESS_THRESHOLD],
    )
    return conn.execute(
        f"""
        SELECT
          ppm.project_id,
          ppm.paper_id,
          ppm.score,
          ppm.rank_score,
          COALESCE(NULLIF(ppm.quality_score, 0), ppm.score) AS quality_score,
          ppm.updated_at AS match_updated_at,
          p.arxiv_id,
          p.title AS paper_title,
          p.summary,
          p.link,
          p.published_at,
          p.categories_json,
          p.text_status,
          ac.page_start,
          ac.page_end,
          ac.text AS arxiv_text,
          c.heading AS obsidian_heading,
          c.text AS obsidian_text,
          n.title AS note_title,
          n.path AS note_path,
          rp.name AS project_name,
          rp.status AS project_status,
          rp.obsidian_project_path,
          rp.obsidian_folder,
          j.relation_type,
          j.relevance_score,
          j.usefulness_score,
          j.confidence,
          j.suggested_action,
          j.reason AS judgment_reason,
          j.evidence_mapping_json,
          j.missing_evidence
        FROM project_paper_matches ppm
        JOIN arxiv_papers p ON p.id = ppm.paper_id
        JOIN research_projects rp ON rp.id = ppm.project_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = ppm.best_arxiv_chunk_id
        LEFT JOIN research_chunks c ON c.id = ppm.best_obsidian_chunk_id
        LEFT JOIN obsidian_notes n ON n.id = c.note_id
        JOIN project_paper_judgments j
          ON j.project_id = ppm.project_id AND j.paper_id = p.id
        {where}
        ORDER BY
          CASE j.relation_type WHEN 'direct' THEN 0 ELSE 1 END,
          j.usefulness_score DESC,
          j.confidence DESC,
          quality_score DESC,
          ppm.updated_at DESC
        LIMIT ?
        """,
        (*params, limit),
    ).fetchall()


def _global_match_rows(
    conn: DbConnection,
    paper_ids: list[int] | None,
    limit: int,
) -> list[DbRow]:
    return []


def _frontmatter(report_date: str) -> str:
    return "\n".join(
        [
            "---",
            f"title: {report_date} 科研情报日报",
            f"date: {report_date}",
            f"generated_at: {utc_now()}",
            "source: research_intelligence_system",
            "tags:",
            "  - research/daily-report",
            "---",
            "",
        ]
    )


def _strip_markdown_fence(value: str) -> str:
    text = clean_unicode(value).strip()
    if not text.startswith("```"):
        return text
    text = re.sub(r"^```(?:markdown|md)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _strip_frontmatter(value: str) -> str:
    text = value.strip()
    if not text.startswith("---"):
        return text
    parts = text.split("---", 2)
    if len(parts) == 3:
        return parts[2].strip()
    return text


def _normalize_llm_markdown(value: object, report_date: str) -> str:
    body = _strip_frontmatter(_strip_markdown_fence(str(value or ""))).strip()
    if not body:
        return ""
    if not body.startswith("#"):
        body = f"# {report_date} 科研情报日报\n\n{body}"
    if "## 今日结论" not in body:
        body = body.replace("\n", "\n\n", 1) if "\n" in body else f"{body}\n\n"
        body += "\n\n## 今日结论\n\n见上文摘要。"
    return clean_unicode(body.rstrip() + "\n")


def _paper_link_entries(payload: dict[str, object]) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    seen: set[str] = set()
    for key in ("project_candidates", "global_recommendations"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            arxiv_id = clean_unicode(str(item.get("arxiv_id") or "")).strip()
            if not arxiv_id or arxiv_id in seen:
                continue
            link = clean_unicode(str(item.get("link") or "")).strip() or f"https://arxiv.org/abs/{arxiv_id}"
            title = clean_unicode(str(item.get("title") or "")).strip()
            entries.append({"arxiv_id": arxiv_id, "link": link, "title": title})
            seen.add(arxiv_id)
    return entries


def _inject_arxiv_link_after_title(body: str, title: str, link_text: str) -> tuple[str, bool]:
    if not title:
        return body, False
    escaped = re.escape(title)
    patterns = [
        re.compile(rf"(\*\*{escaped}\*\*)"),
        re.compile(rf"(#{1,6}\s+{escaped})"),
        re.compile(rf"({escaped})"),
    ]
    for pattern in patterns:
        next_body, count = pattern.subn(lambda match: f"{match.group(1)} {link_text}", body, count=1)
        if count:
            return next_body, True
    return body, False


def _ensure_arxiv_links(body: str, payload: dict[str, object]) -> str:
    if not body.strip():
        return ""
    missing: list[dict[str, str]] = []
    for entry in _paper_link_entries(payload):
        arxiv_id = entry["arxiv_id"]
        link = entry["link"]
        link_text = f"[{arxiv_id}]({link})"
        if link in body or link_text in body:
            continue

        id_pattern = re.compile(
            rf"(?<![\w./-])(?:arXiv:\s*)?{re.escape(arxiv_id)}(?![\w./-])",
            flags=re.IGNORECASE,
        )
        next_body, count = id_pattern.subn(link_text, body, count=1)
        if count:
            body = next_body
            continue

        body, injected = _inject_arxiv_link_after_title(body, entry["title"], link_text)
        if not injected:
            missing.append(entry)

    if missing:
        lines = ["", "## arXiv 链接"]
        for entry in missing:
            title = f" - {entry['title']}" if entry["title"] else ""
            lines.append(f"- [{entry['arxiv_id']}]({entry['link']}){title}")
        body = body.rstrip() + "\n" + "\n".join(lines) + "\n"
    return clean_unicode(body.rstrip() + "\n")


def _project_payload(row: DbRow) -> dict[str, object]:
    return {
        "project": row["project_name"],
        "project_status": row["project_status"],
        "arxiv_id": row["arxiv_id"],
        "title": row["paper_title"],
        "link": row["link"],
        "published_at": row["published_at"],
        "retrieval_quality": round(_float(row["quality_score"]), 4),
        "rank_score": round(_float(row["rank_score"]), 4),
        "relation_type": row["relation_type"],
        "relevance_score": round(_float(row["relevance_score"]), 4),
        "usefulness_score": round(_float(row["usefulness_score"]), 4),
        "judgment_confidence": round(_float(row["confidence"]), 4),
        "suggested_action": row["suggested_action"] or "read_later",
        "judgment_reason": _short(row["judgment_reason"], 900),
        "evidence_mapping": from_json(row["evidence_mapping_json"], []),
        "missing_evidence": _short(row["missing_evidence"], 700),
        "paper_evidence": _short(row["arxiv_text"], 700),
        "project_evidence": _short(row["obsidian_text"], 700),
        "project_note_path": row["note_path"],
    }


def _global_payload(row: DbRow) -> dict[str, object]:
    return {
        "arxiv_id": row["arxiv_id"],
        "title": row["paper_title"],
        "link": row["link"],
        "published_at": row["published_at"],
        "categories": from_json(row["categories_json"], []),
        "match_score": round(_float(row["score"]), 4),
    }


def _report_source_payload(
    report_date: str,
    rel_path: str,
    stats: dict[str, Any],
    project_rows: list[DbRow],
    global_rows: list[DbRow],
) -> dict[str, object]:
    project_paper_ids = {int(row["paper_id"]) for row in project_rows}
    global_payload = [
        _global_payload(row)
        for row in global_rows
        if int(row["paper_id"]) not in project_paper_ids
    ]
    return {
        "date": report_date,
        "report_path": rel_path,
        "pipeline_stats": clean_unicode(stats),
        "project_candidates": [_project_payload(row) for row in project_rows],
        "global_recommendations": global_payload,
        "counts": {
            "project_candidates": len(project_rows),
            "global_recommendations": len(global_payload),
        },
    }


def _llm_report_prompt(payload: dict[str, object]) -> str:
    return f"""
只返回 JSON，不要 Markdown fence，不要额外解释。
JSON schema: {{"markdown": "...完整 Markdown 正文..."}}

你是科研情报编辑，也是研究助理。请基于下面已经通过项目级 LLM 判定的候选论文、项目证据、论文证据和流程指标，生成一篇中文科研情报日报。
目标不是列清单，而是让读者快速理解：今天有哪些论文值得投入注意力、为什么和现有项目有关、具体能怎么用、还需要验证什么。

硬性要求：
- markdown 字段必须是一篇完整 Markdown 正文，不要包含 YAML frontmatter。
- 使用中文撰写；论文标题可以保留英文。
- 事实只能来自输入 JSON；不要编造 arXiv ID、链接、项目名、分数或不存在的论文。
- 每篇论文第一次出现时必须带 arXiv 链接，使用输入 JSON 的 link 字段，格式为 [arXivID](URL)。
- 按项目组织“项目候选论文”；每个项目下，每篇候选论文写成一个自然段，不要用脚本式字段堆砌。
- 项目候选论文已经由 project_paper_judgments 判定通过；不得把 relation_type、confidence、usefulness_score 改写成更强的结论。
- 每篇项目候选论文都必须解释清楚 5 件事：一句话结论、项目级判定认为它为什么相关、论文里具体可借鉴的机制/方法/实验、可以落到项目里的下一步动作、主要不确定性或 missing_evidence。
- 每篇项目候选论文段落建议 120-220 个中文字符；候选很多时可以压缩，但不能只写标题、分数或一句“值得关注”。
- 不要直接复述 judgment_reason；要综合 judgment_reason、evidence_mapping、paper_evidence、project_evidence，写成读者能理解的判断。
- 如果 paper_evidence 或 project_evidence 不足，要明确说“证据不足在哪里”，不要用确定语气。
- 对已归入项目的论文，不要在“全局推荐”里重复展开。
- 全局推荐只写输入 JSON 中 global_recommendations 提供的论文；没有输入时说明本次不做全局补充。
- 如果候选很多，仍要覆盖输入中的项目候选；可以用更紧凑的自然段，但不要只给标题列表。
- 把流程指标放在靠后的“流程状态”部分，不能压过正文。
- “重点优先级”不要只排序，要解释优先级原因：项目相关度、可行动性、证据强度、时间敏感性。
- “今日忽略/过滤情况”要用通俗语言说明低于项目级判定阈值的论文不会进入日报；没有相关输入时简短说明即可。
- “下一步动作”要具体到可执行动作，例如阅读哪篇的哪些部分、把哪条想法写入哪个项目、需要补充什么验证。
- 术语可以保留英文，但第一次出现时尽量用中文解释其作用。
- 避免重复模板句、空泛判断和机械字段名；不要写“该论文具有重要意义”这类无信息量句子。
- 不要输出“暂无流程指标”，除非 pipeline_stats 为空。

建议结构：
# <日期> 科研情报日报
## 今日结论
## 重点优先级
## 按项目候选论文
### [[项目名]]
每篇论文一段。
## 全局补充推荐
## 今日忽略/过滤情况
## 流程状态
## 下一步动作

输入 JSON：
{to_json(payload)}
""".strip()


def _llm_daily_report_markdown(
    settings: Settings,
    report_date: str,
    rel_path: str,
    stats: dict[str, Any],
    project_rows: list[DbRow],
    global_rows: list[DbRow],
) -> str:
    provider = settings.chat_provider()
    if not provider or not provider.api_key or not provider.base_url or not settings.llm_chat_model:
        raise RuntimeError("LLM chat provider is not fully configured; daily report generation requires LLM output")
    payload = _report_source_payload(report_date, rel_path, stats, project_rows, global_rows)
    try:
        response = call_chat_json(
            settings,
            _llm_report_prompt(payload),
            system="你是严谨的中文科研情报编辑，只根据输入事实生成可读 Markdown 日报。",
            response_format={"type": "json_object"},
            timeout_seconds=DAILY_REPORT_LLM_TIMEOUT_SECONDS,
            raise_errors=True,
        )
    except ChatJsonError as exc:
        raise RuntimeError(f"LLM daily report generation failed: {exc}") from exc
    if not isinstance(response, dict):
        raise RuntimeError("LLM daily report generation failed: no valid JSON response")
    body = _ensure_arxiv_links(_normalize_llm_markdown(response.get("markdown"), report_date), payload)
    if not body:
        raise RuntimeError("LLM daily report generation failed: response missing non-empty markdown")
    return body


def generate_daily_report(
    conn: DbConnection,
    settings: Settings,
    stats: dict[str, Any] | None = None,
    paper_ids: list[int] | None = None,
    limit: int | None = None,
    export_to_obsidian: bool | None = None,
) -> dict[str, object]:
    stats = clean_unicode(stats or {})
    report_date = date.today().isoformat()
    row_limit = limit or DAILY_REPORT_LIMIT
    project_rows = _project_match_rows(conn, paper_ids, row_limit)
    global_rows = _global_match_rows(conn, paper_ids, row_limit)
    rel_path = _daily_report_relative_path(report_date)
    body = _llm_daily_report_markdown(
        settings,
        report_date,
        rel_path,
        stats,
        project_rows,
        global_rows,
    )
    source_payload = _report_source_payload(report_date, rel_path, stats, project_rows, global_rows)
    artifact = upsert_artifact(
        conn,
        scope_type="system",
        scope_id=None,
        artifact_type="daily_report",
        title=f"{report_date} 科研情报日报",
        content_markdown=body,
        content_json={"frontmatter": {"date": report_date, "source": "research_intelligence_system"}},
        status="ready",
        source_json=source_payload,
        source_key=f"daily_report:{report_date}",
        model_provider_id=settings.llm_chat_provider_id,
        model=settings.llm_chat_model,
        input_hash=content_hash(body, source_payload),
    )
    exported_path = ""
    export_enabled = (
        bool(settings.obsidian_vault_path) or obsidian_remote_enabled(settings)
        if export_to_obsidian is None
        else bool(export_to_obsidian)
    )
    if export_enabled:
        try:
            exported = export_artifact_to_obsidian(conn, settings, int(artifact["id"]), relative_path=rel_path)
            exported_path = str(exported.get("path") or "")
        except RuntimeError:
            if export_to_obsidian:
                raise
    return {
        "reports_considered": len(project_rows) + len(global_rows),
        "reports_created": 1,
        "reports_failed": 0,
        "daily_reports_created": 1,
        "daily_report_artifact_id": int(artifact["id"]),
        "daily_report_path": exported_path,
        "daily_report_exported": bool(exported_path),
        "daily_report_mode": "llm",
        "daily_report_project_matches": len(project_rows),
        "daily_report_global_papers": len(global_rows),
    }
