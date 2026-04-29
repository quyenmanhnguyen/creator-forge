"""Tests for core/lang_detect.py — used by Video Cloner to pick output language."""
from __future__ import annotations

from core.lang_detect import detect_lang


def test_detect_english_returns_en() -> None:
    text = (
        "Hello everyone, welcome back to the channel. Today we are going to "
        "talk about productivity habits and how they completely changed my "
        "morning routine over the last six months."
    )
    assert detect_lang(text) == "en"


def test_detect_korean_returns_ko() -> None:
    text = (
        "안녕하세요 여러분, 오늘은 50대 이후의 말년운과 집안에서 가장 먼저"
        " 치워야 할 것들에 대해서 이야기 해보려고 합니다. 끝까지 시청해주세요."
    )
    assert detect_lang(text) == "ko"


def test_detect_japanese_returns_ja() -> None:
    text = (
        "こんにちは、皆さん。今日は朝のルーティンで生産性を上げる方法に"
        "ついてお話しします。最後までご視聴いただければ嬉しいです。"
    )
    assert detect_lang(text) == "ja"


def test_detect_vietnamese_returns_vi() -> None:
    text = (
        "Xin chào các bạn, hôm nay chúng ta sẽ cùng nhau tìm hiểu về"
        " những thói quen buổi sáng giúp tăng năng suất làm việc trong"
        " suốt cả ngày dài."
    )
    assert detect_lang(text) == "vi"


def test_detect_short_returns_default() -> None:
    """Below the 20-char minimum we just return the default."""
    assert detect_lang("hi", default="ko") == "ko"
    assert detect_lang("", default="ja") == "ja"


def test_detect_unknown_lang_falls_back() -> None:
    """A Russian sample (which we don't ship) should fall back to default."""
    russian = "Привет, как дела? Сегодня мы поговорим о здоровье и привычках."
    assert detect_lang(russian, default="en") == "en"
