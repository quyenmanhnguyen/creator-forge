"""Offline tests for ``research.core.pixelle.video_probe`` (PR-20E).

These tests stub ``subprocess.run`` via the ``runner`` injection seam
so they pass regardless of whether ffprobe is installed on the host.
We cover every decision branch of ``validate_video_output``:

  - missing file
  - file-size below floor (short-circuits even when ffprobe says ok)
  - ffprobe non-zero exit code (corrupt mp4)
  - ffprobe returns invalid JSON
  - ffprobe reports no video stream
  - ffprobe reports duration at / below floor
  - ffprobe reports ok → validator ok
  - ffprobe unavailable (size-only fallback)
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from research.core.pixelle import video_probe


@dataclass
class _Proc:
    returncode: int
    stdout: str
    stderr: str


def _fake_runner(*, code=0, stdout="", stderr=""):
    def runner(cmd, **_kwargs):
        return _Proc(returncode=code, stdout=stdout, stderr=stderr)
    return runner


def _happy_stdout():
    return json.dumps({
        "format": {"duration": "5.5"},
        "streams": [
            {"codec_type": "audio"},
            {
                "codec_type": "video", "codec_name": "h264",
                "width": 720, "height": 1280, "duration": "5.5",
            },
        ],
    })


def _stat_fn(size):
    class St:
        st_size = size
    def fn(_p):
        return St()
    return fn


def _missing_stat_fn(_p):
    raise FileNotFoundError


def _force_ffprobe(monkeypatch, present: bool):
    """Deterministically pin _resolve_ffprobe for the test."""
    monkeypatch.setattr(video_probe, "_resolve_ffprobe",
                        lambda: "/fake/ffprobe" if present else None)


def test_probe_empty_path_returns_reason():
    r = video_probe.probe_video_file("")
    assert r.exists is False
    assert "empty" in (r.reason or "")


def test_probe_missing_file_returns_reason(monkeypatch):
    _force_ffprobe(monkeypatch, True)
    r = video_probe.probe_video_file("/no/such/file.mp4", stat_fn=_missing_stat_fn)
    assert r.exists is False
    assert "file not on disk" in (r.reason or "")


def test_validate_happy_path_size_ok_and_ffprobe_ok(monkeypatch):
    _force_ffprobe(monkeypatch, True)
    r = video_probe.validate_video_output(
        "/tmp/x.mp4",
        min_bytes=10_000,
        stat_fn=_stat_fn(200_000),
        runner=_fake_runner(stdout=_happy_stdout()),
    )
    assert r.ok is True
    assert r.ffprobe_available is True
    assert r.has_video_stream is True
    assert r.codec == "h264"
    assert r.width == 720 and r.height == 1280
    assert r.duration_sec == pytest.approx(5.5)
    # Video stream duration is reported alongside the container duration
    # so callers (e.g. /producer/assemble) can distinguish the two when
    # soft-subs extend the container.
    assert r.video_stream_duration_sec == pytest.approx(5.5)


def test_probe_separates_video_and_container_durations(monkeypatch):
    """When format.duration > video_stream.duration (e.g. soft subs
    keep the container open past the visual track), both fields must
    be reported independently.
    """
    _force_ffprobe(monkeypatch, True)
    long_container = json.dumps({
        # Container says 11.18s — typical when mov_text SRT is longer.
        "format": {"duration": "11.18"},
        "streams": [
            {"codec_type": "audio"},
            {
                "codec_type": "video", "codec_name": "h264",
                "width": 720, "height": 1280, "duration": "10.000",
            },
        ],
    })
    r = video_probe.probe_video_file(
        "/tmp/final.mp4",
        runner=_fake_runner(stdout=long_container),
        stat_fn=_stat_fn(200_000),
    )
    # Legacy field still reflects the container (back-compat).
    assert r.duration_sec == pytest.approx(11.18)
    # New field cleanly separates the visual length.
    assert r.video_stream_duration_sec == pytest.approx(10.0)


def test_probe_video_stream_duration_falls_back_when_only_format_known(monkeypatch):
    """When ffprobe reports only ``format.duration`` (no per-stream
    ``duration``), ``video_stream_duration_sec`` is ``None`` so callers
    can detect the missing data and fall back to their own estimate.
    """
    _force_ffprobe(monkeypatch, True)
    no_stream_dur = json.dumps({
        "format": {"duration": "5.5"},
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 720, "height": 1280},
        ],
    })
    r = video_probe.probe_video_file(
        "/tmp/x.mp4",
        runner=_fake_runner(stdout=no_stream_dur),
        stat_fn=_stat_fn(200_000),
    )
    assert r.duration_sec == pytest.approx(5.5)
    assert r.video_stream_duration_sec is None


def test_validate_size_below_floor_fails(monkeypatch):
    _force_ffprobe(monkeypatch, True)
    r = video_probe.validate_video_output(
        "/tmp/tiny.mp4",
        min_bytes=10_000,
        stat_fn=_stat_fn(500),
        runner=_fake_runner(stdout=_happy_stdout()),
    )
    assert r.ok is False
    assert "suspiciously small" in (r.reason or "")


def test_validate_ffprobe_non_zero_exit_fails(monkeypatch):
    _force_ffprobe(monkeypatch, True)
    r = video_probe.validate_video_output(
        "/tmp/corrupt.mp4",
        min_bytes=10_000,
        stat_fn=_stat_fn(50_000),
        runner=_fake_runner(code=1, stderr="moov atom not found\n"),
    )
    assert r.ok is False
    assert "ffprobe rejected" in (r.reason or "")


def test_validate_ffprobe_invalid_json_fails(monkeypatch):
    _force_ffprobe(monkeypatch, True)
    r = video_probe.validate_video_output(
        "/tmp/garbage.mp4",
        min_bytes=10_000,
        stat_fn=_stat_fn(50_000),
        runner=_fake_runner(stdout="not-json"),
    )
    assert r.ok is False
    assert "not valid JSON" in (r.reason or "")


def test_validate_no_video_stream_fails(monkeypatch):
    _force_ffprobe(monkeypatch, True)
    audio_only = json.dumps({
        "format": {"duration": "3.0"},
        "streams": [{"codec_type": "audio"}],
    })
    r = video_probe.validate_video_output(
        "/tmp/audio.mp4",
        min_bytes=10_000,
        stat_fn=_stat_fn(50_000),
        runner=_fake_runner(stdout=audio_only),
    )
    assert r.ok is False
    assert r.has_video_stream is False


def test_validate_duration_below_floor_fails(monkeypatch):
    _force_ffprobe(monkeypatch, True)
    short_dur = json.dumps({
        "format": {"duration": "0.05"},
        "streams": [{"codec_type": "video", "codec_name": "h264"}],
    })
    r = video_probe.validate_video_output(
        "/tmp/short.mp4",
        min_bytes=10_000,
        min_duration_sec=0.2,
        stat_fn=_stat_fn(50_000),
        runner=_fake_runner(stdout=short_dur),
    )
    assert r.ok is False
    assert "duration" in (r.reason or "")


def test_validate_ffprobe_missing_soft_passes_on_size(monkeypatch):
    _force_ffprobe(monkeypatch, False)
    # runner shouldn't be invoked when ffprobe isn't resolved.
    def tripwire(*_a, **_k):  # noqa: ARG001
        pytest.fail("subprocess.run must not run when ffprobe is missing")
    r = video_probe.validate_video_output(
        "/tmp/ok.mp4",
        min_bytes=10_000,
        stat_fn=_stat_fn(200_000),
        runner=tripwire,
    )
    assert r.ok is True
    assert r.ffprobe_available is False
    assert r.reason is not None
    assert "ffprobe unavailable" in r.reason


def test_validate_ffprobe_missing_AND_size_below_floor_fails(monkeypatch):
    _force_ffprobe(monkeypatch, False)
    r = video_probe.validate_video_output(
        "/tmp/tiny.mp4",
        min_bytes=10_000,
        stat_fn=_stat_fn(500),
        runner=lambda *a, **k: pytest.fail("should not run"),
    )
    assert r.ok is False


def test_probe_resolves_ffprobe_from_env_when_set(tmp_path, monkeypatch):
    fake_binary = tmp_path / "ffprobe"
    fake_binary.write_text("#!/bin/sh\necho")
    fake_binary.chmod(0o755)
    monkeypatch.setenv("FFPROBE_PATH", str(fake_binary))
    assert video_probe._resolve_ffprobe() == str(fake_binary)


def test_probe_env_missing_path_falls_back_to_which(monkeypatch):
    monkeypatch.setenv("FFPROBE_PATH", "/definitely/not/a/real/path")
    monkeypatch.setattr(video_probe.shutil, "which", lambda name: "/usr/bin/fake-ffprobe")
    assert video_probe._resolve_ffprobe() == "/usr/bin/fake-ffprobe"
