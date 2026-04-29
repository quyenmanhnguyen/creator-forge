"""Tests for core.pixelle.llm (provider chain: DeepSeek primary, Gemini fallback)."""
from __future__ import annotations

import pytest

from core.pixelle import llm as pixelle_llm
from core.pixelle.config import LLMConfig


def test_chat_uses_deepseek_when_primary(monkeypatch):
    captured: dict[str, object] = {}

    def fake_core_chat(prompt, *, system=None, temperature=0.7, model=None):
        captured["called"] = "deepseek"
        captured["prompt"] = prompt
        captured["model"] = model
        return "from-deepseek"

    monkeypatch.setattr(pixelle_llm.core_llm, "chat", fake_core_chat)

    out = pixelle_llm.chat("hello", config=LLMConfig(primary="deepseek", fallback=None))

    assert out == "from-deepseek"
    assert captured["called"] == "deepseek"
    assert captured["model"] == "deepseek-chat"


def test_chat_falls_back_to_gemini_when_primary_fails(monkeypatch):
    def failing_deepseek(*_args, **_kwargs):
        raise RuntimeError("deepseek down")

    monkeypatch.setattr(pixelle_llm.core_llm, "chat", failing_deepseek)
    monkeypatch.setattr(
        pixelle_llm,
        "_gemini_chat",
        lambda prompt, *, system, temperature, model, key: "from-gemini",
    )
    monkeypatch.setenv("GOOGLE_API_KEY", "g-test")

    out = pixelle_llm.chat("hello", config=LLMConfig(primary="deepseek", fallback="gemini"))

    assert out == "from-gemini"


def test_chat_raises_when_all_providers_fail(monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError("primary down")

    monkeypatch.setattr(pixelle_llm.core_llm, "chat", fail)
    monkeypatch.setattr(
        pixelle_llm,
        "_gemini_chat",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("gemini down too")),
    )

    with pytest.raises(pixelle_llm.LLMUnavailableError, match="All providers failed"):
        pixelle_llm.chat("hello", config=LLMConfig(primary="deepseek", fallback="gemini"))


def test_gemini_chat_requires_key(monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="MISSING_PIXELLE_GEMINI_KEY"):
        pixelle_llm._gemini_chat(
            "hi", system=None, temperature=0.7, model="gemini-2.5-flash", key=None
        )


def test_unknown_provider_name_raises():
    with pytest.raises(ValueError, match="Unknown LLM provider"):
        pixelle_llm._provider_fn("anthropic", LLMConfig())


def test_provider_chain_deduplicates_when_primary_equals_fallback():
    cfg = LLMConfig(primary="deepseek", fallback="deepseek")
    chain = pixelle_llm._provider_chain(cfg)
    assert len(chain) == 1
    assert chain[0][0] == "deepseek"
