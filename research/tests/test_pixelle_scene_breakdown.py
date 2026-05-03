"""Tests for ``core.pixelle.scene_breakdown`` (PR-A4.1)."""
from __future__ import annotations

import pytest

from core.pixelle.scene_breakdown import (
    MAX_SCENE_COUNT,
    MIN_SCENE_COUNT,
    SCENE_TEMPLATES,
    TEMPLATE_KEYS,
    LongFormScene,
    SceneTemplate,
    build_breakdown_system_prompt,
    build_breakdown_user_prompt,
    build_thumbnail_prompt,
    count_words,
    estimate_scene_count,
    estimate_total_duration_s,
    generate_scene_breakdown,
    make_custom_template,
    parse_breakdown_response,
    serialize_breakdown_json,
    serialize_breakdown_md,
)


# ─── Estimation helpers ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [
        ("", 0),
        ("Hello world.", 2),
        ("Hello, world! 123 done.", 4),
        ("a" * 1, 1),
        ("Multi\nline\nnewlines.", 3),
    ],
)
def test_count_words(text: str, expected: int) -> None:
    assert count_words(text) == expected


def test_estimate_total_duration_at_default_wpm() -> None:
    # 150 words at 150 WPM == 60 seconds.
    script = " ".join(["word"] * 150)
    assert estimate_total_duration_s(script) == pytest.approx(60.0, rel=1e-3)


def test_estimate_total_duration_low_wpm_clamped() -> None:
    """``words_per_minute`` clamps to a floor (60) so input 30 → 60."""
    script = " ".join(["word"] * 60)
    # If wpm clamped to 60, duration = 60/60*60 = 60.
    assert estimate_total_duration_s(script, words_per_minute=30) == pytest.approx(60.0)


def test_estimate_scene_count_empty_script_returns_min() -> None:
    assert estimate_scene_count("") == MIN_SCENE_COUNT


def test_estimate_scene_count_clamped_to_bounds() -> None:
    huge = " ".join(["word"] * 100_000)
    assert estimate_scene_count(huge) == MAX_SCENE_COUNT
    tiny = "Hello."
    assert estimate_scene_count(tiny) == MIN_SCENE_COUNT


def test_estimate_scene_count_long_form_4200_words() -> None:
    """4200-word script → multiple scenes (real-world calibration)."""
    script = " ".join(["word"] * 4200)
    n = estimate_scene_count(script)
    assert MIN_SCENE_COUNT <= n <= MAX_SCENE_COUNT
    # 4200 / 220 ≈ 19, fits comfortably in [3, 60].
    assert 12 <= n <= 30


# ─── Template registry ───────────────────────────────────────────────────────


def test_template_registry_keys() -> None:
    assert set(TEMPLATE_KEYS) == {
        "cinematic",
        "educational",
        "lifestyle",
        "factory",
        "custom",
    }
    for key in TEMPLATE_KEYS:
        assert isinstance(SCENE_TEMPLATES[key], SceneTemplate)
        assert SCENE_TEMPLATES[key].key == key


def test_factory_template_has_user_style_tag() -> None:
    """The user's strict format tag must round-trip verbatim into prompts."""
    factory = SCENE_TEMPLATES["factory"]
    assert "ultra-realistic" in factory.image_style_tag
    assert "documentary style" in factory.image_style_tag
    assert "4K" in factory.image_style_tag
    assert factory.process_notes  # non-empty for factory specifically


def test_custom_template_factory() -> None:
    tpl = make_custom_template(
        image_style_tag="hyper-saturated, vaporwave",
        camera_hints="locked-off wide, slow zoom",
        process_notes="Each scene must show neon signage.",
    )
    assert tpl.key == "custom"
    assert "vaporwave" in tpl.image_style_tag
    assert "neon signage" in tpl.process_notes


# ─── System prompt construction ──────────────────────────────────────────────


def test_system_prompt_embeds_template_style_tag_and_camera() -> None:
    factory = SCENE_TEMPLATES["factory"]
    prompt = build_breakdown_system_prompt(factory, n_scenes=12)
    assert "EXACTLY 12 standalone scenes" in prompt
    assert factory.image_style_tag in prompt
    assert factory.camera_hints in prompt
    assert "PROCESS NOTES" in prompt  # factory has process_notes
    # Strict format markers must be present so the LLM emits parseable text.
    assert "Scene <N>:" in prompt
    assert "NARRATION:" in prompt
    assert "IMAGE PROMPT:" in prompt
    assert "FLOW VIDEO PROMPT:" in prompt


def test_system_prompt_skips_process_block_when_empty() -> None:
    cinematic = SCENE_TEMPLATES["cinematic"]
    prompt = build_breakdown_system_prompt(cinematic, n_scenes=5)
    assert "PROCESS NOTES" not in prompt


def test_system_prompt_carries_scene_to_scene_diversity_rule() -> None:
    """PR-B regression: every breakdown must instruct the LLM to vary
    the opening clause across scenes, even when the location and
    subject are shared. Without this rule DeepSeek tends to emit
    multiple scenes that begin with the same boilerplate noun phrase
    (e.g. several scenes opening with "A sunlit bedroom..."),
    producing a visually monotonous storyboard."""
    cinematic = SCENE_TEMPLATES["cinematic"]
    prompt = build_breakdown_system_prompt(cinematic, n_scenes=6)
    assert "SCENE-TO-SCENE DIVERSITY" in prompt
    assert "no two IMAGE PROMPTs may open with the" in prompt
    # Mentions the actual variation axes so the LLM has concrete options.
    for axis in ("composition", "camera angle", "detail focus"):
        assert axis in prompt.lower()
    # Mentions the FLOW VIDEO PROMPT side of the rule too — the user's
    # screenshots showed multiple scenes all starting with "A slow
    # dolly push-in".
    assert "FLOW VIDEO PROMPT openings" in prompt


def test_user_prompt_strips_and_wraps_script() -> None:
    user = build_breakdown_user_prompt("   hello world.  \n\n")
    assert user.startswith("SCRIPT:\n")
    assert "hello world." in user


# ─── Thumbnail prompt ────────────────────────────────────────────────────────


def test_thumbnail_prompt_factory_includes_animal_environment_hint() -> None:
    """Factory thumbnail uses the user's industrial environment block."""
    tpl = SCENE_TEMPLATES["factory"]
    prompt = build_thumbnail_prompt("How Coca-Cola is Made", tpl)
    assert "How Coca-Cola is Made" in prompt
    assert "FACTORY ENVIRONMENT" in prompt
    assert "stainless-steel machinery" in prompt
    assert "wide-angle 18–24mm" in prompt


def test_thumbnail_prompt_non_factory_uses_generic_environment() -> None:
    tpl = SCENE_TEMPLATES["cinematic"]
    prompt = build_thumbnail_prompt("Why Stoicism Wins", tpl)
    assert "Why Stoicism Wins" in prompt
    assert "FACTORY ENVIRONMENT" not in prompt
    assert "ENVIRONMENT" in prompt
    assert "high-impact" in prompt.lower()


def test_thumbnail_prompt_falls_back_for_blank_title() -> None:
    tpl = SCENE_TEMPLATES["cinematic"]
    prompt = build_thumbnail_prompt("", tpl)
    assert "Untitled video" in prompt


# ─── Parser ──────────────────────────────────────────────────────────────────


SAMPLE_TWO_SCENES = """Scene 1: Raw Ingredients Arriving at Beverage Facility
NARRATION:
The factory floor wakes at dawn. Workers begin their shifts.
IMAGE PROMPT:
Inside a massive beverage factory intake bay, forklift operators efficiently unload sacks of sugar, conveyor belts move in synchronization, ultra-realistic, cinematic, professional, high-detail 4K, documentary style.
FLOW VIDEO PROMPT:
A smooth dolly shot follows forklifts unloading ingredients onto moving conveyor belts. Workers in sync direct materials to automated sorting machines. The camera pans across the facility. Clean efficiency in motion.

Scene 2: Quality Lab Inspection
NARRATION:
Lab technicians test samples.
IMAGE PROMPT:
A pristine industrial testing laboratory, white-coated technicians at chrome workstations, ultra-realistic.
FLOW VIDEO PROMPT:
Macro tracking shot follows pipettes as drops fall into vials. Technicians coordinate. Camera pulls back. Clean efficiency.
"""


def test_parse_two_scenes_happy_path() -> None:
    scenes = parse_breakdown_response(SAMPLE_TWO_SCENES)
    assert len(scenes) == 2
    assert scenes[0].scene_id == 1
    assert "Beverage Facility" in scenes[0].title
    assert scenes[0].image_prompt.startswith("Inside a massive")
    assert scenes[0].flow_video_prompt.startswith("A smooth dolly")
    assert scenes[0].duration_s > 0


def test_parse_renumbers_scene_ids() -> None:
    """LLM may emit Scene 1 then Scene 5; parser renumbers contiguously."""
    raw = """Scene 1: A
NARRATION:
N1.
IMAGE PROMPT:
I1.
FLOW VIDEO PROMPT:
V1.

Scene 5: B
NARRATION:
N5.
IMAGE PROMPT:
I5.
FLOW VIDEO PROMPT:
V5.
"""
    scenes = parse_breakdown_response(raw)
    assert [s.scene_id for s in scenes] == [1, 2]
    assert scenes[1].title == "B"


def test_parse_drops_scenes_missing_required_section() -> None:
    raw = """Scene 1: Has all
NARRATION:
N.
IMAGE PROMPT:
I.
FLOW VIDEO PROMPT:
V.

Scene 2: Missing video
NARRATION:
N2.
IMAGE PROMPT:
I2.
"""
    scenes = parse_breakdown_response(raw)
    assert len(scenes) == 1
    assert scenes[0].title == "Has all"


def test_parse_lenient_on_label_casing() -> None:
    raw = """scene 1: Mixed Case
narration:
N.
image prompt:
I.
flow video prompt:
V.
"""
    scenes = parse_breakdown_response(raw)
    assert len(scenes) == 1


def test_parse_accepts_video_prompt_alias() -> None:
    """Some LLMs drop the ``FLOW`` prefix — accept ``VIDEO PROMPT:`` too."""
    raw = """Scene 1: Alias
NARRATION:
N.
IMAGE PROMPT:
I.
VIDEO PROMPT:
V.
"""
    scenes = parse_breakdown_response(raw)
    assert len(scenes) == 1
    assert scenes[0].flow_video_prompt == "V."


def test_parse_empty_returns_empty_list() -> None:
    assert parse_breakdown_response("") == []
    assert parse_breakdown_response("   \n\n  ") == []


# ─── Serializer + round-trip ─────────────────────────────────────────────────


def test_serialize_md_includes_header_when_supplied() -> None:
    scenes = parse_breakdown_response(SAMPLE_TWO_SCENES)
    md = serialize_breakdown_md(
        scenes, title="My Video", template=SCENE_TEMPLATES["factory"]
    )
    assert md.startswith("# My Video")
    assert "_template: factory" in md
    assert "Scene 1:" in md
    assert "FLOW VIDEO PROMPT:" in md


def test_serialize_md_omits_header_when_blank() -> None:
    scenes = parse_breakdown_response(SAMPLE_TWO_SCENES)
    md = serialize_breakdown_md(scenes)
    assert not md.startswith("#")
    assert md.startswith("Scene 1:")


def test_round_trip_parse_serialize_parse_preserves_scenes() -> None:
    scenes = parse_breakdown_response(SAMPLE_TWO_SCENES)
    md = serialize_breakdown_md(scenes)
    scenes2 = parse_breakdown_response(md)
    assert len(scenes) == len(scenes2)
    for a, b in zip(scenes, scenes2, strict=True):
        assert a.title == b.title
        assert a.image_prompt == b.image_prompt
        assert a.flow_video_prompt == b.flow_video_prompt


def test_serialize_json_returns_list_of_dicts() -> None:
    scenes = parse_breakdown_response(SAMPLE_TWO_SCENES)
    payload = serialize_breakdown_json(scenes)
    assert isinstance(payload, list)
    assert all(isinstance(p, dict) for p in payload)
    assert payload[0]["scene_id"] == 1
    assert "image_prompt" in payload[0]
    assert "flow_video_prompt" in payload[0]


# ─── Orchestrator (with mocked LLM) ──────────────────────────────────────────


def test_generate_scene_breakdown_uses_chat_fn_and_parses_reply() -> None:
    captured: dict[str, str] = {}

    def fake_chat(user: str, system: str) -> str:
        captured["user"] = user
        captured["system"] = system
        return SAMPLE_TWO_SCENES

    scenes = generate_scene_breakdown(
        "The factory floor wakes at dawn. Workers begin their shifts.",
        template=SCENE_TEMPLATES["factory"],
        n_scenes=4,
        chat_fn=fake_chat,
    )
    # Parser pulls 2 scenes from SAMPLE_TWO_SCENES; the LLM was asked for 4.
    assert len(scenes) == 2
    assert "EXACTLY 4 standalone scenes" in captured["system"]
    assert "factory floor wakes at dawn" in captured["user"]


def test_generate_scene_breakdown_empty_script_short_circuits() -> None:
    called: dict[str, bool] = {"hit": False}

    def fake_chat(user: str, system: str) -> str:
        called["hit"] = True
        return ""

    scenes = generate_scene_breakdown(
        "   \n", template=SCENE_TEMPLATES["cinematic"], chat_fn=fake_chat
    )
    assert scenes == []
    assert called["hit"] is False


def test_generate_scene_breakdown_clamps_n_scenes() -> None:
    captured: dict[str, str] = {}

    def fake_chat(user: str, system: str) -> str:
        captured["system"] = system
        return ""

    generate_scene_breakdown(
        "A " * 10,
        template=SCENE_TEMPLATES["cinematic"],
        n_scenes=999,
        chat_fn=fake_chat,
    )
    assert f"EXACTLY {MAX_SCENE_COUNT} standalone scenes" in captured["system"]


def test_generate_scene_breakdown_estimates_n_when_unspecified() -> None:
    captured: dict[str, str] = {}

    def fake_chat(user: str, system: str) -> str:
        captured["system"] = system
        return ""

    generate_scene_breakdown(
        " ".join(["word"] * 4200),
        template=SCENE_TEMPLATES["factory"],
        chat_fn=fake_chat,
    )
    assert "EXACTLY" in captured["system"]


# ─── Dataclass round-trip ────────────────────────────────────────────────────


def test_long_form_scene_to_json_keys() -> None:
    scene = LongFormScene(
        scene_id=1,
        title="t",
        narration="n",
        image_prompt="i",
        flow_video_prompt="v",
        duration_s=4.0,
    )
    payload = scene.to_json()
    assert set(payload) == {
        "scene_id",
        "title",
        "narration",
        "image_prompt",
        "flow_video_prompt",
        "duration_s",
        # PR-26: paste-ready variant list (empty when only one prompt
        # was requested; legacy ``image_prompt`` keeps the first variant).
        "image_prompts",
        # PR-48: paste-ready video variant list paired 1:1 with
        # ``image_prompts``; empty for legacy single-image path.
        "flow_video_prompts",
        "extra",
    }


# ─── PR-48: video variant expansion ──────────────────────────────────────────


def test_expand_video_variants_returns_one_per_image_variant() -> None:
    """LLM emits N delimited prompts; one per image variant in order."""
    from research.core.pixelle.scene_breakdown import (
        _VARIANT_DELIMITER,
        expand_video_variants_for_images,
    )

    scene = LongFormScene(
        scene_id=1,
        title="Coffee shop",
        narration="A barista pulls a shot.",
        image_prompt="wide shot",
        flow_video_prompt="Slow camera push toward the bar.",
    )
    image_prompts = [
        "wide shot of the bar",
        "low-angle on espresso machine",
        "over-the-shoulder of barista",
    ]
    raw = (
        "Camera dollies forward from the wide framing of the bar, settling on the barista. "
        "Steam curls upward as he tamps the puck. Low ambient hum.\n"
        f"{_VARIANT_DELIMITER}\n"
        "Tilt up from the low-angle of the espresso machine as crema flows. "
        "Hand reaches into frame to pull the cup. Warm glow from the side lamp.\n"
        f"{_VARIANT_DELIMITER}\n"
        "Following the over-the-shoulder framing, the camera glides past his hand "
        "toward the cup as it lands on the saucer. Soft chatter fills the room.\n"
    )

    captured: dict[str, str] = {}

    def fake_chat(user: str, system: str) -> str:
        captured["user"] = user
        captured["system"] = system
        return raw

    out = expand_video_variants_for_images(
        scene, image_prompts, chat_fn=fake_chat
    )
    assert len(out) == 3
    assert "wide framing of the bar" in out[0]
    assert "low-angle of the espresso" in out[1]
    assert "over-the-shoulder framing" in out[2]
    # System prompt must request the right count.
    assert "EXACTLY 3 flow video prompts" in captured["system"]
    # User prompt must list all 3 variants in order.
    assert "IMAGE VARIANT 1:" in captured["user"]
    assert "IMAGE VARIANT 3:" in captured["user"]
    assert "low-angle on espresso machine" in captured["user"]


def test_expand_video_variants_falls_back_when_llm_returns_nothing() -> None:
    """LLM returns garbage / empty string → repeat the base flow video prompt."""
    from research.core.pixelle.scene_breakdown import (
        expand_video_variants_for_images,
    )

    scene = LongFormScene(
        scene_id=1,
        title="t",
        narration="n",
        image_prompt="i",
        flow_video_prompt="Base motion seed.",
    )

    def empty_chat(user: str, system: str) -> str:
        return ""

    out = expand_video_variants_for_images(
        scene, ["a", "b", "c"], chat_fn=empty_chat
    )
    assert out == ["Base motion seed.", "Base motion seed.", "Base motion seed."]


def test_expand_video_variants_short_circuits_on_single_variant() -> None:
    """count==1 — no LLM call needed; just repeat the base prompt."""
    from research.core.pixelle.scene_breakdown import (
        expand_video_variants_for_images,
    )

    scene = LongFormScene(
        scene_id=1,
        title="t",
        narration="n",
        image_prompt="i",
        flow_video_prompt="Base motion.",
    )
    called: dict[str, bool] = {"hit": False}

    def chat(user: str, system: str) -> str:
        called["hit"] = True
        return ""

    out = expand_video_variants_for_images(scene, ["only"], chat_fn=chat)
    assert out == ["Base motion."]
    assert called["hit"] is False


def test_expand_video_variants_empty_image_prompts_returns_empty() -> None:
    """No image prompts → no video prompts (don't call the LLM)."""
    from research.core.pixelle.scene_breakdown import (
        expand_video_variants_for_images,
    )

    scene = LongFormScene(
        scene_id=1,
        title="t",
        narration="n",
        image_prompt="i",
        flow_video_prompt="vp",
    )
    called: dict[str, bool] = {"hit": False}

    def chat(user: str, system: str) -> str:
        called["hit"] = True
        return ""

    assert expand_video_variants_for_images(scene, [], chat_fn=chat) == []
    assert called["hit"] is False


def test_expand_video_variants_empty_seed_repeats_empty() -> None:
    """No flow_video_prompt → degrade to repeating the empty base."""
    from research.core.pixelle.scene_breakdown import (
        expand_video_variants_for_images,
    )

    scene = LongFormScene(
        scene_id=1,
        title="t",
        narration="n",
        image_prompt="i",
        flow_video_prompt="",
    )
    called: dict[str, bool] = {"hit": False}

    def chat(user: str, system: str) -> str:
        called["hit"] = True
        return ""

    out = expand_video_variants_for_images(scene, ["a", "b"], chat_fn=chat)
    # No seed → no LLM call; we get exactly len(image_prompts) empties.
    assert out == ["", ""]
    assert called["hit"] is False


def test_generate_scene_breakdown_populates_flow_video_prompts_with_variants() -> None:
    """When images_per_scene > 1, each scene also carries flow_video_prompts."""
    from research.core.pixelle.scene_breakdown import (
        _VARIANT_DELIMITER,
        generate_scene_breakdown,
    )

    sample = """Scene 1: Coffee shop
NARRATION:
A barista pulls a shot.
IMAGE PROMPT:
A bustling coffee shop interior, warm light, ultra-detailed.
FLOW VIDEO PROMPT:
Camera glides through the room. Steam rises. Soft jazz hum.
"""

    image_variants_raw = (
        f"variant1 image{_VARIANT_DELIMITER}variant2 image{_VARIANT_DELIMITER}variant3 image"
    )
    video_variants_raw = (
        f"variant1 video{_VARIANT_DELIMITER}variant2 video{_VARIANT_DELIMITER}variant3 video"
    )
    calls: list[str] = []

    def fake_chat(user: str, system: str) -> str:
        # Order: breakdown → image variants → video variants
        if "scene-breakdown specialist" in system:
            calls.append("breakdown")
            return sample
        if "EXACTLY 3 paste-ready image prompts" in system:
            calls.append("image_variants")
            return image_variants_raw
        if "EXACTLY 3 flow video prompts" in system:
            calls.append("video_variants")
            return video_variants_raw
        return ""

    scenes = generate_scene_breakdown(
        "A coffee shop wakes up.",
        template=SCENE_TEMPLATES["cinematic"],
        n_scenes=1,
        chat_fn=fake_chat,
        images_per_scene=3,
    )
    assert calls == ["breakdown", "image_variants", "video_variants"]
    assert len(scenes) == 1
    assert len(scenes[0].image_prompts) == 3
    assert len(scenes[0].flow_video_prompts) == 3
    assert "variant1 video" in scenes[0].flow_video_prompts[0]
    assert "variant3 video" in scenes[0].flow_video_prompts[2]


def test_generate_scene_breakdown_no_video_variants_when_single_image() -> None:
    """images_per_scene <= 1 → no extra LLM call; flow_video_prompts stays ()."""
    from research.core.pixelle.scene_breakdown import generate_scene_breakdown

    sample = """Scene 1: t
NARRATION:
n.
IMAGE PROMPT:
i.
FLOW VIDEO PROMPT:
v.
"""
    calls: list[str] = []

    def fake_chat(user: str, system: str) -> str:
        if "scene-breakdown specialist" in system:
            calls.append("breakdown")
            return sample
        calls.append("unexpected:" + system[:30])
        return ""

    scenes = generate_scene_breakdown(
        "A short script body.",
        template=SCENE_TEMPLATES["cinematic"],
        n_scenes=1,
        chat_fn=fake_chat,
        images_per_scene=1,
    )
    assert calls == ["breakdown"]
    assert len(scenes) == 1
    assert scenes[0].image_prompts == ()
    assert scenes[0].flow_video_prompts == ()
