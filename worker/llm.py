from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.request

from .config import Settings
from .db import from_json, to_json, utc_now


EXPLANATION_REPORT_CONFIDENCE_THRESHOLD = 0.35


def _fallback_explanation(paper: sqlite3.Row, evidence: list[sqlite3.Row]) -> dict[str, object]:
    top = evidence[0] if evidence else None
    reason = "Evidence-only match. Configure an LLM provider to generate an explanation."
    if top:
        reason = f"Matches prior notes in {top['note_title']} through overlapping research terms and concepts."
    confidence = float(top["score"]) if top else 0.0
    action = "read" if confidence >= 0.75 else "read_later"
    return {
        "recommendation_reason": reason,
        "relevant_points": [],
        "evidence_refs": [int(row["chunk_id"]) for row in evidence],
        "confidence": confidence,
        "suggested_action": action,
        "raw": {"mode": "fallback"},
    }


def _prompt(paper: sqlite3.Row, evidence: list[sqlite3.Row]) -> str:
    evidence_text = "\n\n".join(
        "\n".join(
            [
                f"[obsidian:{row['chunk_id']}] {row['note_title']} ({row['note_path']}): {row['text'][:900]}",
                f"[paper_chunk:{row['arxiv_chunk_id']}] pages {row['arxiv_page_start'] or '?'}-{row['arxiv_page_end'] or '?'}: {(row['arxiv_text'] or '')[:900]}",
            ]
        )
        for row in evidence
    )
    return f"""
只返回 JSON，不要 Markdown，不要额外解释。
JSON keys must be exactly: recommendation_reason, relevant_points, evidence_refs, confidence, suggested_action.
JSON 字段名保持英文，但所有可读文本字段值必须使用中文。
recommendation_reason 必须是 1-3 句中文，说明这篇论文为什么对研究笔记/项目有用，或为什么证据不足。
relevant_points 必须是中文短语数组，例如 ["检索规划", "证据选择"]。
evidence_refs 必须是相关 obsidian chunk id 的数字数组。
confidence 必须是 0 到 1 之间的 JSON number，例如 0.72；不要返回字符串或 low/medium/moderate/high。
suggested_action 必须是 read, read_later, ignore 之一。
当证据弱、泛泛相关或不可操作时，使用 suggested_action=ignore。
confidence 低于 {EXPLANATION_REPORT_CONFIDENCE_THRESHOLD:.2f} 的论文会被日报过滤。

Paper:
Title: {paper['title']}
Abstract: {paper['summary']}

Matched Obsidian evidence and paper chunks:
{evidence_text}
""".strip()


def _confidence_score(value: object, fallback: float = 0.0) -> float:
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
    score = fallback
    if isinstance(value, bool):
        score = 1.0 if value else 0.0
    elif isinstance(value, (int, float)):
        score = float(value)
    elif isinstance(value, str):
        text = value.strip().lower()
        if text in labels:
            score = labels[text]
        else:
            try:
                score = float(text.rstrip("%"))
                if text.endswith("%"):
                    score /= 100
            except ValueError:
                score = fallback
    return max(0.0, min(1.0, score))


def _suggested_action(value: object) -> str:
    action = str(value or "read_later").strip()
    if action not in {"read", "read_later", "ignore"}:
        return "read_later"
    return action


def explanation_passes_report_filter(confidence: object, suggested_action: object) -> bool:
    return (
        _suggested_action(suggested_action) != "ignore"
        and _confidence_score(confidence) >= EXPLANATION_REPORT_CONFIDENCE_THRESHOLD
    )


def call_chat_json(
    settings: Settings,
    prompt: str,
    system: str = "You explain why arXiv papers are relevant to a researcher's notes.",
) -> dict[str, object] | None:
    provider = settings.chat_provider()
    if not provider or not provider.api_key or not provider.base_url or not settings.llm_chat_model:
        return None
    payload = {
        "model": settings.llm_chat_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
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
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None
    content = (
        body.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return None


def _call_chat(settings: Settings, prompt: str) -> dict[str, object] | None:
    return call_chat_json(settings, prompt)


def generate_missing_explanations(conn: sqlite3.Connection, settings: Settings) -> dict[str, int]:
    papers = conn.execute(
        """
        SELECT DISTINCT p.*
        FROM arxiv_papers p
        LEFT JOIN llm_explanations e ON e.paper_id = p.id
        WHERE e.paper_id IS NULL
          AND (
            EXISTS (SELECT 1 FROM matches m WHERE m.paper_id = p.id)
            OR EXISTS (SELECT 1 FROM project_paper_matches ppm WHERE ppm.paper_id = p.id)
          )
        ORDER BY p.published_at DESC
        """
    ).fetchall()
    created = 0
    filtered = 0
    for paper in papers:
        evidence = conn.execute(
            """
            SELECT *
            FROM (
              SELECT
                m.chunk_id,
                m.arxiv_chunk_id,
                m.score,
                m.searchers_json,
                ac.page_start AS arxiv_page_start,
                ac.page_end AS arxiv_page_end,
                ac.text AS arxiv_text,
                c.text,
                n.title AS note_title,
                n.path AS note_path
              FROM matches m
              JOIN research_chunks c ON c.id = m.chunk_id
              JOIN obsidian_notes n ON n.id = c.note_id
              LEFT JOIN arxiv_text_chunks ac ON ac.id = m.arxiv_chunk_id
              WHERE m.paper_id = ?

              UNION ALL

              SELECT
                ppm.best_obsidian_chunk_id AS chunk_id,
                ppm.best_arxiv_chunk_id AS arxiv_chunk_id,
                ppm.score,
                ppm.searchers_json,
                ac.page_start AS arxiv_page_start,
                ac.page_end AS arxiv_page_end,
                ac.text AS arxiv_text,
                c.text,
                n.title AS note_title,
                n.path AS note_path
              FROM project_paper_matches ppm
              JOIN research_chunks c ON c.id = ppm.best_obsidian_chunk_id
              JOIN obsidian_notes n ON n.id = c.note_id
              LEFT JOIN arxiv_text_chunks ac ON ac.id = ppm.best_arxiv_chunk_id
              WHERE ppm.paper_id = ?
            )
            ORDER BY score DESC
            LIMIT ?
            """,
            (int(paper["id"]), int(paper["id"]), settings.rag_top_k),
        ).fetchall()
        explanation = _call_chat(settings, _prompt(paper, evidence))
        if not explanation:
            explanation = _fallback_explanation(paper, evidence)
        fallback_confidence = float(evidence[0]["score"]) if evidence else 0.0
        confidence = _confidence_score(explanation.get("confidence"), fallback_confidence)
        suggested_action = _suggested_action(explanation.get("suggested_action"))
        if not explanation_passes_report_filter(confidence, suggested_action):
            filtered += 1
        now = utc_now()
        conn.execute(
            """
            INSERT OR REPLACE INTO llm_explanations(
              paper_id, recommendation_reason, relevant_points_json, evidence_refs_json,
              confidence, suggested_action, raw_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(paper["id"]),
                str(explanation.get("recommendation_reason", "")),
                to_json(explanation.get("relevant_points", [])),
                to_json(explanation.get("evidence_refs", [])),
                confidence,
                suggested_action,
                to_json(explanation.get("raw", explanation)),
                now,
            ),
        )
        conn.commit()
        created += 1
    return {"explanations_created": created, "explanations_filtered": filtered}
