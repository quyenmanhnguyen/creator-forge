"""Studio route — 5-step wizard from pages/04_Studio.py.

① topics ② titles ③ outline ④ script ⑤ humanize.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


class TopicsRequest(BaseModel):
    seed: str
    language: str = "en"
    count: int = Field(20, ge=1, le=50)


class TitlesRequest(BaseModel):
    topic: str
    language: str = "en"
    count: int = Field(10, ge=1, le=20)


class OutlineRequest(BaseModel):
    title: str
    language: str = "en"


class ScriptRequest(BaseModel):
    title: str
    outline: list[dict] | str
    language: str = "en"
    max_chars: int = Field(24000, ge=2000, le=80000)


class HumanizeRequest(BaseModel):
    script: str
    language: str = "en"
    tone: str = "warm"


@router.post("/topics")
def topics(req: TopicsRequest) -> dict:
    return {"items": [], "notes": "PR-0 shell. Wire into research.core.llm.studio_topics."}


@router.post("/titles")
def titles(req: TitlesRequest) -> dict:
    return {"items": [], "top_ctr": [], "notes": "PR-0 shell. research.core.llm.studio_titles."}


@router.post("/outline")
def outline(req: OutlineRequest) -> dict:
    return {"sections": [], "notes": "PR-0 shell. research.core.llm.studio_outline (8-part)."}


@router.post("/script")
def script(req: ScriptRequest) -> dict:
    return {"chunks": [], "full": "", "notes": "PR-0 shell. research.core.llm.studio_script (chunked)."}


@router.post("/humanize")
def humanize(req: HumanizeRequest) -> dict:
    return {"script": "", "notes": "PR-0 shell. research.core.llm.studio_humanize."}
