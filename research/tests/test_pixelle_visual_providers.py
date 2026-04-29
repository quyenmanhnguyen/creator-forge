"""Tests for :mod:`core.pixelle.visual_providers` (PR-A3)."""
from __future__ import annotations

from pathlib import Path

import pytest

from core.pixelle.prompting import ScenePrompt
from core.pixelle.visual_providers import (
    DEFAULT_PROVIDER_NAME,
    PROVIDER_NAMES,
    ComfyUIVisualProvider,
    GeminiImageProvider,
    GoogleWhiskProvider,
    GrokImageProvider,
    PlaceholderVisualProvider,
    ProviderInfo,
    ProviderNotConfiguredError,
    ProviderNotImplementedError,
    UsePlaceholderFallback,
    VisualProvider,
    get_provider,
    list_provider_specs,
)


def _scene() -> ScenePrompt:
    return ScenePrompt(
        scene_id=1,
        duration=4.0,
        narration="hi",
        image_prompt="img",
        video_prompt="vid",
    )


def test_default_provider_is_placeholder():
    assert DEFAULT_PROVIDER_NAME == "placeholder"
    assert "placeholder" in PROVIDER_NAMES


def test_get_provider_unknown_falls_back_to_placeholder():
    p = get_provider("does-not-exist")
    assert isinstance(p, PlaceholderVisualProvider)


def test_get_provider_returns_concrete_instances():
    assert isinstance(get_provider("placeholder"), PlaceholderVisualProvider)
    assert isinstance(get_provider("comfyui_local"), ComfyUIVisualProvider)
    assert isinstance(get_provider("google_whisk"), GoogleWhiskProvider)
    assert isinstance(get_provider("gemini_image"), GeminiImageProvider)
    assert isinstance(get_provider("grok_image"), GrokImageProvider)


def test_list_provider_specs_returns_provider_infos():
    specs = list_provider_specs()
    assert len(specs) == len(PROVIDER_NAMES)
    for spec in specs:
        assert isinstance(spec, ProviderInfo)
        assert spec.name and spec.label and spec.kind


def test_every_provider_has_unique_name_and_label():
    specs = list_provider_specs()
    names = [s.name for s in specs]
    labels = [s.label for s in specs]
    assert len(names) == len(set(names))
    assert len(labels) == len(set(labels))


def test_placeholder_always_configured():
    p = PlaceholderVisualProvider()
    assert p.is_configured() is True
    assert p.missing_reason() == ""


def test_placeholder_generate_image_signals_fallback(tmp_path: Path):
    p = PlaceholderVisualProvider()
    with pytest.raises(UsePlaceholderFallback):
        p.generate_image(_scene(), output_path=tmp_path / "out.png")


def test_placeholder_generate_video_signals_fallback(tmp_path: Path):
    p = PlaceholderVisualProvider()
    with pytest.raises(UsePlaceholderFallback):
        p.generate_video(_scene(), output_path=tmp_path / "out.mp4")


def test_comfyui_is_configured_when_local_url_set(monkeypatch: pytest.MonkeyPatch):
    # Default config sets COMFYUI local URL — should be configured.
    p = ComfyUIVisualProvider()
    assert p.is_configured() is True


def test_stub_provider_without_config_raises_not_configured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    p = GeminiImageProvider()
    assert not p.is_configured()
    with pytest.raises(ProviderNotConfiguredError):
        p.generate_image(_scene(), output_path=tmp_path / "x.png")


def test_stub_provider_with_config_raises_not_implemented(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    p = GeminiImageProvider()
    assert p.is_configured()
    with pytest.raises(ProviderNotImplementedError):
        p.generate_image(_scene(), output_path=tmp_path / "x.png")


def test_grok_provider_unconfigured_without_session():
    """PR-A4.2: provider is not configured until a session is injected."""
    assert GrokImageProvider().is_configured() is False
    assert GrokImageProvider().missing_reason()


def test_grok_provider_configured_with_session():
    """A :class:`GrokSession` instance flips ``is_configured``."""
    from core.pixelle.grok_web_client import GrokSession

    sess = GrokSession(cookies={"sso": "abc"}, headers={}, email="u@x.ai")
    assert GrokImageProvider(session=sess).is_configured() is True


def test_grok_provider_reads_session_from_kwarg_only():
    """The constructor never falls back to env vars for auth."""
    p1 = GrokImageProvider()
    assert not p1.is_configured()
    from core.pixelle.grok_web_client import GrokSession

    p2 = GrokImageProvider(session=GrokSession(cookies={"a": "b"}))
    assert p2.is_configured()


def test_google_whisk_reads_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GOOGLE_WHISK_API_KEY", raising=False)
    assert not GoogleWhiskProvider().is_configured()
    monkeypatch.setenv("GOOGLE_WHISK_API_KEY", "any")
    assert GoogleWhiskProvider().is_configured()


def test_all_providers_implement_visual_provider_interface():
    for name in PROVIDER_NAMES:
        p = get_provider(name)
        assert isinstance(p, VisualProvider)
        assert callable(p.is_configured)
        assert callable(p.missing_reason)


def test_provider_missing_reason_nonempty_when_not_configured(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    p = GeminiImageProvider()
    assert p.missing_reason()  # non-empty hint


# ─── PR-A3.1: ComfyUI provider real-wiring tests ─────────────────────────────


def test_comfyui_generate_image_delegates_to_orchestrator(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """``ComfyUIVisualProvider.generate_image`` should call
    :func:`core.pixelle.comfyui_image.generate_scene_image` with the
    base URL from config + the user-supplied workflow / checkpoint /
    seed knobs, and return its result.
    """
    from core.pixelle import comfyui_image

    captured: dict = {}
    expected_path = tmp_path / "scene.png"

    def _fake_generate(prompt, **kwargs):
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs
        # Simulate the real orchestrator writing the file.
        kwargs["output_path"].parent.mkdir(parents=True, exist_ok=True)
        kwargs["output_path"].write_bytes(b"fake-png")
        return kwargs["output_path"]

    monkeypatch.setattr(comfyui_image, "generate_scene_image", _fake_generate)

    workflow = tmp_path / "wf.json"
    workflow.write_text("{}")  # not actually loaded by the fake

    p = ComfyUIVisualProvider(
        workflow_path=workflow,
        checkpoint="my-ckpt.safetensors",
        seed=42,
    )

    out = p.generate_image(_scene(), output_path=expected_path)
    assert out == expected_path
    assert captured["kwargs"]["workflow_path"] == workflow
    assert captured["kwargs"]["checkpoint"] == "my-ckpt.safetensors"
    assert captured["kwargs"]["seed"] == 42
    # base_url comes from config, not user-supplied here
    assert captured["kwargs"]["base_url"].startswith("http")


def test_comfyui_generate_image_translates_error_to_placeholder_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Any :class:`ComfyUIError` from the orchestrator should be wrapped
    in :class:`UsePlaceholderFallback` so the Producer page can recover.
    """
    from core.pixelle import comfyui_image
    from core.pixelle.comfy_client import ComfyUIError

    def _boom(prompt, **kwargs):
        raise ComfyUIError("server down")

    monkeypatch.setattr(comfyui_image, "generate_scene_image", _boom)

    p = ComfyUIVisualProvider()
    with pytest.raises(UsePlaceholderFallback) as exc_info:
        p.generate_image(_scene(), output_path=tmp_path / "x.png")
    # Original error should be chained for debuggability.
    assert isinstance(exc_info.value.__cause__, ComfyUIError)


def test_comfyui_generate_image_raises_not_configured_when_no_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("COMFYUI_URL", "")
    monkeypatch.delenv("RUNNINGHUB_API_KEY", raising=False)
    p = ComfyUIVisualProvider()
    assert not p.is_configured()
    with pytest.raises(ProviderNotConfiguredError):
        p.generate_image(_scene(), output_path=tmp_path / "x.png")


# ─── PR-A4.2: Grok image provider real-wiring tests ──────────────────────────


def _grok_session():
    from core.pixelle.grok_web_client import GrokSession

    return GrokSession(cookies={"sso": "abc"}, headers={}, email="u@x.ai")


def test_grok_generate_image_writes_bytes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Happy path: provider calls ``generate_image_via_web`` and writes
    the returned bytes to ``output_path``.
    """
    from core.pixelle import grok_web_client as gwc

    fake_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8000

    def _fake_generate(prompt, session, **kwargs):
        assert prompt  # non-empty
        assert session is not None
        return [fake_bytes]

    monkeypatch.setattr(gwc, "generate_image_via_web", _fake_generate)

    p = GrokImageProvider(session=_grok_session())
    out = p.generate_image(_scene(), output_path=tmp_path / "scene.png")
    assert out == tmp_path / "scene.png"
    assert (tmp_path / "scene.png").read_bytes() == fake_bytes


def test_grok_generate_image_translates_error_to_placeholder_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """A :class:`GrokWebError` from the client should be wrapped in
    :class:`UsePlaceholderFallback` so the Producer page can recover.
    """
    from core.pixelle import grok_web_client as gwc

    def _boom(prompt, session, **kwargs):
        raise gwc.GrokWebError("expired session")

    monkeypatch.setattr(gwc, "generate_image_via_web", _boom)

    p = GrokImageProvider(session=_grok_session())
    with pytest.raises(UsePlaceholderFallback) as exc_info:
        p.generate_image(_scene(), output_path=tmp_path / "x.png")
    assert isinstance(exc_info.value.__cause__, gwc.GrokWebError)


def test_grok_generate_image_raises_not_configured_without_session(
    tmp_path: Path,
):
    p = GrokImageProvider()  # no session
    with pytest.raises(ProviderNotConfiguredError):
        p.generate_image(_scene(), output_path=tmp_path / "x.png")


def test_grok_generate_image_makes_no_http_calls_without_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """No session → no HTTP calls. ``requests`` is monkeypatched to a
    sentinel that fails the test if used.
    """
    from core.pixelle import grok_web_client as gwc

    def _boom(*a, **k):
        raise AssertionError("HTTP must not be called when session is None")

    monkeypatch.setattr(gwc, "generate_image_via_web", _boom)

    p = GrokImageProvider()
    with pytest.raises(ProviderNotConfiguredError):
        p.generate_image(_scene(), output_path=tmp_path / "x.png")


def test_grok_generate_image_passes_aspect_ratio(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    from core.pixelle import grok_web_client as gwc

    captured: dict = {}

    def _spy(prompt, session, **kwargs):
        captured.update(kwargs)
        return [b"\x89PNG" + b"\x00" * 8000]

    monkeypatch.setattr(gwc, "generate_image_via_web", _spy)

    p = GrokImageProvider(session=_grok_session(), aspect_ratio="16:9")
    p.generate_image(_scene(), output_path=tmp_path / "x.png")
    assert captured["aspect_ratio"] == "16:9"


def test_grok_generate_video_raises_not_configured_without_session(tmp_path: Path):
    p = GrokImageProvider()  # no session
    with pytest.raises(ProviderNotConfiguredError):
        p.generate_video(_scene(), output_path=tmp_path / "x.mp4")


# ─── PR-A5: Grok video provider real-wiring tests ───────────────────────────


def test_grok_generate_video_returns_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Happy path: provider delegates to ``generate_video_via_web`` and
    returns the same ``output_path`` it received.
    """
    from core.pixelle import grok_video_client as gvc

    captured: dict = {}

    def _fake_generate(prompt, session, *, output_path, **kwargs):
        captured["prompt"] = prompt
        captured["session"] = session
        captured["kwargs"] = kwargs
        # Simulate the real client writing to disk.
        Path(output_path).write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096)
        return Path(output_path)

    monkeypatch.setattr(gvc, "generate_video_via_web", _fake_generate)

    p = GrokImageProvider(session=_grok_session())
    out = p.generate_video(_scene(), output_path=tmp_path / "scene.mp4")
    assert out == tmp_path / "scene.mp4"
    assert (tmp_path / "scene.mp4").exists()
    # Default aspect_ratio / video_length / resolution flow through.
    assert captured["kwargs"]["aspect_ratio"] == "9:16"
    assert captured["kwargs"]["video_length"] == 6
    assert captured["kwargs"]["resolution"] == "720p"
    # video_prompt is preferred over image_prompt.
    assert captured["prompt"] == "vid"


def test_grok_generate_video_passes_video_knobs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    from core.pixelle import grok_video_client as gvc

    captured: dict = {}

    def _spy(prompt, session, *, output_path, **kwargs):
        captured.update(kwargs)
        Path(output_path).write_bytes(b"X" * 2048)
        return Path(output_path)

    monkeypatch.setattr(gvc, "generate_video_via_web", _spy)

    p = GrokImageProvider(
        session=_grok_session(),
        aspect_ratio="16:9",
        video_length=10,
        resolution="480p",
    )
    p.generate_video(_scene(), output_path=tmp_path / "x.mp4")
    assert captured["aspect_ratio"] == "16:9"
    assert captured["video_length"] == 10
    assert captured["resolution"] == "480p"


def test_grok_generate_video_translates_error_to_placeholder_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """A :class:`GrokWebError` from the client should be wrapped in
    :class:`UsePlaceholderFallback` so the Producer page can recover.
    """
    from core.pixelle import grok_video_client as gvc
    from core.pixelle import grok_web_client as gwc

    def _boom(prompt, session, *, output_path, **kwargs):
        raise gwc.GrokWebError("moderation blocked all candidates")

    monkeypatch.setattr(gvc, "generate_video_via_web", _boom)

    p = GrokImageProvider(session=_grok_session())
    with pytest.raises(UsePlaceholderFallback) as exc_info:
        p.generate_video(_scene(), output_path=tmp_path / "x.mp4")
    assert isinstance(exc_info.value.__cause__, gwc.GrokWebError)


def test_grok_generate_video_empty_prompt_falls_back(tmp_path: Path):
    """Both ``video_prompt`` and ``image_prompt`` blank → fallback."""
    p = GrokImageProvider(session=_grok_session())
    empty_scene = ScenePrompt(
        scene_id=1,
        duration=4.0,
        narration="hi",
        image_prompt="",
        video_prompt="",
    )
    with pytest.raises(UsePlaceholderFallback):
        p.generate_video(empty_scene, output_path=tmp_path / "x.mp4")


def test_grok_generate_video_falls_back_to_image_prompt_when_video_blank(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """If ``video_prompt`` is empty, ``image_prompt`` is used."""
    from core.pixelle import grok_video_client as gvc

    captured: dict = {}

    def _spy(prompt, session, *, output_path, **kwargs):
        captured["prompt"] = prompt
        Path(output_path).write_bytes(b"X" * 2048)
        return Path(output_path)

    monkeypatch.setattr(gvc, "generate_video_via_web", _spy)

    p = GrokImageProvider(session=_grok_session())
    scene = ScenePrompt(
        scene_id=1,
        duration=4.0,
        narration="hi",
        image_prompt="img-only",
        video_prompt="",
    )
    p.generate_video(scene, output_path=tmp_path / "x.mp4")
    assert captured["prompt"] == "img-only"


def test_grok_generate_video_kind_advertises_image_plus_video():
    """Provider info should advertise video support after PR-A5."""
    info = GrokImageProvider.info
    assert info.kind == "image+video"
