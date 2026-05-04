/**
 * researchIPC.js — IPC handlers that proxy renderer calls to the Python sidecar.
 *
 * Wired in main.js after the sidecar is healthy:
 *
 *     const sidecar = require('./researchSidecar');
 *     const ipc = require('./researchIPC');
 *     await sidecar.start();
 *     ipc.register({ ipcMain, sidecar });
 *
 * Every channel maps 1:1 to a FastAPI route under research/api/routes/.
 */

const http = require('http');

/**
 * HF-16 — Electron's structured-clone bridge between main and renderer
 * only preserves ``Error.message`` / ``.name`` / ``.stack`` and drops every
 * other own-property. Earlier code did
 *
 *     reject(Object.assign(new Error(`sidecar ${code}`), { status, body }))
 *
 * which meant the renderer only ever saw the literal string
 * "sidecar 422" — useful enough to know something failed, useless for
 * pinpointing which field. We now flatten the body into the message so
 * the renderer can show the FastAPI validation detail verbatim.
 */
function _summarizeFastApiDetail(detail) {
    if (!Array.isArray(detail)) return null;
    const parts = [];
    for (const d of detail) {
        if (!d || typeof d !== 'object') continue;
        const loc = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : '';
        const msg = typeof d.msg === 'string' ? d.msg : (d.type || 'invalid');
        parts.push(loc ? `${loc}: ${msg}` : msg);
    }
    return parts.length ? parts.join('; ') : null;
}

function _formatSidecarError(statusCode, parsed) {
    let summary = '';
    if (parsed && typeof parsed === 'object') {
        const detailSummary = _summarizeFastApiDetail(parsed.detail);
        if (detailSummary) {
            summary = detailSummary;
        } else if (typeof parsed.detail === 'string') {
            summary = parsed.detail;
        } else if (typeof parsed.message === 'string') {
            summary = parsed.message;
        } else if (typeof parsed.error === 'string') {
            summary = parsed.error;
        } else if (typeof parsed.raw === 'string') {
            summary = parsed.raw;
        } else {
            try { summary = JSON.stringify(parsed); } catch (_) { /* ignore */ }
        }
    }
    if (summary && summary.length > 800) summary = `${summary.slice(0, 800)}…`;
    return summary
        ? `sidecar ${statusCode} — ${summary}`
        : `sidecar ${statusCode}`;
}

function jsonRequest(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers: {
                    'content-type': 'application/json',
                    ...(data ? { 'content-length': String(data.length) } : {}),
                },
                timeout: 120_000,
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let parsed = null;
                    try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = { raw }; }
                    if (res.statusCode >= 400) {
                        const message = _formatSidecarError(res.statusCode, parsed);
                        reject(Object.assign(new Error(message), { status: res.statusCode, body: parsed }));
                    } else {
                        resolve(parsed);
                    }
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('sidecar request timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

const CHANNELS = {
    'research:searchNiche':       { method: 'POST', path: '/research/niche' },
    'research:keywordIdeas':      { method: 'POST', path: '/research/keywords' },
    'research:outlierFinder':     { method: 'POST', path: '/research/outlier' },
    'research:videoCloner':       { method: 'POST', path: '/research/cloner' },

    'studio:topics':              { method: 'POST', path: '/studio/topics' },
    'studio:titles':              { method: 'POST', path: '/studio/titles' },
    'studio:outline':             { method: 'POST', path: '/studio/outline' },
    'studio:script':              { method: 'POST', path: '/studio/script' },
    'studio:humanize':            { method: 'POST', path: '/studio/humanize' },

    'storyboard:fromScript':      { method: 'POST', path: '/producer/scene_breakdown' },
    'storyboard:thumbnail':       { method: 'POST', path: '/producer/thumbnail_prompt' },
    // PR-26: Visual DNA + variant re-roll (used by the Storyboard panel
    // when the user edits the style anchor or bumps images_per_scene
    // without re-running the whole scene_breakdown).
    'storyboard:visualDna':       { method: 'POST', path: '/producer/visual_dna' },
    'storyboard:variantPrompts':  { method: 'POST', path: '/producer/variant_prompts' },

    'producer:composeShort':      { method: 'POST', path: '/producer/short' },
    // PR-30: voiceover-first workflow — TTS + optional SRT, no ffmpeg
    // compose. Request shape is a strict subset of /producer/short
    // (no style / scene_assets / aspect / visual_provider).
    'producer:composeAudio':      { method: 'POST', path: '/producer/audio' },
    // PR: LLM-driven script clean-up before TTS. Renderer's "Refine
    // script" button calls this to rewrite the Compose-audio script
    // textarea -- strips prompt JSON / bracketed lists / keyword
    // dumps, sizes the output to the assembled video duration. Falls
    // back to the original script (200 + warning) when
    // DEEPSEEK_API_KEY is missing.
    'producer:refineScript':      { method: 'POST', path: '/producer/refine_script' },
    // HF-13: LLM image-prompt softener. Renderer's "✨ Mềm hoá prompts"
    // button on the Storyboard panel calls this to rewrite explicit
    // anatomy / fabric vocabulary in stuck rows so Grok / generic CDN
    // moderation stops returning <100KB blurred placeholders. Falls
    // back to the originals (200 + warning) when DEEPSEEK_API_KEY is
    // missing or the LLM errors.
    'producer:softenPrompts':     { method: 'POST', path: '/producer/soften_prompts' },
    // PR-31: Video Assembly — concat per-scene MP4s, replace audio with
    // /producer/audio output, attach soft mov_text subs, write
    // ~/.creator-forge/output/assembly-<ts>/final.mp4.
    'producer:assemble':          { method: 'POST', path: '/producer/assemble' },
    'producer:listVoices':        { method: 'GET',  path: '/producer/voices' },
    'producer:listProviders':     { method: 'GET',  path: '/producer/providers' },
};

// `producer:listVoices` is the channel the renderer polls every 5s for the
// status-dot indicator. Treat "sidecar not ready yet" as a soft state for this
// channel only — return a sentinel object instead of throwing, so the
// main-process log stays quiet during cold start. All other channels still
// throw (user explicitly clicked Run, so a hard error is appropriate).
const SOFT_NOT_READY_CHANNELS = new Set(['producer:listVoices']);

function register({ ipcMain, sidecar }) {
    for (const [channel, route] of Object.entries(CHANNELS)) {
        ipcMain.handle(channel, async (_event, payload) => {
            const port = sidecar.getPort();
            if (!port) {
                if (SOFT_NOT_READY_CHANNELS.has(channel)) {
                    return { ready: false, status: 'sidecar starting' };
                }
                throw new Error('research sidecar is not running');
            }
            return jsonRequest(port, route.method, route.path, payload ?? null);
        });
    }
}

module.exports = {
    register,
    CHANNELS,
    // Exposed for unit tests (HF-16) — verify renderer-visible error
    // messages flatten FastAPI 422 detail bodies.
    _formatSidecarError,
    _summarizeFastApiDetail,
};
