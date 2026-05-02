/**
 * Offline regression tests for `desktop/electron/keysStore.js`.
 *
 * Coverage:
 *   1. `getKeysFile` honours `CREATOR_FORGE_KEYS_FILE` env override
 *      ahead of `storeDir`.
 *   2. `loadKeys` returns `{}` when the file does not exist.
 *   3. `loadKeys` returns `{}` when the file is malformed JSON.
 *   4. `loadKeys` filters unknown keys out of an existing file.
 *   5. `saveKeys` round-trips a sanitised object to disk and back.
 *   6. `saveKeys` drops non-whitelisted keys silently.
 *   7. `saveKeys` drops empty / non-string values silently.
 *   8. `saveKeys` writes the file with mode 0600 (POSIX only).
 *   9. `saveKeys` creates a missing parent directory.
 *  10. `getKeyEnv` mirrors `loadKeys` (no extra process-env leakage).
 *
 * Run:  node desktop/tests/test_keys_store.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshTmpDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `cfk-${label}-`));
}

function loadFreshModule() {
    const resolved = require.resolve('../electron/keysStore.js');
    delete require.cache[resolved];
    return require('../electron/keysStore.js');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('getKeysFile honours CREATOR_FORGE_KEYS_FILE env override', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('env');
    const overridden = path.join(tmp, 'override-keys.json');
    const file = ks.getKeysFile({
        storeDir: '/should/not/be/used',
        env: { CREATOR_FORGE_KEYS_FILE: overridden },
    });
    assert.strictEqual(file, overridden);
});

test('getKeysFile falls back to storeDir/api-keys.json when env is unset', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('default');
    const file = ks.getKeysFile({ storeDir: tmp, env: {} });
    assert.strictEqual(file, path.join(tmp, 'api-keys.json'));
});

test('loadKeys returns {} when file does not exist', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('missing');
    const out = ks.loadKeys({ storeDir: tmp, env: {} });
    assert.deepStrictEqual(out, {});
});

test('loadKeys returns {} when file is malformed JSON', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('garbage');
    fs.writeFileSync(path.join(tmp, 'api-keys.json'), 'this is not json {{{');
    const out = ks.loadKeys({ storeDir: tmp, env: {} });
    assert.deepStrictEqual(out, {});
});

test('loadKeys returns {} when file contains a non-object (e.g. array)', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('nonobj');
    fs.writeFileSync(path.join(tmp, 'api-keys.json'), '["sk-not-a-key"]');
    const out = ks.loadKeys({ storeDir: tmp, env: {} });
    assert.deepStrictEqual(out, {});
});

test('loadKeys filters unknown / empty / non-string fields', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('filter');
    fs.writeFileSync(
        path.join(tmp, 'api-keys.json'),
        JSON.stringify({
            DEEPSEEK_API_KEY: 'sk-deepseek',
            YOUTUBE_API_KEY: '', // empty → drop
            GOOGLE_API_KEY: 42, // non-string → drop
            UNRELATED_SECRET: 'sk-leaky', // not whitelisted → drop
        }),
    );
    const out = ks.loadKeys({ storeDir: tmp, env: {} });
    assert.deepStrictEqual(out, { DEEPSEEK_API_KEY: 'sk-deepseek' });
});

test('saveKeys round-trips a sanitised object to disk and back', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('round-trip');
    const written = ks.saveKeys(
        { DEEPSEEK_API_KEY: 'sk-ds', YOUTUBE_API_KEY: 'AIza-yt' },
        { storeDir: tmp, env: {} },
    );
    assert.deepStrictEqual(written, {
        DEEPSEEK_API_KEY: 'sk-ds',
        YOUTUBE_API_KEY: 'AIza-yt',
    });
    const reloaded = ks.loadKeys({ storeDir: tmp, env: {} });
    assert.deepStrictEqual(reloaded, written);
});

test('saveKeys drops non-whitelisted keys silently', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('whitelist');
    const written = ks.saveKeys(
        {
            DEEPSEEK_API_KEY: 'sk-ds',
            UNRELATED_SECRET: 'should-not-be-here',
            __proto__: 'sneaky',
        },
        { storeDir: tmp, env: {} },
    );
    assert.deepStrictEqual(written, { DEEPSEEK_API_KEY: 'sk-ds' });
    // Re-load and confirm the file on disk matches.
    const reloaded = ks.loadKeys({ storeDir: tmp, env: {} });
    assert.deepStrictEqual(reloaded, written);
    assert.strictEqual(reloaded.UNRELATED_SECRET, undefined);
});

test('saveKeys drops empty / non-string values', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('empty');
    const written = ks.saveKeys(
        {
            DEEPSEEK_API_KEY: '',          // empty string → drop
            YOUTUBE_API_KEY: undefined,    // undefined → drop
            GOOGLE_API_KEY: null,          // null → drop
            GEMINI_API_KEY: { v: 'obj' },  // object → drop
            RUNNINGHUB_API_KEY: 'rh-real', // valid → keep
        },
        { storeDir: tmp, env: {} },
    );
    assert.deepStrictEqual(written, { RUNNINGHUB_API_KEY: 'rh-real' });
});

test('saveKeys creates the parent directory on a fresh install', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('mkdirp');
    // Nested path that does not exist yet.
    const nested = path.join(tmp, 'never', 'made', 'before');
    assert.strictEqual(fs.existsSync(nested), false);
    ks.saveKeys({ DEEPSEEK_API_KEY: 'sk-ds' }, { storeDir: nested, env: {} });
    assert.strictEqual(fs.existsSync(path.join(nested, 'api-keys.json')), true);
});

test('saveKeys writes the file with mode 0600 (POSIX only)', () => {
    if (process.platform === 'win32') return; // Windows ignores POSIX modes.
    const ks = loadFreshModule();
    const tmp = freshTmpDir('mode');
    const file = path.join(tmp, 'api-keys.json');
    // Pre-existing file with permissive mode → should be tightened on save.
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    ks.saveKeys({ DEEPSEEK_API_KEY: 'sk-ds' }, { storeDir: tmp, env: {} });
    const stat = fs.statSync(file);
    // Mask off the file-type bits, keep just the permission bits.
    const mode = stat.mode & 0o777;
    assert.strictEqual(
        mode,
        0o600,
        `expected mode 0600, got 0${mode.toString(8)}`,
    );
});

test('getKeyEnv mirrors loadKeys — never leaks process.env', () => {
    const ks = loadFreshModule();
    const tmp = freshTmpDir('env-leak');
    fs.writeFileSync(
        path.join(tmp, 'api-keys.json'),
        JSON.stringify({ DEEPSEEK_API_KEY: 'sk-ds' }),
    );
    // Even with HOME / PATH / unrelated secrets in the injected env,
    // getKeyEnv must return ONLY the file's whitelisted keys.
    const envWithJunk = {
        HOME: '/root',
        PATH: '/usr/bin',
        SOME_OTHER_SECRET: 'leaky',
    };
    const out = ks.getKeyEnv({ storeDir: tmp, env: envWithJunk });
    assert.deepStrictEqual(out, { DEEPSEEK_API_KEY: 'sk-ds' });
});

(async function run() {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
        } catch (err) {
            failed += 1;
            console.error(`  ✗ ${t.name}\n    ${err.stack || err.message}`);
        }
    }
    if (failed) {
        console.error(`\n${failed} / ${tests.length} test(s) FAILED`);
        process.exit(1);
    }
    console.log(`\n${tests.length} test(s) PASSED`);
})();
