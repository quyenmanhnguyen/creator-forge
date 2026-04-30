/**
 * StoryboardBridge.js — turn a Studio script into scene prompts and feed them
 * into the existing Electron services for actual image / video generation.
 *
 * Pipeline:
 *
 *   Studio script.md
 *      └─► /producer/scene_breakdown   (sidecar; uses core.pixelle.scene_breakdown)
 *              └─► [{ scene_id, image_prompt, video_prompt, duration_s, style }]
 *                     └─► ImageService.generateBatch (Electron, Grok)
 *                     └─► I2VService.generate         (Electron, Grok video)
 *                     └─► /producer/short             (sidecar, ffmpeg compose)
 *
 * The bridge owns orchestration but never holds long-lived state — UI passes
 * the script/scenes in and gets back asset paths.
 */

// Reuse the renderer-side helpers in Node — same retry / picking logic as
// the UI panel, single source of truth (PR-17 / PR-20B).
const composeHelpers = require('../../dist/storyboard_compose_helpers.js');
const videoComposeHelpers = require('../../dist/storyboard_video_compose_helpers.js');

// Minimum useful image size (matches PR-9 MIN_BLOB_LEN in ImageService —
// anything smaller is almost certainly a blur preview / moderation
// placeholder and would render as noise in the composed mp4).
const MIN_USABLE_IMAGE_BYTES = composeHelpers.MIN_USABLE_IMAGE_BYTES;
// Minimum useful I2V mp4 size — generous floor for catching empty/
// truncated downloads. Real Grok I2V output is multi-hundred-KB to
// multi-MB.
const MIN_USABLE_VIDEO_BYTES = videoComposeHelpers.MIN_USABLE_VIDEO_BYTES;

class StoryboardBridge {
    constructor(electronAPI = (typeof window !== 'undefined' ? window.electronAPI : null)) {
        if (!electronAPI || !electronAPI.storyboard || !electronAPI.image) {
            throw new Error('StoryboardBridge: required electronAPI namespaces missing (check preload.js)');
        }
        this.story = electronAPI.storyboard;
        this.image = electronAPI.image;
        this.producer = electronAPI.producer;
        this.i2v = electronAPI.i2v;
        this.refimg = electronAPI.refimg;
        // PR-20E: ffprobe-backed validator. ``electronAPI.video.validateOutput``
        // is registered by preload.js; when it's not exposed (older
        // preload, unit tests with a partial mock) we leave this null
        // and pickI2VOutputFile falls back to size-only checks.
        this.video = electronAPI.video || null;
    }

    /**
     * POST /producer/scene_breakdown — convert script.md into N scene objects.
     *
     * Failure modes mirror the rest of the suite: missing
     * ``DEEPSEEK_API_KEY`` / LLM errors / parser failures all return 200 with
     * an empty ``scenes[]`` and a populated ``warnings[]`` (never 500). When
     * piping into ``animateScenes`` you'll want to copy ``flow_video_prompt``
     * onto each scene as ``video_prompt`` (i2v expects the shorter alias).
     *
     * @param {{
     *   script: string,
     *   template_key?: 'cinematic'|'educational'|'lifestyle'|'factory',
     *   n_scenes?: number,
     *   words_per_minute?: number,
     *   language?: 'en'|'ko'|'ja'|'vi',
     *   images_per_scene?: number,
     *   visual_dna_override?: string|null,
     * }} params
     * @returns {Promise<{
     *   template_key: string, template_label: string, language: string,
     *   words: number,
     *   n_scenes_requested: number|null,
     *   n_scenes_estimated: number,
     *   n_scenes_returned: number,
     *   total_duration_s_estimate: number,
     *   scenes: Array<{
     *     scene_id: number, title: string, narration: string,
     *     image_prompt: string, flow_video_prompt: string, duration_s: number,
     *     image_prompts: string[],
     *   }>,
     *   md: string,
     *   visual_dna: string,
     *   images_per_scene: number,
     *   warnings: string[], notes: string,
     * }>}
     */
    fromScript(params) {
        return this.story.fromScript(params);
    }

    /** Build a single thumbnail prompt for the script/topic. */
    thumbnail(params) {
        return this.story.thumbnail(params);
    }

    /**
     * PR-26 — Auto-extract the script's "Visual DNA" style anchor in a
     * single LLM call. Used by the Storyboard panel to populate the
     * Visual DNA override field before the user edits it.
     *
     * @param {{ script: string }} params
     * @returns {Promise<{ visual_dna: string, warnings: string[] }>}
     */
    visualDna(params) {
        if (!this.story || typeof this.story.visualDna !== 'function') {
            // Older preload — return an empty DNA so the renderer can
            // gracefully fall back to user-entered text without an
            // unhandled rejection bubble.
            return Promise.resolve({ visual_dna: '', warnings: ['storyboard:visualDna IPC unavailable'] });
        }
        return this.story.visualDna(params);
    }

    /**
     * PR-26 — Re-roll a single scene's variant prompts without re-running
     * the whole scene_breakdown. Used when the user edits the Visual DNA
     * override or bumps images_per_scene mid-batch.
     *
     * @param {{
     *   scene: { scene_id: number, title: string, narration: string,
     *            image_prompt: string, flow_video_prompt?: string },
     *   count: number,
     *   visual_dna?: string,
     * }} params
     * @returns {Promise<{ prompts: string[], warnings: string[] }>}
     */
    variantPrompts(params) {
        if (!this.story || typeof this.story.variantPrompts !== 'function') {
            const base = (params && params.scene && params.scene.image_prompt) || '';
            const count = Math.max(1, Number((params && params.count) || 1) | 0);
            return Promise.resolve({
                prompts: new Array(count).fill(base),
                warnings: ['storyboard:variantPrompts IPC unavailable'],
            });
        }
        return this.story.variantPrompts(params);
    }

    /**
     * Take the scenes from `fromScript` and run AutoGrok image generation
     * for each. Returns one image (or batch) per scene.
     *
     * Each scene gets piped through the existing ImageService (which already
     * has retry/auth/account-rotation logic) — we don't re-implement Grok
     * calls here, we just translate prompts.
     *
     * The IPC contract (`image:generate`) expects:
     *   - `prompts`: string[]                          (one prompt per shot)
     *   - `config`: { imageGenerationCount, ... }      (passed to ImageService)
     *
     * Earlier this method passed `count` as a top-level field and `prompts` as
     * an array of objects, both of which were silently dropped by main.js's
     * destructure of `{ prompts, config, startIdx }` and would crash on
     * `prompt.substring(...)` inside `ImageService.generateBatch`.
     *
     * @param {{ scenes: Array, count_per_scene?: number, account?: string,
     *           aspectRatio?: string, enablePro?: boolean }} params
     */
    async generateImages({
        scenes,
        count_per_scene = 4,
        account,
        aspectRatio,
        enablePro,
    } = {}) {
        const prompts = (scenes || [])
            .map((s) => (s && typeof s.image_prompt === 'string' ? s.image_prompt.trim() : ''))
            .filter((p) => p.length > 0);
        const config = { imageGenerationCount: count_per_scene };
        if (aspectRatio) config.aspectRatio = aspectRatio;
        if (typeof enablePro === 'boolean') config.enablePro = enablePro;
        return this.image.generate({ prompts, config, account });
    }

    /**
     * Full pipeline: scenes → AutoGrok image generate → compose mp4 with the
     * generated images splicing the gradient placeholder.
     *
     * Order of operations:
     *   1. Filter scenes that have an `image_prompt` and a positive
     *      `duration_s`. Scenes missing either are skipped (caller still
     *      gets gradient gaps for them via composer fallback).
     *   2. Call `image:generate` IPC with one prompt per scene. Config
     *      forces `imageGenerationCount=1` (the composer only consumes
     *      one hero per scene; asking for 4 wastes Grok budget).
     *   3. For each scene's result, pick the FIRST `savedFiles[]` entry
     *      whose on-disk size is ≥ MIN_USABLE_IMAGE_BYTES (50 KB). Anything
     *      smaller is a blur / moderation placeholder per PR-9 and would
     *      render as noise in the mp4.
     *   4. Compute cumulative `start_s` from each scene's `duration_s`
     *      so the composer pins each image to the right window of the
     *      audio timeline.
     *   5. Call `producer:composeShort` IPC with the same `script` and
     *      the resolved `scene_assets[]`. Sidecar handles the rest
     *      (TTS → captions → ffmpeg compose).
     *
     * Failure modes are reported via the returned object's `warnings[]`
     * + the sidecar's own `warnings`/`scenes_missing` fields. We never
     * throw on a single-scene failure — partial AutoGrok batches still
     * compose with gradient gaps (consistent with the PR-1…6 contract).
     *
     * @param {{
     *   script: string,
     *   scenes: Array<{
     *     scene_id?: number,
     *     image_prompt: string,
     *     duration_s: number,
     *   }>,
     *   voice?: string,
     *   style?: string,
     *   output_dir?: string,
     *   write_srt?: boolean,
     *   account?: string,
     *   aspectRatio?: string,
     *   enablePro?: boolean,
     * }} params
     * @param {object} [hooks] — optional fs probe (stat) for unit tests.
     * @returns {Promise<{
     *   compose: object,         // /producer/short response (unchanged)
     *   imageGenerate: object,   // raw image:generate IPC response
     *   sceneAssets: Array<{image_path:string,start_s:number,duration_s:number,scene_id?:number}>,
     *   skippedScenes: Array<{scene_id?:number,reason:string}>,
     *   warnings: string[],
     * }>}
     */
    async composeWithScenes(params = {}, hooks = {}) {
        const {
            script,
            scenes = [],
            voice,
            style,
            output_dir,
            write_srt,
            account,
            aspectRatio,
            enablePro,
            // PR-17 — scene-level retries + partial compose.
            // `max_attempts` is the TOTAL attempts per scene (1 = no retry).
            // `allow_partial` (default true) lets the composer gradient-fill
            // any scene that never produced a usable image; setting it false
            // makes the bridge throw an "incomplete batch" error instead.
            max_attempts = 2,
            allow_partial = true,
        } = params;

        if (!this.producer || typeof this.producer.composeShort !== 'function') {
            throw new Error('StoryboardBridge.composeWithScenes: electronAPI.producer.composeShort is unavailable.');
        }
        if (typeof script !== 'string' || !script.trim()) {
            throw new Error('StoryboardBridge.composeWithScenes: script is required.');
        }

        // statBytesAsync(path) → { exists, size }. Tests can override via
        // hooks.statBytes (new contract) or hooks.stat (pre-PR-17 sync
        // contract returning `{size}`). Default uses Node fs.statSync.
        let statBytesAsync;
        if (typeof hooks.statBytes === 'function') {
            statBytesAsync = hooks.statBytes;
        } else if (typeof hooks.stat === 'function') {
            statBytesAsync = async (p) => {
                const st = hooks.stat(p);
                return { exists: !!st, size: st && typeof st.size === 'number' ? st.size : 0 };
            };
        } else {
            statBytesAsync = async (p) => {
                try {
                    const fs = require('fs');
                    const st = fs.statSync(p);
                    return { exists: true, size: Number(st.size) || 0 };
                } catch (_) {
                    return { exists: false, size: 0 };
                }
            };
        }

        // Drive image:generate (with scene-level retries) via the shared
        // helper module. Single source of truth with the renderer panel.
        const imageGenerateFn = async (prompts, _ctx) => {
            const config = { imageGenerationCount: 1 };
            if (aspectRatio) config.aspectRatio = aspectRatio;
            if (typeof enablePro === 'boolean') config.enablePro = enablePro;
            return this.image.generate({ prompts, config, account });
        };

        const orchestration = await composeHelpers.orchestrateImageGenerationWithRetries(
            scenes,
            imageGenerateFn,
            statBytesAsync,
            { maxAttempts: max_attempts, minBytes: MIN_USABLE_IMAGE_BYTES },
        );

        const { sceneAssets, perSceneStatus, retryCount, imageGenerate, maxAttempts: effectiveMaxAttempts } = orchestration;

        // Derive legacy-shape `skippedScenes[]` (preserves the contract that
        // pre-PR-17 callers / tests rely on: skipped includes both
        // `skipped` (no prompt / bad duration) and `fallback` (image gen
        // never produced ≥50KB after retries) entries).
        const skippedScenes = perSceneStatus
            .filter((s) => s.status === 'skipped' || s.status === 'fallback')
            .map((s) => ({
                scene_id: s.scene_id,
                reason: s.reason || (s.status === 'fallback' ? 'image:generate did not return a ≥50KB file after retries' : 'unknown'),
            }));

        const warnings = [];
        if (imageGenerate && imageGenerate.success === false) {
            warnings.push(
                `image:generate IPC failed on first attempt${imageGenerate.error ? ': ' + imageGenerate.error : ''}; orchestrator continued with retries.`
            );
        }
        const fallbackCount = composeHelpers.countFallbackScenes(perSceneStatus);
        if (fallbackCount > 0) {
            warnings.push(
                `${fallbackCount} scene(s) fell back to gradient after ${effectiveMaxAttempts} attempt(s); composer will fill those windows with the configured style.`
            );
        }
        if (retryCount > 0) {
            warnings.push(`Issued ${retryCount} retry attempt(s) across scenes that didn't produce a ≥${MIN_USABLE_IMAGE_BYTES}-byte image on the first pass.`);
        }
        if (sceneAssets.length === 0 && perSceneStatus.some((s) => s.status === 'fallback')) {
            warnings.push('No scene produced a usable Grok image; entire mp4 will be gradient + narration.');
        }

        // Strict mode: any scene in `fallback` blocks the compose call.
        if (!allow_partial && fallbackCount > 0) {
            const err = new Error(
                `StoryboardBridge.composeWithScenes: ${fallbackCount} scene(s) missing usable images after ${effectiveMaxAttempts} attempt(s) and allow_partial=false.`
            );
            err.code = 'INCOMPLETE_BATCH';
            err.perSceneStatus = perSceneStatus;
            err.sceneAssets = sceneAssets;
            err.retryCount = retryCount;
            err.imageGenerate = imageGenerate;
            err.warnings = warnings;
            throw err;
        }

        // Compose. The composer gradient-fills any window not covered by
        // `scene_assets[]` (so `fallback` scenes naturally render as
        // gradient when allow_partial=true).
        const composePayload = {
            script,
            scene_assets: composeHelpers.stripSceneAssetForComposer(sceneAssets),
        };
        if (voice) composePayload.voice = voice;
        if (style) composePayload.style = style;
        if (output_dir) composePayload.output_dir = output_dir;
        if (typeof write_srt === 'boolean') composePayload.write_srt = write_srt;

        const compose = await this.producer.composeShort(composePayload);

        return {
            compose,
            imageGenerate,
            sceneAssets,
            skippedScenes,
            // PR-17 additions — older callers can ignore these safely.
            perSceneStatus,
            retryCount,
            maxAttempts: effectiveMaxAttempts,
            allowPartial: !!allow_partial,
            warnings,
        };
    }

    /**
     * Full pipeline with motion clips (PR-20B):
     *
     *   scenes → image:generate (per-scene retries)
     *          → i2v:generate (per-scene retries on the hero images)
     *          → /producer/short with both ``scene_assets[]`` (image
     *            fallback per window) AND ``video_scene_assets[]``.
     *
     * The composer's layered fallback chain (``gradient < image < video``,
     * see :func:`research.core.pixelle.composer.make_short`) means a
     * scene that succeeds at I2V renders motion, a scene that fails I2V
     * but succeeded image_generate renders the still hero image (Ken
     * Burns), and a scene that failed both renders the gradient — no
     * black gaps even on partial batches.
     *
     * Diff vs :meth:`composeWithScenes`:
     *
     *   - Adds a Phase-2 i2v:generate orchestration after the image
     *     orchestration. ``max_attempts_i2v`` is independent of
     *     ``max_attempts`` (image) so the user can be more or less
     *     aggressive on each side.
     *   - Forwards both lists to ``producer.composeShort``.
     *   - ``allow_partial`` semantics extend to *images* (fallback to
     *     gradient) but the I2V layer is **always** partial-tolerant:
     *     a failed I2V scene falls back to the underlying image
     *     (already validated by the image phase). Setting
     *     ``allow_partial=false`` only blocks if the *image* phase
     *     can't satisfy every scene.
     *
     * @param {{
     *   script: string,
     *   scenes: Array,
     *   voice?: string, style?: string, output_dir?: string,
     *   write_srt?: boolean, account?: string,
     *   aspectRatio?: string, enablePro?: boolean,
     *   max_attempts?: number,        // image attempts per scene (default 2)
     *   max_attempts_i2v?: number,    // i2v attempts per scene (default 2)
     *   allow_partial?: boolean,      // gates image-fallback windows (default true)
     *   i2v_config?: object,          // optional override forwarded to i2v:generate
     * }} params
     * @param {{
     *   stat?: (p:string)=>{size:number}|null,
     *   statBytes?: (p:string)=>Promise<{exists:boolean,size:number}|null>,
     * }} [hooks]
     * @returns {Promise<{
     *   compose: object,
     *   sceneAssets: Array,
     *   videoSceneAssets: Array,
     *   imagePerSceneStatus: Array,
     *   videoPerSceneStatus: Array,
     *   imageRetryCount: number,
     *   videoRetryCount: number,
     *   imageMaxAttempts: number,
     *   videoMaxAttempts: number,
     *   allowPartial: boolean,
     *   warnings: string[],
     * }>}
     */
    async composeWithVideoScenes(params = {}, hooks = {}) {
        const {
            script,
            scenes,
            voice,
            style,
            output_dir,
            write_srt,
            account,
            aspectRatio,
            enablePro,
            max_attempts = 2,
            max_attempts_i2v = 2,
            allow_partial = true,
            i2v_config,
        } = params;

        if (!this.producer || typeof this.producer.composeShort !== 'function') {
            throw new Error('StoryboardBridge.composeWithVideoScenes: electronAPI.producer.composeShort is unavailable.');
        }
        if (!this.i2v || typeof this.i2v.generate !== 'function') {
            throw new Error('StoryboardBridge.composeWithVideoScenes: electronAPI.i2v.generate is unavailable.');
        }
        if (typeof script !== 'string' || !script.trim()) {
            throw new Error('StoryboardBridge.composeWithVideoScenes: script is required.');
        }

        // statBytesAsync(path) → { exists, size }. Same hook contract as
        // composeWithScenes so tests can share fakes.
        let statBytesAsync;
        if (typeof hooks.statBytes === 'function') {
            statBytesAsync = hooks.statBytes;
        } else if (typeof hooks.stat === 'function') {
            statBytesAsync = async (p) => {
                const st = hooks.stat(p);
                return { exists: !!st, size: st && typeof st.size === 'number' ? st.size : 0 };
            };
        } else {
            statBytesAsync = async (p) => {
                try {
                    const fs = require('fs');
                    const st = fs.statSync(p);
                    return { exists: true, size: Number(st.size) || 0 };
                } catch (_) {
                    return { exists: false, size: 0 };
                }
            };
        }

        const warnings = [];

        // ── Phase 1: image generation (with retries) ────────────────────
        const imageGenerateFn = async (prompts, _ctx) => {
            const config = { imageGenerationCount: 1 };
            if (aspectRatio) config.aspectRatio = aspectRatio;
            if (typeof enablePro === 'boolean') config.enablePro = enablePro;
            return this.image.generate({ prompts, config, account });
        };
        const imageOrchestration = await composeHelpers.orchestrateImageGenerationWithRetries(
            scenes,
            imageGenerateFn,
            statBytesAsync,
            { maxAttempts: max_attempts, minBytes: MIN_USABLE_IMAGE_BYTES },
        );
        const {
            sceneAssets,
            perSceneStatus: imagePerSceneStatus,
            retryCount: imageRetryCount,
            imageGenerate,
            maxAttempts: imageMaxAttempts,
        } = imageOrchestration;

        if (imageGenerate && imageGenerate.success === false) {
            warnings.push(
                `image:generate IPC failed on first attempt${imageGenerate.error ? ': ' + imageGenerate.error : ''}; orchestrator continued with retries.`
            );
        }
        const imageFallbackCount = composeHelpers.countFallbackScenes(imagePerSceneStatus);
        if (imageRetryCount > 0) {
            warnings.push(`Image phase: issued ${imageRetryCount} retry attempt(s) across scenes that didn't produce a ≥${MIN_USABLE_IMAGE_BYTES}-byte image on the first pass.`);
        }
        if (imageFallbackCount > 0) {
            warnings.push(`Image phase: ${imageFallbackCount} scene(s) fell back to gradient after ${imageMaxAttempts} attempt(s).`);
        }

        // Strict mode: if the user opted out of partial composition, an
        // image fallback blocks the whole pipeline (no point running
        // I2V on missing images).
        if (!allow_partial && imageFallbackCount > 0) {
            const err = new Error(
                `StoryboardBridge.composeWithVideoScenes: ${imageFallbackCount} scene(s) missing usable images after ${imageMaxAttempts} attempt(s) and allow_partial=false.`
            );
            err.code = 'INCOMPLETE_BATCH';
            err.imagePerSceneStatus = imagePerSceneStatus;
            err.sceneAssets = sceneAssets;
            err.imageRetryCount = imageRetryCount;
            err.imageGenerate = imageGenerate;
            err.warnings = warnings;
            throw err;
        }

        // ── Phase 2: i2v generation (with retries) ──────────────────────
        // Only scenes that produced a hero image are eligible — scenes
        // that fell back to gradient cannot drive i2v.
        const { jobs, skipped: i2vPlanSkipped } = videoComposeHelpers
            .planI2VJobsFromScenesAndAssets(scenes, sceneAssets);

        const i2vGenerateFn = async (items, _ctx) => {
            const payload = { items };
            if (i2v_config && typeof i2v_config === 'object') payload.config = i2v_config;
            return this.i2v.generate(payload);
        };

        let videoSceneAssets = [];
        let videoPerSceneStatus = [];
        let videoRetryCount = 0;
        let i2vFirstResp = null;
        let videoMaxAttempts = Math.max(1, Number(max_attempts_i2v) || 2);

        // PR-20E: hand the orchestrator an ffprobe-backed validator so
        // downloads that passed the service's size floor but aren't
        // actually playable mp4s (truncated moov, HTML error body with
        // an mp4 extension, codec_type missing) get marked as fallback
        // instead of going into video_scene_assets[]. When the
        // electronAPI.video.validateOutput IPC isn't available
        // (legacy preload or partial test mocks) the orchestrator falls
        // back to size-only checks — behavior-preserving.
        const validateFn = (this.video && typeof this.video.validateOutput === 'function')
            ? async (filePath, minBytes) => {
                try {
                    return await this.video.validateOutput({ filePath, minBytes });
                } catch (err) {
                    return { ok: false, reason: `validateOutput IPC threw: ${(err && err.message) || err}` };
                }
            }
            : null;

        if (jobs.length > 0) {
            const videoOrchestration = await videoComposeHelpers.orchestrateI2VWithRetries(
                jobs,
                i2vGenerateFn,
                statBytesAsync,
                { maxAttempts: max_attempts_i2v, minBytes: MIN_USABLE_VIDEO_BYTES, validateFn },
            );
            videoSceneAssets = videoOrchestration.videoSceneAssets;
            videoPerSceneStatus = videoOrchestration.perSceneStatus;
            videoRetryCount = videoOrchestration.retryCount;
            i2vFirstResp = videoOrchestration.i2vGenerate;
            videoMaxAttempts = videoOrchestration.maxAttempts;
        }

        // Reflect plan-level skips (scene with no image OR no prompt) in
        // the per-scene status table — surface them so the UI doesn't
        // appear to silently drop scenes.
        for (const sk of i2vPlanSkipped) {
            videoPerSceneStatus.push({
                scene_id: sk.scene_id,
                status: 'skipped',
                attempts: 0,
                reason: sk.reason,
            });
        }

        if (i2vFirstResp && i2vFirstResp.success === false) {
            warnings.push(
                `i2v:generate IPC failed on first attempt${i2vFirstResp.error ? ': ' + i2vFirstResp.error : ''}; orchestrator continued with retries.`
            );
        }
        const videoFallbackCount = videoComposeHelpers.countFallbackI2VScenes(videoPerSceneStatus);
        if (videoRetryCount > 0) {
            warnings.push(`I2V phase: issued ${videoRetryCount} retry attempt(s) across scenes that didn't produce a usable mp4 on the first pass.`);
        }
        if (videoFallbackCount > 0) {
            warnings.push(
                `I2V phase: ${videoFallbackCount} scene(s) fell back to image after ${videoMaxAttempts} attempt(s); composer will render the still hero frame for those windows.`
            );
        }

        // ── Phase 3: compose ────────────────────────────────────────────
        const composePayload = {
            script,
            scene_assets: composeHelpers.stripSceneAssetForComposer(sceneAssets),
        };
        if (videoSceneAssets.length > 0) {
            composePayload.video_scene_assets = videoComposeHelpers
                .stripVideoSceneAssetForComposer(videoSceneAssets);
        }
        if (voice) composePayload.voice = voice;
        if (style) composePayload.style = style;
        if (output_dir) composePayload.output_dir = output_dir;
        if (typeof write_srt === 'boolean') composePayload.write_srt = write_srt;

        const compose = await this.producer.composeShort(composePayload);

        return {
            compose,
            sceneAssets,
            videoSceneAssets,
            imagePerSceneStatus,
            videoPerSceneStatus,
            imageRetryCount,
            videoRetryCount,
            imageMaxAttempts,
            videoMaxAttempts,
            allowPartial: !!allow_partial,
            warnings,
        };
    }

    /**
     * For each scene that has a hero image, run image-to-video to get motion.
     *
     * The IPC contract (``i2v:generate`` in
     * ``desktop/electron/main.js``) is ``{ items, config, startIdx }`` —
     * each ``item`` is ``{ imagePath, prompt }`` (consumed by
     * :class:`I2VService.generateOne`). Earlier this method shipped
     * ``{ jobs, account }`` with ``image_path``/``video_prompt`` field
     * names, both of which were silently dropped by the IPC handler's
     * destructure (so ``items.length`` blew up the first time anyone
     * actually wired the I2V flow). Pre-PR-20A this never went over the
     * wire because no caller existed yet — PR-20B's
     * ``composeWithVideoScenes`` is the first caller, hence the fix
     * lands here.
     *
     * Scenes without a usable hero image (or without a non-empty video
     * prompt — we accept ``video_prompt`` *or* ``flow_video_prompt`` so
     * the scene_breakdown output drops in directly) are silently
     * dropped from the batch; the caller surfaces them via
     * ``perSceneStatus`` in the orchestrator.
     *
     * @param {{
     *   scenes: Array<{
     *     scene_id?: number,
     *     hero_image_path?: string,
     *     video_prompt?: string,
     *     flow_video_prompt?: string,
     *     duration_s?: number,
     *   }>,
     *   config?: object,
     *   startIdx?: number,
     * }} params
     */
    async animateScenes({ scenes, config, startIdx } = {}) {
        if (!this.i2v || typeof this.i2v.generate !== 'function') {
            throw new Error('StoryboardBridge.animateScenes: electronAPI.i2v.generate is unavailable.');
        }
        const items = (scenes || [])
            .map((s) => {
                if (!s) return null;
                const imagePath = typeof s.hero_image_path === 'string' ? s.hero_image_path.trim() : '';
                const prompt = (
                    typeof s.video_prompt === 'string' && s.video_prompt.trim()
                ) ? s.video_prompt.trim()
                    : (typeof s.flow_video_prompt === 'string' ? s.flow_video_prompt.trim() : '');
                if (!imagePath || !prompt) return null;
                return { imagePath, prompt };
            })
            .filter((it) => it !== null);
        const payload = { items };
        if (config && typeof config === 'object') payload.config = config;
        if (typeof startIdx === 'number') payload.startIdx = startIdx;
        return this.i2v.generate(payload);
    }
}

module.exports = StoryboardBridge;
