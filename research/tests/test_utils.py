"""Unit tests for core.utils."""
from __future__ import annotations

from datetime import timedelta

import pytest

from core.utils import (
    engagement_rate,
    humanize_int,
    parse_count,
    parse_iso_duration,
)


class TestParseIsoDuration:
    def test_hours_minutes(self):
        assert parse_iso_duration("PT1H30M") == timedelta(hours=1, minutes=30)

    def test_seconds_only(self):
        assert parse_iso_duration("PT45S") == timedelta(seconds=45)

    def test_full(self):
        assert parse_iso_duration("PT2H15M30S") == timedelta(
            hours=2, minutes=15, seconds=30
        )

    def test_with_days(self):
        assert parse_iso_duration("P1DT2H") == timedelta(days=1, hours=2)

    def test_zero_on_invalid(self):
        assert parse_iso_duration("not-a-duration") == timedelta()

    def test_zero_on_empty(self):
        assert parse_iso_duration("") == timedelta()
        assert parse_iso_duration(None) == timedelta()  # type: ignore[arg-type]


class TestHumanizeInt:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (0, "0"),
            (999, "999"),
            (1_000, "1K"),
            (1_500, "1.5K"),
            (1_000_000, "1M"),
            (2_500_000, "2.5M"),
            (1_000_000_000, "1B"),
        ],
    )
    def test_known(self, value, expected):
        assert humanize_int(value) == expected

    def test_string_int(self):
        assert humanize_int("12345") == "12.3K"

    def test_invalid(self):
        assert humanize_int(None) == "—"
        assert humanize_int("abc") == "—"


class TestEngagementRate:
    def test_normal(self):
        # (50 + 10) / 1000 * 100 = 6.0
        assert engagement_rate(1000, 50, 10) == pytest.approx(6.0)

    def test_zero_views(self):
        assert engagement_rate(0, 10, 5) == 0.0

    def test_negative_views(self):
        assert engagement_rate(-10, 1, 1) == 0.0


class TestParseCount:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (None, 0),
            ("", 0),
            ("0", 0),
            ("123", 123),
            ("1,234", 1234),
            ("1.2K", 1200),
            ("1k", 1000),
            ("3M", 3_000_000),
            ("2.5B", 2_500_000_000),
            ("garbage", 0),
            (42, 42),
            (3.7, 3),
        ],
    )
    def test_parse(self, value, expected):
        assert parse_count(value) == expected

    def test_sort_order_correct(self):
        # The original bug: lexicographic "9" > "100".
        items = ["1.2K", "9", "100", "10", "2K", "500"]
        sorted_items = sorted(items, key=parse_count, reverse=True)
        assert sorted_items == ["2K", "1.2K", "500", "100", "10", "9"]
