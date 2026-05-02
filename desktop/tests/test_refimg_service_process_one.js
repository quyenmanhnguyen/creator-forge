/**
 * Offline tests for ``RefImageService._processOneBatchItem``.
 *
 * The work-stealing multi-account fan-out scheduler (Phase 2 of
 * PR-47) dispatches single ref-image items directly to this
 * helper — instead of going through ``generateBatch``'s
 * static-slice contract. These tests pin the helper's shape so
 * any regression to its return value (jobResult), file-naming
 * convention, base64-vs-URL precedence, or progress reporting is
 * caught offline.
 *
 * Run:  node desktop/tests/test_refimg_service_process_one.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const stubs = new Map();
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request) {
    if (stubs.has(request)) return request;
    return origResolve.apply(this, arguments);
};
Module._load = function (request, parent, ...rest) {
    if (stubs.has(request)) return stubs.get(request);
    return origLoad.apply(this, [request, parent, ...rest]);
};

const savedBuffers = [];
stubs.set('./AuthService', { getAllSessions: () => [] });
stubs.set('./FileService', {
    saveFile: (buf, name, folder) => {
        savedBuffers.push({ name, folder, size: buf.length });
        return path.join(folder, name);
    },
});

const RefImageService = require('../src/services/RefImageService');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeBase64(sizeBytes) {
    return Buffer.alloc(sizeBytes, 0x42).toString('base64');
}

function stubBase64Success(numImages = 1, sizeEach = 100000) {
    RefImageService.generateOne = async (item, session, config, onProg) => {
        onProg && onProg({ progress: 50 });
        return {
            title: 'Ref Title',
            imageBase64: Array.from({ length: numImages }, (_, i) => ({
                data: makeBase64(sizeEach),
                imageIndex: i,
            })),
            imageUrls: [],
            error: null,
        };
    };
    RefImageService.downloadImage = async () => null;
    RefImageService.downloadViaBrowser = async () => null;
}

function stubUrlOnlySuccess() {
    RefImageService.generateOne = async () => ({
        title: 'URL Only',
        imageBase64: [{ data: makeBase64(100), imageIndex: 0 }],  // tiny base64 (< 50000)
        imageUrls: [{ imageUrl: 'https://x/y.png', imageIndex: 0 }],
        error: null,
    });
    RefImageService.downloadImage = async () => ({
        data: Buffer.alloc(80000, 0x55),
        size: 80000,
        contentType: 'image/png',
    });
    RefImageService.downloadViaBrowser = async () => null;
}

function stubFailure() {
    RefImageService.generateOne = async () => ({
        title: '',
        imageBase64: [],
        imageUrls: [],
        error: 'no-output',
    });
    RefImageService.downloadImage = async () => null;
    RefImageService.downloadViaBrowser = async () => null;
}

// ─── tests ────────────────────────────────────────────────────────

test('successful base64 path: jobResult.savedFiles + prompt set', async () => {
    savedBuffers.length = 0;
    stubBase64Success(2, 100000);
    const item = { prompt: 'cat with sword', refImagePaths: ['/r/a.png', '/r/b.png'] };
    const result = await RefImageService._processOneBatchItem(
        item,
        { accIdx: 0 },
        { outputFolder: '/tmp/refout' },
        null,
        0, 8, 10,
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.title, 'Ref Title');
    assert.strictEqual(result.prompt, 'cat with sword');
    assert.strictEqual(result.savedFiles.length, 2);
    assert.strictEqual(result.outputPath, result.savedFiles[0]);
    for (const f of result.savedFiles) {
        assert.match(f, /ref_shot0008_/);
    }
});

test('failure path: jobResult success=false + savedFiles=[]', async () => {
    stubFailure();
    const item = { prompt: 'broken', refImagePaths: ['/r/a.png'] };
    const result = await RefImageService._processOneBatchItem(
        item,
        { accIdx: 1 },
        { outputFolder: '/tmp/refout' },
        null,
        0, 1, 1,
    );
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.savedFiles, []);
    assert.strictEqual(result.outputPath, null);
    assert.strictEqual(result.error, 'no-output');
});

test('URL fallback: when base64 < 50000, downloads URL + saves it', async () => {
    savedBuffers.length = 0;
    stubUrlOnlySuccess();
    const item = { prompt: 'tiny base64 + url fallback', refImagePaths: ['/r/a.png'] };
    const result = await RefImageService._processOneBatchItem(
        item,
        { accIdx: 0 },
        { outputFolder: '/tmp/refout' },
        null,
        0, 1, 1,
    );
    assert.strictEqual(result.success, true);
    // Should have at least 1 saved file from URL fallback (could be 2
    // if base64 was also saved first, then URL added on top — both
    // valid).
    assert.ok(result.savedFiles.length >= 1);
    const cdnFile = result.savedFiles.find(f => f.includes('_cdn_'));
    assert.ok(cdnFile, `expected one filename to contain _cdn_, got: ${result.savedFiles.join(', ')}`);
});

test('emits final 100% progress with jobResult', async () => {
    stubBase64Success(1, 100000);
    const events = [];
    const onProg = (prompt, progress, result) => {
        events.push({ prompt, progress, hasResult: !!result });
    };
    await RefImageService._processOneBatchItem(
        { prompt: 'progress-test', refImagePaths: ['/r/a.png'] },
        { accIdx: 0 },
        {},
        onProg,
        0, 1, 1,
    );
    const final = events.filter(e => e.progress === 100 && e.hasResult);
    assert.strictEqual(final.length, 1);
    assert.strictEqual(final[0].prompt, 'progress-test');
    const mid = events.filter(e => e.progress === 50 && !e.hasResult);
    assert.strictEqual(mid.length, 1);
});

test('uses globalNum for ref_shot#### naming', async () => {
    stubBase64Success(1, 100000);
    const result = await RefImageService._processOneBatchItem(
        { prompt: 'p', refImagePaths: ['/r/a.png'] },
        { accIdx: 0 },
        { outputFolder: '/tmp/refout' },
        null,
        0, 77, 100,
    );
    assert.match(result.savedFiles[0], /ref_shot0077_/);
});

test('respects explicit outputFolder argument over config.outputFolder', async () => {
    stubBase64Success(1, 100000);
    const result = await RefImageService._processOneBatchItem(
        { prompt: 'p', refImagePaths: ['/r/a.png'] },
        { accIdx: 0 },
        { outputFolder: '/tmp/from-config' },
        null,
        0, 1, 1,
        '/tmp/explicit',
    );
    assert.ok(result.savedFiles[0].startsWith('/tmp/explicit'),
        `expected /tmp/explicit, got: ${result.savedFiles[0]}`);
});

(async () => {
    let passed = 0;
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`PASS  ${name}`);
            passed++;
        } catch (err) {
            console.error(`FAIL  ${name}`);
            console.error(err && (err.stack || err.message || err));
            failed++;
        }
    }
    console.log(`\n${passed}/${tests.length} passed${failed ? ` (${failed} failed)` : ''}`);
    process.exit(failed ? 1 : 0);
})();
