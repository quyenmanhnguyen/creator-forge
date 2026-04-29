"""Tests for :mod:`core.pixelle.grok_video_client` (PR-A5).

All HTTP traffic is mocked. No real grok.com calls are made.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from core.pixelle import grok_video_client as gvc
from core.pixelle.grok_video_client import (
    _build_video_request,
    _consume_video_stream,
    _resolve_video_url,
    _validate_aspect_ratio,
    _validate_resolution,
    _validate_video_length,
    create_media_post,
    generate_video_via_web,
)
from core.pixelle.grok_web_client import GrokSession, GrokWebError


def _session() -> GrokSession:
    return GrokSession(
        cookies={"sso": "abc", "sso-rw": "def"},
        headers={"User-Agent": "test", "x-statsig-id": "stx"},
        email="user@x.ai",
    )


# ─── Validation helpers ─────────────────────────────────────────────────────


def test_validate_aspect_ratio_accepts_known():
    assert _validate_aspect_ratio("9:16") == "9:16"
    assert _validate_aspect_ratio("16:9") == "16:9"
    assert _validate_aspect_ratio("1:1") == "1:1"


def test_validate_aspect_ratio_rejects_unknown():
    with pytest.raises(GrokWebError):
        _validate_aspect_ratio("4:3")


def test_validate_video_length_accepts_known():
    assert _validate_video_length(6) == 6
    assert _validate_video_length(10) == 10
    # int-coercible strings are also fine.
    assert _validate_video_length("6") == 6  # type: ignore[arg-type]


def test_validate_video_length_rejects_unknown():
    with pytest.raises(GrokWebError):
        _validate_video_length(8)
    with pytest.raises(GrokWebError):
        _validate_video_length("nope")  # type: ignore[arg-type]


def test_validate_resolution_accepts_known():
    assert _validate_resolution("480p") == "480p"
    assert _validate_resolution("720p") == "720p"


def test_validate_resolution_rejects_unknown():
    with pytest.raises(GrokWebError):
        _validate_resolution("1080p")


# ─── _resolve_video_url ─────────────────────────────────────────────────────


def test_resolve_video_url_relative():
    assert (
        _resolve_video_url("/generated/videos/abc.mp4")
        == "https://assets.grok.com/generated/videos/abc.mp4"
    )


def test_resolve_video_url_no_leading_slash():
    assert (
        _resolve_video_url("generated/videos/abc.mp4")
        == "https://assets.grok.com/generated/videos/abc.mp4"
    )


def test_resolve_video_url_absolute_passthrough():
    url = "https://cdn.example.com/video.mp4"
    assert _resolve_video_url(url) == url


# ─── _build_video_request ───────────────────────────────────────────────────


def test_build_video_request_shape():
    payload = _build_video_request(
        prompt="a cat skating",
        post_id="post-123",
        aspect_ratio="9:16",
        video_length=6,
        resolution="720p",
    )
    assert payload["temporary"] is True
    assert payload["modelName"] == "grok-3"
    assert payload["message"].endswith("--mode=custom")
    assert payload["toolOverrides"] == {"videoGen": True}
    assert payload["enableSideBySide"] is True
    config = payload["responseMetadata"]["modelConfigOverride"]["modelMap"][
        "videoGenModelConfig"
    ]
    assert config["parentPostId"] == "post-123"
    assert config["aspectRatio"] == "9:16"
    assert config["videoLength"] == 6
    assert config["resolutionName"] == "720p"
    assert config["isVideoEdit"] is False


def test_build_video_request_strips_whitespace():
    payload = _build_video_request(
        prompt="   prompt   ",
        post_id="x",
        aspect_ratio="9:16",
        video_length=6,
        resolution="720p",
    )
    assert payload["message"].startswith("prompt ")


# ─── create_media_post ──────────────────────────────────────────────────────


def test_create_media_post_returns_post_id(monkeypatch: pytest.MonkeyPatch):
    captured = {}

    def fake_post(url, **kw):
        captured["url"] = url
        captured["json"] = kw["json"]
        captured["cookies"] = kw["cookies"]
        captured["headers"] = kw["headers"]
        resp = MagicMock()
        resp.status_code = 200
        resp.json = MagicMock(return_value={"post": {"id": "post-123"}})
        return resp

    monkeypatch.setattr(gvc.requests, "post", fake_post)
    out = create_media_post("a calm meadow", _session())
    assert out == "post-123"
    assert captured["url"].endswith("/rest/media/post/create")
    assert captured["json"]["mediaType"] == "MEDIA_POST_TYPE_VIDEO"
    assert captured["json"]["prompt"] == "a calm meadow"
    assert captured["cookies"] == {"sso": "abc", "sso-rw": "def"}


def test_create_media_post_rejects_empty_prompt():
    with pytest.raises(GrokWebError):
        create_media_post("   ", _session())


def test_create_media_post_translates_403(monkeypatch: pytest.MonkeyPatch):
    resp = MagicMock(status_code=403, text="forbidden")
    monkeypatch.setattr(gvc.requests, "post", lambda *a, **kw: resp)
    with pytest.raises(GrokWebError, match="rejected session cookies"):
        create_media_post("p", _session())


def test_create_media_post_translates_5xx(monkeypatch: pytest.MonkeyPatch):
    resp = MagicMock(status_code=500, text="boom")
    monkeypatch.setattr(gvc.requests, "post", lambda *a, **kw: resp)
    with pytest.raises(GrokWebError, match="HTTP 500"):
        create_media_post("p", _session())


def test_create_media_post_translates_request_exception(
    monkeypatch: pytest.MonkeyPatch,
):
    def boom(*a, **kw):
        import requests as r  # local alias to construct the exception

        raise r.ConnectionError("net down")

    monkeypatch.setattr(gvc.requests, "post", boom)
    with pytest.raises(GrokWebError, match="media/post/create failed"):
        create_media_post("p", _session())


def test_create_media_post_missing_id(monkeypatch: pytest.MonkeyPatch):
    resp = MagicMock(status_code=200)
    resp.json = MagicMock(return_value={"post": {}})
    monkeypatch.setattr(gvc.requests, "post", lambda *a, **kw: resp)
    with pytest.raises(GrokWebError, match="no postId"):
        create_media_post("p", _session())


def test_create_media_post_non_json(monkeypatch: pytest.MonkeyPatch):
    resp = MagicMock(status_code=200)
    resp.json = MagicMock(side_effect=ValueError("not json"))
    monkeypatch.setattr(gvc.requests, "post", lambda *a, **kw: resp)
    with pytest.raises(GrokWebError, match="non-JSON"):
        create_media_post("p", _session())


# ─── _consume_video_stream ──────────────────────────────────────────────────


def _ndjson_resp(lines: list[str]) -> MagicMock:
    """Build a fake response whose ``iter_lines`` yields the given lines."""
    resp = MagicMock()
    resp.iter_lines = MagicMock(return_value=iter(lines))
    resp.status_code = 200
    return resp


def _video_record(
    *,
    progress: int,
    video_url: str | None = None,
    video_id: str | None = None,
    soft_block: bool = False,
    disallowed: bool = False,
) -> str:
    body = {
        "result": {
            "response": {
                "streamingVideoGenerationResponse": {
                    "progress": progress,
                    "isSoftBlock": soft_block,
                    "isDisallowed": disallowed,
                }
            }
        }
    }
    sv = body["result"]["response"]["streamingVideoGenerationResponse"]
    if video_url is not None:
        sv["videoUrl"] = video_url
    if video_id is not None:
        sv["videoId"] = video_id
    return json.dumps(body)


def test_consume_stream_short_circuits_on_complete():
    lines = [
        _video_record(progress=10),
        _video_record(progress=50),
        _video_record(
            progress=100, video_url="/generated/videos/x.mp4", video_id="v1"
        ),
    ]
    resp = _ndjson_resp(lines)
    seen: list[int] = []
    out = _consume_video_stream(resp, on_progress=seen.append)
    assert out == "/generated/videos/x.mp4"
    assert seen[-1] == 100


def test_consume_stream_picks_best_finished_at_eof():
    lines = [
        _video_record(progress=70, video_id="v1"),
        _video_record(
            progress=100,
            video_id="v1",
            video_url="/generated/videos/x.mp4",
        ),
        # Stream closes before progress=100 is short-circuited (e.g. the
        # final chunk arrives wrapped with extra metadata that the
        # consumer's fast-path ignores). EOF logic must still pick it.
    ]
    resp = _ndjson_resp(lines)
    out = _consume_video_stream(resp, on_progress=None)
    assert out == "/generated/videos/x.mp4"


def test_consume_stream_all_blocked_raises():
    lines = [
        _video_record(progress=100, video_id="v1", soft_block=True, video_url="/a"),
        _video_record(progress=100, video_id="v2", disallowed=True, video_url="/b"),
    ]
    resp = _ndjson_resp(lines)
    with pytest.raises(GrokWebError, match="moderation blocked"):
        _consume_video_stream(resp, on_progress=None)


def test_consume_stream_one_blocked_one_ok_returns_ok():
    lines = [
        _video_record(progress=100, video_id="v1", soft_block=True, video_url="/a"),
        _video_record(progress=100, video_id="v2", video_url="/b"),
    ]
    resp = _ndjson_resp(lines)
    out = _consume_video_stream(resp, on_progress=None)
    assert out == "/b"


def test_consume_stream_no_records_raises():
    resp = _ndjson_resp([json.dumps({"result": {"response": {}}})])
    with pytest.raises(GrokWebError, match="no video records"):
        _consume_video_stream(resp, on_progress=None)


def test_consume_stream_progress_only_no_url_raises():
    lines = [
        _video_record(progress=20),
        _video_record(progress=50),
    ]
    resp = _ndjson_resp(lines)
    with pytest.raises(GrokWebError, match="never produced a videoUrl"):
        _consume_video_stream(resp, on_progress=None)


def test_consume_stream_callback_errors_are_swallowed():
    lines = [_video_record(progress=100, video_url="/a")]
    resp = _ndjson_resp(lines)

    def boom(_p):
        raise RuntimeError("UI exploded")

    out = _consume_video_stream(resp, on_progress=boom)
    assert out == "/a"


# ─── generate_video_via_web (integration of the parts) ──────────────────────


def test_generate_video_happy_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Drives the full pipeline: media post → stream → download."""
    calls: list[tuple[str, dict]] = []

    def fake_post(url, **kw):
        calls.append((url, kw))
        if url.endswith("/rest/media/post/create"):
            r = MagicMock(status_code=200)
            r.json = MagicMock(return_value={"post": {"id": "post-xyz"}})
            return r
        # conversations/new — return an NDJSON stream.
        r = MagicMock(status_code=200)
        r.iter_lines = MagicMock(
            return_value=iter(
                [
                    _video_record(progress=10),
                    _video_record(
                        progress=100,
                        video_url="/generated/videos/v.mp4",
                    ),
                ]
            )
        )
        return r

    def fake_get(url, **kw):
        # Streamed download — return a >1KB chunk so the size check passes.
        r = MagicMock(status_code=200)
        r.iter_content = MagicMock(return_value=iter([b"M" * 4096]))
        return r

    monkeypatch.setattr(gvc.requests, "post", fake_post)
    monkeypatch.setattr(gvc.requests, "get", fake_get)

    out_path = tmp_path / "scene.mp4"
    progress_seen: list[int] = []
    result = generate_video_via_web(
        "a tranquil river",
        _session(),
        aspect_ratio="9:16",
        video_length=6,
        resolution="720p",
        output_path=out_path,
        on_progress=progress_seen.append,
    )
    assert result == out_path
    assert out_path.exists()
    assert out_path.stat().st_size >= 1024
    # First call was media/post/create, second was conversations/new.
    assert calls[0][0].endswith("/rest/media/post/create")
    assert calls[1][0].endswith("/rest/app-chat/conversations/new")
    # Final progress callback fires with 100 after download completes.
    assert progress_seen[-1] == 100


def test_generate_video_rejects_bad_args(tmp_path: Path):
    out_path = tmp_path / "x.mp4"
    with pytest.raises(GrokWebError):
        generate_video_via_web(
            "p",
            _session(),
            aspect_ratio="4:3",
            video_length=6,
            resolution="720p",
            output_path=out_path,
        )
    with pytest.raises(GrokWebError):
        generate_video_via_web(
            "p",
            _session(),
            aspect_ratio="9:16",
            video_length=8,
            resolution="720p",
            output_path=out_path,
        )
    with pytest.raises(GrokWebError):
        generate_video_via_web(
            "p",
            _session(),
            aspect_ratio="9:16",
            video_length=6,
            resolution="1080p",
            output_path=out_path,
        )


def test_generate_video_empty_prompt_raises(tmp_path: Path):
    with pytest.raises(GrokWebError):
        generate_video_via_web(
            "   ",
            _session(),
            output_path=tmp_path / "x.mp4",
        )


def test_generate_video_403_on_chat_translates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    def fake_post(url, **kw):
        if url.endswith("/rest/media/post/create"):
            r = MagicMock(status_code=200)
            r.json = MagicMock(return_value={"post": {"id": "post-xyz"}})
            return r
        return MagicMock(status_code=403, text="forbidden")

    monkeypatch.setattr(gvc.requests, "post", fake_post)

    with pytest.raises(GrokWebError, match="rejected session cookies"):
        generate_video_via_web(
            "p",
            _session(),
            output_path=tmp_path / "x.mp4",
        )


def test_generate_video_download_failure_translates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    def fake_post(url, **kw):
        if url.endswith("/rest/media/post/create"):
            r = MagicMock(status_code=200)
            r.json = MagicMock(return_value={"post": {"id": "post-xyz"}})
            return r
        r = MagicMock(status_code=200)
        r.iter_lines = MagicMock(
            return_value=iter(
                [_video_record(progress=100, video_url="/generated/videos/v.mp4")]
            )
        )
        return r

    def fake_get(url, **kw):
        return MagicMock(status_code=404)

    monkeypatch.setattr(gvc.requests, "post", fake_post)
    monkeypatch.setattr(gvc.requests, "get", fake_get)

    with pytest.raises(GrokWebError, match="download HTTP 404"):
        generate_video_via_web(
            "p",
            _session(),
            output_path=tmp_path / "x.mp4",
        )


def test_generate_video_too_small_download_translates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    def fake_post(url, **kw):
        if url.endswith("/rest/media/post/create"):
            r = MagicMock(status_code=200)
            r.json = MagicMock(return_value={"post": {"id": "post-xyz"}})
            return r
        r = MagicMock(status_code=200)
        r.iter_lines = MagicMock(
            return_value=iter(
                [_video_record(progress=100, video_url="/generated/videos/v.mp4")]
            )
        )
        return r

    def fake_get(url, **kw):
        r = MagicMock(status_code=200)
        # 100 bytes — way under the 1KB sanity threshold.
        r.iter_content = MagicMock(return_value=iter([b"X" * 100]))
        return r

    monkeypatch.setattr(gvc.requests, "post", fake_post)
    monkeypatch.setattr(gvc.requests, "get", fake_get)

    with pytest.raises(GrokWebError, match="suspiciously small"):
        generate_video_via_web(
            "p",
            _session(),
            output_path=tmp_path / "x.mp4",
        )
