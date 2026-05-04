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
    DEFAULT_EDGE_FALLBACK_VOICE,
    DEFAULT_TTS_PROVIDER,
    ELEVENLABS_TO_EDGE_VOICE_MAP,
    KNOWN_TTS_PROVIDERS,
    EdgeTTSAdapter,
    ElevenLabsAdapter,
    PiperTTSAdapter,
    _elevenlabs_alignment_to_word_boundaries,
    edge_voice_for_elevenlabs,
    is_elevenlabs_fatal_error,
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


def test_known_providers_includes_edge_piper_elevenlabs() -> None:
    assert "edge-tts" in KNOWN_TTS_PROVIDERS
    assert "piper-tts" in KNOWN_TTS_PROVIDERS
    assert "elevenlabs" in KNOWN_TTS_PROVIDERS
    assert DEFAULT_TTS_PROVIDER == "edge-tts"


def test_make_tts_adapter_elevenlabs() -> None:
    adapter = make_tts_adapter("elevenlabs")
    assert isinstance(adapter, ElevenLabsAdapter)
    assert adapter.name == "elevenlabs"


def test_make_tts_adapter_elevenlabs_normalises_case() -> None:
    assert isinstance(make_tts_adapter("  ElevenLabs "), ElevenLabsAdapter)


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
        # ``auto_download=False`` keeps this test offline — short-name
        # ``nope`` doesn't match the HF pattern anyway, so even with
        # auto-download on it'd skip the network call, but we pass the
        # flag explicitly so the assertion is unambiguous.
        resolve_piper_voice_path(
            "nope", voices_dir=voices_dir, auto_download=False
        )
    # Message must point users at the download URL — keeps support trail
    # short.
    assert "huggingface.co/rhasspy/piper-voices" in str(ei.value)


# ---------------------------------------------------------------------------
# HF-15 — Piper voice auto-download (offline; we monkey-patch the
# ``_download_to_path`` helper so the test never hits the network).
# ---------------------------------------------------------------------------


def test_piper_voice_hf_url_known_short_name() -> None:
    # HF-15: en_US-amy-medium → en/en_US/amy/medium/en_US-amy-medium.onnx
    assert tts_mod._piper_voice_hf_url("en_US-amy-medium") == (
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
        "en/en_US/amy/medium/en_US-amy-medium.onnx"
    )
    # vi_VN-vais1000-medium → vi/vi_VN/vais1000/medium/...
    assert tts_mod._piper_voice_hf_url("vi_VN-vais1000-medium") == (
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
        "vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx"
    )


def test_piper_voice_hf_url_rejects_malformed() -> None:
    # Non-piper short-names (e.g. raw filenames, edge-tts ids) return
    # None so the auto-download stays an opt-in fast path.
    assert tts_mod._piper_voice_hf_url("nope") is None
    assert tts_mod._piper_voice_hf_url("en-US-AriaNeural") is None
    assert tts_mod._piper_voice_hf_url("en_US-AMY-medium") is None  # uppercase name
    assert tts_mod._piper_voice_hf_url("en_us-amy-medium") is None  # lowercase country


def _patch_download(monkeypatch, fake) -> None:
    """Patch ``_download_to_path`` on every module copy that holds it.

    ``research/core/pixelle/__init__.py`` aliases ``core`` → ``research.core``
    by registering both names in ``sys.modules``, which means
    ``research.core.pixelle.tts`` and ``core.pixelle.tts`` are loaded as
    *two* distinct module objects sharing the same source file. A
    `monkeypatch` against one copy doesn't affect the other, so the
    auto-download chain (whose globals point at whichever module the
    function happened to be defined in) escapes the patch. We patch both
    here so the unit test stays deterministic regardless of import order.
    """
    import sys as _sys

    for mod_name in ("research.core.pixelle.tts", "core.pixelle.tts"):
        mod = _sys.modules.get(mod_name)
        if mod is not None:
            monkeypatch.setattr(mod, "_download_to_path", fake)


def test_resolve_piper_voice_auto_download_success(monkeypatch, tmp_path: Path) -> None:
    """Auto-download writes both .onnx + .onnx.json then returns the path."""
    voices_dir = tmp_path / "voices"

    captured_urls: list[str] = []

    def fake_dl(url: str, dest: Path, *, timeout: float) -> None:
        captured_urls.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Simulate a real download by writing a non-empty file.
        dest.write_bytes(b"\x00" * 32)

    _patch_download(monkeypatch, fake_dl)

    p = resolve_piper_voice_path(
        "en_US-amy-medium", voices_dir=voices_dir, auto_download=True
    )
    assert p == voices_dir / "en_US-amy-medium.onnx"
    assert (voices_dir / "en_US-amy-medium.onnx.json").exists()
    # Both files were fetched, in order: .onnx first, then .onnx.json.
    assert len(captured_urls) == 2
    assert captured_urls[0].endswith("/en_US-amy-medium.onnx")
    assert captured_urls[1].endswith("/en_US-amy-medium.onnx.json")


def test_resolve_piper_voice_auto_download_failure_raises_file_not_found(
    monkeypatch, tmp_path: Path
) -> None:
    """Network failure during auto-download falls through to the legacy
    FileNotFoundError so HF-14's edge-tts fallback can take over."""
    voices_dir = tmp_path / "voices"

    def boom(url: str, dest: Path, *, timeout: float) -> None:
        raise OSError("simulated network failure")

    _patch_download(monkeypatch, boom)

    with pytest.raises(FileNotFoundError):
        resolve_piper_voice_path(
            "en_US-amy-medium", voices_dir=voices_dir, auto_download=True
        )


def test_resolve_piper_voice_auto_download_env_disabled(
    monkeypatch, tmp_path: Path
) -> None:
    """``CREATOR_FORGE_PIPER_AUTO_DOWNLOAD=0`` skips network entirely."""
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()

    called = {"count": 0}

    def fake_dl(*args, **kwargs):
        called["count"] += 1

    _patch_download(monkeypatch, fake_dl)
    monkeypatch.setenv("CREATOR_FORGE_PIPER_AUTO_DOWNLOAD", "0")

    with pytest.raises(FileNotFoundError):
        # ``auto_download=None`` → consult env (now disabled).
        resolve_piper_voice_path("en_US-amy-medium", voices_dir=voices_dir)
    assert called["count"] == 0  # never hit the network


def test_resolve_piper_voice_auto_download_skipped_when_present(
    monkeypatch, tmp_path: Path
) -> None:
    """A pre-existing ``.onnx`` short-circuits — no download attempt."""
    voices_dir = tmp_path / "voices"
    voices_dir.mkdir()
    onnx = voices_dir / "en_US-amy-medium.onnx"
    onnx.write_bytes(b"\x00" * 32)

    called = {"count": 0}

    def fake_dl(*args, **kwargs):
        called["count"] += 1

    _patch_download(monkeypatch, fake_dl)

    p = resolve_piper_voice_path(
        "en_US-amy-medium", voices_dir=voices_dir, auto_download=True
    )
    assert p == onnx
    assert called["count"] == 0


def test_piper_auto_download_enabled_env_parses_falsy() -> None:
    """The env-var parser treats common falsy strings as off, otherwise on."""
    import os

    backup = os.environ.get("CREATOR_FORGE_PIPER_AUTO_DOWNLOAD")
    try:
        for v in ("0", "false", "no", "off", "FALSE", "Off", ""):
            os.environ["CREATOR_FORGE_PIPER_AUTO_DOWNLOAD"] = v
            assert not tts_mod._piper_auto_download_enabled(), v
        for v in ("1", "true", "yes", "on", "anything"):
            os.environ["CREATOR_FORGE_PIPER_AUTO_DOWNLOAD"] = v
            assert tts_mod._piper_auto_download_enabled(), v
        # Unset → default ON.
        os.environ.pop("CREATOR_FORGE_PIPER_AUTO_DOWNLOAD", None)
        assert tts_mod._piper_auto_download_enabled()
    finally:
        if backup is None:
            os.environ.pop("CREATOR_FORGE_PIPER_AUTO_DOWNLOAD", None)
        else:
            os.environ["CREATOR_FORGE_PIPER_AUTO_DOWNLOAD"] = backup


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


# ---------------------------------------------------------------------------
# ElevenLabsAdapter — HTTP plumbing monkey-patched
# ---------------------------------------------------------------------------


class _FakeElevenLabsResponse:
    """Minimal stand-in for ``requests.Response`` covering the surface
    the adapter touches (``status_code``, ``json()``, ``text``,
    ``iter_content``)."""

    def __init__(
        self,
        *,
        status_code: int = 200,
        json_body: dict | None = None,
        audio_bytes: bytes = b"",
        text: str = "",
    ) -> None:
        self.status_code = status_code
        self._json = json_body
        self._audio = audio_bytes
        self.text = text or ""

    def json(self) -> dict:
        if self._json is None:
            raise ValueError("no json body")
        return self._json

    def iter_content(self, chunk_size: int = 8192):
        # Single-chunk yield is enough for the test contract.
        if self._audio:
            yield self._audio


def test_elevenlabs_adapter_rejects_blank_text(tmp_path: Path) -> None:
    adapter = ElevenLabsAdapter(api_key="test-key")
    with pytest.raises(ValueError):
        adapter.synthesize(text="   ", output_path=tmp_path / "x.mp3", voice="vID")


def test_elevenlabs_adapter_rejects_blank_voice(tmp_path: Path) -> None:
    adapter = ElevenLabsAdapter(api_key="test-key")
    with pytest.raises(ValueError):
        adapter.synthesize(text="hello", output_path=tmp_path / "x.mp3", voice="")


def test_elevenlabs_adapter_missing_api_key_raises() -> None:
    """Reading ``api_key`` with neither constructor arg nor env var
    raises a RuntimeError pointing at the dashboard URL — the route
    surfaces this verbatim as a warning so users know how to fix it."""
    import os

    saved = os.environ.pop("ELEVENLABS_API_KEY", None)
    try:
        adapter = ElevenLabsAdapter()  # no api_key, no env
        with pytest.raises(RuntimeError) as ei:
            _ = adapter.api_key
        assert "ELEVENLABS_API_KEY" in str(ei.value)
        assert "elevenlabs.io" in str(ei.value)
    finally:
        if saved is not None:
            os.environ["ELEVENLABS_API_KEY"] = saved


def test_elevenlabs_adapter_synthesize_writes_audio_and_sends_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``synthesize`` POSTs to ``/v1/text-to-speech/{voice_id}``,
    streams audio bytes to ``output_path``, and returns a TTSResult
    with engine='elevenlabs'."""
    captured: dict[str, object] = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["params"] = kwargs.get("params")
        captured["headers"] = kwargs.get("headers")
        captured["json"] = kwargs.get("json")
        return _FakeElevenLabsResponse(
            status_code=200, audio_bytes=b"\xff\xfb\x90\x00fakeMP3", text=""
        )

    import requests

    monkeypatch.setattr(requests, "post", fake_post)
    # ``_probe_mp3_duration`` is best-effort and returns 0.0 for our
    # fake bytes (no real mp3 decoder will parse them). We assert
    # >= 0 so the test doesn't depend on whether mutagen is installed
    # in the CI image — the duration probe is exercised by the
    # EdgeTTSAdapter / Piper tests already.
    monkeypatch.setattr(
        "research.core.pixelle.tts._probe_mp3_duration", lambda _p: 1.234
    )

    out = tmp_path / "voice.mp3"
    adapter = ElevenLabsAdapter(api_key="test-key")
    result = adapter.synthesize(
        text="Hello world", output_path=out, voice="21m00Tcm4TlvDq8ikWAM"
    )
    assert result.engine == "elevenlabs"
    assert result.voice == "21m00Tcm4TlvDq8ikWAM"
    assert result.duration_seconds >= 0.0  # probe is best-effort
    assert out.exists()
    assert out.read_bytes() == b"\xff\xfb\x90\x00fakeMP3"

    # Endpoint shape: voice id appears in the URL path; mp3 output_format
    # is on the query string; xi-api-key + accept headers are sent;
    # JSON body carries text + model_id + voice_settings.
    assert captured["url"] == (
        "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"
    )
    assert captured["params"] == {"output_format": "mp3_44100_128"}
    headers = captured["headers"]
    assert headers["xi-api-key"] == "test-key"
    assert headers["accept"] == "audio/mpeg"
    body = captured["json"]
    assert body["text"] == "Hello world"
    assert body["model_id"] == "eleven_multilingual_v2"
    assert "voice_settings" in body
    assert body["voice_settings"]["stability"] == pytest.approx(0.5)
    assert body["voice_settings"]["use_speaker_boost"] is True


def test_elevenlabs_adapter_propagates_http_error_with_detail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 4xx/5xx response with a documented ``detail.message`` JSON
    body becomes a RuntimeError carrying that message — so the route
    can surface "ElevenLabs 401: Invalid API key" as a user-readable
    warning instead of a generic stacktrace."""

    def fake_post(url, **kwargs):
        return _FakeElevenLabsResponse(
            status_code=401,
            json_body={
                "detail": {
                    "status": "invalid_api_key",
                    "message": "Invalid API key. Please verify your key.",
                }
            },
        )

    import requests

    monkeypatch.setattr(requests, "post", fake_post)
    adapter = ElevenLabsAdapter(api_key="bad-key")
    with pytest.raises(RuntimeError) as ei:
        adapter.synthesize(
            text="hi", output_path=tmp_path / "voice.mp3", voice="vID"
        )
    msg = str(ei.value)
    assert "401" in msg
    assert "Invalid API key" in msg


def test_elevenlabs_adapter_synthesize_with_timing_decodes_audio_and_parses_alignment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``synthesize_with_timing`` calls the ``/with-timestamps``
    endpoint, base64-decodes ``audio_base64`` to disk, and converts
    ``normalized_alignment``'s per-character timing into the
    pipeline's :class:`WordBoundary` list (one per whitespace-bounded
    word)."""
    import base64

    fake_audio = b"\xff\xfb\x90\x00fakeMP3PAYLOAD"
    body = {
        "audio_base64": base64.b64encode(fake_audio).decode("ascii"),
        "normalized_alignment": {
            "characters":               ["H", "i", " ", "y", "o", "u"],
            "character_start_times_seconds": [0.00, 0.10, 0.20, 0.25, 0.30, 0.40],
            "character_end_times_seconds":   [0.10, 0.20, 0.25, 0.30, 0.40, 0.50],
        },
    }

    def fake_post(url, **kwargs):
        # Sanity: route hits the with-timestamps endpoint, not the
        # plain /text-to-speech/{voice_id}.
        assert url.endswith("/with-timestamps")
        return _FakeElevenLabsResponse(status_code=200, json_body=body)

    import requests

    monkeypatch.setattr(requests, "post", fake_post)

    out = tmp_path / "voice.mp3"
    adapter = ElevenLabsAdapter(api_key="test-key")
    result = adapter.synthesize_with_timing(
        text="Hi you", output_path=out, voice="vID"
    )
    assert result.engine == "elevenlabs"
    assert out.read_bytes() == fake_audio
    # Two words: "Hi" (0.00 → 0.20) and "you" (0.25 → 0.50).
    assert len(result.word_boundaries) == 2
    w0, w1 = result.word_boundaries
    assert w0.text == "Hi"
    assert w0.start_s == pytest.approx(0.0)
    assert w0.end_s == pytest.approx(0.20)
    assert w1.text == "you"
    assert w1.start_s == pytest.approx(0.25)
    assert w1.end_s == pytest.approx(0.50)


def test_elevenlabs_alignment_helper_handles_empty_payload() -> None:
    """Missing / malformed alignment shapes return [] — callers fall
    back to the sentence-fallback caption builder."""
    assert _elevenlabs_alignment_to_word_boundaries({}) == []
    assert _elevenlabs_alignment_to_word_boundaries({"characters": []}) == []
    # Mismatched lengths are tolerated; we use ``min(len,...)``.
    assert _elevenlabs_alignment_to_word_boundaries({
        "characters": ["A"],
        "character_start_times_seconds": [0.0],
        "character_end_times_seconds": [],
    }) == []


def test_elevenlabs_alignment_helper_groups_punctuation_with_word() -> None:
    """Punctuation is non-whitespace so it stays attached to the
    preceding word — matches Edge-TTS's WordBoundary contract."""
    out = _elevenlabs_alignment_to_word_boundaries({
        "characters":                    ["H", "i", "!", " ", "Y", "o", "u", "?"],
        "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
        "character_end_times_seconds":   [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    })
    assert [w.text for w in out] == ["Hi!", "You?"]
    assert out[0].start_s == pytest.approx(0.0)
    assert out[0].end_s == pytest.approx(0.3)
    assert out[1].start_s == pytest.approx(0.4)
    assert out[1].end_s == pytest.approx(0.8)


# ---------------------------------------------------------------------------
# HF-13 — fatal-error detection + edge-tts fallback voice mapping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "msg",
    [
        # 401 free-tier-revoked — the exact bug report.
        "ElevenLabs 401: Free Tier usage disabled — Unusual activity detected",
        "ElevenLabs 401 Unauthorized: invalid_api_key",
        "ELEVENLABS_API_KEY not set",
        # 403 region / quota.
        "ElevenLabs 403 Forbidden: detected_unusual_activity",
        "ElevenLabs 422: voice_not_found",
        "ElevenLabs 429: quota_exceeded — tier_quota_exceeded",
        "ElevenLabs 422 Unprocessable Entity: model_not_found",
        "ElevenLabs 429: too_many_concurrent_requests",
    ],
)
def test_is_elevenlabs_fatal_error_detects_known_fatal_messages(msg: str) -> None:
    """Every documented ElevenLabs error pattern must trip the predicate
    so the route layer falls back to edge-tts on the next scene."""
    assert is_elevenlabs_fatal_error(msg) is True
    # Same predicate must also accept exceptions, not just strings.
    assert is_elevenlabs_fatal_error(RuntimeError(msg)) is True


@pytest.mark.parametrize(
    "msg",
    [
        # Empty / unrelated — must not trip a fallback.
        "",
        "edge-tts: connection reset",
        "Piper voice file missing: en_US-amy-medium.onnx",
        "ffmpeg returned non-zero exit code",
        # Mentions ElevenLabs but is a transient network blip — keep
        # retrying the same provider, don't burn the fallback.
        "ElevenLabs 500: temporary server error",
        "ElevenLabs 503: service unavailable",
    ],
)
def test_is_elevenlabs_fatal_error_passes_through_recoverable_errors(msg: str) -> None:
    """Transient / unrelated errors stay on the primary provider — the
    sticky fallback is meant to break the *fatal* loop, not poach
    edge-tts on a 500."""
    assert is_elevenlabs_fatal_error(msg) is False


def test_is_elevenlabs_fatal_error_handles_none() -> None:
    """Defensive: None / blank strings must not crash the predicate."""
    assert is_elevenlabs_fatal_error(None) is False  # type: ignore[arg-type]


def test_edge_voice_for_elevenlabs_known_id_returns_mapped_voice() -> None:
    """Every voice id in the map round-trips to a non-blank edge-tts
    short_name. Default fallback is en-US-AriaNeural."""
    rachel = "21m00Tcm4TlvDq8ikWAM"
    assert edge_voice_for_elevenlabs(rachel) == ELEVENLABS_TO_EDGE_VOICE_MAP[rachel]
    assert edge_voice_for_elevenlabs(rachel).startswith("en-")


def test_edge_voice_for_elevenlabs_unknown_id_returns_default() -> None:
    """Unknown / blank ids resolve to ``DEFAULT_EDGE_FALLBACK_VOICE`` so
    the route layer never crashes on a freshly-cloned voice id."""
    assert edge_voice_for_elevenlabs("totally-unknown-id-xyz") == DEFAULT_EDGE_FALLBACK_VOICE
    assert edge_voice_for_elevenlabs("") == DEFAULT_EDGE_FALLBACK_VOICE
    assert edge_voice_for_elevenlabs(None) == DEFAULT_EDGE_FALLBACK_VOICE  # type: ignore[arg-type]


def test_elevenlabs_voice_map_values_look_like_edge_tts_short_names() -> None:
    """Every mapped fallback voice must follow the ``<locale>-<Name>Neural``
    shape so edge-tts can synthesize without a 400 from the upstream
    provider. Catches a regression where someone pastes an ElevenLabs
    voice id into the *value* column by accident."""
    for elevenlabs_id, edge_voice in ELEVENLABS_TO_EDGE_VOICE_MAP.items():
        assert elevenlabs_id, "blank ElevenLabs voice id in map"
        assert edge_voice.endswith("Neural"), f"{edge_voice!r} not a Neural voice"
        assert "-" in edge_voice, f"{edge_voice!r} missing locale prefix"
