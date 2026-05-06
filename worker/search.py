from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from dataclasses import dataclass

from .config import Settings
from .arxiv_text import ensure_arxiv_chunks
from .db import from_json, to_json, utc_now
from .embeddings import (
    cosine,
    embed_text,
    ensure_arxiv_chunk_embedding,
    ensure_arxiv_paper_embedding,
    ensure_missing_arxiv_chunk_embeddings,
)

TOKEN_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_\-]{2,}")
STOPWORDS = {
    "and",
    "are",
    "for",
    "from",
    "into",
    "that",
    "the",
    "this",
    "with",
    "using",
    "towards",
    "their",
    "they",
    "have",
    "has",
    "our",
    "can",
    "will",
}


@dataclass
class SearchHit:
    chunk_id: int
    score: float
    searcher: str


def tokenize(text: str) -> list[str]:
    tokens = [match.group(0).lower() for match in TOKEN_PATTERN.finditer(text)]
    return [token for token in tokens if token not in STOPWORDS]


def _chunk_id_set(chunk_ids: set[int] | list[int] | tuple[int, ...] | None) -> set[int] | None:
    if chunk_ids is None:
        return None
    return {int(chunk_id) for chunk_id in chunk_ids}


def _chunks(
    conn: sqlite3.Connection,
    chunk_ids: set[int] | list[int] | tuple[int, ...] | None = None,
) -> list[sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT c.id, c.chunk_index, c.heading, c.text, n.title AS note_title, n.path AS note_path
        FROM research_chunks c
        JOIN obsidian_notes n ON n.id = c.note_id
        """
    ).fetchall()
    allowed = _chunk_id_set(chunk_ids)
    if allowed is None:
        return rows
    return [row for row in rows if int(row["id"]) in allowed]


def keyword_search(
    conn: sqlite3.Connection,
    query: str,
    chunk_ids: set[int] | list[int] | tuple[int, ...] | None = None,
) -> list[SearchHit]:
    query_terms = set(tokenize(query))
    if not query_terms:
        return []
    hits: list[SearchHit] = []
    for chunk in _chunks(conn, chunk_ids):
        chunk_terms = set(tokenize(f"{chunk['heading']} {chunk['text']}"))
        overlap = query_terms & chunk_terms
        if not overlap:
            continue
        score = len(overlap) / max(len(query_terms), 1)
        hits.append(SearchHit(int(chunk["id"]), score, "keyword_search"))
    return sorted(hits, key=lambda hit: hit.score, reverse=True)


def front_page_search(
    conn: sqlite3.Connection,
    query: str,
    chunk_ids: set[int] | list[int] | tuple[int, ...] | None = None,
) -> list[SearchHit]:
    query_terms = set(tokenize(query))
    if not query_terms:
        return []
    hits: list[SearchHit] = []
    for chunk in _chunks(conn, chunk_ids):
        if int(chunk["chunk_index"]) > 4:
            continue
        chunk_terms = set(tokenize(f"{chunk['heading']} {chunk['text']}"))
        overlap = query_terms & chunk_terms
        if not overlap:
            continue
        position_bonus = 1.0 / (1 + int(chunk["chunk_index"]))
        score = (len(overlap) / max(len(query_terms), 1)) * 0.7 + position_bonus * 0.3
        hits.append(SearchHit(int(chunk["id"]), score, "front_page_search"))
    return sorted(hits, key=lambda hit: hit.score, reverse=True)


def embedding_search(
    conn: sqlite3.Connection,
    settings: Settings,
    query: str,
    chunk_ids: set[int] | list[int] | tuple[int, ...] | None = None,
) -> list[SearchHit]:
    query_embedding = embed_text(settings, query)
    if query_embedding is None:
        return []
    return embedding_search_with_vector(conn, query_embedding, chunk_ids)


def embedding_search_with_vector(
    conn: sqlite3.Connection,
    query_embedding: list[float],
    chunk_ids: set[int] | list[int] | tuple[int, ...] | None = None,
) -> list[SearchHit]:
    if not query_embedding:
        return []
    allowed = _chunk_id_set(chunk_ids)
    rows = conn.execute("SELECT chunk_id, embedding_json FROM chunk_embeddings").fetchall()
    hits: list[SearchHit] = []
    for row in rows:
        if allowed is not None and int(row["chunk_id"]) not in allowed:
            continue
        embedding = from_json(row["embedding_json"], [])
        if not embedding:
            continue
        score = max(0.0, cosine(query_embedding, [float(value) for value in embedding]))
        if score > 0:
            hits.append(SearchHit(int(row["chunk_id"]), score, "embedding_search"))
    return sorted(hits, key=lambda hit: hit.score, reverse=True)


def hybrid_search(conn: sqlite3.Connection, settings: Settings, query: str, top_k: int) -> list[dict[str, object]]:
    return hybrid_search_with_embedding(conn, settings, query, top_k, None)


def hybrid_search_with_embedding(
    conn: sqlite3.Connection,
    settings: Settings,
    query: str,
    top_k: int,
    query_embedding: list[float] | None,
    chunk_ids: set[int] | list[int] | tuple[int, ...] | None = None,
) -> list[dict[str, object]]:
    searcher_hits: list[list[SearchHit]] = []
    for searcher in settings.rag_searchers:
        if searcher == "embedding_search":
            if query_embedding is not None:
                searcher_hits.append(embedding_search_with_vector(conn, query_embedding, chunk_ids))
            else:
                searcher_hits.append(embedding_search(conn, settings, query, chunk_ids))
        elif searcher == "keyword_search":
            searcher_hits.append(keyword_search(conn, query, chunk_ids))
        elif searcher == "front_page_search":
            searcher_hits.append(front_page_search(conn, query, chunk_ids))

    fused: dict[int, float] = defaultdict(float)
    details: dict[int, list[dict[str, object]]] = defaultdict(list)
    for hits in searcher_hits:
        for rank, hit in enumerate(hits, start=1):
            fused[hit.chunk_id] += 1.0 / (60 + rank)
            details[hit.chunk_id].append(
                {"searcher": hit.searcher, "raw_score": round(hit.score, 6), "rank": rank}
            )

    if not fused:
        return []
    max_score = max(fused.values()) or 1.0
    ranked = sorted(fused.items(), key=lambda item: item[1], reverse=True)[:top_k]
    return [
        {
            "chunk_id": chunk_id,
            "score": fused_score / max_score,
            "searchers": sorted({detail["searcher"] for detail in details[chunk_id]}),
            "details": details[chunk_id],
        }
        for chunk_id, fused_score in ranked
    ]


def _project_chunk_ids(conn: sqlite3.Connection, project_id: int) -> set[int]:
    rows = conn.execute(
        """
        SELECT c.id
        FROM project_notes pn
        JOIN research_chunks c ON c.note_id = pn.note_id
        WHERE pn.project_id = ?
        """,
        (project_id,),
    ).fetchall()
    return {int(row["id"]) for row in rows}


def _project_match_evidence(hit: dict[str, object]) -> dict[str, object]:
    return {
        "search_details": hit["details"],
        "top_project_hits": hit.get("top_project_hits", []),
        "arxiv_chunk_index": hit["arxiv_chunk_index"],
        "arxiv_chunk_source": hit["arxiv_chunk_source"],
        "arxiv_page_start": hit["arxiv_page_start"],
        "arxiv_page_end": hit["arxiv_page_end"],
        "arxiv_text": str(hit["arxiv_text"])[:1600],
    }


def prefilter_papers(
    conn: sqlite3.Connection,
    settings: Settings,
    papers: list[sqlite3.Row],
) -> tuple[list[sqlite3.Row], dict[str, int]]:
    if not settings.rag_prefilter_enabled or "embedding_search" not in settings.rag_searchers:
        max_keep = max(0, settings.rag_prefilter_max_keep)
        selected = papers[:max_keep] if max_keep else papers
        return selected, {
            "prefilter_considered": len(papers),
            "prefilter_passed": len(selected),
            "prefilter_skipped": len(papers) - len(selected),
            "prefilter_fallback": 1,
            "prefilter_capped": 1 if max_keep and len(papers) > max_keep else 0,
        }

    scored: list[tuple[sqlite3.Row, float, list[dict[str, object]]]] = []
    fallback = False
    for paper in papers:
        embedding = ensure_arxiv_paper_embedding(conn, settings, paper)
        if embedding is None:
            fallback = True
            break
        hits = embedding_search_with_vector(conn, embedding)[: settings.rag_prefilter_top_k]
        if hits:
            top_score = max(hit.score for hit in hits)
        else:
            top_score = 0.0
        top_chunks = [
            {"chunk_id": hit.chunk_id, "score": round(hit.score, 6), "searcher": hit.searcher}
            for hit in hits[:5]
        ]
        scored.append((paper, top_score, top_chunks))

    if fallback:
        max_keep = max(0, settings.rag_prefilter_max_keep)
        selected = papers[:max_keep] if max_keep else papers
        return selected, {
            "prefilter_considered": len(papers),
            "prefilter_passed": len(selected),
            "prefilter_skipped": len(papers) - len(selected),
            "prefilter_fallback": 1,
            "prefilter_capped": 1 if max_keep and len(papers) > max_keep else 0,
        }

    scored.sort(key=lambda item: item[1], reverse=True)
    selected: list[sqlite3.Row] = []
    now = utc_now()
    min_keep = max(0, settings.rag_prefilter_min_keep)
    max_keep = max(0, settings.rag_prefilter_max_keep)
    capped = 0
    for rank, (paper, score, top_chunks) in enumerate(scored, start=1):
        would_pass = score >= settings.rag_prefilter_threshold or rank <= min_keep
        if would_pass and max_keep and len(selected) >= max_keep:
            passed = False
            reason = "max_keep"
            capped = 1
        else:
            passed = would_pass
            reason = "score" if score >= settings.rag_prefilter_threshold else "min_keep" if rank <= min_keep else "below_threshold"
        conn.execute(
            """
            INSERT INTO paper_prefilter_runs(
              paper_id, model, score, rank, passed, reason, top_chunks_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(paper["id"]),
                settings.llm_embedding_model,
                float(score),
                rank,
                1 if passed else 0,
                reason,
                to_json(top_chunks),
                now,
            ),
        )
        if passed:
            selected.append(paper)
    conn.commit()
    return selected, {
        "prefilter_considered": len(papers),
        "prefilter_passed": len(selected),
        "prefilter_skipped": len(papers) - len(selected),
        "prefilter_fallback": 0,
        "prefilter_capped": capped,
    }


def unmatched_papers(conn: sqlite3.Connection, limit: int | None = None) -> list[sqlite3.Row]:
    sql = """
        SELECT p.*
        FROM arxiv_papers p
        LEFT JOIN matches m ON m.paper_id = p.id
        WHERE m.id IS NULL OR m.arxiv_chunk_id IS NULL
        GROUP BY p.id
        ORDER BY p.published_at DESC
    """
    params: list[object] = []
    if limit:
        sql += " LIMIT ?"
        params.append(limit)
    return conn.execute(sql, params).fetchall()


def recent_papers(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT p.*
        FROM arxiv_papers p
        ORDER BY p.published_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def prefilter_recent_papers(
    conn: sqlite3.Connection,
    settings: Settings,
) -> tuple[list[sqlite3.Row], dict[str, int]]:
    return prefilter_papers(conn, settings, recent_papers(conn, settings.arxiv_max_results))


def rank_unmatched_papers(
    conn: sqlite3.Connection,
    settings: Settings,
    papers: list[sqlite3.Row] | None = None,
    prefilter_result: dict[str, int] | None = None,
) -> dict[str, int]:
    if papers is None:
        papers = unmatched_papers(conn)
        papers, prefilter_result = prefilter_papers(conn, settings, list(papers))
    paper_ids = [int(paper["id"]) for paper in papers]
    chunk_result = ensure_arxiv_chunks(conn, paper_ids=paper_ids)
    embedding_result = ensure_missing_arxiv_chunk_embeddings(conn, settings, paper_ids=paper_ids)
    prefilter_result = prefilter_result or {
        "prefilter_considered": len(papers),
        "prefilter_passed": len(papers),
        "prefilter_skipped": 0,
        "prefilter_fallback": 0,
    }
    matched_papers = 0
    matches_created = 0
    arxiv_chunks_scored = 0

    for paper in papers:
        arxiv_chunks = conn.execute(
            """
            SELECT id, chunk_index, source, page_start, page_end, text
            FROM arxiv_text_chunks
            WHERE paper_id = ?
            ORDER BY chunk_index
            """,
            (int(paper["id"]),),
        ).fetchall()
        best_by_obsidian_chunk: dict[int, dict[str, object]] = {}
        for arxiv_chunk in arxiv_chunks:
            arxiv_chunks_scored += 1
            query_embedding = ensure_arxiv_chunk_embedding(
                conn,
                settings,
                int(arxiv_chunk["id"]),
                arxiv_chunk["text"],
            )
            hits = hybrid_search_with_embedding(
                conn,
                settings,
                arxiv_chunk["text"],
                settings.rag_top_k,
                query_embedding,
            )
            for hit in hits:
                if float(hit["score"]) < settings.rag_score_threshold:
                    continue
                obsidian_chunk_id = int(hit["chunk_id"])
                previous = best_by_obsidian_chunk.get(obsidian_chunk_id)
                if previous and float(previous["score"]) >= float(hit["score"]):
                    continue
                best_by_obsidian_chunk[obsidian_chunk_id] = {
                    **hit,
                    "arxiv_chunk_id": int(arxiv_chunk["id"]),
                    "arxiv_chunk_index": int(arxiv_chunk["chunk_index"]),
                    "arxiv_chunk_source": arxiv_chunk["source"],
                    "arxiv_page_start": arxiv_chunk["page_start"],
                    "arxiv_page_end": arxiv_chunk["page_end"],
                    "arxiv_text": arxiv_chunk["text"],
                }
        ranked_hits = sorted(
            best_by_obsidian_chunk.values(),
            key=lambda hit: float(hit["score"]),
            reverse=True,
        )[: settings.rag_top_k]
        if not ranked_hits:
            continue
        now = utc_now()
        for hit in ranked_hits:
            cur = conn.execute(
                """
                INSERT INTO matches(
                  paper_id, arxiv_chunk_id, chunk_id, score, searchers_json, evidence_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(paper_id, chunk_id) DO UPDATE SET
                  arxiv_chunk_id = excluded.arxiv_chunk_id,
                  score = excluded.score,
                  searchers_json = excluded.searchers_json,
                  evidence_json = excluded.evidence_json,
                  created_at = excluded.created_at
                WHERE excluded.score > matches.score OR matches.arxiv_chunk_id IS NULL
                """,
                (
                    int(paper["id"]),
                    int(hit["arxiv_chunk_id"]),
                    int(hit["chunk_id"]),
                    float(hit["score"]),
                    to_json(hit["searchers"]),
                    to_json(
                        {
                            "search_details": hit["details"],
                            "arxiv_chunk_index": hit["arxiv_chunk_index"],
                            "arxiv_chunk_source": hit["arxiv_chunk_source"],
                            "arxiv_page_start": hit["arxiv_page_start"],
                            "arxiv_page_end": hit["arxiv_page_end"],
                            "arxiv_text": str(hit["arxiv_text"])[:1600],
                        }
                    ),
                    now,
                ),
            )
            if cur.rowcount:
                matches_created += 1
        matched_papers += 1
        conn.commit()

    return {
        **chunk_result,
        **embedding_result,
        **prefilter_result,
        "papers_considered": len(papers),
        "arxiv_chunks_scored": arxiv_chunks_scored,
        "matched_papers": matched_papers,
        "matches_created": matches_created,
    }


def rank_project_papers(
    conn: sqlite3.Connection,
    settings: Settings,
    papers: list[sqlite3.Row] | None = None,
) -> dict[str, int]:
    if papers is None:
        papers, _ = prefilter_recent_papers(conn, settings)
    paper_ids = [int(paper["id"]) for paper in papers]
    chunk_result = ensure_arxiv_chunks(conn, paper_ids=paper_ids)
    embedding_result = ensure_missing_arxiv_chunk_embeddings(conn, settings, paper_ids=paper_ids)
    projects = conn.execute(
        """
        SELECT id, name
        FROM research_projects
        ORDER BY updated_at DESC
        """
    ).fetchall()
    projects_considered = 0
    projects_with_context = 0
    papers_considered = 0
    arxiv_chunks_scored = 0
    project_paper_matches_created = 0
    project_papers_linked = 0

    for project in projects:
        projects_considered += 1
        project_id = int(project["id"])
        project_chunk_ids = _project_chunk_ids(conn, project_id)
        if not project_chunk_ids:
            continue
        projects_with_context += 1
        for paper in papers:
            papers_considered += 1
            arxiv_chunks = conn.execute(
                """
                SELECT id, chunk_index, source, page_start, page_end, text
                FROM arxiv_text_chunks
                WHERE paper_id = ?
                ORDER BY chunk_index
                """,
                (int(paper["id"]),),
            ).fetchall()
            best_by_obsidian_chunk: dict[int, dict[str, object]] = {}
            for arxiv_chunk in arxiv_chunks:
                arxiv_chunks_scored += 1
                query_embedding = ensure_arxiv_chunk_embedding(
                    conn,
                    settings,
                    int(arxiv_chunk["id"]),
                    arxiv_chunk["text"],
                )
                hits = hybrid_search_with_embedding(
                    conn,
                    settings,
                    arxiv_chunk["text"],
                    settings.rag_top_k,
                    query_embedding,
                    project_chunk_ids,
                )
                for hit in hits:
                    if float(hit["score"]) < settings.rag_score_threshold:
                        continue
                    obsidian_chunk_id = int(hit["chunk_id"])
                    previous = best_by_obsidian_chunk.get(obsidian_chunk_id)
                    if previous and float(previous["score"]) >= float(hit["score"]):
                        continue
                    best_by_obsidian_chunk[obsidian_chunk_id] = {
                        **hit,
                        "arxiv_chunk_id": int(arxiv_chunk["id"]),
                        "arxiv_chunk_index": int(arxiv_chunk["chunk_index"]),
                        "arxiv_chunk_source": arxiv_chunk["source"],
                        "arxiv_page_start": arxiv_chunk["page_start"],
                        "arxiv_page_end": arxiv_chunk["page_end"],
                        "arxiv_text": arxiv_chunk["text"],
                    }
            ranked_hits = sorted(
                best_by_obsidian_chunk.values(),
                key=lambda hit: float(hit["score"]),
                reverse=True,
            )[: settings.rag_top_k]
            if not ranked_hits:
                continue
            best = ranked_hits[0]
            top_scores = [float(hit["score"]) for hit in ranked_hits[:3]]
            score = (float(best["score"]) * 0.7) + ((sum(top_scores) / len(top_scores)) * 0.3)
            best["top_project_hits"] = [
                {
                    "chunk_id": int(hit["chunk_id"]),
                    "arxiv_chunk_id": int(hit["arxiv_chunk_id"]),
                    "score": round(float(hit["score"]), 6),
                    "searchers": hit["searchers"],
                }
                for hit in ranked_hits
            ]
            now = utc_now()
            cur = conn.execute(
                """
                INSERT INTO project_paper_matches(
                  project_id,
                  paper_id,
                  score,
                  best_arxiv_chunk_id,
                  best_obsidian_chunk_id,
                  searchers_json,
                  evidence_json,
                  match_type,
                  created_at,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'project_context', ?, ?)
                ON CONFLICT(project_id, paper_id) DO UPDATE SET
                  score = excluded.score,
                  best_arxiv_chunk_id = excluded.best_arxiv_chunk_id,
                  best_obsidian_chunk_id = excluded.best_obsidian_chunk_id,
                  searchers_json = excluded.searchers_json,
                  evidence_json = excluded.evidence_json,
                  match_type = excluded.match_type,
                  updated_at = excluded.updated_at
                WHERE excluded.score > project_paper_matches.score
                """,
                (
                    project_id,
                    int(paper["id"]),
                    float(score),
                    int(best["arxiv_chunk_id"]),
                    int(best["chunk_id"]),
                    to_json(best["searchers"]),
                    to_json(_project_match_evidence(best)),
                    now,
                    now,
                ),
            )
            if cur.rowcount:
                project_paper_matches_created += 1
            link_cur = conn.execute(
                """
                INSERT OR IGNORE INTO project_papers(
                  project_id, paper_id, relation, note, created_at, updated_at
                )
                VALUES (?, ?, 'candidate', 'auto_matched_by_project_context', ?, ?)
                """,
                (project_id, int(paper["id"]), now, now),
            )
            if link_cur.rowcount:
                project_papers_linked += 1
            conn.commit()

    maintenance_result = {
        **{f"project_rank_{key}": value for key, value in chunk_result.items()},
        **{f"project_rank_{key}": value for key, value in embedding_result.items()},
    }
    return {
        **maintenance_result,
        "project_rank_projects_considered": projects_considered,
        "project_rank_projects_with_context": projects_with_context,
        "project_rank_papers_considered": papers_considered,
        "project_rank_arxiv_chunks_scored": arxiv_chunks_scored,
        "project_paper_matches_created": project_paper_matches_created,
        "project_papers_linked": project_papers_linked,
    }
