/**
 * Offline tests for researchSidecar.restart() — exercises the new
 * /admin/shutdown + waitForPortFree path that was added to fix the
 * "DEEPSEEK_API_KEY not set after Save" bug.
 *
 * Why these tests exist: pre-fix, when start() reused an externally-
 * launched uvicorn (probe-and-reuse), restart() would hit stop()'s
 * externalReuse branch (no kill) → start()'s probe-and-reuse branch
 * (no spawn) → silently drop the new extraEnv. The user's saved
 * keys never reached the running process. The fix is to POST
 * /admin/shutdown between stop() and start() so the external
 * sidecar exits and the fresh spawn picks up the new env.
 *
 * We don't actually spawn Python here — these are pure-JS unit tests
 * that wire a mini HTTP server to mimic /healthz + /admin/shutdown,
 * stub child_process.spawn before requiring the sidecar module, and
 * assert the call sequence.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log('  ok ', name);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
        if (err && err.stack) console.error(err.stack);
        failed++;
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

const SERVICE_TAG_BODY = JSON.stringify({ ok: true, service: 'creator-forge.research' });

/**
 * Boot a tiny HTTP server that mimics the FastAPI sidecar — answers
 * /healthz with the SERVICE_TAG body, and accepts POST /admin/shutdown
 * to close itself. Returns { port, server, shutdownCount }.
 */
function startFakeSidecar(opts = {}) {
    const acceptShutdown = opts.acceptShutdown !== false;
    const state = { shutdownCount: 0, healthzCount: 0 };
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/healthz') {
                state.healthzCount += 1;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(SERVICE_TAG_BODY);
                return;
            }
            if (req.method === 'POST' && req.url === '/admin/shutdown') {
                state.shutdownCount += 1;
                if (acceptShutdown) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, shutting_down: true }));
                    // Close the server after the response flushes so the
                    // port frees up — this mimics FastAPI's _delayed_exit.
                    setTimeout(() => server.close(), 50);
                } else {
                    // Simulate an old sidecar without the endpoint.
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ detail: 'Not Found' }));
                }
                return;
            }
            res.writeHead(404).end();
        });
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ port, server, state });
        });
    });
}

/**
 * Load a fresh copy of researchSidecar.js so each test starts with a
 * clean singleton (no carry-over actualPort / externalReuse / child
 * from a previous test). When `spawnStub` is provided we wire it via
 * the module's `__setSpawnImpl` test hook (we can't rewrite
 * require.cache for the builtin `child_process` because builtins are
 * not stored in `require.cache`).
 */
function freshSidecar({ spawnStub } = {}) {
    const sidecarPath = require.resolve('../electron/researchSidecar.js');
    delete require.cache[sidecarPath];
    const sidecar = require(sidecarPath);
    if (spawnStub) sidecar.__setSpawnImpl(spawnStub);
    return sidecar;
}

/**
 * Build a minimal EventEmitter-like fake child that the spawn stub
 * returns. Tests that exercise the spawn path should never actually
 * need to drive output; they only check that spawn was called with
 * the right env.
 */
function makeFakeChild() {
    const handlers = {};
    return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on(event, cb) { handlers[event] = cb; },
        once(event, cb) { handlers[event] = cb; },
        kill() { if (handlers.exit) setTimeout(() => handlers.exit(0, null), 10); },
    };
}

// ── helper-level tests (no singleton state, easy to reason about) ────────

(async () => {
    console.log('test_research_sidecar_restart:');

    await test('sendShutdown: returns ok=true when sidecar accepts shutdown', async () => {
        const sidecar = freshSidecar();
        const fake = await startFakeSidecar({ acceptShutdown: true });
        try {
            const result = await sidecar.sendShutdown(fake.port);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.status, 200);
            assert.strictEqual(fake.state.shutdownCount, 1);
        } finally {
            try { fake.server.close(); } catch (_) {}
        }
    });

    await test('sendShutdown: returns ok=false on 404 (older sidecar without endpoint)', async () => {
        const sidecar = freshSidecar();
        const fake = await startFakeSidecar({ acceptShutdown: false });
        try {
            const result = await sidecar.sendShutdown(fake.port);
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.status, 404);
        } finally {
            try { fake.server.close(); } catch (_) {}
        }
    });

    await test('sendShutdown: returns ok=false on connection refused', async () => {
        const sidecar = freshSidecar();
        // Pick a high port that is almost certainly free.
        const result = await sidecar.sendShutdown(1);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, -1);
    });

    await test('waitForPortFree: returns true once /healthz stops responding', async () => {
        const sidecar = freshSidecar();
        const fake = await startFakeSidecar({ acceptShutdown: true });
        const port = fake.port;
        // Schedule the server to close shortly after we start waiting.
        setTimeout(() => fake.server.close(), 200);
        const t0 = Date.now();
        const freed = await sidecar.waitForPortFree(port, 3000);
        const elapsed = Date.now() - t0;
        assert.strictEqual(freed, true);
        assert.ok(elapsed >= 100, 'should have observed at least one healthz cycle (got ' + elapsed + 'ms)');
        assert.ok(elapsed < 2000, 'should not have hit timeout (got ' + elapsed + 'ms)');
    });

    await test('waitForPortFree: returns false when port stays busy past timeout', async () => {
        const sidecar = freshSidecar();
        const fake = await startFakeSidecar({ acceptShutdown: false });
        try {
            const t0 = Date.now();
            const freed = await sidecar.waitForPortFree(fake.port, 600);
            const elapsed = Date.now() - t0;
            assert.strictEqual(freed, false);
            assert.ok(elapsed >= 500, 'should have honoured the timeout (got ' + elapsed + 'ms)');
        } finally {
            try { fake.server.close(); } catch (_) {}
        }
    });

    // ── full restart() flow with externalReuse → shutdown → respawn ──────

    await test('restart: externalReuse → POSTs /admin/shutdown and respawns with new extraEnv', async () => {
        // Track every server we open so we can clean up on test failure.
        const servers = [];
        let spawnCalls = [];
        const spawnStub = (cmd, args, opts) => {
            spawnCalls.push({ cmd, args, env: opts && opts.env });
            // The real spawn would launch uvicorn, which would then bind
            // the port and answer /healthz. To satisfy waitForHealth in
            // the test we open a fresh HTTP server bound to the same
            // port the spawn was asked to use. waitForPortFree has
            // already returned (the original fake sidecar is gone), so
            // listen() should succeed.
            const portIdx = args.indexOf('--port');
            const port = portIdx >= 0 ? Number(args[portIdx + 1]) : null;
            if (port) {
                const s = http.createServer((req, res) => {
                    if (req.url === '/healthz') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(SERVICE_TAG_BODY);
                    } else {
                        res.writeHead(404).end();
                    }
                });
                // Listen async — by the time waitForHealth's first poll
                // fires (500ms cadence) this will be bound.
                s.listen(port, '127.0.0.1');
                servers.push(s);
            }
            return makeFakeChild();
        };
        const sidecar = freshSidecar({ spawnStub });
        const fake = await startFakeSidecar({ acceptShutdown: true });
        servers.push(fake.server);
        try {
            const fakeRoot = path.join(__dirname, '..', '..');
            // 1. start() — externalReuse path (probe finds SERVICE_TAG).
            await sidecar.start({ port: fake.port, repoRoot: fakeRoot, extraEnv: {} });
            assert.strictEqual(spawnCalls.length, 0, 'start() should NOT spawn when reusing external');

            // 2. restart({ extraEnv }) — must shut down the external
            //    fake, wait for the port to free, then spawn fresh
            //    with the new env merged in.
            const newEnv = { DEEPSEEK_API_KEY: 'sk-restart-test', YOUTUBE_API_KEY: 'AIza-restart' };
            await sidecar.restart({ port: fake.port, repoRoot: fakeRoot, extraEnv: newEnv });

            // Assertions:
            // 1. /admin/shutdown was POSTed exactly once to the fake.
            assert.strictEqual(fake.state.shutdownCount, 1, 'shutdown POST count');
            // 2. spawn was called once with the new env merged.
            assert.strictEqual(spawnCalls.length, 1, 'spawn call count');
            const spawnedEnv = spawnCalls[0].env || {};
            assert.strictEqual(spawnedEnv.DEEPSEEK_API_KEY, 'sk-restart-test',
                'spawned env should have new DEEPSEEK_API_KEY');
            assert.strictEqual(spawnedEnv.YOUTUBE_API_KEY, 'AIza-restart',
                'spawned env should have new YOUTUBE_API_KEY');
            assert.strictEqual(spawnedEnv.PYTHONUNBUFFERED, '1',
                'spawned env should still set PYTHONUNBUFFERED');

            // 3. The spawn args invoke uvicorn on the same port.
            assert.deepStrictEqual(spawnCalls[0].args.slice(0, 4),
                ['-m', 'uvicorn', 'research.api.main:app', '--host']);
            const portIdx = spawnCalls[0].args.indexOf('--port');
            assert.strictEqual(Number(spawnCalls[0].args[portIdx + 1]), fake.port,
                'spawn should target the same port');
        } finally {
            for (const s of servers) {
                try { s.close(); } catch (_) {}
            }
        }
    });

    await test('restart: spawned-mode (no externalReuse) skips shutdown POST', async () => {
        let spawnCalls = [];
        const spawnStub = (cmd, args, opts) => {
            spawnCalls.push({ cmd, args, env: opts && opts.env });
            return makeFakeChild();
        };
        const sidecar = freshSidecar({ spawnStub });

        // Pretend the previous start() spawned its own child on a port
        // that is currently free — we test this by going through start()
        // with a fake sidecar that we then close, then call restart()
        // and observe NO shutdown POST is made (because we're not in
        // externalReuse mode).
        //
        // To keep this test focused, we directly verify that when
        // externalReuse is false, the wasExternal branch in restart()
        // is skipped: we use a port that is free from the start, so
        // start() spawns (and we control spawn via stub). Then we
        // restart and assert no /admin/shutdown traffic.

        // Find a free port.
        const free = await new Promise((resolve) => {
            const s = http.createServer();
            s.listen(0, '127.0.0.1', () => {
                const p = s.address().port;
                s.close(() => resolve(p));
            });
        });

        const fakeRoot = path.join(__dirname, '..', '..');

        // Stand up a fake healthz responder so waitForHealth resolves.
        let respondToHealthz = false;
        const healthServer = http.createServer((req, res) => {
            if (respondToHealthz && req.url === '/healthz') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(SERVICE_TAG_BODY);
            } else {
                res.writeHead(404).end();
            }
        });

        await new Promise((resolve, reject) => {
            healthServer.on('error', reject);
            healthServer.listen(free, '127.0.0.1', resolve);
        });

        try {
            // Open the healthz responder as soon as start() spawns.
            setTimeout(() => { respondToHealthz = true; }, 100);
            await sidecar.start({ port: free, repoRoot: fakeRoot, extraEnv: { DEEPSEEK_API_KEY: 'first' } });
            assert.strictEqual(spawnCalls.length, 1, 'start() should spawn when port empty');

            // Capture shutdown POST attempts (there should be none).
            let shutdownAttempts = 0;
            const origRoute = healthServer.listeners('request')[0];
            healthServer.removeAllListeners('request');
            healthServer.on('request', (req, res) => {
                if (req.url === '/admin/shutdown') {
                    shutdownAttempts += 1;
                }
                origRoute(req, res);
            });

            // restart() — wasExternal=false, so should NOT call sendShutdown.
            // To let waitForPortFree return true, close the responder briefly.
            respondToHealthz = false;
            // Then bring it back up so the post-spawn waitForHealth resolves.
            setTimeout(() => { respondToHealthz = true; }, 600);

            await sidecar.restart({ port: free, repoRoot: fakeRoot, extraEnv: { DEEPSEEK_API_KEY: 'second' } });

            assert.strictEqual(shutdownAttempts, 0, 'restart() should NOT POST /admin/shutdown when not externalReuse');
            assert.strictEqual(spawnCalls.length, 2, 'restart() should spawn a new child');
            assert.strictEqual(spawnCalls[1].env.DEEPSEEK_API_KEY, 'second',
                'second spawn must apply new extraEnv');
        } finally {
            try { healthServer.close(); } catch (_) {}
        }
    });

    // ── start() warning when reusing external sidecar with extraEnv ──────

    await test('start: logs WARN when reusing external sidecar AND extraEnv non-empty', async () => {
        const sidecar = freshSidecar();
        const fake = await startFakeSidecar({ acceptShutdown: true });
        const logs = [];
        sidecar.setLogSink((...args) => logs.push(args.map(String).join(' ')));
        try {
            const fakeRoot = path.join(__dirname, '..', '..');
            await sidecar.start({
                port: fake.port,
                repoRoot: fakeRoot,
                extraEnv: { DEEPSEEK_API_KEY: 'sk-xyz' },
            });
            const warned = logs.some((l) => l.includes('WARN reusing external sidecar') &&
                                            l.includes('NOT applied'));
            assert.ok(warned, 'expected WARN log when reusing external with extraEnv. logs=' + JSON.stringify(logs));
        } finally {
            try { fake.server.close(); } catch (_) {}
        }
    });

    await test('start: silent reuse when extraEnv is empty (dev workflow)', async () => {
        const sidecar = freshSidecar();
        const fake = await startFakeSidecar({ acceptShutdown: true });
        const logs = [];
        sidecar.setLogSink((...args) => logs.push(args.map(String).join(' ')));
        try {
            const fakeRoot = path.join(__dirname, '..', '..');
            await sidecar.start({ port: fake.port, repoRoot: fakeRoot, extraEnv: {} });
            const warned = logs.some((l) => l.includes('WARN reusing external sidecar'));
            assert.strictEqual(warned, false, 'should NOT WARN when extraEnv is empty');
            const reused = logs.some((l) => l.includes('reusing external sidecar') && !l.includes('WARN'));
            assert.ok(reused, 'expected info-level reuse log. logs=' + JSON.stringify(logs));
        } finally {
            try { fake.server.close(); } catch (_) {}
        }
    });

    console.log(`\n  ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
