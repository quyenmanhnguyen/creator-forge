"""Niche / Research route — real implementation ported from
``_streamlit_pages_legacy/01_Research.py``.

The endpoint runs the same analysis pipeline as the original Streamlit page,
just without the UI scaffolding — long-tail keywords, YouTube top results,
breakout outliers, top channels, Trend Pulse 7d, opportunity score, optional
Google Trends related queries, and optional DeepSeek AI verdict.

Each external call is isolated in a try/except so the endpoint stays useful
even if a single API key (YouTube, DeepSeek, pytrends) is missing or rate-
limited — the partial result is returned with a ``warnings`` list explaining
what was skipped.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from research.core import autocomplete, llm, trends
from research.core import youtube as yt
from research.core.utils import parse_count

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Schemas ────────────────────────────────────────────────────────────────

class NicheRequest(BaseModel):
    seed: str = Field(..., min_length=1, description="Niche / topic seed, e.g. 'sleep stories for adults'.")
    language: str = Field("en", description="Output language code (en / ko / ja / vi / zh-CN).")
    region: str = Field("US", description="YouTube region code (US / KR / JP / VN / GB / ID / CN).")
    include_trends: bool = Field(True, description="Call pytrends for related queries (slow, easily rate-limited).")
    include_verdict: bool = Field(True, description="Call DeepSeek for the AI verdict block.")
    max_top_videos: int = Field(25, ge=1, le=50, description="How many top YouTube videos to hydrate.")

    @field_validator("seed", mode="before")
    @classmethod
    def _strip_seed(cls, v: object) -> object:
        # Strip BEFORE min_length runs so whitespace-only inputs like " " are
        # rejected as 422 instead of slipping through to upstream calls.
        return v.strip() if isinstance(v, str) else v


class TopVideo(BaseModel):
    video_id: str
    title: str
    channel_id: str
    channel_title: str
    views: int = 0
    likes: int = 0
    comments: int = 0
    published_at: str = ""
    url: str = ""


class Outlier(BaseModel):
    video_id: str
    title: str
    channel_title: str
    views: int
    view_ratio: float = Field(..., description="views / median(views_in_set)")
    url: str


class ChannelRow(BaseModel):
    channel_id: str
    title: str
    subs: int = 0
    views: int = 0
    videos: int = 0
    url: str


class TrendPulse(BaseModel):
    recent_7d: int = 0
    prior_7d: int = 0
    growth_pct: float = 0.0
    status: str = "stable"


class Verdict(BaseModel):
    verdict: str = ""  # hot / warm / cold
    score: int = 0
    competition: str = ""
    summary: str = ""
    opportunities: list[str] = []
    risks: list[str] = []
    content_gaps: list[str] = []


class NicheResponse(BaseModel):
    seed: str
    region: str
    language: str

    # Long-tail keywords
    longtail: list[str] = []

    # YouTube competition surface
    top_videos: list[TopVideo] = []
    channels: list[ChannelRow] = []
    outliers: list[Outlier] = []
    total_competition: int = 0
    recent_uploads_14d: int = 0

    # Niche signals
    pulse_7d: TrendPulse = TrendPulse()
    opportunity_score: int = 0
    opportunity_grade: str = ""

    # Google Trends related queries (optional)
    trends_top: list[dict[str, Any]] = []
    trends_rising: list[dict[str, Any]] = []

    # DeepSeek AI verdict (optional)
    verdict: Verdict | None = None

    # Surface partial-failure messages instead of swallowing them.
    warnings: list[str] = []
    notes: str = ""


# ─── Helpers ────────────────────────────────────────────────────────────────

def _safe(label: str, fn, warnings: list[str], default):
    """Call ``fn()``; on exception append a human-readable warning and return ``default``."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 — intentional broad catch at API boundary.
        msg = f"{label} failed: {type(exc).__name__}: {exc}"
        logger.warning(msg)
        warnings.append(msg)
        return default


def _video_to_dto(v: dict, ratio: float | None = None) -> dict[str, Any]:
    sn = v.get("snippet", {}) or {}
    stats = v.get("statistics", {}) or {}
    vid = v.get("id")
    if isinstance(vid, dict):
        vid = vid.get("videoId", "")
    vid = vid or ""
    out: dict[str, Any] = {
        "video_id": vid,
        "title": sn.get("title", ""),
        "channel_id": sn.get("channelId", ""),
        "channel_title": sn.get("channelTitle", ""),
        "views": int(parse_count(stats.get("viewCount", 0))),
        "likes": int(parse_count(stats.get("likeCount", 0))),
        "comments": int(parse_count(stats.get("commentCount", 0))),
        "published_at": sn.get("publishedAt", ""),
        "url": f"https://youtube.com/watch?v={vid}" if vid else "",
    }
    if ratio is not None:
        out["view_ratio"] = float(ratio)
    return out


_LANG_LABELS = {
    "en": "English",
    "ko": "Korean",
    "ja": "Japanese",
    "vi": "Vietnamese",
    "zh-CN": "Simplified Chinese",
}


def _llm_verdict(seed: str, region: str, language: str, payload: dict, warnings: list[str]) -> Verdict | None:
    """Run the DeepSeek niche-analyst prompt, mirroring 01_Research.py."""
    lang_label = _LANG_LABELS.get(language, "English")
    system = (
        "You are a YouTube niche analyst. Given trend, keyword, channel, and audience"
        " data, decide whether this niche is worth pursuing. Output JSON with shape:"
        ' {"verdict":"hot|warm|cold","score":0-100,"competition":"low|medium|high",'
        '"opportunities":[str],"risks":[str],"content_gaps":[str],"summary":str}.'
        f" Write the summary, opportunities, risks and content_gaps in {lang_label}."
    )
    try:
        raw = llm.chat_json(json.dumps(payload, default=str), system=system)
        data = json.loads(raw)
    except RuntimeError as exc:
        # Specific case: missing DeepSeek key → friendly warning, no traceback noise.
        if llm.ERR_NO_DEEPSEEK_KEY in str(exc):
            warnings.append("AI verdict skipped: DEEPSEEK_API_KEY not set.")
            return None
        warnings.append(f"AI verdict failed: {exc}")
        return None
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"AI verdict failed: {type(exc).__name__}: {exc}")
        return None

    # Construction can still raise if the LLM returns a non-numeric ``score``
    # (e.g. ``"high"``) or a non-iterable ``opportunities`` — keep the partial
    # 200 contract instead of letting it become a 500.
    try:
        return Verdict(
            verdict=str(data.get("verdict", "")).lower(),
            score=int(float(data.get("score", 0) or 0)),
            competition=str(data.get("competition", "")),
            summary=str(data.get("summary", "")),
            opportunities=list(data.get("opportunities", []) or []),
            risks=list(data.get("risks", []) or []),
            content_gaps=list(data.get("content_gaps", []) or []),
        )
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"AI verdict parse failed: {type(exc).__name__}: {exc}")
        return None


# ─── Endpoint ───────────────────────────────────────────────────────────────

@router.post("/niche", response_model=NicheResponse)
def niche(req: NicheRequest) -> NicheResponse:
    """End-to-end niche analysis for a seed keyword.

    Mirrors ``_streamlit_pages_legacy/01_Research.py``'s niche tab: long-tail
    suggestions + YouTube top results + Trend Pulse 7d + opportunity score
    + outliers + top channels + (optional) Google Trends related queries
    + (optional) DeepSeek AI verdict.

    Returns a partial result with ``warnings`` populated when individual
    upstream calls fail (missing API key, network, rate limit, etc.) so the
    client can surface them without the whole request failing.
    """
    seed = req.seed  # already stripped by the validator
    warnings: list[str] = []

    # ── Long-tail keywords (Google/YouTube autocomplete; no API key) ───────
    longtail = _safe(
        "autocomplete.suggest",
        lambda: autocomplete.suggest(seed, hl=req.language, gl=req.region),
        warnings,
        [],
    )

    # ── YouTube top results (needs YOUTUBE_API_KEY) ────────────────────────
    raw_search = _safe(
        "youtube.search_raw",
        lambda: yt.search_raw(seed, max_results=req.max_top_videos, region=req.region, order="viewCount"),
        warnings,
        {"items": [], "pageInfo": {}},
    )
    raw_items = raw_search.get("items", []) or []
    total_competition = int(raw_search.get("pageInfo", {}).get("totalResults", 0) or 0)

    video_ids = [it["id"]["videoId"] for it in raw_items if it.get("id", {}).get("videoId")]
    hydrated = _safe(
        "youtube.videos_details",
        lambda: yt.videos_details(video_ids[: req.max_top_videos]) if video_ids else [],
        warnings,
        [],
    )

    # YouTube videos.list does NOT preserve the input ID order, so hydrated[0]
    # is not necessarily the top-viewed video. Take the max viewCount across
    # the whole batch — this feeds yt.opportunity_score()'s Reach component.
    top_video_views = 0
    if hydrated:
        try:
            top_video_views = max(
                (
                    int(parse_count(v.get("statistics", {}).get("viewCount", 0)))
                    for v in hydrated
                ),
                default=0,
            )
        except (TypeError, ValueError):
            top_video_views = 0

    recent_uploads = _safe(
        "youtube.recent_uploads_count",
        lambda: yt.recent_uploads_count(seed, region=req.region, days=14),
        warnings,
        0,
    )

    pulse_dict = _safe(
        "youtube.trend_pulse",
        lambda: yt.trend_pulse(seed, region=req.region),
        warnings,
        None,
    )
    pulse = TrendPulse(**pulse_dict) if isinstance(pulse_dict, dict) else TrendPulse()

    op_score, op_grade = (0, "")
    if hydrated:
        try:
            op_score, op_grade = yt.opportunity_score(
                recent_uploads=recent_uploads,
                top_video_views=top_video_views,
                total_competition=total_competition,
            )
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"opportunity_score failed: {exc}")

    # ── Outliers + top channels ────────────────────────────────────────────
    outliers_raw: list[dict] = []
    if hydrated:
        outliers_raw = _safe(
            "youtube.detect_outliers",
            lambda: yt.detect_outliers(hydrated, multiplier=2.5),
            warnings,
            [],
        )

    channel_ids = list({(it.get("snippet") or {}).get("channelId") for it in raw_items if (it.get("snippet") or {}).get("channelId")})[:20]
    channels_raw = _safe(
        "youtube.channel_details",
        lambda: yt.channel_details(channel_ids) if channel_ids else [],
        warnings,
        [],
    )

    # ── Google Trends related queries (optional) ───────────────────────────
    trends_top: list[dict] = []
    trends_rising: list[dict] = []
    if req.include_trends:
        related = _safe(
            "trends.related_queries",
            lambda: trends.related_queries(seed, geo=req.region),
            warnings,
            {},
        )
        try:
            top_df = related.get("top") if isinstance(related, dict) else None
            if top_df is not None and hasattr(top_df, "to_dict"):
                trends_top = top_df.head(10).to_dict(orient="records")
            rising_df = related.get("rising") if isinstance(related, dict) else None
            if rising_df is not None and hasattr(rising_df, "to_dict"):
                trends_rising = rising_df.head(10).to_dict(orient="records")
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"trends related serialise failed: {exc}")

    # ── Build response DTOs ────────────────────────────────────────────────
    top_videos = [TopVideo(**_video_to_dto(v)) for v in (hydrated or [])]
    outlier_rows: list[Outlier] = []
    for v in outliers_raw[:10]:
        dto = _video_to_dto(v, ratio=v.get("_view_ratio", 0.0))
        outlier_rows.append(
            Outlier(
                video_id=dto["video_id"],
                title=dto["title"],
                channel_title=dto["channel_title"],
                views=dto["views"],
                view_ratio=dto.get("view_ratio", 0.0),
                url=dto["url"],
            )
        )

    channel_rows: list[ChannelRow] = []
    for ch in channels_raw or []:
        sn = ch.get("snippet", {}) or {}
        stats = ch.get("statistics", {}) or {}
        cid = ch.get("id", "") or ""
        channel_rows.append(
            ChannelRow(
                channel_id=cid,
                title=sn.get("title", ""),
                subs=int(parse_count(stats.get("subscriberCount", 0))),
                views=int(parse_count(stats.get("viewCount", 0))),
                videos=int(parse_count(stats.get("videoCount", 0))),
                url=f"https://youtube.com/channel/{cid}" if cid else "",
            )
        )
    channel_rows.sort(key=lambda r: r.subs, reverse=True)
    channel_rows = channel_rows[:10]

    # ── DeepSeek AI verdict (optional) ─────────────────────────────────────
    verdict_dto: Verdict | None = None
    if req.include_verdict:
        verdict_dto = _llm_verdict(
            seed=seed,
            region=req.region,
            language=req.language,
            payload={
                "seed": seed,
                "region": req.region,
                "long_tail_count": len(longtail),
                "long_tail_sample": longtail[:10],
                "channels_top10": [c.model_dump() for c in channel_rows],
                "recent_uploads_14d": recent_uploads,
                "total_competition": total_competition,
                "top_video_views": top_video_views,
                "pulse_status": pulse.status,
                "pulse_growth_pct": pulse.growth_pct,
                "opportunity_score": op_score,
            },
            warnings=warnings,
        )

    notes = ""
    if not longtail and not top_videos and not warnings:
        notes = "No data returned for this seed — check the seed spelling and region code."
    elif warnings:
        notes = "Partial result — see warnings[]. Most often missing YOUTUBE_API_KEY or DEEPSEEK_API_KEY."

    return NicheResponse(
        seed=seed,
        region=req.region,
        language=req.language,
        longtail=longtail,
        top_videos=top_videos,
        channels=channel_rows,
        outliers=outlier_rows,
        total_competition=total_competition,
        recent_uploads_14d=recent_uploads,
        pulse_7d=pulse,
        opportunity_score=op_score,
        opportunity_grade=op_grade,
        trends_top=trends_top,
        trends_rising=trends_rising,
        verdict=verdict_dto,
        warnings=warnings,
        notes=notes,
    )
