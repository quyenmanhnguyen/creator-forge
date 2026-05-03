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

// PR-B regression coverage: real-flow batch rows carry the path on
// ``video_path`` (set by ``applyBatchResult``), not ``savedFile``;
// status comes through as ``generated`` / ``retried``, not the
// legacy ``settled``. Before PR-B the helper looked at the wrong
// field and produced an empty list, breaking the Video Assembly
// auto-fill in real flow.

test("pullScenePathsFromBatch: real-flow video_path + status='generated' is kept", () => {
    const rows = [
        { scene_id: 1, video_path: "/tmp/v1.mp4", status: "generated" },
        { scene_id: 2, video_path: "/tmp/v2.mp4", status: "retried" },
        { scene_id: 3, video_path: "/tmp/v3.mp4", status: "generated" },
    ];
    const out = helpers.pullScenePathsFromBatch(rows);
    assert.deepStrictEqual(out, ["/tmp/v1.mp4", "/tmp/v2.mp4", "/tmp/v3.mp4"]);
});

test("pullScenePathsFromBatch: status='generating'/'pending'/'failed'/'skipped' rows are dropped", () => {
    const rows = [
        { scene_id: 1, video_path: "/tmp/v1.mp4", status: "generated" },
        { scene_id: 2, video_path: "/tmp/v2.mp4", status: "generating" },
        { scene_id: 3, video_path: "/tmp/v3.mp4", status: "pending" },
        { scene_id: 4, video_path: "/tmp/v4.mp4", status: "failed" },
        { scene_id: 5, video_path: "/tmp/v5.mp4", status: "skipped" },
        { scene_id: 6, video_path: "/tmp/v6.mp4", status: "fallback" },
    ];
    const out = helpers.pullScenePathsFromBatch(rows);
    assert.deepStrictEqual(out, ["/tmp/v1.mp4", "/tmp/v6.mp4"]);
});

test("pullScenePathsFromBatch: prefers video_path over savedFile when both present", () => {
    const rows = [
        // Real flow shouldn't ever set both, but if upstream copies
        // the IPC ``savedFile`` AND the renderer fills in ``video_path``
        // we want the renderer-side (canonical) value to win.
        { scene_id: 1, video_path: "/tmp/canonical.mp4", savedFile: "/tmp/legacy.mp4", status: "generated" },
    ];
    const out = helpers.pullScenePathsFromBatch(rows);
    assert.deepStrictEqual(out, ["/tmp/canonical.mp4"]);
});

test("pullScenePathsFromBatch: legacy savedFile-only rows still work without status (back-compat)", () => {
    const rows = [
        { scene_id: 1, savedFile: "/tmp/a.mp4" },
        { scene_id: 2, savedFile: "/tmp/b.mp4" },
    ];
    const out = helpers.pullScenePathsFromBatch(rows);
    assert.deepStrictEqual(out, ["/tmp/a.mp4", "/tmp/b.mp4"]);
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

// ─── HF-10 — burn caption styling ──────────────────────────────────────────
//
// The renderer-side whitelist + ``buildAssemblePayload`` must agree
// with the backend's ``CAPTION_STYLE_PRESETS`` / ``CaptionFontSize``
// / ``CaptionPosition`` Literals. These tests pin the contract:
//
//   * The four constants exist and contain the documented values.
//   * Burn payloads include caption_style + caption_font_size +
//     caption_position fields (non-burn omits them entirely).
//   * Unknown style / font-size / position values fall back to the
//     default / null so a stale renderer never produces a 422.
//   * ``DEFAULT_CAPTION_STYLE`` matches the backend's default
//     ("modern").

test("CAPTION_STYLES whitelist matches backend's CaptionStyle Literal", () => {
    // ``research/core/pixelle/assembler.py:CAPTION_STYLE_PRESETS`` keys
    // are the source of truth — keep this list in lock-step.
    assert.deepStrictEqual(
        [...helpers.CAPTION_STYLES].sort(),
        ["cinematic", "minimal", "modern", "tiktok"],
    );
});

test("CAPTION_FONT_SIZES whitelist exposes small / medium / large", () => {
    assert.deepStrictEqual(
        [...helpers.CAPTION_FONT_SIZES].sort(),
        ["large", "medium", "small"],
    );
});

test("CAPTION_POSITIONS whitelist exposes bottom / middle / top", () => {
    assert.deepStrictEqual(
        [...helpers.CAPTION_POSITIONS].sort(),
        ["bottom", "middle", "top"],
    );
});

test("DEFAULT_CAPTION_STYLE matches backend default ('modern')", () => {
    // The backend's AssembleRequest.caption_style defaults to "modern".
    assert.strictEqual(helpers.DEFAULT_CAPTION_STYLE, "modern");
});

test("buildAssemblePayload: burn mode includes caption_style + font_size + position fields", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        srtPath: "/tmp/captions.srt",
        captionMode: "burn",
        captionStyle: "tiktok",
        captionFontSize: "large",
        captionPosition: "top",
    });
    assert.strictEqual(payload.caption_mode, "burn");
    assert.strictEqual(payload.caption_style, "tiktok");
    assert.strictEqual(payload.caption_font_size, "large");
    assert.strictEqual(payload.caption_position, "top");
});

test("buildAssemblePayload: burn mode without overrides defaults to modern + null overrides", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        captionMode: "burn",
        // No captionStyle/FontSize/Position — exercise defaults.
    });
    assert.strictEqual(payload.caption_style, "modern");
    assert.strictEqual(payload.caption_font_size, null);
    assert.strictEqual(payload.caption_position, null);
});

test("buildAssemblePayload: soft mode omits the caption_style fields entirely", () => {
    // Wire-payload minimisation — the backend's AssembleRequest
    // ignores caption_style for non-burn modes anyway, so sending
    // them just bloats the request. Confirm the helper drops them.
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        captionMode: "soft",
        captionStyle: "tiktok",
        captionFontSize: "large",
        captionPosition: "top",
    });
    assert.strictEqual(payload.caption_mode, "soft");
    assert.strictEqual("caption_style" in payload, false);
    assert.strictEqual("caption_font_size" in payload, false);
    assert.strictEqual("caption_position" in payload, false);
});

test("buildAssemblePayload: 'none' caption mode also omits the styling fields", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        captionMode: "none",
        captionStyle: "tiktok",
    });
    assert.strictEqual(payload.caption_mode, "none");
    assert.strictEqual("caption_style" in payload, false);
});

test("buildAssemblePayload: invalid captionStyle in burn mode falls back to default", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        captionMode: "burn",
        captionStyle: "ferrari-red",
    });
    assert.strictEqual(payload.caption_style, helpers.DEFAULT_CAPTION_STYLE);
});

test("buildAssemblePayload: invalid captionFontSize in burn mode collapses to null", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        captionMode: "burn",
        captionFontSize: "huge",
    });
    assert.strictEqual(payload.caption_font_size, null);
});

test("buildAssemblePayload: invalid captionPosition in burn mode collapses to null", () => {
    const payload = helpers.buildAssemblePayload({
        scenePaths: ["/tmp/a.mp4"],
        captionMode: "burn",
        captionPosition: "diagonal",
    });
    assert.strictEqual(payload.caption_position, null);
});

test("buildAssemblePayload: every CAPTION_STYLE round-trips intact when burn is selected", () => {
    // Pin the whitelist contract — if a future change adds a key it
    // must propagate through buildAssemblePayload too.
    for (const style of helpers.CAPTION_STYLES) {
        const payload = helpers.buildAssemblePayload({
            scenePaths: ["/tmp/a.mp4"],
            captionMode: "burn",
            captionStyle: style,
        });
        assert.strictEqual(
            payload.caption_style, style,
            `caption_style '${style}' should round-trip but became '${payload.caption_style}'`,
        );
    }
});

test("buildAssemblePayload: every CAPTION_FONT_SIZE / CAPTION_POSITION round-trips when burn", () => {
    for (const size of helpers.CAPTION_FONT_SIZES) {
        const payload = helpers.buildAssemblePayload({
            scenePaths: ["/tmp/a.mp4"],
            captionMode: "burn",
            captionFontSize: size,
        });
        assert.strictEqual(payload.caption_font_size, size);
    }
    for (const pos of helpers.CAPTION_POSITIONS) {
        const payload = helpers.buildAssemblePayload({
            scenePaths: ["/tmp/a.mp4"],
            captionMode: "burn",
            captionPosition: pos,
        });
        assert.strictEqual(payload.caption_position, pos);
    }
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
