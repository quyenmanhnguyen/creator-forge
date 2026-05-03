# Creator-Forge — CHECKPOINT

> Last updated: 2026-05-03 (post HF-9 sprint — image gate hardening + per-scene audio + LLM refine + PR-83 retry boost)
> Main HEAD: `c84dd17` — `feat(image): boost output count on retry + enhanced reject reasons (#83)`
> Last sprint code commits: `53d2d43` (PR-79) → `9385554` (PR-80) → `e71553a` (PR-81) → `bff32f9` (PR-82) → `c84dd17` (PR-83)

---

## Status

| Metric | Value |
| --- | --- |
| **CI strict pytest bucket** | **246 passed** (`test_api_*.py` + `test_video_probe` + `test_pixelle_tts_providers` + `test_assembler` + `test_llm_helpers`) — +26 from HF-9 additions (PR-79 +11 audio-scene, PR-80 +5 adaptive-audio/gate, PR-81 +10 refine-script/fallback) |
| **Full pytest (local, all deps)** | **644 passed, 7 failed** — all 7 failures are `test_pixelle_grok_browser.py` (require Playwright Chromium binary, not a regression; pre-existing env gap) |
| **Desktop offline test files** | **28 / 28 PASS** — `test_storyboard_batch_helpers.js`: **123 / 123** (+7 from PR-82/83: retry assertions, reason tiers); `test_storyboard_assemble_helpers.js`: **21 / 21**. Cross-platform path assertions hardened for Windows. |
| `ruff check research` | clean |
| `node --check` (Electron entry points + dist) | clean |
| Pixelle heavy-import tests | not run in CI (require moviepy / edge-tts / mutagen — best-effort only) |
| Live E2E verification | **PR-79: 13/13 assertions** (per-scene audio + image gate, with negative controls) · **PR-80: 12/12** (100 KB gate + adaptive audio via sidecar) · **PR-81: 28/28** (real-LLM refine + fallback + thumbnail CSS) |

---

## Sprint History (PR-48 → PR-81)

### HF-9 — Image gate hardening + Per-scene audio + LLM Refine-script (PR-79, PR-80, PR-81)

User feedback after HF-8: "Small broken Grok images (50–150 KB) still slip into I2V batch. Compose audio uses one global TTS pass — narration timing doesn't match per-scene video lengths. Compose textarea still shows raw image-prompt JSON with `negative_prompt`, `nsfw`, `avoid` keys when script is polluted. Storyboard thumbnails are blurry at 64×64."

| PR | Title | What it ships |
| --- | --- | --- |
| #79 | fix(image+audio): block <200KB images from I2V batch + per-scene narration TTS | **(1)** `enrichBatchRowsWithFileBytes` calls `fs.stat` and injects `bytes` into each image row before `applyBatchResult`; gate inside `applyBatchResult` demotes rows with `bytes < MIN_OK_IMAGE_BYTES` to `fallback` so `pairImagePathsForI2V` never sees them. **(2)** `/producer/audio` accepts `scene_narrations[]` — one narration string per scene; each slot is TTS-rendered independently and padded with ffmpeg silence to match its `scene_videos[]` duration, then concatenated. Negative control: omitting `scene_narrations` falls back to legacy single-pass TTS. Adds 11 new backend tests + 4 new JS tests. |
| #80 | image gate to 100KB + best-quality video defaults + adaptive audio + Final-video Open/Folder buttons | **(1)** `MIN_OK_IMAGE_BYTES` lowered from `200 * 1024` → `100 * 1024` (empirically matches real Grok failure range). **(2)** Video generation defaults bumped to best-quality presets (duration, Pro mode). **(3)** `/producer/audio` gains `humanize_per_scene` flag: when set, DeepSeek rewrites each scene narration to natural spoken language before TTS (falls back gracefully if key missing). **(4)** Compose panel adds **Open file** + **📂 Open folder** buttons for the final assembled video. Adds 5 new backend tests. |
| #81 | feat(audio,thumbs): LLM Refine-script for narration + sharper storyboard thumbnails | **(1)** New `POST /producer/refine_script` endpoint: accepts a polluted script (raw image-prompt JSON), `scene_videos[]` for duration target, and an image-prompts list for topic grounding; calls DeepSeek to strip banned tokens (`negative_prompt`, `nsfw`, `avoid`, `watermark`, `deformed`, etc.) and rewrite to clean narration sized to `target_words = ⌊target_duration_s × 2.5⌋`; falls back (preserves input, `used_llm=false`, warning) when `DEEPSEEK_API_KEY` absent. **(2)** Storyboard `.thumb-cell img/video` bumped from 64×64 → **96×132 portrait** + `image-rendering: -webkit-optimize-contrast` for sharper downscale; cell width 76→112 px. **(3)** New `research/core/llm.py` helper (`call_deepseek`) extracted from scattered inline calls. Adds 10 new backend tests + 1 JS thumbnail CSS test. |
| #82 | fix(image): auto-retry small images + fix stale thumbnail on Retry | **(1)** Renderer auto-retries rows up to 3 times when they fall below the 100 KB gate. **(2)** Service-level retry checks saved image size before returning, backing off and retrying up to 2 times internally. **(3)** Clears `url/image_path` on retry to avoid stale thumbnails. Adds 4 JS tests. |
| #83 | feat(image): boost output count on retry + enhanced reject reasons | **(1)** Boosts `imageGenerationCount` from 1 to 4 on retries (both Renderer and Service-level) so Grok produces multiple candidates, sorting by size and keeping the largest. **(2)** Enhances reject reasons for <30 KB (CDN moderation), <60 KB (incomplete download), and <100 KB (too small). Adds 3 JS tests. |

All three PRs tested end-to-end on the Devin Linux VM with ffmpeg-generated scene_videos (no Grok/DeepSeek credentials needed for the fix paths). Negative controls confirmed flip-one-knob design: same payload, only env or flag toggled → behaviour flips lockstep.

### HF-8 — Compose audio-only + auto-fit SRT + Video Assembly auto-fill (PR-75, PR-77)

User feedback after HF-7: "`Output mode` and `Style` selectors on Compose are noise. Captions don't match scene durations. `scene_videos` doesn't auto-fill. Script from Storyboard doesn't propagate into Compose. Broken Grok images treated as `generated`. Variant scene prompts reuse same noun phrase."

| PR | Title | What it ships |
| --- | --- | --- |
| #75 | feat(compose,assemble): drop short mode, auto-fit SRT to video, auto-fill assembly | Removes `Output mode` + `Style` selectors; pins to `/producer/audio`. Adds `Target duration override` + ffprobe-driven `scene_videos[]` sum. `Video Assembly` auto-fills from batch. `/producer/short` retained for back-compat. +13 tests. |
| #77 | PR-B: real-flow auto-fill + image-size gate + script mirror + scene-prompt diversity | `pullScenePathsFromBatch` reads `video_path` + `savedFile`; filters status. `MIN_OK_IMAGE_BYTES = 200 KB` gate (later reduced to 100 KB in PR-80). Script mirror with `psScriptUserEdited` guard. Hard rule #6 SCENE-TO-SCENE DIVERSITY in breakdown prompt. |

### HF-4 — Storyboard / Variant / Fan-out (PR-47 … PR-61)

| PR | Title | Notes |
| --- | --- | --- |
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
| --- | --- | --- |
| #63 | feat(packaging): bundle Python runtime for macOS + Linux installers (PR-62) | electron-builder copies `python-build-standalone` into `extraResources`. |
| #69 | feat(desktop): HF-5 Batch Panel Overhaul — streamline production UI | Compact `Batch Image + Video` panel. Hides `Video mode` / `Images per scene` / `Videos per scene` / `Pro mode`. Adds `Duration` dropdown (6s/10s). Output folder collapsed to icon-only `📁`. Each section header gains progress badge + `🔄 Retry failed` + `📂 Open folder`. `runSceneBreakdown()` auto-clears the batch table. |

### HF-6 + HF-7 — Sidecar restart hardening (PR-65 → PR-72)

A chain of seven follow-up fixes triggered by users hitting `sidecar restart failed` on the API-keys Save flow.

| PR | Title | Root cause it fixed |
| --- | --- | --- |
| #65 | force fresh spawn on `restart()` so saved API keys reach uvicorn | Previously `start()`'s probe-and-reuse short-circuit was skipping the new `extraEnv`. |
| #66 | kill-by-port fallback when stale pre-PR-65 sidecar 404s `/admin/shutdown` | Older sidecar builds didn't expose `/admin/shutdown`. |
| #67 | always run `killByPort` fallback when `waitForPortFree` times out (PR-66 follow-up) | The fallback only ran in the `externalReuse` branch; spawned-mode could also leak the port. |
| #68 | tree-kill child on Windows + extensive restart logging (PR-67 follow-up) | Windows `child.kill('SIGTERM')` only terminates the immediate PID, leaving uvicorn descendants alive. Fixed via `taskkill /F /T /PID`. |
| #71 | bump healthz wait to 30s → 90s + 5s progress logs + surface stderr tail (HF-6) | Cold-start of bundled `python-build-standalone` + AV scanning on Windows can take ~70s. New env override: `CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS`. |
| #72 | **real TCP bind probe in `waitForPortFree`** (HF-7) | Pre-PR-72 `waitForPortFree` checked `/healthz` (HTTP). On Windows the kernel can hold `TIME_WAIT` causing `WinError 10048`. Replaced HTTP probe with `net.createServer().listen(port)` — kernel-truth answer. |

---

## Architectural deltas

### HF-9 additions

- **Image size gate (lowered).** `MIN_OK_IMAGE_BYTES = 100 * 1024` (was 200 KB in PR-77; calibrated down in PR-80). Single source of truth in `desktop/dist/storyboard_batch_helpers.js`.
- **`enrichBatchRowsWithFileBytes`.** New helper in `storyboard_batch_helpers.js` — must be called on the raw IPC result array before `applyBatchResult`. Injects `bytes` field from `fs.stat`; without it the gate silently passes (negative control proves this is the fix).
- **Per-scene narration TTS.** `/producer/audio` accepts `scene_narrations[]`. When present, each slot is rendered individually via TTS, padded with silence to match `scene_videos[i]` duration, then concatenated. `scenes_rendered` count in response reflects how many slots fired.
- **Humanize per-scene (PR-80).** Optional `humanize_per_scene: true` flag triggers a DeepSeek pass that rewrites each narration to natural spoken language before TTS. Graceful fallback when key absent.
- **`/producer/refine_script`.** New endpoint: `POST /producer/refine_script { script, scene_videos[], image_prompts[] }`. Returns `{ refined_script, used_llm, target_duration_s, target_words, warnings }`. Strips 11+ banned tokens; grounds output to image_prompts keywords; `used_llm=false` + preserved input when `DEEPSEEK_API_KEY` absent.
- **`research/core/llm.py`.** New module — `call_deepseek(prompt, system, model, temperature)` extracted from scattered inline calls. Catches `httpx.HTTPError` + malformed JSON gracefully.
- **Storyboard thumbnail sharpness.** `.thumb-cell img/video` → `96px × 132px` portrait + `image-rendering: -webkit-optimize-contrast`. Cell container width 76→112 px.
- **Final-video buttons.** Compose panel gains "📂 Open folder" + "Open file" for the assembled output path after assembly completes.

### HF-8 additions (still current)

- **Compose panel is single-mode.** Always POSTs to `/producer/audio`. `/producer/short` retained for back-compat.
- **Auto-fit SRT contract.** `scene_videos[]` + `target_duration_s` → ffprobe-driven target + linear caption stretch.
- **Renderer ↔ batch row contract.** `video_path` prioritised over `savedFile`; only `{generated, retried, settled, fallback}` eligible for `scene_videos`.
- **Script-mirror flag.** `psScriptUserEdited` guards Compose `#ps-script` auto-mirror from Storyboard.
- **LLM scene-prompt diversity rule.** Hard rule #6 in `build_breakdown_system_prompt`.

---

## Test Inventory

### Strict CI bucket (246 passed)

`research/tests/test_api_niche.py`, `test_api_keywords.py`, `test_api_outlier.py`, `test_api_cloner.py`, `test_api_studio.py`, `test_api_producer.py`, `test_video_probe.py`, `test_pixelle_tts_providers.py`, `test_assembler.py`, **`test_llm_helpers.py`** (new — PR-81).

Key additions since PR-75:
- +11 producer tests (PR-79): per-scene narration, padding, blank-slot skip, validator normalisation, legacy fallback, negative control
- +5 producer tests (PR-80): `humanize_per_scene` real call + fallback + wrong-shape + skip-when-false + scene_image_prompts validator
- +10 producer tests (PR-81): refine_script happy path, banned-token strip, grounding, target_words, fallback no-key, blank-script 422, `test_llm_helpers.py` (8 cases for `call_deepseek`)

### Desktop offline tests (28 files, all PASS)

```
test_account_service_path.js              test_research_sidecar_health_timeout.js
test_auth_service_keep_alive.js           test_research_sidecar_lookup.js
test_auth_service_relogin_path.js         test_research_sidecar_port_bind.js   ← PR-72 NEW (9 tests)
test_auth_session_status.js               test_research_sidecar_restart.js
test_compose_voice_picker_helpers.js      test_storyboard_account_manager_helpers.js
test_e2e_compose_script.js                test_storyboard_assemble_helpers.js
test_fetch_python_runtime.js              test_storyboard_batch_helpers.js     ← 116 tests (was 107)
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
| --- | --- | --- |
| `test_research_sidecar_lookup.js` | repo-root walk, packaged-resources lookup, python executable resolution | path resolution |
| `test_research_sidecar_restart.js` | `sendShutdown`, `waitForPortFree`, `restart()` flow, `killByPort`, Windows tree-kill | restart hot path (PR-65 → PR-68) |
| `test_research_sidecar_health_timeout.js` | `healthTimeoutMs()` env override, periodic progress log, stderr-tail surfacing | PR-71 |
| `test_research_sidecar_port_bind.js` | `canBindPort` returns kernel-truth, `waitForPortFree` non-HTTP regression | PR-72 |

### Known failures (non-regression)

`test_pixelle_grok_browser.py` — 7 tests require Playwright Chromium binary installed locally. Not in strict CI bucket; pre-existing env gap on Linux VM. All other 644 tests pass.

---

## File-level architecture pointers

| Concern | Files |
| --- | --- |
| Sidecar lifecycle (start/stop/restart/healthz) | `desktop/electron/researchSidecar.js` |
| API-keys save → sidecar restart | `desktop/electron/main.js` (IPC handler) → `desktop/electron/keysStore.js` → `researchSidecar.restart({ extraEnv })` |
| Renderer Settings ⚙ dialog | `desktop/dist/creator-forge.js` (search `keys.save`) |
| Batch Image+Video panel (HF-5) | `desktop/dist/creator-forge.html` (sbb-* IDs) + `desktop/dist/creator-forge.js` (`sbb_` functions) |
| Multi-account fan-out scheduler | `desktop/src/services/multiAccountFanOut.js` |
| Python sidecar entry | `research/api/main.py` |
| Bundled python runtime locator | `desktop/electron/researchSidecar.js::resolvePythonExecutable` |
| Compose / Video Assembly UX (HF-8) | `desktop/dist/creator-forge.html` (Compose `ps-*` IDs, Video Assembly `pa-*` IDs) + `desktop/dist/creator-forge.js` (`psSyncScriptFromStoryboard`, `paAutoFillScenesFromBatch`, `psComposeAudio` request builder) |
| Renderer pure helpers (HF-8) | `desktop/dist/storyboard_assemble_helpers.js` (`pullScenePathsFromBatch`, `validateAssembleForm`) + `desktop/dist/storyboard_batch_helpers.js` (`applyBatchResult`, `pairImagePathsForI2V`, `MIN_OK_IMAGE_BYTES`) |
| `/producer/audio` auto-fit SRT + per-scene (PR-75 + PR-79) | `research/api/routes/producer.py` (`_resolve_target_duration`, `_render_scene_narrations`) |
| `/producer/refine_script` (PR-81) | `research/api/routes/producer.py` (`refine_script` endpoint) |
| DeepSeek LLM helper | `research/core/llm.py` (`call_deepseek`) |
| Storyboard thumbnails (PR-81) | `desktop/dist/creator-forge.js` (`.thumb-cell` style) + `desktop/dist/creator-forge.html` |
| Scene breakdown LLM prompt (PR-77) | `research/core/pixelle/scene_breakdown.py::build_breakdown_system_prompt` (Hard rule #6) |
| Image size gate | `desktop/dist/storyboard_batch_helpers.js` → `MIN_OK_IMAGE_BYTES = 100 * 1024` |

---

## Running locally (verified 2026-05-03)

```bash
# Sidecar — terminal 1, from REPO ROOT
pip install edge-tts mutagen   # required for /producer/audio
uvicorn research.api.main:app --host 127.0.0.1 --port 5050

# Desktop — terminal 2
cd desktop && npm install && npm start
```

API keys are persisted per-user via the ⚙ Settings dialog at `userData/api-keys.json`. After Save, `researchSidecar.restart({ extraEnv })` fires and re-spawns uvicorn with the new env.

| Key | Required for |
| --- | --- |
| `DEEPSEEK_API_KEY` | Studio (topics/titles/outline/script) + scene_breakdown + variant_prompts + **refine_script** + **humanize_per_scene** |
| `GROK_ACCOUNTS_JSON` | Image / I2V / Video / RefImg generation |
| `YOUTUBE_API_KEY` | Research / niche / outlier |
| `GOOGLE` / `GEMINI` / `RUNNINGHUB` | Reserved (not yet wired) |

`/producer/short`, `/producer/audio`, `/producer/assemble`, `/producer/refine_script` all work without API keys — only `edge-tts` + `ffmpeg`. `refine_script` degrades gracefully (`used_llm=false`, input preserved).

---

## Quick guidance for the next sprint

- **Image gate threshold** (`MIN_OK_IMAGE_BYTES = 100 * 1024`) is empirically calibrated. If Grok image sizes change, re-measure and bump in lockstep with `test_storyboard_batch_helpers.js` (dedicated cases: exact threshold, just-below, just-above).
- **`enrichBatchRowsWithFileBytes` must precede `applyBatchResult`.** Missing it silently passes small images — the negative control in PR-79 proves this. Document this call-order dependency whenever the IPC handler is modified.
- **Per-scene narration** (`scene_narrations[]`) and **humanize_per_scene** are additive: you can send both. The humanize pass runs before TTS per slot. If LLM is slow, humanize adds latency proportional to scene count.
- **`/producer/refine_script` banned-token list** lives in `producer.py` (`BANNED_TOKENS`). Extending it requires a test asserting the new token doesn't appear in `refined_script` under real-LLM path.
- **Thumbnail size** (96×132) is hardcoded CSS. If the storyboard panel width changes, revisit to maintain portrait aspect ratio.
- **LLM diversity rule** (Hard rule #6) only ensures the prompt ships — adherence is non-deterministic. Next escalation: similarity-score first-N-words across `IMAGE PROMPT`s and reroll outliers in a post-processing pass.
- **CDP-driven testing recipe** (HF-8): launch Electron with `--remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222`, drive `window.StoryboardAssembleHelpers` / `window.StoryboardBatchHelpers` from a CDP client. Use before reaching for full E2E with credentials.
- `CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS` env knob for slow Windows cold-start. 180000 (3 min) is a safe upper bound.
