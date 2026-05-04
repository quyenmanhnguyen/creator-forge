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

# Vendored from tube-atlas-oss where the package was importable as
# ``core.pixelle.*`` (Streamlit ran with ``research/`` as cwd). Inside the
# FastAPI sidecar the package lives at ``research.core.pixelle.*``, so we
# alias ``core`` → ``research.core`` once here. This lets every submodule
# below keep its original ``from core.X import …`` style without touching
# legacy files.
import sys as _sys

import research.core as _research_core

_sys.modules.setdefault("core", _research_core)
_sys.modules.setdefault("core.pixelle", _sys.modules[__name__])

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
    MAX_VARIANTS_PER_SCENE,
    MIN_SCENE_COUNT,
    SCENE_TEMPLATES,
    TEMPLATE_KEYS,
    VISUAL_DNA_MAX_CHARS,
    LongFormScene,
    SceneTemplate,
    build_breakdown_system_prompt,
    build_breakdown_user_prompt,
    build_thumbnail_prompt,
    build_variant_system_prompt,
    build_variant_user_prompt,
    build_video_variant_system_prompt,
    build_video_variant_user_prompt,
    build_visual_dna_system_prompt,
    count_words,
    estimate_scene_count,
    estimate_total_duration_s,
    expand_image_variants,
    expand_video_variants_for_images,
    extract_visual_dna,
    generate_scene_breakdown,
    generate_scene_breakdown_with_dna,
    make_custom_template,
    parse_breakdown_response,
    parse_variant_response,
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
    scale_captions_to_duration,
    split_by_sentences,
)
from core.pixelle.tts import (
    DEFAULT_EDGE_FALLBACK_VOICE,
    DEFAULT_TTS_PROVIDER,
    KNOWN_TTS_PROVIDERS,
    EdgeTTSAdapter,
    ElevenLabsAdapter,
    PiperTTSAdapter,
    TTSAdapter,
    TTSResult,
    edge_voice_for_elevenlabs,
    is_elevenlabs_fatal_error,
    make_tts_adapter,
    resolve_piper_voice_path,
    synthesize,
)
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
    "MAX_VARIANTS_PER_SCENE",
    "MIN_SCENE_COUNT",
    "PRESET_NAMES",
    "PRESET_STYLES",
    "PROVIDER_NAMES",
    "SCENE_TEMPLATES",
    "STYLES",
    "TEMPLATE_KEYS",
    "VISUAL_DNA_MAX_CHARS",
    "Caption",
    "ComfyUIConfig",
    "ComfyUIVisualProvider",
    "ComposerOptions",
    "DEFAULT_EDGE_FALLBACK_VOICE",
    "DEFAULT_TTS_PROVIDER",
    "KNOWN_TTS_PROVIDERS",
    "EdgeTTSAdapter",
    "ElevenLabsAdapter",
    "PiperTTSAdapter",
    "edge_voice_for_elevenlabs",
    "is_elevenlabs_fatal_error",
    "make_tts_adapter",
    "resolve_piper_voice_path",
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
    "build_variant_system_prompt",
    "build_variant_user_prompt",
    "build_video_prompt_from_style",
    "build_video_variant_system_prompt",
    "build_video_variant_user_prompt",
    "build_visual_dna_system_prompt",
    "captions_to_srt",
    "count_words",
    "estimate_scene_count",
    "estimate_total_duration_s",
    "expand_image_variants",
    "expand_video_variants_for_images",
    "extract_visual_dna",
    "fallback_captions_from_text",
    "from_cloner_kit",
    "from_manual_reference",
    "from_preset",
    "generate_scene_breakdown",
    "generate_scene_breakdown_with_dna",
    "get_provider",
    "get_style",
    "group_word_boundaries",
    "list_provider_specs",
    "load_config",
    "make_custom_template",
    "make_short",
    "parse_breakdown_response",
    "parse_variant_response",
    "scale_captions_to_duration",
    "serialize_breakdown_json",
    "serialize_breakdown_md",
    "split_by_sentences",
    "split_script_into_scenes",
    "synthesize",
]
