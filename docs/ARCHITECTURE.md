# Architecture

## Why two processes

creator-forge is a **monorepo with two runtimes**:

1. **Electron desktop** — Node.js + Chromium. Owns UX, IPC, native file system, license, account management, and the Puppeteer-driven Grok flows that already work in `autogrok-veo3`.
2. **Python research sidecar** — FastAPI + uvicorn on `127.0.0.1:5050`. Owns YouTube Data API calls, DeepSeek LLM chains, scene breakdown, ffmpeg/TTS composition. This is the `core/` + `core/pixelle/` from `tube-atlas-oss`, lifted into HTTP routes instead of Streamlit pages.

We chose **process separation over rewrite** because:

- 100% of Tube-Atlas's research code keeps working untouched (just in `research/core` instead of repo root).
- 100% of AutoGrok's Puppeteer / Electron flows keep working untouched.
- The two stacks have very different deployment / packaging stories — Python data libs on one side, Chromium runtime on the other. A sidecar boundary keeps them independent.
- The renderer never talks to the sidecar directly — it goes through main process IPC, which means the sidecar can stay bound to localhost and the renderer never needs CORS or auth.

## Process topology

```
                  ┌──────────────────────────────────────┐
                  │            Renderer (React)          │
                  │  research / studio / storyboard /    │
                  │  producer / image / video / i2v UI   │
                  └───────────────┬──────────────────────┘
                                  │  window.electronAPI.*  (preload.js)
                                  ▼
        ┌──────────────────────────────────────────────────┐
        │                Electron main process              │
        │                                                   │
        │  ┌─────────────┐   ┌─────────────────────────┐    │
        │  │ ipcMain     │──▶│  desktop/src/services/* │    │
        │  │ image:*     │   │  Image / Video / I2V /  │    │
        │  │ video:*     │   │  RefImage / Auth /      │    │
        │  │ i2v:*       │   │  Account / File /       │    │
        │  │ refimg:*    │   │  License                │    │
        │  └─────────────┘   └─────────────────────────┘    │
        │                                                   │
        │  ┌─────────────┐   ┌─────────────────────────┐    │
        │  │ ipcMain     │──▶│  researchIPC.js         │    │
        │  │ research:*  │   │  HTTP fetch             │    │
        │  │ studio:*    │   │  127.0.0.1:5050         │    │
        │  │ storyboard:*│   └────────────┬────────────┘    │
        │  │ producer:*  │                │                 │
        │  └─────────────┘                │                 │
        │                                 │                 │
        │      researchSidecar.js         │                 │
        │      (spawn / health / stop) ◀──┘                 │
        └──────────────────────┬───────────────────────────┘
                               │  child_process.spawn
                               ▼
        ┌──────────────────────────────────────────────────┐
        │           Python sidecar (uvicorn :5050)          │
        │                                                   │
        │  research/api/main.py  ── FastAPI app             │
        │  ├─ /research/{niche,keywords,outlier,cloner}     │
        │  ├─ /studio/{topics,titles,outline,script,humanize}│
        │  ├─ /producer/{scene_breakdown,thumbnail_prompt,   │
        │  │              short,voices,providers}           │
        │  └─ /healthz                                      │
        │                                                   │
        │  research/core/         ── tube-atlas modules     │
        │  research/core/pixelle/ ── scene_breakdown,       │
        │                            composer, tts,         │
        │                            subtitles, prompting,  │
        │                            styles, voices,        │
        │                            workflows,             │
        │                            GrokImageProvider,     │
        │                            ComfyUI provider       │
        └──────────────────────────────────────────────────┘
```

## Lifecycle

| Event | What happens |
| --- | --- |
| `app.whenReady()` | `researchSidecar.start()` spawns `python -m uvicorn research.api.main:app --port 5050`, polls `/healthz` until 200, then registers all `research:*`, `studio:*`, `storyboard:*`, `producer:*` IPC handlers via `researchIPC.register()`. |
| Renderer call | `window.electronAPI.research.searchNiche(...)` → `ipcRenderer.invoke('research:searchNiche', ...)` → main → `http.request('http://127.0.0.1:5050/research/niche', ...)` → JSON returned to renderer. |
| Sidecar crash | `child.on('exit')` clears the port and logs. The IPC handlers throw "research sidecar is not running"; the renderer can call a `research:restart` channel (TODO) to retry. |
| `before-quit` | Electron pre-empts the quit, `researchSidecar.stop()` SIGINTs uvicorn, then `app.exit(0)`. |

## Why HTTP instead of stdin/stdout JSON-RPC?

- Easy to debug — any browser or `curl` against `localhost:5050/docs` shows the OpenAPI surface from FastAPI.
- Easy to swap — same sidecar can be deployed remotely later (Docker, Streamlit Cloud) without changing the renderer.
- ffmpeg / yt-dlp / Puppeteer all want to write to disk — HTTP keeps the JSON layer simple while the heavy lifting happens via filesystem paths returned in the response.

## Where the original Streamlit pages live

`research/_streamlit_pages_legacy/` keeps the original Streamlit multi-page UI as a **read-only reference**. It's not wired into the sidecar (there's no `streamlit run` from inside Electron) but you can run it standalone for sanity checks while porting:

```bash
streamlit run research/_streamlit_pages_legacy/app.py
```

Each FastAPI route file has a `notes:` field that points to the legacy page it should mirror.

## Where the Chromium runtime went

`autogrok-veo3` shipped its full Electron build artifact (Chromium .pak files, ffmpeg.dll, swiftshader.dll, etc.) inside the source repo — ~50 MB. We deliberately **did not** vendor those here:

- They're regenerated by `electron-builder` / `electron-packager` from `desktop/package.json`.
- They make `git clone` slow and hide real diffs.
- They differ per-platform (Windows .dll, macOS .dylib, Linux .so) — version-controlling them creates ambiguity.

The build pipeline (TODO in PR-roadmap) should produce them as release artifacts, not commits.
