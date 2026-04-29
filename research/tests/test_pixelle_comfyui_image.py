"""Tests for :mod:`core.pixelle.comfyui_image` and the new HTTP helpers
in :mod:`core.pixelle.comfy_client` (PR-A3.1).

We don't talk to a real ComfyUI server — every external call is
monkeypatched on the ``requests`` module the same way
``test_pixelle_comfy.py`` does it.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import requests

from core.pixelle import comfy_client, comfyui_image
from core.pixelle.comfy_client import ComfyUIError
from core.pixelle.prompting import ScenePrompt


# ─── Fixtures ────────────────────────────────────────────────────────────────


def _scene() -> ScenePrompt:
    return ScenePrompt(
        scene_id=1,
        duration=4.0,
        narration="hello world",
        image_prompt="a cinematic robot painting at golden hour",
        video_prompt="slow dolly-in",
        negative_prompt="lowres, watermark",
        style_notes="cinematic; amber+teal palette",
        aspect_ratio="9:16",
    )


class _Resp:
    def __init__(
        self,
        *,
        status: int = 200,
        json_data: dict | None = None,
        content: bytes = b"",
    ) -> None:
        self.status_code = status
        self._json = json_data if json_data is not None else {}
        self.content = content

    def json(self) -> dict:
        return self._json

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")


# ─── splice_workflow ─────────────────────────────────────────────────────────


def test_splice_substitutes_known_sentinels():
    workflow = comfyui_image.load_workflow()
    spliced = comfyui_image.splice_workflow(
        workflow,
        positive="my positive prompt",
        negative="my negative prompt",
        seed=12345,
        width=1080,
        height=1920,
        checkpoint="my-model.safetensors",
    )

    # Positive / negative replaced as full-string values.
    assert spliced["6"]["inputs"]["text"] == "my positive prompt"
    assert spliced["7"]["inputs"]["text"] == "my negative prompt"
    # Seed coerced to int.
    assert spliced["3"]["inputs"]["seed"] == 12345
    # Width / height coerced to int.
    assert spliced["5"]["inputs"]["width"] == 1080
    assert spliced["5"]["inputs"]["height"] == 1920
    # Checkpoint replaced.
    assert spliced["4"]["inputs"]["ckpt_name"] == "my-model.safetensors"


def test_splice_does_not_mutate_input():
    workflow = comfyui_image.load_workflow()
    original_seed = workflow["3"]["inputs"]["seed"]
    comfyui_image.splice_workflow(
        workflow,
        positive="p",
        negative="n",
        seed=42,
    )
    assert workflow["3"]["inputs"]["seed"] == original_seed  # untouched


def test_splice_handles_sentinels_inside_strings():
    workflow = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "text": "prefix __POSITIVE_PROMPT__ suffix",
                "clip": ["x", 0],
            },
        }
    }
    spliced = comfyui_image.splice_workflow(
        workflow, positive="HELLO", negative="bad", seed=1
    )
    assert spliced["1"]["inputs"]["text"] == "prefix HELLO suffix"
    # List values pass through unchanged.
    assert spliced["1"]["inputs"]["clip"] == ["x", 0]


def test_splice_skips_missing_checkpoint_sentinel():
    workflow = {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "manual.safetensors"},
        }
    }
    spliced = comfyui_image.splice_workflow(
        workflow, positive="p", negative="n", seed=1, checkpoint=None
    )
    # checkpoint=None means the sentinel isn't applied → existing value
    # is preserved.
    assert spliced["1"]["inputs"]["ckpt_name"] == "manual.safetensors"


def test_load_workflow_uses_bundled_default():
    workflow = comfyui_image.load_workflow()
    # Bundled default has 6→9 nodes (KSampler, CheckpointLoaderSimple,
    # EmptyLatentImage, two CLIPTextEncode, VAEDecode, SaveImage).
    assert {"3", "4", "5", "6", "7", "8", "9"}.issubset(workflow.keys())


def test_load_workflow_rejects_non_object(tmp_path: Path):
    bad = tmp_path / "bad.json"
    bad.write_text("[1, 2, 3]")
    with pytest.raises(ComfyUIError):
        comfyui_image.load_workflow(bad)


# ─── comfy_client HTTP helpers ───────────────────────────────────────────────


def test_is_local_alive_true_on_200(monkeypatch):
    monkeypatch.setattr(comfy_client.requests, "get", lambda *a, **kw: _Resp(status=200))
    assert comfy_client.is_local_alive("http://x:8188") is True


def test_is_local_alive_false_on_request_exception(monkeypatch):
    def _boom(*a, **kw):
        raise requests.ConnectionError("nope")

    monkeypatch.setattr(comfy_client.requests, "get", _boom)
    assert comfy_client.is_local_alive("http://x:8188") is False


def test_wait_for_history_returns_entry_when_outputs_present(monkeypatch):
    payload = {
        "abc-123": {
            "outputs": {
                "9": {
                    "images": [
                        {"filename": "scene_00001.png", "subfolder": "", "type": "output"}
                    ]
                }
            },
            "status": {"completed": True},
        }
    }
    monkeypatch.setattr(
        comfy_client.requests, "get",
        lambda *a, **kw: _Resp(status=200, json_data=payload),
    )
    entry = comfy_client.wait_for_history(
        "http://x:8188", "abc-123", poll_interval=0.0, timeout=1.0
    )
    assert "outputs" in entry
    assert entry["outputs"]["9"]["images"][0]["filename"] == "scene_00001.png"


def test_wait_for_history_times_out_when_entry_never_appears(monkeypatch):
    monkeypatch.setattr(
        comfy_client.requests, "get",
        lambda *a, **kw: _Resp(status=200, json_data={}),
    )
    with pytest.raises(ComfyUIError, match="did not finish"):
        comfy_client.wait_for_history(
            "http://x:8188", "missing", poll_interval=0.0, timeout=0.05
        )


def test_fetch_view_bytes_returns_content(monkeypatch):
    monkeypatch.setattr(
        comfy_client.requests, "get",
        lambda *a, **kw: _Resp(status=200, content=b"PNGDATA"),
    )
    data = comfy_client.fetch_view_bytes(
        "http://x:8188",
        filename="scene_00001.png",
        subfolder="",
        folder_type="output",
    )
    assert data == b"PNGDATA"


# ─── generate_scene_image (orchestrator) ─────────────────────────────────────


def test_generate_scene_image_happy_path(monkeypatch, tmp_path: Path):
    output = tmp_path / "scene_01.png"

    monkeypatch.setattr(comfy_client, "is_local_alive", lambda *a, **kw: True)
    monkeypatch.setattr(
        comfy_client, "submit_local_workflow",
        lambda *a, **kw: "prompt-xyz",
    )
    monkeypatch.setattr(
        comfy_client, "wait_for_history",
        lambda *a, **kw: {
            "outputs": {
                "9": {
                    "images": [
                        {"filename": "scene.png", "subfolder": "sub", "type": "output"}
                    ]
                }
            }
        },
    )
    monkeypatch.setattr(
        comfy_client, "fetch_view_bytes", lambda *a, **kw: b"FAKE_PNG"
    )

    path = comfyui_image.generate_scene_image(
        _scene(),
        output_path=output,
        base_url="http://127.0.0.1:8188",
        seed=99,
        checkpoint=None,  # leaves the sentinel; harmless for this mock
    )
    assert path == output.resolve()
    assert output.read_bytes() == b"FAKE_PNG"


def test_generate_scene_image_raises_when_server_down(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(comfy_client, "is_local_alive", lambda *a, **kw: False)
    with pytest.raises(ComfyUIError, match="not reachable"):
        comfyui_image.generate_scene_image(
            _scene(),
            output_path=tmp_path / "x.png",
            base_url="http://127.0.0.1:8188",
        )


def test_generate_scene_image_raises_when_no_images_in_history(
    monkeypatch, tmp_path: Path
):
    monkeypatch.setattr(comfy_client, "is_local_alive", lambda *a, **kw: True)
    monkeypatch.setattr(
        comfy_client, "submit_local_workflow",
        lambda *a, **kw: "prompt-xyz",
    )
    monkeypatch.setattr(
        comfy_client, "wait_for_history",
        lambda *a, **kw: {"outputs": {"9": {"images": []}}},
    )
    with pytest.raises(ComfyUIError, match="produced no images"):
        comfyui_image.generate_scene_image(
            _scene(),
            output_path=tmp_path / "x.png",
            base_url="http://127.0.0.1:8188",
            checkpoint=None,
        )
