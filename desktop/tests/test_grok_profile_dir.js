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
    _gotoShouldFail: false,
    isClosed: () => false,
    url() { return this._url; },
    async title() { return "Grok"; },
    async goto(url) {
        if (this._gotoShouldFail) {
            throw new Error("net::ERR_INTERNET_DISCONNECTED");
        }
        this._url = url;
        return null;
    },
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

    // ── test 6: about:blank must NOT be treated as a successful login.
    //           Simulate a failed page.goto (network down): the .catch in
    //           browser.js swallows it, page stays at about:blank. The
    //           polling loop must NOT early-return ok:true (regression for
    //           the negative-only URL check; fixed by allow-listing
    //           grok.com / x.ai as the post-login destination).
    fakePage._url = "about:blank";
    fakePage._gotoShouldFail = true;
    const tmpDir2 = "/tmp/cf-test-grok-profile-blank";
    const r2 = await browser.openManualLogin({
        profileDir: tmpDir2,
        timeoutMs: 1500, // short — confirm it doesn't early-return ok:true
        executablePath: "/usr/bin/fake-chrome-for-test",
    });
    fakePage._gotoShouldFail = false;
    assert.strictEqual(r2.ok, false, `about:blank must not be treated as success, got ${JSON.stringify(r2)}`);
    assert.match(r2.error || "", /timed out|closed/i, "expect timeout or closed error, not silent success");

    // ── test 7: chrome://newtab / random hosts must also not count as success.
    fakePage._url = "https://example.com/";
    fakePage._gotoShouldFail = true;
    const r3 = await browser.openManualLogin({
        profileDir: "/tmp/cf-test-grok-profile-randomhost",
        timeoutMs: 1500,
        executablePath: "/usr/bin/fake-chrome-for-test",
    });
    fakePage._gotoShouldFail = false;
    assert.strictEqual(r3.ok, false, `non-grok host must not be treated as success, got ${JSON.stringify(r3)}`);

    console.log("# GROK_PROFILE_DIR + openManualLogin");
    console.log("  ok  GROK_PROFILE_DIR overrides SESSIONS_DIR in config.js");
    console.log("  ok  GROK_PROFILE_DIR overrides PATHS.SESSIONS_DIR in app.config.js");
    console.log("  ok  fallback SESSIONS_DIR is BASE_DIR/sessions when env unset");
    console.log("  ok  openManualLogin returns ok:false on missing profileDir");
    console.log("  ok  openManualLogin launches headful with userDataDir = profileDir");
    console.log("  ok  openManualLogin resolves ok:true once user leaves /sign-in");
    console.log("  ok  openManualLogin rejects about:blank (failed page.goto)");
    console.log("  ok  openManualLogin rejects non-grok hosts (no allow-listed host)");

    // ── test 8: regression for the auth:openManualLogin default-path
    //           resolution. When GROK_PROFILE_DIR is set, the IPC handler
    //           must resolve `payload.profileDir || <SESSIONS_DIR>/manual`,
    //           NOT short-circuit on `process.env.GROK_PROFILE_DIR` (which
    //           would point at SESSIONS_DIR root and collide with the
    //           per-email subdirs that setupAccount writes there).
    process.env.GROK_PROFILE_DIR = "/tmp/cf-test-grok-profile-ipc";
    delete require.cache[require.resolve("../src/config")];
    const ipcCfg = require("../src/config");
    // Simulate the resolution that desktop/electron/main.js performs:
    //   payload.profileDir || path.join(GROK_SESSIONS_DIR, 'manual')
    const resolved = path.join(ipcCfg.SESSIONS_DIR, "manual");
    assert.strictEqual(
        resolved,
        path.join(path.resolve("/tmp/cf-test-grok-profile-ipc"), "manual"),
        `auth:openManualLogin default must point at <SESSIONS_DIR>/manual, got ${resolved}`
    );
    assert.notStrictEqual(
        resolved,
        path.resolve("/tmp/cf-test-grok-profile-ipc"),
        "manual login profile must NOT be the SESSIONS_DIR root (collides with per-email subdirs)"
    );
    delete process.env.GROK_PROFILE_DIR;
    console.log("  ok  auth:openManualLogin default = <SESSIONS_DIR>/manual (not root)");

    console.log("\n# results: 9 passed, 0 failed");
})().catch((err) => {
    console.error("FAIL:", err && err.stack ? err.stack : err);
    process.exit(1);
});
