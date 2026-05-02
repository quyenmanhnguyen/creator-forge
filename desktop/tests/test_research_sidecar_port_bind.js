/**
 * Offline tests for researchSidecar's port-bind probe (PR-72).
 *
 * Why these tests exist: a user reported `WinError 10048: error while
 * attempting to bind on address ('127.0.0.1', 5050)` from the API-keys
 * Save flow even after PR-71 bumped the healthz timeout to 90s. The
 * timeout fired because the SPAWNED uvicorn could never bind \u2014 the
 * old sidecar's TCP socket was still in TIME_WAIT on the kernel side
 * even though the python process had already died.
 *
 * Root cause: pre-PR-72 `waitForPortFree(port)` used `probe(port)`
 * (HTTP /healthz check) to decide if the port was free. /healthz
 * stops responding the instant the python process exits; the TCP
 * listening socket can stay in TIME_WAIT for several more seconds on
 * Windows. So `waitForPortFree` returned `true` while bind() would
 * still fail with EADDRINUSE, leading to the 90s timeout firing on a
 * sidecar that could never actually come up.
 *
 * The fix: replace the /healthz check with a real bind probe via
 * `net.createServer().listen(port)`. If the bind succeeds the port is
 * actually free at the kernel layer; if it fails with EADDRINUSE
 * something still holds it.
 *
 * These tests cover:
 *   - canBindPort returns {free: true} when nothing listens
 *   - canBindPort returns {free: false, code: 'EADDRINUSE'} when a
 *     TCP listener holds the port
 *   - canBindPort works for an HTTP listener too (real-world case)
 *   - waitForPortFree resolves true once a listener closes
 *   - waitForPortFree returns false when the port stays bound past
 *     the budget
 *   - The decisive regression: a non-HTTP TCP listener (the bug
 *     scenario) is still detected as "not free" \u2014 the old probe()
 *     would have wrongly reported free.
 */

const assert = require('assert');
const net = require('net');
const http = require('http');

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

function freshSidecar() {
    const sidecarPath = require.resolve('../electron/researchSidecar.js');
    delete require.cache[sidecarPath];
    return require(sidecarPath);
}

/** Bind to port 0, read the OS-assigned port, close, return it. */
function pickFreePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close((err) => err ? reject(err) : resolve(port));
        });
    });
}

/** Start a bare TCP listener (no HTTP) on a given port. */
function startTcpListener(port) {
    return new Promise((resolve, reject) => {
        const s = net.createServer((socket) => socket.end());
        s.on('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
    });
}

/** Start an HTTP listener (no /healthz route — 404 for everything). */
function startHttpListener(port) {
    return new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
            res.writeHead(404);
            res.end();
        });
        s.on('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
    });
}

function closeServer(s) {
    return new Promise((resolve) => {
        try {
            s.close(() => resolve());
        } catch (_) {
            resolve();
        }
    });
}

// ── tests ──────────────────────────────────────────────────────────────────

(async () => {
    console.log('test_research_sidecar_port_bind');

    await test('canBindPort: returns {free: true} on a port nothing holds', async () => {
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        const result = await sidecar.canBindPort(port);
        assert.deepStrictEqual(result, { free: true });
    });

    await test('canBindPort: returns {free: false, code: "EADDRINUSE"} when a TCP listener holds the port', async () => {
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        const server = await startTcpListener(port);
        try {
            const result = await sidecar.canBindPort(port);
            assert.strictEqual(result.free, false, `expected free=false, got ${JSON.stringify(result)}`);
            assert.strictEqual(result.code, 'EADDRINUSE',
                `expected code=EADDRINUSE, got ${result.code}`);
        } finally {
            await closeServer(server);
        }
    });

    await test('canBindPort: detects an HTTP listener too (real-world holder)', async () => {
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        const server = await startHttpListener(port);
        try {
            const result = await sidecar.canBindPort(port);
            assert.strictEqual(result.free, false);
            assert.strictEqual(result.code, 'EADDRINUSE');
        } finally {
            await closeServer(server);
        }
    });

    await test('canBindPort: closes its probe listener so the next caller can bind', async () => {
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        const r1 = await sidecar.canBindPort(port);
        const r2 = await sidecar.canBindPort(port);
        const r3 = await sidecar.canBindPort(port);
        // If canBindPort leaked its server, the second / third call
        // would return free=false with EADDRINUSE because the first
        // call's probe would still be listening.
        assert.deepStrictEqual(r1, { free: true });
        assert.deepStrictEqual(r2, { free: true });
        assert.deepStrictEqual(r3, { free: true });
    });

    await test('waitForPortFree: returns true immediately on an unbound port', async () => {
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        const t0 = Date.now();
        const ok = await sidecar.waitForPortFree(port, 2000);
        const elapsed = Date.now() - t0;
        assert.strictEqual(ok, true);
        assert.ok(elapsed < 500, `expected <500ms, got ${elapsed}ms`);
    });

    await test('waitForPortFree: returns true once a listener closes (within budget)', async () => {
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        const server = await startTcpListener(port);
        // Close the listener after 600ms. waitForPortFree polls every
        // 200ms so it should detect the free port within ~200ms of close.
        setTimeout(() => server.close(), 600);
        const t0 = Date.now();
        const ok = await sidecar.waitForPortFree(port, 3000);
        const elapsed = Date.now() - t0;
        assert.strictEqual(ok, true,
            `expected ok=true once listener closed, got ${ok} after ${elapsed}ms`);
        assert.ok(elapsed >= 500 && elapsed <= 2000,
            `expected ~600-1200ms, got ${elapsed}ms`);
    });

    await test('waitForPortFree: returns false when the port stays bound past the budget', async () => {
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        const server = await startTcpListener(port);
        try {
            const t0 = Date.now();
            const ok = await sidecar.waitForPortFree(port, 800);
            const elapsed = Date.now() - t0;
            assert.strictEqual(ok, false);
            assert.ok(elapsed >= 700 && elapsed < 1500,
                `expected ~800ms, got ${elapsed}ms`);
        } finally {
            await closeServer(server);
        }
    });

    await test('REGRESSION (PR-72): non-HTTP TCP listener is correctly detected as not-free', async () => {
        // This is the decisive test — the pre-PR-72 implementation
        // used probe(port) (HTTP /healthz). A bare TCP listener
        // doesn't answer HTTP, so probe would have returned ok=false
        // and waitForPortFree would have wrongly said "port free"
        // even though net.bind would still fail with EADDRINUSE.
        // After PR-72 we use a real bind probe, so the answer matches
        // the actual kernel state.
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        const server = await startTcpListener(port);
        try {
            const t0 = Date.now();
            const ok = await sidecar.waitForPortFree(port, 600);
            const elapsed = Date.now() - t0;
            assert.strictEqual(ok, false,
                'a bare TCP listener (no HTTP) MUST cause waitForPortFree to return false — ' +
                'returning true here is the exact bug PR-72 fixes (TIME_WAIT race on Save+restart)');
            assert.ok(elapsed >= 500, `expected >=500ms (full budget), got ${elapsed}ms`);
        } finally {
            await closeServer(server);
        }
    });

    await test('canBindPort + waitForPortFree are idempotent: 5 sequential calls stay clean', async () => {
        const sidecar = freshSidecar();
        const port = await pickFreePort();
        for (let i = 0; i < 5; i += 1) {
            const r = await sidecar.canBindPort(port);
            assert.deepStrictEqual(r, { free: true }, `iteration ${i} leaked`);
            const ok = await sidecar.waitForPortFree(port, 500);
            assert.strictEqual(ok, true, `iteration ${i} waitForPortFree leaked`);
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
