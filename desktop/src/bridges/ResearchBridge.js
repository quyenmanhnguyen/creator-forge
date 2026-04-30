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
     * 02 Keyword Finder — POST /research/keywords.
     *
     * @param {{
     *   seed: string,
     *   language?: string,
     *   region?: string,
     *   compute_kgr?: boolean,
     *   max_kgr_keywords?: number,
     *   max_top_videos?: number,
     *   include_questions?: boolean,
     * }} params
     * @returns {Promise<{
     *   seed: string,
     *   region: string,
     *   language: string,
     *   suggestions: Array<{keyword:string,length:number,words:number,competition:number,score:number,grade:string}>,
     *   seed_score: { volume:number, competition:number, keyword:number, grade:string },
     *   total_results: number,
     *   vph_top: Array<{video_id:string,title:string,views:number,vph:number,published_at:string,url:string}>,
     *   questions: Object<string, string[]>,
     *   warnings: string[],
     *   notes: string,
     * }>}
     */
    keywordIdeas(params) {
        return this.api.keywordIdeas(params);
    }

    /**
     * 03 Outlier Finder — POST /research/outlier.
     * Surfaces small channels (subs <= max_subs) with breakout videos
     * in the last window_days. Sorted by outlier_score DESC.
     *
     * @param {{
     *   seed: string,
     *   region?: string,
     *   window_days?: 7|14|30,
     *   max_subs?: number,
     *   min_outlier?: number,
     *   max_results?: number,
     * }} params
     * @returns {Promise<{
     *   seed: string,
     *   region: string,
     *   window_days: number,
     *   rows: Array<{
     *     video_id: string, title: string,
     *     channel_id: string, channel_title: string,
     *     subs: number, views: number, likes: number, comments: number,
     *     published_at: string, hours_since: number, vph: number,
     *     outlier_score: number, thumbnail: string, url: string, duration: string,
     *   }>,
     *   stats: { count:number, max_vph:number, avg_vph:number, avg_outlier_score:number },
     *   warnings: string[],
     *   notes: string,
     * }>}
     */
    outlierFinder(params) {
        return this.api.outlierFinder(params);
    }

    /**
     * 04 Video Cloner — POST /research/cloner.
     * Reverse-engineers a YouTube video into a remake kit: fingerprint
     * (stats + tags) + hook analysis + N title clones + full script clone +
     * thumbnail copy + SEO tags, in the source video's language (or override).
     *
     * @param {{
     *   url: string,
     *   new_topic?: string,
     *   n_titles?: number,
     *   language_override?: 'auto'|'en'|'ko'|'ja'|'vi',
     *   transcript_languages?: string[],
     *   transcript_max_chars?: number,
     * }} params
     * @returns {Promise<{
     *   video_id: string,
     *   fingerprint: {
     *     video_id:string, title:string, channel_id:string, channel_title:string,
     *     published_at:string, duration_sec:number, views:number, likes:number,
     *     comments:number, engagement_rate_pct:number, thumbnail:string,
     *     tags:string[], url:string,
     *   },
     *   transcript_excerpt: string,
     *   transcript_segments: number,
     *   detected_language: string,
     *   output_language: string,
     *   kit: null | {
     *     hook_analysis:string, title_clones:string[], script:string,
     *     thumbnail_copy:string[], tags:string[],
     *   },
     *   warnings: string[],
     *   notes: string,
     * }>}
     */
    videoCloner(params) {
        return this.api.videoCloner(params);
    }
}

module.exports = ResearchBridge;
