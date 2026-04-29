"""Visual provider abstraction for AI image / video generation.

PR-A3 ships:

- :class:`VisualProvider` — the abstract interface every provider obeys.
- :class:`PlaceholderVisualProvider` — concrete no-op default. Always
  ``is_configured()`` and signals "use the gradient Ken Burns fallback"
  by raising :class:`UsePlaceholderFallback` on generate calls.
- Stubs for the four providers we plan to wire later:

  * :class:`ComfyUIVisualProvider` (local + RunningHub fallback)
  * :class:`GoogleWhiskProvider` (Google Whisk; no public API yet)
  * :class:`GeminiImageProvider` (Gemini image-gen API)
  * :class:`GrokImageProvider` (xAI / Grok image API)

The stubs intentionally **don't call any external API** — they only
report ``is_configured()`` based on env vars / config and raise
:class:`ProviderNotImplementedError` if generate is called. Future PRs
(A3.1 / A4) will replace the stub bodies with real HTTP wiring.

Usage from ``pages/05_Producer.py``::

    from core.pixelle.visual_providers import (
        PlaceholderVisualProvider,
        list_provider_specs,
        get_provider,
    )

    spec = get_provider("placeholder")
    if not spec.is_configured():
        st.warning(spec.missing_reason())
"""
from __future__ import annotations

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from core.pixelle.config import load_config
from core.pixelle.prompting import ScenePrompt


# ─── Errors ──────────────────────────────────────────────────────────────────


class VisualProviderError(RuntimeError):
    """Base class for all provider errors."""


class ProviderNotConfiguredError(VisualProviderError):
    """Raised when ``generate_*`` is called on a provider missing keys/config."""


class ProviderNotImplementedError(VisualProviderError):
    """Raised by stub providers that have config but no real API wiring yet."""


class UsePlaceholderFallback(VisualProviderError):
    """Sentinel raised by :class:`PlaceholderVisualProvider` to tell the
    composer to keep its existing gradient Ken Burns background instead
    of expecting a per-scene asset.
    """


# ─── Interface ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ProviderInfo:
    """Static metadata describing a provider for the UI selector."""

    name: str  # machine id, e.g. "comfyui_local"
    label: str  # human label, e.g. "ComfyUI (local)"
    kind: str  # "image" or "video" or "image+video"
    requires: list[str]  # env vars / config keys needed
    notes: str  # short user-visible note


class VisualProvider(ABC):
    """Abstract interface every provider implements.

    Two responsibilities:

    1. Report configuration status (so the UI can show "missing key")
       *without* attempting any network calls.
    2. Generate per-scene image / video assets when asked. Either path
       may legally raise :class:`UsePlaceholderFallback` to keep the
       composer's existing gradient flow.
    """

    info: ProviderInfo

    @abstractmethod
    def is_configured(self) -> bool: ...

    @abstractmethod
    def missing_reason(self) -> str:
        """One-liner explaining what's missing (for UI display)."""

    @abstractmethod
    def generate_image(self, prompt: ScenePrompt, *, output_path: Path) -> Path:
        """Render ``prompt`` as a single still 9:16 image at ``output_path``.

        Raises :class:`ProviderNotConfiguredError` if not configured,
        :class:`ProviderNotImplementedError` if config is present but
        the API integration isn't wired yet, or
        :class:`UsePlaceholderFallback` to signal "no asset, fall back
        to gradient".
        """

    @abstractmethod
    def generate_video(self, prompt: ScenePrompt, *, output_path: Path) -> Path | None:
        """Render ``prompt`` as a short 9:16 video clip.

        Returning ``None`` means the provider is image-only and the
        composer should still-image-pan instead.
        """


# ─── Placeholder (concrete, default) ─────────────────────────────────────────


class PlaceholderVisualProvider(VisualProvider):
    """No-op default. Always configured, always falls back to gradient.

    This is what the Producer page picks by default — it preserves the
    PR-A2 behaviour (gradient + Ken Burns) and lets users render videos
    without any AI provider keys.
    """

    info = ProviderInfo(
        name="placeholder",
        label="Placeholder (gradient + Ken Burns)",
        kind="image+video",
        requires=[],
        notes="No AI keys needed. Renders the existing PR-A2 gradient short.",
    )

    def is_configured(self) -> bool:
        return True

    def missing_reason(self) -> str:
        return ""

    def generate_image(self, prompt: ScenePrompt, *, output_path: Path) -> Path:
        raise UsePlaceholderFallback(
            "PlaceholderVisualProvider does not produce per-scene images."
        )

    def generate_video(self, prompt: ScenePrompt, *, output_path: Path) -> Path | None:
        raise UsePlaceholderFallback(
            "PlaceholderVisualProvider does not produce per-scene videos."
        )


# ─── Stubs ───────────────────────────────────────────────────────────────────


class _StubVisualProvider(VisualProvider):
    """Common base for providers whose API isn't wired yet."""

    def generate_image(self, prompt: ScenePrompt, *, output_path: Path) -> Path:
        if not self.is_configured():
            raise ProviderNotConfiguredError(self.missing_reason())
        raise ProviderNotImplementedError(
            f"{self.info.label}: image API integration is not wired yet."
        )

    def generate_video(self, prompt: ScenePrompt, *, output_path: Path) -> Path | None:
        if not self.is_configured():
            raise ProviderNotConfiguredError(self.missing_reason())
        raise ProviderNotImplementedError(
            f"{self.info.label}: video API integration is not wired yet."
        )


class ComfyUIVisualProvider(VisualProvider):
    """ComfyUI provider — drives a local ComfyUI instance via HTTP.

    PR-A3.1 wires real image generation through
    :mod:`core.pixelle.comfyui_image`. The provider reports
    ``is_configured()`` based on whether the local URL is set in config;
    it doesn't probe the URL there (that's a network call). The actual
    health check happens inside :meth:`generate_image`, and any failure
    — server down, workflow missing, prompt rejected, output never
    materialised — is translated into :class:`UsePlaceholderFallback`
    so the Producer page keeps its gradient-fallback behaviour without
    crashing the run.
    """

    info = ProviderInfo(
        name="comfyui_local",
        label="ComfyUI (local + RunningHub fallback)",
        kind="image",
        requires=["ComfyUI at 127.0.0.1:8188 OR RUNNINGHUB_API_KEY"],
        notes=(
            "Local-first: the provider posts the bundled txt2img workflow "
            "to your ComfyUI instance and saves one image per scene. "
            "If the server is down or the workflow fails, the run falls "
            "back to the gradient Ken Burns placeholder (no crash)."
        ),
    )

    def __init__(
        self,
        *,
        workflow_path: Path | None = None,
        checkpoint: str | None = None,
        seed: int | None = None,
    ) -> None:
        self._workflow_path = workflow_path
        # ``None`` defers to the default in :mod:`comfyui_image`.
        self._checkpoint = checkpoint
        self._seed = seed

    def is_configured(self) -> bool:
        cfg = load_config()
        # Either local URL set or RunningHub fallback available.
        return bool(cfg.comfy.local_url) or cfg.comfy.cloud_available

    def missing_reason(self) -> str:
        return (
            "ComfyUI not configured: set COMFYUI_LOCAL_URL (default "
            "http://127.0.0.1:8188) or RUNNINGHUB_API_KEY."
        )

    def generate_image(self, prompt: ScenePrompt, *, output_path: Path) -> Path:
        if not self.is_configured():
            raise ProviderNotConfiguredError(self.missing_reason())

        # Lazy import: keeps `core.pixelle` import cheap and lets unit
        # tests patch the orchestrator without dragging requests in.
        from core.pixelle import comfyui_image
        from core.pixelle.comfy_client import ComfyUIError

        cfg = load_config()
        try:
            return comfyui_image.generate_scene_image(
                prompt,
                output_path=output_path,
                base_url=cfg.comfy.local_url,
                workflow_path=self._workflow_path,
                checkpoint=self._checkpoint or comfyui_image.DEFAULT_CHECKPOINT,
                seed=self._seed,
            )
        except ComfyUIError as exc:
            # Translate any ComfyUI-side failure into the placeholder
            # signal so the Producer page can fall back gracefully.
            raise UsePlaceholderFallback(
                f"ComfyUI generate failed → falling back to placeholder: {exc}"
            ) from exc

    def generate_video(self, prompt: ScenePrompt, *, output_path: Path) -> Path | None:
        # Video wiring lands in a follow-up PR. Until then this stays a
        # stub so the Producer page knows to fall back.
        if not self.is_configured():
            raise ProviderNotConfiguredError(self.missing_reason())
        raise ProviderNotImplementedError(
            f"{self.info.label}: video API integration is not wired yet."
        )


class GoogleWhiskProvider(_StubVisualProvider):
    """Google Whisk image generation.

    Whisk has no public API yet; the integration will plug into the
    same env-var (``GOOGLE_WHISK_API_KEY``) once Google publishes one.
    Today this provider is a placeholder so the UI can show its row
    and prompts can already be copy-pasted into the Whisk web UI.
    """

    info = ProviderInfo(
        name="google_whisk",
        label="Google Whisk (image)",
        kind="image",
        requires=["GOOGLE_WHISK_API_KEY (when public)"],
        notes=(
            "No public API yet. Use the prompt JSON below to drive Whisk "
            "manually in the meantime."
        ),
    )

    def is_configured(self) -> bool:
        return bool(os.getenv("GOOGLE_WHISK_API_KEY"))

    def missing_reason(self) -> str:
        return "Google Whisk has no public API yet — copy prompts manually."


class GeminiImageProvider(_StubVisualProvider):
    """Google Gemini image generation (Imagen / Gemini-2.x image).

    Activated when ``GEMINI_API_KEY`` (or ``GOOGLE_API_KEY``) is set.
    """

    info = ProviderInfo(
        name="gemini_image",
        label="Gemini image (Imagen 3 / Gemini 2.0)",
        kind="image",
        requires=["GEMINI_API_KEY or GOOGLE_API_KEY"],
        notes="Real wiring lands in a follow-up PR. Today: prompt-only.",
    )

    def is_configured(self) -> bool:
        return bool(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"))

    def missing_reason(self) -> str:
        return "Set GEMINI_API_KEY (or GOOGLE_API_KEY) to enable Gemini image generation."


class GrokImageProvider(VisualProvider):
    """grok.com / xAI image generation (Aurora / imagine-x-1).

    PR-A4.2 wires real image generation through
    :mod:`core.pixelle.grok_web_client`. Auth is **runtime** — a
    :class:`~core.pixelle.grok_web_client.GrokSession` is captured by
    :func:`core.pixelle.grok_browser.grok_browser_login` after the
    user enters their email and password in the Streamlit credential
    dialog. The session is *not* read from environment variables and
    *not* persisted to disk; it lives in ``st.session_state`` for the
    lifetime of the page.

    Construction is two-step so the registry helpers
    (:func:`get_provider`, :func:`list_provider_specs`) can introspect
    the provider without a session. The Producer page builds a
    *configured* instance once a login succeeds::

        provider = GrokImageProvider(session=st.session_state["grok_session"])

    Any failure inside :meth:`generate_image` — expired session,
    server error, moderation blocking every candidate — is translated
    into :class:`UsePlaceholderFallback` so the Producer page degrades
    cleanly to the gradient placeholder. Video generation
    (:meth:`generate_video`) lands in PR-A5.
    """

    info = ProviderInfo(
        name="grok_image",
        label="Grok / xAI image + video (Aurora · Veo 3)",
        kind="image+video",
        requires=["Grok account login (email + password)"],
        notes=(
            "Drives grok.com's web image and video endpoints after a "
            "Playwright auto-login. Sign in once with your grok.com "
            "email and password in the credential dialog above; the "
            "session lives in memory only. Image generation falls back "
            "to the gradient placeholder on session expiry or "
            "moderation. Video generation produces 6 / 10 second MP4 "
            "clips at 480p / 720p (Veo 3)."
        ),
    )

    def __init__(
        self,
        *,
        session: "object | None" = None,
        aspect_ratio: str = "9:16",
        video_length: int = 6,
        resolution: str = "720p",
    ) -> None:
        # ``session`` is typed as ``object`` here to avoid an import
        # cycle on grok_web_client at registry-construction time. The
        # method bodies do a lazy import + isinstance check.
        self._session = session
        self._aspect_ratio = aspect_ratio
        self._video_length = video_length
        self._resolution = resolution

    def is_configured(self) -> bool:
        return self._session is not None

    def missing_reason(self) -> str:
        return (
            "No active Grok login. Sign in with your grok.com email "
            "and password using the credential dialog."
        )

    def generate_image(self, prompt: ScenePrompt, *, output_path: Path) -> Path:
        if self._session is None:
            raise ProviderNotConfiguredError(self.missing_reason())

        # Lazy import keeps ``import core.pixelle`` cheap — pages that
        # never pick the Grok provider don't pay for ``requests`` setup.
        from core.pixelle.grok_web_client import (
            GrokSession,
            GrokWebError,
            generate_image_via_web,
        )

        if not isinstance(self._session, GrokSession):
            raise ProviderNotConfiguredError(
                "GrokImageProvider session is not a GrokSession instance."
            )

        try:
            images = generate_image_via_web(
                prompt.image_prompt,
                self._session,
                aspect_ratio=self._aspect_ratio,
                image_count=1,
            )
        except GrokWebError as exc:
            raise UsePlaceholderFallback(
                f"Grok generate failed → falling back to placeholder: {exc}"
            ) from exc

        if not images:
            raise UsePlaceholderFallback(
                "Grok returned no usable images → falling back to placeholder."
            )

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(images[0])
        return output_path

    def generate_video(self, prompt: ScenePrompt, *, output_path: Path) -> Path | None:
        """Generate a short MP4 clip via grok.com's Veo 3 endpoint.

        Reuses the same :class:`GrokSession` as
        :meth:`generate_image`. Errors (expired session, moderation
        blocking every candidate, network failures) are translated to
        :class:`UsePlaceholderFallback` so the Producer page can roll
        the entire pipeline back to the gradient + Ken Burns flow.

        ``prompt.video_prompt`` is the long-form 3–4 sentence scene
        description from PR-A4.1 — Grok / Veo handle it well; the
        shorter ``image_prompt`` is a fallback for callers that only
        carry the still-image string.
        """
        if self._session is None:
            raise ProviderNotConfiguredError(self.missing_reason())

        # Lazy import — keeps ``import core.pixelle`` cheap and lets
        # tests stub the client module out without provoking an
        # import-time HTTP setup.
        from core.pixelle.grok_video_client import generate_video_via_web
        from core.pixelle.grok_web_client import GrokSession, GrokWebError

        if not isinstance(self._session, GrokSession):
            raise ProviderNotConfiguredError(
                "GrokImageProvider session is not a GrokSession instance."
            )

        text = (prompt.video_prompt or prompt.image_prompt or "").strip()
        if not text:
            raise UsePlaceholderFallback(
                "Empty prompt → falling back to placeholder."
            )

        try:
            return generate_video_via_web(
                text,
                self._session,
                aspect_ratio=self._aspect_ratio,
                video_length=self._video_length,
                resolution=self._resolution,
                output_path=Path(output_path),
            )
        except GrokWebError as exc:
            raise UsePlaceholderFallback(
                f"Grok video generation failed → falling back to placeholder: {exc}"
            ) from exc


# ─── Registry helpers ────────────────────────────────────────────────────────


_PROVIDER_CLASSES: dict[str, type[VisualProvider]] = {
    "placeholder": PlaceholderVisualProvider,
    "comfyui_local": ComfyUIVisualProvider,
    "google_whisk": GoogleWhiskProvider,
    "gemini_image": GeminiImageProvider,
    "grok_image": GrokImageProvider,
}


def list_provider_specs() -> list[ProviderInfo]:
    """Return :class:`ProviderInfo` for every registered provider."""
    return [cls.info for cls in _PROVIDER_CLASSES.values()]


def get_provider(name: str) -> VisualProvider:
    """Instantiate provider by ``name``; falls back to placeholder."""
    cls = _PROVIDER_CLASSES.get(name, PlaceholderVisualProvider)
    return cls()


PROVIDER_NAMES: list[str] = list(_PROVIDER_CLASSES.keys())
DEFAULT_PROVIDER_NAME = "placeholder"
