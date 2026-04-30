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
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from research.core import llm
from research.core.pixelle import (
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
    make_tts_adapter,
    LongFormScene,
    SceneAsset,
    VideoSceneAsset,
    captions_to_srt,
    count_words,
    estimate_scene_count,
    estimate_total_duration_s,
    expand_image_variants,
    extract_visual_dna,
    fallback_captions_from_text,
    generate_scene_breakdown,
    group_word_boundaries,
    list_provider_specs,
    make_short,
    serialize_breakdown_md,
)
from research.core.pixelle.video_probe import (
    MIN_FINAL_MP4_BYTES,
    MIN_USABLE_VIDEO_BYTES,
    validate_video_output,
)
from research.core.pixelle.voices import VOICES, voice_short_names

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
    warnings: list[str] = []


@router.post("/variant_prompts", response_model=VariantPromptsResponse)
def variant_prompts(req: VariantPromptsRequest) -> VariantPromptsResponse:
    """PR-26 — expand a single base scene prompt into ``count`` varied
    paste-ready prompts.

    Used by the renderer when the user re-rolls variants without
    re-running scene_breakdown (e.g. after editing the Visual DNA
    override or bumping ``images_per_scene``).
    """
    warnings: list[str] = []
    scene = LongFormScene(
        scene_id=int(req.scene.scene_id or 0),
        title=req.scene.title or "",
        narration=req.scene.narration or "",
        image_prompt=req.scene.image_prompt,
        flow_video_prompt=req.scene.flow_video_prompt or "",
    )
    try:
        prompts = expand_image_variants(
            scene,
            count=req.count,
            visual_dna=req.visual_dna or "",
            chat_fn=_make_chat_fn(),
        )
    except Exception as exc:  # noqa: BLE001
        msg = _llm_warning("Variant prompts", exc)
        logger.warning(msg)
        warnings.append(msg)
        # Degrade to repeating the base prompt so the caller still gets
        # exactly ``count`` entries (mirrors expand_image_variants's
        # in-process fallback path).
        prompts = [req.scene.image_prompt] * req.count
    return VariantPromptsResponse(prompts=prompts, warnings=warnings)


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
    if _provider_key == "edge-tts" and req.voice not in voice_short_names():
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
        tts_result = adapter.synthesize_with_timing(
            script, output_path=audio_path, voice=req.voice
        )
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


# ─── /producer/voices — curated Edge-TTS voice picker ───────────────────────


class VoiceOut(BaseModel):
    short_name: str
    label: str
    locale: str
    gender: str


@router.get("/voices")
def voices() -> dict:
    return {
        "voices": [
            VoiceOut(short_name=v.short_name, label=v.label, locale=v.locale, gender=v.gender).model_dump()
            for v in VOICES
        ],
        "default": _DEFAULT_VOICE,
        "ready": True,
        "notes": "Curated Edge-TTS voice list from research.core.pixelle.voices.",
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
    return out
