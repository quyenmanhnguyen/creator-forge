/**
 * Offline regression tests for `AuthService.getSessionStatus` (PR-20E).
 *
 * The IPC surface `auth:getSessionStatus` is what drives the renderer's
 * 3-state banner (no_accounts / stale / ready). This test verifies
 * three contracts:
 *
 *   1. The status decision matches the documented state machine.
 *   2. The returned account summaries NEVER carry cookies, headers,
 *      statsigId, or anything else that could leak from the Electron
 *      main process into the renderer.
 *   3. A broken accountsLoader doesn't crash — it degrades to
 *      ``status: 'unknown'`` so the UI can show a neutral banner.
 *
 * AuthService exports a singleton with an in-memory ``activeSessions``
 * Map — we prime that Map directly in the test for determinism, and
 * inject ``accountsLoader`` via the opts arg (so the test doesn't read
 * the user's real accounts.json from userData).
 *
 * Run:  node desktop/tests/test_auth_session_status.js
 */
"use strict";

const assert = require("assert");
const Module = require("module");

// Stub puppeteer-extra so AuthService → browser.js doesn't try to
// require/install puppeteer at module load time (CI minimal image
// doesn't have it).
const stubPuppeteerExtra = {
    use() { return null; },
    async launch() { return { async pages() { return []; }, async newPage() { return null; }, async close() {} }; },
};
const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
    if (request === "puppeteer-extra") return stubPuppeteerExtra;
    if (request === "puppeteer-extra-plugin-stealth") return () => null;
    return origLoad.call(this, request, parent, isMain);
};

const AuthService = require("../src/services/AuthService.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function resetSessions() {
    AuthService.activeSessions.clear();
}

test("status=no_accounts when accounts.json is empty", () => {
    resetSessions();
    const res = AuthService.getSessionStatus({ accountsLoader: () => [] });
    assert.strictEqual(res.status, "no_accounts");
    assert.strictEqual(res.configured_count, 0);
    assert.strictEqual(res.ready_count, 0);
    assert.strictEqual(res.stale_count, 0);
    assert.deepStrictEqual(res.accounts, []);
    assert.match(res.reason, /manual login/);
});

test("status=stale when account configured but no active session", () => {
    resetSessions();
    const res = AuthService.getSessionStatus({
        accountsLoader: () => [{ email: "a@example.com", password: "shh" }],
    });
    assert.strictEqual(res.status, "stale");
    assert.strictEqual(res.configured_count, 1);
    assert.strictEqual(res.ready_count, 0);
    assert.strictEqual(res.accounts[0].has_session, false);
    assert.strictEqual(res.accounts[0].cookie_count, 0);
    assert.strictEqual(res.accounts[0].fresh, false);
});

test("status=stale when session exists but older than maxAgeMs", () => {
    resetSessions();
    const now = 10_000_000;
    AuthService.activeSessions.set("a@example.com", {
        email: "a@example.com",
        cookies: [{ name: "c", value: "secret" }],
        capturedHeaders: { authorization: "Bearer TOP_SECRET" },
        statsigId: "super-secret",
        timestamp: now - 2 * 60 * 60 * 1000, // 2h old
    });
    const res = AuthService.getSessionStatus({
        accountsLoader: () => [{ email: "a@example.com" }],
        maxAgeMs: 60 * 60 * 1000,
        now,
    });
    assert.strictEqual(res.status, "stale");
    assert.strictEqual(res.stale_count, 1);
    assert.strictEqual(res.ready_count, 0);
    assert.strictEqual(res.accounts[0].fresh, false);
    assert.strictEqual(res.accounts[0].has_session, true);
});

test("status=ready when session fresh and has cookies", () => {
    resetSessions();
    const now = 10_000_000;
    AuthService.activeSessions.set("a@example.com", {
        email: "a@example.com",
        cookies: [{ name: "c", value: "leak" }, { name: "c2", value: "also-leak" }],
        capturedHeaders: { authorization: "Bearer TOP_SECRET" },
        statsigId: "super-secret",
        timestamp: now - 10_000,
    });
    const res = AuthService.getSessionStatus({
        accountsLoader: () => [{ email: "a@example.com" }],
        maxAgeMs: 60 * 60 * 1000,
        now,
    });
    assert.strictEqual(res.status, "ready");
    assert.strictEqual(res.ready_count, 1);
    assert.strictEqual(res.accounts[0].fresh, true);
    assert.strictEqual(res.accounts[0].cookie_count, 2);
});

test("status=unknown when accountsLoader throws", () => {
    resetSessions();
    const res = AuthService.getSessionStatus({
        accountsLoader: () => { throw new Error("disk read failed"); },
    });
    assert.strictEqual(res.status, "unknown");
    assert.match(res.reason, /disk read failed/);
    assert.deepStrictEqual(res.accounts, []);
});

test("SECURITY: returned shape never contains cookies/headers/statsigId/passwords", () => {
    resetSessions();
    const now = 10_000_000;
    AuthService.activeSessions.set("a@example.com", {
        email: "a@example.com",
        cookies: [{ name: "SecretCookieName", value: "SuperLeakyCookieValue" }],
        capturedHeaders: { authorization: "Bearer DO_NOT_LEAK_ME_EVER" },
        statsigId: "DO_NOT_LEAK_STATSIG_ID",
        timestamp: now - 10_000,
    });
    const res = AuthService.getSessionStatus({
        accountsLoader: () => [{
            email: "a@example.com",
            password: "SUPER-SECRET-PASSWORD",
            refresh_token: "REFRESH_TOKEN_LEAK",
        }],
        now,
    });
    const blob = JSON.stringify(res);
    for (const forbidden of [
        "SuperLeakyCookieValue", "SecretCookieName",
        "DO_NOT_LEAK_ME_EVER", "DO_NOT_LEAK_STATSIG_ID",
        "SUPER-SECRET-PASSWORD", "REFRESH_TOKEN_LEAK",
        "Bearer", "authorization", "statsigId", "capturedHeaders",
    ]) {
        assert.ok(
            !blob.includes(forbidden),
            `status payload must not contain "${forbidden}" — got ${blob}`,
        );
    }
    // Explicit allow-list: only documented fields appear per account.
    const allowed = ["email", "has_session", "age_ms", "cookie_count", "fresh"];
    for (const acc of res.accounts) {
        for (const key of Object.keys(acc)) {
            assert.ok(allowed.includes(key), `unexpected key on account summary: ${key}`);
        }
    }
});

test("multiple accounts: one ready + one stale → status=ready (any fresh wins)", () => {
    resetSessions();
    const now = 10_000_000;
    AuthService.activeSessions.set("fresh@example.com", {
        email: "fresh@example.com",
        cookies: [{ name: "c", value: "x" }],
        timestamp: now - 1000,
    });
    AuthService.activeSessions.set("old@example.com", {
        email: "old@example.com",
        cookies: [{ name: "c", value: "x" }],
        timestamp: now - 10 * 60 * 60 * 1000,
    });
    const res = AuthService.getSessionStatus({
        accountsLoader: () => [{ email: "fresh@example.com" }, { email: "old@example.com" }],
        maxAgeMs: 60 * 60 * 1000,
        now,
    });
    assert.strictEqual(res.status, "ready");
    assert.strictEqual(res.ready_count, 1);
    assert.strictEqual(res.stale_count, 1);
});

test("malformed accounts entries (no email) are skipped", () => {
    resetSessions();
    const res = AuthService.getSessionStatus({
        accountsLoader: () => [{ notAnEmail: "x" }, null, { email: "ok@example.com" }],
    });
    assert.strictEqual(res.configured_count, 3); // raw length — we report what we got
    assert.strictEqual(res.accounts.length, 1);
    assert.strictEqual(res.accounts[0].email, "ok@example.com");
});

// ─── PR-24 ─────────────────────────────────────────────────────────
// In dev mode (`npm start`) the IPC writer ``auth:saveAccounts``
// targets ``app.getPath('userData')/accounts.json`` while the legacy
// default loader resolves ``PATHS.ACCOUNTS_FILE`` to
// ``desktop/accounts.json``. The two paths point at different files,
// so without the IPC handler injecting an explicit ``accountsLoader``
// the status would stay ``no_accounts`` even after a successful save
// + auto-login. This test pins the contract that
// ``getSessionStatus`` honours an explicit loader so the IPC handler
// can wire the correct path.
test("PR-24: explicit accountsLoader overrides the AccountService default (banner-sync fix)", () => {
    resetSessions();
    let calls = 0;
    const customLoader = () => {
        calls += 1;
        return [{ email: "saved-via-userdata@example.com", password: "x" }];
    };
    const res = AuthService.getSessionStatus({ accountsLoader: customLoader });
    assert.strictEqual(calls, 1, "explicit accountsLoader must be invoked exactly once");
    assert.strictEqual(res.configured_count, 1);
    // No active session yet → status == 'stale' (account exists but
    // cookies haven't been captured), NOT 'no_accounts'.
    assert.strictEqual(res.status, "stale");
});

let pass = 0;
let fail = 0;
for (const t of tests) {
    try {
        t.fn();
        console.log(`  ok  ${t.name}`);
        pass += 1;
    } catch (err) {
        console.error(`  FAIL  ${t.name}\n    ${err && err.stack ? err.stack : err}`);
        fail += 1;
    }
}
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"} ${pass} / ${pass + fail} test(s)`);
process.exit(fail === 0 ? 0 : 1);
