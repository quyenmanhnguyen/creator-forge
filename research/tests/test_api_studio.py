"""Offline tests for ``POST /studio/{topics,titles,outline,script,humanize}``.

Every LLM call is monkeypatched at ``research.core.llm.*`` — the suite
runs without a DeepSeek key and without network.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from research.api.main import create_app
from research.api.routes import studio as studio_route
from research.core import llm

app = create_app()
client = TestClient(app)


# ─── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture
def topics_payload():
    return {
        "ideas": [
            {"topic": "How to fall asleep in 5 minutes", "emotion": "calm", "hook": "what insomniacs do at 2am"},
            {"topic": "Bedtime stories for tired adults", "emotion": "comfort", "hook": "the lullaby ritual"},
        ],
    }


@pytest.fixture
def titles_payload():
    return {
        "titles": [
            {"title": "5 Bedtime Tips That Work in 60s", "reason": "specific time + count", "ctr_rank": 1},
            {"title": "I Slept 8h For The First Time Ever", "reason": "personal stake", "ctr_rank": 2},
            {"title": "Why You Wake Up at 3am Every Night", "reason": "curiosity gap", "ctr_rank": 3},
            {"title": "The Sleep Mistake You Keep Making", "reason": "warning frame", "ctr_rank": None},
        ],
        "top_3": [1, 2, 3],
    }


@pytest.fixture
def outline_payload():
    return {
        "parts": [
            {"part": i, "role": f"Role {i}", "emotion": "calm", "expansion": f"Expansion for part {i}"}
            for i in range(1, 9)
        ],
    }


# ─── Validation ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path, body", [
    ("/studio/topics", {"seed": ""}),
    ("/studio/topics", {"seed": "  "}),
    ("/studio/topics", {"seed": "\t"}),
    ("/studio/titles", {"topic": ""}),
    ("/studio/titles", {"topic": "   "}),
    ("/studio/outline", {"title": ""}),
    ("/studio/outline", {"title": "\n"}),
    ("/studio/humanize", {"script": ""}),
    ("/studio/humanize", {"script": "   "}),
])
def test_studio_rejects_empty_or_whitespace(path, body):
    r = client.post(path, json=body)
    assert r.status_code == 422, r.text


def test_studio_topics_rejects_invalid_language():
    r = client.post("/studio/topics", json={"seed": "ai art", "language": "fr"})
    assert r.status_code == 422


def test_studio_topics_rejects_n_out_of_range():
    r = client.post("/studio/topics", json={"seed": "ai art", "n": 0})
    assert r.status_code == 422
    r = client.post("/studio/topics", json={"seed": "ai art", "n": 51})
    assert r.status_code == 422


def test_studio_script_requires_eight_parts():
    r = client.post(
        "/studio/script",
        json={
            "title": "Sleep Stories",
            "parts": [{"part": i, "role": "x", "emotion": "calm", "expansion": "x"} for i in range(1, 4)],
        },
    )
    assert r.status_code == 422
    body = r.json()
    assert any("outline must have 8 parts" in str(d).lower() or "8" in str(d) for d in body["detail"])


# ─── Step 1 — topics ────────────────────────────────────────────────────────

def test_studio_topics_happy_path(monkeypatch, topics_payload):
    captured: dict = {}

    def fake(seed, *, language, n=20):
        captured["seed"] = seed
        captured["language"] = language
        captured["n"] = n
        return topics_payload

    monkeypatch.setattr(studio_route.llm, "topic_ideas", fake)

    r = client.post("/studio/topics", json={"seed": "  sleep stories  ", "language": "vi", "n": 12})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["seed"] == "sleep stories"
    assert body["language"] == "vi"
    assert len(body["ideas"]) == 2
    assert body["ideas"][0]["topic"] == "How to fall asleep in 5 minutes"
    assert body["warnings"] == []
    # Helper called with the full language label, not the code.
    assert captured["language"].startswith("Vietnamese")
    assert captured["n"] == 12
    assert captured["seed"] == "sleep stories"


def test_studio_topics_missing_deepseek_key(monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)

    monkeypatch.setattr(studio_route.llm, "topic_ideas", boom)

    r = client.post("/studio/topics", json={"seed": "sleep"})
    assert r.status_code == 200
    body = r.json()
    assert body["ideas"] == []
    assert any("DEEPSEEK_API_KEY not set" in w for w in body["warnings"])


def test_studio_topics_handles_malformed_payload(monkeypatch):
    """LLM returns ideas as a non-list — still 200 with empty ideas + warning."""
    monkeypatch.setattr(studio_route.llm, "topic_ideas", lambda *a, **kw: {"ideas": "not a list"})

    r = client.post("/studio/topics", json={"seed": "sleep"})
    assert r.status_code == 200
    body = r.json()
    # str.split? actually list("not a list") iterates chars — those become non-dicts and get skipped.
    assert body["ideas"] == []


# ─── Step 2 — titles ────────────────────────────────────────────────────────

def test_studio_titles_happy_path(monkeypatch, titles_payload):
    captured: dict = {}

    def fake(topic, *, language, n=10, must_keywords=""):
        captured.update({"topic": topic, "language": language, "n": n, "kw": must_keywords})
        return titles_payload

    monkeypatch.setattr(studio_route.llm, "titles_with_ctr", fake)

    r = client.post(
        "/studio/titles",
        json={"topic": "  sleep stories  ", "n": 4, "must_keywords": "  insomnia  "},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["topic"] == "sleep stories"
    assert len(body["titles"]) == 4
    assert body["titles"][0]["ctr_rank"] == 1
    assert body["titles"][3]["ctr_rank"] is None
    # ``chars`` is computed by the route, not the LLM.
    assert body["titles"][0]["chars"] == len("5 Bedtime Tips That Work in 60s")
    assert body["top_3"] == [1, 2, 3]
    assert body["warnings"] == []
    assert captured["kw"] == "insomnia"  # stripped


def test_studio_titles_coerces_non_int_rank(monkeypatch):
    """A LLM returning ctr_rank as 'high' should not 500 — coerce to None."""
    payload = {
        "titles": [{"title": "X", "reason": "y", "ctr_rank": "high"}],
        "top_3": ["1", "abc", 2],
    }
    monkeypatch.setattr(studio_route.llm, "titles_with_ctr", lambda *a, **kw: payload)
    r = client.post("/studio/titles", json={"topic": "x"})
    assert r.status_code == 200
    body = r.json()
    assert body["titles"][0]["ctr_rank"] is None
    # 'abc' coerces to 0 → filtered out.
    assert body["top_3"] == [1, 2]


def test_studio_titles_llm_failure(monkeypatch):
    monkeypatch.setattr(
        studio_route.llm, "titles_with_ctr",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("rate-limited")),
    )
    r = client.post("/studio/titles", json={"topic": "x"})
    assert r.status_code == 200
    body = r.json()
    assert body["titles"] == []
    assert any("Titles failed" in w and "rate-limited" in w for w in body["warnings"])


# ─── Step 3 — outline ───────────────────────────────────────────────────────

def test_studio_outline_happy_path(monkeypatch, outline_payload):
    monkeypatch.setattr(studio_route.llm, "outline_8part", lambda *a, **kw: outline_payload)
    r = client.post("/studio/outline", json={"title": "Sleep Stories"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["parts"]) == 8
    assert body["parts"][0]["part"] == 1
    assert body["parts"][7]["part"] == 8
    assert body["warnings"] == []


def test_studio_outline_warns_on_wrong_part_count(monkeypatch):
    """LLM returns 5 parts instead of 8 — still 200, but warning explains."""
    payload = {"parts": [{"part": i, "role": "x", "emotion": "x", "expansion": "x"} for i in range(1, 6)]}
    monkeypatch.setattr(studio_route.llm, "outline_8part", lambda *a, **kw: payload)
    r = client.post("/studio/outline", json={"title": "Sleep Stories"})
    assert r.status_code == 200
    body = r.json()
    assert len(body["parts"]) == 5
    assert any("expected 8" in w for w in body["warnings"])


def test_studio_outline_missing_deepseek_key(monkeypatch):
    monkeypatch.setattr(
        studio_route.llm, "outline_8part",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)),
    )
    r = client.post("/studio/outline", json={"title": "Sleep Stories"})
    assert r.status_code == 200
    body = r.json()
    assert body["parts"] == []
    assert any("DEEPSEEK_API_KEY not set" in w for w in body["warnings"])


# ─── Step 4 — script ────────────────────────────────────────────────────────

def test_studio_script_happy_path(monkeypatch, outline_payload):
    captured: dict = {}

    def fake(title, parts, *, language, target_chars=18000):
        captured.update({"title": title, "n_parts": len(parts), "language": language, "target": target_chars})
        return "## PART 1 — Hook\nlong body...\n\n## PART 8 — CTA\nclosing"

    monkeypatch.setattr(studio_route.llm, "long_script_chunked", fake)

    r = client.post(
        "/studio/script",
        json={
            "title": "Sleep Stories",
            "parts": outline_payload["parts"],
            "language": "en",
            "target_chars": 8000,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Sleep Stories"
    assert body["chars"] == len(body["script"]) > 0
    assert body["warnings"] == []
    assert captured["n_parts"] == 8
    assert captured["target"] == 8000


def test_studio_script_llm_failure(monkeypatch, outline_payload):
    monkeypatch.setattr(
        studio_route.llm, "long_script_chunked",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)),
    )
    r = client.post(
        "/studio/script",
        json={"title": "X", "parts": outline_payload["parts"]},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["script"] == ""
    assert body["chars"] == 0
    assert any("DEEPSEEK_API_KEY not set" in w for w in body["warnings"])


# ─── Step 5 — humanize ──────────────────────────────────────────────────────

def test_studio_humanize_happy_path(monkeypatch):
    captured: dict = {}

    def fake(script, *, language):
        captured.update({"chars_in": len(script), "language": language})
        return script + "\n[humanized]"

    monkeypatch.setattr(studio_route.llm, "humanize_rewrite", fake)

    raw = "## PART 1\nrobotic AI text"
    r = client.post("/studio/humanize", json={"script": raw, "language": "vi"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["script_final"].endswith("[humanized]")
    assert body["chars_in"] == len(raw)
    assert body["chars_out"] == len(raw) + len("\n[humanized]")
    assert body["warnings"] == []
    assert captured["language"].startswith("Vietnamese")


def test_studio_humanize_llm_failure(monkeypatch):
    monkeypatch.setattr(
        studio_route.llm, "humanize_rewrite",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("timeout")),
    )
    r = client.post("/studio/humanize", json={"script": "raw script"})
    assert r.status_code == 200
    body = r.json()
    assert body["script_final"] == ""
    assert body["chars_out"] == 0
    assert any("Humanize failed" in w and "timeout" in w for w in body["warnings"])
