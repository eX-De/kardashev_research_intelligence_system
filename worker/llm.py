from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.request

from .config import Settings
from .db import from_json, to_json, utc_now


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
Return JSON with keys recommendation_reason, relevant_points, evidence_refs, confidence, suggested_action.
suggested_action must be one of read, read_later, ignore.

Paper:
Title: {paper['title']}
Abstract: {paper['summary']}

Matched Obsidian evidence and paper chunks:
{evidence_text}
""".strip()


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
        JOIN matches m ON m.paper_id = p.id
        LEFT JOIN llm_explanations e ON e.paper_id = p.id
        WHERE e.paper_id IS NULL
        ORDER BY p.published_at DESC
        """
    ).fetchall()
    created = 0
    for paper in papers:
        evidence = conn.execute(
            """
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
            ORDER BY m.score DESC
            LIMIT ?
            """,
            (int(paper["id"]), settings.rag_top_k),
        ).fetchall()
        explanation = _call_chat(settings, _prompt(paper, evidence))
        if not explanation:
            explanation = _fallback_explanation(paper, evidence)
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
                float(explanation.get("confidence", 0) or 0),
                str(explanation.get("suggested_action", "read_later")),
                to_json(explanation.get("raw", explanation)),
                now,
            ),
        )
        conn.commit()
        created += 1
    return {"explanations_created": created}
