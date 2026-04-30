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

// Minimum useful image size (matches PR-9 MIN_BLOB_LEN in ImageService —
// anything smaller is almost certainly a blur preview / moderation
// placeholder and would render as noise in the composed mp4).
const MIN_USABLE_IMAGE_BYTES = 50000;

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
        } = params;

        if (!this.producer || typeof this.producer.composeShort !== 'function') {
            throw new Error('StoryboardBridge.composeWithScenes: electronAPI.producer.composeShort is unavailable.');
        }
        if (typeof script !== 'string' || !script.trim()) {
            throw new Error('StoryboardBridge.composeWithScenes: script is required.');
        }

        const stat = hooks.stat || ((p) => {
            // Default: Node fs.statSync. Wrapped in try/catch so a missing
            // file becomes "0 bytes" rather than throwing — matches the
            // sidecar's "missing file → warning + skip" contract.
            try {
                // require('fs') lazily to keep the file usable in browser-only
                // environments (renderer process running tests, etc.).
                const fs = require('fs');
                return fs.statSync(p);
            } catch (_) {
                return null;
            }
        });

        const warnings = [];
        const skipped = [];

        // ── Step 1+2: build prompts, drive image:generate ───────────────
        const promptsForScenes = [];
        const indexMap = []; // promptsForScenes[i] → scenes[indexMap[i]]
        for (let i = 0; i < scenes.length; i++) {
            const s = scenes[i] || {};
            const prompt = typeof s.image_prompt === 'string' ? s.image_prompt.trim() : '';
            const duration = Number(s.duration_s);
            if (!prompt || !(duration > 0)) {
                skipped.push({ scene_id: s.scene_id, reason: !prompt ? 'missing image_prompt' : 'invalid duration_s' });
                continue;
            }
            promptsForScenes.push(prompt);
            indexMap.push(i);
        }

        let imageGenerate = { success: true, results: [] };
        if (promptsForScenes.length > 0) {
            const config = { imageGenerationCount: 1 };
            if (aspectRatio) config.aspectRatio = aspectRatio;
            if (typeof enablePro === 'boolean') config.enablePro = enablePro;
            imageGenerate = await this.image.generate({ prompts: promptsForScenes, config, account });
            if (!imageGenerate || imageGenerate.success === false) {
                warnings.push(
                    `image:generate IPC failed${imageGenerate && imageGenerate.error ? ': ' + imageGenerate.error : ''}; composing with gradient fallback only.`
                );
            }
        } else {
            warnings.push('No scenes had usable image_prompt + duration_s; composing with gradient fallback only.');
        }

        // ── Step 3: pick first ≥50KB savedFile per scene ────────────────
        // image:generate returns a flat results[] preserving input order
        // (one block of size N per prompt with localIdx). We rely on the
        // PR-9 contract: each prompt's results land contiguously and
        // savedFiles[] is the list of files saved for that prompt.
        const resultsByPrompt = new Map(); // promptIdx (in promptsForScenes) → savedFiles[]
        const allResults = (imageGenerate && Array.isArray(imageGenerate.results)) ? imageGenerate.results : [];
        for (const r of allResults) {
            // localIdx is set by main.js's IPC handler relative to the per-account
            // slice; globalIdx is the absolute index in the original prompts[].
            const idx = (typeof r.globalIdx === 'number')
                ? r.globalIdx
                : (typeof r.localIdx === 'number' ? r.localIdx : null);
            if (idx == null || idx < 0 || idx >= promptsForScenes.length) continue;
            if (!resultsByPrompt.has(idx)) resultsByPrompt.set(idx, []);
            const list = Array.isArray(r.savedFiles) ? r.savedFiles : [];
            for (const f of list) resultsByPrompt.get(idx).push(f);
        }

        // ── Step 4: compute cumulative start_s + build scene_assets ─────
        const sceneAssets = [];
        let cursor = 0.0;
        for (let i = 0; i < scenes.length; i++) {
            const s = scenes[i] || {};
            const duration = Number(s.duration_s);
            if (!(duration > 0) || typeof s.image_prompt !== 'string' || !s.image_prompt.trim()) {
                // Already counted in `skipped` above. Cursor doesn't advance
                // for invalid durations — but if image_prompt is missing yet
                // duration is positive, advance the cursor so subsequent scenes
                // line up correctly with the audio (this scene becomes a gap).
                if (duration > 0) cursor += duration;
                continue;
            }

            const promptIdx = indexMap.indexOf(i);
            const candidates = (promptIdx >= 0 ? resultsByPrompt.get(promptIdx) : null) || [];
            let chosen = null;
            for (const filePath of candidates) {
                const st = stat(filePath);
                const bytes = st && typeof st.size === 'number' ? st.size : 0;
                if (bytes >= MIN_USABLE_IMAGE_BYTES) {
                    chosen = { filePath, bytes };
                    break;
                }
            }

            if (chosen) {
                sceneAssets.push({
                    image_path: chosen.filePath,
                    start_s: Number(cursor.toFixed(3)),
                    duration_s: Number(duration.toFixed(3)),
                    scene_id: s.scene_id,
                });
            } else {
                skipped.push({
                    scene_id: s.scene_id,
                    reason: candidates.length === 0
                        ? 'image:generate returned no files for this scene'
                        : `no candidate file ≥ ${MIN_USABLE_IMAGE_BYTES} bytes (likely blur/moderation placeholder)`,
                });
            }

            cursor += duration;
        }

        // ── Step 5: compose ─────────────────────────────────────────────
        const composePayload = {
            script,
            // Strip our `scene_id` annotation before crossing the IPC
            // boundary — the sidecar's SceneAssetSpec only knows about
            // image_path / start_s / duration_s.
            scene_assets: sceneAssets.map(({ image_path, start_s, duration_s }) => ({
                image_path, start_s, duration_s,
            })),
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
            skippedScenes: skipped,
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
