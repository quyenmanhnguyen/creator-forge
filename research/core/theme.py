"""Shared premium CSS + layout helpers (Tube Atlas v3 — animated mesh + glass).

Color tokens
------------
- Background: ``#08051a`` deep violet-black.
- Panel:      ``#15102e`` raised purple (translucent in v3).
- Border:     ``#2a1f5c``.
- Primary:    ``#a855f7`` (violet) → ``#7c3aed`` (deep violet).
- Accent:     ``#ec4899`` neon pink.
- Indigo:     ``#6366f1`` (mesh blob).
- Text:       ``#f5f3ff`` near-white on dark.
- Muted:      ``#a78bfa`` lavender.

v3 additions:
- Animated mesh-gradient background (CSS keyframes drift, GPU-cheap).
- Glassmorphism (``.glass-block``) — translucent panels with ``backdrop-filter: blur``.
- Subtle SVG noise overlay so the gradient never looks plastic.
- Refined hover (lift + accent border + glow) and gradient section dividers.
"""
from __future__ import annotations

import streamlit as st

PREMIUM_CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap');

/* ── Global ── */
html, body, [class*="css"], [data-testid="stAppViewContainer"] {
    font-family: 'Inter', system-ui, sans-serif !important;
    color: #f5f3ff;
}

/* Animated mesh-gradient background. Three radial blobs drift slowly + a deep
   linear base. The keyframes shift each blob's centre in opposite directions,
   creating a perpetually-changing aurora that the eye can't predict. */
[data-testid="stAppViewContainer"] {
    position: relative;
    background:
      radial-gradient(circle at var(--blob1-x, 18%) var(--blob1-y, 22%), rgba(168,85,247,0.32), transparent 48%),
      radial-gradient(circle at var(--blob2-x, 82%) var(--blob2-y, 14%), rgba(236,72,153,0.28), transparent 44%),
      radial-gradient(circle at var(--blob3-x, 50%) var(--blob3-y, 92%), rgba(99,102,241,0.32), transparent 56%),
      linear-gradient(180deg, #08051a 0%, #11082a 48%, #08051a 100%) !important;
    background-attachment: fixed !important;
    animation: ta-mesh 24s ease-in-out infinite alternate;
}
@keyframes ta-mesh {
    0%   { background-position: 0% 0%, 100% 0%, 50% 100%, 0 0; }
    50%  { background-position: 30% 20%, 70% 30%, 30% 80%, 0 0; }
    100% { background-position: 60% 10%, 40% 50%, 60% 70%, 0 0; }
}

/* SVG noise texture overlay — sits under content, above the gradient. */
[data-testid="stAppViewContainer"]::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    opacity: 0.5;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.045 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
}
[data-testid="stAppViewContainer"] > * { position: relative; z-index: 1; }
[data-testid="stHeader"] { background: transparent !important; }

/* ── Sidebar ── */
[data-testid="stSidebar"] {
    background: linear-gradient(180deg, rgba(11,7,25,0.9) 0%, rgba(21,9,58,0.9) 100%) !important;
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-right: 1px solid rgba(124,58,237,0.32);
}
[data-testid="stSidebar"] [data-testid="stMarkdownContainer"] p,
[data-testid="stSidebar"] label,
[data-testid="stSidebar"] a {
    color: #c4b5fd !important;
}

/* ── Typography ── */
h1, h2, h3, h4 { color: #f5f3ff; letter-spacing: -0.02em; }
h1, h2, h3 { font-family: 'Space Grotesk', 'Inter', sans-serif; font-weight: 700 !important; }
.eyebrow {
    color: #ec4899;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.32em;
    text-transform: uppercase;
}
.muted { color: #a78bfa; }

/* Glassmorphism utility — drop this class on any block to give it the
   translucent + blurred-backdrop card look. */
.glass-block {
    background: rgba(20, 13, 48, 0.55) !important;
    backdrop-filter: blur(14px) saturate(1.2);
    -webkit-backdrop-filter: blur(14px) saturate(1.2);
    border: 1px solid rgba(124,58,237,0.28);
    border-radius: 16px;
}

/* Gradient horizontal section divider (replaces "---"). */
.ta-divider {
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(168,85,247,0.45) 30%, rgba(236,72,153,0.55) 70%, transparent 100%);
    margin: 28px 0;
    border: 0;
}

/* ── Buttons (default = solid violet) ── */
.stButton > button, .stDownloadButton > button, [data-testid="stFormSubmitButton"] button {
    background: linear-gradient(135deg, #7c3aed, #a855f7) !important;
    color: #ffffff !important;
    border: none !important;
    border-radius: 999px !important;
    padding: 0.55rem 1.4rem !important;
    font-weight: 600 !important;
    letter-spacing: 0.04em !important;
    transition: transform 0.18s ease, box-shadow 0.18s ease, filter 0.18s ease !important;
    box-shadow: 0 6px 22px rgba(124,58,237,0.35) !important;
}
.stButton > button:hover, .stDownloadButton > button:hover,
[data-testid="stFormSubmitButton"] button:hover {
    transform: translateY(-1px) !important;
    box-shadow: 0 12px 32px rgba(236,72,153,0.45) !important;
    filter: brightness(1.08);
}

/* ── Metric cards ── */
[data-testid="stMetric"] {
    background: rgba(28,17,72,0.55);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(124,58,237,0.32);
    border-radius: 16px;
    padding: 18px 22px;
    box-shadow: 0 4px 22px rgba(124,58,237,0.10);
    transition: transform 0.18s ease, border-color 0.18s ease;
}
[data-testid="stMetric"]:hover {
    transform: translateY(-1px);
    border-color: rgba(236,72,153,0.45);
}
[data-testid="stMetricValue"] {
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 700 !important;
    background: linear-gradient(135deg, #f5f3ff, #c4b5fd);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}
[data-testid="stMetricLabel"] { color: #a78bfa !important; letter-spacing: 0.08em; }

/* ── Inputs ── */
[data-testid="stForm"] {
    background: rgba(20,13,48,0.55);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(124,58,237,0.28);
    border-radius: 18px;
    padding: 24px;
}
[data-testid="stExpander"], [data-testid="stDataFrame"] {
    background: rgba(20,13,48,0.55) !important;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(124,58,237,0.28) !important;
    border-radius: 14px !important;
}
input, textarea {
    background: rgba(26,17,64,0.85) !important;
    color: #f5f3ff !important;
    border-radius: 10px !important;
    border: 1px solid #2a1f5c !important;
}
[data-baseweb="select"] > div {
    background: rgba(26,17,64,0.85) !important;
    border-color: #2a1f5c !important;
    border-radius: 10px !important;
}
[data-baseweb="tag"] { background: #2d1b69 !important; color: #f5f3ff !important; }

/* ── Tabs ── */
.stTabs [data-baseweb="tab-list"] {
    gap: 4px;
    background: rgba(20,13,48,0.6);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-radius: 14px;
    padding: 5px;
    border: 1px solid rgba(124,58,237,0.28);
}
.stTabs [data-baseweb="tab"] { border-radius: 10px; font-weight: 600; color: #c4b5fd; padding: 8px 18px; }
.stTabs [aria-selected="true"] {
    background: linear-gradient(135deg, #7c3aed, #ec4899) !important;
    color: #ffffff !important;
    box-shadow: 0 6px 18px rgba(236,72,153,0.30);
}

/* st.container(border=True) inside research/keyword pages */
[data-testid="stVerticalBlockBorderWrapper"] {
    background: rgba(20,13,48,0.50) !important;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(124,58,237,0.28) !important;
    border-radius: 14px !important;
    transition: border-color 0.18s ease, transform 0.18s ease;
}
[data-testid="stVerticalBlockBorderWrapper"]:hover {
    border-color: rgba(236,72,153,0.45) !important;
}

/* ── Alerts ── */
[data-testid="stAlert"] {
    background: rgba(124,58,237,0.10) !important;
    border-radius: 12px !important;
    border-left: 3px solid #ec4899 !important;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: #08051a; }
::-webkit-scrollbar-thumb { background: linear-gradient(180deg, #7c3aed, #ec4899); border-radius: 3px; }

/* ── Hero (used by app.py landing) ── */
.hero {
    position: relative;
    border-radius: 24px;
    border: 1px solid rgba(124,58,237,0.35);
    padding: 64px 56px 72px;
    overflow: hidden;
    background:
        radial-gradient(60% 80% at 80% 20%, rgba(236,72,153,0.45), transparent 60%),
        radial-gradient(70% 90% at 30% 80%, rgba(99,102,241,0.45), transparent 65%),
        radial-gradient(40% 60% at 60% 60%, rgba(168,85,247,0.55), transparent 70%),
        linear-gradient(135deg, #1a0f3d 0%, #2d1568 100%);
    box-shadow: 0 32px 80px rgba(124,58,237,0.25);
    margin-bottom: 36px;
    backdrop-filter: blur(2px);
}
.hero::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 24px;
    background:
        radial-gradient(circle at 78% 28%, rgba(255,255,255,0.10), transparent 30%),
        radial-gradient(circle at 22% 78%, rgba(255,255,255,0.06), transparent 30%);
    pointer-events: none;
    animation: ta-hero-shine 18s ease-in-out infinite alternate;
}
@keyframes ta-hero-shine {
    0%   { transform: translate(0, 0) rotate(0deg); }
    100% { transform: translate(-3%, -2%) rotate(2deg); }
}
.hero h1 {
    font-size: 3.8rem !important;
    line-height: 1.04;
    margin: 8px 0 20px !important;
    background: linear-gradient(135deg, #f5f3ff 0%, #ec4899 60%, #a855f7 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
}
.hero p.lead { color: #d8b4fe; font-size: 1.05rem; max-width: 60ch; margin-bottom: 32px; }

/* Outline pink CTA (hero & cards). Apply via class on the markdown link. */
.btn-outline {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 12px 22px;
    border: 1.5px solid #ec4899;
    border-radius: 999px;
    color: #ec4899 !important;
    text-decoration: none !important;
    letter-spacing: 0.18em;
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    transition: background 0.2s ease, color 0.2s ease, transform 0.2s ease;
}
.btn-outline:hover { background: rgba(236,72,153,0.14); transform: translateY(-1px); }
.btn-outline .arrow {
    width: 26px; height: 26px;
    border: 1.5px solid #ec4899;
    border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 0.85rem;
}

/* ── Numbered feature card (IOCO style + glass) ── */
.feature-card {
    position: relative;
    border: 1px solid rgba(124,58,237,0.32);
    border-radius: 20px;
    padding: 30px 24px 32px;
    background: linear-gradient(180deg, rgba(28,17,72,0.62) 0%, rgba(20,12,52,0.62) 100%);
    backdrop-filter: blur(14px) saturate(1.1);
    -webkit-backdrop-filter: blur(14px) saturate(1.1);
    height: 100%;
    min-height: 280px;
    transition: transform 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
    overflow: hidden;
}
.feature-card::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 20px;
    background: radial-gradient(60% 50% at 50% 0%, rgba(236,72,153,0.18), transparent 60%);
    opacity: 0;
    transition: opacity 0.22s ease;
    pointer-events: none;
}
.feature-card:hover {
    transform: translateY(-4px);
    border-color: rgba(236,72,153,0.55);
    box-shadow: 0 26px 56px rgba(236,72,153,0.22);
}
.feature-card:hover::before { opacity: 1; }
.feature-card .num {
    color: #ec4899;
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 700;
    font-size: 0.85rem;
    letter-spacing: 0.32em;
}
.feature-card .num::after {
    content: "";
    display: block;
    width: 32px;
    height: 1px;
    background: linear-gradient(90deg, #ec4899, transparent);
    margin-top: 8px;
    margin-bottom: 26px;
}
.feature-card .icon-circle {
    width: 68px; height: 68px;
    border: 1.5px solid rgba(236,72,153,0.55);
    border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.6rem;
    margin: 6px auto 22px;
    color: #f5f3ff;
    background: linear-gradient(135deg, rgba(124,58,237,0.18), rgba(236,72,153,0.10));
    box-shadow: inset 0 0 18px rgba(168,85,247,0.18);
}
.feature-card h3 {
    text-align: center;
    font-family: 'Space Grotesk', sans-serif;
    font-weight: 700;
    font-size: 1.6rem;
    margin: 0 0 6px;
}
.feature-card .sub {
    text-align: center;
    color: #ec4899;
    font-size: 0.72rem;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    margin-bottom: 14px;
}
.feature-card .desc {
    text-align: center;
    color: #c4b5fd;
    font-size: 0.88rem;
    line-height: 1.55;
}
.feature-card .arrow-bottom {
    position: absolute;
    left: 24px; bottom: 22px;
    color: #ec4899;
    opacity: 0.7;
    transition: transform 0.22s ease, opacity 0.22s ease;
}
.feature-card:hover .arrow-bottom { transform: translateX(4px); opacity: 1; }

/* Page-level title section reused by tool pages */
.page-eyebrow {
    color: #ec4899;
    font-size: 0.75rem;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    font-weight: 600;
    margin-bottom: 8px;
}

/* Reduced-motion friendly: kill long animations for users who opt-out. */
@media (prefers-reduced-motion: reduce) {
    [data-testid="stAppViewContainer"] { animation: none !important; }
    .hero::after { animation: none !important; }
}
</style>
"""


def inject() -> None:
    """Apply the shared theme CSS. Call at the top of every page."""
    st.markdown(PREMIUM_CSS, unsafe_allow_html=True)


def page_header(eyebrow: str, title: str, subtitle: str = "") -> None:
    """Render a consistent page header (eyebrow + title + optional subtitle)."""
    sub = (
        f'<p style="color:#c4b5fd; font-size:1rem; max-width:64ch;">{subtitle}</p>'
        if subtitle else ""
    )
    st.markdown(
        f"""
        <div style="margin: 8px 0 28px;">
            <div class="page-eyebrow">{eyebrow}</div>
            <h1 style="margin: 0 0 10px; font-size: 2.4rem;">{title}</h1>
            {sub}
        </div>
        """,
        unsafe_allow_html=True,
    )


def gradient_divider() -> None:
    """Render a subtle pink/violet gradient line. Replaces ``st.markdown('---')``."""
    st.markdown('<hr class="ta-divider"/>', unsafe_allow_html=True)
