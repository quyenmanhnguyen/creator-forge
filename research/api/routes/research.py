"""Niche / Research route — port of pages/01_Research.py.

PR-0 lays a thin shell that delegates to ``research.core`` modules already
shipped with tube-atlas. Steady-state, this should mirror the Streamlit page
1:1; the legacy Streamlit page is kept under
``research/_streamlit_pages_legacy/`` as a reference.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


class NicheRequest(BaseModel):
    seed: str = Field(..., description="Niche / topic seed, eg. 'sleep stories for adults'.")
    language: str = Field("en", description="Output language code (en / ko / ja / vi).")
    region: str = Field("US", description="YouTube region for trends.")


class NicheResponse(BaseModel):
    seed: str
    trends: list[dict[str, Any]] = []
    longtail: list[str] = []
    channels: list[dict[str, Any]] = []
    outliers: list[dict[str, Any]] = []
    opportunity: float = 0.0
    pulse_7d: str = "stable"
    sentiment: dict[str, float] = {}
    verdict: str = ""
    notes: str = ""


@router.post("/niche", response_model=NicheResponse)
def niche(req: NicheRequest) -> NicheResponse:
    """Niche analysis stub.

    The real implementation should wire into ``research.core.trends``,
    ``research.core.youtube``, ``research.core.outliers``, and
    ``research.core.llm`` exactly the way ``pages/01_Research.py`` does.
    """
    return NicheResponse(
        seed=req.seed,
        notes=(
            "PR-0 shell. Wire into research.core.trends.fetch_trends, "
            "research.core.youtube.search_top_channels, "
            "research.core.outliers.find_breakouts, "
            "research.core.llm.niche_verdict — see _streamlit_pages_legacy/01_Research.py."
        ),
    )
