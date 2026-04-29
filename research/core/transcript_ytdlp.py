"""yt-dlp-backed transcript fetcher.

Used as a fallback when ``youtube-transcript-api`` fails (e.g. cloud-IP
blocks). yt-dlp scrapes the watch page and downloads the auto-generated
``.vtt`` subtitle file, which goes through a different code path on
YouTube's end and is more resilient against IP blocking.

We parse the VTT in-process (no temp files) by passing
``--write-auto-sub --skip-download --output -`` and a custom hook —
but yt-dlp's CLI doesn't easily stream subs to stdout, so we write to
a tempdir, read, and clean up.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile


_TIMESTAMP_LINE = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}")
_TAG = re.compile(r"<[^>]+>")


def _parse_timestamp(line: str) -> tuple[float, float] | None:
    parts = line.strip().split(" --> ")
    if len(parts) != 2:
        return None

    def _to_secs(ts: str) -> float:
        h, m, rest = ts.split(":")
        s, ms = rest.split(".")
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0

    try:
        return _to_secs(parts[0]), _to_secs(parts[1])
    except ValueError:
        return None


def parse_vtt(text: str) -> list[dict]:
    """Parse VTT body to ``[{text, start, duration}, ...]``."""
    lines = text.splitlines()
    out: list[dict] = []
    i = 0
    last_text = ""
    while i < len(lines):
        line = lines[i]
        if _TIMESTAMP_LINE.match(line):
            ts = _parse_timestamp(line)
            i += 1
            buf: list[str] = []
            while i < len(lines) and lines[i].strip():
                buf.append(_TAG.sub("", lines[i]).strip())
                i += 1
            text_block = " ".join(s for s in buf if s).strip()
            if ts and text_block and text_block != last_text:
                start, end = ts
                out.append(
                    {"text": text_block, "start": start, "duration": max(end - start, 0.0)}
                )
                last_text = text_block
        else:
            i += 1
    return out


def fetch_transcript_ytdlp(
    video_id: str,
    languages: list[str] | None = None,
    timeout: int = 60,
) -> list[dict]:
    """Use ``yt-dlp`` to download auto-subs for ``video_id``; parse VTT.

    Returns the same shape as ``core.transcript.fetch_transcript`` —
    ``[{text, start, duration}, ...]``. Raises ``RuntimeError`` if no
    subtitle could be obtained.
    """
    languages = languages or ["en", "ko", "ja", "vi"]
    url = f"https://www.youtube.com/watch?v={video_id}"
    sub_langs = ",".join(languages)

    with tempfile.TemporaryDirectory() as tmpdir:
        out_template = os.path.join(tmpdir, "%(id)s.%(ext)s")
        cmd = [
            "yt-dlp",
            "--quiet",
            "--no-warnings",
            "--write-auto-sub",
            "--write-sub",
            "--sub-lang",
            sub_langs,
            "--skip-download",
            "--sub-format",
            "vtt",
            "--output",
            out_template,
            url,
        ]
        try:
            subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            raise RuntimeError(f"yt-dlp unavailable or timed out: {e}") from e

        vtt_files = [
            os.path.join(tmpdir, f)
            for f in os.listdir(tmpdir)
            if f.endswith(".vtt")
        ]
        if not vtt_files:
            raise RuntimeError("yt-dlp produced no subtitle file (likely no captions).")

        # Prefer subtitle that matches one of the requested languages, in order.
        chosen: str | None = None
        for lang in languages:
            for f in vtt_files:
                if f".{lang}." in f:
                    chosen = f
                    break
            if chosen:
                break
        chosen = chosen or vtt_files[0]

        with open(chosen, encoding="utf-8") as f:
            text = f.read()

    parsed = parse_vtt(text)
    if not parsed:
        raise RuntimeError("yt-dlp returned an empty transcript.")
    return parsed
