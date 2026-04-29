"""Tests for core.pixelle.composer.

Heavy moviepy operations (video encoding) are mocked — we verify the
caption layering math, gradient PNG generation, and the make_short()
plumbing rather than a full mp4 round-trip in CI.
"""
from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

import pytest

from core.pixelle import composer
from core.pixelle.styles import get_style
from core.pixelle.subtitles import Caption


def test_pillow_antialias_shim_applied():
    """moviepy 1.x calls ``PIL.Image.ANTIALIAS`` from its resize fx; the
    composer module patches it back in for Pillow >= 10."""
    from PIL import Image

    assert hasattr(Image, "ANTIALIAS")
    assert Image.ANTIALIAS == Image.Resampling.LANCZOS


def test_render_gradient_background_creates_png(tmp_path):
    out = tmp_path / "bg.png"
    style = get_style("violet-pink")

    composer._render_gradient_background(out, width=200, height=400, style=style)

    assert out.exists()
    from PIL import Image

    with Image.open(out) as img:
        # Background is rendered 10% larger so Ken Burns zoom never reveals edges.
        assert img.size == (220, 440)
        assert img.mode == "RGB"


def test_render_caption_png_returns_image_for_text():
    style = get_style("ocean")
    img = composer._render_caption_png(
        text="hello world", width=400, font_size=32, accent=style.accent
    )
    assert img is not None
    assert img.mode == "RGBA"
    assert img.size[0] > 0 and img.size[1] > 0


def test_render_caption_png_returns_none_for_empty():
    assert composer._render_caption_png(text="   ", width=400, font_size=32, accent=(0, 0, 0)) is None


def test_wrap_breaks_long_lines():
    font = composer._load_font(20)
    lines = composer._wrap("one two three four five six seven", font=font, max_width=80)
    assert len(lines) >= 2
    # Greedy fit: each line packs as many words as possible.
    for line in lines:
        assert line.strip()


def test_ken_burns_factory_zooms_over_duration():
    fn = composer._ken_burns_factory(duration=5.0)
    assert fn(0.0) == pytest.approx(1.0)
    assert fn(5.0) == pytest.approx(composer.KEN_BURNS_END_ZOOM)
    assert 1.0 < fn(2.5) < composer.KEN_BURNS_END_ZOOM


def test_ken_burns_factory_handles_zero_duration():
    fn = composer._ken_burns_factory(duration=0.0)
    assert fn(0.0) == 1.0
    assert fn(10.0) == 1.0


def test_make_short_invokes_moviepy_pipeline(tmp_path, monkeypatch):
    """make_short() should: load audio → resize bg → composite → write mp4 → cleanup."""
    audio = tmp_path / "v.mp3"
    audio.write_bytes(b"fake-mp3")
    out = tmp_path / "out.mp4"
    captions = [Caption(start_s=0.0, end_s=1.5, text="hi"), Caption(start_s=1.5, end_s=3.0, text="bye")]

    fake_audio = MagicMock()
    fake_audio.duration = 3.0
    fake_audio.close = MagicMock()

    fake_bg_clip = MagicMock()
    fake_bg_clip.set_duration.return_value = fake_bg_clip
    fake_bg_clip.resize.return_value = fake_bg_clip
    fake_bg_clip.set_position.return_value = fake_bg_clip

    fake_caption_clip = MagicMock()
    for method in ("set_start", "set_duration", "set_position"):
        getattr(fake_caption_clip, method).return_value = fake_caption_clip

    fake_composite = MagicMock()
    fake_composite.set_duration.return_value = fake_composite
    fake_composite.set_audio.return_value = fake_composite
    fake_composite.write_videofile = MagicMock()
    fake_composite.close = MagicMock()

    image_clip_call_count = {"n": 0}

    def fake_image_clip(*args, **kwargs):
        # First call = background PNG; subsequent calls = caption PNGs.
        image_clip_call_count["n"] += 1
        if image_clip_call_count["n"] == 1:
            return fake_bg_clip
        return fake_caption_clip

    fake_module = types.ModuleType("moviepy.editor")
    fake_module.AudioFileClip = MagicMock(return_value=fake_audio)
    fake_module.ImageClip = fake_image_clip
    fake_module.CompositeVideoClip = MagicMock(return_value=fake_composite)
    monkeypatch.setitem(sys.modules, "moviepy", types.ModuleType("moviepy"))
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    result = composer.make_short(audio, out, captions=captions)

    assert result == out.resolve()
    fake_module.AudioFileClip.assert_called_once_with(str(audio))
    # 1 background ImageClip + 2 caption ImageClips.
    assert image_clip_call_count["n"] == 3
    fake_composite.write_videofile.assert_called_once()
    write_args = fake_composite.write_videofile.call_args
    assert write_args.kwargs["codec"] == "libx264"
    assert write_args.kwargs["audio_codec"] == "aac"
    fake_composite.close.assert_called_once()
    fake_audio.close.assert_called_once()
    # Background PNG must be cleaned up afterwards.
    assert not out.with_suffix(".bg.png").exists()


def test_make_short_raises_when_duration_unknown(tmp_path, monkeypatch):
    audio = tmp_path / "v.mp3"
    audio.write_bytes(b"fake")
    out = tmp_path / "out.mp4"

    fake_audio = MagicMock()
    fake_audio.duration = None  # could not be probed
    fake_audio.close = MagicMock()

    fake_module = types.ModuleType("moviepy.editor")
    fake_module.AudioFileClip = MagicMock(return_value=fake_audio)
    fake_module.ImageClip = MagicMock()
    fake_module.CompositeVideoClip = MagicMock()
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    with pytest.raises(ValueError, match="duration_hint"):
        composer.make_short(audio, out)


def test_composer_options_defaults_to_9_16_at_30fps():
    opts = composer.ComposerOptions()
    assert opts.width == 1080
    assert opts.height == 1920
    assert opts.fps == 30


def test_caption_clips_skip_empty_captions(monkeypatch):
    """Captions whose rendered PNG is None (empty text) must be skipped, not crash."""
    monkeypatch.setattr(composer, "_render_caption_png", lambda **kw: None)

    fake_module = types.ModuleType("moviepy.editor")
    fake_module.ImageClip = MagicMock()
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    clips = composer._caption_clips(
        [Caption(start_s=0, end_s=1, text="ignored")],
        opts=composer.ComposerOptions(),
        style=get_style("violet-pink"),
    )
    assert clips == []
    fake_module.ImageClip.assert_not_called()


def test_pil_to_array_returns_correct_shape(tmp_path):
    from PIL import Image

    img = Image.new("RGBA", (10, 6), (255, 0, 0, 128))

    arr = composer._pil_to_array(img)

    assert arr.shape == (6, 10, 4)  # numpy convention is (h, w, channels)


# ─── PR-A3.1: scene_assets path (per-scene Ken Burns) ────────────────────────


def test_scene_clips_creates_one_clip_per_asset(monkeypatch, tmp_path):
    """``_scene_clips`` should produce exactly one ImageClip per
    :class:`SceneAsset`, with the correct start / duration / position.
    """
    fake_clip = MagicMock()
    for method in ("set_start", "set_duration", "set_position", "resize"):
        getattr(fake_clip, method).return_value = fake_clip

    fake_image_clip = MagicMock(return_value=fake_clip)
    fake_module = types.ModuleType("moviepy.editor")
    fake_module.ImageClip = fake_image_clip
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    img1 = tmp_path / "scene_01.png"
    img1.write_bytes(b"x")
    img2 = tmp_path / "scene_02.png"
    img2.write_bytes(b"y")
    assets = [
        composer.SceneAsset(image_path=img1, start_s=0.0, duration_s=4.0),
        composer.SceneAsset(image_path=img2, start_s=4.0, duration_s=3.0),
    ]

    clips = composer._scene_clips(
        assets, opts=composer.ComposerOptions(), total_duration=7.0
    )

    assert len(clips) == 2
    # Two ImageClip(...) calls, one per asset.
    assert fake_image_clip.call_count == 2
    # Start times match the asset definitions.
    starts = [call.args[0] for call in fake_clip.set_start.call_args_list]
    assert starts == [0.0, 4.0]
    durations = [call.args[0] for call in fake_clip.set_duration.call_args_list]
    assert durations == [4.0, 3.0]


def test_scene_clips_clamps_overflow_to_total_duration(monkeypatch, tmp_path):
    """If an asset's start+duration exceeds ``total_duration``, the
    clip's effective duration is clamped — never negative.
    """
    fake_clip = MagicMock()
    for method in ("set_start", "set_duration", "set_position", "resize"):
        getattr(fake_clip, method).return_value = fake_clip

    fake_module = types.ModuleType("moviepy.editor")
    fake_module.ImageClip = MagicMock(return_value=fake_clip)
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    img = tmp_path / "scene.png"
    img.write_bytes(b"x")
    assets = [composer.SceneAsset(image_path=img, start_s=4.0, duration_s=10.0)]

    composer._scene_clips(
        assets, opts=composer.ComposerOptions(), total_duration=5.0
    )
    # Effective duration should be clamped to (5.0 - 4.0) = 1.0.
    duration_arg = fake_clip.set_duration.call_args_list[0].args[0]
    assert duration_arg == pytest.approx(1.0)


def test_scene_clips_skips_zero_duration(monkeypatch, tmp_path):
    fake_clip = MagicMock()
    for method in ("set_start", "set_duration", "set_position", "resize"):
        getattr(fake_clip, method).return_value = fake_clip

    fake_image_clip = MagicMock(return_value=fake_clip)
    fake_module = types.ModuleType("moviepy.editor")
    fake_module.ImageClip = fake_image_clip
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    img = tmp_path / "scene.png"
    img.write_bytes(b"x")
    assets = [composer.SceneAsset(image_path=img, start_s=0.0, duration_s=0.0)]
    clips = composer._scene_clips(
        assets, opts=composer.ComposerOptions(), total_duration=5.0
    )
    assert clips == []
    fake_image_clip.assert_not_called()


def test_make_short_with_scene_assets_uses_scene_clips_not_gradient(
    tmp_path, monkeypatch
):
    """When ``scene_assets`` is provided, ``make_short`` must NOT
    render the gradient PNG and must NOT clean up a non-existent
    ``.bg.png``. ImageClip should be called once per scene.
    """
    audio = tmp_path / "v.mp3"
    audio.write_bytes(b"fake-mp3")
    out = tmp_path / "out.mp4"

    fake_audio = MagicMock()
    fake_audio.duration = 6.0
    fake_audio.close = MagicMock()

    fake_clip = MagicMock()
    for method in ("set_start", "set_duration", "set_position", "resize"):
        getattr(fake_clip, method).return_value = fake_clip

    fake_image_clip = MagicMock(return_value=fake_clip)

    fake_composite = MagicMock()
    fake_composite.set_duration.return_value = fake_composite
    fake_composite.set_audio.return_value = fake_composite
    fake_composite.write_videofile = MagicMock()
    fake_composite.close = MagicMock()

    fake_module = types.ModuleType("moviepy.editor")
    fake_module.AudioFileClip = MagicMock(return_value=fake_audio)
    fake_module.ImageClip = fake_image_clip
    fake_module.CompositeVideoClip = MagicMock(return_value=fake_composite)
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    # Spy on gradient render to confirm it is NOT called when scene_assets are present.
    gradient_calls = {"n": 0}

    def _spy(*a, **kw):
        gradient_calls["n"] += 1

    monkeypatch.setattr(composer, "_render_gradient_background", _spy)

    img1 = tmp_path / "scene_01.png"
    img1.write_bytes(b"x")
    img2 = tmp_path / "scene_02.png"
    img2.write_bytes(b"y")
    assets = [
        composer.SceneAsset(image_path=img1, start_s=0.0, duration_s=3.0),
        composer.SceneAsset(image_path=img2, start_s=3.0, duration_s=3.0),
    ]

    composer.make_short(audio, out, scene_assets=assets, captions=None)

    assert gradient_calls["n"] == 0
    # Two ImageClip calls — one per scene asset, no gradient.
    assert fake_image_clip.call_count == 2
    # No bg.png was created, so cleanup is a no-op.
    assert not out.with_suffix(".bg.png").exists()


# ─── PR-A5: video_scene_assets path (per-scene VideoFileClip) ───────────────


def _install_video_moviepy_stub(monkeypatch, *, source_duration: float = 6.0):
    """Install a fake ``moviepy.editor`` module exposing the bits
    ``_video_scene_clips`` needs (``VideoFileClip`` + ``vfx.loop``).

    Returns a tuple ``(fake_module, source_clip_factory)`` where
    ``source_clip_factory`` produces a fresh ``MagicMock`` per call —
    one clip per :class:`VideoSceneAsset`.
    """
    created: list[MagicMock] = []

    def _make_source(*args, **kwargs):
        clip = MagicMock()
        clip.duration = source_duration
        clip.w = 640
        clip.h = 480
        # All chainable methods return the same MagicMock so we can
        # assert against the final state.
        for method in (
            "without_audio",
            "subclip",
            "fx",
            "resize",
            "set_start",
            "set_duration",
            "set_position",
            "close",
        ):
            getattr(clip, method).return_value = clip
        created.append(clip)
        return clip

    fake_module = types.ModuleType("moviepy.editor")
    fake_module.VideoFileClip = MagicMock(side_effect=_make_source)
    # vfx.loop is just sentinel-passed to ``.fx()`` — its identity
    # doesn't matter for our assertions.
    fake_vfx = types.SimpleNamespace(loop="LOOP_FX")
    fake_module.vfx = fake_vfx
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)
    return fake_module, created


def test_video_scene_clips_creates_one_clip_per_asset(monkeypatch, tmp_path):
    fake_module, created = _install_video_moviepy_stub(
        monkeypatch, source_duration=6.0
    )

    v1 = tmp_path / "scene_01.mp4"
    v1.write_bytes(b"x")
    v2 = tmp_path / "scene_02.mp4"
    v2.write_bytes(b"y")
    assets = [
        composer.VideoSceneAsset(video_path=v1, start_s=0.0, duration_s=4.0),
        composer.VideoSceneAsset(video_path=v2, start_s=4.0, duration_s=3.0),
    ]

    clips = composer._video_scene_clips(
        assets, opts=composer.ComposerOptions(), total_duration=7.0
    )

    assert len(clips) == 2
    assert fake_module.VideoFileClip.call_count == 2
    # Source duration (6s) >= requested 4s → use subclip(0, 4.0) trim path.
    created[0].subclip.assert_called_with(0, 4.0)
    # Same for the second scene (6s >= 3s).
    created[1].subclip.assert_called_with(0, 3.0)
    # Both clips end up positioned at center,center.
    for clip in created:
        clip.set_position.assert_called_with(("center", "center"))


def test_video_scene_clips_loops_short_source(monkeypatch, tmp_path):
    """Source shorter than requested duration → loop via ``vfx.loop``."""
    fake_module, created = _install_video_moviepy_stub(
        monkeypatch, source_duration=2.0
    )

    v = tmp_path / "scene.mp4"
    v.write_bytes(b"x")
    assets = [composer.VideoSceneAsset(video_path=v, start_s=0.0, duration_s=6.0)]

    composer._video_scene_clips(
        assets, opts=composer.ComposerOptions(), total_duration=10.0
    )

    # Should have called ``.fx(vfx.loop, duration=6.0)`` instead of subclip.
    created[0].fx.assert_called_with("LOOP_FX", duration=6.0)
    created[0].subclip.assert_not_called()


def test_video_scene_clips_clamps_overflow_to_total_duration(monkeypatch, tmp_path):
    fake_module, created = _install_video_moviepy_stub(
        monkeypatch, source_duration=10.0
    )
    v = tmp_path / "scene.mp4"
    v.write_bytes(b"x")
    assets = [composer.VideoSceneAsset(video_path=v, start_s=4.0, duration_s=10.0)]

    composer._video_scene_clips(
        assets, opts=composer.ComposerOptions(), total_duration=5.0
    )

    duration_arg = created[0].set_duration.call_args.args[0]
    assert duration_arg == pytest.approx(1.0)


def test_video_scene_clips_skips_zero_duration(monkeypatch, tmp_path):
    fake_module, created = _install_video_moviepy_stub(monkeypatch)
    v = tmp_path / "scene.mp4"
    v.write_bytes(b"x")
    assets = [composer.VideoSceneAsset(video_path=v, start_s=0.0, duration_s=0.0)]

    clips = composer._video_scene_clips(
        assets, opts=composer.ComposerOptions(), total_duration=5.0
    )
    assert clips == []
    fake_module.VideoFileClip.assert_not_called()


def test_video_scene_clips_skips_unprobeable_sources(monkeypatch, tmp_path):
    """A source clip whose ``.duration`` is ``None`` (probe failed) is
    silently dropped — no exception, no clip emitted.
    """
    created: list[MagicMock] = []

    def _make_source(*a, **kw):
        clip = MagicMock()
        clip.duration = None
        clip.w = 640
        clip.h = 480
        for method in ("without_audio", "close"):
            getattr(clip, method).return_value = clip
        created.append(clip)
        return clip

    fake_module = types.ModuleType("moviepy.editor")
    fake_module.VideoFileClip = MagicMock(side_effect=_make_source)
    fake_module.vfx = types.SimpleNamespace(loop="LOOP_FX")
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    v = tmp_path / "broken.mp4"
    v.write_bytes(b"x")
    clips = composer._video_scene_clips(
        [composer.VideoSceneAsset(video_path=v, start_s=0.0, duration_s=2.0)],
        opts=composer.ComposerOptions(),
        total_duration=5.0,
    )
    assert clips == []
    created[0].close.assert_called_once()


def test_make_short_video_assets_take_priority_over_image_assets(monkeypatch, tmp_path):
    """When both ``video_scene_assets`` and ``scene_assets`` are passed,
    only the video path runs (no Ken-Burns'd ImageClips).
    """
    audio = tmp_path / "v.mp3"
    audio.write_bytes(b"fake-mp3")
    out = tmp_path / "out.mp4"

    fake_audio = MagicMock()
    fake_audio.duration = 6.0
    fake_audio.close = MagicMock()

    video_clip = MagicMock()
    video_clip.duration = 6.0
    video_clip.w = 640
    video_clip.h = 480
    for method in (
        "without_audio",
        "subclip",
        "fx",
        "resize",
        "set_start",
        "set_duration",
        "set_position",
    ):
        getattr(video_clip, method).return_value = video_clip

    fake_image_clip_factory = MagicMock()  # should never fire

    fake_composite = MagicMock()
    fake_composite.set_duration.return_value = fake_composite
    fake_composite.set_audio.return_value = fake_composite
    fake_composite.write_videofile = MagicMock()
    fake_composite.close = MagicMock()

    fake_module = types.ModuleType("moviepy.editor")
    fake_module.AudioFileClip = MagicMock(return_value=fake_audio)
    fake_module.ImageClip = fake_image_clip_factory
    fake_module.VideoFileClip = MagicMock(return_value=video_clip)
    fake_module.vfx = types.SimpleNamespace(loop="LOOP_FX")
    fake_module.CompositeVideoClip = MagicMock(return_value=fake_composite)
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    monkeypatch.setattr(
        composer, "_render_gradient_background", lambda *a, **k: None
    )

    img = tmp_path / "scene_01.png"
    img.write_bytes(b"x")
    video = tmp_path / "scene_01.mp4"
    video.write_bytes(b"y")

    composer.make_short(
        audio,
        out,
        scene_assets=[
            composer.SceneAsset(image_path=img, start_s=0.0, duration_s=6.0),
        ],
        video_scene_assets=[
            composer.VideoSceneAsset(video_path=video, start_s=0.0, duration_s=6.0),
        ],
        captions=None,
    )

    # Video path ran exactly once.
    assert fake_module.VideoFileClip.call_count == 1
    # Image path did NOT run despite ``scene_assets`` being passed.
    fake_image_clip_factory.assert_not_called()


# ─── Path overlap test for caption layout (math, not rendering) ─────────────
def test_caption_clips_position_and_timing_math(monkeypatch):
    """Verify start/duration/y-offset are correctly applied to each caption clip."""
    fake_clip = MagicMock()
    for method in ("set_start", "set_duration", "set_position"):
        getattr(fake_clip, method).return_value = fake_clip

    fake_image_clip = MagicMock(return_value=fake_clip)
    fake_module = types.ModuleType("moviepy.editor")
    fake_module.ImageClip = fake_image_clip
    monkeypatch.setitem(sys.modules, "moviepy.editor", fake_module)

    monkeypatch.setattr(composer, "_pil_to_array", lambda img: object())

    captions = [
        Caption(start_s=0.0, end_s=1.0, text="alpha"),
        Caption(start_s=1.0, end_s=2.5, text="beta gamma"),
    ]
    composer._caption_clips(captions, opts=composer.ComposerOptions(), style=get_style("violet-pink"))

    # Each caption produced one clip with set_start / set_duration matching its window.
    assert fake_clip.set_start.call_args_list[0].args == (0.0,)
    assert fake_clip.set_start.call_args_list[1].args == (1.0,)
    assert fake_clip.set_duration.call_args_list[0].args == (1.0,)
    assert fake_clip.set_duration.call_args_list[1].args == (1.5,)
    # Position is anchored at horizontal center, with bottom margin from options.
    pos = fake_clip.set_position.call_args_list[0].args[0]
    assert pos[0] == "center"
    assert isinstance(pos[1], int) and pos[1] > 0
