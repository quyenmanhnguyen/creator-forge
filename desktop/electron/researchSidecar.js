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

const { spawn: realSpawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Test hook — only the offline test suite calls __setSpawnImpl to swap
// in a stub so it can assert spawn args without launching real Python.
// Runtime callers always go through the real `child_process.spawn`.
let spawnImpl = realSpawn;

const DEFAULT_PORT = Number(process.env.CREATOR_FORGE_RESEARCH_PORT || 5050);
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 500;
const SERVICE_TAG = 'creator-forge.research';

let child = null;
let actualPort = null;
let externalReuse = false;
let logSink = (...args) => console.log('[research-sidecar]', ...args);
// Cached args from the most recent successful start({...}) so restart()
// can re-use the same port + extraEnv without forcing every caller to
// re-supply them. Reset by stop().
let lastStartOpts = null;

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
 *      `<resourcesPath>/python/<interpreter>` (PR-19 on Windows,
 *      PR-62 on macOS + Linux).
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
    //    Supported keys mirror python-runtime.config.json: win32-x64,
    //    linux-x64, darwin-x64, darwin-arm64.
    const repoRoot = opts.repoRoot || findRepoRoot(__dirname);
    if (repoRoot && isDevModeBundleSupported(platform, arch)) {
        const key = `${platform}-${arch}`;
        const devBundled = path.join(repoRoot, 'desktop', 'build', 'python-runtime', key, 'python', interpreterRel);
        if (fsImpl.existsSync(devBundled)) return devBundled;
    }

    // 4. PATH fallback (existing behaviour pre-PR-19).
    return platform === 'win32' ? 'python' : 'python3';
}

/**
 * Returns true when `<platform>-<arch>` matches one of the bundle keys
 * pinned in `scripts/python-runtime.config.json`. Encoded here (not
 * loaded from JSON) to keep this hot-path zero-IO; CI guards against
 * drift via `test_research_sidecar_lookup.js`.
 */
function isDevModeBundleSupported(platform, arch) {
    if (arch === 'x64' && (platform === 'win32' || platform === 'linux' || platform === 'darwin')) {
        return true;
    }
    if (arch === 'arm64' && platform === 'darwin') return true;
    return false;
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
 * POST /admin/shutdown to a creator-forge sidecar listening on `port`.
 * Used by `restart()` to terminate an externally-launched uvicorn (one
 * we did not spawn, so we don't have its PID) before re-spawning a
 * fresh process with the new `extraEnv`. Best-effort: returns
 * `{ ok, status }` rather than throwing, so the caller can fall back
 * to a port-busy error with a useful hint.
 */
function sendShutdown(port) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: '/admin/shutdown',
                method: 'POST',
                timeout: 2000,
                headers: { 'Content-Length': '0' },
            },
            (res) => {
                res.resume();
                finish({ ok: res.statusCode === 200, status: res.statusCode || -1 });
            },
        );
        req.on('error', () => finish({ ok: false, status: -1 }));
        req.on('timeout', () => {
            req.destroy();
            finish({ ok: false, status: -1 });
        });
        req.end();
    });
}

/**
 * Wait until `:port` no longer answers `/healthz`. Used after
 * `sendShutdown()` (or after stop()'s SIGINT) to give the OS a beat
 * to release the listening socket before a fresh spawn binds it.
 * Returns true if the port freed within `timeoutMs`, else false.
 */
async function waitForPortFree(port, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { ok } = await probe(port);
        if (!ok) return true;
        await new Promise((r) => setTimeout(r, 200));
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
 *
 * `extraEnv` is merged into the spawned child's `env` after `process.env` and
 * before `PYTHONUNBUFFERED`, so callers can inject API keys (DEEPSEEK_API_KEY,
 * YOUTUBE_API_KEY, etc.) loaded from `keysStore.js` without polluting the
 * desktop process's own env. Pass an empty object / undefined when there is
 * nothing extra to inject.
 */
async function start({ port = DEFAULT_PORT, repoRoot, extraEnv } = {}) {
    lastStartOpts = { port, repoRoot, extraEnv };
    if (actualPort) return { port: actualPort };

    const pre = await probe(port);
    if (pre.ours) {
        actualPort = port;
        externalReuse = true;
        // If the caller asked us to inject env vars (e.g. API keys from
        // keysStore.js) but we're reusing an externally-launched uvicorn,
        // those vars never reach the running process. Log loudly so the
        // user notices when their saved keys aren't taking effect — they
        // can resolve via the Settings ⚙ Save button which calls
        // restart() (which DOES force a fresh spawn).
        const hasExtraEnv =
            extraEnv && typeof extraEnv === 'object' &&
            Object.keys(extraEnv).some(
                (k) => typeof extraEnv[k] === 'string' && extraEnv[k].length > 0,
            );
        if (hasExtraEnv) {
            logSink(
                'WARN reusing external sidecar on :' + port +
                ' — saved API keys NOT applied to this process. ' +
                'Open Settings ⚙ and click Save to force a fresh spawn.',
            );
        } else {
            logSink('reusing external sidecar on :' + port);
        }
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

    const spawnEnv = { ...process.env };
    if (extraEnv && typeof extraEnv === 'object') {
        for (const [k, v] of Object.entries(extraEnv)) {
            // Skip undefined / non-string values so we never write
            // "undefined" into the env (Python would see the literal
            // string and the friendly "key not set" warnings would
            // never fire).
            if (typeof v === 'string' && v.length > 0) spawnEnv[k] = v;
        }
    }
    spawnEnv.PYTHONUNBUFFERED = '1';

    child = spawnImpl(python, args, {
        cwd: root,
        env: spawnEnv,
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
        lastStartOpts = null;
        return;
    }
    if (!child) {
        actualPort = null;
        lastStartOpts = null;
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

/**
 * Restart the sidecar with a fresh `extraEnv`. Used by the API-keys
 * Settings dialog so saved keys take effect without forcing the user
 * to relaunch the app.
 *
 * Unlike `start()`, this **always forces a fresh spawn** — that's the
 * whole point of restart, and the only way the new `extraEnv` reaches
 * the running uvicorn process. The flow:
 *
 *   1. `stop()` — kills the child if we own it (spawned by us). When
 *      we're in `externalReuse` mode (`start()` reused an externally-
 *      launched uvicorn) `stop()` only clears local state because we
 *      don't have the PID; the external process is still alive.
 *
 *   2. If we were in externalReuse mode, POST `/admin/shutdown` to the
 *      sidecar so it exits cleanly. Without this step `start()` below
 *      would just probe-and-reuse the same external process again, and
 *      the new `extraEnv` would be silently dropped (this was the root
 *      cause of "DEEPSEEK_API_KEY not set" warnings persisting after
 *      Save in the API-keys dialog).
 *
 *   3. Wait for `:port` to actually free up before spawning, otherwise
 *      uvicorn's bind would race against the dying external process.
 *
 *   4. `start()` — probes a now-empty port and spawns a fresh uvicorn
 *      with the merged `extraEnv` applied to its env block.
 *
 * Falls back to the cached startup options when the caller does not
 * pass new ones, so a bare `restart()` rebounces the existing process
 * with whatever env it had on the previous successful boot.
 */
async function restart(opts = {}) {
    const merged = Object.assign({}, lastStartOpts || {}, opts || {});
    const portToUse = merged.port || DEFAULT_PORT;
    const wasExternal = externalReuse;
    await stop();

    if (wasExternal) {
        // We didn't kill anything in stop() — the external sidecar is
        // still alive. Ask it to exit so the port frees up for our
        // fresh spawn with the new extraEnv.
        const sd = await sendShutdown(portToUse);
        if (!sd.ok) {
            logSink(
                'WARN /admin/shutdown to external sidecar returned ' + sd.status +
                ' — the sidecar may be running an older build without the ' +
                'shutdown endpoint. Continuing to wait for the port to free up.',
            );
        }
    }

    // Whether we spawned or external-reused the previous instance, the
    // OS may need a beat to release the listening socket before our
    // fresh uvicorn can bind it. Block until /healthz stops responding
    // (or until the timeout — at which point we surface a clear error
    // so the user knows what to do).
    const freed = await waitForPortFree(portToUse, 5000);
    if (!freed) {
        throw new Error(
            `research sidecar restart: port :${portToUse} still busy after shutdown attempt. ` +
            'Close any external uvicorn process holding the port (e.g. a stale daemon ' +
            'from a previous app run, or `uvicorn ... --reload` in a separate terminal) ' +
            'and try Save again. Hint: ' +
            `\`lsof -i :${portToUse}\` (mac/linux) or ` +
            `\`netstat -ano | findstr :${portToUse}\` (windows) to find the holder PID.`,
        );
    }

    return start(merged);
}

module.exports = {
    start,
    stop,
    restart,
    getPort,
    setLogSink,
    // Exported for offline tests (test_research_sidecar_lookup.js,
    // test_research_sidecar_restart.js):
    findRepoRoot,
    locatePackagedSidecarRoot,
    resolvePythonExecutable,
    isDevModeBundleSupported,
    pythonExecutable,
    sendShutdown,
    waitForPortFree,
    // Test-only hooks — used by test_research_sidecar_restart.js to
    // stub out child_process.spawn without touching require.cache for
    // a builtin module. NEVER call from runtime code.
    __setSpawnImpl(impl) { spawnImpl = impl || realSpawn; },
};
