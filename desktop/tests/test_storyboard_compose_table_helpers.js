/**
 * Offline regression test for
 * `desktop/dist/storyboard_compose_table_helpers.js`.
 *
 * The helpers manage the per-scene table view state for "Compose
 * with AutoGrok" (PR-20C). Verifies:
 *   - Row factory keeps order, copies prompt/title/duration, defaults
 *     image+i2v statuses to 'pending'.
 *   - startImagePhase splits into 'generating' for eligible vs.
 *     'skipped' (with i2v→skipped cascade) for not-eligible.
 *   - startImageRetry bumps attempts + sets 'retrying' only on
 *     listed rows.
 *   - applyImageProgress advances progress monotonically and never
 *     downgrades a row already settled to 'generated'/'fallback'.
 *   - applyImageResult settles status, transitions i2v from
 *     'pending' to 'idle' on success, to 'skipped' on fallback.
 *   - I2V counterparts behave symmetrically.
 *   - summarizeRows totals + status helpers stay stable for renderer.
 *
 * Run:
 *   node desktop/tests/test_storyboard_compose_table_helpers.js
 */

"use strict";

const assert = require("assert");

const helpers = require("../dist/storyboard_compose_table_helpers.js");

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

const SCENES = [
    { scene_id: 1, title: "intro", image_prompt: "p1", video_prompt: "v1", flow_video_prompt: "vf1", duration_s: 3 },
    { scene_id: 2, title: "middle", image_prompt: "p2", flow_video_prompt: "vf2", duration_s: 4 },
    { scene_id: 3, title: "skipped", image_prompt: "", duration_s: 0 },
];

async function run() {
    test("initRowsFromScenes: copies fields + defaults statuses pending", () => {
        const rows = helpers.initRowsFromScenes(SCENES);
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0].order, 1);
        assert.strictEqual(rows[0].scene_id, 1);
        assert.strictEqual(rows[0].image_prompt, "p1");
        // Prefers explicit video_prompt over flow_video_prompt.
        assert.strictEqual(rows[0].video_prompt, "v1");
        // Falls back to flow_video_prompt when video_prompt missing.
        assert.strictEqual(rows[1].video_prompt, "vf2");
        // Empty prompt is preserved as empty string.
        assert.strictEqual(rows[2].image_prompt, "");
        // Statuses default to pending.
        assert.strictEqual(rows[0].image.status, "pending");
        assert.strictEqual(rows[0].i2v.status, "pending");
    });

    test("initRowsFromScenes: empty/null inputs return empty array", () => {
        assert.deepStrictEqual(helpers.initRowsFromScenes([]), []);
        assert.deepStrictEqual(helpers.initRowsFromScenes(null), []);
        assert.deepStrictEqual(helpers.initRowsFromScenes(undefined), []);
    });

    test("startImagePhase: eligible rows go generating, skipped rows cascade i2v→skipped", () => {
        const rows = helpers.initRowsFromScenes(SCENES);
        const after = helpers.startImagePhase(
            rows,
            [1, 2],
            [{ scene_id: 3, reason: "missing image_prompt" }],
        );
        assert.strictEqual(after[0].image.status, "generating");
        assert.strictEqual(after[0].image.attempts, 1);
        assert.strictEqual(after[1].image.status, "generating");
        assert.strictEqual(after[2].image.status, "skipped");
        assert.match(after[2].image.reason, /image_prompt/);
        assert.strictEqual(after[2].i2v.status, "skipped");
        // Pure: original rows untouched.
        assert.strictEqual(rows[0].image.status, "pending");
    });

    test("startImageRetry: bumps attempts only on listed rows", () => {
        let rows = helpers.initRowsFromScenes(SCENES);
        rows = helpers.startImagePhase(rows, [1, 2], []);
        const retried = helpers.startImageRetry(rows, [2], 2);
        assert.strictEqual(retried[0].image.status, "generating", "scene 1 untouched");
        assert.strictEqual(retried[0].image.attempts, 1);
        assert.strictEqual(retried[1].image.status, "retrying");
        assert.strictEqual(retried[1].image.attempts, 2);
    });

    test("applyImageProgress: only ratchets up, never downgrades, ignores other scenes", () => {
        let rows = helpers.initRowsFromScenes(SCENES);
        rows = helpers.startImagePhase(rows, [1, 2], []);
        rows = helpers.applyImageProgress(rows, 1, { progress: 25 });
        rows = helpers.applyImageProgress(rows, 1, { progress: 60 });
        rows = helpers.applyImageProgress(rows, 1, { progress: 30 }); // late event
        assert.strictEqual(rows[0].image.progress, 60);
        // scene 2 untouched.
        assert.strictEqual(rows[1].image.progress, 0);
    });

    test("applyImageProgress: never downgrades a settled row", () => {
        let rows = helpers.initRowsFromScenes(SCENES);
        rows = helpers.startImagePhase(rows, [1, 2], []);
        rows = helpers.applyImageResult(rows, 1, {
            status: "generated", attempts: 1, image_path: "/img1.png", bytes: 80_000,
        });
        rows = helpers.applyImageProgress(rows, 1, { progress: 5 });
        assert.strictEqual(rows[0].image.status, "generated");
        assert.strictEqual(rows[0].image.progress, 100);
    });

    test("applyImageResult generated → i2v transitions pending→idle", () => {
        let rows = helpers.initRowsFromScenes(SCENES);
        rows = helpers.startImagePhase(rows, [1, 2], []);
        rows = helpers.applyImageResult(rows, 1, {
            status: "generated", attempts: 1, image_path: "/img1.png", bytes: 80_000,
        });
        assert.strictEqual(rows[0].image.status, "generated");
        assert.strictEqual(rows[0].image.image_path, "/img1.png");
        assert.strictEqual(rows[0].image.bytes, 80_000);
        assert.strictEqual(rows[0].i2v.status, "idle");
    });

    test("applyImageResult fallback → i2v transitions to skipped (no image)", () => {
        let rows = helpers.initRowsFromScenes(SCENES);
        rows = helpers.startImagePhase(rows, [1, 2], []);
        rows = helpers.applyImageResult(rows, 2, {
            status: "fallback", attempts: 2, reason: "all <50KB",
        });
        assert.strictEqual(rows[1].image.status, "fallback");
        assert.strictEqual(rows[1].i2v.status, "skipped");
        assert.strictEqual(rows[1].i2v.reason, "no image");
    });

    test("startI2VPhase: only image-success rows go to generating, plan-skipped marked skipped", () => {
        let rows = helpers.initRowsFromScenes(SCENES);
        rows = helpers.startImagePhase(rows, [1, 2], []);
        rows = helpers.applyImageResult(rows, 1, { status: "generated", attempts: 1, image_path: "/img1.png", bytes: 80000 });
        rows = helpers.applyImageResult(rows, 2, { status: "generated", attempts: 1, image_path: "/img2.png", bytes: 80000 });
        // Now only scene 1 is I2V-eligible (e.g. scene 2 has no video_prompt).
        rows = helpers.startI2VPhase(rows, [1], [{ scene_id: 2, reason: "missing video_prompt" }]);
        assert.strictEqual(rows[0].i2v.status, "generating");
        assert.strictEqual(rows[0].i2v.attempts, 1);
        assert.strictEqual(rows[1].i2v.status, "skipped");
        assert.match(rows[1].i2v.reason, /video_prompt/);
    });

    test("applyI2VResult: fallback keeps the still image (image row unaffected)", () => {
        let rows = helpers.initRowsFromScenes(SCENES);
        rows = helpers.startImagePhase(rows, [1, 2], []);
        rows = helpers.applyImageResult(rows, 1, { status: "generated", attempts: 1, image_path: "/img1.png", bytes: 80000 });
        rows = helpers.startI2VPhase(rows, [1], []);
        rows = helpers.applyI2VResult(rows, 1, { status: "fallback", attempts: 2, reason: "moderation" });
        assert.strictEqual(rows[0].image.status, "generated", "image row preserved");
        assert.strictEqual(rows[0].image.image_path, "/img1.png");
        assert.strictEqual(rows[0].i2v.status, "fallback");
    });

    test("applyI2VResult generated: writes video_path + flips progress to 100", () => {
        let rows = helpers.initRowsFromScenes(SCENES);
        rows = helpers.startImagePhase(rows, [1], []);
        rows = helpers.applyImageResult(rows, 1, { status: "generated", attempts: 1, image_path: "/img1.png", bytes: 80000 });
        rows = helpers.startI2VPhase(rows, [1], []);
        rows = helpers.applyI2VProgress(rows, 1, { progress: 40 });
        rows = helpers.applyI2VResult(rows, 1, { status: "generated", attempts: 1, video_path: "/v1.mp4", bytes: 500000 });
        assert.strictEqual(rows[0].i2v.status, "generated");
        assert.strictEqual(rows[0].i2v.video_path, "/v1.mp4");
        assert.strictEqual(rows[0].i2v.progress, 100);
    });

    test("status label / class helpers stable", () => {
        assert.strictEqual(helpers.imageStatusLabel("generating"), "generating…");
        assert.strictEqual(helpers.imageStatusLabel("fallback"), "fallback (gradient)");
        assert.strictEqual(helpers.imageStatusLabel("nonsense"), "nonsense");
        assert.strictEqual(helpers.i2vStatusLabel("idle"), "idle (image only)");
        assert.strictEqual(helpers.i2vStatusLabel("fallback"), "fallback → image");
        assert.strictEqual(helpers.statusClass("generated"), "ok");
        assert.strictEqual(helpers.statusClass("fallback"), "warn");
        assert.strictEqual(helpers.statusClass("retrying"), "warn");
        assert.strictEqual(helpers.statusClass("nonsense"), "muted");
    });

    test("summarizeRows: totals after a mixed run", () => {
        let rows = helpers.initRowsFromScenes([
            { scene_id: 1, image_prompt: "a", video_prompt: "x", duration_s: 1 },
            { scene_id: 2, image_prompt: "b", video_prompt: "y", duration_s: 1 },
            { scene_id: 3, image_prompt: "c", video_prompt: "z", duration_s: 1 },
            { scene_id: 4, image_prompt: "", duration_s: 1 },
        ]);
        rows = helpers.startImagePhase(rows, [1, 2, 3], [{ scene_id: 4, reason: "missing image_prompt" }]);
        rows = helpers.applyImageResult(rows, 1, { status: "generated", attempts: 1, image_path: "/i1.png", bytes: 80000 });
        rows = helpers.applyImageResult(rows, 2, { status: "retried", attempts: 2, image_path: "/i2.png", bytes: 80000 });
        rows = helpers.applyImageResult(rows, 3, { status: "fallback", attempts: 2, reason: "all<50KB" });
        rows = helpers.startI2VPhase(rows, [1, 2], [{ scene_id: 3, reason: "no image" }]);
        rows = helpers.applyI2VResult(rows, 1, { status: "generated", attempts: 1, video_path: "/v1.mp4", bytes: 500000 });
        rows = helpers.applyI2VResult(rows, 2, { status: "fallback", attempts: 2, reason: "moderation" });
        const s = helpers.summarizeRows(rows);
        assert.strictEqual(s.total, 4);
        assert.strictEqual(s.image_generated, 1);
        assert.strictEqual(s.image_retried, 1);
        assert.strictEqual(s.image_fallback, 1);
        assert.strictEqual(s.image_skipped, 1);
        assert.strictEqual(s.i2v_generated, 1);
        assert.strictEqual(s.i2v_fallback, 1);
        // image fallback cascades i2v → skipped.
        assert.strictEqual(s.i2v_skipped, 2);
    });

    test("immutability: helpers never mutate inputs", () => {
        const rowsOriginal = helpers.initRowsFromScenes([
            { scene_id: 1, image_prompt: "a", video_prompt: "x", duration_s: 1 },
        ]);
        const snapshot = JSON.parse(JSON.stringify(rowsOriginal));
        helpers.startImagePhase(rowsOriginal, [1], []);
        helpers.applyImageProgress(rowsOriginal, 1, { progress: 50 });
        helpers.applyImageResult(rowsOriginal, 1, { status: "generated", attempts: 1, image_path: "/x.png" });
        helpers.startI2VPhase(rowsOriginal, [1], []);
        helpers.applyI2VResult(rowsOriginal, 1, { status: "generated", attempts: 1, video_path: "/x.mp4" });
        assert.deepStrictEqual(rowsOriginal, snapshot, "input rows must not be mutated");
    });

    await Promise.all(pending);
    console.log("");
    if (failed === 0) { console.log(`PASSED ${passed} test(s)`); process.exit(0); }
    else { console.error(`FAILED ${failed} of ${passed + failed} test(s)`); process.exit(1); }
}

run().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
