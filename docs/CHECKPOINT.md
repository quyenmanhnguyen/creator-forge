# Creator-Forge — CHECKPOINT

> Last updated: 2026-05-02 (post-PR-54 validation pass)
> Main HEAD: `fa55abf` — `feat(storyboard): show paired hero image in video batch table (#54)`

## Status

| Metric | Value |
|--------|-------|
| Strict pytest bucket (CI must-pass) | **209 passed** (was 191 in HF-4 checkpoint; +18 from PR-49 progress UI + PR-30/31 helpers) |
| `test_pixelle_visual_dna.py` | **30 passed** (run from `research/` due to `core` import path) |
| Desktop offline tests | **20/20 files PASS** (was 17 in HF-4; +3 from PR-47 multi-account + PR-50 I2V gate + PR-54 source column) |
| `test_storyboard_batch_helpers.js` | 103 / 103 (was 81; +22 across PR-48 + PR-50 + PR-54) |
| Ruff lint | clean |
| Live E2E (backend) | ✅ Verified 2026-05-02 — `/producer/audio` + `/producer/assemble` + Source column render, all on `fa55abf` |
| Open PRs | **0** |

## PR History (post-HF-4)

| PR | Feature | Status |
|----|---------|--------|
| PR-43 | Fix `duration_s` → report video stream duration not container | ✅ Merged |
| PR-44 | Burn-in subtitles (`caption_mode='burn'`) | ✅ Merged (PR-32 in HF-4 checkpoint) |
| PR-45 | `testing-app` SKILL.md | ✅ Merged |
| PR-46 | Storyboard UX polish | ✅ Merged |
| PR-47 | Multi-account fan-out (image only) | ✅ Merged |
| PR-48 | Image↔Video variant continuity + Pro mode toggle | ✅ Merged |
| PR-49 | Scene_breakdown speed-up + progress UI | ✅ Merged |
| PR-50 | I2V gate + auto-scroll | ✅ Merged (rebased on top of #48 to resolve additive test conflict) |
| PR-51 | Testing skill update for HF-3 | ✅ Merged |
| PR-52 | P3 — IPC fan-out stats + console log mirroring | ✅ Merged (live-tested 5/5 assertions) |
| PR-53 | Hotfix — split image / video variant call counters in visual DNA test | ✅ Merged |
| PR-54 | Source column on video batch table (paired hero image preview) | ✅ Merged (live-tested 5/5 assertions via DevTools harness) |

---

## What changed since HF-4 checkpoint

### PR-52 — IPC fan-out stats + console log mirroring (P3)
- `sendLog()` in `desktop/electron/main.js` now mirrors every renderer-bound log to main-process stdout/stderr (`[ts] [level] msg`). Level → stream routing: `error`/`warn` → stderr, all others → stdout.
- `image:generate` IPC return now includes `stats: fanOut.stats` (per-session work-stealing metrics from PR-47's MultiAccountFanOut).
- CI workflow now runs `test_multi_account_fan_out.js` in the offline regression list (was missing).
- Bonus: `desktop/tests/test_ipc_console_log_mirror.js` documents the contract.

### PR-53 — Test hotfix after PR-48 + PR-49 merge interaction
- PR-48 added `expand_video_variants_for_images` (a 2nd LLM call per scene during scene_breakdown).
- PR-49 had asserted `variant_call_count == 2` assuming 1 image-variant call per scene.
- Both PRs CI-green individually (each rebased on pre-merge main); only collided after both landed.
- Fix: split counter into `image_variant_call_count` + `video_variant_call_count`, both asserted == 2 across the 2 scenes.
- See "Lessons learned" below for CI improvement proposal.

### PR-54 — Source column on video batch table
User-reported gap: "the video section must show the images that were already created above, to generate video."

- New `Source` column inserted at position 4 in the video batch table (image table layout unchanged).
- Three render states per row:
  1. `source_image_url` resolved → `<img src="file://..." />` thumbnail
  2. `image_path` set but URL pending → `loading…` placeholder
  3. No paired image → muted `no image yet` hint (visually reinforces the I2V gate state)
- `pairImagePathsForI2V` now propagates the matched image row's `url` field → video row's `source_image_url` synchronously when available; otherwise `sbbResolveUrls` resolves it asynchronously via `electronAPI.getFileUrl()`.
- Stale-clear branch (`else if (row.source_image_url && !ip)`) prevents phantom thumbnails when the paired image disappears.
- 4 new helper unit tests cover propagation / fallback / async race / stale-clear.
- Live verified via DevTools harness (no Grok creds): synthesized 4 PNGs in 4 distinct colors, drove the renderer through `pairImagePathsForI2V` → `sbbResolveUrls` → `sbbRepaintAll`, visually confirmed variant-N video pairs to variant-N image (red→red, green→green, blue→blue, yellow→yellow).

---

## Live E2E status (verified 2026-05-02 on `fa55abf`)

Backend pipeline tested via direct sidecar curl (no Grok / DeepSeek creds needed):

| Test | Endpoint | Result |
|------|----------|--------|
| 1 | `GET /healthz` | `{"ok":true,"service":"creator-forge.research"}` ✅ |
| 2 | `POST /producer/audio` (edge-tts + sentence-fallback captions) | `voice.mp3` (10.512s) + `captions.srt` (3 captions, sentence_fallback) ✅ |
| 3 | `POST /producer/assemble` (3 synthetic 4s+3s+3s scenes + audio + soft subs) | `final.mp4` with h264 + aac + **mov_text** streams ✅ |
| 4 | PR-43 fix verify (`duration_s` from video stream) | Reported `duration_s = 10.0` (matches v:0 stream); container is 10.579s (subtitle stream length) — fix working as designed ✅ |
| 5 | App boot + sidecar pill green | Electron renders, sidecar pill shows `sidecar ready` ✅ |
| 6 | Source column render path (PR-54) | Verified 2026-05-01 via DevTools harness: 5/5 assertions PASS (header position, image-table no-regress, img src=file://, variant pairing, stale-clear) ✅ |

UI panels NOT re-tested live this pass because their renderer code is unchanged since the May-01 baseline (`2145629`):
- Compose mode toggle (pill + button + Style visibility) — covered by `psApplyComposeMode` unit tests
- Video Assembly autofill — covered by `pullFromVideoBatch` + `useLatestProducerAudio` unit tests
- Storyboard scene_breakdown progress UI — covered by PR-49's `test_storyboard_progress_helpers.js`

### Findings

1. **edge-tts word_boundaries no longer surface in v7.2.8.**
   `EdgeTTSAdapter._run_with_timing` reads `chunk.get("type") == "WordBoundary"` from `Communicate.stream()`, but in edge-tts 7.2.8 the chunks no longer include those events. We currently fall back to `fallback_captions_from_text` (sentence-based, evenly distributed over the audio duration), which still works — `caption_source = "sentence_fallback"` in the response. **Action:** investigate edge-tts API change; either pin to an older version that emits boundary events, or update the adapter to use `SubMaker` (the v7.x replacement). Not a regression on `fa55abf` — same behaviour as HF-4.

2. **Mutagen + edge-tts not in CI strict bucket.**
   The `Pillow + fastapi + uvicorn + ...` heavy-stack install in `ci.yml` step "Install Python deps" deliberately omits these to keep CI fast. Sidecar `/producer/audio` test passes only because we install them locally. The `test_assembler.py` + `test_pixelle_tts_providers.py` files monkey-patch the adapters, so CI doesn't actually need edge-tts installed. Status: **expected**, not a bug.

---

## Backlog (post-PR-54)

The Apr-30 + May-01 live findings list is **fully cleared**. Remaining items, ranked:

| Priority | Item | Size | Source / Notes |
|----------|------|------|----------------|
| **P2** | Phase 2 multi-account fan-out (`video:generate` / `i2v:generate` / `refimg:generate`) | Medium | PR-47 only migrated image. Hold until release cycle has baked PR-47. |
| **P2** | TTS provider UI in Compose panel | Medium | Provider currently in dropdown but not surfaced uniformly between `short` + `audio` modes. |
| **P3** | edge-tts v7.x WordBoundary regression | Small-Medium | Either pin to older edge-tts in `requirements*.txt` or update `EdgeTTSAdapter._run_with_timing` to use `SubMaker`. Currently masked by sentence-fallback. |
| **P3** | CI pre-merge integration check | Small | Add a workflow that does `git merge-tree origin/main HEAD` then runs the full test suite — would have caught the PR-48 × PR-49 collision before #53 was needed. |
| **P3** | Devin Review informational findings cleanup | Small | Carry-over. |
| **P3** | Bundle Python runtime for Windows packaging | Medium | `PR-18` Electron-builder + `PR-19` bundle-python-windows already merged; verify on real Windows host. |

---

## Lessons learned (PR-48 × PR-49 collision)

Two PRs each green on their own branches but red after both land:
- **PR-48** added a 2nd LLM call per scene (`expand_video_variants_for_images`) inside `generate_scene_breakdown`.
- **PR-49** asserted total LLM calls per breakdown = `len(scenes)` (one per scene for variant expansion).
- Both rebased on pre-PR-48 main and CI-green individually.
- After landing both, `test_pixelle_visual_dna.py::test_generate_with_dna_expands_variants_per_scene` failed because the counter PR-49 introduced now caught both kinds of calls.

**Root cause:** CI tests each branch against `origin/main` at the time of push. If two PRs touch overlapping invariants and merge in quick succession, neither CI run sees the other's changes.

**Mitigation options:**
1. Auto-merge with **merge queues** (GitHub native) — re-runs CI on the merged-state head before flipping the merge button.
2. A "post-merge sentinel" CI workflow that runs the full suite on `main` after every push and opens an issue if it fails.
3. Manual "rebase + re-push" right before merging the 2nd PR (cheap, but humans forget).

Recommendation: **option 2** (sentinel workflow). Cheapest, no GitHub plan upgrade, surfaces the regression before users hit it.

---

## Architecture (unchanged from HF-4 checkpoint, condensed)

**Desktop (Electron):** `desktop/dist/creator-forge.{html,js}` (renderer) → `desktop/electron/preload.js` → `desktop/electron/main.js` → `researchSidecar.js` (manages uvicorn child) + IPC routes in `researchIPC.js`. Bridges: `ResearchBridge`, `StudioBridge`, `StoryboardBridge`. Services: `Image`/`RefImage`/`Video`/`I2V` (Puppeteer Grok), `Auth`/`Account`. **Multi-account fan-out:** `MultiAccountFanOut` work-stealing scheduler in `multiAccountFanOut.js` (image:generate only as of PR-47).

**Sidecar (Python FastAPI):** `research/api/main.py` on `:5050`. Routes in `research/api/routes/{studio,producer,research,cloner,keywords,outlier}.py`. Core in `research/core/llm.py` + `research/core/pixelle/{scene_breakdown,composer,tts,subtitles,video_probe,assembler}.py`.

### API Endpoints

Unchanged since HF-4 checkpoint. Full list:

| Endpoint | Method | Function |
|----------|--------|----------|
| `/healthz` | GET | Health check |
| `/studio/topics` `/titles` `/outline` `/script` `/humanize` | POST | Studio pipeline |
| `/producer/scene_breakdown` | POST | Script → N scenes + Visual DNA + per-image-variant video prompts |
| `/producer/variant_prompts` | POST | Re-roll image variant prompts |
| `/producer/short` | POST | Compose 9:16 MP4 (TTS + captions + ffmpeg single-shot) |
| `/producer/audio` | POST | TTS-only → MP3/WAV + SRT |
| `/producer/assemble` | POST | Concat scenes + audio + soft/burn subs → final.mp4 |
| `/producer/voices` `/providers` | GET | Capability listing |
| `/research/niche` `/keywords` `/outlier` `/cloner` | POST | Research toolkit |

---

## Environment

| Variable | Purpose | Required for |
|----------|---------|--------------|
| `DEEPSEEK_API_KEY` | LLM calls | Research / Studio / scene_breakdown / variant_prompts / Visual DNA |
| `YOUTUBE_API_KEY` | YouTube research | `/research/niche` `/research/outlier` |
| `GROK_PROFILE_DIR` | Persistent Grok session | Image / I2V / Video / RefImg generation |
| `CREATOR_FORGE_ACCOUNTS_FILE` | Override accounts.json path | optional |

`/producer/short`, `/producer/audio`, `/producer/assemble` need **no** API keys — TTS + ffmpeg only.

---

## Quickstart (verified 2026-05-02)

```bash
# Sidecar — from REPO ROOT (not from research/)
cd /path/to/creator-forge
pip install edge-tts mutagen   # required for /producer/audio with captions
uvicorn research.api.main:app --host 127.0.0.1 --port 5050

# Desktop — separate terminal
cd desktop && npm install && npm start

# Tests
ruff check research                                    # lint
pytest research/tests/test_api_*.py \
       research/tests/test_assembler.py \
       research/tests/test_pixelle_tts_providers.py \
       research/tests/test_video_probe.py -q          # 209 strict pytest
(cd research && pytest tests/test_pixelle_visual_dna.py -q)  # +30 visual DNA
for t in desktop/tests/test_*.js; do node "$t"; done   # 20 desktop offline files
```

---

## Hotfixes still in effect (carried forward from HF-4)

- `researchIPC.js`: LLM-heavy endpoints (`scene_breakdown`, `visual_dna`, `variant_prompts`, `script`, `humanize`) timeout = 300s; `scene_breakdown` + `variant_prompts` extended to 600s for parallel expansion.
- Sidecar must be started with env vars BEFORE Electron, otherwise Electron reuses a stale sidecar without keys.
- README's `cd research && python -m api.main` form **does not work** — always run uvicorn from repo root (route imports use absolute `research.api...` prefix).
- HF-4 — Pro mode always-on, T2V removed, videos/scene fixed at 1, duration picker (6s / 10s) — all still in effect.
- HF-3 — Scene breakdown progress UI (5 phase texts in Vietnamese + elapsed counter) + I2V gate on Generate-videos button — still in effect.
- HF-2 — Per-channel IPC timeouts + `ThreadPoolExecutor(max_workers=8)` for parallel scene expansion — still in effect.
- HF-1 — API Keys setup dialog auto-opens if keys missing + ⚙ button in header — still in effect.
