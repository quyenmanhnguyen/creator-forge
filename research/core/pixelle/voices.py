"""Curated Edge-TTS voice list for the Producer page picker.

Edge-TTS exposes several hundred voices; this is a hand-picked top selection
covering EN/KO/JA/VI/ZH/ES with both genders. Order is what the UI shows.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Voice:
    """A single Edge-TTS voice option."""

    short_name: str
    label: str
    locale: str
    gender: str  # "F" or "M"


VOICES: tuple[Voice, ...] = (
    Voice("en-US-AriaNeural",      "English (US) · Aria · F",      "en-US", "F"),
    Voice("en-US-GuyNeural",       "English (US) · Guy · M",       "en-US", "M"),
    Voice("en-US-JennyNeural",     "English (US) · Jenny · F",     "en-US", "F"),
    Voice("en-GB-LibbyNeural",     "English (UK) · Libby · F",     "en-GB", "F"),
    Voice("ko-KR-SunHiNeural",     "한국어 · 선희 · F",            "ko-KR", "F"),
    Voice("ko-KR-InJoonNeural",    "한국어 · 인준 · M",            "ko-KR", "M"),
    Voice("ja-JP-NanamiNeural",    "日本語 · ナナミ · F",          "ja-JP", "F"),
    Voice("ja-JP-KeitaNeural",     "日本語 · 圭太 · M",            "ja-JP", "M"),
    Voice("vi-VN-HoaiMyNeural",    "Tiếng Việt · Hoài My · F",     "vi-VN", "F"),
    Voice("vi-VN-NamMinhNeural",   "Tiếng Việt · Nam Minh · M",    "vi-VN", "M"),
    Voice("zh-CN-XiaoxiaoNeural",  "中文 · 晓晓 · F",              "zh-CN", "F"),
    Voice("es-ES-ElviraNeural",    "Español · Elvira · F",         "es-ES", "F"),
)


def voice_short_names() -> list[str]:
    return [v.short_name for v in VOICES]


def voice_labels() -> list[str]:
    return [v.label for v in VOICES]


def voice_by_short_name(short_name: str) -> Voice | None:
    for v in VOICES:
        if v.short_name == short_name:
            return v
    return None


def default_voice_for_lang(lang_code: str) -> Voice:
    """Pick a sensible default voice for a 2-letter UI language code."""
    prefix = (lang_code or "").lower()
    for v in VOICES:
        if v.locale.lower().startswith(prefix):
            return v
    return VOICES[0]
