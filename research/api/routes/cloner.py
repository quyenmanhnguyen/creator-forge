"""Video Cloner route — real implementation ported from
``_streamlit_pages_legacy/02_Video_Cloner.py``.

Reverse-engineers a competitor video into a reusable kit:
fingerprint (stats + tags) + transcript-driven hook & structure analysis
+ N title clones + full script clone + thumbnail copy + SEO tags, in the
language of the source video (auto-detected; the user may override).

Pipeline (each upstream wrapped in ``_safe()``):
  1. ``yt.parse_video_id(url)`` — accept full URL, ``youtu.be``, ``shorts/``
     or raw video id.
  2. ``yt.videos_details([id])`` — fingerprint snippet/statistics/contentDetails.
  3. ``transcript.fetch_transcript(id)`` — youtube-transcript-api, falling
     back to yt-dlp. Failure is non-fatal — title-only clone still runs.
  4. ``lang_detect.detect_lang(transcript or title)`` — pick output language.
  5. ``llm.chat_json(...)`` (DeepSeek) — produce the clone kit
     (hook_analysis, title_clones, script, thumbnail_copy, tags).

Same robust failure mode as PR-1 / PR-2 / PR-3. Missing
``YOUTUBE_API_KEY``, no transcript, or no ``DEEPSEEK_API_KEY`` → 200 with
populated ``warnings[]`` instead of 500.
"""
from __future__ import annotations

import json
import logging
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from research.core import lang_detect, llm, transcript
from research.core import youtube as yt
from research.core.utils import engagement_rate, parse_iso_duration

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Schemas ────────────────────────────────────────────────────────────────

LANG_FULL_NAME: dict[str, str] = {
    "en": "English",
    "ko": "Korean",
    "ja": "Japanese",
    "vi": "Vietnamese",
}


class ClonerRequest(BaseModel):
    url: str = Field(..., min_length=1, description="YouTube URL or raw video id.")
    new_topic: str = Field("", description="Optional new topic for the clone — blank keeps the original topic.")
    n_titles: int = Field(10, ge=1, le=30, description="How many title clones to generate.")
    language_override: Literal["auto", "en", "ko", "ja", "vi"] = Field(
        "auto", description="Output language. ``auto`` uses the detected source language."
    )
    transcript_languages: list[str] = Field(
        default_factory=lambda: ["en", "ko", "ja", "vi"],
        description="Preferred transcript languages, in order.",
    )
    transcript_max_chars: int = Field(
        8000, ge=500, le=20000, description="Truncate transcript before sending to LLM."
    )

    @field_validator("url", mode="before")
    @classmethod
    def _strip_url(cls, v: object) -> object:
        # Strip BEFORE min_length runs so whitespace-only URLs are rejected as
        # 422 instead of slipping through to ``parse_video_id``.
        return v.strip() if isinstance(v, str) else v


class Fingerprint(BaseModel):
    video_id: str
    title: str = ""
    channel_id: str = ""
    channel_title: str = ""
    published_at: str = ""
    duration_sec: int = 0
    views: int = 0
    likes: int = 0
    comments: int = 0
    engagement_rate_pct: float = 0.0
    thumbnail: str = ""
    tags: list[str] = []
    url: str = ""


class CloneKit(BaseModel):
    hook_analysis: str = ""
    title_clones: list[str] = []
    script: str = ""
    thumbnail_copy: list[str] = []
    tags: list[str] = []


class ClonerResponse(BaseModel):
    video_id: str
    fingerprint: Fingerprint
    transcript_excerpt: str = ""
    transcript_segments: int = 0
    detected_language: str = "en"
    output_language: str = "en"
    kit: CloneKit | None = None

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


def _int_stat(stats: dict, key: str) -> int:
    try:
        return int(stats.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0


def _build_fingerprint(video_id: str, item: dict) -> Fingerprint:
    sn = item.get("snippet", {}) or {}
    stats = item.get("statistics", {}) or {}
    cd = item.get("contentDetails", {}) or {}

    views = _int_stat(stats, "viewCount")
    likes = _int_stat(stats, "likeCount")
    n_comments = _int_stat(stats, "commentCount")

    try:
        duration_sec = int(parse_iso_duration(cd.get("duration", "PT0S")).total_seconds())
    except Exception:  # noqa: BLE001
        duration_sec = 0

    thumbs = sn.get("thumbnails", {}) or {}
    thumb = (
        thumbs.get("maxres") or thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}
    ).get("url", "")

    return Fingerprint(
        video_id=video_id,
        title=sn.get("title", ""),
        channel_id=sn.get("channelId", ""),
        channel_title=sn.get("channelTitle", ""),
        published_at=sn.get("publishedAt", ""),
        duration_sec=duration_sec,
        views=views,
        likes=likes,
        comments=n_comments,
        engagement_rate_pct=engagement_rate(views, likes, n_comments),
        thumbnail=thumb,
        tags=list(sn.get("tags", []) or [])[:30],
        url=f"https://youtube.com/watch?v={video_id}",
    )


def _llm_clone_kit(
    *,
    fingerprint: Fingerprint,
    transcript_text: str,
    new_topic: str,
    n_titles: int,
    out_lang: str,
    warnings: list[str],
) -> CloneKit | None:
    """Run DeepSeek with the clone-kit prompt; return ``None`` on failure."""
    lang_label = LANG_FULL_NAME.get(out_lang, "English")
    system = (
        "You are a YouTube clone-engineer. Given a video's title, stats and"
        " transcript, output a complete remake kit in JSON with this exact"
        " shape:\n"
        '{"hook_analysis": str (markdown, analyse the first 0-15 seconds, the'
        " emotional triggers used, pacing, and the structural beats of the"
        ' rest of the video, with timestamps when possible),\n'
        ' "title_clones": [str] (titles that follow the same formula but use'
        " the new topic; respect the original language style),\n"
        ' "script": str (markdown, full script of a similar video on the new'
        " topic, ~600-900 words, structured as Hook · Body · CTA, with section"
        ' headers; should mirror the original\'s pacing and tone),\n'
        ' "thumbnail_copy": [str] (5 short text overlays for the thumbnail,'
        " ≤6 words each, high-impact),\n"
        ' "tags": [str] (12 SEO tags relevant to the new topic)\n'
        "}.\n"
        f"Write hook_analysis, script, title_clones, thumbnail_copy and tags in {lang_label}."
    )

    payload = {
        "original_title": fingerprint.title,
        "channel": fingerprint.channel_title,
        "duration_sec": fingerprint.duration_sec,
        "views": fingerprint.views,
        "likes": fingerprint.likes,
        "tags": fingerprint.tags[:20],
        "transcript": transcript_text,
        "new_topic": new_topic or "(keep the same topic, just rephrase)",
        "n_title_clones": n_titles,
    }

    try:
        raw = llm.chat_json(json.dumps(payload, ensure_ascii=False), system=system)
        data = json.loads(raw)
    except RuntimeError as exc:
        if llm.ERR_NO_DEEPSEEK_KEY in str(exc):
            warnings.append("Clone kit skipped: DEEPSEEK_API_KEY not set.")
            return None
        warnings.append(f"Clone kit failed: {exc}")
        return None
    except json.JSONDecodeError as exc:
        warnings.append(f"Clone kit returned invalid JSON: {exc}")
        return None
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Clone kit failed: {type(exc).__name__}: {exc}")
        return None

    # Construction can still raise on unexpected field types (e.g. an LLM
    # returning ``"title_clones": 12345`` makes ``list(int)`` raise TypeError).
    # Keep the partial-200 contract instead of letting it become a 500.
    try:
        titles = list(data.get("title_clones", []) or [])[:n_titles]
        return CloneKit(
            hook_analysis=str(data.get("hook_analysis", "")),
            title_clones=[str(t) for t in titles],
            script=str(data.get("script", "")),
            thumbnail_copy=[str(t) for t in (data.get("thumbnail_copy", []) or [])],
            tags=[str(t) for t in (data.get("tags", []) or [])],
        )
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Clone kit parse failed: {type(exc).__name__}: {exc}")
        return None


# ─── Endpoint ───────────────────────────────────────────────────────────────

@router.post("/cloner", response_model=ClonerResponse)
def cloner(req: ClonerRequest) -> ClonerResponse:
    """Reverse-engineer a YouTube video into a remake kit.

    Returns 200 even when individual upstreams fail — partial result + the
    failure messages live in ``response.warnings[]``.
    """
    warnings: list[str] = []
    new_topic = req.new_topic.strip()

    # ── Resolve video id ───────────────────────────────────────────────────
    video_id = _safe(
        "youtube.parse_video_id",
        lambda: yt.parse_video_id(req.url),
        warnings,
        "",
    )
    if not video_id:
        return ClonerResponse(
            video_id="",
            fingerprint=Fingerprint(video_id=""),
            warnings=warnings or [f"Could not parse video id from URL: {req.url!r}"],
            notes="Provide a YouTube watch URL, youtu.be link, shorts/ link, or raw 11-char video id.",
        )

    # ── Fingerprint (needs YOUTUBE_API_KEY) ────────────────────────────────
    items = _safe(
        "youtube.videos_details",
        lambda: yt.videos_details([video_id]),
        warnings,
        [],
    )
    if not items:
        return ClonerResponse(
            video_id=video_id,
            fingerprint=Fingerprint(video_id=video_id, url=f"https://youtube.com/watch?v={video_id}"),
            warnings=warnings or [f"Video not found or videos.list returned empty for {video_id!r}."],
            notes="Check YOUTUBE_API_KEY and that the video is public.",
        )

    fingerprint = _build_fingerprint(video_id, items[0])

    # ── Transcript (non-fatal — title-only clone still runs) ───────────────
    segments = _safe(
        "transcript.fetch_transcript",
        lambda: transcript.fetch_transcript(video_id, languages=req.transcript_languages),
        warnings,
        [],
    )
    full_text = ""
    if segments:
        full_text = _safe(
            "transcript.transcript_to_text",
            lambda: transcript.transcript_to_text(segments),
            warnings,
            "",
        )

    transcript_excerpt = full_text[: req.transcript_max_chars]

    # ── Language detection (always cheap; fall back to "en") ───────────────
    detected = _safe(
        "lang_detect.detect_lang",
        lambda: lang_detect.detect_lang(full_text or fingerprint.title),
        warnings,
        "en",
    )
    if req.language_override == "auto":
        out_lang = detected
    else:
        out_lang = req.language_override

    # ── DeepSeek clone kit ─────────────────────────────────────────────────
    kit = _llm_clone_kit(
        fingerprint=fingerprint,
        transcript_text=transcript_excerpt,
        new_topic=new_topic,
        n_titles=req.n_titles,
        out_lang=out_lang,
        warnings=warnings,
    )

    notes = ""
    if not full_text and kit is not None:
        notes = "Transcript unavailable — clone kit was built from title + metadata only."
    elif kit is None and warnings:
        notes = "Clone kit could not be generated; check warnings[] for the upstream error."

    return ClonerResponse(
        video_id=video_id,
        fingerprint=fingerprint,
        transcript_excerpt=transcript_excerpt,
        transcript_segments=len(segments) if segments else 0,
        detected_language=detected,
        output_language=out_lang,
        kit=kit,
        warnings=warnings,
        notes=notes,
    )
