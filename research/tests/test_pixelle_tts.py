"""Tests for core.pixelle.tts (adapter contract + edge-tts wiring)."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from core.pixelle import tts as pixelle_tts
from core.pixelle.config import TTSConfig


class _FakeCommunicate:
    """Stand-in for ``edge_tts.Communicate`` used in the unit test."""

    last_kwargs: dict | None = None

    def __init__(self, *, text: str, voice: str, rate: str, volume: str) -> None:
        type(self).last_kwargs = {
            "text": text,
            "voice": voice,
            "rate": rate,
            "volume": volume,
        }
        self._text = text

    async def save(self, path: str) -> None:
        Path(path).write_bytes(b"ID3" + b"\x00" * 16 + self._text.encode("utf-8"))


@pytest.fixture
def fake_edge_tts(monkeypatch):
    """Inject a fake ``edge_tts`` module so tests don't hit the network."""
    import sys
    import types

    fake_module = types.ModuleType("edge_tts")
    fake_module.Communicate = _FakeCommunicate  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "edge_tts", fake_module)
    return _FakeCommunicate


def test_edge_tts_adapter_writes_file(tmp_path, fake_edge_tts):
    out = tmp_path / "audio" / "voice.mp3"
    adapter = pixelle_tts.EdgeTTSAdapter(rate="+10%", volume="-5%")

    result = adapter.synthesize("hello world", output_path=out, voice="en-US-AriaNeural")

    assert result.audio_path == out
    assert out.exists()
    assert out.stat().st_size > 0
    assert result.voice == "en-US-AriaNeural"
    assert result.engine == "edge-tts"
    assert fake_edge_tts.last_kwargs == {
        "text": "hello world",
        "voice": "en-US-AriaNeural",
        "rate": "+10%",
        "volume": "-5%",
    }


def test_synthesize_high_level_uses_config(tmp_path, fake_edge_tts):
    cfg = TTSConfig(engine="edge-tts", voice="vi-VN-HoaiMyNeural", rate="+5%", volume="+0%")
    out = tmp_path / "v.mp3"

    pixelle_tts.synthesize("xin chao", output_path=out, config=cfg)

    assert fake_edge_tts.last_kwargs["voice"] == "vi-VN-HoaiMyNeural"


def test_synthesize_rejects_unknown_engine(tmp_path):
    cfg = TTSConfig(engine="chat-tts")  # not yet wired in PR-A1

    with pytest.raises(NotImplementedError, match="chat-tts"):
        pixelle_tts.synthesize("hi", output_path=tmp_path / "x.mp3", config=cfg)


def test_synthesize_rejects_empty_text(tmp_path):
    adapter = pixelle_tts.EdgeTTSAdapter()
    with pytest.raises(ValueError, match="non-empty"):
        adapter.synthesize("   ", output_path=tmp_path / "x.mp3", voice="en-US-AriaNeural")


def test_probe_mp3_duration_returns_zero_when_unprobeable(tmp_path):
    """The fallback path must return 0.0 (not raise) when no probe lib works."""
    p = tmp_path / "garbage.mp3"
    p.write_bytes(b"not actually an mp3")

    duration = pixelle_tts._probe_mp3_duration(p)

    assert duration == 0.0


# Sanity: the fake we use in this file is genuinely awaitable.
def test_fake_communicate_save_is_awaitable(tmp_path):
    p = tmp_path / "x.mp3"
    asyncio.run(_FakeCommunicate(text="hi", voice="en-US-AriaNeural", rate="+0%", volume="+0%").save(str(p)))
    assert p.exists()
