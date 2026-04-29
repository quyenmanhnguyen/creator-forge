"""Outlier Finder route — real implementation ported from
``_streamlit_pages_legacy/03_Outlier_Finder.py``.

The flagship discovery signal: surface YouTube videos where ``views >>
subscriber count`` on small channels in the last N days. Those are the
clonable templates the algorithm just rewarded.

Pipeline (delegated to ``research.core.outliers.find_outliers``):
  1. ``yt.search_raw(seed, order="viewCount", published_after=…)`` — recent
     videos matching the topic.
  2. ``yt.videos_details(...)`` — hydrate views / likes / comments / duration.
  3. ``yt.channel_details(...)`` — fetch subscriber counts for each channel.
  4. Filter to ``subs <= max_subs`` and outlier ratio
     ``views / max(subs, 1000) >= min_outlier``.

Same ``_safe()`` failure pattern as PR-1 / PR-2: any upstream exception
becomes a ``response.warnings[]`` entry instead of a 500. Missing
``YOUTUBE_API_KEY`` returns 200 with an empty ``rows[]`` and a clear
warning.
"""
from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from research.core import outliers

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Schemas ────────────────────────────────────────────────────────────────

class OutlierRequest(BaseModel):
    seed: str = Field(..., min_length=1, description="Topic / keyword to search YouTube for outlier videos.")
    region: str = Field("US", description="YouTube region code (US / KR / JP / VN / GB / ID / CN).")
    window_days: Literal[7, 14, 30] = Field(7, description="Look-back window for ``publishedAfter`` filter.")
    max_subs: int = Field(100_000, ge=1, le=10_000_000, description="Cap channel size — only smaller channels count as outliers.")
    min_outlier: float = Field(1.5, ge=0.0, le=100.0, description="Minimum outlier ratio (views / max(subs, 1000)).")
    max_results: int = Field(50, ge=1, le=50, description="How many YouTube results to inspect (max 50 by API).")

    @field_validator("seed", mode="before")
    @classmethod
    def _strip_seed(cls, v: object) -> object:
        # Strip BEFORE min_length runs so whitespace-only seeds (" ", "\t") are
        # rejected as 422 instead of slipping through to upstream YouTube calls.
        return v.strip() if isinstance(v, str) else v


class OutlierRow(BaseModel):
    video_id: str
    title: str
    channel_id: str
    channel_title: str
    subs: int
    views: int
    likes: int = 0
    comments: int = 0
    published_at: str = ""
    hours_since: float = 1.0
    vph: float = 0.0
    outlier_score: float
    thumbnail: str = ""
    url: str
    duration: str = ""


class OutlierStats(BaseModel):
    count: int = 0
    max_vph: float = 0.0
    avg_vph: float = 0.0
    avg_outlier_score: float = 0.0


class OutlierResponse(BaseModel):
    seed: str
    region: str
    window_days: int

    rows: list[OutlierRow] = []
    stats: OutlierStats = OutlierStats()

    # Surface partial-failure messages instead of swallowing them.
    warnings: list[str] = []
    notes: str = ""


# ─── Helpers ────────────────────────────────────────────────────────────────

def _safe(label: str, fn, warnings: list[str], default):
    """Call ``fn()``; on exception append a human-readable warning and return ``default``."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 — broad catch at API boundary.
        msg = f"{label} failed: {type(exc).__name__}: {exc}"
        logger.warning(msg)
        warnings.append(msg)
        return default


def _stats_from_rows(rows: list[OutlierRow]) -> OutlierStats:
    if not rows:
        return OutlierStats()
    vphs = [r.vph for r in rows]
    scores = [r.outlier_score for r in rows]
    return OutlierStats(
        count=len(rows),
        max_vph=max(vphs),
        avg_vph=sum(vphs) / len(vphs),
        avg_outlier_score=sum(scores) / len(scores),
    )


# ─── Endpoint ───────────────────────────────────────────────────────────────

@router.post("/outlier", response_model=OutlierResponse)
def outlier(req: OutlierRequest) -> OutlierResponse:
    """Find small channels with breakout videos in the last N days.

    Returns a 200 even when YouTube fails — empty ``rows[]`` plus a warning.
    The client can render the warning instead of seeing a 500.
    """
    seed = req.seed  # already stripped by the validator
    warnings: list[str] = []

    raw = _safe(
        "outliers.find_outliers",
        lambda: outliers.find_outliers(
            seed,
            region=req.region,
            window_days=req.window_days,
            max_subs=req.max_subs,
            min_outlier=req.min_outlier,
            max_results=req.max_results,
        ),
        warnings,
        [],
    )

    rows: list[OutlierRow] = []
    for r in raw:
        try:
            rows.append(
                OutlierRow(
                    video_id=r.video_id,
                    title=r.title,
                    channel_id=r.channel_id,
                    channel_title=r.channel_title,
                    subs=r.subs,
                    views=r.views,
                    likes=r.likes,
                    comments=r.comments,
                    published_at=r.published_at,
                    hours_since=r.hours_since,
                    vph=r.vph,
                    outlier_score=r.outlier_score,
                    thumbnail=r.thumbnail,
                    url=r.url,
                    duration=r.duration,
                )
            )
        except Exception as exc:  # noqa: BLE001 — skip malformed rows, keep going.
            warnings.append(f"outlier row coercion failed: {type(exc).__name__}: {exc}")

    # Sort by outlier_score desc — most clonable first.
    rows.sort(key=lambda r: r.outlier_score, reverse=True)

    return OutlierResponse(
        seed=seed,
        region=req.region,
        window_days=req.window_days,
        rows=rows,
        stats=_stats_from_rows(rows),
        warnings=warnings,
        notes=(
            "Outlier ratio = views / max(subs, 1000). >=1.5x interesting, "
            ">=5x clonable. Sort by outlier_score desc."
        ),
    )
