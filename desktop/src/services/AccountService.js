const { PATHS } = require('../config/app.config');
const fs = require('fs');
const path = require('path');

/**
 * AccountService — single source of truth for the
 * `accounts.json` (Grok email+password list) on disk.
 *
 * Path resolution (highest priority first):
 *
 *   1. ``CREATOR_FORGE_ACCOUNTS_FILE`` env override — used by the
 *      offline test runner so unit tests never touch the developer's
 *      real userData directory.
 *   2. ``app.getPath('userData')/accounts.json`` when running inside
 *      Electron (``process.versions.electron`` is set). This matches
 *      what the renderer's Account Manager saves through the
 *      ``auth:saveAccounts`` IPC handler.
 *   3. ``PATHS.ACCOUNTS_FILE`` (legacy fallback). In dev mode this
 *      resolves to ``desktop/accounts.json`` next to the source tree;
 *      kept so non-Electron callers (sidecar maintenance scripts,
 *      research tooling) stay backwards compatible.
 *
 * The previous implementation hardcoded #3, which silently broke
 * ``AuthService._doRelogin`` in dev mode: the renderer's "Save +
 * Auto-login" button wrote to ``%APPDATA%/creator-forge/accounts.json``
 * (path #2) but the re-login flow reloaded from path #3 — a
 * different file that was usually empty, so 401-triggered re-logins
 * always reported "account not found in accounts.json".
 *
 * On first read we also migrate a bundled ``accounts.json`` (shipped
 * next to the Electron entry point) into the userData directory, so
 * existing installs don't lose their accounts the first time they
 * launch a build with the new resolver.
 */
class AccountService {
    /**
     * Resolve the accounts.json path at call time. Re-evaluated on
     * every load/save so a unit test that flips
     * ``CREATOR_FORGE_ACCOUNTS_FILE`` between cases sees the new
     * value without having to bust the require cache.
     *
     * @returns {string} Absolute path to accounts.json.
     */
    getAccountsFile() {
        if (process.env.CREATOR_FORGE_ACCOUNTS_FILE) {
            return process.env.CREATOR_FORGE_ACCOUNTS_FILE;
        }
        if (process.versions && process.versions.electron) {
            try {
                // Lazy-require so plain-Node callers (CI offline
                // tests, research sidecar tooling) don't crash on
                // missing native bindings.
                const electron = require('electron');
                const app = electron && electron.app;
                if (app && typeof app.getPath === 'function') {
                    return path.join(app.getPath('userData'), 'accounts.json');
                }
            } catch (_) {
                // Electron present but `app` API not reachable from
                // this context (e.g. preload). Fall through to the
                // legacy path.
            }
        }
        return PATHS.ACCOUNTS_FILE;
    }

    /**
     * Load accounts from JSON file. On a cold launch where userData
     * is empty but a bundled accounts.json sits next to the Electron
     * entry, the bundled file is migrated forward so the user keeps
     * their saved credentials across upgrades.
     *
     * @returns {Array<Object>} Array of account objects (never null).
     */
    loadAccounts() {
        const target = this.getAccountsFile();
        try {
            if (fs.existsSync(target)) {
                const data = fs.readFileSync(target, 'utf-8');
                const accounts = JSON.parse(data);
                console.log(`[AccountService] Loaded ${accounts.length} accounts from ${target}`);
                return accounts;
            }

            // First-run migration: pull the legacy bundled file
            // forward into userData so we honour the new resolver
            // without losing existing credentials.
            const bundledCandidates = [
                PATHS.ACCOUNTS_FILE,
                path.join(__dirname, '..', '..', 'accounts.json'),
            ];
            for (const candidate of bundledCandidates) {
                if (candidate === target) continue;
                if (!fs.existsSync(candidate)) continue;
                try {
                    const data = fs.readFileSync(candidate, 'utf-8');
                    const parsed = JSON.parse(data);
                    try {
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        fs.writeFileSync(target, data, 'utf-8');
                        console.log(`[AccountService] Migrated accounts.json: ${candidate} → ${target}`);
                    } catch (writeErr) {
                        console.warn('[AccountService] Migration write failed (continuing with in-memory copy):', writeErr.message);
                    }
                    return parsed;
                } catch (readErr) {
                    console.warn(`[AccountService] Migration candidate unreadable (${candidate}):`, readErr.message);
                }
            }

            console.warn(`[AccountService] accounts.json not found at ${target}`);
            return [];
        } catch (error) {
            console.error('[AccountService] Error loading accounts:', error.message);
            return [];
        }
    }

    /**
     * Save accounts to JSON file. Creates the parent directory if it
     * doesn't yet exist (userData on a fresh install).
     *
     * @param {Array<Object>} accounts - Array of account objects
     */
    saveAccounts(accounts) {
        const target = this.getAccountsFile();
        try {
            const dir = path.dirname(target);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // 4-space indent matches the legacy IPC writer in
            // electron/main.js so a save through either entry point
            // produces a byte-identical file.
            const data = JSON.stringify(accounts, null, 4);
            fs.writeFileSync(target, data, 'utf-8');
            console.log(`[AccountService] Saved ${accounts.length} accounts to ${target}`);
        } catch (error) {
            console.error('[AccountService] Error saving accounts:', error.message);
            throw error;
        }
    }

    /**
     * Add a new account
     * @param {Object} account - Account object {email, password}
     */
    addAccount(account) {
        const accounts = this.loadAccounts();

        // Check if account already exists
        const exists = accounts.some(acc => acc.email === account.email);
        if (exists) {
            throw new Error(`Account ${account.email} already exists`);
        }

        accounts.push(account);
        this.saveAccounts(accounts);
        console.log(`[AccountService] Added account: ${account.email}`);
    }

    /**
     * Remove an account by email
     * @param {string} email - Account email
     */
    removeAccount(email) {
        const accounts = this.loadAccounts();
        const filtered = accounts.filter(acc => acc.email !== email);

        if (filtered.length === accounts.length) {
            throw new Error(`Account ${email} not found`);
        }

        this.saveAccounts(filtered);
        console.log(`[AccountService] Removed account: ${email}`);
    }

    /**
     * Update an account
     * @param {string} email - Account email
     * @param {Object} updates - Fields to update
     */
    updateAccount(email, updates) {
        const accounts = this.loadAccounts();
        const index = accounts.findIndex(acc => acc.email === email);

        if (index === -1) {
            throw new Error(`Account ${email} not found`);
        }

        accounts[index] = { ...accounts[index], ...updates };
        this.saveAccounts(accounts);
        console.log(`[AccountService] Updated account: ${email}`);
    }

    /**
     * Validate account credentials
     * @param {Object} account - Account object
     * @returns {boolean} True if valid
     */
    validateAccount(account) {
        if (!account.email || !account.password) {
            return false;
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(account.email)) {
            return false;
        }

        return true;
    }
}

// Export singleton instance
module.exports = new AccountService();
