"""DeepSeek client qua OpenAI-compatible SDK + Studio pipeline helpers."""
from __future__ import annotations

import json
import os
import re

from openai import OpenAI

# Sentinel error string — pages match against this prefix to render an i18n
# error message. See ``core.i18n.STRINGS["err_missing_deepseek"]``.
ERR_NO_DEEPSEEK_KEY = "MISSING_DEEPSEEK_API_KEY"


def client() -> OpenAI:
    key = os.getenv("DEEPSEEK_API_KEY")
    if not key:
        raise RuntimeError(ERR_NO_DEEPSEEK_KEY)
    return OpenAI(api_key=key, base_url="https://api.deepseek.com/v1")


def chat(prompt: str, system: str | None = None, temperature: float = 0.7, model: str | None = None) -> str:
    model = model or os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    resp = client().chat.completions.create(
        model=model,
        messages=msgs,
        temperature=temperature,
    )
    return resp.choices[0].message.content or ""


def chat_json(prompt: str, system: str | None = None, model: str | None = None) -> str:
    """Yêu cầu DeepSeek trả JSON (response_format)."""
    model = model or os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    resp = client().chat.completions.create(
        model=model,
        messages=msgs,
        temperature=0.4,
        response_format={"type": "json_object"},
    )
    return resp.choices[0].message.content or "{}"


# Match a trailing comma immediately before a closing brace or bracket,
# optionally with whitespace in between. DeepSeek and most LLMs sometimes
# emit these in long JSON responses despite ``response_format=json_object``.
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")


def parse_llm_json(raw: str) -> dict:
    """Parse a JSON object from an LLM response — tolerant of common drift.

    DeepSeek / GPT / Claude with ``response_format=json_object`` *usually*
    emit clean JSON, but on long outputs (e.g. the 8-part outline at
    ~900 chars) they occasionally drift: a ``,`` is dropped between two
    keys, a stray ``\\n`` lands inside a string, or the model wraps the
    object in ```` ```json ... ``` ```` fences. Without this helper a
    single missing comma surfaces as
    ``JSONDecodeError: Expecting ',' delimiter: line 14 column 11 (char 853)``
    and the entire Studio outline step fails — which is exactly the
    bug screenshot reported.

    Strategy:
      1. Strip ``json`` markdown fences if present.
      2. Try ``json.loads`` directly.
      3. Clip to the first ``{`` and last ``}`` (drops chatter).
      4. Strip trailing commas before ``}`` / ``]``.
      5. Retry; on final failure re-raise the *original* ``JSONDecodeError``
         so callers can include the LLM's char-offset in their warning.

    Always returns a ``dict``; if the parsed top-level isn't a dict we
    wrap it under ``{"value": ...}`` so callers can ``.get(...)`` safely.
    """
    if not raw:
        return {}
    text = raw.strip()
    if not text:
        return {}
    # Strip ```json ... ``` or ``` ... ``` fences
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, count=1)
        text = re.sub(r"\s*```\s*$", "", text, count=1)
        text = text.strip()
    first_err: json.JSONDecodeError | None = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        first_err = exc
        parsed = None
    if parsed is None:
        # Clip to the outermost balanced-looking object.
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            clipped = text[start : end + 1]
            try:
                parsed = json.loads(clipped)
            except json.JSONDecodeError:
                # Strip trailing commas and retry once.
                repaired = _TRAILING_COMMA_RE.sub(r"\1", clipped)
                try:
                    parsed = json.loads(repaired)
                except json.JSONDecodeError:
                    parsed = None
    if parsed is None:
        # Re-raise the *original* error so the caller's warning carries
        # the most informative offset (the user-visible message in the
        # Studio screenshot pointed at "line 14 column 11 (char 853)").
        if first_err is not None:
            raise first_err
        raise json.JSONDecodeError("could not extract JSON object", text, 0)
    if not isinstance(parsed, dict):
        return {"value": parsed}
    return parsed


# ─── Studio pipeline helpers ─────────────────────────────────────────────────
# Each helper produces structured output in the user's chosen language so
# pages can render results without per-step prompt boilerplate. The prompts
# here mirror the H2Dev "PROMPT NGÁCH NHỎ PHẬT PHÁP" workflow:
# Topic → Title → 8-part Outline → Long-form Script → Humanize Rewrite.


def topic_ideas(seed: str, *, language: str, n: int = 20) -> dict:
    """Step 1 — generate ``n`` video topic ideas for ``seed`` niche/keyword.

    Returns ``{"ideas": [{"topic": str, "emotion": str, "hook": str}, ...]}``.
    """
    sys = (
        "You are a YouTube content planner who picks topics that earn deep"
        " emotional engagement and complete watch-through.\n"
        f"Generate {n} distinct video topic ideas for the seed below.\n"
        "Each idea must:\n"
        "- Hook the click without sensational fear-bait\n"
        "- Vary the angle (avoid repeating the same template)\n"
        "- Connect to a specific emotion in the viewer\n"
        "- Be expandable into a full long-form video\n"
        "Return JSON: {\"ideas\":[{\"topic\":str,\"emotion\":str,\"hook\":str}]}.\n"
        f"Write topic, emotion and hook in {language}."
    )
    raw = chat_json(f"Seed niche/keyword: {seed}", system=sys)
    return parse_llm_json(raw)


def titles_with_ctr(topic: str, *, language: str, n: int = 10, must_keywords: str = "") -> dict:
    """Step 2 — generate ``n`` titles for a chosen topic, mark top 3 by CTR.

    Returns ``{"titles":[{"title":str,"reason":str,"ctr_rank":int|null}], "top_3":[int,...]}``.
    """
    sys = (
        f"You are a YouTube CTR specialist. Generate {n} titles for the topic"
        " below. Avoid clickbait that lies — favour curiosity + specificity"
        " + power-words. Highlight the **top 3 by predicted CTR**.\n"
        "Each title ≤100 characters. Reason ≤120 characters explaining the"
        " click point.\n"
        "Return JSON: {\"titles\":[{\"title\":str,\"reason\":str,"
        "\"ctr_rank\":int (1-3 for top three, null otherwise)}],"
        "\"top_3\":[int (1-based indices)]}.\n"
        f"Write titles and reasons in {language}."
    )
    user = f"Topic: {topic}\nMust-include keywords (optional): {must_keywords or '(none)'}"
    raw = chat_json(user, system=sys)
    return parse_llm_json(raw)


def outline_8part(title: str, *, language: str) -> dict:
    """Step 3 — produce the H2Dev 8-part long-form outline.

    Structure: Hook → Empathy → Problem 1 → Small change → Story → Problems
    2 & 3 → Reflection → Closing + CTA. Each part has role + emotion +
    expansion direction.
    """
    sys = (
        "You are a long-form YouTube structural editor. Produce an 8-part"
        " outline that maximises retention for a long-form video.\n"
        "PART 1 — Strong hook\n"
        "PART 2 — Deep empathy (multiple situations)\n"
        "PART 3 — Problem #1 (extended)\n"
        "PART 4 — Small change / actionable shift\n"
        "PART 5 — Story / case study\n"
        "PART 6 — Problems #2 and #3 (extended)\n"
        "PART 7 — Reflection (philosophical / emotional)\n"
        "PART 8 — Closing + CTA\n"
        "Each PART must be DIFFERENT (no repeats), and detailed enough to"
        " expand into 800-1200 words.\n"
        "Return JSON: {\"parts\":[{\"part\":1,\"role\":str,\"emotion\":str,"
        "\"expansion\":str}, ...]} (exactly 8 entries).\n"
        f"Write role, emotion and expansion in {language}."
    )
    raw = chat_json(f"Title: {title}", system=sys)
    return parse_llm_json(raw)


def long_script_chunked(
    title: str,
    parts: list[dict],
    *,
    language: str,
    target_chars: int = 18000,
) -> str:
    """Step 4 — write the full long-form script in two chunks (parts 1-4, 5-8) and merge.

    Splitting avoids hitting DeepSeek's max_tokens for very long scripts.
    """
    if not parts or len(parts) < 8:
        raise ValueError("outline must have 8 parts")

    target_per_part = max(target_chars // 8, 600)
    sys_template = (
        "You are a long-form YouTube narration writer. Expand the outline"
        " parts below into a full script.\n"
        "RULES:\n"
        f"- Each PART: minimum {target_per_part} characters in {language}.\n"
        "- Repeat the core emotion in different phrasings (avoid identical sentences).\n"
        "- Use lived-in details (drawers, late-night moments, hospital bills, etc.).\n"
        "- Write conversationally — like telling a story to one person.\n"
        "- Address the viewer directly several times.\n"
        "- No emojis, no special bullet symbols.\n"
        f"- Output is naturally read-aloud {language}, not a list.\n"
        "- Mark each PART with a ## PART N — <role> markdown header.\n"
        f"Continue from any prior PART smoothly — do not summarise. Write in {language}."
    )

    chunk_a_outline = parts[:4]
    chunk_b_outline = parts[4:]

    sys = sys_template
    body_a = chat(
        "Title: " + title + "\n\nPARTS 1-4 outline:\n" + json.dumps(chunk_a_outline, ensure_ascii=False),
        system=sys,
        temperature=0.85,
    )

    body_b = chat(
        "Title: "
        + title
        + "\n\nPARTS 5-8 outline:\n"
        + json.dumps(chunk_b_outline, ensure_ascii=False)
        + "\n\nThe script so far ends with:\n\n"
        + body_a[-800:],
        system=sys,
        temperature=0.85,
    )
    return body_a.rstrip() + "\n\n" + body_b.lstrip()


def refine_per_scene_narrations(
    *,
    original_script: str,
    scenes: list[dict],
    language: str = "English",
    words_per_second: float = 2.5,
) -> list[str]:
    """Rewrite per-scene narrations so each line fits its scene's video.

    The Compose-audio path used to chunk the user's full script linearly
    across scenes, which produced narrations that were either too long
    (TTS overflowed the scene_video and bled into the next clip) or too
    short (silence pad ate half the scene). This helper asks DeepSeek to
    produce one narration per scene using three pieces of context:

    * ``original_script`` — the source of truth for storyline and tone.
    * Each scene's ``image_prompt`` — the visual content actually on
      screen at that moment, so the narration matches what's shown.
    * Each scene's ``target_duration_s`` — the *real* duration of the
      scene's I2V video, so word count is sized to fit (default
      ``words_per_second=2.5`` matches the en-US-AriaNeural TTS
      cadence we use elsewhere).

    Each entry in ``scenes`` should be a dict with at least ``index``
    (0-based) and ``target_duration_s``; ``image_prompt`` and
    ``original_narration`` are optional but improve quality when
    provided. Returns a list of strings the same length as ``scenes``;
    empty entries are filled with the per-scene fallback (the original
    narration if any, else an empty string) so the caller can still pad
    silence rather than crashing.

    Raises ``RuntimeError(ERR_NO_DEEPSEEK_KEY)`` when the API key is
    missing — the caller is expected to surface this as a warning and
    fall back to the linear-chunking path.
    """
    n = len(scenes)
    if n == 0:
        return []

    # Build per-scene budget hints so the LLM can match word count to
    # actual video length. We ceil to whole seconds before applying the
    # rate so a 4.4s clip still gets at least 11 words of headroom.
    items: list[dict] = []
    for i, sc in enumerate(scenes):
        if not isinstance(sc, dict):
            sc = {}
        dur = sc.get("target_duration_s")
        try:
            dur_f = float(dur) if dur is not None else 0.0
        except (TypeError, ValueError):
            dur_f = 0.0
        target_words = max(4, int(round(dur_f * words_per_second))) if dur_f > 0 else 12
        items.append({
            "index": int(sc.get("index", i)),
            "target_duration_s": round(dur_f, 2) if dur_f > 0 else None,
            "target_words": target_words,
            "image_prompt": str(sc.get("image_prompt") or "").strip(),
            "original_narration": str(sc.get("original_narration") or "").strip(),
        })

    sys = (
        "You rewrite voice-over narration so it fits each scene of a"
        " short video.\n"
        "INPUTS:\n"
        "- An ORIGINAL_SCRIPT: the storyline / tone source of truth.\n"
        "- An array of SCENES, one per scene in playback order. Each"
        " scene has: index (0-based), target_duration_s (real duration"
        " of that scene's video), target_words (recommended word"
        " budget for the narration to fit the duration at a natural"
        " pace), image_prompt (what is visible on screen during this"
        " scene), and original_narration (the linear chunk the renderer"
        " split off the original script — use it as a starting point,"
        " refine it).\n"
        "RULES:\n"
        "- Output exactly one refined narration per scene, IN ORDER.\n"
        "- Each narration MUST fit roughly within its target_words"
        " budget (\u00b120%); if you can't say it cleanly in the"
        " budget, prefer being slightly shorter.\n"
        "- Each narration should describe / complement what the scene's"
        " image_prompt shows, while staying faithful to the storyline"
        " in ORIGINAL_SCRIPT.\n"
        "- Maintain emotional continuity scene-to-scene (do not repeat"
        " the same opening words across scenes).\n"
        "- No section headers, no scene labels, no markdown — just the"
        " narration sentence(s) themselves.\n"
        f"- Write all narrations in {language}.\n"
        "OUTPUT FORMAT: a single JSON object with a key"
        " \"narrations\" whose value is an array of"
        f" {n} strings, in scene order."
    )
    user_payload = {
        "ORIGINAL_SCRIPT": original_script,
        "SCENES": items,
    }
    raw = chat_json(json.dumps(user_payload, ensure_ascii=False), system=sys)
    parsed = parse_llm_json(raw)
    out_raw = parsed.get("narrations")
    fallbacks = [it["original_narration"] for it in items]
    if not isinstance(out_raw, list):
        return _dedupe_scene_narrations(fallbacks, fallbacks)
    out: list[str] = []
    for i in range(n):
        v = out_raw[i] if i < len(out_raw) else None
        if isinstance(v, str):
            txt = v.strip()
        elif v is None:
            txt = ""
        else:
            txt = str(v).strip()
        out.append(txt if txt else fallbacks[i])
    return _dedupe_scene_narrations(out, fallbacks)


def _dedupe_scene_narrations(
    narrations: list[str], fallbacks: list[str]
) -> list[str]:
    """Strip duplicate per-scene narrations after the LLM rewrite.

    DeepSeek occasionally ignores the "do not repeat the same opening
    words across scenes" rule and emits identical strings for two
    different scenes — usually scene 1 and the last scene. When the
    Compose-audio pipeline TTS-renders both, the same caption appears
    once at the start and once at the end of the assembled video,
    looking like a "captions loop back to the beginning" bug to the
    user.

    Strategy: walk the list once. If a narration's normalised text
    matches one we've already kept, swap it for the corresponding
    ``fallbacks`` entry (the original linear chunk). If the fallback
    is also a duplicate of something we've already emitted, blank
    the slot — the caller pads silence in that scene rather than
    re-speaking the line. Empty strings are passed through (they
    are already pad-silence sentinels).

    Comparison is case-insensitive and whitespace-collapsed so
    "Hello world" matches "  hello   world  ".
    """
    seen: set[str] = set()
    out: list[str] = []
    for i, narration in enumerate(narrations):
        text = (narration or "").strip()
        norm = " ".join(text.lower().split())
        if not norm:
            out.append(text)
            continue
        if norm not in seen:
            seen.add(norm)
            out.append(text)
            continue
        fallback = (fallbacks[i] if i < len(fallbacks) else "") or ""
        fb_norm = " ".join(fallback.strip().lower().split())
        if fb_norm and fb_norm not in seen:
            seen.add(fb_norm)
            out.append(fallback.strip())
        else:
            out.append("")
    return out


def refine_script_for_narration(
    *,
    raw_script: str,
    scene_image_prompts: list[str] | None = None,
    target_duration_s: float | None = None,
    language: str = "English",
    words_per_second: float = 2.5,
) -> str:
    """Distil any input (storyline, JSON blob, prompt dump, draft) into a
    clean voice-over narration script.

    The Compose-audio path used to TTS-render whatever the user pasted into
    the script box verbatim. When the input is actually a paste of upstream
    image-prompt JSON (``"negative_prompt": [...], "avoid": [...]``) or a
    draft full of bracketed lists, the result is unintelligible audio.
    This helper asks DeepSeek to produce a single flowing narration that:

    * Tells the storyline implied by ``raw_script`` (extracting it from
      whatever syntax surrounds it -- JSON, lists, prompt fragments).
    * Describes / complements what the storyboard's
      ``scene_image_prompts`` show, so the audio matches the visuals
      even when the input script was off-topic / contaminated.
    * Fits the total ``target_duration_s`` (sum of scene_videos when
      the renderer can compute it) at ~``words_per_second`` cadence --
      so the rendered audio is short enough to ride the assembled
      video without bleeding past it.

    Returns a single string (the refined narration). Empty input,
    missing key (raises ``RuntimeError(ERR_NO_DEEPSEEK_KEY)``), and any
    LLM error are the caller's responsibility -- the renderer surfaces
    these as warnings and keeps the user's textarea unchanged.
    """
    text = (raw_script or "").strip()
    if not text:
        return ""
    prompts = [str(p).strip() for p in (scene_image_prompts or []) if p and str(p).strip()]
    try:
        dur_f = float(target_duration_s) if target_duration_s is not None else 0.0
    except (TypeError, ValueError):
        dur_f = 0.0
    if dur_f > 0:
        target_words = max(20, int(round(dur_f * words_per_second)))
        budget_hint = (
            f"- The total narration MUST fit roughly {target_words} words"
            f" (plus or minus 10%) so it rides a ~{round(dur_f, 1)}s video"
            f" at a natural pace. Prefer slightly shorter to slightly longer."
        )
    else:
        target_words = 0
        budget_hint = (
            "- Keep the narration concise -- one or two short paragraphs"
            " is usually enough."
        )
    sys = (
        "You convert raw input (which may be a storyline, a JSON blob,"
        " an image-prompt dump, or a messy draft) into a CLEAN voice-over"
        " narration ready for text-to-speech.\n"
        "INPUTS:\n"
        "- RAW_INPUT: anything the user pasted in (treat as best-effort"
        " source material -- extract the underlying storyline; if it's"
        " purely prompt syntax with no narrative, fall back to the"
        " image_prompts).\n"
        "- IMAGE_PROMPTS: per-scene visual descriptions in playback"
        " order. Use them to ground the narration in what's on screen.\n"
        "RULES:\n"
        "- Output ONE flowing narration. No section headers. No scene"
        " labels. No JSON. No bracketed lists. No prompt syntax (no"
        " 'negative_prompt', no 'avoid', no comma-separated keyword"
        " lists). No code fences.\n"
        "- Strip out anything that looks like a generation prompt"
        " (camera directions in brackets, lighting tags, NSFW filter"
        " words, list-of-keywords) -- the goal is what a viewer should"
        " HEAR, not what the image model needs to read.\n"
        "- Maintain emotional continuity scene-to-scene.\n"
        f"{budget_hint}\n"
        f"- Write the narration in {language}.\n"
        "OUTPUT FORMAT: a single JSON object with one key \"narration\""
        " whose value is the cleaned narration as a single string. No"
        " other keys."
    )
    user_payload = {
        "RAW_INPUT": text,
        "IMAGE_PROMPTS": prompts,
        "TARGET_DURATION_S": round(dur_f, 2) if dur_f > 0 else None,
        "TARGET_WORDS": target_words or None,
    }
    raw = chat_json(json.dumps(user_payload, ensure_ascii=False), system=sys)
    parsed = parse_llm_json(raw)
    out = parsed.get("narration")
    if isinstance(out, str):
        return out.strip()
    if isinstance(out, list):
        joined = " ".join(str(x).strip() for x in out if str(x).strip())
        return joined
    return ""


def humanize_rewrite(script: str, *, language: str) -> str:
    """Step 5 — rewrite to remove AI tells without shrinking length."""
    sys = (
        "Rewrite the script below to sound more natural and human, while"
        " keeping the structure and length.\n"
        "GOALS:\n"
        "- Remove AI-sounding phrasing\n"
        "- Vary sentence rhythm — fewer same-shape sentences in a row\n"
        "- Strengthen emotional flow — make it feel earned, not announced\n"
        "- Add natural lived-in details where helpful\n"
        "- Keep the same PART structure and headers\n"
        "RULES:\n"
        "- Do NOT summarise or shorten any PART\n"
        "- Do NOT remove paragraphs\n"
        "- Do NOT change the title or section markers\n"
        f"- Write the entire output in {language}."
    )
    return chat(script, system=sys, temperature=0.6)
