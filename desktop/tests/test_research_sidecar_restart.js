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
function freshSidecar({ spawnStub, spawnSyncStub } = {}) {
    const sidecarPath = require.resolve('../electron/researchSidecar.js');
    delete require.cache[sidecarPath];
    const sidecar = require(sidecarPath);
    if (spawnStub) sidecar.__setSpawnImpl(spawnStub);
    if (spawnSyncStub) sidecar.__setSpawnSyncImpl(spawnSyncStub);
    return sidecar;
}

/**
 * Build a minimal EventEmitter-like fake child that the spawn stub
 * returns. Tests that exercise the spawn path should never actually
 * need to drive output; they only check that spawn was called with
 * the right env.
 */
function makeFakeChild(pid) {
    const handlers = {};
    return {
        pid: pid,
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

        // PR-72 note: waitForPortFree now does a real TCP bind probe
        // (`net.createServer().listen(port)`) rather than an HTTP
        // /healthz check. So to simulate "port frees up between stop()
        // and start()" we have to actually close the listener; just
        // toggling a `respondToHealthz` flag while keeping the socket
        // bound (the old approach) is now correctly detected as busy.
        //
        // The flow we set up here:
        //   t=0    port unbound → start() probe returns ECONNREFUSED
        //                       → start() falls through to spawn (stub)
        //   t=100  open healthServer #1 → waitForHealth in start() succeeds
        //   t=...  start() returns; close healthServer #1
        //   ...    test calls restart() → stop() → waitForPortFree (port
        //                                         genuinely free → true)
        //                                       → start() pre-probes
        //                                         (refused) → spawn stub
        //   t=...  open healthServer #2 → second waitForHealth succeeds
        let shutdownAttempts = 0;
        const buildHealthServer = () => http.createServer((req, res) => {
            if (req.url === '/admin/shutdown') {
                shutdownAttempts += 1;
                res.writeHead(404).end();
                return;
            }
            if (req.url === '/healthz') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(SERVICE_TAG_BODY);
                return;
            }
            res.writeHead(404).end();
        });
        const openOn = (server) => new Promise((resolve, reject) => {
            server.on('error', reject);
            server.listen(free, '127.0.0.1', resolve);
        });
        const closeServer = (s) => new Promise((r) => {
            try { s.close(() => r()); } catch (_) { r(); }
        });

        let healthServer = null;
        const openTimers = [];
        try {
            // Schedule healthServer #1 to come up shortly after spawn.
            const t1 = setTimeout(async () => {
                const s = buildHealthServer();
                await openOn(s);
                healthServer = s;
            }, 100);
            openTimers.push(t1);

            await sidecar.start({ port: free, repoRoot: fakeRoot, extraEnv: { DEEPSEEK_API_KEY: 'first' } });
            assert.strictEqual(spawnCalls.length, 1, 'start() should spawn when port empty');

            // Close healthServer #1 so the port is genuinely free for
            // waitForPortFree's bind probe to succeed.
            if (healthServer) {
                await closeServer(healthServer);
                healthServer = null;
            }

            // Schedule healthServer #2 so the second start()'s
            // waitForHealth can resolve.
            const t2 = setTimeout(async () => {
                const s = buildHealthServer();
                try { await openOn(s); healthServer = s; } catch (_) {}
            }, 600);
            openTimers.push(t2);

            await sidecar.restart({ port: free, repoRoot: fakeRoot, extraEnv: { DEEPSEEK_API_KEY: 'second' } });

            assert.strictEqual(shutdownAttempts, 0, 'restart() should NOT POST /admin/shutdown when not externalReuse');
            assert.strictEqual(spawnCalls.length, 2, 'restart() should spawn a new child');
            assert.strictEqual(spawnCalls[1].env.DEEPSEEK_API_KEY, 'second',
                'second spawn must apply new extraEnv');
        } finally {
            for (const t of openTimers) clearTimeout(t);
            if (healthServer) { try { healthServer.close(); } catch (_) {} }
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

    // ── kill-by-port fallback (PR-66) ─────────────────────────────────────

    await test('killByPort: posix — parses lsof output and SIGKILLs each pid', async () => {
        const spawnSyncCalls = [];
        const spawnSyncStub = (cmd, args) => {
            spawnSyncCalls.push({ cmd, args });
            if (cmd === 'lsof') {
                return { stdout: '12345\n67890\n', stderr: '', status: 0 };
            }
            return { stdout: '', stderr: '', status: 0 };
        };
        // Patch process.kill so the test doesn't actually try to send
        // signals to fictional pids (or worse, real ones). Capture the
        // call sequence instead.
        const origKill = process.kill;
        const killCalls = [];
        process.kill = (pid, sig) => { killCalls.push({ pid, sig }); };
        try {
            const sidecar = freshSidecar({ spawnSyncStub });
            // Force the platform branch even if running on win32 hosts.
            const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
            try {
                const result = sidecar.killByPort(5050);
                assert.deepStrictEqual(spawnSyncCalls[0].cmd, 'lsof');
                assert.ok(spawnSyncCalls[0].args.includes(':5050'),
                    'lsof should target the port via :PORT arg');
                assert.deepStrictEqual(result.pids, [12345, 67890]);
                assert.strictEqual(result.killed, true);
                assert.deepStrictEqual(killCalls, [
                    { pid: 12345, sig: 'SIGKILL' },
                    { pid: 67890, sig: 'SIGKILL' },
                ]);
            } finally {
                if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
            }
        } finally {
            process.kill = origKill;
        }
    });

    await test('killByPort: posix — empty lsof output → killed=false', async () => {
        const spawnSyncStub = () => ({ stdout: '', stderr: '', status: 1 });
        const sidecar = freshSidecar({ spawnSyncStub });
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        try {
            const result = sidecar.killByPort(5050);
            assert.strictEqual(result.killed, false);
            assert.deepStrictEqual(result.pids, []);
        } finally {
            if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
        }
    });

    await test('killByPort: windows — parses netstat LISTENING line and runs taskkill /F /T /PID (tree-kill)', async () => {
        const spawnSyncCalls = [];
        const spawnSyncStub = (cmd, args) => {
            spawnSyncCalls.push({ cmd, args });
            if (cmd === 'netstat') {
                return {
                    stdout:
                        '  Proto  Local Address          Foreign Address        State           PID\r\n' +
                        '  TCP    127.0.0.1:5050         0.0.0.0:0              LISTENING       4242\r\n' +
                        '  TCP    127.0.0.1:5050         127.0.0.1:50001        ESTABLISHED     7777\r\n' +
                        '  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       9999\r\n',
                    stderr: '', status: 0,
                };
            }
            return { stdout: 'SUCCESS', stderr: '', status: 0 };
        };
        const sidecar = freshSidecar({ spawnSyncStub });
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
            const result = sidecar.killByPort(5050);
            // Should ONLY pick the LISTENING row on :5050 — not the
            // ESTABLISHED client connection, not the unrelated :8080.
            assert.deepStrictEqual(result.pids, [4242]);
            assert.strictEqual(result.killed, true);
            // Verify taskkill ran with /F /T /PID 4242 (tree-kill so the
            // watchfiles --reload reloader and all child uvicorn processes
            // are terminated together, not just the immediate PID).
            const taskkillCalls = spawnSyncCalls.filter((c) => c.cmd === 'taskkill');
            assert.strictEqual(taskkillCalls.length, 1);
            assert.deepStrictEqual(taskkillCalls[0].args, ['/F', '/T', '/PID', '4242']);
        } finally {
            if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
        }
    });

    await test('killByPort: command missing → returns error gracefully', async () => {
        const spawnSyncStub = () => { throw new Error('ENOENT lsof'); };
        const sidecar = freshSidecar({ spawnSyncStub });
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        try {
            const result = sidecar.killByPort(5050);
            assert.strictEqual(result.killed, false);
            assert.match(result.error || '', /ENOENT lsof/);
        } finally {
            if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
        }
    });

    await test('restart: stale external sidecar (404 on /admin/shutdown) → killByPort fallback frees the port', async () => {
        // The bug we're fixing in PR-66: a pre-PR-65 sidecar that 404s
        // /admin/shutdown left restart() throwing "port still busy"
        // after the 5s waitForPortFree timeout. The fallback should
        // now invoke killByPort which mocked here closes the fake
        // sidecar so the second waitForPortFree sees an empty port.
        const spawnCalls = [];
        const spawnStub = (cmd, args, opts) => {
            spawnCalls.push({ cmd, args, env: opts && opts.env });
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
                s.listen(port, '127.0.0.1');
                servers.push(s);
            }
            return makeFakeChild();
        };

        const servers = [];
        // Stale sidecar: ACCEPTS /healthz but 404s /admin/shutdown.
        const fake = await startFakeSidecar({ acceptShutdown: false });
        servers.push(fake.server);

        // Mock spawnSync so killByPort returns killed=true and we can
        // close the fake server in response (mimicking SIGKILL).
        const spawnSyncStub = (cmd, args) => {
            if (cmd === 'lsof') {
                // Return a fictional pid; the actual close is done in
                // the process.kill stub below so the order is right.
                return { stdout: '99999\n', stderr: '', status: 0 };
            }
            return { stdout: '', stderr: '', status: 0 };
        };
        const origKill = process.kill;
        process.kill = (pid, sig) => {
            if (pid === 99999 && sig === 'SIGKILL') {
                try { fake.server.close(); } catch (_) {}
            }
        };

        const sidecar = freshSidecar({ spawnStub, spawnSyncStub });
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        try {
            const fakeRoot = path.join(__dirname, '..', '..');
            await sidecar.start({ port: fake.port, repoRoot: fakeRoot, extraEnv: {} });

            const newEnv = { DEEPSEEK_API_KEY: 'sk-applies-after-killbyport' };
            // Without the killByPort fallback, this would throw the
            // "port still busy" error after ~5s.
            await sidecar.restart({ port: fake.port, repoRoot: fakeRoot, extraEnv: newEnv });

            // The fake sidecar got the shutdown POST (and 404'd it).
            assert.strictEqual(fake.state.shutdownCount, 1, 'shutdown POST count');
            // Then killByPort fired (verified by the close happening in process.kill).
            // And spawn ran with the new extraEnv.
            assert.strictEqual(spawnCalls.length, 1, 'spawn call count');
            assert.strictEqual(
                spawnCalls[0].env.DEEPSEEK_API_KEY,
                'sk-applies-after-killbyport',
                'spawned env should have new DEEPSEEK_API_KEY despite stale sidecar',
            );
        } finally {
            process.kill = origKill;
            if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
            for (const s of servers) {
                try { s.close(); } catch (_) {}
            }
        }
    });

    await test('restart: spawned-mode (wasExternal=false) but child kill leaves port bound → killByPort still fires (PR-67 windows)', async () => {
        // The bug we're fixing in PR-67: on Windows, after Electron
        // spawns its own uvicorn child and the user clicks Save, the
        // child.kill('SIGTERM') in stop() sometimes leaves the listening
        // socket bound to the dying python interpreter for >5s — the
        // observed user case had `wasExternal=false` (full app restart
        // with all stale processes pre-killed by the user). PR-66's
        // killByPort fallback was gated on wasExternal so it never
        // fired for this case. PR-67 removes the gate.

        // Track the "zombie listener" that survives stop() and the new
        // spawn target; the fake healthz server we open in spawnStub.
        const servers = [];
        const spawnCalls = [];
        const spawnStub = (cmd, args, opts) => {
            spawnCalls.push({ cmd, args, env: opts && opts.env });
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
                s.listen(port, '127.0.0.1');
                servers.push(s);
            }
            return makeFakeChild();
        };

        // Find a free port up front so we can stand up the "zombie"
        // listener at the same port after our fake child exits.
        const freePort = await new Promise((resolve) => {
            const s = http.createServer();
            s.listen(0, '127.0.0.1', () => {
                const p = s.address().port;
                s.close(() => resolve(p));
            });
        });

        // killByPort stub: returns a fake pid; process.kill stub closes
        // the zombie listener so the second waitForPortFree sees an
        // empty port (mimicking a real SIGKILL releasing the socket).
        let zombieListener = null;
        const spawnSyncStub = (cmd, args) => {
            if (cmd === 'lsof' || cmd === 'netstat') {
                return cmd === 'lsof'
                    ? { stdout: '88888\n', stderr: '', status: 0 }
                    : {
                        stdout:
                            '  TCP    127.0.0.1:' + freePort + '         0.0.0.0:0              LISTENING       88888\r\n',
                        stderr: '', status: 0,
                    };
            }
            if (cmd === 'taskkill') {
                try { zombieListener && zombieListener.close(); } catch (_) {}
                zombieListener = null;
                return { stdout: 'SUCCESS', stderr: '', status: 0 };
            }
            return { stdout: '', stderr: '', status: 0 };
        };
        const origKill = process.kill;
        process.kill = (pid, sig) => {
            if (pid === 88888 && sig === 'SIGKILL') {
                try { zombieListener && zombieListener.close(); } catch (_) {}
                zombieListener = null;
            }
        };

        const sidecar = freshSidecar({ spawnStub, spawnSyncStub });
        // Test the windows code path explicitly — the PR-67 user is on
        // Windows so we want netstat + taskkill verified end-to-end.
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        const logs = [];
        sidecar.setLogSink((...args) => logs.push(args.map(String).join(' ')));

        try {
            const fakeRoot = path.join(__dirname, '..', '..');

            // 1. start() — port empty, spawn fires, fake healthz comes
            //    up. externalReuse=false. wasExternal in restart() will
            //    therefore be false (the case PR-66 missed).
            await sidecar.start({
                port: freePort, repoRoot: fakeRoot,
                extraEnv: { DEEPSEEK_API_KEY: 'old' },
            });
            assert.strictEqual(spawnCalls.length, 1, 'start() spawned');

            // 2. Simulate the Windows-specific bug: stop() runs (child
            //    kill returns), but a "zombie listener" still answers
            //    /healthz on the same port. waitForPortFree(3s) will
            //    time out → killByPort fires → process.kill stub closes
            //    the zombie → second waitForPortFree returns true →
            //    fresh spawn applies the new extraEnv.
            zombieListener = http.createServer((req, res) => {
                if (req.url === '/healthz') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(SERVICE_TAG_BODY);
                } else {
                    res.writeHead(404).end();
                }
            });
            await new Promise((resolve) => {
                // The first server (from spawnStub) is still bound to
                // freePort — close it before standing up the zombie so
                // the zombie can take over without EADDRINUSE.
                const first = servers.shift();
                first.close(() => {
                    zombieListener.listen(freePort, '127.0.0.1', resolve);
                });
            });

            const newEnv = { DEEPSEEK_API_KEY: 'sk-windows-fix' };
            await sidecar.restart({ port: freePort, repoRoot: fakeRoot, extraEnv: newEnv });

            // No /admin/shutdown was POSTed — wasExternal was false.
            // killByPort fired regardless thanks to PR-67.
            const freedLog = logs.find((l) => l.includes('freed :' + freePort) &&
                                              l.includes('stop() killed our child'));
            assert.ok(
                freedLog,
                'expected log line crediting killByPort with freeing the spawned-mode port. logs=\n' + logs.join('\n'),
            );

            assert.strictEqual(spawnCalls.length, 2, 'restart() spawned a fresh child');
            assert.strictEqual(
                spawnCalls[1].env.DEEPSEEK_API_KEY,
                'sk-windows-fix',
                'fresh spawn applies new extraEnv',
            );
        } finally {
            process.kill = origKill;
            if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
            try { zombieListener && zombieListener.close(); } catch (_) {}
            for (const s of servers) {
                try { s.close(); } catch (_) {}
            }
        }
    });

    await test('stop: windows runs taskkill /F /T /PID against the spawned child tree (PR-68)', async () => {
        // Reproduces the PR-68 fix: on Windows, child.kill() only
        // TerminateProcess'es the immediate PID, so any python /
        // uvicorn helper threads that inherited the listening socket
        // can keep :5050 bound for several seconds. stop() now
        // explicitly runs `taskkill /F /T /PID <child.pid>` to walk
        // the parent-child tree and forcibly terminate every
        // descendant. This test verifies the right command is run.

        const taskkillCalls = [];
        const spawnSyncStub = (cmd, args) => {
            if (cmd === 'taskkill') {
                taskkillCalls.push({ cmd, args });
            }
            return { stdout: 'SUCCESS', stderr: '', status: 0 };
        };

        const spawnedChildPid = 41234;
        const spawnStub = (cmd, args, opts) => {
            const portIdx = args.indexOf('--port');
            const port = portIdx >= 0 ? Number(args[portIdx + 1]) : null;
            // We need the fake healthz to come up so start() resolves.
            if (port) {
                const s = http.createServer((req, res) => {
                    if (req.url === '/healthz') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(SERVICE_TAG_BODY);
                    } else {
                        res.writeHead(404).end();
                    }
                });
                s.listen(port, '127.0.0.1');
                servers.push(s);
            }
            return makeFakeChild(spawnedChildPid);
        };

        const servers = [];
        const sidecar = freshSidecar({ spawnStub, spawnSyncStub });
        const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        const logs = [];
        sidecar.setLogSink((...args) => logs.push(args.map(String).join(' ')));

        try {
            const fakeRoot = path.join(__dirname, '..', '..');

            const free = await new Promise((resolve) => {
                const s = http.createServer();
                s.listen(0, '127.0.0.1', () => {
                    const p = s.address().port;
                    s.close(() => resolve(p));
                });
            });

            await sidecar.start({ port: free, repoRoot: fakeRoot, extraEnv: {} });
            // Close the fake healthz server so stop()'s post-kill
            // wait can resolve quickly.
            for (const s of servers) { try { s.close(); } catch (_) {} }

            await sidecar.stop();

            // stop() should have invoked taskkill /F /T /PID <pid>
            // exactly once with the spawned child's pid.
            assert.strictEqual(taskkillCalls.length, 1,
                'expected exactly one taskkill call from stop()');
            assert.deepStrictEqual(
                taskkillCalls[0].args,
                ['/F', '/T', '/PID', String(spawnedChildPid)],
                'taskkill should /F /T /PID the spawned child',
            );

            const treeKillLog = logs.find((l) =>
                l.includes('stop windows tree-kill') &&
                l.includes(String(spawnedChildPid)));
            assert.ok(treeKillLog,
                'expected stop() to log the tree-kill action. logs=\n' + logs.join('\n'));
        } finally {
            if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
            for (const s of servers) { try { s.close(); } catch (_) {} }
        }
    });

    console.log(`\n  ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
