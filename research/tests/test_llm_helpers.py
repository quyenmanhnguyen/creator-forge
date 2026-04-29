"""Tests for core/llm.py Studio pipeline helpers — verify prompts compose
correctly and that ``ERR_NO_DEEPSEEK_KEY`` is raised when no key is set.
"""
from __future__ import annotations

import json

import pytest

from core import llm


def test_client_without_key_raises_sentinel(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(RuntimeError) as ei:
        llm.client()
    assert llm.ERR_NO_DEEPSEEK_KEY in str(ei.value)


def test_long_script_chunked_rejects_short_outline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "stub")
    with pytest.raises(ValueError):
        llm.long_script_chunked("title", parts=[{"part": 1}], language="English")


def test_long_script_chunked_calls_chat_twice_and_concats(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify chunking does 2 calls + merges (no DeepSeek call)."""
    calls: list[tuple[str, str]] = []

    def fake_chat(prompt: str, system: str | None = None, **kw: object) -> str:
        calls.append((prompt[:30], system or ""))
        return f"== chunk {len(calls)} ==\nbody {len(calls)}"

    monkeypatch.setattr(llm, "chat", fake_chat)

    parts = [{"part": i, "role": f"r{i}", "emotion": "e", "expansion": "x"} for i in range(1, 9)]
    out = llm.long_script_chunked("My title", parts=parts, language="English", target_chars=4000)
    assert len(calls) == 2
    assert "chunk 1" in out and "chunk 2" in out


def test_topic_ideas_parses_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm,
        "chat_json",
        lambda prompt, system=None: json.dumps(
            {"ideas": [{"topic": "T1", "emotion": "calm", "hook": "H1"}]}
        ),
    )
    data = llm.topic_ideas("seed", language="English")
    assert data["ideas"][0]["topic"] == "T1"


def test_humanize_rewrite_passes_script_through(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    def fake_chat(prompt: str, system: str | None = None, **kw: object) -> str:
        captured["prompt"] = prompt
        captured["system"] = system or ""
        return "rewritten"

    monkeypatch.setattr(llm, "chat", fake_chat)
    out = llm.humanize_rewrite("ORIGINAL_SCRIPT", language="Korean (한국어)")
    assert out == "rewritten"
    assert "ORIGINAL_SCRIPT" in captured["prompt"]
    assert "Korean" in captured["system"]
