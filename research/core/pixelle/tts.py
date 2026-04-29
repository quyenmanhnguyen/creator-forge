"""Text-to-speech adapters for the Pixelle pipeline.

The :class:`TTSAdapter` protocol is the single seam used by the Producer
page. Today only Edge-TTS is implemented (free, no key, decent quality).
IndexTTS / ChatTTS / Kokoro can be added later by implementing the same
protocol — pages need not change.

The Edge-TTS adapter exposes two flavours:

- :meth:`EdgeTTSAdapter.synthesize` — fire-and-forget, just writes the mp3.
- :meth:`EdgeTTSAdapter.synthesize_with_timing` — also captures per-word
  timing (``WordBoundary`` events) so the subtitle module can build SRT
  without needing a separate alignment pass.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from core.pixelle.config import TTSConfig
from core.pixelle.subtitles import WordBoundary


@dataclass
class TTSResult:
    """Outcome of a synthesis run."""

    audio_path: Path
    duration_seconds: float
    voice: str
    engine: str
    word_boundaries: list[WordBoundary] = field(default_factory=list)


class TTSAdapter(Protocol):
    """Minimal interface every TTS engine must implement."""

    name: str

    def synthesize(self, text: str, *, output_path: Path, voice: str) -> TTSResult:
        """Render *text* to *output_path* (mp3) using *voice*; return metadata."""
        ...


class EdgeTTSAdapter:
    """Microsoft Edge TTS (via the ``edge-tts`` PyPI package).

    Free, no API key, dozens of locales. The ``edge-tts`` library is
    async-only, so we wrap it with :func:`asyncio.run`.
    """

    name = "edge-tts"

    def __init__(self, *, rate: str = "+0%", volume: str = "+0%") -> None:
        self.rate = rate
        self.volume = volume

    def synthesize(self, text: str, *, output_path: Path, voice: str) -> TTSResult:
        if not text.strip():
            raise ValueError("TTS text must be non-empty")
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        asyncio.run(self._run(text=text, output_path=output_path, voice=voice))
        duration = _probe_mp3_duration(output_path)
        return TTSResult(
            audio_path=output_path,
            duration_seconds=duration,
            voice=voice,
            engine=self.name,
        )

    def synthesize_with_timing(
        self, text: str, *, output_path: Path, voice: str
    ) -> TTSResult:
        """Like :meth:`synthesize` but also captures WordBoundary events.

        Falls back gracefully: if the underlying ``edge-tts`` install
        doesn't surface boundary events, ``word_boundaries`` is empty and
        callers should use :func:`subtitles.fallback_captions_from_text`.
        """
        if not text.strip():
            raise ValueError("TTS text must be non-empty")
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        boundaries = asyncio.run(
            self._run_with_timing(text=text, output_path=output_path, voice=voice)
        )
        duration = _probe_mp3_duration(output_path)
        return TTSResult(
            audio_path=output_path,
            duration_seconds=duration,
            voice=voice,
            engine=self.name,
            word_boundaries=boundaries,
        )

    async def _run(self, *, text: str, output_path: Path, voice: str) -> None:
        # Imported lazily so unit tests that monkey-patch the adapter don't
        # require ``edge-tts`` to be installed in CI minimal images.
        import edge_tts

        communicate = edge_tts.Communicate(
            text=text,
            voice=voice,
            rate=self.rate,
            volume=self.volume,
        )
        await communicate.save(str(output_path))

    async def _run_with_timing(
        self, *, text: str, output_path: Path, voice: str
    ) -> list[WordBoundary]:
        import edge_tts

        communicate = edge_tts.Communicate(
            text=text,
            voice=voice,
            rate=self.rate,
            volume=self.volume,
        )
        boundaries: list[WordBoundary] = []
        with output_path.open("wb") as fh:
            async for chunk in communicate.stream():
                kind = chunk.get("type")
                if kind == "audio":
                    fh.write(chunk.get("data") or b"")
                elif kind == "WordBoundary":
                    boundaries.append(WordBoundary.from_edge_tts(chunk))
        return boundaries


def _probe_mp3_duration(path: Path) -> float:
    """Best-effort duration probe for an MP3 file.

    Returns 0.0 if no probe library is available (callers should treat 0.0
    as "unknown"). Avoids hard dependency on ffmpeg / mutagen for tests.
    """
    try:
        from mutagen.mp3 import MP3  # type: ignore[import-untyped]

        return float(MP3(str(path)).info.length)
    except Exception:
        return 0.0


def synthesize(text: str, *, output_path: Path, config: TTSConfig | None = None) -> TTSResult:
    """High-level convenience: read engine + voice from :class:`TTSConfig`."""
    cfg = config or TTSConfig()
    if cfg.engine == "edge-tts":
        adapter = EdgeTTSAdapter(rate=cfg.rate, volume=cfg.volume)
    else:
        raise NotImplementedError(
            f"TTS engine {cfg.engine!r} is not yet wired (only edge-tts is in PR-A1)."
        )
    return adapter.synthesize(text, output_path=output_path, voice=cfg.voice)
