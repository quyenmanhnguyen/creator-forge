/**
 * PR-22: offline tests for storyboard_account_manager_helpers.js.
 *
 * Coverage:
 *   - validateAccount / validateAccountList: email shape, password
 *     required, duplicate detection, normalised payload.
 *   - formatAccountRow: password is ALWAYS replaced with the
 *     PASSWORD_PLACEHOLDER (never echoed), state class derives from
 *     PR-20E session shape.
 *   - mergeWithSessionStatus / redactAccountListForDisplay: matches
 *     by email (case-insensitive), missing rows fall back to
 *     "no session", live passwords are still scrubbed.
 *   - sanitizeProgressLog: a misbehaving log line that contains the
 *     plaintext password gets the password redacted before render.
 *   - deriveBannerCta: maps PR-20E session status to the right CTA
 *     (Auto-login when ≥1 configured + not ready, Refresh when
 *     ready, Open manual login as last-ditch fallback).
 *
 * Run:  node desktop/tests/test_storyboard_account_manager_helpers.js
 */
"use strict";

const assert = require("assert");
const helpers = require("../dist/storyboard_account_manager_helpers.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── validateAccount ──────────────────────────────────────────────
test("validateAccount: empty input is rejected", () => {
    const res = helpers.validateAccount(null);
    assert.strictEqual(res.valid, false);
    assert.match(res.error, /empty/i);
});

test("validateAccount: missing email is rejected", () => {
    const res = helpers.validateAccount({ email: '', password: 'pw' });
    assert.strictEqual(res.valid, false);
    assert.match(res.error, /email is required/i);
});

test("validateAccount: malformed email is rejected", () => {
    const res = helpers.validateAccount({ email: 'not-an-email', password: 'pw' });
    assert.strictEqual(res.valid, false);
    assert.match(res.error, /invalid/i);
});

test("validateAccount: missing password is rejected", () => {
    const res = helpers.validateAccount({ email: 'alice@example.com', password: '' });
    assert.strictEqual(res.valid, false);
    assert.match(res.error, /password is required/i);
});

test("validateAccount: trims surrounding whitespace from email", () => {
    const res = helpers.validateAccount({ email: '  alice@example.com  ', password: 'pw' });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.normalized.email, 'alice@example.com');
    assert.strictEqual(res.normalized.password, 'pw');
});

// ─── validateAccountList ─────────────────────────────────────────
test("validateAccountList: passes through normalized rows", () => {
    const res = helpers.validateAccountList([
        { email: 'alice@example.com', password: 'pw1' },
        { email: 'bob@example.com', password: 'pw2' },
    ]);
    assert.strictEqual(res.valid, true);
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(res.normalized.length, 2);
    // Normalised rows are exactly { email, password } — no extras.
    assert.deepStrictEqual(Object.keys(res.normalized[0]).sort(), ['email', 'password']);
});

test("validateAccountList: rejects duplicate emails (case-insensitive)", () => {
    const res = helpers.validateAccountList([
        { email: 'alice@example.com', password: 'pw1' },
        { email: 'ALICE@example.com', password: 'pw2' },
    ]);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.errors.length, 1);
    assert.match(res.errors[0].error, /duplicate/i);
});

test("validateAccountList: collects per-row errors with original indexes", () => {
    const res = helpers.validateAccountList([
        { email: 'alice@example.com', password: 'pw1' },
        { email: 'bad', password: 'pw' },
        { email: 'bob@example.com', password: '' },
    ]);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.errors.length, 2);
    const idxs = res.errors.map((e) => e.idx).sort();
    assert.deepStrictEqual(idxs, [1, 2]);
    assert.strictEqual(res.normalized.length, 1, 'valid rows still come through');
});

// ─── formatAccountRow + mergeWithSessionStatus ────────────────────
test("formatAccountRow: password is ALWAYS replaced by the placeholder", () => {
    const row = helpers.formatAccountRow(
        { email: 'alice@example.com', password: 'sup3rS3cret' },
        { has_session: true, fresh: true, age_ms: 12345, cookie_count: 3 }
    );
    assert.strictEqual(row.password_display, helpers.PASSWORD_PLACEHOLDER);
    // Defensive: serialise the row and confirm the secret is gone.
    const blob = JSON.stringify(row);
    assert.ok(!blob.includes('sup3rS3cret'), 'plaintext password must not appear in the row payload');
});

test("formatAccountRow: maps fresh session → state_class=ready", () => {
    const row = helpers.formatAccountRow(
        { email: 'alice@example.com' },
        { has_session: true, fresh: true, age_ms: 1000, cookie_count: 5 }
    );
    assert.strictEqual(row.state_class, 'ready');
    assert.strictEqual(row.state_label, 'ready');
});

test("formatAccountRow: maps in-memory but not-fresh session → state_class=stale", () => {
    const row = helpers.formatAccountRow(
        { email: 'alice@example.com' },
        { has_session: true, fresh: false, age_ms: 99999999, cookie_count: 0 }
    );
    assert.strictEqual(row.state_class, 'stale');
    assert.strictEqual(row.state_label, 'stale');
});

test("formatAccountRow: maps no session → state_class=no-accounts", () => {
    const row = helpers.formatAccountRow({ email: 'alice@example.com' }, null);
    assert.strictEqual(row.state_class, 'no-accounts');
    assert.strictEqual(row.state_label, 'no session');
});

test("formatAccountRow: age label is human-friendly", () => {
    assert.strictEqual(helpers.formatAgeLabel(null), '—');
    assert.strictEqual(helpers.formatAgeLabel(5_000), '5s');
    assert.strictEqual(helpers.formatAgeLabel(2 * 60_000), '2m');
    assert.strictEqual(helpers.formatAgeLabel(3 * 3600_000 + 15 * 60_000), '3h 15m');
    assert.strictEqual(helpers.formatAgeLabel(2 * 86400_000 + 4 * 3600_000), '2d 4h');
});

test("mergeWithSessionStatus: looks up by email case-insensitively", () => {
    const rows = helpers.mergeWithSessionStatus(
        [{ email: 'Alice@Example.COM', password: 'x' }],
        {
            accounts: [
                { email: 'alice@example.com', has_session: true, fresh: true, age_ms: 100, cookie_count: 1 },
            ],
        }
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].state_class, 'ready');
});

test("mergeWithSessionStatus: unknown email → no-session row, no crash", () => {
    const rows = helpers.mergeWithSessionStatus(
        [{ email: 'nobody@example.com', password: 'x' }],
        { accounts: [] }
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].state_class, 'no-accounts');
});

test("redactAccountListForDisplay: secret-leak guard for full lists", () => {
    const out = helpers.redactAccountListForDisplay(
        [
            { email: 'alice@example.com', password: 'PWA' },
            { email: 'bob@example.com', password: 'PWB' },
        ],
        { accounts: [] }
    );
    const blob = JSON.stringify(out);
    assert.ok(!blob.includes('PWA'));
    assert.ok(!blob.includes('PWB'));
});

// ─── sanitizeProgressLog ─────────────────────────────────────────
test("sanitizeProgressLog: redacts plaintext passwords from log lines", () => {
    const safe = helpers.sanitizeProgressLog(
        'oops the password is sup3rS3cret why',
        [{ email: 'alice@example.com', password: 'sup3rS3cret' }]
    );
    assert.ok(!safe.includes('sup3rS3cret'));
    assert.ok(safe.includes('●●●'));
});

test("sanitizeProgressLog: passes safe lines through unchanged", () => {
    const safe = helpers.sanitizeProgressLog(
        'Account 1/2 ready: alice@example.com',
        [{ email: 'alice@example.com', password: 'pw' }]
    );
    assert.strictEqual(safe, 'Account 1/2 ready: alice@example.com');
});

test("sanitizeProgressLog: handles non-string input safely", () => {
    assert.strictEqual(helpers.sanitizeProgressLog(null, []), '');
    assert.strictEqual(helpers.sanitizeProgressLog(undefined, []), '');
    assert.strictEqual(helpers.sanitizeProgressLog(42, []), '');
});

test("sanitizeProgressLog: terminates when password contains the sigil character", () => {
    // Devin Review #31 caught an infinite loop when a password is a
    // substring of the replacement sigil (e.g. password === '●'):
    // each replace() spawned new matches inside the inserted sigil.
    // The fix uses split/join so the substitution is atomic.
    const start = Date.now();
    const safe = helpers.sanitizeProgressLog(
        'leaked ● here',
        [{ email: 'a@b.co', password: '●' }]
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `sanitizeProgressLog must not hang (took ${elapsed}ms)`);
    // Single replacement step → '●' → '●●●'.
    assert.strictEqual(safe, 'leaked ●●● here');
});

test("sanitizeProgressLog: still redacts when password equals the sigil string itself", () => {
    const safe = helpers.sanitizeProgressLog(
        'oops ●●● leaked',
        [{ email: 'a@b.co', password: '●●●' }]
    );
    // The password equals the sigil — split/join produces the same
    // string back. No hang, no extra mutation.
    assert.strictEqual(safe, 'oops ●●● leaked');
});

// ─── deriveBannerCta ─────────────────────────────────────────────
test("deriveBannerCta: ready → Refresh status", () => {
    const cta = helpers.deriveBannerCta({ status: 'ready', configured_count: 1 });
    assert.strictEqual(cta.action, 'storyboard-batch-refresh-session');
    assert.match(cta.label, /refresh/i);
});

test("deriveBannerCta: stale + ≥1 configured → Auto-login", () => {
    const cta = helpers.deriveBannerCta({ status: 'stale', configured_count: 2 });
    assert.strictEqual(cta.action, 'storyboard-account-auto-login');
    assert.match(cta.label, /auto-login/i);
});

test("deriveBannerCta: no_accounts → Open manual login fallback", () => {
    const cta = helpers.deriveBannerCta({ status: 'no_accounts', configured_count: 0 });
    assert.strictEqual(cta.action, 'storyboard-batch-login');
    assert.match(cta.label, /manual login/i);
});

test("deriveBannerCta: unknown payload still resolves to a sane CTA", () => {
    const cta = helpers.deriveBannerCta(null);
    assert.ok(cta && typeof cta.action === 'string');
    assert.ok(cta && typeof cta.label === 'string');
});

// ─── Runner ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
for (const t of tests) {
    try {
        t.fn();
        console.log('  ok  ' + t.name);
        pass += 1;
    } catch (e) {
        console.log('  FAIL ' + t.name + '\n    ' + (e && e.message ? e.message : e));
        fail += 1;
    }
}
console.log('\nPASSED ' + pass + ' / ' + (pass + fail) + ' test(s)');
process.exit(fail === 0 ? 0 : 1);
