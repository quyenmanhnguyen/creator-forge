"""Tests for synthesize_with_timing — capture WordBoundary events from the stream."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from core.pixelle import tts as pixelle_tts


class _FakeCommunicate:
    """Mimics ``edge_tts.Communicate`` with a ``stream()`` async generator.

    Accepts the v7.0+ ``boundary`` keyword so signature inspection in the
    adapter detects it and passes ``boundary="WordBoundary"`` through.
    """

    last_kwargs: dict | None = None
    next_events: list[dict] = []

    def __init__(
        self, *, text, voice, rate, volume, boundary="SentenceBoundary"
    ) -> None:
        type(self).last_kwargs = {
            "text": text,
            "voice": voice,
            "rate": rate,
            "volume": volume,
            "boundary": boundary,
        }

    async def stream(self):
        for event in type(self).next_events:
            yield event

    async def save(self, path: str) -> None:  # pragma: no cover — used in older tests
        Path(path).write_bytes(b"fake")


class _FakeCommunicateV6:
    """Mimics edge-tts v6.x ``Communicate`` — no ``boundary`` keyword.

    On v6.x the service emitted WordBoundary chunks by default, so the
    adapter must NOT pass ``boundary="WordBoundary"`` (it would raise
    ``TypeError``). This fake's constructor signature reflects v6.x so
    we can assert the adapter omits the kwarg.
    """

    last_kwargs: dict | None = None
    next_events: list[dict] = []

    def __init__(self, *, text, voice, rate, volume) -> None:
        type(self).last_kwargs = {
            "text": text,
            "voice": voice,
            "rate": rate,
            "volume": volume,
        }

    async def stream(self):
        for event in type(self).next_events:
            yield event


@pytest.fixture
def fake_edge_tts(monkeypatch):
    fake_module = types.ModuleType("edge_tts")
    fake_module.Communicate = _FakeCommunicate  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "edge_tts", fake_module)
    return _FakeCommunicate


@pytest.fixture
def fake_edge_tts_v6(monkeypatch):
    fake_module = types.ModuleType("edge_tts")
    fake_module.Communicate = _FakeCommunicateV6  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "edge_tts", fake_module)
    return _FakeCommunicateV6


def test_synthesize_with_timing_writes_audio_and_collects_boundaries(tmp_path, fake_edge_tts):
    fake_edge_tts.next_events = [
        {"type": "audio", "data": b"AUDIO-CHUNK-1"},
        {
            "type": "WordBoundary",
            "offset": 0,
            "duration": 5_000_000,  # 0.5s in 100ns units
            "text": "hello",
        },
        {"type": "audio", "data": b"AUDIO-CHUNK-2"},
        {
            "type": "WordBoundary",
            "offset": 5_000_000,
            "duration": 7_000_000,
            "text": "world",
        },
    ]

    out = tmp_path / "v.mp3"
    adapter = pixelle_tts.EdgeTTSAdapter(rate="+0%", volume="+0%")

    result = adapter.synthesize_with_timing(
        "hello world", output_path=out, voice="en-US-AriaNeural"
    )

    assert out.read_bytes() == b"AUDIO-CHUNK-1AUDIO-CHUNK-2"
    assert len(result.word_boundaries) == 2
    assert result.word_boundaries[0].text == "hello"
    assert result.word_boundaries[0].start_s == pytest.approx(0.0)
    assert result.word_boundaries[0].end_s == pytest.approx(0.5)
    assert result.word_boundaries[1].start_s == pytest.approx(0.5)
    assert result.word_boundaries[1].end_s == pytest.approx(1.2)


def test_synthesize_with_timing_handles_no_word_boundaries(tmp_path, fake_edge_tts):
    """If the stream emits only audio (some voices don't surface boundaries),
    the result is still valid — just with an empty boundaries list."""
    fake_edge_tts.next_events = [{"type": "audio", "data": b"X" * 100}]

    out = tmp_path / "v.mp3"
    adapter = pixelle_tts.EdgeTTSAdapter()

    result = adapter.synthesize_with_timing("hi", output_path=out, voice="en-US-AriaNeural")

    assert out.read_bytes() == b"X" * 100
    assert result.word_boundaries == []


def test_synthesize_with_timing_rejects_empty_text(tmp_path):
    adapter = pixelle_tts.EdgeTTSAdapter()
    with pytest.raises(ValueError, match="non-empty"):
        adapter.synthesize_with_timing("   ", output_path=tmp_path / "x.mp3", voice="en-US-AriaNeural")


def test_synthesize_with_timing_creates_parent_dir(tmp_path, fake_edge_tts):
    fake_edge_tts.next_events = [{"type": "audio", "data": b"abc"}]
    nested = tmp_path / "a" / "b" / "c.mp3"
    adapter = pixelle_tts.EdgeTTSAdapter()

    adapter.synthesize_with_timing("hello", output_path=nested, voice="en-US-AriaNeural")

    assert nested.exists()


def test_synthesize_with_timing_passes_boundary_word_on_v7(tmp_path, fake_edge_tts):
    """On edge-tts v7.0+ the adapter must explicitly request WordBoundary.

    v7.0 changed the default of ``Communicate.boundary`` from WordBoundary
    to SentenceBoundary; without the explicit override the WebSocket
    service emits no per-word events and the adapter falls back to
    sentence-distributed captions.
    """
    fake_edge_tts.next_events = [{"type": "audio", "data": b"x"}]

    adapter = pixelle_tts.EdgeTTSAdapter()
    adapter.synthesize_with_timing(
        "hello", output_path=tmp_path / "v.mp3", voice="en-US-AriaNeural"
    )

    assert fake_edge_tts.last_kwargs is not None
    assert fake_edge_tts.last_kwargs.get("boundary") == "WordBoundary"


def test_synthesize_with_timing_omits_boundary_on_v6(tmp_path, fake_edge_tts_v6):
    """On edge-tts v6.x the adapter must NOT pass ``boundary``.

    v6.x has no ``boundary`` keyword and would raise ``TypeError``.
    Detection is by ``inspect.signature`` on the live ``Communicate``.
    """
    fake_edge_tts_v6.next_events = [{"type": "audio", "data": b"x"}]

    adapter = pixelle_tts.EdgeTTSAdapter()
    adapter.synthesize_with_timing(
        "hello", output_path=tmp_path / "v.mp3", voice="en-US-AriaNeural"
    )

    assert fake_edge_tts_v6.last_kwargs is not None
    assert "boundary" not in fake_edge_tts_v6.last_kwargs


def test_communicate_kwargs_helper_detects_boundary_param():
    """Direct unit test for ``_communicate_kwargs`` signature reflection."""

    class WithBoundary:
        def __init__(self, *, text, voice, rate, volume, boundary="SentenceBoundary"):
            pass

    class WithoutBoundary:
        def __init__(self, *, text, voice, rate, volume):
            pass

    with_kwargs = pixelle_tts._communicate_kwargs(
        WithBoundary, text="t", voice="v", rate="+0%", volume="+0%"
    )
    without_kwargs = pixelle_tts._communicate_kwargs(
        WithoutBoundary, text="t", voice="v", rate="+0%", volume="+0%"
    )

    assert with_kwargs.get("boundary") == "WordBoundary"
    assert "boundary" not in without_kwargs
