from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Any

from .config import Settings
from .db import clean_unicode, from_json, to_json, utc_now
from .llm import call_chat_json


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", clean_unicode(value)).strip(" .")
    return cleaned or "paper"


def _short(value: object, limit: int = 900) -> str:
    text = re.sub(r"\s+", " ", clean_unicode(str(value or ""))).strip()
    return text[:limit]


def _project_folder(project: sqlite3.Row) -> str:
    folder = str(project["obsidian_folder"] or project["obsidian_output_dir"] or "").strip("/\\")
    if folder:
        return folder.replace("\\", "/")
    path = str(project["obsidian_project_path"] or "").strip().replace("\\", "/")
    if "/" in path:
        return path.rsplit("/", 1)[0]
    return f"Projects/{_safe_filename(project['name'])}"


def _resolve_report_path(settings: Settings, project: sqlite3.Row, paper: sqlite3.Row) -> tuple[Path, str]:
    if not settings.obsidian_vault_path:
        raise RuntimeError("Obsidian vault path is not configured")
    vault = settings.obsidian_vault_path.expanduser().resolve()
    if not vault.exists() or not vault.is_dir():
        raise RuntimeError("Obsidian vault path does not exist")
    filename = f"{_safe_filename(str(paper['arxiv_id']))} - {_safe_filename(str(paper['title']))}.md"
    relative = Path(_project_folder(project)) / "Papers" / filename
    target = (vault / relative).resolve()
    try:
        rel_path = target.relative_to(vault).as_posix()
    except ValueError as exc:
        raise RuntimeError("Paper report path must be inside the configured vault") from exc
    return target, rel_path


def _report_rows(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT
          ppm.project_id,
          ppm.paper_id,
          ppm.score,
          ppm.best_arxiv_chunk_id,
          ppm.best_obsidian_chunk_id,
          ppm.evidence_json,
          ppm.updated_at AS match_updated_at,
          p.arxiv_id,
          p.title AS paper_title,
          p.summary,
          p.link,
          p.pdf_link,
          p.published_at,
          p.categories_json,
          ac.page_start,
          ac.page_end,
          ac.text AS arxiv_text,
          c.heading AS obsidian_heading,
          c.text AS obsidian_text,
          n.title AS note_title,
          n.path AS note_path,
          rp.name AS project_name,
          rp.status AS project_status,
          rp.goals,
          rp.summary AS project_summary,
          rp.keywords_json,
          rp.obsidian_project_path,
          rp.obsidian_output_dir,
          rp.obsidian_folder
        FROM project_paper_matches ppm
        JOIN arxiv_papers p ON p.id = ppm.paper_id
        JOIN research_projects rp ON rp.id = ppm.project_id
        LEFT JOIN arxiv_text_chunks ac ON ac.id = ppm.best_arxiv_chunk_id
        LEFT JOIN research_chunks c ON c.id = ppm.best_obsidian_chunk_id
        LEFT JOIN obsidian_notes n ON n.id = c.note_id
        LEFT JOIN project_artifacts pa
          ON pa.project_id = ppm.project_id
         AND pa.artifact_type = 'paper_usefulness_report'
         AND json_extract(pa.source_json, '$.paper_id') = ppm.paper_id
        WHERE pa.id IS NULL OR pa.updated_at < ppm.updated_at
        ORDER BY ppm.score DESC, ppm.updated_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def _prompt(row: sqlite3.Row) -> str:
    evidence = from_json(row["evidence_json"], {})
    return f"""
Return JSON only.
Keys:
- usefulness: one of useful, maybe, not_useful
- priority: one of high, medium, low
- confidence: number 0-1
- verdict: short Chinese conclusion
- usefulness_types: array, choose from 方法参考, 实验设计, baseline, related work, 数据集, 工具实现, 写作素材, 未来方向
- specific_uses: array of objects with keys area, explanation, paper_evidence, project_evidence, suggested_action
- uncertainties: array of Chinese strings
- recommended_actions: array of Chinese strings

Question:
这篇论文对我的研究有没有用？如果有用，具体有用在哪？

Project:
Name: {row['project_name']}
Status: {row['project_status']}
Summary: {row['project_summary']}
Goals: {row['goals']}
Keywords: {', '.join(from_json(row['keywords_json'], []))}
Center page: {row['obsidian_project_path']}

Paper:
arXiv: {row['arxiv_id']}
Title: {row['paper_title']}
Categories: {', '.join(from_json(row['categories_json'], []))}
Published: {row['published_at']}
Abstract: {_short(row['summary'], 1600)}

Matched paper evidence:
Pages: {row['page_start'] or '?'}-{row['page_end'] or '?'}
Text: {_short(row['arxiv_text'], 1600)}

Matched project evidence:
Note: {row['note_title']} ({row['note_path']})
Heading: {row['obsidian_heading']}
Text: {_short(row['obsidian_text'], 1600)}

Match metadata:
Score: {float(row['score'] or 0):.3f}
Evidence JSON: {_short(to_json(evidence), 1200)}

Rules:
- 不要泛泛总结论文。
- 每个 specific_use 必须同时说明论文证据和项目证据。
- 如果证据不足，usefulness 设为 maybe 或 not_useful，并解释缺什么。
""".strip()


def _fallback_judgment(row: sqlite3.Row) -> dict[str, Any]:
    score = float(row["score"] or 0)
    usefulness = "useful" if score >= 0.55 else "maybe"
    priority = "high" if score >= 0.75 else "medium" if score >= 0.45 else "low"
    return {
        "usefulness": usefulness,
        "priority": priority,
        "confidence": min(0.9, max(0.2, score)),
        "verdict": f"这篇论文可能对项目“{row['project_name']}”有用，主要依据是论文正文片段与项目笔记存在直接匹配。",
        "usefulness_types": ["方法参考", "related work"],
        "specific_uses": [
            {
                "area": "项目上下文匹配",
                "explanation": "系统检测到论文片段与项目笔记在方法或概念上相近，适合先作为候选阅读材料。",
                "paper_evidence": _short(row["arxiv_text"], 360),
                "project_evidence": _short(row["obsidian_text"], 360),
                "suggested_action": "阅读命中片段，确认是否应纳入核心文献或 related work。",
            }
        ],
        "uncertainties": ["未配置可用 LLM 时，报告只基于检索证据生成，判断较保守。"],
        "recommended_actions": ["阅读论文命中页附近内容", "与项目方法笔记对照后决定是否标为 core"],
        "raw": {"mode": "fallback"},
    }


def _normalize_judgment(value: dict[str, Any] | None, row: sqlite3.Row) -> dict[str, Any]:
    judgment = value or _fallback_judgment(row)
    fallback = _fallback_judgment(row)
    normalized = {**fallback, **{key: val for key, val in judgment.items() if val not in (None, "")}}
    if not isinstance(normalized.get("specific_uses"), list):
        normalized["specific_uses"] = fallback["specific_uses"]
    if not isinstance(normalized.get("uncertainties"), list):
        normalized["uncertainties"] = fallback["uncertainties"]
    if not isinstance(normalized.get("recommended_actions"), list):
        normalized["recommended_actions"] = fallback["recommended_actions"]
    if not isinstance(normalized.get("usefulness_types"), list):
        normalized["usefulness_types"] = fallback["usefulness_types"]
    return clean_unicode(normalized)


def _md_list(items: list[Any], empty: str = "无") -> list[str]:
    if not items:
        return [f"- {empty}"]
    return [f"- {clean_unicode(str(item))}" for item in items]


def _report_markdown(row: sqlite3.Row, judgment: dict[str, Any], rel_path: str) -> str:
    generated_at = utc_now()
    uses = judgment.get("specific_uses", [])
    lines = [
        "---",
        f"title: {_safe_filename(str(row['paper_title']))}",
        f"arxiv_id: {row['arxiv_id']}",
        f"project: {row['project_name']}",
        f"usefulness: {judgment.get('usefulness')}",
        f"priority: {judgment.get('priority')}",
        f"confidence: {float(judgment.get('confidence') or 0):.2f}",
        f"match_score: {float(row['score'] or 0):.3f}",
        f"generated_at: {generated_at}",
        "source: research_intelligence_system",
        "tags:",
        "  - paper/usefulness-report",
        "---",
        "",
        f"# {row['paper_title']}",
        "",
        "## 结论",
        "",
        f"- 判断: **{judgment.get('usefulness')}**",
        f"- 相关项目: [[{row['project_name']}]]",
        f"- 用途类型: {', '.join(str(item) for item in judgment.get('usefulness_types', []))}",
        f"- 优先级: {judgment.get('priority')}",
        f"- 置信度: {float(judgment.get('confidence') or 0):.2f}",
        f"- 匹配分数: {float(row['score'] or 0):.3f}",
        f"- 报告路径: `{rel_path}`",
        "",
        clean_unicode(str(judgment.get("verdict") or "")),
        "",
        "## 具体有用在哪",
        "",
    ]
    if uses:
        for index, item in enumerate(uses, start=1):
            if not isinstance(item, dict):
                continue
            lines.extend(
                [
                    f"### {index}. {clean_unicode(str(item.get('area') or '用途'))}",
                    "",
                    clean_unicode(str(item.get("explanation") or "")),
                    "",
                    f"- 论文证据: {clean_unicode(str(item.get('paper_evidence') or ''))}",
                    f"- 项目证据: {clean_unicode(str(item.get('project_evidence') or ''))}",
                    f"- 建议动作: {clean_unicode(str(item.get('suggested_action') or ''))}",
                    "",
                ]
            )
    else:
        lines.append("暂无可提取用途。")
        lines.append("")

    lines.extend(
        [
            "## 证据",
            "",
            "### 论文片段",
            "",
            f"- arXiv: [{row['arxiv_id']}]({row['link']})",
            f"- 页码: {row['page_start'] or '?'}-{row['page_end'] or '?'}",
            "",
            _short(row["arxiv_text"], 1200),
            "",
            "### 项目片段",
            "",
            f"- 笔记: `{row['note_path'] or ''}`",
            f"- 标题: {row['note_title'] or ''}",
            "",
            _short(row["obsidian_text"], 1200),
            "",
            "## 不确定点",
            "",
            *_md_list(list(judgment.get("uncertainties", []))),
            "",
            "## 建议动作",
            "",
            *_md_list(list(judgment.get("recommended_actions", []))),
            "",
        ]
    )
    return clean_unicode("\n".join(lines).rstrip() + "\n")


def generate_project_paper_reports(
    conn: sqlite3.Connection,
    settings: Settings,
    limit: int | None = None,
) -> dict[str, int]:
    if not settings.obsidian_vault_path:
        return {"reports_considered": 0, "reports_created": 0, "reports_skipped": 1}
    rows = _report_rows(conn, limit or settings.arxiv_max_results)
    created = 0
    failed = 0
    for row in rows:
        project = conn.execute("SELECT * FROM research_projects WHERE id = ?", (int(row["project_id"]),)).fetchone()
        paper = conn.execute("SELECT * FROM arxiv_papers WHERE id = ?", (int(row["paper_id"]),)).fetchone()
        if not project or not paper:
            continue
        try:
            target, rel_path = _resolve_report_path(settings, project, paper)
            judgment = _normalize_judgment(
                call_chat_json(
                    settings,
                    _prompt(row),
                    system="You generate evidence-grounded Chinese research usefulness reports for papers.",
                ),
                row,
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(_report_markdown(row, judgment, rel_path), encoding="utf-8")
            now = utc_now()
            conn.execute(
                """
                INSERT INTO project_artifacts(
                  project_id, artifact_type, title, obsidian_path, status, source_json, created_at, updated_at
                )
                VALUES (?, 'paper_usefulness_report', ?, ?, 'synced', ?, ?, ?)
                ON CONFLICT(project_id, artifact_type, obsidian_path) DO UPDATE SET
                  title = excluded.title,
                  status = excluded.status,
                  source_json = excluded.source_json,
                  updated_at = excluded.updated_at
                """,
                (
                    int(row["project_id"]),
                    str(row["paper_title"]),
                    rel_path,
                    to_json(
                        {
                            "paper_id": int(row["paper_id"]),
                            "arxiv_id": row["arxiv_id"],
                            "score": float(row["score"] or 0),
                            "judgment": judgment,
                        }
                    ),
                    now,
                    now,
                ),
            )
            conn.commit()
            created += 1
        except Exception as exc:
            failed += 1
            conn.execute(
                """
                INSERT INTO project_artifacts(
                  project_id, artifact_type, title, obsidian_path, status, source_json, created_at, updated_at
                )
                VALUES (?, 'paper_usefulness_report_error', ?, '', 'failed', ?, ?, ?)
                """,
                (
                    int(row["project_id"]),
                    str(row["paper_title"]),
                    to_json({"paper_id": int(row["paper_id"]), "error": str(exc)[:1000]}),
                    utc_now(),
                    utc_now(),
                ),
            )
            conn.commit()
    return {
        "reports_considered": len(rows),
        "reports_created": created,
        "reports_failed": failed,
    }
