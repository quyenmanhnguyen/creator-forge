# Testing creator-forge end-to-end

Reference for testing the **desktop Electron app + Python FastAPI sidecar** against the Storyboard / Producer / Compose / Assembly features. Distilled from the PR-30 audio-only Compose and PR-31 Video Assembly E2E sessions.

## When this skill applies

- Anything that needs the Storyboard tab (Scene breakdown, Batch Image+Video, Compose, Video Assembly).
- Anything that hits a `/producer/*` endpoint.
- UI-state regression checks (e.g. "toggling X must hide Y").

For pure unit tests (`research/tests/` or `desktop/tests/`), skip this skill — just run pytest / node directly.

## Prerequisites on the VM

```bash
# Desktop deps (504 packages, ~45 s)
cd desktop && npm install --no-audit --no-fund

# Sidecar runtime deps that aren't in CI's strict bucket but are needed at runtime
pip install edge-tts mutagen
```

`ffmpeg` and `ffprobe` are already in the standard Devin VM image. Verify with `which ffmpeg ffprobe`.

## Starting the stack

**Sidecar (run from repo root, NOT from `research/`):**

```bash
cd /home/ubuntu/repos/creator-forge
uvicorn research.api.main:app --host 127.0.0.1 --port 5050 2>&1 | tee /tmp/sidecar.log
```

The README also documents `cd research && python -m api.main` — this form **does not work** because the route imports use the absolute `research.api...` prefix. Always run uvicorn from the repo root. Tee-ing to `/tmp/sidecar.log` is critical: the live request log is the cheapest way to verify which endpoint actually got hit (see *Adversarial assertions* below).

Verify with `curl http://127.0.0.1:5050/healthz` — expect `{"ok":true,...}`.

**Desktop:**

```bash
cd desktop && DISPLAY=:0 npm start 2>&1 | tee /tmp/electron.log
```

Electron will detect the already-running sidecar (`[research] sidecar ready on :5050` in the log) instead of spawning its own. The renderer pill in the top-right will say "sidecar ready" once `/producer/voices` polling succeeds (within ~5 s).

## Fitting the Electron window on the Devin VM

`desktop/electron/main.js` defaults to a 1400×900 BrowserWindow with `minWidth: 1200, minHeight: 700`. Two workarounds:

1. **Edit-and-revert** (preferred for one-off testing): drop the size to `width: 1024, height: 740, minWidth: 800, minHeight: 600` for the duration of the test, then revert before reporting. `git diff HEAD` should be clean by the time you post results.
2. **xdotool resize** *after* the window is up:
   ```bash
   DISPLAY=:0 xdotool search --name "Creator Forge" windowactivate windowmove 0 0 windowsize 1600 1140
   ```
   The actual screen is 1600×1200 even though screenshots are downsampled to 1024×768, so use the larger numbers.

## UI selectors (renderer)

Grep'ing the renderer to find these every time is wasteful — keep this table in sync.

### Compose panel — `<div class="panel" data-form="compose-short">`

| What | Selector |
| --- | --- |
| Mode dropdown (`short` / `audio`) | `#ps-mode` |
| Endpoint pill (`/producer/short` ↔ `/producer/audio`) | `#ps-mode-pill` |
| TTS provider | `#ps-provider` (defaults `edge-tts (online)`) |
| Voice | `#ps-voice` |
| Style (only shown when mode=short) | `#ps-style` (parent has `data-ps-mode-show="short"`) |
| Output folder | `#ps-output-dir` |
| Script textarea | `#ps-script` |
| Run button | `#ps-run-btn` (label flips between `Compose short` ↔ `Compose audio`) |

State wiring: `psApplyComposeMode()` in `desktop/dist/creator-forge.js` is the single function that flips pill + button label + `data-ps-mode-show` visibility on `#ps-mode` change.

### Video Assembly panel (PR-31) — `<div class="panel" data-form="assemble">`

| What | Selector |
| --- | --- |
| Scene videos textarea (one absolute path per line) | `#pa-scene-videos` |
| Narration audio path | `#pa-audio-path` |
| Captions SRT path | `#pa-srt-path` |
| Output folder | `#pa-output-dir` |
| Audio mode (`replace` / `none`) | `<select>` first in row of 3 |
| Trim to (`video` / `audio`) | `<select>` second in row of 3 |
| Caption mode (`soft` / `none`) | `<select>` third in row of 3 |
| "Pull from Video batch" helper | `data-run="assemble-pull-from-batch"` |
| "Use latest /producer/audio" helper | `data-run="assemble-use-latest-audio"` |
| Primary run button | `#pa-run-btn` (`data-run="assemble"`) |
| Result card | `#pa-result` |

No authoritative `id` exists for the three select boxes; locate them by surrounding label text or by index within the panel.

## Navigating to a panel

1. Click the **Storyboard** tab in the top nav.
2. Scroll down past **Scene breakdown**, **Grok accounts**, **Batch Image + Video**.
3. Order from there is **Compose** → **Video Assembly** (Compose comes before Assembly even though Assembly is the downstream stage).

Each panel header carries a pill showing the active endpoint path — useful as a one-glance routing check.

## Self-contained Video Assembly test (no Grok needed)

The assembly happy path needs scene MP4s — normally generated via Grok I2V. To exercise PR-31 without Grok auth, synthesise dummy scenes with ffmpeg:

```bash
mkdir -p /tmp/cf-test-scenes && cd /tmp/cf-test-scenes
for s in "1:0x6633CC:4" "2:0xFF6699:3" "3:0x33AA77:3"; do
  IFS=: read -r idx color dur <<< "$s"
  ffmpeg -hide_banner -loglevel error \
    -f lavfi -i "color=c=$color:s=720x1280:d=$dur:r=30,format=yuv420p" \
    -f lavfi -i "sine=f=$((300+idx*100)):d=$dur" \
    -c:v libx264 -c:a aac -shortest -y "scene$idx.mp4"
done
```

9:16 (`720x1280`) + `yuv420p` + libx264 + aac matches the codec/container shape `assembler.py` expects. 4+3+3 = 10 s gives a recognizable target duration for downstream assertions.

Then the UI flow:

1. Compose panel → switch mode to **Audio only** → paste a 1-2 sentence script → click **Compose audio** → wait ~10 s. Note the `audio-<ts>/` output dir.
2. Video Assembly panel → click **Use latest /producer/audio** (auto-fills both narration + srt fields from the most recent `audio-*` dir).
3. Paste the 3 scene paths into `#pa-scene-videos`.
4. Click **Assemble final MP4** → wait ~3-5 s.
5. Result card shows `assembly-<ts>/final.mp4`, scene count, audio attached, captions attached.

## Adversarial assertion patterns that worked well

- **Endpoint routing**: don't trust the UI label alone. Read the sidecar's uvicorn stdout — every request is logged as `INFO:     127.0.0.1:NNNNN - "METHOD /path HTTP/1.1" 200 OK`. `grep -c "POST /producer/short" /tmp/sidecar.log` and `grep -c "POST /producer/audio" /tmp/sidecar.log` against the captured stdout prove which endpoint actually got hit. Same trick distinguishes a click on `Compose audio` from a silent fallback to `/producer/short`.
- **Mode-toggle wiring**: assert at least three independent reactions atomically (header pill + button label + conditional field visibility). A broken `psApplyComposeMode()` mismatches at least one.
- **Output-folder prefix**: the backend uses different default folder prefixes per endpoint (`short-<ts>/` vs `audio-<ts>/` vs `assembly-<ts>/`). Reading the result card's output dir is sufficient — no need to diff folder contents.
- **On-disk artifact list**: `ls -la ~/.creator-forge/output/<folder>/` confirms the response wasn't lying. Audio-only should be exactly `voice.mp3` (or `voice.wav`) + `captions.srt`. Assembly should be exactly `final.mp4`. Anything else means a bug.
- **PR-31 load-bearing assertion — `mov_text` stream presence**: ffprobe the assembled mp4 and check for **3 streams** (h264 + aac + mov_text). `ffprobe -v 0 -select_streams s:0 -show_entries stream=codec_name -of csv=p=0 final.mp4` should print `mov_text`. If PR-31's soft-subs path silently regresses, the rest of the UI still looks healthy and only this check catches it.
  ```bash
  for k in v:0 a:0 s:0; do
    echo -n "$k: "; ffprobe -v 0 -select_streams $k -show_entries stream=codec_name -of csv=p=0 final.mp4
  done
  # expected:
  # v:0: h264
  # a:0: aac
  # s:0: mov_text
  ```

## Known gotcha — `duration_s` is container, not video

The `/producer/assemble` response (and the `Duration` field on the result card) returns the **mp4 container duration**, which is the *longest* stream, not the video stream's duration. With `trim_to=video` (default) the v:0 + a:0 streams are correctly capped at the summed scene durations, but the `mov_text` subtitle stream is copied verbatim from the source SRT and is not re-trimmed. So if the narration audio is longer than the scene total, `duration_s` will exceed the scene total even though the video itself is correctly trimmed.

Reference: `research/core/pixelle/assembler.py:480` — `duration_s=float(check.duration_sec or video_total_s or 0.0)` (where `check.duration_sec` is `ffprobe -show_entries format=duration` of the output mp4 = container).

Do not file this as a bug without first per-stream-probing the output; it is by design (soft subs don't gate visual output, and burn-in is deferred to PR-32).

## TTS providers available for testing

- **edge-tts** — online, free, no auth. Default voice `en-US-AriaNeural`. Round-trip ~5–15 s for a short script. Always usable.
- **piper-tts** — local binary, **NOT installed** on the standard Devin VM. Skip live tests for Piper-specific behaviour and rely on the pytest covering it (e.g. `test_audio_piper_writes_wav_and_reflects_format`).

## What needs Grok auth (and is therefore expensive to test live)

Anything that calls `image:generate`, `i2v:generate`, `video:generate`, `refimg:generate`. These open Puppeteer Chrome sessions against grok.com and need an account in `~/.config/Creator Forge/accounts.json`. For PRs that don't change the Grok integration itself, prefer:

- UI-state checks against the `Generate images` / `Generate videos` buttons (label, disabled state, selection count) without clicking.
- The synthetic-scene recipe above to drive everything *downstream* of Grok.
- Backend pytest for any non-Grok logic.

## What needs DeepSeek auth

Anything under `/research/*`, `/studio/*`, and `/producer/scene_breakdown`, `/producer/variant_prompts`. `/producer/short`, `/producer/audio`, and `/producer/assemble` do **not** call DeepSeek — TTS + ffmpeg only.

## CI sanity

- `cd research && ruff check . && python -m pytest tests/ -q` — strict bucket is **191 pytests** as of PR-31 (was 166 after PR-30, 155 before that). Some legacy `test_pixelle_grok_browser` / `test_pixelle_comfyui_image` failures exist on `main` from test-ordering pollution and are CI-allowed; ignore them.
- `cd desktop && for t in tests/test_*.js; do node "$t"; done` — 17 offline test files, ~300 assertions total as of PR-31.
- Both are green as of `main` HEAD `2145629` (Merge PR #41 "PR-31 Video Assembly").

## Devin Secrets Needed

None for `/producer/audio`, `/producer/short`, `/producer/assemble`, the Compose UI, the Video Assembly UI, or Storyboard UI-state regressions. For Grok-touching flows (image/video generation, refimg), an authenticated `accounts.json` is required — request `GROK_ACCOUNTS_JSON` (plain, not committed) from the user as a session secret if those flows are in scope. For Research/Studio flows, request `DEEPSEEK_API_KEY`.

## Reporting

One PR comment with `<details>` sections, lead with the load-bearing test (the one most likely to break if the PR is wrong), inline screenshots, and a recording. For verification of `main` (no PR), send the report directly to the user instead. Keep verdicts to passed / failed / untested.
