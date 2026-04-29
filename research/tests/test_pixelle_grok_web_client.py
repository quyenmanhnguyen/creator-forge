"""Tests for :mod:`core.pixelle.grok_web_client` (PR-A4.2).

All HTTP traffic is mocked. No real grok.com calls are made.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from core.pixelle import grok_web_client as gwc
from core.pixelle.grok_web_client import (
    GrokSession,
    GrokWebError,
    _build_image_request,
    _candidate_download_urls,
    _parse_cookie_blob,
    _parse_image_stream,
    generate_image_via_web,
    load_session_from_env,
)


# ─── Cookie parsing ─────────────────────────────────────────────────────────


def test_parse_cookie_blob_json_array():
    blob = json.dumps([{"name": "sso", "value": "abc"}, {"name": "sso-rw", "value": "def"}])
    out = _parse_cookie_blob(blob)
    assert out == {"sso": "abc", "sso-rw": "def"}


def test_parse_cookie_blob_json_object_single():
    blob = json.dumps({"name": "sso", "value": "abc"})
    out = _parse_cookie_blob(blob)
    assert out == {"sso": "abc"}


def test_parse_cookie_blob_header_string():
    out = _parse_cookie_blob("sso=abc; sso-rw=def; ; foo=bar")
    assert out == {"sso": "abc", "sso-rw": "def", "foo": "bar"}


def test_parse_cookie_blob_empty():
    assert _parse_cookie_blob("") == {}
    assert _parse_cookie_blob("   ") == {}


def test_parse_cookie_blob_invalid_json_raises():
    with pytest.raises(GrokWebError):
        _parse_cookie_blob("[not, valid, json")


def test_parse_cookie_blob_drops_extra_keys():
    """domain/path/expires fields should be silently ignored."""
    blob = json.dumps([
        {"name": "sso", "value": "abc", "domain": ".grok.com", "path": "/", "expires": 9999},
    ])
    assert _parse_cookie_blob(blob) == {"sso": "abc"}


# ─── load_session_from_env ──────────────────────────────────────────────────


def test_load_session_from_env_missing(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GROK_SESSION_COOKIES", raising=False)
    assert load_session_from_env() is None


def test_load_session_from_env_blank(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GROK_SESSION_COOKIES", "   ")
    assert load_session_from_env() is None


def test_load_session_from_env_valid(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(
        "GROK_SESSION_COOKIES",
        json.dumps([{"name": "sso", "value": "abc"}]),
    )
    sess = load_session_from_env()
    assert sess is not None
    assert sess.cookies == {"sso": "abc"}
    assert "User-Agent" in sess.headers
    assert sess.headers.get("Content-Type") == "application/json"


def test_load_session_from_env_invalid_json_raises(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GROK_SESSION_COOKIES", "[bad json")
    with pytest.raises(GrokWebError):
        load_session_from_env()


def test_load_session_from_env_no_pairs_raises(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GROK_SESSION_COOKIES", json.dumps([{"foo": "bar"}]))
    with pytest.raises(GrokWebError):
        load_session_from_env()


# ─── Request payload ────────────────────────────────────────────────────────


def test_build_image_request_includes_aspect_ratio_token():
    payload = _build_image_request("a cat", aspect_ratio="9:16", image_count=1)
    assert payload["message"] == "a cat --ar 9:16"
    assert payload["enableImageGeneration"] is True
    assert payload["imageGenerationCount"] == 1
    assert payload["modelName"] == "grok-3"
    assert payload["imageModelName"] == "imagine-x-1"


def test_build_image_request_image_count_coerced_to_int():
    payload = _build_image_request("x", aspect_ratio="16:9", image_count=4)
    assert isinstance(payload["imageGenerationCount"], int)
    assert payload["imageGenerationCount"] == 4


# ─── NDJSON parsing ─────────────────────────────────────────────────────────


def _ndjson_response(lines: list[str]) -> MagicMock:
    """Build a fake ``requests.Response`` with an ``iter_lines`` stub."""
    resp = MagicMock()
    resp.iter_lines = MagicMock(return_value=iter(lines))
    resp.status_code = 200
    return resp


def test_parse_image_stream_card_attachment_format():
    line = json.dumps({
        "result": {
            "response": {
                "cardAttachment": {
                    "jsonData": json.dumps({
                        "image_chunk": {
                            "imageUrl": "/generated/images/abc/img.jpg",
                            "imageIndex": 0,
                            "progress": 100,
                            "moderated": False,
                        }
                    })
                }
            }
        }
    })
    resp = _ndjson_response([line])
    records = _parse_image_stream(resp)
    assert len(records) == 1
    assert records[0]["image_url"] == "/generated/images/abc/img.jpg"
    assert records[0]["image_index"] == 0
    assert records[0]["moderated"] is False


def test_parse_image_stream_streaming_fallback_format():
    line = json.dumps({
        "result": {
            "response": {
                "streamingImageGenerationResponse": {
                    "imageUrl": "/generated/images/xyz/img.jpg",
                    "imageIndex": 1,
                    "progress": 100,
                }
            }
        }
    })
    resp = _ndjson_response([line])
    records = _parse_image_stream(resp)
    assert len(records) == 1
    assert records[0]["image_url"] == "/generated/images/xyz/img.jpg"


def test_parse_image_stream_late_chunk_overrides_moderation():
    """Two chunks for the same URL → the latest moderated flag wins."""
    early = json.dumps({
        "result": {"response": {"cardAttachment": {"jsonData": json.dumps({
            "image_chunk": {"imageUrl": "/img.jpg", "moderated": False, "progress": 50}
        })}}}
    })
    late = json.dumps({
        "result": {"response": {"cardAttachment": {"jsonData": json.dumps({
            "image_chunk": {"imageUrl": "/img.jpg", "moderated": True, "progress": 100}
        })}}}
    })
    resp = _ndjson_response([early, late])
    records = _parse_image_stream(resp)
    assert len(records) == 1
    assert records[0]["moderated"] is True


def test_parse_image_stream_skips_keepalive_and_invalid_json():
    line = json.dumps({
        "result": {"response": {"cardAttachment": {"jsonData": json.dumps({
            "image_chunk": {"imageUrl": "/img.jpg", "progress": 100}
        })}}}
    })
    resp = _ndjson_response(["", "  ", "not-json", line])
    records = _parse_image_stream(resp)
    assert len(records) == 1


def test_parse_image_stream_ignores_chunks_without_image_url():
    line = json.dumps({"result": {"response": {"text": "hello"}}})
    resp = _ndjson_response([line])
    assert _parse_image_stream(resp) == []


def test_parse_image_stream_results_sorted_by_image_index():
    a = json.dumps({"result": {"response": {"cardAttachment": {"jsonData": json.dumps({
        "image_chunk": {"imageUrl": "/a.jpg", "imageIndex": 1}
    })}}}})
    b = json.dumps({"result": {"response": {"cardAttachment": {"jsonData": json.dumps({
        "image_chunk": {"imageUrl": "/b.jpg", "imageIndex": 0}
    })}}}})
    resp = _ndjson_response([a, b])
    records = _parse_image_stream(resp)
    assert [r["image_url"] for r in records] == ["/b.jpg", "/a.jpg"]


# ─── Candidate URLs ─────────────────────────────────────────────────────────


def test_candidate_download_urls_strips_part_segment():
    urls = _candidate_download_urls("/generated/images/abc-part-0/image.jpg")
    # Both the part-0 and the stripped versions should be present.
    assert any("abc-part-0/image.jpg" in u for u in urls)
    assert any("abc/image.jpg" in u for u in urls)
    # Should hit both hosts.
    assert any(u.startswith("https://assets.grok.com") for u in urls)
    assert any(u.startswith("https://grok.com/rest/app-chat/asset/") for u in urls)


def test_candidate_download_urls_dedupes():
    urls = _candidate_download_urls("/img.jpg")
    assert len(urls) == len(set(urls))


# ─── End-to-end generate_image_via_web ──────────────────────────────────────


def _mock_post_with_lines(lines: list[str]) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.iter_lines = MagicMock(return_value=iter(lines))
    return resp


@pytest.fixture
def session() -> GrokSession:
    return GrokSession(cookies={"sso": "abc"}, headers={"User-Agent": "test"})


def _stream_with_one_image(url: str = "/generated/images/abc/img.jpg") -> list[str]:
    return [json.dumps({"result": {"response": {"cardAttachment": {"jsonData": json.dumps({
        "image_chunk": {"imageUrl": url, "imageIndex": 0, "progress": 100}
    })}}}})]


def test_generate_image_via_web_returns_bytes(monkeypatch, session):
    big_image = b"\x89PNG\r\n\x1a\n" + b"\x00" * (10 * 1024)  # 10 KB

    monkeypatch.setattr(
        gwc.requests, "post",
        MagicMock(return_value=_mock_post_with_lines(_stream_with_one_image())),
    )

    def _fake_get(url, **kwargs):
        r = MagicMock()
        r.status_code = 200
        r.content = big_image
        return r

    monkeypatch.setattr(gwc.requests, "get", _fake_get)

    images = generate_image_via_web("a happy cat", session)
    assert len(images) == 1
    assert images[0] == big_image


def test_generate_image_via_web_filters_blurred_moderation_image(monkeypatch, session):
    """Below MIN_IMAGE_BYTES = blurred placeholder. Should be filtered."""
    tiny = b"\xff" * 1024  # 1 KB << MIN_IMAGE_BYTES (5 KB)

    monkeypatch.setattr(
        gwc.requests, "post",
        MagicMock(return_value=_mock_post_with_lines(_stream_with_one_image())),
    )

    def _fake_get(url, **kwargs):
        r = MagicMock()
        r.status_code = 200
        r.content = tiny
        return r

    monkeypatch.setattr(gwc.requests, "get", _fake_get)

    with pytest.raises(GrokWebError, match="moderation-bypass threshold"):
        generate_image_via_web("borderline prompt", session)


def test_generate_image_via_web_raises_on_403(monkeypatch, session):
    resp = MagicMock()
    resp.status_code = 403
    resp.text = "Unauthorized"
    resp.iter_lines = MagicMock(return_value=iter([]))
    monkeypatch.setattr(gwc.requests, "post", MagicMock(return_value=resp))

    with pytest.raises(GrokWebError, match="rejected session cookies"):
        generate_image_via_web("p", session)


def test_generate_image_via_web_raises_on_401(monkeypatch, session):
    resp = MagicMock()
    resp.status_code = 401
    resp.text = "Unauthorized"
    resp.iter_lines = MagicMock(return_value=iter([]))
    monkeypatch.setattr(gwc.requests, "post", MagicMock(return_value=resp))

    with pytest.raises(GrokWebError, match="rejected session cookies"):
        generate_image_via_web("p", session)


def test_generate_image_via_web_raises_on_5xx(monkeypatch, session):
    resp = MagicMock()
    resp.status_code = 503
    resp.text = "Service Unavailable"
    resp.iter_lines = MagicMock(return_value=iter([]))
    monkeypatch.setattr(gwc.requests, "post", MagicMock(return_value=resp))

    with pytest.raises(GrokWebError, match="HTTP 503"):
        generate_image_via_web("p", session)


def test_generate_image_via_web_raises_on_no_images_in_stream(monkeypatch, session):
    """Stream completed but never carried an imageUrl."""
    line = json.dumps({"result": {"response": {"text": "no images here"}}})
    monkeypatch.setattr(
        gwc.requests, "post",
        MagicMock(return_value=_mock_post_with_lines([line])),
    )
    with pytest.raises(GrokWebError, match="no image URLs"):
        generate_image_via_web("p", session)


def test_generate_image_via_web_raises_on_empty_prompt(session):
    with pytest.raises(GrokWebError, match="empty"):
        generate_image_via_web("", session)
    with pytest.raises(GrokWebError, match="empty"):
        generate_image_via_web("   ", session)


def test_generate_image_via_web_handles_request_exception(monkeypatch, session):
    import requests

    def _boom(*a, **k):
        raise requests.ConnectionError("network down")

    monkeypatch.setattr(gwc.requests, "post", _boom)
    with pytest.raises(GrokWebError, match="grok.com request failed"):
        generate_image_via_web("p", session)


def test_generate_image_via_web_returns_largest_when_multiple_candidates(monkeypatch, session):
    """Race-download: keep the largest body across URL candidates."""
    big = b"\x89PNG" + b"\x00" * (20 * 1024)
    medium = b"\x89PNG" + b"\x00" * (8 * 1024)

    monkeypatch.setattr(
        gwc.requests, "post",
        MagicMock(return_value=_mock_post_with_lines(
            _stream_with_one_image("/generated/images/abc-part-0/img.jpg")
        )),
    )

    # Different URLs return different sizes; the function should keep the biggest.
    sizes_by_url: dict[str, bytes] = {}

    def _fake_get(url, **kwargs):
        r = MagicMock()
        r.status_code = 200
        # First URL gets big, others get medium.
        sizes_by_url.setdefault(url, big if not sizes_by_url else medium)
        r.content = sizes_by_url[url]
        return r

    monkeypatch.setattr(gwc.requests, "get", _fake_get)

    images = generate_image_via_web("p", session)
    assert images == [big]
