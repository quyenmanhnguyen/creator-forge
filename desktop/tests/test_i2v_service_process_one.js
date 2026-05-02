/**
 * Offline tests for ``I2VService._processOneBatchItem``.
 *
 * The work-stealing multi-account fan-out scheduler (Phase 2 of
 * PR-47) dispatches single I2V items directly to this helper —
 * instead of going through ``generateBatch``'s static-slice
 * contract. These tests pin the helper's shape so any regression
 * to its return value (jobResult), file-naming convention, or
 * progress reporting is caught offline.
 *
 * Run:  node desktop/tests/test_i2v_service_process_one.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

// CI does not run ``npm install`` for the offline test job, so we
// short-circuit module loads for every package that the service
// transitively pulls in at require time but that this test never
// touches.
const stubs = new Map();
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request) {
    if (stubs.has(request)) return request;
    return origResolve.apply(this, arguments);
};
Module._load = function (request, parent, ...rest) {
    if (stubs.has(request)) return stubs.get(request);
    if (request === 'puppeteer-extra') {
        return { use: () => {}, launch: async () => null };
    }
    if (request === 'puppeteer-extra-plugin-stealth') {
        return () => ({});
    }
    if (request === 'electron') {
        return { app: { getPath: () => '/tmp/creator-forge-test' } };
    }
    if (request === 'axios') {
        const stub = () => {};
        stub.get = stub.post = stub.put = stub.delete = stub.request = async () => ({ status: 0, data: '' });
        stub.create = () => stub;
        stub.defaults = { headers: {} };
        return stub;
    }
    return origLoad.apply(this, [request, parent, ...rest]);
};

stubs.set('./AuthService', { getAllSessions: () => [] });
stubs.set('./FileService', {
    saveFile: (buf, name, folder) => path.join(folder, name),
});

const I2VService = require('../src/services/I2VService');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function stubI2VSuccess() {
    I2VService.generateOne = async (item, session, config, onProg) => {
        onProg && onProg({ progress: 60 });
        return {
            videoUrl: 'https://example.test/i2v.mp4',
            videoId: 'i2v_456',
            title: 'I2V Title',
            error: null,
        };
    };
    I2VService.downloadVideoByUrlToFile = async (url, session, fp) => ({ path: fp });
}

function stubI2VFailure() {
    I2VService.generateOne = async () => ({
        videoUrl: null, videoId: null, title: '', error: 'auth-expired',
    });
    I2VService.downloadVideoByUrlToFile = async () => null;
}

// ─── tests ────────────────────────────────────────────────────────

test('successful path: jobResult includes imagePath + prompt + savedFile', async () => {
    stubI2VSuccess();
    const item = { imagePath: '/tmp/in/cat.png', prompt: 'cat dancing' };
    const result = await I2VService._processOneBatchItem(
        item,
        { accIdx: 0 },
        { outputFolder: '/tmp/out' },
        null,
        0, 5, 10,
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.imagePath, '/tmp/in/cat.png');
    assert.strictEqual(result.prompt, 'cat dancing');
    assert.strictEqual(result.title, 'I2V Title');
    assert.strictEqual(result.videoId, 'i2v_456');
    assert.strictEqual(result.localIdx, 0);
    assert.match(result.savedFile, /shot0005_I2V_Title\.mp4$/);
    assert.strictEqual(result.outputPath, result.savedFile);
});

test('failure path: jobResult success=false, savedFile null, error propagated', async () => {
    stubI2VFailure();
    const item = { imagePath: '/tmp/in/dog.png', prompt: 'dog jumping' };
    const result = await I2VService._processOneBatchItem(
        item,
        { accIdx: 1 },
        { outputFolder: '/tmp/out' },
        null,
        1, 2, 3,
    );
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.savedFile, null);
    assert.strictEqual(result.outputPath, null);
    assert.strictEqual(result.error, 'auth-expired');
    assert.strictEqual(result.imagePath, '/tmp/in/dog.png');
});

test('emits final 100% progress with jobResult', async () => {
    stubI2VSuccess();
    const events = [];
    const onProg = (item, progress, result) => {
        events.push({ progress, hasResult: !!result, gotItem: !!item });
    };
    await I2VService._processOneBatchItem(
        { imagePath: '/x.png', prompt: 'x' },
        { accIdx: 0 },
        {},
        onProg,
        0, 1, 1,
    );
    const final = events.filter(e => e.progress === 100 && e.hasResult);
    assert.strictEqual(final.length, 1);
    const mid = events.filter(e => e.progress === 60 && !e.hasResult);
    assert.strictEqual(mid.length, 1);
});

test('uses globalNum for shot#### naming (not localIdx)', async () => {
    stubI2VSuccess();
    const result = await I2VService._processOneBatchItem(
        { imagePath: '/x.png', prompt: 'x' },
        { accIdx: 0 },
        { outputFolder: '/tmp/n' },
        null,
        0, 99, 100,
    );
    assert.match(result.savedFile, /shot0099_/);
});

test('respects explicit outputFolder argument over config.outputFolder', async () => {
    stubI2VSuccess();
    const result = await I2VService._processOneBatchItem(
        { imagePath: '/x.png', prompt: 'x' },
        { accIdx: 0 },
        { outputFolder: '/tmp/from-config' },
        null,
        0, 1, 1,
        '/tmp/explicit',
    );
    assert.ok(result.savedFile.startsWith('/tmp/explicit'),
        `expected savedFile in /tmp/explicit, got: ${result.savedFile}`);
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
