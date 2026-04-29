/**
 * Offline regression test for StoryboardBridge.generateImages.
 *
 * Verifies the PR-9 fix: the bridge now feeds `image:generate` IPC the
 * correct shape:
 *
 *   { prompts: string[], config: { imageGenerationCount, ... }, account }
 *
 * Previously it sent `{ prompts: object[], count, account }` which the
 * `image:generate` handler in main.js ignored (it destructures `config`,
 * not `count`) and which crashed `ImageService.generateBatch` when it
 * tried `prompt.substring(...)` on an object.
 *
 * Run:
 *   node desktop/tests/test_storyboard_bridge.js
 */

'use strict';

const assert = require('assert');
const StoryboardBridge = require('../src/bridges/StoryboardBridge');

function fakeAPI() {
    const calls = [];
    const api = {
        storyboard: {
            fromScript: () => null,
            thumbnail: () => null,
        },
        image: {
            generate: (params) => {
                calls.push(params);
                return Promise.resolve({ ok: true });
            },
        },
        i2v: { generate: () => null },
        refimg: { generate: () => null },
    };
    return { api, calls };
}

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

console.log('# StoryboardBridge.generateImages');

test('forwards string prompts (one per scene), not raw scene objects', async () => {
    const { api, calls } = fakeAPI();
    const bridge = new StoryboardBridge(api);
    await bridge.generateImages({
        scenes: [
            { scene_id: 's1', image_prompt: 'a cat in a hat' },
            { scene_id: 's2', image_prompt: 'a dog on a log' },
        ],
    });
    assert.strictEqual(calls.length, 1);
    const params = calls[0];
    assert.deepStrictEqual(params.prompts, ['a cat in a hat', 'a dog on a log']);
    assert.ok(params.prompts.every((p) => typeof p === 'string'));
});

test('passes count_per_scene as config.imageGenerationCount (was dropped before)', async () => {
    const { api, calls } = fakeAPI();
    const bridge = new StoryboardBridge(api);
    await bridge.generateImages({
        scenes: [{ scene_id: 's1', image_prompt: 'a sunset' }],
        count_per_scene: 4,
    });
    assert.strictEqual(calls[0].config.imageGenerationCount, 4);
    // Sanity: top-level `count` is not part of the IPC contract.
    assert.strictEqual(calls[0].count, undefined);
});

test('default count_per_scene is 4', async () => {
    const { api, calls } = fakeAPI();
    const bridge = new StoryboardBridge(api);
    await bridge.generateImages({
        scenes: [{ scene_id: 's1', image_prompt: 'a sunset' }],
    });
    assert.strictEqual(calls[0].config.imageGenerationCount, 4);
});

test('skips scenes with empty/missing image_prompt instead of crashing', async () => {
    const { api, calls } = fakeAPI();
    const bridge = new StoryboardBridge(api);
    await bridge.generateImages({
        scenes: [
            { scene_id: 's1', image_prompt: 'a sunset' },
            { scene_id: 's2', image_prompt: '   ' }, // whitespace-only
            { scene_id: 's3' },                       // missing
            { scene_id: 's4', image_prompt: 'a forest' },
        ],
    });
    assert.deepStrictEqual(calls[0].prompts, ['a sunset', 'a forest']);
});

test('aspectRatio and enablePro pass through to config when provided', async () => {
    const { api, calls } = fakeAPI();
    const bridge = new StoryboardBridge(api);
    await bridge.generateImages({
        scenes: [{ scene_id: 's1', image_prompt: 'a sunset' }],
        aspectRatio: '16:9',
        enablePro: true,
    });
    assert.strictEqual(calls[0].config.aspectRatio, '16:9');
    assert.strictEqual(calls[0].config.enablePro, true);
});

console.log('');
console.log(`# results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
