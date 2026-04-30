/**
 * Offline regression tests for ImageService / RefImageService request-body
 * builders.
 *
 * These tests exist because PR-9 fixed two AutoGrok generation bugs:
 *
 *   1. Default `enable_pro: true` made the Imagine WS server return ONE
 *      Pro image and ignore `enable_side_by_side`, even when the caller
 *      asked for 4. After fix, `enable_pro` defaults to `false`.
 *
 *   2. When `enablePro: true` is opted in, the request count must be
 *      capped at 1 to match server behavior (Pro returns a single image).
 *
 * The tests are deliberately offline: they avoid spawning a browser, hitting
 * the network, or requiring an authenticated session. They do NOT install
 * puppeteer (CI's desktop-node job does not `npm install` desktop deps).
 *
 * To accomplish that, we patch `Module._load` to stub the modules that
 * `ImageService` -> `AuthService` -> `browser.js` would otherwise pull in
 * at require time.
 *
 * Run:
 *   node desktop/tests/test_image_service_config.js
 */

'use strict';

const Module = require('module');
const path = require('path');
const assert = require('assert');

// ---- Stub modules that the desktop services load at require time ---------
// `browser.js` does `require('puppeteer-extra')` and
// `require('puppeteer-extra-plugin-stealth')`, neither of which is installed
// in CI. AuthService also pulls in browser.js. We short-circuit those loads
// so the test can exercise the *pure* body-builder logic.
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
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
        // Body-builder code paths never call axios — return a no-op stub
        // so module-level `require('axios')` succeeds without `npm install`.
        const noop = () => {};
        const stub = noop;
        stub.get = stub.post = stub.put = stub.delete = stub.request = async () => ({ status: 0, data: '' });
        stub.create = () => stub;
        stub.defaults = { headers: {} };
        return stub;
    }
    return _origLoad.call(this, request, parent, isMain);
};

const ImageService = require('../src/services/ImageService');
const RefImageService = require('../src/services/RefImageService');
const { IMAGE_CONFIG } = require('../src/config/app.config');

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL ${name}`);
        console.error('       ' + (err && err.message ? err.message : err));
        failed++;
    }
}

console.log('# ImageService.buildBody (chat-stream fallback)');

test('default config: enablePro is false (PR-9: Pro is opt-in)', () => {
    const body = ImageService.buildBody('a sunset', {});
    assert.strictEqual(body.enablePro, false,
        'Default enablePro must be false. When true, Grok Imagine returns ' +
        'a single Pro image and ignores enable_side_by_side, breaking the ' +
        '4-image batch flow.');
});

test('default config: imageGenerationCount falls through to IMAGE_CONFIG (4)', () => {
    const body = ImageService.buildBody('a sunset', {});
    assert.strictEqual(body.imageGenerationCount, IMAGE_CONFIG.imageGenerationCount);
    assert.strictEqual(body.imageGenerationCount, 4);
});

test('explicit imageGenerationCount: 4 honored when Pro is off', () => {
    const body = ImageService.buildBody('a sunset', { imageGenerationCount: 4 });
    assert.strictEqual(body.imageGenerationCount, 4);
    assert.strictEqual(body.enablePro, false);
});

test('explicit enablePro: true forces imageGenerationCount to 1', () => {
    const body = ImageService.buildBody('a sunset', {
        enablePro: true,
        imageGenerationCount: 4,
    });
    assert.strictEqual(body.enablePro, true);
    assert.strictEqual(body.imageGenerationCount, 1,
        'Pro mode must cap count at 1 to match server behavior.');
});

test('legacy `count` alias is honored', () => {
    const body = ImageService.buildBody('a sunset', { count: 2 });
    assert.strictEqual(body.imageGenerationCount, 2);
});

test('aspectRatio defaults to 1:1 and is appended to the message', () => {
    const body = ImageService.buildBody('a sunset', {});
    assert.ok(body.message.endsWith('--ar 1:1'),
        `Expected message to end with --ar 1:1, got: ${body.message}`);
});

test('aspectRatio override propagates', () => {
    const body = ImageService.buildBody('a sunset', { aspectRatio: '16:9' });
    assert.ok(body.message.endsWith('--ar 16:9'));
});

test('enableNsfw default is true; explicit false respected', () => {
    assert.strictEqual(ImageService.buildBody('p', {}).enableNsfw, true);
    assert.strictEqual(ImageService.buildBody('p', { enableNsfw: false }).enableNsfw, false);
});

console.log('# ImageService.buildApiBody (official API path)');

test('default API body: n falls through to IMAGE_CONFIG (4)', () => {
    const body = ImageService.buildApiBody('a sunset', {});
    assert.strictEqual(body.n, 4);
});

test('Pro mode caps API n at 1 too', () => {
    const body = ImageService.buildApiBody('a sunset', {
        enablePro: true,
        imageGenerationCount: 4,
    });
    assert.strictEqual(body.n, 1);
});

console.log('# RefImageService.buildRefImageBody (image-edit / ref flow)');

test('default ref body: enablePro is false', () => {
    const body = RefImageService.buildRefImageBody('p', ['ref1.jpg'], 'post-1', {});
    assert.strictEqual(body.enablePro, false);
});

test('default ref body: imageGenerationCount is 4', () => {
    const body = RefImageService.buildRefImageBody('p', ['ref1.jpg'], 'post-1', {});
    assert.strictEqual(body.imageGenerationCount, 4);
});

test('ref body Pro mode caps imageGenerationCount at 1', () => {
    const body = RefImageService.buildRefImageBody('p', ['ref1.jpg'], 'post-1', {
        enablePro: true,
        imageGenerationCount: 4,
    });
    assert.strictEqual(body.imageGenerationCount, 1);
});

console.log('');
console.log(`# results: ${passed} passed, ${failed} failed`);

Module._load = _origLoad;

if (failed > 0) {
    process.exit(1);
}
