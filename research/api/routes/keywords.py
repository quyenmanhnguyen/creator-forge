"""Keyword Finder route — real implementation ported from the keyword tab of
``_streamlit_pages_legacy/01_Research.py``.

Mirrors the long-tail keywords tab: YouTube/Google autocomplete suggestions,
VidIQ-style Volume / Competition / Score gauges for the seed, VPH (views per
hour) of top results, optional KGR (Keyword Golden Ratio) competition score
per keyword, and question-bucket keywords (how/what/why/...).

Each external call is wrapped in a ``_safe()`` helper — exceptions become
entries on ``response.warnings[]`` instead of 500s, so a missing
``YOUTUBE_API_KEY`` or transient network error produces a partial result the
client can still render.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel, Field

from research.core import autocomplete, keywords as kw
from research.core import youtube as yt
from research.core.utils import parse_count

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Schemas ────────────────────────────────────────────────────────────────

class KeywordRequest(BaseModel):
    seed: str = Field(..., min_length=1, description="Seed keyword to expand into long-tail.")
    language: str = Field("en", description="Output language for autocomplete prefix + question buckets (en / ko / ja / vi).")
    region: str = Field("US", description="YouTube region code (US / KR / JP / VN / GB / ID / CN).")
    compute_kgr: bool = Field(False, description="Compute per-keyword competition (one YouTube API call per keyword). Costs quota.")
    max_kgr_keywords: int = Field(25, ge=1, le=50, description="When compute_kgr=true, cap how many keywords get scored.")
    max_top_videos: int = Field(10, ge=1, le=50, description="How many top videos to hydrate for VPH + competition_score.")
    include_questions: bool = Field(True, description="Fetch question-bucket autocomplete (how/what/why/...).")


class KeywordRow(BaseModel):
    keyword: str
    length: int
    words: int
    competition: int = 0  # YouTube totalResults for the exact phrase (0 unless compute_kgr=true)
    score: float = 0.0    # 0..100 KGR-style score (only set when compute_kgr=true)
    grade: str = "medium"  # easy / medium / hard


class SeedScore(BaseModel):
    volume: float = 0.0       # 0..100
    competition: float = 0.0  # 0..100
    keyword: float = 0.0      # 0..100 composite — VidIQ-style
    grade: str = ""           # great / good / ok / weak


class VphRow(BaseModel):
    video_id: str
    title: str
    views: int
    vph: float                # views per hour since publication (>= 1 hour)
    published_at: str
    url: str


class KeywordResponse(BaseModel):
    seed: str
    region: str
    language: str

    # Long-tail suggestions
    suggestions: list[KeywordRow] = []

    # Seed-level scoring (Volume / Competition / Composite)
    seed_score: SeedScore = SeedScore()
    total_results: int = 0   # YouTube totalResults for the seed itself

    # VPH of top videos
    vph_top: list[VphRow] = []

    # Question buckets (how/what/why/...)
    questions: dict[str, list[str]] = {}

    # Surface partial-failure messages instead of swallowing them.
    warnings: list[str] = []
    notes: str = ""


# ─── Helpers ────────────────────────────────────────────────────────────────

def _safe(label: str, fn, warnings: list[str], default):
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 — broad catch at API boundary.
        msg = f"{label} failed: {type(exc).__name__}: {exc}"
        logger.warning(msg)
        warnings.append(msg)
        return default


def _vph_rows(top_videos: list[dict], limit: int) -> list[VphRow]:
    """Compute views-per-hour for each hydrated top video."""
    out: list[VphRow] = []
    now = datetime.now(timezone.utc)
    for v in top_videos:
        try:
            sn = v.get("snippet") or {}
            stats = v.get("statistics") or {}
            pub_raw = sn.get("publishedAt", "")
            if not pub_raw:
                continue
            dt = datetime.fromisoformat(pub_raw.replace("Z", "+00:00"))
            hours = max((now - dt).total_seconds() / 3600.0, 1.0)
            views = int(parse_count(stats.get("viewCount", 0)))
            vid = v.get("id") if isinstance(v.get("id"), str) else (v.get("id") or {}).get("videoId", "")
            out.append(
                VphRow(
                    video_id=vid or "",
                    title=sn.get("title", ""),
                    views=views,
                    vph=yt.vph(views, hours),
                    published_at=pub_raw,
                    url=f"https://youtube.com/watch?v={vid}" if vid else "",
                )
            )
        except Exception as exc:  # noqa: BLE001 — per-row resilience.
            logger.debug("vph row skipped: %s", exc)
            continue
    out.sort(key=lambda r: r.vph, reverse=True)
    return out[:limit]


# ─── Endpoint ───────────────────────────────────────────────────────────────

@router.post("/keywords", response_model=KeywordResponse)
def keywords(req: KeywordRequest) -> KeywordResponse:
    """Long-tail keyword finder for a seed — autocomplete + VidIQ-style score
    + VPH of top YouTube results + (optional) per-keyword KGR + question buckets.

    Returns a partial result with ``warnings`` populated when individual
    upstream calls fail (missing API key, network, rate limit, etc.).
    """
    seed = req.seed.strip()
    warnings: list[str] = []

    # ── Long-tail autocomplete (no API key needed) ─────────────────────────
    suggestions_raw: list[str] = _safe(
        "autocomplete.suggest",
        lambda: autocomplete.suggest(seed, hl=req.language, gl=req.region),
        warnings,
        [],
    )
    rows_raw = kw.build_rows(seed, suggestions_raw) if suggestions_raw else []

    # ── YouTube top results (needs YOUTUBE_API_KEY) ────────────────────────
    raw_search = _safe(
        "youtube.search_raw",
        lambda: yt.search_raw(seed, max_results=req.max_top_videos, region=req.region, order="relevance"),
        warnings,
        {"items": [], "pageInfo": {}},
    )
    items = raw_search.get("items", []) or []
    total_results = int(raw_search.get("pageInfo", {}).get("totalResults", 0) or 0)

    video_ids = [it["id"]["videoId"] for it in items if it.get("id", {}).get("videoId")]
    hydrated = _safe(
        "youtube.videos_details",
        lambda: yt.videos_details(video_ids[: req.max_top_videos]) if video_ids else [],
        warnings,
        [],
    )

    # ── VidIQ-style seed scores ────────────────────────────────────────────
    seed_score = SeedScore()
    if suggestions_raw:
        try:
            top_views = [int(parse_count(v.get("statistics", {}).get("viewCount", 0))) for v in hydrated]
            avg_top = int(sum(top_views) / len(top_views)) if top_views else 0
            volume = kw.volume_score(len(suggestions_raw), total_results)
            comp = kw.competition_score(total_results, avg_top)
            composite = kw.keyword_score(volume, comp)
            seed_score = SeedScore(
                volume=volume,
                competition=comp,
                keyword=composite,
                grade=kw.score_grade(composite),
            )
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"seed_score failed: {type(exc).__name__}: {exc}")

    # ── VPH of top videos ──────────────────────────────────────────────────
    vph_rows: list[VphRow] = []
    if hydrated:
        try:
            vph_rows = _vph_rows(hydrated, limit=req.max_top_videos)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"vph compute failed: {type(exc).__name__}: {exc}")

    # ── Optional KGR per keyword (one YouTube call per keyword) ────────────
    #
    # On per-call exception we leave the row's default (competition=0,
    # score=0.0, grade="medium") rather than stamping kgr_score(0, breadth)
    # = (90.0, "easy"). Without that distinction a client sorting by score
    # would float failed lookups to the top as "easiest to rank", actively
    # misleading the user. comp==0 returned by a *successful* call (genuinely
    # no YouTube results) is still treated as easy and scored normally.
    if req.compute_kgr and rows_raw:
        breadth = max(len(suggestions_raw), 1)
        sample = rows_raw[: req.max_kgr_keywords]
        kgr_failures = 0
        for row in sample:
            try:
                resp = yt.search_raw(
                    row["keyword"], max_results=1, region=req.region, order="relevance"
                )
                comp = int(resp.get("pageInfo", {}).get("totalResults", 0))
            except Exception as exc:  # noqa: BLE001 — per-row resilience.
                kgr_failures += 1
                if kgr_failures <= 3:
                    warnings.append(
                        f"kgr search_raw[{row['keyword']}] failed: {type(exc).__name__}: {exc}"
                    )
                # Keep defaults from build_rows (competition=0, score=0.0,
                # grade="medium") — do NOT call kgr_score for failed lookups.
                continue
            row["competition"] = comp
            score, grade = kw.kgr_score(comp, breadth)
            row["score"] = score
            row["grade"] = grade
        if kgr_failures > 3:
            warnings.append(
                f"kgr: {kgr_failures} of {len(sample)} keywords failed to fetch competition (rate-limit or missing key)."
            )

    suggestions = [
        KeywordRow(
            keyword=r["keyword"],
            length=r["length"],
            words=r["words"],
            competition=int(r.get("competition", 0) or 0),
            score=float(r.get("score", 0.0) or 0.0),
            grade=str(r.get("grade", "medium")),
        )
        for r in rows_raw
    ]

    # ── Question buckets (autocomplete only — no API key needed) ───────────
    questions: dict[str, list[str]] = {}
    if req.include_questions:
        questions = _safe(
            "keywords.question_buckets",
            lambda: kw.question_buckets(seed, hl=req.language, gl=req.region, lang=req.language),
            warnings,
            {},
        )

    notes = ""
    if not suggestions and not warnings:
        notes = "No autocomplete suggestions for this seed — try a more specific or different language."
    elif warnings:
        notes = "Partial result — see warnings[]. Most often missing YOUTUBE_API_KEY or rate-limited autocomplete."

    return KeywordResponse(
        seed=seed,
        region=req.region,
        language=req.language,
        suggestions=suggestions,
        seed_score=seed_score,
        total_results=total_results,
        vph_top=vph_rows,
        questions=questions,
        warnings=warnings,
        notes=notes,
    )
