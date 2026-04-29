# Testing creator-forge end-to-end

This skill covers how to bring up the desktop app (Electron + FastAPI sidecar) for live testing the **Creator Forge UI** (Research / Studio / Storyboard) introduced in PR-7. The legacy AutoGrok UI is reachable separately with `CREATOR_FORGE_UI=autogrok`.

## Devin Secrets Needed

- `YOUTUBE_API_KEY` — required for `/research/{niche,keywords,outlier,cloner}`. Save scope: `user`.
- `DEEPSEEK_API_KEY` — required for `/research/niche` verdict, all `/studio/*` routes, and `/producer/scene_breakdown`. Save scope: `user`.

Without these the sidecar boots fine and surfaces partial responses with `warnings[]`, but the LLM-backed steps will be empty.

## One-time setup on a fresh box

```bash
cd /home/ubuntu/repos/creator-forge

# Python deps (uvicorn binary may not end up on PATH; we'll invoke as `python3 -m uvicorn`)
pip install ruff pytest httpx fastapi uvicorn pydantic python-dotenv requests langdetect openai vaderSentiment google-api-python-client pytrends pandas youtube-transcript-api yt-dlp

# Electron deps. NOTE: `electron` itself is not declared in desktop/package.json yet,
# so install it ad-hoc (any v33+ works).
cd desktop && npm install --no-audit --no-fund && npm install --no-save electron@33 --no-audit --no-fund && cd ..

# .env at repo root — referenced by the sidecar via python-dotenv.
cp .env.example .env
# then edit .env to set YOUTUBE_API_KEY=... and DEEPSEEK_API_KEY=... from your env vars
```

## Running the app for tests

Best path: let Electron own the sidecar lifecycle (`researchSidecar.js` spawns `python3 -m uvicorn research.api.main:app --host 127.0.0.1 --port 5050` and waits for `/healthz`). Don't also start a standalone uvicorn — port 5050 conflicts and the IPC bridge gets confused.

```bash
cd /home/ubuntu/repos/creator-forge/desktop
DISPLAY=:0 ./node_modules/.bin/electron . --no-sandbox 2>&1 | tee /tmp/electron.log
```

The window title should say **Creator Forge** and the header status dot should turn green within ~5 s. If it stays red:

- check `/tmp/electron.log` for `[research] sidecar ready on :5050`
- check `tail /tmp/sidecar.log`-equivalent inside the electron log (sidecar stdout/stderr is tee'd through `setLogSink`)
- confirm port 5050 isn't already taken: `ss -ltnp | grep 5050`

To run the legacy AutoGrok renderer instead (PR-9 scope):

```bash
DISPLAY=:0 CREATOR_FORGE_UI=autogrok ./node_modules/.bin/electron . --no-sandbox
```

## Smoke-tests without the GUI

```bash
# Quick liveness — no key needed
curl -s http://127.0.0.1:5050/healthz
curl -s http://127.0.0.1:5050/producer/voices

# Real pipeline (needs both keys; ~7-10s)
curl -s -H 'content-type: application/json' \
  -d '{"seed":"sleep stories for adults","region":"US","language":"en","include_trends":false,"include_verdict":true,"max_top_videos":5}' \
  http://127.0.0.1:5050/research/niche | python3 -m json.tool | head -40
```

## Gotchas observed during PR-7 testing

1. **Window maximize**: the `Super+Up` shortcut may only tile to half-screen on KDE. Use `wmctrl -r 'Creator Forge' -b add,maximized_vert,maximized_horz` (apt-install `wmctrl` first if missing).
2. **First-load IPC race**: the renderer polls `producer:listVoices` every 5 s starting on DOMContentLoaded, but `researchIPC.register()` only registers handlers after the sidecar's `/healthz` returns 200. The first one or two polls log `Error occurred in handler for 'producer:listVoices': No handler registered` in the Electron main log; the dot reconciles to green on the next poll. This is benign — don't chase it as a regression.
3. **uvicorn binary missing**: `pip install uvicorn` inside this env doesn't always put `uvicorn` on `$PATH`. Always invoke as `python3 -m uvicorn`. `researchSidecar.js` already does this.
4. **electron not in package.json**: `desktop/package.json` declares electron-related libs (electron-log, electron-updater) but not `electron` itself. Install ad-hoc with `npm install --no-save electron@33`. (Worth adding as a devDependency in a future PR.)
5. **Studio script chunked output is long**: even with `target_chars=2000`, the `/studio/script` chunked generator produces ~13 k chars (one chunk per outline part × 8). Don't assume the response will be near `target_chars`.
6. **Trends rate-limited (HTTP 429)**: pytrends often gets a 429 from Google during `/research/niche`. PR-1's robust mode propagates this as a `warnings[]` entry; the rest of the response stays populated. A yellow warnings box in the UI is expected, not a regression.

## Suggested test recording flow (PR-7 surface)

Keep it linear so the recording reads cleanly:

1. Show the green sidecar dot in the header.
2. Research → niche with seed `sleep stories for adults`, max_top_videos=5, include_trends=true → cards + verdict appear.
3. Studio → seed → Generate topics → click first topic card → step 2 input fills.
4. Generate titles → click first title card → step 3 + step 4 inputs fill.
5. Generate outline → 8 cards.
6. Generate script (target_chars=2000 to keep it under ~50 s).
7. Click `Send script → Storyboard` → tab switches, textarea pre-filled.
8. Storyboard → template `cinematic`, n_scenes=3, wpm=150 → Break into scenes → 3 cards each with Narration + Image prompt + Veo3 video prompt.

Annotate each step with `annotate_recording` (`test_start` + `assertion`). The recording slows around annotations so the user can read them.
