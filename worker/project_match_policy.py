from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class ProjectPaperMatchEarlyStopConfig:
    strong_score: float = 0.52
    excellent_score: float = 0.58
    min_distinct_project_chunks: int = 2
    min_scanned_arxiv_chunks: int = 3
    exceptional_score: float = 0.72
    exceptional_min_scanned_arxiv_chunks: int = 4

    def __post_init__(self) -> None:
        if self.strong_score < 0 or self.excellent_score < 0 or self.exceptional_score < 0:
            raise ValueError("score thresholds must be non-negative")
        if self.excellent_score < self.strong_score:
            raise ValueError("excellent_score must be greater than or equal to strong_score")
        if self.exceptional_score < self.excellent_score:
            raise ValueError("exceptional_score must be greater than or equal to excellent_score")
        if self.min_distinct_project_chunks < 1:
            raise ValueError("min_distinct_project_chunks must be at least 1")
        if self.min_scanned_arxiv_chunks < 1:
            raise ValueError("min_scanned_arxiv_chunks must be at least 1")
        if self.exceptional_min_scanned_arxiv_chunks < self.min_scanned_arxiv_chunks:
            raise ValueError(
                "exceptional_min_scanned_arxiv_chunks must be greater than or equal to min_scanned_arxiv_chunks"
            )


DEFAULT_PROJECT_MATCH_EARLY_STOP_CONFIG = ProjectPaperMatchEarlyStopConfig()


@dataclass(frozen=True)
class ProjectPaperMatchEarlyStopDecision:
    should_stop: bool
    reason: str
    scanned_arxiv_chunks: int
    best_quality_score: float
    distinct_strong_project_chunks: int


def should_stop_project_paper_scan(
    *,
    scanned_arxiv_chunks: int,
    best_quality_score: float,
    distinct_strong_project_chunks: int,
    config: ProjectPaperMatchEarlyStopConfig | None = None,
) -> ProjectPaperMatchEarlyStopDecision:
    cfg = config or DEFAULT_PROJECT_MATCH_EARLY_STOP_CONFIG
    scanned = _non_negative_int(scanned_arxiv_chunks, "scanned_arxiv_chunks")
    distinct = _non_negative_int(distinct_strong_project_chunks, "distinct_strong_project_chunks")
    best = _score(best_quality_score)

    if scanned < cfg.min_scanned_arxiv_chunks:
        return ProjectPaperMatchEarlyStopDecision(
            should_stop=False,
            reason="below_min_scanned_arxiv_chunks",
            scanned_arxiv_chunks=scanned,
            best_quality_score=best,
            distinct_strong_project_chunks=distinct,
        )

    if distinct >= cfg.min_distinct_project_chunks and best >= cfg.excellent_score:
        return ProjectPaperMatchEarlyStopDecision(
            should_stop=True,
            reason="excellent_multi_project_chunk_evidence",
            scanned_arxiv_chunks=scanned,
            best_quality_score=best,
            distinct_strong_project_chunks=distinct,
        )

    if scanned >= cfg.exceptional_min_scanned_arxiv_chunks and distinct >= 1 and best >= cfg.exceptional_score:
        return ProjectPaperMatchEarlyStopDecision(
            should_stop=True,
            reason="exceptional_single_project_chunk_evidence",
            scanned_arxiv_chunks=scanned,
            best_quality_score=best,
            distinct_strong_project_chunks=distinct,
        )

    return ProjectPaperMatchEarlyStopDecision(
        should_stop=False,
        reason="insufficient_project_match_evidence",
        scanned_arxiv_chunks=scanned,
        best_quality_score=best,
        distinct_strong_project_chunks=distinct,
    )


class ProjectPaperMatchEarlyStopper:
    """Small state object for one project/paper scan."""

    def __init__(self, config: ProjectPaperMatchEarlyStopConfig | None = None) -> None:
        self.config = config or DEFAULT_PROJECT_MATCH_EARLY_STOP_CONFIG
        self.scanned_arxiv_chunks = 0
        self.best_quality_score = 0.0
        self._strong_project_chunk_ids: set[int] = set()

    @property
    def distinct_strong_project_chunks(self) -> int:
        return len(self._strong_project_chunk_ids)

    @property
    def strong_project_chunk_ids(self) -> tuple[int, ...]:
        return tuple(sorted(self._strong_project_chunk_ids))

    @property
    def should_stop(self) -> bool:
        return self.decision().should_stop

    def record_scan(self, count: int = 1) -> ProjectPaperMatchEarlyStopDecision:
        self.scanned_arxiv_chunks += _non_negative_int(count, "count")
        return self.decision()

    def record_hit(
        self,
        hit: Mapping[str, object] | None = None,
        *,
        quality_score: float | None = None,
        project_chunk_id: int | None = None,
    ) -> ProjectPaperMatchEarlyStopDecision:
        if hit is not None:
            quality_score = _hit_quality_score(hit) if quality_score is None else quality_score
            project_chunk_id = _hit_project_chunk_id(hit) if project_chunk_id is None else project_chunk_id

        score = _score(quality_score)
        self.best_quality_score = max(self.best_quality_score, score)
        if project_chunk_id is not None and score >= self.config.strong_score:
            self._strong_project_chunk_ids.add(int(project_chunk_id))
        return self.decision()

    def record_hits(self, hits: Iterable[Mapping[str, object]]) -> ProjectPaperMatchEarlyStopDecision:
        for hit in hits:
            self.record_hit(hit)
        return self.decision()

    def record_arxiv_chunk(
        self,
        hits: Iterable[Mapping[str, object]] = (),
    ) -> ProjectPaperMatchEarlyStopDecision:
        self.record_scan()
        return self.record_hits(hits)

    def decision(self) -> ProjectPaperMatchEarlyStopDecision:
        return should_stop_project_paper_scan(
            scanned_arxiv_chunks=self.scanned_arxiv_chunks,
            best_quality_score=self.best_quality_score,
            distinct_strong_project_chunks=self.distinct_strong_project_chunks,
            config=self.config,
        )


def _hit_quality_score(hit: Mapping[str, object]) -> float:
    if "quality_score" in hit:
        return _score(hit["quality_score"])
    if "score" in hit:
        return _score(hit["score"])
    return 0.0


def _hit_project_chunk_id(hit: Mapping[str, object]) -> int | None:
    if "chunk_id" not in hit or hit["chunk_id"] is None:
        return None
    return int(hit["chunk_id"])


def _score(value: object) -> float:
    if value is None:
        return 0.0
    score = float(value)
    if score < 0:
        return 0.0
    return score


def _non_negative_int(value: int, name: str) -> int:
    integer = int(value)
    if integer < 0:
        raise ValueError(f"{name} must be non-negative")
    return integer
