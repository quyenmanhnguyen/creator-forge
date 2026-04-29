"""High-level image generation against a local ComfyUI instance.

This wraps the thin HTTP layer in :mod:`core.pixelle.comfy_client` with
the bits Tube Atlas Producer needs:

- Load a workflow JSON template (bundled or user-supplied).
- Splice scene-specific values (positive / negative prompt, seed, size,
  checkpoint) into known sentinel strings.
- Submit → poll → download → write to disk.

The only public entry point is :func:`generate_scene_image`. It always
returns a :class:`pathlib.Path` to the saved PNG, or raises
:class:`core.pixelle.comfy_client.ComfyUIError` (subclass of
``RuntimeError``) on any failure. Callers — typically
:class:`core.pixelle.visual_providers.ComfyUIVisualProvider` — translate
that into :class:`UsePlaceholderFallback` so the Producer page can fall
back to gradient + Ken Burns without crashing.
"""
from __future__ import annotations

import json
import random
from copy import deepcopy
from pathlib import Path
from typing import Any

from core.pixelle import comfy_client
from core.pixelle.comfy_client import ComfyUIError
from core.pixelle.prompting import ScenePrompt

# Default Shorts canvas. Multiples of 8 (ComfyUI EmptyLatentImage requirement).
DEFAULT_WIDTH = 1080
DEFAULT_HEIGHT = 1920

# The bundled workflow shipped with the repo.
DEFAULT_WORKFLOW_PATH = (
    Path(__file__).parent / "workflows" / "default_txt2img.json"
)

# Sensible default checkpoint name; users can override via the UI / kwarg.
DEFAULT_CHECKPOINT = "v1-5-pruned-emaonly.safetensors"

# Sentinels recognised by :func:`splice_workflow`. Order doesn't matter;
# any sentinel not present in the workflow is silently ignored.
SENTINEL_POSITIVE = "__POSITIVE_PROMPT__"
SENTINEL_NEGATIVE = "__NEGATIVE_PROMPT__"
SENTINEL_SEED = "__SEED__"
SENTINEL_WIDTH = "__WIDTH__"
SENTINEL_HEIGHT = "__HEIGHT__"
SENTINEL_CHECKPOINT = "__CHECKPOINT__"


def load_workflow(path: Path | None = None) -> dict:
    """Load a workflow JSON from disk.

    Parameters
    ----------
    path:
        Path to a ComfyUI workflow JSON. If ``None``, the bundled
        :data:`DEFAULT_WORKFLOW_PATH` is used.
    """
    src = Path(path) if path is not None else DEFAULT_WORKFLOW_PATH
    with src.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ComfyUIError(f"Workflow {src} is not a JSON object")
    return data


def splice_workflow(
    workflow: dict,
    *,
    positive: str,
    negative: str,
    seed: int,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    checkpoint: str | None = DEFAULT_CHECKPOINT,
) -> dict:
    """Return a deep copy of *workflow* with scene values spliced in.

    Sentinels (see module-level constants) are replaced wherever they
    appear as a *value* in any node's ``inputs`` dict. Sentinels appearing
    inside larger strings are also replaced (handy for "your prompt: …"
    style templates). Width / height / seed sentinels are coerced to int
    when they're the entire value.
    """
    out = deepcopy(workflow)
    replacements: dict[str, Any] = {
        SENTINEL_POSITIVE: positive,
        SENTINEL_NEGATIVE: negative,
        SENTINEL_SEED: int(seed),
        SENTINEL_WIDTH: int(width),
        SENTINEL_HEIGHT: int(height),
    }
    if checkpoint is not None:
        replacements[SENTINEL_CHECKPOINT] = checkpoint

    for node in out.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, value in list(inputs.items()):
            inputs[key] = _replace_in_value(value, replacements)
    return out


def _replace_in_value(value: Any, replacements: dict[str, Any]) -> Any:
    """Recursively splice sentinels into *value*.

    - If *value* exactly equals a sentinel, return the typed replacement.
    - If *value* is a string containing a sentinel, do string substitution
      (the result is always a string — int sentinels become ``str(int)``).
    - Lists / tuples are walked element-wise; everything else passes
      through unchanged.
    """
    if isinstance(value, str):
        if value in replacements:
            return replacements[value]
        out = value
        for sentinel, repl in replacements.items():
            if sentinel in out:
                out = out.replace(sentinel, str(repl))
        return out
    if isinstance(value, list):
        return [_replace_in_value(v, replacements) for v in value]
    return value


def generate_scene_image(
    prompt: ScenePrompt,
    *,
    output_path: Path,
    base_url: str,
    workflow_path: Path | None = None,
    checkpoint: str | None = DEFAULT_CHECKPOINT,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    seed: int | None = None,
    poll_interval: float = 0.5,
    poll_timeout: float = 180.0,
    request_timeout: float = 30.0,
) -> Path:
    """Generate one scene image via a local ComfyUI server.

    Parameters
    ----------
    prompt:
        The :class:`ScenePrompt` whose ``image_prompt`` and
        ``negative_prompt`` get spliced into the workflow.
    output_path:
        Destination on disk. Parent directories are created. The file
        extension is preserved (typically ``.png``).
    base_url:
        ComfyUI base URL, e.g. ``"http://127.0.0.1:8188"``.
    workflow_path:
        Optional override for the bundled workflow JSON.
    checkpoint:
        ComfyUI ``ckpt_name`` to use. Pass ``None`` to leave the
        sentinel in place (only useful for tests).
    width, height:
        Output resolution. Defaults match the 9:16 Shorts canvas.
    seed:
        Optional fixed seed (for reproducible runs / debugging). When
        ``None``, a random 63-bit positive seed is picked per call.
    poll_interval, poll_timeout, request_timeout:
        Forwarded to :func:`core.pixelle.comfy_client.wait_for_history`
        and the underlying HTTP calls.

    Returns
    -------
    Path
        ``output_path`` (absolute) on success.

    Raises
    ------
    ComfyUIError
        For any failure (probe, submit, poll, download, missing outputs).
        Callers should treat this as an opaque "ComfyUI didn't deliver"
        signal and decide how to recover.
    """
    output_path = Path(output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not comfy_client.is_local_alive(base_url):
        raise ComfyUIError(f"ComfyUI not reachable at {base_url}")

    workflow = load_workflow(workflow_path)
    chosen_seed = int(seed) if seed is not None else random.randint(1, 2**63 - 1)
    spliced = splice_workflow(
        workflow,
        positive=prompt.image_prompt,
        negative=prompt.negative_prompt,
        seed=chosen_seed,
        width=width,
        height=height,
        checkpoint=checkpoint,
    )

    prompt_id = comfy_client.submit_local_workflow(
        base_url,
        spliced,
        client_id="tube-atlas-producer",
        timeout=request_timeout,
    )

    history = comfy_client.wait_for_history(
        base_url,
        prompt_id,
        poll_interval=poll_interval,
        timeout=poll_timeout,
        request_timeout=request_timeout,
    )

    image_meta = _first_image_from_history(history)
    if image_meta is None:
        raise ComfyUIError(
            f"ComfyUI prompt {prompt_id} finished but produced no images"
        )

    payload = comfy_client.fetch_view_bytes(
        base_url,
        filename=image_meta["filename"],
        subfolder=image_meta.get("subfolder", "") or "",
        folder_type=image_meta.get("type", "output") or "output",
        timeout=request_timeout,
    )
    output_path.write_bytes(payload)
    return output_path


def _first_image_from_history(history: dict) -> dict | None:
    """Pull the first image entry out of a ``/history`` response.

    ComfyUI's history payload nests outputs as
    ``{node_id: {"images": [{"filename": "...", "subfolder": "...", "type": "output"}, ...], ...}}``.
    We don't care which SaveImage node produced the image — just take
    the first one we find so the caller doesn't need to know node IDs.
    """
    outputs = history.get("outputs") or {}
    for node_outputs in outputs.values():
        if not isinstance(node_outputs, dict):
            continue
        images = node_outputs.get("images")
        if isinstance(images, list) and images:
            first = images[0]
            if isinstance(first, dict) and first.get("filename"):
                return first
    return None
