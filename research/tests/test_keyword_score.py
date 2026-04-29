"""Tests for VidIQ-style keyword scoring formulas."""
from __future__ import annotations

import pytest

from core import keywords


class TestVolumeScore:
    def test_zero_breadth_zero_results(self):
        assert keywords.volume_score(0, 0) == pytest.approx(0.0)

    def test_high_breadth_low_results(self):
        # Saturating around 12 breadth → ~80
        s = keywords.volume_score(12, 0)
        assert 75 <= s <= 85

    def test_breadth_plus_results_caps_at_100(self):
        s = keywords.volume_score(20, 100_000_000)
        assert s <= 100.0
        assert s >= 90.0

    def test_results_only(self):
        # No autocomplete, but 1M results → ~20 from results pts
        s = keywords.volume_score(0, 1_000_000)
        assert 15 <= s <= 25


class TestCompetitionScore:
    def test_zero_results_zero_competition(self):
        assert keywords.competition_score(0) == pytest.approx(0.0)

    def test_low_results_low_competition(self):
        # 1k results → ~37 (low end, log scale)
        s = keywords.competition_score(1_000)
        assert 30 <= s <= 50

    def test_high_results_high_competition(self):
        # 100M+ results → near max
        s = keywords.competition_score(100_000_000)
        assert s >= 95.0

    def test_top_views_bump(self):
        base = keywords.competition_score(1_000_000)
        bumped = keywords.competition_score(1_000_000, top_avg_views=10_000_000)
        assert bumped > base


class TestKeywordScore:
    def test_high_volume_low_competition_high_score(self):
        s = keywords.keyword_score(volume=80, competition=20)
        # 0.7*80 + 0.3*80 = 56 + 24 = 80
        assert s == pytest.approx(80.0)

    def test_low_volume_high_competition_low_score(self):
        s = keywords.keyword_score(volume=10, competition=90)
        # 0.7*10 + 0.3*10 = 10
        assert s == pytest.approx(10.0)

    def test_clamps_to_0_100(self):
        assert 0 <= keywords.keyword_score(0, 0) <= 100
        assert 0 <= keywords.keyword_score(100, 0) <= 100
        assert 0 <= keywords.keyword_score(100, 100) <= 100


class TestScoreGrade:
    def test_grades_match_thresholds(self):
        assert keywords.score_grade(85) == "great"
        assert keywords.score_grade(60) == "good"
        assert keywords.score_grade(35) == "ok"
        assert keywords.score_grade(15) == "weak"
