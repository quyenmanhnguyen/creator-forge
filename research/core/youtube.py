"""YouTube Data API v3 wrapper với caching nhẹ."""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from googleapiclient.discovery import build


def _client():
    key = os.getenv("YOUTUBE_API_KEY")
    if not key:
        raise RuntimeError(
            "Thiếu YOUTUBE_API_KEY. Tạo tại https://console.cloud.google.com/apis/credentials"
        )
    return build("youtube", "v3", developerKey=key, cache_discovery=False)


def search_videos(query: str, max_results: int = 25, region: str = "VN", order: str = "relevance") -> list[dict]:
    yt = _client()
    resp = yt.search().list(
        q=query,
        part="snippet",
        type="video",
        maxResults=min(max_results, 50),
        regionCode=region,
        order=order,
    ).execute()
    return resp.get("items", [])


def search_raw(
    query: str,
    max_results: int = 5,
    region: str = "US",
    order: str = "relevance",
    published_after: str | None = None,
) -> dict:
    """Return the full search.list response (includes ``pageInfo.totalResults``)."""
    yt = _client()
    params: dict[str, Any] = {
        "q": query,
        "part": "snippet",
        "type": "video",
        "maxResults": min(max_results, 50),
        "regionCode": region,
        "order": order,
    }
    if published_after:
        params["publishedAfter"] = published_after
    return yt.search().list(**params).execute()


def recent_uploads_count(query: str, region: str = "US", days: int = 14) -> int:
    """Count uploads matching ``query`` published in the last ``days`` days."""
    from datetime import datetime, timedelta, timezone

    after = (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    resp = search_raw(query, max_results=1, region=region, order="date", published_after=after)
    return int(resp.get("pageInfo", {}).get("totalResults", 0))


def trend_pulse(query: str, region: str = "US") -> dict:
    """Compare last-7d uploads to the prior 7d → "HOT / cooling / stable".

    Returns ``{recent_7d, prior_7d, growth_pct, status}``.
    """
    recent = recent_uploads_count(query, region=region, days=7)
    last_14 = recent_uploads_count(query, region=region, days=14)
    prior = max(last_14 - recent, 0)
    if prior == 0:
        growth = 0.0 if recent == 0 else 100.0
    else:
        growth = ((recent - prior) / prior) * 100.0
    if growth >= 30 and recent >= 5:
        status = "hot"
    elif growth <= -20:
        status = "cooling"
    else:
        status = "stable"
    return {
        "recent_7d": recent,
        "prior_7d": prior,
        "growth_pct": growth,
        "status": status,
    }


def vph(views: int, hours_since_published: float) -> float:
    """Views per hour. Floors hours at 1 to avoid div-by-zero / nonsense."""
    return float(views) / max(hours_since_published, 1.0)


def channel_recent_videos(channel_id: str, max_videos: int = 30) -> list[dict]:
    """Recent videos from a channel via its uploads playlist + videos.list."""
    pl = channel_uploads_playlist(channel_id)
    if not pl:
        return []
    ids = playlist_video_ids(pl, max_videos=max_videos)
    if not ids:
        return []
    return videos_details(ids)


def detect_outliers(videos: list[dict], multiplier: float = 2.5) -> list[dict]:
    """Mark videos whose ``views > multiplier × median(views)`` as breakouts.

    Returns the breakout videos sorted by ``view_ratio`` (views / median) desc.
    """
    if not videos:
        return []
    counts: list[int] = []
    for v in videos:
        try:
            counts.append(int(v.get("statistics", {}).get("viewCount", 0)))
        except (TypeError, ValueError):
            counts.append(0)
    if not counts:
        return []
    counts_sorted = sorted(counts)
    median = counts_sorted[len(counts_sorted) // 2] or 1
    out: list[dict] = []
    for v, vc in zip(videos, counts):
        if vc > multiplier * median:
            v = dict(v)
            v["_view_ratio"] = vc / median
            out.append(v)
    return sorted(out, key=lambda x: x["_view_ratio"], reverse=True)


def opportunity_score(
    *, recent_uploads: int, top_video_views: int, total_competition: int
) -> tuple[int, str]:
    """0-100 niche-opportunity score + grade.

    Higher = niche is alive (recent uploads, top video gets views) but not
    saturated (low total competition).
    """
    recent_uploads = max(recent_uploads, 0)
    top_video_views = max(top_video_views, 0)
    total_competition = max(total_competition, 1)

    # Activity: 0..40, saturating at ~50 uploads/14d
    activity = min(recent_uploads / 50, 1.0) * 40
    # Reach: 0..40, saturating at ~5M views on top video
    reach = min(top_video_views / 5_000_000, 1.0) * 40
    # Saturation penalty: 0..-20, more competition = worse
    sat = min(total_competition / 5_000_000, 1.0) * 20

    score = max(0, min(100, int(round(activity + reach + (20 - sat)))))
    if score >= 70:
        grade = "high"
    elif score >= 40:
        grade = "medium"
    else:
        grade = "low"
    return score, grade


def videos_details(video_ids: list[str]) -> list[dict]:
    yt = _client()
    out: list[dict] = []
    for i in range(0, len(video_ids), 50):
        chunk = video_ids[i : i + 50]
        resp = yt.videos().list(
            id=",".join(chunk),
            part="snippet,statistics,contentDetails,topicDetails,status",
            maxResults=50,
        ).execute()
        out.extend(resp.get("items", []))
    return out


def channel_details(channel_ids: list[str]) -> list[dict]:
    yt = _client()
    resp = yt.channels().list(
        id=",".join(channel_ids),
        part="snippet,statistics,brandingSettings,topicDetails",
        maxResults=50,
    ).execute()
    return resp.get("items", [])


def channel_by_handle(handle: str) -> dict | None:
    yt = _client()
    handle = handle.lstrip("@")
    resp = yt.channels().list(
        forHandle=handle,
        part="snippet,statistics,brandingSettings,topicDetails",
    ).execute()
    items = resp.get("items", [])
    return items[0] if items else None


def channel_uploads_playlist(channel_id: str) -> str | None:
    yt = _client()
    resp = yt.channels().list(id=channel_id, part="contentDetails").execute()
    items = resp.get("items", [])
    if not items:
        return None
    return items[0]["contentDetails"]["relatedPlaylists"]["uploads"]


def playlist_video_ids(playlist_id: str, max_videos: int = 200) -> list[str]:
    yt = _client()
    ids: list[str] = []
    token: str | None = None
    while len(ids) < max_videos:
        resp = yt.playlistItems().list(
            playlistId=playlist_id,
            part="contentDetails",
            maxResults=50,
            pageToken=token,
        ).execute()
        ids.extend(item["contentDetails"]["videoId"] for item in resp.get("items", []))
        token = resp.get("nextPageToken")
        if not token:
            break
    return ids[:max_videos]


def trending_videos(region: str = "VN", max_results: int = 50, category_id: str | None = None) -> list[dict]:
    yt = _client()
    params: dict[str, Any] = {
        "chart": "mostPopular",
        "regionCode": region,
        "part": "snippet,statistics,contentDetails",
        "maxResults": min(max_results, 50),
    }
    if category_id:
        params["videoCategoryId"] = category_id
    return yt.videos().list(**params).execute().get("items", [])


@lru_cache(maxsize=32)
def video_categories(region: str = "VN") -> dict[str, str]:
    yt = _client()
    resp = yt.videoCategories().list(part="snippet", regionCode=region).execute()
    return {it["id"]: it["snippet"]["title"] for it in resp.get("items", [])}


def parse_video_id(url_or_id: str) -> str:
    """Chấp nhận URL đầy đủ, youtu.be hoặc raw video id."""
    s = url_or_id.strip()
    if "youtu.be/" in s:
        return s.split("youtu.be/")[1].split("?")[0].split("&")[0]
    if "watch?v=" in s:
        return s.split("watch?v=")[1].split("&")[0]
    if "shorts/" in s:
        return s.split("shorts/")[1].split("?")[0].split("&")[0]
    if "/embed/" in s:
        return s.split("/embed/")[1].split("?")[0]
    return s
