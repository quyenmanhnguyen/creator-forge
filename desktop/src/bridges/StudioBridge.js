/**
 * StudioBridge.js — 5-step Studio wizard (Topic → Title → Outline → Script → Humanize).
 *
 * Wraps the DeepSeek-driven LLM chain from tube-atlas (`core.llm` +
 * `pages/04_Studio.py`) which now lives behind the FastAPI sidecar
 * under `/studio/*`.
 *
 * State lives in the React renderer; the bridge is stateless and just calls
 * each step on demand. Every step returns 200 with `warnings[]` on upstream
 * failure (missing DEEPSEEK_API_KEY, rate limits, malformed JSON) — never 500.
 */

class StudioBridge {
    constructor(electronAPI = (typeof window !== 'undefined' ? window.electronAPI : null)) {
        if (!electronAPI || !electronAPI.studio) {
            throw new Error('StudioBridge: electronAPI.studio is not exposed (check preload.js)');
        }
        this.api = electronAPI.studio;
    }

    /**
     * Step ① — POST /studio/topics. Generate `n` topic ideas for a seed niche.
     *
     * @param {{ seed: string, language?: 'en'|'ko'|'ja'|'vi', n?: number }} params
     * @returns {Promise<{
     *   seed: string, language: string,
     *   ideas: Array<{ topic: string, emotion: string, hook: string }>,
     *   warnings: string[], notes: string,
     * }>}
     */
    topics({ seed, language = 'en', n = 20 }) {
        return this.api.topics({ seed, language, n });
    }

    /**
     * Step ② — POST /studio/titles. Generate `n` titles for a chosen topic; the
     * top 3 by predicted CTR are marked via `ctr_rank` (1, 2 or 3) and `top_3`.
     *
     * @param {{ topic: string, language?: 'en'|'ko'|'ja'|'vi', n?: number, must_keywords?: string }} params
     * @returns {Promise<{
     *   topic: string, language: string,
     *   titles: Array<{ title: string, reason: string, ctr_rank: number|null, chars: number }>,
     *   top_3: number[],
     *   warnings: string[], notes: string,
     * }>}
     */
    titles({ topic, language = 'en', n = 10, must_keywords = '' }) {
        return this.api.titles({ topic, language, n, must_keywords });
    }

    /**
     * Step ③ — POST /studio/outline. H2Dev 8-part long-form outline:
     * Hook · Empathy · Problem 1 · Small Change · Story · Problems 2 & 3 ·
     * Reflection · Closing + CTA.
     *
     * @param {{ title: string, language?: 'en'|'ko'|'ja'|'vi' }} params
     * @returns {Promise<{
     *   title: string, language: string,
     *   parts: Array<{ part: number, role: string, emotion: string, expansion: string }>,
     *   warnings: string[], notes: string,
     * }>}
     */
    outline({ title, language = 'en' }) {
        return this.api.outline({ title, language });
    }

    /**
     * Step ④ — POST /studio/script. Chunked long-form script (parts 1-4 then
     * 5-8, merged) targeting `target_chars` characters total. The LLM call is
     * slow (30-60s); show a spinner.
     *
     * @param {{
     *   title: string,
     *   parts: Array<{ part: number, role: string, emotion: string, expansion: string }>,
     *   language?: 'en'|'ko'|'ja'|'vi',
     *   target_chars?: number,
     * }} params
     * @returns {Promise<{
     *   title: string, language: string, script: string, chars: number,
     *   warnings: string[], notes: string,
     * }>}
     */
    script({ title, parts, language = 'en', target_chars = 8000 }) {
        return this.api.script({ title, parts, language, target_chars });
    }

    /**
     * Step ⑤ — POST /studio/humanize. Rewrite `script` to remove AI-shaped
     * phrasing while preserving the PART structure and total length.
     *
     * @param {{ script: string, language?: 'en'|'ko'|'ja'|'vi' }} params
     * @returns {Promise<{
     *   language: string, script_final: string, chars_in: number, chars_out: number,
     *   warnings: string[], notes: string,
     * }>}
     */
    humanize({ script, language = 'en' }) {
        return this.api.humanize({ script, language });
    }
}

module.exports = StudioBridge;
