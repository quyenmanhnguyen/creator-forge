/**
 * Offline tests for ``VideoService._processOneBatchItem``.
 *
 * The work-stealing multi-account fan-out scheduler (Phase 2 of
 * PR-47) dispatches single video items directly to this helper
 * — instead of going through ``generateBatch``'s static-slice
 * contract. These tests pin the helper's shape so any regression
 * to its return value (jobResult), file-naming convention, or
 * progress reporting is caught offline.
 *
 * Run:  node desktop/tests/test_video_service_process_one.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

// Stub ``./AuthService`` import inside VideoService so requiring
// the service does not pull in puppeteer / electron paths.
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
const stubs = new Map();
Module._resolveFilename = function (request, parent) {
    if (stubs.has(request)) return request;
    return origResolve.apply(this, arguments);
};
Module._load = function (request, parent, ...rest) {
    if (stubs.has(request)) return stubs.get(request);
    return origLoad.apply(this, [request, parent, ...rest]);
};

stubs.set('./AuthService', {
    getAllSessions: () => [],
});
stubs.set('./FileService', {
    saveFile: (buf, name, folder) => path.join(folder, name),
});

const VideoService = require('../src/services/VideoService');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── helper: stub generateOne + downloadVideoToFile ───────────────

function stubVideoSuccess() {
    const calls = { generateOne: 0, download: 0 };
    VideoService.generateOne = async (prompt, session, config, onProg) => {
        calls.generateOne++;
        onProg && onProg({ progress: 50 });
        return {
            videoUrl: 'https://example.test/v.mp4',
            videoId: 'vid_123',
            title: 'My Video Title',
            error: null,
        };
    };
    VideoService.downloadVideoToFile = async (url, session, filePath) => {
        calls.download++;
        return { path: filePath };
    };
    return calls;
}

function stubVideoFailure() {
    VideoService.generateOne = async () => ({
        videoUrl: null,
        videoId: null,
        title: '',
        error: 'rate-limited',
    });
    VideoService.downloadVideoToFile = async () => null;
}

// ─── tests ────────────────────────────────────────────────────────

test('successful path: returns jobResult with savedFile + outputPath set', async () => {
    stubVideoSuccess();
    const session = { accIdx: 0 };
    const result = await VideoService._processOneBatchItem(
        'a calm morning lake',
        session,
        { outputFolder: '/tmp/test-videos' },
        null,
        0,
        7,
        10,
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.title, 'My Video Title');
    assert.strictEqual(result.videoId, 'vid_123');
    assert.strictEqual(result.localIdx, 0);
    assert.strictEqual(typeof result.savedFile, 'string');
    assert.strictEqual(result.outputPath, result.savedFile);
    assert.match(result.savedFile, /shot0007_My_Video_Title\.mp4$/);
    assert.strictEqual(result.error, null);
});

test('failure path: returns jobResult with success=false + savedFile=null', async () => {
    stubVideoFailure();
    const session = { accIdx: 1 };
    const result = await VideoService._processOneBatchItem(
        'broken prompt',
        session,
        { outputFolder: '/tmp/test-videos' },
        null,
        2,
        3,
        4,
    );
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.savedFile, null);
    assert.strictEqual(result.outputPath, null);
    assert.strictEqual(result.error, 'rate-limited');
});

test('emits final 100% progress with jobResult to onProgress callback', async () => {
    stubVideoSuccess();
    const events = [];
    const onProg = (prompt, progress, result) => {
        events.push({ prompt, progress, hasResult: !!result });
    };
    await VideoService._processOneBatchItem(
        'progress-test',
        { accIdx: 0 },
        {},
        onProg,
        0, 1, 1,
    );
    // Expect at least one mid-progress (progress=50, no result) and a
    // final emission (progress=100, with result).
    const final = events.filter(e => e.progress === 100 && e.hasResult);
    assert.strictEqual(final.length, 1);
    const mid = events.filter(e => e.progress < 100 && !e.hasResult);
    assert.ok(mid.length >= 1, 'expected at least one mid-progress emission');
});

test('respects custom outputFolder param over config.outputFolder', async () => {
    stubVideoSuccess();
    const result = await VideoService._processOneBatchItem(
        'custom-folder-test',
        { accIdx: 0 },
        { outputFolder: '/tmp/from-config' },
        null,
        0, 1, 1,
        '/tmp/explicit-arg',
    );
    assert.ok(result.savedFile.startsWith('/tmp/explicit-arg'),
        `expected savedFile under /tmp/explicit-arg, got: ${result.savedFile}`);
});

test('uses globalNum (not localIdx) for shot####_ filename', async () => {
    stubVideoSuccess();
    const result = await VideoService._processOneBatchItem(
        'numbering-test',
        { accIdx: 0 },
        { outputFolder: '/tmp/n' },
        null,
        0,         // localIdx = 0
        42,        // globalNum = 42
        100,
    );
    // Filename should embed shot0042 (4-digit pad of globalNum=42),
    // not shot0001 from localIdx+1.
    assert.match(result.savedFile, /shot0042_/);
});

test('strips emoji + special chars from title in filename slug', async () => {
    VideoService.generateOne = async () => ({
        videoUrl: 'https://example.test/v.mp4',
        videoId: 'vid_999',
        title: '🎬 Ngày đẹp trời! @#$%',
        error: null,
    });
    VideoService.downloadVideoToFile = async (_, __, fp) => ({ path: fp });
    const result = await VideoService._processOneBatchItem(
        'p',
        { accIdx: 0 },
        { outputFolder: '/tmp/n' },
        null, 0, 1, 1,
    );
    // Vietnamese chars + spaces are kept (turned into underscores);
    // emoji + other punctuation stripped.
    assert.ok(!/[🎬@#$%!]/.test(result.savedFile), `expected no emoji/punct, got: ${result.savedFile}`);
    assert.ok(result.savedFile.includes('Ngày_đẹp_trời'),
        `expected Vietnamese chars preserved, got: ${result.savedFile}`);
});

// ─── runner ───────────────────────────────────────────────────────

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
