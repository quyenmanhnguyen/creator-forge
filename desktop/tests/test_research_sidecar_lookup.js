/**
 * Offline tests for researchSidecar lookup helpers (PR-18).
 *
 * Verifies that `locatePackagedSidecarRoot` correctly handles every
 * lookup branch — packaged build (research/ at process.resourcesPath),
 * dev mode (no research/ next to Electron's own resources), and bad
 * inputs. Pure functions, no spawn, no HTTP, no electron import.
 */

const assert = require('assert');
const sidecar = require('../electron/researchSidecar.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log('  ok ', name);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
        if (err && err.stack) console.error(err.stack);
        failed++;
    }
}

// In-memory fs stub. Only `existsSync` is consulted by the helper.
function makeFs(existing) {
    const set = new Set(existing.map((p) => p.replace(/\\/g, '/')));
    return {
        existsSync(p) {
            return set.has(String(p).replace(/\\/g, '/'));
        },
    };
}

// ── locatePackagedSidecarRoot ───────────────────────────────────────────────

test('locatePackagedSidecarRoot: returns null for null/undefined', () => {
    assert.strictEqual(sidecar.locatePackagedSidecarRoot(null), null);
    assert.strictEqual(sidecar.locatePackagedSidecarRoot(undefined), null);
    assert.strictEqual(sidecar.locatePackagedSidecarRoot(''), null);
});

test('locatePackagedSidecarRoot: returns null for non-string input', () => {
    assert.strictEqual(sidecar.locatePackagedSidecarRoot(42), null);
    assert.strictEqual(sidecar.locatePackagedSidecarRoot({ path: '/x' }), null);
});

test('locatePackagedSidecarRoot: returns null when research/api/main.py absent', () => {
    const stubFs = makeFs([]);
    assert.strictEqual(
        sidecar.locatePackagedSidecarRoot('/Applications/Creator Forge.app/Contents/Resources', stubFs),
        null,
    );
});

test('locatePackagedSidecarRoot: returns resourcesPath when bundle has research/api/main.py', () => {
    const resources = '/Applications/Creator Forge.app/Contents/Resources';
    const stubFs = makeFs([resources + '/research/api/main.py']);
    assert.strictEqual(sidecar.locatePackagedSidecarRoot(resources, stubFs), resources);
});

test('locatePackagedSidecarRoot: dev-mode resourcesPath without research/ → null', () => {
    // In dev, process.resourcesPath usually points at Electron's own
    // resources dir, which does NOT contain research/. Verify we don't
    // false-positive there.
    const electronResources = '/home/dev/repos/creator-forge/desktop/node_modules/electron/dist/resources';
    const stubFs = makeFs([electronResources + '/default_app.asar']);
    assert.strictEqual(sidecar.locatePackagedSidecarRoot(electronResources, stubFs), null);
});

test('locatePackagedSidecarRoot: defaults fsImpl to real fs (smoke)', () => {
    // Calling without the fsImpl arg must not throw — it should fall
    // back to the real `fs` module. We pass a path that definitely
    // doesn't exist so the call returns null without erroring.
    const result = sidecar.locatePackagedSidecarRoot('/definitely/not/a/real/resources/path/' + Date.now());
    assert.strictEqual(result, null);
});

// ── findRepoRoot (exists pre-PR-18, sanity-check it still works) ────────────

test('findRepoRoot: walks up from a deep child into the actual repo root', () => {
    // From this very file, the helper must still find research/api/main.py
    // at the real repo root. This is a regression guard for PR-18 changes
    // that touched the surrounding function.
    const here = __dirname; // .../desktop/tests
    const root = sidecar.findRepoRoot(here);
    assert.ok(root, 'expected a non-null repo root');
    assert.ok(root.endsWith('creator-forge') || root.endsWith('creator-forge/'), 'unexpected root: ' + root);
});

// ── exports ─────────────────────────────────────────────────────────────────

test('module exports public + private helpers expected by callers/tests', () => {
    assert.strictEqual(typeof sidecar.start, 'function');
    assert.strictEqual(typeof sidecar.stop, 'function');
    assert.strictEqual(typeof sidecar.getPort, 'function');
    assert.strictEqual(typeof sidecar.setLogSink, 'function');
    assert.strictEqual(typeof sidecar.findRepoRoot, 'function');
    assert.strictEqual(typeof sidecar.locatePackagedSidecarRoot, 'function');
});

// ── results ─────────────────────────────────────────────────────────────────

console.log('');
console.log(`# results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
