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
     * Convert script.md into N scene objects.
     * @param {{ script: string, count?: number, template?: string, style?: object, language?: string }} params
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
     * @param {{ scenes: Array, count_per_scene?: number, account?: string }} params
     */
    async generateImages({ scenes, count_per_scene = 4, account } = {}) {
        const prompts = (scenes || []).map((s) => ({
            id: s.scene_id,
            prompt: s.image_prompt,
            negative: s.negative_prompt || null,
            style: s.style || null,
        }));
        return this.image.generate({ prompts, count: count_per_scene, account });
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
