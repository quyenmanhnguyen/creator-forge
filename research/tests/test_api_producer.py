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
from research.core.pixelle.video_probe import VideoValidateResult

app = create_app()
client = TestClient(app)


@pytest.fixture(autouse=True)
def _bypass_video_validation(monkeypatch):
    """Default all /producer/short tests to "validation passes".

    PR-20E wires ``validate_video_output`` into both the
    ``video_scene_assets[]`` input loop and the final ``short.mp4``
    check. The fake ``_make_short`` used throughout this file writes
    tiny stub mp4s that would otherwise fail the 10 KB byte floor (and
    the ffprobe step, when ffprobe is installed on the runner). We
    replace ``_validate_video_output`` with a no-op that always
    returns an "ok" result so unrelated tests keep passing; the
    dedicated PR-20E tests below opt out with their own monkeypatches.
    """
    def _always_ok(file_path, *, min_bytes=0, min_duration_sec=0.0):
        size = 0
        try:
            size = Path(file_path).stat().st_size
        except OSError:
            pass
        return VideoValidateResult(
            ok=True,
            exists=True,
            size=size,
            ffprobe_available=True,
            duration_sec=3.0,
            has_video_stream=True,
            width=720,
            height=1280,
            codec="h264",
            reason=None,
        )
    monkeypatch.setattr(producer_route, "_validate_video_output", _always_ok)


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

    def fake_gen(script: str, *, template, n_scenes=None, chat_fn=None, words_per_minute=150, **kw):
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

    def fake_gen(script: str, *, template, n_scenes=None, chat_fn=None, words_per_minute=150, **kw):
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

    def fake_gen(script: str, *, template, n_scenes=None, chat_fn=None, words_per_minute=150, **kw):
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

    def fake_gen(script: str, *, template: SceneTemplate, n_scenes=None, chat_fn=None, words_per_minute=150, **kw):
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


# ─── /producer/short — scene_assets wiring (PR-14) ──────────────────────────


def _basic_fake_tts():
    """Reusable fake Edge-TTS adapter that yields a 4s clip + 2 word boundaries."""

    class FakeAdapter:
        name = "fake-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 8)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=4.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[
                    WordBoundary(start_s=0.0, end_s=2.0, text="Welcome"),
                    WordBoundary(start_s=2.0, end_s=4.0, text="creator-forge."),
                ],
            )

    return FakeAdapter


def test_short_passes_scene_assets_to_composer(monkeypatch, tmp_path):
    """Happy path: every scene_assets entry has an existing file → all
    pass through to ``_make_short`` as ``SceneAsset`` instances and the
    response counts ``scenes_used``."""
    captured: dict[str, Any] = {}

    img_a = tmp_path / "scene_a.jpg"
    img_b = tmp_path / "scene_b.jpg"
    img_a.write_bytes(b"\xff" * 1024)
    img_b.write_bytes(b"\xff" * 1024)

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, **_):
        captured["scene_assets"] = scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    out = tmp_path / "out_scene_assets_ok"
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "output_dir": str(out),
            "scene_assets": [
                {"image_path": str(img_a), "start_s": 0.0, "duration_s": 2.0},
                {"image_path": str(img_b), "start_s": 2.0, "duration_s": 2.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenes_used"] == 2
    assert body["scenes_missing"] == 0
    assert body["warnings"] == []

    # _make_short must have received exactly two SceneAsset instances,
    # in declaration order, with the requested timings.
    assets = captured["scene_assets"]
    assert assets is not None
    assert len(assets) == 2
    assert all(a.__class__.__name__ == "SceneAsset" for a in assets)
    assert assets[0].image_path == img_a
    assert assets[0].start_s == 0.0
    assert assets[0].duration_s == 2.0
    assert assets[1].image_path == img_b
    assert assets[1].start_s == 2.0
    assert assets[1].duration_s == 2.0


def test_short_skips_missing_scene_asset_with_warning(monkeypatch, tmp_path):
    """Robust failure mode: a scene_assets entry whose image_path doesn't
    exist must NOT 422 the whole request — it gets a friendly warning,
    is dropped from the composer payload, and counted in
    ``scenes_missing``. This mirrors the rest of the suite (e.g. studio
    LLM failures still return 200 + warnings)."""
    captured: dict[str, Any] = {}

    img_a = tmp_path / "scene_a.jpg"
    img_a.write_bytes(b"\xff" * 1024)

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, **_):
        captured["scene_assets"] = scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    out = tmp_path / "out_scene_assets_partial"
    missing_path = str(tmp_path / "does_not_exist.jpg")
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "output_dir": str(out),
            "scene_assets": [
                {"image_path": str(img_a), "start_s": 0.0, "duration_s": 2.0},
                {"image_path": missing_path, "start_s": 2.0, "duration_s": 2.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenes_used"] == 1
    assert body["scenes_missing"] == 1
    assert any("does_not_exist.jpg" in w for w in body["warnings"]), body["warnings"]

    # Composer received only the surviving asset.
    assets = captured["scene_assets"]
    assert assets is not None
    assert len(assets) == 1
    assert assets[0].image_path == img_a


def test_short_omits_scene_assets_preserves_gradient_default(monkeypatch, tmp_path):
    """Backwards-compat: when the caller omits ``scene_assets`` the
    composer must still be invoked with ``scene_assets=None`` (gradient
    Ken-Burns fallback) and the response reports ``scenes_used=0``."""
    captured: dict[str, Any] = {}

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, **_):
        captured["scene_assets"] = scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    out = tmp_path / "out_no_scene_assets"
    r = client.post(
        "/producer/short",
        json={"script": SHORT_SCRIPT, "output_dir": str(out)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenes_used"] == 0
    assert body["scenes_missing"] == 0
    assert captured["scene_assets"] is None


def test_short_rejects_invalid_scene_asset_timings():
    """Pydantic-level validation: duration_s must be > 0 and start_s must
    be >= 0. These are programmer errors, not partial-batch failures, so
    a 422 is appropriate (unlike a missing-file case)."""
    # duration_s = 0 → 422
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "scene_assets": [
                {"image_path": "/tmp/x.jpg", "start_s": 0.0, "duration_s": 0.0},
            ],
        },
    )
    assert r.status_code == 422, r.text

    # start_s < 0 → 422
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "scene_assets": [
                {"image_path": "/tmp/x.jpg", "start_s": -1.0, "duration_s": 1.0},
            ],
        },
    )
    assert r.status_code == 422, r.text

    # whitespace-only image_path → 422 after strip
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "scene_assets": [
                {"image_path": "   ", "start_s": 0.0, "duration_s": 1.0},
            ],
        },
    )
    assert r.status_code == 422, r.text


# ─── /producer/short — video_scene_assets wiring (PR-20A) ───────────────────


def test_short_passes_video_scene_assets_to_composer(monkeypatch, tmp_path):
    """Happy path: every video_scene_assets entry has an existing mp4 →
    all pass through to ``_make_short`` as ``VideoSceneAsset`` instances
    and the response counts ``videos_used``. ``scene_assets`` is None so
    the composer receives ``scene_assets=None`` (gradient unused — video
    path wins per :func:`make_short`).
    """
    captured: dict[str, Any] = {}

    v_a = tmp_path / "scene_a.mp4"
    v_b = tmp_path / "scene_b.mp4"
    v_a.write_bytes(b"\x00" * 1024)
    v_b.write_bytes(b"\x00" * 1024)

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, video_scene_assets=None, **_):
        captured["scene_assets"] = scene_assets
        captured["video_scene_assets"] = video_scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    out = tmp_path / "out_video_scene_assets_ok"
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "output_dir": str(out),
            "video_scene_assets": [
                {"video_path": str(v_a), "start_s": 0.0, "duration_s": 2.0},
                {"video_path": str(v_b), "start_s": 2.0, "duration_s": 2.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["videos_used"] == 2
    assert body["videos_missing"] == 0
    assert body["scenes_used"] == 0
    assert body["scenes_missing"] == 0
    assert body["warnings"] == []

    # _make_short must have received exactly two VideoSceneAsset instances,
    # in declaration order, with the requested timings.
    vassets = captured["video_scene_assets"]
    assert vassets is not None
    assert len(vassets) == 2
    assert all(a.__class__.__name__ == "VideoSceneAsset" for a in vassets)
    assert vassets[0].video_path == v_a
    assert vassets[0].start_s == 0.0
    assert vassets[0].duration_s == 2.0
    assert vassets[1].video_path == v_b
    assert vassets[1].start_s == 2.0
    assert vassets[1].duration_s == 2.0
    # Image path must be untouched.
    assert captured["scene_assets"] is None


def test_short_skips_missing_video_scene_asset_with_warning(monkeypatch, tmp_path):
    """Robust failure mode: a video_scene_assets entry whose video_path
    doesn't exist must NOT 422 the whole request — it gets a friendly
    warning, is dropped from the composer payload, and counted in
    ``videos_missing``. Mirrors the ``scene_assets`` contract (PR-14)."""
    captured: dict[str, Any] = {}

    v_a = tmp_path / "scene_a.mp4"
    v_a.write_bytes(b"\x00" * 1024)

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, video_scene_assets=None, **_):
        captured["video_scene_assets"] = video_scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    out = tmp_path / "out_video_scene_assets_partial"
    missing_path = str(tmp_path / "nope.mp4")
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "output_dir": str(out),
            "video_scene_assets": [
                {"video_path": str(v_a), "start_s": 0.0, "duration_s": 2.0},
                {"video_path": missing_path, "start_s": 2.0, "duration_s": 2.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["videos_used"] == 1
    assert body["videos_missing"] == 1
    assert any("nope.mp4" in w for w in body["warnings"]), body["warnings"]

    vassets = captured["video_scene_assets"]
    assert vassets is not None
    assert len(vassets) == 1
    assert vassets[0].video_path == v_a


def test_short_passes_both_scene_and_video_scene_assets(monkeypatch, tmp_path):
    """Mixed: caller supplies BOTH ``scene_assets`` and
    ``video_scene_assets``. The route forwards both lists untouched —
    the composer applies its priority chain (video > image > gradient,
    see :func:`research.core.pixelle.composer.make_short`). The
    ``ShortResponse`` reports each list independently so the UI can tell
    how many of each made it through."""
    captured: dict[str, Any] = {}

    img = tmp_path / "fallback.jpg"
    img.write_bytes(b"\xff" * 1024)
    vid = tmp_path / "scene.mp4"
    vid.write_bytes(b"\x00" * 1024)

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, video_scene_assets=None, **_):
        captured["scene_assets"] = scene_assets
        captured["video_scene_assets"] = video_scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "output_dir": str(tmp_path / "out_mixed"),
            "scene_assets": [
                {"image_path": str(img), "start_s": 0.0, "duration_s": 4.0},
            ],
            "video_scene_assets": [
                {"video_path": str(vid), "start_s": 0.0, "duration_s": 4.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenes_used"] == 1
    assert body["scenes_missing"] == 0
    assert body["videos_used"] == 1
    assert body["videos_missing"] == 0
    assert body["warnings"] == []

    # Both lists reach the composer — composer handles priority itself.
    sassets = captured["scene_assets"]
    vassets = captured["video_scene_assets"]
    assert sassets is not None and len(sassets) == 1
    assert vassets is not None and len(vassets) == 1
    assert sassets[0].image_path == img
    assert vassets[0].video_path == vid


def test_short_video_all_missing_falls_back_to_image_assets(monkeypatch, tmp_path):
    """Fallback chain: every ``video_scene_assets`` entry is missing →
    composer is invoked with ``video_scene_assets=None`` and
    ``scene_assets`` is preserved, so the existing image timeline still
    drives the visuals (matches the composer's
    ``elif scene_assets:`` branch). Response surfaces every drop as a
    warning + counts ``videos_missing`` so the UI can tell."""
    captured: dict[str, Any] = {}

    img = tmp_path / "img.jpg"
    img.write_bytes(b"\xff" * 1024)

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, video_scene_assets=None, **_):
        captured["scene_assets"] = scene_assets
        captured["video_scene_assets"] = video_scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "output_dir": str(tmp_path / "out_video_fallback"),
            "scene_assets": [
                {"image_path": str(img), "start_s": 0.0, "duration_s": 4.0},
            ],
            "video_scene_assets": [
                {"video_path": str(tmp_path / "missing_a.mp4"),
                 "start_s": 0.0, "duration_s": 2.0},
                {"video_path": str(tmp_path / "missing_b.mp4"),
                 "start_s": 2.0, "duration_s": 2.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenes_used"] == 1
    assert body["videos_used"] == 0
    assert body["videos_missing"] == 2
    assert sum("missing_a.mp4" in w for w in body["warnings"]) == 1
    assert sum("missing_b.mp4" in w for w in body["warnings"]) == 1

    # Composer must see the image list and a None video list — that's
    # the trigger for the gradient/image fallback path.
    assert captured["video_scene_assets"] is None
    assert captured["scene_assets"] is not None
    assert len(captured["scene_assets"]) == 1


def test_short_omits_video_scene_assets_preserves_default(monkeypatch, tmp_path):
    """Backwards-compat: when the caller omits ``video_scene_assets`` the
    composer must still be invoked with ``video_scene_assets=None`` and
    the response reports ``videos_used=0`` / ``videos_missing=0``."""
    captured: dict[str, Any] = {}

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, video_scene_assets=None, **_):
        captured["video_scene_assets"] = video_scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    r = client.post(
        "/producer/short",
        json={"script": SHORT_SCRIPT, "output_dir": str(tmp_path / "out_no_video")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["videos_used"] == 0
    assert body["videos_missing"] == 0
    assert captured["video_scene_assets"] is None


def test_short_rejects_invalid_video_scene_asset_timings():
    """Pydantic-level validation: duration_s must be > 0, start_s must be
    >= 0, video_path must be non-empty after stripping. These are
    programmer errors (not partial-batch failures) so a 422 is
    appropriate."""
    # duration_s = 0 → 422
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "video_scene_assets": [
                {"video_path": "/tmp/x.mp4", "start_s": 0.0, "duration_s": 0.0},
            ],
        },
    )
    assert r.status_code == 422, r.text

    # start_s < 0 → 422
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "video_scene_assets": [
                {"video_path": "/tmp/x.mp4", "start_s": -1.0, "duration_s": 1.0},
            ],
        },
    )
    assert r.status_code == 422, r.text

    # whitespace-only video_path → 422 after strip
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "video_scene_assets": [
                {"video_path": "   ", "start_s": 0.0, "duration_s": 1.0},
            ],
        },
    )
    assert r.status_code == 422, r.text


# ─── PR-20E: ffprobe-backed video validation ───────────────────────────────

def test_short_drops_video_scene_asset_when_validator_says_not_ok(monkeypatch, tmp_path):
    """A video_scene_assets entry that exists on disk but fails
    ``_validate_video_output`` (truncated mp4, no video stream, etc.)
    must be dropped from the composer payload with a validation-failed
    warning and counted in ``videos_missing`` — it must NOT silently
    render as a corrupt segment inside the final short.
    """
    captured: dict[str, Any] = {}

    v_bad = tmp_path / "bad.mp4"
    v_good = tmp_path / "good.mp4"
    v_bad.write_bytes(b"\x00" * 1024)
    v_good.write_bytes(b"\x00" * 1024)

    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, video_scene_assets=None, **_):
        captured["video_scene_assets"] = video_scene_assets
        Path(output_path).write_bytes(b"\x00" * 16)
        return Path(output_path)

    def selective_validator(file_path, *, min_bytes=0, min_duration_sec=0.0):
        p = Path(file_path)
        if p.name == "bad.mp4":
            return VideoValidateResult(
                ok=False, exists=True, size=1024, ffprobe_available=True,
                has_video_stream=False, reason="no video stream",
            )
        return VideoValidateResult(
            ok=True, exists=True, size=1024, ffprobe_available=True,
            has_video_stream=True, duration_sec=2.0,
        )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)
    monkeypatch.setattr(producer_route, "_validate_video_output", selective_validator)

    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "output_dir": str(tmp_path / "out_pr20e_drop"),
            "video_scene_assets": [
                {"video_path": str(v_bad), "start_s": 0.0, "duration_s": 2.0},
                {"video_path": str(v_good), "start_s": 2.0, "duration_s": 2.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["videos_used"] == 1
    assert body["videos_missing"] == 1
    assert any("validation failed" in w and "bad.mp4" in w for w in body["warnings"])
    vassets = captured["video_scene_assets"]
    assert vassets is not None and len(vassets) == 1
    assert vassets[0].video_path == v_good


def test_short_final_mp4_fails_validation_returns_empty_mp4_path(monkeypatch, tmp_path):
    """If ``_make_short`` writes a file but it fails validation (e.g.
    moviepy crashed mid-write leaving a 0-byte stub, or ffprobe says
    no video stream), the response must drop ``mp4_path`` back to ``""``
    so the renderer doesn't show a "generated" mp4 that won't play. A
    warning surfaces the reason. Audio / captions survive — this is
    the allow_partial contract from earlier PRs.
    """
    def fake_compose(audio_path, output_path, *, captions=None, duration_hint=None,
                     options=None, scene_assets=None, video_scene_assets=None, **_):
        Path(output_path).write_bytes(b"")  # 0-byte stub
        return Path(output_path)

    def rejecting_validator(file_path, *, min_bytes=0, min_duration_sec=0.0):
        return VideoValidateResult(
            ok=False, exists=True, size=0, ffprobe_available=True,
            has_video_stream=False, reason="composed mp4 is 0 bytes",
        )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)
    monkeypatch.setattr(producer_route, "_validate_video_output", rejecting_validator)

    r = client.post(
        "/producer/short",
        json={"script": SHORT_SCRIPT, "output_dir": str(tmp_path / "out_pr20e_final")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mp4_path"] == ""
    assert any("failed validation" in w for w in body["warnings"])
    # Audio still present (allow_partial).
    assert body["audio_path"].endswith("voice.mp3")


def test_short_ffprobe_missing_surfaces_single_warning(monkeypatch, tmp_path):
    """When ffprobe isn't installed, validation soft-passes with
    ``ffprobe_available=False`` and the route surfaces a SINGLE
    warning (not one per asset + one for output) so the UI doesn't
    spam.
    """
    v = tmp_path / "v.mp4"
    v.write_bytes(b"\x00" * 20_000)

    def fake_compose(audio_path, output_path, **_kwargs):
        Path(output_path).write_bytes(b"\x00" * 20_000)
        return Path(output_path)

    def size_only_validator(file_path, *, min_bytes=0, min_duration_sec=0.0):
        return VideoValidateResult(
            ok=True, exists=True, size=20_000, ffprobe_available=False,
            reason="ffprobe unavailable on this machine — fell back to exists+size check",
        )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", _basic_fake_tts())
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)
    monkeypatch.setattr(producer_route, "_validate_video_output", size_only_validator)

    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "output_dir": str(tmp_path / "out_pr20e_noffprobe"),
            "video_scene_assets": [
                {"video_path": str(v), "start_s": 0.0, "duration_s": 2.0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    ffprobe_warnings = [w for w in body["warnings"] if "ffprobe is not on PATH" in w]
    assert len(ffprobe_warnings) == 1, f"expected one ffprobe-missing warning, got {ffprobe_warnings}"
    assert body["videos_used"] == 1


# ---------------------------------------------------------------------------
# PR-23 — TTS provider routing tests.
# ---------------------------------------------------------------------------


def test_short_routes_through_make_tts_adapter_when_factory_is_default(
    monkeypatch, tmp_path
):
    """When ``_tts_adapter_factory`` is the un-monkeypatched default
    (``EdgeTTSAdapter``), :func:`_resolve_tts_adapter` must delegate to
    :func:`make_tts_adapter` so that ``tts_provider`` from the request
    actually picks the engine.
    """
    from research.core.pixelle.tts import EdgeTTSAdapter as RealEdgeTTSAdapter

    captured: dict[str, Any] = {}

    class FakePiper:
        name = "piper-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["engine_called"] = self.name
            captured["voice"] = voice
            output_path = Path(output_path).with_suffix(".wav")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 32)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=2.5,
                voice=voice,
                engine=self.name,
            )

    def fake_make_tts_adapter(provider):
        captured["provider_arg"] = provider
        if provider == "piper-tts":
            return FakePiper()
        return RealEdgeTTSAdapter()

    monkeypatch.setattr(producer_route, "_tts_factory_func", fake_make_tts_adapter)
    monkeypatch.setattr(
        producer_route,
        "_make_short",
        lambda *a, **k: Path(k.get("output_path") or a[1]).write_bytes(b"\x00" * 32) or Path(k.get("output_path") or a[1]),
    )

    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "tts_provider": "piper-tts",
            "voice": "vi_VN-vais1000-medium",
            "output_dir": str(tmp_path / "out_piper"),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert captured["provider_arg"] == "piper-tts"
    assert captured["engine_called"] == "piper-tts"
    assert body["engine"] == "piper-tts"
    # PR-23: when piper writes a .wav file, the response must reflect it.
    assert body["audio_path"].endswith(".wav")


def test_short_unknown_tts_provider_falls_back_to_default(monkeypatch, tmp_path):
    captured: dict[str, Any] = {}

    class FakeEdge:
        name = "edge-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["engine"] = self.name
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 8)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=1.5,
                voice=voice,
                engine=self.name,
            )

    monkeypatch.setattr(
        producer_route, "_tts_factory_func", lambda provider: FakeEdge()
    )
    monkeypatch.setattr(
        producer_route,
        "_make_short",
        lambda *a, **k: Path(k.get("output_path") or a[1]).write_bytes(b"\x00" * 16) or Path(k.get("output_path") or a[1]),
    )
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "tts_provider": "kokoro",  # not in KNOWN_TTS_PROVIDERS
            "output_dir": str(tmp_path / "out_unknown"),
        },
    )
    # Route must NOT 422 on unknown provider — UI may be stale.
    assert r.status_code == 200, r.text
    assert captured["engine"] == "edge-tts"


def test_providers_endpoint_lists_tts_providers():
    r = client.get("/producer/providers")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "tts_providers" in body
    names = [p["name"] for p in body["tts_providers"]]
    assert "edge-tts" in names
    assert "piper-tts" in names
    assert body["tts_default"] == "edge-tts"
    # Each entry has the renderer-friendly shape.
    for p in body["tts_providers"]:
        assert "name" in p and "label" in p and "is_configured" in p


def test_short_keeps_explicit_factory_monkeypatch_for_back_compat(
    monkeypatch, tmp_path
):
    """PR-20E tests still monkeypatch ``_tts_adapter_factory`` directly.
    That contract MUST keep working — _resolve_tts_adapter only routes
    through the registry when the factory is the un-patched default.
    """
    captured: dict[str, Any] = {}

    class FakeTagged:
        name = "fake-back-compat"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["called"] = True
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 8)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=1.0,
                voice=voice,
                engine=self.name,
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeTagged)
    # Even though tts_provider says piper-tts, the explicit factory wins.
    monkeypatch.setattr(
        producer_route,
        "_make_short",
        lambda *a, **k: Path(k.get("output_path") or a[1]).write_bytes(b"\x00" * 16) or Path(k.get("output_path") or a[1]),
    )
    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "tts_provider": "piper-tts",
            "output_dir": str(tmp_path / "out_back_compat"),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert captured["called"] is True
    assert body["engine"] == "fake-back-compat"


def test_short_piper_request_skips_edge_tts_curated_voice_warning(monkeypatch, tmp_path):
    """PR-23 — the curated voice list is Edge-TTS specific. Piper voices
    (e.g. 'vi_VN-vais1000-medium') are NEVER in that list, so the
    'passing through to Edge-TTS as-is' warning would fire on every
    Piper request — misleading and noisy. Suppress it for non-edge-tts
    providers.
    """

    class FakePiper:
        name = "piper-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            wav = Path(output_path).with_suffix(".wav")
            wav.parent.mkdir(parents=True, exist_ok=True)
            wav.write_bytes(b"\x00" * 32)
            return TTSResult(
                audio_path=wav,
                duration_seconds=2.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(
        producer_route, "_tts_factory_func", lambda provider: FakePiper()
    )
    monkeypatch.setattr(
        producer_route,
        "_make_short",
        lambda *a, **kw: Path(kw.get("output_path") or a[1]).write_bytes(b"\x00" * 16) or Path(kw.get("output_path") or a[1]),
    )

    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "tts_provider": "piper-tts",
            "voice": "vi_VN-vais1000-medium",
            "output_dir": str(tmp_path / "out_piper_no_warn"),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    edge_warnings = [w for w in body["warnings"] if "Edge-TTS" in w or "curated list" in w]
    assert edge_warnings == [], f"unexpected Edge-TTS curated-voice warning on Piper request: {edge_warnings}"


def test_short_zero_duration_warning_is_format_aware_for_wav(monkeypatch, tmp_path):
    """PR-23 — when Piper produces a WAV and the duration probe returns
    0, the warning must NOT mention `mutagen` (which is the MP3 probe
    library; WAV is probed via stdlib `wave`).
    """

    class FakeWavAdapter:
        name = "piper-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            wav = Path(output_path).with_suffix(".wav")
            wav.parent.mkdir(parents=True, exist_ok=True)
            wav.write_bytes(b"")  # truncated → wave probe returns 0
            return TTSResult(
                audio_path=wav,
                duration_seconds=0.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeWavAdapter)
    monkeypatch.setattr(
        producer_route,
        "_make_short",
        lambda *a, **kw: pytest.fail("_make_short must not run when duration is 0"),
    )

    r = client.post(
        "/producer/short",
        json={
            "script": SHORT_SCRIPT,
            "tts_provider": "piper-tts",
            "output_dir": str(tmp_path / "out_wav_warn"),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["audio_path"].endswith(".wav")
    duration_warnings = [w for w in body["warnings"] if "duration probe returned 0" in w]
    assert len(duration_warnings) == 1
    # The misleading mutagen suggestion must NOT appear for WAV output.
    assert "mutagen" not in duration_warnings[0]
    assert "WAV" in duration_warnings[0] or "truncated" in duration_warnings[0]


# ─── /producer/audio — PR-30 (TTS-only, no ffmpeg compose) ──────────────────
#
# These tests exercise the audio-only render path. They share the
# ``_tts_adapter_factory`` indirection point with /producer/short tests
# above so they can swap in a fake TTS engine without touching
# edge-tts / piper / moviepy / ffmpeg.

AUDIO_SCRIPT = (
    "Welcome to creator-forge. This is a quick smoke test for the audio-only "
    "compose path. We synthesize narration to MP3, attach captions, and stop."
)


@pytest.mark.parametrize("script_value", ["", " ", "   ", "\t", "\n"])
def test_audio_rejects_empty_or_whitespace_script(script_value):
    r = client.post("/producer/audio", json={"script": script_value})
    assert r.status_code == 422, r.text


def test_audio_happy_path_writes_mp3_and_srt(monkeypatch, tmp_path):
    captured: dict[str, Any] = {}
    compose_called = {"flag": False}

    class FakeAdapter:
        name = "fake-edge"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["text"] = text
            captured["voice"] = voice
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 64)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=5.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[
                    WordBoundary(start_s=0.0, end_s=1.0, text="Welcome"),
                    WordBoundary(start_s=1.0, end_s=2.0, text="back."),
                ],
            )

    def fake_compose(*args, **kwargs):
        # /producer/audio MUST NOT call the composer. If this fires the
        # route accidentally regressed to the /producer/short pipeline.
        compose_called["flag"] = True
        return Path(args[1]) if len(args) >= 2 else None

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)
    monkeypatch.setattr(producer_route, "_make_short", fake_compose)

    out = tmp_path / "audio-out1"
    r = client.post(
        "/producer/audio",
        json={
            "script": "  " + AUDIO_SCRIPT + "  \n",
            "voice": "en-US-AriaNeural",
            "output_dir": str(out),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert captured["text"].startswith("Welcome to creator-forge")
    assert not captured["text"].endswith(" ")
    assert compose_called["flag"] is False, (
        "/producer/audio must not invoke make_short — it's a TTS-only route"
    )
    assert body["audio_path"].endswith("voice.mp3")
    assert body["audio_format"] == "mp3"
    assert body["srt_path"].endswith("captions.srt")
    assert body["duration_s"] == 5.0
    assert body["voice"] == "en-US-AriaNeural"
    assert body["engine"] == "fake-edge"
    assert body["captions_count"] >= 1
    assert body["caption_source"] == "word_boundaries"
    assert body["output_dir"] == str(out)
    assert "mp4_path" not in body, "audio response must not carry an mp4_path field"
    assert (out / "voice.mp3").exists()
    assert (out / "captions.srt").exists()
    # No mp4 should be produced.
    assert not (out / "short.mp4").exists()


def test_audio_falls_back_to_sentence_captions_when_no_word_boundaries(monkeypatch, tmp_path):
    class FakeAdapter:
        name = "fake-edge"

        def synthesize_with_timing(self, text, *, output_path, voice):
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 32)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=8.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)

    r = client.post(
        "/producer/audio",
        json={"script": AUDIO_SCRIPT, "output_dir": str(tmp_path / "audio-out2")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["caption_source"] == "sentence_fallback"
    assert body["captions_count"] >= 1
    assert body["audio_path"]


def test_audio_skips_srt_when_disabled(monkeypatch, tmp_path):
    class FakeAdapter:
        name = "fake-edge"

        def synthesize_with_timing(self, text, *, output_path, voice):
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 16)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=3.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[WordBoundary(start_s=0.0, end_s=1.0, text="Hi.")],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)

    out = tmp_path / "audio-out3"
    r = client.post(
        "/producer/audio",
        json={"script": AUDIO_SCRIPT, "output_dir": str(out), "write_srt": False},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["srt_path"] is None
    assert not (out / "captions.srt").exists()
    # Audio is still produced.
    assert body["audio_path"]
    assert (out / "voice.mp3").exists()


def test_audio_piper_writes_wav_and_reflects_format(monkeypatch, tmp_path):
    """Piper rewrites the output extension to ``.wav`` on its own. The
    route must report the actual extension via ``audio_format`` so the
    renderer can label the result correctly."""
    class FakePiperAdapter:
        name = "piper-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            # Mimic Piper: we got an .mp3 path in, we write a .wav out.
            wav_path = Path(output_path).with_suffix(".wav")
            wav_path.parent.mkdir(parents=True, exist_ok=True)
            wav_path.write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt ")
            return TTSResult(
                audio_path=wav_path,
                duration_seconds=4.5,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakePiperAdapter)

    out = tmp_path / "audio-out4"
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "tts_provider": "piper-tts",
            "voice": "vi_VN-vais1000-medium",
            "output_dir": str(out),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["audio_path"].endswith(".wav")
    assert body["audio_format"] == "wav"
    assert body["engine"] == "piper-tts"
    # No spurious "voice not in curated list" warning when the provider
    # is Piper — that warning is Edge-TTS specific.
    assert not any("curated list" in w for w in body["warnings"])


def test_audio_tts_exception_returns_empty_paths_with_warning(monkeypatch, tmp_path):
    class FailingAdapter:
        name = "broken-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            raise RuntimeError("simulated edge-tts network error")

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FailingAdapter)

    r = client.post(
        "/producer/audio",
        json={"script": AUDIO_SCRIPT, "output_dir": str(tmp_path / "audio-out5")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["audio_path"] == "", "audio must be empty when TTS failed"
    assert body["srt_path"] is None
    assert body["caption_source"] == "none"
    assert any("simulated edge-tts" in w for w in body["warnings"])


def test_audio_default_output_dir_uses_audio_prefix(monkeypatch, tmp_path):
    """The auto-generated output dir must use the ``audio-<ts>`` prefix
    (not ``short-<ts>``) so the user can tell at a glance which renders
    were audio-only.
    """
    sentinel = tmp_path / "auto-audio-1234"

    class FakeAdapter:
        name = "fake-edge"

        def synthesize_with_timing(self, text, *, output_path, voice):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(b"\x00")
            return TTSResult(
                audio_path=Path(output_path),
                duration_seconds=1.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeAdapter)
    monkeypatch.setattr(
        producer_route, "_default_audio_output_dir", lambda: sentinel
    )

    r = client.post("/producer/audio", json={"script": AUDIO_SCRIPT})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["output_dir"] == str(sentinel)
    assert sentinel.exists()


# ─── /producer/assemble — PR-31 (concat scene videos + audio + soft subs) ───
#
# These tests stub ``assembler.assemble_final_mp4`` (and its underlying
# ffmpeg / ffprobe runners) so the route logic can be exercised
# without touching ffmpeg on the host. The deeper structural
# guarantees (argv shape, codec normalisation, trim policy) live in
# ``research/tests/test_assembler.py``; here we cover request
# validation, default ``assembly-<ts>`` output dir, and the response
# shape adapter.

ASSEMBLE_SCRIPT_DIR_PREFIX = "assembly-"


@pytest.mark.parametrize("payload", [
    {"scene_videos": []},                # min_length=1 violated
    {"scene_videos": ["", "  "]},        # all-whitespace → cleaned to []
    {},                                  # missing scene_videos entirely
])
def test_assemble_rejects_empty_or_blank_scene_videos(payload):
    r = client.post("/producer/assemble", json=payload)
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("audio_mode", ["replace", "none"])
@pytest.mark.parametrize("trim_to", ["video", "audio"])
def test_assemble_accepts_documented_modes(monkeypatch, tmp_path, audio_mode, trim_to):
    from research.core.pixelle import assembler as assembler_mod

    captured: dict[str, Any] = {}

    def fake_assemble(**kwargs):
        captured.update(kwargs)
        return assembler_mod.AssembleResult(
            final_path=str(kwargs["output_dir"] / "final.mp4"),
            duration_s=12.0,
            scene_count=len(kwargs["scene_videos"]),
            audio_attached=kwargs["audio_mode"] == "replace",
            captions_attached=kwargs["caption_mode"] in ("soft", "burn"),
            output_dir=str(kwargs["output_dir"]),
        )

    monkeypatch.setattr(assembler_mod, "assemble_final_mp4", fake_assemble)

    out = tmp_path / "out"
    r = client.post(
        "/producer/assemble",
        json={
            "scene_videos": ["/tmp/a.mp4", "/tmp/b.mp4"],
            "audio_path": "/tmp/voice.mp3",
            "output_dir": str(out),
            "audio_mode": audio_mode,
            "trim_to": trim_to,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["video_path"].endswith("final.mp4")
    assert body["scene_count"] == 2
    assert body["audio_attached"] is (audio_mode == "replace")
    assert captured["audio_mode"] == audio_mode
    assert captured["trim_to"] == trim_to
    assert captured["caption_mode"] == "soft"


@pytest.mark.parametrize("caption_mode", ["soft", "none", "burn"])
def test_assemble_accepts_documented_caption_modes(monkeypatch, tmp_path, caption_mode):
    """PR-32 — the route must accept all three caption modes in the
    Literal and forward them verbatim to the helper. Validates the
    schema didn't drift after burn was added."""
    from research.core.pixelle import assembler as assembler_mod

    captured: dict[str, Any] = {}

    def fake_assemble(**kwargs):
        captured.update(kwargs)
        return assembler_mod.AssembleResult(
            final_path=str(kwargs["output_dir"] / "final.mp4"),
            duration_s=10.0,
            scene_count=len(kwargs["scene_videos"]),
            audio_attached=kwargs["audio_mode"] == "replace",
            captions_attached=kwargs["caption_mode"] in ("soft", "burn"),
            output_dir=str(kwargs["output_dir"]),
        )

    monkeypatch.setattr(assembler_mod, "assemble_final_mp4", fake_assemble)

    out = tmp_path / "out"
    r = client.post(
        "/producer/assemble",
        json={
            "scene_videos": ["/tmp/a.mp4"],
            "srt_path": "/tmp/captions.srt",
            "output_dir": str(out),
            "caption_mode": caption_mode,
        },
    )
    assert r.status_code == 200, r.text
    assert captured["caption_mode"] == caption_mode
    assert r.json()["captions_attached"] is (caption_mode in ("soft", "burn"))


def test_assemble_rejects_unknown_caption_mode():
    """Defence-in-depth — if the renderer's whitelist drifts, the
    backend's Literal must still reject the unknown value with 422."""
    r = client.post(
        "/producer/assemble",
        json={
            "scene_videos": ["/tmp/a.mp4"],
            "caption_mode": "explode",
        },
    )
    assert r.status_code == 422, r.text


def test_assemble_default_output_dir_uses_assembly_prefix(monkeypatch, tmp_path):
    """The auto-generated output dir must use the ``assembly-<ts>`` prefix
    so a user with concurrent short / audio / assembly runs can tell
    them apart at a glance.
    """
    from research.core.pixelle import assembler as assembler_mod

    sentinel = tmp_path / "auto-assembly-9999"
    captured: dict[str, Any] = {}

    def fake_assemble(**kwargs):
        captured.update(kwargs)
        return assembler_mod.AssembleResult(
            final_path=str(kwargs["output_dir"] / "final.mp4"),
            duration_s=4.0,
            scene_count=1,
            audio_attached=False,
            captions_attached=False,
            output_dir=str(kwargs["output_dir"]),
        )

    monkeypatch.setattr(assembler_mod, "assemble_final_mp4", fake_assemble)
    monkeypatch.setattr(
        producer_route, "_default_assembly_output_dir", lambda: sentinel,
    )

    r = client.post(
        "/producer/assemble",
        json={"scene_videos": ["/tmp/a.mp4"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["output_dir"] == str(sentinel)
    # The route must hand the resolved path through to the helper —
    # we don't want the helper re-resolving and racing the timestamp.
    assert captured["output_dir"] == sentinel


def test_assemble_route_passes_warnings_through(monkeypatch, tmp_path):
    """When the helper reports warnings (ffmpeg failure, missing audio,
    etc.) the route must surface them verbatim instead of swallowing
    them. The route never returns 500.
    """
    from research.core.pixelle import assembler as assembler_mod

    def fake_assemble(**kwargs):
        return assembler_mod.AssembleResult(
            final_path="",
            scene_count=1,
            output_dir=str(kwargs["output_dir"]),
            warnings=[
                "ffmpeg exited 1: moov atom not found",
                "audio_path not on disk, will render silent video.",
            ],
        )

    monkeypatch.setattr(assembler_mod, "assemble_final_mp4", fake_assemble)

    r = client.post(
        "/producer/assemble",
        json={
            "scene_videos": ["/tmp/a.mp4"],
            "output_dir": str(tmp_path),
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["video_path"] == ""
    assert any("moov atom not found" in w for w in body["warnings"])
    assert any("audio_path not on disk" in w for w in body["warnings"])
