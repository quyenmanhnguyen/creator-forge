"""Final-MP4 assembly: concat scene videos + (re)attach narration audio.

Counterpart to :mod:`research.core.pixelle.composer` for the
voiceover-first workflow introduced in PR-30. Once the user has a
narration MP3 (from ``/producer/audio``) and a stack of per-scene MP4s
(from the desktop's I2V/T2V batch flow), this module stitches them into
a single 9:16 MP4 in one ffmpeg invocation:

1. **Concat demuxer** reads the scene videos in order.
2. **Re-encode** with libx264 + yuv420p so codec / SAR / framerate
   mismatches between scenes don't break the concat (the same
   normalisation strategy the desktop's existing ``video:merge`` IPC
   uses, mirrored here so the two halves stay consistent).
3. **Audio replace** maps the narration MP3 in as the only audio
   track. Scene videos may carry ambient/no audio; PR-31's contract is
   that the narration is the master.
4. **Captions** — three modes:

   - ``"soft"`` (default) attaches the SRT as a selectable
     ``mov_text`` subtitle track. Plays back in QuickTime / VLC /
     Chrome; ignored by platforms that don't render soft subs (some
     social uploads).
   - ``"none"`` ignores the SRT entirely.
   - ``"burn"`` (PR-32) renders the SRT pixels into the video stream
     via ffmpeg's ``subtitles`` filter so every player sees them. We
     stage the SRT as ``_subs.srt`` in ``output_dir`` and run ffmpeg
     with ``cwd=output_dir`` so the filter resolves it by relative
     name — sidesteps the Windows ``C:\\…`` path-colon escaping
     headache and means we don't have to special-case spaces or
     filter-graph metacharacters in user-supplied filenames.

5. **Trim policy** defaults to *video* — the output is exactly the
   summed scene durations; audio is cut to fit. ``trim_to="audio"``
   uses ``-shortest`` and lets the audio cap the output instead.

Robust failure: every error path returns an :class:`AssembleResult`
with ``final_path=""`` and a structured warning. The route layer
re-uses these warnings; nothing here raises.

Tests live in ``research/tests/test_assembler.py`` and stub
``subprocess.run`` to avoid requiring ffmpeg/ffprobe in CI.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Literal

from research.core.pixelle.video_probe import (
    MIN_FINAL_MP4_BYTES,
    MIN_USABLE_VIDEO_BYTES,
    probe_video_file,
    validate_video_output,
)

logger = logging.getLogger(__name__)


# ─── Constants ──────────────────────────────────────────────────────────────

# Same allow-list as desktop/electron/main.js → ipcMain.handle('video:merge').
# The two halves of the pipeline must agree on what counts as a video.
SUPPORTED_VIDEO_EXTS: frozenset[str] = frozenset({".mp4", ".mov", ".m4v", ".webm"})

# Audio extensions accepted as the narration track. mp3 is the
# /producer/audio default for edge-tts; wav comes from piper-tts.
SUPPORTED_AUDIO_EXTS: frozenset[str] = frozenset({".mp3", ".wav", ".m4a", ".aac"})

FFMPEG_TIMEOUT_SEC = 600  # 10 min — long enough for ~10 min of source

AudioMode = Literal["replace", "none"]
TrimMode = Literal["video", "audio"]
CaptionMode = Literal["soft", "none", "burn"]

# Filename used when staging the SRT for ``caption_mode="burn"``. Lives
# in ``output_dir`` next to ``final.mp4`` and is cleaned up after
# ffmpeg returns (best-effort). The ``_`` prefix matches the existing
# ``_concat_list.txt`` so a ``ls`` of the output dir cleanly groups the
# transient files.
BURN_SRT_STAGED_NAME = "_subs.srt"


# ─── Public result ──────────────────────────────────────────────────────────


@dataclass
class AssembleResult:
    """Structured outcome of :func:`assemble_final_mp4`.

    Mirrors the route response shape so the caller can ``model_dump()``
    without an adapter layer.
    """

    final_path: str = ""
    duration_s: float = 0.0
    scene_count: int = 0
    audio_attached: bool = False
    captions_attached: bool = False
    output_dir: str = ""
    warnings: list[str] = field(default_factory=list)


# ─── Helpers ────────────────────────────────────────────────────────────────


def _resolve_ffmpeg() -> str | None:
    """Return an ffmpeg path or ``None`` when none is available.

    Order matches :func:`research.core.pixelle.video_probe._resolve_ffprobe`:
    ``$FFMPEG_PATH`` then ``shutil.which('ffmpeg')``. The desktop's
    Electron main.js has its own resolver that also checks bundled
    locations; this module is sidecar-only so we don't replicate that.
    """
    env = os.environ.get("FFMPEG_PATH")
    if env and Path(env).exists():
        return env
    return shutil.which("ffmpeg")


def _concat_list_line(file_path: Path) -> str:
    """Format a single line for ffmpeg's concat demuxer list file.

    Matches the escaping rules in
    ``desktop/electron/main.js:concatListLine`` so a path that works in
    one half works in the other.
    """
    normalized = str(file_path).replace("\\", "/").replace("'", "'\\''")
    return f"file '{normalized}'"


def _write_concat_list(paths: Iterable[Path], list_path: Path) -> None:
    """Write a concat demuxer list file at ``list_path``.

    Caller is responsible for ``unlink`` on the file after ffmpeg
    consumes it. We always write UTF-8 with ``\n`` line endings — ffmpeg
    accepts both but the test fixture comparisons get easier if we
    normalise.
    """
    lines = [_concat_list_line(p) for p in paths]
    list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _sum_video_durations(
    paths: Iterable[Path],
    *,
    runner: Callable | None = None,
) -> tuple[float, list[str]]:
    """Probe each video and sum durations.

    Returns ``(total_seconds, warnings)``. A scene that fails to probe
    contributes ``0`` to the total and a warning entry — the caller
    decides whether to abort or continue.
    """
    total = 0.0
    warnings: list[str] = []
    for p in paths:
        result = probe_video_file(p, runner=runner)
        if result.duration_sec is None or result.duration_sec <= 0:
            warnings.append(
                f"Could not probe duration for {p} — fell back to 0s "
                f"(reason: {result.reason or 'unknown'})."
            )
            continue
        total += float(result.duration_sec)
    return total, warnings


def _validate_inputs(
    scene_videos: list[str],
    audio_path: str | None,
    srt_path: str | None,
) -> tuple[list[Path], Path | None, Path | None, list[str]]:
    """Resolve + check the input paths.

    Returns ``(resolved_scene_videos, audio, srt, warnings)``. Missing
    or wrong-extension scene videos drop out of the list and surface a
    warning; missing audio/srt downgrade to ``None`` (audio mute / no
    subs) with a warning.
    """
    warnings: list[str] = []
    resolved_scenes: list[Path] = []
    for raw in scene_videos:
        p = Path(str(raw)).expanduser()
        if not p.exists():
            warnings.append(f"Scene video not on disk, skipping: {p}")
            continue
        if p.suffix.lower() not in SUPPORTED_VIDEO_EXTS:
            warnings.append(
                f"Scene video has unsupported extension {p.suffix!r}, skipping: {p}"
            )
            continue
        try:
            size = p.stat().st_size
        except OSError as exc:
            warnings.append(f"Could not stat {p}: {exc}")
            continue
        if size < MIN_USABLE_VIDEO_BYTES:
            warnings.append(
                f"Scene video {p} is too small ({size}B < "
                f"{MIN_USABLE_VIDEO_BYTES}B), skipping."
            )
            continue
        resolved_scenes.append(p)

    audio: Path | None = None
    if audio_path:
        ap = Path(str(audio_path)).expanduser()
        if not ap.exists():
            warnings.append(f"audio_path not on disk, will render silent video: {ap}")
        elif ap.suffix.lower() not in SUPPORTED_AUDIO_EXTS:
            warnings.append(
                f"audio_path has unsupported extension {ap.suffix!r}, "
                f"will render silent video: {ap}"
            )
        else:
            audio = ap

    srt: Path | None = None
    if srt_path:
        sp = Path(str(srt_path)).expanduser()
        if not sp.exists():
            warnings.append(f"srt_path not on disk, no captions track: {sp}")
        elif sp.suffix.lower() != ".srt":
            warnings.append(
                f"srt_path has unsupported extension {sp.suffix!r}, "
                f"no captions track: {sp}"
            )
        else:
            srt = sp

    return resolved_scenes, audio, srt, warnings


def _build_ffmpeg_args(
    *,
    list_path: Path,
    output_path: Path,
    audio: Path | None,
    srt: Path | None,
    audio_mode: AudioMode,
    caption_mode: CaptionMode,
    trim_to: TrimMode,
    video_total_s: float,
    burn_srt_relname: str | None = None,
) -> list[str]:
    """Construct the single-pass ffmpeg command.

    Kept pure / no I/O so tests can assert on the argv shape.

    ``burn_srt_relname`` is the relative filename ffmpeg will see
    inside the working directory when ``caption_mode="burn"`` — the
    caller is responsible for staging the SRT there before invoking
    ffmpeg with that ``cwd``. This separation keeps the args builder
    pure (no copying).
    """
    args: list[str] = ["-y", "-fflags", "+genpts"]
    args += ["-f", "concat", "-safe", "0", "-i", str(list_path)]

    audio_input_idx: int | None = None
    srt_input_idx: int | None = None
    next_idx = 1

    use_audio = audio is not None and audio_mode == "replace"
    if use_audio:
        args += ["-i", str(audio)]
        audio_input_idx = next_idx
        next_idx += 1

    use_soft_subs = srt is not None and caption_mode == "soft"
    use_burn_subs = (
        srt is not None
        and caption_mode == "burn"
        and burn_srt_relname is not None
    )
    if use_soft_subs:
        args += ["-i", str(srt)]
        srt_input_idx = next_idx
        next_idx += 1

    # Map: video from concat (input 0), audio from narration if present,
    # soft subs from srt if present. Burn-in subs don't need a -map
    # entry — they're rendered into 0:v:0 by the filter graph.
    args += ["-map", "0:v:0"]
    if audio_input_idx is not None:
        args += ["-map", f"{audio_input_idx}:a:0"]
    elif audio_mode == "none":
        # Pull through original scene audio if available; ffmpeg's
        # concat demuxer tolerates per-input audio absence with ``a?``.
        args += ["-map", "0:a?"]
    if srt_input_idx is not None:
        args += ["-map", f"{srt_input_idx}:s:0"]

    # Re-encode video for codec/SAR/framerate consistency. Same
    # normalisation as the desktop video:merge handler. When burning
    # subs in we append the ``subtitles`` filter to the same chain so
    # ffmpeg only does one decode/encode pass.
    vf_chain = "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p"
    if use_burn_subs:
        # ``subtitles`` filter resolves the filename from cwd. The
        # caller stages the SRT as ``_subs.srt`` inside ``output_dir``
        # and runs ffmpeg with ``cwd=output_dir`` so this relative
        # filename works on every OS — no path-colon / quote / brace
        # escaping needed for user-supplied source paths.
        vf_chain += f",subtitles={burn_srt_relname}"
    args += [
        "-vf",
        vf_chain,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
    ]

    # Audio codec — aac always, even if we're passing through original
    # scene audio (some cameras output PCM/MP2 which mp4 doesn't take
    # without conversion).
    args += [
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "48000",
        "-ac", "2",
    ]

    if use_soft_subs:
        # mov_text is the only soft-sub codec that mp4 reliably plays
        # back across QuickTime / VLC / Chrome.
        args += ["-c:s", "mov_text"]

    # Trim policy.
    if trim_to == "audio" and use_audio:
        args += ["-shortest"]
    elif trim_to == "video" and video_total_s > 0 and use_audio:
        # Cap the output at the summed scene duration so a longer
        # narration doesn't extend the video with a frozen final frame.
        args += ["-t", f"{video_total_s:.3f}"]

    args += [
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        str(output_path),
    ]
    return args


def _run_ffmpeg(
    args: list[str],
    *,
    runner: Callable | None = None,
    cwd: Path | None = None,
) -> tuple[bool, int, str, str]:
    """Execute ffmpeg with the given args.

    ``runner`` is the test injection seam (mirror of
    :func:`video_probe._run_ffprobe`). ``cwd``, when provided, is
    forwarded to ``subprocess.run`` — used by ``caption_mode="burn"``
    so the ``subtitles`` filter resolves the staged ``_subs.srt`` by
    relative name. Returns ``(available, returncode, stdout, stderr)``.
    Never raises.
    """
    binary = _resolve_ffmpeg()
    if not binary:
        return False, -1, "", "ffmpeg not on PATH and FFMPEG_PATH not set"
    cmd = [binary, *args]
    run = runner or subprocess.run
    run_kwargs: dict = {
        "capture_output": True,
        "text": True,
        "timeout": FFMPEG_TIMEOUT_SEC,
        "check": False,
    }
    if cwd is not None:
        run_kwargs["cwd"] = str(cwd)
    try:
        proc = run(cmd, **run_kwargs)
    except FileNotFoundError as exc:
        return False, -1, "", f"ffmpeg binary not executable: {exc}"
    except subprocess.TimeoutExpired:
        return True, -1, "", "ffmpeg timed out"
    except Exception as exc:  # noqa: BLE001
        return True, -1, "", f"{type(exc).__name__}: {exc}"
    return True, int(proc.returncode), str(proc.stdout or ""), str(proc.stderr or "")


# ─── Public entry point ─────────────────────────────────────────────────────


def assemble_final_mp4(
    *,
    scene_videos: list[str],
    audio_path: str | None,
    srt_path: str | None,
    output_dir: Path,
    audio_mode: AudioMode = "replace",
    trim_to: TrimMode = "video",
    caption_mode: CaptionMode = "soft",
    runner: Callable | None = None,
) -> AssembleResult:
    """Concat scene videos, attach audio + soft subs, write ``final.mp4``.

    See module docstring for the contract. ``runner`` is injected into
    both ffprobe (via :func:`probe_video_file`) and ffmpeg, so a single
    test fixture can stub the whole stack.

    Returns an :class:`AssembleResult`. ``final_path`` is empty on any
    fatal error, with structured warnings explaining why.
    """
    warnings: list[str] = []

    if not scene_videos:
        # The route layer already rejects empty via Field(min_length=1),
        # but we double-check here so callers using the helper directly
        # get the same robust behaviour.
        warnings.append("scene_videos is empty — nothing to assemble.")
        return AssembleResult(
            output_dir=str(output_dir),
            warnings=warnings,
        )

    output_dir = Path(output_dir).expanduser()
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        warnings.append(f"Could not create output_dir {output_dir}: {exc}")
        return AssembleResult(
            output_dir=str(output_dir),
            warnings=warnings,
        )

    resolved_scenes, audio, srt, validation_warnings = _validate_inputs(
        scene_videos, audio_path, srt_path,
    )
    warnings.extend(validation_warnings)

    if not resolved_scenes:
        warnings.append(
            "No usable scene videos after validation — aborting before ffmpeg.",
        )
        return AssembleResult(
            output_dir=str(output_dir),
            warnings=warnings,
        )

    # Probe durations up-front so we can pass ``-t`` to ffmpeg when
    # ``trim_to=="video"``. Probing failures don't abort — we just lose
    # the trim cap and let ffmpeg's natural concat behaviour win.
    video_total_s, probe_warnings = _sum_video_durations(
        resolved_scenes, runner=runner,
    )
    warnings.extend(probe_warnings)

    list_path = output_dir / "_concat_list.txt"
    output_path = output_dir / "final.mp4"
    try:
        _write_concat_list(resolved_scenes, list_path)
    except OSError as exc:
        warnings.append(f"Could not write concat list: {exc}")
        return AssembleResult(
            output_dir=str(output_dir),
            warnings=warnings,
        )

    # Stage the SRT for burn-in (PR-32). When the user asked for burn
    # but the SRT can't be staged (read-only volume, source missing
    # mid-call) we fall back to soft subs and warn — same robust-
    # failure pattern the audio-not-on-disk path uses. Tracking
    # ``effective_caption_mode`` separately from the user's requested
    # ``caption_mode`` lets us reflect that fallback in the response's
    # ``captions_attached`` flag.
    effective_caption_mode: CaptionMode = caption_mode
    burn_srt_relname: str | None = None
    staged_srt_path: Path | None = None
    if caption_mode == "burn":
        if srt is None:
            warnings.append(
                "caption_mode='burn' but no usable srt_path — skipping captions."
            )
            effective_caption_mode = "none"
        else:
            try:
                staged_srt_path = output_dir / BURN_SRT_STAGED_NAME
                shutil.copyfile(str(srt), str(staged_srt_path))
                burn_srt_relname = BURN_SRT_STAGED_NAME
            except OSError as exc:
                warnings.append(
                    f"Could not stage srt for burn-in ({exc}); "
                    "falling back to soft subtitles."
                )
                effective_caption_mode = "soft"
                staged_srt_path = None
                burn_srt_relname = None

    args = _build_ffmpeg_args(
        list_path=list_path,
        output_path=output_path,
        audio=audio,
        srt=srt,
        audio_mode=audio_mode,
        caption_mode=effective_caption_mode,
        trim_to=trim_to,
        video_total_s=video_total_s,
        burn_srt_relname=burn_srt_relname,
    )

    # Burn-in needs cwd=output_dir so the ``subtitles`` filter
    # resolves the staged ``_subs.srt`` by relative name.
    ffmpeg_cwd = output_dir if effective_caption_mode == "burn" else None
    available, code, _stdout, stderr = _run_ffmpeg(
        args, runner=runner, cwd=ffmpeg_cwd,
    )

    # Best-effort cleanup of the concat list + the staged srt. Failures
    # here are non-fatal — both files are small and live next to the
    # output, and a stale ``_subs.srt`` is not user-visible (the prefix
    # ``_`` is the project's convention for transient files).
    try:
        list_path.unlink()
    except OSError:
        pass
    if staged_srt_path is not None:
        try:
            staged_srt_path.unlink()
        except OSError:
            pass

    if not available:
        warnings.append(
            "ffmpeg unavailable on this machine — install ffmpeg or set "
            "$FFMPEG_PATH. " + (stderr or "")
        )
        return AssembleResult(
            scene_count=len(resolved_scenes),
            output_dir=str(output_dir),
            warnings=warnings,
        )

    if code != 0:
        tail = " ".join((stderr or "").splitlines()[-3:]).strip()
        warnings.append(
            f"ffmpeg exited {code}: {tail or 'no stderr'}"
        )
        return AssembleResult(
            scene_count=len(resolved_scenes),
            output_dir=str(output_dir),
            warnings=warnings,
        )

    # Verify the output mp4 is actually playable. Same probe gate as
    # ``/producer/short`` uses for ``short.mp4``.
    check = validate_video_output(
        output_path,
        min_bytes=MIN_FINAL_MP4_BYTES,
        runner=runner,
    )
    if not check.ok:
        warnings.append(
            f"ffmpeg succeeded but final.mp4 failed validation: "
            f"{check.reason or 'unknown'}."
        )
        return AssembleResult(
            scene_count=len(resolved_scenes),
            output_dir=str(output_dir),
            warnings=warnings,
        )

    return AssembleResult(
        final_path=str(output_path),
        duration_s=float(check.duration_sec or video_total_s or 0.0),
        scene_count=len(resolved_scenes),
        audio_attached=audio is not None and audio_mode == "replace",
        captions_attached=(
            srt is not None and effective_caption_mode in ("soft", "burn")
        ),
        output_dir=str(output_dir),
        warnings=warnings,
    )
