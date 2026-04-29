"""Lấy comments YouTube qua youtube-comment-downloader (không cần API key)."""
from __future__ import annotations

from itertools import islice

from youtube_comment_downloader import YoutubeCommentDownloader, SORT_BY_POPULAR, SORT_BY_RECENT


def fetch_comments(video_id_or_url: str, limit: int = 200, sort: str = "popular") -> list[dict]:
    sort_by = SORT_BY_POPULAR if sort == "popular" else SORT_BY_RECENT
    url = (
        video_id_or_url
        if video_id_or_url.startswith("http")
        else f"https://www.youtube.com/watch?v={video_id_or_url}"
    )
    dl = YoutubeCommentDownloader()
    gen = dl.get_comments_from_url(url, sort_by=sort_by)
    return list(islice(gen, limit))
