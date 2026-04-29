"""Tests for core.pixelle.styles + voices (small but covered for completeness)."""
from __future__ import annotations

from core.pixelle import styles, voices


def test_all_styles_have_three_colors():
    for style in styles.STYLES.values():
        for component in (style.top, style.bottom, style.accent):
            assert len(component) == 3
            assert all(0 <= c <= 255 for c in component)


def test_get_style_falls_back_to_default():
    assert styles.get_style("does-not-exist").name == styles.DEFAULT_STYLE


def test_get_style_returns_named_when_present():
    assert styles.get_style("ocean").name == "ocean"


def test_voices_top_12_are_unique():
    short_names = [v.short_name for v in voices.VOICES]
    assert len(short_names) == len(set(short_names))
    assert len(voices.VOICES) >= 10  # at least 10 voices for EN/KO/JA/VI


def test_voices_have_label_and_locale():
    for v in voices.VOICES:
        assert v.short_name
        assert v.label
        assert "-" in v.locale  # e.g. "en-US"
        assert v.gender in {"F", "M"}


def test_voice_by_short_name_lookup():
    v = voices.voice_by_short_name("vi-VN-HoaiMyNeural")
    assert v is not None
    assert v.locale == "vi-VN"
    assert voices.voice_by_short_name("does-not-exist") is None


def test_default_voice_for_language_prefix():
    assert voices.default_voice_for_lang("vi").locale.startswith("vi-")
    assert voices.default_voice_for_lang("ko").locale.startswith("ko-")
    assert voices.default_voice_for_lang("ja").locale.startswith("ja-")
    assert voices.default_voice_for_lang("en").locale.startswith("en-")
    # Unknown → first voice (English).
    assert voices.default_voice_for_lang("xx").locale.startswith("en-")
