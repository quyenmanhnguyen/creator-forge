"""Tests for core/keywords.py — KGR-style scoring + question buckets."""
from __future__ import annotations

from core.keywords import (
    QUESTION_PREFIXES,
    build_rows,
    grade_color,
    kgr_score,
)


def test_kgr_low_competition_is_easy() -> None:
    score, grade = kgr_score(competition=200, breadth=10)
    assert grade == "easy"
    assert 80 <= score <= 100


def test_kgr_high_competition_is_hard() -> None:
    score, grade = kgr_score(competition=200_000, breadth=1)
    assert grade == "hard"
    assert score <= 30


def test_kgr_medium_band() -> None:
    score, grade = kgr_score(competition=10_000, breadth=1)
    assert grade == "medium"
    assert 30 < score < 80


def test_kgr_breadth_zero_does_not_divide_by_zero() -> None:
    # build_rows produces rows with breadth >= 1 implied; defensive call.
    score, grade = kgr_score(competition=1000, breadth=0)
    assert grade in {"easy", "medium", "hard"}
    assert 0 <= score <= 100


def test_grade_color_known_grades() -> None:
    assert grade_color("easy").startswith("#")
    assert grade_color("medium").startswith("#")
    assert grade_color("hard").startswith("#")


def test_grade_color_unknown_returns_fallback() -> None:
    assert grade_color("???").startswith("#")


def test_build_rows_shapes_each_entry() -> None:
    rows = build_rows("python tutorial", ["python tutorial for beginners", "python tutorial pdf"])
    assert len(rows) == 2
    r = rows[0]
    assert r["keyword"] == "python tutorial for beginners"
    assert r["length"] == len("python tutorial for beginners")
    assert r["words"] == 4
    assert r["competition"] == 0
    assert r["score"] == 0.0
    assert r["grade"] == "medium"


def test_question_prefixes_have_supported_languages() -> None:
    for code in ("en", "ko", "ja", "vi"):
        assert code in QUESTION_PREFIXES
        assert len(QUESTION_PREFIXES[code]) >= 5
