"""Tests for ``POST /research/keywords`` (PR-2).

All upstreams are stubbed via ``monkeypatch`` so the suite runs offline.

Coverage:
- empty seed → 422
- happy path: autocomplete + YouTube succeed → suggestions, seed_score, vph_top,
  questions all populated, no warnings
- compute_kgr=true: per-keyword competition + KGR score get filled in
- all upstreams fail: 200 with empty payload + warnings
- include_questions=false + missing YOUTUBE_API_KEY: autocomplete still works,
  YouTube + questions skipped
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from research.api.main import app
from research.api.routes import keywords as kw_route

client = TestClient(app)


# ─── Fixtures ───────────────────────────────────────────────────────────────

_NOW_PUB = "2025-04-01T00:00:00Z"


@pytest.fixture
def stub_autocomplete(monkeypatch):
    """Autocomplete returns a stable set of long-tail keywords."""

    def fake_suggest(seed, hl="en", gl="US"):
        # Mimic the real shape: longer, more specific phrases for the question
        # buckets (so we can tell main suggest from question buckets).
        if seed == "ai art":
            return ["ai art tutorial", "ai art generator", "ai art prompts", "ai art free"]
        if seed.startswith(("how ", "what ", "why ", "어떻게", "왜", "tại sao")):
            return [f"{seed} 1", f"{seed} 2"]
        return []

    monkeypatch.setattr(kw_route.autocomplete, "suggest", fake_suggest)


@pytest.fixture
def stub_youtube_happy(monkeypatch):
    raw_search_resp = {
        "pageInfo": {"totalResults": 12345},
        "items": [
            {"id": {"videoId": "v1"}, "snippet": {"title": "Best AI art tools", "publishedAt": _NOW_PUB}},
            {"id": {"videoId": "v2"}, "snippet": {"title": "AI art prompts", "publishedAt": _NOW_PUB}},
        ],
    }
    hydrated = [
        {
            "id": "v1",
            "snippet": {"title": "Best AI art tools", "publishedAt": _NOW_PUB},
            "statistics": {"viewCount": "1000000"},
        },
        {
            "id": "v2",
            "snippet": {"title": "AI art prompts", "publishedAt": _NOW_PUB},
            "statistics": {"viewCount": "200000"},
        },
    ]
    monkeypatch.setattr(kw_route.yt, "search_raw", lambda *a, **kw: raw_search_resp)
    monkeypatch.setattr(kw_route.yt, "videos_details", lambda ids: hydrated[: len(ids)])


# ─── Validation ─────────────────────────────────────────────────────────────

def test_keywords_rejects_empty_seed():
    r = client.post("/research/keywords", json={"seed": "", "region": "US", "language": "en"})
    assert r.status_code == 422


# ─── Happy path ─────────────────────────────────────────────────────────────

def test_keywords_happy_path(stub_autocomplete, stub_youtube_happy):
    r = client.post(
        "/research/keywords",
        json={
            "seed": "ai art",
            "region": "US",
            "language": "en",
            "compute_kgr": False,
            "include_questions": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["seed"] == "ai art"
    assert body["region"] == "US"
    assert body["language"] == "en"

    # Suggestions
    keywords_only = [s["keyword"] for s in body["suggestions"]]
    assert "ai art tutorial" in keywords_only
    assert all(s["competition"] == 0 for s in body["suggestions"])  # compute_kgr=false → not filled

    # Seed-level scores wired through (volume / competition / composite + grade).
    assert body["seed_score"]["volume"] > 0
    assert body["seed_score"]["competition"] > 0
    assert body["seed_score"]["keyword"] >= 0
    assert body["seed_score"]["grade"] in {"great", "good", "ok", "weak"}
    assert body["total_results"] == 12345

    # VPH list sorted by vph desc
    assert len(body["vph_top"]) == 2
    assert body["vph_top"][0]["vph"] >= body["vph_top"][1]["vph"]
    assert body["vph_top"][0]["url"].startswith("https://youtube.com/watch?v=")

    # Question buckets populated for English
    assert "how" in body["questions"]
    assert all(s.startswith("how ai art") for s in body["questions"]["how"])

    assert body["warnings"] == []


# ─── KGR per keyword ────────────────────────────────────────────────────────

def test_keywords_kgr_fills_competition(monkeypatch, stub_autocomplete, stub_youtube_happy):
    """When compute_kgr=true, each keyword gets a competition value + score + grade."""
    counts = iter([100, 1000, 10000, 200000])  # easy / medium / medium / hard

    def kgr_search(query, **kw):
        return {"pageInfo": {"totalResults": next(counts, 0)}}

    # First call (seed-level) goes to the original happy stub via search_raw,
    # subsequent KGR calls go through here too — re-stub with our counter.
    call_count = {"n": 0}
    happy = kw_route.yt.search_raw

    def proxy(query, *a, **kw):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return happy(query, *a, **kw)  # seed-level top-results call
        return kgr_search(query, **kw)

    monkeypatch.setattr(kw_route.yt, "search_raw", proxy)

    r = client.post(
        "/research/keywords",
        json={"seed": "ai art", "compute_kgr": True, "max_kgr_keywords": 4, "include_questions": False},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # 4 suggestions, all should now carry per-keyword competition + grade.
    assert len(body["suggestions"]) == 4
    grades = {s["grade"] for s in body["suggestions"]}
    assert grades.issubset({"easy", "medium", "hard"})
    competitions = [s["competition"] for s in body["suggestions"]]
    assert competitions == [100, 1000, 10000, 200000]
    # easy + hard endpoints should have appropriate scores
    assert body["suggestions"][0]["score"] >= 70  # comp=100 → easy
    assert body["suggestions"][3]["score"] <= 40  # comp=200000 → hard


# ─── Failure modes ──────────────────────────────────────────────────────────

def test_keywords_all_upstreams_fail(monkeypatch):
    """Every upstream raises → 200 with empty payload + warnings."""

    def boom(*a, **kw):
        raise RuntimeError("Thieu key / network / ratelimit")

    monkeypatch.setattr(kw_route.autocomplete, "suggest", boom)
    monkeypatch.setattr(kw_route.yt, "search_raw", boom)
    monkeypatch.setattr(kw_route.yt, "videos_details", boom)
    monkeypatch.setattr(kw_route.kw, "question_buckets", boom)

    r = client.post(
        "/research/keywords",
        json={"seed": "obscure", "compute_kgr": False, "include_questions": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["suggestions"] == []
    assert body["vph_top"] == []
    assert body["questions"] == {}
    assert body["total_results"] == 0
    joined = " ".join(body["warnings"])
    assert "autocomplete.suggest" in joined
    assert "youtube.search_raw" in joined


def test_keywords_skip_questions(monkeypatch, stub_autocomplete, stub_youtube_happy):
    """include_questions=false → question_buckets is never called."""
    monkeypatch.setattr(kw_route.kw, "question_buckets", lambda *a, **kw: pytest.fail("should not be called"))

    r = client.post(
        "/research/keywords",
        json={"seed": "ai art", "include_questions": False},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["questions"] == {}
    assert body["suggestions"], "suggestions still populated by autocomplete"
