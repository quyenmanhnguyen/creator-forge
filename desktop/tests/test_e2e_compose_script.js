/**
 * Offline regression test for `scripts/e2e_compose_with_scene_assets.js`.
 *
 * Exercises the pure helpers (parseArgs / pickUsableImages /
 * buildSceneAssets / validateShortResponse) — no sidecar, no HTTP, no Grok.
 *
 * Run:
 *   node desktop/tests/test_e2e_compose_script.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const harness = require("../../scripts/e2e_compose_with_scene_assets.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL ${name}`);
        console.error("       " + (err && err.stack ? err.stack : err));
        failed++;
    }
}

// ── parseArgs ────────────────────────────────────────────────────────────────

test("parseArgs: --key value pairs", () => {
    const args = harness.parseArgs(["--input-dir", "/tmp/x", "--duration", "5"]);
    assert.strictEqual(args["input-dir"], "/tmp/x");
    assert.strictEqual(args.duration, "5");
});

test("parseArgs: positional collapses into --input-dir", () => {
    const args = harness.parseArgs(["./e2e-output/ts"]);
    assert.strictEqual(args["input-dir"], "./e2e-output/ts");
});

test("parseArgs: explicit --input-dir wins over positional", () => {
    const args = harness.parseArgs(["./pos", "--input-dir", "/explicit"]);
    assert.strictEqual(args["input-dir"], "/explicit");
});

test("parseArgs: boolean flags", () => {
    const args = harness.parseArgs(["--keep-sidecar", "--limit", "3"]);
    assert.strictEqual(args["keep-sidecar"], true);
    assert.strictEqual(args.limit, "3");
});

test("parseArgs: --help short and long", () => {
    assert.strictEqual(harness.parseArgs(["-h"]).help, true);
    assert.strictEqual(harness.parseArgs(["--help"]).help, true);
});

// ── pickUsableImages ─────────────────────────────────────────────────────────

test("pickUsableImages: filters by ≥ 50 KB and allowed extensions", () => {
    const fakeStat = (p) => {
        const sizes = {
            "/d/a.jpg": { size: 60_000 },
            "/d/b.jpg": { size: 10_000 },
            "/d/c.png": { size: 80_000 },
            "/d/notes.txt": { size: 90_000 },
            "/d/d.webp": { size: 50_001 },
        };
        if (!(p in sizes)) throw new Error("ENOENT " + p);
        return sizes[p];
    };
    const fakeReaddir = () => ["a.jpg", "b.jpg", "c.png", "notes.txt", "d.webp"];

    const { picked, skipped } = harness.pickUsableImages("/d", {
        statFn: fakeStat,
        readdirFn: fakeReaddir,
    });

    assert.deepStrictEqual(
        picked.map((p) => path.basename(p.path)),
        ["a.jpg", "c.png", "d.webp"]
    );
    // notes.txt is filtered by extension before any stat — it doesn't show up
    // in `skipped` (would be noise). Only b.jpg surfaces because it failed the
    // size check.
    assert.deepStrictEqual(
        skipped.map((s) => path.basename(s.path)),
        ["b.jpg"]
    );
    assert.match(skipped[0].reason, /< 50000/);
});

test("pickUsableImages: lexicographic sort by basename", () => {
    const fakeStat = () => ({ size: 100_000 });
    const fakeReaddir = () => ["c.jpg", "a.jpg", "b.jpg"];
    const { picked } = harness.pickUsableImages("/d", {
        statFn: fakeStat,
        readdirFn: fakeReaddir,
    });
    assert.deepStrictEqual(
        picked.map((p) => path.basename(p.path)),
        ["a.jpg", "b.jpg", "c.jpg"]
    );
});

test("pickUsableImages: throws EINPUTDIR when readdir fails", () => {
    let err;
    try {
        harness.pickUsableImages("/missing", {
            readdirFn: () => {
                throw new Error("ENOENT");
            },
        });
    } catch (e) {
        err = e;
    }
    assert.ok(err, "expected throw");
    assert.strictEqual(err.code, "EINPUTDIR");
    assert.match(err.message, /Cannot read --input-dir \/missing/);
});

test("pickUsableImages: real fs round-trip on tmpdir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-e2e-"));
    fs.writeFileSync(path.join(dir, "ok.jpg"), Buffer.alloc(60_000, 1));
    fs.writeFileSync(path.join(dir, "small.jpg"), Buffer.alloc(10_000, 1));
    fs.writeFileSync(path.join(dir, "ignore.bin"), Buffer.alloc(100_000, 1));

    const { picked, skipped } = harness.pickUsableImages(dir);
    assert.strictEqual(picked.length, 1);
    assert.strictEqual(path.basename(picked[0].path), "ok.jpg");
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(path.basename(skipped[0].path), "small.jpg");

    fs.rmSync(dir, { recursive: true, force: true });
});

// ── buildSceneAssets ─────────────────────────────────────────────────────────

test("buildSceneAssets: cumulative start_s with default duration", () => {
    const images = [{ path: "/i/a.jpg" }, { path: "/i/b.jpg" }, { path: "/i/c.jpg" }];
    const assets = harness.buildSceneAssets(images);
    assert.deepStrictEqual(assets, [
        { image_path: "/i/a.jpg", start_s: 0, duration_s: 4 },
        { image_path: "/i/b.jpg", start_s: 4, duration_s: 4 },
        { image_path: "/i/c.jpg", start_s: 8, duration_s: 4 },
    ]);
});

test("buildSceneAssets: custom per-scene duration", () => {
    const images = [{ path: "/x/1.jpg" }, { path: "/x/2.jpg" }];
    const assets = harness.buildSceneAssets(images, { duration: 6.5 });
    assert.strictEqual(assets[0].start_s, 0);
    assert.strictEqual(assets[1].start_s, 6.5);
    assert.strictEqual(assets[0].duration_s, 6.5);
    assert.strictEqual(assets[1].duration_s, 6.5);
});

test("buildSceneAssets: empty input yields empty output", () => {
    assert.deepStrictEqual(harness.buildSceneAssets([]), []);
});

// ── validateShortResponse ────────────────────────────────────────────────────

test("validateShortResponse: happy path", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 3,
            scenes_missing: 0,
            warnings: [],
        },
        3
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exitCode, 0);
    assert.deepStrictEqual(r.problems, []);
});

test("validateShortResponse: empty mp4_path → exit 4", () => {
    const r = harness.validateShortResponse(
        { mp4_path: "", scenes_used: 3, scenes_missing: 0, warnings: [] },
        3
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 4);
});

test("validateShortResponse: scenes_missing > 0 → exit 5", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 2,
            scenes_missing: 1,
            warnings: [],
        },
        3
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 5);
});

test("validateShortResponse: warnings present → exit 5", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 3,
            scenes_missing: 0,
            warnings: ["TTS hiccup"],
        },
        3
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 5);
    assert.match(r.problems.join(" "), /TTS hiccup/);
});

test("validateShortResponse: scenes_used mismatch → exit 6", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 2,
            scenes_missing: 0,
            warnings: [],
        },
        3
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 6);
});

test("validateShortResponse: missing response object → exit 4", () => {
    const r = harness.validateShortResponse(null, 3);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 4);
});

// ── PR-17: --allow-partial flag ─────────────────────────────────────────────

test("parseArgs: --allow-partial parsed as boolean", () => {
    const a = harness.parseArgs(["--input-dir", "x", "--allow-partial"]);
    assert.strictEqual(a["allow-partial"], true);
});

test("validateShortResponse: --allow-partial downgrades scenes_missing to notice", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 2,
            scenes_missing: 1,
            warnings: [],
        },
        3,
        { allowPartial: true },
    );
    assert.strictEqual(r.ok, true, "ok=true under allow_partial");
    assert.strictEqual(r.exitCode, 0);
    assert.ok(Array.isArray(r.notices) && r.notices.length === 1, "1 notice");
    assert.match(r.notices[0], /scenes_missing=1/);
});

test("validateShortResponse: --allow-partial downgrades warnings to notice", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 3,
            scenes_missing: 0,
            warnings: ["scene 2 fell back to gradient"],
        },
        3,
        { allowPartial: true },
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.notices.length === 1);
    assert.match(r.notices[0], /scene 2 fell back/);
});

test("validateShortResponse: --allow-partial still fails on empty mp4_path", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "",
            scenes_used: 0,
            scenes_missing: 3,
            warnings: ["everything failed"],
        },
        3,
        { allowPartial: true },
    );
    assert.strictEqual(r.ok, false, "mp4_path empty is non-negotiable");
    assert.strictEqual(r.exitCode, 4);
});

test("validateShortResponse: --allow-partial accepts scenes_used <= expected (partial)", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 2,
            scenes_missing: 1,
            warnings: [],
        },
        3,
        { allowPartial: true },
    );
    assert.strictEqual(r.ok, true);
});

test("validateShortResponse: --allow-partial rejects scenes_used > expected", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 5,
            scenes_missing: 0,
            warnings: [],
        },
        3,
        { allowPartial: true },
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 6);
});

test("validateShortResponse: without --allow-partial, scenes_missing > 0 still fails", () => {
    const r = harness.validateShortResponse(
        {
            mp4_path: "/out/short.mp4",
            scenes_used: 2,
            scenes_missing: 1,
            warnings: [],
        },
        3,
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 5);
});

// ── results ─────────────────────────────────────────────────────────────────

console.log("");
console.log(`# results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
