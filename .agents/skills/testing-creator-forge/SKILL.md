# Testing creator-forge end-to-end

Creator-forge is an Electron desktop app + Python FastAPI sidecar (uvicorn on :5050).
The Electron renderer is `desktop/dist/creator-forge.html` + `creator-forge.js`
(vanilla HTML/JS, three tabs: Research / Studio / Storyboard).

## Devin Secrets Needed

- `YOUTUBE_API_KEY` (user scope) — required for `/research/*` pipelines.
- `DEEPSEEK_API_KEY` (user scope) — required for `/research/niche` verdict,
  `/research/cloner` clone-kit, all `/studio/*` endpoints, and
  `/producer/scene_breakdown`.
- `/producer/short`, `/producer/voices`, `/producer/providers` need NO API keys —
  edge-tts is keyless, voices are a curated list, providers just check env vars.

Keys are normally already exported into the Electron child's env via
`.env` or session secrets; verify with `curl -s :5050/healthz` →
`{"youtube_key":true,"deepseek_key":true}`.

## How to launch for testing

**Always let Electron spawn its own sidecar.** Do NOT pre-start uvicorn manually:

```bash
cd desktop
node_modules/.bin/electron . --no-sandbox > /tmp/cf-electron.log 2>&1 &
# wait ~5s, then check the log for `[research] sidecar ready on :5050`
wmctrl -r "Creator Forge" -b add,maximized_vert,maximized_horz   # before recording
```

`npm run dev` from repo root also works (uses `concurrently`), but for
headless-style test runs the direct `electron` invocation is simpler.

If `desktop/node_modules/.bin/electron` is missing, run
`cd desktop && npm install` first. PR-7 cleanup added `electron@^33` as a
devDependency (PR #9), so a fresh checkout no longer needs `--no-save electron`
workarounds.

## Gotcha — never pre-start uvicorn manually

If you start `uvicorn research.api.main:app --port 5050` BEFORE `electron`:

1. Electron's `researchSidecar.start()` spawns its own uvicorn on 5050.
2. The spawned child fails to bind (port busy) and exits.
3. `waitForHealth` still pings `:5050` (your external uvicorn) and returns `true`.
4. The exit handler then resets `actualPort = null`.
5. IPC channels report `Error: research sidecar is not running` even though
   `:5050` is reachable. The renderer shows a red error box for every action.

**Fix**: kill your manual uvicorn, restart electron alone. Sidecar dot turns
green within ~3s.

`researchSidecar.start` could probe `/healthz` first and reuse an external
sidecar — out of scope for now, but a future PR-10 polish target.

## Voice picker — cold start label is stale

`/producer/voices` returns `{ ready: false, status: 'sidecar starting' }`
while the sidecar is booting (PR-9 sentinel). The renderer polls every 5 s
until the response has `ready: true` and the voices list is populated.

The header status dot can show `starting sidecar...` or `sidecar not reachable`
for a few seconds at cold start, then flip to green `sidecar ready`. **Wait
~10 s after launch** before clicking buttons. If the dot ever flips back to
`sidecar not reachable` mid-test, check `/tmp/cf-electron.log` for the
spawned uvicorn dying (port conflict, missing `edge-tts`, etc).

## Where the Compose-short UI lives

- HTML panel: `desktop/dist/creator-forge.html` (search `data-form="compose-short"`).
- Renderer logic: `desktop/dist/creator-forge.js`:
  - `populateVoicePicker` — auto-fills `#ps-voice` from `/producer/voices`.
  - `runComposeShort` — `#ps-script` (or fallback `#sb-script`),
    `#ps-voice`, `#ps-style`, `#ps-output-dir`, `#ps-write-srt`.
  - `renderComposeShort` — stats row + Output files block + warnings + raw JSON.
- Backend route: `research/api/routes/producer.py::compose_short`. Indirection
  points `_tts_adapter_factory` and `_make_short` for monkeypatch tests.

Client-side guards use `asNonEmpty()` which `.trim()`s — empty AND whitespace
inputs both intercept before the backend. To exercise the **backend** Pydantic
validator (`min_length=1`), call the route with `curl` directly.

## Verifying `/producer/short` output

```bash
ls -la /tmp/cf-pr8-test-T1/
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,duration \
        -of default=noprint_wrappers=1 /tmp/cf-pr8-test-T1/short.mp4
```

Expected for the default style/voice with a 2-sentence script:
- `short.mp4` ≥ 50 KB, h264 1080×1920, aac audio, ~7-15 s duration.
- `voice.mp3` ≥ 5 KB.
- `captions.srt` non-empty, 1+ cues.
- Response `caption_source` is usually `sentence_fallback` (edge-tts often
  returns empty `word_boundaries`); `word_boundaries` is also valid.
  `none` would indicate a bug.

## What to skip (out of scope unless explicitly asked)

- Real per-scene visual generation (placeholder gradient is the only path until
  PR-A3+ wires ComfyUI / Grok / Gemini / Whisk).
- AutoGrok bug fixes (reserved for PR-9 — chỉ trả 1 ảnh, blur/moderation).
- Visual quality of the rendered mp4 (only check container + codec + dims,
  not pixel content).

## Recording tips

- Maximize Electron window before `recording_start`:
  `wmctrl -r "Creator Forge" -b add,maximized_vert,maximized_horz`.
- Keyboard shortcut alternatives like Super+Up may only half-tile.
- Use `annotate_recording` for `setup`, `test_start`, `assertion`. Group
  related checks into one assertion (`Sidebar collapsed to icon-only rail`,
  not three separate label-by-label assertions).
- One continuous recording per testing session — don't fragment.
