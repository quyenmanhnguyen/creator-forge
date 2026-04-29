"""Producer — turn a Studio script into a 9:16 short with voice + captions.

PR-A2 shipped placeholder visuals (gradient + Ken Burns). PR-A3 layered
on a **prompt generator + provider abstraction**. PR-A3.1 wired the
ComfyUI local provider for per-scene image generation.

PR-A4.1 adds a second mode: **Long-form scene breakdown**. Instead of
rendering a 45 s short, the page expands a long ``script_final.md`` into
``N`` standalone scenes — each with an ultra-detailed image prompt and a
3–4 sentence flow video prompt — paste-ready for AutoGrok, grok.com web,
Veo 3, Whisk, etc. Image / video generation is deferred to PR-A4.2 (Grok
image) and PR-A5 (Veo 3 video).

Mode picker:

- ``short`` (default) — PR-A2/A3/A3.1 flow: TTS → captions → composite
  9:16 mp4 with optional ComfyUI scene images.
- ``long_form`` — PR-A4.1 flow: pick a template + scene count → call LLM
  → render a per-scene table + downloads (``.md`` and ``.json``).
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

import streamlit as st

from core.i18n import language_selector, t
from core.pixelle import (
    ComfyUIVisualProvider,
    ComposerOptions,
    EdgeTTSAdapter,
    GrokImageProvider,
    PRESET_NAMES,
    PixelleConfig,
    SCENE_TEMPLATES,
    STYLES,
    TEMPLATE_KEYS,
    LongFormScene,
    SceneAsset,
    ScenePrompt,
    SceneTemplate,
    StyleSource,
    UsePlaceholderFallback,
    VideoSceneAsset,
    VisualProvider,
    build_scene_prompts,
    build_thumbnail_prompt,
    count_words,
    estimate_scene_count,
    estimate_total_duration_s,
    fallback_captions_from_text,
    from_cloner_kit,
    from_manual_reference,
    from_preset,
    generate_scene_breakdown,
    get_provider,
    group_word_boundaries,
    list_provider_specs,
    load_config,
    make_custom_template,
    make_short,
    serialize_breakdown_json,
    serialize_breakdown_md,
)
from core.pixelle.voices import VOICES, voice_by_short_name, voice_labels, voice_short_names
from core.theme import inject, page_header

st.set_page_config(page_title="Producer · Tube Atlas", page_icon="🎞️", layout="wide")
inject()
language_selector()

page_header(
    eyebrow="05 · " + t("section_create"),
    title="🎞️  " + t("producer_name"),
    subtitle=t("producer_desc"),
)

CFG = load_config()


# ─── Credentials dialog (PR-A4.2) ────────────────────────────────────────────
def _save_env_var(key: str, value: str) -> None:
    """Append/update ``key=value`` in the project's ``.env`` file.

    The .env file lives at the repo root (parent of ``pages/``). We
    rewrite the file in-place so subsequent Streamlit reruns pick the
    new value up via ``python-dotenv``. The function is intentionally
    naïve — for a single-user dev tool, atomic rename + lock are
    overkill; we only ever write small strings.
    """
    env_path = Path(__file__).resolve().parent.parent / ".env"
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    rendered = f"{key}={value}"
    for i, line in enumerate(lines):
        if line.startswith(f"{key}="):
            lines[i] = rendered
            env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return
    lines.append(rendered)
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _ensure_credentials() -> None:
    """Surface a credential-input panel for any missing auth.

    PR-A4.2 introduces a Playwright-driven Grok login that captures a
    session into ``st.session_state["grok_session"]``. The DeepSeek
    API key — needed for scene-prompt generation and long-form
    breakdowns — is collected via the same panel and persisted to
    the project's ``.env`` so future runs don't re-prompt.

    The panel is *informational* — it does not stop the page. Users
    can still run the gradient placeholder pipeline (no Grok / no
    DeepSeek) without entering anything. Real generation paths check
    ``is_configured()`` and degrade to placeholder if the panel was
    skipped.
    """
    grok_session = st.session_state.get("grok_session")
    deepseek_set = bool(os.getenv("DEEPSEEK_API_KEY"))
    if grok_session and deepseek_set:
        return

    with st.expander("⚠️  " + t("producer_missing_credentials"), expanded=False):
        st.caption(t("producer_missing_credentials_help"))

        if not grok_session:
            st.markdown(f"**{t('producer_grok_cookie_label')}**")
            st.caption("Email + password — used once to log into grok.com via Playwright. Nothing is persisted to disk.")
            col1, col2 = st.columns(2)
            with col1:
                grok_email = st.text_input(
                    "Email",
                    key="producer_grok_email_input",
                )
            with col2:
                grok_pass = st.text_input(
                    "Password",
                    type="password",
                    key="producer_grok_pass_input",
                )
            if st.button("🔐 Login to Grok", key="producer_grok_login_btn"):
                if not grok_email or not grok_pass:
                    st.error("Email and password are both required.")
                else:
                    with st.spinner("Logging in via Playwright (~30s)…"):
                        try:
                            from core.pixelle.grok_browser import (
                                GrokBrowserError,
                                grok_browser_login,
                            )

                            session = grok_browser_login(grok_email, grok_pass)
                        except GrokBrowserError as exc:
                            st.error(f"Login failed: {exc}")
                        except Exception as exc:  # noqa: BLE001
                            st.error(f"{type(exc).__name__}: {exc}")
                        else:
                            st.session_state["grok_session"] = session
                            st.success(t("producer_credentials_saved"))
                            st.rerun()

        if not deepseek_set:
            st.markdown(f"**{t('producer_deepseek_label')}**")
            st.caption(t("producer_deepseek_help"))
            ds_key = st.text_input(
                t("producer_deepseek_label"),
                type="password",
                key="producer_ds_key_input",
                label_visibility="collapsed",
            )
            if st.button(
                t("producer_credentials_save"),
                key="producer_ds_save_btn",
            ):
                if ds_key.strip():
                    _save_env_var("DEEPSEEK_API_KEY", ds_key.strip())
                    os.environ["DEEPSEEK_API_KEY"] = ds_key.strip()
                    st.success(t("producer_credentials_saved"))
                    st.rerun()


_ensure_credentials()


# ─── Cross-page handoff: prefill from Studio output ──────────────────────────
def _initial_script() -> str:
    """Pull a script from Studio's session state if present, else empty.

    Studio writes its final humanized rewrite into ``studio.script_final``;
    if absent we fall back to ``studio.script`` (raw long-form draft) or
    a one-shot handoff key ``producer_script_in``.
    """
    handoff = st.session_state.pop("producer_script_in", None)
    if handoff:
        return handoff
    studio = st.session_state.get("studio") or {}
    return studio.get("script_final") or studio.get("script") or ""


# ─── Provider status pane ────────────────────────────────────────────────────
with st.expander("⚙️ " + t("producer_status"), expanded=False):
    summary = CFG.describe()
    st.json(summary, expanded=False)


# ─── Long-form scene-breakdown mode (PR-A4.1) ───────────────────────────────
def _resolve_long_form_script() -> str:
    """Pick the long-form script body from one of three sources.

    1. ``Studio`` — pulled from ``st.session_state["studio"]["script_final"]``
       (the same handoff the short mode uses for prefilling).
    2. ``Upload`` — ``.md`` / ``.txt`` via :func:`st.file_uploader`.
    3. ``Paste`` — free-form textarea (default for fresh sessions).

    Returns the raw body text. The caller decides what to do if empty.
    """
    studio = st.session_state.get("studio") or {}
    has_studio_script = bool(studio.get("script_final"))
    options = (
        ["studio", "upload", "paste"] if has_studio_script else ["upload", "paste"]
    )
    label = {
        "studio": t("producer_lf_source_studio"),
        "upload": t("producer_lf_source_upload"),
        "paste": t("producer_lf_source_paste"),
    }
    pick = st.radio(
        t("producer_lf_source"),
        options=options,
        format_func=lambda v: label.get(v, v),
        horizontal=True,
        key="producer_lf_source_pick",
    )
    if pick == "studio":
        return str(studio.get("script_final") or "")
    if pick == "upload":
        upload = st.file_uploader(
            t("producer_lf_upload"),
            type=["md", "txt"],
            key="producer_lf_upload_input",
        )
        if upload is None:
            return ""
        try:
            return upload.read().decode("utf-8", errors="replace")
        except (OSError, UnicodeDecodeError):
            return ""
    return st.text_area(
        t("producer_script"),
        value=st.session_state.get("producer_lf_paste_text", ""),
        height=320,
        placeholder="Paste a long-form script (any length)…",
        key="producer_lf_paste_text",
    )


def _resolve_template() -> SceneTemplate:
    """Pick a built-in template or build a custom one from inline inputs."""
    keys = TEMPLATE_KEYS
    labels = {k: SCENE_TEMPLATES[k].label for k in keys}
    pick = st.selectbox(
        t("producer_lf_template"),
        options=keys,
        format_func=lambda k: labels.get(k, k),
        index=keys.index("factory") if "factory" in keys else 0,
        key="producer_lf_template_pick",
    )
    st.caption(t("producer_lf_template_hint"))
    base = SCENE_TEMPLATES[pick]
    if pick != "custom":
        st.caption(base.description)
        return base
    style_tag = st.text_input(
        t("producer_lf_template_custom_style"),
        value=st.session_state.get(
            "producer_lf_custom_style",
            "ultra-realistic, cinematic, high-detail 4K, documentary style",
        ),
        key="producer_lf_custom_style",
    )
    camera = st.text_input(
        t("producer_lf_template_custom_camera"),
        value=st.session_state.get(
            "producer_lf_custom_camera",
            "tracking shot, dolly push, smooth motion",
        ),
        key="producer_lf_custom_camera",
    )
    process = st.text_area(
        t("producer_lf_template_custom_process"),
        value=st.session_state.get("producer_lf_custom_process", ""),
        height=80,
        placeholder="(optional) extra rules every scene must follow",
        key="producer_lf_custom_process",
    )
    return make_custom_template(
        image_style_tag=style_tag,
        camera_hints=camera,
        process_notes=process,
    )


def _render_long_form_mode() -> None:
    """Long-form pipeline: script → LLM-driven scene breakdown table."""
    st.subheader("📝 " + t("producer_lf_section"))
    script_lf = _resolve_long_form_script()

    template = _resolve_template()

    words = count_words(script_lf)
    auto_n_scenes = estimate_scene_count(script_lf) if words else 0
    col_a, col_b, col_c = st.columns(3, gap="medium")
    with col_a:
        wpm = st.slider(
            t("producer_lf_wpm"),
            min_value=90,
            max_value=200,
            value=int(st.session_state.get("producer_lf_wpm", 150)),
            step=5,
            key="producer_lf_wpm",
        )
    with col_b:
        n_scenes = st.slider(
            t("producer_lf_n_scenes"),
            min_value=3,
            max_value=60,
            value=max(3, auto_n_scenes or 8),
            step=1,
            key="producer_lf_n_scenes",
        )
    with col_c:
        thumbnail_title = st.text_input(
            t("producer_lf_thumbnail_title"),
            value=st.session_state.get("producer_lf_thumbnail_title", ""),
            placeholder="Title for thumbnail prompt…",
            key="producer_lf_thumbnail_title",
        )

    if words:
        minutes = round(estimate_total_duration_s(script_lf, words_per_minute=wpm) / 60.0, 1)
        st.caption(
            t("producer_lf_stats").format(
                words=words, minutes=minutes, wpm=wpm, n_scenes=n_scenes
            )
        )

    run_lf = st.button(
        t("producer_lf_run"),
        type="primary",
        use_container_width=True,
        key="producer_lf_run_btn",
    )

    if run_lf:
        if not script_lf.strip():
            st.warning(t("producer_lf_no_script"))
        else:
            with st.spinner(t("producer_lf_running")):
                try:
                    scenes = generate_scene_breakdown(
                        script_lf,
                        template=template,
                        n_scenes=n_scenes,
                        words_per_minute=wpm,
                    )
                except Exception as exc:  # noqa: BLE001 — surface to user
                    st.error(f"{type(exc).__name__}: {exc}")
                    scenes = []
            st.session_state["producer_lf_scenes"] = [s.to_json() for s in scenes]
            st.session_state["producer_lf_template_key"] = template.key
            st.session_state["producer_lf_thumbnail_used_title"] = thumbnail_title
            if not scenes:
                st.warning(t("producer_lf_no_scenes"))

    cached = st.session_state.get("producer_lf_scenes") or []
    if cached:
        st.success(t("producer_lf_result_count").format(n=len(cached)))
        st.caption(t("producer_lf_table_caption"))
        for s in cached:
            with st.expander(
                f"Scene {s['scene_id']} · {s['title']}  ·  ~{s['duration_s']:.1f}s",
                expanded=False,
            ):
                st.markdown("**Narration**")
                st.code(s["narration"], language="markdown")
                st.markdown("**Image prompt**")
                st.code(s["image_prompt"], language="markdown")
                st.markdown("**Flow video prompt**")
                st.code(s["flow_video_prompt"], language="markdown")
        used_template = SCENE_TEMPLATES.get(
            st.session_state.get("producer_lf_template_key", "factory"),
            SCENE_TEMPLATES["factory"],
        )
        scene_objs = [LongFormScene(**s) for s in cached]
        md_blob = serialize_breakdown_md(
            scene_objs,
            title=thumbnail_title or "",
            template=used_template,
        )
        json_blob = json.dumps(
            serialize_breakdown_json(scene_objs), ensure_ascii=False, indent=2
        )

        col_md, col_json = st.columns(2)
        with col_md:
            st.download_button(
                t("producer_lf_download_md"),
                data=md_blob.encode("utf-8"),
                file_name="breakdown.md",
                mime="text/markdown",
                use_container_width=True,
                key="producer_lf_download_md_btn",
            )
        with col_json:
            st.download_button(
                t("producer_lf_download_json"),
                data=json_blob.encode("utf-8"),
                file_name="breakdown.json",
                mime="application/json",
                use_container_width=True,
                key="producer_lf_download_json_btn",
            )

        if thumbnail_title.strip():
            with st.expander(t("producer_lf_thumbnail"), expanded=False):
                thumb = build_thumbnail_prompt(thumbnail_title, used_template)
                st.code(thumb, language="markdown")


# ─── Mode picker ─────────────────────────────────────────────────────────────
mode = st.radio(
    t("producer_mode"),
    options=["short", "long_form"],
    format_func=lambda v: t(f"producer_mode_{v}"),
    horizontal=True,
    index=0,
    key="producer_mode_pick",
)

if mode == "long_form":
    _render_long_form_mode()
    st.stop()


# ─── Inputs (short mode) ─────────────────────────────────────────────────────
left, right = st.columns([3, 2], gap="large")

with left:
    script = st.text_area(
        t("producer_script"),
        value=_initial_script(),
        height=320,
        placeholder="Paste a script or run Studio first…",
        key="producer_script_text",
    )

with right:
    voice_options = voice_short_names()
    voice_label_lookup = dict(zip(voice_options, voice_labels(), strict=True))
    voice_short = st.selectbox(
        t("producer_voice"),
        options=voice_options,
        format_func=lambda sn: voice_label_lookup.get(sn, sn),
        index=0,
        key="producer_voice_pick",
    )

    style_name = st.selectbox(
        t("producer_style"),
        options=list(STYLES.keys()),
        index=0,
        key="producer_style_pick",
    )

    target_duration = st.slider(
        t("producer_duration"),
        min_value=15,
        max_value=90,
        value=45,
        step=5,
        key="producer_duration_pick",
    )

    run_clicked = st.button(t("producer_run"), type="primary", use_container_width=True)


# ─── Visual generation (PR-A3) ───────────────────────────────────────────────
def _resolve_style_source() -> StyleSource:
    """Pick a :class:`StyleSource` based on the user's UI choice.

    Three options surface depending on what's in session state:

    - ``video_clone`` — only when ``cloner_style_kit`` was set by
      :file:`pages/02_Video_Cloner.py`. Distilled via
      :func:`from_cloner_kit`.
    - ``manual`` — free-form reference text the user types in.
    - ``preset`` — picks one of :data:`PRESET_NAMES`.
    """
    sources: list[str] = []
    if isinstance(st.session_state.get("cloner_style_kit"), dict):
        sources.append("video_clone")
    sources.extend(["preset", "manual"])

    label = {
        "video_clone": t("producer_style_src_clone"),
        "preset": t("producer_style_src_preset"),
        "manual": t("producer_style_src_manual"),
    }
    pick = st.radio(
        t("producer_style_src"),
        options=sources,
        format_func=lambda v: label.get(v, v),
        horizontal=True,
        key="producer_style_src_pick",
    )
    if pick == "video_clone":
        kit = st.session_state.get("cloner_style_kit") or {}
        st.caption(
            t("producer_style_clone_hint").format(
                title=kit.get("source_title", "?")
            )
        )
        return from_cloner_kit(kit)
    if pick == "manual":
        ref = st.text_area(
            t("producer_style_manual_ref"),
            value=st.session_state.get("producer_style_manual_text", ""),
            placeholder="warm cinematic, golden hour, shallow DoF…",
            height=120,
            key="producer_style_manual_text",
        )
        return from_manual_reference(ref)
    preset_name = st.selectbox(
        t("producer_style_preset_pick"),
        options=PRESET_NAMES,
        index=0,
        key="producer_style_preset_pick_select",
    )
    return from_preset(preset_name)


def _provider_picker() -> VisualProvider:
    """Render the provider dropdown + status pill, return the instance.

    When ``comfyui_local`` is selected, an inline settings block surfaces
    workflow JSON / checkpoint / seed knobs that the provider needs.
    """
    specs = list_provider_specs()
    name_options = [s.name for s in specs]
    label_lookup = {s.name: s.label for s in specs}
    provider_name = st.selectbox(
        t("producer_provider_pick"),
        options=name_options,
        format_func=lambda n: label_lookup.get(n, n),
        index=0,
        key="producer_provider_pick_select",
    )

    if provider_name == "comfyui_local":
        provider: VisualProvider = _build_comfyui_provider()
    elif provider_name == "grok_image":
        # PR-A4.2/A5: inject the runtime session captured by the
        # credentials dialog (Playwright login). When no session is
        # present, the provider stays unconfigured and the run
        # pipeline falls back to the gradient placeholder. The video
        # mode picker (PR-A5) chooses image vs. video and Veo knobs.
        provider = _build_grok_provider()
    else:
        provider = get_provider(provider_name)

    if provider.is_configured():
        st.success(
            t("producer_provider_ok").format(label=provider.info.label)
        )
    else:
        st.warning(
            t("producer_provider_missing").format(
                label=provider.info.label,
                reason=provider.missing_reason(),
            )
        )
    if provider.info.notes:
        st.caption(provider.info.notes)
    return provider


def _build_comfyui_provider() -> ComfyUIVisualProvider:
    """Render ComfyUI-specific settings and return a configured provider."""
    with st.container():
        st.caption("⚙️ " + t("producer_comfy_settings"))
        url_default = CFG.comfy.local_url
        # The URL is read from config.load_config() inside the provider;
        # surfacing it here is read-only for visibility.
        st.text_input(
            t("producer_comfy_url"),
            value=url_default,
            disabled=True,
            key="producer_comfy_url_display",
        )
        workflow_str = st.text_input(
            t("producer_comfy_workflow"),
            value=st.session_state.get("producer_comfy_workflow", ""),
            placeholder="(blank = bundled default_txt2img.json)",
            key="producer_comfy_workflow_input",
        )
        checkpoint = st.text_input(
            t("producer_comfy_checkpoint"),
            value=st.session_state.get(
                "producer_comfy_checkpoint", "v1-5-pruned-emaonly.safetensors"
            ),
            key="producer_comfy_checkpoint_input",
        )
        seed_str = st.text_input(
            t("producer_comfy_seed"),
            value=st.session_state.get("producer_comfy_seed", ""),
            key="producer_comfy_seed_input",
        )

    workflow_path = Path(workflow_str).expanduser() if workflow_str.strip() else None
    seed: int | None
    try:
        seed = int(seed_str) if seed_str.strip() else None
    except ValueError:
        seed = None

    return ComfyUIVisualProvider(
        workflow_path=workflow_path,
        checkpoint=checkpoint or None,
        seed=seed,
    )


def _build_grok_provider() -> GrokImageProvider:
    """Render Grok-specific knobs and return a configured provider.

    PR-A5 introduces a *visual mode* picker — image (Aurora) vs.
    video (Veo 3) — plus Veo 3-only sliders for clip length and
    resolution. The picked values are surfaced in
    ``st.session_state["producer_grok_video_mode"]`` so the run
    pipeline knows whether to call ``generate_image`` or
    ``generate_video`` per scene.

    The session is read from ``st.session_state["grok_session"]`` —
    populated by the credentials dialog at the top of the page.
    """
    with st.container():
        st.caption("⚙️ " + t("producer_video_mode_label"))
        mode = st.radio(
            t("producer_video_mode_label"),
            options=("image", "video"),
            format_func=lambda key: t(f"producer_video_mode_{key}"),
            index=0,
            horizontal=True,
            key="producer_grok_video_mode_select",
            label_visibility="collapsed",
        )
        st.session_state["producer_grok_video_mode"] = mode

        video_length = 6
        resolution = "720p"
        if mode == "video":
            col1, col2 = st.columns(2)
            with col1:
                video_length = st.selectbox(
                    t("producer_video_length"),
                    options=(6, 10),
                    index=0,
                    key="producer_grok_video_length_select",
                )
            with col2:
                resolution = st.selectbox(
                    t("producer_video_resolution"),
                    options=("720p", "480p"),
                    index=0,
                    key="producer_grok_video_resolution_select",
                )

    grok_session = st.session_state.get("grok_session")
    return GrokImageProvider(
        session=grok_session,
        aspect_ratio="9:16",
        video_length=int(video_length),
        resolution=resolution,
    )


with st.expander("🎨 " + t("producer_visual_section"), expanded=False):
    style_source = _resolve_style_source()
    visual_provider = _provider_picker()
    if st.button(t("producer_build_prompts"), key="producer_build_prompts_btn"):
        if not script.strip():
            st.warning(t("producer_no_script"))
        else:
            st.session_state["producer_scene_prompts"] = [
                sp.to_json() for sp in build_scene_prompts(script, style_source)
            ]
    cached_prompts = st.session_state.get("producer_scene_prompts")
    if cached_prompts:
        st.caption(
            t("producer_scene_count").format(n=len(cached_prompts))
        )
        st.json(cached_prompts, expanded=False)
        st.download_button(
            t("producer_download_prompts"),
            data=json.dumps(cached_prompts, ensure_ascii=False, indent=2).encode("utf-8"),
            file_name="scene_prompts.json",
            mime="application/json",
            key="producer_download_prompts_btn",
        )


# ─── Pipeline ────────────────────────────────────────────────────────────────
def _run_pipeline(
    *,
    script: str,
    voice: str,
    style: str,
    target_duration_s: int,
    config: PixelleConfig,
    output_dir: Path,
    scene_assets: list[SceneAsset] | None = None,
) -> tuple[Path, str]:
    """Run TTS → captions → composite. Returns ``(mp4_path, caption_source_label)``."""
    output_dir.mkdir(parents=True, exist_ok=True)
    audio_path = output_dir / "voice.mp3"

    progress = st.progress(0, text=t("producer_step_tts"))
    adapter = EdgeTTSAdapter(rate=config.tts.rate, volume=config.tts.volume)
    tts_result = adapter.synthesize_with_timing(
        script, output_path=audio_path, voice=voice
    )
    progress.progress(40, text=t("producer_step_caps"))

    if tts_result.word_boundaries:
        captions = group_word_boundaries(tts_result.word_boundaries)
        caption_source = t("producer_caption_source_wb")
    else:
        captions = fallback_captions_from_text(
            script, audio_duration_s=tts_result.duration_seconds or float(target_duration_s)
        )
        caption_source = t("producer_caption_source_fb")

    progress.progress(60, text=t("producer_step_render"))
    mp4_path = output_dir / "short.mp4"
    options = ComposerOptions(style=style)
    make_short(
        audio_path,
        mp4_path,
        captions=captions,
        duration_hint=tts_result.duration_seconds or float(target_duration_s),
        options=options,
        scene_assets=scene_assets,
    )
    progress.progress(100, text=t("producer_done"))
    return mp4_path, caption_source


def _generate_scene_assets_via_comfyui(
    *,
    provider: ComfyUIVisualProvider,
    scene_prompts: list[ScenePrompt],
    audio_duration_s: float,
    output_dir: Path,
) -> list[SceneAsset] | None:
    """Drive ComfyUI per scene; return :class:`SceneAsset` list on success.

    Returns ``None`` (and surfaces a warning to the user) if any scene
    fails — the caller falls back to the gradient placeholder. We do
    all-or-nothing rather than mixing assets to keep the composer's
    timeline consistent.
    """
    base_url = CFG.comfy.local_url
    st.info(t("producer_comfy_probing").format(url=base_url))

    # Health check before kicking off TTS-heavy work would be ideal, but
    # the provider does its own probe inside generate_image. We still
    # do one here to give an early warning + skip the inevitable per-
    # scene retry storm if ComfyUI is down.
    from core.pixelle.comfy_client import is_local_alive

    if not is_local_alive(base_url):
        st.warning(t("producer_comfy_down").format(url=base_url))
        return None

    images_dir = output_dir / "scenes"
    images_dir.mkdir(parents=True, exist_ok=True)

    scene_progress = st.progress(0, text="")
    assets: list[SceneAsset] = []
    total_scene_seconds = sum(max(0.0, s.duration) for s in scene_prompts)
    if total_scene_seconds <= 0:
        return None
    # Scale scene durations so they cover the actual audio length.
    scale = audio_duration_s / total_scene_seconds if total_scene_seconds else 1.0
    cursor = 0.0

    for i, sp in enumerate(scene_prompts, start=1):
        scene_progress.progress(
            (i - 1) / max(1, len(scene_prompts)),
            text=t("producer_comfy_scene_step").format(i=i, n=len(scene_prompts)),
        )
        out_path = images_dir / f"scene_{i:02d}.png"
        try:
            provider.generate_image(sp, output_path=out_path)
        except UsePlaceholderFallback as exc:
            st.warning(
                t("producer_comfy_scene_fail").format(i=i, reason=str(exc))
            )
            return None
        except Exception as exc:  # noqa: BLE001 — any other failure also falls back
            st.warning(
                t("producer_comfy_scene_fail").format(i=i, reason=f"{type(exc).__name__}: {exc}")
            )
            return None
        scaled_dur = max(0.5, sp.duration * scale)
        assets.append(
            SceneAsset(
                image_path=out_path,
                start_s=cursor,
                duration_s=scaled_dur,
            )
        )
        cursor += scaled_dur

    scene_progress.progress(1.0, text="")
    st.success(t("producer_comfy_using").format(n=len(assets)))
    return assets


def _generate_scene_assets_via_grok(
    *,
    provider: GrokImageProvider,
    scene_prompts: list[ScenePrompt],
    audio_duration_s: float,
    output_dir: Path,
) -> list[SceneAsset] | None:
    """Drive the Grok image provider per-scene; return assets on success.

    Mirrors :func:`_generate_scene_assets_via_comfyui`: all-or-nothing.
    A single scene failure rolls the whole pipeline back to the
    gradient placeholder so the composer's timeline stays consistent.
    """
    images_dir = output_dir / "scenes"
    images_dir.mkdir(parents=True, exist_ok=True)

    scene_progress = st.progress(0, text="")
    assets: list[SceneAsset] = []
    total_scene_seconds = sum(max(0.0, s.duration) for s in scene_prompts)
    if total_scene_seconds <= 0:
        return None
    scale = audio_duration_s / total_scene_seconds if total_scene_seconds else 1.0
    cursor = 0.0

    for i, sp in enumerate(scene_prompts, start=1):
        scene_progress.progress(
            (i - 1) / max(1, len(scene_prompts)),
            text=t("producer_grok_scene_step").format(i=i, n=len(scene_prompts)),
        )
        out_path = images_dir / f"scene_{i:02d}.png"
        try:
            provider.generate_image(sp, output_path=out_path)
        except UsePlaceholderFallback as exc:
            st.warning(
                t("producer_grok_scene_fail").format(i=i, reason=str(exc))
            )
            return None
        except Exception as exc:  # noqa: BLE001 — any other failure also falls back
            st.warning(
                t("producer_grok_scene_fail").format(i=i, reason=f"{type(exc).__name__}: {exc}")
            )
            return None
        scaled_dur = max(0.5, sp.duration * scale)
        assets.append(
            SceneAsset(
                image_path=out_path,
                start_s=cursor,
                duration_s=scaled_dur,
            )
        )
        cursor += scaled_dur

    scene_progress.progress(1.0, text="")
    st.success(t("producer_grok_using").format(n=len(assets)))
    return assets


def _generate_video_scene_assets_via_grok(
    *,
    provider: GrokImageProvider,
    scene_prompts: list[ScenePrompt],
    audio_duration_s: float,
    output_dir: Path,
) -> list[VideoSceneAsset] | None:
    """Drive the Grok provider's video pipeline per scene → return assets.

    Each call goes through the slow ``POST /rest/media/post/create``
    + chat NDJSON stream + MP4 download — typically 60–180 seconds
    per scene. We surface a per-scene progress bar with the
    server-reported percent so the user has a heartbeat. All-or-
    nothing rollback to the gradient placeholder mirrors the image
    flow.
    """
    videos_dir = output_dir / "scene_videos"
    videos_dir.mkdir(parents=True, exist_ok=True)

    overall_progress = st.progress(0, text="")
    assets: list[VideoSceneAsset] = []
    total_scene_seconds = sum(max(0.0, s.duration) for s in scene_prompts)
    if total_scene_seconds <= 0:
        return None
    scale = audio_duration_s / total_scene_seconds if total_scene_seconds else 1.0
    cursor = 0.0
    n_total = len(scene_prompts)

    for i, sp in enumerate(scene_prompts, start=1):
        overall_progress.progress(
            (i - 1) / max(1, n_total),
            text=t("producer_grok_video_step").format(i=i, n=n_total, progress=0),
        )
        out_path = videos_dir / f"scene_{i:02d}.mp4"
        try:
            provider.generate_video(sp, output_path=out_path)
        except UsePlaceholderFallback as exc:
            st.warning(
                t("producer_grok_video_fail").format(i=i, reason=str(exc))
            )
            return None
        except Exception as exc:  # noqa: BLE001 — any other failure also falls back
            st.warning(
                t("producer_grok_video_fail").format(i=i, reason=f"{type(exc).__name__}: {exc}")
            )
            return None

        scaled_dur = max(0.5, sp.duration * scale)
        assets.append(
            VideoSceneAsset(
                video_path=out_path,
                start_s=cursor,
                duration_s=scaled_dur,
            )
        )
        cursor += scaled_dur

    overall_progress.progress(1.0, text="")
    st.success(t("producer_grok_video_using").format(n=len(assets)))
    return assets


if run_clicked:
    if not script.strip():
        st.warning(t("producer_no_script"))
        st.stop()

    voice_meta = voice_by_short_name(voice_short) or VOICES[0]
    out_dir = Path(tempfile.gettempdir()) / "tube-atlas-producer" / f"run-{int(time.time())}"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Pre-render: synthesize voice first so we know audio duration before
    # spinning up ComfyUI (so per-scene durations can be scaled to fit).
    audio_path = out_dir / "voice.mp3"
    try:
        adapter = EdgeTTSAdapter(rate=CFG.tts.rate, volume=CFG.tts.volume)
        tts_result = adapter.synthesize_with_timing(
            script, output_path=audio_path, voice=voice_meta.short_name
        )
    except Exception as exc:  # noqa: BLE001 — surface any failure to the user
        st.error(f"{type(exc).__name__}: {exc}")
        st.stop()

    audio_duration = tts_result.duration_seconds or float(target_duration)

    # Resolve scene assets if the user picked a real visual provider.
    scene_assets: list[SceneAsset] | None = None
    video_scene_assets: list[VideoSceneAsset] | None = None
    if visual_provider.info.name == "comfyui_local":
        scene_prompts = build_scene_prompts(script, style_source)
        scene_assets = _generate_scene_assets_via_comfyui(
            provider=visual_provider,  # type: ignore[arg-type]
            scene_prompts=scene_prompts,
            audio_duration_s=audio_duration,
            output_dir=out_dir,
        )
    elif visual_provider.info.name == "grok_image":
        if not visual_provider.is_configured():
            st.info(t("producer_provider_fallback").format(label=visual_provider.info.label))
        else:
            scene_prompts = build_scene_prompts(script, style_source)
            grok_mode = st.session_state.get("producer_grok_video_mode", "image")
            if grok_mode == "video":
                video_scene_assets = _generate_video_scene_assets_via_grok(
                    provider=visual_provider,  # type: ignore[arg-type]
                    scene_prompts=scene_prompts,
                    audio_duration_s=audio_duration,
                    output_dir=out_dir,
                )
            else:
                scene_assets = _generate_scene_assets_via_grok(
                    provider=visual_provider,  # type: ignore[arg-type]
                    scene_prompts=scene_prompts,
                    audio_duration_s=audio_duration,
                    output_dir=out_dir,
                )
    elif visual_provider.info.name != "placeholder":
        # Whisk / Gemini stubs — show the not-wired notice and
        # use the gradient placeholder for the actual render.
        st.info(t("producer_provider_fallback").format(label=visual_provider.info.label))

    # Build captions + composite. Reuse the audio we already synthesized.
    if tts_result.word_boundaries:
        captions = group_word_boundaries(tts_result.word_boundaries)
        caption_source = t("producer_caption_source_wb")
    else:
        captions = fallback_captions_from_text(
            script, audio_duration_s=audio_duration
        )
        caption_source = t("producer_caption_source_fb")

    mp4_path = out_dir / "short.mp4"
    options = ComposerOptions(style=style_name)
    progress = st.progress(60, text=t("producer_step_render"))
    try:
        make_short(
            audio_path,
            mp4_path,
            captions=captions,
            duration_hint=audio_duration,
            options=options,
            scene_assets=scene_assets,
            video_scene_assets=video_scene_assets,
        )
    except Exception as exc:  # noqa: BLE001 — surface any failure to the user
        st.error(f"{type(exc).__name__}: {exc}")
        st.stop()
    progress.progress(100, text=t("producer_done"))

    st.success(t("producer_done") + f" · {caption_source}")
    st.video(str(mp4_path))
    st.download_button(
        t("producer_download"),
        data=mp4_path.read_bytes(),
        file_name=mp4_path.name,
        mime="video/mp4",
        use_container_width=True,
    )
