// Offline regression tests for `storyboard_assemble_helpers.js` (PR-31).
//
// The helpers are pure functions exported via the
// `module.exports`-friendly UMD wrapper, so we exercise them under
// plain Node without any DOM / IPC / auth mocks. Goals:
//
//   * `parseSceneVideoPaths` strips, dedupes, drops empties.
//   * `pullScenePathsFromBatch` filters by savedFile + extension and
//     orders by scene_id (stable across rows that share an id).
//   * `buildAssemblePayload` produces the documented JSON shape and
//     coerces blank/whitespace inputs to `null`.
//   * `validateAssembleForm` blocks empty submissions and surfaces
//     the heads-up for the 1-scene-no-audio degenerate case.

"use strict";

const assert = require("assert");
const helpers = require("../dist/storyboard_assemble_helpers.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── parseSceneVideoPaths ───────────────────────────────────────────────────

test("parseSceneVideoPaths: trims whitespace + drops empties + dedupes", () => {
    const out = helpers.parseSceneVideoPaths(
        "  /tmp/a.mp4  \n\n/tmp/b.mp4\n /tmp/a.mp4\n   \n/tmp/c.mp4\r\n",
    );
    assert.deepStrictEqual(out, ["/tmp/a.mp4", "/tmp/b.mp4", "/tmp/c.mp4"]);
});

test("parseSceneVideoPaths: non-string input returns []", () => {
    assert.deepStrictEqual(helpers.parseSceneVideoPaths(undefined), []);
    assert.deepStrictEqual(helpers.parseSceneVideoPaths(null), []);
    assert.deepStrictEqual(helpers.parseSceneVideoPaths(123), []);
});

// ─── pullScenePathsFromBatch ───────────────────────────────────────────────

test("pullScenePathsFromBatch: keeps savedFile rows, drops missing/wrong-ext", () => {
    const rows = [
        { scene_id: 2, savedFile: "/tmp/shot2.mp4", status: "settled" },
        { scene_id: 1, savedFile: "/tmp/shot1.mp4", status: "settled" },
        { scene_id: 3, savedFile: "", status: "fallback" },          // empty
        { scene_id: 4, savedFile: "/tmp/shot4.txt", status: "settled" }, // wrong ext
        { scene_id: 5, status: "settled" },                          // no savedFile
        { scene_id: 6, savedFile: "/tmp/shot6.mov", status: "fallback" },
    ];
    const out = helpers.pullScenePathsFromBatch(rows);
    // Sorted by scene_id ascending.
    assert.deepStrictEqual(out, [
        "/tmp/shot1.mp4",
        "/tmp/shot2.mp4",
        "/tmp/shot6.mov",
    ]);
});

test("pullScenePathsFromBatch: rows without scene_id slot in last (insertion-stable)", () => {
    const rows = [
        { savedFile: "/tmp/x.mp4" },              // no scene_id
        { scene_id: 5, savedFile: "/tmp/e.mp4" },
        { savedFile: "/tmp/y.mp4" },              // no scene_id
        { scene_id: 1, savedFile: "/tmp/a.mp4" },
    ];
    const out = helpers.pullScenePathsFromBatch(rows);
    assert.deepStrictEqual(out, [
        "/tmp/a.mp4", "/tmp/e.mp4",
        "/tmp/x.mp4", "/tmp/y.mp4",
    ]);
});

test("pullScenePathsFromBatch: non-array → []", () => {
    assert.deepStrictEqual(helpers.pullScenePathsFromBatch(null), []);
    assert.deepStrictEqual(helpers.pullScenePathsFromBatch({ a: 1 }), []);
});

test("pullScenePathsFromBatch: extension match is case-insensitive", () => {
    const rows = [
        { scene_id: 1, savedFile: "/tmp/SHOT1.MP4" },
        { scene_id: 2, savedFile: "/tmp/Shot2.WebM" },
    ];
    const out = helpers.pullScenePathsFromBatch(rows);
    assert.strictEqual(out.length, 2);
});

// ─── buildAssemblePayload ──────────────────────────────────────────────────

test("buildAssemblePayload: blank strings become null, defaults applied", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4", "  /tmp/b.mp4  "],
        audioPath: "   ",
        srtPath: "",
        outputDir: undefined,
    });
    assert.deepStrictEqual(payload, {
        scene_videos: ["/tmp/a.mp4", "/tmp/b.mp4"],
        audio_path: null,
        srt_path: null,
        output_dir: null,
        audio_mode: "replace",
        trim_to: "video",
        caption_mode: "soft",
    });
});

test("buildAssemblePayload: every documented mode echoes through", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        audioPath: "/tmp/voice.mp3",
        srtPath: "/tmp/captions.srt",
        outputDir: "/tmp/out",
        audioMode: "none",
        trimTo: "audio",
        captionMode: "none",
    });
    assert.strictEqual(payload.audio_mode, "none");
    assert.strictEqual(payload.trim_to, "audio");
    assert.strictEqual(payload.caption_mode, "none");
    assert.strictEqual(payload.audio_path, "/tmp/voice.mp3");
    assert.strictEqual(payload.srt_path, "/tmp/captions.srt");
    assert.strictEqual(payload.output_dir, "/tmp/out");
});

test("buildAssemblePayload: unknown mode values fall back to documented defaults", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        audioMode: "bogus",
        trimTo: "weird",
        captionMode: "explode",
    });
    assert.strictEqual(payload.audio_mode, "replace");
    assert.strictEqual(payload.trim_to, "video");
    assert.strictEqual(payload.caption_mode, "soft");
});

// ─── PR-32: caption_mode burn ──────────────────────────────────────────────

test("buildAssemblePayload: captionMode='burn' is forwarded to backend", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        audioPath: "/tmp/voice.mp3",
        srtPath: "/tmp/captions.srt",
        captionMode: "burn",
    });
    assert.strictEqual(payload.caption_mode, "burn");
});

test("buildAssemblePayload: every caption mode in CAPTION_MODES whitelist round-trips", () => {
    // The whitelist is the contract between the renderer and the
    // backend's Literal["soft", "none", "burn"]. If a future change
    // adds a value here, the backend must also accept it (and vice
    // versa) — this test fails fast when one half drifts.
    for (const mode of helpers.CAPTION_MODES) {
        const payload = helpers.buildAssemblePayload({
            scenePaths: ["/tmp/a.mp4"],
            captionMode: mode,
        });
        assert.strictEqual(
            payload.caption_mode, mode,
            `caption_mode '${mode}' should round-trip but became '${payload.caption_mode}'`,
        );
    }
});

test("buildAssemblePayload: DEFAULT_CAPTION_MODE matches backend default", () => {
    // The backend's AssembleRequest.caption_mode defaults to "soft".
    // The renderer should match so an undefined/missing UI value
    // produces the same wire payload as the default backend behaviour.
    assert.strictEqual(helpers.DEFAULT_CAPTION_MODE, "soft");
    const payload = helpers.buildAssemblePayload({ scenePaths: ["/tmp/a.mp4"] });
    assert.strictEqual(payload.caption_mode, helpers.DEFAULT_CAPTION_MODE);
});

test("buildAssemblePayload: missing form returns empty scene_videos", () => {
    const payload = helpers.buildAssemblePayload(undefined);
    assert.deepStrictEqual(payload.scene_videos, []);
    assert.strictEqual(payload.audio_path, null);
});

// ─── validateAssembleForm ──────────────────────────────────────────────────

test("validateAssembleForm: empty scene list disables submit", () => {
    const v = helpers.validateAssembleForm({ scenePaths: [] });
    assert.strictEqual(v.enabled, false);
    assert.match(v.reason, /at least one scene/i);
});

test("validateAssembleForm: 1 scene + no audio surfaces heads-up but stays enabled", () => {
    const v = helpers.validateAssembleForm({ scenePaths: ["/tmp/a.mp4"] });
    assert.strictEqual(v.enabled, true);
    assert.match(v.reason, /1 scene.*no narration|re-encode/i);
});

test("validateAssembleForm: 2+ scenes is unconditionally enabled with empty reason", () => {
    const v = helpers.validateAssembleForm({
        scenePaths: ["/tmp/a.mp4", "/tmp/b.mp4"],
    });
    assert.strictEqual(v.enabled, true);
    assert.strictEqual(v.reason, "");
});

test("validateAssembleForm: 1 scene + audio override is fine", () => {
    const v = helpers.validateAssembleForm({
        scenePaths: ["/tmp/a.mp4"],
        audioPath: "/tmp/voice.mp3",
    });
    assert.strictEqual(v.enabled, true);
    assert.strictEqual(v.reason, "");
});

// ─── runner ────────────────────────────────────────────────────────────────

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
