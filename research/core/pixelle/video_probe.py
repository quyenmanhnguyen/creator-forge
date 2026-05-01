"""ffprobe-based validation for video/mp4 outputs (PR-20E).

Counterpart to ``desktop/dist/video_validation_helpers.js``. The
``/producer/short`` route uses :func:`validate_video_output` to (a)
gate ``video_scene_assets[]`` inputs before they reach
:func:`research.core.pixelle.composer.make_short` and (b) verify the
final ``short.mp4`` after compose finishes — the previous contract of
``mp4_path.exists()`` accepted a 0-byte stub if moviepy crashed
mid-write.

The helper degrades gracefully when ffprobe isn't on PATH: it falls
back to ``exists + size >= min_bytes`` and surfaces
``ffprobe_available=False`` so the route can warn the user. We never
raise from validate — every failure mode is a structured result so the
calling route can append a warning + downgrade to ``mp4_path=""`` while
still returning the audio/srt artifacts the user already paid for.

Tests live in ``research/tests/test_video_probe.py`` and stub
``subprocess.run`` to avoid requiring ffprobe in CI.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Aligned with desktop/dist/video_validation_helpers.js so the two
# halves of the pipeline (Electron download → bridge → composer) agree
# on what "usable" means.
MIN_USABLE_VIDEO_BYTES = 10_000
MIN_FINAL_MP4_BYTES = 10_000
MIN_DURATION_SEC = 0.2
FFPROBE_TIMEOUT_SEC = 15


@dataclass
class VideoProbeResult:
    """Structured probe result; mirrors the JS helper's return shape.

    ``duration_sec`` is the **container** duration (``format.duration``),
    which equals the longest stream — typically the visual track but it
    can be the soft-subtitle track when the SRT extends past the video
    (PR-31 / PR-32). ``video_stream_duration_sec`` is the v:0 stream's
    own ``duration`` field; callers that care about *visual* length
    (e.g. ``/producer/assemble``'s response) should prefer that and only
    fall back to the container duration if it is unavailable.
    """

    exists: bool = False
    size: int = 0
    ffprobe_available: bool = False
    duration_sec: float | None = None
    video_stream_duration_sec: float | None = None
    has_video_stream: bool | None = None
    width: int | None = None
    height: int | None = None
    codec: str | None = None
    reason: str | None = None


@dataclass
class VideoValidateResult(VideoProbeResult):
    """Probe + a boolean ``ok`` decision plus the threshold reason."""

    ok: bool = False


def _resolve_ffprobe() -> str | None:
    """Return an ffprobe path or ``None`` when none is available.

    Order: ``$FFPROBE_PATH`` → ``shutil.which('ffprobe')``. We don't
    sniff bundled Windows-only locations here because the sidecar runs
    on the user's Python (or the bundled CPython on Win) and ffprobe,
    when bundled, lives next to ffmpeg on PATH for both halves.
    """
    env = os.environ.get("FFPROBE_PATH")
    if env and Path(env).exists():
        return env
    found = shutil.which("ffprobe")
    return found  # may be None — caller surfaces the fallback warning


def _run_ffprobe(file_path: Path, runner=None) -> tuple[bool, int, str, str]:
    """Run ffprobe on ``file_path`` and return ``(available, code, stdout, stderr)``.

    ``runner`` is an injection seam for tests — it must accept the same
    args/kwargs as ``subprocess.run`` and return a CompletedProcess-like
    object with ``.returncode``, ``.stdout``, ``.stderr``. Production
    code path uses ``subprocess.run`` directly.
    """
    binary = _resolve_ffprobe()
    if not binary:
        return False, -1, "", "ffprobe not on PATH and FFPROBE_PATH not set"
    cmd = [
        binary,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(file_path),
    ]
    run = runner or subprocess.run
    try:
        proc = run(
            cmd,
            capture_output=True,
            text=True,
            timeout=FFPROBE_TIMEOUT_SEC,
            check=False,
        )
    except FileNotFoundError as exc:
        return False, -1, "", f"ffprobe binary not executable: {exc}"
    except subprocess.TimeoutExpired:
        return True, -1, "", "ffprobe timed out"
    except Exception as exc:  # noqa: BLE001 — boundary catch for the sidecar.
        return True, -1, "", f"{type(exc).__name__}: {exc}"
    return True, int(proc.returncode), str(proc.stdout or ""), str(proc.stderr or "")


def probe_video_file(
    file_path: str | os.PathLike,
    *,
    runner=None,
    stat_fn=None,
) -> VideoProbeResult:
    """Probe ``file_path`` and return a structured result.

    Never raises. ``runner`` and ``stat_fn`` are test seams.
    """
    if not file_path:
        return VideoProbeResult(reason="empty file_path")
    p = Path(file_path).expanduser()
    statter = stat_fn or (lambda path: path.stat())
    try:
        st = statter(p)
        size = int(getattr(st, "st_size", 0))
        exists = True
    except FileNotFoundError:
        return VideoProbeResult(reason=f"file not on disk: {p}")
    except OSError as exc:
        return VideoProbeResult(reason=f"stat failed: {type(exc).__name__}: {exc}")

    available, code, stdout, stderr = _run_ffprobe(p, runner=runner)
    if not available:
        return VideoProbeResult(
            exists=exists,
            size=size,
            ffprobe_available=False,
            reason="ffprobe unavailable on this machine — fell back to exists+size check",
        )
    if code != 0 or not stdout:
        tail = " ".join((stderr or "").splitlines()[-3:]).strip()
        return VideoProbeResult(
            exists=exists,
            size=size,
            ffprobe_available=True,
            has_video_stream=False,
            reason=f"ffprobe rejected file (exit {code}): {tail or 'no stderr'}",
        )
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return VideoProbeResult(
            exists=exists,
            size=size,
            ffprobe_available=True,
            has_video_stream=False,
            reason=f"ffprobe stdout was not valid JSON: {exc}",
        )
    fmt = parsed.get("format") or {}
    streams = parsed.get("streams") or []
    video_stream = next(
        (s for s in streams if isinstance(s, dict) and s.get("codec_type") == "video"),
        None,
    )
    def _safe_float(val):
        try:
            return float(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    container_duration = _safe_float(fmt.get("duration"))
    video_duration = _safe_float((video_stream or {}).get("duration"))

    # Container duration is reported as the legacy ``duration_sec`` for
    # backwards compatibility with /producer/short callers. When it's
    # missing (some encoders skip ``format.duration``), fall back to the
    # video stream's own duration so the existing
    # ``duration_sec > MIN_DURATION_SEC`` validation still passes.
    duration: float | None = container_duration
    if duration is None:
        duration = video_duration

    def _safe_int(val):
        try:
            return int(val) if val is not None else None
        except (TypeError, ValueError):
            return None

    return VideoProbeResult(
        exists=exists,
        size=size,
        ffprobe_available=True,
        duration_sec=duration,
        video_stream_duration_sec=video_duration,
        has_video_stream=bool(video_stream),
        width=_safe_int((video_stream or {}).get("width")),
        height=_safe_int((video_stream or {}).get("height")),
        codec=(video_stream or {}).get("codec_name") or None,
    )


def validate_video_output(
    file_path: str | os.PathLike,
    *,
    min_bytes: int = MIN_USABLE_VIDEO_BYTES,
    min_duration_sec: float = MIN_DURATION_SEC,
    runner=None,
    stat_fn=None,
) -> VideoValidateResult:
    """Validate ``file_path`` against the project's mp4 policy.

    Policy mirrors :func:`validateVideoOutput` in the JS helper:

      - exists + size ≥ ``min_bytes`` always.
      - When ffprobe ran: ``has_video_stream is True`` and
        ``duration_sec > min_duration_sec``.
      - When ffprobe is unavailable: soft-pass on size only with
        ``reason`` set so the caller can warn.
    """
    probe = probe_video_file(file_path, runner=runner, stat_fn=stat_fn)
    if not probe.exists:
        return VideoValidateResult(
            ok=False,
            exists=probe.exists,
            size=probe.size,
            ffprobe_available=probe.ffprobe_available,
            duration_sec=probe.duration_sec,
            video_stream_duration_sec=probe.video_stream_duration_sec,
            has_video_stream=probe.has_video_stream,
            width=probe.width,
            height=probe.height,
            codec=probe.codec,
            reason=probe.reason or "file not on disk",
        )
    if probe.size < min_bytes:
        return VideoValidateResult(
            ok=False,
            exists=True,
            size=probe.size,
            ffprobe_available=probe.ffprobe_available,
            duration_sec=probe.duration_sec,
            video_stream_duration_sec=probe.video_stream_duration_sec,
            has_video_stream=probe.has_video_stream,
            width=probe.width,
            height=probe.height,
            codec=probe.codec,
            reason=(
                f"file is suspiciously small ({probe.size} < {min_bytes} bytes — "
                "likely truncated download)"
            ),
        )
    if probe.ffprobe_available:
        if not probe.has_video_stream:
            return VideoValidateResult(
                ok=False,
                exists=True,
                size=probe.size,
                ffprobe_available=True,
                duration_sec=probe.duration_sec,
                video_stream_duration_sec=probe.video_stream_duration_sec,
                has_video_stream=probe.has_video_stream,
                width=probe.width,
                height=probe.height,
                codec=probe.codec,
                reason=probe.reason or "no video stream detected by ffprobe",
            )
        if not (probe.duration_sec is not None and probe.duration_sec > min_duration_sec):
            dur_repr = (
                "unknown"
                if probe.duration_sec is None
                else f"{probe.duration_sec:.3f}s"
            )
            return VideoValidateResult(
                ok=False,
                exists=True,
                size=probe.size,
                ffprobe_available=True,
                duration_sec=probe.duration_sec,
                video_stream_duration_sec=probe.video_stream_duration_sec,
                has_video_stream=probe.has_video_stream,
                width=probe.width,
                height=probe.height,
                codec=probe.codec,
                reason=f"ffprobe reports duration {dur_repr} ≤ {min_duration_sec}s",
            )
        return VideoValidateResult(
            ok=True,
            exists=True,
            size=probe.size,
            ffprobe_available=True,
            duration_sec=probe.duration_sec,
            video_stream_duration_sec=probe.video_stream_duration_sec,
            has_video_stream=True,
            width=probe.width,
            height=probe.height,
            codec=probe.codec,
        )
    # ffprobe unavailable → soft-pass with reason kept for caller to log.
    return VideoValidateResult(
        ok=True,
        exists=True,
        size=probe.size,
        ffprobe_available=False,
        duration_sec=None,
        has_video_stream=None,
        width=None,
        height=None,
        codec=None,
        reason=probe.reason,
    )


__all__ = [
    "MIN_USABLE_VIDEO_BYTES",
    "MIN_FINAL_MP4_BYTES",
    "MIN_DURATION_SEC",
    "VideoProbeResult",
    "VideoValidateResult",
    "probe_video_file",
    "validate_video_output",
]
