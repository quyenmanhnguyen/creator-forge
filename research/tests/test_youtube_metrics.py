"""Tests for core.youtube outlier + opportunity_score helpers (no API calls)."""
from __future__ import annotations

from core.youtube import detect_outliers, opportunity_score, vph


def _fake_video(vid: str, view_count: int) -> dict:
    return {
        "id": vid,
        "snippet": {"title": f"video {vid}", "channelTitle": "ch"},
        "statistics": {"viewCount": str(view_count)},
    }


def test_detect_outliers_flags_breakouts() -> None:
    videos = [
        _fake_video("a", 1_000),
        _fake_video("b", 1_200),
        _fake_video("c", 1_100),
        _fake_video("d", 50_000),  # 50× median → breakout
        _fake_video("e", 800),
    ]
    breakouts = detect_outliers(videos, multiplier=2.5)
    ids = [v["id"] for v in breakouts]
    assert "d" in ids
    assert "a" not in ids
    # sorted desc by ratio
    assert breakouts[0]["_view_ratio"] >= breakouts[-1]["_view_ratio"]


def test_detect_outliers_no_breakouts_returns_empty() -> None:
    videos = [_fake_video("x", 1_000), _fake_video("y", 1_100), _fake_video("z", 950)]
    assert detect_outliers(videos, multiplier=2.5) == []


def test_detect_outliers_empty_input() -> None:
    assert detect_outliers([], multiplier=2.5) == []


def test_opportunity_score_alive_niche_is_high() -> None:
    score, grade = opportunity_score(
        recent_uploads=40, top_video_views=4_000_000, total_competition=200_000
    )
    assert grade in {"high", "medium"}
    assert score >= 60


def test_opportunity_score_dead_niche_is_low() -> None:
    score, grade = opportunity_score(
        recent_uploads=0, top_video_views=500, total_competition=10_000_000
    )
    assert grade == "low"
    assert score <= 30


def test_opportunity_score_clamps_to_0_100() -> None:
    score, _ = opportunity_score(
        recent_uploads=10**9, top_video_views=10**12, total_competition=10**12
    )
    assert 0 <= score <= 100


def test_vph_basic() -> None:
    # 100k views / 10 hours = 10k VPH
    assert vph(100_000, 10) == 10_000.0


def test_vph_floors_hours_at_one() -> None:
    # Brand-new video: 0 hours since publish → cap at 1
    assert vph(50_000, 0) == 50_000.0
    assert vph(50_000, 0.5) == 50_000.0


def test_vph_negative_hours_floor() -> None:
    # Defensive: negative input → still floored
    assert vph(1_000, -1) == 1_000.0
