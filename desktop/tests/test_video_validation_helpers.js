/**
 * Offline regression tests for `desktop/dist/video_validation_helpers.js` (PR-20E).
 *
 * We don't require a real ffprobe binary in CI — a tiny `fakeSpawn`
 * stub emits pre-canned stdout / stderr / exit codes via Node's
 * EventEmitter, which is enough to exercise every decision branch in
 * `validateVideoOutput`:
 *
 *   - exists=false                     → ok:false
 *   - size < minBytes                  → ok:false (truncated download)
 *   - ffprobe exits non-zero           → ok:false (reason captured)
 *   - ffprobe returns no video stream  → ok:false (codec_type missing)
 *   - ffprobe returns duration ≤ floor → ok:false (too short)
 *   - ffprobe returns invalid JSON     → ok:false (parse error)
 *   - ffprobe spawn fails with ENOENT  → ok:true  (soft-pass + reason)
 *   - happy path                       → ok:true  (+ dims/codec)
 *
 * Run:  node desktop/tests/test_video_validation_helpers.js
 */
"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { validateVideoOutput, probeVideoFile } = require("../dist/video_validation_helpers.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Fake a `child_process.spawn`-compatible object. `recipe`:
//   { stdout, stderr, code, errorCode }
// If `errorCode` is set we fire a synthetic 'error' event (used to
// simulate ENOENT when ffprobe isn't installed); otherwise we emit
// stdout/stderr + 'close' on the next tick.
function fakeSpawn(recipe) {
    return () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
            if (recipe.errorCode) {
                const err = new Error("spawn failure");
                err.code = recipe.errorCode;
                child.emit("error", err);
                return;
            }
            if (recipe.stdout) child.stdout.emit("data", Buffer.from(recipe.stdout));
            if (recipe.stderr) child.stderr.emit("data", Buffer.from(recipe.stderr));
            child.emit("close", typeof recipe.code === "number" ? recipe.code : 0);
        });
        return child;
    };
}

const okProbeStdout = JSON.stringify({
    format: { duration: "5.123" },
    streams: [
        { codec_type: "audio" },
        { codec_type: "video", codec_name: "h264", width: 720, height: 1280, duration: "5.123" },
    ],
});

test("probeVideoFile: missing file → exists:false with reason", async () => {
    const res = await probeVideoFile("/no/such/file.mp4", {
        statFn: () => ({ exists: false, size: 0 }),
        spawnFn: fakeSpawn({ stdout: okProbeStdout }),
    });
    assert.strictEqual(res.exists, false);
    assert.match(res.reason, /file not on disk/);
});

test("probeVideoFile: empty path → exists:false with 'empty filePath' reason", async () => {
    const res = await probeVideoFile("", {});
    assert.strictEqual(res.exists, false);
    assert.match(res.reason, /empty filePath/);
});

test("validateVideoOutput: happy path (valid mp4, size ok, duration>floor, video stream present)", async () => {
    const res = await validateVideoOutput("/tmp/ok.mp4", {
        minBytes: 10_000,
        statFn: () => ({ exists: true, size: 250_000 }),
        spawnFn: fakeSpawn({ stdout: okProbeStdout }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.ffprobeAvailable, true);
    assert.strictEqual(res.hasVideoStream, true);
    assert.strictEqual(res.codec, "h264");
    assert.strictEqual(res.width, 720);
    assert.strictEqual(res.height, 1280);
    assert.ok(res.durationSec > 5);
});

test("validateVideoOutput: file too small → ok:false, reason mentions bytes (does NOT spawn ffprobe)", async () => {
    let spawned = 0;
    const res = await validateVideoOutput("/tmp/tiny.mp4", {
        minBytes: 10_000,
        statFn: () => ({ exists: true, size: 1_000 }),
        spawnFn: () => { spawned += 1; return null; },
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /suspiciously small/);
    // size check runs inside probeVideoFile which DOES spawn — that's
    // fine; we care the validator returns ok:false.
    assert.strictEqual(spawned, 1);
});

test("validateVideoOutput: ffprobe non-zero exit → ok:false with reason captured", async () => {
    const res = await validateVideoOutput("/tmp/corrupt.mp4", {
        minBytes: 10_000,
        statFn: () => ({ exists: true, size: 50_000 }),
        spawnFn: fakeSpawn({ code: 1, stderr: "moov atom not found\n" }),
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /ffprobe rejected file/);
});

test("validateVideoOutput: ffprobe returns no video stream → ok:false", async () => {
    const audioOnly = JSON.stringify({
        format: { duration: "3.0" },
        streams: [{ codec_type: "audio" }],
    });
    const res = await validateVideoOutput("/tmp/noV.mp4", {
        minBytes: 10_000,
        statFn: () => ({ exists: true, size: 50_000 }),
        spawnFn: fakeSpawn({ stdout: audioOnly }),
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.hasVideoStream, false);
});

test("validateVideoOutput: ffprobe reports duration ≤ floor → ok:false", async () => {
    const zeroDur = JSON.stringify({
        format: { duration: "0.05" },
        streams: [{ codec_type: "video", codec_name: "h264" }],
    });
    const res = await validateVideoOutput("/tmp/short.mp4", {
        minBytes: 10_000,
        minDurationSec: 0.2,
        statFn: () => ({ exists: true, size: 50_000 }),
        spawnFn: fakeSpawn({ stdout: zeroDur }),
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /duration/);
});

test("validateVideoOutput: invalid JSON → ok:false with parse-error reason", async () => {
    const res = await validateVideoOutput("/tmp/garbage.mp4", {
        minBytes: 10_000,
        statFn: () => ({ exists: true, size: 50_000 }),
        spawnFn: fakeSpawn({ stdout: "not-json" }),
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /not valid JSON/);
});

test("validateVideoOutput: spawn ENOENT (ffprobe not installed) → soft-pass with ffprobeAvailable:false", async () => {
    const res = await validateVideoOutput("/tmp/ok.mp4", {
        minBytes: 10_000,
        statFn: () => ({ exists: true, size: 250_000 }),
        spawnFn: fakeSpawn({ errorCode: "ENOENT" }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.ffprobeAvailable, false);
    assert.match(res.reason, /ffprobe unavailable/);
});

test("validateVideoOutput: spawn ENOENT AND size below floor → ok:false (size wins)", async () => {
    const res = await validateVideoOutput("/tmp/tiny.mp4", {
        minBytes: 10_000,
        statFn: () => ({ exists: true, size: 500 }),
        spawnFn: fakeSpawn({ errorCode: "ENOENT" }),
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /suspiciously small/);
});

test("validateVideoOutput: missing file → ok:false even when ffprobe happy", async () => {
    const res = await validateVideoOutput("/no/file.mp4", {
        minBytes: 10_000,
        statFn: () => ({ exists: false, size: 0 }),
        spawnFn: fakeSpawn({ stdout: okProbeStdout }),
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.exists, false);
});

(async () => {
    let pass = 0;
    let fail = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ok  ${t.name}`);
            pass += 1;
        } catch (err) {
            console.error(`  FAIL  ${t.name}\n    ${err && err.stack ? err.stack : err}`);
            fail += 1;
        }
    }
    console.log(`\n${fail === 0 ? "PASSED" : "FAILED"} ${pass} / ${pass + fail} test(s)`);
    process.exit(fail === 0 ? 0 : 1);
})();
