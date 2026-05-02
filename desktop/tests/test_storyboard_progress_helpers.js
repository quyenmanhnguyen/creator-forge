/**
 * Offline regression test for `desktop/dist/storyboard_progress_helpers.js`.
 *
 * The helpers drive the renderer-side long-running progress UI used
 * by `runSceneBreakdown` (PR-A). Pure functions, no DOM:
 *   - formatElapsed: 0/sub-second/seconds/minutes formatting
 *   - selectPhaseLabel: ascending phase pick by elapsed ms, with
 *     defensive handling of malformed inputs
 *   - buildProgressHtml: deterministic HTML fragment incl. escaping
 *   - DEFAULT_SCENE_BREAKDOWN_PHASES: contract pin (sorted, frozen)
 *
 * Run:
 *   node desktop/tests/test_storyboard_progress_helpers.js
 */

"use strict";

const assert = require("assert");

const helpers = require("../dist/storyboard_progress_helpers.js");

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
    // ── formatElapsed ───────────────────────────────────────────────────

    test("formatElapsed: zero / sub-second floors to '0s'", () => {
        assert.strictEqual(helpers.formatElapsed(0), "0s");
        assert.strictEqual(helpers.formatElapsed(900), "0s");
        assert.strictEqual(helpers.formatElapsed(999), "0s");
    });

    test("formatElapsed: whole seconds under 1m", () => {
        assert.strictEqual(helpers.formatElapsed(1000), "1s");
        assert.strictEqual(helpers.formatElapsed(12_000), "12s");
        assert.strictEqual(helpers.formatElapsed(59_999), "59s");
    });

    test("formatElapsed: minutes + seconds split at 1m", () => {
        assert.strictEqual(helpers.formatElapsed(60_000), "1m 0s");
        assert.strictEqual(helpers.formatElapsed(75_000), "1m 15s");
        assert.strictEqual(helpers.formatElapsed(125_500), "2m 5s");
    });

    test("formatElapsed: defensive against bad inputs", () => {
        // Malformed inputs must clamp to '0s' so the timer never
        // renders 'NaNs' / 'Infinitys' under a misbehaving caller.
        assert.strictEqual(helpers.formatElapsed(-100), "0s");
        assert.strictEqual(helpers.formatElapsed(NaN), "0s");
        assert.strictEqual(helpers.formatElapsed(Infinity), "0s");
        assert.strictEqual(helpers.formatElapsed("abc"), "0s");
        assert.strictEqual(helpers.formatElapsed(null), "0s");
        assert.strictEqual(helpers.formatElapsed(undefined), "0s");
    });

    // ── selectPhaseLabel ────────────────────────────────────────────────

    const PHASES = [
        { at_ms: 0,     text: "starting" },
        { at_ms: 5000,  text: "phase A" },
        { at_ms: 10000, text: "phase B" },
        { at_ms: 30000, text: "phase C" },
    ];

    test("selectPhaseLabel: returns the largest at_ms <= elapsed", () => {
        assert.strictEqual(helpers.selectPhaseLabel(PHASES, 0), "starting");
        assert.strictEqual(helpers.selectPhaseLabel(PHASES, 4999), "starting");
        assert.strictEqual(helpers.selectPhaseLabel(PHASES, 5000), "phase A");
        assert.strictEqual(helpers.selectPhaseLabel(PHASES, 9999), "phase A");
        assert.strictEqual(helpers.selectPhaseLabel(PHASES, 10_000), "phase B");
        assert.strictEqual(helpers.selectPhaseLabel(PHASES, 99_999), "phase C");
    });

    test("selectPhaseLabel: empty before first milestone returns ''", () => {
        const phases = [{ at_ms: 5000, text: "first phase" }];
        assert.strictEqual(helpers.selectPhaseLabel(phases, 0), "");
        assert.strictEqual(helpers.selectPhaseLabel(phases, 4999), "");
        assert.strictEqual(helpers.selectPhaseLabel(phases, 5000), "first phase");
    });

    test("selectPhaseLabel: handles unsorted input by sorting internally", () => {
        const out_of_order = [
            { at_ms: 30000, text: "C" },
            { at_ms: 0,     text: "A" },
            { at_ms: 10000, text: "B" },
        ];
        assert.strictEqual(helpers.selectPhaseLabel(out_of_order, 0), "A");
        assert.strictEqual(helpers.selectPhaseLabel(out_of_order, 10_000), "B");
        assert.strictEqual(helpers.selectPhaseLabel(out_of_order, 99_999), "C");
    });

    test("selectPhaseLabel: skips malformed entries instead of crashing", () => {
        const messy = [
            { at_ms: 0,     text: "ok-0" },
            { at_ms: "bad", text: "drop me" },           // non-numeric at_ms
            { at_ms: 5000 }, // missing text
            null,                                         // null entry
            { at_ms: 10000, text: "ok-10" },
            { text: "no at_ms" },                          // missing at_ms
        ];
        assert.strictEqual(helpers.selectPhaseLabel(messy, 0), "ok-0");
        assert.strictEqual(helpers.selectPhaseLabel(messy, 5000), "ok-0");
        assert.strictEqual(helpers.selectPhaseLabel(messy, 10_000), "ok-10");
    });

    test("selectPhaseLabel: non-array phases returns ''", () => {
        assert.strictEqual(helpers.selectPhaseLabel(null, 1000), "");
        assert.strictEqual(helpers.selectPhaseLabel(undefined, 1000), "");
        assert.strictEqual(helpers.selectPhaseLabel("not-an-array", 1000), "");
        assert.strictEqual(helpers.selectPhaseLabel({}, 1000), "");
    });

    test("selectPhaseLabel: bad elapsed defaults to 0", () => {
        // NaN/non-finite elapsed should not crash; treat as 0.
        const phases = [
            { at_ms: 0, text: "zero" },
            { at_ms: 5000, text: "five" },
        ];
        assert.strictEqual(helpers.selectPhaseLabel(phases, NaN), "zero");
        assert.strictEqual(helpers.selectPhaseLabel(phases, "abc"), "zero");
        assert.strictEqual(helpers.selectPhaseLabel(phases, undefined), "zero");
    });

    test("selectPhaseLabel: input array is not mutated", () => {
        // Defensive contract: the caller may freeze its phases array
        // (we do for the default exports), so the helper must not
        // try to sort in place.
        const original = [
            { at_ms: 30000, text: "C" },
            { at_ms: 0,     text: "A" },
            { at_ms: 10000, text: "B" },
        ];
        const snapshot = original.map((p) => ({ ...p }));
        helpers.selectPhaseLabel(original, 50_000);
        assert.deepStrictEqual(original, snapshot);
    });

    // ── DEFAULT_SCENE_BREAKDOWN_PHASES ─────────────────────────────────

    test("DEFAULT_SCENE_BREAKDOWN_PHASES: sorted ascending by at_ms", () => {
        const phases = helpers.DEFAULT_SCENE_BREAKDOWN_PHASES;
        assert.ok(Array.isArray(phases), "must be an array");
        assert.ok(phases.length >= 3, "should have at least 3 phases");
        for (let i = 1; i < phases.length; i++) {
            assert.ok(
                phases[i - 1].at_ms <= phases[i].at_ms,
                `phase ${i} (at_ms=${phases[i].at_ms}) is before phase ${i - 1} (at_ms=${phases[i - 1].at_ms})`
            );
        }
    });

    test("DEFAULT_SCENE_BREAKDOWN_PHASES: every entry is fully populated", () => {
        for (const p of helpers.DEFAULT_SCENE_BREAKDOWN_PHASES) {
            assert.ok(typeof p.at_ms === "number" && Number.isFinite(p.at_ms),
                `at_ms must be a finite number: ${JSON.stringify(p)}`);
            assert.ok(typeof p.text === "string" && p.text.length > 0,
                `text must be a non-empty string: ${JSON.stringify(p)}`);
        }
    });

    test("DEFAULT_SCENE_BREAKDOWN_PHASES: starts at 0 so the very-first paint is never blank", () => {
        const first = helpers.DEFAULT_SCENE_BREAKDOWN_PHASES[0];
        assert.strictEqual(first.at_ms, 0,
            "first phase must trigger at elapsed=0 so the renderer has a label to paint immediately");
    });

    test("DEFAULT_SCENE_BREAKDOWN_PHASES: frozen so callers can't mutate the shared array", () => {
        const phases = helpers.DEFAULT_SCENE_BREAKDOWN_PHASES;
        assert.ok(Object.isFrozen(phases), "phases array must be frozen");
        for (const p of phases) {
            assert.ok(Object.isFrozen(p), `phase ${JSON.stringify(p)} must be frozen`);
        }
    });

    // ── buildProgressHtml ──────────────────────────────────────────────

    test("buildProgressHtml: includes label, elapsed, spinner, and bar", () => {
        const html = helpers.buildProgressHtml({
            label: "Working hard",
            phaseText: "phase A",
            elapsedText: "12s",
        });
        assert.ok(html.includes("progress-block"), "must include progress-block class");
        assert.ok(html.includes("progress-bar"), "must include progress-bar class");
        assert.ok(html.includes("spinner"), "must include the existing spinner span");
        assert.ok(html.includes("Working hard"), "must include the label");
        assert.ok(html.includes("phase A"), "must include the phase text");
        assert.ok(html.includes("12s"), "must include the elapsed text");
    });

    test("buildProgressHtml: phaseText empty → no phase row", () => {
        const html = helpers.buildProgressHtml({
            label: "L",
            phaseText: "",
            elapsedText: "0s",
        });
        assert.ok(!html.includes("progress-phase"), "empty phaseText must omit the phase row entirely");
    });

    test("buildProgressHtml: hint omitted by default", () => {
        const html = helpers.buildProgressHtml({
            label: "L", phaseText: "p", elapsedText: "1s",
        });
        assert.ok(!html.includes("progress-hint"), "missing hint must omit the hint row");
    });

    test("buildProgressHtml: hint rendered when provided", () => {
        const html = helpers.buildProgressHtml({
            label: "L", phaseText: "p", elapsedText: "5s",
            hint: "Usually 30-90s",
        });
        assert.ok(html.includes("progress-hint"), "hint must add the hint row");
        assert.ok(html.includes("Usually 30-90s"), "hint text must appear verbatim");
    });

    test("buildProgressHtml: escapes HTML in label / phase / elapsed / hint", () => {
        // Belt-and-suspenders security: even though every caller is
        // in-process, a script that ever sources phase text from a
        // payload must not be able to inject markup.
        const html = helpers.buildProgressHtml({
            label: "<script>alert(1)</script>",
            phaseText: "phase <b>X</b>",
            elapsedText: "<5s>",
            hint: "tip & trick \"quoted\" 'apos'",
        });
        assert.ok(!html.includes("<script>"), "label must be escaped");
        assert.ok(html.includes("&lt;script&gt;"), "label must be HTML-encoded");
        assert.ok(!html.includes("<b>"), "phaseText must be escaped");
        assert.ok(html.includes("&lt;5s&gt;"), "elapsedText must be escaped");
        assert.ok(html.includes("&amp;"), "ampersands in hint must be escaped");
        assert.ok(html.includes("&quot;"), "double quotes in hint must be escaped");
        assert.ok(html.includes("&#39;"), "apostrophes in hint must be escaped");
    });

    test("buildProgressHtml: missing/blank label falls back to 'Working…'", () => {
        const a = helpers.buildProgressHtml({ phaseText: "p", elapsedText: "0s" });
        const b = helpers.buildProgressHtml({ label: "", phaseText: "p", elapsedText: "0s" });
        assert.ok(a.includes("Working"), "missing label should fall back to 'Working…'");
        assert.ok(b.includes("Working"), "blank label should fall back to 'Working…'");
    });

    test("buildProgressHtml: malformed opts → safe defaults, no throw", () => {
        // Renderer will sometimes call this on a freshly loaded panel
        // before the actual values are computed. The helper must
        // never throw on undefined / null / wrong-typed opts.
        assert.doesNotThrow(() => helpers.buildProgressHtml(null));
        assert.doesNotThrow(() => helpers.buildProgressHtml(undefined));
        assert.doesNotThrow(() => helpers.buildProgressHtml("not an object"));
        assert.doesNotThrow(() => helpers.buildProgressHtml({ label: 42, phaseText: 0 }));
        const html = helpers.buildProgressHtml(undefined);
        assert.ok(html.includes("progress-block"), "still produces the wrapper on null opts");
        assert.ok(html.includes("0s"), "elapsedText defaults to '0s' when missing");
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
