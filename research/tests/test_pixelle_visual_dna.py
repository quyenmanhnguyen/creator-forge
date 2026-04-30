"""PR-26 — tests for Visual DNA extraction + variant prompt expansion.

Pinned contracts:

* ``extract_visual_dna`` short-circuits on empty scripts, strips
  surrounding quotes, and truncates at :data:`VISUAL_DNA_MAX_CHARS`.
* ``build_variant_system_prompt`` always names the 4 diversity axes,
  forbids duplicate openings, and embeds the Visual DNA verbatim when
  one is supplied.
* ``parse_variant_response`` splits on the ``<<<VARIANT>>>`` delimiter,
  strips numbering noise, collapses internal newlines, and pads short
  replies up to ``count`` so the renderer never sees a phantom row.
* ``expand_image_variants`` returns the base prompt N× when the LLM
  reply is unparseable (no exceptions reach the caller).
* ``generate_scene_breakdown_with_dna`` round-trips the override + the
  per-scene ``image_prompts`` list, and skips the auto-extract LLM
  call when the override is non-empty.
"""

from __future__ import annotations

import pytest

from core.pixelle.scene_breakdown import (
    MAX_VARIANTS_PER_SCENE,
    SCENE_TEMPLATES,
    VISUAL_DNA_MAX_CHARS,
    LongFormScene,
    build_variant_system_prompt,
    build_visual_dna_system_prompt,
    expand_image_variants,
    extract_visual_dna,
    generate_scene_breakdown_with_dna,
    parse_variant_response,
)


# ─── extract_visual_dna ─────────────────────────────────────────────────────


def test_extract_visual_dna_empty_script_short_circuits() -> None:
    """Empty script → no LLM call, returns empty string."""
    called: dict[str, bool] = {"hit": False}

    def fake_chat(user: str, system: str) -> str:
        called["hit"] = True
        return "ignored"

    assert extract_visual_dna("   \n", chat_fn=fake_chat) == ""
    assert called["hit"] is False


def test_extract_visual_dna_returns_cleaned_paragraph() -> None:
    captured: dict[str, str] = {}

    def fake_chat(user: str, system: str) -> str:
        captured["user"] = user
        captured["system"] = system
        return "  Cinematic 80s neon, low-key lighting.  "

    dna = extract_visual_dna(
        "A neon-soaked detective walks through Tokyo rain.",
        chat_fn=fake_chat,
    )
    assert dna == "Cinematic 80s neon, low-key lighting."
    # System prompt must mention the canonical axes so the model knows
    # what to output (era, palette, lighting, lens, mood).
    sys_prompt = captured["system"].lower()
    for axis in ("era", "palette", "lighting", "lens", "mood"):
        assert axis in sys_prompt, f"system prompt missing axis: {axis}"


def test_extract_visual_dna_strips_surrounding_quotes() -> None:
    def fake_chat(user: str, system: str) -> str:
        return '"Warm 1970s film grain, Kodak Portra palette, soft natural light."'

    dna = extract_visual_dna("script body", chat_fn=fake_chat)
    assert not dna.startswith('"') and not dna.endswith('"')
    assert "Kodak Portra palette" in dna


def test_extract_visual_dna_truncates_chatty_models() -> None:
    big = "Lorem ipsum dolor sit amet. " * 200

    def fake_chat(user: str, system: str) -> str:
        return big

    dna = extract_visual_dna("script", chat_fn=fake_chat)
    assert len(dna) <= VISUAL_DNA_MAX_CHARS + 1  # +1 for ellipsis suffix
    assert dna.endswith("…")


def test_visual_dna_system_prompt_forbids_quotes_and_headings() -> None:
    sys_prompt = build_visual_dna_system_prompt()
    # Strict format constraints we depend on for the cleaning logic
    # downstream.
    assert "no headings" in sys_prompt.lower()
    assert "no surrounding quotes" in sys_prompt.lower()
    assert "plain text only" in sys_prompt.lower()


# ─── build_variant_system_prompt ────────────────────────────────────────────


@pytest.mark.parametrize("count", [2, 3, 4, 6, 8])
def test_variant_system_prompt_names_count_and_axes(count: int) -> None:
    sys_prompt = build_variant_system_prompt(
        count=count, visual_dna="warm natural light"
    )
    # Count is asserted verbatim so the LLM cannot drift to a different
    # variant count.
    assert f"EXACTLY {count} paste-ready" in sys_prompt
    # All 4 diversity axes must appear so the LLM's prompt has the
    # contract spelled out (the tests below pin the axes individually).
    sys_prompt_lower = sys_prompt.lower()
    for axis in ("composition", "lighting", "camera angle", "detail focus"):
        assert axis in sys_prompt_lower
    # Hard constraints for F1.
    assert "at least two" in sys_prompt_lower
    assert "no two prompts may share the same opening" in sys_prompt_lower
    # Visual DNA gets quoted verbatim — case-sensitive substring match.
    assert "warm natural light" in sys_prompt
    # Delimiter contract.
    assert "<<<VARIANT>>>" in sys_prompt


def test_variant_system_prompt_omits_dna_block_when_empty() -> None:
    sys_prompt = build_variant_system_prompt(count=3, visual_dna="   ")
    assert "VISUAL DNA" not in sys_prompt
    # The diversity contract must still survive the missing DNA case.
    assert "EXACTLY 3 paste-ready" in sys_prompt


# ─── parse_variant_response ─────────────────────────────────────────────────


def test_parse_variant_response_splits_on_delimiter() -> None:
    raw = (
        "First prompt body, wide shot.\n"
        "<<<VARIANT>>>\n"
        "Second prompt body, close-up.\n"
        "<<<VARIANT>>>\n"
        "Third prompt body, top-down."
    )
    parsed = parse_variant_response(raw, count=3)
    assert parsed == [
        "First prompt body, wide shot.",
        "Second prompt body, close-up.",
        "Third prompt body, top-down.",
    ]


def test_parse_variant_response_strips_leading_numbering() -> None:
    raw = (
        "Variant 1: Low-angle wide of the factory floor.\n"
        "<<<VARIANT>>>\n"
        "2. Close-up macro on the conveyor belt rivets.\n"
        "<<<VARIANT>>>\n"
        "3) Overhead crane shot of the whole shift.\n"
    )
    parsed = parse_variant_response(raw, count=3)
    assert parsed[0].startswith("Low-angle wide")
    assert parsed[1].startswith("Close-up macro")
    assert parsed[2].startswith("Overhead crane shot")


def test_parse_variant_response_collapses_multiline_paragraphs() -> None:
    raw = (
        "Wide aerial shot of\n"
        "the harbour at\n"
        "blue hour.\n"
        "<<<VARIANT>>>\n"
        "Tight close-up\n"
        "of the captain's hands."
    )
    parsed = parse_variant_response(raw, count=2)
    assert parsed == [
        "Wide aerial shot of the harbour at blue hour.",
        "Tight close-up of the captain's hands.",
    ]


def test_parse_variant_response_pads_short_replies() -> None:
    """Underflow → repeat the last prompt up to ``count``."""
    raw = "Only one variant supplied."
    parsed = parse_variant_response(raw, count=4)
    assert parsed == ["Only one variant supplied."] * 4


def test_parse_variant_response_empty_returns_empty_list() -> None:
    assert parse_variant_response("", count=4) == []
    assert parse_variant_response("   \n", count=4) == []


# ─── expand_image_variants ──────────────────────────────────────────────────


_BASE_SCENE = LongFormScene(
    scene_id=1,
    title="Factory floor at dawn",
    narration="The factory wakes at dawn. Workers begin their shifts.",
    image_prompt="Wide shot of a clean factory floor at dawn, conveyor belts running.",
    flow_video_prompt="Slow dolly push across the conveyor belts.",
)


def test_expand_image_variants_count_one_returns_base_singleton() -> None:
    """No LLM call when only one prompt was requested."""
    called: dict[str, bool] = {"hit": False}

    def fake_chat(user: str, system: str) -> str:
        called["hit"] = True
        return ""

    out = expand_image_variants(_BASE_SCENE, count=1, chat_fn=fake_chat)
    assert out == [_BASE_SCENE.image_prompt]
    assert called["hit"] is False


def test_expand_image_variants_appends_visual_dna_when_missing() -> None:
    captured: dict[str, str] = {}

    def fake_chat(user: str, system: str) -> str:
        captured["user"] = user
        captured["system"] = system
        # LLM "forgets" to append the DNA; the helper must add it back
        # so the final prompts are coherent across the batch.
        return (
            "Aerial wide of the factory floor at dawn.\n"
            "<<<VARIANT>>>\n"
            "Macro close-up of hands lacing up steel-toed boots.\n"
            "<<<VARIANT>>>\n"
            "Low-angle hero shot of the foreman silhouetted against the sunrise."
        )

    dna = "Cinematic 35mm, golden-hour warmth, deep amber palette."
    out = expand_image_variants(
        _BASE_SCENE, count=3, visual_dna=dna, chat_fn=fake_chat
    )
    assert len(out) == 3
    for prompt in out:
        assert dna in prompt, f"missing DNA in: {prompt!r}"
    # User prompt must carry the base seed so the LLM can vary
    # rather than invent a different scene.
    assert _BASE_SCENE.image_prompt in captured["user"]


def test_expand_image_variants_idempotent_dna_when_llm_already_added_it() -> None:
    dna = "anamorphic film grain, low-key amber"

    def fake_chat(user: str, system: str) -> str:
        return (
            f"Wide tracking shot of the assembly line, {dna}\n"
            "<<<VARIANT>>>\n"
            f"Close-up on a worker's gloved hand pressing the start button, {dna}"
        )

    out = expand_image_variants(
        _BASE_SCENE, count=2, visual_dna=dna, chat_fn=fake_chat
    )
    # Helper must NOT double-append when the DNA is already in the
    # response.
    for prompt in out:
        assert prompt.count(dna) == 1


def test_expand_image_variants_falls_back_to_repeat_on_unparseable_reply() -> None:
    def fake_chat(user: str, system: str) -> str:
        return "   \n"

    out = expand_image_variants(_BASE_SCENE, count=4, chat_fn=fake_chat)
    assert out == [_BASE_SCENE.image_prompt] * 4


def test_expand_image_variants_swallows_chat_exceptions() -> None:
    def fake_chat(user: str, system: str) -> str:
        raise RuntimeError("DEEPSEEK_API_KEY not set")

    out = expand_image_variants(_BASE_SCENE, count=3, chat_fn=fake_chat)
    assert out == [_BASE_SCENE.image_prompt] * 3


def test_expand_image_variants_clamps_at_max() -> None:
    captured: dict[str, str] = {}

    def fake_chat(user: str, system: str) -> str:
        captured["system"] = system
        return ""

    expand_image_variants(_BASE_SCENE, count=999, chat_fn=fake_chat)
    assert f"EXACTLY {MAX_VARIANTS_PER_SCENE} paste-ready" in captured["system"]


# ─── generate_scene_breakdown_with_dna ──────────────────────────────────────


_TWO_SCENE_REPLY = """
Scene 1: First scene
NARRATION:
First narration body.
IMAGE PROMPT:
Wide shot of the first subject in their environment.
FLOW VIDEO PROMPT:
Slow push-in. Steady gimbal. Soft ambient sound.

Scene 2: Second scene
NARRATION:
Second narration body.
IMAGE PROMPT:
Medium shot of the second subject reacting to the prior beat.
FLOW VIDEO PROMPT:
Whip pan. Handheld. Punchy mid-tempo cut.
""".strip()


def test_generate_with_dna_extracts_when_override_blank() -> None:
    """LLM is called twice: once for DNA, once for breakdown.
    No variant calls when ``images_per_scene == 1``.
    """
    calls: list[str] = []

    def fake_chat(user: str, system: str) -> str:
        # Detect which LLM call this is by inspecting the system prompt.
        if "Visual DNA" in system or "visual director" in system.lower():
            calls.append("dna")
            return "Auto-extracted: noir 1940s b&w with deep shadows."
        if "scene-breakdown specialist" in system:
            calls.append("breakdown")
            return _TWO_SCENE_REPLY
        calls.append("variant")
        return ""

    scenes, dna = generate_scene_breakdown_with_dna(
        "A noir detective walks the rain-soaked streets.",
        template=SCENE_TEMPLATES["cinematic"],
        n_scenes=2,
        chat_fn=fake_chat,
        images_per_scene=1,  # → no variant calls
    )
    assert dna == "Auto-extracted: noir 1940s b&w with deep shadows."
    assert calls == ["dna", "breakdown"], calls
    assert len(scenes) == 2
    # No variants requested → image_prompts stays empty.
    for s in scenes:
        assert s.image_prompts == ()


def test_generate_with_dna_skips_extract_when_override_provided() -> None:
    calls: list[str] = []

    def fake_chat(user: str, system: str) -> str:
        if "visual director" in system.lower():
            calls.append("dna")
        elif "scene-breakdown specialist" in system:
            calls.append("breakdown")
        else:
            calls.append("variant")
        return _TWO_SCENE_REPLY if "scene-breakdown" in system else ""

    scenes, dna = generate_scene_breakdown_with_dna(
        "Some script body that's long enough to count.",
        template=SCENE_TEMPLATES["cinematic"],
        n_scenes=2,
        chat_fn=fake_chat,
        visual_dna_override="user-pinned: 80s neon",
        images_per_scene=1,
    )
    assert dna == "user-pinned: 80s neon"
    assert "dna" not in calls, "override must skip the auto-extract call"
    assert "breakdown" in calls


def test_generate_with_dna_expands_variants_per_scene() -> None:
    """``images_per_scene == 3`` triggers one variant call per scene."""
    variant_call_count = 0

    def fake_chat(user: str, system: str) -> str:
        nonlocal variant_call_count
        if "visual director" in system.lower():
            return "noir 40s monochrome"
        if "scene-breakdown specialist" in system:
            return _TWO_SCENE_REPLY
        variant_call_count += 1
        return (
            "Wide tracking shot, exterior, low key.\n"
            "<<<VARIANT>>>\n"
            "Medium two-shot, ambient practicals only.\n"
            "<<<VARIANT>>>\n"
            "Macro close-up on a single rain-soaked detail."
        )

    scenes, dna = generate_scene_breakdown_with_dna(
        "Long enough script body to pass the n-scene estimator.",
        template=SCENE_TEMPLATES["cinematic"],
        n_scenes=2,
        chat_fn=fake_chat,
        images_per_scene=3,
    )
    assert variant_call_count == 2  # one per scene
    assert dna == "noir 40s monochrome"
    assert len(scenes) == 2
    for s in scenes:
        assert len(s.image_prompts) == 3
        # First variant must round-trip into the legacy singular field.
        assert s.image_prompt == s.image_prompts[0]
        # DNA must be appended to every variant.
        for p in s.image_prompts:
            assert dna in p


def test_generate_with_dna_empty_script_returns_empty() -> None:
    """No script → no LLM calls, no scenes, empty DNA."""
    called: dict[str, bool] = {"hit": False}

    def fake_chat(user: str, system: str) -> str:
        called["hit"] = True
        return ""

    scenes, dna = generate_scene_breakdown_with_dna(
        "   \n",
        template=SCENE_TEMPLATES["cinematic"],
        chat_fn=fake_chat,
    )
    assert scenes == []
    assert dna == ""
    assert called["hit"] is False
