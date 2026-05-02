/**
 * Offline tests for scripts/fetch-python-runtime.js (PR-19).
 *
 * All side-effecting code paths (download, extract, pip install) are
 * intentionally NOT covered here — they're integration-tested by the
 * Devin VM smoke run (Linux target) and by the user's actual `npm run
 * dist:win` build. These tests cover the pure helpers + the pinned
 * config so we can't regress URL construction, sha256 verification, or
 * platform handling without the suite catching it.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const helpers = require('../../scripts/fetch-python-runtime.js');

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

// ── parseArgs ───────────────────────────────────────────────────────────────

test('parseArgs: defaults', () => {
    const o = helpers.parseArgs([]);
    assert.strictEqual(o.platform, null);
    assert.strictEqual(o.arch, null);
    assert.strictEqual(o.skipDeps, false);
    assert.strictEqual(o.force, false);
    assert.strictEqual(o.noVerify, false);
    assert.strictEqual(o.offlineCacheOnly, false);
});

test('parseArgs: --platform / --arch / --skip-deps / --force', () => {
    const o = helpers.parseArgs(['--platform', 'win32', '--arch', 'x64', '--skip-deps', '--force']);
    assert.strictEqual(o.platform, 'win32');
    assert.strictEqual(o.arch, 'x64');
    assert.strictEqual(o.skipDeps, true);
    assert.strictEqual(o.force, true);
});

test('parseArgs: --no-verify, --offline-cache-only', () => {
    const o = helpers.parseArgs(['--no-verify', '--offline-cache-only']);
    assert.strictEqual(o.noVerify, true);
    assert.strictEqual(o.offlineCacheOnly, true);
});

test('parseArgs: unknown arg throws', () => {
    assert.throws(() => helpers.parseArgs(['--bogus']), /unknown argument/);
});

// ── platformKey ─────────────────────────────────────────────────────────────

test('platformKey: win32 + x64 → win32-x64', () => {
    assert.strictEqual(helpers.platformKey('win32', 'x64'), 'win32-x64');
});

test('platformKey: linux + x64 → linux-x64', () => {
    assert.strictEqual(helpers.platformKey('linux', 'x64'), 'linux-x64');
});

test('platformKey: darwin + x64 → darwin-x64 (PR-62)', () => {
    assert.strictEqual(helpers.platformKey('darwin', 'x64'), 'darwin-x64');
});

test('platformKey: darwin + arm64 → darwin-arm64 (PR-62)', () => {
    assert.strictEqual(helpers.platformKey('darwin', 'arm64'), 'darwin-arm64');
});

test('platformKey: darwin + unknown arch throws', () => {
    assert.throws(() => helpers.platformKey('darwin', 'ia32'), /unsupported arch for darwin/);
});

test('platformKey: arch != x64 throws on win32 / linux', () => {
    assert.throws(() => helpers.platformKey('win32', 'arm64'), /unsupported arch/);
    assert.throws(() => helpers.platformKey('linux', 'ia32'), /unsupported arch/);
});

test('platformKey: unknown platform throws', () => {
    assert.throws(() => helpers.platformKey('aix', 'x64'), /unsupported platform/);
});

// ── buildAssetUrl + buildAssetFilename ──────────────────────────────────────

test('buildAssetUrl: composes the canonical GitHub release URL', () => {
    const u = helpers.buildAssetUrl({
        releaseTag: '20250918',
        pythonVersion: '3.12.11',
        triple: 'x86_64-pc-windows-msvc',
        assetSuffix: 'install_only.tar.gz',
    });
    assert.strictEqual(
        u,
        'https://github.com/astral-sh/python-build-standalone/releases/download/20250918/cpython-3.12.11+20250918-x86_64-pc-windows-msvc-install_only.tar.gz',
    );
});

test('buildAssetFilename: matches the path component of buildAssetUrl', () => {
    const filename = helpers.buildAssetFilename({
        pythonVersion: '3.12.11',
        releaseTag: '20250918',
        triple: 'x86_64-unknown-linux-gnu',
        assetSuffix: 'install_only.tar.gz',
    });
    assert.strictEqual(filename, 'cpython-3.12.11+20250918-x86_64-unknown-linux-gnu-install_only.tar.gz');
});

// ── sha256 helpers ──────────────────────────────────────────────────────────

test('sha256OfBuffer: known vector for empty buffer', () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    assert.strictEqual(
        helpers.sha256OfBuffer(Buffer.alloc(0)),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
});

test('sha256OfBuffer: known vector for "abc"', () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    assert.strictEqual(
        helpers.sha256OfBuffer(Buffer.from('abc')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
});

test('sha256OfFile: hashes via injected fsImpl', () => {
    const stub = {
        readFileSync(p) {
            assert.strictEqual(p, '/tmp/whatever.bin');
            return Buffer.from('abc');
        },
    };
    assert.strictEqual(
        helpers.sha256OfFile('/tmp/whatever.bin', stub),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
});

// ── loadConfig + pinned config sanity ───────────────────────────────────────

test('loadConfig: parses scripts/python-runtime.config.json', () => {
    const cfg = helpers.loadConfig();
    assert.ok(cfg.release_tag, 'release_tag set');
    assert.ok(cfg.python_version, 'python_version set');
    assert.ok(cfg.platforms, 'platforms set');
    assert.ok(cfg.platforms['win32-x64'], 'win32-x64 entry present');
    const win = cfg.platforms['win32-x64'];
    assert.strictEqual(win.triple, 'x86_64-pc-windows-msvc');
    assert.strictEqual(win.asset_suffix, 'install_only.tar.gz');
    assert.match(win.sha256, /^[0-9a-f]{64}$/, 'win sha256 looks well-formed');
    assert.strictEqual(win.interpreter_relpath, 'python/python.exe');
});

test('loadConfig: linux-x64 entry exists for Devin smoke', () => {
    const cfg = helpers.loadConfig();
    const lin = cfg.platforms['linux-x64'];
    assert.ok(lin, 'linux-x64 entry present');
    assert.strictEqual(lin.triple, 'x86_64-unknown-linux-gnu');
    assert.match(lin.sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(lin.interpreter_relpath, 'python/bin/python3');
});

test('loadConfig: darwin-x64 entry exists (PR-62)', () => {
    const cfg = helpers.loadConfig();
    const m = cfg.platforms['darwin-x64'];
    assert.ok(m, 'darwin-x64 entry present');
    assert.strictEqual(m.triple, 'x86_64-apple-darwin');
    assert.strictEqual(m.asset_suffix, 'install_only.tar.gz');
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(m.interpreter_relpath, 'python/bin/python3');
});

test('loadConfig: darwin-arm64 entry exists (PR-62)', () => {
    const cfg = helpers.loadConfig();
    const m = cfg.platforms['darwin-arm64'];
    assert.ok(m, 'darwin-arm64 entry present');
    assert.strictEqual(m.triple, 'aarch64-apple-darwin');
    assert.strictEqual(m.asset_suffix, 'install_only.tar.gz');
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(m.interpreter_relpath, 'python/bin/python3');
});

test('buildAssetUrl: composes a darwin URL (PR-62)', () => {
    const u = helpers.buildAssetUrl({
        releaseTag: '20250918',
        pythonVersion: '3.12.11',
        triple: 'aarch64-apple-darwin',
        assetSuffix: 'install_only.tar.gz',
    });
    assert.strictEqual(
        u,
        'https://github.com/astral-sh/python-build-standalone/releases/download/20250918/cpython-3.12.11+20250918-aarch64-apple-darwin-install_only.tar.gz',
    );
});

test('loadConfig: malformed JSON / missing keys throws', () => {
    const badPath = '/tmp/test_fetch_python_runtime_bad_' + Date.now() + '.json';
    fs.writeFileSync(badPath, '{"release_tag": "x"}');
    try {
        assert.throws(() => helpers.loadConfig(badPath), /malformed/);
    } finally {
        fs.unlinkSync(badPath);
    }
});

// ── exports surface ─────────────────────────────────────────────────────────

test('module exports the helpers used by main + tests', () => {
    for (const key of [
        'loadConfig',
        'platformKey',
        'buildAssetUrl',
        'buildAssetFilename',
        'parseArgs',
        'sha256OfBuffer',
        'sha256OfFile',
        'REPO_ROOT',
        'RUNTIME_ROOT',
        'CACHE_DIR',
        'CONFIG_PATH',
    ]) {
        assert.ok(key in helpers, `missing export: ${key}`);
    }
});

// ── results ─────────────────────────────────────────────────────────────────

console.log('');
console.log(`# results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
