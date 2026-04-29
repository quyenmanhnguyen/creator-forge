"""Tests for ``POST /research/niche`` (PR-1).

Exercise the route through ``fastapi.testclient.TestClient`` and stub the
upstream ``research.core.*`` modules so we don't make real HTTP calls.
Verifies:

- Happy path: every upstream returns data → response carries it through
  with the expected shape and field names.
- Missing-key path: every upstream raises → response still 200 with an
  empty payload + populated ``warnings``.
- DeepSeek-only-missing path: AI verdict is gracefully skipped.
- Validation: empty seed → 422.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from research.api.main import app
from research.api.routes import research as niche_route
from research.core import llm

client = TestClient(app)


# ─── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture
def stub_youtube_happy(monkeypatch):
    """All YouTube calls succeed and return fake-but-shape-correct data."""
    raw_search_resp = {
        "pageInfo": {"totalResults": 1234},
        "items": [
            {
                "id": {"videoId": "vid_aaa"},
                "snippet": {
                    "title": "Top Video A",
                    "channelId": "chan_a",
                    "channelTitle": "Channel A",
                    "publishedAt": "2025-01-01T00:00:00Z",
                },
            },
            {
                "id": {"videoId": "vid_bbb"},
                "snippet": {
                    "title": "Top Video B",
                    "channelId": "chan_b",
                    "channelTitle": "Channel B",
                    "publishedAt": "2025-01-02T00:00:00Z",
                },
            },
        ],
    }
    hydrated = [
        {
            "id": "vid_aaa",
            "snippet": raw_search_resp["items"][0]["snippet"],
            "statistics": {"viewCount": "5000000", "likeCount": "100000", "commentCount": "8000"},
        },
        {
            "id": "vid_bbb",
            "snippet": raw_search_resp["items"][1]["snippet"],
            "statistics": {"viewCount": "100000", "likeCount": "2000", "commentCount": "150"},
        },
    ]
    channels = [
        {
            "id": "chan_a",
            "snippet": {"title": "Channel A"},
            "statistics": {"subscriberCount": "1000000", "viewCount": "50000000", "videoCount": "200"},
        },
        {
            "id": "chan_b",
            "snippet": {"title": "Channel B"},
            "statistics": {"subscriberCount": "5000", "viewCount": "100000", "videoCount": "10"},
        },
    ]

    monkeypatch.setattr(niche_route.yt, "search_raw", lambda *a, **kw: raw_search_resp)
    monkeypatch.setattr(niche_route.yt, "videos_details", lambda ids: hydrated[: len(ids)])
    monkeypatch.setattr(niche_route.yt, "recent_uploads_count", lambda *a, **kw: 42)
    monkeypatch.setattr(
        niche_route.yt,
        "trend_pulse",
        lambda *a, **kw: {"recent_7d": 30, "prior_7d": 10, "growth_pct": 200.0, "status": "hot"},
    )
    monkeypatch.setattr(niche_route.yt, "channel_details", lambda ids: channels)
    # Outliers: pretend the first video is a 50× outlier.
    monkeypatch.setattr(
        niche_route.yt,
        "detect_outliers",
        lambda videos, multiplier=2.5: [{**hydrated[0], "_view_ratio": 50.0}],
    )
    monkeypatch.setattr(niche_route.yt, "opportunity_score", lambda **kw: (78, "high"))


@pytest.fixture
def stub_autocomplete(monkeypatch):
    monkeypatch.setattr(
        niche_route.autocomplete,
        "suggest",
        lambda seed, hl="en", gl="US": [f"{seed} ideas", f"{seed} for beginners", f"how to {seed}"],
    )


@pytest.fixture
def stub_trends_empty(monkeypatch):
    """pytrends returns empty top/rising — most common case in CI without network."""
    monkeypatch.setattr(niche_route.trends, "related_queries", lambda *a, **kw: {"top": None, "rising": None})


@pytest.fixture
def stub_llm_verdict(monkeypatch):
    fake = {
        "verdict": "hot",
        "score": 82,
        "competition": "medium",
        "opportunities": ["Faceless format works", "30-min docs trending"],
        "risks": ["Heavy AI-generated content"],
        "content_gaps": ["Beginner playlists"],
        "summary": "Strong audience demand with manageable competition.",
    }
    monkeypatch.setattr(niche_route.llm, "chat_json", lambda prompt, system=None: json.dumps(fake))


# ─── Smoke ──────────────────────────────────────────────────────────────────

def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["service"] == "creator-forge.research"


# ─── Validation ─────────────────────────────────────────────────────────────

def test_niche_rejects_empty_seed():
    r = client.post("/research/niche", json={"seed": "", "region": "US", "language": "en"})
    assert r.status_code == 422


@pytest.mark.parametrize("seed", [" ", "   ", "\t", "\n"])
def test_niche_rejects_whitespace_only_seed(seed):
    """Whitespace-only seeds must be rejected (422), not stripped to '' and
    silently passed to upstream YouTube / DeepSeek calls."""
    r = client.post("/research/niche", json={"seed": seed, "region": "US", "language": "en"})
    assert r.status_code == 422, r.text


# ─── Happy path ─────────────────────────────────────────────────────────────

def test_niche_happy_path(stub_youtube_happy, stub_autocomplete, stub_trends_empty, stub_llm_verdict):
    r = client.post(
        "/research/niche",
        json={"seed": "ai art", "region": "US", "language": "en", "include_trends": True, "include_verdict": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["seed"] == "ai art"
    assert body["region"] == "US"
    assert body["language"] == "en"

    # Long-tail
    assert "ai art ideas" in body["longtail"]

    # Top videos
    assert len(body["top_videos"]) == 2
    first = body["top_videos"][0]
    assert first["video_id"] == "vid_aaa"
    assert first["views"] == 5_000_000
    assert first["url"] == "https://youtube.com/watch?v=vid_aaa"

    # Channels — sorted by subs desc, top 10
    assert len(body["channels"]) == 2
    assert body["channels"][0]["channel_id"] == "chan_a"
    assert body["channels"][0]["subs"] == 1_000_000

    # Outliers carry view_ratio
    assert len(body["outliers"]) == 1
    assert body["outliers"][0]["view_ratio"] == 50.0

    # Pulse + opportunity wired through
    assert body["pulse_7d"]["status"] == "hot"
    assert body["pulse_7d"]["growth_pct"] == 200.0
    assert body["opportunity_score"] == 78
    assert body["opportunity_grade"] == "high"
    assert body["recent_uploads_14d"] == 42
    assert body["total_competition"] == 1234

    # Verdict
    assert body["verdict"] is not None
    assert body["verdict"]["verdict"] == "hot"
    assert body["verdict"]["score"] == 82
    assert "Beginner playlists" in body["verdict"]["content_gaps"]

    # No warnings expected — every stub returned data.
    assert body["warnings"] == []


# ─── Missing keys / failures ────────────────────────────────────────────────

def test_niche_all_youtube_calls_fail(monkeypatch, stub_autocomplete):
    """Every YouTube call raises → endpoint still 200, warnings populated, no verdict request fired."""

    def boom(*a, **kw):
        raise RuntimeError("Thieu YOUTUBE_API_KEY")

    for name in ("search_raw", "videos_details", "recent_uploads_count", "trend_pulse", "channel_details", "detect_outliers"):
        monkeypatch.setattr(niche_route.yt, name, boom)
    # Trends + LLM also missing
    monkeypatch.setattr(niche_route.trends, "related_queries", boom)
    monkeypatch.setattr(niche_route.llm, "chat_json", boom)

    r = client.post(
        "/research/niche",
        json={"seed": "obscure topic", "region": "US", "language": "en"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["top_videos"] == []
    assert body["channels"] == []
    assert body["outliers"] == []
    assert body["total_competition"] == 0
    assert body["opportunity_score"] == 0
    assert body["verdict"] is None

    # Warnings should call out at least search_raw + the LLM.
    joined = " ".join(body["warnings"])
    assert "search_raw" in joined
    assert "verdict" in joined.lower()


def test_niche_missing_only_deepseek(stub_youtube_happy, stub_autocomplete, stub_trends_empty, monkeypatch):
    """DeepSeek-only missing → YouTube fields populated, verdict skipped with friendly warning."""

    def no_key(*a, **kw):
        raise RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)

    monkeypatch.setattr(niche_route.llm, "chat_json", no_key)

    r = client.post(
        "/research/niche",
        json={"seed": "ai art", "region": "US", "language": "en"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["top_videos"], "YouTube fields should still be populated"
    assert body["verdict"] is None
    assert any("DEEPSEEK_API_KEY not set" in w for w in body["warnings"])


def test_niche_skip_verdict_and_trends(stub_youtube_happy, stub_autocomplete, monkeypatch):
    """Caller opts out of verdict + trends → those calls don't run and no warnings appear for them."""
    fail = lambda *a, **kw: pytest.fail("should not be called")  # noqa: E731
    monkeypatch.setattr(niche_route.llm, "chat_json", fail)
    monkeypatch.setattr(niche_route.trends, "related_queries", fail)

    r = client.post(
        "/research/niche",
        json={
            "seed": "ai art",
            "region": "US",
            "language": "en",
            "include_trends": False,
            "include_verdict": False,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["verdict"] is None
    assert body["trends_top"] == []
    assert body["trends_rising"] == []
    # No verdict / trends warnings — they were intentionally skipped.
    assert all("verdict" not in w.lower() for w in body["warnings"])
    assert all("trends" not in w.lower() for w in body["warnings"])
