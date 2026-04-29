"""HTTP client for grok.com web image-generation endpoints.

Authenticates with **session cookies + headers** captured from a real
browser. The recommended path is :mod:`core.pixelle.grok_browser`,
which drives Playwright through ``accounts.x.ai/sign-in`` and pulls
out everything this module needs at runtime. There is no public xAI
API behind this — we mirror the AutoGrok Electron reference
implementation:

1. ``POST /rest/app-chat/conversations/new`` with
   ``enableImageGeneration: true`` and the user's prompt.
2. Server streams **NDJSON** chunks. Each line is a JSON object that
   may carry partial state. We parse two shapes:

   - ``result.response.cardAttachment.jsonData`` (preferred) → contains
     an ``image_chunk`` block with ``imageUrl``, ``imageIndex`` and
     ``progress``.
   - ``result.response.streamingImageGenerationResponse`` (fallback).
3. For each unique ``image_url`` we **race-download** several CDN URL
   variants and keep the largest one — moderated images on the CDN are
   blurred to a tiny <25 KB JPEG, while the unblurred version sits on
   the asset host for a brief window.
4. Images smaller than :data:`MIN_IMAGE_BYTES` are dropped.

Errors:

- :class:`GrokWebError` is the only exception this module raises.
  Callers (the :class:`~core.pixelle.visual_providers.GrokImageProvider`)
  translate it into ``UsePlaceholderFallback`` so the Producer page
  can degrade gracefully to the gradient placeholder.

This module makes **no calls at import time**. ``requests`` is imported
at module top because it is already a project dependency. The optional
:func:`load_session_from_env` helper exists purely as a power-user
escape hatch (CLI / CI smoke tests); the Streamlit UI does not use it.
"""
from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Iterable

import requests

# ─── Constants ───────────────────────────────────────────────────────────────

GROK_BASE_URL = "https://grok.com"
GROK_ASSETS_URL = "https://assets.grok.com"
CONVERSATIONS_NEW = f"{GROK_BASE_URL}/rest/app-chat/conversations/new"

# Default UA — a recent stable Chrome string, which is what the AutoGrok
# Electron client also impersonates. Avoids the bare "python-requests"
# UA that grok.com rate-limits aggressively.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Network knobs.
DEFAULT_REQUEST_TIMEOUT_S = 180.0
DEFAULT_DOWNLOAD_TIMEOUT_S = 30.0

# Below this, the image is almost certainly the moderation-blur
# placeholder and we should drop it. AutoGrok uses 5 KB.
MIN_IMAGE_BYTES = 5 * 1024


# ─── Errors ─────────────────────────────────────────────────────────────────


class GrokWebError(RuntimeError):
    """Any failure talking to grok.com (auth, parse, download, ...)."""


# ─── Session loader ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GrokSession:
    """Bundles the cookies + headers needed to talk to grok.com.

    The ``cookies`` mapping is what :func:`requests.post` accepts as
    its ``cookies=`` keyword. Headers include a browser-like UA, the
    JSON content type used by the chat endpoint, and (when captured
    via Playwright) the rotating ``x-statsig-id`` header the server
    expects on real-user requests.

    ``email`` is purely for display in the Streamlit UI ("Logged in
    as ...") and never sent over the wire.
    """

    cookies: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    email: str = ""


def _parse_cookie_blob(blob: str) -> dict[str, str]:
    """Parse a cookie blob into a ``{name: value}`` mapping.

    Supports two formats:

    - **JSON array** (DevTools "Copy as JSON" output):
      ``[{"name": "...", "value": "..."}, ...]``. Extra keys (``domain``,
      ``path``, etc.) are ignored.
    - **Header string** (single cookie line):
      ``"name1=value1; name2=value2"``.
    """
    blob = blob.strip()
    if not blob:
        return {}
    if blob.startswith("[") or blob.startswith("{"):
        try:
            data = json.loads(blob)
        except json.JSONDecodeError as exc:
            raise GrokWebError(f"GROK_SESSION_COOKIES is not valid JSON: {exc}") from exc
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            raise GrokWebError(
                "GROK_SESSION_COOKIES JSON must be an array of {name, value} objects."
            )
        out: dict[str, str] = {}
        for entry in data:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            value = entry.get("value")
            if isinstance(name, str) and isinstance(value, str) and name:
                out[name] = value
        return out

    # Plain "k=v; k=v" header string.
    out2: dict[str, str] = {}
    for part in blob.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if k:
            out2[k] = v
    return out2


def load_session_from_env() -> GrokSession | None:
    """Build a :class:`GrokSession` from ``GROK_SESSION_COOKIES``.

    Returns ``None`` when the env var is missing or empty so callers
    can render a "missing credentials" hint without catching an
    exception. Raises :class:`GrokWebError` only when the env var is
    set but malformed.
    """
    raw = os.getenv("GROK_SESSION_COOKIES", "").strip()
    if not raw:
        return None
    cookies = _parse_cookie_blob(raw)
    if not cookies:
        raise GrokWebError(
            "GROK_SESSION_COOKIES is set but no name/value pairs were parsed."
        )
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": "*/*",
        "Content-Type": "application/json",
        "Origin": GROK_BASE_URL,
        "Referer": f"{GROK_BASE_URL}/",
    }
    return GrokSession(cookies=cookies, headers=headers)


# ─── Image generation ───────────────────────────────────────────────────────


def _build_image_request(prompt: str, *, aspect_ratio: str, image_count: int) -> dict:
    """Build the JSON payload expected by ``conversations/new``.

    Keep this in lockstep with AutoGrok ``ImageService.js``: the server
    is fussy about extra/missing fields. ``message`` carries the prompt
    plus a ``--ar`` aspect-ratio token (the same shorthand Midjourney
    popularised, which grok.com inherited).
    """
    return {
        "temporary": False,
        "modelName": "grok-3",
        "imageModelName": "imagine-x-1",
        "message": f"{prompt} --ar {aspect_ratio}",
        "fileAttachments": [],
        "imageAttachments": [],
        "enableImageGeneration": True,
        "returnImageBytes": False,
        "enableImageStreaming": True,
        "imageGenerationCount": int(image_count),
        "enableSideBySide": True,
        "enableNsfw": True,
        "enablePro": True,
        "sendFinalMetadata": True,
        "isReasoning": False,
        "disableTextFollowUps": False,
        "disableMemory": False,
        "forceSideBySide": False,
        "modelMode": "MODEL_MODE_EXPERT",
    }


def _iter_ndjson_lines(resp: requests.Response) -> Iterable[dict]:
    """Yield JSON objects from a streaming NDJSON response."""
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            # grok.com occasionally sends keep-alive whitespace; skip.
            continue


def _parse_image_stream(resp: requests.Response) -> list[dict]:
    """Walk the NDJSON stream and collect one record per image_url.

    Returned shape::

        {"image_url": str, "image_index": int, "moderated": bool}

    The same ``image_url`` may appear in multiple progress chunks;
    only the final entry (latest progress) wins so moderation flags
    in late chunks override earlier ones.
    """
    by_url: dict[str, dict] = {}
    for j in _iter_ndjson_lines(resp):
        # PRIMARY: cardAttachment → image_chunk
        try:
            card_json = j["result"]["response"]["cardAttachment"]["jsonData"]
            card = json.loads(card_json) if isinstance(card_json, str) else card_json
            chunk = card.get("image_chunk") if isinstance(card, dict) else None
        except (KeyError, TypeError, json.JSONDecodeError):
            chunk = None
        if isinstance(chunk, dict):
            url = chunk.get("imageUrl")
            if isinstance(url, str) and url:
                by_url[url] = {
                    "image_url": url,
                    "image_index": int(chunk.get("imageIndex") or 0),
                    "progress": int(chunk.get("progress") or 0),
                    "moderated": bool(chunk.get("moderated", False)),
                }
                continue

        # FALLBACK: streamingImageGenerationResponse
        try:
            ir = j["result"]["response"]["streamingImageGenerationResponse"]
        except (KeyError, TypeError):
            ir = None
        if isinstance(ir, dict):
            url = ir.get("imageUrl")
            if isinstance(url, str) and url:
                by_url[url] = {
                    "image_url": url,
                    "image_index": int(ir.get("imageIndex") or 0),
                    "progress": int(ir.get("progress") or 0),
                    "moderated": bool(ir.get("moderated", False)),
                }

    return sorted(by_url.values(), key=lambda r: r.get("image_index", 0))


def _candidate_download_urls(image_url: str) -> list[str]:
    """Return URL variants to race-download for a single image.

    grok.com sometimes serves the unblurred image only on the asset
    host and sometimes only on the chat host; the path may also live
    under a ``-part-N/`` segment that we strip. We try every plausible
    location and keep the largest payload.
    """
    candidates: list[str] = []
    path = image_url.lstrip("/")

    # Direct asset host.
    candidates.append(f"{GROK_ASSETS_URL}/{path}")
    # Chat-host fallback used when the asset CDN is still moderating.
    candidates.append(f"{GROK_BASE_URL}/rest/app-chat/asset/{path}")

    # Strip ``-part-N/`` from the path. The unblurred original sometimes
    # lives at the parent path.
    if "-part-" in path:
        # E.g. "generated/images/abc-part-0/image.jpg" →
        # "generated/images/abc/image.jpg".
        head, _, tail = path.partition("-part-")
        if "/" in tail:
            _, _, after = tail.partition("/")
            stripped = f"{head}/{after}"
            candidates.append(f"{GROK_ASSETS_URL}/{stripped}")
            candidates.append(f"{GROK_BASE_URL}/rest/app-chat/asset/{stripped}")

    # De-dupe while preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _download_one(url: str, session: GrokSession, *, timeout: float) -> bytes | None:
    """GET a URL with the session cookies; return bytes or ``None``."""
    try:
        resp = requests.get(
            url,
            cookies=session.cookies,
            headers=session.headers,
            timeout=timeout,
            stream=False,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    body = resp.content
    if not body:
        return None
    return body


def _download_image(
    image_record: dict,
    session: GrokSession,
    *,
    timeout: float = DEFAULT_DOWNLOAD_TIMEOUT_S,
) -> bytes | None:
    """Race-download all candidate URLs and return the largest body.

    A ``None`` return means every candidate failed, was empty, or fell
    under :data:`MIN_IMAGE_BYTES` (the moderation-blur placeholder).
    """
    urls = _candidate_download_urls(image_record["image_url"])
    if not urls:
        return None
    best: bytes | None = None
    with ThreadPoolExecutor(max_workers=min(4, len(urls))) as pool:
        futures = [pool.submit(_download_one, u, session, timeout=timeout) for u in urls]
        for fut in as_completed(futures):
            try:
                body = fut.result()
            except Exception:  # noqa: BLE001 — defensive; pool errors → drop
                continue
            if not body or len(body) < MIN_IMAGE_BYTES:
                continue
            if best is None or len(body) > len(best):
                best = body
    return best


def generate_image_via_web(
    prompt: str,
    session: GrokSession,
    *,
    aspect_ratio: str = "9:16",
    image_count: int = 1,
    request_timeout_s: float = DEFAULT_REQUEST_TIMEOUT_S,
    download_timeout_s: float = DEFAULT_DOWNLOAD_TIMEOUT_S,
) -> list[bytes]:
    """Generate ``image_count`` images for *prompt* via grok.com web.

    Returns the **raw bytes** of every image that survived moderation
    filtering, sorted by ``imageIndex``.

    Raises
    ------
    GrokWebError
        On HTTP errors (incl. 401/403 expired session), if the stream
        contained no image URLs, or if every download fell below the
        moderation-bypass threshold.
    """
    if not prompt or not prompt.strip():
        raise GrokWebError("Prompt is empty.")
    payload = _build_image_request(
        prompt.strip(), aspect_ratio=aspect_ratio, image_count=image_count
    )

    try:
        resp = requests.post(
            CONVERSATIONS_NEW,
            json=payload,
            cookies=session.cookies,
            headers=session.headers,
            stream=True,
            timeout=request_timeout_s,
        )
    except requests.RequestException as exc:
        raise GrokWebError(f"grok.com request failed: {exc}") from exc

    if resp.status_code in (401, 403):
        raise GrokWebError(
            f"grok.com rejected session cookies (HTTP {resp.status_code}). "
            "Re-export GROK_SESSION_COOKIES from a logged-in browser tab."
        )
    if resp.status_code >= 400:
        # Read a short body slice to aid debugging without blowing memory.
        snippet = ""
        try:
            snippet = resp.text[:300]
        except Exception:  # noqa: BLE001
            pass
        raise GrokWebError(f"grok.com HTTP {resp.status_code}: {snippet}")

    records = _parse_image_stream(resp)
    if not records:
        raise GrokWebError("grok.com stream returned no image URLs.")

    images: list[bytes] = []
    for rec in records:
        body = _download_image(rec, session, timeout=download_timeout_s)
        if body is None:
            continue
        images.append(body)

    if not images:
        raise GrokWebError(
            "All grok.com images were below the moderation-bypass threshold "
            f"({MIN_IMAGE_BYTES} bytes). The prompt may have been blocked."
        )
    return images


__all__ = [
    "CONVERSATIONS_NEW",
    "DEFAULT_USER_AGENT",
    "GROK_ASSETS_URL",
    "GROK_BASE_URL",
    "MIN_IMAGE_BYTES",
    "GrokSession",
    "GrokWebError",
    "generate_image_via_web",
    "load_session_from_env",
]
