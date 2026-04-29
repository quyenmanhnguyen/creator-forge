"""Outlier Finder — discover small channels with breakout videos.

Strategy: search YouTube for videos matching ``seed`` published in the last
``window_days``, hydrate ``videos`` + ``channels`` stats, then score each
video by ``views / max(subs, 1000)`` (an "outperformance" ratio). Filter to
channels under ``max_subs`` and outlier ratio above ``min_outlier``.

The flagship signal a creator wants: *"Find small channels with videos
already going viral this week — these are clonable templates."*
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable


@dataclass
class OutlierRow:
    video_id: str
    title: str
    channel_id: str
    channel_title: str
    subs: int
    views: int
    likes: int
    comments: int
    published_at: str
    hours_since: float
    vph: float
    outlier_score: float
    thumbnail: str
    url: str
    duration: str


def _hours_since(published_at: str) -> float:
    try:
        dt = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        return max(delta.total_seconds() / 3600.0, 1.0)
    except Exception:
        return 1.0


def published_after_iso(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def compute_outlier_score(views: int, subs: int) -> float:
    """``views / max(subs, 1000)`` — capped reasonable floor.

    Subscribers floor of 1,000 prevents brand-new channels (10 subs) from
    dominating with ``views/subs = 10,000×``. Empirically a ratio of 1.5+
    is interesting; 5+ is "clonable" territory.
    """
    return views / max(subs, 1000)


def find_outliers(
    seed: str,
    *,
    region: str = "US",
    window_days: int = 7,
    max_subs: int = 100_000,
    min_outlier: float = 1.5,
    max_results: int = 50,
    search_fn: Callable[..., dict] | None = None,
    videos_fn: Callable[[list[str]], list[dict]] | None = None,
    channels_fn: Callable[[list[str]], list[dict]] | None = None,
) -> list[OutlierRow]:
    """Run the full outlier discovery pipeline.

    Functions are dependency-injected so tests can stub the YouTube layer.
    """
    if search_fn is None or videos_fn is None or channels_fn is None:
        from . import youtube as yt

        search_fn = search_fn or yt.search_raw
        videos_fn = videos_fn or yt.videos_details
        channels_fn = channels_fn or yt.channel_details

    after = published_after_iso(window_days)
    resp = search_fn(
        seed,
        max_results=max_results,
        region=region,
        order="viewCount",
        published_after=after,
    )
    items = resp.get("items", []) if isinstance(resp, dict) else []
    video_ids = [it["id"]["videoId"] for it in items if it.get("id", {}).get("videoId")]
    if not video_ids:
        return []

    videos = videos_fn(video_ids)
    if not videos:
        return []

    channel_ids = list({v["snippet"]["channelId"] for v in videos})
    channels = channels_fn(channel_ids)
    subs_by_channel: dict[str, int] = {}
    for ch in channels:
        try:
            subs_by_channel[ch["id"]] = int(ch.get("statistics", {}).get("subscriberCount", 0))
        except (TypeError, ValueError):
            subs_by_channel[ch["id"]] = 0

    rows: list[OutlierRow] = []
    for v in videos:
        sn = v.get("snippet", {})
        stats = v.get("statistics", {})
        cd = v.get("contentDetails", {})
        ch_id = sn.get("channelId", "")
        subs = subs_by_channel.get(ch_id, 0)
        if subs > max_subs:
            continue
        try:
            views = int(stats.get("viewCount", 0))
            likes = int(stats.get("likeCount", 0))
            n_comments = int(stats.get("commentCount", 0))
        except (TypeError, ValueError):
            views = likes = n_comments = 0
        ratio = compute_outlier_score(views, subs)
        if ratio < min_outlier:
            continue
        published = sn.get("publishedAt", "")
        hours = _hours_since(published)
        thumb = (
            sn.get("thumbnails", {}).get("medium", {}).get("url")
            or sn.get("thumbnails", {}).get("default", {}).get("url", "")
        )
        rows.append(
            OutlierRow(
                video_id=v.get("id", ""),
                title=sn.get("title", ""),
                channel_id=ch_id,
                channel_title=sn.get("channelTitle", ""),
                subs=subs,
                views=views,
                likes=likes,
                comments=n_comments,
                published_at=published,
                hours_since=hours,
                vph=views / hours if hours else 0.0,
                outlier_score=ratio,
                thumbnail=thumb,
                url=f"https://youtube.com/watch?v={v.get('id', '')}",
                duration=cd.get("duration", ""),
            )
        )

    rows.sort(key=lambda r: r.outlier_score, reverse=True)
    return rows


def to_records(rows: list[OutlierRow]) -> list[dict[str, Any]]:
    return [r.__dict__ for r in rows]
