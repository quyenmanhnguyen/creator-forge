/**
 * PR-25: end-to-end regression test that pins the
 * `AuthService._doRelogin` → `AccountService.loadAccounts` path
 * mismatch fix.
 *
 * Repro contract:
 *   1. The renderer's Account Manager wrote to
 *      `app.getPath('userData')/accounts.json` via the
 *      `auth:saveAccounts` IPC.
 *   2. The 401-triggered re-login flow (`reloginAccount` →
 *      `_doRelogin`) called `AccountService.loadAccounts` to
 *      recover the email/password to feed back into Puppeteer.
 *   3. `loadAccounts` previously read `PATHS.ACCOUNTS_FILE` which
 *      in dev mode pointed at `desktop/accounts.json` — a
 *      different, usually-empty file. Result: every re-login
 *      logged "account not found in accounts.json" and never
 *      recovered.
 *
 * After the PR-25 refactor, `AccountService.loadAccounts` honours
 * `CREATOR_FORGE_ACCOUNTS_FILE` (test override), then
 * `app.getPath('userData')` (Electron runtime), then the legacy
 * fallback. This test stubs the env override to simulate the
 * userData path, stages an account at that path, then verifies
 * `_doRelogin` finds it and reaches `setupAccount`.
 *
 * Run:  node desktop/tests/test_auth_service_relogin_path.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// ─── Spies ─────────────────────────────────────────────────────────
const spy = {
    setupAccountCalls: [],
};

// ─── Hijack require() so AuthService loads against fakes ───────────
const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
    if (request === '../browser') {
        return {
            async setupAccount(account, idx) {
                spy.setupAccountCalls.push({ email: account && account.email, idx });
                // Return enough shape for AuthService.setupAccount to
                // accept the response (capturedHeaders + page +
                // browser).
                return {
                    accIdx: idx,
                    capturedHeaders: { 'x-statsig-id': 'STUB' },
                    statsigId: 'STUB',
                    browser: { async close() {} },
                    page: {
                        async cookies() { return []; },
                        async goto() { return { ok: () => true }; },
                        target() {
                            return {
                                async createCDPSession() {
                                    return {
                                        async send(method) {
                                            if (method === 'Browser.getWindowForTarget') {
                                                return { windowId: 1 };
                                            }
                                            return null;
                                        },
                                    };
                                },
                            };
                        },
                    },
                };
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

// Stage an isolated SESSIONS_DIR + accounts.json so the test never
// touches the developer's real userData directory.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pr25-relogin-'));
process.env.GROK_PROFILE_DIR = path.join(tmpRoot, 'sessions');
const accountsFile = path.join(tmpRoot, 'userData', 'accounts.json');
fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
process.env.CREATOR_FORGE_ACCOUNTS_FILE = accountsFile;

// Bust caches so the freshly set env vars are picked up.
for (const mod of [
    '../src/services/AccountService.js',
    '../src/services/AuthService.js',
    '../src/config/app.config.js',
    '../src/config.js',
]) {
    try {
        delete require.cache[require.resolve(mod)];
    } catch (_) { /* not yet loaded */ }
}

const AccountService = require('../src/services/AccountService.js');
const AuthService = require('../src/services/AuthService.js');

// Seed the userData accounts.json with one entry — this simulates
// the renderer's Account Manager having saved a credential through
// the `auth:saveAccounts` IPC.
AccountService.saveAccounts([
    { email: 'recover-me@example.com', password: 'rotation-secret' },
]);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("_doRelogin finds the account staged at userData/accounts.json", async () => {
    spy.setupAccountCalls.length = 0;
    AuthService.activeSessions.clear();
    AuthService.resetAllReloginCounts();

    const result = await AuthService.reloginAccount('recover-me@example.com');

    assert.ok(result, '_doRelogin should return a session payload when the account is found');
    assert.strictEqual(result.email, 'recover-me@example.com');
    assert.strictEqual(spy.setupAccountCalls.length, 1, 'browser.setupAccount must be invoked exactly once');
    assert.strictEqual(spy.setupAccountCalls[0].email, 'recover-me@example.com');
});

test("_doRelogin returns null + does NOT call setupAccount for an unknown email", async () => {
    spy.setupAccountCalls.length = 0;
    AuthService.activeSessions.clear();
    AuthService.resetAllReloginCounts();

    const result = await AuthService.reloginAccount('unknown@example.com');

    assert.strictEqual(result, null);
    assert.strictEqual(spy.setupAccountCalls.length, 0, 'unknown account must short-circuit before setupAccount');
});

test("_doRelogin reuses the prior accIdx when a stale session is in memory", async () => {
    spy.setupAccountCalls.length = 0;
    AuthService.activeSessions.clear();
    AuthService.resetAllReloginCounts();

    // Prime an "old" session so the relogin path picks up the
    // existing accIdx (mirrors what happens after a 401 wipe — the
    // session entry stays around with stale cookies).
    AuthService.activeSessions.set('recover-me@example.com', {
        email: 'recover-me@example.com',
        accIdx: 7,
        cookies: [],
        timestamp: Date.now() - 10_000,
    });

    await AuthService.reloginAccount('recover-me@example.com');

    assert.strictEqual(spy.setupAccountCalls.length, 1);
    assert.strictEqual(spy.setupAccountCalls[0].idx, 7, 'accIdx should be carried over from the stale session');
});

test("_doRelogin caps retries at MAX_RELOGIN_ATTEMPTS", async () => {
    spy.setupAccountCalls.length = 0;
    AuthService.activeSessions.clear();
    AuthService.resetAllReloginCounts();

    await AuthService.reloginAccount('recover-me@example.com');
    await AuthService.reloginAccount('recover-me@example.com');
    // Third attempt should be refused without invoking setupAccount.
    const third = await AuthService.reloginAccount('recover-me@example.com');

    assert.strictEqual(third, null);
    assert.strictEqual(spy.setupAccountCalls.length, 2, 'retry cap must hold');
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
