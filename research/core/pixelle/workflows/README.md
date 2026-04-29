# Bundled ComfyUI workflows

These JSON files are the default workflows Tube Atlas Producer ships with.
They are vanilla ComfyUI graphs with **sentinel strings** in the inputs that
`core.pixelle.comfyui_image.splice_workflow()` substitutes at runtime:

| Sentinel                  | Replacement                                      |
| ------------------------- | ------------------------------------------------ |
| `__POSITIVE_PROMPT__`     | The scene's `image_prompt` (PR-A3 generator).    |
| `__NEGATIVE_PROMPT__`     | The scene's `negative_prompt`.                   |
| `__SEED__`                | Integer seed (random per scene unless fixed).    |
| `__WIDTH__` / `__HEIGHT__`| Output resolution (default 1080×1920 for 9:16).  |
| `__CHECKPOINT__`          | `.safetensors` / `.ckpt` model name on the host. |

## Why sentinels (not "find this node by id")?

Workflow JSONs are graph data — node IDs are stable per-file but not
across files. Using string sentinels means:

1. Users can swap in their own workflows without touching Python code,
   as long as they keep the same sentinels.
2. Splicing is a single dict-walk; no graph parsing required.
3. The bundled workflow stays small and readable.

## `default_txt2img.json`

A minimal SD-style txt2img graph: `CheckpointLoaderSimple` → CLIP →
KSampler → VAEDecode → SaveImage. 20 steps, cfg 7, euler/normal —
sane defaults for portrait 1080×1920. The user's installed checkpoint
must match `__CHECKPOINT__`; the Producer UI exposes this so it can be
overridden without editing JSON.

## Bring-your-own workflow

Drop a custom workflow JSON anywhere on disk and point the Producer
"Workflow file" picker at it. As long as the sentinels above are
present, splicing will work. Any sentinel not present in your workflow
is simply skipped — so you can omit `__CHECKPOINT__` if your graph
hard-codes the model.
