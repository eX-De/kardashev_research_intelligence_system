from __future__ import annotations

import unittest

from worker.project_match_policy import (
    ProjectPaperMatchEarlyStopConfig,
    ProjectPaperMatchEarlyStopper,
    should_stop_project_paper_scan,
)


class ProjectMatchPolicyTests(unittest.TestCase):
    def test_no_hits_do_not_stop(self) -> None:
        stopper = ProjectPaperMatchEarlyStopper()

        for _ in range(5):
            decision = stopper.record_arxiv_chunk()

        self.assertFalse(decision.should_stop)
        self.assertEqual(decision.reason, "insufficient_project_match_evidence")
        self.assertEqual(stopper.scanned_arxiv_chunks, 5)
        self.assertEqual(stopper.best_quality_score, 0.0)
        self.assertEqual(stopper.distinct_strong_project_chunks, 0)

    def test_single_hit_does_not_stop_on_merely_excellent_score(self) -> None:
        stopper = ProjectPaperMatchEarlyStopper()

        stopper.record_scan(4)
        decision = stopper.record_hit({"chunk_id": 11, "quality_score": 0.70})

        self.assertFalse(decision.should_stop)
        self.assertEqual(decision.reason, "insufficient_project_match_evidence")
        self.assertEqual(stopper.best_quality_score, 0.70)
        self.assertEqual(stopper.strong_project_chunk_ids, (11,))

    def test_multi_strong_project_chunk_evidence_stops(self) -> None:
        stopper = ProjectPaperMatchEarlyStopper()

        stopper.record_scan(3)
        stopper.record_hit({"chunk_id": 11, "quality_score": 0.58})
        decision = stopper.record_hit({"chunk_id": 12, "quality_score": 0.52})

        self.assertTrue(decision.should_stop)
        self.assertEqual(decision.reason, "excellent_multi_project_chunk_evidence")
        self.assertEqual(decision.best_quality_score, 0.58)
        self.assertEqual(decision.distinct_strong_project_chunks, 2)

    def test_threshold_boundaries_are_inclusive(self) -> None:
        below_strong = ProjectPaperMatchEarlyStopper()
        below_strong.record_scan(3)
        below_strong.record_hit({"chunk_id": 11, "quality_score": 0.58})
        decision = below_strong.record_hit({"chunk_id": 12, "quality_score": 0.519999})

        self.assertFalse(decision.should_stop)
        self.assertEqual(decision.distinct_strong_project_chunks, 1)

        at_threshold = ProjectPaperMatchEarlyStopper()
        at_threshold.record_scan(3)
        at_threshold.record_hit({"chunk_id": 11, "quality_score": 0.58})
        decision = at_threshold.record_hit({"chunk_id": 12, "quality_score": 0.52})

        self.assertTrue(decision.should_stop)
        self.assertEqual(decision.reason, "excellent_multi_project_chunk_evidence")

    def test_scan_count_floor_prevents_early_stop(self) -> None:
        stopper = ProjectPaperMatchEarlyStopper()

        stopper.record_scan(2)
        stopper.record_hit({"chunk_id": 11, "quality_score": 0.65})
        decision = stopper.record_hit({"chunk_id": 12, "quality_score": 0.62})

        self.assertFalse(decision.should_stop)
        self.assertEqual(decision.reason, "below_min_scanned_arxiv_chunks")

        decision = stopper.record_scan()

        self.assertTrue(decision.should_stop)
        self.assertEqual(decision.reason, "excellent_multi_project_chunk_evidence")

    def test_exceptional_single_hit_still_requires_extra_scans(self) -> None:
        stopper = ProjectPaperMatchEarlyStopper()

        stopper.record_scan(3)
        decision = stopper.record_hit({"chunk_id": 11, "quality_score": 0.90})

        self.assertFalse(decision.should_stop)
        self.assertEqual(decision.reason, "insufficient_project_match_evidence")

        decision = stopper.record_scan()

        self.assertTrue(decision.should_stop)
        self.assertEqual(decision.reason, "exceptional_single_project_chunk_evidence")

    def test_stateless_decision_helper(self) -> None:
        config = ProjectPaperMatchEarlyStopConfig(
            strong_score=0.50,
            excellent_score=0.60,
            min_distinct_project_chunks=3,
            min_scanned_arxiv_chunks=2,
        )

        decision = should_stop_project_paper_scan(
            scanned_arxiv_chunks=2,
            best_quality_score=0.60,
            distinct_strong_project_chunks=3,
            config=config,
        )

        self.assertTrue(decision.should_stop)
        self.assertEqual(decision.reason, "excellent_multi_project_chunk_evidence")


if __name__ == "__main__":
    unittest.main()
