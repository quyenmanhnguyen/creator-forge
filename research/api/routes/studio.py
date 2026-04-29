"""Studio route — 5-step creator wizard ported from
``_streamlit_pages_legacy/04_Studio.py``.

Pipeline (each step feeds the next):

  POST /studio/topics    → ``llm.topic_ideas``        — Step 1
  POST /studio/titles    → ``llm.titles_with_ctr``    — Step 2
  POST /studio/outline   → ``llm.outline_8part``      — Step 3 (H2Dev 8-part)
  POST /studio/script    → ``llm.long_script_chunked``— Step 4 (chunked long-form)
  POST /studio/humanize  → ``llm.humanize_rewrite``   — Step 5

Robust failure mode (matches PR-1/2/3/4):

* Missing ``DEEPSEEK_API_KEY`` → 200 with empty payload + a friendly
  "DEEPSEEK_API_KEY not set" warning, never a 500.
* DeepSeek API errors / invalid JSON / unexpected payload shape → 200
  with empty payload + the upstream message in ``warnings[]``.
* Whitespace-only ``seed`` / ``topic`` / ``title`` / ``script`` is
  rejected as 422 (validators strip BEFORE ``min_length`` runs).
"""
from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from research.core import llm

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Language helper ────────────────────────────────────────────────────────
# DeepSeek prompts interpolate a full language label (e.g. "English"). The
# request takes a short ISO-like code and we map it here.
LANG_FULL_NAME: dict[str, str] = {
    "en": "English",
    "ko": "Korean (한국어)",
    "ja": "Japanese (日本語)",
    "vi": "Vietnamese (Tiếng Việt)",
}

LangCode = Literal["en", "ko", "ja", "vi"]


def _lang_label(code: str) -> str:
    return LANG_FULL_NAME.get(code, "English")


# ─── Shared validator ───────────────────────────────────────────────────────

def _strip(v: object) -> object:
    return v.strip() if isinstance(v, str) else v


# ─── Schemas ────────────────────────────────────────────────────────────────

class _BaseStudioResponse(BaseModel):
    warnings: list[str] = []
    notes: str = ""


# Step 1 — Topics
class TopicIdea(BaseModel):
    topic: str = ""
    emotion: str = ""
    hook: str = ""


class TopicsRequest(BaseModel):
    seed: str = Field(..., min_length=1, description="Niche / keyword seed (e.g. 'sleep stories for adults').")
    language: LangCode = "en"
    n: int = Field(20, ge=1, le=50, description="How many topic ideas to generate.")

    _strip_seed = field_validator("seed", mode="before")(classmethod(lambda cls, v: _strip(v)))


class TopicsResponse(_BaseStudioResponse):
    seed: str
    language: str
    ideas: list[TopicIdea] = []


# Step 2 — Titles
class TitleItem(BaseModel):
    title: str = ""
    reason: str = ""
    ctr_rank: int | None = None
    chars: int = 0


class TitlesRequest(BaseModel):
    topic: str = Field(..., min_length=1)
    language: LangCode = "en"
    n: int = Field(10, ge=1, le=30)
    must_keywords: str = ""

    _strip_topic = field_validator("topic", mode="before")(classmethod(lambda cls, v: _strip(v)))


class TitlesResponse(_BaseStudioResponse):
    topic: str
    language: str
    titles: list[TitleItem] = []
    top_3: list[int] = []


# Step 3 — Outline (8 parts)
class OutlinePart(BaseModel):
    part: int = 0
    role: str = ""
    emotion: str = ""
    expansion: str = ""


class OutlineRequest(BaseModel):
    title: str = Field(..., min_length=1)
    language: LangCode = "en"

    _strip_title = field_validator("title", mode="before")(classmethod(lambda cls, v: _strip(v)))


class OutlineResponse(_BaseStudioResponse):
    title: str
    language: str
    parts: list[OutlinePart] = []


# Step 4 — Long-form script
class ScriptRequest(BaseModel):
    title: str = Field(..., min_length=1)
    parts: list[OutlinePart] = Field(..., description="The 8-part outline from /studio/outline.")
    language: LangCode = "en"
    target_chars: int = Field(8000, ge=2000, le=40000)

    _strip_title = field_validator("title", mode="before")(classmethod(lambda cls, v: _strip(v)))

    @field_validator("parts")
    @classmethod
    def _need_eight_parts(cls, v: list[OutlinePart]) -> list[OutlinePart]:
        if len(v) < 8:
            raise ValueError("outline must have 8 parts")
        return v


class ScriptResponse(_BaseStudioResponse):
    title: str
    language: str
    script: str = ""
    chars: int = 0


# Step 5 — Humanize
class HumanizeRequest(BaseModel):
    script: str = Field(..., min_length=1)
    language: LangCode = "en"

    _strip_script = field_validator("script", mode="before")(classmethod(lambda cls, v: _strip(v)))


class HumanizeResponse(_BaseStudioResponse):
    language: str
    script_final: str = ""
    chars_in: int = 0
    chars_out: int = 0


# ─── Helpers ────────────────────────────────────────────────────────────────

def _llm_warning(label: str, exc: Exception) -> str:
    """Format an LLM-call failure message — friendly text for the missing-key case."""
    if isinstance(exc, RuntimeError) and llm.ERR_NO_DEEPSEEK_KEY in str(exc):
        return f"{label} skipped: DEEPSEEK_API_KEY not set."
    return f"{label} failed: {type(exc).__name__}: {exc}"


def _coerce_int(v: Any, default: int = 0) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/topics", response_model=TopicsResponse)
def topics(req: TopicsRequest) -> TopicsResponse:
    """Step 1 — generate ``n`` topic ideas for a seed."""
    seed = req.seed.strip()
    warnings: list[str] = []
    ideas: list[TopicIdea] = []

    try:
        data = llm.topic_ideas(seed, language=_lang_label(req.language), n=req.n)
    except Exception as exc:  # noqa: BLE001 — broad catch at API boundary.
        msg = _llm_warning("Topic ideas", exc)
        logger.warning(msg)
        warnings.append(msg)
        data = {}

    try:
        raw_items = list(data.get("ideas", []) or [])
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            ideas.append(
                TopicIdea(
                    topic=str(raw.get("topic", "")),
                    emotion=str(raw.get("emotion", "")),
                    hook=str(raw.get("hook", "")),
                )
            )
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Topic ideas parse failed: {type(exc).__name__}: {exc}")
        ideas = []

    return TopicsResponse(seed=seed, language=req.language, ideas=ideas, warnings=warnings)


@router.post("/titles", response_model=TitlesResponse)
def titles(req: TitlesRequest) -> TitlesResponse:
    """Step 2 — generate ``n`` titles for a topic, marking the predicted top 3 by CTR."""
    topic = req.topic.strip()
    warnings: list[str] = []
    out_titles: list[TitleItem] = []
    top_3: list[int] = []

    try:
        data = llm.titles_with_ctr(
            topic,
            language=_lang_label(req.language),
            n=req.n,
            must_keywords=req.must_keywords.strip(),
        )
    except Exception as exc:  # noqa: BLE001
        msg = _llm_warning("Titles", exc)
        logger.warning(msg)
        warnings.append(msg)
        data = {}

    try:
        raw_items = list(data.get("titles", []) or [])
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("title", ""))
            ctr_rank: int | None
            rank_raw = raw.get("ctr_rank")
            if rank_raw in (None, "", 0):
                ctr_rank = None
            else:
                try:
                    ctr_rank = int(float(rank_raw))
                except (TypeError, ValueError):
                    ctr_rank = None
            out_titles.append(
                TitleItem(
                    title=text,
                    reason=str(raw.get("reason", "")),
                    ctr_rank=ctr_rank,
                    chars=len(text),
                )
            )
        top_3 = [_coerce_int(x, 0) for x in (data.get("top_3", []) or [])]
        top_3 = [i for i in top_3 if i > 0]
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Titles parse failed: {type(exc).__name__}: {exc}")
        out_titles, top_3 = [], []

    return TitlesResponse(
        topic=topic,
        language=req.language,
        titles=out_titles,
        top_3=top_3,
        warnings=warnings,
    )


@router.post("/outline", response_model=OutlineResponse)
def outline(req: OutlineRequest) -> OutlineResponse:
    """Step 3 — produce the H2Dev 8-part outline for a title."""
    title = req.title.strip()
    warnings: list[str] = []
    parts: list[OutlinePart] = []

    try:
        data = llm.outline_8part(title, language=_lang_label(req.language))
    except Exception as exc:  # noqa: BLE001
        msg = _llm_warning("Outline", exc)
        logger.warning(msg)
        warnings.append(msg)
        data = {}

    try:
        raw_items = list(data.get("parts", []) or [])
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            parts.append(
                OutlinePart(
                    part=_coerce_int(raw.get("part", 0)),
                    role=str(raw.get("role", "")),
                    emotion=str(raw.get("emotion", "")),
                    expansion=str(raw.get("expansion", "")),
                )
            )
        if parts and len(parts) != 8:
            warnings.append(f"Outline returned {len(parts)} parts (expected 8).")
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"Outline parse failed: {type(exc).__name__}: {exc}")
        parts = []

    return OutlineResponse(title=title, language=req.language, parts=parts, warnings=warnings)


@router.post("/script", response_model=ScriptResponse)
def script(req: ScriptRequest) -> ScriptResponse:
    """Step 4 — write the full long-form script (chunked under the hood)."""
    title = req.title.strip()
    warnings: list[str] = []
    body = ""

    parts_payload = [p.model_dump() for p in req.parts]

    try:
        body = llm.long_script_chunked(
            title,
            parts_payload,
            language=_lang_label(req.language),
            target_chars=req.target_chars,
        )
    except ValueError as exc:
        # ``long_script_chunked`` raises ValueError for outline shape; the
        # request validator already enforces 8 parts so this is a defence in depth.
        warnings.append(f"Script failed: {exc}")
    except Exception as exc:  # noqa: BLE001
        msg = _llm_warning("Script", exc)
        logger.warning(msg)
        warnings.append(msg)

    return ScriptResponse(
        title=title,
        language=req.language,
        script=body or "",
        chars=len(body or ""),
        warnings=warnings,
    )


@router.post("/humanize", response_model=HumanizeResponse)
def humanize(req: HumanizeRequest) -> HumanizeResponse:
    """Step 5 — rewrite the script to feel less AI-shaped while keeping length."""
    script_in = req.script
    warnings: list[str] = []
    final = ""

    try:
        final = llm.humanize_rewrite(script_in, language=_lang_label(req.language))
    except Exception as exc:  # noqa: BLE001
        msg = _llm_warning("Humanize", exc)
        logger.warning(msg)
        warnings.append(msg)

    return HumanizeResponse(
        language=req.language,
        script_final=final or "",
        chars_in=len(script_in),
        chars_out=len(final or ""),
        warnings=warnings,
    )

