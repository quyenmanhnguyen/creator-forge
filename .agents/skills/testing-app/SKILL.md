# Testing creator-forge (Electron + Python sidecar + ffmpeg)

This skill documents the testing recipes for the creator-forge
pipeline (Research → Studio → Storyboard → AutoGrok → Compose →
Video Assembly). It covers what we've actually done and what works.

---
name: testing-app
description: End-to-end testing recipes for creator-forge — Electron + Python sidecar + ffmpeg pipeline. Use when verifying Storyboard, Compose, or Assembly changes through the desktop UI or curl-able sidecar endpoints.
---

## Architecture cheat-sheet

- **Sidecar**: Python FastAPI on `127.0.0.1:5050`. Source under
  `research/`. Started with
  `python -m uvicorn research.api.main:app --host 127.0.0.1 --port 5050`
  from the repo root.
- **Desktop**: Electron app under `desktop/`. Started with
  `cd desktop && npm start`. Spawns its own sidecar by default; for
  testing it's often easier to start the sidecar yourself first and
  then start Electron — the Electron sidecar manager will reuse the
  running one.
- **Visual pipeline**: Grok (Puppeteer-driven) generates scenes;
  each scene is an MP4. The final stage `/producer/assemble`
  concatenates scene MP4s with audio + optional captions into
  `final.mp4`.
- **Caption modes** (`caption_mode` field on `/producer/assemble`):
  - `soft` — captions attached as `mov_text` track (toggleable in
    players)
  - `none` — no captions
  - `burn` (PR-32) — captions rendered into the visible h264
    stream via ffmpeg's `subtitles=` filter

## Devin Secrets Needed

- `DEEPSEEK_API_KEY` — needed for Studio (topics, titles, outline,
  script, humanize) and `/producer/scene_breakdown`,
  `/producer/variant_prompts`.
- `GROK_ACCOUNTS_JSON` — needed for AutoGrok image / video / I2V /
  refimg generation. Path to an `accounts.json` with
  email + password for grok.com (sessions persist via
  `GROK_PROFILE_DIR`).
- `YOUTUBE_API_KEY` — needed for Research (niche, keywords,
  outlier).

Every test path **except** Compose Audio + Video Assembly needs at
least one of these. If the user wants to skip auth setup, prefer
testing Compose Audio (`/producer/audio` uses edge-tts which is
free) and `/producer/assemble` (which only needs ffmpeg) — those
two cover the most recently merged load-bearing changes (PR-30,
PR-31, PR-32). For **Storyboard renderer-only changes** (e.g. new
column, new badge, pairing display), see the `Storyboard
render-only testing (no Grok creds)` recipe below — that path
needs **zero** secrets.

## Setting up a temporary accounts.json for Grok testing

The Grok account file is loaded from `CREATOR_FORGE_ACCOUNTS_FILE`
if set, otherwise from Electron `userData`/`accounts.json`. For
session-scoped testing, build it from secrets and point Electron
at it before launch:

```bash
mkdir -p /tmp/cf-test
cat > /tmp/cf-test/accounts.json <<EOF
[{"email": "$GROK_TEST_EMAIL", "password": "$GROK_TEST_PASSWORD"}]
EOF
export CREATOR_FORGE_ACCOUNTS_FILE=/tmp/cf-test/accounts.json
cd desktop && npm start  # picks up env
```

After `Auto-login (programmatic)` in the Grok accounts panel, the
session persists in `<repo>/desktop/sessions/<email_safe>/`
(or under `GROK_PROFILE_DIR` if set). If a launch fails midway and
leaves a corrupt profile dir, just `rm -rf` it and retry.

## Skipping Grok auth: synthesize scene MP4s with testsrc

When testing `/producer/assemble` without going through the full
Grok pipeline, synthesize three short 9:16 scene MP4s with ffmpeg.
Use solid-color `color=` source + `sine=` audio so the scenes are
visually distinct (red → green → blue) and timestamps line up
with the narration.

```bash
mkdir -p /tmp/cf-scenes
cd /tmp/cf-scenes
for i in 1 2 3; do
  case $i in 1) dur=4; color=red;;   2) dur=3; color=green;; 3) dur=3; color=blue;; esac
  ffmpeg -y \
    -f lavfi -i "color=c=${color}:s=720x1280:d=${dur}:r=30" \
    -f lavfi -i "sine=frequency=$((220*i)):duration=${dur}" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
    "shot${i}.mp4"
done
```

Total 10s of video. The schema requires ≥1 scene + each scene
≥1KB + extension in `[mp4, mov, m4v, webm, mkv]`.

## Skipping login: real audio via /producer/audio (edge-tts)

```bash
curl -s -X POST http://127.0.0.1:5050/producer/audio \
  -H 'Content-Type: application/json' \
  -d '{"script": "This is a creator forge end to end test. We are checking that audio generation works. The final video assembly will stitch our scenes together."}'
```

Returns `audio_path` (mp3) + `srt_path` (3 caption blocks for a
3-sentence script) + `output_dir` (`~/.creator-forge/output/audio-<ts>/`).

## Storyboard render-only testing (no Grok creds)

When the change is **purely renderer** — a new column, badge,
button state, thumbnail layout, sort order, etc. — you do NOT need
Grok auth. The image/video pairing helpers (`pairImagePathsForI2V`,
`sbbResolveUrls`, `sbbRenderTable`) all run client-side, so a
DevTools harness with synthesized PNGs covers the full render path.

### Step 1 — synthesize visually-distinct PNGs (one per variant)

Use 4+ saturated colors so variant-aware pairing bugs are obvious
at a glance — if `pairImagePathsForI2V` regresses to scene-only,
you'll see two reds in one column instead of red+green.

```bash
mkdir -p /tmp/cf-test-images && cd /tmp/cf-test-images
for c in red:s1v0 green:s1v1 blue:s2v0 yellow:s2v1; do
  color="${c%:*}"; name="${c#*:}"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=${color}:s=512x512:d=0.04:r=1" \
    -frames:v 1 "/tmp/cf-test-images/${name}.png"
done
```

### Step 2 — temporarily expose sbbState + auto-open DevTools

`F12` / `Ctrl+Shift+I` keystrokes do **not** reliably reach the
Electron window through `xdotool` or the GUI input layer (observed
on Devin VMs even with `devTools: isDev` enabled). The reliable
workaround is two test-only patches that you revert before the
final `git diff`:

1. **`desktop/dist/creator-forge.js`** — right after the `sbbState`
   declaration block ends (search for `proMode: false,\n    };`):

   ```js
   if (typeof window !== 'undefined') {
       window.__sbbStateForTesting = sbbState;
       window.__sbbRepaintAll = () => sbbRepaintAll();
       window.__sbbResolveUrls = (rows, kind) => sbbResolveUrls(rows, kind);
   }
   ```

2. **`desktop/electron/main.js`** — right after the
   `mainWindow.loadFile(htmlPath).catch(...)` block:

   ```js
   mainWindow.webContents.once('did-finish-load', () => {
       try { mainWindow.webContents.openDevTools({ mode: 'right' }); } catch (e) {}
   });
   ```

Both are gated by user intent (the `__` prefix + a comment
labelling them TEST-ONLY) and add zero behaviour to the production
path. **Always `git diff HEAD` before posting test results to
confirm both reverted.**

### Step 3 — drive the harness from DevTools console

Launch sidecar + Electron, switch to Storyboard tab, then paste a
single-line IIFE in the DevTools console (newlines in `type`
actions execute the line prematurely; semicolons keep it one
statement):

```js
(async()=>{const S=window.__sbbStateForTesting,H=window.StoryboardBatchHelpers;
 const scenes=[{scene_id:1,title:'Scene 1',duration_s:4,image_prompts:['p1a','p1b'],flow_video_prompts:['v1a','v1b']},
               {scene_id:2,title:'Scene 2',duration_s:4,image_prompts:['p2a','p2b'],flow_video_prompts:['v2a','v2b']}];
 S.imageRows=H.initImageRowsFromScenes(scenes,{imagesPerScene:2});
 const paths=['/tmp/cf-test-images/s1v0.png','/tmp/cf-test-images/s1v1.png',
              '/tmp/cf-test-images/s2v0.png','/tmp/cf-test-images/s2v1.png'];
 S.imageRows=H.applyBatchResult(S.imageRows,'1#0',{status:'generated',image_path:paths[0]});
 S.imageRows=H.applyBatchResult(S.imageRows,'1#1',{status:'generated',image_path:paths[1]});
 S.imageRows=H.applyBatchResult(S.imageRows,'2#0',{status:'generated',image_path:paths[2]});
 S.imageRows=H.applyBatchResult(S.imageRows,'2#1',{status:'generated',image_path:paths[3]});
 S.videoRows=H.initVideoRowsFromScenes(scenes,{videosPerScene:2});
 S.videoRows=H.pairImagePathsForI2V(S.videoRows,S.imageRows);
 window.__sbbRepaintAll();
 await window.__sbbResolveUrls(S.imageRows,'image');
 await window.__sbbResolveUrls(S.videoRows,'video');
 window.__sbbRepaintAll();})();
```

Then scroll the Storyboard panel — both Image batch and Video
batch tables render against synthesized data. Variant 0 of scene
N should match Variant 0 of scene N's image (red↔red, green↔green,
blue↔blue, yellow↔yellow). Any mismatch is a pairing bug.

### Step 4 — assert table structure from DevTools

```js
[...document.querySelectorAll('#sbb-video-result table thead th')].map(t=>t.innerText.trim())
// Expect: ['', '#', 'SCENE', 'SOURCE', 'PROMPT', 'STATUS', 'OUTPUT', 'ACTIONS']
//                            ^ post-PR-54 — Source column at position 4

[...document.querySelectorAll('#sbb-image-result table thead th')].map(t=>t.innerText.trim())
// Expect: ['', '#', 'SCENE', 'PROMPT', 'STATUS', 'OUTPUT', 'ACTIONS']
//                            ^ no Source col on image table

[...document.querySelectorAll('#sbb-video-result table tbody tr td:nth-child(4) img')]
  .map(i=>i.getAttribute('src'))
// Expect: 4× 'file:///tmp/cf-test-images/s*.png' URLs
```

### Step 5 — exercise stale-clear + fallback paths

With the harness state still loaded:

```js
// Stale clear: delete ALL images of one scene
(()=>{const S=window.__sbbStateForTesting,H=window.StoryboardBatchHelpers;
  S.imageRows=S.imageRows.filter(r=>r.scene_id!==1);
  S.videoRows=H.pairImagePathsForI2V(S.videoRows,S.imageRows);
  window.__sbbRepaintAll();
  return S.videoRows[0].source_image_url; })()
// Expect null + cell text 'no image yet'

// Fallback: delete only variant 0 of one scene
(()=>{const S=window.__sbbStateForTesting,H=window.StoryboardBatchHelpers;
  S.imageRows=S.imageRows.filter(r=>!(r.scene_id===1&&r.variant_idx===0));
  S.videoRows=H.pairImagePathsForI2V(S.videoRows,S.imageRows);
  window.__sbbRepaintAll();
  return S.videoRows[0].source_image_url; })()
// Expect 'file:///.../s1v1.png' — variant N missing → fall back to lowest available
// variant of same scene (PR-23 hero behaviour preserved on top of variant pairing)
```

### Step 6 — revert + verify diff is empty

```bash
cd /home/ubuntu/repos/creator-forge && git diff HEAD
# Empty output before posting test results.
```

This recipe was developed during PR-54 (Source column for video
table). Reuse it for any future renderer-only Storyboard change —
selection-state badges, per-row chips, prompt clamp behaviour,
etc. — without burning Grok quota.

## Testing /producer/assemble — the three caption modes

```bash
curl -s -X POST http://127.0.0.1:5050/producer/assemble \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json; print(json.dumps({
    \"scene_videos\": [\"/tmp/cf-scenes/shot1.mp4\", \"/tmp/cf-scenes/shot2.mp4\", \"/tmp/cf-scenes/shot3.mp4\"],
    \"audio_path\": \"<voice.mp3 from /producer/audio>\",
    \"srt_path\": \"<captions.srt from /producer/audio>\",
    \"output_dir\": \"/tmp/cf-out\",
    \"caption_mode\": \"burn\"
  }))')"
```

## The decisive burn-vs-soft assertion (use this when verifying PR-32 / regressions)

With the **same** audio + SRT + scene files, run the call twice —
once with `caption_mode="burn"`, once with `caption_mode="soft"`.
The binary distinction is:

1. **`ffprobe -show_entries 'stream=codec_type,codec_name'`** on each
   output:
   - Burn: `[h264, aac]` only. **No `mov_text` stream.**
   - Soft: `[h264, aac, mov_text]`. The `mov_text` stream is
     present.

   If burn output also has `mov_text`, the implementation silently
   fell back to soft and the burn feature is broken.

2. **`ffmpeg -ss 2.5 -i final.mp4 -frames:v 1 frame.png`** — extract
   a raw frame from each output:
   - Burn frame: must contain visible caption text rendered into
     pixels (white outlined letters at the bottom).
   - Soft frame: must NOT contain caption text (mov_text only
     surfaces when the player has subs enabled; raw pixel
     extraction bypasses that).

Use `read` tool on the PNGs to view them inline — visual
verification is the only honest answer to "are the captions in the
pixels". File-size heuristics work too (burn frame is
10–40× larger than a solid-color soft frame) but visual is the
ground truth.

## Schema regression

```bash
curl -s -X POST http://127.0.0.1:5050/producer/assemble \
  -H 'Content-Type: application/json' \
  -d '{"scene_videos":["/tmp/cf-scenes/shot1.mp4"], "caption_mode":"explode"}'
# expect HTTP 422 with body containing
# "Input should be 'soft', 'none' or 'burn'"
```

## Storyboard — testing PR-A progress UI + PR-B I2V gate

PR-A turned `/producer/scene_breakdown`'s static spinner into a
live `.progress-block` with a phase label, animated bar, ticking
elapsed counter, and an after-3s hint. PR-B disables the
Generate-videos button when `mode=i2v` and 0 image rows have
settled, with a Vietnamese tooltip; once at least one row settles
the page smooth-scrolls down to `#sbb-video-section`.

### What to assert (Test 1 — progress UI)

With a long enough script (`scene_breakdown` should run ≥30 s),
click **Break into scenes (DeepSeek)** and watch `#sb-result`.
Expected DOM (NOT the legacy `<div class="loading">`):

- `.progress-block` exists with children `.progress-label`,
  `.progress-elapsed`, `.progress-bar`, `.progress-phase`, and
  (after ~3s) `.progress-hint`.
- `.progress-elapsed` ticks each second (1s `setInterval`).
- `.progress-phase` text advances through the 5 phases in
  `DEFAULT_SCENE_BREAKDOWN_PHASES` (defined in
  `desktop/dist/storyboard_progress_helpers.js`):
  - `t=0`     `Đang gửi yêu cầu sang DeepSeek…`
  - `t=3000`  `Đang phân tích kịch bản và chia scene…`
  - `t=25000` `Đang trích xuất Visual DNA…`
  - `t=45000` `Đang sinh prompts variants song song…`
  - `t=75000` `Vẫn đang xử lý — script dài cần thêm vài chục giây nữa…`
- `formatElapsed` switches from `Xs` to `Xm Ys` at exactly 60s —
  `1m 0s`, not `60s`.

### What to assert (Test 2 — I2V gate + toggle)

With scenes loaded but 0 images settled:
- Mode = `i2v`: button.disabled=true, text is exactly
  `Generate videos` (no `(N)` suffix), tooltip is exactly
  `Tạo ảnh trước — I2V cần ảnh đã sinh xong làm hero frame. (Hoặc chuyển sang T2V để bỏ qua bước này.)`.
- Toggle to `t2v`: button enables, text becomes
  `Generate all (N)`, tooltip becomes the standard English
  `Run videos generation on all N rows...`.
- Toggle back to `i2v`: gate re-engages. **This second toggle
  matters** — it proves the change-event listener fires both
  directions, not just the first time.

### What to assert (Test 3 — auto-scroll on first settle)

This test requires real Grok image generation and is therefore
gated on Puppeteer working (see Puppeteer gotcha below).
With Video section initially below the viewport
(`#sbb-video-section.getBoundingClientRect().top > window.innerHeight`),
click **Generate images**, wait for the first row to flip to
`status: 'generated'` with non-empty `image_path`. Within ~1s
`#sbb-video-section` should smooth-scroll into view
(`top` between 0 and `viewport_height * 0.66`) and the
Generate-videos button should flip to `Generate all (M)` enabled.

## Common gotchas

### Sidecar caches stale code

If you change Python code on a branch and then test, **the running
sidecar is still on the old code**. Check before testing:

```bash
# Confirm the running enum matches your branch's expected modes:
curl -s http://127.0.0.1:5050/openapi.json \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)
  ["components"]["schemas"]["AssembleRequest"]
  ["properties"]["caption_mode"])'
```

If the enum is wrong, restart the sidecar from the working tree
(kill the existing PID, then re-run
`python -m uvicorn research.api.main:app ...`). Electron is
tolerant of this — it'll reuse the new sidecar via the existing
pill.

### duration_s reports the visual stream, not the container

PR #43 fixed this. With `caption_mode="soft"` the `mov_text` track
extends the mp4 container past the visual stream (e.g. 12.5s
container vs 10.0s video stream when the SRT runs longer than
the trimmed scenes). `duration_s` in the response now
correctly reports the **visual** stream length, not the inflated
container. ffprobe's `[FORMAT] duration=` is the container; per-
`[STREAM] duration=` for the video stream is the truth.

### Burn mode needs fontconfig + a usable font

Ubuntu base images have `fontconfig` + DejaVu pre-installed, so
burn just works on the standard VM. On a clean Windows / macOS /
headless-Linux install, libass may fall back to a built-in font
silently or error — if real-world burns fail there, install
`fontconfig` + `fonts-dejavu` (or equivalent) on the host. The
implementation never raises on font issues; it surfaces them as
response warnings.

### caption_mode="burn" but no SRT → silent skip + warning

The implementation downgrades `burn` with no usable `srt_path` to
`none` and emits a warning rather than 5xxing. If you're testing
the burn happy path, make sure `srt_path` is set and the file
exists — otherwise `captions_attached` will be `false` and you'll
think burn is broken.

### Window sizing for Electron testing

Maximize the Electron window before recording any screen test.
`xdotool search --name 'Creator Forge' windowsize 1600 1140` works
on the standard VM. The default 800x600 hides several panels.

### DevTools won't open via F12 / Ctrl+Shift+I in the Devin desktop

Observed on Devin VMs: `key: F12` and `key: ctrl+shift+i` actions
do not open Electron's DevTools, even though `devTools: isDev` is
true and `npm start` sets `app.isPackaged === false`. The
workaround is to patch `desktop/electron/main.js` with a one-shot
`mainWindow.webContents.openDevTools({ mode: 'right' })` after
`did-finish-load` — see the `Storyboard render-only testing` recipe
above for the exact snippet. **Always revert this patch before
posting test results.**

### IPC client timeout on long LLM calls (and the 300s claim)

The IPC layer at `desktop/electron/researchIPC.js:29` has a single
global `timeout: 120_000` (2 minutes) for **every** request, not
the 300s some older notes claim is configured per-endpoint. On a
long scene_breakdown (12 scenes × 4 variants ≈ 48 LLM calls), the
renderer can bail with `sidecar request timeout` even though the
sidecar is still happily streaming DeepSeek responses. To keep a
test under the ceiling, reduce the load: short script (≤200
words) + `# scenes ≈ 4` + `images_per_scene = 1` typically returns
in 30–60s. If you actually want to verify the long-running path
more than 2 minutes deep, you'll need to bump that timeout in code
for the test.

### Puppeteer-from-Electron silent launch failure on sandboxed VMs

On some sandboxed VMs (observed on a Devin runner), Puppeteer's
`launch()` from inside Electron's `AuthService.setupAccount` exits
silently with `Failed to launch the browser process: Code: 0` and
empty stderr — even though a standalone Node script using the
same `args` / `ignoreDefaultArgs` / `userDataDir` against the same
Chrome binary launches fine and prints `LAUNCH OK Chrome/<ver>`.
The failure is environment-specific to the Electron child-process
spawn path, not a code bug.

Mitigations to try, in order:

1. Symlink a real Chrome binary at `/usr/bin/google-chrome` (see
   gotcha below).
2. Wipe the per-account session profile dir if a previous failed
   launch corrupted it:
   `rm -rf desktop/sessions/<email_safe>` (or the
   `GROK_PROFILE_DIR` equivalent).
3. As a last resort, run the full Electron app on a workstation
   where Puppeteer can launch system Chrome successfully — the
   silent-failure mode hasn't reproduced outside this sandbox.

The pure helper `countSettledImageRows` is unit-tested
(`desktop/tests/test_storyboard_batch_helpers.js`), so you can
verify the gate-state and auto-scroll logic at the helper layer
without a real Grok session, but the actual `scrollIntoView` call
at the renderer level only fires when a real settled row arrives.

### Chrome path detection only checks `/usr/bin/...`

`desktop/src/browser.js:findChromePath()` checks four hardcoded
Linux paths: `/usr/bin/{google-chrome, google-chrome-stable,
chromium, chromium-browser}`. On Devin VMs the only `google-chrome`
on `PATH` is `/home/ubuntu/.local/bin/google-chrome`, which is a
`#!/bin/sh` shim that PUTs URLs to `localhost:29229/json/new` —
NOT a real Chrome binary. If you symlink that shim into
`/usr/bin/google-chrome`, Puppeteer happily launches it, the shim
immediately exits with status 0, and you get the silent
`Code: 0` failure described above.

The right symlink target is the Puppeteer-managed Chrome already
on disk:

```bash
PUPPET_CHROME=$(ls -d /home/ubuntu/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome | head -1)
sudo ln -sf "$PUPPET_CHROME" /usr/bin/google-chrome
# verify with: /usr/bin/google-chrome --version
```

This is a test-environment workaround for the `findChromePath`
hardcoded list, not a fix — the production path uses the user's
real Chrome install. An alternative is to set
`CHROME_EXECUTABLE_PATH` (which the code respects) before
launching Electron.

## Sidecar working dir + log capture (when starting yourself)

```bash
cd /home/ubuntu/repos/creator-forge
nohup python -m uvicorn research.api.main:app \
  --host 127.0.0.1 --port 5050 \
  > /tmp/sidecar.log 2>&1 &
echo $! > /tmp/sidecar.pid
sleep 3
curl -s http://127.0.0.1:5050/healthz
```

## Lint & test commands

- `ruff check research` — backend lint
- `python -m pytest research/tests/ -q` — strict pytest bucket
  (≈3s; runs API + assembler + tts_providers + video_probe). The
  legacy `test_pixelle_*.py` and `test_youtube_*.py` collect-fail
  on missing heavy deps (moviepy, edge-tts) — that's CI-marked
  best-effort, not a regression.
- `node desktop/tests/test_*.js` — desktop offline regression. Run
  individually or `for f in desktop/tests/test_*.js; do node $f; done`.

## When to skip live testing

If the change is purely backend code with strong unit-test coverage
(e.g. a new caption mode with full args-shape + integration tests in
`test_assembler.py` + route tests in `test_api_producer.py`), you
can skip live testing if all you'd be doing is re-running the
unit assertions through curl. Live testing earns its keep when:

- The change crosses a process boundary (Electron ↔ sidecar,
  sidecar ↔ ffmpeg subprocess, ffmpeg ↔ fontconfig).
- The pixel/audio output of ffmpeg is the actual deliverable
  (frame extraction is the only real proof of "burn renders into
  pixels").
- The unit-test stubs subprocess.run — by definition, those tests
  can't catch host-environment problems (missing ffmpeg, missing
  font, broken pipe, etc.).
