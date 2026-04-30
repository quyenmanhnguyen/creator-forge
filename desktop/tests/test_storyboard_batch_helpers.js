// Offline regression tests for `storyboard_batch_helpers.js` (PR-20D).
//
// The helpers are pure / immutable so we test them in plain Node
// without any DOM, IPC, or auth mocks.

"use strict";

const assert = require("assert");
const helpers = require("../dist/storyboard_batch_helpers.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// scene 1 carries ONLY flow_video_prompt (the long-form scene_breakdown
// shape from /producer/scene_breakdown). scene 2 carries BOTH
// flow_video_prompt and video_prompt — `video_prompt` must win to match
// the precedence used by StoryboardBridge.animateScenes,
// storyboard_compose_table_helpers, and
// storyboard_video_compose_helpers. scene 3 has no image_prompt
// (skip). scene 4 has no video prompt of any kind (skip).
const SCENES = [
    { scene_id: 1, title: "intro", image_prompt: "p1", flow_video_prompt: "vf1", duration_s: 3 },
    { scene_id: 2, title: "middle", image_prompt: "p2", video_prompt: "v2", flow_video_prompt: "vf2-IGNORED", duration_s: 4 },
    { scene_id: 3, title: "no-img", image_prompt: "", flow_video_prompt: "vf3", duration_s: 2 },
    { scene_id: 4, title: "no-vid", image_prompt: "p4", duration_s: 2 },
];

test("initImageRowsFromScenes: copies prompt, defaults to pending; empty prompt → skipped", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES);
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].prompt, "p1");
    assert.strictEqual(rows[0].status, "pending");
    assert.strictEqual(rows[2].prompt, "");
    assert.strictEqual(rows[2].status, "skipped");
    assert.match(rows[2].reason, /image_prompt/);
});

test("initVideoRowsFromScenes: prefers video_prompt, falls back to flow_video_prompt (matches the rest of the codebase)", () => {
    const rows = helpers.initVideoRowsFromScenes(SCENES);
    // scene 1 has only flow_video_prompt → use it.
    assert.strictEqual(rows[0].prompt, "vf1");
    // scene 2 has BOTH; video_prompt must win — same precedence as
    // StoryboardBridge.animateScenes / storyboard_compose_table_helpers
    // / storyboard_video_compose_helpers.
    assert.strictEqual(rows[1].prompt, "v2", "video_prompt must take precedence over flow_video_prompt");
    assert.notStrictEqual(rows[1].prompt, "vf2-IGNORED");
    // scene 4 has neither.
    assert.strictEqual(rows[3].status, "skipped", "scene without any video prompt is skipped");
});

test("initImageRowsFromScenes / initVideoRowsFromScenes: empty / non-array input is safe", () => {
    assert.deepStrictEqual(helpers.initImageRowsFromScenes(null), []);
    assert.deepStrictEqual(helpers.initImageRowsFromScenes(undefined), []);
    assert.deepStrictEqual(helpers.initImageRowsFromScenes([]), []);
    assert.deepStrictEqual(helpers.initVideoRowsFromScenes(null), []);
});

test("startBatchPhase: eligible rows go generating, skipped rows untouched, attempts++", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    assert.strictEqual(rows[0].status, "generating");
    assert.strictEqual(rows[0].attempts, 1);
    assert.strictEqual(rows[2].status, "skipped", "skipped scene must remain skipped");
    assert.strictEqual(rows[2].attempts, 0);
    rows = helpers.startBatchPhase(rows);
    assert.strictEqual(rows[0].attempts, 2, "second attempt bumps attempts to 2");
});

test("applyBatchProgress: ratchets up only", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchProgress(rows, 1, { progress: 30 });
    assert.strictEqual(rows[0].progress, 30);
    rows = helpers.applyBatchProgress(rows, 1, { progress: 70 });
    assert.strictEqual(rows[0].progress, 70);
    rows = helpers.applyBatchProgress(rows, 1, { progress: 50 });
    assert.strictEqual(rows[0].progress, 70, "progress must not downgrade");
});

test("applyBatchProgress: settled rows ignore late events (incl. skipped)", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    // Skipped row stays at progress=0 even if a stray event fires.
    rows = helpers.applyBatchProgress(rows, 3, { progress: 80 });
    assert.strictEqual(rows[2].progress, 0);
    assert.strictEqual(rows[2].status, "skipped");

    // Settled (generated) row should not regress.
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, { status: "generated", attempts: 1, image_path: "/img1.png", bytes: 80_000 });
    rows = helpers.applyBatchProgress(rows, 1, { progress: 50 });
    assert.strictEqual(rows[0].status, "generated");
    assert.strictEqual(rows[0].progress, 100, "settled image stays at 100");
});

test("applyBatchResult: writes image_path/video_path/bytes and flips progress to 100 on success", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 90_000,
    });
    assert.strictEqual(rows[0].status, "generated");
    assert.strictEqual(rows[0].image_path, "/p1.png");
    assert.strictEqual(rows[0].bytes, 90_000);
    assert.strictEqual(rows[0].progress, 100);

    rows = helpers.applyBatchResult(rows, 2, {
        status: "fallback", attempts: 2, reason: "blur threshold",
    });
    assert.strictEqual(rows[1].status, "fallback");
    assert.match(rows[1].reason, /blur/);
});

test("pairImagePathsForI2V: copies path only for settled image rows", () => {
    let imageRows = helpers.initImageRowsFromScenes(SCENES);
    imageRows = helpers.startBatchPhase(imageRows);
    imageRows = helpers.applyBatchResult(imageRows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 90_000,
    });
    imageRows = helpers.applyBatchResult(imageRows, 4, {
        status: "fallback", attempts: 1, reason: "no usable image",
    });
    let videoRows = helpers.initVideoRowsFromScenes(SCENES);
    videoRows = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(videoRows[0].image_path, "/p1.png");
    assert.strictEqual(videoRows[3].image_path, null, "fallback image must NOT be paired");
});

test("planImageGenerate: returns prompts + sceneIds in row order, skips skipped", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES);
    const plan = helpers.planImageGenerate(rows);
    assert.deepStrictEqual(plan.prompts, ["p1", "p2", "p4"]);
    assert.deepStrictEqual(plan.sceneIds, [1, 2, 4]);
});

test("planVideoGenerate t2v: every row with a prompt is eligible (no image required)", () => {
    const rows = helpers.initVideoRowsFromScenes(SCENES);
    const plan = helpers.planVideoGenerate(rows, "t2v");
    assert.strictEqual(plan.mode, "t2v");
    assert.deepStrictEqual(plan.prompts, ["vf1", "v2", "vf3"]);
    assert.deepStrictEqual(plan.sceneIds, [1, 2, 3]);
    assert.strictEqual(plan.skipped.length, 1, "scene 4 has no video prompt → skipped");
});

test("planVideoGenerate i2v: rows without paired image_path are skipped with a clear reason", () => {
    let imageRows = helpers.initImageRowsFromScenes(SCENES);
    imageRows = helpers.applyBatchResult(imageRows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 90_000,
    });
    imageRows = helpers.applyBatchResult(imageRows, 2, {
        status: "fallback", attempts: 1, reason: "blur",
    });
    let videoRows = helpers.initVideoRowsFromScenes(SCENES);
    videoRows = helpers.pairImagePathsForI2V(videoRows, imageRows);
    const plan = helpers.planVideoGenerate(videoRows, "i2v");
    assert.strictEqual(plan.mode, "i2v");
    assert.strictEqual(plan.items.length, 1, "only scene 1 has a paired image");
    assert.deepStrictEqual(plan.items[0], { imagePath: "/p1.png", prompt: "vf1" });
    assert.deepStrictEqual(plan.sceneIds, [1]);
    // scene 2 (no paired image), scene 3 (no prompt), scene 4 (no prompt) → skipped.
    assert.strictEqual(plan.skipped.length, 3);
});

test("mapBatchResponse image: extracts savedFiles[0] (string[] from ImageService.generateBatch) or object shapes", () => {
    const resp = {
        results: [
            // Real ImageService.generateBatch shape: savedFiles is string[].
            { prompt: "p1", savedFiles: ["/out/p1.png", "/out/p1b.png"] },
            // Object shape: { path } or { savedPath } both supported.
            { prompt: "p2", savedFiles: [{ savedPath: "/out/p2.png", bytes: 65_000 }] },
            // Empty savedFiles + outputPath fallback.
            { prompt: "p3", savedFiles: [], outputPath: "/out/p3.png" },
            // Total failure.
            { prompt: "p4", savedFiles: [], error: "blur" },
        ],
    };
    const out = helpers.mapBatchResponse(resp, [1, 2, 3, 4], "image");
    assert.strictEqual(out[0].status, "generated");
    assert.strictEqual(out[0].image_path, "/out/p1.png", "string[] savedFiles → first element");
    assert.strictEqual(out[1].image_path, "/out/p2.png");
    assert.strictEqual(out[1].bytes, 65_000);
    assert.strictEqual(out[2].image_path, "/out/p3.png", "outputPath fallback when savedFiles is empty");
    assert.strictEqual(out[3].status, "fallback");
    assert.match(out[3].reason, /blur/);
});

test("mapBatchResponse video: extracts videoPath, falls back to savedFile, marks failures", () => {
    const resp = {
        results: [
            { success: true, videoPath: "/out/v1.mp4", bytes: 200_000 },
            { success: true, savedFile: "/out/v2.mp4" },
            { success: false, error: "session expired" },
        ],
    };
    const out = helpers.mapBatchResponse(resp, [1, 2, 3], "video");
    assert.strictEqual(out[0].video_path, "/out/v1.mp4");
    assert.strictEqual(out[1].video_path, "/out/v2.mp4");
    assert.strictEqual(out[2].status, "fallback");
    assert.match(out[2].reason, /session expired/);
});

test("mapBatchResponse: missing/short results array fills fallback for every scene", () => {
    const out = helpers.mapBatchResponse({ error: "no sessions" }, [1, 2], "image");
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((r) => r.status === "fallback"));
    assert.match(out[0].reason, /no sessions/);
});

test("summarizeRows: aggregates per-status counts", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, { status: "generated", attempts: 1, image_path: "/p1.png", bytes: 80000 });
    rows = helpers.applyBatchResult(rows, 4, { status: "fallback", attempts: 2, reason: "blur" });
    const sum = helpers.summarizeRows(rows);
    assert.strictEqual(sum.total, 4);
    assert.strictEqual(sum.generated, 1);
    assert.strictEqual(sum.fallback, 1);
    assert.strictEqual(sum.skipped, 1);
    assert.strictEqual(sum.generating, 1, "scene 2 is still generating after the partial settle");
});

test("statusLabel / statusClass: stable labels for all known statuses", () => {
    for (const s of ["pending", "generating", "generated", "retried", "fallback", "skipped"]) {
        assert.strictEqual(typeof helpers.statusLabel(s), "string");
        assert.strictEqual(typeof helpers.statusClass(s), "string");
    }
    assert.strictEqual(helpers.statusClass("generated"), "ok");
    assert.strictEqual(helpers.statusClass("fallback"), "warn");
    assert.strictEqual(helpers.statusClass("skipped"), "muted");
});

test("immutability: helpers never mutate input arrays/objects", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES);
    const snap = JSON.stringify(rows);
    helpers.startBatchPhase(rows);
    helpers.applyBatchProgress(rows, 1, { progress: 50 });
    helpers.applyBatchResult(rows, 1, { status: "generated", attempts: 1, image_path: "/p1.png", bytes: 80000 });
    helpers.pairImagePathsForI2V(helpers.initVideoRowsFromScenes(SCENES), rows);
    assert.strictEqual(JSON.stringify(rows), snap, "input rows must not be mutated");
});

// ── PR-20E: mapBatchResponseAsync with ffprobe-backed validator ──────
test("PR-20E: mapBatchResponseAsync(video) with no validator falls back to sync mapping", async () => {
    const resp = { success: true, results: [{ success: true, videoPath: "/a.mp4" }, { success: false, error: "nope" }] };
    const out = await helpers.mapBatchResponseAsync(resp, ["s1", "s2"], "video", {});
    assert.strictEqual(out[0].status, "generated");
    assert.strictEqual(out[0].video_path, "/a.mp4");
    assert.strictEqual(out[1].status, "fallback");
});

test("PR-20E: mapBatchResponseAsync(video) flips generated→fallback when validator says !ok", async () => {
    const resp = { success: true, results: [{ success: true, videoPath: "/bad.mp4" }, { success: true, videoPath: "/good.mp4" }] };
    const validateFn = async (fp) => fp === "/bad.mp4"
        ? { ok: false, reason: "no video stream", ffprobeAvailable: true }
        : { ok: true, size: 250_000, ffprobeAvailable: true };
    const out = await helpers.mapBatchResponseAsync(resp, ["s1", "s2"], "video", { validateFn });
    assert.strictEqual(out[0].status, "fallback");
    assert.match(out[0].reason, /no video stream/);
    assert.strictEqual(out[1].status, "generated");
    assert.strictEqual(out[1].bytes, 250_000);
    assert.notStrictEqual(out[1].size_only, true);
});

test("PR-20E: mapBatchResponseAsync(video) marks size_only when ffprobe unavailable but ok", async () => {
    const resp = { success: true, results: [{ success: true, videoPath: "/x.mp4" }] };
    const validateFn = async () => ({ ok: true, ffprobeAvailable: false, reason: "ffprobe unavailable" });
    const out = await helpers.mapBatchResponseAsync(resp, ["s1"], "video", { validateFn });
    assert.strictEqual(out[0].status, "generated");
    assert.strictEqual(out[0].size_only, true);
});

test("PR-20E: mapBatchResponseAsync(video) validator throw → fallback with threw reason", async () => {
    const resp = { success: true, results: [{ success: true, videoPath: "/a.mp4" }] };
    const validateFn = async () => { throw new Error("boom"); };
    const out = await helpers.mapBatchResponseAsync(resp, ["s1"], "video", { validateFn });
    assert.strictEqual(out[0].status, "fallback");
    assert.match(out[0].reason, /validator threw: boom/);
});

test("PR-20E: mapBatchResponseAsync(image) does NOT invoke video validator (images are not ffprobed)", async () => {
    let called = 0;
    const resp = { success: true, results: [{ savedFiles: ["/x.png"] }] };
    const validateFn = async () => { called += 1; return { ok: true }; };
    const out = await helpers.mapBatchResponseAsync(resp, ["s1"], "image", { validateFn });
    assert.strictEqual(called, 0);
    assert.strictEqual(out[0].status, "generated");
    assert.strictEqual(out[0].image_path, "/x.png");
});

let pass = 0;
let fail = 0;
(async () => {
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ok  ${t.name}`);
            pass++;
        } catch (e) {
            console.log(`  FAIL  ${t.name}\n    ${e && e.message}`);
            fail++;
        }
    }
    console.log(`\n${fail === 0 ? "PASSED" : "FAILED"} ${pass} / ${pass + fail} test(s)`);
    process.exit(fail === 0 ? 0 : 1);
})();
