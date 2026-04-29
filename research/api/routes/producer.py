"""Producer route — port of pages/05_Producer.py.

Two modes:
- ``short`` — TTS + captions + 9:16 mp4 composite (uses ``core.pixelle.composer``).
- ``long_form`` / ``scene_breakdown`` — turn a long script into N scenes with
  paste-ready prompts for AutoGrok / Veo3 / Whisk. Once scenes are returned,
  the desktop's ``StoryboardBridge`` pipes them into ``ImageService.generateBatch``.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


class SceneBreakdownRequest(BaseModel):
    script: str = Field(..., description="Full long-form script (markdown OK).")
    template: str = Field("default", description="One of TEMPLATE_KEYS in core.pixelle.scene_breakdown.")
    count: int | None = Field(None, ge=1, le=64, description="Override scene count; None = auto-estimate.")
    language: str = "en"
    style: dict[str, Any] | None = None


class SceneBreakdownResponse(BaseModel):
    scenes: list[dict[str, Any]] = []
    estimated_total_duration_s: float = 0.0
    md: str = ""
    json_payload: dict[str, Any] = {}
    notes: str = ""


@router.post("/scene_breakdown", response_model=SceneBreakdownResponse)
def scene_breakdown(req: SceneBreakdownRequest) -> SceneBreakdownResponse:
    return SceneBreakdownResponse(
        notes=(
            "PR-0 shell. Wire into research.core.pixelle.scene_breakdown.generate_scene_breakdown "
            "and serialize_breakdown_md / serialize_breakdown_json."
        ),
    )


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
