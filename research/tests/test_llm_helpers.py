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


def test_refine_script_for_narration_passes_inputs_to_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The helper sends the raw script + image_prompts in a JSON payload
    and asks for a single ``narration`` key back. Word budget is computed
    from ``target_duration_s * words_per_second``."""
    captured: dict[str, str] = {}

    def fake_chat_json(prompt: str, system: str | None = None, **kw: object) -> str:
        captured["prompt"] = prompt
        captured["system"] = system or ""
        return '{"narration": "Cleaned narration here."}'

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)

    out = llm.refine_script_for_narration(
        raw_script="{ 'avoid': ['nsfw'], 'negative_prompt': ['blurry'] }",
        scene_image_prompts=["A wide shot of a calm sea.", "A close-up of an angler."],
        target_duration_s=12.0,
        language="English",
    )
    assert out == "Cleaned narration here."
    # System prompt shape: must mention the JSON output contract + duration.
    assert "narration" in captured["system"]
    assert "30 words" in captured["system"]  # 12.0s * 2.5 wps
    assert "English" in captured["system"]
    # User payload includes the raw script + image prompts verbatim.
    payload = json.loads(captured["prompt"])
    assert payload["RAW_INPUT"].startswith("{ 'avoid'")
    assert payload["IMAGE_PROMPTS"] == [
        "A wide shot of a calm sea.",
        "A close-up of an angler.",
    ]
    assert payload["TARGET_DURATION_S"] == 12.0
    assert payload["TARGET_WORDS"] == 30


def test_refine_script_for_narration_handles_list_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tolerant fallback: if the LLM emits ``narration`` as an array of
    sentences instead of a single string, the helper joins them with a
    single space so callers always get a usable narration."""

    def fake_chat_json(*_a: object, **_kw: object) -> str:
        return '{"narration": ["Sentence one.", "Sentence two."]}'

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)

    out = llm.refine_script_for_narration(
        raw_script="hello",
        target_duration_s=5.0,
    )
    assert out == "Sentence one. Sentence two."


def test_refine_script_for_narration_returns_empty_for_blank_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No LLM call is made for blank input — the helper short-circuits
    so the renderer never wastes a DeepSeek round-trip on noise."""
    called = {"n": 0}

    def fake_chat_json(*_a: object, **_kw: object) -> str:
        called["n"] += 1
        return '{}'

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)
    assert llm.refine_script_for_narration(raw_script="   ") == ""
    assert llm.refine_script_for_narration(raw_script="") == ""
    assert called["n"] == 0
