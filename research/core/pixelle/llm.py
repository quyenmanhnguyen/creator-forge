"""LLM provider abstraction: DeepSeek primary + Gemini optional fallback.

The rest of Tube Atlas already imports ``core.llm.chat`` directly; this
module is only used by the Pixelle production pipeline so it can transparently
fall back to Gemini when DeepSeek hits a quota / outage.

Rationale: the user has DeepSeek (paid, primary) AND Google AI Ultra
(Gemini available). Don't fail the pipeline when DeepSeek is rate-limited.
"""
from __future__ import annotations

from collections.abc import Callable

from core import llm as core_llm
from core.pixelle.config import LLMConfig


class LLMUnavailableError(RuntimeError):
    """Raised when neither primary nor fallback provider succeeds."""


def chat(
    prompt: str,
    *,
    system: str | None = None,
    temperature: float = 0.7,
    config: LLMConfig | None = None,
) -> str:
    """Send *prompt* to the configured primary; on failure try fallback.

    Returns the raw text response. Raises :class:`LLMUnavailableError` if
    every configured provider fails.
    """
    cfg = config or LLMConfig()
    providers = _provider_chain(cfg)
    last_err: Exception | None = None
    for name, fn in providers:
        try:
            return fn(prompt, system=system, temperature=temperature)
        except Exception as exc:  # noqa: BLE001 — we re-raise as LLMUnavailableError
            last_err = exc
            continue
    raise LLMUnavailableError(
        f"All providers failed (last error: {last_err!r}); tried: "
        f"{[n for n, _ in providers]}"
    ) from last_err


def _provider_chain(cfg: LLMConfig) -> list[tuple[str, Callable[..., str]]]:
    chain: list[tuple[str, Callable[..., str]]] = []
    chain.append((cfg.primary, _provider_fn(cfg.primary, cfg)))
    if cfg.fallback and cfg.fallback != cfg.primary:
        chain.append((cfg.fallback, _provider_fn(cfg.fallback, cfg)))
    return chain


def _provider_fn(name: str, cfg: LLMConfig) -> Callable[..., str]:
    if name == "deepseek":
        return lambda prompt, *, system, temperature: core_llm.chat(
            prompt, system=system, temperature=temperature, model=cfg.deepseek_model
        )
    if name == "gemini":
        return lambda prompt, *, system, temperature: _gemini_chat(
            prompt, system=system, temperature=temperature, model=cfg.gemini_model, key=cfg.gemini_key
        )
    raise ValueError(f"Unknown LLM provider: {name!r}")


def _gemini_chat(
    prompt: str,
    *,
    system: str | None,
    temperature: float,
    model: str,
    key: str | None,
) -> str:
    """Call Google Gemini via the ``google-generativeai`` SDK.

    The SDK is imported lazily so users who don't install it can still use
    DeepSeek-only mode without the dependency.
    """
    if not key:
        raise RuntimeError("MISSING_PIXELLE_GEMINI_KEY")
    try:
        import google.generativeai as genai  # type: ignore[import-untyped]
    except ImportError as exc:
        raise RuntimeError(
            "google-generativeai is not installed. Install with "
            "`pip install google-generativeai` to enable the Gemini fallback."
        ) from exc

    genai.configure(api_key=key)
    gem_model = genai.GenerativeModel(
        model_name=model,
        system_instruction=system,
        generation_config={"temperature": temperature},
    )
    resp = gem_model.generate_content(prompt)
    return resp.text or ""
