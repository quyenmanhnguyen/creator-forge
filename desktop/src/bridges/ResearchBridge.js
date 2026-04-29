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
     * 01 Niche / Research — POST /research/niche.
     *
     * @param {{
     *   seed: string,
     *   language?: string,
     *   region?: string,
     *   include_trends?: boolean,
     *   include_verdict?: boolean,
     *   max_top_videos?: number,
     * }} params
     * @returns {Promise<{
     *   seed: string,
     *   region: string,
     *   language: string,
     *   longtail: string[],
     *   top_videos: Array<{video_id:string,title:string,channel_id:string,channel_title:string,views:number,likes:number,comments:number,published_at:string,url:string}>,
     *   channels: Array<{channel_id:string,title:string,subs:number,views:number,videos:number,url:string}>,
     *   outliers: Array<{video_id:string,title:string,channel_title:string,views:number,view_ratio:number,url:string}>,
     *   total_competition: number,
     *   recent_uploads_14d: number,
     *   pulse_7d: { recent_7d:number, prior_7d:number, growth_pct:number, status:string },
     *   opportunity_score: number,
     *   opportunity_grade: string,
     *   trends_top: Array<object>,
     *   trends_rising: Array<object>,
     *   verdict: { verdict:string, score:number, competition:string, summary:string, opportunities:string[], risks:string[], content_gaps:string[] } | null,
     *   warnings: string[],
     *   notes: string,
     * }>}
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
