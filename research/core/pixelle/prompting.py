"""Scene splitter + image/video prompt generator from a style reference.

PR-A3 wires a script + a *style source* (Video Cloner kit, free-form
reference text, or named preset) into a list of :class:`ScenePrompt`
objects. Each scene carries everything a downstream visual provider
(ComfyUI, Google Whisk, Grok, …) or a human user copy-pasting into a
third-party tool needs to render a 9:16 frame.

This module is **provider-agnostic** — it doesn't call any API. It only
turns ``(script, style)`` into a structured prompt list. The
:mod:`core.pixelle.visual_providers` module is the consumer.

The output JSON contract (see :meth:`ScenePrompt.to_json`) matches the
hand-off schema used by the Producer page:

.. code-block:: json

    {
      "scene_id": 1,
      "duration": 4.0,
      "narration": "...",
      "image_prompt": "...",
      "video_prompt": "...",
      "negative_prompt": "...",
      "style_notes": "...",
      "aspect_ratio": "9:16"
    }
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

from core.pixelle.subtitles import split_by_sentences

DEFAULT_ASPECT_RATIO = "9:16"

# Target seconds per scene when no explicit duration is given. Picked to
# match the rule-of-thumb "1 hook beat per ~4s" that short-form editors
# use; tunable per-call via :func:`split_script_into_scenes`.
DEFAULT_TARGET_SCENE_DURATION_S = 4.0
MIN_SCENE_DURATION_S = 1.0
MAX_SCENE_DURATION_S = 8.0

# Default negative prompt — works for most diffusion image models.
DEFAULT_NEGATIVE_PROMPT = (
    "lowres, blurry, jpeg artifacts, watermark, text, logo, signature, "
    "deformed, extra fingers, distorted face, cropped"
)

# Built-in style presets. These give the user a sensible default if they
# haven't run Video Cloner and don't want to write their own reference.
PRESET_STYLES: dict[str, "StyleSource"] = {}


@dataclass(frozen=True)
class StyleSource:
    """A normalized style reference fed into prompt generation.

    Three ways to populate this:

    1. From a Video Cloner kit (see :func:`from_cloner_kit`) — uses the
       hook analysis + tags as visual cues.
    2. From free-form user text (see :func:`from_manual_reference`).
    3. From a named preset (see :data:`PRESET_STYLES` and
       :func:`from_preset`).

    Attributes
    ----------
    name:
        Short identifier shown in the UI (e.g. ``"video_clone:abc123"``,
        ``"manual"``, ``"preset:cinematic"``).
    description:
        Human-readable one-liner summarising the style.
    visual_keywords:
        Short visual descriptors merged into image prompts (e.g.
        ``["cinematic", "warm tones", "shallow depth of field"]``).
    tone:
        Narrative tone (e.g. ``"documentary"``, ``"vlog"``,
        ``"explainer"``). Influences video prompt camera language.
    palette:
        Optional colour cues (named or hex). Joined into image prompts.
    reference_text:
        Raw blob the style was derived from — kept for round-tripping
        and so the user can audit which inputs drove the prompts.
    negative:
        Extra negative-prompt cues to append to
        :data:`DEFAULT_NEGATIVE_PROMPT` (e.g. ``"no text overlays"``).
    """

    name: str
    description: str = ""
    visual_keywords: list[str] = field(default_factory=list)
    tone: str = "documentary"
    palette: list[str] = field(default_factory=list)
    reference_text: str = ""
    negative: str = ""

    def to_json(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ScenePrompt:
    """One scene's worth of prompts — image + video + negative + meta.

    A list of these is the deliverable of PR-A3. The Producer page
    renders them as a JSON preview the user can copy into Whisk/Grok,
    and future PRs feed them to a real :class:`VisualProvider`.
    """

    scene_id: int
    duration: float
    narration: str
    image_prompt: str
    video_prompt: str
    negative_prompt: str = DEFAULT_NEGATIVE_PROMPT
    style_notes: str = ""
    aspect_ratio: str = DEFAULT_ASPECT_RATIO

    def to_json(self) -> dict:
        return asdict(self)


# ─── StyleSource constructors ────────────────────────────────────────────────


def from_cloner_kit(kit: dict, *, source_label: str = "video_clone") -> StyleSource:
    """Distill a Video Cloner ``kit`` dict into a :class:`StyleSource`.

    The kit is the JSON returned by ``pages/02_Video_Cloner.py`` — see
    that page's ``sys`` prompt for the exact schema. We cherry-pick:

    - ``hook_analysis`` → ``reference_text`` (full markdown is fine; the
      prompt builder excerpts the first ~400 chars).
    - ``tags`` → ``visual_keywords`` (already SEO-curated).
    - ``thumbnail_copy`` → seeds ``description``.

    Returns a default-tone documentary style if any field is missing.
    """
    tags = [str(t).strip() for t in (kit.get("tags") or []) if str(t).strip()]
    thumb_copy = [str(t).strip() for t in (kit.get("thumbnail_copy") or []) if str(t).strip()]
    return StyleSource(
        name=source_label,
        description=" · ".join(thumb_copy[:3]) or kit.get("source_title", ""),
        visual_keywords=tags[:12],
        tone=kit.get("tone", "documentary"),
        palette=list(kit.get("palette", []) or []),
        reference_text=str(kit.get("hook_analysis", "")).strip(),
        negative=str(kit.get("negative", "")).strip(),
    )


def from_manual_reference(reference: str, *, name: str = "manual") -> StyleSource:
    """Build a :class:`StyleSource` from a free-form user reference."""
    text = (reference or "").strip()
    return StyleSource(
        name=name,
        description=text[:120],
        visual_keywords=[],
        tone="documentary",
        palette=[],
        reference_text=text,
    )


def from_preset(preset_name: str) -> StyleSource:
    """Look up a named preset; falls back to ``"cinematic"``."""
    return PRESET_STYLES.get(preset_name, PRESET_STYLES["cinematic"])


# ─── Scene splitter ──────────────────────────────────────────────────────────


def split_script_into_scenes(
    script: str,
    *,
    total_duration_s: float | None = None,
    target_scene_duration_s: float = DEFAULT_TARGET_SCENE_DURATION_S,
) -> list[tuple[float, str]]:
    """Split *script* into ``(duration_s, narration)`` tuples.

    Reuses :func:`core.pixelle.subtitles.split_by_sentences` so EN/CJK
    terminators are handled identically to caption splitting.

    If ``total_duration_s`` is given, sentence durations are scaled to
    sum to it (proportional to character length). Otherwise each
    sentence gets ``target_scene_duration_s``, clamped to
    ``[MIN_SCENE_DURATION_S, MAX_SCENE_DURATION_S]``.
    """
    sentences = split_by_sentences(script or "")
    if not sentences:
        return []

    if total_duration_s is not None and total_duration_s > 0:
        total_chars = sum(len(s) for s in sentences) or 1
        return [
            (
                _clamp(total_duration_s * len(s) / total_chars,
                       MIN_SCENE_DURATION_S, MAX_SCENE_DURATION_S),
                s,
            )
            for s in sentences
        ]

    duration = _clamp(target_scene_duration_s, MIN_SCENE_DURATION_S, MAX_SCENE_DURATION_S)
    return [(duration, s) for s in sentences]


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


# ─── Prompt builders ─────────────────────────────────────────────────────────


_REFERENCE_EXCERPT_CHARS = 400


def _style_chunks(style: StyleSource) -> list[str]:
    """Common style fragments shared between image + video prompts."""
    parts: list[str] = []
    if style.visual_keywords:
        parts.append(", ".join(style.visual_keywords[:8]))
    if style.palette:
        parts.append("palette: " + ", ".join(style.palette[:4]))
    if style.reference_text:
        excerpt = style.reference_text.strip().replace("\n", " ")
        if len(excerpt) > _REFERENCE_EXCERPT_CHARS:
            excerpt = excerpt[:_REFERENCE_EXCERPT_CHARS].rstrip() + "…"
        parts.append("style ref: " + excerpt)
    return [p for p in parts if p]


def build_image_prompt_from_style(narration: str, style: StyleSource) -> str:
    """Construct an image prompt suitable for diffusion image models.

    Format: ``<scene description>, <style keywords>, 9:16 vertical
    composition, high detail``. Designed to drop straight into Whisk,
    Imagen, Flux, SDXL, etc.
    """
    base = (narration or "").strip().rstrip(".") or "abstract scene"
    chunks = [base, "9:16 vertical composition", "cinematic lighting", "high detail"]
    chunks.extend(_style_chunks(style))
    return ", ".join(chunks)


def build_video_prompt_from_style(narration: str, style: StyleSource) -> str:
    """Construct a short text-to-video prompt (Wan, Veo, Sora-style).

    Adds camera language driven by ``style.tone`` so a documentary tone
    yields a slow push-in while a vlog tone yields handheld energy.
    """
    base = (narration or "").strip().rstrip(".") or "abstract scene"
    camera = _camera_for_tone(style.tone)
    chunks = [base, camera, "9:16 vertical", "smooth motion", "consistent subject"]
    chunks.extend(_style_chunks(style))
    return ", ".join(chunks)


def _camera_for_tone(tone: str) -> str:
    t = (tone or "").lower()
    if "vlog" in t:
        return "handheld, energetic camera"
    if "explainer" in t or "educational" in t:
        return "static medium shot, clean composition"
    if "cinematic" in t:
        return "slow dolly-in, anamorphic feel"
    return "slow push-in, steady camera"


def _negative_for_style(style: StyleSource) -> str:
    if not style.negative:
        return DEFAULT_NEGATIVE_PROMPT
    return DEFAULT_NEGATIVE_PROMPT + ", " + style.negative


def _style_notes_for_scene(style: StyleSource) -> str:
    bits: list[str] = []
    if style.tone:
        bits.append(f"tone={style.tone}")
    if style.visual_keywords:
        bits.append("keywords=" + ", ".join(style.visual_keywords[:5]))
    if style.palette:
        bits.append("palette=" + ", ".join(style.palette[:4]))
    return " | ".join(bits)


# ─── Top-level orchestration ─────────────────────────────────────────────────


def build_scene_prompts(
    script: str,
    style: StyleSource,
    *,
    total_duration_s: float | None = None,
    target_scene_duration_s: float = DEFAULT_TARGET_SCENE_DURATION_S,
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
) -> list[ScenePrompt]:
    """Top-level: ``(script, style) → list[ScenePrompt]``.

    This is what :file:`pages/05_Producer.py` calls. Returns an empty
    list when the script is empty / whitespace-only (the page surfaces
    a warning in that case).
    """
    pieces = split_script_into_scenes(
        script,
        total_duration_s=total_duration_s,
        target_scene_duration_s=target_scene_duration_s,
    )
    negative = _negative_for_style(style)
    notes = _style_notes_for_scene(style)
    out: list[ScenePrompt] = []
    for i, (duration, narration) in enumerate(pieces, start=1):
        out.append(
            ScenePrompt(
                scene_id=i,
                duration=round(duration, 3),
                narration=narration,
                image_prompt=build_image_prompt_from_style(narration, style),
                video_prompt=build_video_prompt_from_style(narration, style),
                negative_prompt=negative,
                style_notes=notes,
                aspect_ratio=aspect_ratio,
            )
        )
    return out


# ─── Built-in presets (registered after class definitions) ───────────────────

PRESET_STYLES.update(
    {
        "cinematic": StyleSource(
            name="preset:cinematic",
            description="Slow, anamorphic, warm-cool contrast cinematography.",
            visual_keywords=[
                "cinematic",
                "anamorphic lens",
                "shallow depth of field",
                "warm key light",
                "moody atmosphere",
                "filmic grain",
            ],
            tone="cinematic",
            palette=["amber", "teal", "deep blue"],
            reference_text="Inspired by modern cinematic shorts (Villeneuve, Deakins).",
        ),
        "documentary": StyleSource(
            name="preset:documentary",
            description="Natural daylight, observational pacing, real locations.",
            visual_keywords=[
                "documentary",
                "natural light",
                "real location",
                "observational",
                "authentic",
                "subtle depth of field",
            ],
            tone="documentary",
            palette=["neutral", "earth tones"],
            reference_text="Inspired by long-form YouTube documentaries.",
        ),
        "vlog": StyleSource(
            name="preset:vlog",
            description="Handheld, bright, friendly to-camera energy.",
            visual_keywords=[
                "vlog",
                "handheld",
                "bright daylight",
                "friendly composition",
                "punchy colours",
                "in-the-moment",
            ],
            tone="vlog",
            palette=["bright", "saturated"],
            reference_text="Inspired by lifestyle vloggers.",
        ),
        "explainer": StyleSource(
            name="preset:explainer",
            description="Clean infographic-style framing, flat-ish lighting.",
            visual_keywords=[
                "explainer",
                "clean composition",
                "minimal background",
                "infographic feel",
                "soft light",
                "high readability",
            ],
            tone="explainer",
            palette=["white", "soft blue", "accent orange"],
            reference_text="Inspired by infographic-driven explainer channels.",
        ),
        "neon-night": StyleSource(
            name="preset:neon-night",
            description="Neon-lit night cityscape, cyberpunk-adjacent palette.",
            visual_keywords=[
                "neon lights",
                "night city",
                "wet streets",
                "cyberpunk",
                "high contrast",
                "rim light",
            ],
            tone="cinematic",
            palette=["magenta", "cyan", "deep purple"],
            reference_text="Inspired by night-city cinematography.",
        ),
    }
)

PRESET_NAMES: list[str] = list(PRESET_STYLES.keys())
