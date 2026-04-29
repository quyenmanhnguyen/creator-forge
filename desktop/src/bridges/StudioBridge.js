/**
 * StudioBridge.js — 5-step Studio wizard (Topic → Title → Outline → Script → Humanize).
 *
 * Wraps the DeepSeek-driven LLM chain from tube-atlas (`core.llm` +
 * `pages/04_Studio.py`) which now lives behind the FastAPI sidecar.
 *
 * State lives in the React renderer; the bridge is stateless and just calls
 * each step on demand.
 */

class StudioBridge {
    constructor(electronAPI = (typeof window !== 'undefined' ? window.electronAPI : null)) {
        if (!electronAPI || !electronAPI.studio) {
            throw new Error('StudioBridge: electronAPI.studio is not exposed (check preload.js)');
        }
        this.api = electronAPI.studio;
    }

    /** Step ① — 20 topic ideas from a niche/seed. */
    topics({ seed, language = 'en', count = 20 }) {
        return this.api.topics({ seed, language, count });
    }

    /** Step ② — 10 titles, top 3 marked as high-CTR candidates. */
    titles({ topic, language = 'en', count = 10 }) {
        return this.api.titles({ topic, language, count });
    }

    /** Step ③ — 8-part long-form outline (Hook · Empathy · Problem 1 · Small Change · Story · Problems 2&3 · Reflection · CTA). */
    outline({ title, language = 'en' }) {
        return this.api.outline({ title, language });
    }

    /** Step ④ — chunked long-form script (up to ~24k chars). */
    script({ title, outline, language = 'en', max_chars = 24000 }) {
        return this.api.script({ title, outline, language, max_chars });
    }

    /** Step ⑤ — humanize / rewrite an existing script in a more conversational voice. */
    humanize({ script, language = 'en', tone = 'warm' }) {
        return this.api.humanize({ script, language, tone });
    }
}

module.exports = StudioBridge;
