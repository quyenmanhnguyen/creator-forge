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
// the UI panel, single source of truth (PR-17).
const composeHelpers = require('../../dist/storyboard_compose_helpers.js');

// Minimum useful image size (matches PR-9 MIN_BLOB_LEN in ImageService —
// anything smaller is almost certainly a blur preview / moderation
// placeholder and would render as noise in the composed mp4).
const MIN_USABLE_IMAGE_BYTES = composeHelpers.MIN_USABLE_IMAGE_BYTES;

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
     *   }>,
     *   md: string,
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
     * For each scene that has a hero image, run image-to-video to get motion.
     * @param {{ scenes: Array, account?: string }} params
     */
    async animateScenes({ scenes, account } = {}) {
        if (!this.i2v) throw new Error('i2v service unavailable');
        const jobs = (scenes || []).map((s) => ({
            id: s.scene_id,
            image_path: s.hero_image_path,
            prompt: s.video_prompt,
            length_s: s.duration_s || 6,
        }));
        return this.i2v.generate({ jobs, account });
    }
}

module.exports = StoryboardBridge;
