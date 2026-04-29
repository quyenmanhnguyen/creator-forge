"""Keyword research helpers — KGR-style score + question buckets.

KGR (Keyword Golden Ratio): coined for SEO, an approximate "easy to rank"
signal. We adapt it for YouTube as ``existing_results / max(autocomplete_breadth, 1)``,
which favours keywords that *appear in user autocomplete* (proven demand) but
*have few existing videos* (low competition).

Question buckets fetch autocomplete for ``how/what/why/when/where/can + seed``
to surface high-intent informational keywords that rank fast.
"""
from __future__ import annotations

from typing import Iterable, TypedDict

from . import autocomplete

# Standard interrogatives in our 4 supported languages.
QUESTION_PREFIXES: dict[str, list[str]] = {
    "en": ["how", "what", "why", "when", "where", "can", "should", "is"],
    "ko": ["어떻게", "왜", "언제", "어디서", "무엇", "할 수 있"],
    "ja": ["どうやって", "なぜ", "いつ", "どこで", "何", "できる"],
    "vi": ["làm sao", "tại sao", "khi nào", "ở đâu", "có nên", "có thể"],
}


class KeywordRow(TypedDict):
    keyword: str
    length: int
    words: int
    competition: int  # YouTube totalResults for the exact phrase
    score: float  # 0-100, higher = easier to rank
    grade: str  # "easy" | "medium" | "hard"


def question_buckets(
    seed: str, hl: str = "en", gl: str = "US", lang: str = "en"
) -> dict[str, list[str]]:
    """Return ``{prefix: [suggestions]}`` for each interrogative."""
    prefixes = QUESTION_PREFIXES.get(lang, QUESTION_PREFIXES["en"])
    out: dict[str, list[str]] = {}
    for p in prefixes:
        try:
            sugg = autocomplete.suggest(f"{p} {seed}", hl=hl, gl=gl)
        except Exception:
            sugg = []
        if sugg:
            out[p] = sugg[:8]
    return out


def kgr_score(competition: int, breadth: int = 1) -> tuple[float, str]:
    """Compute a 0-100 ease-to-rank score from competition + autocomplete breadth.

    Lower competition + higher breadth = easier. Returns ``(score, grade)``.
    """
    breadth = max(breadth, 1)
    # ratio: 1 (lots of competition per autocomplete hit) → easier when smaller.
    raw = competition / breadth
    # Map raw → 0..100. Anchors chosen empirically: <500 = easy, >50000 = hard.
    if raw <= 500:
        score = 90.0
        grade = "easy"
    elif raw <= 5000:
        score = 70.0
        grade = "medium"
    elif raw <= 50000:
        score = 40.0
        grade = "medium"
    else:
        score = 15.0
        grade = "hard"
    return score, grade


def grade_color(grade: str) -> str:
    return {"easy": "#22c55e", "medium": "#f59e0b", "hard": "#ef4444"}.get(grade, "#a78bfa")


def volume_score(autocomplete_breadth: int, total_results: int) -> float:
    """0-100 demand proxy: more autocomplete hits + more total results = more volume.

    Anchors: 1 hit → ~10, 5 hits → ~50, 10+ hits → ~80, plus a bump from
    log10(total_results) when total_results > 1k.
    """
    import math

    breadth = max(autocomplete_breadth, 0)
    # 0..80 from breadth (saturating around 12 hits)
    breadth_pts = min(breadth / 12.0, 1.0) * 80
    # 0..20 from log10(total_results) where 1M+ caps it
    if total_results > 1:
        results_pts = min(math.log10(max(total_results, 10)) / 6.0, 1.0) * 20
    else:
        results_pts = 0.0
    return float(min(100.0, breadth_pts + results_pts))


def competition_score(total_results: int, top_avg_views: int = 0) -> float:
    """0-100 competition pressure (higher = harder).

    Anchors:
    - <1k results → 5 (very low)
    - 100k → 30
    - 1M → 50
    - 10M → 75
    - 100M+ → 95
    Bumps another +5..10 if top videos average over 1M views (saturated niche).
    """
    import math

    if total_results <= 0:
        base = 0.0
    else:
        # log10 mapping: 0..8 → 0..100
        base = min(math.log10(max(total_results, 1)) / 8.0, 1.0) * 100
    if top_avg_views > 1_000_000:
        base += min(math.log10(top_avg_views / 1_000_000) * 5.0, 10.0)
    return float(min(100.0, base))


def keyword_score(volume: float, competition: float) -> float:
    """Composite 0-100 score, VidIQ-style: ``0.7×Volume + 0.3×(100−Competition)``.

    Higher = better keyword (high volume + low competition).
    """
    return float(max(0.0, min(100.0, 0.7 * volume + 0.3 * (100.0 - competition))))


def score_grade(score: float) -> str:
    if score >= 70:
        return "great"
    if score >= 50:
        return "good"
    if score >= 30:
        return "ok"
    return "weak"


def fetch_competition(yt_search_fn, keyword: str, region: str = "US") -> int:
    """Hit YouTube search.list and pull the (approx.) ``totalResults`` count.

    ``yt_search_fn`` is dependency-injected (so tests can stub it) — it must
    return a ``response`` dict-like with ``pageInfo.totalResults``.
    """
    try:
        resp = yt_search_fn(keyword, region=region)
        return int(resp.get("pageInfo", {}).get("totalResults", 0))
    except Exception:
        return 0


def build_rows(seed: str, items: Iterable[str]) -> list[KeywordRow]:
    """Build a base list of KeywordRow without competition/score (filled later)."""
    rows: list[KeywordRow] = []
    for kw in items:
        rows.append(
            {
                "keyword": kw,
                "length": len(kw),
                "words": len(kw.split()),
                "competition": 0,
                "score": 0.0,
                "grade": "medium",
            }
        )
    return rows
