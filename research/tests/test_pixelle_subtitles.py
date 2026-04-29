"""Tests for core.pixelle.subtitles (WordBoundary grouping + sentence fallback + SRT)."""
from __future__ import annotations

from core.pixelle import subtitles as subs


def _wb(start: float, end: float, text: str) -> subs.WordBoundary:
    return subs.WordBoundary(start_s=start, end_s=end, text=text)


def test_word_boundary_from_edge_tts_event():
    event = {"type": "WordBoundary", "offset": 30_000_000, "duration": 5_000_000, "text": "hi"}
    wb = subs.WordBoundary.from_edge_tts(event)
    assert wb.text == "hi"
    assert wb.start_s == 3.0
    assert wb.end_s == 3.5


def test_group_word_boundaries_splits_at_max_words():
    boundaries = [
        _wb(0.0, 0.3, "one"),
        _wb(0.3, 0.6, "two"),
        _wb(0.6, 0.9, "three"),
        _wb(0.9, 1.2, "four"),
        _wb(1.2, 1.5, "five"),
    ]
    captions = subs.group_word_boundaries(boundaries, max_words=3)
    assert len(captions) == 2
    assert captions[0].text == "one two three"
    assert captions[0].start_s == 0.0
    assert captions[0].end_s == 0.9
    assert captions[1].text == "four five"


def test_group_word_boundaries_splits_at_punctuation():
    boundaries = [
        _wb(0.0, 0.3, "hello,"),
        _wb(0.3, 0.6, "there"),
        _wb(0.6, 0.9, "friend."),
    ]
    captions = subs.group_word_boundaries(boundaries, max_words=10)
    assert len(captions) == 2
    assert captions[0].text == "hello,"
    assert captions[1].text == "there friend."


def test_group_word_boundaries_splits_at_max_duration():
    boundaries = [_wb(0.0, 1.5, "loooong"), _wb(1.5, 3.5, "wooord")]
    captions = subs.group_word_boundaries(boundaries, max_words=10, max_duration_s=2.0)
    assert len(captions) == 2  # second word would push past max_duration


def test_group_word_boundaries_empty_returns_empty():
    assert subs.group_word_boundaries([]) == []


def test_split_by_sentences_handles_en_and_cjk():
    text = "Hello. World! Are you there? 你好。これは。Xin chào!"
    parts = subs.split_by_sentences(text)
    assert parts == ["Hello.", "World!", "Are you there?", "你好。これは。Xin chào!"]


def test_split_by_sentences_drops_blank():
    assert subs.split_by_sentences("   ") == []
    assert subs.split_by_sentences("") == []


def test_fallback_captions_distribute_proportionally():
    # 3 sentences with 1, 2, and 5 words → longer sentence gets bigger slot.
    text = "Short. Two words. This is the longest sentence here."
    captions = subs.fallback_captions_from_text(text, audio_duration_s=10.0)

    assert len(captions) == 3
    assert captions[0].start_s == 0.0
    assert captions[-1].end_s == 10.0  # last caption stretched to audio end
    # Sentences are ordered, no overlap (no strict — captions[1:] is shorter by 1).
    for prev, nxt in zip(captions, captions[1:]):
        assert prev.end_s == nxt.start_s
    # The longer sentence has the longest slot
    durations = [c.duration_s for c in captions]
    assert max(durations) == captions[2].duration_s


def test_fallback_captions_zero_duration_returns_empty():
    assert subs.fallback_captions_from_text("Hello.", audio_duration_s=0) == []
    assert subs.fallback_captions_from_text("", audio_duration_s=10) == []


def test_captions_to_srt_format():
    caps = [
        subs.Caption(start_s=0.0, end_s=1.5, text="first line"),
        subs.Caption(start_s=1.5, end_s=3.25, text="second line"),
    ]
    srt = subs.captions_to_srt(caps)

    expected = (
        "1\n"
        "00:00:00,000 --> 00:00:01,500\n"
        "first line\n"
        "\n"
        "2\n"
        "00:00:01,500 --> 00:00:03,250\n"
        "second line\n"
    )
    assert srt == expected


def test_fmt_srt_ts_pads_correctly():
    assert subs._fmt_srt_ts(0.0) == "00:00:00,000"
    assert subs._fmt_srt_ts(3661.789) == "01:01:01,789"
    assert subs._fmt_srt_ts(-1.0) == "00:00:00,000"
