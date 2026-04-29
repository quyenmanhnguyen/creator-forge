"""Visual style presets for placeholder Producer videos.

Each preset is a vertical-gradient colour pair (``top``, ``bottom``) plus
an accent used for caption highlighting. PR-A2 uses these as Ken Burns
backgrounds; PR-A3 will start replacing them with real AI-generated
visuals from ComfyUI/Flux.
"""
from __future__ import annotations

from dataclasses import dataclass

# RGB (0-255) — readable on white text, all WCAG AA.


@dataclass(frozen=True)
class Style:
    """Background gradient + caption accent for placeholder visuals."""

    name: str
    top: tuple[int, int, int]
    bottom: tuple[int, int, int]
    accent: tuple[int, int, int]


STYLES: dict[str, Style] = {
    "violet-pink": Style(
        name="violet-pink",
        top=(76, 29, 149),       # violet-900
        bottom=(236, 72, 153),   # pink-500
        accent=(244, 114, 182),  # pink-400
    ),
    "sunset": Style(
        name="sunset",
        top=(154, 52, 18),       # orange-900
        bottom=(251, 191, 36),   # amber-400
        accent=(253, 224, 71),   # yellow-300
    ),
    "ocean": Style(
        name="ocean",
        top=(15, 23, 42),        # slate-900
        bottom=(56, 189, 248),   # sky-400
        accent=(125, 211, 252),  # sky-300
    ),
    "mono": Style(
        name="mono",
        top=(15, 15, 15),
        bottom=(60, 60, 60),
        accent=(220, 220, 220),
    ),
    "matcha": Style(
        name="matcha",
        top=(20, 83, 45),        # green-900
        bottom=(132, 204, 22),   # lime-500
        accent=(190, 242, 100),  # lime-300
    ),
}

DEFAULT_STYLE = "violet-pink"


def get_style(name: str) -> Style:
    """Look up a style by name, falling back to the default."""
    return STYLES.get(name, STYLES[DEFAULT_STYLE])
