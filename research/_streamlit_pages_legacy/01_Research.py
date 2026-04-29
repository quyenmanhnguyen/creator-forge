"""Research — long-tail keywords + niche analysis in one workflow.

A merger of the previous Keyword Finder and Niche Finder pages: niche analysis
is a deeper view of the same seed, not a separate tool. One seed input feeds
two tabs:

- **Long-tail keywords** (default, free): YouTube Autocomplete suggestions,
  optional KGR competition score, VidIQ-style Volume / Competition / Score
  gauges, VPH bar chart of top results, question-bucket keywords.
- **Niche analysis** (signals): Trend Pulse 7d, Google Trends interest
  + related queries, niche-level opportunity score, breakout videos
  (outliers), top channels, audience sentiment, AI verdict (DeepSeek).

Every keyword / topic row has a **→ Send to Studio** button to hand the
result to the 5-step Studio wizard.
"""
from __future__ import annotations

import json
import os

import pandas as pd
import plotly.express as px
import streamlit as st

from core import autocomplete, comments, keywords, llm, trends, youtube as yt
from core.i18n import get_lang, language_label, language_selector, t
from core.theme import gradient_divider, inject, page_header
from core.utils import humanize_int, parse_count

st.set_page_config(page_title="Research · Tube Atlas", page_icon="🔬", layout="wide")
inject()
language_selector()

page_header(
    eyebrow="01 · " + t("section_research"),
    title="🔬  " + t("research_name"),
    subtitle=t("research_desc"),
)

if st.session_state.pop("_goto_studio", False):
    st.switch_page("pages/04_Studio.py")


def _send_to_studio(value: str) -> None:
    st.session_state["studio_seed_in"] = value
    st.session_state["_goto_studio"] = True


def _missing_deepseek_render(exc: Exception) -> bool:
    if isinstance(exc, RuntimeError) and llm.ERR_NO_DEEPSEEK_KEY in str(exc):
        st.error(t("err_missing_deepseek"))
        return True
    return False


def _gauge_html(label: str, value: float, color: str) -> str:
    pct = max(0, min(100, int(round(value))))
    return f"""
    <div class="glass-block" style="padding:12px 16px;
                background:linear-gradient(180deg, {color}1a, {color}0d);
                border:1px solid {color}55;">
      <div style="color:#a78bfa; font-size:0.7rem; letter-spacing:.18em;">{label.upper()}</div>
      <div style="color:{color}; font-size:1.7rem; font-weight:700; line-height:1.1;">{pct}<span style="font-size:0.85rem; opacity:.6;">/100</span></div>
      <div style="margin-top:8px; height:6px; background:#1a1040; border-radius:99px; overflow:hidden;">
        <div style="width:{pct}%; height:100%; background:{color};"></div>
      </div>
    </div>
    """


# ─── Shared seed bar ──────────────────────────────────────────────────────────
with st.form("research"):
    seed = st.text_input(
        t("research_seed"),
        placeholder="e.g. minimalist desk setup, k-pop dance practice, 불교 말년운",
    )
    c1, c2 = st.columns([1, 1])
    with c1:
        gl = st.selectbox(
            t("research_region"), ["US", "KR", "JP", "VN", "GB", "ID", "CN"], index=0
        )
    with c2:
        hl = st.selectbox(
            t("research_lang"), ["en", "ko", "ja", "vi", "zh-CN"], index=0
        )
    run = st.form_submit_button(t("research_run"), type="primary")

if not (run and seed.strip()):
    st.stop()

seed = seed.strip()


# ─── Tabs ─────────────────────────────────────────────────────────────────────
tab_kw, tab_niche = st.tabs([
    "🔑  " + t("research_tab_keywords"),
    "🧬  " + t("research_tab_niche"),
])


# ============================================================================
# TAB A — Long-tail keywords
# ============================================================================
with tab_kw:
    with st.spinner(t("research_loading_autocomplete")):
        suggestions = autocomplete.suggest(seed, hl=hl, gl=gl)

    if not suggestions:
        st.warning(t("research_no_suggestions"))
    else:
        rows = keywords.build_rows(seed, suggestions)

        # ── VidIQ-style gauges (proxy) ─────────────────────────────────────
        seed_volume_score: float | None = None
        seed_competition_score: float | None = None
        seed_keyword_score: float | None = None
        seed_total_results = 0
        seed_top_videos: list[dict] = []

        if os.getenv("YOUTUBE_API_KEY"):
            try:
                resp = yt.search_raw(seed, max_results=10, region=gl, order="relevance")
                seed_total_results = int(resp.get("pageInfo", {}).get("totalResults", 0))
                ids = [
                    it["id"]["videoId"]
                    for it in resp.get("items", [])
                    if it.get("id", {}).get("videoId")
                ]
                if ids:
                    seed_top_videos = yt.videos_details(ids[:10])
                top_views = [
                    int(v.get("statistics", {}).get("viewCount", 0))
                    for v in seed_top_videos
                ]
                avg_top = int(sum(top_views) / len(top_views)) if top_views else 0
                seed_volume_score = keywords.volume_score(
                    len(suggestions), seed_total_results
                )
                seed_competition_score = keywords.competition_score(
                    seed_total_results, avg_top
                )
                seed_keyword_score = keywords.keyword_score(
                    seed_volume_score, seed_competition_score
                )
            except Exception:
                pass

        if seed_keyword_score is not None:
            st.markdown(f"### {t('kw_score_panel')} — `{seed}`")
            score_color = (
                "#22c55e" if seed_keyword_score >= 70
                else "#f59e0b" if seed_keyword_score >= 40
                else "#ef4444"
            )
            g1, g2, g3 = st.columns(3)
            with g1:
                st.markdown(_gauge_html(t("kw_score_panel"), seed_keyword_score, score_color), unsafe_allow_html=True)
            with g2:
                st.markdown(_gauge_html(t("kw_volume"), seed_volume_score or 0.0, "#22c55e"), unsafe_allow_html=True)
            with g3:
                st.markdown(_gauge_html(t("kw_competition_g"), seed_competition_score or 0.0, "#ef4444"), unsafe_allow_html=True)
            st.caption(t("kw_score_proxy_note"))

            # VPH sparkline of top 10
            if seed_top_videos:
                from datetime import datetime, timezone

                vph_rows: list[dict] = []
                for v in seed_top_videos:
                    try:
                        pub = v["snippet"]["publishedAt"].replace("Z", "+00:00")
                        dt = datetime.fromisoformat(pub)
                        hours = max(
                            (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0,
                            1.0,
                        )
                        views = int(v.get("statistics", {}).get("viewCount", 0))
                        vph_rows.append({
                            "title": v["snippet"]["title"][:60],
                            "vph": yt.vph(views, hours),
                            "views": views,
                        })
                    except Exception:
                        continue
                if vph_rows:
                    vdf = (
                        pd.DataFrame(vph_rows)
                        .sort_values("vph", ascending=False)
                        .reset_index(drop=True)
                    )
                    st.markdown(f"**{t('kw_vph_top')}**")
                    st.bar_chart(vdf, x="title", y="vph", height=200)
            gradient_divider()

        # ── KGR (optional, costs quota) ────────────────────────────────────
        compute_kgr = st.toggle(t("kw_compute_kgr"), value=False, key="kw_kgr_toggle")
        if compute_kgr:
            if not os.getenv("YOUTUBE_API_KEY"):
                st.error(t("err_missing_youtube"))
            else:
                breadth = max(len(suggestions), 1)
                prog = st.progress(0.0, text="Computing competition + KGR…")
                sample = rows[:25]
                for i, row in enumerate(sample, 1):
                    try:
                        resp = yt.search_raw(
                            row["keyword"], max_results=1, region=gl, order="relevance"
                        )
                        comp = int(resp.get("pageInfo", {}).get("totalResults", 0))
                    except Exception:
                        comp = 0
                    row["competition"] = comp
                    score, grade = keywords.kgr_score(comp, breadth)
                    row["score"] = score
                    row["grade"] = grade
                    prog.progress(i / len(sample), text=f"Computing… {i}/{len(sample)}")
                prog.empty()

        # ── Display rows ───────────────────────────────────────────────────
        df = pd.DataFrame(rows)
        c1, c2, c3 = st.columns(3)
        c1.metric("Suggestions", len(df))
        c2.metric("Avg words", f"{df['words'].mean():.1f}")
        if compute_kgr and df["competition"].sum():
            easy_n = int((df["grade"] == "easy").sum())
            c3.metric("Easy-to-rank", easy_n)

        gradient_divider()

        top = df.head(15)
        for _, row in top.iterrows():
            with st.container(border=True):
                cA, cB, cC = st.columns([5, 2, 2])
                with cA:
                    st.markdown(f"**{row['keyword']}**")
                    meta = f"📏 {row['length']} chars · {row['words']} words"
                    if compute_kgr and row.get("competition"):
                        color = keywords.grade_color(row["grade"])
                        meta += (
                            f"  ·  <span style='color:{color}'>● {row['grade']}</span> "
                            f"({row['score']:.0f}/100)  ·  comp {row['competition']:,}"
                        )
                    st.caption(meta, unsafe_allow_html=True)
                with cB:
                    if compute_kgr and row.get("competition"):
                        st.metric(t("kw_competition"), f"{row['competition']:,}")
                with cC:
                    st.button(
                        t("send_to_studio"),
                        key=f"sts_{row['keyword']}",
                        use_container_width=True,
                        on_click=_send_to_studio,
                        args=(row["keyword"],),
                    )

        with st.expander(f"📋 All {len(df)} suggestions (table)", expanded=False):
            st.dataframe(df, use_container_width=True, hide_index=True)
            st.download_button(
                "⬇ Download CSV",
                df.to_csv(index=False).encode("utf-8"),
                file_name=f"keywords_{seed.replace(' ', '_')}.csv",
            )

        # ── Question buckets ───────────────────────────────────────────────
        st.subheader("❓  " + t("kw_question_buckets"))
        buckets = keywords.question_buckets(seed, hl=hl, gl=gl, lang=get_lang())
        if not buckets:
            st.caption("—")
        else:
            for prefix, sugg in buckets.items():
                with st.expander(f"**{prefix}** ({len(sugg)})", expanded=False):
                    for kw in sugg:
                        cA, cB = st.columns([6, 1])
                        cA.markdown(f"- {kw}")
                        if cB.button(t("send_to_studio"), key=f"q_{prefix}_{kw}"):
                            _send_to_studio(kw)


# ============================================================================
# TAB B — Niche analysis
# ============================================================================
with tab_niche:
    timeframe = st.selectbox(
        t("niche_trend_window"),
        ["now 7-d", "today 1-m", "today 3-m", "today 12-m"],
        index=2,
        key="niche_timeframe",
    )

    # ── Trend signal (Google Trends) ───────────────────────────────────────
    st.subheader("📈  " + t("niche_trend_signal"))
    try:
        trend_df = trends.interest_over_time([seed], geo=gl, timeframe=timeframe)
        related = trends.related_queries(seed, geo=gl, timeframe=timeframe)
    except Exception as e:
        st.warning(f"Trends unavailable: {e}")
        trend_df, related = pd.DataFrame(), {}

    if not trend_df.empty:
        fig = px.area(
            trend_df.reset_index(),
            x="date",
            y=seed,
            title=f'Interest in "{seed}" ({gl})',
        )
        st.plotly_chart(fig, use_container_width=True)
        avg = float(trend_df[seed].mean())
        peak = float(trend_df[seed].max())
        last = float(trend_df[seed].tail(7).mean()) if len(trend_df) >= 7 else avg
        m1, m2, m3 = st.columns(3)
        m1.metric("Avg interest", f"{avg:.0f}")
        m2.metric("Peak", f"{peak:.0f}")
        m3.metric("Last 7-pt avg", f"{last:.0f}", f"{(last - avg):+.1f}")
    else:
        avg = peak = last = 0.0
        st.info(t("niche_no_trend_data"))

    t1, t2 = st.columns(2)
    with t1:
        st.markdown("**Top related**")
        top = related.get("top")
        if top is not None and not top.empty:
            st.dataframe(top, hide_index=True, use_container_width=True)
        else:
            st.caption("—")
    with t2:
        st.markdown("**Rising 🚀**")
        rising = related.get("rising")
        if rising is not None and not rising.empty:
            st.dataframe(rising, hide_index=True, use_container_width=True)
        else:
            st.caption("—")

    # ── YouTube niche metrics ──────────────────────────────────────────────
    top_videos: list[dict] = []
    channel_rows: list[dict] = []
    total_competition = 0
    recent_uploads = 0
    top_video_views = 0
    hydrated: list[dict] = []

    try:
        raw_search = yt.search_raw(seed, max_results=25, region=gl, order="viewCount")
        top_videos = raw_search.get("items", [])
        total_competition = int(raw_search.get("pageInfo", {}).get("totalResults", 0))
    except Exception as e:
        st.warning(f"YouTube search failed (need YOUTUBE_API_KEY?): {e}")

    try:
        recent_uploads = yt.recent_uploads_count(seed, region=gl, days=14)
    except Exception:
        recent_uploads = 0

    # Trend Pulse 7d
    try:
        pulse = yt.trend_pulse(seed, region=gl)
    except Exception:
        pulse = None

    if pulse:
        pulse_color = {
            "hot": "#ef4444",
            "cooling": "#3b82f6",
            "stable": "#a78bfa",
        }[pulse["status"]]
        pulse_label = t(f"pulse_{pulse['status']}")
        st.markdown(
            f"""
            <div class="glass-block" style="margin: 14px 0; padding:16px 22px;
                        background:{pulse_color}14; border:1px solid {pulse_color}55;
                        display:flex; gap:24px; align-items:center; flex-wrap:wrap;">
                <div style="font-size:1.4rem; font-weight:700; color:{pulse_color};">
                    {pulse_label}
                </div>
                <div style="display:flex; gap:32px; opacity:.85; flex-wrap:wrap;">
                    <div><div style="font-size:.7rem; letter-spacing:.16em; color:#a78bfa;">{t("pulse_title").upper()}</div>
                         <div style="font-weight:600;">{pulse["recent_7d"]:,} <span style="opacity:.6;">/ {pulse["prior_7d"]:,} prior</span></div></div>
                    <div><div style="font-size:.7rem; letter-spacing:.16em; color:#a78bfa;">{t("pulse_growth").upper()}</div>
                         <div style="font-weight:600; color:{pulse_color};">{pulse["growth_pct"]:+.0f}%</div></div>
                </div>
            </div>
            """,
            unsafe_allow_html=True,
        )

    if top_videos:
        try:
            ids = [
                v["id"]["videoId"]
                for v in top_videos
                if v.get("id", {}).get("videoId")
            ]
            hydrated = yt.videos_details(ids[:25])
        except Exception:
            hydrated = []

        if hydrated:
            try:
                top_video_views = int(hydrated[0].get("statistics", {}).get("viewCount", 0))
            except (TypeError, ValueError):
                top_video_views = 0

        score, grade = yt.opportunity_score(
            recent_uploads=recent_uploads,
            top_video_views=top_video_views,
            total_competition=total_competition,
        )
        color = {"high": "#22c55e", "medium": "#f59e0b", "low": "#ef4444"}[grade]

        st.subheader("📊  " + t("niche_metrics"))
        m1, m2, m3 = st.columns(3)
        m1.markdown(
            f"""
            <div class="glass-block" style="padding:14px 18px;
                        background:{color}1a; border:1px solid {color}55;">
              <div style="color:#a78bfa; font-size:0.75rem; letter-spacing:.18em;">{t("niche_opportunity").upper()}</div>
              <div style="color:{color}; font-size:1.8rem; font-weight:700;">{score}/100</div>
              <div style="color:#f5f3ff; opacity:.7; font-size:0.8rem;">{grade}</div>
            </div>
            """,
            unsafe_allow_html=True,
        )
        m2.metric(t("niche_recent_uploads"), f"{recent_uploads:,}")
        m3.metric(t("niche_competition"), humanize_int(total_competition))

        # Outlier (breakout) detection
        breakouts = yt.detect_outliers(hydrated, multiplier=2.5) if hydrated else []
        st.markdown("**🚀  " + t("niche_breakouts") + "**")
        if breakouts:
            rows = []
            for v in breakouts[:8]:
                sn = v["snippet"]
                stats = v.get("statistics", {})
                rows.append({
                    "title": sn["title"][:80],
                    "channel": sn["channelTitle"],
                    "views": humanize_int(int(stats.get("viewCount", 0))),
                    "× median": f"{v['_view_ratio']:.1f}×",
                    "url": f"https://youtube.com/watch?v={v['id']}",
                })
            bdf = pd.DataFrame(rows)
            st.dataframe(
                bdf,
                hide_index=True,
                use_container_width=True,
                column_config={"url": st.column_config.LinkColumn("URL")},
            )
        else:
            st.caption(t("niche_no_breakouts"))

        # Top channels
        channel_ids = list({v["snippet"]["channelId"] for v in top_videos})[:20]
        try:
            channels = yt.channel_details(channel_ids)
        except Exception as e:
            channels = []
            st.warning(f"Channel lookup failed: {e}")

        for ch in channels:
            sn, stats = ch["snippet"], ch.get("statistics", {})
            channel_rows.append({
                "channel": sn["title"],
                "subs": int(stats.get("subscriberCount", 0)),
                "views": int(stats.get("viewCount", 0)),
                "videos": int(stats.get("videoCount", 0)),
                "url": f"https://youtube.com/channel/{ch['id']}",
            })

        if channel_rows:
            st.markdown("**🎬  " + t("niche_top_channels") + "**")
            ch_df = (
                pd.DataFrame(channel_rows)
                .sort_values("subs", ascending=False)
                .head(10)
            )
            ch_df["subs_h"] = ch_df["subs"].apply(humanize_int)
            ch_df["views_h"] = ch_df["views"].apply(humanize_int)
            st.dataframe(
                ch_df[["channel", "subs_h", "views_h", "videos", "url"]].rename(
                    columns={"subs_h": "subs", "views_h": "total views"}
                ),
                hide_index=True,
                use_container_width=True,
                column_config={"url": st.column_config.LinkColumn("URL")},
            )

    # ── Audience pulse (sentiment on the top video) ───────────────────────
    sentiment_breakdown: dict[str, int] = {}
    sample_quotes: list[str] = []
    top_video = top_videos[0] if top_videos else None
    if top_video:
        gradient_divider()
        st.subheader("💬  " + t("niche_audience_pulse"))
        vid = top_video["id"]["videoId"]
        title = top_video["snippet"]["title"]
        st.caption(f"Sampling top video: **{title}** ({vid})")
        try:
            cmts = comments.fetch_comments(vid, limit=150)
        except Exception as e:
            cmts = []
            st.caption(f"Comment fetch unavailable: {e}")

        if cmts:
            try:
                from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

                an = SentimentIntensityAnalyzer()
                cdf = pd.DataFrame(cmts)[["author", "text", "votes"]]
                cdf["votes_n"] = cdf["votes"].apply(parse_count)
                cdf["compound"] = cdf["text"].apply(
                    lambda x: an.polarity_scores(x)["compound"]
                )
                cdf["sentiment"] = pd.cut(
                    cdf["compound"],
                    bins=[-1.01, -0.05, 0.05, 1.01],
                    labels=["negative", "neutral", "positive"],
                )
                sentiment_breakdown = cdf["sentiment"].value_counts().to_dict()
                counts = cdf["sentiment"].value_counts().reset_index()
                counts.columns = ["sentiment", "count"]
                fig = px.pie(
                    counts,
                    names="sentiment",
                    values="count",
                    hole=0.55,
                    color_discrete_sequence=["#22c55e", "#a78bfa", "#ef4444"],
                )
                cL, cR = st.columns([1, 1])
                with cL:
                    st.plotly_chart(fig, use_container_width=True)
                with cR:
                    st.markdown("**Top comments**")
                    top_cmts = cdf.sort_values("votes_n", ascending=False).head(5)
                    for _, row in top_cmts.iterrows():
                        st.caption(f"💬 *{row['author']}* — {row['text'][:200]}")
                    sample_quotes = top_cmts["text"].tolist()
            except Exception as e:
                st.caption(f"Sentiment failed: {e}")

    # ── AI verdict ─────────────────────────────────────────────────────────
    gradient_divider()
    st.subheader("🧠  " + t("niche_ai_verdict"))

    # Compute long-tail context (re-use suggestions from tab if cached)
    try:
        suggestions_for_ai = autocomplete.suggest(seed, hl=hl, gl=gl)
    except Exception:
        suggestions_for_ai = []

    try:
        sys = (
            "You are a YouTube niche analyst. Given trend, keyword, channel, and audience"
            " data, decide whether this niche is worth pursuing. Output JSON with shape:"
            ' {"verdict":"hot|warm|cold","score":0-100,"competition":"low|medium|high",'
            '"opportunities":[str],"risks":[str],"content_gaps":[str],"summary":str}.'
            f" Write the summary, opportunities, risks and content_gaps in {language_label()}."
        )
        payload = {
            "seed": seed,
            "region": gl,
            "trend_avg": avg,
            "trend_peak": peak,
            "trend_recent": last,
            "long_tail_count": len(suggestions_for_ai),
            "long_tail_sample": suggestions_for_ai[:10],
            "channels_top10": channel_rows[:10] if channel_rows else [],
            "audience_sentiment_breakdown": sentiment_breakdown,
            "audience_sample_comments": sample_quotes[:5],
            "recent_uploads_14d": recent_uploads,
            "total_competition": total_competition,
        }
        with st.spinner("DeepSeek analysing…"):
            raw = llm.chat_json(json.dumps(payload, default=str), system=sys)
            data = json.loads(raw)

        verdict = (data.get("verdict") or "warm").lower()
        score = int(data.get("score", 50))
        comp = data.get("competition", "?")
        color = {"hot": "#22c55e", "warm": "#f59e0b", "cold": "#ef4444"}.get(
            verdict, "#a78bfa"
        )
        st.markdown(
            f"""
            <div style="display:flex; align-items:center; gap:18px; margin: 6px 0 18px; flex-wrap:wrap;">
                <div style="font-size:1.05rem; padding:6px 14px; border-radius:999px;
                            background:{color}22; color:{color}; font-weight:700; letter-spacing:0.18em;">
                    {verdict.upper()} · {score}/100
                </div>
                <div class="muted">{t("niche_competition")}: <b style="color:#f5f3ff">{comp}</b></div>
            </div>
            """,
            unsafe_allow_html=True,
        )
        st.markdown(data.get("summary", ""))
        o, r, g = st.columns(3)
        with o:
            st.markdown("**🚀 Opportunities**")
            for x in data.get("opportunities", []):
                st.markdown(f"- {x}")
        with r:
            st.markdown("**⚠ Risks**")
            for x in data.get("risks", []):
                st.markdown(f"- {x}")
        with g:
            st.markdown("**🎯 Content gaps**")
            for x in data.get("content_gaps", []):
                st.markdown(f"- {x}")

        gradient_divider()
        st.button(
            f"🎬  {t('use_this_keyword')} ({seed})",
            type="primary",
            key="send_seed_to_studio",
            on_click=_send_to_studio,
            args=(seed,),
        )
    except Exception as e:
        if not _missing_deepseek_render(e):
            st.warning(f"AI verdict failed: {e}")
