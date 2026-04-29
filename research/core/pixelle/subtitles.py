"""Subtitle generation: WordBoundary → Caption groups, with sentence fallback.

Two paths share a single :class:`Caption` schema so the composer never has
to know where the timing came from:

1. **Primary** — :func:`group_word_boundaries` turns Edge-TTS WordBoundary
   events into ~3-word captions, splitting at punctuation.
2. **Fallback** — :func:`split_by_sentences` divides the script into
   sentences (using common Latin + CJK punctuation) and spreads them
   evenly across ``audio_duration_s`` if no per-word timing exists.

Both return ``list[Caption]`` ordered by start time.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Edge-TTS WordBoundary timestamps are in 100-nanosecond units (HNS).
HNS_PER_SECOND = 10_000_000

# Sentence terminators across EN/KO/JA/VI/Chinese.
_SENTENCE_TERMINATORS = re.compile(r"(?<=[.!?。！？])\s+|\n+")

# Captions break naturally on these characters even mid-sentence.
_SOFT_BREAKS = {",", ";", ":", "—", "–", "，", "、", "；", "：", ".", "!", "?", "。", "！", "？"}

# Default cap on caption length when chunking word boundaries.
DEFAULT_MAX_WORDS_PER_CAPTION = 3
DEFAULT_MIN_DURATION_S = 0.6
DEFAULT_MAX_DURATION_S = 4.0


@dataclass(frozen=True)
class Caption:
    """One subtitle line displayed from ``start_s`` to ``end_s``."""

    start_s: float
    end_s: float
    text: str

    @property
    def duration_s(self) -> float:
        return max(0.0, self.end_s - self.start_s)


@dataclass(frozen=True)
class WordBoundary:
    """Timing for one word as emitted by Edge-TTS."""

    start_s: float
    end_s: float
    text: str

    @classmethod
    def from_edge_tts(cls, event: dict) -> "WordBoundary":
        """Build from a raw ``{"type": "WordBoundary", "offset": ..., "duration": ..., "text": ...}``."""
        offset = event.get("offset", 0)
        duration = event.get("duration", 0)
        return cls(
            start_s=offset / HNS_PER_SECOND,
            end_s=(offset + duration) / HNS_PER_SECOND,
            text=event.get("text", ""),
        )


def group_word_boundaries(
    boundaries: list[WordBoundary],
    *,
    max_words: int = DEFAULT_MAX_WORDS_PER_CAPTION,
    max_duration_s: float = DEFAULT_MAX_DURATION_S,
) -> list[Caption]:
    """Group word boundaries into caption-sized chunks.

    Splits whenever any of these is true (whichever fires first):

    - the running word count would exceed ``max_words``,
    - the caption would exceed ``max_duration_s``,
    - the current word ends in a soft-break punctuation.

    Returns an empty list when ``boundaries`` is empty.
    """
    if not boundaries:
        return []

    captions: list[Caption] = []
    chunk: list[WordBoundary] = []

    def _flush() -> None:
        if not chunk:
            return
        text = " ".join(w.text for w in chunk).strip()
        if text:
            captions.append(
                Caption(
                    start_s=chunk[0].start_s,
                    end_s=chunk[-1].end_s,
                    text=text,
                )
            )
        chunk.clear()

    for w in boundaries:
        # Pre-check: if adding this word would push past max_duration_s, flush
        # the current chunk first so this word starts a new caption.
        if chunk and (w.end_s - chunk[0].start_s) > max_duration_s:
            _flush()
        chunk.append(w)
        ends_at_break = bool(w.text) and w.text[-1] in _SOFT_BREAKS
        too_many_words = len(chunk) >= max_words
        if ends_at_break or too_many_words:
            _flush()
    _flush()
    return captions


def split_by_sentences(text: str) -> list[str]:
    """Split *text* into sentences using EN/CJK terminators.

    Empty / whitespace-only sentences are dropped. Trailing whitespace is
    trimmed; internal whitespace is preserved.
    """
    if not text or not text.strip():
        return []
    parts = _SENTENCE_TERMINATORS.split(text.strip())
    return [s.strip() for s in parts if s and s.strip()]


def fallback_captions_from_text(text: str, *, audio_duration_s: float) -> list[Caption]:
    """Generate captions when no per-word timing is available.

    Splits *text* into sentences and distributes them **proportionally to
    sentence character length** across the audio duration — a longer
    sentence gets a longer slot. This is rough but produces readable
    captions even without WordBoundary support.
    """
    sentences = split_by_sentences(text)
    if not sentences or audio_duration_s <= 0:
        return []

    total_chars = sum(len(s) for s in sentences) or 1
    captions: list[Caption] = []
    cursor = 0.0
    for sentence in sentences:
        share = len(sentence) / total_chars
        slot = max(DEFAULT_MIN_DURATION_S, audio_duration_s * share)
        end = min(audio_duration_s, cursor + slot)
        captions.append(Caption(start_s=cursor, end_s=end, text=sentence))
        cursor = end
        if cursor >= audio_duration_s:
            break

    if captions and captions[-1].end_s < audio_duration_s:
        # Stretch the last caption to the end of audio so subtitles cover
        # the full clip rather than leaving a silent tail uncaptioned.
        last = captions[-1]
        captions[-1] = Caption(start_s=last.start_s, end_s=audio_duration_s, text=last.text)
    return captions


def captions_to_srt(captions: list[Caption]) -> str:
    """Render captions as a SubRip (.srt) document."""
    lines: list[str] = []
    for i, cap in enumerate(captions, start=1):
        lines.append(str(i))
        lines.append(f"{_fmt_srt_ts(cap.start_s)} --> {_fmt_srt_ts(cap.end_s)}")
        lines.append(cap.text)
        lines.append("")
    return "\n".join(lines)


def _fmt_srt_ts(seconds: float) -> str:
    """``HH:MM:SS,mmm`` format expected by SubRip."""
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"
