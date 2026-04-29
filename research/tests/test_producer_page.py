"""Tests for the small helpers used by pages/05_Producer.py.

We can't easily run the Streamlit page itself in a unit test (it requires
a real Streamlit runtime), but the page is a thin wrapper over four pure
helpers that we exercise directly here.
"""
from __future__ import annotations

from core import i18n
from core.pixelle.voices import VOICES, default_voice_for_lang, voice_by_short_name


def test_producer_i18n_strings_present_in_all_langs():
    """Every Producer-facing string must exist in en/ko/ja/vi."""
    required_keys = [
        "producer_name",
        "producer_sub",
        "producer_desc",
        "producer_script",
        "producer_voice",
        "producer_style",
        "producer_duration",
        "producer_run",
        "producer_step_tts",
        "producer_step_caps",
        "producer_step_render",
        "producer_done",
        "producer_download",
        "producer_status",
        "producer_no_script",
        "producer_caption_source_wb",
        "producer_caption_source_fb",
        # PR-A3 — Visual generation section
        "producer_visual_section",
        "producer_style_src",
        "producer_style_src_clone",
        "producer_style_src_preset",
        "producer_style_src_manual",
        "producer_style_clone_hint",
        "producer_style_manual_ref",
        "producer_style_preset_pick",
        "producer_provider_pick",
        "producer_provider_ok",
        "producer_provider_missing",
        "producer_provider_fallback",
        "producer_build_prompts",
        "producer_scene_count",
        "producer_download_prompts",
    ]
    required_languages = {"en", "ko", "ja", "vi"}
    for key in required_keys:
        bundle = i18n.STRINGS.get(key)
        assert bundle, f"Missing i18n bundle for {key}"
        assert required_languages.issubset(bundle.keys()), (
            f"{key} missing langs: {required_languages - set(bundle.keys())}"
        )


def test_voice_picker_covers_target_languages():
    """The picker must include at least one voice for each of EN/KO/JA/VI."""
    locales = {v.locale.split("-")[0] for v in VOICES}
    assert {"en", "ko", "ja", "vi"}.issubset(locales)


def test_default_voice_picker_matches_each_ui_lang():
    """default_voice_for_lang() should return a sensible default for each UI lang."""
    assert default_voice_for_lang("en").locale.startswith("en-")
    assert default_voice_for_lang("ko").locale.startswith("ko-")
    assert default_voice_for_lang("ja").locale.startswith("ja-")
    assert default_voice_for_lang("vi").locale.startswith("vi-")


def test_voice_by_short_name_round_trip():
    for v in VOICES:
        assert voice_by_short_name(v.short_name) is v


def test_initial_script_handoff_logic():
    """Mirror the fall-through chain in pages/05_Producer.py._initial_script:
    handoff key > studio.script_final > studio.script > empty."""

    def _initial(state: dict) -> str:
        handoff = state.pop("producer_script_in", None)
        if handoff:
            return handoff
        studio = state.get("studio") or {}
        return studio.get("script_final") or studio.get("script") or ""

    # Handoff wins over Studio output and is consumed (popped).
    state: dict = {"producer_script_in": "from-handoff", "studio": {"script_final": "ignored"}}
    assert _initial(state) == "from-handoff"
    assert "producer_script_in" not in state

    # Final humanized script preferred over raw draft.
    assert _initial({"studio": {"script_final": "final", "script": "draft"}}) == "final"

    # Falls back to raw draft when final is empty.
    assert _initial({"studio": {"script_final": "", "script": "draft"}}) == "draft"

    # No studio at all → empty string (not a crash).
    assert _initial({}) == ""
