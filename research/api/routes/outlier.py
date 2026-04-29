"""Outlier Finder route — port of pages/03_Outlier_Finder.py."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


class OutlierRequest(BaseModel):
    topic: str
    days: Literal[7, 14, 30] = 7
    max_subs: int = Field(100_000, ge=0)
    min_views_per_sub: float = Field(2.0, ge=0)


class OutlierResponse(BaseModel):
    rows: list[dict[str, Any]] = []
    csv: str = ""
    notes: str = ""


@router.post("/outlier", response_model=OutlierResponse)
def outlier(req: OutlierRequest) -> OutlierResponse:
    return OutlierResponse(
        notes=(
            f"PR-0 shell. topic={req.topic!r} days={req.days} max_subs={req.max_subs} "
            f"min_v/s={req.min_views_per_sub}. Wire into research.core.outliers."
        ),
    )
