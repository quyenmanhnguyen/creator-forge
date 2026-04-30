/**
 * researchSidecar.js — Electron-side manager for the Python research backend.
 *
 * The research/ FastAPI app exposes the Tube-Atlas pipeline (niche, keywords,
 * outlier, cloner, studio, producer) over HTTP. We spawn it as a subprocess
 * when the desktop app boots, health-check it, and tear it down on quit.
 *
 * The bridges in src/bridges/*.js are the only callers — they HTTP-fetch
 * `http://127.0.0.1:<port>/...` and return parsed JSON to the renderer.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_PORT = Number(process.env.CREATOR_FORGE_RESEARCH_PORT || 5050);
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 500;
const SERVICE_TAG = 'creator-forge.research';

let child = null;
let actualPort = null;
let externalReuse = false;
let logSink = (...args) => console.log('[research-sidecar]', ...args);

function setLogSink(fn) {
    if (typeof fn === 'function') logSink = fn;
}

function findRepoRoot(start) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
        if (fs.existsSync(path.join(dir, 'research', 'api', 'main.py'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Locate the bundled research/ source when the app is packaged by
 * electron-builder. The build config in `desktop/electron-builder.yml`
 * copies `research/` into `extraResources` so it lands at
 * `<process.resourcesPath>/research/api/main.py` inside the installed
 * app. In dev mode `process.resourcesPath` points at Electron's own
 * resources dir (which doesn't have research/), so this returns null
 * and we fall through to the regular `findRepoRoot` walk-up.
 *
 * Pure function — accepts the resources path explicitly so the offline
 * test suite can hit every branch without touching `process`.
 */
function locatePackagedSidecarRoot(resourcesPath, fsImpl = fs) {
    if (!resourcesPath || typeof resourcesPath !== 'string') return null;
    if (!fsImpl.existsSync(path.join(resourcesPath, 'research', 'api', 'main.py'))) {
        return null;
    }
    return resourcesPath;
}

/**
 * Pure helper exported for offline tests. Resolution order:
 *   1. CREATOR_FORGE_PYTHON env (always wins, even if it points at a
 *      missing path — we want the spawn-side error to surface so users
 *      know their override is broken).
 *   2. Bundled-by-electron-builder runtime at
 *      `<resourcesPath>/python/<interpreter>` (PR-19, Windows).
 *   3. Dev-mode bundled runtime at
 *      `<repoRoot>/desktop/build/python-runtime/<host-key>/<interpreter>`
 *      (populated by `scripts/fetch-python-runtime.js`).
 *   4. PATH fallback: `python` on Windows, `python3` elsewhere.
 *
 * `opts` lets tests inject every external surface (env, platform,
 * arch, resources path, repo root, fs.existsSync) so we can hit each
 * branch without touching the real filesystem.
 */
function resolvePythonExecutable(opts = {}) {
    const env = opts.env || process.env;
    if (env.CREATOR_FORGE_PYTHON) return env.CREATOR_FORGE_PYTHON;

    const platform = opts.platform || process.platform;
    const arch = opts.arch || process.arch;
    const fsImpl = opts.fsImpl || fs;
    const interpreterRel = platform === 'win32' ? 'python.exe' : path.join('bin', 'python3');

    // 2. packaged: <resourcesPath>/python/<interpreterRel>
    const resourcesPath = opts.resourcesPath !== undefined ? opts.resourcesPath : process.resourcesPath;
    if (resourcesPath) {
        const packaged = path.join(resourcesPath, 'python', interpreterRel);
        if (fsImpl.existsSync(packaged)) return packaged;
    }

    // 3. dev-mode: <repoRoot>/desktop/build/python-runtime/<key>/python/<interpreterRel>
    const repoRoot = opts.repoRoot || findRepoRoot(__dirname);
    if (repoRoot && arch === 'x64' && (platform === 'win32' || platform === 'linux')) {
        const key = `${platform}-${arch}`;
        const devBundled = path.join(repoRoot, 'desktop', 'build', 'python-runtime', key, 'python', interpreterRel);
        if (fsImpl.existsSync(devBundled)) return devBundled;
    }

    // 4. PATH fallback (existing behaviour pre-PR-19).
    return platform === 'win32' ? 'python' : 'python3';
}

function pythonExecutable() {
    return resolvePythonExecutable();
}

/**
 * Probe `:port/healthz`. Returns `{ ok, ours }`:
 *   - ok: status 200 (some HTTP service is alive on the port).
 *   - ours: response body contains the creator-forge.research service tag,
 *           proving it's our FastAPI app (not some unrelated server).
 */
function probe(port) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const req = http.get(
            { host: '127.0.0.1', port, path: '/healthz', timeout: 2000 },
            (res) => {
                if (res.statusCode !== 200) {
                    finish({ ok: false, ours: false });
                    res.resume();
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    body += chunk;
                    if (body.length > 1024) {
                        finish({ ok: true, ours: body.includes(SERVICE_TAG) });
                        res.destroy();
                    }
                });
                res.on('end', () => {
                    finish({ ok: true, ours: body.includes(SERVICE_TAG) });
                });
                res.on('error', () => finish({ ok: false, ours: false }));
            },
        );
        req.on('error', () => finish({ ok: false, ours: false }));
        req.on('timeout', () => {
            req.destroy();
            finish({ ok: false, ours: false });
        });
    });
}

async function waitForHealth(port) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const { ok } = await probe(port);
        if (ok) return true;
        await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
    return false;
}

/**
 * Start the sidecar. Returns { port } when /healthz is green.
 *
 * Idempotent — calling twice returns the existing handle.
 *
 * Probe-before-spawn: if `http://127.0.0.1:<port>/healthz` already responds
 * with the creator-forge.research service tag, we reuse that external sidecar
 * instead of spawning another uvicorn (which would race-fail on the busy port
 * and leave actualPort=null after the spawned child exits).
 */
async function start({ port = DEFAULT_PORT, repoRoot } = {}) {
    if (actualPort) return { port: actualPort };

    const pre = await probe(port);
    if (pre.ours) {
        actualPort = port;
        externalReuse = true;
        logSink('reusing external sidecar on :' + port);
        return { port };
    }
    if (pre.ok && !pre.ours) {
        throw new Error(
            `port :${port} is taken by a non-creator-forge service ` +
                `(GET /healthz returned 200 but without the "${SERVICE_TAG}" tag). ` +
                'Free the port or set CREATOR_FORGE_RESEARCH_PORT to a different port.',
        );
    }

    // Resolution order:
    //  1. caller-supplied repoRoot (tests / programmatic embedders)
    //  2. CREATOR_FORGE_REPO_ROOT env (dev override)
    //  3. process.resourcesPath/research (packaged by electron-builder)
    //  4. walk up from __dirname looking for research/api/main.py (dev)
    const root =
        repoRoot ||
        (process.env.CREATOR_FORGE_REPO_ROOT && fs.existsSync(
            path.join(process.env.CREATOR_FORGE_REPO_ROOT, 'research', 'api', 'main.py'),
        )
            ? process.env.CREATOR_FORGE_REPO_ROOT
            : null) ||
        locatePackagedSidecarRoot(process.resourcesPath) ||
        findRepoRoot(__dirname);
    if (!root) {
        throw new Error(
            'researchSidecar: cannot locate research/api/main.py. ' +
                'Set CREATOR_FORGE_REPO_ROOT or run from inside the monorepo.',
        );
    }

    const python = pythonExecutable();
    const args = ['-m', 'uvicorn', 'research.api.main:app', '--host', '127.0.0.1', '--port', String(port)];
    logSink('spawn', python, args.join(' '), 'cwd=', root);

    child = spawn(python, args, {
        cwd: root,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (buf) => logSink('stdout', buf.toString().trim()));
    child.stderr.on('data', (buf) => logSink('stderr', buf.toString().trim()));
    child.on('exit', (code, signal) => {
        logSink('exited', { code, signal });
        child = null;
        actualPort = null;
    });

    const healthy = await waitForHealth(port);
    if (!healthy) {
        await stop();
        throw new Error(`research sidecar did not become healthy on :${port} within ${HEALTH_TIMEOUT_MS}ms`);
    }
    actualPort = port;
    logSink('healthy on :' + port);
    return { port };
}

async function stop() {
    if (externalReuse) {
        externalReuse = false;
        actualPort = null;
        return;
    }
    if (!child) {
        actualPort = null;
        return;
    }
    const proc = child;
    child = null;
    actualPort = null;
    try {
        proc.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
    } catch (_) {}
    await new Promise((resolve) => {
        const t = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch (_) {}
            resolve();
        }, 3000);
        proc.once('exit', () => {
            clearTimeout(t);
            resolve();
        });
    });
}

function getPort() {
    return actualPort;
}

module.exports = {
    start,
    stop,
    getPort,
    setLogSink,
    // Exported for offline tests (test_research_sidecar_lookup.js):
    findRepoRoot,
    locatePackagedSidecarRoot,
    resolvePythonExecutable,
    pythonExecutable,
};
