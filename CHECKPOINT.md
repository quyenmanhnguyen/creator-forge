# Creator-Forge — CHECKPOINT

> Last updated: 2026-05-02 (post HF-4/5/6/7 sprint, PR-48 → PR-73)
> Main HEAD: `8c964ee` — `docs(checkpoint): rewrite to reflect actual main HEAD (post PR-72) (#73)`
> Last code commit on main: `9f95c26` — `fix(sidecar): real TCP bind probe in waitForPortFree (PR-72) (#72)`
> User confirmation: PR-72 verified working on Windows — "đã fix rồi" (Save flow no longer hits WinError 10048).

---

## Status

| Metric | Value |
| --- | --- |
| **CI strict pytest bucket** | **213 passed** (research/tests/test_api_*.py + test_video_probe + test_pixelle_tts_providers + test_assembler) |
| **Desktop offline test files** | **28 / 28 PASS** (deterministic on 3 re-runs) |
| `ruff check research` | clean |
| `node --check` (Electron entry points) | clean |
| Pixelle heavy-import tests | not run in CI (require moviepy / edge-tts / mutagen — best-effort only) |

---

## Sprint History (PR-48 → PR-73)

### HF-4 — Storyboard / Variant / Fan-out (PR-47 … PR-61)

| PR | Title | Notes |
|---|---|---|
| #47 | Work-stealing multi-account fan-out for `image:generate` | Phase 1 of the multi-account scheduler. |
| #48 | Image ↔ Video variant continuity + Pro mode toggle | Variant rows carry over from image batch to video batch. |
| #49 | `scene_breakdown` speed-up + progress UI | Streaming progress while LLM splits the script. |
| #50 | Gate I2V "Generate videos" behind settled images + auto-scroll | Renderer-side guard against running video before images exist. |
| #51 | Testing skill update | Storyboard progress UI / I2V gate testing notes. |
| #52 | Observability | Mirror `sendLog` to console + return fan-out stats from `image:generate`. |
| #53 | Test split | Distinguish image vs video variant LLM calls in visual DNA test. |
| #54 | Paired hero image in video batch table | Storyboard UI clarity. |
| #56 | docs(checkpoint) refresh for post-PR-61 state | Previous checkpoint snapshot. |
| #57 | fix(tts): pass `boundary="WordBoundary"` to edge-tts v7.x | Compatibility with newer edge-tts. |
| #58 | ci(sentinel): open issue when CI on main goes red | Auto-triage. |
| #59 | feat(keys): persistent API-keys store + ⚙ Settings dialog | API keys saved per-user, applied via sidecar restart. |
| #60 | feat(tts): voices tagged with provider + voice-picker filter | Compose UI shows only the selected engine's voices. |
| #61 | Phase 2 of PR-47: scheduler now covers `video` / `i2v` / `refimg` | Multi-account fan-out generalised. |

### HF-5 — Batch Panel Overhaul (PR-63, PR-69)

| PR | Title | Notes |
|---|---|---|
| #63 | feat(packaging): bundle Python runtime for macOS + Linux installers (PR-62) | electron-builder copies `python-build-standalone` into `extraResources`. |
| #69 | feat(desktop): HF-5 Batch Panel Overhaul — streamline production UI | Compact `Batch Image + Video` panel. Hides `Video mode` / `Images per scene` / `Videos per scene` / `Pro mode`. Adds `Duration` dropdown (6s/10s). Output folder collapsed to icon-only `📁`. Each section header gains progress badge + `🔄 Retry failed` + `📂 Open folder`. `runSceneBreakdown()` auto-clears the batch table. |

### HF-6 + HF-7 — Sidecar restart hardening (PR-65 → PR-72)

A chain of seven follow-up fixes triggered by users hitting `sidecar restart failed` on the API-keys Save flow.

| PR | Title | Root cause it fixed |
|---|---|---|
| #65 | force fresh spawn on `restart()` so saved API keys reach uvicorn | Previously `start()`'s probe-and-reuse short-circuit was skipping the new `extraEnv`. |
| #66 | kill-by-port fallback when stale pre-PR-65 sidecar 404s `/admin/shutdown` | Older sidecar builds didn't expose `/admin/shutdown`. |
| #67 | always run `killByPort` fallback when `waitForPortFree` times out (PR-66 follow-up) | The fallback only ran in the `externalReuse` branch; spawned-mode could also leak the port. |
| #68 | tree-kill child on Windows + extensive restart logging (PR-67 follow-up) | Windows `child.kill('SIGTERM')` only terminates the immediate PID, leaving uvicorn descendants alive. Fixed via `taskkill /F /T /PID`. |
| #71 | bump healthz wait to 30s → 90s + 5s progress logs + surface stderr tail (HF-6) | Cold-start of bundled `python-build-standalone` + AV scanning on Windows can take ~70s. The prior 30s budget timed out and gave no clue why. New env override: `CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS`. |
| #72 | **real TCP bind probe in `waitForPortFree`** (HF-7) | Pre-PR-72 `waitForPortFree` checked `/healthz` (HTTP). `/healthz` goes silent the moment the python process dies, but on Windows the kernel can hold the listening socket in `TIME_WAIT` for several more seconds — leading to `WinError 10048: error while attempting to bind on address ('127.0.0.1', 5050)` from the new uvicorn spawn. Replaced HTTP probe with `net.createServer().listen(port)` — kernel-truth answer. **Verified on user's Windows machine — Save flow now succeeds.** |

PR-72 is the fix that unblocked Windows users on the API-keys Save flow. PR-71 + PR-72 are both required: PR-71 buys the time budget the slow Windows cold-start needs; PR-72 ensures the spawn can actually bind once the old sidecar's socket releases.

### Docs (PR-73)

| PR | Title | Notes |
|---|---|---|
| #73 | docs(checkpoint): rewrite to reflect actual main HEAD (post PR-72) | Replaces stale pre-HF-5 plan content (the previous `0beba4b` commit had a misleading message — its body still claimed HF-5 was 'plan approved, not yet implemented'). New body has accurate sprint history, test counts, file pointers. |

---

## Test Inventory

### Strict CI bucket (213 passed)

`research/tests/test_api_niche.py`, `test_api_keywords.py`, `test_api_outlier.py`, `test_api_cloner.py`, `test_api_studio.py`, `test_api_producer.py`, `test_video_probe.py`, `test_pixelle_tts_providers.py`, `test_assembler.py`.

### Desktop offline tests (28 files, all PASS)

```
test_account_service_path.js              test_research_sidecar_health_timeout.js
test_auth_service_keep_alive.js           test_research_sidecar_lookup.js
test_auth_service_relogin_path.js         test_research_sidecar_port_bind.js   ← PR-72 NEW (9 tests)
test_auth_session_status.js               test_research_sidecar_restart.js
test_compose_voice_picker_helpers.js      test_storyboard_account_manager_helpers.js
test_e2e_compose_script.js                test_storyboard_assemble_helpers.js
test_fetch_python_runtime.js              test_storyboard_batch_helpers.js
test_grok_profile_dir.js                  test_storyboard_bridge.js
test_i2v_service_process_one.js           test_storyboard_compose_helpers.js
test_image_service_config.js              test_storyboard_compose_table_helpers.js
test_keys_store.js                        test_storyboard_login_banner_helpers.js
test_multi_account_fan_out.js             test_storyboard_progress_helpers.js
test_refimg_service_process_one.js        test_storyboard_video_compose_helpers.js
                                          test_video_service_process_one.js
                                          test_video_validation_helpers.js
```

### Sidecar test files (4)

| File | Tests | What it covers |
|---|---|---|
| `test_research_sidecar_lookup.js` | repo-root walk, packaged-resources lookup, python executable resolution | path resolution |
| `test_research_sidecar_restart.js` | `sendShutdown`, `waitForPortFree`, `restart()` flow, `killByPort`, Windows tree-kill | restart hot path (PR-65 → PR-68) |
| `test_research_sidecar_health_timeout.js` | `healthTimeoutMs()` env override, periodic progress log, stderr-tail surfacing | PR-71 |
| `test_research_sidecar_port_bind.js` | `canBindPort` returns kernel-truth, `waitForPortFree` non-HTTP regression | PR-72 |

---

## Known caveats / not yet covered

* **Pixelle heavy-import tests** (moviepy / edge-tts / mutagen / piper-tts) are NOT in the strict CI bucket — they run best-effort only. The full `pytest research/tests` count of 213+30+7+... seen in older checkpoints requires those deps installed locally.
* **Windows-specific bugs** cannot be reproduced on the Linux Devin VM. Both PR-71 (cold-start >30s) and PR-72 (`WinError 10048`) were diagnosed from user logs on Windows; the offline test suite simulates the regressions through bind-probe / health-probe stubs.

---

## File-level architecture pointers

| Concern | Files |
|---|---|
| Sidecar lifecycle (start/stop/restart/healthz) | `desktop/electron/researchSidecar.js` |
| API-keys save → sidecar restart | `desktop/electron/main.js` (IPC handler) → `desktop/electron/keysStore.js` → `researchSidecar.restart({ extraEnv })` |
| Renderer Settings ⚙ dialog | `desktop/dist/creator-forge.js` (search `keys.save`) |
| Batch Image+Video panel (HF-5) | `desktop/dist/creator-forge.html` (sbb-* IDs) + `desktop/dist/creator-forge.js` (`sbb*` functions) |
| Multi-account fan-out scheduler | `desktop/src/services/multiAccountFanOut.js` |
| Python sidecar entry | `research/api/main.py` |
| Bundled python runtime locator | `desktop/electron/researchSidecar.js::resolvePythonExecutable` |

---

## Running locally (verified 2026-05-02)

```bash
# Sidecar — terminal 1, from REPO ROOT
pip install edge-tts mutagen   # required for /producer/audio
uvicorn research.api.main:app --host 127.0.0.1 --port 5050

# Desktop — terminal 2
cd desktop && npm install && npm start
```

API keys are persisted per-user via the ⚙ Settings dialog at `userData/api-keys.json`. After Save, `researchSidecar.restart({ extraEnv })` fires and re-spawns uvicorn with the new env.

| Key | Required for |
|---|---|
| `DEEPSEEK_API_KEY` | Studio (topics/titles/outline/script) + scene_breakdown + variant_prompts |
| `GROK_ACCOUNTS_JSON` | Image / I2V / Video / RefImg generation |
| `YOUTUBE_API_KEY` | Research / niche / outlier |
| `GOOGLE` / `GEMINI` / `RUNNINGHUB` | Reserved (not yet wired) |

`/producer/short`, `/producer/audio`, `/producer/assemble` work without any API key — only `edge-tts` + `ffmpeg`.

---

## Quick guidance for the next sprint

* The sidecar restart hot path is now well-tested (28 desktop offline files, including 4 dedicated to sidecar). New work touching `researchSidecar.js` should add cases to one of `test_research_sidecar_{restart,health_timeout,port_bind,lookup}.js`.
* `electron-builder.yml` copies `research/` into `extraResources` so the packaged app finds it via `process.resourcesPath`. Don't break that — `desktop/tests/test_research_sidecar_lookup.js` will catch most regressions.
* `CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS` is the per-machine env knob for users whose Windows cold-start is exceptionally slow (>90s). 180000 (3 min) is a safe upper bound to suggest.
