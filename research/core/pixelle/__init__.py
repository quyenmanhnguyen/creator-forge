"""Pixelle-style production pipeline (vendored, Apache-2.0).

This subpackage provides the building blocks for turning a Studio script
into a finished short video:

- :mod:`core.pixelle.config` — provider configuration (local-first ComfyUI,
  RunningHub fallback, DeepSeek primary LLM, Gemini optional fallback).
- :mod:`core.pixelle.tts` — text-to-speech adapters (Edge-TTS by default).
- :mod:`core.pixelle.comfy_client` — async client for ComfyUI workflows.
- :mod:`core.pixelle.llm` — LLM provider abstraction over ``core.llm``.

PR-A1 ships only the building blocks (no Streamlit page yet). The Producer
page that wires these together will land in PR-A2.

See ``NOTICE`` and ``LICENSE-APACHE`` in this directory for upstream
attribution.
"""
from __future__ import annotations

from core.pixelle.composer import ComposerOptions, SceneAsset, VideoSceneAsset, make_short
from core.pixelle.config import (
    ComfyUIConfig,
    GrokConfig,
    LLMConfig,
    PixelleConfig,
    TTSConfig,
    load_config,
)
from core.pixelle.prompting import (
    PRESET_NAMES,
    PRESET_STYLES,
    ScenePrompt,
    StyleSource,
    build_image_prompt_from_style,
    build_scene_prompts,
    build_video_prompt_from_style,
    from_cloner_kit,
    from_manual_reference,
    from_preset,
    split_script_into_scenes,
)
from core.pixelle.scene_breakdown import (
    DEFAULT_WORDS_PER_MIN,
    DEFAULT_WORDS_PER_SCENE,
    MAX_SCENE_COUNT,
    MIN_SCENE_COUNT,
    SCENE_TEMPLATES,
    TEMPLATE_KEYS,
    LongFormScene,
    SceneTemplate,
    build_breakdown_system_prompt,
    build_breakdown_user_prompt,
    build_thumbnail_prompt,
    count_words,
    estimate_scene_count,
    estimate_total_duration_s,
    generate_scene_breakdown,
    make_custom_template,
    parse_breakdown_response,
    serialize_breakdown_json,
    serialize_breakdown_md,
)
from core.pixelle.styles import STYLES, Style, get_style
from core.pixelle.subtitles import (
    Caption,
    WordBoundary,
    captions_to_srt,
    fallback_captions_from_text,
    group_word_boundaries,
    split_by_sentences,
)
from core.pixelle.tts import EdgeTTSAdapter, TTSAdapter, TTSResult, synthesize
from core.pixelle.visual_providers import (
    DEFAULT_PROVIDER_NAME,
    PROVIDER_NAMES,
    ComfyUIVisualProvider,
    GeminiImageProvider,
    GoogleWhiskProvider,
    GrokImageProvider,
    PlaceholderVisualProvider,
    ProviderInfo,
    ProviderNotConfiguredError,
    ProviderNotImplementedError,
    UsePlaceholderFallback,
    VisualProvider,
    VisualProviderError,
    get_provider,
    list_provider_specs,
)

__all__ = [
    "DEFAULT_PROVIDER_NAME",
    "DEFAULT_WORDS_PER_MIN",
    "DEFAULT_WORDS_PER_SCENE",
    "MAX_SCENE_COUNT",
    "MIN_SCENE_COUNT",
    "PRESET_NAMES",
    "PRESET_STYLES",
    "PROVIDER_NAMES",
    "SCENE_TEMPLATES",
    "STYLES",
    "TEMPLATE_KEYS",
    "Caption",
    "ComfyUIConfig",
    "ComfyUIVisualProvider",
    "ComposerOptions",
    "EdgeTTSAdapter",
    "GeminiImageProvider",
    "GoogleWhiskProvider",
    "GrokConfig",
    "GrokImageProvider",
    "LLMConfig",
    "LongFormScene",
    "PixelleConfig",
    "PlaceholderVisualProvider",
    "ProviderInfo",
    "ProviderNotConfiguredError",
    "ProviderNotImplementedError",
    "SceneAsset",
    "ScenePrompt",
    "SceneTemplate",
    "Style",
    "StyleSource",
    "TTSAdapter",
    "TTSConfig",
    "TTSResult",
    "UsePlaceholderFallback",
    "VideoSceneAsset",
    "VisualProvider",
    "VisualProviderError",
    "WordBoundary",
    "build_breakdown_system_prompt",
    "build_breakdown_user_prompt",
    "build_image_prompt_from_style",
    "build_scene_prompts",
    "build_thumbnail_prompt",
    "build_video_prompt_from_style",
    "captions_to_srt",
    "count_words",
    "estimate_scene_count",
    "estimate_total_duration_s",
    "fallback_captions_from_text",
    "from_cloner_kit",
    "from_manual_reference",
    "from_preset",
    "generate_scene_breakdown",
    "get_provider",
    "get_style",
    "group_word_boundaries",
    "list_provider_specs",
    "load_config",
    "make_custom_template",
    "make_short",
    "parse_breakdown_response",
    "serialize_breakdown_json",
    "serialize_breakdown_md",
    "split_by_sentences",
    "split_script_into_scenes",
    "synthesize",
]
