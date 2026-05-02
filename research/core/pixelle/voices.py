"""Curated TTS voice list for the Producer page picker.

Two providers are supported:

- ``edge-tts``  — Microsoft Edge TTS (online, free). Several hundred voices
  available; this is a hand-picked top selection covering EN/KO/JA/VI/ZH/ES
  with both genders. The ``short_name`` is what edge-tts expects on the
  ``Communicate(short_name=...)`` call.

- ``piper-tts`` — Piper neural TTS (local, offline, ~25 MB / voice). The
  ``short_name`` is the Piper voice id (e.g. ``vi_VN-vais1000-medium``); the
  EdgeTTSAdapter passes it straight to ``piper.PiperVoice.load()`` which
  resolves it under ``~/.creator-forge/piper-voices/<short_name>.onnx``.
  We expose a small starter list — users can drop more voices into that
  folder and pick them by typing the id (handled at the route layer).

The order in ``VOICES`` is the order the UI shows. ``provider`` is exposed
as a tag on every voice so the renderer's voice-picker can filter by the
currently-selected TTS provider dropdown.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Voice:
    """A single curated TTS voice option."""

    short_name: str
    label: str
    locale: str
    gender: str  # "F" or "M"
    # Which TTS provider this voice belongs to. Defaults to
    # ``edge-tts`` so existing callers / tests that omit the field
    # continue to behave identically. Renderer + ``/producer/voices``
    # consumers must NOT cross-feed a piper voice id into edge-tts
    # or vice versa — the route's voice-validation gate uses this tag.
    provider: str = "edge-tts"


VOICES: tuple[Voice, ...] = (
    # ── Edge-TTS (online) ────────────────────────────────────────────
    Voice("en-US-AriaNeural",      "English (US) · Aria · F",      "en-US", "F", "edge-tts"),
    Voice("en-US-GuyNeural",       "English (US) · Guy · M",       "en-US", "M", "edge-tts"),
    Voice("en-US-JennyNeural",     "English (US) · Jenny · F",     "en-US", "F", "edge-tts"),
    Voice("en-GB-LibbyNeural",     "English (UK) · Libby · F",     "en-GB", "F", "edge-tts"),
    Voice("ko-KR-SunHiNeural",     "한국어 · 선희 · F",            "ko-KR", "F", "edge-tts"),
    Voice("ko-KR-InJoonNeural",    "한국어 · 인준 · M",            "ko-KR", "M", "edge-tts"),
    Voice("ja-JP-NanamiNeural",    "日本語 · ナナミ · F",          "ja-JP", "F", "edge-tts"),
    Voice("ja-JP-KeitaNeural",     "日本語 · 圭太 · M",            "ja-JP", "M", "edge-tts"),
    Voice("vi-VN-HoaiMyNeural",    "Tiếng Việt · Hoài My · F",     "vi-VN", "F", "edge-tts"),
    Voice("vi-VN-NamMinhNeural",   "Tiếng Việt · Nam Minh · M",    "vi-VN", "M", "edge-tts"),
    Voice("zh-CN-XiaoxiaoNeural",  "中文 · 晓晓 · F",              "zh-CN", "F", "edge-tts"),
    Voice("es-ES-ElviraNeural",    "Español · Elvira · F",         "es-ES", "F", "edge-tts"),

    # ── Piper TTS (offline) ──────────────────────────────────────────
    # Voice ids resolve via piper.PiperVoice.load(short_name) ↦
    # ~/.creator-forge/piper-voices/<short_name>.onnx. Users add more
    # voices by dropping new .onnx + .json pairs into that folder and
    # editing the dropdown manually (or — cheaper — using the
    # "Custom voice id" override on the dropdown to type a name).
    Voice("vi_VN-vais1000-medium", "Tiếng Việt · VAIS-1000 (Piper · M)",  "vi-VN", "M", "piper-tts"),
    Voice("en_US-amy-medium",      "English (US) · Amy (Piper · F)",     "en-US", "F", "piper-tts"),
    Voice("en_US-ryan-medium",     "English (US) · Ryan (Piper · M)",    "en-US", "M", "piper-tts"),
    Voice("en_GB-alan-medium",     "English (UK) · Alan (Piper · M)",    "en-GB", "M", "piper-tts"),
    Voice("ja_JP-takumi-medium",   "日本語 · Takumi (Piper · M)",         "ja-JP", "M", "piper-tts"),
    Voice("ko_KR-ngfei-medium",    "한국어 · ngfei (Piper · F)",          "ko-KR", "F", "piper-tts"),
)


def voices_for_provider(provider: str | None) -> tuple[Voice, ...]:
    """Return the subset of curated voices matching the given provider.

    ``provider=None`` or empty string returns the full list, matching the
    pre-PR behaviour of ``VOICES`` so existing callers that don't care
    about provider segmentation stay green. Unknown providers return an
    empty tuple — callers (e.g. the route) can decide whether to 404 or
    fall back to ``VOICES``.
    """
    if not provider:
        return VOICES
    p = provider.strip().lower()
    return tuple(v for v in VOICES if v.provider == p)


def voice_short_names(provider: str | None = None) -> list[str]:
    """Short names for the given provider (default: every voice).

    The legacy zero-arg form is preserved so existing callers in
    ``research/api/routes/producer.py`` keep validating against the
    full edge-tts + piper-tts set when the provider isn't known yet.
    """
    return [v.short_name for v in voices_for_provider(provider)]


def voice_labels(provider: str | None = None) -> list[str]:
    return [v.label for v in voices_for_provider(provider)]


def voice_by_short_name(short_name: str) -> Voice | None:
    for v in VOICES:
        if v.short_name == short_name:
            return v
    return None


def default_voice_for_lang(lang_code: str, provider: str | None = None) -> Voice:
    """Pick a sensible default voice for a 2-letter UI language code.

    When ``provider`` is supplied we restrict the search to that
    provider's voices — this matters for the renderer's voice-picker
    which flips the default voice when the user toggles the TTS
    provider dropdown. Falls back to the first voice in the
    provider-filtered list (or ``VOICES[0]`` for unknown providers).
    """
    candidates = voices_for_provider(provider)
    if not candidates:
        candidates = VOICES
    prefix = (lang_code or "").lower()
    for v in candidates:
        if v.locale.lower().startswith(prefix):
            return v
    return candidates[0]
