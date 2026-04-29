"""Long-form script → scene-by-scene breakdown sheet.

PR-A4.1 turns a long-form script (e.g. the 8-PART output of
:mod:`core.llm` Studio pipeline, or any ``script_final.md``) into ``N``
self-contained scene prompts following a configurable template.

Each scene carries:

- ``scene_id`` — 1-indexed
- ``title`` — short standalone title
- ``narration`` — the verbatim source paragraph(s) the scene was distilled
  from (handed off to TTS later)
- ``image_prompt`` — single ultra-detailed paragraph, paste-ready into
  Whisk / Imagen / Flux / Grok / SDXL
- ``flow_video_prompt`` — 3–4 sentences of continuous-motion description,
  paste-ready into Veo 3 / Sora / Wan / Kling
- ``duration_s`` — estimated seconds at 150 WPM (configurable)

The module is **provider-agnostic**: it calls ``core.llm.chat()`` to ask
the LLM to expand the script, and parses the structured text reply. PR-A4.2
will plug a real Grok image generator into the resulting prompts.

Output formats
--------------

- :func:`serialize_breakdown_md` — strict markdown that round-trips back
  to the LLM template (the user's "factory style" recipe, generalized).
  Designed to paste directly into AutoGrok / grok.com web.
- :func:`serialize_breakdown_json` — machine-readable list of dicts.

Templates
---------

Five built-ins live in :data:`SCENE_TEMPLATES`: ``cinematic``,
``educational``, ``lifestyle``, ``factory``, and ``custom``. Each picks
the style tag appended to image prompts plus the camera-language hints
fed into video prompts. ``custom`` lets the user paste their own style
tag and process notes — useful when the built-ins don't fit the topic.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any

# ─── Tunables ────────────────────────────────────────────────────────────────

DEFAULT_WORDS_PER_MIN = 150  # spoken English ≈ 140–160 WPM
DEFAULT_WORDS_PER_SCENE = 220  # ≈ 90 s of speech per scene at 150 WPM
MIN_SCENE_COUNT = 3
MAX_SCENE_COUNT = 60


@dataclass(frozen=True)
class SceneTemplate:
    """A named scene-prompt template.

    Attributes
    ----------
    key:
        Stable identifier used in UIs and persisted state
        (``"cinematic"``, ``"factory"``, …).
    label:
        Human-readable name shown in the UI.
    description:
        One-liner describing when the template fits.
    image_style_tag:
        Trailing style descriptor appended to every image prompt (e.g.
        ``"ultra-realistic, cinematic, professional, high-detail 4K,
        documentary style"``).
    camera_hints:
        Comma-joined camera language fed into video prompts (e.g.
        ``"tracking shot, overhead crane, dolly push, pan across
        machines"``).
    process_notes:
        Optional extra system-prompt block describing the canonical
        process flow (factory style: arrival → sorting → manufacturing
        → packaging → retail). Used to hint the LLM when the topic is
        a process / industrial subject.
    """

    key: str
    label: str
    description: str
    image_style_tag: str
    camera_hints: str
    process_notes: str = ""


SCENE_TEMPLATES: dict[str, SceneTemplate] = {
    "cinematic": SceneTemplate(
        key="cinematic",
        label="Cinematic (dramatic, film-grain)",
        description="Dramatic film-grain look — anamorphic, shallow DOF.",
        image_style_tag=(
            "cinematic, dramatic lighting, anamorphic lens, film grain, "
            "shallow depth of field, ultra-realistic, 4K"
        ),
        camera_hints=(
            "slow dolly push-in, tracking shot, anamorphic lens flare, "
            "golden-hour light"
        ),
    ),
    "educational": SceneTemplate(
        key="educational",
        label="Educational (clean, infographic)",
        description="Clean infographic / whiteboard look, bright lighting.",
        image_style_tag=(
            "clean infographic illustration, bright neutral lighting, "
            "minimalist, high-detail vector style"
        ),
        camera_hints=(
            "static framing, clean composition, on-screen graphic overlays, "
            "subtle parallax"
        ),
    ),
    "lifestyle": SceneTemplate(
        key="lifestyle",
        label="Lifestyle (warm, candid, natural light)",
        description="Warm, natural-light, candid documentary aesthetic.",
        image_style_tag=(
            "warm natural light, candid documentary, soft focus, "
            "vibrant colours, ultra-realistic, 4K"
        ),
        camera_hints=(
            "handheld, walk-and-talk, soft golden light, gentle parallax"
        ),
    ),
    "factory": SceneTemplate(
        key="factory",
        label="Factory / industrial process (efficient, precise)",
        description=(
            "Highly efficient industrial-process aesthetic — synchronized "
            "machines, conveyor belts, workers in protective gear."
        ),
        image_style_tag=(
            "ultra-realistic, cinematic, professional, high-detail 4K, "
            "documentary style"
        ),
        camera_hints=(
            "tracking shot, overhead crane, dolly push, pan across "
            "machines, wide-angle aerial"
        ),
        process_notes=(
            "Every scene must feel like a highly efficient, smoothly "
            "running factory: machines and workers coordinated, "
            "production flows continuously, the process looks "
            "professional and precise. Each scene is standalone — all "
            "context, materials, and actions must be fully described "
            "within the scene itself. Image prompts MUST mention "
            "location/environment, materials/products, the process step, "
            "synchronized workers in protective gear, machines (conveyor "
            "belts, automated arms, presses, rollers), industrial LED "
            "lighting, camera angle, atmosphere cues (steam, dust, "
            "sparks, moving belts), textures and reflective metals."
        ),
    ),
    "custom": SceneTemplate(
        key="custom",
        label="Custom (paste your own style + process)",
        description="Paste your own style tag and process notes.",
        image_style_tag="",
        camera_hints="",
    ),
}
# Built-in templates. Mutable copies for ``custom`` are produced via
# :func:`make_custom_template` so callers can plug in their own style tag /
# camera hints / process notes without mutating the registry.


TEMPLATE_KEYS: list[str] = list(SCENE_TEMPLATES.keys())


def make_custom_template(
    *,
    image_style_tag: str,
    camera_hints: str,
    process_notes: str = "",
    label: str = "Custom",
) -> SceneTemplate:
    """Build a non-registered :class:`SceneTemplate` from user-supplied bits."""
    return SceneTemplate(
        key="custom",
        label=label,
        description="User-defined style.",
        image_style_tag=(image_style_tag or "").strip(),
        camera_hints=(camera_hints or "").strip(),
        process_notes=(process_notes or "").strip(),
    )


# ─── Scene dataclass ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LongFormScene:
    """One row of the breakdown sheet — paste-ready for AutoGrok / Veo / Whisk.

    Round-trips through :func:`serialize_breakdown_md` /
    :func:`parse_breakdown_response`.
    """

    scene_id: int
    title: str
    narration: str
    image_prompt: str
    flow_video_prompt: str
    duration_s: float = 0.0
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict:
        return asdict(self)


# ─── Estimation helpers ──────────────────────────────────────────────────────


_WORD_RE = re.compile(r"\b\w+\b", re.UNICODE)


def count_words(text: str) -> int:
    """Count whitespace-delimited words. Robust to markdown / punctuation."""
    return len(_WORD_RE.findall(text or ""))


def estimate_total_duration_s(
    script: str, *, words_per_minute: int = DEFAULT_WORDS_PER_MIN
) -> float:
    """Estimate spoken duration of ``script`` at ``words_per_minute`` WPM."""
    wpm = max(60, int(words_per_minute))
    return count_words(script) / wpm * 60.0


def estimate_scene_count(
    script: str,
    *,
    words_per_scene: int = DEFAULT_WORDS_PER_SCENE,
    min_scenes: int = MIN_SCENE_COUNT,
    max_scenes: int = MAX_SCENE_COUNT,
) -> int:
    """Estimate how many scenes a script of this length deserves.

    Defaults to ``words_per_scene=220`` (≈ 90 s of speech), clamped to
    ``[min_scenes, max_scenes]``. Returns ``min_scenes`` for empty
    scripts so the UI never offers ``0`` scenes.
    """
    words = count_words(script)
    if words <= 0:
        return min_scenes
    raw = round(words / max(60, int(words_per_scene)))
    return max(min_scenes, min(max_scenes, int(raw)))


# ─── LLM prompt construction ─────────────────────────────────────────────────


def _section_block(label: str, body: str) -> str:
    return f"{label}:\n{body.strip()}"


def build_breakdown_system_prompt(template: SceneTemplate, *, n_scenes: int) -> str:
    """Compose the LLM ``system`` prompt for scene breakdown.

    Keeps the user's strict template format (Scene X / NARRATION / IMAGE
    PROMPT / FLOW VIDEO PROMPT) and bolts the chosen template's style
    tag + camera hints + process notes onto it.
    """
    style_tag = template.image_style_tag or "high-detail, cinematic, 4K"
    camera = template.camera_hints or "smooth motion, cinematic camera"
    process = template.process_notes or ""
    process_block = (
        f"\nPROCESS NOTES (apply to EVERY scene):\n{process.strip()}\n"
        if process.strip()
        else ""
    )
    return (
        "You are a YouTube long-form scene-breakdown specialist. The user "
        "will paste a finished script. Split it into EXACTLY "
        f"{n_scenes} standalone scenes that, played in order, retell the "
        "script visually. For each scene produce a single ultra-detailed "
        "image prompt and a 3–4 sentence flow video prompt.\n\n"
        "Hard rules:\n"
        "1. Every scene is STANDALONE — all context, materials, and "
        "actions must be fully described inside that scene's prompts. "
        "Never write 'the same as scene 2'.\n"
        "2. NARRATION must be a verbatim slice of the script (exact "
        "wording, not a paraphrase). Slices may be 1–4 sentences long.\n"
        "3. IMAGE PROMPT is one paragraph (no line breaks), naming the "
        "location / environment, subjects, action, lighting, camera "
        "angle, mood, textures. End with the style tag below.\n"
        "4. FLOW VIDEO PROMPT is 3–4 sentences describing continuous "
        "motion of subjects/cameras and environmental cues. No brand "
        "names, logos, or on-screen text.\n"
        "5. Output ONLY the strict format below — no markdown headers, "
        "no extra commentary, no JSON.\n\n"
        f"Style tag (append to every image prompt): {style_tag}\n"
        f"Camera language pool (mix into flow video prompts): {camera}\n"
        f"{process_block}"
        "Strict format (one block per scene, blank line between blocks):\n"
        "Scene <N>: <Standalone Scene Title>\n"
        "NARRATION:\n"
        "<verbatim script slice>\n"
        "IMAGE PROMPT:\n"
        "<single ultra-detailed paragraph>\n"
        "FLOW VIDEO PROMPT:\n"
        "<3–4 sentences>\n"
    )


def build_breakdown_user_prompt(script: str) -> str:
    """The ``user`` half of the breakdown call — just the script body."""
    return f"SCRIPT:\n{(script or '').strip()}\n"


def build_thumbnail_prompt(title: str, template: SceneTemplate) -> str:
    """Assemble the user's high-impact YouTube thumbnail prompt.

    Mirrors the user's ``TẠO THUMBNAIL`` template — close-up subject, slight
    rotation, wide-angle lens, deep DOF, factory environment when the
    template is industrial. For non-factory templates the environment
    block becomes generic ("a striking environment matching the topic")
    so the prompt still works.
    """
    title = (title or "").strip() or "Untitled video"
    if template.key == "factory":
        environment = (
            "FACTORY ENVIRONMENT — bright, clean industrial lighting, "
            "stainless-steel machinery and conveyor belts, workers in "
            "protective uniforms (red or yellow coats, gloves, masks, "
            "hairnets), crisp documentary-style industrial setting."
        )
    else:
        environment = (
            "ENVIRONMENT — a striking real-world setting matching the "
            "topic, dramatic lighting, ultra-detailed background, "
            "high-contrast composition that pops at thumbnail size."
        )
    return (
        f"Generate a highly detailed thumbnail image prompt based on the "
        f"TITLE: {title}.\n\n"
        "CAMERA + COMPOSITION — close-up foreground subject, large and "
        "dominant, camera angled slightly to the right (rotated about "
        "10–20 degrees), camera at chest/head height with a mild "
        "downward tilt, wide-angle 18–24mm lens to exaggerate scale, "
        "long leading lines extending deep into the background, deep "
        "depth of field (foreground and background both sharp).\n\n"
        f"{environment}\n\n"
        "OVERALL FEEL — surreal but realistic documentary aesthetic, "
        "dramatic high-impact YouTube thumbnail style. "
        f"Style tag: {template.image_style_tag or 'cinematic, 4K'}.\n"
        "Output ONLY the image prompt (do NOT generate an image)."
    )


# ─── Parser ──────────────────────────────────────────────────────────────────

# Match `Scene 12: Title` with optional whitespace / dashes around the colon.
_SCENE_HEADER_RE = re.compile(
    r"^\s*scene\s*(?P<id>\d+)\s*[:\-]\s*(?P<title>.*?)\s*$",
    re.IGNORECASE,
)
_SECTION_RE = re.compile(
    r"^\s*(?P<label>narration|image\s*prompt|flow\s*video\s*prompt|video\s*prompt)\s*:\s*$",
    re.IGNORECASE,
)


def parse_breakdown_response(
    raw: str,
    *,
    words_per_minute: int = DEFAULT_WORDS_PER_MIN,
) -> list[LongFormScene]:
    """Parse the LLM's structured reply into :class:`LongFormScene`\\ s.

    Lenient on whitespace / casing; strict on the four section labels
    (``NARRATION``, ``IMAGE PROMPT``, ``FLOW VIDEO PROMPT``). Scenes
    missing required sections are dropped (with their data discarded).
    """
    if not raw or not raw.strip():
        return []

    scenes: list[LongFormScene] = []
    current_id: int | None = None
    current_title = ""
    current_section: str | None = None
    buffers: dict[str, list[str]] = {
        "narration": [],
        "image_prompt": [],
        "flow_video_prompt": [],
    }

    def _flush() -> None:
        if current_id is None:
            return
        narration = "\n".join(buffers["narration"]).strip()
        image_prompt = " ".join(buffers["image_prompt"]).strip()
        # Collapse multi-line video prompts but keep sentence boundaries.
        flow_lines = [ln.strip() for ln in buffers["flow_video_prompt"] if ln.strip()]
        flow_video_prompt = " ".join(flow_lines).strip()
        if not (narration and image_prompt and flow_video_prompt):
            return
        duration = estimate_total_duration_s(
            narration, words_per_minute=words_per_minute
        )
        scenes.append(
            LongFormScene(
                scene_id=current_id,
                title=current_title or f"Scene {current_id}",
                narration=narration,
                image_prompt=image_prompt,
                flow_video_prompt=flow_video_prompt,
                duration_s=round(duration, 2),
            )
        )

    for line in raw.splitlines():
        header = _SCENE_HEADER_RE.match(line)
        if header:
            _flush()
            current_id = int(header.group("id"))
            current_title = header.group("title").strip()
            current_section = None
            buffers = {
                "narration": [],
                "image_prompt": [],
                "flow_video_prompt": [],
            }
            continue

        section = _SECTION_RE.match(line)
        if section:
            label = section.group("label").lower().replace(" ", "")
            if label == "narration":
                current_section = "narration"
            elif label == "imageprompt":
                current_section = "image_prompt"
            elif label in {"flowvideoprompt", "videoprompt"}:
                current_section = "flow_video_prompt"
            else:
                current_section = None
            continue

        if current_section is None or current_id is None:
            continue
        buffers[current_section].append(line)

    _flush()
    # Renumber to ensure IDs are 1..N contiguous (the LLM occasionally
    # skips a scene when it can't fit a section).
    return [
        LongFormScene(
            scene_id=i + 1,
            title=s.title,
            narration=s.narration,
            image_prompt=s.image_prompt,
            flow_video_prompt=s.flow_video_prompt,
            duration_s=s.duration_s,
        )
        for i, s in enumerate(scenes)
    ]


# ─── Serializers ─────────────────────────────────────────────────────────────


def serialize_breakdown_md(
    scenes: list[LongFormScene],
    *,
    title: str = "",
    template: SceneTemplate | None = None,
) -> str:
    """Render scenes back into the strict LLM template (round-trip safe).

    Optional ``title`` and ``template`` produce a small header so the
    output doubles as a deliverable users can paste into AutoGrok or
    grok.com web verbatim.
    """
    out: list[str] = []
    if title or template:
        header_bits = []
        if title:
            header_bits.append(f"# {title}")
        if template:
            header_bits.append(
                f"_template: {template.key} — {template.label}_"
            )
        out.append("\n".join(header_bits))
    for scene in scenes:
        out.append(
            "\n".join(
                [
                    f"Scene {scene.scene_id}: {scene.title}",
                    _section_block("NARRATION", scene.narration),
                    _section_block("IMAGE PROMPT", scene.image_prompt),
                    _section_block("FLOW VIDEO PROMPT", scene.flow_video_prompt),
                ]
            )
        )
    return "\n\n".join(out).rstrip() + "\n"


def serialize_breakdown_json(scenes: list[LongFormScene]) -> list[dict]:
    """Plain list-of-dicts; suitable for ``json.dumps`` or ``st.json``."""
    return [scene.to_json() for scene in scenes]


# ─── Orchestrator ────────────────────────────────────────────────────────────


def generate_scene_breakdown(
    script: str,
    *,
    template: SceneTemplate,
    n_scenes: int | None = None,
    chat_fn: Callable[[str, str], str] | None = None,
    words_per_minute: int = DEFAULT_WORDS_PER_MIN,
) -> list[LongFormScene]:
    """Expand ``script`` into a breakdown sheet using ``chat_fn``.

    Parameters
    ----------
    script:
        Long-form narration text (Studio's ``script_final`` or any
        ``.md``/``.txt`` body).
    template:
        Style + camera + process recipe driving the LLM prompt.
    n_scenes:
        Force a specific scene count; defaults to
        :func:`estimate_scene_count` for the script.
    chat_fn:
        Callable ``(prompt, system) -> str``. Defaults to
        :func:`core.llm.chat`. Tests pass a fake.
    words_per_minute:
        WPM used to estimate per-scene duration from the narration
        slice the LLM emits.
    """
    body = (script or "").strip()
    if not body:
        return []
    if n_scenes is None:
        n_scenes = estimate_scene_count(body)
    n_scenes = max(MIN_SCENE_COUNT, min(MAX_SCENE_COUNT, int(n_scenes)))

    if chat_fn is None:
        from core.llm import chat as default_chat

        def chat_fn(user: str, system: str) -> str:  # type: ignore[misc]
            return default_chat(user, system=system, temperature=0.6)

    system = build_breakdown_system_prompt(template, n_scenes=n_scenes)
    user = build_breakdown_user_prompt(body)
    raw = chat_fn(user, system)
    return parse_breakdown_response(raw, words_per_minute=words_per_minute)
