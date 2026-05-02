# Creator-Forge — CHECKPOINT

> Last updated: 2026-05-02 (post-PR-61 validation pass)
> Main HEAD: `9e3f204` — `feat(fanout): work-stealing multi-account scheduler for video / i2v / refimg (Phase 2 of PR-47) (#61)`

## Status

| Metric | Value |
|--------|-------|
| Strict pytest bucket (CI must-pass) | **213 passed** (was 209 in pre-PR-57 checkpoint; +4 from PR-60 voices filter / unknown provider / case-insensitive) |
| `test_pixelle_visual_dna.py` | **30 passed** (run from `research/` due to `core` import path) |
| `test_pixelle_tts_timing.py` | **7 passed** (was 4; +3 from PR-57 v6/v7/helper boundary branches) |
| Desktop offline tests | **24/24 files PASS** (was 20 pre-PR-57; +4 from PR-60 voice picker + PR-61 video/i2v/refimg `_processOneBatchItem` tests) |
| `test_storyboard_batch_helpers.js` | 103 / 103 (unchanged since PR-54) |
| Ruff lint | clean |
| Live E2E (backend) | ✅ Verified 2026-05-02 — `/producer/audio` (now `caption_source = word_boundaries` post-PR-57), `/producer/voices` provider filter, multi-account work-stealing across video batch |
| Open PRs | **3** (PR-58 sentinel, PR-59 keys store, this PR-56 checkpoint refresh) |

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
| PR-57 | edge-tts v7.x WordBoundary fix (pass `boundary="WordBoundary"`) | ✅ Merged (live-tested 8/8 assertions; flipped `caption_source` from `sentence_fallback` → `word_boundaries`) |
| PR-58 | CI sentinel workflow — open issue when CI on `main` goes red | 🟢 Open, 2/2 CI green |
| PR-59 | Persistent API-keys store + ⚙ Settings dialog (auto-open on first launch) | 🟢 Open, 2/2 CI green |
| PR-60 | TTS provider-tagged voices + Compose voice-picker filter | ✅ Merged (live-tested 10/10 assertions: 5 sidecar API + 5 UI Electron) |
| PR-61 | Phase 2 multi-account fan-out (`video` / `i2v` / `refimg`) | ✅ Merged (live-tested 7/8 assertions with 2 Grok accounts; A4 verified transitively) |

PR-55 / PR-56 reserved for the prior checkpoint commit + this refresh.

---

## What changed since post-PR-54 checkpoint

### PR-57 — edge-tts v7.x WordBoundary fix (P3)
- Root cause: edge-tts v7.0+ added a `boundary` param to `Communicate.__init__` defaulting to `"SentenceBoundary"`. Pre-v7 code worked because v6.x emitted WordBoundary by default; v7.2.8 silently dropped to sentence chunks → `_run_with_timing` fell back to `fallback_captions_from_text`.
- Fix: `EdgeTTSAdapter._run_with_timing` introspects `inspect.signature(edge_tts.Communicate)`; if `boundary` is a recognised parameter, pass `boundary="WordBoundary"` explicitly. Backwards-compatible with v6.x (parameter absent → branch skipped).
- 3 new test cases in `test_pixelle_tts_timing.py` (v7 path / v6 path / direct helper).
- Live verified post-merge on `/producer/audio`: same 3-sentence script flipped from 3 sentence captions (avg 4.2s) to 10 word-grouped captions (avg 1.066s). Caption_source now reads `word_boundaries`.

### PR-58 — CI sentinel workflow (P3)
- New `.github/workflows/sentinel.yml` listens to `workflow_run` on the `CI` workflow (default branch only). When CI on `main` concludes `failure` / `timed_out` / `cancelled`, opens or comments on a `sentinel-failure`-tagged issue with the failing run URL + commit SHA.
- De-dupes by reusing an open issue if one already exists.
- `workflow_dispatch` fallback for manual dry-run.
- Closes the "Lessons learned" P3 below (option 2 — post-merge sentinel).
- Cannot be live-tested before merge (GitHub design: `workflow_run` listeners only fire from default-branch copy).

### PR-59 — Persistent API-keys store + ⚙ Settings dialog (HF-1 follow-up)
- ⚙ button in `creator-forge.html` header opens an API-keys modal whitelisting 5 keys: `DEEPSEEK`, `YOUTUBE`, `GOOGLE`, `GEMINI`, `RUNNINGHUB`.
- Persists at `app.getPath('userData')/api-keys.json` (file mode 0600).
- Auto-opens on first launch when no keys present (carries forward HF-1 behaviour).
- Save → bounces sidecar via `researchSidecar.restart({ extraEnv })` so uvicorn picks up the new env without a full app relaunch.
- 12 new unit tests (`test_keys_store.js`).

### PR-60 — TTS provider-tagged voices + Compose picker filter
- `Voice` dataclass in `research/core/pixelle/voices.py` gains `provider` field. 6 piper-tts voices added alongside existing edge-tts.
- `/producer/voices` accepts `?provider=` query param; response includes `provider` / `providers` / `warnings`.
- Renderer ships `desktop/dist/compose_voice_picker_helpers.js` (UMD) — flips `ps-tts-provider` repaints `ps-voice` filtered by provider, auto-picks default (preserve current → sidecar default → first option). Empty state renders `no voices for <provider>`.
- `/producer/short` + `/producer/audio` validation now scoped to selected provider's allow-list (no more silent Piper-id-as-Edge-id mismatches at runtime).
- Strict pytest +4, desktop offline +1 (`test_compose_voice_picker_helpers.js` 13 cases).
- Live tested 10/10 (5 sidecar API + 5 UI Electron).

### PR-61 — Phase 2 multi-account fan-out (video / i2v / refimg)
- Extended `MultiAccountFanOut` work-stealing scheduler from PR-47 (image-only) to `video:generate` / `i2v:generate` / `refimg:generate`.
- Each Service grew a `_processOneBatchItem(item, session, config, onProgress, myIdx, globalNum, totalForLog, outputFolder?)` helper extracted from `generateBatch`. `generateBatch` now delegates → single-account path bytes-identical.
- IPC handlers in `desktop/electron/main.js` build a `runFanOut({ items, sessions, processOne, workerStaggerMs, onProgress })` call instead of looping a single-account batch.
- IPC return shape extended with `stats: fanOut.stats` (per-session: `accIdx`, `taken`, `ok`, `failed`, `quarantined`) — mirrors PR-52's pattern for image.
- Per-session log line replaces `(K per acc)`: `Generating N videos across M account(s) — work-stealing queue, up to C/account = up to M*C parallel...` and `Video generation complete: N/M successful | Acc1=N/M Acc2=N/M`.
- 17 new offline test cases across `test_video_service_process_one.js` (6) / `test_i2v_service_process_one.js` (5) / `test_refimg_service_process_one.js` (6). Wired into `ci.yml`.
- Live tested with 2 Grok accounts on a 4-prompt T2V batch: 4/4 success, log lines confirmed work-stealing pivot, stats field verified transitively from end-log construction.

---

## Live E2E status (verified 2026-05-02 on `9e3f204`)

| Test | Endpoint / Surface | Result |
|------|-------------------|--------|
| 1 | `GET /healthz` | `{"ok":true,"service":"creator-forge.research"}` ✅ |
| 2 | `POST /producer/audio` (edge-tts) | `voice.mp3` (~10s) + SRT now with `caption_source = word_boundaries` (PR-57) ✅ |
| 3 | `POST /producer/assemble` | `final.mp4` with h264 + aac + mov_text ✅ (carry-over) |
| 4 | `GET /producer/voices?provider=edge-tts` | 12 entries, default `en-US-AriaNeural` ✅ (PR-60) |
| 5 | `GET /producer/voices?provider=piper-tts` | 6 entries, default `vi_VN-vais1000-medium` ✅ (PR-60) |
| 6 | Compose UI provider × voice picker (Full short + Audio only modes) | 5/5 UI assertions ✅ (PR-60) |
| 7 | `video:generate` IPC with 2 Grok accounts × 4 prompts | 4/4 mp4 generated, work-stealing queue confirmed ✅ (PR-61) |
| 8 | App boot + sidecar pill green | Electron renders, sidecar pill `sidecar ready` ✅ |

UI panels NOT re-tested live this pass (renderer code unchanged):
- Storyboard scene_breakdown progress UI — covered by PR-49's `test_storyboard_progress_helpers.js`
- Video Assembly autofill — covered by `pullFromVideoBatch` + `useLatestProducerAudio` unit tests
- Source column render path (PR-54) — verified 2026-05-01 via DevTools harness, 5/5 assertions

### Findings

1. **Cloudflare turnstile blocks Auto-login on Devin VMs.** Programmatic Puppeteer login hits "Verify you are human" checkpoint (per-account, every fresh session). Workaround: manually click the turnstile checkbox in the headful browser when it appears — Puppeteer continues from there. Documented in `.agents/skills/testing-app/SKILL.md` updates suggested during PR-61 testing. Not specific to fan-out — affects any Grok login flow without a persisted session.

2. **DevTools shortcut not bound on this Electron build.** F12 / Ctrl+Shift+I do not open DevTools, leaving no obvious way to programmatically inspect IPC return shapes during testing. Workaround: verify return shapes transitively via log lines that mechanically construct from the field (e.g. PR-61's per-session log line is built from `stats.perSession.map(...)`). Documented in SKILL.md updates.

3. **Mutagen + edge-tts not in CI strict bucket.** Status unchanged since post-PR-54: heavy stack deliberately omitted to keep CI fast. Adapters monkey-patched in tests so CI does not need real edge-tts. Status: **expected**, not a bug. Env config suggestion approved 2026-05-02 to install `edge-tts` + `mutagen` in maintenance step for future Devin sessions.

---

## Backlog (post-PR-61)

The pre-PR-57 backlog dropped 4 items (P2 video fan-out → PR-61, P2 TTS provider UI → PR-60, P3 edge-tts WordBoundary → PR-57, P3 CI pre-merge integration → PR-58). Remaining items, ranked:

| Priority | Item | Size | Source / Notes |
|----------|------|------|----------------|
| **P3** | Devin Review informational findings cleanup | Small | Carry-over. |
| **P3** | Bundle Python runtime for Windows packaging | Medium | `PR-18` Electron-builder + `PR-19` bundle-python-windows already merged; verify on real Windows host + extend to `dist:linux` / `dist:mac` (currently `darwin-*` raises "follow-up PR" by design). |
| **P3** | macOS / Linux installer parity | Medium | `electron-builder.yml` has `mac` (DMG) + `linux` (AppImage) targets but they don't pull in the bundled python runtime — only `win` does. Once the `darwin-*` branch in `scripts/fetch-python-runtime.js` is implemented, mirror the `extraResources` block. |

---

## Lessons learned (carried forward)

### PR-48 × PR-49 collision (now mitigated by PR-58)
Two PRs each green on their own branches but red after both land. Root cause: CI tests each branch against `origin/main` at the time of push; if two PRs touch overlapping invariants and merge in quick succession, neither CI run sees the other's changes.

**Resolution:** PR-58 sentinel workflow (option 2 from prior recommendation) — runs the full suite on `main` after every push and opens an issue if it goes red. Awaits merge as of 2026-05-02.

### Multi-account live testing requires creds (PR-61 carry-forward)
Phase 2 fan-out's value is only observable with ≥2 Grok accounts. With balanced latency the work-stealing pattern still appears in the per-session log line (`Acc1=2/2 Acc2=2/2`) but no imbalance is visible; with throttled accounts the imbalance becomes the proof. Document this expectation in any future fan-out testing playbooks.

---

## Architecture (unchanged from HF-4 checkpoint, condensed)

**Desktop (Electron):** `desktop/dist/creator-forge.{html,js}` (renderer) → `desktop/electron/preload.js` → `desktop/electron/main.js` → `researchSidecar.js` (manages uvicorn child) + IPC routes in `researchIPC.js`. Bridges: `ResearchBridge`, `StudioBridge`, `StoryboardBridge`. Services: `Image`/`RefImage`/`Video`/`I2V` (Puppeteer Grok), `Auth`/`Account`. **Multi-account fan-out:** `MultiAccountFanOut` work-stealing scheduler in `multi_account_fan_out.js` — covers `image:generate` (PR-47) + `video:generate` / `i2v:generate` / `refimg:generate` (PR-61).

**Sidecar (Python FastAPI):** `research/api/main.py` on `:5050`. Routes in `research/api/routes/{studio,producer,research,cloner,keywords,outlier}.py`. Core in `research/core/llm.py` + `research/core/pixelle/{scene_breakdown,composer,tts,subtitles,video_probe,assembler,voices}.py`.

### API Endpoints

| Endpoint | Method | Function |
|----------|--------|----------|
| `/healthz` | GET | Health check |
| `/studio/topics` `/titles` `/outline` `/script` `/humanize` | POST | Studio pipeline |
| `/producer/scene_breakdown` | POST | Script → N scenes + Visual DNA + per-image-variant video prompts |
| `/producer/variant_prompts` | POST | Re-roll image variant prompts |
| `/producer/short` | POST | Compose 9:16 MP4 (TTS + captions + ffmpeg single-shot) |
| `/producer/audio` | POST | TTS-only → MP3/WAV + SRT (PR-57: word-boundary captions) |
| `/producer/assemble` | POST | Concat scenes + audio + soft/burn subs → final.mp4 |
| `/producer/voices` | GET | Capability listing — accepts `?provider=` filter (PR-60) |
| `/producer/providers` | GET | List supported TTS providers |
| `/research/niche` `/keywords` `/outlier` `/cloner` | POST | Research toolkit |

---

## Environment

| Variable | Purpose | Required for |
|----------|---------|--------------|
| `DEEPSEEK_API_KEY` | LLM calls | Research / Studio / scene_breakdown / variant_prompts / Visual DNA |
| `YOUTUBE_API_KEY` | YouTube research | `/research/niche` `/research/outlier` |
| `GROK_PROFILE_DIR` | Persistent Grok session | Image / I2V / Video / RefImg generation |
| `CREATOR_FORGE_ACCOUNTS_FILE` | Override accounts.json path | optional |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` / `RUNNINGHUB_API_KEY` | Reserved for future provider integrations | Whitelisted by PR-59 keys-store but not yet wired |

`/producer/short`, `/producer/audio`, `/producer/assemble` need **no** API keys — TTS + ffmpeg only. After PR-59 lands, the ⚙ Settings dialog persists keys at `userData/api-keys.json` (mode 0600); on launch they are merged into the sidecar's env via `researchSidecar.start({ extraEnv })`.

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
       research/tests/test_video_probe.py -q          # 213 strict pytest
(cd research && pytest tests/test_pixelle_visual_dna.py -q)  # +30 visual DNA
pytest research/tests/test_pixelle_tts_timing.py -q   # +7 edge-tts timing (PR-57)
for t in desktop/tests/test_*.js; do node "$t"; done   # 24 desktop offline files
```

---

## Hotfixes still in effect (carried forward)

- `researchIPC.js`: LLM-heavy endpoints (`scene_breakdown`, `visual_dna`, `variant_prompts`, `script`, `humanize`) timeout = 300s; `scene_breakdown` + `variant_prompts` extended to 600s for parallel expansion.
- Sidecar must be started with env vars BEFORE Electron, otherwise Electron reuses a stale sidecar without keys. PR-59 mitigates this for users by adding `researchSidecar.restart({ extraEnv })` on Save.
- README's `cd research && python -m api.main` form **does not work** — always run uvicorn from repo root (route imports use absolute `research.api...` prefix).
- HF-4 — Pro mode always-on, T2V removed, videos/scene fixed at 1, duration picker (6s / 10s) — all still in effect.
- HF-3 — Scene breakdown progress UI (5 phase texts in Vietnamese + elapsed counter) + I2V gate on Generate-videos button — still in effect.
- HF-2 — Per-channel IPC timeouts + `ThreadPoolExecutor(max_workers=8)` for parallel scene expansion — still in effect.
- HF-1 — API Keys setup dialog auto-opens if keys missing + ⚙ button in header — promoted from in-memory to persistent (`userData/api-keys.json`) by PR-59.
