"""Producer route — port of pages/05_Producer.py.

Two modes (only ``scene_breakdown`` is wired here; others remain shells):

* ``short`` — TTS + captions + 9:16 mp4 composite (uses ``core.pixelle.composer``).
* ``long_form`` / ``scene_breakdown`` — turn a long script into N scenes with
  paste-ready prompts for AutoGrok / Veo3 / Whisk. Once scenes are returned,
  the desktop's ``StoryboardBridge`` pipes them into ``ImageService.generateBatch``.

Robust failure mode (matches PR-1/2/3/4/5):

* Missing ``DEEPSEEK_API_KEY`` → 200 with empty ``scenes[]`` + a friendly
  ``"DEEPSEEK_API_KEY not set"`` warning, never 500.
* LLM raises / parser fails / unexpected payload → 200 with empty
  ``scenes[]`` + the upstream message in ``warnings[]``.
* Whitespace-only ``script`` is rejected as 422 via
  ``field_validator(mode='before')`` strip — same pattern as the other
  routes in the suite.
"""
from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from research.core import llm
from research.core.pixelle import (
    SCENE_TEMPLATES,
    TEMPLATE_KEYS,
    LongFormScene,
    count_words,
    estimate_scene_count,
    estimate_total_duration_s,
    generate_scene_breakdown,
    serialize_breakdown_md,
)

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

    try:
        scenes_raw: list[LongFormScene] = generate_scene_breakdown(
            script,
            template=template,
            n_scenes=n_scenes,
            chat_fn=_make_chat_fn(),
            words_per_minute=req.words_per_minute,
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


class ShortRequest(BaseModel):
    script: str
    voice: str = "en-US-AvaNeural"
    visual_provider: str = "placeholder"
    aspect: str = "9:16"
    seed_image_path: str | None = None


@router.post("/short")
def compose_short(req: ShortRequest) -> dict:
    return {
        "mp4_path": "",
        "duration_s": 0.0,
        "notes": (
            "PR-0 shell. Wire into research.core.pixelle.composer.make_short with "
            "EdgeTTSAdapter + visual provider selected by req.visual_provider."
        ),
    }


@router.get("/voices")
def voices() -> dict:
    return {"voices": [], "notes": "PR-0 shell. research.core.pixelle.voices.VOICES."}


@router.get("/providers")
def providers() -> dict:
    return {"providers": [], "notes": "PR-0 shell. research.core.pixelle.visual_providers.list_provider_specs()."}
