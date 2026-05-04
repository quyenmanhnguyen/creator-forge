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


def test_producer_returns_flow_video_prompts_alongside_image_prompts(monkeypatch):
    """PR-48 — when scenes carry ``flow_video_prompts`` (variant case), the
    response must surface them so the renderer can pair video rows 1:1."""

    def fake_gen(script: str, *, template, n_scenes=None, chat_fn=None, **kw):
        s = LongFormScene(
            scene_id=1,
            title="Coffee shop",
            narration="A barista pulls a shot.",
            image_prompt="wide shot",
            flow_video_prompt="slow push-in",
            duration_s=6.0,
            image_prompts=("wide shot", "low-angle", "over-the-shoulder"),
            flow_video_prompts=(
                "Camera dollies in from wide framing.",
                "Tilt up from low-angle as crema flows.",
                "Glide past shoulder toward the cup.",
            ),
        )
        return [s]

    monkeypatch.setattr(producer_route, "generate_scene_breakdown", fake_gen)
    r = client.post(
        "/producer/scene_breakdown",
        json={"script": SAMPLE_SCRIPT, "n_scenes": 3, "images_per_scene": 3},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    scene = body["scenes"][0]
    assert scene["image_prompts"] == ["wide shot", "low-angle", "over-the-shoulder"]
    assert scene["flow_video_prompts"] == [
        "Camera dollies in from wide framing.",
        "Tilt up from low-angle as crema flows.",
        "Glide past shoulder toward the cup.",
    ]
    # Singular fields stay populated for back-compat callers.
    assert scene["flow_video_prompt"] == "slow push-in"


def test_producer_returns_empty_flow_video_prompts_for_legacy_scenes(monkeypatch):
    """Legacy scenes (images_per_scene=1) emit empty arrays — back-compat."""

    monkeypatch.setattr(
        producer_route, "generate_scene_breakdown",
        lambda *a, **kw: [_scene(i) for i in range(1, 4)],
    )
    r = client.post("/producer/scene_breakdown", json={"script": SAMPLE_SCRIPT})
    assert r.status_code == 200
    body = r.json()
    for scene in body["scenes"]:
        assert scene["image_prompts"] == []
        assert scene["flow_video_prompts"] == []


# ─── /producer/variant_prompts ──────────────────────────────────────────────

def test_variant_prompts_returns_image_and_video_prompts(monkeypatch):
    """PR-48 — re-rolling variants returns both image and video prompts paired 1:1."""

    captured: dict[str, Any] = {}

    def fake_image(scene, *, count, visual_dna, chat_fn):
        captured["image_count"] = count
        captured["image_dna"] = visual_dna
        return [f"image variant {i}" for i in range(count)]

    def fake_video(scene, image_prompts, *, chat_fn):
        captured["video_image_prompts"] = list(image_prompts)
        return [f"video for {p}" for p in image_prompts]

    monkeypatch.setattr(producer_route, "expand_image_variants", fake_image)
    monkeypatch.setattr(
        producer_route, "expand_video_variants_for_images", fake_video
    )

    r = client.post(
        "/producer/variant_prompts",
        json={
            "scene": {
                "scene_id": 1,
                "title": "t",
                "narration": "n",
                "image_prompt": "base image",
                "flow_video_prompt": "base motion",
            },
            "count": 3,
            "visual_dna": "warm cinematic",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompts"] == ["image variant 0", "image variant 1", "image variant 2"]
    assert body["video_prompts"] == [
        "video for image variant 0",
        "video for image variant 1",
        "video for image variant 2",
    ]
    assert body["warnings"] == []
    assert captured["image_count"] == 3
    assert captured["image_dna"] == "warm cinematic"
    # The video call gets the *just-expanded* image prompts so the LLM
    # can match each video 1:1 to the right framing.
    assert captured["video_image_prompts"] == [
        "image variant 0",
        "image variant 1",
        "image variant 2",
    ]


def test_variant_prompts_skips_video_call_for_count_one(monkeypatch):
    """count==1 — no need to call the video LLM (no variation possible)."""
    called: dict[str, bool] = {"video": False}

    def fake_image(scene, *, count, visual_dna, chat_fn):
        return ["only image"]

    def fake_video(scene, image_prompts, *, chat_fn):
        called["video"] = True
        return ["should not be called"]

    monkeypatch.setattr(producer_route, "expand_image_variants", fake_image)
    monkeypatch.setattr(
        producer_route, "expand_video_variants_for_images", fake_video
    )

    r = client.post(
        "/producer/variant_prompts",
        json={
            "scene": {
                "scene_id": 1,
                "image_prompt": "base",
                "flow_video_prompt": "vp",
            },
            "count": 1,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["prompts"] == ["only image"]
    # Empty when count==1 — caller falls back to scene-level video prompt.
    assert body["video_prompts"] == []
    assert called["video"] is False


def test_variant_prompts_skips_video_call_when_no_seed(monkeypatch):
    """No flow_video_prompt seed → no video LLM call; empty video_prompts list."""
    called: dict[str, bool] = {"video": False}

    def fake_image(scene, *, count, visual_dna, chat_fn):
        return ["a", "b"]

    def fake_video(scene, image_prompts, *, chat_fn):
        called["video"] = True
        return ["should not be called", "here"]

    monkeypatch.setattr(producer_route, "expand_image_variants", fake_image)
    monkeypatch.setattr(
        producer_route, "expand_video_variants_for_images", fake_video
    )

    r = client.post(
        "/producer/variant_prompts",
        json={
            "scene": {
                "scene_id": 1,
                "image_prompt": "base",
                # No flow_video_prompt → renderer must keep the scene-level one
                # rather than ask for variant-specific prompts.
            },
            "count": 2,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["prompts"] == ["a", "b"]
    assert body["video_prompts"] == []
    assert called["video"] is False


def test_variant_prompts_video_failure_surfaces_warning(monkeypatch):
    """Video LLM call failure → warning + repeat the base prompt."""

    def fake_image(scene, *, count, visual_dna, chat_fn):
        return ["a", "b"]

    def boom(scene, image_prompts, *, chat_fn):
        raise RuntimeError("video LLM down")

    monkeypatch.setattr(producer_route, "expand_image_variants", fake_image)
    monkeypatch.setattr(
        producer_route, "expand_video_variants_for_images", boom
    )

    r = client.post(
        "/producer/variant_prompts",
        json={
            "scene": {
                "scene_id": 1,
                "image_prompt": "base",
                "flow_video_prompt": "scene-level motion",
            },
            "count": 2,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["prompts"] == ["a", "b"]
    assert body["video_prompts"] == ["scene-level motion", "scene-level motion"]
    assert any("Variant video prompts" in w for w in body["warnings"])


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
    # Schema spot-check — every voice now carries a ``provider`` tag
    # so the renderer can filter by the TTS provider dropdown.
    first = body["voices"][0]
    assert {"short_name", "label", "locale", "gender", "provider"} <= set(first)
    short_names = {v["short_name"] for v in body["voices"]}
    assert "en-US-AriaNeural" in short_names
    assert body["default"] in short_names
    # Top-level shape: ``providers`` lists every distinct provider tag,
    # so the UI can render the TTS provider dropdown without hard-coding
    # the list. The default filter (no query param) returns ``provider=None``.
    assert set(body["providers"]) == {"edge-tts", "piper-tts", "elevenlabs"}
    assert body["provider"] is None
    assert body.get("warnings", []) == []


def test_voices_filtered_by_edge_tts_provider():
    r = client.get("/producer/voices?provider=edge-tts")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True
    assert body["provider"] == "edge-tts"
    # All returned voices must be edge-tts; default still in the list.
    assert all(v["provider"] == "edge-tts" for v in body["voices"])
    short_names = {v["short_name"] for v in body["voices"]}
    assert "en-US-AriaNeural" in short_names
    # Piper voices are excluded.
    assert "vi_VN-vais1000-medium" not in short_names
    assert body["default"] in short_names


def test_voices_filtered_by_piper_tts_provider():
    r = client.get("/producer/voices?provider=piper-tts")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True
    assert body["provider"] == "piper-tts"
    assert body["voices"], "piper-tts curated list must not be empty"
    assert all(v["provider"] == "piper-tts" for v in body["voices"])
    short_names = {v["short_name"] for v in body["voices"]}
    # Piper voices land in the filtered set.
    assert "vi_VN-vais1000-medium" in short_names
    # Edge-tts voices do not.
    assert "en-US-AriaNeural" not in short_names
    # Default is the first piper voice (renderer uses this as the
    # initial selection when the user flips the provider dropdown).
    assert body["default"] == body["voices"][0]["short_name"]
    assert body.get("warnings", []) == []


def test_voices_unknown_provider_returns_empty_with_warning():
    r = client.get("/producer/voices?provider=bogus-engine")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True
    assert body["provider"] == "bogus-engine"
    assert body["voices"] == []
    assert body["default"] is None
    assert any("bogus-engine" in w for w in body.get("warnings", []))


def test_voices_provider_query_is_case_insensitive_and_trimmed():
    r = client.get("/producer/voices?provider=  Piper-TTS  ")
    assert r.status_code == 200
    body = r.json()
    # Trim + lowercase so ``  Piper-TTS  `` is handled the same as
    # ``piper-tts``. This matches the route's existing _provider_key
    # normalisation pattern in /producer/short + /producer/audio.
    assert body["provider"] == "piper-tts"
    assert all(v["provider"] == "piper-tts" for v in body["voices"])


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


# ─── /producer/audio — PR-A (target_duration_s + scene_videos auto-fit) ────


def _fake_word_adapter(audio_secs: float, words: list[tuple[float, float, str]]):
    """Build a fake TTS adapter that returns deterministic word boundaries."""

    class FakeAdapter:
        name = "fake-edge"

        def synthesize_with_timing(self, text, *, output_path, voice):
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 64)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=audio_secs,
                voice=voice,
                engine=self.name,
                word_boundaries=[
                    WordBoundary(start_s=s, end_s=e, text=t) for s, e, t in words
                ],
            )

    return FakeAdapter


def test_audio_target_duration_scales_captions_in_srt(monkeypatch, tmp_path):
    """Explicit ``target_duration_s`` stretches captions linearly."""
    monkeypatch.setattr(
        producer_route,
        "_tts_adapter_factory",
        _fake_word_adapter(
            audio_secs=5.0,
            words=[
                (0.0, 1.0, "first"),
                (1.0, 2.0, "second"),
                (2.0, 3.0, "third."),
                (3.0, 4.0, "fourth."),
                (4.0, 5.0, "fifth."),
            ],
        ),
    )
    out = tmp_path / "audio-target"
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(out),
            "target_duration_s": 10.0,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["captions_scaled"] is True
    assert body["target_duration_s"] == 10.0
    assert body["caption_source"] == "word_boundaries"
    # SRT was written and the last caption should end at exactly the
    # target — verify by reading the file off disk.
    srt = (out / "captions.srt").read_text(encoding="utf-8")
    # Last cue is rendered as ``HH:MM:SS,mmm --> HH:MM:SS,mmm``.
    last_cue = [line for line in srt.splitlines() if "-->" in line][-1]
    assert last_cue.split(" --> ")[1].startswith("00:00:10,000"), last_cue


def test_audio_scene_videos_drive_target_via_ffprobe(monkeypatch, tmp_path):
    """When ``scene_videos`` is supplied and ``target_duration_s`` isn't,
    the route runs ffprobe on each path, sums durations, and uses that
    as the auto-fit target."""
    from research.core.pixelle.video_probe import VideoProbeResult

    # Stub probe_video_file: each scene reports 4s of video (12s total).
    def fake_probe(file_path, **kwargs):
        return VideoProbeResult(
            exists=True,
            size=12_345,
            ffprobe_available=True,
            duration_sec=4.5,
            video_stream_duration_sec=4.0,  # video stream wins over container
            has_video_stream=True,
            width=720,
            height=1280,
            codec="h264",
        )

    monkeypatch.setattr(producer_route, "probe_video_file", fake_probe)
    monkeypatch.setattr(
        producer_route,
        "_tts_adapter_factory",
        _fake_word_adapter(
            audio_secs=6.0,
            words=[
                (0.0, 2.0, "alpha"),
                (2.0, 4.0, "beta"),
                (4.0, 6.0, "gamma."),
            ],
        ),
    )

    out = tmp_path / "audio-scene-videos"
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(out),
            "scene_videos": [
                "/abs/path/shot1.mp4",
                "/abs/path/shot2.mp4",
                "/abs/path/shot3.mp4",
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["captions_scaled"] is True
    # 3 scenes × 4.0s each.
    assert body["target_duration_s"] == 12.0
    last_cue = [
        line for line in (out / "captions.srt").read_text("utf-8").splitlines()
        if "-->" in line
    ][-1]
    assert last_cue.split(" --> ")[1].startswith("00:00:12,000")


def test_audio_target_duration_overrides_scene_videos(monkeypatch, tmp_path):
    """Explicit ``target_duration_s`` wins over the ``scene_videos`` sum."""
    from research.core.pixelle.video_probe import VideoProbeResult

    monkeypatch.setattr(
        producer_route,
        "probe_video_file",
        lambda *_a, **_kw: VideoProbeResult(
            exists=True,
            size=1024,
            ffprobe_available=True,
            duration_sec=20.0,
            video_stream_duration_sec=20.0,
            has_video_stream=True,
        ),
    )
    monkeypatch.setattr(
        producer_route,
        "_tts_adapter_factory",
        _fake_word_adapter(
            audio_secs=2.0,
            words=[(0.0, 1.0, "x"), (1.0, 2.0, "y.")],
        ),
    )
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(tmp_path / "audio-override"),
            "scene_videos": ["/foo.mp4"],
            "target_duration_s": 7.5,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target_duration_s"] == 7.5
    assert body["captions_scaled"] is True


def test_audio_missing_scene_video_warns_and_skips(monkeypatch, tmp_path):
    """A missing scene video is dropped with a warning, not a 500.

    When every entry is missing the fallback target is 0 and no scaling
    happens — the response still carries audio + native-length captions."""
    from research.core.pixelle.video_probe import VideoProbeResult

    monkeypatch.setattr(
        producer_route,
        "probe_video_file",
        lambda *_a, **_kw: VideoProbeResult(exists=False, size=0, ffprobe_available=True),
    )
    monkeypatch.setattr(
        producer_route,
        "_tts_adapter_factory",
        _fake_word_adapter(
            audio_secs=4.0,
            words=[(0.0, 2.0, "hi"), (2.0, 4.0, "there.")],
        ),
    )
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(tmp_path / "audio-missing"),
            "scene_videos": ["/does/not/exist.mp4"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["captions_scaled"] is False
    assert body["target_duration_s"] == 0.0
    assert any(
        "Scene video missing" in w or "ffprobe" in w for w in body["warnings"]
    )


def test_audio_warns_when_narration_longer_than_target(monkeypatch, tmp_path):
    monkeypatch.setattr(
        producer_route,
        "_tts_adapter_factory",
        _fake_word_adapter(
            audio_secs=12.0,
            words=[
                (0.0, 4.0, "long"),
                (4.0, 8.0, "long"),
                (8.0, 12.0, "audio."),
            ],
        ),
    )
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(tmp_path / "audio-too-long"),
            "target_duration_s": 6.0,
        },
    )
    body = r.json()
    assert body["captions_scaled"] is True
    assert body["target_duration_s"] == 6.0
    assert any("Narration audio is" in w for w in body["warnings"])


# ─── /producer/audio — per-scene narration (one TTS pass per scene) ────────


def _fake_per_scene_word_adapter(scene_audio_specs: list[tuple[float, list[tuple[float, float, str]]]]):
    """Build a fake TTS adapter that returns deterministic per-scene
    durations + word boundaries.

    Each call to ``synthesize_with_timing`` consumes the next entry
    from ``scene_audio_specs`` (so calls map 1:1 to scenes in input
    order). Useful for asserting per-scene synthesis was invoked
    independently per scene rather than rendering the full ``script``
    once.
    """
    state = {"i": 0, "calls": []}

    class FakeAdapter:
        name = "fake-edge-per-scene"

        def synthesize_with_timing(self, text, *, output_path, voice):
            i = state["i"]
            state["i"] = i + 1
            state["calls"].append({"text": text, "path": str(output_path), "voice": voice})
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 64)
            audio_secs, words = scene_audio_specs[i]
            return TTSResult(
                audio_path=output_path,
                duration_seconds=audio_secs,
                voice=voice,
                engine=self.name,
                word_boundaries=[
                    WordBoundary(start_s=s, end_s=e, text=t) for s, e, t in words
                ],
            )

    FakeAdapter._calls = state  # type: ignore[attr-defined]
    return FakeAdapter


def test_audio_scene_narrations_calls_tts_once_per_scene(monkeypatch, tmp_path):
    """The bug: previously the route ran one TTS pass over the full
    ``script``. After the fix, when ``scene_narrations`` is non-empty
    each scene narration triggers its own TTS call so the audio matches
    the storyboard beat-by-beat instead of dumping the full script
    onto one timeline.
    """
    Adapter = _fake_per_scene_word_adapter([
        (2.0, [(0.0, 1.0, "alpha"), (1.0, 2.0, "one.")]),
        (3.0, [(0.0, 1.5, "beta"), (1.5, 3.0, "two.")]),
        (1.5, [(0.0, 0.7, "gamma"), (0.7, 1.5, "three.")]),
    ])
    monkeypatch.setattr(producer_route, "_tts_adapter_factory", Adapter)
    # No scene_videos → no padding, no probe needed; concat helper is
    # also stubbed so we don't require ffmpeg.
    def _fake_concat_basic(segments, *, silence_pads_s, output_path, audio_format, timeout_s=600.0):
        Path(output_path).write_bytes(b"\x00" * 32)
        return True, ""
    monkeypatch.setattr(producer_route, "_ffmpeg_concat_audio_segments", _fake_concat_basic)

    out = tmp_path / "audio-per-scene"
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(out),
            "scene_narrations": [
                "Scene one narration.",
                "Scene two has different content.",
                "Scene three closes it out.",
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenes_rendered"] == 3, body
    # 3 scenes × independent TTS calls — NOT one big call over `script`.
    calls = Adapter._calls["calls"]  # type: ignore[attr-defined]
    assert len(calls) == 3, calls
    assert calls[0]["text"] == "Scene one narration."
    assert calls[1]["text"] == "Scene two has different content."
    assert calls[2]["text"] == "Scene three closes it out."
    # The full script must NOT have been sent through TTS.
    assert all(c["text"] != AUDIO_SCRIPT for c in calls)
    # Combined captions span the assembled timeline (2.0 + 3.0 + 1.5 = 6.5s).
    assert body["duration_s"] == pytest.approx(6.5, abs=0.05)
    # group_word_boundaries collapses 2 words/scene into ~1 caption,
    # so we expect at least 3 captions (1 per scene) — possibly more
    # if punctuation triggers a split.
    assert body["captions_count"] >= 3


def test_audio_scene_narrations_pads_silence_to_match_scene_videos(monkeypatch, tmp_path):
    """Per-scene narration that is *shorter* than the corresponding
    scene_video gets padded with silence so the next scene's narration
    starts when the next scene's video starts. The combined caption
    timeline must reflect that shift.
    """
    from research.core.pixelle.video_probe import VideoProbeResult

    Adapter = _fake_per_scene_word_adapter([
        (2.0, [(0.0, 1.0, "first"), (1.0, 2.0, "scene.")]),
        (3.0, [(0.0, 1.5, "second"), (1.5, 3.0, "scene.")]),
    ])
    monkeypatch.setattr(producer_route, "_tts_adapter_factory", Adapter)
    monkeypatch.setattr(
        producer_route,
        "probe_video_file",
        lambda *_a, **_kw: VideoProbeResult(
            exists=True,
            size=12_345,
            ffprobe_available=True,
            duration_sec=5.0,
            video_stream_duration_sec=5.0,
            has_video_stream=True,
        ),
    )
    captured_pads: dict[str, Any] = {}

    def fake_concat(segments, *, silence_pads_s, output_path, audio_format, timeout_s=600.0):
        captured_pads["pads"] = list(silence_pads_s)
        captured_pads["segments"] = list(segments)
        Path(output_path).write_bytes(b"\x00" * 32)
        return True, ""

    monkeypatch.setattr(producer_route, "_ffmpeg_concat_audio_segments", fake_concat)

    out = tmp_path / "audio-padding"
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(out),
            "scene_narrations": ["First scene narration.", "Second scene narration."],
            "scene_videos": ["/scene1.mp4", "/scene2.mp4"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenes_rendered"] == 2
    # scene 1: narration 2.0s, video 5.0s → 3.0s silence padding
    # scene 2: narration 3.0s, video 5.0s → 2.0s silence padding
    assert captured_pads["pads"] == pytest.approx([3.0, 2.0], abs=0.01)
    # Final duration is the assembled video length (5 + 5 = 10s).
    assert body["duration_s"] == pytest.approx(10.0, abs=0.05)
    # Combined captions are time-shifted: scene 2's first caption
    # starts at offset 5.0 (cumulative duration of scene 1).
    srt_text = (out / "captions.srt").read_text("utf-8")
    assert "00:00:05" in srt_text or "00:00:06" in srt_text


def test_audio_scene_narrations_falls_back_to_legacy_when_all_blank(monkeypatch, tmp_path):
    """When every entry in ``scene_narrations`` is blank we fall back
    to single-pass TTS over ``script`` so the user still gets an
    audio file.
    """
    monkeypatch.setattr(
        producer_route,
        "_tts_adapter_factory",
        _fake_word_adapter(
            audio_secs=4.0,
            words=[(0.0, 2.0, "hi"), (2.0, 4.0, "there.")],
        ),
    )
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(tmp_path / "audio-blank-scenes"),
            "scene_narrations": ["", "  ", "\t"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Per-scene mode is disabled (all blanks) → scenes_rendered stays 0
    # and the legacy single-pass duration (4.0s) is returned.
    assert body["scenes_rendered"] == 0
    assert body["duration_s"] == pytest.approx(4.0, abs=0.05)


def test_audio_scene_narrations_skips_blank_slot_without_scene_video(monkeypatch, tmp_path):
    """A blank narration entry with no matching scene_video duration
    is skipped from the concat (we have no way to size the silent
    placeholder). The remaining slots still synthesise correctly.
    """
    Adapter = _fake_per_scene_word_adapter([
        (2.0, [(0.0, 1.0, "scene"), (1.0, 2.0, "one.")]),
        (1.5, [(0.0, 0.7, "scene"), (0.7, 1.5, "three.")]),
    ])
    monkeypatch.setattr(producer_route, "_tts_adapter_factory", Adapter)
    captured_segments: dict[str, Any] = {}

    def fake_concat(segments, *, silence_pads_s, output_path, audio_format, timeout_s=600.0):
        captured_segments["segments"] = list(segments)
        captured_segments["pads"] = list(silence_pads_s)
        Path(output_path).write_bytes(b"\x00" * 32)
        return True, ""

    monkeypatch.setattr(producer_route, "_ffmpeg_concat_audio_segments", fake_concat)
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(tmp_path / "audio-skip-blank"),
            # Middle slot is intentionally blank; no scene_videos so we
            # can't size silence for it.
            "scene_narrations": ["Scene one.", "", "Scene three."],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenes_rendered"] == 2  # only 2 real scenes synthesised
    assert len(captured_segments["segments"]) == 2
    assert any("blank narration" in w for w in body["warnings"]), body["warnings"]


def test_audio_scene_narrations_validator_normalises_entries(monkeypatch, tmp_path):
    """Validator: list length is preserved (i-th narration aligns with
    i-th scene_video) but each entry is stripped; non-string entries
    are coerced. Blank entries become ``""`` and don't kick the route
    into per-scene mode (every-entry-blank is treated as legacy).
    """
    monkeypatch.setattr(
        producer_route,
        "_tts_adapter_factory",
        _fake_word_adapter(audio_secs=2.0, words=[(0.0, 1.0, "x"), (1.0, 2.0, "y.")]),
    )
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "output_dir": str(tmp_path / "audio-validator"),
            "scene_narrations": ["  trim me  ", "", None, 42],
        },
    )
    # 422 not expected — validator coerces None/int to strings, doesn't reject.
    assert r.status_code == 200, r.text


def test_audio_scene_videos_strip_whitespace_and_empties():
    """The ``scene_videos`` validator must drop blanks before reaching
    the route logic — mirrors the assemble-side contract.
    """
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "scene_videos": ["", "  ", "  /x.mp4  ", "\n"],
            # No target -> if ffprobe isn't on the runner, the route
            # still returns 200 with warnings (no scaling). We're only
            # checking the request schema accepts the noisy input.
        },
    )
    assert r.status_code == 200, r.text


def test_audio_humanize_per_scene_calls_llm_and_uses_refined_narrations(monkeypatch, tmp_path):
    """When ``humanize_per_scene=True`` the route must (a) call
    ``llm.refine_per_scene_narrations`` with the original script + each
    scene's image_prompt + each scene's actual scene_video duration,
    and (b) feed the *refined* narrations into TTS instead of the raw
    renderer-split chunks. The response surfaces
    ``humanized_per_scene=True`` so the renderer can label the audio
    accordingly.
    """
    from research.core.pixelle.video_probe import VideoProbeResult

    Adapter = _fake_per_scene_word_adapter([
        (2.0, [(0.0, 1.0, "refined"), (1.0, 2.0, "one.")]),
        (3.0, [(0.0, 1.5, "refined"), (1.5, 3.0, "two.")]),
    ])
    monkeypatch.setattr(producer_route, "_tts_adapter_factory", Adapter)
    monkeypatch.setattr(
        producer_route,
        "probe_video_file",
        lambda *_a, **_kw: VideoProbeResult(
            exists=True,
            size=12_345,
            ffprobe_available=True,
            duration_sec=4.0,
            video_stream_duration_sec=4.0,
            has_video_stream=True,
        ),
    )

    captured_llm: dict[str, Any] = {}

    def fake_refine(**kwargs):
        captured_llm.update(kwargs)
        return ["Refined scene one.", "Refined scene two."]

    monkeypatch.setattr(llm, "refine_per_scene_narrations", fake_refine)

    def fake_concat(segments, *, silence_pads_s, output_path, audio_format, timeout_s=600.0):
        Path(output_path).write_bytes(b"\x00" * 32)
        return True, ""

    monkeypatch.setattr(producer_route, "_ffmpeg_concat_audio_segments", fake_concat)

    out = tmp_path / "audio-humanise"
    r = client.post(
        "/producer/audio",
        json={
            "script": "Original full script — the storyline source of truth.",
            "output_dir": str(out),
            "scene_narrations": ["Raw chunk one.", "Raw chunk two."],
            "scene_image_prompts": [
                "A wide shot of a forest at dawn.",
                "A close-up of a deer drinking water.",
            ],
            "scene_videos": ["/scene1.mp4", "/scene2.mp4"],
            "humanize_per_scene": True,
            "humanize_language": "English",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["humanized_per_scene"] is True, body
    assert body["scenes_rendered"] == 2

    # The LLM helper received the original script + each scene's
    # image_prompt + each scene's real scene_video duration (4.0s
    # each from the probe stub).
    assert captured_llm["original_script"] == (
        "Original full script — the storyline source of truth."
    )
    sent_scenes = captured_llm["scenes"]
    assert len(sent_scenes) == 2
    assert sent_scenes[0]["image_prompt"] == "A wide shot of a forest at dawn."
    assert sent_scenes[1]["image_prompt"] == "A close-up of a deer drinking water."
    assert sent_scenes[0]["target_duration_s"] == pytest.approx(4.0)
    assert sent_scenes[1]["target_duration_s"] == pytest.approx(4.0)
    assert sent_scenes[0]["original_narration"] == "Raw chunk one."
    assert sent_scenes[1]["original_narration"] == "Raw chunk two."

    # TTS received the refined narrations, NOT the raw chunks.
    calls = Adapter._calls["calls"]  # type: ignore[attr-defined]
    assert [c["text"] for c in calls] == ["Refined scene one.", "Refined scene two."]


def test_audio_humanize_per_scene_falls_back_when_llm_key_missing(monkeypatch, tmp_path):
    """Missing ``DEEPSEEK_API_KEY`` must surface a friendly warning and
    fall back to the raw scene_narrations rather than 500ing.
    ``humanized_per_scene`` stays false in the response.
    """
    Adapter = _fake_per_scene_word_adapter([
        (2.0, [(0.0, 1.0, "raw"), (1.0, 2.0, "one.")]),
        (1.5, [(0.0, 0.7, "raw"), (0.7, 1.5, "two.")]),
    ])
    monkeypatch.setattr(producer_route, "_tts_adapter_factory", Adapter)

    def raising_refine(**_kwargs):
        raise RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)

    monkeypatch.setattr(llm, "refine_per_scene_narrations", raising_refine)

    def fake_concat(segments, *, silence_pads_s, output_path, audio_format, timeout_s=600.0):
        Path(output_path).write_bytes(b"\x00" * 32)
        return True, ""

    monkeypatch.setattr(producer_route, "_ffmpeg_concat_audio_segments", fake_concat)

    out = tmp_path / "audio-humanise-no-key"
    r = client.post(
        "/producer/audio",
        json={
            "script": "Whatever the script.",
            "output_dir": str(out),
            "scene_narrations": ["Raw chunk one.", "Raw chunk two."],
            "scene_image_prompts": ["img1", "img2"],
            "humanize_per_scene": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["humanized_per_scene"] is False, body
    assert body["scenes_rendered"] == 2
    assert any(
        "Per-scene humanise skipped: DEEPSEEK_API_KEY not set" in w
        for w in body["warnings"]
    ), body["warnings"]
    # TTS still ran on the raw chunks so the user gets a working voice.
    calls = Adapter._calls["calls"]  # type: ignore[attr-defined]
    assert [c["text"] for c in calls] == ["Raw chunk one.", "Raw chunk two."]


def test_audio_humanize_per_scene_falls_back_when_llm_returns_wrong_shape(monkeypatch, tmp_path):
    """If the LLM returns a list of the wrong length (or a non-list)
    we must surface a warning, leave the raw scene_narrations in
    place, and keep ``humanized_per_scene=False``.
    """
    Adapter = _fake_per_scene_word_adapter([
        (2.0, [(0.0, 1.0, "raw"), (1.0, 2.0, "one.")]),
        (1.5, [(0.0, 0.7, "raw"), (0.7, 1.5, "two.")]),
    ])
    monkeypatch.setattr(producer_route, "_tts_adapter_factory", Adapter)
    # Return only ONE narration when two scenes were requested.
    monkeypatch.setattr(
        llm,
        "refine_per_scene_narrations",
        lambda **_kw: ["Only one narration came back."],
    )

    def fake_concat(segments, *, silence_pads_s, output_path, audio_format, timeout_s=600.0):
        Path(output_path).write_bytes(b"\x00" * 32)
        return True, ""

    monkeypatch.setattr(producer_route, "_ffmpeg_concat_audio_segments", fake_concat)

    r = client.post(
        "/producer/audio",
        json={
            "script": "Script body.",
            "output_dir": str(tmp_path / "audio-humanise-shape"),
            "scene_narrations": ["Raw one.", "Raw two."],
            "scene_image_prompts": ["i1", "i2"],
            "humanize_per_scene": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["humanized_per_scene"] is False, body
    assert any(
        "Per-scene humanise returned an unexpected shape" in w
        for w in body["warnings"]
    ), body["warnings"]
    # TTS received the raw narrations because the LLM output was
    # rejected.
    calls = Adapter._calls["calls"]  # type: ignore[attr-defined]
    assert [c["text"] for c in calls] == ["Raw one.", "Raw two."]


def test_audio_humanize_per_scene_skipped_when_flag_false(monkeypatch, tmp_path):
    """When ``humanize_per_scene`` is false (or omitted) the LLM helper
    must NOT be called and the raw scene_narrations are TTS'd as-is.
    """
    Adapter = _fake_per_scene_word_adapter([
        (2.0, [(0.0, 1.0, "raw"), (1.0, 2.0, "one.")]),
    ])
    monkeypatch.setattr(producer_route, "_tts_adapter_factory", Adapter)

    def boom(**_kw):  # pragma: no cover - asserts non-call
        raise AssertionError("LLM must not be called when humanize_per_scene=False")

    monkeypatch.setattr(llm, "refine_per_scene_narrations", boom)

    def fake_concat(segments, *, silence_pads_s, output_path, audio_format, timeout_s=600.0):
        Path(output_path).write_bytes(b"\x00" * 32)
        return True, ""

    monkeypatch.setattr(producer_route, "_ffmpeg_concat_audio_segments", fake_concat)

    r = client.post(
        "/producer/audio",
        json={
            "script": "Script.",
            "output_dir": str(tmp_path / "audio-no-humanise"),
            "scene_narrations": ["Raw one."],
            # humanize_per_scene omitted entirely.
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["humanized_per_scene"] is False
    assert body["scenes_rendered"] == 1


def test_audio_scene_image_prompts_validator_normalises_entries():
    """``scene_image_prompts`` must accept None / non-string entries
    without 422ing — same shape contract as ``scene_narrations``.
    """
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "scene_image_prompts": ["  prompt one  ", None, 42, ""],
            # No humanize flag → entries are accepted but not used.
        },
    )
    assert r.status_code == 200, r.text


def test_audio_pre_pr_a_request_unchanged(monkeypatch, tmp_path):
    """Old clients that don't send ``scene_videos`` / ``target_duration_s``
    must observe the exact same behaviour as before — no scaling, no
    extra warnings, ``captions_scaled=False``."""
    monkeypatch.setattr(
        producer_route,
        "_tts_adapter_factory",
        _fake_word_adapter(
            audio_secs=3.0,
            words=[(0.0, 1.0, "hi"), (1.0, 2.0, "there"), (2.0, 3.0, "now.")],
        ),
    )
    r = client.post(
        "/producer/audio",
        json={"script": AUDIO_SCRIPT, "output_dir": str(tmp_path / "legacy")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["captions_scaled"] is False
    assert body["target_duration_s"] == 0.0




# ─── /producer/refine_script — LLM clean-up before TTS ───────────────
#
# These tests stub ``llm.refine_script_for_narration`` so the route
# logic is exercised without going to DeepSeek. The deeper helper
# behaviour (prompt shape, JSON parsing) lives in
# ``research/tests/test_llm.py``; here we cover request validation,
# duration budgeting, robust-failure on missing key / LLM error, and
# the response-shape adapter.


def test_refine_script_calls_llm_and_returns_cleaned_narration(monkeypatch):
    """Happy path — ``used_llm=True`` and ``refined_script`` is the
    LLM's output. The helper receives the raw script + image_prompts +
    the resolved target duration."""
    captured: dict[str, Any] = {}

    def fake_refine(**kwargs):
        captured.update(kwargs)
        return "Dawn breaks over the harbor. A lone fisherman casts his line."

    monkeypatch.setattr(llm, "refine_script_for_narration", fake_refine)

    r = client.post(
        "/producer/refine_script",
        json={
            "script": "{ 'avoid': ['nsfw'], 'negative_prompt': ['blurry'] }",
            "scene_image_prompts": [
                "Wide shot of a calm sea at dawn.",
                "Close-up of an angler casting a line.",
            ],
            "target_duration_s": 12.0,
            "language": "English",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["used_llm"] is True
    assert body["refined_script"] == (
        "Dawn breaks over the harbor. A lone fisherman casts his line."
    )
    assert body["original_length"] == len(
        "{ 'avoid': ['nsfw'], 'negative_prompt': ['blurry'] }"
    )
    assert body["refined_length"] > 0
    assert body["target_duration_s"] == pytest.approx(12.0)
    assert body["target_words"] == 30  # 12.0s * 2.5 wps
    assert body["warnings"] == []

    # Helper saw the right inputs.
    assert captured["raw_script"] == (
        "{ 'avoid': ['nsfw'], 'negative_prompt': ['blurry'] }"
    )
    assert captured["scene_image_prompts"] == [
        "Wide shot of a calm sea at dawn.",
        "Close-up of an angler casting a line.",
    ]
    assert captured["target_duration_s"] == pytest.approx(12.0)
    assert captured["language"] == "English"


def test_refine_script_uses_scene_videos_when_no_explicit_target(monkeypatch):
    """When ``target_duration_s`` is missing the route runs ffprobe on
    each ``scene_videos`` entry and uses the summed duration as the
    word budget — matching the auto-fit semantics of /producer/audio."""
    from research.core.pixelle.video_probe import VideoProbeResult

    monkeypatch.setattr(
        producer_route,
        "probe_video_file",
        lambda *_a, **_kw: VideoProbeResult(
            exists=True,
            size=12_345,
            ffprobe_available=True,
            duration_sec=5.0,
            video_stream_duration_sec=5.0,
            has_video_stream=True,
        ),
    )

    captured: dict[str, Any] = {}

    def fake_refine(**kwargs):
        captured.update(kwargs)
        return "A short narration."

    monkeypatch.setattr(llm, "refine_script_for_narration", fake_refine)

    r = client.post(
        "/producer/refine_script",
        json={
            "script": "raw input",
            "scene_videos": ["/scene1.mp4", "/scene2.mp4", "/scene3.mp4"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target_duration_s"] == pytest.approx(15.0)  # 3 × 5.0
    assert body["target_words"] == 38  # 15.0 * 2.5 = 37.5 → round to 38
    assert captured["target_duration_s"] == pytest.approx(15.0)


def test_refine_script_explicit_override_wins_over_scene_videos(monkeypatch):
    """When both ``target_duration_s`` and ``scene_videos`` are sent,
    the explicit override wins (no ffprobe is run)."""
    probed: list[str] = []

    def fake_probe(path, *_, **__):
        probed.append(path)
        from research.core.pixelle.video_probe import VideoProbeResult

        return VideoProbeResult(
            exists=True,
            size=12_345,
            ffprobe_available=True,
            duration_sec=99.0,
            video_stream_duration_sec=99.0,
            has_video_stream=True,
        )

    monkeypatch.setattr(producer_route, "probe_video_file", fake_probe)
    monkeypatch.setattr(
        llm, "refine_script_for_narration", lambda **_: "ok"
    )

    r = client.post(
        "/producer/refine_script",
        json={
            "script": "raw",
            "scene_videos": ["/scene1.mp4"],
            "target_duration_s": 8.0,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target_duration_s"] == pytest.approx(8.0)
    assert probed == [], "ffprobe should be skipped when explicit override is set"


def test_refine_script_missing_key_falls_back(monkeypatch):
    """Missing ``DEEPSEEK_API_KEY`` ⇒ 200 + warning + ``used_llm=False``;
    ``refined_script`` mirrors the original input so the renderer can
    just keep the textarea unchanged."""

    def boom(**_):
        raise RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)

    monkeypatch.setattr(llm, "refine_script_for_narration", boom)

    r = client.post(
        "/producer/refine_script",
        json={"script": "raw script content"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["used_llm"] is False
    assert body["refined_script"] == "raw script content"
    assert body["original_length"] == body["refined_length"]
    assert any(
        "DEEPSEEK_API_KEY not set" in w for w in body["warnings"]
    ), body["warnings"]


def test_refine_script_llm_error_falls_back(monkeypatch):
    """Any other LLM exception ⇒ 200 + warning + original returned."""

    def boom(**_):
        raise ValueError("downstream parse failed")

    monkeypatch.setattr(llm, "refine_script_for_narration", boom)

    r = client.post(
        "/producer/refine_script",
        json={"script": "raw script content"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["used_llm"] is False
    assert body["refined_script"] == "raw script content"
    assert any(
        "Refine-script failed" in w and "downstream parse failed" in w
        for w in body["warnings"]
    ), body["warnings"]


def test_refine_script_empty_llm_output_falls_back(monkeypatch):
    """LLM returned empty string ⇒ 200 + warning + original returned
    (the renderer should not blank the textarea on a no-op rewrite)."""
    monkeypatch.setattr(
        llm, "refine_script_for_narration", lambda **_: "   "
    )

    r = client.post(
        "/producer/refine_script",
        json={"script": "raw script content"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["used_llm"] is False
    assert body["refined_script"] == "raw script content"
    assert any("empty output" in w for w in body["warnings"]), body["warnings"]


def test_refine_script_rejects_blank_script():
    """Validator: blank / whitespace-only script ⇒ 422."""
    for bad in ["", "   ", "\n\n"]:
        r = client.post("/producer/refine_script", json={"script": bad})
        assert r.status_code == 422, r.text


def test_refine_script_strips_invalid_image_prompt_entries(monkeypatch):
    """Validator: ``scene_image_prompts`` accepts mixed types — None /
    int / blank — coerced to empty strings so the LLM helper sees a
    clean list of prompts."""
    captured: dict[str, Any] = {}

    def fake_refine(**kwargs):
        captured.update(kwargs)
        return "ok"

    monkeypatch.setattr(llm, "refine_script_for_narration", fake_refine)

    r = client.post(
        "/producer/refine_script",
        json={
            "script": "raw",
            "scene_image_prompts": ["  prompt one  ", None, 42, ""],
        },
    )
    assert r.status_code == 200, r.text
    # Helper receives the cleaned list (with empty entries preserved
    # as empty strings — the helper itself filters them out).
    assert captured["scene_image_prompts"] == ["prompt one", "", "42", ""]


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


# ─── HF-10 — burn caption styling pass-through + AudioOnlyRequest.rate ────


def test_assemble_forwards_caption_style_overrides_to_helper(monkeypatch, tmp_path):
    """The route must forward ``caption_style`` / ``caption_font_size`` /
    ``caption_position`` verbatim to ``assemble_final_mp4``. Validates
    the schema → helper bridge so a UI change can't silently drop a
    field on the floor."""
    from research.core.pixelle import assembler as assembler_mod

    captured: dict[str, Any] = {}

    def fake_assemble(**kwargs):
        captured.update(kwargs)
        return assembler_mod.AssembleResult(
            final_path=str(kwargs["output_dir"] / "final.mp4"),
            duration_s=8.0,
            scene_count=len(kwargs["scene_videos"]),
            audio_attached=False,
            captions_attached=True,
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
            "caption_mode": "burn",
            "caption_style": "tiktok",
            "caption_font_size": "large",
            "caption_position": "top",
        },
    )
    assert r.status_code == 200, r.text
    assert captured["caption_style"] == "tiktok"
    assert captured["caption_font_size"] == "large"
    assert captured["caption_position"] == "top"


def test_assemble_caption_style_defaults_when_unset(monkeypatch, tmp_path):
    """Omitting the HF-10 fields lands on the documented defaults
    (``modern`` preset, no font / position override). Catches
    schema-default drift between renderer and backend."""
    from research.core.pixelle import assembler as assembler_mod

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

    r = client.post(
        "/producer/assemble",
        json={
            "scene_videos": ["/tmp/a.mp4"],
            "output_dir": str(tmp_path / "out"),
            # No caption_* fields — exercising the schema defaults.
        },
    )
    assert r.status_code == 200, r.text
    assert captured["caption_style"] == "modern"
    assert captured["caption_font_size"] is None
    assert captured["caption_position"] is None


def test_assemble_rejects_unknown_caption_style():
    """Defence-in-depth — an out-of-band style value must 422.
    Mirrors the existing unknown-caption_mode coverage so the four
    presets are the contract."""
    r = client.post(
        "/producer/assemble",
        json={
            "scene_videos": ["/tmp/a.mp4"],
            "caption_mode": "burn",
            "caption_style": "ferrari-red",  # not in the Literal whitelist
        },
    )
    assert r.status_code == 422, r.text


def test_audio_accepts_rate_and_applies_it_on_adapter(monkeypatch, tmp_path):
    """HF-10 — ``rate`` flows from the request into the adapter's
    ``rate`` attribute on both the per-scene and single-pass paths.
    This test exercises the single-pass path (no scene_narrations);
    the per-scene path is exercised by /producer/audio's
    scene_narrations integration tests."""
    captured: dict[str, Any] = {}

    class FakeRateAdapter:
        name = "fake-edge-rate"
        rate = "+0%"
        volume = "+0%"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["rate_at_synth"] = self.rate
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 64)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=2.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[WordBoundary(start_s=0.0, end_s=1.0, text="ok")],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeRateAdapter)

    out = tmp_path / "audio-out-rate"
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "voice": "en-US-AriaNeural",
            "output_dir": str(out),
            "rate": "+25%",
        },
    )
    assert r.status_code == 200, r.text
    # The route set the adapter's ``rate`` attribute BEFORE calling
    # synthesize_with_timing, so the captured value reflects what
    # edge-tts would actually use at synthesis time.
    assert captured["rate_at_synth"] == "+25%"


def test_audio_rate_defaults_to_plus_zero_percent_when_omitted(monkeypatch, tmp_path):
    """Omitting ``rate`` must NOT crash and must leave the adapter's
    own default in place (the schema's documented default is "+0%",
    matching edge-tts's native cadence)."""
    captured: dict[str, Any] = {}

    class FakeRateAdapter:
        name = "fake-edge-default-rate"
        rate = "+0%"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["rate_at_synth"] = self.rate
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 64)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=2.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[WordBoundary(start_s=0.0, end_s=1.0, text="ok")],
            )

    monkeypatch.setattr(producer_route, "_tts_adapter_factory", FakeRateAdapter)

    out = tmp_path / "audio-out-default-rate"
    r = client.post(
        "/producer/audio",
        json={
            "script": AUDIO_SCRIPT,
            "voice": "en-US-AriaNeural",
            "output_dir": str(out),
            # No rate field — exercises the schema default.
        },
    )
    assert r.status_code == 200, r.text
    assert captured["rate_at_synth"] == "+0%"


# ---------------------------------------------------------------------------
# Producer-side dedupe of per-scene narrations (caption-repeat-at-end bug guard).
# ---------------------------------------------------------------------------


def test_dedupe_per_scene_narrations_strips_duplicates_and_warns() -> None:
    """The producer-route safety net runs *after* the optional LLM
    rewrite and catches duplicates from any source. Each duplicate
    slot is blanked (so the per-scene synth pads silence rather than
    re-rendering the same line) and a warning is emitted naming the
    scene number."""
    warnings: list[str] = []
    out = producer_route._dedupe_per_scene_narrations(
        [
            "Late night grocery run. Just stretching.",
            "She rides the escalator unaware.",
            "Late night grocery run. Just stretching.",
        ],
        warnings=warnings,
    )
    assert out == [
        "Late night grocery run. Just stretching.",
        "She rides the escalator unaware.",
        "",
    ]
    assert len(warnings) == 1
    assert "Scene 3" in warnings[0]
    assert "duplicates" in warnings[0]


def test_dedupe_per_scene_narrations_passes_through_unique() -> None:
    """No-op when all entries are distinct — the warning list stays
    empty so the renderer doesn't show a misleading toast."""
    warnings: list[str] = []
    out = producer_route._dedupe_per_scene_narrations(
        ["one", "two", "three"], warnings=warnings
    )
    assert out == ["one", "two", "three"]
    assert warnings == []


def test_dedupe_per_scene_narrations_passes_blank_through() -> None:
    """Blank entries are silence-pad sentinels — they are not treated
    as duplicates of one another even when several scenes are blank."""
    warnings: list[str] = []
    out = producer_route._dedupe_per_scene_narrations(
        ["", "Real line.", "   ", ""], warnings=warnings
    )
    assert out == ["", "Real line.", "", ""]
    assert warnings == []


def test_audio_endpoint_dedupes_duplicate_scene_narrations(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """End-to-end through ``/producer/audio`` per-scene mode: when two
    scenes have identical narrations the duplicate is blanked, only
    the first scene is TTS-synthesised with that text, and the
    response surfaces a warning naming the duplicate scene index."""
    captured: dict[str, list[str]] = {"texts": []}

    class FakeAdapter:
        name = "edge-tts"
        rate = "+0%"

        def synthesize_with_timing(
            self, text: str, *, output_path: Path, voice: str
        ) -> TTSResult:
            captured["texts"].append(text)
            output_path = Path(output_path)
            output_path.write_bytes(b"\x00" * 1024)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=1.0,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    monkeypatch.setattr(producer_route, "_resolve_tts_adapter", lambda _p: FakeAdapter())
    # Skip the per-scene audio concat (mp3 stitching needs ffmpeg with
    # encoders we don't always have in the test image). The dedupe
    # path runs strictly before this so disabling the concat keeps
    # the test focused on the dedupe contract.
    monkeypatch.setattr(
        producer_route,
        "_ffmpeg_concat_audio_segments",
        lambda *a, **kw: (False, "skipped"),
    )

    client = TestClient(create_app())
    out = tmp_path / "audio-out-dedupe"
    r = client.post(
        "/producer/audio",
        json={
            "script": "anything",
            "voice": "en-US-AriaNeural",
            "output_dir": str(out),
            "scene_narrations": [
                "Late night grocery run. Just stretching.",
                "She rides the escalator unaware.",
                "Late night grocery run. Just stretching.",
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # Per-scene path saw exactly two TTS calls — the duplicate scene
    # 3 was blanked so the synth padded silence instead of re-rendering
    # the line. (A subsequent single-pass fallback may TTS the full
    # script when the audio concat is stubbed out as in this test;
    # it's the per-scene call sequence we care about here.)
    per_scene_texts = captured["texts"][:2]
    assert per_scene_texts == [
        "Late night grocery run. Just stretching.",
        "She rides the escalator unaware.",
    ]
    # The duplicate narration must NOT have been TTS-rendered a 2nd time
    # in the per-scene path.
    assert captured["texts"].count("Late night grocery run. Just stretching.") == 1
    # Warning surfaces the duplicate scene index for renderer toast.
    dedupe_warnings = [w for w in body["warnings"] if "Scene 3" in w and "duplicate" in w]
    assert dedupe_warnings, body["warnings"]


# ---------------------------------------------------------------------------
# HF-13 — ElevenLabs → edge-tts auto-fallback (single-pass + per-scene)
# ---------------------------------------------------------------------------


def test_audio_falls_back_to_edge_when_elevenlabs_returns_fatal_401(
    monkeypatch, tmp_path
):
    """When the user picks ``elevenlabs`` and the API trips the
    ``Free Tier usage disabled`` 401, /producer/audio must transparently
    swap to edge-tts so the call still produces audio. The response
    should:

    - Return 200 with ``audio_ok=True`` (a real mp3 was written).
    - Contain a ``warnings`` entry naming the swap so the renderer
      can surface it.
    """
    captured: dict[str, Any] = {}

    class FakeElevenLabs:
        name = "elevenlabs"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured.setdefault("elevenlabs_calls", []).append({
                "voice": voice, "text": text,
            })
            raise RuntimeError(
                "ElevenLabs 401: Free Tier usage disabled. "
                "Unusual activity detected."
            )

    class FakeEdge:
        name = "edge-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured.setdefault("edge_calls", []).append({
                "voice": voice, "text": text,
            })
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 64)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=1.25,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    def factory(provider):
        if provider == "elevenlabs":
            return FakeElevenLabs()
        return FakeEdge()

    monkeypatch.setattr(producer_route, "_tts_factory_func", factory)

    r = client.post(
        "/producer/audio",
        json={
            "script": "Hello world. This is a test narration.",
            "tts_provider": "elevenlabs",
            "voice": "21m00Tcm4TlvDq8ikWAM",
            "output_dir": str(tmp_path / "out_eleven_fallback"),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Audio was actually written by the edge-tts fallback.
    assert body["audio_path"], body
    assert Path(body["audio_path"]).exists(), body
    assert body["engine"] == "edge-tts"
    # Warning surfaces the swap so the renderer can show the user.
    swap_warnings = [
        w for w in body["warnings"]
        if "ElevenLabs" in w and "edge-tts" in w
    ]
    assert swap_warnings, body["warnings"]
    # Voice mapped from the Rachel ElevenLabs id to en-US-AriaNeural.
    assert captured["edge_calls"], "edge-tts fallback was never invoked"
    assert captured["edge_calls"][0]["voice"] == "en-US-AriaNeural"


def test_audio_per_scene_falls_back_once_then_uses_edge_for_remaining_scenes(
    monkeypatch, tmp_path
):
    """In per-scene mode, the fallback should be sticky: the first scene
    that trips a fatal ElevenLabs error swaps the adapter for every
    subsequent scene, so we don't re-burn the auth-failing API on
    scene 2, 3, 4..."""
    captured: dict[str, list[Any]] = {"elevenlabs_calls": [], "edge_calls": []}

    class FakeElevenLabs:
        name = "elevenlabs"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["elevenlabs_calls"].append(text)
            raise RuntimeError("ElevenLabs 401: Free Tier usage disabled")

    class FakeEdge:
        name = "edge-tts"

        def synthesize_with_timing(self, text, *, output_path, voice):
            captured["edge_calls"].append(text)
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 32)
            return TTSResult(
                audio_path=output_path,
                duration_seconds=0.8,
                voice=voice,
                engine=self.name,
                word_boundaries=[],
            )

    def factory(provider):
        if provider == "elevenlabs":
            return FakeElevenLabs()
        return FakeEdge()

    monkeypatch.setattr(producer_route, "_tts_factory_func", factory)

    # Stub the ffmpeg concat so we don't need real mp3s on disk —
    # without this the per-scene path falls back to single-pass on
    # ffmpeg failure and runs both code paths (which is a valid
    # secondary fallback but pollutes the per-scene assertion).
    def fake_concat(audio_segments, *, silence_pads_s, output_path,
                    audio_format, timeout_s):
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"\x00" * 128)
        return True, None

    monkeypatch.setattr(
        producer_route, "_ffmpeg_concat_audio_segments", fake_concat
    )

    r = client.post(
        "/producer/audio",
        json={
            "script": "Discarded — per-scene narrations win.",
            "scene_narrations": [
                "Scene one narration line.",
                "Scene two narration line.",
                "Scene three narration line.",
            ],
            "tts_provider": "elevenlabs",
            "voice": "21m00Tcm4TlvDq8ikWAM",
            "output_dir": str(tmp_path / "out_per_scene_fallback"),
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # ElevenLabs was tried exactly once (scene 1) before the swap;
    # every scene was rendered through edge-tts after the swap stuck.
    assert len(captured["elevenlabs_calls"]) == 1, captured
    assert len(captured["edge_calls"]) == 3, captured
    # Single warning surfaces the swap (not three repeats).
    swap_warnings = [
        w for w in body["warnings"]
        if "ElevenLabs" in w and "edge-tts" in w
    ]
    assert len(swap_warnings) == 1, body["warnings"]
    # HF-13a — response engine reflects the post-swap state. Pre-fix
    # this was incorrectly reporting "elevenlabs" because engine_name
    # in the route was set once at init and never updated when the
    # per-scene path swapped adapters internally.
    assert body["engine"] == "edge-tts", body


def test_ffmpeg_concat_audio_segments_no_silence_pads_does_not_emit_dot_entries(
    tmp_path,
):
    """HF-13a regression: ``_ffmpeg_concat_audio_segments`` must NOT
    write ``file '.'`` lines into the concat list when a scene's
    silence pad is zero. The pre-fix code appended ``Path("")`` which
    silently became ``Path(".")`` (truthy) and slipped through the
    ``if sil and str(sil)`` filter. ffmpeg then bailed on the directory
    entry and only the first scene's audio survived in the final mp3 —
    the bug that made every per-scene call lose scenes 2..N."""
    captured: dict[str, str] = {}

    def fake_run(cmd, *args, **kwargs):
        # Capture the concat list contents on the second invocation
        # (the first generates silence pads; we have none here).
        if "-f" in cmd and "concat" in cmd:
            list_idx = cmd.index("-i") + 1
            list_path = Path(cmd[list_idx])
            captured["list_contents"] = list_path.read_text(encoding="utf-8")
            # Pretend ffmpeg succeeded so we can inspect the list.
            output_path = Path(cmd[-1])
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"\x00" * 64)
        return type("P", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    import subprocess as _sp
    import research.api.routes.producer as _pr

    real_run = _sp.run

    def fake_subprocess_run(cmd, *args, **kwargs):
        # Only intercept ffmpeg calls; let real subprocess.run handle
        # anything else (none expected in this test path).
        if cmd and isinstance(cmd, list) and cmd[0].endswith("ffmpeg"):
            return fake_run(cmd, *args, **kwargs)
        return real_run(cmd, *args, **kwargs)

    import unittest.mock

    seg_a = tmp_path / "voice_scene_01.mp3"
    seg_b = tmp_path / "voice_scene_02.mp3"
    seg_c = tmp_path / "voice_scene_03.mp3"
    for s in (seg_a, seg_b, seg_c):
        s.write_bytes(b"\x00" * 32)

    out = tmp_path / "concat-out.mp3"

    with unittest.mock.patch.object(
        _pr.subprocess, "run", side_effect=fake_subprocess_run
    ):
        ok, err = _pr._ffmpeg_concat_audio_segments(
            [seg_a, seg_b, seg_c],
            silence_pads_s=[0.0, 0.0, 0.0],
            output_path=out,
            audio_format="mp3",
            timeout_s=10.0,
        )
    assert ok, err
    contents = captured.get("list_contents", "")
    assert contents, "concat list was never captured"
    # Critical assertion: the list must contain only the three real
    # segment files, nothing referencing the current directory.
    assert "file '.'\n" not in contents, contents
    assert "file '.'" not in contents, contents
    # And every real segment is listed exactly once.
    for seg in (seg_a, seg_b, seg_c):
        assert str(seg) in contents, contents


# ---------------------------------------------------------------------------
# HF-13 — /producer/soften_prompts
# ---------------------------------------------------------------------------


def test_soften_prompts_calls_llm_and_returns_rewritten(monkeypatch):
    captured: dict[str, Any] = {}

    def fake_softener(prompts, *, language="English"):
        captured["prompts"] = list(prompts)
        captured["language"] = language
        return [f"softened-{p}" for p in prompts]

    monkeypatch.setattr(llm, "soften_image_prompts", fake_softener)

    r = client.post(
        "/producer/soften_prompts",
        json={
            "prompts": [
                "wet-look transparent mesh revealing nipples",
                "see-through wet bralette underboob",
            ],
            "language": "Vietnamese",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["used_llm"] is True
    assert body["softened_prompts"] == [
        "softened-wet-look transparent mesh revealing nipples",
        "softened-see-through wet bralette underboob",
    ]
    assert captured["language"] == "Vietnamese"
    assert body["original_count"] == 2
    assert body["softened_count"] == 2
    assert body["warnings"] == []


def test_soften_prompts_falls_back_when_deepseek_key_missing(monkeypatch):
    """Missing DEEPSEEK_API_KEY → 200 with prompts unchanged + warning,
    so the renderer can keep going even when the user hasn't set up
    the LLM yet."""
    def explode(prompts, *, language="English"):
        raise RuntimeError(llm.ERR_NO_DEEPSEEK_KEY)

    monkeypatch.setattr(llm, "soften_image_prompts", explode)

    r = client.post(
        "/producer/soften_prompts",
        json={"prompts": ["explicit prompt that needs softening"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["used_llm"] is False
    assert body["softened_prompts"] == ["explicit prompt that needs softening"]
    assert any("DEEPSEEK_API_KEY" in w for w in body["warnings"]), body["warnings"]


def test_soften_prompts_falls_back_on_malformed_llm_response(monkeypatch):
    """When the LLM returns a list with the wrong length, the route
    must still return the originals + a warning rather than silently
    rendering through with N-1 prompts."""
    monkeypatch.setattr(
        llm, "soften_image_prompts", lambda prompts, **k: ["only-one-rewrite"]
    )

    r = client.post(
        "/producer/soften_prompts",
        json={"prompts": ["a", "b", "c"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["used_llm"] is False
    assert body["softened_prompts"] == ["a", "b", "c"]
    assert any("malformed" in w.lower() for w in body["warnings"]), body["warnings"]


def test_soften_prompts_rejects_empty_input():
    """min_length=1 on the request model — pydantic returns 422."""
    r = client.post("/producer/soften_prompts", json={"prompts": []})
    assert r.status_code == 422, r.text
