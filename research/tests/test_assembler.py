"""Offline tests for ``research.core.pixelle.assembler`` (PR-31).

ffmpeg/ffprobe are stubbed via the ``runner`` injection seam so the
suite passes regardless of whether either binary is on PATH. We pair
every behavioural assertion (route call → result) with a structural
assertion on the argv that ``_build_ffmpeg_args`` produced, which
catches the "looks-right but not what we asked for" failure mode where
e.g. the audio map slot points at the wrong input index.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from research.core.pixelle import assembler


# ─── Fakes / helpers ───────────────────────────────────────────────────────


@dataclass
class _Proc:
    returncode: int
    stdout: str
    stderr: str


def _make_scene_file(tmp_path: Path, name: str, size: int = 50_000) -> Path:
    p = tmp_path / name
    # Pad the file so it clears MIN_USABLE_VIDEO_BYTES (10_000B).
    p.write_bytes(b"x" * size)
    return p


def _make_audio_file(tmp_path: Path, name: str = "voice.mp3") -> Path:
    p = tmp_path / name
    p.write_bytes(b"id3" + b"\x00" * 200)
    return p


def _make_srt_file(tmp_path: Path, name: str = "captions.srt") -> Path:
    p = tmp_path / name
    p.write_text("1\n00:00:00,000 --> 00:00:01,000\nHello\n", encoding="utf-8")
    return p


def _ffprobe_stdout(duration: float = 3.0) -> str:
    return json.dumps({
        "format": {"duration": str(duration)},
        "streams": [
            {
                "codec_type": "video", "codec_name": "h264",
                "width": 720, "height": 1280, "duration": str(duration),
            },
        ],
    })


def _ffprobe_stdout_split(*, container: float, video_stream: float) -> str:
    """ffprobe output where ``format.duration`` exceeds the video stream's
    ``duration`` — the post-PR-31 mov_text "soft subs extend container"
    case.
    """
    return json.dumps({
        "format": {"duration": str(container)},
        "streams": [
            {
                "codec_type": "video", "codec_name": "h264",
                "width": 720, "height": 1280, "duration": str(video_stream),
            },
            {"codec_type": "audio", "codec_name": "aac"},
            {"codec_type": "subtitle", "codec_name": "mov_text"},
        ],
    })


def _runner_factory(
    *,
    ffprobe_stdout: str = "",
    ffprobe_code: int = 0,
    ffmpeg_stdout: str = "",
    ffmpeg_stderr: str = "",
    ffmpeg_code: int = 0,
    on_ffmpeg=None,
):
    """Build a runner that branches on ``cmd[0]``.

    The path resolver returns ``/fake/ffprobe`` or ``/fake/ffmpeg``
    (forced via monkeypatch in the test), so we pattern-match on the
    binary path rather than full-args parsing.
    """
    def runner(cmd, **_kwargs):
        binary = str(cmd[0])
        if "ffprobe" in binary:
            return _Proc(returncode=ffprobe_code, stdout=ffprobe_stdout, stderr="")
        # ffmpeg
        if on_ffmpeg is not None:
            on_ffmpeg(cmd)
        return _Proc(returncode=ffmpeg_code, stdout=ffmpeg_stdout, stderr=ffmpeg_stderr)
    return runner


def _force_binaries(monkeypatch, *, ffprobe: bool = True, ffmpeg: bool = True):
    monkeypatch.setattr(
        "research.core.pixelle.video_probe._resolve_ffprobe",
        lambda: "/fake/ffprobe" if ffprobe else None,
    )
    monkeypatch.setattr(
        assembler, "_resolve_ffmpeg",
        lambda: "/fake/ffmpeg" if ffmpeg else None,
    )


# ─── Pure helpers ──────────────────────────────────────────────────────────


def test_concat_list_line_normalises_backslashes_and_quotes():
    line = assembler._concat_list_line(Path("C:\\videos\\sc'ene.mp4"))
    assert line == "file 'C:/videos/sc'\\''ene.mp4'"


def test_validate_inputs_drops_missing_unsupported_and_tiny(tmp_path):
    good = _make_scene_file(tmp_path, "good.mp4")
    tiny = _make_scene_file(tmp_path, "tiny.mp4", size=100)
    wrong_ext = _make_scene_file(tmp_path, "weird.txt", size=50_000)
    missing = tmp_path / "ghost.mp4"

    scenes, audio, srt, warnings = assembler._validate_inputs(
        [str(good), str(tiny), str(wrong_ext), str(missing)],
        audio_path=None, srt_path=None,
    )
    assert scenes == [good]
    assert audio is None and srt is None
    # Three warnings — one per dropped path.
    assert sum("not on disk" in w for w in warnings) == 1
    assert sum("unsupported extension" in w for w in warnings) == 1
    assert sum("too small" in w for w in warnings) == 1


def test_validate_inputs_warns_on_missing_audio(tmp_path):
    good = _make_scene_file(tmp_path, "good.mp4")
    _scenes, audio, _srt, warnings = assembler._validate_inputs(
        [str(good)], audio_path=str(tmp_path / "nope.mp3"), srt_path=None,
    )
    assert audio is None
    assert any("audio_path not on disk" in w for w in warnings)


# ─── _build_ffmpeg_args structural tests ───────────────────────────────────


def test_args_default_replace_video_soft(tmp_path):
    list_p = tmp_path / "list.txt"
    audio_p = _make_audio_file(tmp_path)
    srt_p = _make_srt_file(tmp_path)
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p,
        output_path=out_p,
        audio=audio_p,
        srt=srt_p,
        audio_mode="replace",
        caption_mode="soft",
        trim_to="video",
        video_total_s=12.5,
    )

    # Inputs in order: 0=concat, 1=audio, 2=srt
    i = args.index("-i")
    assert args[i + 1] == str(list_p)
    j = args.index("-i", i + 1)
    assert args[j + 1] == str(audio_p)
    k = args.index("-i", j + 1)
    assert args[k + 1] == str(srt_p)
    # Map slots wired to those input indexes.
    assert "-map" in args and "0:v:0" in args
    assert "1:a:0" in args
    assert "2:s:0" in args
    # mov_text soft sub.
    assert args[args.index("-c:s") + 1] == "mov_text"
    # Trim cap based on video_total_s, not -shortest.
    assert "-shortest" not in args
    assert "-t" in args
    assert args[args.index("-t") + 1] == "12.500"
    # Output is last positional.
    assert args[-1] == str(out_p)


def test_args_audio_none_pulls_through_scene_audio(tmp_path):
    list_p = tmp_path / "list.txt"
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p, output_path=out_p,
        audio=None, srt=None,
        audio_mode="none", caption_mode="none",
        trim_to="video", video_total_s=10.0,
    )
    # No audio input added → scene audio pulled through with ``a?``.
    assert "0:a?" in args
    # No subtitle input + no -c:s flag.
    assert "-c:s" not in args
    # -t is only applied when use_audio is true (otherwise concat
    # natural duration wins).
    assert "-t" not in args


def test_args_trim_to_audio_uses_shortest(tmp_path):
    list_p = tmp_path / "list.txt"
    audio_p = _make_audio_file(tmp_path)
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p, output_path=out_p,
        audio=audio_p, srt=None,
        audio_mode="replace", caption_mode="none",
        trim_to="audio", video_total_s=10.0,
    )
    assert "-shortest" in args
    assert "-t" not in args


def test_args_caption_burn_appends_subtitles_filter_and_skips_srt_input(tmp_path):
    """PR-32 — burn mode chains the ``subtitles=`` filter onto -vf and
    must NOT add the srt as a separate -i input or emit -c:s mov_text.
    """
    list_p = tmp_path / "list.txt"
    audio_p = _make_audio_file(tmp_path)
    srt_p = _make_srt_file(tmp_path)
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p, output_path=out_p,
        audio=audio_p, srt=srt_p,
        audio_mode="replace", caption_mode="burn",
        trim_to="video", video_total_s=10.0,
        burn_srt_relname="_subs.srt",
    )

    # SRT is consumed by the filter, not as an input.
    assert str(srt_p) not in args
    # -vf chain ends with subtitles=_subs.srt (relative — caller stages
    # the file in cwd before invoking ffmpeg).
    vf_idx = args.index("-vf")
    vf_chain = args[vf_idx + 1]
    assert vf_chain.endswith(",subtitles=_subs.srt"), (
        f"-vf chain should end with subtitles filter, got: {vf_chain!r}"
    )
    # Burn does not need a soft-sub stream → no mov_text codec flag.
    assert "-c:s" not in args
    # 2:s:0 stream map is for soft subs; burn must not emit it.
    assert "2:s:0" not in args
    # The visible-input count is exactly 2 (concat list + audio).
    assert sum(1 for a in args if a == "-i") == 2


def test_args_caption_burn_without_relname_falls_back_to_no_filter(tmp_path):
    """If the caller forgets to pass ``burn_srt_relname`` (e.g. SRT
    staging failed) the args builder must NOT emit ``subtitles=`` or
    add a soft-sub stream. The result is silent video, with the
    caller responsible for surfacing the warning.
    """
    list_p = tmp_path / "list.txt"
    audio_p = _make_audio_file(tmp_path)
    srt_p = _make_srt_file(tmp_path)
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p, output_path=out_p,
        audio=audio_p, srt=srt_p,
        audio_mode="replace", caption_mode="burn",
        trim_to="video", video_total_s=10.0,
        burn_srt_relname=None,  # staging failed
    )

    # Filter chain stays at the baseline scale/setsar/format.
    vf_chain = args[args.index("-vf") + 1]
    assert "subtitles=" not in vf_chain
    # No soft-sub stream either.
    assert "-c:s" not in args


def test_args_caption_none_drops_srt_input(tmp_path):
    list_p = tmp_path / "list.txt"
    audio_p = _make_audio_file(tmp_path)
    srt_p = _make_srt_file(tmp_path)
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p, output_path=out_p,
        audio=audio_p, srt=srt_p,  # provided but caption_mode="none"
        audio_mode="replace", caption_mode="none",
        trim_to="video", video_total_s=5.0,
    )
    # srt path should not appear as a -i input.
    assert str(srt_p) not in args
    assert "-c:s" not in args


# ─── End-to-end (stubbed ffmpeg) ───────────────────────────────────────────


def test_assemble_empty_scene_videos_returns_warning(tmp_path):
    out_dir = tmp_path / "out"
    r = assembler.assemble_final_mp4(
        scene_videos=[], audio_path=None, srt_path=None,
        output_dir=out_dir,
    )
    assert r.final_path == ""
    assert r.scene_count == 0
    assert any("scene_videos is empty" in w for w in r.warnings)


def test_assemble_no_usable_scenes_aborts_before_ffmpeg(tmp_path, monkeypatch):
    _force_binaries(monkeypatch)
    out_dir = tmp_path / "out"
    calls: list = []

    def runner(cmd, **_):
        calls.append(cmd)
        return _Proc(0, "", "")

    r = assembler.assemble_final_mp4(
        scene_videos=[str(tmp_path / "missing.mp4")],
        audio_path=None, srt_path=None,
        output_dir=out_dir,
        runner=runner,
    )
    assert r.final_path == ""
    # ffmpeg should never have been spawned.
    assert all("ffmpeg" not in str(cmd[0]) for cmd in calls)
    assert any("No usable scene videos" in w for w in r.warnings)


def test_assemble_burn_path_stages_srt_passes_cwd_and_cleans_up(tmp_path, monkeypatch):
    """PR-32 — full-stack burn-in flow.

    The assembler must:
      1. Copy the user's SRT into ``output_dir/_subs.srt`` before
         invoking ffmpeg (so the ``subtitles=`` filter resolves it
         relative to cwd, dodging Windows path-colon escaping).
      2. Invoke the runner with ``cwd=output_dir`` so the relative
         filename actually works.
      3. Build args containing ``subtitles=_subs.srt`` and *not*
         containing the user's original SRT path.
      4. Clean up the staged SRT after ffmpeg finishes.
      5. Surface ``captions_attached=True`` on the result.
    """
    _force_binaries(monkeypatch)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    audio = _make_audio_file(tmp_path)
    srt = _make_srt_file(tmp_path)
    out_dir = tmp_path / "assembly"

    captured: dict = {}

    def runner(cmd, **kwargs):
        binary = str(cmd[0])
        if "ffprobe" in binary:
            return _Proc(0, _ffprobe_stdout(3.0), "")
        captured["cmd"] = list(cmd)
        captured["cwd"] = kwargs.get("cwd")
        # While ffmpeg is "running" the staged srt must be on disk.
        captured["staged_srt_present_during_run"] = (
            (out_dir / "_subs.srt").is_file()
        )
        (out_dir / "final.mp4").write_bytes(b"y" * 300_000)
        return _Proc(0, "", "")

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1)],
        audio_path=str(audio), srt_path=str(srt),
        output_dir=out_dir,
        caption_mode="burn",
        runner=runner,
    )

    # Result surface.
    assert r.final_path == str(out_dir / "final.mp4")
    assert r.captions_attached is True
    assert all("falling back to soft" not in w for w in r.warnings)

    # Args contain the relative subtitles filter, not the absolute SRT.
    # HF-10 — the chain now also gets a ``:force_style='...'`` payload
    # for the default ``modern`` caption preset so the subtitles
    # render with the YouTube-Shorts-style outline instead of libass's
    # ugly defaults. We don't pin the exact force_style here (the
    # preset content is exercised by the build_force_style tests
    # below); instead we assert the structural shape: the ``subtitles=``
    # filter resolves to the staged relative name, and force_style
    # follows it as an additional filter argument.
    cmd = captured["cmd"]
    vf_chain = cmd[cmd.index("-vf") + 1]
    assert ",subtitles=_subs.srt" in vf_chain
    assert ":force_style='" in vf_chain
    assert str(srt) not in cmd
    # No mov_text codec for burn.
    assert "-c:s" not in cmd

    # cwd was set to output_dir so the relative filename resolves.
    assert captured["cwd"] == str(out_dir)

    # Staged SRT existed mid-run, gone after.
    assert captured["staged_srt_present_during_run"] is True
    assert not (out_dir / "_subs.srt").exists(), (
        "staged _subs.srt should be cleaned up after ffmpeg returns"
    )


def test_assemble_burn_without_srt_warns_and_falls_back_to_no_captions(
    tmp_path, monkeypatch,
):
    """``caption_mode="burn"`` + missing ``srt_path`` is a user error
    we surface, not silently downgrade."""
    _force_binaries(monkeypatch)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    audio = _make_audio_file(tmp_path)
    out_dir = tmp_path / "assembly"

    def on_ffmpeg(cmd):
        (out_dir / "final.mp4").write_bytes(b"y" * 300_000)
        # No srt → no subtitles filter.
        vf = cmd[cmd.index("-vf") + 1]
        assert "subtitles=" not in vf

    runner = _runner_factory(
        ffprobe_stdout=_ffprobe_stdout(3.0),
        on_ffmpeg=on_ffmpeg,
    )

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1)],
        audio_path=str(audio), srt_path=None,
        output_dir=out_dir,
        caption_mode="burn",
        runner=runner,
    )

    assert r.final_path == str(out_dir / "final.mp4")
    assert r.captions_attached is False
    assert any(
        "caption_mode='burn' but no usable srt_path" in w for w in r.warnings
    )


def test_assemble_reports_video_stream_duration_not_container(tmp_path, monkeypatch):
    """Reproduces the May-01 live-E2E finding: with ``caption_mode="soft"``
    the soft-subs SRT extends the mp4 container past the visual track,
    and the legacy code path (``check.duration_sec``) erroneously
    reported the longer container duration. ``duration_s`` must reflect
    the v:0 stream's duration so callers can sanity-check against the
    summed scene durations.
    """
    _force_binaries(monkeypatch)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    scene2 = _make_scene_file(tmp_path, "shot2.mp4")
    scene3 = _make_scene_file(tmp_path, "shot3.mp4")
    audio = _make_audio_file(tmp_path)
    srt = _make_srt_file(tmp_path)
    out_dir = tmp_path / "assembly"

    def runner(cmd, **_kwargs):
        binary = str(cmd[0])
        target = str(cmd[-1])
        if "ffprobe" in binary:
            # final.mp4 is the only path that exhibits the split (mov_text
            # extends container). Scene probes use the symmetric helper.
            if target.endswith("final.mp4"):
                return _Proc(
                    returncode=0,
                    stdout=_ffprobe_stdout_split(container=11.18, video_stream=10.0),
                    stderr="",
                )
            # Each scene returns 3.333s so summed = 9.999s ≈ 10s.
            return _Proc(returncode=0, stdout=_ffprobe_stdout(3.333), stderr="")
        # ffmpeg — pretend it wrote a realistic-sized final.mp4.
        (out_dir / "final.mp4").write_bytes(b"y" * 300_000)
        return _Proc(returncode=0, stdout="", stderr="")

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1), str(scene2), str(scene3)],
        audio_path=str(audio), srt_path=str(srt),
        output_dir=out_dir,
        runner=runner,
    )

    assert r.final_path == str(out_dir / "final.mp4")
    # The headline assertion: video stream length, not container length.
    assert r.duration_s == pytest.approx(10.0, abs=0.01)
    # Specifically NOT the container duration — that would silently
    # over-report by ~1.18s when soft-subs are attached.
    assert r.duration_s != pytest.approx(11.18)
    assert r.captions_attached is True


def test_assemble_falls_back_to_video_total_when_stream_duration_missing(
    tmp_path, monkeypatch,
):
    """When ffprobe reports ``format.duration`` only (no per-stream
    ``duration`` field — some encoders skip it), we fall back to the
    summed scene durations rather than the container.
    """
    _force_binaries(monkeypatch)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    out_dir = tmp_path / "assembly"

    def runner(cmd, **_kwargs):
        binary = str(cmd[0])
        target = str(cmd[-1])
        if "ffprobe" in binary:
            if target.endswith("final.mp4"):
                # format only, no streams[].duration.
                no_stream_dur = json.dumps({
                    "format": {"duration": "11.18"},
                    "streams": [
                        {"codec_type": "video", "codec_name": "h264",
                         "width": 720, "height": 1280},
                    ],
                })
                return _Proc(returncode=0, stdout=no_stream_dur, stderr="")
            return _Proc(returncode=0, stdout=_ffprobe_stdout(4.0), stderr="")
        (out_dir / "final.mp4").write_bytes(b"y" * 300_000)
        return _Proc(returncode=0, stdout="", stderr="")

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1)],
        audio_path=None, srt_path=None,
        output_dir=out_dir,
        runner=runner,
    )

    assert r.final_path == str(out_dir / "final.mp4")
    # Falls back to summed scene durations, not the inflated container.
    assert r.duration_s == pytest.approx(4.0)


def test_assemble_happy_path_writes_final_mp4(tmp_path, monkeypatch):
    _force_binaries(monkeypatch)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    scene2 = _make_scene_file(tmp_path, "shot2.mp4")
    audio = _make_audio_file(tmp_path)
    srt = _make_srt_file(tmp_path)
    out_dir = tmp_path / "assembly"

    captured: dict = {}

    def on_ffmpeg(cmd):
        captured["cmd"] = list(cmd)
        # Pretend ffmpeg wrote final.mp4 with realistic size.
        (out_dir / "final.mp4").write_bytes(b"y" * 300_000)

    runner = _runner_factory(
        ffprobe_stdout=_ffprobe_stdout(3.0),
        on_ffmpeg=on_ffmpeg,
    )

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1), str(scene2)],
        audio_path=str(audio), srt_path=str(srt),
        output_dir=out_dir,
        runner=runner,
    )

    assert r.final_path == str(out_dir / "final.mp4")
    assert r.scene_count == 2
    assert r.audio_attached is True
    assert r.captions_attached is True
    # 2 scenes × 3.0s probed each = 6.0s summed → -t 6.000.
    assert "-t" in captured["cmd"]
    t_val = captured["cmd"][captured["cmd"].index("-t") + 1]
    assert t_val == "6.000"
    # Concat list file should have been cleaned up.
    assert not (out_dir / "_concat_list.txt").exists()


def test_assemble_ffmpeg_failure_returns_warning_no_path(tmp_path, monkeypatch):
    _force_binaries(monkeypatch)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    out_dir = tmp_path / "assembly"

    runner = _runner_factory(
        ffprobe_stdout=_ffprobe_stdout(2.0),
        ffmpeg_code=1,
        ffmpeg_stderr="Error opening output file\n",
    )

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1)],
        audio_path=None, srt_path=None,
        output_dir=out_dir,
        runner=runner,
    )
    assert r.final_path == ""
    assert r.scene_count == 1
    assert any("ffmpeg exited 1" in w for w in r.warnings)


def test_assemble_no_ffmpeg_binary_warns_and_aborts(tmp_path, monkeypatch):
    _force_binaries(monkeypatch, ffmpeg=False)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    out_dir = tmp_path / "assembly"

    runner = _runner_factory(ffprobe_stdout=_ffprobe_stdout(2.0))

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1)],
        audio_path=None, srt_path=None,
        output_dir=out_dir,
        runner=runner,
    )
    assert r.final_path == ""
    assert any("ffmpeg unavailable" in w for w in r.warnings)


def test_assemble_missing_audio_falls_back_silent(tmp_path, monkeypatch):
    _force_binaries(monkeypatch)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    out_dir = tmp_path / "assembly"
    captured: dict = {}

    def on_ffmpeg(cmd):
        captured["cmd"] = list(cmd)
        (out_dir / "final.mp4").write_bytes(b"y" * 300_000)

    runner = _runner_factory(
        ffprobe_stdout=_ffprobe_stdout(2.0),
        on_ffmpeg=on_ffmpeg,
    )

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1)],
        audio_path=str(tmp_path / "ghost.mp3"),  # missing
        srt_path=None,
        output_dir=out_dir,
        runner=runner,
    )

    assert r.final_path == str(out_dir / "final.mp4")
    assert r.audio_attached is False
    assert any("audio_path not on disk" in w for w in r.warnings)
    # No second -i (audio) input.
    cmd = captured["cmd"]
    i_count = sum(1 for arg in cmd if arg == "-i")
    assert i_count == 1


def test_assemble_validation_fails_returns_warning(tmp_path, monkeypatch):
    _force_binaries(monkeypatch)
    scene1 = _make_scene_file(tmp_path, "shot1.mp4")
    out_dir = tmp_path / "assembly"

    def on_ffmpeg(cmd):
        # ffmpeg "succeeds" but writes a 0-byte stub.
        (out_dir / "final.mp4").write_bytes(b"")

    runner = _runner_factory(
        ffprobe_stdout=_ffprobe_stdout(2.0),
        on_ffmpeg=on_ffmpeg,
    )

    r = assembler.assemble_final_mp4(
        scene_videos=[str(scene1)],
        audio_path=None, srt_path=None,
        output_dir=out_dir,
        runner=runner,
    )
    assert r.final_path == ""
    assert any("failed validation" in w for w in r.warnings)


def test_assemble_unwritable_output_dir_returns_warning(tmp_path, monkeypatch):
    monkeypatch.setattr(
        Path, "mkdir",
        lambda self, *a, **k: (_ for _ in ()).throw(PermissionError("nope")),
    )
    r = assembler.assemble_final_mp4(
        scene_videos=["/tmp/whatever.mp4"],
        audio_path=None, srt_path=None,
        output_dir=tmp_path / "blocked",
    )
    assert r.final_path == ""
    assert any("Could not create output_dir" in w for w in r.warnings)


def test_sum_video_durations_skips_unprobeable(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "research.core.pixelle.video_probe._resolve_ffprobe",
        lambda: "/fake/ffprobe",
    )
    good = _make_scene_file(tmp_path, "good.mp4")
    bad = _make_scene_file(tmp_path, "bad.mp4")

    def runner(cmd, **_):
        path = cmd[-1]
        if "bad" in path:
            return _Proc(returncode=1, stdout="", stderr="moov atom not found")
        return _Proc(returncode=0, stdout=_ffprobe_stdout(4.0), stderr="")

    total, warnings = assembler._sum_video_durations([good, bad], runner=runner)
    assert total == pytest.approx(4.0)
    assert any("Could not probe duration" in w for w in warnings)


# ─── HF-10: build_force_style + _build_ffmpeg_args force_style injection ───
#
# The four presets in ``CAPTION_STYLE_PRESETS`` are the source of truth
# for ffmpeg's ``subtitles=...:force_style='...'`` argument. These
# tests exercise:
#   * Each preset round-trips its FontName / FontSize / Alignment
#     intact through ``build_force_style``.
#   * ``font_size`` and ``position`` overrides replace the preset's
#     ``FontSize`` / ``Alignment`` + ``MarginV``.
#   * Unknown values fall back gracefully (no exceptions, no missing
#     keys) so a stale renderer can never crash the route.
#   * ``_build_ffmpeg_args`` injects the resulting string as
#     ``:force_style='...'`` (with comma-escape) only in burn mode,
#     and skips it cleanly when force_style is None.


def test_build_force_style_modern_default_preset_round_trips():
    """Default call returns the ``modern`` preset's full param set in
    ``Key=Value,...`` order."""
    out = assembler.build_force_style()
    # Modern is the documented default — bold white sans-serif.
    assert "FontName=Arial" in out
    assert "FontSize=22" in out
    assert "Bold=1" in out
    assert "Outline=2" in out
    assert "Alignment=2" in out
    # Comma-separated and contains every preset key (no silent drops).
    pairs = out.split(",")
    keys = [p.split("=", 1)[0] for p in pairs]
    for must_have in (
        "FontName", "FontSize", "PrimaryColour", "OutlineColour",
        "BackColour", "Bold", "Italic", "Outline", "Shadow",
        "Alignment", "MarginV",
    ):
        assert must_have in keys, f"modern preset missing {must_have!r} in: {out}"


def test_build_force_style_cinematic_uses_serif_italic_with_shadow():
    out = assembler.build_force_style("cinematic")
    assert "FontName=Georgia" in out
    assert "Italic=1" in out
    assert "Shadow=2" in out
    # Cinematic has a thinner outline than modern (1 vs 2).
    assert "Outline=1" in out


def test_build_force_style_tiktok_uses_impact_with_heavy_outline():
    out = assembler.build_force_style("tiktok")
    assert "FontName=Impact" in out
    assert "FontSize=28" in out
    assert "Bold=1" in out
    # Heavier outline than modern so the text pops on busy bg.
    assert "Outline=4" in out
    # TikTok preset sits a bit higher than the bottom-default 40.
    assert "MarginV=60" in out


def test_build_force_style_minimal_drops_outline_keeps_subtle_shadow():
    out = assembler.build_force_style("minimal")
    assert "FontName=Arial" in out
    assert "FontSize=18" in out
    assert "Outline=0" in out
    assert "Shadow=1" in out
    assert "Bold=0" in out


def test_build_force_style_unknown_preset_falls_back_to_modern():
    """A stale renderer that ships an unknown preset key must NOT
    raise — the helper falls back to ``DEFAULT_CAPTION_STYLE`` so the
    ffmpeg call still runs."""
    out_unknown = assembler.build_force_style("ferrari-red")
    out_default = assembler.build_force_style(assembler.DEFAULT_CAPTION_STYLE)
    assert out_unknown == out_default


def test_build_force_style_font_size_override_replaces_preset_value():
    """Each named font-size bucket overrides the preset's FontSize."""
    for name, expected_pt in (("small", 16), ("medium", 22), ("large", 28)):
        out = assembler.build_force_style("modern", font_size=name)
        assert f"FontSize={expected_pt}" in out, (
            f"font_size={name!r} should set FontSize={expected_pt} but got: {out}"
        )


def test_build_force_style_invalid_font_size_keeps_preset_default():
    """An unknown font-size string is silently dropped — preset wins."""
    out = assembler.build_force_style("modern", font_size="huge")
    # modern's preset FontSize is 22.
    assert "FontSize=22" in out


def test_build_force_style_position_override_replaces_alignment_and_marginv():
    """Each named position override replaces the preset's Alignment +
    MarginV with the documented numpad/MarginV combo."""
    cases = (
        ("bottom", "Alignment=2", "MarginV=40"),
        ("middle", "Alignment=5", "MarginV=0"),
        ("top",    "Alignment=8", "MarginV=40"),
    )
    for name, expected_align, expected_margin in cases:
        out = assembler.build_force_style("modern", position=name)
        assert expected_align in out, (
            f"position={name!r} should set {expected_align} but got: {out}"
        )
        assert expected_margin in out


def test_build_force_style_invalid_position_keeps_preset_default():
    out = assembler.build_force_style("modern", position="diagonal")
    # Modern's preset values: Alignment=2, MarginV=40.
    assert "Alignment=2" in out
    assert "MarginV=40" in out


def test_build_force_style_combined_overrides_apply_together():
    """Setting both font_size and position overrides at once must
    update both — neither override should clobber the other."""
    out = assembler.build_force_style(
        "tiktok", font_size="small", position="top",
    )
    # font_size override wins over preset (was 28).
    assert "FontSize=16" in out
    # position override wins over preset (was 2/60).
    assert "Alignment=8" in out
    assert "MarginV=40" in out
    # Preset's other params still flow through (Impact font, Bold=1).
    assert "FontName=Impact" in out
    assert "Bold=1" in out


def test_args_caption_burn_with_force_style_is_appended_with_escaped_commas(tmp_path):
    """When ``force_style`` is set with burn mode, the -vf chain ends
    with ``subtitles=<srt>:force_style='<escaped>'`` and inner commas
    are replaced with ``\\,`` so the lavfi parser doesn't split them
    as filter separators."""
    list_p = tmp_path / "list.txt"
    audio_p = _make_audio_file(tmp_path)
    srt_p = _make_srt_file(tmp_path)
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p, output_path=out_p,
        audio=audio_p, srt=srt_p,
        audio_mode="replace", caption_mode="burn",
        trim_to="video", video_total_s=10.0,
        burn_srt_relname="_subs.srt",
        force_style="FontName=Arial,FontSize=22,Bold=1",
    )

    vf_idx = args.index("-vf")
    vf_chain = args[vf_idx + 1]
    # Filter ends with the styled subtitles part, and commas inside the
    # force_style payload are escaped so the outer chain parser keeps
    # the rest of the styling together.
    assert "subtitles=_subs.srt:force_style=" in vf_chain
    assert r"FontName=Arial\,FontSize=22\,Bold=1" in vf_chain
    # Single-quoted so an older ffmpeg's lavfi parser can use that as
    # an extra hint — belt-and-suspenders.
    assert ":force_style='" in vf_chain
    assert vf_chain.endswith("'"), vf_chain


def test_args_caption_burn_without_force_style_keeps_plain_subtitles_filter(tmp_path):
    """When ``force_style`` is omitted, the -vf chain ends in
    ``subtitles=<srt>`` with no ``:force_style=`` suffix — preserves
    the pre-HF-10 behaviour for callers that didn't opt in."""
    list_p = tmp_path / "list.txt"
    audio_p = _make_audio_file(tmp_path)
    srt_p = _make_srt_file(tmp_path)
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p, output_path=out_p,
        audio=audio_p, srt=srt_p,
        audio_mode="replace", caption_mode="burn",
        trim_to="video", video_total_s=10.0,
        burn_srt_relname="_subs.srt",
    )

    vf_idx = args.index("-vf")
    vf_chain = args[vf_idx + 1]
    assert vf_chain.endswith(",subtitles=_subs.srt")
    assert "force_style" not in vf_chain


def test_args_caption_soft_ignores_force_style_kwarg(tmp_path):
    """Even if a stale caller passes ``force_style`` with
    ``caption_mode='soft'``, the args builder must NOT inject the
    subtitles filter — the SRT goes in as a mov_text stream and the
    style argument is irrelevant."""
    list_p = tmp_path / "list.txt"
    audio_p = _make_audio_file(tmp_path)
    srt_p = _make_srt_file(tmp_path)
    out_p = tmp_path / "final.mp4"

    args = assembler._build_ffmpeg_args(
        list_path=list_p, output_path=out_p,
        audio=audio_p, srt=srt_p,
        audio_mode="replace", caption_mode="soft",
        trim_to="video", video_total_s=10.0,
        force_style="FontSize=99,Bold=1",
    )

    vf_idx = args.index("-vf")
    vf_chain = args[vf_idx + 1]
    # No subtitles filter at all — and certainly no force_style.
    assert "subtitles=" not in vf_chain
    assert "force_style" not in vf_chain
    # mov_text codec confirms the soft-sub path.
    assert args[args.index("-c:s") + 1] == "mov_text"


def test_assemble_burn_path_passes_force_style_into_ffmpeg(tmp_path, monkeypatch):
    """End-to-end via ``assemble_final_mp4``: caption_style + overrides
    flow through to the ffmpeg argv as a force_style payload."""
    monkeypatch.setattr(
        "research.core.pixelle.video_probe._resolve_ffprobe",
        lambda: "/fake/ffprobe",
    )
    monkeypatch.setattr(assembler, "_resolve_ffmpeg", lambda: "/fake/ffmpeg")

    scene = _make_scene_file(tmp_path, "scene_001.mp4")
    audio = _make_audio_file(tmp_path)
    srt = _make_srt_file(tmp_path)
    output_dir = tmp_path / "out"
    output_dir.mkdir()

    captured: list[list[str]] = []

    def runner(cmd, **kwargs):
        captured.append(list(cmd))
        if cmd[0].endswith("ffprobe"):
            return _Proc(returncode=0, stdout=_ffprobe_stdout(4.0), stderr="")
        # Pretend ffmpeg succeeded and wrote final.mp4 — pad past the
        # MIN_USABLE_VIDEO_BYTES threshold so the post-run validator
        # accepts it (a smaller payload looks like a truncated download
        # to the size sentinel).
        (output_dir / "final.mp4").write_bytes(b"y" * 50_000)
        return _Proc(returncode=0, stdout="", stderr="")

    result = assembler.assemble_final_mp4(
        scene_videos=[str(scene)],
        audio_path=str(audio),
        srt_path=str(srt),
        output_dir=output_dir,
        audio_mode="replace",
        trim_to="video",
        caption_mode="burn",
        caption_style="tiktok",
        caption_font_size="large",
        caption_position="top",
        runner=runner,
    )

    assert result.final_path
    # Find the ffmpeg call (not ffprobe) and inspect its -vf arg.
    ffmpeg_calls = [c for c in captured if c[0].endswith("ffmpeg")]
    assert ffmpeg_calls, "expected at least one ffmpeg invocation"
    args = ffmpeg_calls[-1]
    vf_idx = args.index("-vf")
    vf_chain = args[vf_idx + 1]
    # tiktok preset font (Impact) + large size override (28pt) + top
    # position override (Alignment=8) all reach the wire payload.
    assert "force_style=" in vf_chain
    assert r"FontName=Impact" in vf_chain
    assert r"FontSize=28" in vf_chain
    assert r"Alignment=8" in vf_chain
