"""Provider configuration for the Pixelle pipeline (local-first).

All fields read from environment variables (typically populated via the
``.env`` file already used by the rest of Tube Atlas). The pipeline is
**local-first**: ComfyUI is expected to run on ``http://127.0.0.1:8188``
unless the user opts into the RunningHub cloud fallback.

Why dataclasses (not pydantic): keeping the dependency footprint small —
the rest of the repo already uses ``python-dotenv`` + plain ``os.getenv``.

Example ``.env``:

.. code-block:: bash

    DEEPSEEK_API_KEY=sk-...
    DEEPSEEK_MODEL=deepseek-chat

    # Optional fallback
    GOOGLE_API_KEY=AIzaS...
    GEMINI_MODEL=gemini-2.5-flash

    # Local ComfyUI (default)
    COMFYUI_URL=http://127.0.0.1:8188

    # Cloud fallback (optional)
    RUNNINGHUB_API_KEY=
    RUNNINGHUB_INSTANCE=plus
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

# Sentinel returned by adapters when a required key is missing — pages
# match against this prefix to render an i18n-friendly error.
ERR_MISSING_KEY_PREFIX = "MISSING_PIXELLE_"


@dataclass(frozen=True)
class LLMConfig:
    """LLM provider routing.

    ``primary`` is the provider used for every call by default. ``fallback``
    is consulted only when the primary raises (e.g. quota / rate limits).
    """

    primary: str = "deepseek"
    fallback: str | None = "gemini"
    deepseek_model: str = "deepseek-chat"
    gemini_model: str = "gemini-2.5-flash"

    @property
    def deepseek_key(self) -> str | None:
        return os.getenv("DEEPSEEK_API_KEY")

    @property
    def gemini_key(self) -> str | None:
        # Accept both naming conventions (Google's docs use both).
        return os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")


@dataclass(frozen=True)
class ComfyUIConfig:
    """ComfyUI endpoint configuration (local-first, cloud fallback).

    The :attr:`local_url` server is contacted first. If unreachable AND a
    :attr:`runninghub_api_key` is set, the client falls back to RunningHub
    cloud (https://runninghub.cn). Set ``cloud_only=True`` to skip local.
    """

    local_url: str = "http://127.0.0.1:8188"
    cloud_only: bool = False

    # RunningHub cloud (optional fallback)
    runninghub_base_url: str = "https://www.runninghub.cn"
    runninghub_instance: str = ""  # "" = 24GB VRAM, "plus" = 48GB VRAM

    # Default workflows (JSON files shipped under workflows/ in PR-A2)
    default_image_workflow: str = "image_flux.json"
    default_video_workflow: str = "video_wan2.1_fusionx.json"
    prompt_prefix: str = ""

    @property
    def runninghub_key(self) -> str | None:
        return os.getenv("RUNNINGHUB_API_KEY")

    @property
    def cloud_available(self) -> bool:
        return bool(self.runninghub_key)


@dataclass(frozen=True)
class GrokConfig:
    """grok.com / xAI configuration for the visual-provider chain.

    Auth is **runtime-only**: PR-A4.2 ships a Playwright-driven login
    flow that captures a session in :class:`st.session_state` after
    the user enters their grok.com email + password in the Streamlit
    UI. There are no env vars to manage, no API key to paste, and
    nothing is persisted to disk.

    This class exists as a placeholder so the rest of the
    :class:`PixelleConfig` shape stays consistent — the field is
    populated lazily by the page that owns the session and never
    inspected at module load time.
    """

    auth_kind: str = "browser_login"  # informational; not user-tunable


@dataclass(frozen=True)
class TTSConfig:
    """Text-to-speech configuration.

    Edge-TTS (default) is free and key-less. ``voice`` is a Microsoft Edge
    voice short-name (e.g. ``en-US-AriaNeural``, ``vi-VN-HoaiMyNeural``).
    """

    engine: str = "edge-tts"
    voice: str = "en-US-AriaNeural"
    rate: str = "+0%"
    volume: str = "+0%"


@dataclass(frozen=True)
class PixelleConfig:
    """Top-level Pixelle configuration."""

    llm: LLMConfig = field(default_factory=LLMConfig)
    comfy: ComfyUIConfig = field(default_factory=ComfyUIConfig)
    grok: GrokConfig = field(default_factory=GrokConfig)
    tts: TTSConfig = field(default_factory=TTSConfig)

    def describe(self) -> dict[str, str]:
        """Return a redacted summary suitable for showing in a UI status pane."""
        return {
            "llm.primary": self.llm.primary,
            "llm.fallback": self.llm.fallback or "(none)",
            "llm.deepseek_key": "set" if self.llm.deepseek_key else "missing",
            "llm.gemini_key": "set" if self.llm.gemini_key else "missing",
            "comfy.local_url": self.comfy.local_url,
            "comfy.cloud_available": "yes" if self.comfy.cloud_available else "no",
            "grok.auth_kind": self.grok.auth_kind,
            "tts.engine": self.tts.engine,
            "tts.voice": self.tts.voice,
        }


def load_config() -> PixelleConfig:
    """Build a :class:`PixelleConfig` from environment variables.

    All non-secret fields are overridable via env (e.g. ``COMFYUI_URL``,
    ``PIXELLE_TTS_VOICE``). Secrets are accessed through the per-provider
    properties (``LLMConfig.deepseek_key`` etc.) so they're never copied
    into the frozen dataclass.
    """
    return PixelleConfig(
        llm=LLMConfig(
            primary=os.getenv("PIXELLE_LLM_PRIMARY", "deepseek"),
            fallback=os.getenv("PIXELLE_LLM_FALLBACK", "gemini") or None,
            deepseek_model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        ),
        comfy=ComfyUIConfig(
            local_url=os.getenv("COMFYUI_URL", "http://127.0.0.1:8188"),
            cloud_only=os.getenv("COMFYUI_CLOUD_ONLY", "").lower() in {"1", "true", "yes"},
            runninghub_instance=os.getenv("RUNNINGHUB_INSTANCE", ""),
            default_image_workflow=os.getenv("PIXELLE_IMAGE_WORKFLOW", "image_flux.json"),
            default_video_workflow=os.getenv("PIXELLE_VIDEO_WORKFLOW", "video_wan2.1_fusionx.json"),
            prompt_prefix=os.getenv("PIXELLE_PROMPT_PREFIX", ""),
        ),
        tts=TTSConfig(
            engine=os.getenv("PIXELLE_TTS_ENGINE", "edge-tts"),
            voice=os.getenv("PIXELLE_TTS_VOICE", "en-US-AriaNeural"),
            rate=os.getenv("PIXELLE_TTS_RATE", "+0%"),
            volume=os.getenv("PIXELLE_TTS_VOLUME", "+0%"),
        ),
    )
