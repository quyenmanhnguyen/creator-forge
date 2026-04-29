"""Offline tests for ``POST /producer/scene_breakdown``.

The orchestrator (``research.core.pixelle.scene_breakdown.generate_scene_breakdown``)
is patched so the LLM call never goes out, and the route's
``_make_chat_fn`` factory is bypassed entirely.
"""
from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from research.api.main import create_app
from research.api.routes import producer as producer_route
from research.core import llm
from research.core.pixelle.scene_breakdown import LongFormScene, SceneTemplate

app = create_app()
client = TestClient(app)


SAMPLE_SCRIPT = (
    "## PART 1 — Hook\n"
    "Imagine waking up at 3am again. Heart pounding, the room dim, the day "
    "ahead already heavy on your shoulders.\n\n"
    "## PART 2 — Empathy\n"
    "You are not alone. Millions of adults can't fall asleep, even when they "
    "are exhausted from a hard day.\n\n"
    "## PART 3 — Problem\n"
    "Most sleep advice is generic — count sheep, drink tea, dim the lights — "
    "but none of it engages the part of the brain that actually winds you down."
)


def _scene(i: int, dur: float = 6.0) -> LongFormScene:
    return LongFormScene(
        scene_id=i,
        title=f"Scene {i} title",
        narration=f"Narration body for scene {i}.",
        image_prompt=f"Image prompt for scene {i}, ultra-detailed.",
        flow_video_prompt=f"Flow video prompt for scene {i}, four sentences.",
        duration_s=dur,
    )


# ─── Validation ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("script_value", ["", " ", "   ", "\t", "\n"])
def test_producer_rejects_empty_or_whitespace_script(script_value):
    r = client.post("/producer/scene_breakdown", json={"script": script_value})
    assert r.status_code == 422, r.text


def test_producer_rejects_unknown_template_key():
    r = client.post(
        "/producer/scene_breakdown",
        json={"script": SAMPLE_SCRIPT, "template_key": "made_up"},
    )
    assert r.status_code == 422
    body = r.json()
    assert any("template_key" in str(d).lower() for d in body["detail"])


def test_producer_rejects_n_scenes_out_of_range():
    r = client.post(
        "/producer/scene_breakdown",
        json={"script": SAMPLE_SCRIPT, "n_scenes": 2},  # < 3
    )
    assert r.status_code == 422
    r = client.post(
        "/producer/scene_breakdown",
        json={"script": SAMPLE_SCRIPT, "n_scenes": 61},  # > 60
    )
    assert r.status_code == 422


def test_producer_rejects_words_per_minute_out_of_range():
    r = client.post(
        "/producer/scene_breakdown",
        json={"script": SAMPLE_SCRIPT, "words_per_minute": 80},
    )
    assert r.status_code == 422
    r = client.post(
        "/producer/scene_breakdown",
        json={"script": SAMPLE_SCRIPT, "words_per_minute": 250},
    )
    assert r.status_code == 422


def test_producer_rejects_invalid_language():
    r = client.post(
        "/producer/scene_breakdown",
        json={"script": SAMPLE_SCRIPT, "language": "fr"},
    )
    assert r.status_code == 422


def test_producer_strips_script_before_use(monkeypatch):
    """Leading/trailing whitespace must be stripped — but a non-empty body
    after stripping must still flow through the orchestrator."""
    captured: dict[str, Any] = {}

    def fake_gen(script: str, *, template, n_scenes=None, chat_fn=None, words_per_minute=150):
        captured["script"] = script
        captured["n_scenes"] = n_scenes
        return [_scene(i) for i in range(1, 4)]

    monkeypatch.setattr(producer_route, "generate_scene_breakdown", fake_gen)
    r = client.post(
        "/producer/scene_breakdown",
        json={"script": "  " + SAMPLE_SCRIPT + "  \n", "n_scenes": 3},
    )
    assert r.status_code == 200, r.text
    assert captured["script"].startswith("## PART 1")
    assert not captured["script"].endswith(" ")
    assert captured["n_scenes"] == 3


# ─── Happy path ────────────────────────────────────────────────────────────

def test_producer_happy_path(monkeypatch):
    captured: dict[str, Any] = {}
    scenes = [_scene(i, dur=8.0) for i in range(1, 9)]

    def fake_gen(script: str, *, template, n_scenes=None, chat_fn=None, words_per_minute=150):
        captured.update(
            {
                "template_key": template.key,
                "n_scenes": n_scenes,
                "wpm": words_per_minute,
                "chat_fn_callable": callable(chat_fn),
            }
        )
        return scenes

    monkeypatch.setattr(producer_route, "generate_scene_breakdown", fake_gen)

    r = client.post(
        "/producer/scene_breakdown",
        json={
            "script": SAMPLE_SCRIPT,
            "template_key": "factory",
            "n_scenes": 8,
            "words_per_minute": 160,
            "language": "en",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["template_key"] == "factory"
    assert body["template_label"].startswith("Factory")
    assert body["language"] == "en"
    assert body["n_scenes_requested"] == 8
    assert body["n_scenes_returned"] == 8
    assert body["words"] > 0
    assert body["total_duration_s_estimate"] > 0
    assert len(body["scenes"]) == 8
    assert body["scenes"][0]["scene_id"] == 1
    assert body["scenes"][0]["narration"].startswith("Narration body")
    # md is round-trippable from the scenes.
    assert "Scene 1:" in body["md"]
    assert "IMAGE PROMPT:" in body["md"]
    assert "FLOW VIDEO PROMPT:" in body["md"]
    assert body["warnings"] == []
    # The route must inject a chat_fn — generate_scene_breakdown's default
    # chat path tries to ``from core.llm import chat`` which doesn't work in
    # the sidecar.
    assert captured["chat_fn_callable"] is True
    assert captured["template_key"] == "factory"
    assert captured["wpm"] == 160


def test_producer_auto_estimates_n_scenes(monkeypatch):
    """When n_scenes is None, the route must call the orchestrator with the
    same value that estimate_scene_count() returned (mirrored to the
    response's ``n_scenes_estimated`` field)."""
    captured: dict[str, Any] = {}

    def fake_gen(script: str, *, template, n_scenes=None, chat_fn=None, words_per_minute=150):
        captured["n_scenes_passed"] = n_scenes
        return [_scene(i) for i in range(1, (n_scenes or 3) + 1)]

    monkeypatch.setattr(producer_route, "generate_scene_breakdown", fake_gen)

    r = client.post("/producer/scene_breakdown", json={"script": SAMPLE_SCRIPT})
    assert r.status_code == 200
    body = r.json()
    assert body["n_scenes_requested"] is None
    assert body["n_scenes_estimated"] == captured["n_scenes_passed"]
    assert body["n_scenes_estimated"] >= 3


def test_producer_default_template(monkeypatch):
    """No template_key in request → defaults to ``cinematic``."""
    captured: dict[str, Any] = {}

    def fake_gen(script: str, *, template: SceneTemplate, n_scenes=None, chat_fn=None, words_per_minute=150):
        captured["template_key"] = template.key
        return [_scene(i) for i in range(1, 4)]

    monkeypatch.setattr(producer_route, "generate_scene_breakdown", fake_gen)
    r = client.post("/producer/scene_breakdown", json={"script": SAMPLE_SCRIPT})
    assert r.status_code == 200
    assert captured["template_key"] == "cinematic"
    assert r.json()["template_key"] == "cinematic"


# ─── Failure modes (always return 200 + warnings) ──────────────────────────

def test_producer_missing_deepseek_key(monkeypatch):
    """RuntimeError(ERR_NO_DEEPSEEK_KEY) → 200 with a friendly warning."""

    def boom(*a, **kw):
        raise RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)

    monkeypatch.setattr(producer_route, "generate_scene_breakdown", boom)

    r = client.post("/producer/scene_breakdown", json={"script": SAMPLE_SCRIPT})
    assert r.status_code == 200
    body = r.json()
    assert body["scenes"] == []
    assert body["n_scenes_returned"] == 0
    assert any("DEEPSEEK_API_KEY not set" in w for w in body["warnings"])


def test_producer_llm_runtime_error(monkeypatch):
    """A generic LLM failure → 200 + 'Scene breakdown failed' warning."""

    def boom(*a, **kw):
        raise RuntimeError("rate-limited by DeepSeek")

    monkeypatch.setattr(producer_route, "generate_scene_breakdown", boom)

    r = client.post("/producer/scene_breakdown", json={"script": SAMPLE_SCRIPT})
    assert r.status_code == 200
    body = r.json()
    assert body["scenes"] == []
    assert any("Scene breakdown failed" in w and "rate-limited" in w for w in body["warnings"])


def test_producer_empty_scenes_warns(monkeypatch):
    """LLM returns no scenes (parser couldn't find any) → 200 + hint warning."""
    monkeypatch.setattr(producer_route, "generate_scene_breakdown", lambda *a, **kw: [])

    r = client.post("/producer/scene_breakdown", json={"script": SAMPLE_SCRIPT})
    assert r.status_code == 200
    body = r.json()
    assert body["scenes"] == []
    assert any("zero scenes" in w for w in body["warnings"])


def test_producer_serializer_failure(monkeypatch):
    """If serialize_breakdown_md raises after a successful LLM call, the route
    should still 200 with empty scenes + a serialize-failure warning instead
    of leaking the exception as a 500."""

    monkeypatch.setattr(
        producer_route, "generate_scene_breakdown",
        lambda *a, **kw: [_scene(i) for i in range(1, 4)],
    )
    monkeypatch.setattr(
        producer_route, "serialize_breakdown_md",
        lambda *a, **kw: (_ for _ in ()).throw(TypeError("template arg missing")),
    )

    r = client.post("/producer/scene_breakdown", json={"script": SAMPLE_SCRIPT})
    assert r.status_code == 200
    body = r.json()
    assert body["scenes"] == []
    assert body["md"] == ""
    assert any("Scene breakdown serialize failed" in w for w in body["warnings"])
