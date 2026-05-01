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
