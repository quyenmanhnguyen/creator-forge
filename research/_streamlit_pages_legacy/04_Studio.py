"""Studio — 5-step creator pipeline (Topic → Title → Outline → Script → Rewrite).

Mirrors the H2Dev workflow the user specified: each step's output feeds
the next, all stored in ``st.session_state["studio"]``. Niche Finder and
Keyword Finder can prefill ``studio.seed`` / ``studio.topic`` / ``studio.title``
to skip ahead. Output language follows the sidebar selector (or the
override set by Video Cloner when the source video is in another language).
"""
from __future__ import annotations

import json

import streamlit as st

from core import llm
from core.i18n import language_label, language_selector, t
from core.theme import inject, page_header

st.set_page_config(page_title="Studio · Tube Atlas", page_icon="🎬", layout="wide")
inject()
language_selector()

page_header(
    eyebrow="04 · " + t("section_create"),
    title="🎬  " + t("studio_name"),
    subtitle=t("studio_desc"),
)


def _missing_key_render(exc: Exception) -> bool:
    """If ``exc`` is the missing-DeepSeek-key sentinel, render i18n error and return True."""
    if isinstance(exc, RuntimeError) and llm.ERR_NO_DEEPSEEK_KEY in str(exc):
        st.error(t("err_missing_deepseek"))
        return True
    return False


# ─── State ────────────────────────────────────────────────────────────────────
DEFAULT_STATE = {
    "step": 1,
    "seed": "",
    "ideas": [],
    "topic": "",
    "titles": [],
    "title": "",
    "outline_parts": [],
    "script": "",
    "script_final": "",
}
if "studio" not in st.session_state:
    st.session_state["studio"] = dict(DEFAULT_STATE)
S = st.session_state["studio"]

# Cross-page handoff (set by other pages, consumed once).
for handoff_key, target_key, target_step in [
    ("studio_seed_in", "seed", 1),
    ("studio_topic_in", "topic", 2),
    ("studio_title_in", "title", 3),
]:
    incoming = st.session_state.pop(handoff_key, None)
    if incoming:
        S[target_key] = incoming
        S["step"] = target_step
        st.toast(f"Studio: {target_key} = {incoming[:80]}", icon="🎬")

# ─── Sidebar progress ─────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("---")
    st.caption(t("studio_progress"))
    step_labels = [
        t("studio_step1"),
        t("studio_step2"),
        t("studio_step3"),
        t("studio_step4"),
        t("studio_step5"),
    ]
    for i, lbl in enumerate(step_labels, 1):
        marker = "🟣" if i == S["step"] else ("🟢" if i < S["step"] else "⚪")
        st.markdown(f"{marker} **{lbl}**" if i == S["step"] else f"{marker} {lbl}")
    if st.button("↺ Restart pipeline", key="studio_restart", use_container_width=True):
        st.session_state["studio"] = dict(DEFAULT_STATE)
        st.rerun()


def _nav_buttons(*, can_back: bool = True, can_next: bool = False) -> None:
    """Render Back / Next buttons. Caller wires the conditions."""
    cols = st.columns([1, 1, 4])
    with cols[0]:
        if can_back and st.button(t("studio_back"), key=f"back_{S['step']}", use_container_width=True):
            S["step"] = max(1, S["step"] - 1)
            st.rerun()
    with cols[1]:
        if can_next and st.button(t("studio_next"), key=f"next_{S['step']}", type="primary", use_container_width=True):
            S["step"] = min(5, S["step"] + 1)
            st.rerun()


lang_label_str = language_label()


# ─── Step 1 — Topic ideas ─────────────────────────────────────────────────────
if S["step"] == 1:
    st.subheader(t("studio_step1"))
    with st.form("studio_step1"):
        S["seed"] = st.text_input(t("studio_seed_label"), value=S.get("seed", ""))
        run = st.form_submit_button(t("studio_run_step1"), type="primary")
    if run and S["seed"].strip():
        try:
            with st.spinner("DeepSeek…"):
                data = llm.topic_ideas(S["seed"].strip(), language=lang_label_str)
            S["ideas"] = data.get("ideas", [])
        except Exception as e:
            if not _missing_key_render(e):
                st.error(f"{e}")

    st.caption(t("studio_paste_hint"))
    paste_topic = st.text_area("", placeholder="(paste a topic here to skip ahead)", key="paste_topic", height=70, label_visibility="collapsed")
    if paste_topic.strip() and st.button(t("studio_pick_topic"), key="paste_topic_btn"):
        S["topic"] = paste_topic.strip()
        S["step"] = 2
        st.rerun()

    if S["ideas"]:
        st.markdown("---")
        st.markdown(f"**{len(S['ideas'])} ideas** — {t('studio_select_topic')}")
        for i, idea in enumerate(S["ideas"], 1):
            with st.container(border=True):
                c1, c2 = st.columns([5, 1])
                with c1:
                    st.markdown(f"**{i:02d}. {idea.get('topic', '')}**")
                    st.caption(f"💗 {idea.get('emotion', '')}  ·  🎣 {idea.get('hook', '')}")
                with c2:
                    if st.button(t("studio_pick_topic"), key=f"pick_topic_{i}", use_container_width=True):
                        S["topic"] = idea.get("topic", "")
                        S["step"] = 2
                        st.rerun()


# ─── Step 2 — Titles ──────────────────────────────────────────────────────────
elif S["step"] == 2:
    st.subheader(t("studio_step2"))
    st.markdown(f"**Topic:** {S.get('topic', '—')}")
    with st.form("studio_step2"):
        n = st.slider("# titles", 5, 20, 10)
        must_kw = st.text_input("Must-include keywords (optional)")
        run = st.form_submit_button(t("studio_run_step2"), type="primary")
    if run and S["topic"].strip():
        try:
            with st.spinner("DeepSeek…"):
                data = llm.titles_with_ctr(S["topic"], language=lang_label_str, n=n, must_keywords=must_kw)
            S["titles"] = data.get("titles", [])
        except Exception as e:
            if not _missing_key_render(e):
                st.error(f"{e}")

    st.caption(t("studio_paste_hint"))
    paste_title = st.text_input("", placeholder="(paste a title here to skip ahead)", key="paste_title", label_visibility="collapsed")
    if paste_title.strip() and st.button(t("studio_pick_title"), key="paste_title_btn"):
        S["title"] = paste_title.strip()
        S["step"] = 3
        st.rerun()

    if S["titles"]:
        st.markdown("---")
        for i, ttl in enumerate(S["titles"], 1):
            is_top = bool(ttl.get("ctr_rank"))
            border_style = "linear-gradient(135deg, rgba(34,197,94,0.18), rgba(124,58,237,0.18))" if is_top else "transparent"
            with st.container(border=True):
                c1, c2 = st.columns([5, 1])
                with c1:
                    badge = f" · 🏆 {t('studio_top3')}" if is_top else ""
                    st.markdown(
                        f"<div style='background:{border_style}; padding:6px 10px; border-radius:8px;'>"
                        f"<b>{i:02d}.</b> {ttl.get('title', '')}{badge}</div>",
                        unsafe_allow_html=True,
                    )
                    st.caption(f"💡 {ttl.get('reason', '')}  ·  📏 {len(ttl.get('title', ''))} {t('studio_chars')}")
                with c2:
                    if st.button(t("studio_pick_title"), key=f"pick_title_{i}", use_container_width=True):
                        S["title"] = ttl.get("title", "")
                        S["step"] = 3
                        st.rerun()
    _nav_buttons(can_back=True, can_next=False)


# ─── Step 3 — 8-part outline ──────────────────────────────────────────────────
elif S["step"] == 3:
    st.subheader(t("studio_step3"))
    st.markdown(f"**Title:** {S.get('title', '—')}")
    if st.button(t("studio_run_step3"), type="primary", key="run_step3"):
        try:
            with st.spinner("DeepSeek…"):
                data = llm.outline_8part(S["title"], language=lang_label_str)
            S["outline_parts"] = data.get("parts", [])
        except Exception as e:
            if not _missing_key_render(e):
                st.error(f"{e}")

    if S["outline_parts"]:
        for p in S["outline_parts"]:
            with st.container(border=True):
                st.markdown(f"**PART {p.get('part', '?')} — {p.get('role', '')}**")
                st.caption(f"💗 {p.get('emotion', '')}")
                st.markdown(p.get("expansion", ""))
        st.download_button(
            t("studio_download_md"),
            json.dumps(S["outline_parts"], ensure_ascii=False, indent=2).encode("utf-8"),
            file_name="outline_8part.json",
            mime="application/json",
        )
        if st.button(t("studio_next"), type="primary", key="next_step3"):
            S["step"] = 4
            st.rerun()
    _nav_buttons(can_back=True, can_next=False)


# ─── Step 4 — Long-form script ────────────────────────────────────────────────
elif S["step"] == 4:
    st.subheader(t("studio_step4"))
    st.markdown(f"**Title:** {S.get('title', '—')}")
    if not S.get("outline_parts"):
        st.warning("No outline yet. Go back to step 3.")
        _nav_buttons(can_back=True)
    else:
        target_chars = st.select_slider(
            t("studio_target_chars"),
            options=[3000, 5000, 8000, 12000, 18000, 24000],
            value=8000,
        )
        if st.button(t("studio_run_step4"), type="primary", key="run_step4"):
            try:
                with st.spinner("DeepSeek (this may take 30-60s)…"):
                    script = llm.long_script_chunked(
                        S["title"],
                        S["outline_parts"],
                        language=lang_label_str,
                        target_chars=target_chars,
                    )
                S["script"] = script
            except Exception as e:
                if not _missing_key_render(e):
                    st.error(f"{e}")

        if S.get("script"):
            st.metric(t("studio_chars"), f"{len(S['script']):,}")
            with st.expander("Full script", expanded=True):
                st.markdown(S["script"])
            st.download_button(
                t("studio_download_md"),
                S["script"].encode("utf-8"),
                file_name="script_raw.md",
            )
            if st.button(t("studio_next"), type="primary", key="next_step4"):
                S["step"] = 5
                st.rerun()
        _nav_buttons(can_back=True, can_next=False)


# ─── Step 5 — Humanize rewrite ────────────────────────────────────────────────
elif S["step"] == 5:
    st.subheader(t("studio_step5"))
    if not S.get("script"):
        st.warning("No script yet. Go back to step 4.")
        _nav_buttons(can_back=True)
    else:
        if st.button(t("studio_run_step5"), type="primary", key="run_step5"):
            try:
                with st.spinner("DeepSeek (this may take 30-60s)…"):
                    final = llm.humanize_rewrite(S["script"], language=lang_label_str)
                S["script_final"] = final
            except Exception as e:
                if not _missing_key_render(e):
                    st.error(f"{e}")

        if S.get("script_final"):
            c1, c2 = st.columns(2)
            c1.metric("Raw " + t("studio_chars"), f"{len(S['script']):,}")
            c2.metric("Final " + t("studio_chars"), f"{len(S['script_final']):,}")
            with st.expander("Final script", expanded=True):
                st.markdown(S["script_final"])
            st.download_button(
                t("studio_download_md"),
                S["script_final"].encode("utf-8"),
                file_name="script_final.md",
            )
        _nav_buttons(can_back=True, can_next=False)
