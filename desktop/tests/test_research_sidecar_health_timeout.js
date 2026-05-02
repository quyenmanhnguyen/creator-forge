/**
 * Offline tests for researchSidecar's healthz wait — covers the
 * configurable timeout, periodic progress logging, and stderr-tail
 * surfacing when start() throws.
 *
 * Why these tests exist: a user reported "Keys saved, sidecar
 * restart failed: research sidecar did not become healthy on :5050
 * within 30000ms" on Save. The 30s budget was hard-coded and the
 * thrown error gave no clue why uvicorn was slow (cold-start of
 * bundled python-build-standalone + AV scanning on Windows is the
 * usual culprit). The fix bumps the default to 90s, adds an env
 * override (CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS), logs progress
 * every 5s during the wait, and includes the trailing 20 stderr
 * lines from the spawned uvicorn in the timeout error message.
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

function freshSidecar() {
    const sidecarPath = require.resolve('../electron/researchSidecar.js');
    delete require.cache[sidecarPath];
    return require(sidecarPath);
}

/** Bind to port 0, read the OS-assigned port, close, and return it. */
function pickFreePort() {
    return new Promise((resolve, reject) => {
        const s = http.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

function startHealthzServer({ delay = 0 } = {}) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/healthz') {
                if (delay > 0) {
                    setTimeout(() => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(SERVICE_TAG_BODY);
                    }, delay);
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(SERVICE_TAG_BODY);
                }
                return;
            }
            res.writeHead(404).end();
        });
        server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }));
    });
}

(async () => {
    console.log('test_research_sidecar_health_timeout:');

    await test('healthTimeoutMs: default is 90_000ms', () => {
        const prev = process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
        delete process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
        try {
            const sidecar = freshSidecar();
            assert.strictEqual(sidecar.healthTimeoutMs(), 90_000);
            assert.strictEqual(sidecar.HEALTH_TIMEOUT_MS_DEFAULT, 90_000);
        } finally {
            if (prev !== undefined) process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = prev;
        }
    });

    await test('healthTimeoutMs: env override applies', () => {
        const prev = process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
        process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = '12345';
        try {
            const sidecar = freshSidecar();
            assert.strictEqual(sidecar.healthTimeoutMs(), 12345);
        } finally {
            if (prev === undefined) delete process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
            else process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = prev;
        }
    });

    await test('healthTimeoutMs: invalid env value falls back to default', () => {
        const prev = process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
        for (const bogus of ['', 'oops', '0', '-100', 'NaN']) {
            process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = bogus;
            const sidecar = freshSidecar();
            assert.strictEqual(
                sidecar.healthTimeoutMs(),
                90_000,
                `bogus value ${JSON.stringify(bogus)} should fall back to default`,
            );
        }
        if (prev === undefined) delete process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
        else process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = prev;
    });

    await test('waitForHealth: returns true once healthz answers (timeoutMs arg)', async () => {
        const sidecar = freshSidecar();
        const fake = await startHealthzServer();
        try {
            const t0 = Date.now();
            const ok = await sidecar.waitForHealth(fake.port, 5000);
            const elapsed = Date.now() - t0;
            assert.strictEqual(ok, true);
            assert.ok(elapsed < 1500, `should resolve quickly when port is up (got ${elapsed}ms)`);
        } finally {
            fake.server.close();
        }
    });

    await test('waitForHealth: returns false past timeout when port stays silent', async () => {
        const sidecar = freshSidecar();
        // Pick a definitely-free port. We use port 1 (impossible to bind for
        // a regular user) so probe always errors out.
        const t0 = Date.now();
        const ok = await sidecar.waitForHealth(1, 600);
        const elapsed = Date.now() - t0;
        assert.strictEqual(ok, false);
        assert.ok(elapsed >= 500, `should honour the timeout argument (got ${elapsed}ms)`);
        assert.ok(elapsed < 2000, `should not run far past the timeout (got ${elapsed}ms)`);
    });

    await test('waitForHealth: env-driven default is honoured when timeoutMs omitted', async () => {
        const prev = process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
        process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = '500';
        try {
            const sidecar = freshSidecar();
            const t0 = Date.now();
            const ok = await sidecar.waitForHealth(1);
            const elapsed = Date.now() - t0;
            assert.strictEqual(ok, false);
            assert.ok(elapsed >= 400, `should honour the env-driven default (got ${elapsed}ms)`);
            assert.ok(elapsed < 2000, `env-driven default should cap the wait (got ${elapsed}ms)`);
        } finally {
            if (prev === undefined) delete process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
            else process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = prev;
        }
    });

    await test('start: timeout error includes the captured stderr tail', async () => {
        const sidecar = freshSidecar();
        const captured = [];
        sidecar.setLogSink((...args) => captured.push(args.join(' ')));

        // Stub spawn to return a fake child that emits a stderr line and
        // never opens any healthz responder. waitForHealth times out
        // → start() throws → message should include that stderr line.
        sidecar.__setSpawnImpl(() => {
            const handlers = {};
            const stderrHandlers = [];
            const child = {
                pid: 9999,
                stdout: { on: () => {} },
                stderr: { on: (_evt, cb) => stderrHandlers.push(cb) },
                on(event, cb) { handlers[event] = cb; },
                once(event, cb) { handlers[event] = cb; },
                kill() {
                    setTimeout(() => {
                        if (handlers.exit) handlers.exit(1, null);
                    }, 10);
                },
            };
            // Schedule a couple of stderr lines so the tail buffer fills.
            setTimeout(() => {
                for (const cb of stderrHandlers) {
                    cb(Buffer.from('ModuleNotFoundError: No module named edge_tts\n'));
                    cb(Buffer.from('ImportError: cannot import name X from research.api.main\n'));
                }
            }, 50);
            return child;
        });

        const prev = process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
        process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = '600';
        try {
            const freePort = await pickFreePort();
            const fakeRoot = path.join(__dirname, '..', '..');
            let thrown = null;
            try {
                await sidecar.start({ port: freePort, repoRoot: fakeRoot });
            } catch (err) {
                thrown = err;
            }
            assert.ok(thrown, 'start() should throw on healthz timeout');
            assert.ok(
                thrown.message.includes('did not become healthy'),
                `message should describe the timeout, got: ${thrown.message}`,
            );
            assert.ok(
                thrown.message.includes('within 600ms'),
                `message should include the configured timeout, got: ${thrown.message}`,
            );
            assert.ok(
                thrown.message.includes('Last stderr from uvicorn:'),
                `message should label the stderr tail, got: ${thrown.message}`,
            );
            assert.ok(
                thrown.message.includes('ModuleNotFoundError: No module named edge_tts'),
                `message should include captured stderr, got: ${thrown.message}`,
            );
        } finally {
            if (prev === undefined) delete process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
            else process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = prev;
        }
    });

    await test('start: timeout error suggests env override when no stderr captured', async () => {
        const sidecar = freshSidecar();
        sidecar.setLogSink(() => {});
        sidecar.__setSpawnImpl(() => {
            const handlers = {};
            const child = {
                pid: 8888,
                stdout: { on: () => {} },
                stderr: { on: () => {} },  // never emits
                on(event, cb) { handlers[event] = cb; },
                once(event, cb) { handlers[event] = cb; },
                kill() {
                    setTimeout(() => {
                        if (handlers.exit) handlers.exit(1, null);
                    }, 10);
                },
            };
            return child;
        });

        const prev = process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
        process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = '300';
        try {
            const freePort = await pickFreePort();
            const fakeRoot = path.join(__dirname, '..', '..');
            let thrown = null;
            try {
                await sidecar.start({ port: freePort, repoRoot: fakeRoot });
            } catch (err) {
                thrown = err;
            }
            assert.ok(thrown, 'start() should throw on healthz timeout');
            assert.ok(
                thrown.message.includes('CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS'),
                `message should suggest the env override, got: ${thrown.message}`,
            );
        } finally {
            if (prev === undefined) delete process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS;
            else process.env.CREATOR_FORGE_RESEARCH_HEALTH_TIMEOUT_MS = prev;
        }
    });

    await test('waitForHealth: emits a progress log line every ~5s while waiting', async () => {
        const sidecar = freshSidecar();
        const captured = [];
        sidecar.setLogSink((...args) => captured.push(args.join(' ')));

        // Use a 6.5s budget so the 5s progress log fires exactly once before
        // we give up (port stays silent the whole time). This is the longest
        // single-test wall-clock cost in the offline suite — kept below 7s
        // intentionally.
        const t0 = Date.now();
        const ok = await sidecar.waitForHealth(1, 6500);
        const elapsed = Date.now() - t0;
        assert.strictEqual(ok, false);
        assert.ok(elapsed >= 6300, `should run the full budget (got ${elapsed}ms)`);
        const progressLines = captured.filter((l) =>
            l.includes('still waiting for sidecar healthz'),
        );
        assert.ok(
            progressLines.length >= 1,
            `expected at least one "still waiting" progress log, got: ${JSON.stringify(captured)}`,
        );
        assert.ok(
            progressLines[0].includes('s elapsed'),
            `progress log should report elapsed seconds, got: ${progressLines[0]}`,
        );
        assert.ok(
            progressLines[0].includes('budget remaining'),
            `progress log should report remaining budget, got: ${progressLines[0]}`,
        );
    });

    console.log(`\n  ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
    console.error('test runner crashed:', err);
    process.exit(2);
});
