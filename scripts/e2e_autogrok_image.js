#!/usr/bin/env node
"use strict";

/**
 * Standalone E2E harness for AutoGrok image generation (PR-9 + PR-11 verify).
 *
 * Verifies on a fresh `main` checkout:
 *  - Persistent userDataDir is honored (PR-11): GROK_PROFILE_DIR or default
 *    `~/.creator-forge/grok-profile`.
 *  - Manual login via openManualLogin (PR-11) — no email/password stored.
 *  - ImageService.generateBatch returns the requested batch (PR-9 fix:
 *    `enablePro:false` + `imageGenerationCount:4` → 4 images, not 1).
 *  - WebSocket finals reject blob < 50 KB (PR-9 fix: no blur/moderation).
 *
 * Usage:
 *   GROK_EMAIL="you@example.com" node scripts/e2e_autogrok_image.js
 *
 * Optional env:
 *   GROK_PROFILE_DIR    Persistent profile root. Default
 *                       `~/.creator-forge/grok-profile`.
 *   GROK_E2E_PROMPT     Override the test prompt. Default:
 *                       "A serene mountain lake at dawn, photorealistic,
 *                        soft volumetric light, mist rising from water,
 *                        ultra-detailed, 8k".
 *   GROK_E2E_OUTPUT_DIR Where saved images go. Default
 *                       `<repo>/e2e-output/<timestamp>/`.
 *   GROK_E2E_COUNT      imageGenerationCount. Default 4.
 *   GROK_E2E_TIMEOUT_MS Manual-login timeout. Default 600000 (10 min).
 *   CHROME_EXECUTABLE_PATH  Override Chrome/Edge auto-detect.
 *
 * Exit codes:
 *   0  All assertions passed
 *   2  Manual login required but did not complete
 *   3  setupAccount failed (no x-statsig-id headers captured)
 *   4  Generation returned < requested count
 *   5  Generation returned blurred / under-50KB images only
 *   1  Other error
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// ── Resolve repo root from script location.
const REPO_ROOT = path.resolve(__dirname, "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "desktop");

if (!fs.existsSync(path.join(DESKTOP_DIR, "node_modules"))) {
    console.error(
        "[E2E] ❌ desktop/node_modules missing. Run `cd desktop && npm install` first."
    );
    process.exit(1);
}

// Resolve GROK_PROFILE_DIR before requiring config so the override applies.
const PROFILE_ROOT = process.env.GROK_PROFILE_DIR
    || path.join(os.homedir(), ".creator-forge", "grok-profile");
process.env.GROK_PROFILE_DIR = PROFILE_ROOT;

// `desktop/src/config.js` reads GROK_PROFILE_DIR at require time and uses it
// as SESSIONS_DIR — the parent of every per-account / manual profile.
require(path.join(DESKTOP_DIR, "src/config")); // populates env paths
const { PATHS } = require(path.join(DESKTOP_DIR, "src/config/app.config"));
const { setupAccount, openManualLogin } = require(path.join(DESKTOP_DIR, "src/browser"));
const ImageService = require(path.join(DESKTOP_DIR, "src/services/ImageService"));

const EMAIL = process.env.GROK_EMAIL || "";
if (!EMAIL) {
    console.error("[E2E] ❌ GROK_EMAIL is required. Example:");
    console.error('       GROK_EMAIL="you@example.com" node scripts/e2e_autogrok_image.js');
    process.exit(1);
}

const PROMPT = process.env.GROK_E2E_PROMPT
    || "A serene mountain lake at dawn, photorealistic, soft volumetric light, mist rising from water, ultra-detailed, 8k";
const COUNT = Number(process.env.GROK_E2E_COUNT || 4);
const MANUAL_TIMEOUT_MS = Number(process.env.GROK_E2E_TIMEOUT_MS || 10 * 60 * 1000);

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_DIR = process.env.GROK_E2E_OUTPUT_DIR
    || path.join(REPO_ROOT, "e2e-output", ts);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const emailSafe = EMAIL.replace(/[^a-z0-9]/gi, "_");
const accountProfileDir = path.join(PATHS.SESSIONS_DIR, emailSafe);

function log(...args) {
    const t = new Date().toISOString().slice(11, 19);
    console.log(`[E2E ${t}]`, ...args);
}

function profileHasGrokSession(dir) {
    // Heuristic: a real logged-in profile has Default/Cookies (SQLite) and
    // Local Storage. We don't parse the SQLite — just check the files exist
    // and Cookies is non-trivial in size.
    try {
        const cookiesPath = path.join(dir, "Default", "Cookies");
        const stat = fs.statSync(cookiesPath);
        return stat.size > 4096;
    } catch {
        return false;
    }
}

(async () => {
    log("─".repeat(72));
    log("AutoGrok image-generate E2E — PR-9 (4-image batch + no-blur) + PR-11");
    log("─".repeat(72));
    log("Profile root      :", PROFILE_ROOT);
    log("Account profile   :", accountProfileDir);
    log("Output folder     :", OUTPUT_DIR);
    log("Email             :", EMAIL);
    log("imageGenCount     :", COUNT);
    log("enablePro         : false (PR-9 default)");
    log("─".repeat(72));

    // ── 1. Ensure account profile exists with a logged-in session.
    if (!profileHasGrokSession(accountProfileDir)) {
        log("⚠️  No Grok session at account profile dir.");
        log("    Launching headful Chrome for manual login —");
        log("    please sign in with your Grok account in the window that opens.");
        log("    The window will auto-close once you reach grok.com.");
        const result = await openManualLogin({
            profileDir: accountProfileDir,
            label: "E2E-Login",
            timeoutMs: MANUAL_TIMEOUT_MS,
        });
        if (!result.ok) {
            log("❌ Manual login did not complete:", result.error);
            log("   Re-run the script after logging in, or set GROK_E2E_TIMEOUT_MS.");
            process.exit(2);
        }
        log("✅ Manual login complete. Cookies persisted at", result.profileDir);
    } else {
        log("✅ Existing Grok session found at account profile dir — reusing cookies.");
    }

    // ── 2. Capture x-statsig-id + cookies (Puppeteer relaunches the same
    //       userDataDir; setupAccount short-circuits when session is valid).
    log("→ Capturing x-statsig-id + cookies via setupAccount(...)");
    const session = await setupAccount({ email: EMAIL, password: "" }, 0);
    if (!session || !session.capturedHeaders) {
        log("❌ setupAccount returned no headers. Likely Cloudflare blocked the");
        log("   automated request, or the session expired between manual login and");
        log("   this step. Delete the profile dir and re-run:");
        log("     rm -rf", accountProfileDir);
        process.exit(3);
    }
    log("✅ Headers captured (x-statsig-id len:",
        (session.capturedHeaders["x-statsig-id"] || "").length, ")");

    // setupAccount keeps the browser alive (minimized) so we can reuse
    // session._page for any browser-side downloads. Build a session object
    // shaped like AuthService.activeSessions entries.
    const cookies = await session.page.cookies("https://grok.com");
    const fullSession = {
        accIdx: 0,
        email: EMAIL,
        capturedHeaders: session.capturedHeaders,
        cookies,
        statsigId: session.statsigId,
        timestamp: Date.now(),
        _browser: session.browser,
        _page: session.page,
    };
    log("✅ Cookies for grok.com:", cookies.length);

    // ── 3. Run ImageService.generateBatch with the PR-9 defaults.
    log("→ ImageService.generateBatch — 1 prompt × 1 batch (count=" + COUNT + ")");
    log('  prompt: "' + PROMPT.slice(0, 80) + (PROMPT.length > 80 ? "..." : "") + '"');
    const startedAt = Date.now();
    const results = await ImageService.generateBatch(
        [PROMPT],
        fullSession,
        {
            imageGenerationCount: COUNT,
            enablePro: false,
            outputFolder: OUTPUT_DIR,
            aspectRatio: "1:1",
            batchSize: 1,
        },
        (prompt, prog, jobResult, idx) => {
            if (jobResult) {
                log(`  → progress ${prog}% — ${jobResult.success ? "OK" : "FAIL"} (#${idx + 1})`);
            }
        }
    );
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log("→ Generation finished in", elapsed, "s");

    // ── 4. Verify outputs.
    if (!Array.isArray(results) || results.length === 0) {
        log("❌ Empty results array.");
        process.exit(4);
    }
    const job = results[0];
    log("─".repeat(72));
    log("Result: success=", job.success, "title=", job.title, "error=", job.error);
    const saved = (job.savedFiles || []).slice();
    log("savedFiles count :", saved.length, "(requested:", COUNT, ")");
    saved.forEach((p, i) => {
        let size = 0;
        try { size = fs.statSync(p).size; } catch {}
        const flag = size < 50000 ? " ⚠️ <50KB (BLUR/MOD)" : "";
        log(`  [${i + 1}/${saved.length}] ${path.basename(p)} — ${size} bytes${flag}`);
    });

    const goodFiles = saved.filter((p) => {
        try { return fs.statSync(p).size >= 50000; } catch { return false; }
    });
    const badFiles = saved.filter((p) => {
        try { return fs.statSync(p).size < 50000; } catch { return false; }
    });

    log("─".repeat(72));
    log("Summary");
    log("─".repeat(72));
    log("  Requested        :", COUNT);
    log("  Returned         :", saved.length);
    log("  Usable (≥ 50KB)  :", goodFiles.length);
    log("  Suspicious < 50KB:", badFiles.length);
    log("  Output dir       :", OUTPUT_DIR);

    let exitCode = 0;
    if (saved.length < COUNT) {
        log("❌ FAIL: returned", saved.length, "of", COUNT, "requested.");
        log("   This is the PR-9 'only-1-image' regression. Check that");
        log("   `enablePro: false` was actually applied and that the WS");
        log("   `completed` handler isn't dropping batch members.");
        exitCode = 4;
    }
    if (goodFiles.length < COUNT) {
        log("❌ FAIL: only", goodFiles.length, "/", COUNT, "images are ≥ 50KB.");
        log("   The PR-9 blur-rejection should have either retried via CDN");
        log("   download or marked the slot moderated. Inspect", OUTPUT_DIR);
        exitCode = exitCode || 5;
    }
    if (exitCode === 0) {
        log("✅ PASS — PR-9 + PR-11 verified end-to-end.");
    }

    // ── 5. Tear down.
    try { await fullSession._browser.close(); } catch {}
    process.exit(exitCode);
})().catch((err) => {
    console.error("\n[E2E] FAIL:", err && err.stack ? err.stack : err);
    process.exit(1);
});
