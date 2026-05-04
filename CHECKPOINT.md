# Creator-Forge — CHECKPOINT

> Last updated: 2026-05-04 (post HF-12 sprint — character anchor + scene_breakdown auto-fit fallback + ElevenLabs key promotion all MERGED into main)
> Main HEAD: `dd0ecb4` — `fix(storyboard): character anchor + scene_breakdown auto-fit fallback + ElevenLabs key promotion (#89)`
> Last sprint code commits: `78b297f` (HF-11 PR #86) → `6793e66` (PR #87 docs/checkpoint refresh) → `2e36b9f` (PR #88 ElevenLabs voices + Settings ⚙ field) → `dd0ecb4` (PR #89 HF-12 character anchor + autofit fallback + key promotion)

---

## Current state

All HF-10 + HF-11 + HF-12 work is merged into `main`. No outstanding PRs to land before resuming.

| PR | Title | State |
| --- | --- | --- |
| [#84](https://github.com/quyenmanhnguyen/creator-forge/pull/84) | feat(audio,captions): HF-10 — caption styling presets + speech-rate slider + voice expansion | **Merged** (`43268cf`) |
| [#85](https://github.com/quyenmanhnguyen/creator-forge/pull/85) | fix(audio): dedupe per-scene narrations to prevent caption-repeat at end of video | **Merged** (`fe2316f`) |
| [#86](https://github.com/quyenmanhnguyen/creator-forge/pull/86) | feat(audio): add ElevenLabs TTS provider as alternative to edge-tts | **Merged** (`78b297f`) |
| [#87](https://github.com/quyenmanhnguyen/creator-forge/pull/87) | docs(checkpoint): refresh post-merge — HF-10 + HF-11 all merged into main | **Merged** (`6793e66`) |
| [#88](https://github.com/quyenmanhnguyen/creator-forge/pull/88) | fix(audio): expose ElevenLabs voices + ELEVENLABS_API_KEY field in Settings ⚙ | **Merged** (`2e36b9f`) |
| [#89](https://github.com/quyenmanhnguyen/creator-forge/pull/89) | fix(storyboard): character anchor + scene_breakdown auto-fit fallback + ElevenLabs key promotion | **Merged** (`dd0ecb4`) |

**To resume:** `git checkout main && git pull --ff-only` — `main` is the source of truth.

## Run-locally checklist

```powershell
# Windows PowerShell — only needed if you'll test the ElevenLabs provider:
$env:ELEVENLABS_API_KEY = "sk_..."   # get from https://elevenlabs.io/app/settings/api-keys
# (Or: open the desktop app → Settings ⚙ → Secrets → save with scope=user — auto-injected on sidecar restart.)
```

```bash
# macOS / Linux equivalent:
export ELEVENLABS_API_KEY=sk_...
```

Then:
```bash
git pull --ff-only
cd desktop && npm install   # only if package.json changed (HF-11 didn't)
npm start                   # spawns sidecar on 127.0.0.1:5050
```

In the desktop window:
- **Caption-dedupe smoke test (PR #85, free)**: Studio → write a short script → Compose Audio → enable `humanize_per_scene` → Generate Audio. With a 3-scene script the warnings list should NO LONGER show duplicate captions in the final SRT (compare against the user-supplied `final.mp4` from 2026-05-03 which had "Late night grocery run..." repeated near the end).
- **ElevenLabs voice smoke test (PR #86, paid — burns ~70 chars from your ElevenLabs free quota)**: Compose Audio → flip **TTS provider** dropdown from `edge-tts` to `elevenlabs` → voice list refreshes to show the 12 curated voices (Rachel, Antoni, Sarah, ...) → pick **Rachel · F (calm en-US)** → paste *"Xin chào, đây là bản dịch tiếng Việt do ElevenLabs đọc."* → Generate Audio. Should produce a natural-sounding multilingual MP3, NOT robotic edge-tts.
- **Character anchor smoke test (PR #89, paid for Grok)**: Storyboard → paste a 3-scene script → Break into scenes → fill `Character anchor` textarea with `"young woman, jet-black hair with wispy bangs, light peach camisole, dewy fair skin"` → Auto-fill from scenes → Generate selected. Every prompt sent to Grok will be prefixed with `Subject anchor: <cue>. ` so the same person appears across all scenes (defends against Grok drifting hair/face/makeup between variants even with a global ref image attached).
- **Auto-fit fallback smoke test (PR #89, free)**: Storyboard → Break into scenes (no Video batch yet) → scroll to Compose audio. The `Auto-fit target (read-only)` field should read `No scene videos yet — using scene_breakdown estimate (X.Xs, N scenes). ...` — no longer blank, no longer requires a settled Video batch first. Generate Video batch and the same field flips to ffprobe-summed durations.
- **ElevenLabs API key field (PR #88 + PR #89)**: Settings ⚙ → modal opens with **ElevenLabs API key** at the top alongside DeepSeek + YouTube (no longer hidden inside ▶ Optional providers). Save round-trips through `~/.config/Creator Forge/api-keys.json` and the sidecar restarts with the new env.

**If `ELEVENLABS_API_KEY` is unset and you flip to `elevenlabs`:** the route returns a structured warning string (`"ELEVENLABS_API_KEY not set..."`) instead of a 500 — this is intentional graceful degradation, not a bug.

---

## HF-12 — Character anchor + auto-fit fallback + ElevenLabs key promotion (sprint complete, merged)

User feedback after testing HF-11 PR #88 build on Windows: three pain points — (1) character / face / hair drifts across scenes despite ref image + Visual DNA being attached, (2) Compose audio's auto-fit target was blocked on Video batch settling first, even though Scene breakdown already had per-scene durations from words ÷ WPM, (3) ELEVENLABS_API_KEY field was hidden inside ▶ Optional providers and easy to miss. Quote: "sao k thấy nhập riêng ngay từ đầu cho bao quát mà click vào đã thấy có rồi k biết chạy được k".

| PR | What it ships |
| --- | --- |
| **#87** docs/checkpoint refresh | Pure docs PR: rewrites CHECKPOINT.md to reflect HF-10 + HF-11 all merged into `main` (was originally drafted before PR #85 + PR #86 landed and showed them as "awaiting merge"). No code change. |
| **#88** ElevenLabs Settings ⚙ + voice picker self-heal | (1) `ELEVENLABS_API_KEY` added to `keysStore.js` `ALLOWED_KEYS` whitelist + `KEY_INPUT_IDS` map, plus a `<label>` in the Settings ⚙ modal under "Optional providers" so users can save the key without env vars. (2) New `_psOnProviderChange()` handler — when user flips Compose audio's TTS provider dropdown, the renderer **paints from cache instantly** and **fetches `/producer/voices` in the background**; if the new payload is larger than the cached one (e.g. user upgraded sidecar in-place without Ctrl+R), it replaces the cache and re-renders. Self-healing — no full app restart needed. (3) +2 `test_keys_store.js` (12 → 14) + +2 `test_compose_voice_picker_helpers.js` (13 → 15). |
| **#89** HF-12 character anchor + autofit fallback + key promotion | New pure-helper module `desktop/dist/storyboard_character_anchor_helpers.js` (UMD, framework-free, 6 exports: `normalizeCharacterAnchor`, `buildCharacterAnchorPrefix`, `applyCharacterAnchor`, `applyCharacterAnchorToRefItems`, `sumSceneDurations`, `resolveAutoFitTarget`). Three coordinated wiring edits: **(1)** new `<textarea id="sb-character-anchor">` between Visual DNA and Reference image (global) — when filled, `sbbRunImageBatchForRowIds()` calls `applyCharacterAnchor(prompts, anchor)` to prepend `Subject anchor: <cue>. ` to every prompt before the IPC fires (or `applyCharacterAnchorToRefItems(items, anchor)` for ref-image-edit paths). Empty anchor short-circuits per `(charHelpers && characterAnchor) ? helper() : raw` — byte-identical to pre-PR behavior. **(2)** new `state.lastScenesTotalDuration` cache; `renderSceneBreakdown()` captures `total_duration_s_estimate` from the response (or sums `duration_s` via `sumSceneDurations` as fallback) and calls `psRefreshReferenceVideos()`. New `psResolveAutoFitTarget()` invokes `resolveAutoFitTarget()`'s 4-priority chain (explicit override > settled scene videos ffprobe-summed > scene_breakdown estimate > none); `runComposeShort()` and `runRefineScript()` route through it. UI placeholders updated to spell out the priority. **(3)** ELEVENLABS_API_KEY row moved OUT of `<details>Optional providers` to top-level alongside DeepSeek + YouTube. Tests: new `test_storyboard_character_anchor_helpers.js` with **21** node:test cases covering normalize edge cases, prefix building, prompt + refImg application, scene-duration summing, and 4-priority resolution. |

**Strict-bucket pytest at HF-12 head (`dd0ecb4`):** **271 passed** (unchanged — backend wasn't touched this sprint). `ruff check research` clean, `python -m compileall research` clean.

**Out-of-scope this sprint (deferred):**
- Scene-by-scene character similarity scoring (e.g. CLIP-similarity-against-ref-image rerank). The text-anchor approach is a defense-in-depth layer; if it still drifts visibly we'd add image-similarity rerank as a follow-up.
- A separate `Visual DNA` editing modal — current single-line textarea is fine.
- Anchor templates / library ("save as preset") — premature.

---

## HF-11 — Caption-repeat fix + ElevenLabs TTS provider (sprint complete, merged)

User feedback after HF-10 final.mp4: "cái lời cho voice text to speech chưa đủ hay, thô kệch quá, và video gần cuối nó bị lặp lại text đoạn đầu". Scope after clarification: skip upscale + skip BGM, focus on caption-repeat fix + ElevenLabs (with API key).

| PR | What it ships |
| --- | --- |
| **#85** caption-dedupe | Two-layer guard against duplicate per-scene narrations: **(1)** `core/llm.refine_per_scene_narrations` post-processes the LLM output through new `_dedupe_scene_narrations` helper — duplicate slots swap for `original_narration` fallback, or blank to silence-pad if fallback also collides. **(2)** `routes/producer._dedupe_per_scene_narrations` is the safety net AFTER `humanize_per_scene` — catches duplicates from any source (LLM, upstream chunker, user paste) and emits a structured warning naming the scene index. Both compare case-insensitively + whitespace-collapsed. Tests: +5 `test_llm_helpers` + +4 `test_api_producer`. |
| **#86** ElevenLabs adapter | New `ElevenLabsAdapter` in `core/pixelle/tts.py`: `.synthesize()` POSTs `/v1/text-to-speech/{voice_id}` (mp3 stream); `.synthesize_with_timing()` POSTs `/with-timestamps` and converts per-character `normalized_alignment` to `WordBoundary` objects (whitespace-bounded grouping; punctuation stays attached to preceding word — matches Edge-TTS contract). Reads `ELEVENLABS_API_KEY` from env; missing key → `RuntimeError` with link to https://elevenlabs.io/app/settings/api-keys. HTTP errors unpacked to `"ElevenLabs <status>: <message>"`. `KNOWN_TTS_PROVIDERS` gains `"elevenlabs"`; `make_tts_adapter("elevenlabs")` routes to new adapter. 12 curated voices added to `VOICES` (Rachel, Antoni, Sarah, Domi, Adam, Arnold, Charlotte, Charlie, Matilda, Josh, Dorothy, Grace) — `short_name` is the raw ElevenLabs voice id so existing voice-picker plumbing passes it straight to the API. `_AUDIO_FORMAT_BY_PROVIDER` maps `elevenlabs → mp3`. `_list_tts_providers()` reports `elevenlabs` with `is_configured` following env presence. HTML `ps-tts-provider` dropdown gains `elevenlabs` option. Tests: +11 `test_pixelle_tts_providers` + 1 line in `test_api_producer` providers-set assertion. |

**Strict-bucket pytest at HF-11 head (`78b297f`):** **271 passed** (re-measured 2026-05-04 against the exact CI command) — the `Pytest — API tests (must pass)` bucket: `test_api_*.py` + `test_video_probe` + `test_pixelle_tts_providers` + `test_assembler`. `ruff check research` clean, `python -m compileall research` clean.

**Out-of-scope HF-11 (deferred per user, partly addressed in HF-12):**
- Real-ESRGAN upscaling ("bỏ upscale đi") — still deferred.
- BGM picker / sidechain duck ("skip BGM lần này") — still deferred.
- SSML pitch/volume on edge-tts (rolled into ElevenLabs scope instead since user opted to pay for higher-quality voice).
- Character drift across scenes — addressed in HF-12 PR #89.
- Compose audio gated on Video batch — addressed in HF-12 PR #89.
- ElevenLabs key visibility — partly addressed in HF-11 PR #86 (env var) → HF-11 PR #88 (Settings ⚙ field, optional collapse) → HF-12 PR #89 (top-level).

---

## Status

| Metric | Value |
| --- | --- |
| **CI strict pytest bucket** | **271 passed** at HEAD `dd0ecb4` (re-measured 2026-05-04 post HF-12 merge — backend untouched this sprint, count is identical to HF-11 head). Bucket = `test_api_*.py` + `test_video_probe` + `test_pixelle_tts_providers` + `test_assembler`. `test_llm_helpers.py` is NOT in the strict CI bucket (it imports `from core import llm` which only resolves under the sidecar runtime, not pytest's default sys.path). |
| **Full pytest (local, all deps)** | **~677 passed, 7 failed** — all 7 failures are `test_pixelle_grok_browser.py` (require Playwright Chromium binary, not a regression; pre-existing env gap). |
| **Desktop offline test files** | **29 / 29 PASS** at HEAD `dd0ecb4` (was 28 — HF-12 PR #89 added `test_storyboard_character_anchor_helpers.js` with 21 cases). `test_storyboard_batch_helpers.js`: 123 / 123; `test_storyboard_assemble_helpers.js`: 33 / 33; `test_storyboard_character_anchor_helpers.js`: 21 / 21 (NEW); `test_research_sidecar_restart.js`: 16 / 16; `test_compose_voice_picker_helpers.js`: 15 / 15 (HF-11 ElevenLabs option, +2 in PR #88); `test_keys_store.js`: 14 / 14 (+2 ELEVENLABS_API_KEY whitelist in PR #88). |
| `ruff check research` | clean |
| `node --check` (Electron entry points + dist) | clean |
| Pixelle heavy-import tests | not run in CI (require moviepy / edge-tts / mutagen — best-effort only). |
| Live E2E verification | **PR-82: auto-retry small images + stale preview fix** · **PR-83: 8/8 assertions** (tiered reject reasons + retry boost) · **PR-85 sidecar fix: API key Save no longer throws "port still busy" in dev mode** · **HF-11 PR #85 caption-dedupe + PR #86 ElevenLabs:** verified via CI green (271 strict-bucket passed). · **HF-11 PR #88: 3/3 PASS** (Settings ⚙ ELEVENLABS_API_KEY field appears + persists; Compose audio voice list shows 12 ElevenLabs voices on dropdown flip; regression flip back to edge-tts restores 22-voice roster). · **HF-12 PR #89: 4/4 PASS** (ELEVENLABS_API_KEY at top-level; auto-fit summary reads literal `36.4s, 3 scenes` from scene_breakdown; helper-wrap captures `Subject anchor: <cue>. ` prefix on every `image:generate` prompt; empty anchor short-circuits helper). Recordings + screenshots in PR comments. |

---

## Sprint History (PR-47 → PR-89)

### PR #87 — docs(checkpoint): refresh post-merge (merged, `6793e66`)

Pure docs PR: rewrites CHECKPOINT.md to reflect HF-10 + HF-11 all merged into `main`. The original draft was prepared before PR #85 + PR #86 landed and showed them as "awaiting merge" (stale). No code change.

### PR #88 — fix(audio): expose ElevenLabs voices + ELEVENLABS_API_KEY field in Settings ⚙ (merged, `2e36b9f`)

User report after testing HF-11 build: "sao không có bảng để nhập api key" + voice list showed `no voices for elevenlabs` even though PR #86 shipped 12 curated voices. Two coordinated fixes:

1. **Settings ⚙ ELEVENLABS_API_KEY field.** `ALLOWED_KEYS` whitelist in `keysStore.js` gains `ELEVENLABS_API_KEY` (silently dropped on save before this); `KEY_INPUT_IDS` map in `creator-forge.js` gains the renderer side; new `<label>` in the Settings ⚙ modal (originally inside `<details>Optional providers`, later promoted top-level by PR #89). Round-trips through `~/.config/Creator Forge/api-keys.json` and the sidecar restarts with the new env.
2. **Voice picker self-heal.** New `_psOnProviderChange()` handler — when user flips Compose audio's TTS provider dropdown, the renderer **paints from cache instantly** and **fetches `/producer/voices` in the background**. If the new payload is larger than the cached one (e.g. user upgraded sidecar in-place without Ctrl+R), it replaces the cache and re-renders. Self-healing — no full app restart needed.

Tests: +2 `test_keys_store.js` (12 → 14) + +2 `test_compose_voice_picker_helpers.js` (13 → 15). E2E verified on Devin VM with sentinel key — round-trip through Settings ⚙ Save / Cancel / reopen works; voice list populates 12 ElevenLabs voices on first dropdown flip.

### PR #89 — fix(storyboard): character anchor + scene_breakdown auto-fit fallback + ElevenLabs key promotion (merged, `dd0ecb4`)

User feedback after testing HF-11 PR #88 build on Windows: "cái tính năng đồng nhất style nhân vật từ prompt và ảnh tham chiếu vào không ổn thấy đầu ra khác quá, cái text to speech mà script được chỉnh lại phù hợp với video thì không hẳn là phải tham chiếu từ video riêng mà là tổng thể như chiều dài của video prompt của video và một chút prompt ảnh nữa". Three coordinated edits:

1. **Character anchor.** New pure-helper module `desktop/dist/storyboard_character_anchor_helpers.js` (UMD, framework-free, 6 exports). New `<textarea id="sb-character-anchor">` between Visual DNA and Reference image (global). When filled, `sbbRunImageBatchForRowIds()` calls `applyCharacterAnchor(prompts, anchor)` to prepend `Subject anchor: <cue>. ` to every prompt before the IPC fires (or `applyCharacterAnchorToRefItems(items, anchor)` for ref-image-edit paths). Empty anchor short-circuits the helper call entirely per `(charHelpers && characterAnchor) ? helper() : raw` — byte-identical to pre-PR behavior. The anchor is **prepended verbatim**, period-terminated, then a single space, then the original prompt. Cap: 480 chars (silently truncated with whitespace cleanup).
2. **Auto-fit 4-priority chain.** New `resolveAutoFitTarget()` helper + new `state.lastScenesTotalDuration` renderer cache. `renderSceneBreakdown()` captures `total_duration_s_estimate` from the response (or sums `duration_s` via `sumSceneDurations` as fallback) and calls `psRefreshReferenceVideos()`. New `psResolveAutoFitTarget()` invokes the helper with priority: explicit `Target duration override` (s) > settled scene videos (ffprobe-summed) > scene_breakdown estimate (sum of per-scene `duration_s` from words ÷ WPM) > none. `runComposeShort()` and `runRefineScript()` route through it instead of computing raw video durations directly. UI placeholders rewritten to spell out the chain.
3. **ELEVENLABS_API_KEY top-level promotion.** Row moved OUT of `<details>Optional providers` to alongside DeepSeek + YouTube. The collapse now contains only Google/Gemini + RunningHub.

Tests: new `test_storyboard_character_anchor_helpers.js` with **21** node:test cases covering normalize edge cases (whitespace collapse, trailing-period strip, 480-char cap), prefix building (with/without ref-image hint), prompt application (no-op on empty), refImg application, scene-duration summing, and 4-priority resolution (explicit > video > breakdown > none). E2E verified via mock-sidecar + helper-wrap CDP harness — all 4 test assertions PASS (see PR #89 comment + recording).

### PR #85 — fix(audio): dedupe per-scene narrations (merged, `fe2316f`)

See "HF-11" section above for full rationale + per-layer breakdown.

### PR #86 — feat(audio): add ElevenLabs TTS provider (merged, `78b297f`)

See "HF-11" section above for full rationale + adapter contract.

### `91dc43a` — fix(sidecar): `killByPort` Windows tree-kill on API key Save

User report: "Keys saved, sidecar restart failed: research sidecar restart: port :5050 still busy after shutdown attempt" — occurs every time user clicks Save in the Settings ⚙ dialog while running in dev mode (`npm run dev`).

**Root cause:** `npm run dev` starts uvicorn with `--reload` (watchfiles reloader). When the sidecar tries to restart on API key Save, it calls `killByPort()` which found the LISTENING PID via `netstat -ano` and called `taskkill /F /PID <pid>`. This killed only the **immediate** child uvicorn process — the **watchfiles reloader parent** (a separate PID) survived and immediately respawned uvicorn before `waitForPortFree()` saw the port as free. The race left the port perpetually busy.

**Fix:** Changed `taskkill /F /PID` → `taskkill /F /T /PID` in `killByPort()`. The `/T` flag walks the kernel's parent-child process tree and kills **all descendants** (reloader + child uvicorn) atomically — same mechanism already used in `stop()` (PR-68).

**Test update:** `test_research_sidecar_restart.js` → `killByPort: windows` test renamed and assertion updated from `['/F', '/PID', '4242']` → `['/F', '/T', '/PID', '4242']`. All 16 tests pass.

### HF-10 — Audio caption enhancements + voice expansion (merged in PR #84, `43268cf`)

User feedback after HF-9 / PR-82 / PR-83: "Audio quality and SRT/caption appearance can be improved. Want professional caption styling, more voice options, speed control, configurable burn-in captions."

**Shipped:**

| Feature | What it ships |
| --- | --- |
| **A. Burn caption styling** | 4 presets via ffmpeg `force_style` parameter: **Modern** (bold white + black outline, YouTube Shorts style), **Cinematic** (italic + shadow, movie subs), **TikTok Bold** (large bold + heavy outline), **Minimal** (thin white + subtle shadow). `build_force_style()` helper in `assembler.py` generates the ASS style string. |
| **B. Caption mode UI** | Video Assembly panel gains: caption mode dropdown (Soft / Burn / None), style preset selector (shows only when Burn selected), font size picker (Small 16pt / Medium 22pt / Large 28pt), position picker (Bottom / Middle / Top). Show/hide logic wired via DOMContentLoaded. |
| **C. Audio speed control** | Speech rate slider (-50% to +100%) in Compose Audio panel. `rate` field added to `AudioOnlyRequest`; passed to `EdgeTTSAdapter.rate` on both per-scene and single-pass TTS paths. Slider label syncs in real-time. |
| **D. Voice expansion** | Voice picker expanded from 12 → 22 edge-tts voices. Added: Sara, Davis, Amber (en-US), Sonia, Ryan (en-GB), Yunxi (zh-CN), Denise (fr-FR), Katja (de-DE), Francisca (pt-BR), Premwadee (th-TH), Gadis (id-ID). HTML voice picker reorganised into `<optgroup>` by language. |
| **E. Font size + position** | `caption_font_size` (small/medium/large) and `caption_position` (bottom/middle/top) fields in `AssembleRequest`. Override the preset's FontSize and ASS Alignment/MarginV respectively. |

**Tests added (HF-10):**
- +14 assembler tests: `build_force_style` (all 4 presets, font size override, position override, combined, unknown preset fallback, invalid size/position) + `_build_ffmpeg_args` with/without force_style
- +5 producer tests: `caption_style` pass-through to helper, defaults, unknown style 422, `AudioOnlyRequest.rate` acceptance + defaults
- +12 JS assemble helper tests: `CAPTION_STYLES`/`FONT_SIZES`/`POSITIONS` constants, burn payload includes style fields, soft/none omits them, invalid style/size/position handling

### PR-82, PR-83 — Image retry hardening (merged)

User feedback: "Small Grok images (24 KB) still slip through. Retry shows stale preview. Want to know WHY images are rejected."

| PR | Title | What it ships |
| --- | --- | --- |
| #82 | fix(image): auto-retry small images + fix stale thumbnail on Retry | **(1)** Clears `url`/`image_path`/`bytes` when row transitions to `generating` so `sbbResolveUrls` re-resolves after retry. **(2)** Renderer-side auto-retry: rows gate-rejected at 100 KB get automatic retry (max 3 attempts, 3s delay, progress banner). **(3)** Service-level retry: `_processOneBatchItem` checks file size post-save, retries up to 2× with 2s backoff. |
| #83 | feat(image): boost output count on retry + enhanced reject reasons | **(1)** Retry requests 4 images instead of 1 (`retryBoostCount`), sorts by size, picks largest. **(2)** Tiered reject reasons: <30 KB → "CDN moderation placeholder", 30–59 KB → "incomplete download or preview frame", 60–99 KB → "image too small to be a real generation". |

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

### HF-11 additions (merged in PR #85 + PR #86)

- **Caption-dedupe two-layer guard.** `core/llm._dedupe_scene_narrations(narrations, fallbacks)` is the post-LLM-rewrite layer — duplicate slot swaps for the corresponding `original_narration`, or blanks to silence if the fallback also collides. `routes/producer._dedupe_per_scene_narrations(narrations, *, warnings)` is the route safety net AFTER `humanize_per_scene` — duplicate slots become empty strings (rendered as silence the length of that scene's video), and a structured warning naming the scene index is appended. Both compare case-insensitively + whitespace-collapsed.
- **`ElevenLabsAdapter`.** New TTS provider in `research/core/pixelle/tts.py`. `.synthesize(text, voice, *, format="mp3")` POSTs `/v1/text-to-speech/{voice_id}` and streams MP3 bytes. `.synthesize_with_timing(...)` POSTs `/with-timestamps` and converts per-character `normalized_alignment` into `WordBoundary` objects (whitespace-bounded grouping; punctuation attaches to the preceding word — matches the Edge-TTS contract). Reads `ELEVENLABS_API_KEY` from env; missing key raises `RuntimeError` linking to https://elevenlabs.io/app/settings/api-keys. HTTP errors are unpacked to `"ElevenLabs <status>: <message>"`.
- **Provider routing.** `KNOWN_TTS_PROVIDERS` gains `"elevenlabs"`; `make_tts_adapter("elevenlabs")` instantiates the new adapter. `_AUDIO_FORMAT_BY_PROVIDER` maps `elevenlabs → mp3`. `_list_tts_providers()` reports `elevenlabs` with `is_configured` reflecting env presence.
- **Voice catalogue.** `VOICES` tuple gains 12 curated ElevenLabs voices (Rachel, Antoni, Sarah, Domi, Adam, Arnold, Charlotte, Charlie, Matilda, Josh, Dorothy, Grace). The `short_name` for each is the raw ElevenLabs voice id, so existing voice-picker plumbing passes it straight to the API.
- **Provider dropdown.** HTML `ps-tts-provider` `<select>` gains an `elevenlabs` option. Voice list refreshes when the provider changes.

### HF-10 additions (merged in PR #84)

- **Burn caption style presets.** `CAPTION_STYLE_PRESETS` dict in `assembler.py` — four entries (`modern`, `cinematic`, `tiktok`, `minimal`), each a `dict[str, str]` of ASS style parameters. `build_force_style(caption_style, font_size, position)` merges preset + overrides into a single ffmpeg `force_style` string.
- **Caption styling pipeline.** `assemble_final_mp4()` gains `caption_style`, `caption_font_size`, `caption_position` keyword args. When `caption_mode="burn"`, `build_force_style()` is called and the resulting string is injected into the ffmpeg `-vf` chain as `subtitles=_subs.srt:force_style='...'`.
- **`AssembleRequest` expansion.** Three new fields: `caption_style: Literal["modern", "cinematic", "tiktok", "minimal"]` (default `"modern"`), `caption_font_size: Literal["small", "medium", "large"] | None`, `caption_position: Literal["bottom", "middle", "top"] | None`. Route passes all three through to the assembler helper.
- **TTS speech rate.** `AudioOnlyRequest.rate` field (default `"+0%"`). After `_resolve_tts_adapter()` creates the adapter, the route sets `adapter.rate = req.rate` on both per-scene and single-pass code paths. UI slider maps -50…+100 integer to edge-tts rate string format.
- **Voice expansion.** `VOICES` tuple in `voices.py` grew from 12 → 22 edge-tts entries. New voices: Sara, Davis, Amber (en-US), Sonia, Ryan (en-GB), Yunxi (zh-CN), Denise (fr-FR), Katja (de-DE), Francisca (pt-BR), Premwadee (th-TH), Gadis (id-ID). HTML voice picker restructured into `<optgroup>` by language family.
- **Caption mode UI.** Video Assembly panel gains `<select id="pa-caption-mode">` (soft/burn/none), with conditional show/hide of style/font/position controls when burn is selected. JS event listener on `change` toggles visibility of `#pa-caption-style-label`, `#pa-caption-font-size-label`, `#pa-caption-position-label`.
- **Payload builder expansion.** `storyboard_assemble_helpers.js` exports `CAPTION_STYLES`, `DEFAULT_CAPTION_STYLE`, `CAPTION_FONT_SIZES`, `CAPTION_POSITIONS`. `buildAssemblePayload()` includes `caption_style`, `caption_font_size`, `caption_position` only when `caption_mode === 'burn'`.

### PR-82 / PR-83 additions

- **Stale preview fix.** `sbbResolveUrls` re-resolves after retry because `url`/`image_path`/`bytes` are cleared when row enters `generating` state.
- **Auto-retry gate-rejected images.** Renderer-side: rows with bytes < 100 KB auto-retry up to 3 times (3s delay). Service-side: `_processOneBatchItem` retries up to 2× with 2s backoff when saved file < 100 KB.
- **Retry boost.** Retry requests `n_images=4` (was 1). Saved files sorted by size descending; largest picked.
- **Tiered reject reasons.** Three buckets based on file size: <30 KB (CDN moderation), 30–59 KB (incomplete download), 60–99 KB (too small).

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

### Strict CI bucket (271 passed at HEAD `78b297f`)

`research/tests/test_api_niche.py`, `test_api_keywords.py`, `test_api_outlier.py`, `test_api_cloner.py`, `test_api_studio.py`, `test_api_producer.py`, `test_video_probe.py`, `test_pixelle_tts_providers.py`, `test_assembler.py`. (`test_llm_helpers.py` and the heavy-dep tests are NOT in the strict bucket — see Status table above.)

Key additions since PR-75:
- +11 producer tests (PR-79): per-scene narration, padding, blank-slot skip, validator normalisation, legacy fallback, negative control
- +5 producer tests (PR-80): `humanize_per_scene` real call + fallback + wrong-shape + skip-when-false + scene_image_prompts validator
- +10 producer tests (PR-81): refine_script happy path, banned-token strip, grounding, target_words, fallback no-key, blank-script 422, `test_llm_helpers.py` (8 cases for `call_deepseek`)
- +5 producer tests (HF-10): caption_style pass-through, defaults, unknown style 422, AudioOnlyRequest.rate acceptance + defaults
- +14 assembler tests (HF-10): build_force_style (all 4 presets, font size override, position override, combined, unknown preset, invalid size/position) + _build_ffmpeg_args with/without force_style
- +5 `test_llm_helpers` + +4 `test_api_producer` (HF-11 PR #85): `_dedupe_scene_narrations` + `refine_per_scene_narrations` dedupe paths; `_dedupe_per_scene_narrations` route safety net + structured warnings.
- +11 `test_pixelle_tts_providers` (HF-11 PR #86): `ElevenLabsAdapter.synthesize` mocked POST, missing-key `RuntimeError`, HTTP-error unpacking, `synthesize_with_timing` `WordBoundary` conversion, `make_tts_adapter("elevenlabs")` routing, `_list_tts_providers` env-presence reporting.

### Desktop offline tests (29 files, all PASS at `dd0ecb4`)

```
test_account_service_path.js              test_research_sidecar_health_timeout.js
test_auth_service_keep_alive.js           test_research_sidecar_lookup.js
test_auth_service_relogin_path.js         test_research_sidecar_port_bind.js   ← PR-72 NEW (9 tests)
test_auth_session_status.js               test_research_sidecar_restart.js
test_compose_voice_picker_helpers.js      test_storyboard_account_manager_helpers.js
  ↑ 15 / 15 (HF-11 ElevenLabs filter, +2 in PR #88)
test_e2e_compose_script.js                test_storyboard_assemble_helpers.js  ← 33 tests (was 21)
test_fetch_python_runtime.js              test_storyboard_batch_helpers.js     ← 123 tests (was 116)
test_grok_profile_dir.js                  test_storyboard_bridge.js
test_i2v_service_process_one.js           test_storyboard_character_anchor_helpers.js  ← HF-12 NEW (21 tests)
test_image_service_config.js              test_storyboard_compose_helpers.js
test_keys_store.js                        test_storyboard_compose_table_helpers.js
  ↑ 14 / 14 (+2 ELEVENLABS_API_KEY whitelist in PR #88)
test_multi_account_fan_out.js             test_storyboard_login_banner_helpers.js
test_refimg_service_process_one.js        test_storyboard_progress_helpers.js
                                          test_storyboard_video_compose_helpers.js
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

`test_pixelle_grok_browser.py` — 7 tests require Playwright Chromium binary installed locally. Not in strict CI bucket; pre-existing env gap on Linux VM. All other tests pass.

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
| Compose / Video Assembly UX (HF-8 + HF-10) | `desktop/dist/creator-forge.html` (Compose `ps-*` IDs, Video Assembly `pa-*` IDs) + `desktop/dist/creator-forge.js` (`psSyncScriptFromStoryboard`, `paAutoFillScenesFromBatch`, `psComposeAudio` request builder, `_paToggleBurnOpts`) |
| Renderer pure helpers (HF-8 + HF-10) | `desktop/dist/storyboard_assemble_helpers.js` (`pullScenePathsFromBatch`, `validateAssembleForm`, `buildAssemblePayload` with burn caption fields) + `desktop/dist/storyboard_batch_helpers.js` (`applyBatchResult`, `pairImagePathsForI2V`, `MIN_OK_IMAGE_BYTES`) |
| `/producer/audio` auto-fit SRT + per-scene + rate (PR-75 + PR-79 + HF-10) | `research/api/routes/producer.py` (`_resolve_target_duration`, `_render_scene_narrations`, `AudioOnlyRequest.rate`) |
| `/producer/assemble` burn captions + styling (PR-32 + HF-10) | `research/api/routes/producer.py` (`AssembleRequest.caption_style/font_size/position`) → `research/core/pixelle/assembler.py` (`build_force_style`, `CAPTION_STYLE_PRESETS`) |
| `/producer/refine_script` (PR-81) | `research/api/routes/producer.py` (`refine_script` endpoint) |
| DeepSeek LLM helper | `research/core/llm.py` (`call_deepseek`) |
| Storyboard thumbnails (PR-81) | `desktop/dist/creator-forge.js` (`.thumb-cell` style) + `desktop/dist/creator-forge.html` |
| Scene breakdown LLM prompt (PR-77) | `research/core/pixelle/scene_breakdown.py::build_breakdown_system_prompt` (Hard rule #6) |
| Image size gate | `desktop/dist/storyboard_batch_helpers.js` → `MIN_OK_IMAGE_BYTES = 100 * 1024` |
| Image retry boost + tiered reject (PR-82/83) | `desktop/dist/storyboard_batch_helpers.js` (auto-retry, reject reasons) + `desktop/src/services/ImageService.js` (service-level retry, boost count) |
| Voice registry (HF-10 + HF-11) | `research/core/pixelle/voices.py` → `VOICES` tuple (22 edge-tts + 6 piper-tts + 12 ElevenLabs voices) |
| Burn caption presets (HF-10) | `research/core/pixelle/assembler.py` → `CAPTION_STYLE_PRESETS`, `CAPTION_FONT_SIZES`, `CAPTION_POSITIONS`, `build_force_style()` |
| Per-scene narration dedupe (HF-11 PR #85) | `research/core/llm.py` (`_dedupe_scene_narrations`, applied inside `refine_per_scene_narrations`) + `research/api/routes/producer.py` (`_dedupe_per_scene_narrations` route safety net) |
| ElevenLabs TTS provider (HF-11 PR #86) | `research/core/pixelle/tts.py` (`ElevenLabsAdapter`, `make_tts_adapter("elevenlabs")`) + `research/api/routes/producer.py` (`KNOWN_TTS_PROVIDERS`, `_AUDIO_FORMAT_BY_PROVIDER`, `_list_tts_providers`) + `desktop/dist/creator-forge.html` (`ps-tts-provider` option) |
| ELEVENLABS_API_KEY whitelist + Settings ⚙ field (HF-11 PR #88, promoted to top-level by HF-12 PR #89) | `desktop/electron/keysStore.js` (`ALLOWED_KEYS`) + `desktop/dist/creator-forge.js` (`KEY_INPUT_IDS`) + `desktop/dist/creator-forge.html` (`#key-elevenlabs` row, top-level alongside DeepSeek + YouTube) |
| Voice picker self-heal on provider flip (HF-11 PR #88) | `desktop/dist/creator-forge.js` (`_psOnProviderChange` — paint from cache + background refetch + replace-if-larger) |
| Character anchor (HF-12 PR #89) | `desktop/dist/storyboard_character_anchor_helpers.js` (UMD pure helpers — `normalizeCharacterAnchor`, `buildCharacterAnchorPrefix`, `applyCharacterAnchor`, `applyCharacterAnchorToRefItems`) + `desktop/dist/creator-forge.html` (`#sb-character-anchor` textarea between Visual DNA and Reference image) + `desktop/dist/creator-forge.js` (`sbbRunImageBatchForRowIds` calls helper before IPC) |
| Auto-fit 4-priority chain (HF-12 PR #89) | `desktop/dist/storyboard_character_anchor_helpers.js` (`sumSceneDurations`, `resolveAutoFitTarget`) + `desktop/dist/creator-forge.js` (`state.lastScenesTotalDuration`, `renderSceneBreakdown` captures `total_duration_s_estimate`, `psResolveAutoFitTarget`, `psRefreshReferenceVideos`, `runComposeShort` + `runRefineScript` routes through resolver) |

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
- **CDP-driven testing recipe** (HF-8): launch Electron with `--remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222`, drive `window.StoryboardAssembleHelpers` / `window.StoryboardBatchHelpers` / `window.StoryboardCharacterAnchorHelpers` from a CDP client. Use before reaching for full E2E with credentials.
- **Helper-wrap testing pattern (HF-12).** `window.electronAPI` is **frozen** by Electron's contextBridge — `Object.defineProperty` throws `Cannot redefine property`, so IPC stubbing at the renderer level is impossible. But `window.*Helpers` UMD modules ARE mutable. Wrap their functions to capture inputs+outputs at the boundary just before IPC fires; the helper return value IS the IPC payload. This is how HF-12 PR #89 character-anchor + autofit-fallback was end-to-end verified without burning Grok credits. See `.agents/skills/testing-app/SKILL.md` for the pattern.
- **Mock sidecar pattern (HF-12).** When a renderer flow depends on `/producer/scene_breakdown` (DeepSeek-backed), replace the sidecar with a FastAPI mock on `127.0.0.1:5050` returning canned responses. Mock MUST implement `/healthz` returning `{"service": "creator-forge.research", ...}` so `desktop/electron/researchSidecar.js:188` reuse-external-sidecar probe accepts it. Otherwise Electron tries to spawn its own and fails because the port is busy.
- `CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS` env knob for slow Windows cold-start. 180000 (3 min) is a safe upper bound.
- **Burn caption styling** (HF-10): presets live in `assembler.py:CAPTION_STYLE_PRESETS`. To add a new preset, add a key to the dict, add the value to `CaptionStyle` Literal in both `assembler.py` and `producer.py:AssembleRequest.caption_style`, and add the option to `desktop/dist/creator-forge.html` (`pa-caption-style` select). Test via `test_assembler.py::test_build_force_style_*`.
- **Voice list** (HF-10): 22 edge-tts voices in `voices.py:VOICES`. To add more, append a `Voice(...)` entry and add a matching `<option>` to `desktop/dist/creator-forge.html` (`ps-voice` select). Edge-tts voices are validated by name on the backend; unknown names get a warning but still pass through.
- **TTS rate** (HF-10): `AudioOnlyRequest.rate` accepts edge-tts format strings like `"+20%"`, `"-10%"`. The UI slider maps integer -50…+100 to this format. Rate only affects edge-tts; Piper-tts ignores it silently.
- **Character anchor cap** (HF-12): 480 chars in `normalizeCharacterAnchor`. Trailing `.` stripped before re-adding (so `Subject anchor: <cue>. ` is always single-period-terminated). If you change the prefix template, update `buildCharacterAnchorPrefix` AND the 21 unit tests in `test_storyboard_character_anchor_helpers.js`.
- **Auto-fit priority chain** (HF-12): explicit `Target duration override` > settled scene videos (ffprobe-summed) > scene_breakdown estimate (sum of `duration_s`) > none. `0` in the override field means "no scaling — let TTS run native" (NOT "auto-fit"). `psResolveAutoFitTarget()` is the single source of truth — `runComposeShort` and `runRefineScript` both route through it. Don't reimplement the chain inline.
