"""Outlier Finder — small channels with viral videos in the last N days.

Flagship discovery tool: surfaces videos where ``views >> subscriber count``
on channels under a chosen size cap. These are the clonable templates the
algorithm just rewarded — exactly what creators want to find.

Per-row "🎯 Clone" → routes to the Video Cloner with the URL prefilled.
Per-row "📝 Use topic" → routes to the Studio with the title as topic.
"""
from __future__ import annotations

import pandas as pd
import streamlit as st

from core import outliers
from core.i18n import language_selector, t
from core.theme import inject, page_header
from core.utils import humanize_int

st.set_page_config(page_title="Outlier Finder · Tube Atlas", page_icon="🎯", layout="wide")
inject()
language_selector()

page_header(
    eyebrow="03 · " + t("section_research"),
    title="🎯  " + t("outlier_name"),
    subtitle=t("outlier_desc"),
)

# Cross-page handoffs (consumed once).
if st.session_state.pop("_goto_studio", False):
    st.switch_page("pages/04_Studio.py")
if st.session_state.pop("_goto_cloner", False):
    st.switch_page("pages/02_Video_Cloner.py")


def _send_topic_to_studio(value: str) -> None:
    st.session_state["studio_topic_in"] = value
    st.session_state["_goto_studio"] = True


def _send_url_to_cloner(value: str) -> None:
    st.session_state["cloner_url_in"] = value
    st.session_state["_goto_cloner"] = True


with st.form("outlier"):
    seed = st.text_input(
        t("outlier_seed"),
        placeholder="e.g. 불교 말년운, ai music tutorial, minimalist setup",
    )
    c1, c2, c3, c4 = st.columns(4)
    with c1:
        region = st.selectbox("Region", ["VN", "US", "JP", "KR", "GB", "ID"], index=0)
    with c2:
        window_label = st.selectbox(
            t("outlier_window"),
            [t("outlier_window_7"), t("outlier_window_14"), t("outlier_window_30")],
            index=0,
        )
        window_days = {
            t("outlier_window_7"): 7,
            t("outlier_window_14"): 14,
            t("outlier_window_30"): 30,
        }[window_label]
    with c3:
        max_subs = st.number_input(t("outlier_max_subs"), 1_000, 5_000_000, 100_000, step=10_000)
    with c4:
        min_ratio = st.slider(t("outlier_min_ratio"), 0.5, 10.0, 1.5, step=0.5)
    run = st.form_submit_button(t("outlier_run"), type="primary")

if not (run and seed.strip()):
    st.stop()


@st.cache_data(ttl=900, show_spinner=False)
def _cached_find_outliers(
    seed: str, region: str, window_days: int, max_subs: int, min_ratio: float
) -> list[dict]:
    rows = outliers.find_outliers(
        seed,
        region=region,
        window_days=window_days,
        max_subs=int(max_subs),
        min_outlier=min_ratio,
    )
    return [r.__dict__ for r in rows]


with st.spinner("Searching YouTube + scoring outliers…"):
    try:
        records = _cached_find_outliers(
            seed.strip(), region, window_days, int(max_subs), float(min_ratio)
        )
    except Exception as e:
        st.error(f"YouTube lookup failed (need YOUTUBE_API_KEY?): {e}")
        st.stop()

if not records:
    st.info(t("outlier_no_results"))
    st.stop()


# ─── Header stats ─────────────────────────────────────────────────────────────
df = pd.DataFrame(records)
m1, m2, m3, m4 = st.columns(4)
m1.metric("Outliers found", len(df))
m2.metric(t("outlier_max_vph"), humanize_int(int(df["vph"].max())))
m3.metric(t("outlier_avg_vph"), humanize_int(int(df["vph"].mean())))
m4.metric(t("outlier_avg_score"), f"{df['outlier_score'].mean():.1f}×")

st.markdown("---")

# ─── Rows ─────────────────────────────────────────────────────────────────────
for _, row in df.iterrows():
    with st.container(border=True):
        cols = st.columns([1, 4, 2, 2, 2])
        with cols[0]:
            if row["thumbnail"]:
                st.image(row["thumbnail"], width=160)
        with cols[1]:
            st.markdown(f"**{row['title'][:120]}**")
            days_ago = max(int(row["hours_since"] / 24), 0)
            st.caption(
                f"📺 {row['channel_title']} · 👥 {humanize_int(row['subs'])} subs · "
                f"📅 {days_ago}d ago"
            )
            st.markdown(f"[Open on YouTube]({row['url']})")
        with cols[2]:
            st.metric("Views", humanize_int(int(row["views"])))
            st.caption(f"VPH {humanize_int(int(row['vph']))}")
        with cols[3]:
            ratio = float(row["outlier_score"])
            color = "#22c55e" if ratio >= 5 else ("#f59e0b" if ratio >= 2 else "#a78bfa")
            st.markdown(
                f"""
                <div style="padding:10px 14px; border-radius:12px;
                            background:{color}1a; border:1px solid {color}55; text-align:center;">
                  <div style="color:#a78bfa; font-size:0.65rem; letter-spacing:.16em;">{t("outlier_score").upper()}</div>
                  <div style="color:{color}; font-size:1.4rem; font-weight:700;">{ratio:.1f}×</div>
                </div>
                """,
                unsafe_allow_html=True,
            )
        with cols[4]:
            st.button(
                t("outlier_clone_video"),
                key=f"clone_{row['video_id']}",
                use_container_width=True,
                on_click=_send_url_to_cloner,
                args=(row["url"],),
            )
            st.button(
                t("outlier_use_topic"),
                key=f"topic_{row['video_id']}",
                use_container_width=True,
                on_click=_send_topic_to_studio,
                args=(row["title"],),
            )

# ─── CSV export ───────────────────────────────────────────────────────────────
st.markdown("---")
csv_cols = [
    "title", "channel_title", "subs", "views", "vph",
    "outlier_score", "hours_since", "url",
]
csv_df = df[csv_cols].copy()
csv_df["outlier_score"] = csv_df["outlier_score"].round(2)
csv_df["vph"] = csv_df["vph"].round(1)
csv_df["hours_since"] = csv_df["hours_since"].round(1)
st.download_button(
    t("outlier_csv"),
    csv_df.to_csv(index=False).encode("utf-8"),
    file_name=f"outliers_{seed.strip().replace(' ', '_')}_{window_days}d.csv",
)
