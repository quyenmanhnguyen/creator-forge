"""Text-to-speech adapters for the Pixelle pipeline.

The :class:`TTSAdapter` protocol is the single seam used by the Producer
page. Three engines are wired today:

- ``edge-tts``  — Microsoft Edge TTS (free, online, no key).
- ``piper-tts`` — Piper neural TTS (free, offline, ~25 MB / voice).
- ``elevenlabs`` — ElevenLabs hosted TTS (paid, ``ELEVENLABS_API_KEY``
  env var). Highest perceived quality + native multilingual support
  (incl. Vietnamese) via the ``eleven_multilingual_v2`` model.

IndexTTS / ChatTTS / Kokoro can be added later by implementing the same
protocol — pages need not change.

Each adapter exposes two flavours:

- :meth:`synthesize` — fire-and-forget, just writes the audio file.
- :meth:`synthesize_with_timing` — also captures per-word timing
  (``WordBoundary`` events) so the subtitle module can build SRT without
  a separate alignment pass.
"""
from __future__ import annotations

import asyncio
import base64
import os
import re
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

    HF-13a — try mutagen first (cheapest, header-only) then fall back to
    ``ffprobe``. The mutagen-only path silently returned 0.0 in fresh
    environments where mutagen wasn't pinned, which broke per-scene
    caption time-shifting and made every scene's subtitles render
    starting at 00:00:00.
    """
    try:
        from mutagen.mp3 import MP3  # type: ignore[import-untyped]

        return float(MP3(str(path)).info.length)
    except Exception:
        pass

    # ffprobe fallback. ``ffprobe`` ships with ffmpeg which is already a
    # hard dependency for the renderer, so this path is reliable in
    # production. Tests stub ``_probe_mp3_duration`` directly so they
    # don't trip ffprobe.
    try:
        import shutil
        import subprocess

        ffprobe = shutil.which("ffprobe")
        if not ffprobe:
            return 0.0
        proc = subprocess.run(  # noqa: S603 — controlled cmd, no shell=True.
            [
                ffprobe,
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=15.0,
            check=False,
        )
        if proc.returncode != 0:
            return 0.0
        return float((proc.stdout or "0").strip() or 0)
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


ELEVENLABS_API_BASE = "https://api.elevenlabs.io"
ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2"
ELEVENLABS_DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"
ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY"


class ElevenLabsAdapter:
    """ElevenLabs hosted TTS adapter (https://elevenlabs.io).

    Uses the ``eleven_multilingual_v2`` model by default which speaks
    EN/JA/KO/ZH/ES/FR/DE/PT/HI/PL/IT/AR/RU/TR/UK/VI/ID/TH/ML/CS/SV/RO
    natively, so the same curated voice list works across every locale
    we expose in the Producer page picker. The ``voice`` argument
    passed to :meth:`synthesize` / :meth:`synthesize_with_timing` is
    the ElevenLabs voice id (e.g. ``"21m00Tcm4TlvDq8ikWAM"`` for
    Rachel) — :mod:`core.pixelle.voices` exposes a curated set whose
    ``short_name`` is the raw id so the renderer's voice dropdown can
    pass it straight through.

    Authentication: reads ``ELEVENLABS_API_KEY`` from the process env
    at synth time. Missing key raises :class:`RuntimeError` with a
    pointer; the route layer surfaces this as a warning rather than
    500-ing the whole call (mirrors ``DEEPSEEK_API_KEY`` handling
    elsewhere in the codebase).

    Output format: mp3 at 44.1 kHz / 128 kbps. Word boundaries come
    from the ``with-timestamps`` endpoint's ``normalized_alignment``
    payload (per-character start/end times) — we group consecutive
    non-whitespace characters into words so the assembled SRT lines
    up with what listeners actually hear.

    The ``stability`` / ``similarity_boost`` / ``style`` fields are
    settable on the adapter for callers that want to tweak the
    voice settings without changing the public protocol; they map
    1-to-1 onto the API's ``voice_settings`` block. Defaults match
    ElevenLabs' "Default" preset.
    """

    name = "elevenlabs"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model_id: str = ELEVENLABS_DEFAULT_MODEL,
        output_format: str = ELEVENLABS_DEFAULT_OUTPUT_FORMAT,
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        style: float = 0.0,
        use_speaker_boost: bool = True,
        timeout_s: float = 60.0,
    ) -> None:
        # Captured at construction so tests can inject a fake key
        # without touching os.environ; the route layer reads the env
        # var fresh on each request and passes it in.
        self._api_key = api_key
        self.model_id = model_id
        self.output_format = output_format
        self.stability = float(stability)
        self.similarity_boost = float(similarity_boost)
        self.style = float(style)
        self.use_speaker_boost = bool(use_speaker_boost)
        self.timeout_s = float(timeout_s)

    @property
    def api_key(self) -> str:
        key = (self._api_key or os.environ.get(ELEVENLABS_API_KEY_ENV) or "").strip()
        if not key:
            raise RuntimeError(
                f"{ELEVENLABS_API_KEY_ENV} not set. Get a key from "
                "https://elevenlabs.io/app/settings/api-keys and either "
                "store it via the desktop app's Secrets panel or export "
                f"{ELEVENLABS_API_KEY_ENV}=... in the sidecar environment."
            )
        return key

    def synthesize(self, text: str, *, output_path: Path, voice: str) -> TTSResult:
        if not text.strip():
            raise ValueError("TTS text must be non-empty")
        if not (voice or "").strip():
            raise ValueError("ElevenLabs voice id must be non-empty")
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self._post_audio_to(output_path=output_path, text=text, voice=voice)
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
        if not text.strip():
            raise ValueError("TTS text must be non-empty")
        if not (voice or "").strip():
            raise ValueError("ElevenLabs voice id must be non-empty")
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        boundaries = self._post_audio_with_timestamps_to(
            output_path=output_path, text=text, voice=voice
        )
        duration = _probe_mp3_duration(output_path)
        return TTSResult(
            audio_path=output_path,
            duration_seconds=duration,
            voice=voice,
            engine=self.name,
            word_boundaries=boundaries,
        )

    # ------------------------------------------------------------------
    # HTTP plumbing — kept on the instance so tests can monkey-patch
    # ``requests.post`` (or swap the whole helper) without async fixtures.
    # ------------------------------------------------------------------

    def _post_audio_to(self, *, output_path: Path, text: str, voice: str) -> None:
        import requests

        url = f"{ELEVENLABS_API_BASE}/v1/text-to-speech/{voice}"
        params = {"output_format": self.output_format}
        resp = requests.post(
            url,
            params=params,
            headers={
                "xi-api-key": self.api_key,
                "accept": "audio/mpeg",
                "content-type": "application/json",
            },
            json=self._payload(text),
            timeout=self.timeout_s,
        )
        if resp.status_code >= 400:
            raise RuntimeError(_elevenlabs_error_message(resp))
        with output_path.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    fh.write(chunk)

    def _post_audio_with_timestamps_to(
        self, *, output_path: Path, text: str, voice: str
    ) -> list[WordBoundary]:
        import requests

        url = f"{ELEVENLABS_API_BASE}/v1/text-to-speech/{voice}/with-timestamps"
        params = {"output_format": self.output_format}
        resp = requests.post(
            url,
            params=params,
            headers={
                "xi-api-key": self.api_key,
                "accept": "application/json",
                "content-type": "application/json",
            },
            json=self._payload(text),
            timeout=self.timeout_s,
        )
        if resp.status_code >= 400:
            raise RuntimeError(_elevenlabs_error_message(resp))
        body = resp.json()
        audio_b64 = body.get("audio_base64") or ""
        if not audio_b64:
            raise RuntimeError(
                "ElevenLabs with-timestamps response missing 'audio_base64'"
            )
        output_path.write_bytes(base64.b64decode(audio_b64))
        alignment = body.get("normalized_alignment") or body.get("alignment") or {}
        return _elevenlabs_alignment_to_word_boundaries(alignment)

    def _payload(self, text: str) -> dict:
        return {
            "text": text,
            "model_id": self.model_id,
            "voice_settings": {
                "stability": self.stability,
                "similarity_boost": self.similarity_boost,
                "style": self.style,
                "use_speaker_boost": self.use_speaker_boost,
            },
        }


def _elevenlabs_error_message(resp) -> str:
    """Best-effort extraction of a human-readable error from an
    ElevenLabs error response. Falls back to status + body snippet
    when the JSON shape doesn't match the documented contract."""
    try:
        body = resp.json()
    except Exception:
        body = None
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, dict):
            msg = detail.get("message") or detail.get("status")
            if msg:
                return f"ElevenLabs {resp.status_code}: {msg}"
        if isinstance(detail, str):
            return f"ElevenLabs {resp.status_code}: {detail}"
    snippet = (resp.text or "")[:200].strip()
    return f"ElevenLabs HTTP {resp.status_code}: {snippet or '<no body>'}"


# ---------------------------------------------------------------------------
# Fatal-error detection + edge-tts fallback voice mapping
# ---------------------------------------------------------------------------
#
# When the ElevenLabs API returns 401 ("Unusual activity detected. Free Tier
# usage disabled"), 403 (forbidden), or any of the documented quota / voice
# errors, retrying the same request will keep failing — the user's IP / key
# is the problem, not the request shape. We surface a typed predicate so the
# Producer route can fall back to ``edge-tts`` automatically and still emit
# *some* audio rather than an empty response.

# Regex to extract the HTTP status from ``_elevenlabs_error_message`` output.
# Matches both ``"ElevenLabs 401: ..."`` and ``"ElevenLabs HTTP 401: ..."``.
_ELEVENLABS_STATUS_RE = re.compile(
    r"elevenlabs(?:\s+http)?\s+(\d{3})\s*:",
    re.IGNORECASE,
)


# Recoverable HTTP status codes — retrying the same request against the
# same key/IP can succeed (rate-limit windows reopen, transient 5xx
# resolves). We do NOT swap to edge-tts on these so the user keeps
# their selected paid provider.
ELEVENLABS_RECOVERABLE_STATUSES: frozenset[int] = frozenset({429, 500, 502, 503, 504})


# Legacy/non-HTTP fatal fragments — kept so non-HTTP exceptions (e.g. the
# ``RuntimeError("ELEVENLABS_API_KEY not set")`` raised by the api_key
# property *before* any HTTP call) still trip the swap. HTTP errors take
# the status-code path above and don't depend on this list.
ELEVENLABS_FATAL_FRAGMENTS: tuple[str, ...] = (
    "elevenlabs_api_key not set",
    "missing_api_key",
    "invalid_api_key",
    "unauthorized",
    "free tier usage disabled",
    "unusual activity",
    "detected_unusual_activity",
    "forbidden",
    "voice_not_found",
    "voice id not found",
    "voice with voice_id",
    "model_not_found",
    "model with model_id",
    "was not found",
    "quota_exceeded",
    "quota exceeded",
    "tier_quota_exceeded",
    "max_character_limit_exceeded",
    "concurrent_requests_exceeded",
    "too_many_concurrent_requests",
)


def is_elevenlabs_fatal_error(exc: BaseException | str) -> bool:
    """Return True when an ElevenLabs error is unrecoverable for *this* request.

    "Fatal" means retrying the same call against the same key/IP/voice will
    keep failing — the safe move is to swap to a different provider rather
    than burn N retries.

    HF-13a — the predicate is now **status-code driven** rather than
    message-text driven. ``_elevenlabs_error_message`` always emits
    ``"ElevenLabs <status>: <message>"`` (or ``"ElevenLabs HTTP <status>: ..."``
    for non-JSON bodies), so we extract the numeric status and treat any
    4xx **except 429** as fatal. This catches the production 404 voice-not-found
    case (``"ElevenLabs 404: A voice with voice_id 'X' was not found."``) that
    the previous text-fragment matcher missed because the literal substring
    ``voice_not_found`` never appears in the upstream message.

    For non-HTTP exceptions (e.g. ``RuntimeError("ELEVENLABS_API_KEY not set")``
    raised before any HTTP call) we fall back to the legacy fragment list.

    Accepts either an exception or a raw message string so callers can
    feed a captured warning line back through the same predicate.
    """
    if exc is None:
        return False
    msg = str(exc)
    if not msg:
        return False
    msg_lower = msg.lower()
    if (
        "elevenlabs" not in msg_lower
        and "eleven_labs" not in msg_lower
    ):
        return False

    # HTTP status path — the most reliable signal because the route layer
    # always emits "ElevenLabs <status>: <message>".
    match = _ELEVENLABS_STATUS_RE.search(msg_lower)
    if match is not None:
        try:
            status = int(match.group(1))
        except ValueError:
            status = 0
        if 400 <= status < 500 and status not in ELEVENLABS_RECOVERABLE_STATUSES:
            return True
        # 5xx, 429, anything else → recoverable, do not swap.
        return False

    # Non-HTTP path — pre-flight RuntimeError or vendor SDK errors that
    # don't carry the "ElevenLabs <status>:" prefix.
    return any(frag in msg_lower for frag in ELEVENLABS_FATAL_FRAGMENTS)


# Map an ElevenLabs voice id to an edge-tts voice short name with the same
# locale + gender so the fallback narration still sounds reasonable. Keep
# this in sync with the curated list in :mod:`core.pixelle.voices`. Falls
# back to ``en-US-AriaNeural`` (calm female en-US) for unknown ids.
#
# HF-13a — voices in this map MUST be currently serving on the public
# edge-tts speech-platform endpoint. ``en-US-DavisNeural``,
# ``en-US-SaraNeural`` and ``en-US-AmberNeural`` were dropped from this
# map after the bing speech-platform stopped returning audio for them
# (``edge_tts.exceptions.NoAudioReceived``), which silently broke the
# fallback for ElevenLabs Adam / Josh / Domi / Charlotte. Verified
# working voices: Aria, Guy, Jenny, Michelle, Christopher, Eric, Roger,
# Steffan, Ana, GB-Ryan, GB-Libby.
ELEVENLABS_TO_EDGE_VOICE_MAP: dict[str, str] = {
    # Rachel · F · en-US (calm, narrator)
    "21m00Tcm4TlvDq8ikWAM": "en-US-AriaNeural",
    # Antoni · M · en-US (well-rounded)
    "ErXwobaYiN019PkySvjV": "en-US-GuyNeural",
    # Sarah · F · en-US (soft, news)
    "EXAVITQu4vr4xnSDxMaL": "en-US-JennyNeural",
    # Domi · F · en-US (confident) — was SaraNeural (dead).
    "AZnzlk1HvdrTNbZXh": "en-US-MichelleNeural",
    # Adam · M · en-US (deep, narrator) — was DavisNeural (dead).
    "pNInz6obpgDQGBFOQs8c": "en-US-EricNeural",
    # Arnold · M · en-US (crisp)
    "VR6AewLTigWG4xSOukaG": "en-US-GuyNeural",
    # Charlotte · F · en-US (warm) — was AmberNeural (dead).
    "XB0fDUnXU5powFXDhCwa": "en-US-AriaNeural",
    # Charlie · M · en-AU (casual)
    "IKne3meq5aSn9XLyUdCD": "en-GB-RyanNeural",
    # Matilda · F · en-US (warm)
    "XrExE9yKIg1WjnnlVkGX": "en-US-AriaNeural",
    # Josh · M · en-US (deep) — was DavisNeural (dead).
    "TxGEqnHWrfWFTfGW9XjX": "en-US-ChristopherNeural",
    # Dorothy · F · en-GB (pleasant)
    "ThT5KcBeYPX3keUQqHPh": "en-GB-LibbyNeural",
    # Grace · F · en-US (gentle)
    "oWAxZDx7w5VEj9dCyTzz": "en-US-JennyNeural",
}

DEFAULT_EDGE_FALLBACK_VOICE = "en-US-AriaNeural"


def edge_voice_for_elevenlabs(elevenlabs_voice_id: str | None) -> str:
    """Return the edge-tts short_name we should fall back to for *id*.

    Unknown / blank ids resolve to :data:`DEFAULT_EDGE_FALLBACK_VOICE`. The
    route layer uses this when ElevenLabs hits a fatal error so the
    swap-in adapter speaks at roughly the same locale + gender the user
    originally selected.
    """
    key = (elevenlabs_voice_id or "").strip()
    if not key:
        return DEFAULT_EDGE_FALLBACK_VOICE
    return ELEVENLABS_TO_EDGE_VOICE_MAP.get(key, DEFAULT_EDGE_FALLBACK_VOICE)


def _elevenlabs_alignment_to_word_boundaries(alignment: dict) -> list[WordBoundary]:
    """Convert ElevenLabs' per-character alignment payload to the
    pipeline's :class:`WordBoundary` list.

    The ``with-timestamps`` endpoint returns three parallel arrays:

    * ``characters`` — list of single-character strings.
    * ``character_start_times_seconds`` — float seconds since audio
      start, one per character.
    * ``character_end_times_seconds`` — same length, end times.

    We group consecutive non-whitespace characters into words. The
    word's ``start_s`` is the first character's start time; its
    ``end_s`` is the last character's end time. Empty / whitespace-only
    runs are dropped. Returns an empty list when the payload is
    missing or malformed (callers fall back to
    :func:`subtitles.fallback_captions_from_text`).
    """
    chars = alignment.get("characters")
    starts = alignment.get("character_start_times_seconds")
    ends = alignment.get("character_end_times_seconds")
    if (
        not isinstance(chars, list)
        or not isinstance(starts, list)
        or not isinstance(ends, list)
    ):
        return []
    n = min(len(chars), len(starts), len(ends))
    if n == 0:
        return []

    words: list[WordBoundary] = []
    buf: list[str] = []
    word_start: float | None = None
    last_end: float = 0.0
    for i in range(n):
        ch = chars[i] if isinstance(chars[i], str) else ""
        try:
            s = float(starts[i])
            e = float(ends[i])
        except (TypeError, ValueError):
            continue
        if ch.strip():
            if word_start is None:
                word_start = s
            buf.append(ch)
            last_end = e
            continue
        # Whitespace / control char → flush current word.
        if buf and word_start is not None:
            words.append(
                WordBoundary(
                    start_s=float(word_start),
                    end_s=float(last_end),
                    text="".join(buf),
                )
            )
        buf = []
        word_start = None
    if buf and word_start is not None:
        words.append(
            WordBoundary(
                start_s=float(word_start),
                end_s=float(last_end),
                text="".join(buf),
            )
        )
    return words


# ---------------------------------------------------------------------------
# Provider registry / factory
# ---------------------------------------------------------------------------


KNOWN_TTS_PROVIDERS: tuple[str, ...] = ("edge-tts", "piper-tts", "elevenlabs")
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
    if key == "elevenlabs":
        return ElevenLabsAdapter()
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
