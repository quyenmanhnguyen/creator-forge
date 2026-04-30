/**
 * Offline regression test for `desktop/dist/storyboard_video_compose_helpers.js`.
 *
 * Mirrors `test_storyboard_compose_helpers.js` for the I2V branch
 * (PR-20B). Covers:
 *   - planning jobs from scenes + sceneAssets (image hero match by
 *     scene_id, video_prompt OR flow_video_prompt fallback, skip
 *     reasons)
 *   - groupI2VResultsByJobIndex picks globalIdx/localIdx and dedupes
 *   - pickI2VOutputFile validates savedFile + minBytes + success flag
 *   - orchestrateI2VWithRetries: scene-level retry, fallback marking,
 *     single shared first-attempt response, retryCount accounting
 *   - countFallbackI2VScenes / stripVideoSceneAssetForComposer
 *
 * Run:
 *   node desktop/tests/test_storyboard_video_compose_helpers.js
 */

"use strict";

const assert = require("assert");

const helpers = require("../dist/storyboard_video_compose_helpers.js");

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

// Utility: build a fake statBytesFn that returns a fixed size for known
// paths and {exists:false} for everything else.
function fakeStat(map) {
    return async (p) => {
        if (Object.prototype.hasOwnProperty.call(map, p)) {
            return { exists: true, size: map[p] };
        }
        return { exists: false, size: 0 };
    };
}

async function run() {
    // ── planI2VJobsFromScenesAndAssets ───────────────────────────────────

    test("planI2VJobsFromScenesAndAssets: matches scene_id, prefers video_prompt over flow_video_prompt", () => {
        const scenes = [
            { scene_id: 1, video_prompt: "  pan left ", flow_video_prompt: "ignored" },
            { scene_id: 2, flow_video_prompt: "zoom in" },
            { scene_id: 3, video_prompt: "" },           // empty → skipped
            { scene_id: 4, video_prompt: "tilt up" },     // no asset → skipped
        ];
        const sceneAssets = [
            { image_path: "/tmp/hero1.png", start_s: 0, duration_s: 3, scene_id: 1 },
            { image_path: "/tmp/hero2.png", start_s: 3, duration_s: 4, scene_id: 2 },
            { image_path: "/tmp/hero3.png", start_s: 7, duration_s: 4, scene_id: 3 },
            // scene 4 deliberately missing
        ];
        const { jobs, skipped } = helpers.planI2VJobsFromScenesAndAssets(scenes, sceneAssets);
        assert.strictEqual(jobs.length, 2);
        assert.deepStrictEqual(jobs[0], { scene_id: 1, imagePath: "/tmp/hero1.png", prompt: "pan left", start_s: 0, duration_s: 3 });
        assert.deepStrictEqual(jobs[1], { scene_id: 2, imagePath: "/tmp/hero2.png", prompt: "zoom in", start_s: 3, duration_s: 4 });
        // Two skipped: scene 3 (empty prompt) and scene 4 (no asset).
        assert.strictEqual(skipped.length, 2);
        assert.strictEqual(skipped[0].scene_id, 3);
        assert.match(skipped[0].reason, /missing video_prompt/);
        assert.strictEqual(skipped[1].scene_id, 4);
        assert.match(skipped[1].reason, /no usable hero image/);
    });

    test("planI2VJobsFromScenesAndAssets: empty inputs return empty jobs", () => {
        const out1 = helpers.planI2VJobsFromScenesAndAssets([], []);
        assert.deepStrictEqual(out1, { jobs: [], skipped: [] });
        const out2 = helpers.planI2VJobsFromScenesAndAssets(null, null);
        assert.deepStrictEqual(out2, { jobs: [], skipped: [] });
    });

    test("planI2VJobsFromScenesAndAssets: rejects sceneAsset with non-positive duration", () => {
        const scenes = [{ scene_id: 1, video_prompt: "x" }];
        const sceneAssets = [{ image_path: "/tmp/a.png", start_s: 0, duration_s: 0, scene_id: 1 }];
        const { jobs, skipped } = helpers.planI2VJobsFromScenesAndAssets(scenes, sceneAssets);
        assert.strictEqual(jobs.length, 0);
        assert.strictEqual(skipped.length, 1);
        assert.match(skipped[0].reason, /invalid duration_s/);
    });

    // ── groupI2VResultsByJobIndex ────────────────────────────────────────

    test("groupI2VResultsByJobIndex: prefers globalIdx, falls back to localIdx, dedupes", () => {
        const resp = {
            success: true,
            results: [
                { globalIdx: 0, savedFile: "/a.mp4" },
                { localIdx: 1, savedFile: "/b.mp4" },           // no globalIdx
                { globalIdx: 0, savedFile: "/dup.mp4" },          // dup → ignored
                { globalIdx: 99, savedFile: "/oob.mp4" },         // out of range
                { savedFile: "/no-idx.mp4" },                     // no idx → ignored
            ],
        };
        const grouped = helpers.groupI2VResultsByJobIndex(resp, 3);
        assert.strictEqual(grouped.size, 2);
        assert.strictEqual(grouped.get(0).savedFile, "/a.mp4");
        assert.strictEqual(grouped.get(1).savedFile, "/b.mp4");
    });

    // ── pickI2VOutputFile ─────────────────────────────────────────────────

    test("pickI2VOutputFile: rejects null result", async () => {
        const out = await helpers.pickI2VOutputFile(null, fakeStat({}));
        assert.strictEqual(out.chosen, null);
        assert.match(out.reason, /no result/);
    });

    test("pickI2VOutputFile: short-circuits on success=false", async () => {
        const out = await helpers.pickI2VOutputFile(
            { success: false, error: "rate limited", savedFile: "/tmp/x.mp4" },
            fakeStat({ "/tmp/x.mp4": 999999 }),
        );
        assert.strictEqual(out.chosen, null);
        assert.match(out.reason, /rate limited/);
    });

    test("pickI2VOutputFile: rejects missing savedFile + outputPath", async () => {
        const out = await helpers.pickI2VOutputFile({ success: true }, fakeStat({}));
        assert.strictEqual(out.chosen, null);
        assert.match(out.reason, /missing savedFile/);
    });

    test("pickI2VOutputFile: rejects file not on disk", async () => {
        const out = await helpers.pickI2VOutputFile(
            { success: true, savedFile: "/nope.mp4" },
            fakeStat({}),
        );
        assert.strictEqual(out.chosen, null);
        assert.match(out.reason, /not on disk/);
    });

    test("pickI2VOutputFile: rejects file under minBytes", async () => {
        const out = await helpers.pickI2VOutputFile(
            { success: true, savedFile: "/tiny.mp4" },
            fakeStat({ "/tiny.mp4": 100 }),
        );
        assert.strictEqual(out.chosen, null);
        assert.match(out.reason, /suspiciously small/);
    });

    test("pickI2VOutputFile: accepts ≥minBytes", async () => {
        const out = await helpers.pickI2VOutputFile(
            { success: true, savedFile: "/ok.mp4" },
            fakeStat({ "/ok.mp4": 50_000 }),
        );
        assert.deepStrictEqual(out.chosen, { filePath: "/ok.mp4", bytes: 50_000 });
        assert.strictEqual(out.reason, null);
    });

    test("pickI2VOutputFile: falls back to outputPath when savedFile missing", async () => {
        const out = await helpers.pickI2VOutputFile(
            { success: true, outputPath: "/server-side.mp4" },
            fakeStat({ "/server-side.mp4": 250_000 }),
        );
        assert.deepStrictEqual(out.chosen, { filePath: "/server-side.mp4", bytes: 250_000 });
    });

    // ── orchestrateI2VWithRetries ────────────────────────────────────────

    test("orchestrateI2VWithRetries: all jobs succeed on first attempt → status=generated, retryCount=0", async () => {
        const jobs = [
            { scene_id: 1, imagePath: "/h1.png", prompt: "p1", start_s: 0, duration_s: 3 },
            { scene_id: 2, imagePath: "/h2.png", prompt: "p2", start_s: 3, duration_s: 4 },
        ];
        const calls = [];
        const i2vGenerateFn = async (items, ctx) => {
            calls.push({ items: items.length, attempt: ctx.attemptNumber });
            return {
                success: true,
                results: items.map((it, k) => ({
                    globalIdx: k,
                    savedFile: `/out-${k}.mp4`,
                    success: true,
                })),
            };
        };
        const stat = fakeStat({ "/out-0.mp4": 300_000, "/out-1.mp4": 800_000 });
        const out = await helpers.orchestrateI2VWithRetries(jobs, i2vGenerateFn, stat, { maxAttempts: 2 });

        assert.strictEqual(calls.length, 1, "should not retry when all succeed");
        assert.strictEqual(calls[0].attempt, 1);
        assert.strictEqual(out.retryCount, 0);
        assert.strictEqual(out.maxAttempts, 2);
        assert.strictEqual(out.videoSceneAssets.length, 2);
        assert.strictEqual(out.videoSceneAssets[0].video_path, "/out-0.mp4");
        assert.strictEqual(out.videoSceneAssets[0].scene_id, 1);
        assert.strictEqual(out.videoSceneAssets[0].start_s, 0);
        assert.strictEqual(out.videoSceneAssets[0].duration_s, 3);
        assert.deepStrictEqual(out.perSceneStatus.map((s) => s.status), ["generated", "generated"]);
        assert.deepStrictEqual(out.perSceneStatus.map((s) => s.attempts), [1, 1]);
    });

    test("orchestrateI2VWithRetries: scene-level retry only re-issues failing jobs", async () => {
        const jobs = [
            { scene_id: 1, imagePath: "/h1.png", prompt: "p1", start_s: 0, duration_s: 3 },
            { scene_id: 2, imagePath: "/h2.png", prompt: "p2", start_s: 3, duration_s: 3 },
            { scene_id: 3, imagePath: "/h3.png", prompt: "p3", start_s: 6, duration_s: 3 },
        ];
        const callLog = [];
        let attemptCounter = 0;
        const i2vGenerateFn = async (items, ctx) => {
            attemptCounter++;
            callLog.push({ count: items.length, sceneIds: ctx.sceneIds.slice(), attempt: ctx.attemptNumber });
            // Attempt 1: scene 1 ok, scenes 2 + 3 fail.
            // Attempt 2: scene 2 ok (now retried), scene 3 still fails (→ fallback).
            if (attemptCounter === 1) {
                return {
                    success: true,
                    results: [
                        { globalIdx: 0, savedFile: "/v1.mp4", success: true },
                        { globalIdx: 1, savedFile: "", success: false, error: "moderation block" },
                        { globalIdx: 2, savedFile: "/v3-tiny.mp4", success: true },
                    ],
                };
            }
            // attempt 2: items[0] is scene 2, items[1] is scene 3
            return {
                success: true,
                results: [
                    { globalIdx: 0, savedFile: "/v2-retry.mp4", success: true },
                    { globalIdx: 1, savedFile: "/v3-retry-tiny.mp4", success: true },
                ],
            };
        };
        const stat = fakeStat({
            "/v1.mp4": 500_000,
            "/v2-retry.mp4": 600_000,
            "/v3-tiny.mp4": 50,           // below floor
            "/v3-retry-tiny.mp4": 20,     // still below floor
        });
        const out = await helpers.orchestrateI2VWithRetries(jobs, i2vGenerateFn, stat, { maxAttempts: 2 });

        // Two attempts: 3 items first, 2 items second.
        assert.strictEqual(callLog.length, 2);
        assert.strictEqual(callLog[0].count, 3);
        assert.deepStrictEqual(callLog[0].sceneIds, [1, 2, 3]);
        assert.strictEqual(callLog[1].count, 2);
        assert.deepStrictEqual(callLog[1].sceneIds, [2, 3]);

        assert.strictEqual(out.retryCount, 2, "retry count == # items re-issued on attempts > 1");
        assert.strictEqual(out.videoSceneAssets.length, 2);
        // Order in videoSceneAssets follows scene order, regardless of when each succeeded.
        assert.deepStrictEqual(out.videoSceneAssets.map((v) => v.scene_id), [1, 2]);

        const byScene = Object.fromEntries(out.perSceneStatus.map((s) => [s.scene_id, s]));
        assert.strictEqual(byScene[1].status, "generated");
        assert.strictEqual(byScene[1].attempts, 1);
        assert.strictEqual(byScene[2].status, "retried");
        assert.strictEqual(byScene[2].attempts, 2);
        assert.strictEqual(byScene[3].status, "fallback");
        assert.strictEqual(byScene[3].attempts, 2);
        assert.match(byScene[3].reason, /suspiciously small|did not return/);
    });

    test("orchestrateI2VWithRetries: i2v throw on attempt 1 → retried jobs still get a clean shot", async () => {
        const jobs = [{ scene_id: 1, imagePath: "/h1.png", prompt: "p1", start_s: 0, duration_s: 3 }];
        let attempt = 0;
        const i2vGenerateFn = async () => {
            attempt++;
            if (attempt === 1) throw new Error("ipc gone");
            return {
                success: true,
                results: [{ globalIdx: 0, savedFile: "/v1.mp4", success: true }],
            };
        };
        const stat = fakeStat({ "/v1.mp4": 200_000 });
        const out = await helpers.orchestrateI2VWithRetries(jobs, i2vGenerateFn, stat, { maxAttempts: 2 });
        assert.strictEqual(out.videoSceneAssets.length, 1);
        assert.strictEqual(out.perSceneStatus[0].status, "retried");
        assert.strictEqual(out.perSceneStatus[0].attempts, 2);
        assert.strictEqual(out.i2vGenerate.success, false, "first-attempt response captured even on throw");
        assert.match(out.i2vGenerate.error, /ipc gone/);
    });

    test("orchestrateI2VWithRetries: maxAttempts=1 disables retry, marks fallback immediately", async () => {
        const jobs = [{ scene_id: 1, imagePath: "/h1.png", prompt: "p1", start_s: 0, duration_s: 3 }];
        let calls = 0;
        const i2vGenerateFn = async () => {
            calls++;
            return { success: true, results: [{ globalIdx: 0, savedFile: "", success: false, error: "no quota" }] };
        };
        const out = await helpers.orchestrateI2VWithRetries(jobs, i2vGenerateFn, fakeStat({}), { maxAttempts: 1 });
        assert.strictEqual(calls, 1);
        assert.strictEqual(out.retryCount, 0);
        assert.strictEqual(out.videoSceneAssets.length, 0);
        assert.strictEqual(out.perSceneStatus[0].status, "fallback");
        assert.strictEqual(out.perSceneStatus[0].attempts, 1);
        assert.match(out.perSceneStatus[0].reason, /no quota/);
    });

    test("orchestrateI2VWithRetries: empty jobs → no calls", async () => {
        let calls = 0;
        const i2vGenerateFn = async () => { calls++; return { success: true, results: [] }; };
        const out = await helpers.orchestrateI2VWithRetries([], i2vGenerateFn, fakeStat({}), { maxAttempts: 3 });
        assert.strictEqual(calls, 0);
        assert.deepStrictEqual(out.videoSceneAssets, []);
        assert.deepStrictEqual(out.perSceneStatus, []);
        assert.strictEqual(out.retryCount, 0);
    });

    // ── countFallbackI2VScenes / stripVideoSceneAssetForComposer ─────────

    test("countFallbackI2VScenes: counts only 'fallback' status entries", () => {
        const status = [
            { scene_id: 1, status: "generated" },
            { scene_id: 2, status: "fallback" },
            { scene_id: 3, status: "skipped" },
            { scene_id: 4, status: "fallback" },
        ];
        assert.strictEqual(helpers.countFallbackI2VScenes(status), 2);
        assert.strictEqual(helpers.countFallbackI2VScenes(null), 0);
    });

    // ── PR-20E: validateFn integration ────────────────────────────────
    test("PR-20E: pickI2VOutputFile passes ffprobe validator → chosen kept", async () => {
        const result = { savedFile: "/tmp/ok.mp4", success: true };
        const stat = fakeStat({ "/tmp/ok.mp4": 200_000 });
        const validateFn = async (fp, minBytes) => {
            assert.strictEqual(fp, "/tmp/ok.mp4");
            assert.strictEqual(minBytes, 10000);
            return { ok: true, size: 200_000, ffprobeAvailable: true };
        };
        const pick = await helpers.pickI2VOutputFile(result, stat, { validateFn });
        assert.strictEqual(pick.reason, null);
        assert.strictEqual(pick.chosen.filePath, "/tmp/ok.mp4");
        assert.strictEqual(pick.chosen.bytes, 200_000);
        assert.strictEqual(pick.chosen.validation.ok, true);
    });

    test("PR-20E: pickI2VOutputFile fails validator → chosen:null + reason propagated", async () => {
        const result = { savedFile: "/tmp/html.mp4", success: true };
        const stat = fakeStat({ "/tmp/html.mp4": 50_000 });
        const validateFn = async () => ({
            ok: false,
            reason: "no video stream detected by ffprobe",
            ffprobeAvailable: true,
        });
        const pick = await helpers.pickI2VOutputFile(result, stat, { validateFn });
        assert.strictEqual(pick.chosen, null);
        assert.match(pick.reason, /no video stream/);
    });

    test("PR-20E: pickI2VOutputFile validateFn throws → chosen:null + reason captures throw", async () => {
        const result = { savedFile: "/tmp/x.mp4", success: true };
        const stat = fakeStat({ "/tmp/x.mp4": 20_000 });
        const validateFn = async () => { throw new Error("IPC exploded"); };
        const pick = await helpers.pickI2VOutputFile(result, stat, { validateFn });
        assert.strictEqual(pick.chosen, null);
        assert.match(pick.reason, /validateFn threw: IPC exploded/);
    });

    test("PR-20E: pickI2VOutputFile size floor short-circuits before validateFn runs", async () => {
        let called = 0;
        const result = { savedFile: "/tmp/tiny.mp4", success: true };
        const stat = fakeStat({ "/tmp/tiny.mp4": 500 }); // below 10KB minBytes
        const validateFn = async () => { called += 1; return { ok: true }; };
        const pick = await helpers.pickI2VOutputFile(result, stat, { validateFn });
        assert.strictEqual(pick.chosen, null);
        assert.match(pick.reason, /suspiciously small/);
        assert.strictEqual(called, 0);
    });

    test("PR-20E: orchestrateI2VWithRetries forwards validateFn; invalid mp4 on attempt 1 → retry wins", async () => {
        const jobs = [{ globalIdx: 0, scene_id: "A", prompt: "p", imagePath: "/img.jpg", start_s: 0, duration_s: 3 }];
        const firstSaved = "/tmp/attempt1.mp4";
        const secondSaved = "/tmp/attempt2.mp4";
        const stat = fakeStat({ [firstSaved]: 20_000, [secondSaved]: 20_000 });
        let attempts = 0;
        const i2vGenerateFn = async (items) => {
            attempts += 1;
            return {
                success: true,
                results: items.map((_, localIdx) => ({
                    success: true,
                    savedFile: attempts === 1 ? firstSaved : secondSaved,
                    globalIdx: jobs[0].globalIdx,
                    localIdx,
                })),
            };
        };
        // validator rejects attempt1 (no moov), accepts attempt2.
        const validateFn = async (fp) => fp === firstSaved
            ? { ok: false, reason: "no video stream", ffprobeAvailable: true }
            : { ok: true, ffprobeAvailable: true };
        const res = await helpers.orchestrateI2VWithRetries(
            jobs, i2vGenerateFn, stat,
            { maxAttempts: 2, minBytes: 10000, validateFn },
        );
        assert.strictEqual(attempts, 2);
        assert.strictEqual(res.perSceneStatus[0].status, "retried");
        assert.strictEqual(res.perSceneStatus[0].video_path, secondSaved);
        assert.strictEqual(res.videoSceneAssets.length, 1);
    });

    test("stripVideoSceneAssetForComposer: drops scene_id, preserves only video_path/start_s/duration_s", () => {
        const stripped = helpers.stripVideoSceneAssetForComposer([
            { video_path: "/a.mp4", start_s: 0, duration_s: 3, scene_id: 1, extra: "ignored" },
            { video_path: "/b.mp4", start_s: 3, duration_s: 4, scene_id: 2 },
        ]);
        assert.deepStrictEqual(stripped, [
            { video_path: "/a.mp4", start_s: 0, duration_s: 3 },
            { video_path: "/b.mp4", start_s: 3, duration_s: 4 },
        ]);
    });

    await Promise.all(pending);
    console.log("");
    if (failed === 0) {
        console.log(`PASSED ${passed} test(s)`);
        process.exit(0);
    } else {
        console.error(`FAILED ${failed} of ${passed + failed} test(s)`);
        process.exit(1);
    }
}

run().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
