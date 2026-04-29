"""Video Cloner — reverse-engineer a competitor video into a reusable kit.

Input: a YouTube URL.
Output: fingerprint + hook & structure analysis + N title clones + full
script clone + thumbnail copy suggestions, in the **language of the source
video** (auto-detected from the transcript). The user can override.

Each title clone has a "→ Send to Studio" button that drops it into the
5-step Studio wizard.
"""
from __future__ import annotations

import json

import streamlit as st

from core import lang_detect, llm, transcript, youtube as yt
from core.i18n import LANG_FULL_NAME, language_label, language_selector, t
from core.theme import inject, page_header
from core.utils import engagement_rate, humanize_int, parse_iso_duration

st.set_page_config(page_title="Video Cloner · Tube Atlas", page_icon="▶", layout="wide")
inject()
language_selector()

page_header(
    eyebrow="02 · " + t("section_research"),
    title="▶  " + t("cloner_name"),
    subtitle=t("cloner_desc"),
)

if st.session_state.pop("_goto_studio", False):
    st.switch_page("pages/04_Studio.py")

# Outlier Finder hands off the video URL via cloner_url_in.
_url_prefill = st.session_state.pop("cloner_url_in", "")


def _send_title_to_studio(value: str) -> None:
    st.session_state["studio_title_in"] = value
    st.session_state["_goto_studio"] = True


def _send_topic_to_studio(value: str) -> None:
    st.session_state["studio_topic_in"] = value
    st.session_state["_goto_studio"] = True


def _missing_key_render(exc: Exception) -> bool:
    if isinstance(exc, RuntimeError) and llm.ERR_NO_DEEPSEEK_KEY in str(exc):
        st.error(t("err_missing_deepseek"))
        return True
    return False


with st.form("clone"):
    url = st.text_input(
        "YouTube video URL",
        value=_url_prefill,
        placeholder="https://www.youtube.com/watch?v=…",
    )
    new_topic = st.text_input(
        "New topic for the clone (optional)",
        placeholder="leave empty to keep the same topic, or e.g. 'protein for cyclists'",
    )
    c1, c2 = st.columns(2)
    with c1:
        n_titles = st.slider("# of title clones", 5, 20, 10)
    with c2:
        override_options = [("auto", t("cloner_lang_auto"))] + [
            (code, name) for code, name in LANG_FULL_NAME.items()
        ]
        override_idx = st.selectbox(
            t("cloner_override_lang"),
            range(len(override_options)),
            format_func=lambda i: override_options[i][1],
            index=0,
        )
        override_code = override_options[override_idx][0]
    run = st.form_submit_button("Clone this video", type="primary")

if not (run and url.strip()):
    st.stop()

# ─── Fingerprint ──────────────────────────────────────────────────────────────
try:
    vid = yt.parse_video_id(url.strip())
    items = yt.videos_details([vid])
except Exception as e:
    st.error(f"YouTube lookup failed (need YOUTUBE_API_KEY?): {e}")
    st.stop()
if not items:
    st.error("Video not found.")
    st.stop()

v = items[0]
sn, stats, cd = v["snippet"], v.get("statistics", {}), v["contentDetails"]
views = int(stats.get("viewCount", 0))
likes = int(stats.get("likeCount", 0))
n_comments = int(stats.get("commentCount", 0))
duration = parse_iso_duration(cd["duration"])

st.subheader("🔍  Video fingerprint")
col_thumb, col_meta = st.columns([1, 2])
with col_thumb:
    thumb = sn["thumbnails"].get("maxres") or sn["thumbnails"].get("high") or sn["thumbnails"].get("default")
    if thumb:
        st.image(thumb["url"])
with col_meta:
    st.markdown(f"### {sn['title']}")
    st.caption(f"📺 {sn['channelTitle']} · ⏱ {duration} · 📅 {sn['publishedAt'][:10]}")
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Views", humanize_int(views))
    m2.metric("Likes", humanize_int(likes))
    m3.metric("Comments", humanize_int(n_comments))
    m4.metric("Engagement", f"{engagement_rate(views, likes, n_comments):.2f}%")

tags = sn.get("tags", [])
if tags:
    with st.expander(f"🏷 Tags ({len(tags)})"):
        st.write(" · ".join(f"`{t_}`" for t_ in tags))

# ─── Transcript + language detect ─────────────────────────────────────────────
st.subheader("📜  Transcript & hook analysis")
try:
    segments = transcript.fetch_transcript(vid, languages=["en", "ko", "ja", "vi"])
    full_text = transcript.transcript_to_text(segments)
except Exception as e:
    segments, full_text = [], ""
    st.warning(f"Transcript unavailable: {e}")

if not full_text:
    st.info("No transcript available — title-only clone will be generated.")

# Auto-detect language from transcript (fallback to title if empty).
detected = lang_detect.detect_lang(full_text or sn["title"])
if override_code == "auto":
    out_code = detected
else:
    out_code = override_code  # type: ignore[assignment]

c1, c2 = st.columns(2)
c1.metric(t("cloner_detected_lang"), LANG_FULL_NAME[detected])
c2.metric("Output language", LANG_FULL_NAME[out_code])

lang_label_str = language_label(out_code)
clipped = full_text[:8000]

# ─── DeepSeek clone kit ───────────────────────────────────────────────────────
sys = (
    "You are a YouTube clone-engineer. Given a video's title, stats and"
    " transcript, output a complete remake kit in JSON with this exact"
    " shape:\n"
    '{"hook_analysis": str (markdown, analyse the first 0-15 seconds, the'
    " emotional triggers used, pacing, and the structural beats of the"
    ' rest of the video, with timestamps when possible),\n'
    ' "title_clones": [str] (titles that follow the same formula but use'
    " the new topic; respect the original language style),\n"
    ' "script": str (markdown, full script of a similar video on the new'
    " topic, ~600-900 words, structured as Hook · Body · CTA, with section"
    ' headers; should mirror the original\'s pacing and tone),\n'
    ' "thumbnail_copy": [str] (5 short text overlays for the thumbnail,'
    " ≤6 words each, high-impact),\n"
    ' "tags": [str] (12 SEO tags relevant to the new topic)\n'
    "}.\n"
    f"Write hook_analysis, script, title_clones, thumbnail_copy and tags in {lang_label_str}."
)

prompt_payload = {
    "original_title": sn["title"],
    "channel": sn["channelTitle"],
    "duration_sec": int(duration.total_seconds()),
    "views": views,
    "likes": likes,
    "tags": tags[:20],
    "transcript": clipped,
    "new_topic": new_topic.strip() or "(keep the same topic, just rephrase)",
    "n_title_clones": n_titles,
}

with st.spinner("DeepSeek cloning…"):
    try:
        raw = llm.chat_json(json.dumps(prompt_payload, ensure_ascii=False), system=sys)
        kit = json.loads(raw)
    except Exception as e:
        if not _missing_key_render(e):
            st.error(f"Clone kit failed: {e}")
        st.stop()

# Persist a slim "style kit" so the Producer page (PR-A3) can import the
# cloned visual style. We deliberately store only fields useful for prompt
# generation — no transcript, no duplicate of raw kit data.
st.session_state["cloner_style_kit"] = {
    "source_title": sn["title"],
    "source_channel": sn["channelTitle"],
    "language": out_code,
    "hook_analysis": kit.get("hook_analysis", ""),
    "tags": list(kit.get("tags", []) or []),
    "thumbnail_copy": list(kit.get("thumbnail_copy", []) or []),
}

# Hook
st.markdown(kit.get("hook_analysis", ""))

# Title clones — each row gets a "Send to Studio" button.
st.subheader("🎯  Title clones")
titles = kit.get("title_clones", [])[:n_titles]
for i, ttl in enumerate(titles, 1):
    with st.container(border=True):
        cA, cB = st.columns([5, 1])
        with cA:
            st.markdown(f"**{i:02d}.** {ttl}")
            st.caption(f"📏 {len(ttl)} chars")
        with cB:
            st.button(
                t("send_to_studio"),
                key=f"clone_sts_{i}",
                use_container_width=True,
                on_click=_send_title_to_studio,
                args=(ttl,),
            )

# Script
st.subheader("📝  Cloned script")
st.markdown(kit.get("script", ""))
st.download_button(
    "⬇ Download script (.md)",
    (kit.get("script") or "").encode("utf-8"),
    file_name=f"clone_{vid}.md",
)

# Thumbnail copy
st.subheader("🖼  Thumbnail copy ideas")
for line in kit.get("thumbnail_copy", []):
    st.markdown(f"- **{line}**")

# Tags
tags_out = kit.get("tags", [])
if tags_out:
    st.subheader("🏷  Suggested tags")
    st.write(" · ".join(f"`{t_}`" for t_ in tags_out))

# Pipeline handoff at the bottom: send the *new topic* (or original title) to Studio.
st.markdown("---")
handoff_seed = new_topic.strip() or sn["title"]
st.button(
    f"🎬  {t('use_this_topic')} — {handoff_seed[:60]}",
    type="primary",
    key="clone_handoff_topic",
    on_click=_send_topic_to_studio,
    args=(handoff_seed,),
)
