"""Offline tests for ``POST /research/outlier`` — every upstream is stubbed
via monkeypatch, so the suite runs without network or API keys.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from research.api.main import create_app
from research.api.routes import outlier as outlier_route
from research.core.outliers import OutlierRow

app = create_app()
client = TestClient(app)


def _row(
    *,
    vid: str = "abc",
    title: str = "Sample",
    channel: str = "Chan",
    subs: int = 5_000,
    views: int = 100_000,
    score: float | None = None,
    hours: float = 24.0,
) -> OutlierRow:
    """Build an OutlierRow for stubbing find_outliers."""
    return OutlierRow(
        video_id=vid,
        title=title,
        channel_id=f"UC{vid}",
        channel_title=channel,
        subs=subs,
        views=views,
        likes=int(views * 0.04),
        comments=int(views * 0.005),
        published_at=(datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(),
        hours_since=hours,
        vph=views / max(hours, 1.0),
        outlier_score=score if score is not None else views / max(subs, 1000),
        thumbnail=f"https://img.youtube.com/vi/{vid}/mqdefault.jpg",
        url=f"https://youtube.com/watch?v={vid}",
        duration="PT1M30S",
    )


# ─── Validation ─────────────────────────────────────────────────────────────

def test_outlier_rejects_empty_seed():
    r = client.post("/research/outlier", json={"seed": ""})
    assert r.status_code == 422


@pytest.mark.parametrize("seed", [" ", "   ", "\t", "\n"])
def test_outlier_rejects_whitespace_only_seed(seed):
    r = client.post("/research/outlier", json={"seed": seed})
    assert r.status_code == 422, r.text


def test_outlier_rejects_invalid_window_days():
    r = client.post("/research/outlier", json={"seed": "ai art", "window_days": 5})
    assert r.status_code == 422


# ─── Happy path ─────────────────────────────────────────────────────────────

def test_outlier_happy_path(monkeypatch):
    """find_outliers returns rows → response sorts by outlier_score desc and
    populates stats correctly."""
    rows = [
        _row(vid="lo", views=10_000, subs=5_000, hours=48.0),     # ratio 2.0
        _row(vid="hi", views=500_000, subs=10_000, hours=24.0),   # ratio 50.0
        _row(vid="mid", views=50_000, subs=5_000, hours=10.0),    # ratio 10.0
    ]
    captured: dict = {}

    def fake_find(seed, **kw):
        captured["seed"] = seed
        captured.update(kw)
        return rows

    monkeypatch.setattr(outlier_route.outliers, "find_outliers", fake_find)

    r = client.post(
        "/research/outlier",
        json={
            "seed": "  ai art  ",
            "region": "US",
            "window_days": 14,
            "max_subs": 50_000,
            "min_outlier": 1.5,
            "max_results": 30,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # find_outliers received the *stripped* seed and exact options.
    assert captured["seed"] == "ai art"
    assert captured["region"] == "US"
    assert captured["window_days"] == 14
    assert captured["max_subs"] == 50_000
    assert captured["min_outlier"] == 1.5
    assert captured["max_results"] == 30

    # 3 rows, sorted by outlier_score DESC.
    assert body["seed"] == "ai art"
    assert body["region"] == "US"
    assert body["window_days"] == 14
    assert len(body["rows"]) == 3
    scores = [r["outlier_score"] for r in body["rows"]]
    assert scores == sorted(scores, reverse=True)
    assert body["rows"][0]["video_id"] == "hi"

    # Stats reflect the aggregate.
    stats = body["stats"]
    assert stats["count"] == 3
    assert stats["max_vph"] == max(r.vph for r in rows)
    assert stats["avg_outlier_score"] == pytest.approx(
        sum(r.outlier_score for r in rows) / 3
    )

    assert body["warnings"] == []


def test_outlier_empty_results_no_warnings(monkeypatch):
    """find_outliers returns [] (no qualifying outliers) → 200 with empty rows
    + zeroed stats + no warnings."""
    monkeypatch.setattr(outlier_route.outliers, "find_outliers", lambda *a, **kw: [])

    r = client.post("/research/outlier", json={"seed": "ai art"})
    assert r.status_code == 200
    body = r.json()
    assert body["rows"] == []
    assert body["stats"] == {
        "count": 0,
        "max_vph": 0.0,
        "avg_vph": 0.0,
        "avg_outlier_score": 0.0,
    }
    assert body["warnings"] == []


# ─── Failure modes ──────────────────────────────────────────────────────────

def test_outlier_youtube_failure_returns_partial_200(monkeypatch):
    """Missing YOUTUBE_API_KEY (or any other upstream raise) → 200 with empty
    rows, zeroed stats, and a warning citing the failure."""
    def boom(*a, **kw):
        raise RuntimeError("Thiếu YOUTUBE_API_KEY")

    monkeypatch.setattr(outlier_route.outliers, "find_outliers", boom)

    r = client.post("/research/outlier", json={"seed": "ai art"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows"] == []
    assert body["stats"]["count"] == 0
    assert any("outliers.find_outliers failed" in w for w in body["warnings"])
    assert any("YOUTUBE_API_KEY" in w for w in body["warnings"])


def test_outlier_max_results_capped_to_50():
    """max_results must be 1..50 (the YouTube search.list page limit)."""
    r = client.post("/research/outlier", json={"seed": "ai art", "max_results": 51})
    assert r.status_code == 422
    r2 = client.post("/research/outlier", json={"seed": "ai art", "max_results": 0})
    assert r2.status_code == 422
