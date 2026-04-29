"""Detect the language of a transcript / text and map to our LangCode.

Used by Video Cloner so the clone kit (titles, script, thumbnail copy) is
emitted in the same language as the original video, regardless of the
sidebar Language picker.
"""
from __future__ import annotations

from typing import Literal

from langdetect import DetectorFactory, detect

DetectorFactory.seed = 0  # deterministic for our 4 supported langs

LangCode = Literal["en", "ko", "ja", "vi"]

# langdetect → our LangCode. Anything else → "en" fallback.
_MAP: dict[str, LangCode] = {
    "en": "en",
    "ko": "ko",
    "ja": "ja",
    "vi": "vi",
    "zh-cn": "en",  # treat Chinese as English fallback (we don't ship zh)
    "zh-tw": "en",
}


def detect_lang(text: str, default: LangCode = "en") -> LangCode:
    """Return one of ``en/ko/ja/vi`` for ``text``. ``default`` if unknown."""
    sample = text.strip()
    if len(sample) < 20:
        return default
    try:
        raw = detect(sample[:1500]).lower()
    except Exception:
        return default
    return _MAP.get(raw, default)
