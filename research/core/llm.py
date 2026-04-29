"""DeepSeek client qua OpenAI-compatible SDK + Studio pipeline helpers."""
from __future__ import annotations

import json
import os

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
    return json.loads(raw)


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
    return json.loads(raw)


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
    return json.loads(raw)


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
