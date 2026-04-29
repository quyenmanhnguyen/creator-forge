"""Tests for core.outliers — outlier discovery pipeline."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from core import outliers


def _iso_now_minus(hours: float) -> str:
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def test_compute_outlier_score_basic():
    # 100k views on a 10k-sub channel → 10×
    assert outliers.compute_outlier_score(100_000, 10_000) == pytest.approx(10.0)


def test_compute_outlier_score_subs_floor():
    # New channel with 50 subs floors at 1000 to prevent crazy ratios
    assert outliers.compute_outlier_score(50_000, 50) == pytest.approx(50.0)


def test_published_after_iso_format():
    s = outliers.published_after_iso(7)
    assert s.endswith("Z")
    assert "T" in s
    assert len(s) == 20


def test_find_outliers_filters_large_channels():
    """Channels above max_subs should be excluded even with high views."""

    def stub_search(*args, **kwargs):
        return {
            "items": [
                {"id": {"videoId": "small1"}},
                {"id": {"videoId": "huge1"}},
            ]
        }

    def stub_videos(ids):
        return [
            {
                "id": "small1",
                "snippet": {
                    "title": "small channel banger",
                    "channelId": "ch_small",
                    "channelTitle": "Small Ch",
                    "publishedAt": _iso_now_minus(48),
                    "thumbnails": {"medium": {"url": "https://thumb/small.jpg"}},
                },
                "statistics": {"viewCount": "200000", "likeCount": "10000", "commentCount": "500"},
                "contentDetails": {"duration": "PT8M"},
            },
            {
                "id": "huge1",
                "snippet": {
                    "title": "MrBeast video",
                    "channelId": "ch_huge",
                    "channelTitle": "MrBeast",
                    "publishedAt": _iso_now_minus(48),
                    "thumbnails": {"medium": {"url": "https://thumb/huge.jpg"}},
                },
                "statistics": {"viewCount": "10000000", "likeCount": "500000", "commentCount": "10000"},
                "contentDetails": {"duration": "PT12M"},
            },
        ]

    def stub_channels(ids):
        return [
            {"id": "ch_small", "statistics": {"subscriberCount": "10000"}},
            {"id": "ch_huge", "statistics": {"subscriberCount": "200000000"}},
        ]

    rows = outliers.find_outliers(
        "test", max_subs=100_000, min_outlier=1.5, window_days=7,
        search_fn=stub_search, videos_fn=stub_videos, channels_fn=stub_channels,
    )
    assert len(rows) == 1
    assert rows[0].video_id == "small1"
    assert rows[0].outlier_score == pytest.approx(20.0)  # 200k / 10k


def test_find_outliers_filters_below_min_ratio():
    """Videos under the min outlier ratio should be filtered."""

    def stub_search(*args, **kwargs):
        return {"items": [{"id": {"videoId": "weak"}}]}

    def stub_videos(ids):
        return [{
            "id": "weak",
            "snippet": {
                "title": "ok video",
                "channelId": "ch1",
                "channelTitle": "C1",
                "publishedAt": _iso_now_minus(24),
                "thumbnails": {"default": {"url": "x"}},
            },
            "statistics": {"viewCount": "1000", "likeCount": "10", "commentCount": "1"},
            "contentDetails": {"duration": "PT5M"},
        }]

    def stub_channels(ids):
        return [{"id": "ch1", "statistics": {"subscriberCount": "10000"}}]

    # 1000 views / 10000 subs = 0.1× → below default 1.5
    rows = outliers.find_outliers(
        "test", min_outlier=1.5,
        search_fn=stub_search, videos_fn=stub_videos, channels_fn=stub_channels,
    )
    assert rows == []


def test_find_outliers_sorted_by_score_desc():
    """When multiple pass the filter, the highest outlier_score should come first."""

    def stub_search(*args, **kwargs):
        return {"items": [{"id": {"videoId": f"v{i}"}} for i in range(3)]}

    def stub_videos(ids):
        # v0: 5×, v1: 20×, v2: 3×
        viewcounts = ["50000", "200000", "30000"]
        return [
            {
                "id": f"v{i}",
                "snippet": {
                    "title": f"t{i}",
                    "channelId": f"ch{i}",
                    "channelTitle": f"C{i}",
                    "publishedAt": _iso_now_minus(24),
                    "thumbnails": {"default": {"url": "x"}},
                },
                "statistics": {"viewCount": v, "likeCount": "0", "commentCount": "0"},
                "contentDetails": {"duration": "PT5M"},
            }
            for i, v in enumerate(viewcounts)
        ]

    def stub_channels(ids):
        return [{"id": f"ch{i}", "statistics": {"subscriberCount": "10000"}} for i in range(3)]

    rows = outliers.find_outliers(
        "test", max_subs=100_000, min_outlier=1.0,
        search_fn=stub_search, videos_fn=stub_videos, channels_fn=stub_channels,
    )
    assert [r.video_id for r in rows] == ["v1", "v0", "v2"]


def test_find_outliers_empty_search():
    rows = outliers.find_outliers(
        "x",
        search_fn=lambda *a, **k: {"items": []},
        videos_fn=lambda ids: [],
        channels_fn=lambda ids: [],
    )
    assert rows == []
