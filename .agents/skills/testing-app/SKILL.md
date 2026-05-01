# Testing creator-forge end-to-end

Reference for testing the **desktop Electron app + Python FastAPI sidecar** against the Storyboard / Producer / Compose features. Distilled from the PR-30 audio-only Compose E2E session.

## When this skill applies

- Anything that needs the Storyboard tab (Scene breakdown, Batch Image+Video, Compose).
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

ffmpeg and ffprobe are already in the standard Devin VM image.

## Starting the stack

**Sidecar (run from repo root, NOT from `research/`):**

```bash
cd /home/ubuntu/repos/creator-forge
uvicorn research.api.main:app --host 127.0.0.1 --port 5050
```

The README also documents `cd research && python -m api.main` — this form **does not work** because the route imports use the absolute `research.api...` prefix. Always run uvicorn from the repo root.

Verify with `curl http://127.0.0.1:5050/healthz` — expect `{"ok":true,...}`.

**Desktop:**

```bash
cd desktop && npm start
```

Electron will detect the already-running sidecar (`[research] sidecar ready on :5050` in the log) instead of spawning its own. The renderer pill in the top-right will say "sidecar ready" once `/producer/voices` polling succeeds (within ~5 s).

## Fitting the Electron window on a 1024×768 VM

`desktop/electron/main.js` defaults to a 1400×900 BrowserWindow with `minWidth: 1200, minHeight: 700`, which doesn't fit on Devin's standard desktop. Two workarounds:

1. **Edit-and-revert** (preferred for one-off testing): drop the size to `width: 1024, height: 740, minWidth: 800, minHeight: 600` for the duration of the test, then revert before reporting. `git diff HEAD` should be clean by the time you post results.
2. **xdotool resize** *after* the window is up: `xdotool search --name "Creator Forge" windowmove 0 0 windowsize 1600 1140`. The actual screen is 1600×1200 even though screenshots are downsampled to 1024×768, so use the larger numbers.

## Navigating to Compose

1. Click the **Storyboard** tab in the top nav.
2. Scroll down past **Scene breakdown**, **Grok accounts**, **Batch Image + Video**.
3. **Compose** is the last panel. Mode dropdown / Voice / Style / Output folder / Script textarea / `Compose short` (or `Compose audio`) button.

The panel has a header pill that always shows the active endpoint path — useful as a one-glance routing check.

## Adversarial assertion patterns that worked well

- **Endpoint routing**: don't trust the UI label alone. Read the sidecar's uvicorn stdout — every request is logged as `INFO:     127.0.0.1:NNNNN - "METHOD /path HTTP/1.1" 200 OK`. `grep -c "POST /producer/short"` and `grep -c "POST /producer/audio"` against the captured stdout proves which endpoint actually got hit.
- **Mode-toggle wiring**: assert at least three independent reactions atomically (header pill + button label + conditional field visibility). A broken `psApplyComposeMode()` would mismatch at least one.
- **Output-folder prefix**: the backend uses different default folder prefixes per endpoint (`short-<ts>/` vs `audio-<ts>/`). Reading the result card's output dir is sufficient — no need to diff folder contents.
- **On-disk artifact list**: `ls -la ~/.creator-forge/output/<folder>/` confirms the response wasn't lying. Audio-only should be exactly `voice.mp3` (or `voice.wav`) + `captions.srt`. Anything else (especially `short.mp4`) means the audio path silently fell back.

## TTS providers available for testing

- **edge-tts** — online, free, no auth. Default voice `en-US-AriaNeural`. Round-trip ~5–15 s for a short script. Always usable.
- **piper-tts** — local binary, **NOT installed** on the standard Devin VM. Skip live tests for Piper-specific behaviour and rely on the pytest covering it (e.g. `test_audio_piper_writes_wav_and_reflects_format`).

## What needs Grok auth (and is therefore expensive to test live)

Anything that calls `image:generate`, `i2v:generate`, `video:generate`, `refimg:generate`. These open Puppeteer Chrome sessions against grok.com and need an account in `~/.config/Creator Forge/accounts.json`. For PRs that don't change the Grok integration itself, prefer:

- UI-state checks against the `Generate images` / `Generate videos` buttons (label, disabled state, selection count) without clicking.
- Backend pytest for any non-Grok logic.

## What needs DeepSeek auth

Anything under `/research/*`, `/studio/*`, and `/producer/scene_breakdown`, `/producer/variant_prompts`. `/producer/short` and `/producer/audio` do **not** call DeepSeek — TTS + ffmpeg only.

## CI sanity

- `cd research && ruff check . && python -m pytest tests/ -q` — strict bucket is 166 pytests in this repo as of PR-30 (was 155). Some legacy `test_pixelle_grok_browser` / `test_pixelle_comfyui_image` failures exist on `main` from test-ordering pollution and are CI-allowed; ignore them.
- `cd desktop && node tests/test_storyboard_batch_helpers.js` — 81 offline tests as of PR-29.
- Both are green as of the latest merged trilogy + PR-29 + PR-30.

## Devin Secrets Needed

None for `/producer/audio`, `/producer/short`, Compose UI, or Storyboard UI-state regressions. For Grok-touching flows (image/video generation, refimg), an authenticated `accounts.json` is required — request `GROK_ACCOUNTS_JSON` (plain, not committed) from the user as a session secret if those flows are in scope.

## Reporting

One PR comment with `<details>` sections, lead with the load-bearing test (the one most likely to break if the PR is wrong), inline screenshots, and a recording link. Keep verdicts to passed / failed / untested.
