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
                        reject(Object.assign(new Error(`sidecar ${res.statusCode}`), { status: res.statusCode, body: parsed }));
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

    'producer:composeShort':      { method: 'POST', path: '/producer/short' },
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

module.exports = { register, CHANNELS };
