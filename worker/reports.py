from __future__ import annotations

import re
import sqlite3
from datetime import date
from pathlib import Path
from typing import Any

from .config import Settings
from .db import clean_unicode, from_json, to_json, utc_now
from .llm import EXPLANATION_REPORT_CONFIDENCE_THRESHOLD, call_chat_json


DAILY_REPORT_DIR = Path("Research Intelligence") / "Daily"
DAILY_REPORT_LIMIT = 40


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


def _report_explanation_condition(alias: str = "e") -> str:
    return (
        f"({alias}.paper_id IS NULL OR "
        f"({alias}.suggested_action != 'ignore' AND {alias}.confidence >= ?))"
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


def _project_match_rows(
    conn: sqlite3.Connection,
    paper_ids: list[int] | None,
    limit: int,
) -> list[sqlite3.Row]:
    where, params = _paper_filter(
        paper_ids,
        "p",
        [_report_explanation_condition("e")],
        [EXPLANATION_REPORT_CONFIDENCE_THRESHOLD],
    )
    return conn.execute(
        f"""
        SELECT
          ppm.project_id,
          ppm.paper_id,
          ppm.score,
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
          e.recommendation_reason,
          e.relevant_points_json,
          e.suggested_action,
          e.confidence
        FROM project_paper_matches ppm
        JOIN arxiv_papers p ON p.id = ppm.paper_id
        JOIN research_projects rp ON rp.id = ppm.project_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = ppm.best_arxiv_chunk_id
        LEFT JOIN research_chunks c ON c.id = ppm.best_obsidian_chunk_id
        LEFT JOIN obsidian_notes n ON n.id = c.note_id
        LEFT JOIN llm_explanations e ON e.paper_id = p.id
        {where}
        ORDER BY ppm.score DESC, ppm.updated_at DESC
        LIMIT ?
        """,
        (*params, limit),
    ).fetchall()


def _global_match_rows(
    conn: sqlite3.Connection,
    paper_ids: list[int] | None,
    limit: int,
) -> list[sqlite3.Row]:
    where, params = _paper_filter(
        paper_ids,
        "p",
        [_report_explanation_condition("e")],
        [EXPLANATION_REPORT_CONFIDENCE_THRESHOLD],
    )
    return conn.execute(
        f"""
        SELECT
          p.id AS paper_id,
          p.arxiv_id,
          p.title AS paper_title,
          p.summary,
          p.link,
          p.published_at,
          p.categories_json,
          p.text_status,
          MAX(m.score) AS score,
          e.recommendation_reason,
          e.suggested_action,
          e.confidence
        FROM arxiv_papers p
        JOIN matches m ON m.paper_id = p.id
        LEFT JOIN llm_explanations e ON e.paper_id = p.id
        {where}
        GROUP BY p.id
        ORDER BY score DESC, p.published_at DESC
        LIMIT ?
        """,
        (*params, limit),
    ).fetchall()


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


def _project_payload(row: sqlite3.Row) -> dict[str, object]:
    return {
        "project": row["project_name"],
        "project_status": row["project_status"],
        "arxiv_id": row["arxiv_id"],
        "title": row["paper_title"],
        "link": row["link"],
        "published_at": row["published_at"],
        "match_score": round(_float(row["score"]), 4),
        "explanation_confidence": round(_float(row["confidence"]), 4),
        "suggested_action": row["suggested_action"] or "read_later",
        "recommendation_reason": _short(row["recommendation_reason"], 700),
        "relevant_points": from_json(row["relevant_points_json"], []),
        "paper_evidence": _short(row["arxiv_text"], 700),
        "project_evidence": _short(row["obsidian_text"], 700),
        "project_note_path": row["note_path"],
    }


def _global_payload(row: sqlite3.Row) -> dict[str, object]:
    return {
        "arxiv_id": row["arxiv_id"],
        "title": row["paper_title"],
        "link": row["link"],
        "published_at": row["published_at"],
        "categories": from_json(row["categories_json"], []),
        "match_score": round(_float(row["score"]), 4),
        "explanation_confidence": round(_float(row["confidence"]), 4),
        "suggested_action": row["suggested_action"] or "read_later",
        "recommendation_reason": _short(row["recommendation_reason"], 700),
    }


def _report_source_payload(
    report_date: str,
    rel_path: str,
    stats: dict[str, Any],
    project_rows: list[sqlite3.Row],
    global_rows: list[sqlite3.Row],
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

你是科研情报编辑，也是研究助理。请基于下面所有候选论文解读、项目证据、论文证据和流程指标，生成一篇中文科研情报日报。
目标不是列清单，而是让读者快速理解：今天有哪些论文值得投入注意力、为什么和现有项目有关、具体能怎么用、还需要验证什么。

硬性要求：
- markdown 字段必须是一篇完整 Markdown 正文，不要包含 YAML frontmatter。
- 使用中文撰写；论文标题可以保留英文。
- 事实只能来自输入 JSON；不要编造 arXiv ID、链接、项目名、分数或不存在的论文。
- 保留每篇论文的 arXiv 链接，格式可用 [arXivID](URL)。
- 按项目组织“项目候选论文”；每个项目下，每篇候选论文写成一个自然段，不要用脚本式字段堆砌。
- 每篇项目候选论文都必须解释清楚 5 件事：一句话结论、为什么它和项目相关、论文里具体可借鉴的机制/方法/实验、可以落到项目里的下一步动作、主要不确定性或需要复核的证据。
- 每篇项目候选论文段落建议 120-220 个中文字符；候选很多时可以压缩，但不能只写标题、分数或一句“值得关注”。
- 不要直接复述 recommendation_reason；要综合 recommendation_reason、relevant_points、paper_evidence、project_evidence，写成读者能理解的判断。
- 如果 paper_evidence 或 project_evidence 不足，要明确说“证据不足在哪里”，不要用确定语气。
- 对已归入项目的论文，不要在“全局推荐”里重复展开。
- 全局推荐只写没有明确项目归属但值得注意的论文；每篇也要用 2-3 句说明主题、潜在价值和为什么暂时没有明确项目归属。
- 如果候选很多，仍要覆盖输入中的项目候选；可以用更紧凑的自然段，但不要只给标题列表。
- 把流程指标放在靠后的“流程状态”部分，不能压过正文。
- “重点优先级”不要只排序，要解释优先级原因：项目相关度、可行动性、证据强度、时间敏感性。
- “今日忽略/过滤情况”要用通俗语言说明哪些论文/解释被筛掉，以及筛掉依据；没有相关输入时简短说明即可。
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
    project_rows: list[sqlite3.Row],
    global_rows: list[sqlite3.Row],
) -> str:
    provider = settings.chat_provider()
    if not provider or not provider.api_key or not provider.base_url or not settings.llm_chat_model:
        raise RuntimeError("LLM chat provider is not fully configured; daily report generation requires LLM output")
    payload = _report_source_payload(report_date, rel_path, stats, project_rows, global_rows)
    response = call_chat_json(
        settings,
        _llm_report_prompt(payload),
        system="你是严谨的中文科研情报编辑，只根据输入事实生成可读 Markdown 日报。",
    )
    if not isinstance(response, dict):
        raise RuntimeError("LLM daily report generation failed: no valid JSON response")
    body = _normalize_llm_markdown(response.get("markdown"), report_date)
    if not body:
        raise RuntimeError("LLM daily report generation failed: response missing non-empty markdown")
    return body


def generate_daily_report(
    conn: sqlite3.Connection,
    settings: Settings,
    stats: dict[str, Any] | None = None,
    paper_ids: list[int] | None = None,
    limit: int | None = None,
) -> dict[str, object]:
    if not settings.obsidian_vault_path:
        raise RuntimeError("Obsidian vault path is not configured")
    stats = clean_unicode(stats or {})
    report_date = date.today().isoformat()
    row_limit = limit or DAILY_REPORT_LIMIT
    project_rows = _project_match_rows(conn, paper_ids, row_limit)
    global_rows = _global_match_rows(conn, paper_ids, row_limit)
    target, rel_path = _resolve_daily_report_path(settings, report_date)
    body = _llm_daily_report_markdown(
        settings,
        report_date,
        rel_path,
        stats,
        project_rows,
        global_rows,
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_frontmatter(report_date) + body, encoding="utf-8")
    return {
        "reports_considered": len(project_rows) + len(global_rows),
        "reports_created": 1,
        "reports_failed": 0,
        "daily_reports_created": 1,
        "daily_report_path": rel_path,
        "daily_report_mode": "llm",
        "daily_report_project_matches": len(project_rows),
        "daily_report_global_papers": len(global_rows),
    }
