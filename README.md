<div align="center">

# 🛠 creator-forge

**End-to-end YouTube creator suite — research a niche, write the script, storyboard the scenes, generate the visuals (Grok + Veo 3), compose the final video. One desktop app, no copy-pasting between tools.**

[![Electron](https://img.shields.io/badge/Electron-desktop-47848F?logo=electron&logoColor=white)](https://www.electronjs.org)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoCol=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-sidecar-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## 📖 What is this?

creator-forge is a **fusion** of two existing projects from [@quyenmanhnguyen](https://github.com/quyenmanhnguyen):

| Source | Role in creator-forge |
| --- | --- |
| [`autogrok-veo3`](https://github.com/quyenmanhnguyen/autogrok-veo3) | **Base shell** — Electron + React desktop, Puppeteer auth into Grok, batch image / video / image-to-video generation, account rotation, license. |
| [`tube-atlas-oss`](https://github.com/quyenmanhnguyen/tube-atlas-oss) | **Research brain** — niche / keyword / outlier discovery, video cloner, 5-step Studio scriptwriter, Producer pipeline (scene breakdown, TTS, captions, ffmpeg compose). |

The architecture keeps the strengths of both:

- The **Electron desktop** stays in charge of UX, native integration, account/auth, license, and the heavy Puppeteer-based Grok flows that already exist in autogrok-veo3.
- The **Python research backend** (Tube-Atlas's `core/` + `core/pixelle/` modules) runs as a **FastAPI sidecar** spawned by Electron at boot. Renderer never talks to it directly — it goes through `electronAPI.research|studio|storyboard|producer.*` (preload) → IPC → main → HTTP.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            creator-forge desktop                            │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌────────────┐  ┌──────────┐  │
│  │ Research  │  │  Studio   │  │ Storyboard│  │ Generation │  │ Producer │  │
│  │ niche·    │  │ topic→    │  │ script→   │  │ Grok image │  │ tts +    │  │
│  │ keywords· │→│ title→    │→│ scenes·   │→│ Grok video │→│ captions │  │
│  │ outlier·  │  │ outline→  │  │ prompts   │  │ I2V (Veo3) │  │ compose  │  │
│  │ cloner    │  │ script→   │  │           │  │ refimg     │  │ → mp4    │  │
│  │           │  │ humanize  │  │           │  │            │  │          │  │
│  └───────────┘  └───────────┘  └───────────┘  └────────────┘  └──────────┘  │
│        │              │              │              │              │        │
│        └──────────────┴──────────────┘              │              │        │
│                       │                             │              │        │
│                  HTTP localhost:5050                 │              │        │
│                       ▼                             ▼              ▼        │
│  ┌──────────────────────────────┐    ┌─────────────────────────────────┐    │
│  │ research/api (FastAPI sidecar) │    │ desktop/src/services/*.js       │    │
│  │ + research/core (tube-atlas)   │    │ Image / Video / I2V / RefImage  │    │
│  │ + research/core/pixelle/       │    │ + Auth + Account + License      │    │
│  └──────────────────────────────┘    └─────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/PIPELINE.md`](docs/PIPELINE.md) for the full picture.

---

## 📦 Repo layout

```
creator-forge/
├── desktop/                         # Electron + React shell (from autogrok-veo3)
│   ├── electron/
│   │   ├── main.js                  # IPC, BrowserWindow, lifecycle
│   │   ├── preload.js               # exposes electronAPI to renderer
│   │   ├── researchSidecar.js       # NEW — spawns / health-checks Python sidecar
│   │   ├── researchIPC.js           # NEW — proxies research/* IPC → sidecar HTTP
│   │   └── autoUpdater.js
│   ├── src/
│   │   ├── services/                # ImageService, VideoService, I2VService,
│   │   │                            # RefImageService, AuthService, AccountService,
│   │   │                            # FileService, LicenseService
│   │   ├── bridges/                 # NEW
│   │   │   ├── ResearchBridge.js
│   │   │   ├── StudioBridge.js
│   │   │   └── StoryboardBridge.js
│   │   ├── config/
│   │   │   └── app.config.js        # Grok endpoints, batch sizes, concurrency
│   │   ├── gen-image.js / gen-video.js / gen-i2v-axios.js …
│   │   ├── browser.js               # Puppeteer setup
│   │   └── prompts.js
│   ├── dist/                        # pre-built React renderer bundle
│   ├── renderer/                    # (placeholder for fresh React source)
│   └── package.json
│
├── research/                        # Python research sidecar
│   ├── api/
│   │   ├── main.py                  # FastAPI app
│   │   └── routes/
│   │       ├── research.py          # /research/niche
│   │       ├── keywords.py          # /research/keywords
│   │       ├── outlier.py           # /research/outlier
│   │       ├── cloner.py            # /research/cloner
│   │       ├── studio.py            # /studio/{topics,titles,outline,script,humanize}
│   │       └── producer.py          # /producer/{scene_breakdown,thumbnail_prompt,short,voices,providers}
│   ├── core/                        # from tube-atlas-oss (unchanged)
│   │   ├── youtube.py · trends.py · outliers.py · keywords.py
│   │   ├── transcript.py · transcript_ytdlp.py · lang_detect.py
│   │   ├── llm.py · i18n.py · theme.py · utils.py · comments.py
│   │   ├── autocomplete.py
│   │   └── pixelle/                 # ⭐ scene_breakdown, composer, tts, subtitles,
│   │                                #    prompting, styles, voices, workflows,
│   │                                #    GrokImageProvider, ComfyUI provider, Edge TTS
│   ├── tests/                       # pytest suite (port from tube-atlas)
│   ├── _streamlit_pages_legacy/     # original Streamlit pages — reference only
│   ├── requirements.txt
│   ├── pyproject.toml
│   └── .streamlit/                  # legacy theme
│
├── docs/
│   ├── ARCHITECTURE.md
│   └── PIPELINE.md
│
├── .github/workflows/ci.yml         # ruff + pytest + eslint
├── .env.example
├── .gitignore
├── package.json                     # root workspace scripts
├── LICENSE
└── README.md
```

---

## 🚀 Quick start (development)

### 1. Prerequisites

- **Node.js 18+** (the Electron shell)
- **Python 3.10+** (the sidecar)
- **`ffmpeg` on `PATH`** — required for `/producer/short` (TTS → captions → 9:16 mp4 compose). On macOS: `brew install ffmpeg`. On Debian/Ubuntu: `sudo apt install ffmpeg`. Windows: download from https://ffmpeg.org/download.html and add to PATH. (`research/requirements.txt` also pulls `imageio-ffmpeg` as a fallback for moviepy, but the system binary is the primary path.)
- **Chrome** installed (Puppeteer attaches to it for Grok auth)

The compose pipeline also depends on `edge-tts`, `mutagen`, `Pillow`, `moviepy>=1.0.3,<2`, and `imageio-ffmpeg` — all already pinned in `research/requirements.txt`, so a single `pip install -r research/requirements.txt` covers everything.

### 2. Install

```bash
# clone
git clone https://github.com/quyenmanhnguyen/creator-forge.git
cd creator-forge

# Python sidecar
python3 -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
pip install -r research/requirements.txt

# Electron desktop
cd desktop
npm install
cd ..

# API keys
cp .env.example .env
# edit .env → add YOUTUBE_API_KEY and DEEPSEEK_API_KEY
```

### 3. Run

The recommended dev flow is **one terminal**:

```bash
npm run dev
```

That script (defined in the root `package.json`) starts:

1. The FastAPI sidecar on `http://127.0.0.1:5050`
2. The Electron desktop, which auto-discovers and proxies into it

To run them separately for debugging:

```bash
# terminal 1
uvicorn research.api.main:app --host 127.0.0.1 --port 5050 --reload

# terminal 2 (Electron alone — npm start, no concurrent sidecar spawn)
cd desktop
npm start
```

`npm start` runs `electron .` directly. When the Electron shell starts it
**probes `:5050/healthz` first** and reuses an external sidecar if it finds
the `creator-forge.research` service tag — so the split-terminal workflow
above just works without port conflicts. Set
`CREATOR_FORGE_RESEARCH_PORT=<port>` to use a different port.

The Electron shell still runs on its own if the sidecar fails — only the Research / Studio / Producer tabs go dark.

### Renderer modes (PR-7)

By default, Electron loads the **Creator Forge UI** (`desktop/dist/creator-forge.html`) — a vanilla HTML/JS shell with three tabs:

- **Research** — niche, keywords, outlier, video cloner.
- **Studio** — 5-step wizard: topics → titles → outline → script → humanize. Click a topic to send to step 2, click a title to send to step 3, etc.
- **Storyboard** — `/producer/scene_breakdown`. Each scene comes with `narration`, `image_prompt`, and `flow_video_prompt` ready for AutoGrok / Veo3.

A small status dot in the header shows whether the Python sidecar is reachable. Warnings from the sidecar (missing API keys, partial LLM failures) are surfaced inline; the raw JSON is also available behind a `<details>` toggle for debugging.

To run the legacy AutoGrok renderer instead (PR-9 will fix its image-count + moderation bugs):

```bash
CREATOR_FORGE_UI=autogrok npm run dev
```

---

## 🔑 API keys

| Key | Where | Used by |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → enable *YouTube Data API v3* | Niche, Keyword, Outlier, Cloner |
| `DEEPSEEK_API_KEY` | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) | Studio (5-step), Niche verdict, Cloner |
| Grok login | Puppeteer flow inside Electron — sign in once, session persists | Image / Video / I2V / RefImage |

Add them to `.env` at repo root; both Electron and the sidecar load it via `python-dotenv` / `process.env`.

---

## 🧠 Pipeline at a glance

| Stage | Owner | What you do | What you get out |
| --- | --- | --- | --- |
| 01 Research | sidecar (Tube-Atlas) | seed → niche analysis | trends, longtail, channels, outliers, opportunity score, AI verdict |
| 02 Keyword | sidecar | seed → keyword score | longtail list, KGR, VPH chart, question buckets |
| 03 Cloner | sidecar | YouTube URL → clone kit | hook, structure, N title clones, full script, thumbnail spec, SEO tags |
| 04 Outlier | sidecar | topic → small-channel viral | rows (subs ≤ N, views/sub ≥ K), CSV export |
| 05 Studio | sidecar | seed/topic → script | 20 topics → 10 titles → 8-part outline → long-form script → humanize rewrite |
| 06 Storyboard | sidecar (`pixelle.scene_breakdown`) | script → N scenes | image prompt + video prompt + duration + style per scene |
| 07 Generation | desktop services | scenes → assets | Grok images (×4), Veo 3 / Grok video, image-to-video animations, ref images |
| 08 Producer | sidecar (`pixelle.composer`) | assets + script → mp4 | TTS narration, captions, 9:16 / 16:9 final composite |

See [`docs/PIPELINE.md`](docs/PIPELINE.md) for the full data flow & schemas.

---

## 🧪 Testing

```bash
# Python (research) — API tests must pass; legacy tube-atlas tests are
# best-effort until each is ported.
pytest research/tests/test_api_niche.py research/tests/test_api_keywords.py research/tests/test_api_outlier.py research/tests/test_api_cloner.py research/tests/test_api_studio.py research/tests/test_api_producer.py -v
pytest research/tests                       # full suite

# Lint
ruff check research
cd desktop && npm run lint  # (TODO: add eslint config)
```

### Manual API smoke

With the sidecar running:

```bash
# happy path (needs YOUTUBE_API_KEY + DEEPSEEK_API_KEY in .env)
curl -s -X POST http://127.0.0.1:5050/research/niche \
  -H 'Content-Type: application/json' \
  -d '{"seed":"sleep stories for adults","region":"US","language":"en"}' | jq

# fast-only path — skip slow / optional upstreams
curl -s -X POST http://127.0.0.1:5050/research/niche \
  -H 'Content-Type: application/json' \
  -d '{"seed":"ai art","region":"US","language":"en","include_trends":false,"include_verdict":false}' | jq

# /research/keywords — long-tail finder (autocomplete + VidIQ-style score + VPH)
curl -s -X POST http://127.0.0.1:5050/research/keywords \
  -H 'Content-Type: application/json' \
  -d '{"seed":"ai art","region":"US","language":"en","include_questions":true}' | jq

# Same, with per-keyword KGR competition scoring (1 YouTube call per keyword)
curl -s -X POST http://127.0.0.1:5050/research/keywords \
  -H 'Content-Type: application/json' \
  -d '{"seed":"ai art","compute_kgr":true,"max_kgr_keywords":15}' | jq

# /research/outlier — small channels with breakout videos in the last N days
curl -s -X POST http://127.0.0.1:5050/research/outlier \
  -H 'Content-Type: application/json' \
  -d '{"seed":"ai art tutorial","region":"US","window_days":7,"max_subs":100000,"min_outlier":1.5}' | jq

# /research/cloner — reverse-engineer a video into a clone kit (fingerprint + hook + N titles + script + thumbnail copy + tags)
curl -s -X POST http://127.0.0.1:5050/research/cloner \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","new_topic":"protein for cyclists","n_titles":10}' | jq

# /studio/* — 5-step wizard: topic ideas -> titles -> 8-part outline -> long-form script -> humanize
curl -s -X POST http://127.0.0.1:5050/studio/topics \
  -H 'Content-Type: application/json' \
  -d '{"seed":"sleep stories for adults","language":"en","n":12}' | jq

curl -s -X POST http://127.0.0.1:5050/studio/titles \
  -H 'Content-Type: application/json' \
  -d '{"topic":"How to fall asleep in 5 minutes","language":"en","n":10,"must_keywords":"insomnia"}' | jq

curl -s -X POST http://127.0.0.1:5050/studio/outline \
  -H 'Content-Type: application/json' \
  -d '{"title":"5 Bedtime Tips That Work in 60 Seconds","language":"en"}' | jq

# Step 4 needs the 8 parts from /studio/outline; step 5 needs the script from step 4.
curl -s -X POST http://127.0.0.1:5050/studio/script \
  -H 'Content-Type: application/json' \
  -d @/tmp/script_request.json | jq        # title + parts[] + language + target_chars

curl -s -X POST http://127.0.0.1:5050/studio/humanize \
  -H 'Content-Type: application/json' \
  -d @/tmp/humanize_request.json | jq      # script + language

# /producer/scene_breakdown — split a finished script into N standalone scenes,
# each with an ultra-detailed image prompt + 3-4 sentence flow video prompt
# (paste-ready for AutoGrok, grok.com web, Veo 3, Whisk).
# template_key ∈ {cinematic, educational, lifestyle, factory}
# n_scenes is optional — omit to auto-estimate from script length.
curl -s -X POST http://127.0.0.1:5050/producer/scene_breakdown \
  -H 'Content-Type: application/json' \
  -d '{"script":"## PART 1 — Hook\nImagine waking at 3am ...\n\n## PART 2 — Empathy\nYou are not alone ...","template_key":"cinematic","n_scenes":8,"words_per_minute":150,"language":"en"}' | jq
```

CI runs lint + API tests + node `--check` on every push (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

---

## 🩺 Troubleshooting

### Status dot stuck on `starting sidecar...`
The header dot polls `/producer/voices` every 5 s. While the spawned uvicorn
is booting, the route returns `{ "ready": false }` and the dot stays orange.
First boot can take 5–15 s on a cold Python interpreter. If it stays orange
for more than ~30 s, look at the Electron terminal output — the `[research]`
log lines from `researchSidecar.js` will tell you whether uvicorn is actually
running, and the `stderr` lines forwarded from the child are usually the
quickest path to the root cause.

### `Error: research sidecar is not running` / dot is red
- **Electron terminal shows `port :5050 is taken by a non-creator-forge service`** —
  another HTTP server is bound to 5050 (Streamlit, another FastAPI app, Jupyter).
  Kill it, or set `CREATOR_FORGE_RESEARCH_PORT=5051 npm run dev`.
- **Electron just exited / the sidecar crashed** — the spawned uvicorn
  printed a Python traceback to stderr. Common causes:
  - `ModuleNotFoundError: No module named 'edge_tts'` / `'moviepy'` / `'mutagen'` /
    `'Pillow'` / `'imageio_ffmpeg'`. Run `pip install -r research/requirements.txt`
    inside the same Python you launched Electron with. Set
    `CREATOR_FORGE_PYTHON=/path/to/.venv/bin/python` if the auto-detected
    `python3` is not your venv interpreter.
- **You started uvicorn manually before launching Electron** — fine since
  PR-10. Electron's `researchSidecar.start` probes `:5050/healthz` first and
  reuses your external sidecar if it returns the `creator-forge.research`
  service tag. (Pre-PR-10 builds would race-fail in this case.)

### `/producer/short` produces a video but no per-word captions
Check the response: `caption_source: "sentence_fallback"` is not a bug — it
just means edge-tts returned an empty `word_boundaries` list this run (a
known intermittent edge-tts behaviour). The route falls back to splitting on
sentences, proportional to the audio duration. Per-word timing (`caption_source: "word_boundaries"`)
will come back on the next call.

### `/producer/short` returns `mp4_path: ""` with a warning
Composer failed but TTS succeeded — `audio_path` and `srt_path` are
preserved as a partial result. The most common cause is `ffmpeg` missing
from `PATH`. Verify with `ffmpeg -version`. moviepy can fall back to
`imageio-ffmpeg`'s bundled binary, but a system-installed `ffmpeg` is
faster and more reliable.

### `/research/niche` warning: `pytrends rate-limited (HTTP 429)`
Google Trends throttles aggressively. The route degrades gracefully —
`trends` field is empty but the rest of the niche pipeline still runs. Wait
a few minutes and retry, or call with `include_trends: false` to skip the
trends pulse entirely.

### `/studio/*` warning about missing DeepSeek key
All Studio routes depend on `DEEPSEEK_API_KEY`. Without it the routes still
return 200 with empty results and a `warnings[]` entry — the UI surfaces
this as a yellow box. Add the key to `.env` and restart the sidecar
(Electron will pick it up on next launch).

### Stale `desktop/dist` after editing `creator-forge.html` / `.js`
The renderer is loaded directly from `desktop/dist/`, no bundler step.
Just `Cmd/Ctrl+R` (View → Reload) inside the Electron window — no rebuild
needed.

### Grok image generation only returns 1 image instead of 4
Fixed in PR-9. Root cause: `ImageService.buildBody` and the Imagine WS
request used to default `enable_pro: true`. With Pro on, the Grok server
returns a *single* high-quality Pro image and silently ignores
`enable_side_by_side`, so even if you asked for `imageGenerationCount: 4`
you would only ever get 1 image back. PR-9 flips the default — Pro is now
opt-in (`config.enablePro: true`), and when set the request count is
clamped to 1 to match server behavior. Same fix applied in
`RefImageService` for the image-edit / ref flow.

### Grok images come back blurred / suspiciously small (~25–37 KB)
Fixed in PR-9. The Imagine WS streams base64 preview frames during
generation; when moderation triggers mid-stream the server emits a small
placeholder blob right before `current_status: "completed"`. The pre-PR-9
code unconditionally promoted that placeholder to a "final" image. PR-9
applies the same `MIN_BLOB_LEN` (≈ 50 000 base64 chars / 37 KB decoded)
filter inside the `completed` handler that `harvestPartialFinals` already
used, and surfaces a `moderatedCount` field on the result so callers can
distinguish moderation rejects from normal failures.

### `npm run dev` works but `count_per_scene` from Storyboard is ignored
Fixed in PR-9. `StoryboardBridge.generateImages` used to send
`{ prompts: object[], count, account }`, but the IPC handler
`image:generate` destructures `{ prompts, config, startIdx }` — `count`
was silently dropped, and the object-shaped `prompts` would crash
`ImageService.generateBatch` when it tried `prompt.substring(...)`. PR-9
forwards string prompts and packages count as
`config.imageGenerationCount`, so the storyboard → image flow now
honors the per-scene count.

---

## 🗺 Roadmap

This repo's first commit is **PR-0: integration scaffold**. Each remaining FastAPI route returns a shell response with a `notes:` field telling you exactly which `research.core.*` function to wire in. Roadmap:

- **PR-1** — port `01_Research.py` (niche tab) → `/research/niche` (**done**, see `research/api/routes/research.py` + `research/tests/test_api_niche.py`).
- **PR-2** — port `01_Research.py` (keyword tab) → `/research/keywords` (**done**, see `research/api/routes/keywords.py` + `research/tests/test_api_keywords.py`).
- **PR-3** — port `03_Outlier_Finder.py` → `/research/outlier` (**done**, see `research/api/routes/outlier.py` + `research/tests/test_api_outlier.py`).
- **PR-4** — port `02_Video_Cloner.py` → `/research/cloner` (**done**, see `research/api/routes/cloner.py` + `research/tests/test_api_cloner.py`).
- **PR-5** — port `04_Studio.py` (5 steps) → `/studio/{topics,titles,outline,script,humanize}` (**done**, see `research/api/routes/studio.py` + `research/tests/test_api_studio.py`).
- **PR-6** — port `05_Producer.py` long-form mode → `/producer/scene_breakdown` (**done**, see `research/api/routes/producer.py` + `research/tests/test_api_producer.py`).
- **PR-7** — Electron renderer UI (`desktop/dist/creator-forge.html` + `.js`) with Research / Studio / Storyboard tabs, sidecar status dot, cross-tab handoff (**done**).
- **PR-8** — port `05_Producer.py` short mode → `/producer/short` (Edge-TTS + captions + ffmpeg compose, real `/producer/voices` and `/producer/providers`) (**done**, see `research/api/routes/producer.py::compose_short` + `research/tests/test_api_producer.py`).
- **PR-9** — fix the two open AutoGrok bugs (only-1-image, blur moderation) carried over from autogrok-veo3 (**done**, see `desktop/src/services/ImageService.js`, `desktop/src/services/RefImageService.js`, `desktop/src/bridges/StoryboardBridge.js`, and `desktop/tests/test_image_service_config.js` / `test_storyboard_bridge.js`).
- **PR-10** — polish: probe-and-reuse for the sidecar (no port-conflict crashes when uvicorn is started in a separate terminal), expanded README setup, troubleshooting section.

---

## 📝 Origin

This repo was scaffolded with [Devin](https://app.devin.ai) by combining the source trees of `autogrok-veo3` (Electron + Grok generation) and `tube-atlas-oss` (research + Producer). Chromium runtime binaries that shipped with `autogrok-veo3` are intentionally **not** vendored here — they belong in the Electron build artifact, not in source.

## 📝 License

MIT — see [`LICENSE`](LICENSE).
