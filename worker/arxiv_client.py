from __future__ import annotations

import sqlite3
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from .config import Settings
from .db import to_json, utc_now

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV = "{http://arxiv.org/schemas/atom}"
API_URL = "https://export.arxiv.org/api/query"


@dataclass
class ArxivPaper:
    arxiv_id: str
    title: str
    authors: list[str]
    summary: str
    categories: list[str]
    published_at: str
    updated_at: str
    link: str
    pdf_link: str


def _parse_arxiv_id(entry_id: str) -> str:
    return entry_id.rstrip("/").split("/")[-1]


def _parse_feed(xml_text: str) -> list[ArxivPaper]:
    root = ET.fromstring(xml_text)
    papers: list[ArxivPaper] = []
    for entry in root.findall(f"{ATOM}entry"):
        entry_id = entry.findtext(f"{ATOM}id", "")
        title = " ".join((entry.findtext(f"{ATOM}title", "") or "").split())
        summary = " ".join((entry.findtext(f"{ATOM}summary", "") or "").split())
        published = entry.findtext(f"{ATOM}published", "") or ""
        updated = entry.findtext(f"{ATOM}updated", "") or published
        authors = [
            (author.findtext(f"{ATOM}name", "") or "").strip()
            for author in entry.findall(f"{ATOM}author")
        ]
        categories = [
            category.attrib.get("term", "")
            for category in entry.findall(f"{ATOM}category")
            if category.attrib.get("term")
        ]
        link = entry_id
        pdf_link = ""
        for link_node in entry.findall(f"{ATOM}link"):
            rel = link_node.attrib.get("rel")
            href = link_node.attrib.get("href", "")
            title_attr = link_node.attrib.get("title", "")
            if rel == "alternate" and href:
                link = href
            if title_attr == "pdf" and href:
                pdf_link = href
        papers.append(
            ArxivPaper(
                arxiv_id=_parse_arxiv_id(entry_id),
                title=title,
                authors=[author for author in authors if author],
                summary=summary,
                categories=categories,
                published_at=published,
                updated_at=updated,
                link=link,
                pdf_link=pdf_link,
            )
        )
    return papers


def _fetch_page(search_query: str, start: int, max_results: int) -> str:
    params = urllib.parse.urlencode(
        {
            "search_query": search_query,
            "start": start,
            "max_results": max_results,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        }
    )
    request = urllib.request.Request(
        f"{API_URL}?{params}",
        headers={"User-Agent": "research-intelligence-system/0.1"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read().decode("utf-8")


def _is_recent(paper: ArxivPaper, lookback_days: int) -> bool:
    if not paper.published_at:
        return True
    try:
        published = datetime.fromisoformat(paper.published_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    return published >= cutoff


def fetch_arxiv(conn: sqlite3.Connection, settings: Settings) -> dict[str, int | str]:
    if not settings.arxiv_categories:
        raise RuntimeError("ARXIV_CATEGORIES is empty")

    batch_id = uuid4().hex
    search_query = " OR ".join(f"cat:{category}" for category in settings.arxiv_categories)
    page_size = min(100, max(1, settings.arxiv_max_results))
    inserted = 0
    seen = 0

    for start in range(0, settings.arxiv_max_results, page_size):
        if start > 0:
            time.sleep(settings.arxiv_request_interval_seconds)
        xml_text = _fetch_page(search_query, start, page_size)
        papers = _parse_feed(xml_text)
        if not papers:
            break
        now = utc_now()
        for paper in papers:
            if not _is_recent(paper, settings.arxiv_daily_lookback_days):
                continue
            seen += 1
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json,
                  published_at, updated_at, link, pdf_link, fetched_batch_id, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    paper.arxiv_id,
                    paper.title,
                    to_json(paper.authors),
                    paper.summary,
                    to_json(paper.categories),
                    paper.published_at,
                    paper.updated_at,
                    paper.link,
                    paper.pdf_link,
                    batch_id,
                    now,
                ),
            )
            if cur.rowcount:
                inserted += 1
        conn.commit()
        if len(papers) < page_size:
            break

    return {"batch_id": batch_id, "papers_seen": seen, "papers_inserted": inserted}
