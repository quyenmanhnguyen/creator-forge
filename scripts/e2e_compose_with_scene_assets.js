#!/usr/bin/env node
"use strict";

/**
 * Standalone E2E harness for the Phase 5 / PR-14 compose-with-scene_assets path.
 *
 * Drives the curl-only branch documented in `docs/e2e-full-pipeline.md`:
 *   - Pick the AutoGrok-saved images from a directory (default ≥ 50 KB; the
 *     PR-9 blur threshold).
 *   - Build a `scene_assets[]` request with cumulative `start_s` from a
 *     uniform per-scene duration.
 *   - Probe `http://127.0.0.1:<port>/healthz`. If a creator-forge sidecar is
 *     already running, reuse it; otherwise spawn one via
 *     `desktop/electron/researchSidecar.js` (idempotent, repo-aware) and tear
 *     it down on exit.
 *   - POST `/producer/short` with the resolved `scene_assets[]`.
 *   - Verify the response: `mp4_path` non-empty, `scenes_used == n`,
 *     `scenes_missing == 0`, `warnings == []`. Exit non-zero on any failure
 *     so CI / local scripting can chain it after `e2e_autogrok_image.js`.
 *
 * Usage:
 *   node scripts/e2e_compose_with_scene_assets.js \
 *        --input-dir e2e-output/2026-04-30T01-41-03-046Z
 *
 *   # Override defaults:
 *   node scripts/e2e_compose_with_scene_assets.js \
 *        --input-dir e2e-output/<ts> \
 *        --script-file my-script.txt \
 *        --duration 5 --voice en-US-AriaNeural --style violet-pink
 *
 * Optional env:
 *   CREATOR_FORGE_RESEARCH_PORT  Sidecar port. Default 5050.
 *   CREATOR_FORGE_PYTHON         Python executable for spawn. Default
 *                                `python3` (or `python` on Windows).
 *
 * Exit codes:
 *   0  All assertions passed (mp4 produced, no missing scenes, no warnings).
 *   1  Generic error (bad args, unreadable files, etc.)
 *   2  No usable images (≥ 50 KB) found in --input-dir.
 *   3  Sidecar didn't become healthy.
 *   4  /producer/short returned but mp4_path is empty (compose failed).
 *   5  /producer/short reports scenes_missing > 0 or warnings[] non-empty.
 *   6  scenes_used didn't match the supplied scene_assets[] length.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");

// ── Pure helpers (exported for offline tests) ───────────────────────────────

/** Parse `--key value` / `--flag` / positional args into a flat object. */
function parseArgs(argv) {
    const out = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            out.help = true;
            continue;
        }
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) {
                out[key] = true; // boolean flag
            } else {
                out[key] = next;
                i++;
            }
            continue;
        }
        positional.push(a);
    }
    if (positional.length > 0 && out["input-dir"] === undefined) {
        out["input-dir"] = positional[0];
    }
    return out;
}

/**
 * Walk `dir` (one level) and return image files filtered by minimum size.
 *
 * Stable order: lexicographic by basename so cumulative `start_s` lines up
 * with the scene sequence the AutoGrok harness wrote (`image_01.jpg`,
 * `image_02.jpg`, …).
 */
function pickUsableImages(dir, opts = {}) {
    const minBytes = typeof opts.minBytes === "number" ? opts.minBytes : 50_000;
    const allowedExt = new Set([".jpg", ".jpeg", ".png", ".webp"]);
    const stat = opts.statFn || ((p) => fs.statSync(p));
    const readdir = opts.readdirFn || ((d) => fs.readdirSync(d));

    let entries;
    try {
        entries = readdir(dir);
    } catch (err) {
        const e = new Error(`Cannot read --input-dir ${dir}: ${err.message}`);
        e.code = "EINPUTDIR";
        throw e;
    }

    const picked = [];
    const skipped = [];
    for (const name of entries.slice().sort()) {
        const ext = path.extname(name).toLowerCase();
        if (!allowedExt.has(ext)) continue;
        const full = path.resolve(dir, name);
        let size = 0;
        try {
            size = stat(full).size;
        } catch (err) {
            skipped.push({ path: full, reason: `stat failed: ${err.message}` });
            continue;
        }
        if (size < minBytes) {
            skipped.push({ path: full, reason: `< ${minBytes} bytes (got ${size})` });
            continue;
        }
        picked.push({ path: full, size });
    }
    return { picked, skipped };
}

/**
 * Build `scene_assets[]` with cumulative `start_s` from a uniform per-scene
 * duration. Mirrors `StoryboardBridge.composeWithScenes` step 4 except it
 * doesn't have per-scene durations available (one-shot harness).
 */
function buildSceneAssets(images, { duration = 4 } = {}) {
    const assets = [];
    let cursor = 0;
    for (const img of images) {
        assets.push({
            image_path: img.path,
            start_s: Number(cursor.toFixed(3)),
            duration_s: duration,
        });
        cursor += duration;
    }
    return assets;
}

/**
 * Validate a `/producer/short` ShortResponse against the supplied scene
 * count. Returns `{ ok, exitCode, problems[] }`.
 */
function validateShortResponse(resp, expectedSceneCount) {
    const problems = [];
    let exitCode = 0;
    if (!resp || typeof resp !== "object") {
        return { ok: false, exitCode: 4, problems: ["empty/invalid response"] };
    }
    // Order matters: more specific causes (missing files / upstream warnings)
    // are checked before the count mismatch they would produce, so the exit
    // code reflects the root cause, not the symptom.
    if (!resp.mp4_path) {
        problems.push("mp4_path is empty (compose failed)");
        exitCode = exitCode || 4;
    }
    if (Number(resp.scenes_missing) > 0) {
        problems.push(`scenes_missing=${resp.scenes_missing} (must be 0)`);
        exitCode = exitCode || 5;
    }
    if (Array.isArray(resp.warnings) && resp.warnings.length > 0) {
        problems.push(`warnings: ${JSON.stringify(resp.warnings)}`);
        exitCode = exitCode || 5;
    }
    if (Number(resp.scenes_used) !== expectedSceneCount) {
        problems.push(
            `scenes_used=${resp.scenes_used} expected ${expectedSceneCount} (mismatch)`
        );
        exitCode = exitCode || 6;
    }
    return { ok: problems.length === 0, exitCode, problems };
}

/** POST a JSON body to `http://127.0.0.1:<port><path>` and return parsed JSON. */
function postJson({ port, path: urlPath, body, timeoutMs = 600_000 }) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body), "utf8");
        const req = http.request(
            {
                host: "127.0.0.1",
                port,
                path: urlPath,
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": payload.length,
                },
                timeout: timeoutMs,
            },
            (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    data += chunk;
                });
                res.on("end", () => {
                    if (res.statusCode === undefined) {
                        reject(new Error("no status code from sidecar"));
                        return;
                    }
                    try {
                        resolve({ status: res.statusCode, json: JSON.parse(data) });
                    } catch (err) {
                        reject(
                            new Error(
                                `non-JSON response (status ${res.statusCode}): ` +
                                    data.slice(0, 500)
                            )
                        );
                    }
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
        });
        req.write(payload);
        req.end();
    });
}

const DEFAULT_SCRIPT =
    "Welcome to the creator forge end to end test. " +
    "We start with a brand new niche and a curated keyword list. " +
    "Our scriptwriter sketches the outline and fills in the narration. " +
    "Each scene gets its own Grok generated background image. " +
    "We compose the final short with voiceover, captions, and Ken Burns visuals.";

const HELP = `\
Usage: node scripts/e2e_compose_with_scene_assets.js --input-dir <dir> [options]

Required:
  --input-dir <dir>     Directory of AutoGrok-saved images (typically
                        e2e-output/<timestamp>/). Files ≥ 50 KB with
                        .jpg/.jpeg/.png/.webp are picked, sorted by name.

Optional:
  --script <text>       Narration script. Default: a 5-sentence smoke script.
  --script-file <path>  Read narration from a file (overrides --script).
  --voice <name>        Edge-TTS voice short name. Default en-US-AriaNeural.
  --style <name>        Gradient style fallback. Default violet-pink.
  --duration <seconds>  Per-scene duration_s. Default 4.
  --limit <n>           Use only the first N usable images.
  --output-dir <dir>    Override sidecar output dir.
  --port <n>            Sidecar port. Default $CREATOR_FORGE_RESEARCH_PORT or 5050.
  --keep-sidecar        Don't tear down sidecar on exit (useful when iterating).
  -h, --help            Show this help.

Exit codes: 0 ok | 2 no usable images | 3 sidecar unhealthy
            4 mp4 not produced | 5 missing/warnings | 6 scenes_used mismatch
`;

function log(...args) {
    const t = new Date().toISOString().slice(11, 19);
    console.log(`[E2E ${t}]`, ...args);
}

async function main(argv) {
    const args = parseArgs(argv);

    if (args.help) {
        process.stdout.write(HELP);
        return 0;
    }
    if (!args["input-dir"]) {
        process.stderr.write("ERROR: --input-dir is required.\n\n" + HELP);
        return 1;
    }

    const inputDir = path.resolve(args["input-dir"]);
    const port = Number(args.port || process.env.CREATOR_FORGE_RESEARCH_PORT || 5050);
    const duration = Number(args.duration || 4);
    if (!(duration > 0)) {
        process.stderr.write(`ERROR: --duration must be > 0 (got ${args.duration})\n`);
        return 1;
    }

    let script = DEFAULT_SCRIPT;
    if (args["script-file"]) {
        try {
            script = fs.readFileSync(path.resolve(args["script-file"]), "utf8").trim();
        } catch (err) {
            process.stderr.write(`ERROR: cannot read --script-file: ${err.message}\n`);
            return 1;
        }
    } else if (typeof args.script === "string") {
        script = args.script;
    }
    if (!script.trim()) {
        process.stderr.write("ERROR: script is empty after trim.\n");
        return 1;
    }

    log("─".repeat(72));
    log("compose-with-scene_assets E2E (PR-14 backend wire verifier)");
    log("─".repeat(72));
    log("Input dir   :", inputDir);
    log("Sidecar port:", port);
    log("Per-scene   :", duration, "s");

    // ── 1. Pick usable images.
    let picked, skipped;
    try {
        ({ picked, skipped } = pickUsableImages(inputDir));
    } catch (err) {
        process.stderr.write(`ERROR: ${err.message}\n`);
        return 1;
    }
    skipped.forEach((s) => log("  ⚠️  skip", path.basename(s.path), "—", s.reason));
    if (args.limit) {
        const n = Math.max(0, Number(args.limit));
        if (n < picked.length) {
            log("  applying --limit", n, "(was", picked.length + ")");
            picked = picked.slice(0, n);
        }
    }
    log("Usable images:", picked.length);
    picked.forEach((p, i) =>
        log(`  [${i + 1}/${picked.length}] ${path.basename(p.path)} — ${p.size} bytes`)
    );
    if (picked.length === 0) {
        process.stderr.write(
            "ERROR: no usable images (≥ 50 KB .jpg/.jpeg/.png/.webp) in " + inputDir + "\n"
        );
        return 2;
    }

    // ── 2. Probe / spawn the sidecar.
    const sidecar = require(path.resolve(__dirname, "..", "desktop", "electron", "researchSidecar.js"));
    sidecar.setLogSink((...m) => log("[sidecar]", ...m));
    let started;
    try {
        started = await sidecar.start({ port });
    } catch (err) {
        process.stderr.write(`ERROR: sidecar.start failed: ${err.message}\n`);
        return 3;
    }
    log("Sidecar healthy on :" + started.port);

    let exitCode = 0;
    try {
        // ── 3. Build request and POST /producer/short.
        const sceneAssets = buildSceneAssets(picked, { duration });
        const body = {
            script,
            voice: args.voice || "en-US-AriaNeural",
            style: args.style || "violet-pink",
            write_srt: true,
            scene_assets: sceneAssets,
        };
        if (args["output-dir"]) body.output_dir = path.resolve(args["output-dir"]);

        log("POST /producer/short — scene_assets[" + sceneAssets.length + "], duration_total ≈",
            sceneAssets.length * duration, "s");

        const { status, json } = await postJson({
            port: started.port,
            path: "/producer/short",
            body,
        });
        if (status !== 200) {
            process.stderr.write(`ERROR: /producer/short returned status ${status}\n`);
            process.stderr.write(JSON.stringify(json, null, 2) + "\n");
            return 4;
        }

        // ── 4. Report + validate.
        log("─".repeat(72));
        log("ShortResponse");
        log("─".repeat(72));
        log("  mp4_path        :", json.mp4_path);
        log("  audio_path      :", json.audio_path);
        log("  srt_path        :", json.srt_path);
        log("  duration_s      :", json.duration_s);
        log("  voice / engine  :", json.voice, "/", json.engine);
        log("  captions_count  :", json.captions_count, "(", json.caption_source, ")");
        log("  visual_provider :", json.visual_provider);
        log("  scenes_used     :", json.scenes_used);
        log("  scenes_missing  :", json.scenes_missing);
        log("  warnings        :", JSON.stringify(json.warnings || []));
        log("  output_dir      :", json.output_dir);

        const verdict = validateShortResponse(json, sceneAssets.length);
        log("─".repeat(72));
        if (verdict.ok) {
            log("✅ PASS — mp4 produced with", sceneAssets.length, "Grok-image scene_assets,",
                "no missing scenes, no warnings.");
        } else {
            log("❌ FAIL");
            verdict.problems.forEach((p) => log("    -", p));
        }
        exitCode = verdict.exitCode;
    } finally {
        if (!args["keep-sidecar"]) {
            try {
                await sidecar.stop();
            } catch (_) {
                // best-effort teardown — never mask the real exit code.
            }
        } else {
            log("(--keep-sidecar set — leaving sidecar running on :" + started.port + ")");
        }
    }

    return exitCode;
}

module.exports = {
    parseArgs,
    pickUsableImages,
    buildSceneAssets,
    validateShortResponse,
    postJson,
    main,
};

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((err) => {
            console.error("[E2E] FATAL:", err && err.stack ? err.stack : err);
            process.exit(1);
        });
}
