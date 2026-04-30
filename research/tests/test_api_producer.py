"""Offline tests for ``POST /producer/scene_breakdown`` and ``/producer/short``.

The orchestrator (``research.core.pixelle.scene_breakdown.generate_scene_breakdown``)
is patched so the LLM call never goes out, and the route's
``_make_chat_fn`` factory is bypassed entirely. ``/producer/short`` swaps in
fake TTS + composer functions via the ``_tts_adapter_factory`` / ``_make_short``
indirection points so no edge-tts / moviepy / ffmpeg is required in CI.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from research.api.main import create_app
from research.api.routes import producer as producer_route
from research.core import llm
from research.core.pixelle.scene_breakdown import LongFormScene, SceneTemplate
from research.core.pixelle.subtitles import WordBoundary
from research.core.pixelle.tts import TTSResult

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


# ─── /producer/voices ───────────────────────────────────────────────────────

def test_voices_returns_curated_list():
    r = client.get("/producer/voices")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True
    assert len(body["voices"]) >= 8
    # Schema spot-check.
    first = body["voices"][0]
    assert {"short_name", "label", "locale", "gender"} <= set(first)
    short_names = {v["short_name"] for v in body["voices"]}
    assert "en-US-AriaNeural" in short_names
    assert body["default"] in short_names


# ─── /producer/providers ────────────────────────────────────────────────────

def test_providers_returns_specs_with_config_status():
    r = client.get("/producer/providers")
    assert r.status_code == 200
    body = r.json()
    names = {p["name"] for p in body["providers"]}
    # Placeholder is always registered + always configured.
    assert "placeholder" in names
    placeholder = next(p for p in body["providers"] if p["name"] == "placeholder")
    assert placeholder["is_configured"] is True
    # Default falls back to placeholder, no extra warnings on a clean
    # environment from listing read-only specs.
    assert body["default"] == "placeholder"


# ─── /producer/short — validation ───────────────────────────────────────────

SHORT_SCRIPT = (
    "Welcome to creator-forge. This is a quick smoke test for the short "
    "compose pipeline. We render text to speech, attach captions, and "
    "stitch a vertical mp4 in three steps."
)


@pytest.mark.parametrize("script_value", ["", " ", "   ", "\t", "\n"])
def test_short_rejects_empty_or_whitespace_script(script_value):
    r = client.post("/producer/short", json={"script": script_value})
    assert r.status_code == 422, r.text


def test_short_strips_script_and_uses_explicit_output_dir(monkeypatch, tmp_path):
    captured: dict[str, Any] = {}

    class FakeAdapter:
        name = "fake-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["text"] = text
            captured["voice"] = voice
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 8)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=4.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[
                    WordBoundary(start_s=0.0, end_s=1.0, text="Hello"),
                    WordBoundary(start_s=1.0, end_s=2.0, text="world."),
                ],
            )

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None, options=None, **_):
        captured["compose_called"] = True
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    r = client.post(
        "/producer/short",
        json={
            "script": "  " + SHORT_SCRIPT + "  \n",
            "voice": "en-US-AriaNeural",
            "style": "violet-pink",
            "output_dir": str(tmp_path / "out1"),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert captured["text"].startswith("Welcome to creator-forge")
    assert not captured["text"].endswith(" ")
    assert captured["voice"] == "en-US-AriaNeural"
    assert captured["compose_called"] is True
    assert body["mp4_path"].endswith("short.mp4")
    assert body["audio_path"].endswith("voice.mp3")
    assert body["srt_path"].endswith("captions.srt")
    assert body["duration_s"] == 4.0
    assert body["voice"] == "en-US-AriaNeural"
    assert body["engine"] == "fake-tts"
    assert body["style"] == "violet-pink"
    assert body["captions_count"] >= 1
    assert body["caption_source"] == "word_boundaries"
    assert body["visual_provider"] == "placeholder"
    assert body["output_dir"] == str(tmp_path / "out1")
    assert body["warnings"] == []
    # Files were actually written.
    assert (tmp_path / "out1" / "voice.mp3").exists()
    assert (tmp_path / "out1" / "short.mp4").exists()
    assert (tmp_path / "out1" / "captions.srt").exists()


def test_short_falls_back_to_sentence_captions_when_no_word_boundaries(monkeypatch, tmp_path):
    class FakeAdapter:
        name = "fake-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 8)
            # No word_boundaries → must use sentence fallback.
            return TTSResult(
                audio_path=output_path,
                duration_seconds=6.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)
    monkeypatch.setattr(
        producer_route, "_make_short",
        lambda audio_path, mp4_path, **kw: Path(mp4_path).write_bytes(b"\x00") or Path(mp4_path),
    )

    r = client.post(
        "/producer/short",
        json={"script": SHORT_SCRIPT, "output_dir": str(tmp_path / "out2")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["caption_source"] == "sentence_fallback"
    assert body["captions_count"] >= 1
    assert body["mp4_path"]


def test_short_warns_on_unknown_style_and_voice(monkeypatch, tmp_path):
    class FakeAdapter:
        name = "fake-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(b"\x00")
            return TTSResult(
                audio_path=Path(output_path),
                duration_seconds=2.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)
    monkeypatch.setattr(
        producer_route, "_make_short",
        lambda audio_path, mp4_path, **kw: Path(mp4_path).write_bytes(b"\x00") or Path(mp4_path),
    )

    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "voice": "xx-YY-DoesNotExistNeural",
            "style": "totally-made-up",
            "output_dir": str(tmp_path / "out3"),
        },
    )
    assert r.status_code == 200
    body = r.json()
    # Unknown style → coerced to default; flagged in warnings.
    assert body["style"] == "violet-pink"
    assert any("Unknown style" in w for w in body["warnings"])
    # Unknown voice → passed through, but flagged.
    assert body["voice"] == "xx-YY-DoesNotExistNeural"
    assert any("not in the curated list" in w for w in body["warnings"])


# ─── /producer/short — failure modes (always 200 + warnings) ────────────────

def test_short_tts_exception_returns_warning_no_500(monkeypatch, tmp_path):
    class BoomAdapter:
        name = "fake-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            raise RuntimeError("edge-tts websocket closed")

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", BoomAdapter)
    # _make_short must NOT be called when audio fails — guard with a tripwire.
    monkeypatch.setattr(
        producer_route, "_make_short",
        lambda *a, **kw: pytest.fail("_make_short must not run when TTS failed"),
    )

    r = client.post(
        "/producer/short",
        json={"script": SHORT_SCRIPT, "output_dir": str(tmp_path / "out4")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["audio_path"] == ""
    assert body["mp4_path"] == ""
    assert body["captions_count"] == 0
    assert body["caption_source"] == "none"
    assert any("TTS failed" in w and "edge-tts websocket closed" in w for w in body["warnings"])


def test_short_compose_exception_keeps_audio_and_captions(monkeypatch, tmp_path):
    """When the composer dies, the audio + SRT we already wrote must still
    be reported (partial result) and mp4_path must be empty."""

    class FakeAdapter:
        name = "fake-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(b"\x00")
            return TTSResult(
                audio_path=Path(output_path),
                duration_seconds=3.5,
                voice=voice,
                engine=self.name,
                word_boundaries=[
                    WordBoundary(start_s=0.0, end_s=1.0, text="Hi."),
                ],
            )

    def boom_compose(audio_path, mp4_path, **kw):
        raise RuntimeError("ffmpeg binary not found")

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)
    monkeypatch.setattr(producer_route, "_make_short", boom_compose)

    out = tmp_path / "out5"
    r = client.post("/producer/short", json={"script": SHORT_SCRIPT, "output_dir": str(out)})
    assert r.status_code == 200
    body = r.json()
    assert body["mp4_path"] == ""           # compose failed → no mp4
    assert body["audio_path"].endswith("voice.mp3")  # but audio survived
    assert body["srt_path"].endswith("captions.srt")
    assert body["captions_count"] >= 1
    assert any("Compose failed" in w and "ffmpeg binary not found" in w for w in body["warnings"])


def test_short_warns_when_audio_duration_unknown(monkeypatch, tmp_path):
    """Audio writes successfully but duration_seconds = 0.0 → composer is
    skipped (cannot render a clip of unknown length)."""

    class FakeAdapter:
        name = "fake-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(b"\x00")
            return TTSResult(
                audio_path=Path(output_path),
                duration_seconds=0.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)
    monkeypatch.setattr(
        producer_route, "_make_short",
        lambda *a, **kw: pytest.fail("_make_short must not run when duration is 0"),
    )

    r = client.post(
        "/producer/short",
        json={"script": SHORT_SCRIPT, "output_dir": str(tmp_path / "out6")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["audio_path"]
    assert body["mp4_path"] == ""
    assert any("duration probe returned 0" in w for w in body["warnings"])


def test_short_skips_srt_when_disabled(monkeypatch, tmp_path):
    class FakeAdapter:
        name = "fake-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(b"\x00")
            return TTSResult(
                audio_path=Path(output_path),
                duration_seconds=2.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[WordBoundary(start_s=0.0, end_s=1.0, text="Hi.")],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)
    monkeypatch.setattr(
        producer_route, "_make_short",
        lambda audio_path, mp4_path, **kw: Path(mp4_path).write_bytes(b"\x00") or Path(mp4_path),
    )

    out = tmp_path / "out7"
    r = client.post(
        "/producer/short",
        json={"script": SHORT_SCRIPT, "output_dir": str(out), "write_srt": False},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["srt_path"] is None
    assert not (out / "captions.srt").exists()
    # Audio + mp4 still produced.
    assert body["audio_path"]
    assert body["mp4_path"]
