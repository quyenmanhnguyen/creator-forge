"use strict";

// Offline test: GROK_PROFILE_DIR env override + openManualLogin contract.
// No puppeteer install required — we stub puppeteer-extra via Module._load.

const path = require("path");
const Module = require("module");
const assert = require("assert");

// ── stub puppeteer-extra so requiring desktop/src/browser.js doesn't try
//    to spawn Chromium / install puppeteer at module load time. We capture
//    the launch options instead so we can assert on them.
const launchCalls = [];
const fakePage = {
    _url: "https://accounts.x.ai/sign-in?redirect=grok-com&email=true",
    isClosed: () => false,
    url() { return this._url; },
    async title() { return "Grok"; },
    async goto(url) { this._url = url; return null; },
    async evaluate(fn) {
        try { return fn(); } catch { return null; }
    },
    async evaluateOnNewDocument() { return null; },
    on() { return null; },
    async waitForSelector() { return null; },
    async reload() { return null; },
    async waitForNavigation() { return null; },
    keyboard: {
        async type() { return null; },
        async press() { return null; },
        async down() { return null; },
        async up() { return null; },
    },
};
const fakeBrowser = {
    async pages() { return [fakePage]; },
    async newPage() { return fakePage; },
    async close() { return null; },
};
const stubPuppeteerExtra = {
    use() { return null; },
    async launch(options) {
        launchCalls.push(options);
        return fakeBrowser;
    },
};
const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
    if (request === "puppeteer-extra") return stubPuppeteerExtra;
    if (request === "puppeteer-extra-plugin-stealth") return () => null;
    return origLoad.call(this, request, parent, isMain);
};

// ── test 1: GROK_PROFILE_DIR overrides SESSIONS_DIR
delete require.cache[require.resolve("../src/config")];
process.env.GROK_PROFILE_DIR = "/tmp/cf-test-grok-profile";
delete process.env.AUTOGROK_USER_DATA_DIR;
const cfg = require("../src/config");
assert.strictEqual(
    cfg.SESSIONS_DIR,
    path.resolve("/tmp/cf-test-grok-profile"),
    "SESSIONS_DIR honors GROK_PROFILE_DIR env"
);

// ── test 2: app.config.js mirrors the same override
delete require.cache[require.resolve("../src/config/app.config")];
const appCfg = require("../src/config/app.config");
assert.strictEqual(
    appCfg.PATHS.SESSIONS_DIR,
    path.resolve("/tmp/cf-test-grok-profile"),
    "PATHS.SESSIONS_DIR also honors GROK_PROFILE_DIR"
);

// ── test 3: with no GROK_PROFILE_DIR, falls back to BASE_DIR/sessions
delete process.env.GROK_PROFILE_DIR;
delete require.cache[require.resolve("../src/config")];
const cfgFallback = require("../src/config");
assert.ok(
    cfgFallback.SESSIONS_DIR.endsWith("/sessions"),
    `fallback SESSIONS_DIR ends with /sessions (got: ${cfgFallback.SESSIONS_DIR})`
);

// ── test 4: openManualLogin rejects empty profileDir
const browser = require("../src/browser");
assert.strictEqual(typeof browser.openManualLogin, "function", "openManualLogin is exported");
(async () => {
    const r0 = await browser.openManualLogin({});
    assert.strictEqual(r0.ok, false, "missing profileDir → ok:false");
    assert.match(r0.error, /profileDir is required/, "error mentions profileDir");

    // ── test 5: with a profileDir, the puppeteer launch options carry it
    //           through and the function returns ok:true once the fake page
    //           leaves /sign-in. We simulate that by mutating fakePage.url
    //           after the goto call but before the polling loop ticks.
    const tmpDir = "/tmp/cf-test-grok-profile-launch";
    setTimeout(() => { fakePage._url = "https://grok.com/"; }, 100);
    const r1 = await browser.openManualLogin({
        profileDir: tmpDir,
        timeoutMs: 5000,
        executablePath: "/usr/bin/fake-chrome-for-test",
    });
    assert.strictEqual(r1.ok, true, `expected ok:true, got ${JSON.stringify(r1)}`);
    assert.strictEqual(r1.profileDir, tmpDir, "profileDir echoed back");
    assert.ok(launchCalls.length >= 1, "puppeteer.launch was called");
    assert.strictEqual(
        launchCalls[launchCalls.length - 1].userDataDir,
        tmpDir,
        "userDataDir matches profileDir"
    );
    assert.strictEqual(
        launchCalls[launchCalls.length - 1].headless,
        false,
        "manual login is always headful"
    );

    console.log("# GROK_PROFILE_DIR + openManualLogin");
    console.log("  ok  GROK_PROFILE_DIR overrides SESSIONS_DIR in config.js");
    console.log("  ok  GROK_PROFILE_DIR overrides PATHS.SESSIONS_DIR in app.config.js");
    console.log("  ok  fallback SESSIONS_DIR is BASE_DIR/sessions when env unset");
    console.log("  ok  openManualLogin returns ok:false on missing profileDir");
    console.log("  ok  openManualLogin launches headful with userDataDir = profileDir");
    console.log("  ok  openManualLogin resolves ok:true once user leaves /sign-in");
    console.log("\n# results: 6 passed, 0 failed");
})().catch((err) => {
    console.error("FAIL:", err && err.stack ? err.stack : err);
    process.exit(1);
});
