"""PR-23 — TTS provider abstraction tests.

Covers ``make_tts_adapter`` factory routing, the new
:class:`PiperTTSAdapter` (subprocess monkey-patched so tests don't need a
real ``piper`` binary or voice model on disk), and
:func:`resolve_piper_voice_path` lookup behaviour.

These tests are pure-Python / offline — they never call the real Piper
binary or download a voice file.
"""
from __future__ import annotations

import wave
from pathlib import Path

import pytest

from research.core.pixelle import tts as tts_mod
from research.core.pixelle.tts import (
    DEFAULT_TTS_PROVIDER,
    KNOWN_TTS_PROVIDERS,
    EdgeTTSAdapter,
    PiperTTSAdapter,
    make_tts_adapter,
    resolve_piper_voice_path,
)


def _write_silent_wav(path: Path, *, seconds: float = 0.5, rate: int = 16_000) -> None:
    """Write a tiny silent WAV so the duration probe has something to read."""
    path.parent.mkdir(parents=True, exist_ok=True)
    n_frames = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"\x00\x00" * n_frames)


# ---------------------------------------------------------------------------
# make_tts_adapter / KNOWN_TTS_PROVIDERS
# ---------------------------------------------------------------------------


def test_known_providers_includes_edge_and_piper() -> None:
    assert "edge-tts" in KNOWN_TTS_PROVIDERS
    assert "piper-tts" in KNOWN_TTS_PROVIDERS
    assert DEFAULT_TTS_PROVIDER == "edge-tts"


def test_make_tts_adapter_edge_default() -> None:
    adapter = make_tts_adapter(None)
    assert isinstance(adapter, EdgeTTSAdapter)
    assert adapter.name == "edge-tts"


def test_make_tts_adapter_piper() -> None:
    adapter = make_tts_adapter("piper-tts")
    assert isinstance(adapter, PiperTTSAdapter)
    assert adapter.name == "piper-tts"


def test_make_tts_adapter_unknown_falls_back_to_edge() -> None:
    # Unknown provider id → fall back to default rather than raise. This
    # matches the route's intent: a stale UI shouldn't 4xx — it should
    # log + render with the default engine.
    adapter = make_tts_adapter("kokoro")
    assert isinstance(adapter, EdgeTTSAdapter)


def test_make_tts_adapter_normalises_case_and_whitespace() -> None:
    assert isinstance(make_tts_adapter("  PIPER-TTS "), PiperTTSAdapter)
    assert isinstance(make_tts_adapter(""), EdgeTTSAdapter)


# ---------------------------------------------------------------------------
# resolve_piper_voice_path
# ---------------------------------------------------------------------------


def test_resolve_piper_voice_short_name(tmp_path: Path) -> None:
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    (voices_dir / "vi_VN-vais1000-medium.onnx").write_bytes(b"x")
    p = resolve_piper_voice_path(
        "vi_VN-vais1000-medium", voices_dir=voices_dir
    )
    assert p == voices_dir / "vi_VN-vais1000-medium.onnx"


def test_resolve_piper_voice_absolute_path(tmp_path: Path) -> None:
    onnx = tmp_path / "custom.onnx"
    onnx.write_bytes(b"x")
    p = resolve_piper_voice_path(str(onnx))
    assert p == onnx


def test_resolve_piper_voice_missing_raises(tmp_path: Path) -> None:
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    with pytest.raises(FileNotFoundError) as ei:
        resolve_piper_voice_path("nope", voices_dir=voices_dir)
    # Message must point users at the download URL — keeps support trail
    # short.
    assert "huggingface.co/rhasspy/piper-voices" in str(ei.value)


# ---------------------------------------------------------------------------
# PiperTTSAdapter — subprocess monkey-patched
# ---------------------------------------------------------------------------


def test_piper_adapter_synthesize_writes_wav_and_probes_duration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    (voices_dir / "v.onnx").write_bytes(b"x")

    captured: dict[str, object] = {}

    def fake_run_piper(self, *, text, output_path, voice_path):
        # Write a 0.5s silent WAV so duration probing returns 0.5.
        _write_silent_wav(output_path)
        captured["text"] = text
        captured["voice_path"] = voice_path

    monkeypatch.setattr(PiperTTSAdapter, "_run_piper", fake_run_piper)

    adapter = PiperTTSAdapter(voices_dir=voices_dir)
    out = tmp_path / "voice.mp3"  # caller passes mp3 path; piper switches to wav
    result = adapter.synthesize(
        text="Xin chào", output_path=out, voice="v"
    )
    assert result.engine == "piper-tts"
    assert result.audio_path == out.with_suffix(".wav")
    assert result.audio_path.exists()
    # Duration probe is best-effort; tiny silent WAV gives ~0.5s. Allow
    # any non-negative float so the test is not picky about the codec.
    assert result.duration_seconds >= 0.0
    assert result.word_boundaries == []  # Piper does NOT surface boundaries
    # Sanity check: input bytes flowed into _run_piper.
    assert captured["text"] == "Xin chào"


def test_piper_adapter_propagates_subprocess_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    (voices_dir / "v.onnx").write_bytes(b"x")

    class FakeProc:
        returncode = 2
        stderr = b"piper exploded"

    def fake_subprocess_run(*args, **kwargs):  # noqa: ANN001 - test stub
        return FakeProc()

    monkeypatch.setattr("shutil.which", lambda _: "/usr/bin/piper-fake")
    monkeypatch.setattr("subprocess.run", fake_subprocess_run)

    adapter = PiperTTSAdapter(voices_dir=voices_dir)
    with pytest.raises(RuntimeError) as ei:
        adapter.synthesize(
            text="hi", output_path=tmp_path / "voice.mp3", voice="v"
        )
    assert "exited with code 2" in str(ei.value)
    assert "piper exploded" in str(ei.value)


def test_piper_adapter_missing_binary_raises_runtime_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    (voices_dir / "v.onnx").write_bytes(b"x")
    monkeypatch.setattr("shutil.which", lambda _: None)

    adapter = PiperTTSAdapter(voices_dir=voices_dir)
    with pytest.raises(RuntimeError) as ei:
        adapter.synthesize(
            text="hi", output_path=tmp_path / "voice.mp3", voice="v"
        )
    msg = str(ei.value)
    assert "Piper binary not on PATH" in msg
    assert "pip install piper-tts" in msg


def test_piper_adapter_synthesize_with_timing_falls_back_to_synthesize(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    (voices_dir / "v.onnx").write_bytes(b"x")

    def fake_run_piper(self, *, text, output_path, voice_path):
        _write_silent_wav(output_path)

    monkeypatch.setattr(PiperTTSAdapter, "_run_piper", fake_run_piper)
    adapter = PiperTTSAdapter(voices_dir=voices_dir)
    result = adapter.synthesize_with_timing(
        text="hi", output_path=tmp_path / "voice.mp3", voice="v"
    )
    # No word boundaries — caller is expected to fall back to
    # ``fallback_captions_from_text``.
    assert result.word_boundaries == []
    assert result.audio_path.exists()


def test_piper_adapter_rejects_blank_text(tmp_path: Path) -> None:
    adapter = PiperTTSAdapter(voices_dir=tmp_path)
    with pytest.raises(ValueError):
        adapter.synthesize(text="   ", output_path=tmp_path / "x.mp3", voice="v")


# ---------------------------------------------------------------------------
# Module-level _probe_wav_duration safety
# ---------------------------------------------------------------------------


def test_probe_wav_duration_returns_zero_for_missing_file(tmp_path: Path) -> None:
    # The probe is best-effort — a missing file must not raise.
    assert tts_mod._probe_wav_duration(tmp_path / "nope.wav") == 0.0


def test_probe_wav_duration_returns_seconds_for_real_wav(tmp_path: Path) -> None:
    p = tmp_path / "ok.wav"
    _write_silent_wav(p, seconds=1.25)
    d = tts_mod._probe_wav_duration(p)
    assert 1.0 <= d <= 1.5, d
