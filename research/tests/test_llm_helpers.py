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


# ---------------------------------------------------------------------------
# Dedupe of per-scene narrations (caption-repeat-at-end bug guard).
# ---------------------------------------------------------------------------


def test_dedupe_scene_narrations_swaps_duplicate_for_fallback() -> None:
    """When the LLM returns the same narration for two scenes, the
    helper replaces the later occurrence with the corresponding
    ``original_narration`` fallback so we don't TTS-render the same
    line twice (which the user perceives as captions looping back to
    the beginning of the video)."""
    out = llm._dedupe_scene_narrations(
        narrations=[
            "Late night grocery run. Just stretching.",
            "She rides the escalator unaware.",
            "Late night grocery run. Just stretching.",
        ],
        fallbacks=[
            "intro chunk",
            "middle chunk",
            "Just a casual grocery run.",
        ],
    )
    assert out == [
        "Late night grocery run. Just stretching.",
        "She rides the escalator unaware.",
        "Just a casual grocery run.",
    ]


def test_dedupe_scene_narrations_blanks_when_fallback_also_collides() -> None:
    """If both the LLM result AND the fallback duplicate something we
    already kept, blank the slot so the per-scene synth pads silence
    rather than re-speaking the line a third time."""
    out = llm._dedupe_scene_narrations(
        narrations=["hello world", "hello world"],
        fallbacks=["hello world", "Hello   World"],  # both collide w/ scene 0
    )
    assert out == ["hello world", ""]


def test_dedupe_scene_narrations_is_case_and_whitespace_insensitive() -> None:
    """``"Hello world"`` and ``"  HELLO   WORLD  "`` are treated as the
    same line — DeepSeek occasionally re-emits the rewrite with subtly
    different casing/spacing."""
    out = llm._dedupe_scene_narrations(
        narrations=["Hello world", "  HELLO   WORLD  "],
        fallbacks=["a", "b"],
    )
    assert out == ["Hello world", "b"]


def test_dedupe_scene_narrations_passes_empty_through() -> None:
    """Empty entries are sentinels meaning "pad silence for this
    scene"; they must not be rewritten or counted as duplicates of
    each other."""
    out = llm._dedupe_scene_narrations(
        narrations=["   ", "Real line.", "", "Real line."],
        fallbacks=["fb0", "fb1", "fb2", "fb3"],
    )
    assert out == ["", "Real line.", "", "fb3"]


def test_refine_per_scene_narrations_dedupes_llm_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end through ``refine_per_scene_narrations``: the LLM
    rewrite returns scene 1 == scene 3, the helper swaps scene 3 for
    its original_narration fallback so the caller receives three
    distinct narrations."""

    def fake_chat_json(prompt: str, system: str | None = None, **kw: object) -> str:
        # Simulate DeepSeek hallucinating a duplicate for scene 3.
        return json.dumps({
            "narrations": [
                "Late night grocery run. Just stretching.",
                "She rides the escalator unaware.",
                "Late night grocery run. Just stretching.",
            ]
        })

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)
    refined = llm.refine_per_scene_narrations(
        original_script="anything",
        scenes=[
            {"index": 0, "target_duration_s": 4.0, "original_narration": "intro chunk"},
            {"index": 1, "target_duration_s": 6.0, "original_narration": "middle chunk"},
            {
                "index": 2,
                "target_duration_s": 3.5,
                "original_narration": "Just a casual grocery run.",
            },
        ],
    )
    assert len(refined) == 3
    # Scene 3 (originally a duplicate of scene 1) was swapped for its
    # original_narration fallback.
    assert refined[0] == "Late night grocery run. Just stretching."
    assert refined[1] == "She rides the escalator unaware."
    assert refined[2] == "Just a casual grocery run."
    # All three are now distinct.
    assert len({n.lower().strip() for n in refined}) == 3
