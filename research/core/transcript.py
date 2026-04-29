"""Transcript fetcher with two backends (api → yt-dlp fallback).

Order of attempts:
1. ``youtube-transcript-api`` — fast, no install, but blocked from many
   cloud-IP ranges.
2. ``yt-dlp`` — scrapes the watch page; usually works where #1 fails.

Set ``TUBE_ATLAS_TRANSCRIPT_BACKEND=ytdlp`` to skip step 1 entirely.
"""
from __future__ import annotations

import os

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound

from . import transcript_ytdlp


def _via_api(video_id: str, languages: list[str]) -> list[dict]:
    api = YouTubeTranscriptApi()
    try:
        fetched = api.fetch(video_id, languages=languages)
    except (TranscriptsDisabled, NoTranscriptFound):
        listing = api.list(video_id)
        for t in listing:
            return [s.__dict__ if hasattr(s, "__dict__") else s for s in t.fetch()]
        return []
    return [
        {"text": s.text, "start": s.start, "duration": s.duration}
        for s in fetched
    ]


def fetch_transcript(video_id: str, languages: list[str] | None = None) -> list[dict]:
    """Fetch transcript with API → yt-dlp fallback.

    Always raises if both backends fail; UI is responsible for handling.
    """
    langs = languages or ["en", "ko", "ja", "vi"]
    backend = os.getenv("TUBE_ATLAS_TRANSCRIPT_BACKEND", "auto").lower()

    api_error: Exception | None = None
    if backend != "ytdlp":
        try:
            res = _via_api(video_id, langs)
            if res:
                return res
            api_error = RuntimeError("transcript-api returned no segments")
        except Exception as e:  # broad: network, IP block, parser issues
            api_error = e

    try:
        return transcript_ytdlp.fetch_transcript_ytdlp(video_id, langs)
    except Exception as ytdlp_err:
        if api_error is not None:
            raise RuntimeError(
                f"transcript-api failed ({api_error}); yt-dlp fallback also failed ({ytdlp_err})"
            ) from ytdlp_err
        raise


def transcript_to_text(segments: list[dict]) -> str:
    return "\n".join(s["text"] for s in segments)


def transcript_to_srt(segments: list[dict]) -> str:
    def fmt(t: float) -> str:
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = int(t % 60)
        ms = int((t - int(t)) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines: list[str] = []
    for i, seg in enumerate(segments, 1):
        start = seg["start"]
        end = start + seg.get("duration", 0)
        lines.append(str(i))
        lines.append(f"{fmt(start)} --> {fmt(end)}")
        lines.append(seg["text"].replace("\n", " "))
        lines.append("")
    return "\n".join(lines)
