"""Keyword Finder route — port of pages/02_Keyword_Finder.py."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


class KeywordRequest(BaseModel):
    seed: str
    language: str = Field("en")


class KeywordResponse(BaseModel):
    seed: str
    longtail: list[str] = []
    score: dict[str, float] = {}
    vph: list[dict[str, Any]] = []
    kgr: float = 0.0
    questions: dict[str, list[str]] = {}
    notes: str = ""


@router.post("/keywords", response_model=KeywordResponse)
def keywords(req: KeywordRequest) -> KeywordResponse:
    return KeywordResponse(
        seed=req.seed,
        notes=(
            "PR-0 shell. Wire into research.core.autocomplete.fetch_suggestions, "
            "research.core.keywords.score, research.core.youtube.vph_for_results."
        ),
    )
