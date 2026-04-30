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

    // ── preload.js / renderer namespace contract ──────────────────────────
    // Regression guard: `electronAPI.statBytes` must be exposed at the top
    // level (matching `readFile` / `deleteFile` etc.), not nested under a
    // `file: {...}` namespace, and the renderer must access it the same way.
    // PR #21 review (BUG_pr-review-job-c0e1d787e7af4d4690859527c6d9eb36_0001)
    // caught a mismatch here that caused the "Compose with AutoGrok" button
    // to early-return on every click.

    test("preload.js exposes statBytes at the top level of electronAPI", () => {
        const fs = require("fs");
        const path = require("path");
        const src = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.js"), "utf8");
        // Top-level binding inside the contextBridge.exposeInMainWorld map.
        assert.match(src, /statBytes:\s*\(filePath\)\s*=>\s*ipcRenderer\.invoke\('file:statBytes'/,
            "preload.js must expose `statBytes` at the top level (not under `file: { statBytes }`)");
    });

    test("creator-forge.js calls api.statBytes (not api.file.statBytes)", () => {
        const fs = require("fs");
        const path = require("path");
        const src = fs.readFileSync(path.join(__dirname, "..", "dist", "creator-forge.js"), "utf8");
        assert.ok(src.includes("api.statBytes"), "renderer must call `api.statBytes`");
        assert.ok(!src.includes("api.file.statBytes"),
            "renderer must NOT call `api.file.statBytes` — that namespace doesn't exist in preload.js");
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

    // ── orchestrateImageGenerationWithRetries (PR-17) ─────────────────────

    function statBytesFromMap(map) {
        return async (p) => ({ exists: p in map, size: map[p] || 0 });
    }

    test("orchestrate: happy path — every scene picks on attempt 1, no retries", async () => {
        const calls = [];
        const imageGenerateFn = async (prompts, ctx) => {
            calls.push({ prompts, ctx });
            return {
                success: true,
                results: prompts.map((_, i) => ({ globalIdx: i, savedFiles: [`/img/p${i}.jpg`], success: true })),
            };
        };
        const stat = statBytesFromMap({ "/img/p0.jpg": 100 * 1024, "/img/p1.jpg": 100 * 1024 });

        const out = await helpers.orchestrateImageGenerationWithRetries(
            [
                { scene_id: 1, image_prompt: "A", duration_s: 3 },
                { scene_id: 2, image_prompt: "B", duration_s: 4 },
            ],
            imageGenerateFn, stat,
            { maxAttempts: 2 },
        );

        assert.strictEqual(calls.length, 1, "single bulk call when nothing fails");
        assert.strictEqual(out.retryCount, 0);
        assert.deepStrictEqual(out.sceneAssets.map((s) => s.image_path), ["/img/p0.jpg", "/img/p1.jpg"]);
        const statuses = out.perSceneStatus.map((s) => s.status);
        assert.deepStrictEqual(statuses, ["generated", "generated"]);
    });

    test("orchestrate: scene-level retry replaces a blur with a usable image", async () => {
        let attempt = 0;
        const calls = [];
        const imageGenerateFn = async (prompts) => {
            attempt++;
            calls.push(prompts.slice());
            if (attempt === 1) {
                return { success: true, results: [
                    { globalIdx: 0, savedFiles: ["/img/blur.jpg"],   success: true },
                    { globalIdx: 1, savedFiles: ["/img/b_ok.jpg"],   success: true },
                ]};
            }
            return { success: true, results: [
                { globalIdx: 0, savedFiles: ["/img/a_retry.jpg"], success: true },
            ]};
        };
        const stat = statBytesFromMap({
            "/img/blur.jpg":     1024,
            "/img/b_ok.jpg":     80 * 1024,
            "/img/a_retry.jpg":  120 * 1024,
        });

        const out = await helpers.orchestrateImageGenerationWithRetries(
            [
                { scene_id: 1, image_prompt: "A", duration_s: 2 },
                { scene_id: 2, image_prompt: "B", duration_s: 5 },
            ],
            imageGenerateFn, stat,
            { maxAttempts: 2 },
        );

        assert.strictEqual(calls.length, 2);
        assert.deepStrictEqual(calls[0], ["A", "B"]);
        assert.deepStrictEqual(calls[1], ["A"]);
        assert.strictEqual(out.retryCount, 1);
        assert.strictEqual(out.perSceneStatus[0].status, "retried");
        assert.strictEqual(out.perSceneStatus[0].attempts, 2);
        assert.strictEqual(out.perSceneStatus[1].status, "generated");
        assert.deepStrictEqual(out.sceneAssets.map((s) => s.image_path), ["/img/a_retry.jpg", "/img/b_ok.jpg"]);
    });

    test("orchestrate: every attempt fails → status=fallback (no asset, cursor advances)", async () => {
        let n = 0;
        const imageGenerateFn = async (prompts) => {
            n++;
            return { success: true, results: prompts.map((_, i) => ({ globalIdx: i, savedFiles: [`/img/blur_${n}_${i}.jpg`], success: true })) };
        };
        const stat = async () => ({ exists: true, size: 1024 }); // every file < 50KB

        const out = await helpers.orchestrateImageGenerationWithRetries(
            [
                { scene_id: 1, image_prompt: "A", duration_s: 2 },
                { scene_id: 2, image_prompt: "B", duration_s: 5 },
            ],
            imageGenerateFn, stat,
            { maxAttempts: 3 },
        );

        assert.strictEqual(out.sceneAssets.length, 0, "no usable files anywhere");
        assert.strictEqual(out.retryCount, 4, "2 scenes × 2 retries");
        const statuses = out.perSceneStatus.map((s) => s.status);
        assert.deepStrictEqual(statuses, ["fallback", "fallback"]);
        for (const s of out.perSceneStatus) {
            assert.strictEqual(s.attempts, 3);
            assert.match(s.reason, /50000|≥/);
        }
    });

    test("orchestrate: skipped scenes (missing prompt or duration) never call image:generate", async () => {
        const calls = [];
        const imageGenerateFn = async (prompts) => {
            calls.push(prompts.slice());
            return { success: true, results: prompts.map((_, i) => ({ globalIdx: i, savedFiles: [`/img/${i}.jpg`], success: true })) };
        };
        const stat = async () => ({ exists: true, size: 100 * 1024 });

        const out = await helpers.orchestrateImageGenerationWithRetries(
            [
                { scene_id: 1, image_prompt: "  ", duration_s: 3 }, // missing prompt
                { scene_id: 2, image_prompt: "B",  duration_s: 0 }, // bad duration
                { scene_id: 3, image_prompt: "C",  duration_s: 4 },
            ],
            imageGenerateFn, stat,
            { maxAttempts: 2 },
        );

        assert.deepStrictEqual(calls[0], ["C"], "only the eligible prompt reaches image:generate");
        assert.strictEqual(out.retryCount, 0);
        const statuses = out.perSceneStatus.map((s) => [s.scene_id, s.status]);
        assert.deepStrictEqual(statuses, [[1, "skipped"], [2, "skipped"], [3, "generated"]]);
    });

    test("orchestrate: maxAttempts=1 makes a single attempt with no retry", async () => {
        let n = 0;
        const imageGenerateFn = async (prompts) => {
            n++;
            return { success: true, results: prompts.map((_, i) => ({ globalIdx: i, savedFiles: ["/img/blur.jpg"], success: true })) };
        };
        const stat = async () => ({ exists: true, size: 1024 });

        const out = await helpers.orchestrateImageGenerationWithRetries(
            [{ scene_id: 1, image_prompt: "A", duration_s: 3 }],
            imageGenerateFn, stat,
            { maxAttempts: 1 },
        );

        assert.strictEqual(n, 1, "no retry attempt");
        assert.strictEqual(out.retryCount, 0);
        assert.strictEqual(out.perSceneStatus[0].status, "fallback");
        assert.strictEqual(out.perSceneStatus[0].attempts, 1);
    });

    test("orchestrate: imageGenerateFn throwing on attempt 1 still allows attempt 2 to recover", async () => {
        let n = 0;
        const imageGenerateFn = async (prompts) => {
            n++;
            if (n === 1) throw new Error("network hiccup");
            return { success: true, results: prompts.map((_, i) => ({ globalIdx: i, savedFiles: ["/img/recovered.jpg"], success: true })) };
        };
        const stat = statBytesFromMap({ "/img/recovered.jpg": 80 * 1024 });

        const out = await helpers.orchestrateImageGenerationWithRetries(
            [{ scene_id: 1, image_prompt: "A", duration_s: 3 }],
            imageGenerateFn, stat,
            { maxAttempts: 2 },
        );

        assert.strictEqual(n, 2);
        assert.strictEqual(out.perSceneStatus[0].status, "retried");
        assert.strictEqual(out.sceneAssets.length, 1);
    });

    test("orchestrate: countFallbackScenes counts only fallback entries", () => {
        const n = helpers.countFallbackScenes([
            { scene_id: 1, status: "generated" },
            { scene_id: 2, status: "fallback"  },
            { scene_id: 3, status: "skipped"   },
            { scene_id: 4, status: "fallback"  },
            { scene_id: 5, status: "retried"   },
        ]);
        assert.strictEqual(n, 2);
        assert.strictEqual(helpers.countFallbackScenes([]), 0);
        assert.strictEqual(helpers.countFallbackScenes(null), 0);
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
