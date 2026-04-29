"""Tests for the yt-dlp transcript fallback layer."""
from __future__ import annotations

from core import transcript_ytdlp


SAMPLE_VTT = """WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.500
Hello and welcome to this video

00:00:02.500 --> 00:00:05.000
where we discuss something <c.color>important</c>

00:00:05.000 --> 00:00:07.200
that's it.
"""


def test_parse_vtt_extracts_segments():
    segs = transcript_ytdlp.parse_vtt(SAMPLE_VTT)
    assert len(segs) == 3
    assert segs[0]["text"] == "Hello and welcome to this video"
    # Tag should be stripped
    assert segs[1]["text"] == "where we discuss something important"
    assert segs[0]["start"] == 0.0
    assert segs[0]["duration"] == 2.5


def test_parse_vtt_dedupes_repeated_lines():
    """yt-dlp auto-subs sometimes repeat the same caption across cues — dedupe."""
    vtt = """WEBVTT

00:00:00.000 --> 00:00:02.000
hello

00:00:02.000 --> 00:00:04.000
hello
"""
    segs = transcript_ytdlp.parse_vtt(vtt)
    assert len(segs) == 1


def test_parse_vtt_empty_returns_empty():
    assert transcript_ytdlp.parse_vtt("") == []
    assert transcript_ytdlp.parse_vtt("WEBVTT\n\n") == []


def test_parse_vtt_invalid_timestamp_skipped():
    vtt = """WEBVTT

00:NOT:VALID --> garbage
broken cue

00:00:00.000 --> 00:00:01.000
valid one
"""
    segs = transcript_ytdlp.parse_vtt(vtt)
    assert len(segs) == 1
    assert segs[0]["text"] == "valid one"
