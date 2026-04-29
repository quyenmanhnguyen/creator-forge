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

- Node.js 18+ (the Electron shell)
- Python 3.10+ (the sidecar)
- ffmpeg in `PATH` (for the Producer compose step)
- Chrome installed (Puppeteer can attach to it for Grok auth)

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

# terminal 2
cd desktop
npm start
```

The Electron shell still runs on its own if the sidecar fails — only the Research / Studio / Producer tabs go dark.

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
pytest research/tests/test_api_niche.py research/tests/test_api_keywords.py research/tests/test_api_outlier.py research/tests/test_api_cloner.py -v
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
```

CI runs lint + API tests + node `--check` on every push (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

---

## 🗺 Roadmap

This repo's first commit is **PR-0: integration scaffold**. Each remaining FastAPI route returns a shell response with a `notes:` field telling you exactly which `research.core.*` function to wire in. Roadmap:

- **PR-1** — port `01_Research.py` (niche tab) → `/research/niche` (**done**, see `research/api/routes/research.py` + `research/tests/test_api_niche.py`).
- **PR-2** — port `01_Research.py` (keyword tab) → `/research/keywords` (**done**, see `research/api/routes/keywords.py` + `research/tests/test_api_keywords.py`).
- **PR-3** — port `03_Outlier_Finder.py` → `/research/outlier` (**done**, see `research/api/routes/outlier.py` + `research/tests/test_api_outlier.py`).
- **PR-4** — port `02_Video_Cloner.py` → `/research/cloner` (**done**, see `research/api/routes/cloner.py` + `research/tests/test_api_cloner.py`).
- **PR-5** — port `04_Studio.py` (5 steps) → `/studio/*`.
- **PR-6** — port `05_Producer.py` long-form mode → `/producer/scene_breakdown`.
- **PR-7** — wire `StoryboardBridge.generateImages` into `ImageService.generateBatch` end-to-end.
- **PR-8** — port `05_Producer.py` short mode → `/producer/short` (TTS + captions + ffmpeg).
- **PR-9** — fix the two open AutoGrok bugs (only-1-image, blur moderation) carried over from autogrok-veo3.
- **PR-10** — fresh React renderer (`desktop/renderer/`) with native tabs for each stage instead of the legacy `dist/` bundle.

---

## 📝 Origin

This repo was scaffolded with [Devin](https://app.devin.ai) by combining the source trees of `autogrok-veo3` (Electron + Grok generation) and `tube-atlas-oss` (research + Producer). Chromium runtime binaries that shipped with `autogrok-veo3` are intentionally **not** vendored here — they belong in the Electron build artifact, not in source.

## 📝 License

MIT — see [`LICENSE`](LICENSE).
