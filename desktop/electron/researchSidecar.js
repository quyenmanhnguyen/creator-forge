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

function pythonExecutable() {
    if (process.env.CREATOR_FORGE_PYTHON) return process.env.CREATOR_FORGE_PYTHON;
    return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Probe `:port/healthz`. Returns `{ ok, ours }`:
 *   - ok: status 200 (some HTTP service is alive on the port).
 *   - ours: response body contains the creator-forge.research service tag,
 *           proving it's our FastAPI app (not some unrelated server).
 */
function probe(port) {
    return new Promise((resolve) => {
        const req = http.get(
            { host: '127.0.0.1', port, path: '/healthz', timeout: 2000 },
            (res) => {
                if (res.statusCode !== 200) {
                    resolve({ ok: false, ours: false });
                    res.resume();
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    body += chunk;
                    if (body.length > 1024) req.destroy();
                });
                res.on('end', () => {
                    resolve({ ok: true, ours: body.includes(SERVICE_TAG) });
                });
            },
        );
        req.on('error', () => resolve({ ok: false, ours: false }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, ours: false });
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

    const root = repoRoot || findRepoRoot(__dirname);
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

module.exports = { start, stop, getPort, setLogSink };
