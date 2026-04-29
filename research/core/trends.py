"""Trends qua pytrends (gprop='youtube')."""
from __future__ import annotations

import pandas as pd
from pytrends.request import TrendReq


def _client(hl: str = "vi-VN", tz: int = 420) -> TrendReq:
    return TrendReq(hl=hl, tz=tz)


def interest_over_time(keywords: list[str], geo: str = "VN", timeframe: str = "today 3-m") -> pd.DataFrame:
    py = _client()
    py.build_payload(keywords[:5], geo=geo, gprop="youtube", timeframe=timeframe)
    df = py.interest_over_time()
    if "isPartial" in df.columns:
        df = df.drop(columns=["isPartial"])
    return df


def related_queries(keyword: str, geo: str = "VN", timeframe: str = "today 3-m") -> dict:
    py = _client()
    py.build_payload([keyword], geo=geo, gprop="youtube", timeframe=timeframe)
    return py.related_queries().get(keyword, {})


def trending_searches(pn: str = "vietnam") -> pd.DataFrame:
    py = _client()
    return py.trending_searches(pn=pn)
