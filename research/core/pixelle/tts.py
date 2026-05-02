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
            **_communicate_kwargs(
                edge_tts.Communicate,
                text=text,
                voice=voice,
                rate=self.rate,
                volume=self.volume,
            )
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


def _communicate_kwargs(
    communicate_cls: type, *, text: str, voice: str, rate: str, volume: str
) -> dict:
    """Build kwargs for ``edge_tts.Communicate`` requesting WordBoundary timing.

    edge-tts v7.0+ added a ``boundary`` parameter to ``Communicate`` that
    defaults to ``"SentenceBoundary"`` — meaning the WebSocket service
    only emits sentence-level chunks and our ``async for`` loop sees no
    ``WordBoundary`` events. v6.x emitted WordBoundary by default and
    has no ``boundary`` keyword.

    We reflect on the constructor signature so the same code path works
    on either major version.
    """
    import inspect

    kwargs: dict = {"text": text, "voice": voice, "rate": rate, "volume": volume}
    try:
        params = inspect.signature(communicate_cls).parameters
    except (TypeError, ValueError):
        params = {}
    if "boundary" in params:
        kwargs["boundary"] = "WordBoundary"
    return kwargs


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


def _probe_wav_duration(path: Path) -> float:
    """Best-effort duration probe for a WAV file using stdlib only."""
    try:
        import wave

        with wave.open(str(path), "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate() or 1
            return float(frames) / float(rate)
    except Exception:
        return 0.0


class PiperTTSAdapter:
    """Local Piper TTS adapter (https://github.com/rhasspy/piper).

    Piper is a small (~25MB per voice), CPU-only neural TTS. Compared to
    Edge-TTS it is fully offline and ships first-class Vietnamese voices,
    at the cost of slightly more robotic output. We treat the
    ``piper-tts`` PyPI package (and its bundled binary) as optional —
    callers that don't have it installed get a ``RuntimeError`` with a
    pointer to the install command, NOT an ``ImportError`` at module
    import time. This keeps the Producer page importable on machines
    without Piper.

    Output format: WAV (Piper's native). The composer happily ingests
    WAV + falls back to a duration of ``0.0`` if the probe fails. We do
    NOT bundle voices — the user is expected to download ``.onnx`` +
    ``.onnx.json`` files and pass an absolute ``voice`` path. The voice
    short-name from the UI is mapped to a path via
    :func:`resolve_piper_voice_path` below.
    """

    name = "piper-tts"

    def __init__(
        self,
        *,
        voices_dir: Path | None = None,
        binary_path: str | None = None,
    ) -> None:
        self.voices_dir = Path(voices_dir) if voices_dir is not None else None
        self.binary_path = binary_path  # explicit override; else "piper" on PATH

    def synthesize(self, text: str, *, output_path: Path, voice: str) -> TTSResult:
        if not text.strip():
            raise ValueError("TTS text must be non-empty")
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        wav_path = output_path.with_suffix(".wav")
        voice_path = resolve_piper_voice_path(voice, voices_dir=self.voices_dir)
        self._run_piper(text=text, output_path=wav_path, voice_path=voice_path)
        duration = _probe_wav_duration(wav_path)
        return TTSResult(
            audio_path=wav_path,
            duration_seconds=duration,
            voice=voice,
            engine=self.name,
        )

    def synthesize_with_timing(
        self, text: str, *, output_path: Path, voice: str
    ) -> TTSResult:
        # Piper does not surface word boundaries — fall back to the
        # plain synthesizer; callers detect the empty word_boundaries
        # list and use ``subtitles.fallback_captions_from_text``.
        return self.synthesize(text=text, output_path=output_path, voice=voice)

    def _run_piper(self, *, text: str, output_path: Path, voice_path: Path) -> None:
        # Lazy import + lazy subprocess so unit tests can monkey-patch.
        import shutil
        import subprocess

        binary = self.binary_path or shutil.which("piper")
        if not binary:
            raise RuntimeError(
                "Piper binary not on PATH. Install with `pip install piper-tts` "
                "or download a release from https://github.com/rhasspy/piper "
                "and re-run with PATH including the `piper` executable."
            )
        # Piper accepts text on stdin and writes WAV to --output_file.
        cmd = [
            binary,
            "--model",
            str(voice_path),
            "--output_file",
            str(output_path),
        ]
        proc = subprocess.run(
            cmd,
            input=text.encode("utf-8"),
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            stderr = proc.stderr.decode("utf-8", "replace").strip()
            raise RuntimeError(
                f"piper exited with code {proc.returncode}: {stderr or '<no stderr>'}"
            )


def resolve_piper_voice_path(
    voice: str, *, voices_dir: Path | None = None
) -> Path:
    """Resolve a Piper voice short-name (or path) to an ``.onnx`` model.

    Accepted forms:

    - Absolute path to the ``.onnx`` model file → returned verbatim.
    - Short name like ``vi_VN-vais1000-medium`` → looked up under
      ``voices_dir`` (default: ``~/.creator-forge/piper-voices/``) as
      ``<voices_dir>/<short>.onnx``.

    Raises :class:`FileNotFoundError` if no matching ``.onnx`` exists —
    we deliberately do NOT auto-download (network access in tests + the
    Devin VM is unreliable; the desktop app downloads voices through a
    separate, user-driven flow).
    """
    p = Path(voice).expanduser()
    if p.is_absolute() and p.suffix == ".onnx" and p.exists():
        return p
    base = (
        Path(voices_dir).expanduser()
        if voices_dir is not None
        else Path.home() / ".creator-forge" / "piper-voices"
    )
    candidate = base / f"{voice}.onnx"
    if candidate.exists():
        return candidate
    raise FileNotFoundError(
        f"Piper voice '{voice}' not found at {candidate}. "
        "Download from https://huggingface.co/rhasspy/piper-voices and "
        f"place {voice}.onnx (and matching .onnx.json) under {base}/."
    )


# ---------------------------------------------------------------------------
# Provider registry / factory
# ---------------------------------------------------------------------------


KNOWN_TTS_PROVIDERS: tuple[str, ...] = ("edge-tts", "piper-tts")
DEFAULT_TTS_PROVIDER: str = "edge-tts"


def make_tts_adapter(provider: str | None) -> TTSAdapter:
    """Instantiate the requested TTS adapter, falling back to edge-tts.

    Unknown / empty providers map to :data:`DEFAULT_TTS_PROVIDER`. The
    Producer route uses this factory so an HTTP request body can carry
    a ``tts_provider`` string and the rest of the pipeline doesn't have
    to care which engine ran.
    """
    key = (provider or "").strip().lower() or DEFAULT_TTS_PROVIDER
    if key == "edge-tts":
        return EdgeTTSAdapter()
    if key == "piper-tts":
        return PiperTTSAdapter()
    # Unknown provider id — fall back to default rather than 4xx; UI
    # validation should catch this earlier and show a friendlier error.
    return EdgeTTSAdapter()


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
