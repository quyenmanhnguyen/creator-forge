# Testing creator-forge (Electron + Python sidecar + ffmpeg)

This skill documents the testing recipes for the creator-forge
pipeline (Research → Studio → Storyboard → AutoGrok → Compose →
Video Assembly). It covers what we've actually done and what works.

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
PR-31, PR-32).

## Launching Electron headlessly on the linux Devin VM

```bash
cd /home/ubuntu/repos/creator-forge/desktop
npm install --no-audit --no-fund   # only needed once per fresh box
DISPLAY=:0 ./node_modules/.bin/electron . --no-sandbox --disable-gpu \
  > /tmp/electron.log 2>&1 &
```

The Electron window renders to the same X server as the Devin
browser (`DISPLAY=:0`). Maximize after launch with
`wmctrl -r "Creator Forge" -b add,maximized_vert,maximized_horz`.

The app dismisses on first launch with an API-keys modal — click
`Cancel` if you don't have keys for the test, or supply them
through the modal.

### CDP attach for white-box assertions (HF-5 lesson)

`creator-forge.js` is wrapped in an IIFE — `sbbState` and friends
are **NOT on `window`**. The Electron build also calls
`Menu.setApplicationMenu(null)` and binds nothing to F12 /
Ctrl+Shift+I, so DevTools cannot be opened normally.

For any test that needs to inspect or mutate renderer state
(e.g. assert `sbbClear()` ran from inside `runSceneBreakdown`,
inject fake batch rows, read state without LLM creds):

1. Launch with a CDP port:
   ```bash
   ./node_modules/.bin/electron . --no-sandbox \
     --remote-debugging-port=9223 &
   curl -s http://127.0.0.1:9223/json/version   # confirm port up
   ```
2. Add a one-line test hook just before the `})();` at the bottom
   of `desktop/dist/creator-forge.js`:
   ```js
   window.__test = { sbbState, sbbRepaintImage, /* etc */ };
   ```
3. Restart Electron (re-reads the file).
4. Attach Puppeteer:
   ```js
   const puppeteer = require('./node_modules/puppeteer');
   const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223' });
   const [page] = (await browser.pages()).filter(p => p.url().includes('creator-forge.html'));
   await page.evaluate(() => {
     window.__test.sbbState.imageRows = [{ row_id: 'r1', status: 'fallback' }];
     window.__test.sbbRepaintImage();
   });
   ```
5. **Always revert the test hook before reporting** (`git checkout`).
   It is not safe to commit — `window.__test` would leak production
   state to any code running on the page.

Note: `sbbRepaintImage()` writes its HTML into `#sbb-image-result`
(a `<div>`), not into a fixed tbody id. Query rows with
`document.querySelector('#sbb-image-result table tbody tr')`.

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
   - `soft` mode → 3 streams: `video=h264`, `audio=aac`, `subtitle=mov_text`
   - `burn` mode → 2 streams: `video=h264`, `audio=aac` (NO subtitle stream)
2. **Visual inspection** of an extracted frame:
   - `soft` mode → no captions visible (player would render mov_text on demand)
   - `burn` mode → captions visible burned into the video pixels

Use `ffmpeg -ss 1 -i out.mp4 -frames:v 1 frame.png` to extract a
frame at t=1s for visual proof.

## OS-level openFolder fallthrough on the Devin VM

On the Devin linux VM there is NO GUI file manager registered for
`xdg-open`. When `📂 Open folder` calls `shell.openPath(dir)`, the
OS falls through to Chrome (the only registered file://-capable
handler), which opens a new tab at `about:blank`. This is OS-level
behavior, not a creator-forge bug. On a normal desktop install the
user's chosen file manager opens. When testing this code path,
assert that the IPC fired (no JS error) and treat the Chrome tab
as evidence the OS got the request.

## Findings carried over

- **Cloudflare turnstile blocks programmatic Grok login.** Manual
  click required when the captcha appears.
- **Electron DevTools is not bound** to F12 / Ctrl+Shift+I on this
  build. Use the CDP attach pattern above.
- **Mutagen + edge-tts not in CI strict bucket** — installed in env
  config maintenance step instead.
