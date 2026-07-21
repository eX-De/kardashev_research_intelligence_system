from __future__ import annotations

from .db_types import DbConnection, DbRow
import time
import urllib.error
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
ARXIV_RETRY_BACKOFF_SECONDS = (30, 60, 120)
ARXIV_RATE_LIMITED = "arxiv_rate_limited"


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


class ArxivRateLimitError(RuntimeError):
    def __init__(
        self,
        *,
        attempts: int,
        retry_after_seconds: int | None = None,
        technical_message: str = "",
    ) -> None:
        self.attempts = max(1, int(attempts or 1))
        self.retry_after_seconds = retry_after_seconds if retry_after_seconds and retry_after_seconds > 0 else None
        self.technical_message = technical_message
        super().__init__(
            f"arXiv 请求被限流（HTTP 429），已重试 {self.attempts} 次仍未成功。"
            "请稍后重试，或在设置中调大 arXiv 请求间隔秒数。"
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "code": ARXIV_RATE_LIMITED,
            "reason": ARXIV_RATE_LIMITED,
            "error_type": ARXIV_RATE_LIMITED,
            "status_code": 429,
            "title": "arXiv 暂时限流",
            "error": str(self),
            "detail": "抓取 arXiv 时被限流，系统已按退避策略重试但仍未成功。",
            "suggested_action": "稍后重新执行每日流程，或在设置中调大 arXiv 请求间隔秒数。",
            "retry_after_seconds": self.retry_after_seconds,
            "attempts": self.attempts,
            "technical_message": self.technical_message,
        }


def _retry_after_seconds(headers: object) -> int | None:
    retry_after = headers.get("Retry-After") if headers else ""
    try:
        parsed = int(str(retry_after or "").strip())
    except ValueError:
        return None
    return parsed if parsed > 0 else None


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
    for attempt in range(len(ARXIV_RETRY_BACKOFF_SECONDS) + 1):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            if exc.code != 429:
                raise
            retry_after = _retry_after_seconds(exc.headers)
            if attempt >= len(ARXIV_RETRY_BACKOFF_SECONDS):
                raise ArxivRateLimitError(
                    attempts=attempt + 1,
                    retry_after_seconds=retry_after,
                    technical_message=str(exc),
                ) from exc
            delay = retry_after or ARXIV_RETRY_BACKOFF_SECONDS[attempt]
            time.sleep(max(1, min(delay, 300)))
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt >= len(ARXIV_RETRY_BACKOFF_SECONDS):
                raise
            time.sleep(ARXIV_RETRY_BACKOFF_SECONDS[attempt])
    raise RuntimeError("arXiv request retry loop exhausted")


def _is_recent(paper: ArxivPaper, lookback_days: int) -> bool:
    if not paper.published_at:
        return True
    try:
        published = datetime.fromisoformat(paper.published_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    return published >= cutoff


def fetch_arxiv(conn: DbConnection, settings: Settings) -> dict[str, int | str]:
    if not settings.arxiv_categories:
        raise RuntimeError("ARXIV_CATEGORIES is empty")

    batch_id = uuid4().hex
    search_query = " OR ".join(f"cat:{category}" for category in settings.arxiv_categories)
    page_size = min(100, max(1, settings.arxiv_max_results))
    inserted = 0
    updated = 0
    seen = 0
    tombstone_skipped = 0
    pages_fetched = 0
    stopped_at_cutoff = 0

    for start in range(0, settings.arxiv_max_results, page_size):
        if start > 0:
            time.sleep(settings.arxiv_request_interval_seconds)
        xml_text = _fetch_page(search_query, start, page_size)
        pages_fetched += 1
        papers = _parse_feed(xml_text)
        if not papers:
            break
        recent_papers: list[ArxivPaper] = []
        reached_cutoff = False
        for paper in papers:
            if _is_recent(paper, settings.arxiv_daily_lookback_days):
                recent_papers.append(paper)
            else:
                reached_cutoff = True
        now = utc_now()
        for paper in recent_papers:
            seen += 1
            tombstone = conn.execute(
                """
                SELECT arxiv_id
                FROM arxiv_paper_tombstones
                WHERE arxiv_id = ?
                """,
                (paper.arxiv_id,),
            ).fetchone()
            if tombstone:
                tombstone_skipped += 1
                conn.execute(
                    """
                    UPDATE arxiv_paper_tombstones
                    SET seen_count = seen_count + 1,
                        last_seen_at = ?
                    WHERE arxiv_id = ?
                    """,
                    (now, paper.arxiv_id),
                )
                continue
            cur = conn.execute(
                """
                INSERT INTO arxiv_papers(
                  arxiv_id, title, authors_json, summary, categories_json,
                  published_at, updated_at, link, pdf_link, fetched_batch_id, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(arxiv_id) DO NOTHING
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
            else:
                update_cur = conn.execute(
                    """
                    UPDATE arxiv_papers
                    SET title = ?,
                        authors_json = ?,
                        summary = ?,
                        categories_json = ?,
                        published_at = ?,
                        updated_at = ?,
                        link = ?,
                        pdf_link = ?,
                        fetched_batch_id = ?
                    WHERE arxiv_id = ?
                    """,
                    (
                        paper.title,
                        to_json(paper.authors),
                        paper.summary,
                        to_json(paper.categories),
                        paper.published_at,
                        paper.updated_at,
                        paper.link,
                        paper.pdf_link,
                        batch_id,
                        paper.arxiv_id,
                    ),
                )
                if update_cur.rowcount:
                    updated += 1
        conn.commit()
        if reached_cutoff:
            stopped_at_cutoff = 1
            break
        if len(papers) < page_size:
            break

    return {
        "batch_id": batch_id,
        "papers_seen": seen,
        "papers_inserted": inserted,
        "papers_updated": updated,
        "papers_tombstone_skipped": tombstone_skipped,
        "pages_fetched": pages_fetched,
        "stopped_at_cutoff": stopped_at_cutoff,
    }
