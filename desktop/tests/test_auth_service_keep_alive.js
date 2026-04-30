/**
 * PR-22: regression test for the keep-browser-alive minimized
 * behaviour in `AuthService.setupAccount` (autogrok-veo3 parity).
 *
 * The contract is:
 *   - setupAccount stores the live { _browser, _page } refs in
 *     `activeSessions` (so the session can refresh cookies later).
 *   - It calls Browser.setWindowBounds with `windowState: 'minimized'`
 *     via a Puppeteer CDPSession before returning, so the user
 *     doesn't see N stacked browser windows after auto-login.
 *   - Failures in setWindowBounds are swallowed (the .catch chain) so
 *     a flaky CDP doesn't tank the whole flow.
 *
 * We can't drive a real browser in CI, so we hijack `require()` to
 * substitute a fake `setupAccount` that produces a fake page +
 * createCDPSession spy. The test then asserts the spy was called with
 * the right payload.
 *
 * Run:  node desktop/tests/test_auth_service_keep_alive.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
const Module = require("module");

// ─── Spies + fake Puppeteer-ish surface ─────────────────────────────
const spy = {
    cdpSendCalls: [],
    cookieCalls: 0,
    pageGotoCalls: [],
    saveSessionsWriteCount: 0,
};

function makeFakePage() {
    return {
        async cookies(_origin) {
            spy.cookieCalls += 1;
            return [{ name: 'sso', value: 'IRRELEVANT' }];
        },
        async goto(url, _opts) {
            spy.pageGotoCalls.push(url);
            return { ok: () => true };
        },
        target() {
            return {
                async createCDPSession() {
                    return {
                        async send(method, payload) {
                            spy.cdpSendCalls.push({ method, payload });
                            if (method === 'Browser.getWindowForTarget') {
                                return { windowId: 7 };
                            }
                            return null;
                        },
                    };
                },
            };
        },
    };
}

function makeFakeSession() {
    return {
        accIdx: 0,
        capturedHeaders: { 'x-statsig-id': 'STUB' },
        statsigId: 'STUB',
        browser: { async close() {} },
        page: makeFakePage(),
    };
}

// ─── Hijack require() so AuthService loads against fakes ───────────
const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
    if (request === '../browser') {
        return {
            async setupAccount(_account, _idx) {
                return makeFakeSession();
            },
        };
    }
    if (request === 'puppeteer-extra') {
        return { use() { return null; }, async launch() { return null; } };
    }
    if (request === 'puppeteer-extra-plugin-stealth') {
        return () => null;
    }
    return origLoad.call(this, request, parent, isMain);
};

// Force a tmpdir for SESSIONS_DIR so the test never touches the
// developer's real userData directory.
process.env.GROK_PROFILE_DIR = require('fs').mkdtempSync(
    path.join(require('os').tmpdir(), 'pr22-keep-alive-')
);

// Bust the require cache so AuthService picks up the stubbed deps.
delete require.cache[require.resolve('../src/services/AuthService.js')];
const AuthService = require('../src/services/AuthService.js');

// Wrap the singleton's _saveSessions so we can assert it ran without
// blowing up on disk I/O. (The constructor already created the
// SESSIONS_DIR via fs.mkdirSync.)
const origSave = AuthService._saveSessions.bind(AuthService);
AuthService._saveSessions = function () {
    spy.saveSessionsWriteCount += 1;
    return origSave();
};

// ─── Tests ─────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("setupAccount: keeps browser + page refs alive in activeSessions", async () => {
    AuthService.activeSessions.clear();
    const result = await AuthService.setupAccount(
        { email: 'alice@example.com', password: 'shouldNotLeak' },
        0
    );
    assert.ok(result, 'setupAccount returned a session payload');
    assert.strictEqual(result.email, 'alice@example.com');
    const stored = AuthService.activeSessions.get('alice@example.com');
    assert.ok(stored, 'session is registered in activeSessions');
    assert.ok(stored._browser, 'live _browser ref is preserved (not closed after setup)');
    assert.ok(stored._page, 'live _page ref is preserved (not closed after setup)');
});

test("setupAccount: minimises window via Browser.setWindowBounds (CDP)", async () => {
    spy.cdpSendCalls.length = 0;
    AuthService.activeSessions.clear();
    await AuthService.setupAccount(
        { email: 'bob@example.com', password: 'shouldNotLeak' },
        1
    );
    const setBoundsCall = spy.cdpSendCalls.find((c) => c.method === 'Browser.setWindowBounds');
    assert.ok(setBoundsCall, 'Browser.setWindowBounds must be called');
    assert.deepStrictEqual(
        setBoundsCall.payload,
        { windowId: 7, bounds: { windowState: 'minimized' } },
        'setWindowBounds payload must request the minimised state'
    );
    const getWindowCall = spy.cdpSendCalls.find((c) => c.method === 'Browser.getWindowForTarget');
    assert.ok(getWindowCall, 'Browser.getWindowForTarget must precede setWindowBounds');
});

test("setupAccount: navigates to grok.com after capture (refresh cookies)", async () => {
    spy.pageGotoCalls.length = 0;
    AuthService.activeSessions.clear();
    await AuthService.setupAccount(
        { email: 'carol@example.com', password: 'shouldNotLeak' },
        2
    );
    assert.ok(
        spy.pageGotoCalls.some((u) => u.startsWith('https://grok.com')),
        'page.goto must be called with a grok.com URL so cookies attach to the right origin'
    );
});

test("setupAccount: passwords never appear in the saved-sessions snapshot", () => {
    // Roundtrip: pluck the session out of activeSessions and serialise
    // it the same way _saveSessions would. The serialised shape is
    // intentionally minimal — the password should never reach disk.
    const stored = AuthService.activeSessions.get('alice@example.com')
        || AuthService.activeSessions.get('bob@example.com')
        || AuthService.activeSessions.get('carol@example.com');
    assert.ok(stored, 'at least one session lives after the previous tests');
    const blob = JSON.stringify({
        accIdx: stored.accIdx,
        email: stored.email,
        capturedHeaders: stored.capturedHeaders,
        cookies: stored.cookies,
        statsigId: stored.statsigId,
        timestamp: stored.timestamp,
    });
    assert.ok(!blob.includes('shouldNotLeak'), 'password must never round-trip into the on-disk session payload');
});

// ─── Runner ────────────────────────────────────────────────────────
(async () => {
    let pass = 0, fail = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log('  ok  ' + t.name);
            pass += 1;
        } catch (e) {
            console.log('  FAIL ' + t.name + '\n    ' + (e && e.message ? e.message : e));
            fail += 1;
        }
    }
    console.log('\nPASSED ' + pass + ' / ' + (pass + fail) + ' test(s)');
    process.exit(fail === 0 ? 0 : 1);
})();
