"""Tiện ích chung: format số, parse ISO 8601 duration, v.v."""
from __future__ import annotations

import re
from datetime import timedelta


_ISO_DURATION = re.compile(
    r"P(?:(?P<days>\d+)D)?T?(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?"
)


def parse_iso_duration(s: str) -> timedelta:
    m = _ISO_DURATION.fullmatch(s or "")
    if not m:
        return timedelta()
    parts = {k: int(v) for k, v in m.groupdict(default="0").items()}
    return timedelta(
        days=parts["days"],
        hours=parts["hours"],
        minutes=parts["minutes"],
        seconds=parts["seconds"],
    )


def humanize_int(n: int | str | None) -> str:
    try:
        n = int(n)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "—"
    for unit, suffix in [(1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")]:
        if n >= unit:
            v = n / unit
            return f"{v:.1f}{suffix}".replace(".0", "")
    return str(n)


def engagement_rate(views: int, likes: int, comments: int) -> float:
    if views <= 0:
        return 0.0
    return (likes + comments) / views * 100


_SUFFIX_MULT = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}


def parse_count(value: object) -> int:
    """Parse compact human counts like ``"1.2K"`` / ``"3M"`` to int.

    Returns 0 on empty / unrecognised input.
    """
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).strip().replace(",", "")
    if not s:
        return 0
    suffix = s[-1].lower()
    if suffix in _SUFFIX_MULT:
        try:
            return int(float(s[:-1]) * _SUFFIX_MULT[suffix])
        except ValueError:
            return 0
    try:
        return int(float(s))
    except ValueError:
        return 0
