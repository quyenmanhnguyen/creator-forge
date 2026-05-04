"""Producer route — port of pages/05_Producer.py.

Two modes:

* ``short`` — TTS + captions + 9:16 mp4 composite. Wires
  ``EdgeTTSAdapter.synthesize_with_timing`` → ``group_word_boundaries`` (or
  the sentence fallback) → ``make_short``.
* ``long_form`` / ``scene_breakdown`` — turn a long script into N scenes with
  paste-ready prompts for AutoGrok / Veo3 / Whisk. Once scenes are returned,
  the desktop's ``StoryboardBridge`` pipes them into ``ImageService.generateBatch``.

Robust failure mode (matches PR-1/2/3/4/5/6):

* Missing ``DEEPSEEK_API_KEY`` → 200 with empty ``scenes[]`` + a friendly
  ``"DEEPSEEK_API_KEY not set"`` warning, never 500.
* TTS / composer / serializer raises → 200 with the upstream message in
  ``warnings[]`` and any partial result still attached (e.g. audio survives
  even if the composer dies).
* Whitespace-only ``script`` is rejected as 422 via
  ``field_validator(mode='before')`` strip.
"""
from __future__ import annotations

import logging
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from research.core import llm
from research.core.pixelle import (
    DEFAULT_EDGE_FALLBACK_VOICE,
    DEFAULT_PROVIDER_NAME,
    MAX_VARIANTS_PER_SCENE,
    SCENE_TEMPLATES,
    STYLES,
    TEMPLATE_KEYS,
    Caption,
    ComposerOptions,
    DEFAULT_TTS_PROVIDER,
    KNOWN_TTS_PROVIDERS,
    EdgeTTSAdapter,
    edge_voice_for_elevenlabs,
    is_elevenlabs_fatal_error,
    make_tts_adapter,
    LongFormScene,
    SceneAsset,
    VideoSceneAsset,
    captions_to_srt,
    count_words,
    estimate_scene_count,
    estimate_total_duration_s,
    expand_image_variants,
    expand_video_variants_for_images,
    extract_visual_dna,
    fallback_captions_from_text,
    generate_scene_breakdown,
    group_word_boundaries,
    list_provider_specs,
    make_short,
    scale_captions_to_duration,
    serialize_breakdown_md,
)
from research.core.pixelle.assembler import (
    _concat_list_line,
    _resolve_ffmpeg,
)
from research.core.pixelle.video_probe import (
    MIN_FINAL_MP4_BYTES,
    MIN_USABLE_VIDEO_BYTES,
    probe_video_file,
    validate_video_output,
)
from research.core.pixelle.voices import VOICES, voice_short_names, voices_for_provider

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Helpers ────────────────────────────────────────────────────────────────

def _strip(v: object) -> object:
    return v.strip() if isinstance(v, str) else v


def _llm_warning(label: str, exc: Exception) -> str:
    if isinstance(exc, RuntimeError) and llm.ERR_NO_DEEPSEEK_KEY in str(exc):
        return f"{label} skipped: DEEPSEEK_API_KEY not set."
    return f"{label} failed: {type(exc).__name__}: {exc}"


def _make_chat_fn() -> Any:
    """Return a ``chat_fn(user, system) -> str`` bound to ``research.core.llm.chat``.

    ``generate_scene_breakdown`` defaults to ``from core.llm import chat`` —
    that import path is broken when called from inside the FastAPI sidecar
    (``core`` isn't on ``sys.path`` here; only ``research.core`` is). We
    bind the chat fn explicitly so the route never relies on the broken
    default.
    """

    def chat_fn(user: str, system: str) -> str:
        return llm.chat(user, system=system, temperature=0.6)

    return chat_fn


# ─── Schemas ────────────────────────────────────────────────────────────────

# ``Literal[*TEMPLATE_KEYS]`` would be nicer but the values come from runtime
# data — fall back to a plain ``str`` field with a runtime validator so the
# 422 message lists the supported keys.

class SceneBreakdownRequest(BaseModel):
    script: str = Field(..., min_length=1, description="Full long-form script (markdown OK).")
    template_key: str = Field(
        "cinematic",
        description=f"One of {TEMPLATE_KEYS} from research.core.pixelle.scene_breakdown.",
    )
    n_scenes: int | None = Field(
        None, ge=3, le=60,
        description="Force the scene count. ``None`` = auto-estimate from the script length.",
    )
    words_per_minute: int = Field(150, ge=90, le=200)
    language: Literal["en", "ko", "ja", "vi"] = "en"
    images_per_scene: int = Field(
        1,
        ge=1,
        le=MAX_VARIANTS_PER_SCENE,
        description=(
            "PR-26 — number of varied image prompts to expand per scene. "
            "When > 1, each scene gets an ``image_prompts`` list whose entries "
            "differ on ≥2 of (composition, lighting, camera angle, detail focus) "
            "and share the auto-extracted (or user-overridden) Visual DNA."
        ),
    )
    visual_dna_override: str | None = Field(
        None,
        description=(
            "PR-26 — user-supplied style anchor. When non-empty, skips the "
            "auto-extract LLM call and is appended to every variant prompt. "
            "When empty/None, the route extracts the Visual DNA from the script "
            "and echoes it in the response so the user can review/override."
        ),
    )

    _strip_script = field_validator("script", mode="before")(classmethod(lambda cls, v: _strip(v)))
    _strip_template = field_validator("template_key", mode="before")(classmethod(lambda cls, v: _strip(v)))

    @field_validator("template_key")
    @classmethod
    def _template_must_exist(cls, v: str) -> str:
        if v not in SCENE_TEMPLATES:
            raise ValueError(
                f"template_key must be one of {list(SCENE_TEMPLATES)}, got {v!r}"
            )
        return v


class SceneOut(BaseModel):
    scene_id: int
    title: str
    narration: str
    image_prompt: str
    flow_video_prompt: str
    duration_s: float = 0.0
    image_prompts: list[str] = Field(
        default_factory=list,
        description=(
            "PR-26 — paste-ready variant list when ``images_per_scene > 1``. "
            "Empty when only one prompt was requested. The legacy singular "
            "``image_prompt`` always carries the first variant so callers "
            "that don't know about variants keep working."
        ),
    )
    flow_video_prompts: list[str] = Field(
        default_factory=list,
        description=(
            "PR-48 — paste-ready video prompts paired 1:1 with "
            "``image_prompts``. ``flow_video_prompts[i]`` describes "
            "camera/subject motion that begins from the framing of "
            "``image_prompts[i]`` so the Storyboard Video batch reads "
            "as a smooth continuation of the Image batch above. Empty "
            "when ``images_per_scene <= 1`` (legacy single-image path); "
            "the singular ``flow_video_prompt`` carries the scene-level "
            "prompt for back-compat."
        ),
    )


class SceneBreakdownResponse(BaseModel):
    template_key: str
    template_label: str
    language: str
    words: int
    n_scenes_requested: int | None
    n_scenes_estimated: int
    n_scenes_returned: int
    total_duration_s_estimate: float
    scenes: list[SceneOut] = []
    md: str = ""
    visual_dna: str = Field(
        "",
        description=(
            "PR-26 — the style anchor used to expand variants. Either echoes "
            "the request's ``visual_dna_override`` (when present) or the "
            "auto-extracted summary derived from the script. Empty string when "
            "the override was empty AND the auto-extract LLM call failed."
        ),
    )
    images_per_scene: int = Field(
        1, description="PR-26 — echoes the request's ``images_per_scene``."
    )
    warnings: list[str] = []
    notes: str = ""


# ─── Endpoint ───────────────────────────────────────────────────────────────

@router.post("/scene_breakdown", response_model=SceneBreakdownResponse)
def scene_breakdown(req: SceneBreakdownRequest) -> SceneBreakdownResponse:
    """Long-form mode — split a finished script into N standalone scenes,
    each with an ultra-detailed image prompt + 3–4 sentence flow video prompt.
    """
    script = req.script.strip()
    template = SCENE_TEMPLATES[req.template_key]
    warnings: list[str] = []

    words = count_words(script)
    auto_n = estimate_scene_count(script)
    n_scenes_requested = req.n_scenes
    n_scenes = n_scenes_requested if n_scenes_requested is not None else auto_n
    total_duration_estimate = estimate_total_duration_s(
        script, words_per_minute=req.words_per_minute
    )

    scenes_out: list[SceneOut] = []
    md_blob = ""
    # Echo the user's override (if any) up front so the field stays
    # populated even when the LLM pipeline fails entirely.
    visual_dna_used = (req.visual_dna_override or "").strip()
    chat_fn = _make_chat_fn()

    # PR-26 — auto-extract Visual DNA in a separate LLM call only when
    # there's no override AND the caller actually wants variants. For
    # the legacy (``images_per_scene == 1``) path we skip the extra
    # call so token cost / latency stays exactly where it was.
    if not visual_dna_used and req.images_per_scene > 1:
        try:
            visual_dna_used = extract_visual_dna(script, chat_fn=chat_fn)
        except Exception as exc:  # noqa: BLE001 — boundary catch.
            msg = _llm_warning("Visual DNA extraction", exc)
            logger.warning(msg)
            warnings.append(msg)

    try:
        scenes_raw: list[LongFormScene] = generate_scene_breakdown(
            script,
            template=template,
            n_scenes=n_scenes,
            chat_fn=chat_fn,
            words_per_minute=req.words_per_minute,
            images_per_scene=req.images_per_scene,
            visual_dna_override=visual_dna_used,
            extract_dna=False,  # already handled above
        )
    except Exception as exc:  # noqa: BLE001 — boundary catch.
        msg = _llm_warning("Scene breakdown", exc)
        logger.warning(msg)
        warnings.append(msg)
        scenes_raw = []

    try:
        for s in scenes_raw:
            scenes_out.append(
                SceneOut(
                    scene_id=int(s.scene_id),
                    title=str(s.title),
                    narration=str(s.narration),
                    image_prompt=str(s.image_prompt),
                    flow_video_prompt=str(s.flow_video_prompt),
                    duration_s=float(s.duration_s or 0.0),
                    image_prompts=list(s.image_prompts or ()),
                    flow_video_prompts=list(s.flow_video_prompts or ()),
                )
            )
        md_blob = serialize_breakdown_md(scenes_raw, template=template)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Scene breakdown serialize failed: {type(exc).__name__}: {exc}")
        scenes_out = []
        md_blob = ""

    if not scenes_out and not warnings:
        # The LLM returned a non-error empty response (rare but possible —
        # parser couldn't find any "Scene N:" blocks). Surface a hint so the
        # caller doesn't show a silent empty grid.
        warnings.append(
            "Scene breakdown returned zero scenes — try a different template_key "
            "or shorten the script."
        )

    return SceneBreakdownResponse(
        template_key=template.key,
        template_label=template.label,
        language=req.language,
        words=words,
        n_scenes_requested=n_scenes_requested,
        n_scenes_estimated=auto_n,
        n_scenes_returned=len(scenes_out),
        total_duration_s_estimate=round(total_duration_estimate, 2),
        scenes=scenes_out,
        md=md_blob,
        visual_dna=visual_dna_used,
        images_per_scene=req.images_per_scene,
        warnings=warnings,
    )


# ─── PR-26: Visual DNA + variant prompt endpoints ───────────────────────────


class VisualDnaRequest(BaseModel):
    """POST body for ``/producer/visual_dna``."""

    script: str = Field(..., min_length=1, description="Long-form script (markdown OK).")

    _strip_script = field_validator("script", mode="before")(classmethod(lambda cls, v: _strip(v)))


class VisualDnaResponse(BaseModel):
    visual_dna: str = ""
    warnings: list[str] = []


@router.post("/visual_dna", response_model=VisualDnaResponse)
def visual_dna(req: VisualDnaRequest) -> VisualDnaResponse:
    """PR-26 — extract the script's Visual DNA in a single LLM call.

    Same robust-failure contract as :func:`scene_breakdown`: missing
    ``DEEPSEEK_API_KEY`` → 200 with empty ``visual_dna`` and a
    friendly warning, never 500.
    """
    warnings: list[str] = []
    try:
        dna = extract_visual_dna(req.script.strip(), chat_fn=_make_chat_fn())
    except Exception as exc:  # noqa: BLE001
        msg = _llm_warning("Visual DNA", exc)
        logger.warning(msg)
        warnings.append(msg)
        dna = ""
    return VisualDnaResponse(visual_dna=dna, warnings=warnings)


class VariantPromptsSceneIn(BaseModel):
    """Trimmed-down :class:`LongFormScene` shape accepted by the
    variant-prompts endpoint. Only the fields needed for variant
    expansion are required — ``narration`` is optional but boosts
    LLM context when supplied."""

    scene_id: int = 0
    title: str = ""
    narration: str = ""
    image_prompt: str = Field(..., min_length=1)
    flow_video_prompt: str = ""

    _strip_image_prompt = field_validator("image_prompt", mode="before")(
        classmethod(lambda cls, v: _strip(v))
    )


class VariantPromptsRequest(BaseModel):
    """POST body for ``/producer/variant_prompts``."""

    scene: VariantPromptsSceneIn
    count: int = Field(
        4,
        ge=1,
        le=MAX_VARIANTS_PER_SCENE,
        description="How many varied prompts to emit (capped at MAX_VARIANTS_PER_SCENE).",
    )
    visual_dna: str = Field(
        "",
        description=(
            "Style anchor appended verbatim to every variant. Pass the "
            "value the user is editing in the Visual DNA field; the "
            "endpoint won't auto-extract one for you here."
        ),
    )


class VariantPromptsResponse(BaseModel):
    prompts: list[str] = []
    video_prompts: list[str] = Field(
        default_factory=list,
        description=(
            "PR-48 — flow video prompts paired 1:1 with ``prompts``. "
            "Each entry describes camera/subject motion that begins "
            "from the framing of the corresponding image variant so "
            "the Storyboard Video batch carries continuity from the "
            "Image batch. Empty when the LLM call fell back to "
            "repeating the base flow video prompt (still safe to "
            "consume — caller can clamp to ``len(prompts)``)."
        ),
    )
    warnings: list[str] = []


@router.post("/variant_prompts", response_model=VariantPromptsResponse)
def variant_prompts(req: VariantPromptsRequest) -> VariantPromptsResponse:
    """PR-26 — expand a single base scene prompt into ``count`` varied
    paste-ready prompts.

    Used by the renderer when the user re-rolls variants without
    re-running scene_breakdown (e.g. after editing the Visual DNA
    override or bumping ``images_per_scene``).

    PR-48 — also expands ``count`` matching flow video prompts (each
    1:1 with the image variants) so the renderer can re-roll image
    + video variants in a single call. Returns an empty
    ``video_prompts`` list when the scene has no
    ``flow_video_prompt`` to seed the variant call from — callers
    should fall back to the scene-level prompt in that case.
    """
    warnings: list[str] = []
    scene = LongFormScene(
        scene_id=int(req.scene.scene_id or 0),
        title=req.scene.title or "",
        narration=req.scene.narration or "",
        image_prompt=req.scene.image_prompt,
        flow_video_prompt=req.scene.flow_video_prompt or "",
    )
    chat_fn = _make_chat_fn()
    try:
        prompts = expand_image_variants(
            scene,
            count=req.count,
            visual_dna=req.visual_dna or "",
            chat_fn=chat_fn,
        )
    except Exception as exc:  # noqa: BLE001
        msg = _llm_warning("Variant prompts", exc)
        logger.warning(msg)
        warnings.append(msg)
        # Degrade to repeating the base prompt so the caller still gets
        # exactly ``count`` entries (mirrors expand_image_variants's
        # in-process fallback path).
        prompts = [req.scene.image_prompt] * req.count

    video_prompts: list[str] = []
    # Only attempt the video-variant LLM call when the scene actually
    # carries a base ``flow_video_prompt`` AND the user wants more
    # than one variant. With count==1 there's nothing to vary, and
    # without a seed we'd just emit empties.
    if req.count > 1 and (req.scene.flow_video_prompt or "").strip():
        try:
            video_prompts = expand_video_variants_for_images(
                scene,
                list(prompts),
                chat_fn=chat_fn,
            )
        except Exception as exc:  # noqa: BLE001
            msg = _llm_warning("Variant video prompts", exc)
            logger.warning(msg)
            warnings.append(msg)
            video_prompts = [scene.flow_video_prompt] * len(prompts)
    return VariantPromptsResponse(
        prompts=prompts,
        video_prompts=video_prompts,
        warnings=warnings,
    )


# ─── Remaining shells (wired in later PRs) ──────────────────────────────────

class ThumbnailPromptRequest(BaseModel):
    title: str
    style: dict[str, Any] | None = None
    language: str = "en"


@router.post("/thumbnail_prompt")
def thumbnail_prompt(req: ThumbnailPromptRequest) -> dict:
    return {"prompt": "", "negative": "", "notes": "PR-0 shell. core.pixelle.prompting.build_thumbnail_prompt."}


# ─── /producer/short — TTS + captions + ffmpeg compose ─────────────────────

# Default placeholder provider name kept here for visibility; today
# ``compose_short`` always uses the gradient/Ken Burns placeholder background
# (real per-scene visuals land in PR-A3+ via ``visual_provider``).
_DEFAULT_VOICE = "en-US-AriaNeural"
_DEFAULT_STYLE = "violet-pink"


def _default_output_dir() -> Path:
    """Per-call output directory under ``~/.creator-forge/output/``.

    Stable, predictable, and avoids ``/tmp`` (which is wiped between
    machine restarts in some environments). Caller can override via
    ``ShortRequest.output_dir``.
    """
    base = Path.home() / ".creator-forge" / "output"
    return base / f"short-{int(time.time() * 1000)}"


class SceneAssetSpec(BaseModel):
    """One pre-rendered per-scene background image to splice into the
    composed short. Mirrors :class:`research.core.pixelle.SceneAsset`
    but as a request schema (validates types, leaves disk-existence
    checks to the route so a missing file becomes a friendly warning
    instead of a 422).
    """

    image_path: str = Field(..., min_length=1, description="Absolute path to a PNG/JPEG/WebP on disk (typically from ImageService.generateBatch.savedFiles).")
    start_s: float = Field(..., ge=0.0, description="Start time on the audio timeline in seconds.")
    duration_s: float = Field(..., gt=0.0, description="How long this image stays on screen in seconds.")

    _strip_path = field_validator("image_path", mode="before")(classmethod(lambda cls, v: _strip(v)))


class VideoSceneAssetSpec(BaseModel):
    """One pre-rendered per-scene motion clip to splice into the composed
    short. Mirrors :class:`research.core.pixelle.VideoSceneAsset` but as a
    request schema. Like :class:`SceneAssetSpec`, disk-existence checks
    are deferred to the route so a missing/unrenderable clip becomes a
    friendly warning + ``videos_missing++`` instead of a 422.

    Sourced from ``I2VService.generateBatch`` ``savedFile`` outputs in the
    typical AutoGrok/Veo3 pipeline; the bridge populates this list once
    each scene has produced a downloaded mp4.
    """

    video_path: str = Field(..., min_length=1, description="Absolute path to an mp4 on disk (typically from I2VService.generateBatch.savedFile).")
    start_s: float = Field(..., ge=0.0, description="Start time on the audio timeline in seconds.")
    duration_s: float = Field(..., gt=0.0, description="How long this clip stays on screen in seconds (composer trims/loops the source clip to fit).")

    _strip_path = field_validator("video_path", mode="before")(classmethod(lambda cls, v: _strip(v)))


class ShortRequest(BaseModel):
    script: str = Field(..., min_length=1, description="Full narration script (single voice).")
    tts_provider: str = Field(
        DEFAULT_TTS_PROVIDER,
        description=(
            "TTS engine id. One of "
            f"{list(KNOWN_TTS_PROVIDERS)}. "
            "'edge-tts' (default) uses Microsoft's online voices, free and "
            "requires internet. 'piper-tts' is a local, offline neural TTS "
            "(install `piper-tts` and place an .onnx voice under "
            "~/.creator-forge/piper-voices/<voice>.onnx). Unknown values "
            "fall back to edge-tts."
        ),
    )
    voice: str = Field(
        _DEFAULT_VOICE,
        description=(
            "Voice id. For edge-tts: short name like 'en-US-AriaNeural'. "
            "For piper-tts: an onnx model short name (e.g. "
            "'vi_VN-vais1000-medium') or absolute path to an .onnx file."
        ),
    )
    style: str = Field(_DEFAULT_STYLE, description=f"Background gradient style. One of {sorted(STYLES)}.")
    output_dir: str | None = Field(None, description="Where to write voice.mp3 / captions.srt / short.mp4. Defaults to ~/.creator-forge/output/short-<ts>/.")
    visual_provider: str = Field(DEFAULT_PROVIDER_NAME, description="Visual provider id (image source). Today only 'placeholder' is wired into the composer; other providers are reported via /producer/providers.")
    aspect: Literal["9:16"] = Field("9:16", description="Output aspect. Composer currently hard-codes 1080×1920.")
    write_srt: bool = Field(True, description="Write a sibling .srt next to the mp4.")
    scene_assets: list[SceneAssetSpec] | None = Field(
        None,
        description=(
            "Optional per-scene background images. Each entry pins one image to a "
            "[start_s, start_s+duration_s] window on the audio timeline. When "
            "provided, the composer skips the gradient placeholder and Ken-Burns "
            "the supplied images instead. Missing files are skipped with a warning "
            "(not a 422) so a partial AutoGrok batch still composes."
        ),
    )
    video_scene_assets: list[VideoSceneAssetSpec] | None = Field(
        None,
        description=(
            "Optional per-scene motion clips (e.g. Grok I2V / Veo3 mp4s). When at "
            "least one resolves to an existing file, the composer prefers the "
            "video timeline over still images (``video_scene_assets`` wins over "
            "``scene_assets`` per scene-priority — see "
            ":func:`research.core.pixelle.composer.make_short`). Each entry pins "
            "one clip to a [start_s, start_s+duration_s] window; the composer "
            "trims clips longer than ``duration_s`` and loops clips that are "
            "shorter. Missing files are skipped with a warning (not a 422) so a "
            "partial I2V batch still composes — if every video drops out and "
            "``scene_assets`` was supplied, the route falls back to images."
        ),
    )

    _strip_script = field_validator("script", mode="before")(classmethod(lambda cls, v: _strip(v)))
    _strip_voice = field_validator("voice", mode="before")(classmethod(lambda cls, v: _strip(v)))
    _strip_style = field_validator("style", mode="before")(classmethod(lambda cls, v: _strip(v)))


class ShortResponse(BaseModel):
    mp4_path: str
    audio_path: str
    srt_path: str | None = None
    duration_s: float = 0.0
    voice: str
    engine: str
    style: str
    captions_count: int = 0
    caption_source: Literal["word_boundaries", "sentence_fallback", "none"] = "none"
    visual_provider: str
    output_dir: str
    scenes_used: int = 0
    scenes_missing: int = 0
    videos_used: int = 0
    videos_missing: int = 0
    warnings: list[str] = []
    notes: str = ""


# Indirection for tests: monkeypatch these names on the module to swap in
# fakes without touching ``research.core.pixelle``. ``_tts_adapter_factory``
# is preserved for back-compat with PR-20E tests; new code routes through
# :func:`_resolve_tts_adapter` below, which honours the request's
# ``tts_provider`` field while still allowing tests to monkeypatch
# ``_tts_adapter_factory`` to short-circuit the registry.
_tts_adapter_factory = EdgeTTSAdapter
_tts_factory_func = make_tts_adapter


def _resolve_tts_adapter(provider: str | None):
    """Pick a TTS adapter for this request.

    Tests can still monkeypatch ``_tts_adapter_factory`` and get the same
    behaviour as before (factory is invoked with no args). When a request
    asks for a non-default provider (and the factory hasn't been
    monkeypatched), we route through :func:`make_tts_adapter` so the
    Producer page can swap engines without code changes.
    """
    factory = _tts_adapter_factory
    if factory is EdgeTTSAdapter:
        return _tts_factory_func(provider)
    return factory()


def _resolve_edge_fallback(
    *, primary_voice: str, primary_engine: str
) -> tuple[Any, str, str]:
    """Build an edge-tts fallback adapter for an ElevenLabs failure.

    Returns ``(adapter, voice, audio_format)`` with an
    :class:`EdgeTTSAdapter` and the locale-matched edge-tts voice (so a
    Rachel-EN-US ElevenLabs request falls back to en-US-AriaNeural, not
    a random voice). When the primary engine wasn't elevenlabs we still
    return the same triple — callers should only invoke this on
    confirmed fatal-elevenlabs paths.

    ``audio_format`` is always ``"mp3"`` because edge-tts writes mp3,
    even when the primary engine was elevenlabs (also mp3) or piper
    (wav). Callers writing into a per-scene ``.mp3`` path keep working
    without renaming files.
    """
    fallback_voice = (
        edge_voice_for_elevenlabs(primary_voice)
        if (primary_engine or "").lower() == "elevenlabs"
        else DEFAULT_EDGE_FALLBACK_VOICE
    )
    adapter = _tts_factory_func("edge-tts")
    return adapter, fallback_voice, "mp3"


_make_short = make_short
_validate_video_output = validate_video_output


@router.post("/short", response_model=ShortResponse)
def compose_short(req: ShortRequest) -> ShortResponse:
    """Render ``script`` to a 9:16 mp4 with Edge-TTS voiceover + captions.

    The flow is intentionally three independent stages so that a failure
    in compositing still surfaces the audio + caption files we already
    rendered:

    1. **TTS**: ``EdgeTTSAdapter.synthesize_with_timing`` writes ``voice.mp3``
       and (best-effort) per-word timing.
    2. **Captions**: word boundaries → ``group_word_boundaries`` if any,
       else ``fallback_captions_from_text`` over the audio duration.
       Optionally serialised to ``captions.srt``.
    3. **Compose**: ``make_short`` blends the audio + placeholder gradient
       Ken-Burns background + caption layer into ``short.mp4``.
    """
    script = req.script.strip()
    warnings: list[str] = []

    if req.style not in STYLES:
        warnings.append(
            f"Unknown style {req.style!r}; falling back to default {_DEFAULT_STYLE!r}. "
            f"Available: {sorted(STYLES)}."
        )
        style = _DEFAULT_STYLE
    else:
        style = req.style

    # PR-23: only check the curated Edge-TTS voice list when the request
    # actually targets edge-tts. The curated list is Edge-TTS specific
    # (`voice_short_names()` returns Microsoft voices) so blindly applying
    # it to Piper would emit a misleading "passing through to Edge-TTS"
    # warning on every Piper call.
    _provider_key = (req.tts_provider or DEFAULT_TTS_PROVIDER).strip().lower()
    if _provider_key == "edge-tts" and req.voice not in voice_short_names("edge-tts"):
        warnings.append(
            f"Voice {req.voice!r} is not in the curated list — passing through to Edge-TTS as-is."
        )

    output_dir = Path(req.output_dir).expanduser() if req.output_dir else _default_output_dir()
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        warnings.append(f"Could not create output_dir {output_dir}: {exc}")
        return ShortResponse(
            mp4_path="",
            audio_path="",
            srt_path=None,
            duration_s=0.0,
            voice=req.voice,
            engine=EdgeTTSAdapter.name,
            style=style,
            captions_count=0,
            caption_source="none",
            visual_provider=req.visual_provider,
            output_dir=str(output_dir),
            scenes_used=0,
            scenes_missing=len(req.scene_assets or []),
            videos_used=0,
            videos_missing=len(req.video_scene_assets or []),
            warnings=warnings,
        )

    # ─── Resolve scene_assets (existence check, gradient fallback) ──────
    # We deliberately do NOT 422 on missing files — a partial AutoGrok
    # batch (e.g. 5 of 8 scenes succeeded) should still compose with the
    # surviving frames + gradient gaps for the rest, mirroring the rest
    # of the suite's "warnings + partial result" pattern.
    resolved_scene_assets: list[SceneAsset] = []
    scenes_missing = 0
    for spec in req.scene_assets or []:
        p = Path(spec.image_path).expanduser()
        if not p.exists():
            scenes_missing += 1
            warnings.append(
                f"Scene asset skipped (file not found): {spec.image_path} "
                f"@ start={spec.start_s:.2f}s dur={spec.duration_s:.2f}s"
            )
            continue
        if not p.is_file():
            scenes_missing += 1
            warnings.append(
                f"Scene asset skipped (not a regular file): {spec.image_path}"
            )
            continue
        resolved_scene_assets.append(
            SceneAsset(
                image_path=p,
                start_s=float(spec.start_s),
                duration_s=float(spec.duration_s),
            )
        )

    # ─── Resolve video_scene_assets (PR-20A) ────────────────────────────
    # Same robust-failure contract as scene_assets above: a partial I2V
    # batch (e.g. 4 of 6 scenes produced a usable mp4) still composes,
    # with missing entries dropped + counted in ``videos_missing``. When
    # every video drops out the composer naturally falls back to the
    # ``scene_assets`` image path (and gradient if those are missing too)
    # — the priority chain lives in
    # :func:`research.core.pixelle.composer.make_short`.
    resolved_video_scene_assets: list[VideoSceneAsset] = []
    videos_missing = 0
    ffprobe_fallback_warned = False
    for spec in req.video_scene_assets or []:
        p = Path(spec.video_path).expanduser()
        if not p.exists():
            videos_missing += 1
            warnings.append(
                f"Video scene asset skipped (file not found): {spec.video_path} "
                f"@ start={spec.start_s:.2f}s dur={spec.duration_s:.2f}s"
            )
            continue
        if not p.is_file():
            videos_missing += 1
            warnings.append(
                f"Video scene asset skipped (not a regular file): {spec.video_path}"
            )
            continue
        # Probe the asset before handing it to make_short — a tiny /
        # truncated mp4 (the I2V download layer's 1KB floor lets these
        # through) would either render as a black hole inside the final
        # short or crash moviepy mid-compose. We drop the asset, count
        # it as missing, and surface the reason so the renderer can
        # show why the scene fell back to its image clip.
        check = _validate_video_output(p, min_bytes=MIN_USABLE_VIDEO_BYTES)
        if not check.ok:
            videos_missing += 1
            warnings.append(
                f"Video scene asset skipped (validation failed): {spec.video_path} "
                f"— {check.reason or 'unknown'}"
            )
            continue
        if not check.ffprobe_available and not ffprobe_fallback_warned:
            ffprobe_fallback_warned = True
            warnings.append(
                "ffprobe is not on PATH — video scene assets validated by "
                "size only. Install ffprobe (or set FFPROBE_PATH) to enable "
                "duration/stream checks."
            )
        resolved_video_scene_assets.append(
            VideoSceneAsset(
                video_path=p,
                start_s=float(spec.start_s),
                duration_s=float(spec.duration_s),
            )
        )

    audio_path = output_dir / "voice.mp3"
    mp4_path = output_dir / "short.mp4"
    srt_path = output_dir / "captions.srt"

    # ─── Step 1: TTS ─────────────────────────────────────────────────────
    audio_ok = False
    duration_s = 0.0
    captions: list[Caption] = []
    caption_source: Literal["word_boundaries", "sentence_fallback", "none"] = "none"
    engine_name = EdgeTTSAdapter.name

    try:
        adapter = _resolve_tts_adapter(req.tts_provider)
        engine_name = getattr(adapter, "name", EdgeTTSAdapter.name)
        tts_voice = req.voice
        try:
            tts_result = adapter.synthesize_with_timing(
                script, output_path=audio_path, voice=tts_voice
            )
        except Exception as exc:  # noqa: BLE001 — boundary catch.
            # HF-13 — auto-fallback to edge-tts on fatal ElevenLabs
            # error so the user still gets audio + captions even when
            # their key/IP is rate-limited or revoked.
            if (
                (engine_name or "").lower() == "elevenlabs"
                and is_elevenlabs_fatal_error(exc)
            ):
                fb_adapter, fb_voice, _fb_audio_format = _resolve_edge_fallback(
                    primary_voice=tts_voice,
                    primary_engine=engine_name,
                )
                warnings.append(
                    "ElevenLabs returned a fatal error "
                    f"({type(exc).__name__}: {exc}) — falling back to edge-tts "
                    f"voice {fb_voice!r}."
                )
                adapter = fb_adapter
                tts_voice = fb_voice
                engine_name = getattr(fb_adapter, "name", EdgeTTSAdapter.name)
                tts_result = adapter.synthesize_with_timing(
                    script, output_path=audio_path, voice=tts_voice
                )
            else:
                raise
        # PR-23: Piper writes ``.wav`` next to the requested ``.mp3``
        # path. Honour the actual ``audio_path`` reported by the
        # adapter so downstream stages (compose, response payload) see
        # the file that was actually written.
        if isinstance(getattr(tts_result, "audio_path", None), Path):
            audio_path = tts_result.audio_path
        audio_ok = audio_path.exists()
        duration_s = float(tts_result.duration_seconds or 0.0)

        # Step 2: captions — word boundaries are best, sentence fallback is
        # always available even when the engine doesn't surface them.
        if tts_result.word_boundaries:
            try:
                captions = group_word_boundaries(tts_result.word_boundaries)
                caption_source = "word_boundaries"
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Caption grouping failed: {type(exc).__name__}: {exc}")
                captions = []

        if not captions:
            try:
                captions = fallback_captions_from_text(
                    script, audio_duration_s=duration_s or 0.0
                )
                caption_source = "sentence_fallback" if captions else "none"
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"Caption fallback failed: {type(exc).__name__}: {exc}")
                captions = []
                caption_source = "none"
    except Exception as exc:  # noqa: BLE001 — boundary catch.
        msg = f"TTS failed: {type(exc).__name__}: {exc}"
        logger.warning(msg)
        warnings.append(msg)

    # ─── Step 2b: optional SRT ───────────────────────────────────────────
    written_srt: Path | None = None
    if req.write_srt and captions:
        try:
            srt_path.write_text(captions_to_srt(captions), encoding="utf-8")
            written_srt = srt_path
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"SRT write failed: {type(exc).__name__}: {exc}")

    # ─── Step 3: compose mp4 ─────────────────────────────────────────────
    composed_ok = False
    if audio_ok and duration_s > 0:
        try:
            opts = ComposerOptions(style=style)
            _make_short(
                audio_path,
                mp4_path,
                captions=captions or None,
                duration_hint=duration_s or None,
                options=opts,
                scene_assets=resolved_scene_assets or None,
                video_scene_assets=resolved_video_scene_assets or None,
            )
            # Previously: ``composed_ok = mp4_path.exists()`` — that
            # accepts a 0-byte stub if moviepy crashed mid-write. Run the
            # same probe we use on inputs so a tiny / corrupt /
            # zero-stream final mp4 surfaces as a warning + an empty
            # ``mp4_path`` instead of being reported as a successful
            # render.
            final_check = _validate_video_output(
                mp4_path, min_bytes=MIN_FINAL_MP4_BYTES
            )
            composed_ok = bool(final_check.ok)
            if not composed_ok and mp4_path.exists():
                warnings.append(
                    f"Composed mp4 failed validation: {final_check.reason or 'unknown'}"
                )
            elif composed_ok and not final_check.ffprobe_available and not ffprobe_fallback_warned:
                ffprobe_fallback_warned = True
                warnings.append(
                    "ffprobe is not on PATH — composed mp4 validated by size "
                    "only. Install ffprobe (or set FFPROBE_PATH) to enable "
                    "duration/stream checks."
                )
        except Exception as exc:  # noqa: BLE001
            msg = f"Compose failed: {type(exc).__name__}: {exc}"
            logger.warning(msg)
            warnings.append(msg)
    elif audio_ok and duration_s <= 0:
        # PR-23: format-aware troubleshooting hint. Piper writes WAV
        # (probed via stdlib `wave`, no extra dep) so suggesting
        # `mutagen` would be misleading.
        suffix = audio_path.suffix.lower()
        if suffix == ".wav":
            warnings.append(
                "Audio rendered but duration probe returned 0 — the WAV file "
                "may be truncated or corrupt; check the TTS log and confirm "
                "the writer flushed the file."
            )
        else:
            warnings.append(
                "Audio rendered but duration probe returned 0 — install "
                "'mutagen' for MP3 duration probing or pass a non-zero "
                "duration upstream."
            )

    return ShortResponse(
        mp4_path=str(mp4_path) if composed_ok else "",
        audio_path=str(audio_path) if audio_ok else "",
        srt_path=str(written_srt) if written_srt else None,
        duration_s=round(duration_s, 3),
        voice=req.voice,
        engine=engine_name,
        style=style,
        captions_count=len(captions),
        caption_source=caption_source,
        visual_provider=req.visual_provider,
        output_dir=str(output_dir),
        scenes_used=len(resolved_scene_assets),
        scenes_missing=scenes_missing,
        videos_used=len(resolved_video_scene_assets),
        videos_missing=videos_missing,
        warnings=warnings,
    )


# ─── /producer/audio — TTS + (optional) captions, no ffmpeg compose ─────────

# PR-30 — voiceover-first workflow. The user wants the narration MP3/WAV
# (and an SRT) without paying the ffmpeg / moviepy cost of building a
# 9:16 mp4 yet. They'll come back later through ``/producer/short`` (or
# the upcoming Video Assembly panel) once the visuals are ready.
#
# This route deliberately mirrors the TTS+captions stages of
# ``/producer/short`` instead of refactoring them out: keeping
# ``/producer/short`` byte-identical means the existing
# ``test_short_*`` regression tests stay valid evidence for the
# image+video composer pipeline. The shared logic is small enough that
# duplication is cheaper than the coupling a helper would introduce.


def _sum_scene_video_duration(
    scene_videos: list[str], *, warnings: list[str]
) -> float:
    """Sum video-stream durations for ``scene_videos`` via ffprobe.

    Used by ``/producer/audio`` to auto-scale captions so the SRT
    covers the assembled video. Robust-failure: a missing / unreadable
    / un-probable file appends a warning and is skipped, matching the
    rest of the route's contract.

    Returns 0.0 when ``scene_videos`` is empty or no probe yielded a
    usable duration — caller treats that as "no scaling".
    """
    durations = _per_scene_video_durations(scene_videos, warnings=warnings)
    return float(sum(d for d in durations if d > 0))


def _dedupe_per_scene_narrations(
    narrations: list[str], *, warnings: list[str]
) -> list[str]:
    """Strip duplicate per-scene narrations before TTS.

    Two scenes whose narrations are identical (case-insensitive and
    whitespace-collapsed) get TTS-rendered as the same audio twice
    and look like a "captions loop back to the beginning" bug at the
    final-mp4 stage. This is the producer-route safety net that runs
    AFTER the optional ``humanize_per_scene`` LLM rewrite, so it
    catches duplicates from any source — DeepSeek's rewrite output,
    a buggy upstream linear chunker, or a user who pasted the same
    sentence twice.

    For each duplicate slot we blank the entry (empty string), which
    the per-scene synth handles by inserting silence the length of
    that scene's video instead of re-speaking the line. The first
    occurrence is kept verbatim. Each blanked scene is surfaced in
    ``warnings`` so the renderer can show the user.
    """
    seen: set[str] = set()
    out: list[str] = []
    for i, narration in enumerate(narrations):
        text = (narration or "").strip()
        norm = " ".join(text.lower().split())
        if not norm:
            out.append(text)
            continue
        if norm not in seen:
            seen.add(norm)
            out.append(text)
            continue
        warnings.append(
            f"Scene {i + 1} narration duplicates an earlier scene — "
            "blanking to silence to avoid a 'captions repeat at the "
            "end of the video' bug. Edit the per-scene narrations to "
            "use distinct lines if this scene should still have voice."
        )
        out.append("")
    return out


def _per_scene_video_durations(
    scene_videos: list[str], *, warnings: list[str]
) -> list[float]:
    """Probe each scene video and return per-scene durations (seconds).

    Mirrors :func:`_sum_scene_video_duration`'s robustness contract but
    keeps the per-scene granularity needed by the per-scene-narration
    flow (each scene's audio is padded / shifted independently). A
    missing / un-probable file lands at ``0.0`` in the returned list
    and a warning is appended; callers treat ``0.0`` as "no usable
    duration for this scene".
    """
    out: list[float] = []
    if not scene_videos:
        return out
    for raw in scene_videos:
        path = (raw or "").strip()
        if not path:
            out.append(0.0)
            continue
        try:
            probe = probe_video_file(path)
        except Exception as exc:  # noqa: BLE001 — never let the route 500.
            warnings.append(
                f"Scene video probe failed for {path!r}: {type(exc).__name__}: {exc}"
            )
            out.append(0.0)
            continue
        if not probe.exists:
            warnings.append(f"Scene video missing: {path}")
            out.append(0.0)
            continue
        dur = (
            probe.video_stream_duration_sec
            if probe.video_stream_duration_sec is not None
            else probe.duration_sec
        )
        if dur is None or dur <= 0:
            if not probe.ffprobe_available:
                warnings.append(
                    f"ffprobe not available — cannot measure {path}, "
                    "captions will not be scaled."
                )
            else:
                warnings.append(f"ffprobe returned no duration for {path}.")
            out.append(0.0)
            continue
        out.append(float(dur))
    return out


def _default_audio_output_dir() -> Path:
    """Per-call output dir for audio-only renders.

    Distinct from ``_default_output_dir()`` so an audio-only render and
    a short render started seconds apart don't collide on the same
    ``short-<ts>/`` folder, and the user can tell at a glance which
    runs were audio-only.
    """
    base = Path.home() / ".creator-forge" / "output"
    return base / f"audio-{int(time.time() * 1000)}"


# ``edge-tts`` and ``elevenlabs`` write mp3, ``piper-tts`` writes wav.
# The route reflects the actual format back in the response so the
# renderer doesn't have to guess from the extension.
_AUDIO_FORMAT_BY_PROVIDER: dict[str, Literal["mp3", "wav"]] = {
    "edge-tts": "mp3",
    "piper-tts": "wav",
    "elevenlabs": "mp3",
}


class AudioOnlyRequest(BaseModel):
    script: str = Field(..., min_length=1, description="Full narration script (single voice).")
    # Per-scene narration — one entry per storyboard scene, in playback
    # order. When this list is non-empty (and at least one entry is
    # non-blank) the route runs **per-scene TTS**: each scene is
    # synthesised independently, padded with silence to match the
    # corresponding ``scene_videos`` duration when shorter, then
    # concatenated into ``voice.mp3`` so the narration tracks the
    # storyboard beat-by-beat instead of dumping the whole script onto
    # one timeline. The SRT is built per-scene with each scene's
    # captions time-shifted by the cumulative scene start so they
    # align with the assembled video's timeline.
    #
    # ``script`` remains required for back-compat (legacy clients only
    # set ``script``) — when ``scene_narrations`` is non-empty it
    # supersedes ``script`` for synthesis but ``script`` is still used
    # as the sentence-fallback source if a TTS engine fails to surface
    # word boundaries.
    scene_narrations: list[str] = Field(
        default_factory=list,
        description=(
            "Optional per-scene narration texts (one per scene, in playback "
            "order). When non-empty and at least one entry has content, the "
            "route TTS-synthesises each scene independently, pads each "
            "scene's audio with silence to match the corresponding "
            "``scene_videos`` duration when shorter, concatenates them into "
            "the final voice file, and emits per-scene captions time-shifted "
            "to align with the assembled video timeline. ``script`` is then "
            "treated as a back-compat field only. When empty (legacy "
            "behavior), the entire ``script`` is rendered as one TTS pass."
        ),
    )
    tts_provider: str = Field(
        DEFAULT_TTS_PROVIDER,
        description=(
            "TTS engine id. One of "
            f"{list(KNOWN_TTS_PROVIDERS)}. Same semantics as /producer/short."
        ),
    )
    voice: str = Field(
        _DEFAULT_VOICE,
        description=(
            "Voice id. For edge-tts: short name like 'en-US-AriaNeural'. "
            "For piper-tts: an .onnx voice short name or absolute path."
        ),
    )
    output_dir: str | None = Field(
        None,
        description=(
            "Where to write voice.mp3 / voice.wav / captions.srt. Defaults to "
            "~/.creator-forge/output/audio-<ts>/."
        ),
    )
    write_srt: bool = Field(
        True,
        description="Write a sibling captions.srt next to the audio file.",
    )
    # PR-A — auto-sync SRT timing to the assembled video. Renderer fills
    # ``scene_videos`` from the settled rows of the I2V/Veo3 batch above
    # the Compose panel; the route probes them with ffprobe and uses the
    # summed video-stream duration to scale captions so the soft-subs
    # cover the full visual track even if the TTS audio is shorter or
    # longer. ``target_duration_s`` is an explicit override (e.g. when
    # the user wants captions to fit a custom length); when both are
    # set the explicit value wins.
    scene_videos: list[str] = Field(
        default_factory=list,
        description=(
            "Optional absolute paths to per-scene mp4/mov/m4v/webm clips. "
            "When non-empty the route runs ffprobe on each file, sums the "
            "video-stream durations, and scales the captions so the last "
            "caption ends exactly at that duration. Missing/unreadable "
            "files are skipped with a warning instead of failing the "
            "request. When ``target_duration_s`` is also set, the explicit "
            "value wins."
        ),
    )
    target_duration_s: float | None = Field(
        None,
        ge=0.0,
        description=(
            "Explicit override for SRT timing. When > 0, captions are "
            "linearly scaled so the last caption ends at exactly this many "
            "seconds — useful when the user wants the SRT to fit a video "
            "of known length. When 0 / null, falls back to the summed "
            "duration of ``scene_videos`` (if any) or no scaling at all."
        ),
    )
    # Per-scene LLM humanise pass. When ``humanize_per_scene`` is true
    # and ``scene_narrations`` is non-empty, the route asks DeepSeek to
    # rewrite each narration so it (a) fits the actual ``scene_videos``
    # duration of its scene at a natural TTS cadence, and (b) describes
    # what is on screen during that scene (per ``scene_image_prompts``)
    # while staying faithful to the original ``script``. The original
    # scene_narrations entry is sent in as a starting point. Without
    # the LLM key (or on any LLM error) the route falls back to the
    # original scene_narrations and surfaces a warning.
    humanize_per_scene: bool = Field(
        False,
        description=(
            "When true and ``scene_narrations`` is non-empty, the route "
            "calls DeepSeek (``core.llm.refine_per_scene_narrations``) "
            "before TTS to rewrite each scene's narration so it fits the "
            "real ``scene_videos`` duration of its scene and matches the "
            "visual content described by ``scene_image_prompts``. Falls "
            "back to the original ``scene_narrations`` and emits a "
            "warning when DEEPSEEK_API_KEY is not set or the LLM call "
            "fails — never 500s."
        ),
    )
    scene_image_prompts: list[str] = Field(
        default_factory=list,
        description=(
            "Optional per-scene image prompts (one per scene, in playback "
            "order, parallel to ``scene_narrations`` and ``scene_videos``). "
            "When ``humanize_per_scene`` is true the LLM uses these to "
            "anchor each refined narration to what's visible on screen "
            "during that scene. Ignored when ``humanize_per_scene`` is "
            "false."
        ),
    )
    humanize_language: str = Field(
        "English",
        description=(
            "Human-readable language label passed to the LLM rewrite "
            "(e.g. \"English\", \"Vietnamese\"). Only used when "
            "``humanize_per_scene`` is true."
        ),
    )
    # HF-10 — speech rate control for edge-tts. Format mirrors the
    # ``rate`` parameter on ``edge_tts.Communicate``: ``"+0%"`` is
    # native cadence, ``"+20%"`` is 20% faster, ``"-30%"`` is 30%
    # slower. The renderer maps a slider (-50…+100 integer) to this
    # string format. Piper-tts ignores the rate (its synthesis tempo
    # is baked into the .onnx model). When the value can't be parsed
    # by edge-tts it surfaces as a warning rather than failing the
    # whole call.
    rate: str = Field(
        "+0%",
        description=(
            "Edge-TTS speech rate as a signed percentage string "
            "(e.g. '+0%', '+20%', '-30%'). Default '+0%' is the "
            "voice's native cadence. Piper-tts ignores this field. "
            "Stored on the adapter and passed to "
            "``edge_tts.Communicate(rate=...)`` for both per-scene "
            "and single-pass synthesis paths."
        ),
    )

    _strip_script = field_validator("script", mode="before")(classmethod(lambda cls, v: _strip(v)))
    _strip_voice = field_validator("voice", mode="before")(classmethod(lambda cls, v: _strip(v)))

    @field_validator("scene_videos", mode="before")
    @classmethod
    def _strip_scene_videos(cls, v: object) -> object:
        if not isinstance(v, list):
            return v
        cleaned: list[str] = []
        for item in v:
            if isinstance(item, str):
                stripped = item.strip()
                if stripped:
                    cleaned.append(stripped)
            elif item is not None:
                cleaned.append(str(item))
        return cleaned

    @field_validator("scene_narrations", mode="before")
    @classmethod
    def _strip_scene_narrations(cls, v: object) -> object:
        # Preserve list length (so the i-th entry still aligns with the
        # i-th scene_video) but normalise individual entries: ``None``
        # / non-string → ``""``; trailing whitespace is stripped. We
        # do NOT drop blank entries here — a blank narration for scene
        # k means "no voice for this scene, just silence under the
        # video", and the route honours that by writing a silent
        # segment of the matching scene-video duration.
        if not isinstance(v, list):
            return v
        cleaned: list[str] = []
        for item in v:
            if isinstance(item, str):
                cleaned.append(item.strip())
            elif item is None:
                cleaned.append("")
            else:
                cleaned.append(str(item).strip())
        return cleaned

    @field_validator("scene_image_prompts", mode="before")
    @classmethod
    def _strip_scene_image_prompts(cls, v: object) -> object:
        # Same shape contract as ``_strip_scene_narrations`` — preserve
        # list length so index ``i`` still points at scene ``i``'s
        # image prompt, but coerce non-string / None to empty string.
        if not isinstance(v, list):
            return v
        cleaned: list[str] = []
        for item in v:
            if isinstance(item, str):
                cleaned.append(item.strip())
            elif item is None:
                cleaned.append("")
            else:
                cleaned.append(str(item).strip())
        return cleaned


class AudioOnlyResponse(BaseModel):
    audio_path: str
    audio_format: Literal["mp3", "wav"]
    srt_path: str | None = None
    duration_s: float = 0.0
    voice: str
    engine: str
    captions_count: int = 0
    caption_source: Literal["word_boundaries", "sentence_fallback", "none"] = "none"
    output_dir: str
    warnings: list[str] = []
    notes: str = ""
    # PR-A — surfaced so the renderer can show "captions scaled to Ns"
    # without having to compare audio_duration vs scene_videos
    # client-side. Both fields default to "no scaling happened" so old
    # responses (pre-PR-A clients) keep parsing.
    target_duration_s: float = 0.0
    captions_scaled: bool = False
    # Per-scene narration mode (default 0 = off). Equal to the number
    # of scene_narrations slots that successfully synthesised + were
    # concatenated into ``audio_path``. The renderer surfaces this so
    # the user can confirm "yes, voice was rendered per-scene, not
    # from the full script".
    scenes_rendered: int = 0
    # Per-scene LLM humanise pass (default false = off). True when the
    # route successfully ran ``llm.refine_per_scene_narrations`` and
    # used the refined narrations for TTS (instead of the raw chunks
    # the renderer originally split off the script). The renderer
    # surfaces this so the user can confirm whether the audio
    # reflected the LLM-tuned narrations or the raw split.
    humanized_per_scene: bool = False


@dataclass
class _PerSceneSynthResult:
    """Outcome of synthesising one scene's narration as part of the
    per-scene audio flow. Pure data so the orchestrator stays testable
    without ffmpeg present.
    """

    audio_path: Path  # Empty Path when synth failed for this slot.
    duration_s: float = 0.0
    captions: list[Caption] = field(default_factory=list)
    caption_source: Literal["word_boundaries", "sentence_fallback", "none"] = "none"
    target_duration_s: float = 0.0  # 0 → no scene_videos pin for this slot
    pad_silence_s: float = 0.0  # silence to append to reach target_duration_s
    final_segment_duration_s: float = 0.0  # max(duration_s, target_duration_s)
    # Set when this scene was a blank narration AND we couldn't fall
    # back to silent video alignment (no scene_video duration). Used
    # by the orchestrator to skip the slot rather than bake an empty
    # segment into the final audio.
    skipped: bool = False
    skip_reason: str = ""


def _ffmpeg_concat_audio_segments(
    segments: list[Path],
    *,
    silence_pads_s: list[float],
    output_path: Path,
    audio_format: Literal["mp3", "wav"],
    timeout_s: float = 600.0,
) -> tuple[bool, str]:
    """Concatenate per-scene audio files (+ optional silence pads) via ffmpeg.

    Each ``segments[i]`` is the synthesised audio for scene ``i``;
    ``silence_pads_s[i]`` is appended after that scene's audio to fit
    the corresponding scene_video duration. Returns
    ``(ok, error_message)``. Never raises — caller decides how to
    surface the failure to the user via ``warnings``.

    Implementation: writes a concat-demuxer list pointing at the
    segment files, generates the silent pads via ``anullsrc`` filter,
    then runs ``ffmpeg -f concat -safe 0 -i list.txt -c:a libmp3lame``
    (or pcm_s16le for wav). To keep the concat demuxer happy across
    codec/sample-rate variations we re-encode rather than copying
    streams.

    The silence pads are baked in by interleaving silent files into
    the concat list. We synthesise them with
    ``-f lavfi -i anullsrc=...`` per pad, write to a per-pad temp file,
    and unlink them after concat returns.
    """
    binary = _resolve_ffmpeg()
    if not binary:
        return False, "ffmpeg not on PATH and FFMPEG_PATH not set"
    if not segments:
        return False, "no per-scene audio segments to concatenate"
    if len(silence_pads_s) != len(segments):
        return False, (
            f"silence_pads_s length {len(silence_pads_s)} != segments {len(segments)}"
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    work_dir = output_path.parent
    list_path = work_dir / f"_scene_audio_list_{int(time.time() * 1000)}.txt"
    silence_paths: list[Path] = []

    try:
        # 1. Generate silence pads (one file per non-zero pad).
        for i, pad_s in enumerate(silence_pads_s):
            if pad_s <= 0.001:
                silence_paths.append(Path(""))
                continue
            silence_path = work_dir / f"_silence_{i}_{int(time.time() * 1000)}.{audio_format}"
            silence_paths.append(silence_path)
            codec_args = (
                ["-c:a", "libmp3lame", "-b:a", "128k"]
                if audio_format == "mp3"
                else ["-c:a", "pcm_s16le"]
            )
            silence_cmd = [
                binary,
                "-y",
                "-loglevel", "error",
                "-f", "lavfi",
                "-i", f"anullsrc=channel_layout=mono:sample_rate=24000:duration={pad_s:.3f}",
                *codec_args,
                str(silence_path),
            ]
            try:
                proc = subprocess.run(  # noqa: S603 — controlled cmd, no shell=True.
                    silence_cmd,
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                return False, f"ffmpeg silence-pad {i} timed out after {timeout_s}s"
            if proc.returncode != 0:
                return False, (
                    f"ffmpeg silence-pad {i} failed: "
                    f"rc={proc.returncode} stderr={(proc.stderr or '').strip()[:400]}"
                )

        # 2. Build the concat list interleaving real segments and silence pads.
        concat_lines: list[str] = []
        for seg, sil in zip(segments, silence_paths):
            if seg and str(seg):
                concat_lines.append(_concat_list_line(seg))
            if sil and str(sil):
                concat_lines.append(_concat_list_line(sil))
        list_path.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")

        # 3. Run ffmpeg concat demuxer.
        codec_args = (
            ["-c:a", "libmp3lame", "-b:a", "128k"]
            if audio_format == "mp3"
            else ["-c:a", "pcm_s16le"]
        )
        concat_cmd = [
            binary,
            "-y",
            "-loglevel", "error",
            "-f", "concat",
            "-safe", "0",
            "-i", str(list_path),
            *codec_args,
            str(output_path),
        ]
        try:
            proc = subprocess.run(  # noqa: S603 — controlled cmd, no shell=True.
                concat_cmd,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return False, f"ffmpeg concat timed out after {timeout_s}s"
        if proc.returncode != 0:
            return False, (
                f"ffmpeg concat failed: "
                f"rc={proc.returncode} stderr={(proc.stderr or '').strip()[:400]}"
            )
        if not output_path.exists() or output_path.stat().st_size == 0:
            return False, f"ffmpeg concat completed but output is empty at {output_path}"
        return True, ""
    finally:
        # Best-effort cleanup of the staged list and silence files.
        try:
            if list_path.exists():
                list_path.unlink()
        except OSError:
            pass
        for sil in silence_paths:
            try:
                if sil and str(sil) and Path(sil).exists():
                    Path(sil).unlink()
            except OSError:
                pass


def _synthesize_per_scene_audio(
    scene_narrations: list[str],
    *,
    adapter: Any,
    voice: str,
    output_dir: Path,
    scene_video_durations: list[float],
    audio_format: Literal["mp3", "wav"],
    warnings: list[str],
    fallback_factory: Any = None,
) -> tuple[list[_PerSceneSynthResult], list[Caption]]:
    """Run TTS per-scene and pad each segment to its scene_video duration.

    Returns ``(per_scene_results, combined_captions)`` where
    ``combined_captions`` is the per-scene captions time-shifted by
    cumulative segment duration so they align with the final
    concatenated audio (which is also the assembled video timeline as
    long as ``scene_video_durations`` matches ``scene_narrations``).

    Robust-failure: a scene whose TTS raises is logged into
    ``warnings`` and replaced with silence the length of its
    ``scene_video_durations`` entry (or skipped entirely when no scene
    video duration is known for that slot — caller should treat the
    skip as "no entry in the final concat").

    HF-13 — when the primary adapter is :class:`ElevenLabsAdapter` and a
    scene hits a *fatal* ElevenLabs error (401 / 403 / quota / region —
    see :func:`is_elevenlabs_fatal_error`), we **swap the adapter sticky**
    for the rest of the batch. ``fallback_factory`` (a zero-arg callable
    returning ``(adapter, voice, audio_format)``) is invoked once on the
    first fatal hit, the failing scene is retried with the fallback
    adapter, and every subsequent scene also uses the fallback. A single
    warning summarises the swap so the user knows the audio came from
    edge-tts even though they picked elevenlabs in the dropdown.

    When ``fallback_factory`` is ``None`` (e.g. tests, or the request
    explicitly disables fallback) the legacy behaviour is preserved:
    the failing scene is replaced with silence and we keep using the
    primary adapter.
    """
    results: list[_PerSceneSynthResult] = []
    combined_captions: list[Caption] = []
    cumulative_offset_s = 0.0
    swapped_to_fallback = False

    for i, raw_narration in enumerate(scene_narrations):
        narration = (raw_narration or "").strip()
        target_dur = (
            float(scene_video_durations[i])
            if i < len(scene_video_durations) and scene_video_durations[i] > 0
            else 0.0
        )
        scene_path = output_dir / f"voice_scene_{i + 1:02d}.{audio_format}"

        if not narration:
            # Blank narration → silent segment for this scene's video
            # duration. If we don't have a scene_video duration we
            # have no way to size the silence, so we skip the slot
            # entirely (the user clearly intended scene_narrations to
            # be a sparse list and didn't pass scene_videos).
            if target_dur <= 0:
                results.append(
                    _PerSceneSynthResult(
                        audio_path=Path(""),
                        skipped=True,
                        skip_reason=(
                            f"scene {i + 1}: blank narration and no scene_video "
                            "duration — skipped from per-scene audio"
                        ),
                    )
                )
                warnings.append(results[-1].skip_reason)
                continue
            # Silence pad will be added by the concat helper; the
            # "segment" is just the silence so we record an empty
            # audio_path and a pad_silence_s of target_dur.
            results.append(
                _PerSceneSynthResult(
                    audio_path=Path(""),
                    duration_s=0.0,
                    captions=[],
                    caption_source="none",
                    target_duration_s=target_dur,
                    pad_silence_s=target_dur,
                    final_segment_duration_s=target_dur,
                )
            )
            cumulative_offset_s += target_dur
            continue

        # Real narration → TTS this scene independently.
        tts_result = None
        try:
            tts_result = adapter.synthesize_with_timing(
                narration, output_path=scene_path, voice=voice
            )
        except Exception as exc:  # noqa: BLE001 — boundary catch.
            # HF-13 — fatal ElevenLabs error (auth / quota / region) on
            # the primary adapter? Swap to edge-tts once for the rest of
            # this batch and retry the current scene with the fallback
            # adapter so we still surface audio for it.
            fallback_used = False
            if (
                not swapped_to_fallback
                and fallback_factory is not None
                and is_elevenlabs_fatal_error(exc)
            ):
                try:
                    fb_adapter, fb_voice, fb_audio_format = fallback_factory()
                except Exception as fb_exc:  # noqa: BLE001
                    warnings.append(
                        "ElevenLabs hit a fatal error and the edge-tts "
                        f"fallback could not be built: {type(fb_exc).__name__}: {fb_exc}"
                    )
                else:
                    swapped_to_fallback = True
                    fallback_used = True
                    warnings.append(
                        "ElevenLabs returned a fatal error "
                        f"({type(exc).__name__}: {exc}) — falling back to edge-tts "
                        f"voice {fb_voice!r} for scene {i + 1} and beyond."
                    )
                    adapter = fb_adapter
                    voice = fb_voice
                    audio_format = fb_audio_format
                    scene_path = output_dir / f"voice_scene_{i + 1:02d}.{audio_format}"
                    try:
                        tts_result = adapter.synthesize_with_timing(
                            narration, output_path=scene_path, voice=voice
                        )
                    except Exception as fallback_exc:  # noqa: BLE001
                        warnings.append(
                            f"Scene {i + 1} edge-tts fallback also failed: "
                            f"{type(fallback_exc).__name__}: {fallback_exc}"
                        )
                        tts_result = None
            if tts_result is None:
                if not fallback_used:
                    warnings.append(
                        f"Scene {i + 1} TTS failed: {type(exc).__name__}: {exc}"
                    )
                # Replace with silence of scene_video length so the timeline
                # still makes sense; if we don't have a target duration,
                # skip this slot entirely (cumulative offset unchanged).
                if target_dur > 0:
                    results.append(
                        _PerSceneSynthResult(
                            audio_path=Path(""),
                            duration_s=0.0,
                            captions=[],
                            caption_source="none",
                            target_duration_s=target_dur,
                            pad_silence_s=target_dur,
                            final_segment_duration_s=target_dur,
                        )
                    )
                    cumulative_offset_s += target_dur
                else:
                    results.append(
                        _PerSceneSynthResult(
                            audio_path=Path(""),
                            skipped=True,
                            skip_reason=(
                                f"scene {i + 1}: TTS failed and no scene_video duration "
                                "to substitute silence — skipped"
                            ),
                        )
                    )
                continue
            # Else: fallback succeeded — fall through to result-processing.

        if isinstance(getattr(tts_result, "audio_path", None), Path):
            scene_path = tts_result.audio_path
        scene_dur = float(tts_result.duration_seconds or 0.0)

        # Build per-scene captions from word boundaries; fall back to
        # sentence split over the natural TTS duration. We do NOT
        # scale to target_dur here — captions are linked to the actual
        # voice they describe, not the silent padding that follows.
        scene_caps: list[Caption] = []
        scene_caption_source: Literal["word_boundaries", "sentence_fallback", "none"] = "none"
        if tts_result.word_boundaries:
            try:
                scene_caps = group_word_boundaries(tts_result.word_boundaries)
                scene_caption_source = "word_boundaries"
            except Exception as exc:  # noqa: BLE001
                warnings.append(
                    f"Scene {i + 1} caption grouping failed: "
                    f"{type(exc).__name__}: {exc}"
                )
                scene_caps = []
        if not scene_caps:
            try:
                scene_caps = fallback_captions_from_text(
                    narration, audio_duration_s=scene_dur or 0.0
                )
                scene_caption_source = "sentence_fallback" if scene_caps else "none"
            except Exception as exc:  # noqa: BLE001
                warnings.append(
                    f"Scene {i + 1} caption fallback failed: "
                    f"{type(exc).__name__}: {exc}"
                )
                scene_caps = []
                scene_caption_source = "none"

        # Pad with silence when narration is shorter than the scene
        # video; never truncate (audio is the master). When narration
        # is *longer* than the scene video, we keep the audio as-is
        # and warn the user — final_segment_duration_s is then >
        # target_duration_s, which means the assembled video will run
        # out of pixels before the audio runs out.
        if target_dur > 0 and scene_dur > 0:
            if scene_dur >= target_dur - 0.05:
                pad = 0.0
                if scene_dur > target_dur + 0.5:
                    warnings.append(
                        f"Scene {i + 1} narration is {scene_dur:.2f}s but "
                        f"scene_video is only {target_dur:.2f}s — final audio "
                        "will outrun the visual track for this scene."
                    )
                final_seg = scene_dur
            else:
                pad = float(target_dur) - float(scene_dur)
                final_seg = target_dur
        else:
            pad = 0.0
            final_seg = scene_dur

        # Time-shift this scene's captions to the assembled timeline.
        for cap in scene_caps:
            combined_captions.append(
                Caption(
                    start_s=float(cumulative_offset_s + cap.start_s),
                    end_s=float(cumulative_offset_s + cap.end_s),
                    text=cap.text,
                )
            )

        results.append(
            _PerSceneSynthResult(
                audio_path=scene_path,
                duration_s=scene_dur,
                captions=scene_caps,
                caption_source=scene_caption_source,
                target_duration_s=target_dur,
                pad_silence_s=pad,
                final_segment_duration_s=final_seg,
            )
        )
        cumulative_offset_s += final_seg

    return results, combined_captions


@router.post("/audio", response_model=AudioOnlyResponse)
def compose_audio(req: AudioOnlyRequest) -> AudioOnlyResponse:
    """Render ``script`` to a TTS audio file (+ optional captions.srt).

    Voiceover-first workflow: skip image/video compositing and just
    emit the narration. Two stages, both robust-failure (warnings, no
    500s) so a partial result still surfaces:

    1. **TTS**: same adapter wiring as ``/producer/short``. Edge-TTS
       writes ``voice.mp3``; Piper writes ``voice.wav``.
    2. **Captions**: word boundaries first, sentence fallback when the
       engine can't supply timing. Optionally serialised to
       ``captions.srt``.

    Per-scene mode: when ``scene_narrations`` is non-empty (and at
    least one entry has content) the route synthesises each scene
    independently and concatenates them into ``voice.mp3`` via ffmpeg
    so the narration tracks the storyboard beat-by-beat instead of
    rendering the full ``script`` as a single TTS pass. Per-scene
    captions are time-shifted by cumulative segment duration so they
    align with the assembled video timeline.
    """
    script = req.script.strip()
    warnings: list[str] = []

    _provider_key = (req.tts_provider or DEFAULT_TTS_PROVIDER).strip().lower()
    if _provider_key == "edge-tts" and req.voice not in voice_short_names("edge-tts"):
        warnings.append(
            f"Voice {req.voice!r} is not in the curated list — passing through to Edge-TTS as-is."
        )

    output_dir = (
        Path(req.output_dir).expanduser() if req.output_dir else _default_audio_output_dir()
    )
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        warnings.append(f"Could not create output_dir {output_dir}: {exc}")
        return AudioOnlyResponse(
            audio_path="",
            audio_format=_AUDIO_FORMAT_BY_PROVIDER.get(_provider_key, "mp3"),
            srt_path=None,
            duration_s=0.0,
            voice=req.voice,
            engine=EdgeTTSAdapter.name,
            captions_count=0,
            caption_source="none",
            output_dir=str(output_dir),
            warnings=warnings,
        )

    # Edge-TTS writes mp3; Piper writes wav. We pass an ``.mp3`` path
    # in for both; the Piper adapter rewrites the extension and
    # returns the actual ``.wav`` path back via ``TTSResult.audio_path``
    # — same convention as ``/producer/short``.
    audio_path = output_dir / "voice.mp3"
    srt_path = output_dir / "captions.srt"
    audio_format_default: Literal["mp3", "wav"] = _AUDIO_FORMAT_BY_PROVIDER.get(
        _provider_key, "mp3"
    )

    audio_ok = False
    duration_s = 0.0
    captions: list[Caption] = []
    caption_source: Literal["word_boundaries", "sentence_fallback", "none"] = "none"
    engine_name = EdgeTTSAdapter.name

    # Per-scene mode is enabled when the renderer sent at least one
    # non-blank narration entry. When all entries are blank we fall
    # back to the legacy single-pass TTS — there's nothing to render
    # per-scene and concatenating only silence wouldn't produce a
    # useful audio file.
    per_scene_active = any(bool((s or "").strip()) for s in req.scene_narrations)
    scenes_rendered = 0
    humanized_per_scene = False

    # Per-scene LLM humanise pass. Run BEFORE TTS so the rewritten
    # narrations (one per scene, sized to fit each scene's real
    # ``scene_videos`` duration and matched to its
    # ``scene_image_prompts``) replace the raw renderer-split chunks.
    # Robust-failure: any exception (missing key, network, malformed
    # JSON) surfaces as a warning and we fall back to the originals.
    effective_scene_narrations = list(req.scene_narrations)
    if per_scene_active and req.humanize_per_scene:
        scene_video_durations_for_llm = _per_scene_video_durations(
            req.scene_videos, warnings=warnings
        )
        scenes_payload: list[dict] = []
        for i, narration in enumerate(effective_scene_narrations):
            dur = (
                float(scene_video_durations_for_llm[i])
                if i < len(scene_video_durations_for_llm)
                else 0.0
            )
            img_prompt = (
                req.scene_image_prompts[i].strip()
                if i < len(req.scene_image_prompts)
                and isinstance(req.scene_image_prompts[i], str)
                else ""
            )
            scenes_payload.append({
                "index": i,
                "target_duration_s": dur,
                "image_prompt": img_prompt,
                "original_narration": narration,
            })
        try:
            refined = llm.refine_per_scene_narrations(
                original_script=script,
                scenes=scenes_payload,
                language=req.humanize_language or "English",
            )
            if isinstance(refined, list) and len(refined) == len(
                effective_scene_narrations
            ):
                effective_scene_narrations = [
                    (refined[i] or "").strip()
                    or effective_scene_narrations[i]
                    for i in range(len(effective_scene_narrations))
                ]
                humanized_per_scene = True
            else:
                warnings.append(
                    "Per-scene humanise returned an unexpected shape "
                    f"({type(refined).__name__}, len="
                    f"{len(refined) if isinstance(refined, list) else 'n/a'}) "
                    f"vs {len(effective_scene_narrations)} scenes — "
                    "using original scene_narrations."
                )
        except RuntimeError as exc:
            if llm.ERR_NO_DEEPSEEK_KEY in str(exc):
                warnings.append(
                    "Per-scene humanise skipped: DEEPSEEK_API_KEY not set "
                    "— using original scene_narrations."
                )
            else:
                warnings.append(
                    "Per-scene humanise failed: "
                    f"{type(exc).__name__}: {exc} — using original scene_narrations."
                )
        except Exception as exc:  # noqa: BLE001 — boundary catch.
            warnings.append(
                "Per-scene humanise failed: "
                f"{type(exc).__name__}: {exc} — using original scene_narrations."
            )

    if per_scene_active:
        # Defensive dedupe: even after the LLM rewrite (which now
        # dedupes internally) a stale linear-chunker upstream or a
        # user-supplied scene_narrations array can still hand us two
        # scenes with identical text. Two TTS-rendered scenes with
        # the same words look exactly like a "captions repeat at the
        # end of the video" bug to the user. Strip duplicates here
        # before synthesis and warn so the operator notices.
        effective_scene_narrations = _dedupe_per_scene_narrations(
            effective_scene_narrations, warnings=warnings
        )
        scene_video_durations = _per_scene_video_durations(
            req.scene_videos, warnings=warnings
        )
        try:
            adapter = _resolve_tts_adapter(req.tts_provider)
            engine_name = getattr(adapter, "name", EdgeTTSAdapter.name)
            # HF-10 — apply speech rate. Only edge-tts honours it
            # (Piper's tempo is baked into the .onnx model). We set
            # the attribute defensively via ``setattr`` so a swapped
            # adapter (e.g. test double) without a ``rate`` slot
            # doesn't crash the call.
            if req.rate and hasattr(adapter, "rate"):
                adapter.rate = req.rate
            primary_engine = getattr(adapter, "name", "")
            primary_voice = req.voice

            def _build_fallback() -> tuple[Any, str, str]:
                # HF-13 — only ElevenLabs benefits from auto-fallback;
                # piper/edge-tts errors are usually request-level and
                # should surface as scene-level failures (silence pad).
                if (primary_engine or "").lower() != "elevenlabs":
                    raise RuntimeError(
                        f"no fallback registered for engine {primary_engine!r}"
                    )
                return _resolve_edge_fallback(
                    primary_voice=primary_voice,
                    primary_engine=primary_engine,
                )

            per_scene_results, combined_captions = _synthesize_per_scene_audio(
                effective_scene_narrations,
                adapter=adapter,
                voice=req.voice,
                output_dir=output_dir,
                scene_video_durations=scene_video_durations,
                audio_format=audio_format_default,
                warnings=warnings,
                fallback_factory=_build_fallback,
            )
        except Exception as exc:  # noqa: BLE001 — boundary catch.
            msg = f"Per-scene TTS failed: {type(exc).__name__}: {exc}"
            logger.warning(msg)
            warnings.append(msg)
            per_scene_results = []
            combined_captions = []

        # Filter out skipped scenes (blank narration + no scene video
        # duration). Each remaining slot contributes an audio segment
        # (real narration OR pure silence at scene_video duration).
        live_segments = [r for r in per_scene_results if not r.skipped]
        if live_segments:
            audio_segments = [r.audio_path for r in live_segments]
            silence_pads = [r.pad_silence_s for r in live_segments]
            ok, err = _ffmpeg_concat_audio_segments(
                audio_segments,
                silence_pads_s=silence_pads,
                output_path=audio_path,
                audio_format=audio_format_default,
                timeout_s=600.0,
            )
            if ok:
                audio_ok = audio_path.exists()
                duration_s = float(
                    sum(r.final_segment_duration_s for r in live_segments)
                )
                captions = combined_captions
                # Caption source is "word_boundaries" if any scene
                # produced timed captions; falls back to
                # "sentence_fallback" / "none" otherwise.
                if any(r.caption_source == "word_boundaries" for r in live_segments):
                    caption_source = "word_boundaries"
                elif any(r.caption_source == "sentence_fallback" for r in live_segments):
                    caption_source = "sentence_fallback"
                else:
                    caption_source = "none"
                scenes_rendered = sum(
                    1 for r in live_segments if r.duration_s > 0 and r.audio_path
                )
                # Best-effort cleanup of the per-scene segment files
                # that survived the concat — they're redundant once
                # voice.mp3 exists.
                for seg in audio_segments:
                    try:
                        if seg and Path(seg).exists() and Path(seg) != audio_path:
                            Path(seg).unlink()
                    except OSError:
                        pass
            else:
                warnings.append(f"Per-scene audio concat failed: {err}")
                # Fall back to legacy single-pass synth so the user
                # still gets *some* audio rather than an empty result.
                per_scene_active = False
        else:
            warnings.append(
                "Per-scene narration: every slot was skipped — falling back to "
                "single-pass TTS over ``script``."
            )
            per_scene_active = False

    if not per_scene_active:
        try:
            adapter = _resolve_tts_adapter(req.tts_provider)
            engine_name = getattr(adapter, "name", EdgeTTSAdapter.name)
            # HF-10 — apply speech rate to the single-pass adapter.
            # Same attribute-set guard as the per-scene path so
            # unconventional adapters (Piper / tests) don't crash.
            if req.rate and hasattr(adapter, "rate"):
                adapter.rate = req.rate
            tts_voice = req.voice
            try:
                tts_result = adapter.synthesize_with_timing(
                    script, output_path=audio_path, voice=tts_voice
                )
            except Exception as exc:  # noqa: BLE001 — boundary catch.
                # HF-13 — same auto-fallback contract as the per-scene
                # path: when the user picked elevenlabs and the API
                # returned a fatal error (auth / quota / region), we
                # transparently retry the entire single-pass synth on
                # edge-tts so the call still produces audio.
                if (
                    (engine_name or "").lower() == "elevenlabs"
                    and is_elevenlabs_fatal_error(exc)
                ):
                    fb_adapter, fb_voice, _fb_audio_format = _resolve_edge_fallback(
                        primary_voice=tts_voice,
                        primary_engine=engine_name,
                    )
                    warnings.append(
                        "ElevenLabs returned a fatal error "
                        f"({type(exc).__name__}: {exc}) — falling back to edge-tts "
                        f"voice {fb_voice!r} for the full script."
                    )
                    if req.rate and hasattr(fb_adapter, "rate"):
                        fb_adapter.rate = req.rate
                    adapter = fb_adapter
                    tts_voice = fb_voice
                    engine_name = getattr(fb_adapter, "name", EdgeTTSAdapter.name)
                    tts_result = adapter.synthesize_with_timing(
                        script, output_path=audio_path, voice=tts_voice
                    )
                else:
                    raise
            if isinstance(getattr(tts_result, "audio_path", None), Path):
                audio_path = tts_result.audio_path
            audio_ok = audio_path.exists()
            duration_s = float(tts_result.duration_seconds or 0.0)

            if tts_result.word_boundaries:
                try:
                    captions = group_word_boundaries(tts_result.word_boundaries)
                    caption_source = "word_boundaries"
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"Caption grouping failed: {type(exc).__name__}: {exc}")
                    captions = []

            if not captions:
                try:
                    captions = fallback_captions_from_text(
                        script, audio_duration_s=duration_s or 0.0
                    )
                    caption_source = "sentence_fallback" if captions else "none"
                except Exception as exc:  # noqa: BLE001
                    warnings.append(f"Caption fallback failed: {type(exc).__name__}: {exc}")
                    captions = []
                    caption_source = "none"
        except Exception as exc:  # noqa: BLE001 — boundary catch.
            msg = f"TTS failed: {type(exc).__name__}: {exc}"
            logger.warning(msg)
            warnings.append(msg)

    # PR-A — auto-sync SRT timing to the assembled video. Resolve the
    # target duration before serialising to .srt so the file on disk
    # already reflects the scaling. ``target_duration_s`` (explicit
    # override) wins over ffprobe-derived ``scene_videos`` when both
    # are set.
    #
    # Per-scene mode skips this scaling because per-scene captions are
    # already aligned to the assembled video timeline (each scene's
    # captions cover its own slice; silence padding fills the gap to
    # the next scene). Re-scaling them linearly against the summed
    # duration would actually mis-align them.
    target_duration_s = 0.0
    if req.target_duration_s and req.target_duration_s > 0:
        target_duration_s = float(req.target_duration_s)
    elif req.scene_videos:
        target_duration_s = _sum_scene_video_duration(
            req.scene_videos, warnings=warnings
        )

    captions_scaled = False
    if not per_scene_active:
        if target_duration_s > 0 and captions:
            # Stretch / compress the existing captions linearly. If TTS
            # never produced timed captions but we have a script + target,
            # fall back to a sentence split spread across the target so the
            # video still has subtitles.
            captions = scale_captions_to_duration(captions, target_duration_s)
            captions_scaled = True
        elif target_duration_s > 0 and not captions:
            try:
                captions = fallback_captions_from_text(
                    script, audio_duration_s=target_duration_s
                )
                if captions:
                    caption_source = "sentence_fallback"
                    captions_scaled = True
            except Exception as exc:  # noqa: BLE001
                warnings.append(
                    f"Caption auto-fit fallback failed: {type(exc).__name__}: {exc}"
                )

        if target_duration_s > 0 and duration_s > target_duration_s + 0.05:
            warnings.append(
                f"Narration audio is {duration_s:.2f}s but target is "
                f"{target_duration_s:.2f}s — captions were compressed to fit "
                "the shorter video. Consider trimming the script."
            )

    written_srt: Path | None = None
    if req.write_srt and captions:
        try:
            srt_path.write_text(captions_to_srt(captions), encoding="utf-8")
            written_srt = srt_path
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"SRT write failed: {type(exc).__name__}: {exc}")

    audio_format: Literal["mp3", "wav"] = (
        "wav" if audio_path.suffix.lower() == ".wav" else "mp3"
    )

    return AudioOnlyResponse(
        audio_path=str(audio_path) if audio_ok else "",
        audio_format=audio_format,
        srt_path=str(written_srt) if written_srt else None,
        duration_s=round(duration_s, 3),
        voice=req.voice,
        engine=engine_name,
        captions_count=len(captions),
        caption_source=caption_source,
        output_dir=str(output_dir),
        warnings=warnings,
        target_duration_s=round(target_duration_s, 3),
        captions_scaled=captions_scaled,
        scenes_rendered=scenes_rendered,
        humanized_per_scene=humanized_per_scene,
    )


# --- /producer/refine_script -- LLM clean-up of dirty narration script ---

# When the user pastes upstream content (Studio output, JSON image-prompt
# blob, or a draft full of bracketed lists) into the Compose-audio script
# textarea, TTS reads the prompt syntax verbatim -- "negative_prompt nsfw
# fully nude" gets spoken aloud, the audio is unintelligible, and the
# user's only fix today is hand-editing the box. This route lets the
# Compose panel offer a "Refine script" button that calls DeepSeek to
# (a) extract the underlying storyline from whatever syntax surrounds it,
# (b) match the narration to the storyboard's image_prompts so the audio
# describes what's on screen, and (c) size the output to a target
# duration (sum of scene_videos via ffprobe, or an explicit override).
#
# Robust-failure: missing DEEPSEEK_API_KEY or any LLM error returns 200
# with the original script unchanged + a warning. Renderer surfaces the
# warning and keeps the textarea as-is.


class RefineScriptRequest(BaseModel):
    script: str = Field(
        ...,
        min_length=1,
        description=(
            "Raw input script -- may be storyline text, JSON image-prompt"
            " blob, draft with bracketed lists, or anything else the user"
            " pasted in. Will be cleaned into a single flowing narration."
        ),
    )
    scene_image_prompts: list[str] = Field(
        default_factory=list,
        description=(
            "Optional per-scene image prompts (one per scene, in playback"
            " order). The LLM uses these to anchor the cleaned narration"
            " to what's on screen during each scene."
        ),
    )
    scene_videos: list[str] = Field(
        default_factory=list,
        description=(
            "Optional absolute paths to per-scene mp4/mov/m4v/webm clips."
            " When non-empty (and ``target_duration_s`` is unset) the route"
            " runs ffprobe on each file and sums the video-stream"
            " durations to set the narration word budget."
        ),
    )
    target_duration_s: float | None = Field(
        None,
        ge=0.0,
        description=(
            "Explicit override for narration length budgeting (seconds)."
            " When > 0 the LLM sizes the output to fit roughly this"
            " duration at a natural TTS cadence. When unset / 0 falls back"
            " to the summed duration of ``scene_videos`` (if any), or no"
            " budget hint at all (LLM picks short)."
        ),
    )
    language: str = Field(
        "English",
        description=(
            "Human-readable language label passed to the LLM rewrite"
            ' (e.g. "English", "Vietnamese").'
        ),
    )

    _strip_script = field_validator("script", mode="before")(classmethod(lambda cls, v: _strip(v)))

    @field_validator("scene_image_prompts", mode="before")
    @classmethod
    def _strip_scene_image_prompts(cls, v: object) -> object:
        if not isinstance(v, list):
            return v
        cleaned: list[str] = []
        for item in v:
            if isinstance(item, str):
                cleaned.append(item.strip())
            elif item is None:
                cleaned.append("")
            else:
                cleaned.append(str(item).strip())
        return cleaned

    @field_validator("scene_videos", mode="before")
    @classmethod
    def _strip_scene_videos(cls, v: object) -> object:
        if not isinstance(v, list):
            return v
        cleaned: list[str] = []
        for item in v:
            if isinstance(item, str):
                stripped = item.strip()
                if stripped:
                    cleaned.append(stripped)
            elif item is not None:
                cleaned.append(str(item))
        return cleaned


class RefineScriptResponse(BaseModel):
    refined_script: str
    original_length: int = 0
    refined_length: int = 0
    target_duration_s: float = 0.0
    target_words: int = 0
    used_llm: bool = False
    warnings: list[str] = []


@router.post("/refine_script", response_model=RefineScriptResponse)
def refine_script(req: RefineScriptRequest) -> RefineScriptResponse:
    """Clean a raw input script into a TTS-ready narration via DeepSeek.

    Two responsibilities:

    1. **Sanitise**: extract the underlying storyline from whatever syntax
       surrounds it (JSON, prompt fragments, lists). Strip prompt-syntax
       tokens (``negative_prompt``, ``avoid``, comma-separated keyword
       lists, NSFW filter words) so TTS doesn't speak them aloud.
    2. **Size**: budget word count to ride the assembled video. The route
       computes target seconds from (a) explicit ``target_duration_s``,
       falling back to (b) summed ffprobe duration of ``scene_videos``.

    Robust-failure: missing ``DEEPSEEK_API_KEY`` and any LLM error are
    surfaced as warnings; the route returns the original script unchanged
    and ``used_llm=False`` so the renderer can present a clear status.
    """
    raw_script = req.script.strip()
    warnings: list[str] = []
    original_length = len(raw_script)

    target_duration_s = 0.0
    if req.target_duration_s is not None and req.target_duration_s > 0:
        target_duration_s = float(req.target_duration_s)
    elif req.scene_videos:
        target_duration_s = _sum_scene_video_duration(
            req.scene_videos, warnings=warnings
        )

    target_words = (
        max(20, int(round(target_duration_s * 2.5))) if target_duration_s > 0 else 0
    )

    try:
        refined = llm.refine_script_for_narration(
            raw_script=raw_script,
            scene_image_prompts=req.scene_image_prompts,
            target_duration_s=target_duration_s if target_duration_s > 0 else None,
            language=req.language or "English",
        )
    except RuntimeError as exc:
        msg = str(exc)
        if msg == llm.ERR_NO_DEEPSEEK_KEY:
            warnings.append(
                "Refine-script skipped: DEEPSEEK_API_KEY not set -- script"
                " unchanged. Set the key in your environment to enable LLM"
                " clean-up."
            )
        else:
            warnings.append(f"Refine-script LLM error: {msg}")
        return RefineScriptResponse(
            refined_script=raw_script,
            original_length=original_length,
            refined_length=original_length,
            target_duration_s=round(target_duration_s, 3),
            target_words=target_words,
            used_llm=False,
            warnings=warnings,
        )
    except Exception as exc:  # noqa: BLE001 -- never let the route 500.
        warnings.append(
            f"Refine-script failed: {type(exc).__name__}: {exc} --"
            " script unchanged."
        )
        return RefineScriptResponse(
            refined_script=raw_script,
            original_length=original_length,
            refined_length=original_length,
            target_duration_s=round(target_duration_s, 3),
            target_words=target_words,
            used_llm=False,
            warnings=warnings,
        )

    refined_clean = (refined or "").strip()
    if not refined_clean:
        warnings.append(
            "Refine-script returned empty output -- keeping original script."
        )
        return RefineScriptResponse(
            refined_script=raw_script,
            original_length=original_length,
            refined_length=original_length,
            target_duration_s=round(target_duration_s, 3),
            target_words=target_words,
            used_llm=False,
            warnings=warnings,
        )

    return RefineScriptResponse(
        refined_script=refined_clean,
        original_length=original_length,
        refined_length=len(refined_clean),
        target_duration_s=round(target_duration_s, 3),
        target_words=target_words,
        used_llm=True,
        warnings=warnings,
    )


# ─── /producer/soften_prompts — rewrite image prompts to bypass moderation ──

# HF-13 — when the user's storyboard prompts trip Grok / generic CDN
# moderation (returns ~80 KB blurred placeholders that the renderer's
# 100 KB gate demotes to ``fallback``), retrying the same prompt is
# wasted compute. This route asks DeepSeek to rewrite each prompt so
# explicit anatomy / fabric vocabulary is replaced with editorial
# equivalents (\"form-fitting silk slip\" instead of \"see-through wet-look
# transparent fabric revealing nipples\") while pose / lighting / camera
# / mood / style tags are preserved verbatim. The desktop renderer
# wires this to a \"✨ Mềm hoá prompts\" button on the Storyboard panel
# so a stuck row can be one-click rescued.
#
# Robust-failure: missing DEEPSEEK_API_KEY or any LLM error returns
# 200 with ``softened_prompts == prompts`` + warning. The renderer
# uses ``used_llm`` to decide whether to surface a success toast or
# the warning text.


class SoftenPromptsRequest(BaseModel):
    prompts: list[str] = Field(
        ...,
        min_length=1,
        description=(
            "Image prompts to soften, in storyboard order. The route preserves"
            " ordering and length in the response; an empty / blank entry is"
            " passed through unchanged."
        ),
    )
    language: str = Field(
        default="English",
        description=(
            "Language of the prompts (English / Vietnamese / Korean / ...)."
            " Used so the softener doesn't accidentally Anglicise prompts"
            " written in another language."
        ),
    )

    @field_validator("prompts", mode="before")
    @classmethod
    def _strip_prompts(cls, v: object) -> object:
        if not isinstance(v, list):
            return v
        cleaned: list[str] = []
        for item in v:
            if isinstance(item, str):
                cleaned.append(item.strip())
            elif item is None:
                cleaned.append("")
            else:
                cleaned.append(str(item))
        return cleaned


class SoftenPromptsResponse(BaseModel):
    softened_prompts: list[str]
    original_count: int
    softened_count: int
    used_llm: bool = False
    warnings: list[str] = []


@router.post("/soften_prompts", response_model=SoftenPromptsResponse)
def soften_prompts(req: SoftenPromptsRequest) -> SoftenPromptsResponse:
    """Rewrite a list of image prompts to be safe for CDN moderation.

    Robust-failure: missing key / LLM error returns 200 with the
    originals unchanged + a warning. ``used_llm=True`` is set only
    when the LLM actually produced rewrites, so the renderer can
    decide whether to celebrate or just surface the warning.
    """
    originals = [str(p or "") for p in req.prompts]
    warnings: list[str] = []
    n = len(originals)

    if n == 0 or all(not p.strip() for p in originals):
        # Defensive: pydantic min_length=1 guarantees at least one
        # entry, but every-blank is still a valid input shape.
        return SoftenPromptsResponse(
            softened_prompts=originals,
            original_count=n,
            softened_count=n,
            used_llm=False,
            warnings=["Soften skipped: every prompt was blank."] if n else [],
        )

    try:
        rewritten = llm.soften_image_prompts(
            originals, language=req.language or "English"
        )
    except RuntimeError as exc:
        msg = str(exc)
        if msg == llm.ERR_NO_DEEPSEEK_KEY:
            warnings.append(
                "Soften-prompts skipped: DEEPSEEK_API_KEY not set --"
                " prompts unchanged. Set the key in your environment to"
                " enable LLM rewrites."
            )
        else:
            warnings.append(f"Soften-prompts LLM error: {msg}")
        return SoftenPromptsResponse(
            softened_prompts=originals,
            original_count=n,
            softened_count=n,
            used_llm=False,
            warnings=warnings,
        )
    except Exception as exc:  # noqa: BLE001 -- never let the route 500.
        warnings.append(
            f"Soften-prompts failed: {type(exc).__name__}: {exc} --"
            " prompts unchanged."
        )
        return SoftenPromptsResponse(
            softened_prompts=originals,
            original_count=n,
            softened_count=n,
            used_llm=False,
            warnings=warnings,
        )

    if not isinstance(rewritten, list) or len(rewritten) != n:
        warnings.append(
            "Soften-prompts returned malformed response -- prompts unchanged."
        )
        return SoftenPromptsResponse(
            softened_prompts=originals,
            original_count=n,
            softened_count=n,
            used_llm=False,
            warnings=warnings,
        )

    softened = [(p or "").strip() or originals[i] for i, p in enumerate(rewritten)]
    return SoftenPromptsResponse(
        softened_prompts=softened,
        original_count=n,
        softened_count=n,
        used_llm=True,
        warnings=warnings,
    )


# ─── /producer/assemble — concat scene videos + replace audio + soft subs ───

# PR-31 — Video Assembly. Once the user has narration mp3 (from
# /producer/audio) and per-scene mp4s (from the desktop's I2V/T2V
# batch), this route stitches them into a final 9:16 mp4 in one ffmpeg
# pass. Audio replace + trim-to-video + soft mov_text subs are the
# defaults. PR-32 adds caption_mode='burn' so the srt is rendered into
# the video stream for platforms that don't honour mov_text. Audio
# mixing (ducking the scene audio under narration) remains a follow-up.
#
# All heavy lifting lives in ``research.core.pixelle.assembler``; this
# route is just request validation + adapter to the public response
# shape. Same robust-failure contract as the rest of /producer/* —
# ffmpeg / probe failures land in ``warnings[]`` and ``video_path=""``
# is returned, never a 500.


def _default_assembly_output_dir() -> Path:
    """Per-call output dir for assembled final mp4s.

    Distinct from ``_default_output_dir()`` (``short-<ts>/``) and
    ``_default_audio_output_dir()`` (``audio-<ts>/``) so a user with
    runs in flight can tell at a glance which folder is which.
    """
    base = Path.home() / ".creator-forge" / "output"
    return base / f"assembly-{int(time.time() * 1000)}"


class AssembleRequest(BaseModel):
    scene_videos: list[str] = Field(
        ...,
        min_length=1,
        description=(
            "Absolute paths to scene mp4/mov/m4v/webm files, in playback order. "
            "Typically the ``savedFile`` of each settled row in the desktop's "
            "Video batch table."
        ),
    )
    audio_path: str | None = Field(
        None,
        description=(
            "Path to a narration mp3/wav. When set with audio_mode='replace' "
            "(the default), the scene audio tracks are dropped and this file "
            "becomes the only audio. When unset, the route falls back to "
            "muxing whatever audio the scene videos already carry."
        ),
    )
    srt_path: str | None = Field(
        None,
        description=(
            "Optional path to a captions.srt. Attached as a soft subtitle "
            "track (mov_text codec) when ``caption_mode='soft'`` (default), "
            "or rendered into the video stream when ``caption_mode='burn'`` "
            "(PR-32). Ignored when ``caption_mode='none'``."
        ),
    )
    output_dir: str | None = Field(
        None,
        description=(
            "Where to write final.mp4. Defaults to "
            "~/.creator-forge/output/assembly-<ts>/."
        ),
    )
    audio_mode: Literal["replace", "none"] = Field(
        "replace",
        description=(
            "'replace' replaces scene audio with audio_path. 'none' keeps "
            "the scene-native audio (or silent if scenes have none). Audio "
            "mixing is deferred to a follow-up PR."
        ),
    )
    trim_to: Literal["video", "audio"] = Field(
        "video",
        description=(
            "'video' caps output at summed scene durations (default — extra "
            "narration is cut). 'audio' uses ``-shortest`` so the audio "
            "track length wins."
        ),
    )
    caption_mode: Literal["soft", "none", "burn"] = Field(
        "soft",
        description=(
            "'soft' attaches the srt as a mov_text subtitle track (default). "
            "'none' ignores ``srt_path``. 'burn' (PR-32) renders the srt "
            "pixels into the video stream via ffmpeg's subtitles filter so "
            "every player sees them — slower (re-encodes the visual track) "
            "and depends on a usable font being resolvable by fontconfig at "
            "runtime, but the captions are guaranteed to display on "
            "platforms that ignore mov_text (e.g. some social uploads). "
            "Falls back to 'soft' with a warning when the srt can't be "
            "staged for burn (read-only output dir)."
        ),
    )
    # HF-10 — burn caption styling. Only used when ``caption_mode='burn'``;
    # ignored for ``soft`` / ``none``. The four presets live in
    # ``research.core.pixelle.assembler.CAPTION_STYLE_PRESETS`` and map
    # to ASS ``force_style`` parameters that override libass's ugly
    # defaults (Arial 16pt, no outline). ``caption_font_size`` and
    # ``caption_position`` are optional overrides on top of the preset
    # — leave them ``null`` to use the preset's defaults. Adding a new
    # preset requires bumping the ``CaptionStyle`` Literal here AND in
    # ``assembler.py`` + the renderer's ``CAPTION_STYLES`` whitelist.
    caption_style: Literal["modern", "cinematic", "tiktok", "minimal"] = Field(
        "modern",
        description=(
            "HF-10 burn caption preset. 'modern' = bold white sans-serif "
            "with thick black outline (YouTube Shorts default). "
            "'cinematic' = italic serif with soft shadow (Netflix style). "
            "'tiktok' = large bold Impact-style with heavy outline. "
            "'minimal' = thin white sans-serif with subtle shadow. Only "
            "applied when ``caption_mode='burn'``; ignored otherwise."
        ),
    )
    caption_font_size: Literal["small", "medium", "large"] | None = Field(
        None,
        description=(
            "HF-10 burn caption font-size override. 'small' = 16pt, "
            "'medium' = 22pt, 'large' = 28pt. ``null`` (default) uses "
            "the active ``caption_style`` preset's built-in size. Only "
            "applied when ``caption_mode='burn'``."
        ),
    )
    caption_position: Literal["bottom", "middle", "top"] | None = Field(
        None,
        description=(
            "HF-10 burn caption vertical position. 'bottom' (default in "
            "every preset), 'middle' (centred over the video), 'top' "
            "(near the top edge — useful when the bottom third of the "
            "frame has on-screen graphics). ``null`` uses the active "
            "``caption_style`` preset's built-in position. Only applied "
            "when ``caption_mode='burn'``."
        ),
    )

    _strip_audio = field_validator("audio_path", mode="before")(
        classmethod(lambda cls, v: _strip(v) if v is not None else v)
    )
    _strip_srt = field_validator("srt_path", mode="before")(
        classmethod(lambda cls, v: _strip(v) if v is not None else v)
    )

    @field_validator("scene_videos", mode="before")
    @classmethod
    def _strip_scene_videos(cls, v: object) -> object:
        if not isinstance(v, list):
            return v
        cleaned: list[str] = []
        for item in v:
            if isinstance(item, str):
                stripped = item.strip()
                if stripped:
                    cleaned.append(stripped)
            elif item is not None:
                cleaned.append(str(item))
        return cleaned


class AssembleResponse(BaseModel):
    video_path: str
    duration_s: float = 0.0
    scene_count: int = 0
    audio_attached: bool = False
    captions_attached: bool = False
    output_dir: str
    warnings: list[str] = []
    notes: str = ""


@router.post("/assemble", response_model=AssembleResponse)
def assemble(req: AssembleRequest) -> AssembleResponse:
    """Concat ``scene_videos`` → replace audio → attach soft subs → mp4."""
    # Lazy import so the rest of the routes don't have to pay for the
    # video_probe / ffmpeg resolution dance at module load time.
    from research.core.pixelle.assembler import assemble_final_mp4

    output_dir = (
        Path(req.output_dir).expanduser()
        if req.output_dir
        else _default_assembly_output_dir()
    )

    result = assemble_final_mp4(
        scene_videos=req.scene_videos,
        audio_path=req.audio_path,
        srt_path=req.srt_path,
        output_dir=output_dir,
        audio_mode=req.audio_mode,
        trim_to=req.trim_to,
        caption_mode=req.caption_mode,
        caption_style=req.caption_style,
        caption_font_size=req.caption_font_size,
        caption_position=req.caption_position,
    )

    return AssembleResponse(
        video_path=result.final_path,
        duration_s=result.duration_s,
        scene_count=result.scene_count,
        audio_attached=result.audio_attached,
        captions_attached=result.captions_attached,
        output_dir=result.output_dir,
        warnings=result.warnings,
    )


# ─── /producer/voices — curated Edge-TTS voice picker ───────────────────────


class VoiceOut(BaseModel):
    short_name: str
    label: str
    locale: str
    gender: str
    # Provider tag — "edge-tts" or "piper-tts". Lets the renderer
    # filter voices by the currently-selected TTS provider dropdown
    # so a Piper voice id never gets fed into edge-tts (or vice
    # versa). Default mirrors the legacy single-provider behaviour.
    provider: str = "edge-tts"


@router.get("/voices")
def voices(provider: str | None = None) -> dict:
    """List curated TTS voices, optionally filtered by provider.

    ``GET /producer/voices``
        Returns every curated voice with its ``provider`` tag.
        ``default`` is the curated edge-tts default so the legacy
        renderer stays compatible.

    ``GET /producer/voices?provider=piper-tts``
        Filters down to Piper voices and returns the first Piper
        voice as ``default``. An unknown / mistyped provider yields
        an empty list with ``default=None`` and a warning so the UI
        can render a friendly empty-state.
    """
    requested = (provider or "").strip().lower() or None
    selection = voices_for_provider(requested)
    warnings: list[str] = []
    if requested and not selection:
        warnings.append(
            f"Unknown TTS provider '{requested}' — returning empty list."
        )
    default_short = (
        _DEFAULT_VOICE if requested in (None, "edge-tts")
        else (selection[0].short_name if selection else None)
    )
    return {
        "voices": [
            VoiceOut(
                short_name=v.short_name,
                label=v.label,
                locale=v.locale,
                gender=v.gender,
                provider=v.provider,
            ).model_dump()
            for v in selection
        ],
        "default": default_short,
        "provider": requested,
        "providers": sorted({v.provider for v in VOICES}),
        "ready": True,
        "warnings": warnings,
        "notes": "Curated edge-tts + piper-tts voice list from research.core.pixelle.voices.",
    }


# ─── /producer/providers — visual provider registry + config status ─────────


class ProviderOut(BaseModel):
    name: str
    label: str
    kind: str
    requires: list[str]
    notes: str
    is_configured: bool
    missing_reason: str | None = None


@router.get("/providers")
def providers() -> dict:
    # ``get_provider`` instantiates so we can call ``is_configured()``;
    # the call is read-only (env vars / config) — no network.
    from research.core.pixelle.visual_providers import get_provider

    out: list[ProviderOut] = []
    warnings: list[str] = []
    for spec in list_provider_specs():
        try:
            inst = get_provider(spec.name)
            ok = bool(inst.is_configured())
            reason = "" if ok else inst.missing_reason()
        except Exception as exc:  # noqa: BLE001
            ok = False
            reason = f"{type(exc).__name__}: {exc}"
            warnings.append(f"Provider {spec.name} probe failed: {reason}")
        out.append(
            ProviderOut(
                name=spec.name,
                label=spec.label,
                kind=spec.kind,
                requires=list(spec.requires),
                notes=spec.notes,
                is_configured=ok,
                missing_reason=(reason or None),
            ).model_dump()
        )
    return {
        "providers": out,
        "default": DEFAULT_PROVIDER_NAME,
        "tts_providers": _list_tts_providers(),
        "tts_default": DEFAULT_TTS_PROVIDER,
        "warnings": warnings,
        "notes": "Provider config status comes from research.core.pixelle.visual_providers.",
    }


def _list_tts_providers() -> list[dict]:
    """Probe each known TTS engine for installation status.

    Returns shape compatible with the renderer: ``[{name, label,
    is_configured, missing_reason}, ...]``. Probing is read-only and
    must NOT raise — failures are surfaced in ``missing_reason``.
    """
    import importlib.util
    import shutil

    out: list[dict] = []
    # edge-tts: requires the ``edge_tts`` PyPI package + internet at
    # call-time. We only check the import here; the actual TTS call
    # surfaces network errors as warnings on /producer/short.
    edge_ok = importlib.util.find_spec("edge_tts") is not None
    out.append({
        "name": "edge-tts",
        "label": "Edge TTS (Microsoft, online, free)",
        "is_configured": edge_ok,
        "missing_reason": None if edge_ok else "edge_tts package not installed (`pip install edge-tts`).",
    })
    # piper-tts: requires the ``piper`` binary on PATH. Voice files
    # are checked lazily per-call so absence here doesn't block the
    # provider being selectable — the user gets a clear FileNotFound
    # if they pick a voice they haven't downloaded.
    piper_bin = shutil.which("piper")
    out.append({
        "name": "piper-tts",
        "label": "Piper TTS (local, offline, ~25MB/voice)",
        "is_configured": bool(piper_bin),
        "missing_reason": (
            None
            if piper_bin
            else "`piper` binary not on PATH — `pip install piper-tts` or download a release."
        ),
    })
    # elevenlabs: hosted, requires ELEVENLABS_API_KEY env var. The
    # ``requests`` package is a hard sidecar dep so we don't probe it.
    # Configured = key present; the actual API call surfaces
    # auth/quota errors as warnings on /producer/audio.
    elevenlabs_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    out.append({
        "name": "elevenlabs",
        "label": "ElevenLabs (hosted, paid, multilingual incl. VI)",
        "is_configured": bool(elevenlabs_key),
        "missing_reason": (
            None
            if elevenlabs_key
            else "ELEVENLABS_API_KEY env var not set — get a key from https://elevenlabs.io/app/settings/api-keys."
        ),
    })
    return out
