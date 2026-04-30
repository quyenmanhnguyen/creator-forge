/**
 * Offline regression test for `desktop/dist/storyboard_compose_helpers.js`.
 *
 * The helpers power the renderer-side "Compose with AutoGrok" panel
 * (PR-16). They must agree with `StoryboardBridge.composeWithScenes`
 * (which is already covered by `test_storyboard_bridge.js`) on:
 *   - prompt planning + skip reasons
 *   - savedFiles grouping by globalIdx / localIdx
 *   - first-≥50KB picking with a stub stat-bytes function
 *   - cumulative start_s on the audio timeline
 *
 * Run:
 *   node desktop/tests/test_storyboard_compose_helpers.js
 */

"use strict";

const assert = require("assert");

const helpers = require("../dist/storyboard_compose_helpers.js");

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
    const p = Promise.resolve()
        .then(fn)
        .then(() => { console.log(`  ok  ${name}`); passed++; })
        .catch((err) => {
            console.error(`  FAIL ${name}`);
            console.error("       " + (err && err.stack ? err.stack : err));
            failed++;
        });
    pending.push(p);
}

async function run() {
    // ── planPromptsFromScenes ─────────────────────────────────────────────

    test("planPromptsFromScenes: trims + drops missing prompt", () => {
        const scenes = [
            { scene_id: 1, image_prompt: "  hero shot ", duration_s: 4 },
            { scene_id: 2, image_prompt: "", duration_s: 4 },
            { scene_id: 3, image_prompt: "act 3", duration_s: 0 },
            { scene_id: 4, image_prompt: "act 4", duration_s: 5 },
        ];
        const out = helpers.planPromptsFromScenes(scenes);
        assert.deepStrictEqual(out.prompts, ["hero shot", "act 4"]);
        assert.deepStrictEqual(out.indexMap, [0, 3]);
        assert.deepStrictEqual(out.skipped, [
            { scene_id: 2, reason: "missing image_prompt" },
            { scene_id: 3, reason: "invalid duration_s" },
        ]);
    });

    test("planPromptsFromScenes: empty / non-array input", () => {
        const a = helpers.planPromptsFromScenes(null);
        assert.deepStrictEqual(a.prompts, []);
        assert.deepStrictEqual(a.indexMap, []);
        assert.deepStrictEqual(a.skipped, []);
    });

    // ── groupSavedFilesByPromptIndex ──────────────────────────────────────

    test("groupSavedFilesByPromptIndex: groups by globalIdx, ignores out-of-range", () => {
        const resp = {
            success: true,
            results: [
                { globalIdx: 0, savedFiles: ["/o/a1.jpg", "/o/a2.jpg"] },
                { globalIdx: 1, savedFiles: ["/o/b1.jpg"] },
                { globalIdx: 2, savedFiles: ["/o/c1.jpg"] },
                { globalIdx: 9, savedFiles: ["/o/oob.jpg"] },        // out-of-range
                { globalIdx: -1, savedFiles: ["/o/neg.jpg"] },       // negative
            ],
        };
        const map = helpers.groupSavedFilesByPromptIndex(resp, 3);
        assert.deepStrictEqual(map.get(0), ["/o/a1.jpg", "/o/a2.jpg"]);
        assert.deepStrictEqual(map.get(1), ["/o/b1.jpg"]);
        assert.deepStrictEqual(map.get(2), ["/o/c1.jpg"]);
        assert.strictEqual(map.has(9), false);
    });

    test("groupSavedFilesByPromptIndex: falls back to localIdx when globalIdx absent", () => {
        const resp = {
            success: true,
            results: [
                { localIdx: 0, savedFiles: ["/o/a.jpg"] },
                { localIdx: 1, savedFiles: ["/o/b.jpg"] },
            ],
        };
        const map = helpers.groupSavedFilesByPromptIndex(resp, 2);
        assert.deepStrictEqual(map.get(0), ["/o/a.jpg"]);
        assert.deepStrictEqual(map.get(1), ["/o/b.jpg"]);
    });

    test("groupSavedFilesByPromptIndex: empty / malformed response → empty map", () => {
        assert.strictEqual(helpers.groupSavedFilesByPromptIndex(null, 3).size, 0);
        assert.strictEqual(helpers.groupSavedFilesByPromptIndex({}, 3).size, 0);
        assert.strictEqual(helpers.groupSavedFilesByPromptIndex({ results: "nope" }, 3).size, 0);
    });

    // ── pickFirstUsableSavedFile ──────────────────────────────────────────

    test("pickFirstUsableSavedFile: returns first ≥50KB file, skipping smaller ones", async () => {
        const stat = async (p) => ({
            "/o/a.jpg": { exists: true, size: 10_000 },
            "/o/b.jpg": { exists: true, size: 60_000 },
            "/o/c.jpg": { exists: true, size: 80_000 },
        }[p] || { exists: false, size: 0 });
        const out = await helpers.pickFirstUsableSavedFile(["/o/a.jpg", "/o/b.jpg", "/o/c.jpg"], stat);
        assert.strictEqual(out.chosen.filePath, "/o/b.jpg");
        assert.strictEqual(out.chosen.bytes, 60_000);
        assert.strictEqual(out.candidates, 3);
        assert.strictEqual(out.reason, null);
    });

    test("pickFirstUsableSavedFile: empty list returns reason", async () => {
        const out = await helpers.pickFirstUsableSavedFile([], async () => ({ exists: false, size: 0 }));
        assert.strictEqual(out.chosen, null);
        assert.strictEqual(out.candidates, 0);
        assert.match(out.reason, /no files/);
    });

    test("pickFirstUsableSavedFile: all <50KB → reason mentions blur threshold", async () => {
        const stat = async () => ({ exists: true, size: 5000 });
        const out = await helpers.pickFirstUsableSavedFile(["/o/x.jpg"], stat);
        assert.strictEqual(out.chosen, null);
        assert.match(out.reason, /50000 bytes/);
    });

    test("pickFirstUsableSavedFile: stat throws → treated as 0 bytes (skipped)", async () => {
        const stat = async () => { throw new Error("ENOENT"); };
        const out = await helpers.pickFirstUsableSavedFile(["/o/x.jpg"], stat);
        assert.strictEqual(out.chosen, null);
    });

    test("pickFirstUsableSavedFile: custom minBytes override", async () => {
        const stat = async () => ({ exists: true, size: 30_000 });
        const out = await helpers.pickFirstUsableSavedFile(["/o/x.jpg"], stat, { minBytes: 10_000 });
        assert.strictEqual(out.chosen.filePath, "/o/x.jpg");
    });

    // ── buildSceneAssetsFromImageBatch ────────────────────────────────────

    test("buildSceneAssetsFromImageBatch: happy path mirrors StoryboardBridge", async () => {
        const scenes = [
            { scene_id: 1, image_prompt: "shot a", duration_s: 4 },
            { scene_id: 2, image_prompt: "shot b", duration_s: 5 },
            { scene_id: 3, image_prompt: "shot c", duration_s: 6 },
        ];
        const imageGenerate = {
            success: true,
            results: [
                { globalIdx: 0, savedFiles: ["/o/a.jpg"] },
                { globalIdx: 1, savedFiles: ["/o/b.jpg"] },
                { globalIdx: 2, savedFiles: ["/o/c.jpg"] },
            ],
        };
        const stat = async () => ({ exists: true, size: 200_000 });
        const { sceneAssets, skipped } = await helpers.buildSceneAssetsFromImageBatch(scenes, imageGenerate, stat);
        assert.deepStrictEqual(sceneAssets, [
            { image_path: "/o/a.jpg", start_s: 0, duration_s: 4, scene_id: 1 },
            { image_path: "/o/b.jpg", start_s: 4, duration_s: 5, scene_id: 2 },
            { image_path: "/o/c.jpg", start_s: 9, duration_s: 6, scene_id: 3 },
        ]);
        assert.deepStrictEqual(skipped, []);
    });

    test("buildSceneAssetsFromImageBatch: scene whose images are all <50KB is reported as skipped + cursor advances", async () => {
        const scenes = [
            { scene_id: 1, image_prompt: "ok", duration_s: 4 },
            { scene_id: 2, image_prompt: "blur", duration_s: 5 },
            { scene_id: 3, image_prompt: "ok2", duration_s: 6 },
        ];
        const imageGenerate = {
            success: true,
            results: [
                { globalIdx: 0, savedFiles: ["/o/a.jpg"] },
                { globalIdx: 1, savedFiles: ["/o/blur.jpg"] },
                { globalIdx: 2, savedFiles: ["/o/c.jpg"] },
            ],
        };
        const sizes = {
            "/o/a.jpg": 200_000,
            "/o/blur.jpg": 8_000,
            "/o/c.jpg": 200_000,
        };
        const stat = async (p) => ({ exists: true, size: sizes[p] || 0 });
        const { sceneAssets, skipped } = await helpers.buildSceneAssetsFromImageBatch(scenes, imageGenerate, stat);

        // Scene 2 is skipped, but scene 3's start_s must still be 9 (4+5)
        // because scene 2's audio window still consumes 5 seconds — the
        // composer renders gradient over that window.
        assert.deepStrictEqual(sceneAssets, [
            { image_path: "/o/a.jpg", start_s: 0, duration_s: 4, scene_id: 1 },
            { image_path: "/o/c.jpg", start_s: 9, duration_s: 6, scene_id: 3 },
        ]);
        assert.strictEqual(skipped.length, 1);
        assert.strictEqual(skipped[0].scene_id, 2);
        assert.match(skipped[0].reason, /50000 bytes/);
    });

    test("buildSceneAssetsFromImageBatch: scene missing prompt is skipped before image:generate slot", async () => {
        const scenes = [
            { scene_id: 1, image_prompt: "ok", duration_s: 4 },
            { scene_id: 2, image_prompt: "", duration_s: 5 },               // skipped, but cursor advances
            { scene_id: 3, image_prompt: "ok2", duration_s: 6 },
        ];
        // image:generate would only have been called for scenes 1 + 3, so
        // result indexes are 0 + 1 (since scene 2 was filtered out client-side).
        const imageGenerate = {
            success: true,
            results: [
                { globalIdx: 0, savedFiles: ["/o/a.jpg"] },
                { globalIdx: 1, savedFiles: ["/o/c.jpg"] },
            ],
        };
        const stat = async () => ({ exists: true, size: 200_000 });
        const { sceneAssets, skipped } = await helpers.buildSceneAssetsFromImageBatch(scenes, imageGenerate, stat);
        assert.deepStrictEqual(sceneAssets, [
            { image_path: "/o/a.jpg", start_s: 0, duration_s: 4, scene_id: 1 },
            { image_path: "/o/c.jpg", start_s: 9, duration_s: 6, scene_id: 3 },
        ]);
        assert.deepStrictEqual(skipped, [{ scene_id: 2, reason: "missing image_prompt" }]);
    });

    test("buildSceneAssetsFromImageBatch: image:generate returned no files for a scene", async () => {
        const scenes = [
            { scene_id: 1, image_prompt: "ok", duration_s: 4 },
            { scene_id: 2, image_prompt: "ok2", duration_s: 5 },
        ];
        const imageGenerate = {
            success: true,
            results: [
                { globalIdx: 0, savedFiles: ["/o/a.jpg"] },
                // Note: index 1 missing entirely (image generate failed for that prompt)
            ],
        };
        const stat = async () => ({ exists: true, size: 200_000 });
        const { sceneAssets, skipped } = await helpers.buildSceneAssetsFromImageBatch(scenes, imageGenerate, stat);
        assert.deepStrictEqual(sceneAssets, [
            { image_path: "/o/a.jpg", start_s: 0, duration_s: 4, scene_id: 1 },
        ]);
        assert.strictEqual(skipped.length, 1);
        assert.strictEqual(skipped[0].scene_id, 2);
        assert.match(skipped[0].reason, /no files/);
    });

    // ── stripSceneAssetForComposer ────────────────────────────────────────

    test("stripSceneAssetForComposer: drops scene_id annotation", () => {
        const out = helpers.stripSceneAssetForComposer([
            { image_path: "/o/a.jpg", start_s: 0, duration_s: 4, scene_id: 1 },
            { image_path: "/o/b.jpg", start_s: 4, duration_s: 5, scene_id: 2 },
        ]);
        assert.deepStrictEqual(out, [
            { image_path: "/o/a.jpg", start_s: 0, duration_s: 4 },
            { image_path: "/o/b.jpg", start_s: 4, duration_s: 5 },
        ]);
    });

    test("stripSceneAssetForComposer: empty / null input", () => {
        assert.deepStrictEqual(helpers.stripSceneAssetForComposer(null), []);
        assert.deepStrictEqual(helpers.stripSceneAssetForComposer([]), []);
    });

    await Promise.all(pending);
    console.log("");
    console.log(`# results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
