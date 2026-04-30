/**
 * PR-25: offline regression tests for `AccountService` path
 * resolution + bundled→userData migration.
 *
 * The bug being pinned here is that `AuthService._doRelogin` calls
 * `AccountService.loadAccounts()` to find the email+password to feed
 * back into Puppeteer when a 401 forces a re-login. Before this PR
 * `loadAccounts()` always read `PATHS.ACCOUNTS_FILE` which, in dev
 * mode (`npm start`, no asar), resolves to `desktop/accounts.json`
 * — a different file from the one the renderer's Account Manager
 * writes via the `auth:saveAccounts` IPC handler
 * (`%APPDATA%/creator-forge/accounts.json` on Windows). The two
 * stores never converged, so 401-triggered re-logins always
 * reported "account not found in accounts.json".
 *
 * Coverage:
 *   1. CREATOR_FORGE_ACCOUNTS_FILE env override beats every other
 *      source (test runner uses this to avoid touching real
 *      userData).
 *   2. loadAccounts() reads exactly what saveAccounts() wrote, with
 *      the same JSON shape (round-trip preserves order + fields).
 *   3. saveAccounts() creates the parent directory on a fresh
 *      install (userData doesn't exist yet).
 *   4. saveAccounts() emits a 4-space-indent JSON file so a save
 *      via `auth:saveAccounts` IPC and a save via this service
 *      produce byte-identical output.
 *   5. First-run migration: when the resolved target is empty but
 *      a legacy bundled accounts.json exists at PATHS.ACCOUNTS_FILE,
 *      loadAccounts() copies it forward into the new target.
 *   6. addAccount/removeAccount/updateAccount round-trip through
 *      the override path (smoke test the dynamic resolution does
 *      not break the higher-level helpers).
 *
 * Run:  node desktop/tests/test_account_service_path.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function freshTmpDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `pr25-account-svc-${label}-`));
}

function loadFreshService() {
    // Bust the require cache so each test sees a fresh singleton
    // (the constructor takes no state, but path resolution is
    // re-evaluated per call so this is mostly defensive).
    const resolved = require.resolve("../src/services/AccountService.js");
    delete require.cache[resolved];
    return require("../src/services/AccountService.js");
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("getAccountsFile honours CREATOR_FORGE_ACCOUNTS_FILE env override", () => {
    const dir = freshTmpDir("env-override");
    const target = path.join(dir, "accounts.json");
    process.env.CREATOR_FORGE_ACCOUNTS_FILE = target;
    try {
        const svc = loadFreshService();
        assert.strictEqual(svc.getAccountsFile(), target);
    } finally {
        delete process.env.CREATOR_FORGE_ACCOUNTS_FILE;
    }
});

test("getAccountsFile falls back to PATHS.ACCOUNTS_FILE outside Electron", () => {
    delete process.env.CREATOR_FORGE_ACCOUNTS_FILE;
    const svc = loadFreshService();
    const { PATHS } = require("../src/config/app.config.js");
    // In a plain Node test runner, process.versions.electron is
    // unset so we should land on the legacy fallback.
    assert.strictEqual(svc.getAccountsFile(), PATHS.ACCOUNTS_FILE);
});

test("saveAccounts → loadAccounts round-trip preserves shape", () => {
    const dir = freshTmpDir("round-trip");
    const target = path.join(dir, "accounts.json");
    process.env.CREATOR_FORGE_ACCOUNTS_FILE = target;
    try {
        const svc = loadFreshService();
        const input = [
            { email: "alice@example.com", password: "pw-1" },
            { email: "bob@example.com", password: "pw-2", note: "secondary" },
        ];
        svc.saveAccounts(input);
        const loaded = svc.loadAccounts();
        assert.deepStrictEqual(loaded, input);
    } finally {
        delete process.env.CREATOR_FORGE_ACCOUNTS_FILE;
    }
});

test("saveAccounts creates the parent directory on a fresh install", () => {
    const dir = freshTmpDir("mkdirp");
    // Nest the target two levels deep — emulate a brand-new
    // userData/accounts.json that doesn't yet exist.
    const target = path.join(dir, "nested", "child", "accounts.json");
    process.env.CREATOR_FORGE_ACCOUNTS_FILE = target;
    try {
        const svc = loadFreshService();
        svc.saveAccounts([{ email: "carol@example.com", password: "pw" }]);
        assert.ok(fs.existsSync(target), "saveAccounts should create the file");
        assert.strictEqual(svc.loadAccounts().length, 1);
    } finally {
        delete process.env.CREATOR_FORGE_ACCOUNTS_FILE;
    }
});

test("saveAccounts emits 4-space-indented JSON (matches legacy IPC writer)", () => {
    const dir = freshTmpDir("indent");
    const target = path.join(dir, "accounts.json");
    process.env.CREATOR_FORGE_ACCOUNTS_FILE = target;
    try {
        const svc = loadFreshService();
        svc.saveAccounts([{ email: "dave@example.com", password: "pw" }]);
        const raw = fs.readFileSync(target, "utf-8");
        // 4-space indent → top-level array entries open with
        // exactly 4 leading spaces, and the inner object fields
        // get 8 leading spaces.
        assert.ok(
            raw.includes('\n    {\n'),
            `expected 4-space top-level indent, got:\n${raw}`,
        );
        assert.ok(
            raw.includes('\n        "email"'),
            `expected 8-space inner-object indent, got:\n${raw}`,
        );
    } finally {
        delete process.env.CREATOR_FORGE_ACCOUNTS_FILE;
    }
});

test("loadAccounts migrates from PATHS.ACCOUNTS_FILE on first run", () => {
    // Stage a legacy accounts.json at PATHS.ACCOUNTS_FILE, then
    // point the override at a brand-new (empty) userData target.
    // loadAccounts must (a) return the legacy contents and
    // (b) write them through to the new target so subsequent reads
    // are direct.
    const { PATHS } = require("../src/config/app.config.js");
    const legacyDir = path.dirname(PATHS.ACCOUNTS_FILE);
    fs.mkdirSync(legacyDir, { recursive: true });
    const hadLegacyBackup = fs.existsSync(PATHS.ACCOUNTS_FILE);
    const legacyBackup = hadLegacyBackup
        ? fs.readFileSync(PATHS.ACCOUNTS_FILE, "utf-8")
        : null;
    const seeded = [{ email: "legacy@example.com", password: "from-bundled" }];
    fs.writeFileSync(PATHS.ACCOUNTS_FILE, JSON.stringify(seeded, null, 4), "utf-8");

    const dir = freshTmpDir("migrate");
    const target = path.join(dir, "accounts.json");
    process.env.CREATOR_FORGE_ACCOUNTS_FILE = target;
    try {
        const svc = loadFreshService();
        const loaded = svc.loadAccounts();
        assert.deepStrictEqual(loaded, seeded, "first read should surface legacy contents");
        assert.ok(fs.existsSync(target), "first read should migrate the file forward");
        // Subsequent read goes straight to the new target — wipe
        // the legacy file and re-read to prove the migration stuck.
        fs.unlinkSync(PATHS.ACCOUNTS_FILE);
        const second = svc.loadAccounts();
        assert.deepStrictEqual(second, seeded, "second read should hit the migrated copy");
    } finally {
        delete process.env.CREATOR_FORGE_ACCOUNTS_FILE;
        if (hadLegacyBackup) {
            fs.writeFileSync(PATHS.ACCOUNTS_FILE, legacyBackup, "utf-8");
        } else if (fs.existsSync(PATHS.ACCOUNTS_FILE)) {
            fs.unlinkSync(PATHS.ACCOUNTS_FILE);
        }
    }
});

test("loadAccounts returns [] when neither target nor legacy exists", () => {
    const dir = freshTmpDir("empty");
    const target = path.join(dir, "accounts.json");
    process.env.CREATOR_FORGE_ACCOUNTS_FILE = target;
    // Make sure no legacy file pollutes the test.
    const { PATHS } = require("../src/config/app.config.js");
    const hadLegacy = fs.existsSync(PATHS.ACCOUNTS_FILE);
    const legacyBackup = hadLegacy
        ? fs.readFileSync(PATHS.ACCOUNTS_FILE, "utf-8")
        : null;
    if (hadLegacy) fs.unlinkSync(PATHS.ACCOUNTS_FILE);
    try {
        const svc = loadFreshService();
        const loaded = svc.loadAccounts();
        assert.deepStrictEqual(loaded, []);
    } finally {
        delete process.env.CREATOR_FORGE_ACCOUNTS_FILE;
        if (hadLegacy && legacyBackup !== null) {
            fs.writeFileSync(PATHS.ACCOUNTS_FILE, legacyBackup, "utf-8");
        }
    }
});

test("addAccount / removeAccount / updateAccount round-trip via override path", () => {
    const dir = freshTmpDir("crud");
    const target = path.join(dir, "accounts.json");
    process.env.CREATOR_FORGE_ACCOUNTS_FILE = target;
    try {
        const svc = loadFreshService();
        svc.saveAccounts([]);
        svc.addAccount({ email: "a@example.com", password: "p1" });
        svc.addAccount({ email: "b@example.com", password: "p2" });
        assert.strictEqual(svc.loadAccounts().length, 2);

        // Duplicate add must throw.
        assert.throws(
            () => svc.addAccount({ email: "a@example.com", password: "dup" }),
            /already exists/,
        );

        svc.updateAccount("a@example.com", { password: "p1-rotated" });
        const after = svc.loadAccounts();
        const a = after.find(x => x.email === "a@example.com");
        assert.strictEqual(a.password, "p1-rotated");

        svc.removeAccount("b@example.com");
        const final = svc.loadAccounts();
        assert.strictEqual(final.length, 1);
        assert.strictEqual(final[0].email, "a@example.com");
    } finally {
        delete process.env.CREATOR_FORGE_ACCOUNTS_FILE;
    }
});

test("validateAccount: rejects malformed credentials", () => {
    const svc = loadFreshService();
    // Note: the existing service contract assumes the caller has
    // already null-checked the input — we don't tighten that here
    // because validateAccount has no other call sites that would
    // benefit from a behaviour change in this PR.
    assert.strictEqual(svc.validateAccount({ email: "", password: "x" }), false);
    assert.strictEqual(svc.validateAccount({ email: "no-at-sign", password: "x" }), false);
    assert.strictEqual(svc.validateAccount({ email: "a@b.co", password: "" }), false);
    assert.strictEqual(svc.validateAccount({ email: "a@b.co", password: "ok" }), true);
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
