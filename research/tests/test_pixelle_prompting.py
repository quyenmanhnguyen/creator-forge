"""Tests for :mod:`core.pixelle.prompting` (PR-A3 scene + prompt builder)."""
from __future__ import annotations

from core.pixelle.prompting import (
    DEFAULT_ASPECT_RATIO,
    DEFAULT_NEGATIVE_PROMPT,
    PRESET_NAMES,
    PRESET_STYLES,
    ScenePrompt,
    StyleSource,
    build_image_prompt_from_style,
    build_scene_prompts,
    build_video_prompt_from_style,
    from_cloner_kit,
    from_manual_reference,
    from_preset,
    split_script_into_scenes,
)

# ─── StyleSource constructors ────────────────────────────────────────────────


def test_from_cloner_kit_distills_tags_and_hook():
    kit = {
        "source_title": "How to wake up early",
        "tags": [" focus ", "morning routine", "", "habit"],
        "thumbnail_copy": ["Wake at 5am", "Win the Day", "Stop Snoozing"],
        "hook_analysis": "## Hook\nOpens with a 0:00–0:05 punch...",
    }
    style = from_cloner_kit(kit)
    # Empty/whitespace tags filtered, others stripped.
    assert style.visual_keywords == ["focus", "morning routine", "habit"]
    # Description seeds from first 3 thumbnail copies.
    assert "Wake at 5am" in style.description
    # Reference text preserves the hook analysis.
    assert "Hook" in style.reference_text
    # Default tone when not provided.
    assert style.tone == "documentary"


def test_from_cloner_kit_handles_missing_fields():
    style = from_cloner_kit({})
    assert style.visual_keywords == []
    assert style.reference_text == ""
    assert style.tone == "documentary"
    assert style.name == "video_clone"


def test_from_manual_reference_truncates_long_description():
    long_text = "x" * 500
    style = from_manual_reference(long_text)
    # Description capped at 120 chars.
    assert len(style.description) == 120
    # Reference text preserved fully.
    assert style.reference_text == long_text


def test_from_manual_reference_strips_whitespace():
    style = from_manual_reference("  warm cinematic look  ")
    assert style.reference_text == "warm cinematic look"


def test_from_preset_known_name():
    style = from_preset("cinematic")
    assert style.name == "preset:cinematic"
    assert "cinematic" in style.visual_keywords


def test_from_preset_unknown_name_falls_back_to_cinematic():
    style = from_preset("does-not-exist")
    assert style.name == "preset:cinematic"


def test_preset_names_match_preset_styles_keys():
    assert set(PRESET_NAMES) == set(PRESET_STYLES.keys())
    # Every preset has at least 3 visual keywords + a tone.
    for spec in PRESET_STYLES.values():
        assert len(spec.visual_keywords) >= 3
        assert spec.tone


# ─── Scene splitter ──────────────────────────────────────────────────────────


def test_split_empty_script_returns_empty():
    assert split_script_into_scenes("") == []
    assert split_script_into_scenes("   \n  ") == []


def test_split_uses_default_target_duration_when_no_total():
    scenes = split_script_into_scenes("First. Second sentence! Third?")
    assert len(scenes) == 3
    # Each gets the default 4.0s when no total_duration_s is provided.
    for duration, _ in scenes:
        assert duration == 4.0


def test_split_with_total_duration_proportional_to_chars():
    text = "A. " + ("x" * 30) + "."
    scenes = split_script_into_scenes(text, total_duration_s=10.0)
    assert len(scenes) == 2
    short_dur, long_dur = scenes[0][0], scenes[1][0]
    assert long_dur > short_dur


def test_split_clamps_target_duration_to_min():
    scenes = split_script_into_scenes("Hello.", target_scene_duration_s=0.1)
    assert scenes[0][0] >= 1.0  # MIN_SCENE_DURATION_S


def test_split_clamps_target_duration_to_max():
    scenes = split_script_into_scenes("Hello.", target_scene_duration_s=99.0)
    assert scenes[0][0] <= 8.0  # MAX_SCENE_DURATION_S


# ─── Prompt builders ─────────────────────────────────────────────────────────


def test_image_prompt_includes_aspect_and_style_keywords():
    style = StyleSource(name="t", visual_keywords=["cinematic", "warm"])
    p = build_image_prompt_from_style("a girl walks at dawn", style)
    assert "9:16" in p
    assert "cinematic" in p
    assert "a girl walks at dawn" in p


def test_image_prompt_falls_back_when_narration_empty():
    p = build_image_prompt_from_style("", StyleSource(name="t"))
    # Should not error, should produce a generic placeholder.
    assert "abstract scene" in p
    assert "9:16" in p


def test_video_prompt_uses_tone_specific_camera_language():
    base_style = StyleSource(name="t", tone="vlog")
    p_vlog = build_video_prompt_from_style("we visit a market", base_style)
    p_doc = build_video_prompt_from_style("we visit a market", StyleSource(name="t", tone="documentary"))
    p_explainer = build_video_prompt_from_style("we visit a market", StyleSource(name="t", tone="explainer"))
    p_cinematic = build_video_prompt_from_style("we visit a market", StyleSource(name="t", tone="cinematic"))
    # Each tone yields a distinct camera language fragment.
    assert "handheld" in p_vlog
    assert "static" in p_explainer
    assert "dolly-in" in p_cinematic
    assert p_doc != p_vlog


def test_image_prompt_reference_text_truncated_with_ellipsis():
    style = StyleSource(name="t", reference_text="z" * 1000)
    p = build_image_prompt_from_style("scene", style)
    # The 400-char excerpt cap appends an ellipsis.
    assert "…" in p
    # The full 1000-char blob should not appear verbatim.
    assert "z" * 1000 not in p


# ─── build_scene_prompts (top-level) ─────────────────────────────────────────


def test_build_scene_prompts_returns_one_per_sentence():
    style = StyleSource(name="t", visual_keywords=["warm"])
    out = build_scene_prompts("First. Second.", style)
    assert len(out) == 2
    assert out[0].scene_id == 1
    assert out[1].scene_id == 2


def test_build_scene_prompts_attaches_style_negative():
    style = StyleSource(name="t", negative="no people")
    out = build_scene_prompts("Hello there.", style)
    assert "no people" in out[0].negative_prompt
    # Default negative bits are still present.
    assert "lowres" in out[0].negative_prompt


def test_build_scene_prompts_default_negative_when_style_has_none():
    style = StyleSource(name="t")
    out = build_scene_prompts("Hello there.", style)
    assert out[0].negative_prompt == DEFAULT_NEGATIVE_PROMPT


def test_build_scene_prompts_durations_sum_close_to_total():
    style = StyleSource(name="t")
    out = build_scene_prompts("A short. A longer one here.", style, total_duration_s=10.0)
    total = sum(s.duration for s in out)
    # Allow ±1s slack since clamping to MIN/MAX can perturb sums.
    assert abs(total - 10.0) <= 2.0


def test_build_scene_prompts_aspect_ratio_default_and_override():
    style = StyleSource(name="t")
    out = build_scene_prompts("Hello.", style)
    assert out[0].aspect_ratio == DEFAULT_ASPECT_RATIO
    assert out[0].aspect_ratio == "9:16"
    # Override propagates.
    out2 = build_scene_prompts("Hello.", style, aspect_ratio="16:9")
    assert out2[0].aspect_ratio == "16:9"


def test_build_scene_prompts_empty_script_returns_empty():
    assert build_scene_prompts("", StyleSource(name="t")) == []


def test_scene_prompt_to_json_matches_user_contract():
    sp = ScenePrompt(
        scene_id=1,
        duration=4.0,
        narration="Hi.",
        image_prompt="img",
        video_prompt="vid",
        negative_prompt="neg",
        style_notes="notes",
        aspect_ratio="9:16",
    )
    payload = sp.to_json()
    # Schema spec from PR-A3 user message must be exact.
    assert set(payload.keys()) == {
        "scene_id",
        "duration",
        "narration",
        "image_prompt",
        "video_prompt",
        "negative_prompt",
        "style_notes",
        "aspect_ratio",
    }
    assert payload["aspect_ratio"] == "9:16"


def test_build_scene_prompts_full_pipeline_smoke():
    """End-to-end: from a Cloner-style kit + 4-sentence script."""
    kit = {
        "tags": ["productivity", "morning", "minimalism"],
        "thumbnail_copy": ["Wake at 5am"],
        "hook_analysis": "Opens with quiet voiceover over slow b-roll.",
    }
    style = from_cloner_kit(kit)
    script = (
        "Most people wake up exhausted. "
        "Three small habits change that. "
        "Drink water before coffee. "
        "Move for ten minutes."
    )
    scenes = build_scene_prompts(script, style, total_duration_s=20.0)
    assert len(scenes) == 4
    # Image prompts inherit Cloner tags.
    assert any("productivity" in s.image_prompt for s in scenes)
    # Video prompts mention the documentary push-in (default tone).
    assert any("push-in" in s.video_prompt for s in scenes)
    # Each carries 9:16 + same negative + non-empty narration.
    for s in scenes:
        assert s.aspect_ratio == "9:16"
        assert s.narration.strip()
        assert s.negative_prompt
