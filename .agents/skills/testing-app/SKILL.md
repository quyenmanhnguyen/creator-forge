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
