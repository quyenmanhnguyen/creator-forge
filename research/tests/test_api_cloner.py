"""Offline tests for ``POST /research/cloner``.

Every upstream (``youtube``, ``transcript``, ``lang_detect``, ``llm``) is
stubbed via monkeypatch — the suite runs without network or API keys.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from research.api.main import create_app
from research.api.routes import cloner as cloner_route
from research.core import llm

app = create_app()
client = TestClient(app)


# ─── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture
def video_item():
    """Minimal but realistic videos.list item."""
    return {
        "id": "abcd1234XYZ",
        "snippet": {
            "title": "10 Things You Didn't Know About Sleep",
            "channelId": "UCabc",
            "channelTitle": "DreamLab",
            "publishedAt": "2025-02-01T10:00:00Z",
            "tags": ["sleep", "wellness", "tips", "explainer"],
            "thumbnails": {
                "default": {"url": "https://img.youtube.com/vi/abcd1234XYZ/default.jpg"},
                "high": {"url": "https://img.youtube.com/vi/abcd1234XYZ/hqdefault.jpg"},
                "maxres": {"url": "https://img.youtube.com/vi/abcd1234XYZ/maxresdefault.jpg"},
            },
        },
        "statistics": {"viewCount": "1234567", "likeCount": "45000", "commentCount": "2100"},
        "contentDetails": {"duration": "PT12M34S"},
    }


@pytest.fixture
def transcript_segments():
    return [
        {"text": "Welcome back to DreamLab.", "start": 0.0, "duration": 2.0},
        {"text": "Today we're talking about sleep.", "start": 2.0, "duration": 2.5},
        {"text": "Tip number one: stop scrolling at midnight.", "start": 4.5, "duration": 3.0},
    ]


@pytest.fixture
def clone_kit_dict():
    return {
        "hook_analysis": "**0-15s**: opens with direct address...",
        "title_clones": [f"Title clone {i}" for i in range(1, 11)],
        "script": "## Hook\n...\n## Body\n...\n## CTA\n...",
        "thumbnail_copy": ["YOU WON'T BELIEVE", "TRY THIS TONIGHT", "FREE TIP", "SCIENCE-BACKED", "5 MIN FIX"],
        "tags": [f"tag{i}" for i in range(1, 13)],
    }


@pytest.fixture
def stub_happy(monkeypatch, video_item, transcript_segments, clone_kit_dict):
    """All upstream calls succeed."""
    monkeypatch.setattr(cloner_route.yt, "videos_details", lambda ids: [video_item])
    monkeypatch.setattr(
        cloner_route.transcript,
        "fetch_transcript",
        lambda vid, languages=None: transcript_segments,
    )
    monkeypatch.setattr(cloner_route.lang_detect, "detect_lang", lambda text, default="en": "en")

    captured: dict = {}

    def fake_chat_json(prompt, system=None, model=None):
        captured["prompt"] = prompt
        captured["system"] = system
        return json.dumps(clone_kit_dict)

    monkeypatch.setattr(cloner_route.llm, "chat_json", fake_chat_json)
    return captured


# ─── Validation ─────────────────────────────────────────────────────────────

def test_cloner_rejects_empty_url():
    r = client.post("/research/cloner", json={"url": ""})
    assert r.status_code == 422


@pytest.mark.parametrize("url", [" ", "   ", "\t", "\n"])
def test_cloner_rejects_whitespace_only_url(url):
    r = client.post("/research/cloner", json={"url": url})
    assert r.status_code == 422, r.text


def test_cloner_rejects_invalid_language_override():
    r = client.post(
        "/research/cloner",
        json={"url": "https://youtu.be/abc", "language_override": "fr"},
    )
    assert r.status_code == 422


def test_cloner_rejects_n_titles_out_of_range():
    r1 = client.post("/research/cloner", json={"url": "abc", "n_titles": 0})
    r2 = client.post("/research/cloner", json={"url": "abc", "n_titles": 31})
    assert r1.status_code == 422
    assert r2.status_code == 422


# ─── Happy path ─────────────────────────────────────────────────────────────

def test_cloner_happy_path(stub_happy, video_item):
    r = client.post(
        "/research/cloner",
        json={
            "url": "  https://www.youtube.com/watch?v=abcd1234XYZ&t=10s  ",
            "new_topic": "  protein for cyclists  ",
            "n_titles": 10,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # URL parsed and fingerprint hydrated.
    assert body["video_id"] == "abcd1234XYZ"
    fp = body["fingerprint"]
    assert fp["title"] == video_item["snippet"]["title"]
    assert fp["channel_title"] == "DreamLab"
    assert fp["views"] == 1234567
    assert fp["likes"] == 45000
    assert fp["comments"] == 2100
    assert fp["duration_sec"] == 12 * 60 + 34
    # Engagement rate = (likes + comments) / views * 100, ~3.81%
    assert fp["engagement_rate_pct"] == pytest.approx((45000 + 2100) / 1234567 * 100, abs=0.01)
    assert fp["thumbnail"].endswith("maxresdefault.jpg")
    assert fp["url"] == "https://youtube.com/watch?v=abcd1234XYZ"

    # Transcript carried through and counted.
    assert body["transcript_segments"] == 3
    assert "Welcome back to DreamLab" in body["transcript_excerpt"]

    # Language detect ran; out_lang = detected when override='auto'.
    assert body["detected_language"] == "en"
    assert body["output_language"] == "en"

    # Clone kit populated.
    kit = body["kit"]
    assert kit is not None
    assert len(kit["title_clones"]) == 10
    assert kit["script"].startswith("## Hook")
    assert len(kit["thumbnail_copy"]) == 5
    assert len(kit["tags"]) == 12

    assert body["warnings"] == []

    # The LLM payload received the *stripped* new_topic and right n_titles.
    payload = json.loads(stub_happy["prompt"])
    assert payload["new_topic"] == "protein for cyclists"
    assert payload["n_title_clones"] == 10
    assert payload["original_title"] == video_item["snippet"]["title"]


def test_cloner_language_override_wins_over_detected(monkeypatch, stub_happy):
    """When user passes language_override, it should override detected lang."""
    monkeypatch.setattr(cloner_route.lang_detect, "detect_lang", lambda text, default="en": "en")
    r = client.post(
        "/research/cloner",
        json={"url": "abcd1234XYZ", "language_override": "vi"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["detected_language"] == "en"
    assert body["output_language"] == "vi"
    # System prompt must mention Vietnamese.
    assert "Vietnamese" in stub_happy["system"]


# ─── Failure modes ──────────────────────────────────────────────────────────

def test_cloner_videos_details_failure(monkeypatch):
    """Missing YOUTUBE_API_KEY → 200 with empty fingerprint + warning."""
    def boom(ids):
        raise RuntimeError("Missing YOUTUBE_API_KEY")

    monkeypatch.setattr(cloner_route.yt, "videos_details", boom)

    r = client.post("/research/cloner", json={"url": "abcd1234XYZ"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_id"] == "abcd1234XYZ"
    assert body["fingerprint"]["title"] == ""
    assert any("youtube.videos_details failed" in w for w in body["warnings"])
    assert body["kit"] is None


def test_cloner_video_not_found(monkeypatch):
    """videos.list returns [] → 200 with empty fingerprint + warning."""
    monkeypatch.setattr(cloner_route.yt, "videos_details", lambda ids: [])

    r = client.post("/research/cloner", json={"url": "abcd1234XYZ"})
    assert r.status_code == 200
    body = r.json()
    assert body["fingerprint"]["title"] == ""
    assert any("Video not found" in w for w in body["warnings"])


def test_cloner_transcript_unavailable_still_runs(monkeypatch, video_item, clone_kit_dict):
    """Transcript fetch raises → kit is still generated (title-only)."""
    monkeypatch.setattr(cloner_route.yt, "videos_details", lambda ids: [video_item])

    def boom(vid, languages=None):
        raise RuntimeError("No transcript available for this video")

    monkeypatch.setattr(cloner_route.transcript, "fetch_transcript", boom)
    monkeypatch.setattr(cloner_route.lang_detect, "detect_lang", lambda text, default="en": "en")
    monkeypatch.setattr(
        cloner_route.llm, "chat_json", lambda prompt, system=None, model=None: json.dumps(clone_kit_dict)
    )

    r = client.post("/research/cloner", json={"url": "abcd1234XYZ"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["transcript_segments"] == 0
    assert body["transcript_excerpt"] == ""
    assert body["kit"] is not None
    assert any("transcript.fetch_transcript failed" in w for w in body["warnings"])
    assert "Transcript unavailable" in body["notes"]


def test_cloner_missing_deepseek_key(monkeypatch, video_item, transcript_segments):
    """Missing DEEPSEEK_API_KEY → 200 with kit=None + friendly warning."""
    monkeypatch.setattr(cloner_route.yt, "videos_details", lambda ids: [video_item])
    monkeypatch.setattr(
        cloner_route.transcript, "fetch_transcript", lambda vid, languages=None: transcript_segments
    )
    monkeypatch.setattr(cloner_route.lang_detect, "detect_lang", lambda text, default="en": "en")

    def boom(prompt, system=None, model=None):
        raise RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)

    monkeypatch.setattr(cloner_route.llm, "chat_json", boom)

    r = client.post("/research/cloner", json={"url": "abcd1234XYZ"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kit"] is None
    # Fingerprint and transcript still present.
    assert body["fingerprint"]["title"] != ""
    assert body["transcript_segments"] == 3
    assert any("DEEPSEEK_API_KEY not set" in w for w in body["warnings"])


def test_cloner_llm_returns_invalid_json(monkeypatch, video_item, transcript_segments):
    """DeepSeek returns junk → kit=None + warning, other data still present."""
    monkeypatch.setattr(cloner_route.yt, "videos_details", lambda ids: [video_item])
    monkeypatch.setattr(
        cloner_route.transcript, "fetch_transcript", lambda vid, languages=None: transcript_segments
    )
    monkeypatch.setattr(cloner_route.lang_detect, "detect_lang", lambda text, default="en": "en")
    monkeypatch.setattr(
        cloner_route.llm,
        "chat_json",
        lambda prompt, system=None, model=None: "this is not JSON {",
    )

    r = client.post("/research/cloner", json={"url": "abcd1234XYZ"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kit"] is None
    assert body["fingerprint"]["title"] != ""
    assert any("invalid JSON" in w for w in body["warnings"])


def test_cloner_accepts_youtu_be_short_url(stub_happy):
    """Confirms parse_video_id works through the route for youtu.be format."""
    r = client.post("/research/cloner", json={"url": "https://youtu.be/abcd1234XYZ?t=42"})
    assert r.status_code == 200
    assert r.json()["video_id"] == "abcd1234XYZ"
