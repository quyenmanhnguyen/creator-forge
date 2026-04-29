"""Tests for core.pixelle.config (env wiring + redacted describe)."""
from __future__ import annotations

import pytest

from core.pixelle import config as pixelle_config


def test_load_config_defaults_to_local_first(monkeypatch):
    """No env set → DeepSeek primary, Gemini fallback, local ComfyUI default."""
    for var in [
        "PIXELLE_LLM_PRIMARY",
        "PIXELLE_LLM_FALLBACK",
        "DEEPSEEK_MODEL",
        "GEMINI_MODEL",
        "COMFYUI_URL",
        "COMFYUI_CLOUD_ONLY",
        "RUNNINGHUB_INSTANCE",
        "PIXELLE_TTS_VOICE",
        "PIXELLE_TTS_ENGINE",
    ]:
        monkeypatch.delenv(var, raising=False)

    cfg = pixelle_config.load_config()

    assert cfg.llm.primary == "deepseek"
    assert cfg.llm.fallback == "gemini"
    assert cfg.comfy.local_url == "http://127.0.0.1:8188"
    assert cfg.comfy.cloud_only is False
    assert cfg.tts.engine == "edge-tts"


def test_load_config_overrides_from_env(monkeypatch):
    """Each non-secret field is overridable via env."""
    monkeypatch.setenv("PIXELLE_LLM_PRIMARY", "gemini")
    monkeypatch.setenv("PIXELLE_LLM_FALLBACK", "")
    monkeypatch.setenv("COMFYUI_URL", "http://comfy.local:9000")
    monkeypatch.setenv("COMFYUI_CLOUD_ONLY", "true")
    monkeypatch.setenv("PIXELLE_TTS_VOICE", "vi-VN-HoaiMyNeural")

    cfg = pixelle_config.load_config()

    assert cfg.llm.primary == "gemini"
    assert cfg.llm.fallback is None  # empty string → None
    assert cfg.comfy.local_url == "http://comfy.local:9000"
    assert cfg.comfy.cloud_only is True
    assert cfg.tts.voice == "vi-VN-HoaiMyNeural"


def test_describe_does_not_leak_secrets(monkeypatch):
    """describe() must report 'set'/'missing', never the raw key."""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-secret-do-not-leak")
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    cfg = pixelle_config.load_config()
    summary = cfg.describe()

    assert summary["llm.deepseek_key"] == "set"
    assert summary["llm.gemini_key"] == "missing"
    assert "sk-secret-do-not-leak" not in repr(summary)


def test_gemini_key_accepts_either_env_var(monkeypatch):
    """Both GOOGLE_API_KEY and GEMINI_API_KEY should populate the key."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "g-1")
    cfg = pixelle_config.load_config()
    assert cfg.llm.gemini_key == "g-1"

    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "g-2")
    cfg = pixelle_config.load_config()
    assert cfg.llm.gemini_key == "g-2"


def test_grok_config_default_describes_browser_login():
    """PR-A4.2: Grok auth is runtime browser login; no env vars used."""
    cfg = pixelle_config.load_config()
    assert cfg.grok.auth_kind == "browser_login"


def test_describe_includes_grok_auth_kind():
    cfg = pixelle_config.load_config()
    summary = cfg.describe()
    assert summary["grok.auth_kind"] == "browser_login"


def test_runninghub_cloud_only_requires_key(monkeypatch):
    """cloud_only=True without RUNNINGHUB_API_KEY is a configuration error."""
    monkeypatch.delenv("RUNNINGHUB_API_KEY", raising=False)
    monkeypatch.setenv("COMFYUI_CLOUD_ONLY", "true")

    cfg = pixelle_config.load_config()

    assert cfg.comfy.cloud_only is True
    assert cfg.comfy.cloud_available is False  # surfaced to the resolver

    # The actual error is raised at resolve time (tested in test_pixelle_comfy)
    from core.pixelle import comfy_client

    with pytest.raises(comfy_client.ComfyUIError, match="cloud_only"):
        comfy_client.resolve_endpoint(cfg.comfy, timeout=0.1)
