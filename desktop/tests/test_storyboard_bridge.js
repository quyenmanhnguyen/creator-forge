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

function fakeAPI(opts = {}) {
    const calls = { image: [], compose: [] };
    const imageReturn = opts.imageReturn || (() => Promise.resolve({ ok: true }));
    const composeReturn = opts.composeReturn || (() => Promise.resolve({
        mp4_path: '/tmp/short.mp4',
        scenes_used: 0,
        scenes_missing: 0,
        warnings: [],
    }));
    const api = {
        storyboard: {
            fromScript: () => null,
            thumbnail: () => null,
        },
        image: {
            generate: (params) => {
                calls.image.push(params);
                return Promise.resolve(imageReturn(params));
            },
        },
        producer: {
            composeShort: (params) => {
                calls.compose.push(params);
                return Promise.resolve(composeReturn(params));
            },
        },
        i2v: { generate: () => null },
        refimg: { generate: () => null },
    };
    return { api, calls };
}

let passed = 0;
let failed = 0;
let pending = 0;
function test(name, fn) {
    pending++;
    Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`  ok  ${name}`);
            passed++;
        })
        .catch((err) => {
            console.error(`  FAIL ${name}`);
            console.error('       ' + (err && err.stack ? err.stack : err));
            failed++;
        })
        .finally(() => {
            pending--;
            if (pending === 0) {
                console.log('');
                console.log(`# results: ${passed} passed, ${failed} failed`);
                if (failed > 0) process.exit(1);
            }
        });
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
    assert.strictEqual(calls.image.length, 1);
    const params = calls.image[0];
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
    assert.strictEqual(calls.image[0].config.imageGenerationCount, 4);
    // Sanity: top-level `count` is not part of the IPC contract.
    assert.strictEqual(calls.image[0].count, undefined);
});

test('default count_per_scene is 4', async () => {
    const { api, calls } = fakeAPI();
    const bridge = new StoryboardBridge(api);
    await bridge.generateImages({
        scenes: [{ scene_id: 's1', image_prompt: 'a sunset' }],
    });
    assert.strictEqual(calls.image[0].config.imageGenerationCount, 4);
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
    assert.deepStrictEqual(calls.image[0].prompts, ['a sunset', 'a forest']);
});

test('aspectRatio and enablePro pass through to config when provided', async () => {
    const { api, calls } = fakeAPI();
    const bridge = new StoryboardBridge(api);
    await bridge.generateImages({
        scenes: [{ scene_id: 's1', image_prompt: 'a sunset' }],
        aspectRatio: '16:9',
        enablePro: true,
    });
    assert.strictEqual(calls.image[0].config.aspectRatio, '16:9');
    assert.strictEqual(calls.image[0].config.enablePro, true);
});

// ─── composeWithScenes (PR-14) ─────────────────────────────────────────
console.log('');
console.log('# StoryboardBridge.composeWithScenes');

/**
 * Build a synthetic image:generate response shaped like main.js's IPC handler:
 *   { success, results: [{ globalIdx, savedFiles, success }, ...] }
 * Each entry corresponds to one prompt (since composeWithScenes forces
 * imageGenerationCount=1, savedFiles has 0 or 1 entries).
 */
function synthImageReturn(perPromptFiles) {
    return () => ({
        success: true,
        results: perPromptFiles.map((files, idx) => ({
            globalIdx: idx,
            success: files.length > 0,
            savedFiles: files,
        })),
    });
}

test('composeWithScenes: happy path picks one ≥50KB file per scene + cumulative start_s', async () => {
    const { api, calls } = fakeAPI({
        imageReturn: synthImageReturn([
            ['/img/a_blur.jpg', '/img/a_full.jpg'], // first <50KB, second ≥50KB
            ['/img/b_full.jpg'],                    // single ≥50KB
        ]),
    });
    const bridge = new StoryboardBridge(api);
    const sizeMap = {
        '/img/a_blur.jpg': 1024,         // < 50KB → skipped
        '/img/a_full.jpg': 120 * 1024,   // ≥ 50KB → chosen
        '/img/b_full.jpg': 80 * 1024,    // ≥ 50KB → chosen
    };

    const out = await bridge.composeWithScenes({
        script: 'Hello world.',
        scenes: [
            { scene_id: 1, image_prompt: 'scene A', duration_s: 3 },
            { scene_id: 2, image_prompt: 'scene B', duration_s: 4 },
        ],
    }, { stat: (p) => ({ size: sizeMap[p] || 0 }) });

    // image:generate forced imageGenerationCount=1
    assert.strictEqual(calls.image.length, 1);
    assert.strictEqual(calls.image[0].config.imageGenerationCount, 1);
    assert.deepStrictEqual(calls.image[0].prompts, ['scene A', 'scene B']);

    // composeShort got one scene_assets per scene with cumulative start_s
    assert.strictEqual(calls.compose.length, 1);
    const composePayload = calls.compose[0];
    assert.strictEqual(composePayload.script, 'Hello world.');
    assert.deepStrictEqual(composePayload.scene_assets, [
        { image_path: '/img/a_full.jpg', start_s: 0,   duration_s: 3 },
        { image_path: '/img/b_full.jpg', start_s: 3,   duration_s: 4 },
    ]);

    assert.strictEqual(out.sceneAssets.length, 2);
    assert.strictEqual(out.skippedScenes.length, 0);
});

test('composeWithScenes: scene with all <50KB files is skipped + reported', async () => {
    const { api, calls } = fakeAPI({
        imageReturn: synthImageReturn([
            ['/img/blur1.jpg', '/img/blur2.jpg'], // both blurs
            ['/img/ok.jpg'],
        ]),
    });
    const bridge = new StoryboardBridge(api);
    const sizeMap = {
        '/img/blur1.jpg': 4096,
        '/img/blur2.jpg': 8192,
        '/img/ok.jpg':    100 * 1024,
    };

    const out = await bridge.composeWithScenes({
        script: 'Hi.',
        scenes: [
            { scene_id: 1, image_prompt: 'A', duration_s: 2 },
            { scene_id: 2, image_prompt: 'B', duration_s: 5 },
        ],
    }, { stat: (p) => ({ size: sizeMap[p] || 0 }) });

    // Only the second scene survives. Its start_s reflects scene 1's
    // duration even though scene 1 was dropped (audio timeline doesn't
    // care that we have no image for the first chunk — gradient gap there).
    assert.deepStrictEqual(calls.compose[0].scene_assets, [
        { image_path: '/img/ok.jpg', start_s: 2, duration_s: 5 },
    ]);
    assert.strictEqual(out.skippedScenes.length, 1);
    assert.strictEqual(out.skippedScenes[0].scene_id, 1);
    assert.match(out.skippedScenes[0].reason, /50000 bytes/);
});

test('composeWithScenes: scene missing image_prompt or duration is excluded from image:generate', async () => {
    const { api, calls } = fakeAPI({
        imageReturn: synthImageReturn([['/img/c.jpg']]),
    });
    const bridge = new StoryboardBridge(api);

    const out = await bridge.composeWithScenes({
        script: 'Hi.',
        scenes: [
            { scene_id: 1, image_prompt: '   ', duration_s: 2 },     // empty prompt
            { scene_id: 2, image_prompt: 'C', duration_s: 0 },        // bad duration
            { scene_id: 3, image_prompt: 'C', duration_s: 4 },        // ok
        ],
    }, { stat: () => ({ size: 200 * 1024 }) });

    // Only one prompt should reach image:generate.
    assert.deepStrictEqual(calls.image[0].prompts, ['C']);
    assert.strictEqual(out.skippedScenes.length, 2);
    // Scene 3 starts at the cumulative offset of scene 1 (scene 2's invalid
    // duration doesn't advance the cursor).
    assert.deepStrictEqual(calls.compose[0].scene_assets, [
        { image_path: '/img/c.jpg', start_s: 2, duration_s: 4 },
    ]);
});

test('composeWithScenes: passes voice/style/output_dir/write_srt + script through to composeShort', async () => {
    const { api, calls } = fakeAPI({
        imageReturn: synthImageReturn([['/img/x.jpg']]),
    });
    const bridge = new StoryboardBridge(api);

    await bridge.composeWithScenes({
        script: 'Body text.',
        scenes: [{ scene_id: 1, image_prompt: 'X', duration_s: 1 }],
        voice: 'en-US-AriaNeural',
        style: 'sunset',
        output_dir: '/tmp/out',
        write_srt: false,
    }, { stat: () => ({ size: 80000 }) });

    const payload = calls.compose[0];
    assert.strictEqual(payload.voice, 'en-US-AriaNeural');
    assert.strictEqual(payload.style, 'sunset');
    assert.strictEqual(payload.output_dir, '/tmp/out');
    assert.strictEqual(payload.write_srt, false);
});

test('composeWithScenes: throws if electronAPI.producer.composeShort is missing', async () => {
    const { api } = fakeAPI();
    delete api.producer;
    const bridge = new StoryboardBridge(api);
    await assert.rejects(
        () => bridge.composeWithScenes({
            script: 'Hi.',
            scenes: [{ scene_id: 1, image_prompt: 'X', duration_s: 1 }],
        }),
        /producer\.composeShort is unavailable/,
    );
});

test('composeWithScenes: throws on missing/whitespace script', async () => {
    const { api } = fakeAPI();
    const bridge = new StoryboardBridge(api);
    await assert.rejects(
        () => bridge.composeWithScenes({ script: '   ', scenes: [] }),
        /script is required/,
    );
});

// ─── PR-17: scene-level retry + allow_partial ──────────────────────────
//
// `imageGenerateFn` is invoked once per attempt. Tests below stub it with
// a stateful function that varies its response between attempts to model
// a transient Grok failure (e.g. moderation hit on the first try, success
// on the second).

/** Build a stateful image:generate stub from a list of per-attempt responses. */
function scriptedImageReturn(attempts) {
    let n = 0;
    return () => {
        const slot = attempts[Math.min(n, attempts.length - 1)];
        n++;
        return slot;
    };
}

test('composeWithScenes: first attempt fails for one scene, retry succeeds → status=retried', async () => {
    const { api, calls } = fakeAPI({
        imageReturn: scriptedImageReturn([
            // Attempt 1: 2 prompts → scene A blur (<50KB), scene B ok.
            {
                success: true,
                results: [
                    { globalIdx: 0, savedFiles: ['/img/a_blur.jpg'], success: true },
                    { globalIdx: 1, savedFiles: ['/img/b_ok.jpg'],   success: true },
                ],
            },
            // Attempt 2: orchestrator should resend ONLY scene A's prompt.
            // globalIdx=0 here is the retry slot for scene A.
            {
                success: true,
                results: [
                    { globalIdx: 0, savedFiles: ['/img/a_retry_ok.jpg'], success: true },
                ],
            },
        ]),
    });
    const bridge = new StoryboardBridge(api);
    const sizeMap = {
        '/img/a_blur.jpg':       1024,         // < 50KB → reject
        '/img/b_ok.jpg':         80 * 1024,
        '/img/a_retry_ok.jpg':   120 * 1024,
    };

    const out = await bridge.composeWithScenes({
        script: 'Hi.',
        scenes: [
            { scene_id: 1, image_prompt: 'A', duration_s: 3 },
            { scene_id: 2, image_prompt: 'B', duration_s: 4 },
        ],
        max_attempts: 2,
    }, { stat: (p) => ({ size: sizeMap[p] || 0 }) });

    assert.strictEqual(calls.image.length, 2, 'image:generate must be called twice (1 bulk + 1 retry)');
    assert.deepStrictEqual(calls.image[0].prompts, ['A', 'B']);
    assert.deepStrictEqual(calls.image[1].prompts, ['A'], 'retry must only re-send the failing scene');

    assert.deepStrictEqual(calls.compose[0].scene_assets, [
        { image_path: '/img/a_retry_ok.jpg', start_s: 0, duration_s: 3 },
        { image_path: '/img/b_ok.jpg',       start_s: 3, duration_s: 4 },
    ]);
    assert.strictEqual(out.retryCount, 1, '1 scene was retried');
    assert.strictEqual(out.maxAttempts, 2);

    const statuses = out.perSceneStatus.map((s) => [s.scene_id, s.status, s.attempts]);
    assert.deepStrictEqual(statuses, [
        [1, 'retried',   2],
        [2, 'generated', 1],
    ]);
});

test('composeWithScenes: all attempts fail for one scene → status=fallback, allow_partial=true (default) still composes', async () => {
    const { api, calls } = fakeAPI({
        imageReturn: scriptedImageReturn([
            // Bulk: scene A blur, scene B ok.
            { success: true, results: [
                { globalIdx: 0, savedFiles: ['/img/a_blur1.jpg'], success: true },
                { globalIdx: 1, savedFiles: ['/img/b_ok.jpg'],    success: true },
            ]},
            // Retry: scene A blur again.
            { success: true, results: [
                { globalIdx: 0, savedFiles: ['/img/a_blur2.jpg'], success: true },
            ]},
            // 3rd attempt: still blur.
            { success: true, results: [
                { globalIdx: 0, savedFiles: ['/img/a_blur3.jpg'], success: true },
            ]},
        ]),
    });
    const bridge = new StoryboardBridge(api);
    const sizeMap = {
        '/img/a_blur1.jpg': 1024,
        '/img/a_blur2.jpg': 2048,
        '/img/a_blur3.jpg': 3072,
        '/img/b_ok.jpg':    80 * 1024,
    };

    const out = await bridge.composeWithScenes({
        script: 'Hi.',
        scenes: [
            { scene_id: 1, image_prompt: 'A', duration_s: 3 },
            { scene_id: 2, image_prompt: 'B', duration_s: 4 },
        ],
        max_attempts: 3,
    }, { stat: (p) => ({ size: sizeMap[p] || 0 }) });

    assert.strictEqual(calls.image.length, 3, '1 bulk + 2 retries');
    // Compose still happens — scene 1 falls back to gradient, scene 2 covered.
    assert.deepStrictEqual(calls.compose[0].scene_assets, [
        { image_path: '/img/b_ok.jpg', start_s: 3, duration_s: 4 },
    ]);
    assert.strictEqual(out.retryCount, 2);
    const statuses = out.perSceneStatus.map((s) => [s.scene_id, s.status, s.attempts]);
    assert.deepStrictEqual(statuses, [
        [1, 'fallback',  3],
        [2, 'generated', 1],
    ]);
    // Warnings should mention the fallback scene + retry count.
    assert.ok(out.warnings.some((w) => /scene\(s\) fell back to gradient/.test(w)), 'fallback warning');
    assert.ok(out.warnings.some((w) => /Issued 2 retry attempt/.test(w)),            'retry warning');
});

test('composeWithScenes: allow_partial=false throws INCOMPLETE_BATCH instead of composing', async () => {
    const { api, calls } = fakeAPI({
        imageReturn: scriptedImageReturn([
            // Bulk: scene A blur, scene B ok.
            { success: true, results: [
                { globalIdx: 0, savedFiles: ['/img/a_blur.jpg'], success: true },
                { globalIdx: 1, savedFiles: ['/img/b_ok.jpg'],   success: true },
            ]},
            // Retry: still blur.
            { success: true, results: [
                { globalIdx: 0, savedFiles: ['/img/a_blur.jpg'], success: true },
            ]},
        ]),
    });
    const bridge = new StoryboardBridge(api);
    const sizeMap = { '/img/a_blur.jpg': 1024, '/img/b_ok.jpg': 80 * 1024 };

    let thrown = null;
    try {
        await bridge.composeWithScenes({
            script: 'Hi.',
            scenes: [
                { scene_id: 1, image_prompt: 'A', duration_s: 3 },
                { scene_id: 2, image_prompt: 'B', duration_s: 4 },
            ],
            max_attempts: 2,
            allow_partial: false,
        }, { stat: (p) => ({ size: sizeMap[p] || 0 }) });
    } catch (err) {
        thrown = err;
    }

    assert.ok(thrown, 'expected throw');
    assert.strictEqual(thrown.code, 'INCOMPLETE_BATCH');
    assert.match(thrown.message, /1 scene\(s\) missing/);
    // Compose must NOT have been called when allow_partial=false.
    assert.strictEqual(calls.compose.length, 0, 'composeShort must not be invoked when batch is incomplete and allow_partial=false');
    // Diagnostic info on the error.
    assert.strictEqual(thrown.retryCount, 1);
    assert.ok(Array.isArray(thrown.perSceneStatus));
    assert.strictEqual(thrown.perSceneStatus.find((s) => s.scene_id === 1).status, 'fallback');
});

test('composeWithScenes: max_attempts=1 disables retry entirely', async () => {
    const { api, calls } = fakeAPI({
        imageReturn: scriptedImageReturn([
            { success: true, results: [
                { globalIdx: 0, savedFiles: ['/img/a_blur.jpg'], success: true },
            ]},
        ]),
    });
    const bridge = new StoryboardBridge(api);

    const out = await bridge.composeWithScenes({
        script: 'Hi.',
        scenes: [{ scene_id: 1, image_prompt: 'A', duration_s: 3 }],
        max_attempts: 1,
    }, { stat: () => ({ size: 1024 }) });

    assert.strictEqual(calls.image.length, 1, 'no retry when max_attempts=1');
    assert.strictEqual(out.retryCount, 0);
    assert.strictEqual(out.perSceneStatus[0].status, 'fallback');
    assert.strictEqual(out.perSceneStatus[0].attempts, 1);
});

test('composeWithScenes: image:generate IPC throwing on first attempt is caught + retried', async () => {
    const calls = { image: [], compose: [] };
    let n = 0;
    const api = {
        storyboard: { fromScript: () => null, thumbnail: () => null },
        image: {
            generate: async (params) => {
                calls.image.push(params);
                n++;
                if (n === 1) throw new Error('socket hangup');
                return {
                    success: true,
                    results: [
                        { globalIdx: 0, savedFiles: ['/img/recovered.jpg'], success: true },
                    ],
                };
            },
        },
        producer: {
            composeShort: async (params) => {
                calls.compose.push(params);
                return { mp4_path: '/tmp/x.mp4', scenes_used: 1, scenes_missing: 0, warnings: [] };
            },
        },
        i2v: { generate: () => null },
        refimg: { generate: () => null },
    };
    const bridge = new StoryboardBridge(api);

    const out = await bridge.composeWithScenes({
        script: 'Hi.',
        scenes: [{ scene_id: 1, image_prompt: 'A', duration_s: 3 }],
        max_attempts: 2,
    }, { stat: () => ({ size: 80 * 1024 }) });

    assert.strictEqual(calls.image.length, 2, 'thrown attempt counts as one — orchestrator retries');
    assert.strictEqual(out.perSceneStatus[0].status, 'retried');
    assert.strictEqual(out.sceneAssets.length, 1);
});

