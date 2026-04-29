"""HTTP client for grok.com web video-generation endpoints (Veo 3).

PR-A5 layers video generation on top of the same
:class:`~core.pixelle.grok_web_client.GrokSession` captured by
:func:`core.pixelle.grok_browser.grok_browser_login` for image
generation. There is no public xAI video API — this module mirrors
the AutoGrok Electron reference implementation:

1. **Create the media post** with
   ``POST /rest/media/post/create`` (``mediaType``,``prompt``).
   Returns a ``postId`` that bookmarks the chat thread the video
   generation will fold into.
2. **Kick off the generation** with
   ``POST /rest/app-chat/conversations/new`` carrying
   ``toolOverrides.videoGen=true`` and a ``videoGenModelConfig`` that
   wraps the ``parentPostId``, ``aspectRatio`` (``9:16`` or ``16:9``),
   ``videoLength`` (6 or 10 seconds) and ``resolutionName`` (``480p``
   or ``720p``).
3. **Stream NDJSON progress** from the chat endpoint until a chunk
   arrives with ``progress == 100`` and a ``videoUrl``. Per AutoGrok,
   ``isSoftBlock`` / ``isDisallowed`` flags can appear for one
   side-by-side candidate while the other still succeeds — we only
   give up when *every* observed candidate is blocked.
4. **Download the MP4** by GET-ing ``assets.grok.com/<videoUrl>``,
   streamed to disk so we don't blow memory on a 30–50 MB clip.

Errors:

- :class:`GrokWebError` (re-exported from
  :mod:`core.pixelle.grok_web_client`) is the only exception raised
  outwards. Callers translate it into ``UsePlaceholderFallback`` so
  the Producer page degrades cleanly to gradient.

This module makes **no calls at import time**. ``requests`` is
imported at module top because it is already a project dependency.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Callable

import requests

from core.pixelle.grok_web_client import (
    GROK_ASSETS_URL,
    GROK_BASE_URL,
    GrokSession,
    GrokWebError,
    _iter_ndjson_lines,
)

LOG = logging.getLogger(__name__)


# ─── Endpoints ──────────────────────────────────────────────────────────────

MEDIA_POST_CREATE_URL = f"{GROK_BASE_URL}/rest/media/post/create"
CONVERSATIONS_NEW_URL = f"{GROK_BASE_URL}/rest/app-chat/conversations/new"

# Defaults match AutoGrok's app.config.js for portrait Shorts.
DEFAULT_ASPECT_RATIO = "9:16"
DEFAULT_VIDEO_LENGTH_S = 6
DEFAULT_RESOLUTION = "720p"
ALLOWED_ASPECT_RATIOS = ("9:16", "16:9", "1:1")
ALLOWED_VIDEO_LENGTHS = (6, 10)
ALLOWED_RESOLUTIONS = ("480p", "720p")

# Watchdog: server-side video gen runs 60–180 s; allow ample headroom
# but fail fast if the stream is wedged with no progress at all.
DEFAULT_REQUEST_TIMEOUT_S = 240.0
DEFAULT_DOWNLOAD_TIMEOUT_S = 120.0
DEFAULT_DOWNLOAD_CHUNK = 64 * 1024
PROGRESS_LOG_INTERVAL_S = 5.0


# ─── Public API ─────────────────────────────────────────────────────────────


def create_media_post(
    prompt: str,
    session: GrokSession,
    *,
    timeout_s: float = 30.0,
) -> str:
    """Reserve a ``postId`` for a video generation by calling
    ``POST /rest/media/post/create``.

    Returns the ``post.id`` string, which becomes the
    ``parentPostId`` referenced by :func:`generate_video_via_web`.
    """
    if not prompt or not prompt.strip():
        raise GrokWebError("Cannot create a media post with an empty prompt.")

    payload = {
        "mediaType": "MEDIA_POST_TYPE_VIDEO",
        "prompt": prompt.strip(),
    }
    try:
        resp = requests.post(
            MEDIA_POST_CREATE_URL,
            cookies=session.cookies,
            headers=session.headers,
            json=payload,
            timeout=timeout_s,
        )
    except requests.RequestException as exc:
        raise GrokWebError(f"grok.com media/post/create failed: {exc}") from exc

    if resp.status_code in (401, 403):
        raise GrokWebError(
            f"grok.com rejected session cookies on media/post/create "
            f"(HTTP {resp.status_code}). Re-login to refresh the session."
        )
    if resp.status_code >= 400:
        raise GrokWebError(
            f"grok.com media/post/create HTTP {resp.status_code}: "
            f"{(resp.text or '')[:200]}"
        )

    try:
        body = resp.json()
    except ValueError as exc:
        raise GrokWebError("media/post/create returned non-JSON body.") from exc

    post_id = _safe_get(body, "post", "id")
    if not isinstance(post_id, str) or not post_id:
        raise GrokWebError(
            f"media/post/create returned no postId. Body: {str(body)[:200]}"
        )
    return post_id


def generate_video_via_web(
    prompt: str,
    session: GrokSession,
    *,
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    video_length: int = DEFAULT_VIDEO_LENGTH_S,
    resolution: str = DEFAULT_RESOLUTION,
    output_path: Path,
    on_progress: Callable[[int], None] | None = None,
    request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S,
    download_timeout_s: float = DEFAULT_DOWNLOAD_TIMEOUT_S,
) -> Path:
    """Generate a single video via grok.com → download to *output_path*.

    Pipeline:

    1. :func:`create_media_post` reserves a ``postId``.
    2. Open the chat NDJSON stream with ``videoGenModelConfig``
       wrapping that ``postId`` plus the user's ``aspect_ratio``,
       ``video_length`` and ``resolution`` knobs.
    3. Watch each chunk for ``streamingVideoGenerationResponse``;
       capture progress and the final ``videoUrl``.
    4. Stream-download the MP4 to disk.

    ``on_progress`` (optional) receives integer percent updates 0..100
    each time the server reports new progress; the callback is also
    invoked with ``100`` once the download completes.
    """
    if not prompt or not prompt.strip():
        raise GrokWebError("Cannot generate a video with an empty prompt.")
    aspect_ratio = _validate_aspect_ratio(aspect_ratio)
    video_length = _validate_video_length(video_length)
    resolution = _validate_resolution(resolution)

    post_id = create_media_post(prompt, session)
    payload = _build_video_request(
        prompt=prompt,
        post_id=post_id,
        aspect_ratio=aspect_ratio,
        video_length=video_length,
        resolution=resolution,
    )

    try:
        resp = requests.post(
            CONVERSATIONS_NEW_URL,
            cookies=session.cookies,
            headers=session.headers,
            json=payload,
            stream=True,
            timeout=request_timeout_s,
        )
    except requests.RequestException as exc:
        raise GrokWebError(f"grok.com conversations/new failed: {exc}") from exc

    if resp.status_code in (401, 403):
        raise GrokWebError(
            f"grok.com rejected session cookies on conversations/new "
            f"(HTTP {resp.status_code}). Re-login to refresh the session."
        )
    if resp.status_code >= 400:
        raise GrokWebError(
            f"grok.com conversations/new HTTP {resp.status_code}: "
            f"{(resp.text or '')[:200]}"
        )

    video_url = _consume_video_stream(resp, on_progress=on_progress)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _download_video(
        video_url, session, output_path=output_path, timeout_s=download_timeout_s
    )
    if on_progress is not None:
        try:
            on_progress(100)
        except Exception:  # noqa: BLE001 — UI callbacks must not break us
            pass
    return output_path


# ─── Request payload ────────────────────────────────────────────────────────


def _build_video_request(
    *,
    prompt: str,
    post_id: str,
    aspect_ratio: str,
    video_length: int,
    resolution: str,
) -> dict:
    """Return the JSON body for the video-gen ``conversations/new`` call.

    Mirrors the AutoGrok ``VideoService.js`` payload exactly — the
    server is strict about field names.
    """
    return {
        "temporary": True,
        "modelName": "grok-3",
        "message": f"{prompt.strip()} --mode=custom",
        "fileAttachments": [],
        "imageAttachments": [],
        "toolOverrides": {"videoGen": True},
        "enableSideBySide": True,
        "enableImageGeneration": False,
        "returnImageBytes": False,
        "isReasoning": False,
        "disableTextFollowUps": True,
        "responseMetadata": {
            "modelConfigOverride": {
                "modelMap": {
                    "videoGenModelConfig": {
                        "parentPostId": post_id,
                        "aspectRatio": aspect_ratio,
                        "videoLength": int(video_length),
                        "isVideoEdit": False,
                        "resolutionName": resolution,
                    }
                }
            }
        },
        "modelMode": "MODEL_MODE_EXPERT",
    }


# ─── NDJSON consumer ────────────────────────────────────────────────────────


def _consume_video_stream(
    resp,
    *,
    on_progress: Callable[[int], None] | None,
) -> str:
    """Read the NDJSON stream until a ``videoUrl`` arrives.

    Raises :class:`GrokWebError` if every observed candidate ends up
    soft-blocked / disallowed, or if the stream closes before any
    ``videoUrl`` materialises.
    """
    candidates: dict[str, dict] = {}
    last_progress: dict[str, int] = {}
    last_log = 0.0

    for chunk in _iter_ndjson_lines(resp):
        record = _extract_video_record(chunk)
        if record is None:
            continue

        key = record.get("video_id") or record.get("video_url") or "_default_"
        candidates[key] = record

        progress = record.get("progress")
        if isinstance(progress, int):
            prev = last_progress.get(key)
            if prev is None or progress > prev:
                last_progress[key] = progress
                if on_progress is not None:
                    try:
                        on_progress(progress)
                    except Exception:  # noqa: BLE001 — UI callbacks must not break us
                        pass
                # Throttle log noise — once per few seconds is plenty.
                now = time.monotonic()
                if now - last_log >= PROGRESS_LOG_INTERVAL_S:
                    LOG.info("grok video progress %s%% (candidate=%s)", progress, key)
                    last_log = now

        # Found a finished, unblocked candidate — short-circuit.
        if (
            record.get("video_url")
            and not record.get("soft_block")
            and not record.get("disallowed")
            and (record.get("progress") in (None, 100))
        ):
            return record["video_url"]

    # Stream finished. Pick the best candidate we have.
    finished = [
        r
        for r in candidates.values()
        if r.get("video_url") and not r.get("soft_block") and not r.get("disallowed")
    ]
    if finished:
        # Prefer the one that hit 100 if available.
        finished.sort(key=lambda r: r.get("progress") or 0, reverse=True)
        return finished[0]["video_url"]

    if not candidates:
        raise GrokWebError(
            "grok.com conversations/new stream returned no video records."
        )
    blocked = [r for r in candidates.values() if r.get("soft_block") or r.get("disallowed")]
    if blocked and len(blocked) == len(candidates):
        raise GrokWebError(
            "grok.com moderation blocked every video candidate "
            "(soft_block / disallowed)."
        )
    raise GrokWebError(
        "grok.com video generation never produced a videoUrl "
        "(stream closed before progress hit 100)."
    )


def _extract_video_record(chunk: dict) -> dict | None:
    """Extract the ``streamingVideoGenerationResponse`` block, if any."""
    response = _safe_get(chunk, "result", "response")
    if not isinstance(response, dict):
        return None
    sv = response.get("streamingVideoGenerationResponse")
    if not isinstance(sv, dict):
        return None
    video_url = sv.get("videoUrl") or sv.get("video_url")
    record: dict = {
        "video_url": video_url,
        "video_id": sv.get("videoId") or sv.get("video_id"),
        "progress": _coerce_int(sv.get("progress")),
        "soft_block": bool(sv.get("isSoftBlock") or sv.get("is_soft_block")),
        "disallowed": bool(sv.get("isDisallowed") or sv.get("is_disallowed")),
    }
    # Drop entries that carry zero useful data.
    if not record["video_url"] and record["progress"] is None and not record["video_id"]:
        return None
    return record


# ─── Download ───────────────────────────────────────────────────────────────


def _download_video(
    video_url: str,
    session: GrokSession,
    *,
    output_path: Path,
    timeout_s: float,
) -> Path:
    """Stream the finished MP4 from ``assets.grok.com`` to disk."""
    full_url = _resolve_video_url(video_url)
    try:
        resp = requests.get(
            full_url,
            cookies=session.cookies,
            headers=session.headers,
            stream=True,
            timeout=timeout_s,
        )
    except requests.RequestException as exc:
        raise GrokWebError(f"grok.com video download failed: {exc}") from exc

    if resp.status_code >= 400:
        raise GrokWebError(
            f"grok.com video download HTTP {resp.status_code} for {full_url}"
        )

    written = 0
    try:
        with output_path.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=DEFAULT_DOWNLOAD_CHUNK):
                if not chunk:
                    continue
                fh.write(chunk)
                written += len(chunk)
    except OSError as exc:
        raise GrokWebError(f"Failed to write video to {output_path}: {exc}") from exc

    if written < 1024:
        # An MP4 small enough to fit in a single TCP frame is almost
        # certainly an error page or a moderated stub.
        raise GrokWebError(
            f"Downloaded video is suspiciously small ({written} bytes); "
            "likely an error response."
        )
    return output_path


def _resolve_video_url(video_url: str) -> str:
    """Promote a relative ``/generated/...`` URL to the assets host."""
    if video_url.startswith("http://") or video_url.startswith("https://"):
        return video_url
    if not video_url.startswith("/"):
        video_url = "/" + video_url
    return f"{GROK_ASSETS_URL}{video_url}"


# ─── Validation helpers ─────────────────────────────────────────────────────


def _validate_aspect_ratio(value: str) -> str:
    if value not in ALLOWED_ASPECT_RATIOS:
        raise GrokWebError(
            f"Unsupported aspect_ratio={value!r}. "
            f"Allowed: {ALLOWED_ASPECT_RATIOS}."
        )
    return value


def _validate_video_length(value: int) -> int:
    try:
        ivalue = int(value)
    except (TypeError, ValueError) as exc:
        raise GrokWebError(f"video_length must be an int, got {value!r}.") from exc
    if ivalue not in ALLOWED_VIDEO_LENGTHS:
        raise GrokWebError(
            f"Unsupported video_length={ivalue}. "
            f"Allowed: {ALLOWED_VIDEO_LENGTHS}."
        )
    return ivalue


def _validate_resolution(value: str) -> str:
    if value not in ALLOWED_RESOLUTIONS:
        raise GrokWebError(
            f"Unsupported resolution={value!r}. "
            f"Allowed: {ALLOWED_RESOLUTIONS}."
        )
    return value


def _safe_get(obj, *keys):
    cur = obj
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _coerce_int(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


__all__ = [
    "ALLOWED_ASPECT_RATIOS",
    "ALLOWED_RESOLUTIONS",
    "ALLOWED_VIDEO_LENGTHS",
    "DEFAULT_ASPECT_RATIO",
    "DEFAULT_RESOLUTION",
    "DEFAULT_VIDEO_LENGTH_S",
    "create_media_post",
    "generate_video_via_web",
]
