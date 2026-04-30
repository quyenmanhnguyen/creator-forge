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

class StoryboardBridge {
    constructor(electronAPI = (typeof window !== 'undefined' ? window.electronAPI : null)) {
        if (!electronAPI || !electronAPI.storyboard || !electronAPI.image) {
            throw new Error('StoryboardBridge: required electronAPI namespaces missing (check preload.js)');
        }
        this.story = electronAPI.storyboard;
        this.image = electronAPI.image;
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
