/**
 * ResearchBridge.js — thin client for the Python research sidecar (renderer side).
 *
 * Mirrors the Tube-Atlas Streamlit pages 01_Research / 02_Keyword / 03_Outlier
 * / 04_Cloner. Each method returns a plain object that the React UI can render.
 *
 * The actual HTTP call lives in main process (researchIPC.js); the renderer
 * only talks via `window.electronAPI.research.*`.
 */

class ResearchBridge {
    constructor(electronAPI = (typeof window !== 'undefined' ? window.electronAPI : null)) {
        if (!electronAPI || !electronAPI.research) {
            throw new Error('ResearchBridge: electronAPI.research is not exposed (check preload.js)');
        }
        this.api = electronAPI.research;
    }

    /**
     * 01 Niche / Research.
     * @param {{ seed: string, language?: string, region?: string }} params
     * @returns {Promise<{ trends: Array, longtail: Array, channels: Array, outliers: Array, opportunity: number, pulse_7d: string, sentiment: object, verdict: string }>}
     */
    searchNiche(params) {
        return this.api.searchNiche(params);
    }

    /**
     * 02 Keyword Finder.
     * @param {{ seed: string, language?: string }} params
     * @returns {Promise<{ longtail: Array, score: { volume: number, competition: number }, vph: Array, kgr: number, questions: object }>}
     */
    keywordIdeas(params) {
        return this.api.keywordIdeas(params);
    }

    /**
     * 04 Outlier Finder — small channels with viral videos.
     * @param {{ topic: string, days?: 7|14|30, max_subs?: number, min_views_per_sub?: number }} params
     * @returns {Promise<{ rows: Array, csv: string }>}
     */
    outlierFinder(params) {
        return this.api.outlierFinder(params);
    }

    /**
     * 03 Video Cloner — paste a YouTube URL → clone kit.
     * @param {{ url: string, language_override?: string }} params
     * @returns {Promise<{ fingerprint: object, hook: string, structure: Array, title_clones: string[], script: string, thumbnail: object, seo_tags: string[] }>}
     */
    videoCloner(params) {
        return this.api.videoCloner(params);
    }
}

module.exports = ResearchBridge;
