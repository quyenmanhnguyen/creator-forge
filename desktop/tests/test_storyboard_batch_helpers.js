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
    rows = helpers.applyBatchResult(rows, 1, { status: "generated", attempts: 1, image_path: "/img1.png", bytes: 250_000 });
    rows = helpers.applyBatchProgress(rows, 1, { progress: 50 });
    assert.strictEqual(rows[0].status, "generated");
    assert.strictEqual(rows[0].progress, 100, "settled image stays at 100");
});

test("applyBatchResult: writes image_path/video_path/bytes and flips progress to 100 on success", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 250_000,
    });
    assert.strictEqual(rows[0].status, "generated");
    assert.strictEqual(rows[0].image_path, "/p1.png");
    assert.strictEqual(rows[0].bytes, 250_000);
    assert.strictEqual(rows[0].progress, 100);

    rows = helpers.applyBatchResult(rows, 2, {
        status: "fallback", attempts: 2, reason: "blur threshold",
    });
    assert.strictEqual(rows[1].status, "fallback");
    assert.match(rows[1].reason, /blur/);
});

// PR-B regression coverage: small image files (< 100 KB) almost
// always indicate a Grok error page / blank placeholder rather than
// a real generation. ``applyBatchResult`` must demote them to
// fallback so they do NOT pair into the I2V batch.

test("applyBatchResult: demotes 'generated' image with bytes < 100 KB to fallback", () => {
    assert.strictEqual(helpers.MIN_OK_IMAGE_BYTES, 100 * 1024, "constant exported for callers");
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 50 * 1024,
    });
    assert.strictEqual(rows[0].status, "fallback", "50 KB image must NOT count as generated");
    assert.match(rows[0].reason, /50 KB/, "reason names the actual size for the user");
    assert.match(rows[0].reason, /below 100 KB/, "reason names the threshold");
    // bytes is preserved so the row still shows the size next to the
    // (now red) thumbnail in the table.
    assert.strictEqual(rows[0].bytes, 50 * 1024);
});

test("applyBatchResult: keeps 'generated' image at the 100 KB threshold (>= passes)", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 100 * 1024,
    });
    assert.strictEqual(rows[0].status, "generated", "100 KB image is right at threshold and must pass");
    rows = helpers.applyBatchResult(rows, 2, {
        status: "generated", attempts: 1, image_path: "/p2.png", bytes: 5 * 1024 * 1024,
    });
    assert.strictEqual(rows[1].status, "generated");
});

test("applyBatchResult: 184 KB legitimate JPEG (the user's regression case) is no longer demoted", () => {
    // Regression: scene 2 in the user's screenshot landed at 184 KB
    // and was demoted under the old 200 KB gate even though the file
    // was a perfectly fine Pro-mode JPEG. With the threshold lowered
    // to 100 KB this exact size must now pass through cleanly.
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 2, {
        status: "generated", attempts: 1, image_path: "/p2.png", bytes: 184 * 1024,
    });
    assert.strictEqual(rows[1].status, "generated", "184 KB JPEG must pass the 100 KB gate");
});

test("applyBatchResult: video result with no bytes is unaffected by image-size gate", () => {
    let rows = helpers.initVideoRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    // No image_path → image-size gate cannot fire even if bytes is
    // small (video bytes have a different distribution and the
    // gate's threshold is image-specific).
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, video_path: "/v1.mp4",
    });
    assert.strictEqual(rows[0].status, "generated");
    assert.strictEqual(rows[0].video_path, "/v1.mp4");
});

test("applyBatchResult: 'generated' image with no bytes reported is left alone (gate is opt-in)", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    // ImageService used to omit ``bytes`` on legacy paths; the gate
    // requires a positive byte count to fire so those legacy rows
    // don't get spuriously demoted.
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png",
    });
    assert.strictEqual(rows[0].status, "generated", "no bytes field → gate is a no-op");
});

// Hot-fix regression coverage: ImageService / RefImageService return
// ``savedFiles`` as a string[] (paths only — no per-file ``bytes``).
// ``mapBatchResponse`` therefore lands rows here with ``bytes === 0``
// even when the file on disk is fine, which silently no-ops the
// MIN_OK_IMAGE_BYTES gate. The renderer now closes the loop with
// ``enrichBatchRowsWithFileBytes`` (sync stat via ``electronAPI.statBytes``)
// before handing rows to ``applyBatchResult``.

test("enrichBatchRowsWithFileBytes: backfills bytes from disk for image rows missing it", async () => {
    const calls = [];
    const stat = async (path) => {
        calls.push(path);
        const sizes = { "/img/a.jpg": 250 * 1024, "/img/b.jpg": 80 * 1024 };
        return { exists: path in sizes, size: sizes[path] || 0 };
    };
    const mapped = [
        { scene_id: 1, status: "generated", image_path: "/img/a.jpg", bytes: 0 },
        { scene_id: 2, status: "generated", image_path: "/img/b.jpg", bytes: 0 },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, stat);
    assert.deepStrictEqual(calls, ["/img/a.jpg", "/img/b.jpg"]);
    assert.strictEqual(enriched[0].bytes, 250 * 1024);
    assert.strictEqual(enriched[1].bytes, 80 * 1024);
    // Caller's array must not be mutated.
    assert.strictEqual(mapped[0].bytes, 0);
    assert.strictEqual(mapped[1].bytes, 0);
});

test("enrichBatchRowsWithFileBytes: feeds applyBatchResult so the < 100 KB gate fires", async () => {
    // The bug: the renderer's old wiring used to pass rows with
    // ``bytes === 0`` straight into ``applyBatchResult``, and the
    // gate (``bytes > 0 && bytes < MIN_OK_IMAGE_BYTES``) silently
    // skipped, letting ~80 KB Grok error pages through as
    // ``generated`` and into the I2V batch. After enrichment the
    // gate fires and the row is correctly demoted to fallback.
    const stat = async () => ({ exists: true, size: 80 * 1024 });
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    const mapped = [
        { scene_id: 1, status: "generated", image_path: "/img/blank.jpg", bytes: 0 },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, stat);
    rows = helpers.applyBatchResult(rows, enriched[0].scene_id, enriched[0]);
    assert.strictEqual(rows[0].status, "fallback", "80 KB image must NOT count as generated after enrichment");
    assert.match(rows[0].reason, /80 KB/);
    assert.match(rows[0].reason, /below 100 KB/);
});

test("enrichBatchRowsWithFileBytes: leaves rows alone when bytes already known (trusted IPC path)", async () => {
    let called = 0;
    const stat = async () => { called += 1; return { exists: true, size: 1 * 1024 }; };
    const mapped = [
        { scene_id: 1, status: "generated", image_path: "/img/a.jpg", bytes: 250 * 1024 },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, stat);
    assert.strictEqual(called, 0, "stat must not be called when bytes already > 0");
    assert.strictEqual(enriched[0].bytes, 250 * 1024);
});

test("enrichBatchRowsWithFileBytes: ignores fallback / skipped / pending rows", async () => {
    let called = 0;
    const stat = async () => { called += 1; return { exists: true, size: 1024 }; };
    const mapped = [
        { scene_id: 1, status: "fallback", reason: "no usable image" },
        { scene_id: 2, status: "skipped", reason: "no prompt" },
        { scene_id: 3, status: "pending" },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, stat);
    assert.strictEqual(called, 0, "stat must not be called for non-generated rows");
    assert.deepStrictEqual(enriched, mapped, "rows are passed through untouched");
});

test("enrichBatchRowsWithFileBytes: video rows are untouched (gate is image-only)", async () => {
    let called = 0;
    const stat = async () => { called += 1; return { exists: true, size: 1024 }; };
    const mapped = [
        { scene_id: 1, status: "generated", video_path: "/v.mp4", bytes: 0 },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, stat);
    assert.strictEqual(called, 0, "video rows have no image_path so the gate doesn't apply");
    assert.deepStrictEqual(enriched, mapped);
});

test("enrichBatchRowsWithFileBytes: stat exception is swallowed; row keeps bytes=0 so gate stays opt-in", async () => {
    const stat = async () => { throw new Error("EBUSY"); };
    const mapped = [
        { scene_id: 1, status: "generated", image_path: "/img/x.jpg", bytes: 0 },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, stat);
    assert.strictEqual(enriched[0].bytes, 0, "stat error keeps row at bytes=0 (no false positive demote)");
    // applyBatchResult would then leave this row alone (bytes==0 → no
    // gate fire), preserving the legacy "trust IPC" behavior on
    // transient stat failures.
});

test("enrichBatchRowsWithFileBytes: accepts bare numeric stat return for unit-test ergonomics", async () => {
    const stat = async () => 250 * 1024;
    const mapped = [
        { scene_id: 1, status: "generated", image_path: "/img/a.jpg", bytes: 0 },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, stat);
    assert.strictEqual(enriched[0].bytes, 250 * 1024);
});

test("enrichBatchRowsWithFileBytes: missing statBytesFn → no-op (keeps legacy renderers working)", async () => {
    const mapped = [
        { scene_id: 1, status: "generated", image_path: "/img/a.jpg", bytes: 0 },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, null);
    assert.deepStrictEqual(enriched, mapped);
});

test("pairImagePathsForI2V: copies path only for settled image rows", () => {
    let imageRows = helpers.initImageRowsFromScenes(SCENES);
    imageRows = helpers.startBatchPhase(imageRows);
    imageRows = helpers.applyBatchResult(imageRows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 250_000,
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
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 250_000,
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
    rows = helpers.applyBatchResult(rows, 1, { status: "generated", attempts: 1, image_path: "/p1.png", bytes: 250000 });
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
    helpers.applyBatchResult(rows, 1, { status: "generated", attempts: 1, image_path: "/p1.png", bytes: 250000 });
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

// PR-23 — variant rows + row_id-keyed dispatch.

test("PR-23: initImageRowsFromScenes(scenes, {imagesPerScene:4}) expands each scene into 4 variant rows with unique row_id", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES, { imagesPerScene: 4 });
    // 4 scenes × 4 variants = 16 rows.
    assert.strictEqual(rows.length, 16);
    // Variants share scene_id but row_id is unique.
    const sceneOne = rows.filter((r) => r.scene_id === 1);
    assert.strictEqual(sceneOne.length, 4);
    const ids = new Set(rows.map((r) => r.row_id));
    assert.strictEqual(ids.size, 16, "row_id collisions");
    // variant_idx runs 0..N-1 within each scene.
    assert.deepStrictEqual(sceneOne.map((r) => r.variant_idx), [0, 1, 2, 3]);
    // Skipped scenes (no image_prompt) still expand into N skipped rows.
    const sceneThree = rows.filter((r) => r.scene_id === 3);
    assert.strictEqual(sceneThree.length, 4);
    assert.ok(sceneThree.every((r) => r.status === "skipped"));
});

test("PR-23: initVideoRowsFromScenes(scenes, {videosPerScene:2}) expands per scene", () => {
    const rows = helpers.initVideoRowsFromScenes(SCENES, { videosPerScene: 2 });
    // 4 scenes × 2 = 8 rows.
    assert.strictEqual(rows.length, 8);
    const sceneTwo = rows.filter((r) => r.scene_id === 2);
    assert.strictEqual(sceneTwo.length, 2);
    // video_prompt precedence preserved across variants.
    assert.ok(sceneTwo.every((r) => r.prompt === "v2"));
    const ids = new Set(rows.map((r) => r.row_id));
    assert.strictEqual(ids.size, 8);
});

test("PR-23: applyBatchProgress matches by row_id (no bleed across variants)", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES.slice(0, 2), { imagesPerScene: 3 });
    let next = helpers.startBatchPhase(rows);
    next = helpers.applyBatchProgress(next, "1#1", { progress: 50 });
    const sceneOneVariants = next.filter((r) => r.scene_id === 1);
    // Only variant 1 advanced. Variants 0 and 2 stay at 0.
    assert.strictEqual(sceneOneVariants[0].progress, 0);
    assert.strictEqual(sceneOneVariants[1].progress, 50);
    assert.strictEqual(sceneOneVariants[2].progress, 0);
});

test("PR-23: applyBatchResult settles only the targeted variant row", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 4 });
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, "1#2", { status: "generated", image_path: "/v2.png" });
    assert.strictEqual(rows[0].status, "generating");
    assert.strictEqual(rows[1].status, "generating");
    assert.strictEqual(rows[2].status, "generated");
    assert.strictEqual(rows[2].image_path, "/v2.png");
    assert.strictEqual(rows[3].status, "generating");
});

test("PR-23: applyBatchProgress falls back to scene_id broadcast when no row_id matches", () => {
    // Legacy table — rows have row_id but the caller passes scene_id only.
    const rows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 3 });
    const started = helpers.startBatchPhase(rows);
    // Pass the scene_id (which doesn't match any row_id directly) → all
    // 3 variants of scene 1 should get the progress event.
    const next = helpers.applyBatchProgress(started, "1", { progress: 25 });
    assert.deepStrictEqual(next.map((r) => r.progress), [25, 25, 25]);
});

test("PR-23: planImageGenerate emits row_ids in lock-step with prompts", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES.slice(0, 2), { imagesPerScene: 2 });
    const plan = helpers.planImageGenerate(rows);
    assert.strictEqual(plan.prompts.length, 4); // 2 scenes × 2 variants
    assert.strictEqual(plan.rowIds.length, 4);
    assert.strictEqual(plan.sceneIds.length, 4);
    assert.deepStrictEqual(plan.rowIds, ["1#0", "1#1", "2#0", "2#1"]);
});

test("PR-23: planVideoGenerate t2v + i2v emit row_ids and skipped rows carry row_id", () => {
    // T2V — every row with a prompt is eligible (variants share prompt).
    let rows = helpers.initVideoRowsFromScenes(SCENES, { videosPerScene: 2 });
    let plan = helpers.planVideoGenerate(rows, "t2v");
    assert.strictEqual(plan.rowIds.length, plan.prompts.length);
    assert.ok(plan.skipped.every((s) => s.row_id != null));
    // I2V — without paired image_path every variant is skipped with row_id set.
    rows = helpers.initVideoRowsFromScenes(SCENES, { videosPerScene: 2 });
    plan = helpers.planVideoGenerate(rows, "i2v");
    assert.strictEqual(plan.items, plan.items); // shape ok
    assert.ok(plan.skipped.every((s) => s.row_id != null));
});

test("PR-23: mapBatchResponse forwards row_id when rowIds[] is supplied", () => {
    const sceneIds = [1, 1, 2, 2];
    const rowIds = ["1#0", "1#1", "2#0", "2#1"];
    const resp = {
        success: true,
        results: [
            { savedFiles: ["/a.png"] },
            { savedFiles: ["/b.png"] },
            { error: "rate limit" },
            { savedFiles: ["/d.png"] },
        ],
    };
    const out = helpers.mapBatchResponse(resp, sceneIds, "image", rowIds);
    assert.strictEqual(out.length, 4);
    assert.deepStrictEqual(out.map((r) => r.row_id), rowIds);
    assert.strictEqual(out[0].status, "generated");
    assert.strictEqual(out[2].status, "fallback");
});

test("PR-23: pairImagePathsForI2V picks lowest variant_idx that settled per scene", () => {
    // 1 scene × 3 image variants; only variant 1 settled.
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 3 });
    imageRows = helpers.applyBatchResult(imageRows, "1#1", {
        status: "generated", image_path: "/img-v1.png",
    });
    // Now also settle variant 0 — pair should switch to variant 0
    // (lowest variant_idx wins).
    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 2 });
    let paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired[0].image_path, "/img-v1.png");
    imageRows = helpers.applyBatchResult(imageRows, "1#0", {
        status: "generated", image_path: "/img-v0.png",
    });
    paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired[0].image_path, "/img-v0.png");
});

test("PR-23: legacy initImageRowsFromScenes(scenes) (no opts) returns 1 row per scene with row_id set", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES);
    assert.strictEqual(rows.length, 4); // one per scene
    assert.ok(rows.every((r) => r.row_id != null));
    // variant_idx is 0 across the board.
    assert.ok(rows.every((r) => r.variant_idx === 0));
});

// ─── PR-24 ─────────────────────────────────────────────────────────
test("PR-24: buildVariantTotals counts variants per scene_id", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES, { imagesPerScene: 4 });
    const totals = helpers.buildVariantTotals(rows);
    assert.strictEqual(totals.get("1"), 4);
    assert.strictEqual(totals.get("2"), 4);
    assert.strictEqual(totals.get("3"), 4);
    assert.strictEqual(totals.get("4"), 4);
});

test("PR-24: buildVariantTotals returns 1 per scene for legacy single-row tables", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES);
    const totals = helpers.buildVariantTotals(rows);
    for (const id of ["1", "2", "3", "4"]) {
        assert.strictEqual(totals.get(id), 1);
    }
});

test("PR-24: buildVariantTotals tolerates null / missing scene_id rows", () => {
    const totals = helpers.buildVariantTotals([
        { scene_id: 7, variant_idx: 0 },
        { scene_id: 7, variant_idx: 1 },
        { scene_id: null, variant_idx: 0 },
        null, // junk row — must not throw
    ]);
    assert.strictEqual(totals.get("7"), 2);
    // scene_id=null still gets bucketed under "" so the renderer can
    // still find a count for it.
    assert.strictEqual(totals.get(""), 2); // null row + scene_id:null both
});

test("PR-24: formatVariantLabel emits 'scene N · variant K/M' for multi-variant scenes", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES, { imagesPerScene: 4 });
    const totals = helpers.buildVariantTotals(rows);
    assert.strictEqual(helpers.formatVariantLabel(rows[0], totals), "scene 1 · variant 1/4");
    assert.strictEqual(helpers.formatVariantLabel(rows[1], totals), "scene 1 · variant 2/4");
    assert.strictEqual(helpers.formatVariantLabel(rows[3], totals), "scene 1 · variant 4/4");
    assert.strictEqual(helpers.formatVariantLabel(rows[4], totals), "scene 2 · variant 1/4");
});

test("PR-24: formatVariantLabel omits the variant tag for legacy 1-row-per-scene tables", () => {
    const rows = helpers.initImageRowsFromScenes(SCENES);
    const totals = helpers.buildVariantTotals(rows);
    // total == 1 → no variant tag, label is plain "scene N".
    for (const r of rows) {
        const lbl = helpers.formatVariantLabel(r, totals);
        assert.ok(!lbl.includes("variant"), `unexpected variant tag in legacy label: ${lbl}`);
        assert.match(lbl, /^scene \d/);
    }
});

test("PR-24: formatVariantLabel falls back to '?' when scene_id is missing entirely", () => {
    const totals = new Map();
    const lbl = helpers.formatVariantLabel({ variant_idx: 0 }, totals);
    assert.strictEqual(lbl, "scene ?");
});

// ─── PR-26: per-variant image_prompts[] from the LLM expander ──────────

test("PR-26: initImageRowsFromScenes consumes image_prompts[] when present", () => {
    // /producer/scene_breakdown with images_per_scene=3 returns scenes
    // carrying an `image_prompts` tuple. Each row must pick its variant
    // entry instead of repeating the singular `image_prompt`.
    const scenes = [
        {
            scene_id: 1,
            title: "factory",
            image_prompt: "Wide factory floor at dawn. (legacy fallback)",
            image_prompts: [
                "Aerial wide of the factory at dawn, anamorphic lens.",
                "Macro close-up on rivets along the conveyor belt.",
                "Low-angle hero shot of the foreman, sun behind.",
            ],
            duration_s: 5,
        },
    ];
    const rows = helpers.initImageRowsFromScenes(scenes, { imagesPerScene: 3 });
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].prompt, "Aerial wide of the factory at dawn, anamorphic lens.");
    assert.strictEqual(rows[1].prompt, "Macro close-up on rivets along the conveyor belt.");
    assert.strictEqual(rows[2].prompt, "Low-angle hero shot of the foreman, sun behind.");
    // Status must be `pending` for all 3 (none of the variants are blank).
    rows.forEach((r) => assert.strictEqual(r.status, "pending"));
});

test("PR-26: initImageRowsFromScenes falls back to image_prompt when image_prompts is shorter than imagesPerScene", () => {
    // Asking for 4 variants but the LLM only returned 2 — the legacy
    // singular field must fill the remainder so we don't end up with
    // phantom blank rows that get marked as skipped.
    const scenes = [
        {
            scene_id: 7,
            title: "underflow",
            image_prompt: "Fallback prompt body.",
            image_prompts: ["Variant A.", "Variant B."],
        },
    ];
    const rows = helpers.initImageRowsFromScenes(scenes, { imagesPerScene: 4 });
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].prompt, "Variant A.");
    assert.strictEqual(rows[1].prompt, "Variant B.");
    // Variants 2 & 3 fall back to the singular field rather than being
    // marked skipped.
    assert.strictEqual(rows[2].prompt, "Fallback prompt body.");
    assert.strictEqual(rows[3].prompt, "Fallback prompt body.");
    rows.forEach((r) => assert.strictEqual(r.status, "pending"));
});

test("PR-26: initImageRowsFromScenes ignores empty/whitespace entries in image_prompts", () => {
    const scenes = [
        {
            scene_id: 9,
            image_prompt: "Singular prompt.",
            image_prompts: ["", "   ", "Real variant."],
        },
    ];
    const rows = helpers.initImageRowsFromScenes(scenes, { imagesPerScene: 3 });
    // Empty/whitespace variant entries fall back to the singular
    // prompt instead of producing skipped rows.
    assert.strictEqual(rows[0].prompt, "Singular prompt.");
    assert.strictEqual(rows[1].prompt, "Singular prompt.");
    assert.strictEqual(rows[2].prompt, "Real variant.");
    rows.forEach((r) => assert.strictEqual(r.status, "pending"));
});

test("PR-26: legacy scenes without image_prompts behave identically (no regression)", () => {
    // Same inputs as the PR-23 expansion test but no image_prompts
    // tuple — must produce the same rows.length (2 scenes × 2 variants
    // = 4) and repeat the singular prompt across all variants.
    const scenes = [
        { scene_id: 1, image_prompt: "p1", duration_s: 1 },
        { scene_id: 2, image_prompt: "p2", duration_s: 1 },
    ];
    const rows = helpers.initImageRowsFromScenes(scenes, { imagesPerScene: 2 });
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].prompt, "p1");
    assert.strictEqual(rows[1].prompt, "p1");
    assert.strictEqual(rows[2].prompt, "p2");
    assert.strictEqual(rows[3].prompt, "p2");
});

// ── PR-27: bulk selection + inline edit + delete + re-roll ────────────

function pr27Rows() {
    // Two scenes, 2 variants each → 4 rows. Mix statuses so the
    // helpers' status guards have something to bite on.
    const scenes = [
        { scene_id: 1, image_prompt: "scene1 base", duration_s: 3 },
        { scene_id: 2, image_prompt: "scene2 base", duration_s: 4 },
    ];
    const rows = helpers.initImageRowsFromScenes(scenes, { imagesPerScene: 2 });
    // rows[0]/[1] → scene 1 variant 0/1, rows[2]/[3] → scene 2 variant 0/1.
    rows[1].status = "generating";
    rows[1].progress = 30;
    rows[2].status = "generated";
    rows[2].image_path = "/tmp/scene2v0.png";
    return rows;
}

test("PR-27: toggleRowSelection adds, then removes; never mutates input", () => {
    const a = new Set();
    const b = helpers.toggleRowSelection(a, "1#0");
    assert.strictEqual(a.size, 0, "input must not be mutated");
    assert.ok(b.has("1#0"));
    const c = helpers.toggleRowSelection(b, "1#0");
    assert.ok(!c.has("1#0"));
});

test("PR-27: toggleRowSelection ignores null/empty row_id", () => {
    const a = helpers.toggleRowSelection(new Set(["1#0"]), null);
    assert.deepStrictEqual([...a], ["1#0"]);
    const b = helpers.toggleRowSelection(new Set(["1#0"]), "");
    assert.deepStrictEqual([...b], ["1#0"]);
});

test("PR-27: selectAllRowIds returns every row_id, including settled / generating rows", () => {
    const sel = helpers.selectAllRowIds(pr27Rows());
    assert.deepStrictEqual([...sel].sort(), ["1#0", "1#1", "2#0", "2#1"]);
});

test("PR-27: reconcileSelection drops row_ids no longer in the table (after delete)", () => {
    const rows = helpers.removeRows(pr27Rows(), ["1#0", "2#1"]);
    const sel = new Set(["1#0", "1#1", "2#0", "2#1", "stale#0"]);
    const out = helpers.reconcileSelection(sel, rows);
    assert.deepStrictEqual([...out].sort(), ["1#1", "2#0"]);
});

test("PR-27: canEditRow allows pending/skipped/fallback, blocks generating/generated/retried", () => {
    assert.strictEqual(helpers.canEditRow({ status: "pending" }), true);
    assert.strictEqual(helpers.canEditRow({ status: "skipped" }), true);
    assert.strictEqual(helpers.canEditRow({ status: "fallback" }), true);
    assert.strictEqual(helpers.canEditRow({ status: "generating" }), false);
    assert.strictEqual(helpers.canEditRow({ status: "generated" }), false);
    assert.strictEqual(helpers.canEditRow({ status: "retried" }), false);
    assert.strictEqual(helpers.canEditRow(null), false);
});

test("PR-27: canDeleteRow allows every status (soft cancel for generating)", () => {
    for (const s of ["pending", "skipped", "fallback", "generating", "generated", "retried"]) {
        assert.strictEqual(helpers.canDeleteRow({ status: s }), true, `status=${s}`);
    }
    assert.strictEqual(helpers.canDeleteRow(null), false);
});

test("PR-27: removeRows drops only matching row_ids, preserves order, returns a new array", () => {
    const rows = pr27Rows();
    const out = helpers.removeRows(rows, ["1#1", "2#0"]);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map((r) => r.row_id), ["1#0", "2#1"]);
    // Input untouched.
    assert.strictEqual(rows.length, 4);
    // Empty / non-array inputs are safe.
    assert.deepStrictEqual(helpers.removeRows(null, ["1#0"]), []);
    assert.deepStrictEqual(helpers.removeRows([], ["1#0"]), []);
    // Empty removeIds → identity slice (same content, different array).
    const noop = helpers.removeRows(rows, []);
    assert.notStrictEqual(noop, rows);
    assert.strictEqual(noop.length, rows.length);
});

test("PR-27: updatePromptForRow rewrites prompt + flips skipped→pending, blocks settled/generating rows", () => {
    let rows = pr27Rows();
    rows = helpers.updatePromptForRow(rows, "1#0", "  new prompt 1  ");
    assert.strictEqual(rows[0].prompt, "new prompt 1");
    assert.strictEqual(rows[0].status, "pending");
    // Generating row (1#1) must not be edited.
    rows = helpers.updatePromptForRow(rows, "1#1", "should-not-apply");
    assert.strictEqual(rows[1].prompt, "scene1 base");
    assert.strictEqual(rows[1].status, "generating");
    // Generated row (2#0) must not be edited.
    rows = helpers.updatePromptForRow(rows, "2#0", "should-not-apply-either");
    assert.strictEqual(rows[2].prompt, "scene2 base");
    assert.strictEqual(rows[2].status, "generated");
});

test("PR-27: updatePromptForRow promotes fallback → pending after fresh prompt edit (Devin Review fix)", () => {
    const rows = helpers.initImageRowsFromScenes([
        { scene_id: 1, image_prompt: "old prompt", duration_s: 1 },
    ], { imagesPerScene: 1 });
    rows[0].status = "fallback";
    rows[0].reason = "Grok rate-limited";
    rows[0].attempts = 2;
    const out = helpers.updatePromptForRow(rows, "1#0", "fresh prompt");
    assert.strictEqual(out[0].prompt, "fresh prompt");
    assert.strictEqual(out[0].status, "pending", "fallback row must flip to pending so the next batch picks it up");
    assert.strictEqual(out[0].reason, null);
    // Attempts counter is preserved — it's the LLM's history, not the prompt's.
    assert.strictEqual(out[0].attempts, 2);
});

test("PR-27: applyVariantPrompts promotes fallback → pending too (Devin Review fix)", () => {
    const rows = helpers.initImageRowsFromScenes([
        { scene_id: 5, image_prompt: "base", duration_s: 1 },
    ], { imagesPerScene: 2 });
    rows[0].status = "fallback";
    rows[0].reason = "Grok timeout";
    rows[1].status = "pending";
    const out = helpers.applyVariantPrompts(rows, 5, ["new-v0", "new-v1"]);
    // Variant 0 (was fallback) → flipped to pending with the new prompt.
    assert.strictEqual(out[0].prompt, "new-v0");
    assert.strictEqual(out[0].status, "pending");
    assert.strictEqual(out[0].reason, null);
    // Variant 1 (was pending) → stays pending with the new prompt.
    assert.strictEqual(out[1].prompt, "new-v1");
    assert.strictEqual(out[1].status, "pending");
});

test("PR-27: updatePromptForRow with empty string falls back to skipped", () => {
    const rows = helpers.initImageRowsFromScenes([
        { scene_id: 1, image_prompt: "x", duration_s: 1 },
    ], { imagesPerScene: 1 });
    const out = helpers.updatePromptForRow(rows, "1#0", "   ");
    assert.strictEqual(out[0].prompt, "");
    assert.strictEqual(out[0].status, "skipped");
    assert.match(out[0].reason || "", /image_prompt/);
});

test("PR-27: applyVariantPrompts replaces editable variants in variant_idx order", () => {
    const rows = pr27Rows();
    // scene 1 has 1#0 (pending) + 1#1 (generating). Re-roll should
    // touch only 1#0 (variant 0) and skip 1#1 (in-flight).
    const out = helpers.applyVariantPrompts(rows, 1, ["fresh-v0", "fresh-v1"]);
    assert.strictEqual(out[0].prompt, "fresh-v0");
    assert.strictEqual(out[0].status, "pending");
    assert.strictEqual(out[1].prompt, "scene1 base", "generating row must not be re-rolled");
    assert.strictEqual(out[1].status, "generating");
});

test("PR-27: applyVariantPrompts no-op when newPrompts is empty / non-array", () => {
    const rows = pr27Rows();
    assert.strictEqual(helpers.applyVariantPrompts(rows, 1, []).length, rows.length);
    assert.strictEqual(helpers.applyVariantPrompts(rows, 1, null).length, rows.length);
    // Reference inequality (returns a fresh array) but content equal.
    const out = helpers.applyVariantPrompts(rows, 1, []);
    assert.notStrictEqual(out, rows);
    assert.deepStrictEqual(out.map((r) => r.prompt), rows.map((r) => r.prompt));
});

test("PR-27: summarizeSelection counts editable vs deletable + tracks scenes touched", () => {
    const rows = pr27Rows();
    const sel = new Set(["1#0", "1#1", "2#0", "2#1"]);
    const s = helpers.summarizeSelection(rows, sel);
    assert.strictEqual(s.total, 4);
    // Editable: 1#0 (pending) + 2#1 (pending) = 2; 1#1 generating, 2#0 generated.
    assert.strictEqual(s.editable, 2);
    // Deletable: every row in selection.
    assert.strictEqual(s.deletable, 4);
    assert.strictEqual(s.inFlight, 1, "1#1 is generating");
    assert.deepStrictEqual([...s.scenes].sort(), ["1", "2"]);
});

test("PR-27: summarizeSelection ignores stale row_ids no longer in the table", () => {
    const rows = pr27Rows();
    const sel = new Set(["1#0", "deleted#9"]);
    const s = helpers.summarizeSelection(rows, sel);
    // ``total`` reflects the size of the selection (not eligibility),
    // so the stale entry contributes — but editable / deletable count
    // only rows actually in ``rows``.
    assert.strictEqual(s.total, 2);
    assert.strictEqual(s.editable, 1);
    assert.strictEqual(s.deletable, 1);
});

// =====================================================================
// PR-28 — reference image resolver / partition / refimg:generate plan
// =====================================================================

function pr28Rows() {
    // 2 scenes × 2 variants = 4 rows. row_id encoding: "<scene>#<variant>".
    return helpers.initImageRowsFromScenes([
        { scene_id: 1, image_prompt: "hero cafe", duration_s: 2 },
        { scene_id: 2, image_prompt: "night skyline", duration_s: 2 },
    ], { imagesPerScene: 2 });
}

test("PR-28: resolveRefsForRow — per-row override beats global defaults", () => {
    const row = { row_id: "1#0", scene_id: 1 };
    const global = ["/refs/global-char.png"];
    const rowMap = { "1#0": ["/refs/scene1-char.png"] };
    const resolved = helpers.resolveRefsForRow(row, rowMap, global);
    assert.deepStrictEqual(resolved, ["/refs/scene1-char.png"]);
});

test("PR-28: resolveRefsForRow — falls back to global when row has no override", () => {
    const row = { row_id: "2#1", scene_id: 2 };
    const resolved = helpers.resolveRefsForRow(row, {}, ["/refs/g1.png", "/refs/g2.png"]);
    assert.deepStrictEqual(resolved, ["/refs/g1.png", "/refs/g2.png"]);
});

test("PR-28: resolveRefsForRow — empty override array still hands through to global", () => {
    // An empty override should NOT shadow the global — the user probably cleared the override.
    const row = { row_id: "1#0", scene_id: 1 };
    const resolved = helpers.resolveRefsForRow(row, { "1#0": [] }, ["/refs/global.png"]);
    assert.deepStrictEqual(resolved, ["/refs/global.png"]);
});

test("PR-28: resolveRefsForRow — de-dupes and trims whitespace from the chosen list", () => {
    const row = { row_id: "1#0", scene_id: 1 };
    const resolved = helpers.resolveRefsForRow(row, null, ["/refs/a.png", "  /refs/a.png  ", "/refs/b.png", ""]);
    assert.deepStrictEqual(resolved, ["/refs/a.png", "/refs/b.png"]);
});

test("PR-28: resolveRefsForRow — accepts Map as rowRefMap (not just plain object)", () => {
    const row = { row_id: "1#0", scene_id: 1 };
    const map = new Map([["1#0", ["/refs/from-map.png"]]]);
    const resolved = helpers.resolveRefsForRow(row, map, ["/refs/global.png"]);
    assert.deepStrictEqual(resolved, ["/refs/from-map.png"]);
});

test("PR-28: resolveRefsForRow — defends against missing row / null inputs", () => {
    assert.deepStrictEqual(helpers.resolveRefsForRow(null, null, null), []);
    assert.deepStrictEqual(helpers.resolveRefsForRow({}, null, null), []);
    assert.deepStrictEqual(helpers.resolveRefsForRow({ row_id: "1#0" }, null, null), []);
});

test("PR-28: partitionRowsByRefs — splits rows cleanly into withRefs / withoutRefs", () => {
    const rows = pr28Rows();
    const rowMap = { "1#0": ["/refs/scene1.png"] };
    const globalRefs = [];
    const out = helpers.partitionRowsByRefs(rows, { rowRefMap: rowMap, globalRefs });
    assert.strictEqual(out.withRefs.length, 1, "only row 1#0 has an override → one row in withRefs");
    assert.strictEqual(out.withRefs[0].row_id, "1#0");
    assert.strictEqual(out.withoutRefs.length, 3, "rest go into the plain image:generate bucket");
});

test("PR-28: partitionRowsByRefs — global refs put every row into withRefs", () => {
    const rows = pr28Rows();
    const out = helpers.partitionRowsByRefs(rows, {
        rowRefMap: null,
        globalRefs: ["/refs/char.png"],
    });
    assert.strictEqual(out.withRefs.length, rows.length, "a global ref routes every row through refimg:generate");
    assert.strictEqual(out.withoutRefs.length, 0);
});

test("PR-28: planRefImageGenerate — emits RefImageService.generateBatch items shape", () => {
    const rows = pr28Rows();
    const plan = helpers.planRefImageGenerate(rows, {
        rowRefMap: { "2#1": ["/refs/scene2-alt.png"] },
        globalRefs: ["/refs/char.png"],
    });
    // All 4 rows have prompts + refs → 4 items.
    assert.strictEqual(plan.items.length, 4);
    // Row 2#1 uses its override; the other rows use the global.
    const forScene2Var1 = plan.items[plan.rowIds.indexOf("2#1")];
    assert.deepStrictEqual(forScene2Var1.refImagePaths, ["/refs/scene2-alt.png"]);
    const forScene1Var0 = plan.items[plan.rowIds.indexOf("1#0")];
    assert.deepStrictEqual(forScene1Var0.refImagePaths, ["/refs/char.png"]);
    // Prompt + row_id + scene_id arrays run in lock-step.
    assert.strictEqual(plan.sceneIds.length, plan.items.length);
    assert.strictEqual(plan.rowIds.length, plan.items.length);
    // prompt text comes through unchanged.
    for (const item of plan.items) {
        assert.ok(typeof item.prompt === "string" && item.prompt.length > 0);
    }
});

test("PR-28: planRefImageGenerate — skips rows with status=skipped or empty prompt", () => {
    const rows = pr28Rows();
    rows[0].status = "skipped";
    rows[0].prompt = "";
    rows[0].reason = "missing image_prompt";
    const plan = helpers.planRefImageGenerate(rows, {
        rowRefMap: null,
        globalRefs: ["/refs/char.png"],
    });
    assert.strictEqual(plan.items.length, 3, "skipped row excluded — only 3 eligible items remain");
    assert.ok(!plan.rowIds.includes("1#0"), "row_id of the skipped row must not appear in plan.rowIds");
});

test("PR-28: planRefImageGenerate — excludes rows with no resolved refs (they take image:generate path)", () => {
    const rows = pr28Rows();
    const plan = helpers.planRefImageGenerate(rows, {
        rowRefMap: { "1#0": ["/refs/only-this.png"] },
        globalRefs: [],
    });
    // Only 1#0 has refs → only 1 item.
    assert.strictEqual(plan.items.length, 1);
    assert.strictEqual(plan.rowIds[0], "1#0");
    assert.deepStrictEqual(plan.items[0].refImagePaths, ["/refs/only-this.png"]);
});

test("PR-28: planRefImageGenerate — no refs anywhere returns an empty plan", () => {
    const rows = pr28Rows();
    const plan = helpers.planRefImageGenerate(rows, { rowRefMap: null, globalRefs: null });
    assert.strictEqual(plan.items.length, 0);
    assert.strictEqual(plan.rowIds.length, 0);
    assert.strictEqual(plan.sceneIds.length, 0);
});

test("PR-28: planRefImageGenerate + planImageGenerate are complementary — no overlap, no loss", () => {
    // The renderer's contract: partition the rows by refs, then feed
    // planRefImageGenerate to withRefs and planImageGenerate to
    // withoutRefs. Every eligible row appears exactly once across the
    // two plans.
    const rows = pr28Rows();
    const opts = {
        rowRefMap: { "1#0": ["/refs/a.png"], "2#0": ["/refs/b.png"] },
        globalRefs: [],
    };
    const split = helpers.partitionRowsByRefs(rows, opts);
    const refPlan = helpers.planRefImageGenerate(split.withRefs, opts);
    const plainPlan = helpers.planImageGenerate(split.withoutRefs);
    const allRowIds = [...refPlan.rowIds, ...plainPlan.rowIds].sort();
    const expected = rows
        .filter((r) => r.status !== "skipped" && r.prompt)
        .map((r) => r.row_id)
        .sort();
    assert.deepStrictEqual(allRowIds, expected, "every eligible row must appear in exactly one of the two plans");
});

test("PR-27: applyBatchProgress / applyBatchResult silently no-op for deleted rows", () => {
    let rows = pr27Rows();
    rows = helpers.removeRows(rows, ["1#1"]);
    // Late progress event for the deleted row_id must not crash and
    // must not resurrect the row.
    rows = helpers.applyBatchProgress(rows, "1#1", { progress: 90 });
    assert.strictEqual(rows.find((r) => r.row_id === "1#1"), undefined);
    rows = helpers.applyBatchResult(rows, "1#1", { status: "generated", image_path: "/tmp/x.png" });
    assert.strictEqual(rows.find((r) => r.row_id === "1#1"), undefined);
});

// ─── PR-29: filterRowsBySelection + improved fallback reason ───────────

test("PR-29: filterRowsBySelection — keeps only rows whose row_id is in the selection set", () => {
    const rows = pr27Rows();
    // pr27Rows() yields scene 1 variants 0/1, scene 2 variants 0/1.
    const selected = new Set(["1#0", "2#1"]);
    const out = helpers.filterRowsBySelection(rows, selected);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map((r) => r.row_id).sort(), ["1#0", "2#1"]);
    // Order from the input is preserved.
    assert.strictEqual(out[0].row_id, "1#0");
    assert.strictEqual(out[1].row_id, "2#1");
});

test("PR-29: filterRowsBySelection — empty selection returns empty array (no fallback to generate-all)", () => {
    const rows = pr27Rows();
    assert.deepStrictEqual(helpers.filterRowsBySelection(rows, new Set()), []);
    assert.deepStrictEqual(helpers.filterRowsBySelection(rows, []), []);
    assert.deepStrictEqual(helpers.filterRowsBySelection(rows, null), []);
    assert.deepStrictEqual(helpers.filterRowsBySelection(rows, undefined), []);
});

test("PR-29: filterRowsBySelection — accepts any iterable, not just Set", () => {
    const rows = pr27Rows();
    // Plain array.
    const fromArray = helpers.filterRowsBySelection(rows, ["1#0"]);
    assert.deepStrictEqual(fromArray.map((r) => r.row_id), ["1#0"]);
    // Numbers stringify so a row_id of "5" matches a selection of 5.
    const numericRows = [
        { row_id: "5", scene_id: 5, status: "pending", prompt: "p", reason: null, attempts: 0, progress: 0 },
    ];
    const fromNumbers = helpers.filterRowsBySelection(numericRows, [5]);
    assert.deepStrictEqual(fromNumbers.map((r) => r.row_id), ["5"]);
});

test("PR-29: filterRowsBySelection — does not mutate inputs", () => {
    const rows = pr27Rows();
    const before = JSON.stringify(rows);
    const selected = new Set(["1#0"]);
    const beforeSel = new Set(selected);
    helpers.filterRowsBySelection(rows, selected);
    assert.strictEqual(JSON.stringify(rows), before);
    assert.deepStrictEqual([...selected].sort(), [...beforeSel].sort());
});

test("PR-29: filterRowsBySelection — defends against null rows / missing row_id", () => {
    assert.deepStrictEqual(helpers.filterRowsBySelection(null, ["x"]), []);
    assert.deepStrictEqual(helpers.filterRowsBySelection(undefined, ["x"]), []);
    assert.deepStrictEqual(
        helpers.filterRowsBySelection([null, { row_id: null }, { row_id: "ok" }], ["ok"]),
        [{ row_id: "ok" }],
    );
});

test("PR-29: filterRowsBySelection composes with planImageGenerate (selection-aware Generate)", () => {
    const rows = pr27Rows();
    const selected = new Set(["1#0", "2#0"]);
    const subset = helpers.filterRowsBySelection(rows, selected);
    const plan = helpers.planImageGenerate(subset);
    // Both selected rows have prompts, so both land in the plan.
    assert.strictEqual(plan.prompts.length, 2);
    assert.deepStrictEqual(plan.rowIds.sort(), ["1#0", "2#0"]);
});

// ─── PR-46: "Generate all (N)" fallback when nothing selected ───────────
// PR-29 originally disabled the Generate button when no rows were
// checked. Live testing showed users hit the button (the panel
// hint even tells them to click it after pairing an image) and
// got nothing. PR-46 routes empty-selection through
// ``selectAllRowIds`` so the call path silently degrades to
// "generate every row" — same effect as the user clicking
// "Select all" first. The pure helpers must compose cleanly for
// that path to work.

test("PR-46: empty-selection Generate falls back to selectAllRowIds (every row picked up)", () => {
    const rows = pr27Rows();
    // Caller pattern from sbbGenerateImages / sbbGenerateVideos:
    // when the user's selection Set is empty, fall back to
    // ``selectAllRowIds`` and feed it through filterRowsBySelection.
    // This must yield every row, in input order, with no losses.
    const fallback = helpers.selectAllRowIds(rows);
    const subset = helpers.filterRowsBySelection(rows, fallback);
    assert.strictEqual(subset.length, rows.length,
        "fallback must include every row when nothing is explicitly selected");
    assert.deepStrictEqual(
        subset.map((r) => r.row_id),
        rows.map((r) => r.row_id),
        "fallback must preserve input order",
    );
});

test("PR-46: empty-selection fallback still partitions by refs (mixed rowRefMap / global refs)", () => {
    // Sanity-check that the empty-selection path doesn't break
    // PR-28 ref-image partitioning. A user with a global ref
    // image who hits "Generate all" without selecting anything
    // should still see the ref payload on every row.
    const rows = pr27Rows();
    const fallback = helpers.selectAllRowIds(rows);
    const subset = helpers.filterRowsBySelection(rows, fallback);
    const split = helpers.partitionRowsByRefs(subset, {
        rowRefMap: {},
        globalRefs: ["/abs/global-ref.png"],
    });
    // With a non-empty global, every row goes through the ref path.
    assert.strictEqual(split.withRefs.length, rows.length);
    assert.strictEqual(split.withoutRefs.length, 0);
});

test("PR-29: mapBatchResponse — image with no error gives an actionable hint instead of 'no usable image'", () => {
    const resp = { success: true, results: [{ savedFiles: [], success: false, error: null }] };
    const mapped = helpers.mapBatchResponse(resp, [42], "image", ["42#0"]);
    assert.strictEqual(mapped.length, 1);
    assert.strictEqual(mapped[0].status, "fallback");
    assert.match(mapped[0].reason, /moderated|rate-limited|session/i,
        "fallback reason must point the user at the likely cause");
    assert.notStrictEqual(mapped[0].reason, "no usable image",
        "the unhelpful default must not survive when the IPC didn't supply an error");
});

test("PR-29: mapBatchResponse — explicit error from the service still wins over the default hint", () => {
    const resp = { success: true, results: [{ savedFiles: [], success: false, error: "403 Forbidden — re-login failed" }] };
    const mapped = helpers.mapBatchResponse(resp, [1], "image", ["1#0"]);
    assert.strictEqual(mapped[0].status, "fallback");
    assert.strictEqual(mapped[0].reason, "403 Forbidden — re-login failed");
});

test("PR-29: mapBatchResponse — empty/whitespace error string falls back to the actionable hint", () => {
    const resp = { success: true, results: [{ savedFiles: [], success: false, error: "   " }] };
    const mapped = helpers.mapBatchResponse(resp, [1], "image", ["1#0"]);
    assert.match(mapped[0].reason, /moderated|rate-limited|session/i);
});

test("PR-29: mapBatchResponse — video with no error gets its own actionable hint", () => {
    const resp = { success: true, results: [{ success: false, error: null }] };
    const mapped = helpers.mapBatchResponse(resp, [7], "video", ["7#0"]);
    assert.strictEqual(mapped[0].status, "fallback");
    assert.match(mapped[0].reason, /moderated|rate-limited|session|no output/i);
    assert.notStrictEqual(mapped[0].reason, "video generation failed");
});

// ─── PR-48 ─────────────────────────────────────────────────────────

test("PR-48: initVideoRowsFromScenes uses video_prompts[v] for each variant when array is present", () => {
    const scenes = [{
        scene_id: 1,
        title: "coffee",
        flow_video_prompt: "scene-level fallback",
        video_prompts: [
            "Camera dollies from wide framing.",
            "Tilt up from low-angle.",
            "Glide past shoulder.",
        ],
        duration_s: 4,
    }];
    const rows = helpers.initVideoRowsFromScenes(scenes, { videosPerScene: 3 });
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].prompt, "Camera dollies from wide framing.");
    assert.strictEqual(rows[1].prompt, "Tilt up from low-angle.");
    assert.strictEqual(rows[2].prompt, "Glide past shoulder.");
    // Each variant is "pending" not "skipped" because its prompt is non-empty.
    assert.ok(rows.every((r) => r.status === "pending"));
});

test("PR-48: initVideoRowsFromScenes accepts flow_video_prompts as alias for video_prompts", () => {
    const scenes = [{
        scene_id: 1,
        flow_video_prompt: "fallback",
        flow_video_prompts: ["A motion", "B motion", "C motion"],
        duration_s: 3,
    }];
    const rows = helpers.initVideoRowsFromScenes(scenes, { videosPerScene: 3 });
    assert.deepStrictEqual(
        rows.map((r) => r.prompt),
        ["A motion", "B motion", "C motion"],
    );
});

test("PR-48: initVideoRowsFromScenes falls back to scene-level prompt when variant array is shorter than count", () => {
    const scenes = [{
        scene_id: 1,
        flow_video_prompt: "fallback motion",
        video_prompts: ["only first variant"],
        duration_s: 3,
    }];
    const rows = helpers.initVideoRowsFromScenes(scenes, { videosPerScene: 3 });
    assert.strictEqual(rows[0].prompt, "only first variant");
    // Missing variants 1 and 2 fall back — must not be empty/skipped.
    assert.strictEqual(rows[1].prompt, "fallback motion");
    assert.strictEqual(rows[2].prompt, "fallback motion");
    assert.ok(rows.every((r) => r.status === "pending"));
});

test("PR-48: initVideoRowsFromScenes back-compat — scenes without variant arrays still use scene-level prompt", () => {
    const scenes = [
        { scene_id: 1, flow_video_prompt: "old style", duration_s: 3 },
        { scene_id: 2, video_prompt: "old style 2", duration_s: 2 },
    ];
    const rows = helpers.initVideoRowsFromScenes(scenes, { videosPerScene: 2 });
    assert.strictEqual(rows.length, 4);
    // Both variants of scene 1 share the scene-level prompt (no variant array).
    assert.strictEqual(rows[0].prompt, "old style");
    assert.strictEqual(rows[1].prompt, "old style");
    assert.strictEqual(rows[2].prompt, "old style 2");
    assert.strictEqual(rows[3].prompt, "old style 2");
});

test("PR-48: pairImagePathsForI2V matches by (scene_id, variant_idx) — video variant N ↔ image variant N", () => {
    // 1 scene × 4 image variants, all settled with distinct paths.
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 4 });
    imageRows = helpers.applyBatchResult(imageRows, "1#0", { status: "generated", image_path: "/img-v0.png" });
    imageRows = helpers.applyBatchResult(imageRows, "1#1", { status: "generated", image_path: "/img-v1.png" });
    imageRows = helpers.applyBatchResult(imageRows, "1#2", { status: "generated", image_path: "/img-v2.png" });
    imageRows = helpers.applyBatchResult(imageRows, "1#3", { status: "generated", image_path: "/img-v3.png" });

    // 4 video variants — each must pair to the same-index image.
    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 4 });
    const paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired.length, 4);
    assert.strictEqual(paired[0].image_path, "/img-v0.png", "video #0 must pair to image #0");
    assert.strictEqual(paired[1].image_path, "/img-v1.png", "video #1 must pair to image #1");
    assert.strictEqual(paired[2].image_path, "/img-v2.png", "video #2 must pair to image #2");
    assert.strictEqual(paired[3].image_path, "/img-v3.png", "video #3 must pair to image #3");
});

test("PR-48: pairImagePathsForI2V — video variant with no exact image variant falls back to lowest-variant_idx settled", () => {
    // Image variants 0 + 1 settled. Video has 4 variants — variants 2, 3
    // should fall back to lowest-settled image (variant 0).
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 2 });
    imageRows = helpers.applyBatchResult(imageRows, "1#0", { status: "generated", image_path: "/img-v0.png" });
    imageRows = helpers.applyBatchResult(imageRows, "1#1", { status: "generated", image_path: "/img-v1.png" });

    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 4 });
    const paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired[0].image_path, "/img-v0.png", "video #0 → image #0 (exact)");
    assert.strictEqual(paired[1].image_path, "/img-v1.png", "video #1 → image #1 (exact)");
    assert.strictEqual(paired[2].image_path, "/img-v0.png", "video #2 → fallback to lowest settled (image #0)");
    assert.strictEqual(paired[3].image_path, "/img-v0.png", "video #3 → fallback to lowest settled (image #0)");
});

test("PR-48: pairImagePathsForI2V — when only a high variant settled, lower video variants fall back to it", () => {
    // Only image variant 2 settled (variants 0 and 1 failed/pending).
    // Every video variant must still pair to /img-v2.png (the only settled image).
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 3 });
    imageRows = helpers.applyBatchResult(imageRows, "1#2", { status: "generated", image_path: "/img-v2.png" });
    imageRows = helpers.applyBatchResult(imageRows, "1#0", { status: "fallback", attempts: 1, reason: "moderated" });
    imageRows = helpers.applyBatchResult(imageRows, "1#1", { status: "fallback", attempts: 1, reason: "moderated" });

    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 3 });
    const paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired[0].image_path, "/img-v2.png", "video #0 → fallback to /img-v2.png (only settled)");
    assert.strictEqual(paired[1].image_path, "/img-v2.png", "video #1 → fallback to /img-v2.png");
    assert.strictEqual(paired[2].image_path, "/img-v2.png", "video #2 → exact match");
});

test("PR-48: pairImagePathsForI2V — does not mutate inputs", () => {
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 2 });
    imageRows = helpers.applyBatchResult(imageRows, "1#0", { status: "generated", image_path: "/v0.png" });
    imageRows = helpers.applyBatchResult(imageRows, "1#1", { status: "generated", image_path: "/v1.png" });
    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 2 });
    const imageSnap = JSON.stringify(imageRows);
    const videoSnap = JSON.stringify(videoRows);
    helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(JSON.stringify(imageRows), imageSnap, "imageRows must not be mutated");
    assert.strictEqual(JSON.stringify(videoRows), videoSnap, "videoRows must not be mutated");
});

test("PR-48: pairImagePathsForI2V — different scenes do NOT cross-pair", () => {
    // Scene 1 has variant 0 settled; Scene 2 has nothing settled.
    // Scene 2's video rows must NOT pair to scene 1's image_path.
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 2), { imagesPerScene: 1 });
    imageRows = helpers.applyBatchResult(imageRows, "1#0", { status: "generated", image_path: "/scene1.png" });
    // Scene 2's image is intentionally not settled (still pending).
    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 2), { videosPerScene: 1 });
    const paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired[0].image_path, "/scene1.png");
    assert.strictEqual(paired[1].image_path, null, "scene 2's video must NOT borrow scene 1's image");
});

// ── PR-B: countSettledImageRows (video Generate gate) ────────────────────

test("PR-B: countSettledImageRows — counts only generated/retried with image_path", () => {
    const rows = [
        { row_id: "1#0", scene_id: 1, status: "generated", image_path: "/tmp/a.png" },
        { row_id: "1#1", scene_id: 1, status: "retried",   image_path: "/tmp/b.png" },
        { row_id: "2#0", scene_id: 2, status: "pending",   image_path: null },
        { row_id: "2#1", scene_id: 2, status: "generating", image_path: null },
        { row_id: "3#0", scene_id: 3, status: "fallback",  image_path: null, reason: "rate-limited" },
        { row_id: "4#0", scene_id: 4, status: "skipped",   image_path: null, reason: "missing prompt" },
    ];
    assert.strictEqual(helpers.countSettledImageRows(rows), 2,
        "only the 'generated' + 'retried' rows with non-empty image_path should count");
});

test("PR-B: countSettledImageRows — rejects status:generated with empty image_path", () => {
    // Defensive: if a backend payload races such that status flips
    // before image_path is filled in, we MUST NOT count that row as
    // settled — clicking Generate videos in that window would hand a
    // missing-file path to I2V.
    const rows = [
        { row_id: "1#0", scene_id: 1, status: "generated", image_path: "" },
        { row_id: "1#1", scene_id: 1, status: "generated", image_path: null },
        { row_id: "2#0", scene_id: 2, status: "generated" },  // no field at all
        { row_id: "3#0", scene_id: 3, status: "retried",  image_path: 0 },  // wrong type
        { row_id: "4#0", scene_id: 4, status: "generated", image_path: "/tmp/ok.png" },
    ];
    assert.strictEqual(helpers.countSettledImageRows(rows), 1,
        "only the row with a non-empty string image_path counts");
});

test("PR-B: countSettledImageRows — null/undefined/scalar input → 0", () => {
    assert.strictEqual(helpers.countSettledImageRows(null), 0);
    assert.strictEqual(helpers.countSettledImageRows(undefined), 0);
    assert.strictEqual(helpers.countSettledImageRows("not-an-array"), 0);
    assert.strictEqual(helpers.countSettledImageRows({}), 0);
    assert.strictEqual(helpers.countSettledImageRows(42), 0);
});

test("PR-B: countSettledImageRows — empty array → 0", () => {
    assert.strictEqual(helpers.countSettledImageRows([]), 0);
});

test("PR-B: countSettledImageRows — handles malformed entries without throwing", () => {
    // Real-world: a stale payload may have null entries or non-objects.
    // Helper must skip rather than crash so the gate logic is safe to
    // call from every repaint.
    const rows = [
        null,
        undefined,
        "not-an-object",
        42,
        { row_id: "1#0", scene_id: 1, status: "generated", image_path: "/tmp/ok.png" },
        { /* missing status */ image_path: "/tmp/orphan.png" },
        { status: "generated" /* missing image_path */ },
    ];
    assert.strictEqual(helpers.countSettledImageRows(rows), 1);
});

test("PR-B: countSettledImageRows — caller's array is not mutated", () => {
    const rows = [
        { row_id: "1#0", status: "generated", image_path: "/tmp/a.png" },
        { row_id: "2#0", status: "pending",   image_path: null },
    ];
    const snapshot = JSON.stringify(rows);
    helpers.countSettledImageRows(rows);
    assert.strictEqual(JSON.stringify(rows), snapshot,
        "input rows must not be mutated");
});

test("PR-B: countSettledImageRows — agrees with pairImagePathsForI2V on which rows produce a binding", () => {
    // Cross-check: the gate's settled-count must match the helper that
    // actually pairs image_paths into video rows. If countSettledImageRows
    // says ≥1 then pairImagePathsForI2V must produce ≥1 video row with
    // a non-null hero_image (matched by scene_id).
    const imageRows = [
        { row_id: "1#0", scene_id: 1, variant_idx: 0, status: "generated", image_path: "/tmp/s1v0.png" },
        { row_id: "2#0", scene_id: 2, variant_idx: 0, status: "fallback",  image_path: null },
    ];
    const videoRows = [
        { row_id: "1#0", scene_id: 1, variant_idx: 0, status: "pending" },
        { row_id: "2#0", scene_id: 2, variant_idx: 0, status: "pending" },
    ];
    const settled = helpers.countSettledImageRows(imageRows);
    const paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    const withHero = paired.filter((r) => r.hero_image || r.image_path);
    assert.ok(settled > 0, "scene 1 should be settled");
    assert.ok(withHero.length > 0, "pairImagePathsForI2V should produce ≥1 video row with a hero image");
});

// Source-image URL propagation — when the matched image row has a
// renderer-side ``url`` (a ``file://`` URL), pairing copies it onto
// the video row as ``source_image_url`` so the Storyboard's video
// table can render a hero-image thumbnail before the I2V job runs.
test("source_image_url: propagates from matched image row's url field", () => {
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 2 });
    imageRows = helpers.applyBatchResult(imageRows, "1#0", { status: "generated", image_path: "/img-v0.png" });
    imageRows = helpers.applyBatchResult(imageRows, "1#1", { status: "generated", image_path: "/img-v1.png" });
    // Simulate sbbResolveUrls populating the ``url`` field on image rows.
    imageRows[0].url = "file:///img-v0.png";
    imageRows[1].url = "file:///img-v1.png";

    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 2 });
    const paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired[0].image_path, "/img-v0.png");
    assert.strictEqual(paired[0].source_image_url, "file:///img-v0.png", "video #0 must inherit url from image #0");
    assert.strictEqual(paired[1].image_path, "/img-v1.png");
    assert.strictEqual(paired[1].source_image_url, "file:///img-v1.png", "video #1 must inherit url from image #1");
});

test("source_image_url: stays unset when matched image row has no url yet", () => {
    // Common race: image batch settled (image_path present) but
    // sbbResolveUrls hasn't finished resolving file:// URLs yet.
    // The video row should still get image_path set (so the gate
    // releases) — but source_image_url stays absent so the renderer
    // falls back to a "loading…" thumbnail.
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 1 });
    imageRows = helpers.applyBatchResult(imageRows, "1#0", { status: "generated", image_path: "/img-v0.png" });
    // No url on the image row.

    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 1 });
    const paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired[0].image_path, "/img-v0.png");
    assert.ok(!paired[0].source_image_url, "source_image_url must be absent when image url not yet resolved");
});

test("source_image_url: fallback path inherits url from lowest-variant settled image", () => {
    // Only variant 2 settled — both video #0 and video #1 should fall
    // back to that image AND inherit its url.
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1), { imagesPerScene: 3 });
    imageRows = helpers.applyBatchResult(imageRows, "1#2", { status: "generated", image_path: "/img-v2.png" });
    imageRows[2].url = "file:///img-v2.png";

    const videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 3 });
    const paired = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(paired[0].source_image_url, "file:///img-v2.png", "video #0 fallback inherits image #2's url");
    assert.strictEqual(paired[1].source_image_url, "file:///img-v2.png", "video #1 fallback inherits image #2's url");
    assert.strictEqual(paired[2].source_image_url, "file:///img-v2.png", "video #2 exact match inherits image #2's url");
});

test("source_image_url: clears stale url when image_path drops to null", () => {
    // Edge case: a row had a paired image previously, but
    // re-pairing now finds no matching image (e.g. user deleted
    // the image row). The stale source_image_url must be cleared
    // so the Source column doesn't keep showing a phantom thumb.
    let videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1), { videosPerScene: 1 });
    videoRows[0] = Object.assign({}, videoRows[0], {
        image_path: "/img-v0.png",
        source_image_url: "file:///img-v0.png",
    });
    // No image rows now → pair finds nothing.
    const paired = helpers.pairImagePathsForI2V(videoRows, []);
    assert.strictEqual(paired[0].image_path, null, "image_path cleared when no match");
    assert.strictEqual(paired[0].source_image_url, null, "stale source_image_url cleared too");
});

// ── Retry-clears-stale-url coverage ──────────────────────────────
// When the renderer sets a row to 'generating' for a retry, it now
// clears url / image_path / bytes so the thumbnail refreshes with
// the new file after applyBatchResult re-settles the row. These
// tests verify the helpers cooperate correctly with that contract.

test("applyBatchResult: re-settles row after url/image_path cleared for retry", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    // First generation — 24 KB error image → fallback.
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/old.jpg", bytes: 24 * 1024,
    });
    assert.strictEqual(rows[0].status, "fallback", "first gen demoted to fallback");
    // Renderer clears url/image_path/bytes on retry (simulate).
    rows = rows.map((r) => r.scene_id === 1
        ? Object.assign({}, r, { status: "generating", url: null, image_path: null, bytes: 0 })
        : r);
    // Second generation — 250 KB valid image.
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 2, image_path: "/new.jpg", bytes: 250 * 1024,
    });
    assert.strictEqual(rows[0].status, "generated", "second gen accepted");
    assert.strictEqual(rows[0].image_path, "/new.jpg", "new path set");
    assert.strictEqual(rows[0].bytes, 250 * 1024, "new bytes set");
});

test("applyBatchResult: retry with cleared row does not inherit stale image_path", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/stale.jpg", bytes: 200 * 1024,
    });
    assert.strictEqual(rows[0].image_path, "/stale.jpg");
    // Simulate retry clearing.
    rows = rows.map((r) => r.scene_id === 1
        ? Object.assign({}, r, { status: "generating", url: null, image_path: null, bytes: 0 })
        : r);
    assert.strictEqual(rows[0].image_path, null, "image_path cleared for retry");
    assert.strictEqual(rows[0].url, null, "url cleared for retry");
    // New result with different path.
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 2, image_path: "/fresh.jpg", bytes: 300 * 1024,
    });
    assert.strictEqual(rows[0].image_path, "/fresh.jpg", "fresh path from new generation");
});

test("enrichBatchRowsWithFileBytes: re-enriches after retry (bytes was 0 again)", async () => {
    const stat = async (p) => ({ exists: true, size: p === "/retry.jpg" ? 350 * 1024 : 0 });
    const mapped = [
        { scene_id: 1, status: "generated", image_path: "/retry.jpg", bytes: 0 },
    ];
    const enriched = await helpers.enrichBatchRowsWithFileBytes(mapped, stat);
    assert.strictEqual(enriched[0].bytes, 350 * 1024, "re-enrichment picks up new size");
});

test("pairImagePathsForI2V: does not pair fallback rows into video batch", () => {
    let imageRows = helpers.initImageRowsFromScenes(SCENES.slice(0, 1));
    imageRows = helpers.startBatchPhase(imageRows);
    imageRows = helpers.applyBatchResult(imageRows, 1, {
        status: "generated", attempts: 1, image_path: "/small.jpg", bytes: 24 * 1024,
    });
    // The gate demotes to fallback.
    assert.strictEqual(imageRows[0].status, "fallback");
    let videoRows = helpers.initVideoRowsFromScenes(SCENES.slice(0, 1));
    videoRows = helpers.pairImagePathsForI2V(videoRows, imageRows);
    assert.strictEqual(videoRows[0].image_path, null, "fallback image must NOT pair into I2V");
});

// ── Enhanced reject reason coverage ──────────────────────────────

test("applyBatchResult: 24 KB image gets CDN moderation reason", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 24 * 1024,
    });
    assert.strictEqual(rows[0].status, "fallback");
    assert.match(rows[0].reason, /24 KB/, "names the actual size");
    assert.match(rows[0].reason, /CDN moderation/, "identifies likely cause for very small images");
});

test("applyBatchResult: 45 KB image gets incomplete download reason", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 45 * 1024,
    });
    assert.strictEqual(rows[0].status, "fallback");
    assert.match(rows[0].reason, /45 KB/);
    assert.match(rows[0].reason, /incomplete download|preview frame/, "identifies likely cause for mid-range small images");
});

test("applyBatchResult: 80 KB image gets generic too-small reason", () => {
    let rows = helpers.initImageRowsFromScenes(SCENES);
    rows = helpers.startBatchPhase(rows);
    rows = helpers.applyBatchResult(rows, 1, {
        status: "generated", attempts: 1, image_path: "/p1.png", bytes: 80 * 1024,
    });
    assert.strictEqual(rows[0].status, "fallback");
    assert.match(rows[0].reason, /80 KB/);
    assert.match(rows[0].reason, /too small to be a real generation/, "generic reason for borderline images");
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
