# Full pipeline E2E — research → studio → storyboard → AutoGrok → compose

End-to-end smoke test for the *entire* creator-forge stack: research a niche,
draft a script in Studio, break it into scenes, generate per-scene images via
AutoGrok, and compose a 9:16 mp4 with the **real Grok-generated images**
splicing the gradient placeholder.

This is the natural follow-on to [`e2e-autogrok-image.md`](e2e-autogrok-image.md),
which only validates the AutoGrok image-generation slice in isolation. **Run
the AutoGrok harness first** to confirm your Grok session works before driving
the full pipeline.

---

## Why local

`accounts.x.ai/sign-in` is gated by Cloudflare and rejects most datacenter
IPs (including Devin's Azure VM, GitHub Actions, etc.). The full pipeline
must run on a residential IP that can complete a manual Grok login.

`grok.com` itself (where the Imagine WebSocket lives) is generally reachable,
so once you have a valid session in `GROK_PROFILE_DIR` you can run repeatedly
without re-logging-in.

---

## Prerequisites

- Node.js 20 LTS
- Python 3.11+ (sidecar uses FastAPI)
- Google Chrome / Microsoft Edge (Puppeteer launches the system browser via
  `executablePath`)
- A working Grok / X account
- `DEEPSEEK_API_KEY` set in the sidecar environment — required for the
  research / studio / storyboard LLM steps. Without it those steps return
  empty payloads + warnings (won't 500, but you'll have nothing to compose).

```bash
export DEEPSEEK_API_KEY="..."
```

---

## Setup (once)

```bash
git clone https://github.com/quyenmanhnguyen/creator-forge.git
cd creator-forge

# Sidecar deps (FastAPI + research/core/pixelle)
python -m venv .venv
. .venv/bin/activate    # or: .venv\Scripts\activate on Windows
pip install -r research/requirements.txt
pip install Pillow      # required by composer; see CI

# Desktop deps (Puppeteer + Electron services)
cd desktop
npm install
cd ..

# Persistent Grok profile (cookies survive across runs)
export GROK_PROFILE_DIR="$HOME/.creator-forge/grok-profile"
```

---

## Step 1 — Validate the AutoGrok slice first

If you haven't already, follow [`e2e-autogrok-image.md`](e2e-autogrok-image.md)
to log in and confirm AutoGrok image generation works:

```bash
node scripts/e2e_autogrok_image.js
```

Expected: 4+ images in `e2e-output/<timestamp>/`, each ≥ 50 KB, exit 0. The
Grok session is now persisted in `GROK_PROFILE_DIR`.

---

## Step 2 — Drive the full pipeline

The pipeline composes through three layers:

| Layer | Endpoint / IPC | Output |
| --- | --- | --- |
| Research | `/research/niche`, `/keywords/...` | niche / keyword candidates |
| Studio | `/studio/topics → titles → outline → script` | finalized narration script |
| Storyboard | `/producer/scene_breakdown` | `scenes[]` with `image_prompt` + `flow_video_prompt` + `duration_s` |
| AutoGrok | `image:generate` IPC → `ImageService.generateBatch` | one ≥50KB image per scene saved on disk |
| Compose | `/producer/short` (with `scene_assets`) | `short.mp4` with per-scene images instead of gradient |

The new piece in this pipeline is **`StoryboardBridge.composeWithScenes`**
(introduced in PR-14). It orchestrates the AutoGrok → compose handoff:

1. Filters scenes that have a non-empty `image_prompt` and a positive `duration_s`.
2. Calls `image:generate` once with all surviving prompts and forces
   `imageGenerationCount=1` (the composer only consumes one hero per scene).
3. For each scene, picks the first `savedFiles[]` entry whose on-disk size is
   ≥ 50 KB (PR-9 blur threshold). Anything smaller is a moderation /
   blur placeholder and gets skipped with a warning.
4. Computes cumulative `start_s` from each scene's `duration_s` so the
   composer pins each image to the correct window of the audio timeline.
5. Calls `producer:composeShort` IPC with the resolved `scene_assets[]`.
   The sidecar's `/producer/short` route applies the existing TTS +
   captions pipeline and Ken-Burns'es each image instead of the gradient.

### Driving the pipeline from the UI (PR-16)

The Storyboard tab now exposes a **"Compose with AutoGrok"** panel that
wraps the same orchestration as `StoryboardBridge.composeWithScenes`:

1. Studio → write/humanize a script → click **Send script → Storyboard**.
2. Storyboard tab → fill the form (template / language / scene count /
   WPM) → click **Break into scenes**. The renderer captures the latest
   `scenes[]` in memory.
3. Scroll to **Compose with AutoGrok** → pick a voice / gradient style /
   optional aspect ratio / **Max attempts per scene** (default 2) /
   **Allow partial compose** (default on) → click
   **Compose with AutoGrok**.
4. The result card shows `scenes_used`, `scenes_missing`, **`retry_count`**,
   **per-scene status** (`generated` / `retried` / `skipped` / `fallback`),
   the resolved `scene_assets[]` (per-scene `image_path` + window), the
   output folder, and any warnings.

Loading state explicitly flips between phases so you can tell whether
the slow part is image generation or the ffmpeg compose:

- *"Generating N Grok image(s) — attempt 1 / M (this can take 30–120s,
  requires an active Grok session)..."*
- *"Retrying K scene(s) that didn't produce a usable image — attempt
  2 / M..."* — only when one or more scenes were rejected on attempt 1
  (PR-17 retry).
- *"Composing 9:16 mp4 (TTS + captions + Ken Burns over Grok images)..."*

Friendly errors call out the most common pitfalls (no scenes captured,
empty script, no Grok session, every image < 50 KB after retries)
instead of throwing into the renderer console.

#### Retry behaviour and partial compose (PR-17)

The orchestrator behind the button (`orchestrateImageGenerationWithRetries`
in `desktop/dist/storyboard_compose_helpers.js`) tracks per-scene state
across attempts:

| Status     | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `generated`| Got a ≥ 50 KB image on attempt 1.                                  |
| `retried`  | Got a ≥ 50 KB image on attempt ≥ 2 after a failure on attempt 1.   |
| `skipped`  | Missing `image_prompt` or non-positive `duration_s` (never sent).  |
| `fallback` | Exhausted all `max_attempts` without a ≥ 50 KB result.             |

Only the failed scenes are re-sent to `image:generate` on retry — scenes
that already produced a usable image are NOT regenerated. The retry
attempt counts toward `retry_count` exposed on the result.

**Allow partial compose** controls what happens when one or more scenes
end up in `fallback`:

- **on** (default): the composer runs anyway. Fallback scenes are
  gradient-filled (violet-pink / sunset / etc) inside the mp4 using the
  audio timeline window that scene would have occupied. `scenes_missing`
  reflects the count of fallback scenes.
- **off** (strict): the bridge throws `INCOMPLETE_BATCH` instead of
  composing. The renderer surfaces it as
  *"K scene(s) missing usable images after M attempt(s) and 'Allow
  partial compose' is off — aborting before composer."*. Use this when
  you specifically want the run to fail loudly so you can refresh the
  Grok session and retry. The `compose` IPC is not invoked.

### Driving the pipeline from the renderer DevTools

If you'd rather call the bridge yourself (e.g. when scripting the UI),
the same orchestration is available:

```js
// Run inside the Electron renderer DevTools (F12 from the app window):
const StoryboardBridge = require('./src/bridges/StoryboardBridge');
const bridge = new StoryboardBridge(window.electronAPI);

// 1. Pick a script (anything Studio produced will work)
const script = `<paste the script.md output from Studio here>`;

// 2. Break into scenes
const breakdown = await bridge.fromScript({
  script,
  template_key: 'cinematic',
  language: 'en',
});
console.log('scenes:', breakdown.scenes.length);

// 3. Generate images + compose with real Grok visuals
const result = await bridge.composeWithScenes({
  script,
  scenes: breakdown.scenes,
  voice: 'en-US-AriaNeural',
  style: 'violet-pink',
});
console.log('mp4:', result.compose.mp4_path);
console.log('scenes_used:', result.compose.scenes_used);
console.log('scenes_missing:', result.compose.scenes_missing);
console.log('skipped:', result.skippedScenes);
```

The mp4 lands in `~/.creator-forge/output/short-<timestamp>/short.mp4` by
default.

---

## What success looks like

A successful run produces:

```
~/.creator-forge/output/short-1717182000123/
├── voice.mp3        # Edge-TTS narration
├── captions.srt     # word-boundary captions (or sentence fallback)
└── short.mp4        # 9:16 with per-scene Grok backgrounds
```

The composed mp4 should:

- Open at 1080×1920 @ 30 fps
- Have audible narration matching the script
- Cycle through one Grok-generated background image per scene, each
  Ken-Burns'd over its `duration_s` window
- **NOT** show the violet/sunset/etc gradient (that's the placeholder
  fallback — its presence means images are missing or all under 50KB).

`ShortResponse.scenes_used` should equal the number of scenes that
produced a usable image, and `ShortResponse.scenes_missing` should be 0
on a healthy run.

---

## Troubleshooting

### `scenes_used = 0` even though `image:generate` succeeded

Every saved file is < 50 KB across all retries. Either Grok flagged your
prompts and returned blurred / moderation placeholders, or the WebSocket
disconnected before the high-resolution upsampler finished. Check
`result.perSceneStatus` (PR-17) for the per-scene reason.

Mitigations:

1. **Bump Max attempts per scene** to 3 — the orchestrator only re-sends
   the prompts that failed, so this just adds one or two more chances
   without re-running successful scenes.
2. Re-run the whole flow — Grok occasionally flakes, especially during
   the upsampler stage. The persistent profile means no re-login needed.
3. Soften the `image_prompt` text (avoid words that trigger the
   moderation classifier).
4. Confirm `enablePro: false` is in effect (Pro mode rate-limits to 1
   image per request — verified by PR-9).

### Some scenes show `status: retried` in the result card

Expected — those scenes failed on attempt 1 (blur/moderation) and
succeeded on attempt 2. The mp4 still uses the retry's image, so
nothing's wrong. If you see this consistently for the same scene, see
the mitigations above.

### Some scenes show `status: fallback`

Those scenes exhausted `max_attempts` without producing a ≥ 50 KB image.
What happens next depends on **Allow partial compose**:

- **on** (default) — the mp4 was still produced, with gradient backgrounds
  for the fallback scenes during their audio windows. Look at
  `warnings[]` in the result card for the specific count
  (`N scene(s) fell back to gradient...`). If you don't want this, flip
  the toggle off and re-run.
- **off** (strict) — the renderer aborted before composing. No mp4 is
  produced. Refresh your Grok session (`scripts/e2e_autogrok_image.js`)
  or soften the prompts and re-run.

### `image:generate IPC failed` warning, gradient mp4

The Electron app couldn't reach Grok at all. Most common causes:

- No active session — re-run `node scripts/e2e_autogrok_image.js` to
  re-establish login.
- Cloudflare flagged your IP — uncommon on residential IPs but possible.
  Wait an hour and retry.
- `GROK_PROFILE_DIR` doesn't have a logged-in profile — verify the
  directory contains a `Default/Cookies` SQLite ≥ 4 KB.

### `compose_short` returns `mp4_path: ""` but `audio_path` is set

TTS succeeded, the composer raised. Check `compose.warnings[]` — the
exception type + message is appended verbatim. Common cases:

- `Pillow` not installed (`pip install Pillow`)
- moviepy can't find the bundled ffmpeg (`pip install --force-reinstall imageio-ffmpeg`)

### Some `scene_assets` got skipped: `file not found`

The AutoGrok image-generate finished after `composeWithScenes` collected
its `savedFiles[]`, or the file was deleted between the IPC return and
the sidecar's existence check. Ordinarily this can't happen — the
saves are synchronous and on the same machine. If you see this, please
file an issue with `result.imageGenerate` attached.

### `scenes_missing > 0` warnings list multiple `does not exist` entries

You're driving `composeWithScenes` from a renderer that can't reach the
file paths the Electron main process wrote (e.g. running the bridge in
a sandboxed test harness). Use the renderer DevTools inside the actual
Electron window instead.

---

## Verifying with a single-shot script (CI / non-interactive)

If you'd like to drive the compose half from a Node script outside Electron —
e.g. right after `scripts/e2e_autogrok_image.js` succeeds — use the bundled
helper:

```bash
node scripts/e2e_compose_with_scene_assets.js \
  --input-dir e2e-output/<timestamp>
```

The helper:

1. Picks every `*.jpg` / `*.jpeg` / `*.png` / `*.webp` from `--input-dir`
   that's ≥ 50 KB (PR-9 blur threshold), sorted by basename.
2. Probes `http://127.0.0.1:5050/healthz`. If a creator-forge sidecar is
   already running it reuses it; otherwise it spawns one via
   `desktop/electron/researchSidecar.js` and tears it down on exit.
3. Builds `scene_assets[]` with cumulative `start_s` from a uniform
   per-scene duration (`--duration`, default 4 seconds).
4. POSTs `/producer/short` with the resolved `scene_assets[]`.
5. Asserts `mp4_path` non-empty, `scenes_used == len(scene_assets)`,
   `scenes_missing == 0`, `warnings == []`. Exit codes (`0` ok, `2` no
   usable images, `3` sidecar unhealthy, `4` mp4 not produced, `5`
   missing/warnings, `6` count mismatch) make it scriptable as a CI gate.

Common overrides:

| Flag | Purpose | Default |
| --- | --- | --- |
| `--script <text>` / `--script-file <path>` | Replace the built-in 5-sentence smoke script. | A fixed 5-sentence intro |
| `--voice <name>` | Edge-TTS voice short name. | `en-US-AriaNeural` |
| `--style <name>` | Gradient style fallback (only used if compose falls back). | `violet-pink` |
| `--duration <seconds>` | Per-scene `duration_s`. | `4` |
| `--limit <n>` | Use only the first N images (e.g. for a 2-image smoke test from a 4-image AutoGrok output). | unlimited |
| `--port <n>` | Sidecar port. | `$CREATOR_FORGE_RESEARCH_PORT` or `5050` |
| `--keep-sidecar` | Don't tear down the sidecar on exit. | tears down |
| `--allow-partial` (PR-17) | Treat `scenes_missing > 0` and non-empty `warnings[]` as advisory notices instead of failures. `mp4_path` empty is still a failure. Useful when intentionally testing the gradient-fallback path. | strict (off) |

If you'd rather drive `/producer/short` by hand, the equivalent curl looks
like this — useful when iterating on the request shape:

```bash
# 1. Start the sidecar (in a separate terminal)
. .venv/bin/activate
DEEPSEEK_API_KEY=... uvicorn research.api.main:create_app --factory --reload

# 2. POST a request directly
curl -X POST http://127.0.0.1:5050/producer/short \
  -H 'Content-Type: application/json' \
  -d '{
    "script": "Welcome to creator-forge. This is scene one. And this is scene two.",
    "voice": "en-US-AriaNeural",
    "style": "violet-pink",
    "scene_assets": [
      {"image_path": "/abs/path/to/image_01.jpg", "start_s": 0.0, "duration_s": 3.0},
      {"image_path": "/abs/path/to/image_02.jpg", "start_s": 3.0, "duration_s": 4.0}
    ]
  }'
```

Use `e2e-output/<ts>/image_*.jpg` from the AutoGrok harness as
`scene_assets[]`. The response includes `mp4_path`, `scenes_used`,
`scenes_missing`, and `warnings[]`.
