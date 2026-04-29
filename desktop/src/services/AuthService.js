const { setupAccount } = require('../browser');
const { PATHS } = require('../config/app.config');
const AccountService = require('./AccountService');
const fs = require('fs');
const path = require('path');

const MAX_RELOGIN_ATTEMPTS = 2;

class AuthService {
    constructor() {
        this.activeSessions = new Map();
        this._reloginLocks = new Map();
        this._reloginCounts = new Map();
        this._sessionFile = path.join(PATHS.SESSIONS_DIR, 'saved_sessions.json');
        this._loadSavedSessions();
    }

    /**
     * Save all sessions to disk (cookies + headers, no browser refs)
     */
    _saveSessions() {
        try {
            const dir = path.dirname(this._sessionFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const toSave = {};
            for (const [email, session] of this.activeSessions) {
                toSave[email] = {
                    accIdx: session.accIdx,
                    email: session.email,
                    capturedHeaders: session.capturedHeaders,
                    cookies: session.cookies,
                    statsigId: session.statsigId,
                    timestamp: session.timestamp,
                };
            }
            fs.writeFileSync(this._sessionFile, JSON.stringify(toSave, null, 2), 'utf8');
            console.log('[AuthService] 💾 Sessions saved to disk');
        } catch (error) {
            console.error('[AuthService] Error saving sessions:', error.message);
        }
    }

    /**
     * Load saved sessions from disk (restored without live browser)
     */
    _loadSavedSessions() {
        try {
            if (!fs.existsSync(this._sessionFile)) return;
            const data = JSON.parse(fs.readFileSync(this._sessionFile, 'utf8'));
            let count = 0;
            for (const [email, session] of Object.entries(data)) {
                const age = Date.now() - (session.timestamp || 0);
                if (age < 24 * 60 * 60 * 1000) {
                    this.activeSessions.set(email, {
                        ...session,
                        _browser: null,
                        _page: null,
                    });
                    count++;
                    console.log(`[AuthService] 📂 Restored session for ${email} (age: ${Math.round(age / 60000)}min)`);
                } else {
                    console.log(`[AuthService] ⏰ Skipped expired session for ${email}`);
                }
            }
            if (count > 0) {
                console.log(`[AuthService] ✅ Restored ${count} saved session(s)`);
            }
        } catch (error) {
            console.error('[AuthService] Error loading saved sessions:', error.message);
        }
    }

    /**
     * Setup account with browser login and header capture
     */
    async setupAccount(account, index, onProgress = null) {
        try {
            console.log(`[AuthService] Setting up account ${index + 1}: ${account.email}`);

            const session = await setupAccount(account, index);

            if (!session) {
                throw new Error(`Failed to setup account ${account.email} — no headers captured`);
            }

            if (!session.capturedHeaders) {
                throw new Error(`Account ${account.email} — headers are null`);
            }

            // Extract cookies
            const cookies = await session.page.cookies("https://grok.com");
            console.log(`[AuthService] Account ${index + 1}: ${cookies.length} cookies captured`);

            // Store session data — KEEP browser + page alive for session persistence
            const sessionData = {
                accIdx: session.accIdx,
                email: account.email,
                capturedHeaders: session.capturedHeaders,
                cookies: cookies,
                statsigId: session.statsigId,
                timestamp: Date.now(),
                _browser: session.browser,
                _page: session.page,
            };

            this.activeSessions.set(account.email, sessionData);
            this._saveSessions();

            // Minimize browser instead of closing — keeps session alive
            try {
                await session.page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                const client = await session.page.target().createCDPSession();
                await client.send('Browser.setWindowBounds', {
                    windowId: (await client.send('Browser.getWindowForTarget')).windowId,
                    bounds: { windowState: 'minimized' }
                }).catch(() => {});
            } catch (_) {}
            console.log(`[AuthService] Account ${index + 1} setup complete, browser kept alive (minimized)`);

            if (onProgress) {
                onProgress(index + 1, account.email, true);
            }

            return sessionData;
        } catch (error) {
            const errMsg = error?.message || String(error) || 'Unknown error';
            console.error(`[AuthService] Error setting up account ${account.email}:`, errMsg);
            if (onProgress) {
                onProgress(index + 1, account.email, false, errMsg);
            }
            return null;
        }
    }

    /**
     * Setup multiple accounts sequentially
     */
    async setupAccounts(accounts, onProgress = null) {
        console.log(`[AuthService] Setting up ${accounts.length} accounts (sequential)...`);

        const results = [];
        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];
            const sessionData = await this.setupAccount(account, i, onProgress);
            if (sessionData) {
                results.push(sessionData);
            }
        }

        console.log(`[AuthService] ${results.length}/${accounts.length} accounts ready`);
        return results;
    }

    getSession(email) {
        return this.activeSessions.get(email) || null;
    }

    getAllSessions() {
        return Array.from(this.activeSessions.values());
    }

    async clearSession(email) {
        const session = this.activeSessions.get(email);
        if (session?._browser) {
            try { await session._browser.close(); } catch (_) {}
        }
        this.activeSessions.delete(email);
        console.log(`[AuthService] Cleared session for ${email}`);
    }

    async clearAllSessions() {
        for (const [email, session] of this.activeSessions) {
            if (session._browser) {
                try { await session._browser.close(); } catch (_) {}
            }
        }
        this.activeSessions.clear();
        console.log('[AuthService] Cleared all sessions');
    }

    async refreshCookies(email) {
        const session = this.activeSessions.get(email);
        if (!session?._page) {
            console.log(`[AuthService] ⚠️ No live browser for ${email}, cannot refresh cookies`);
            return false;
        }
        try {
            const freshCookies = await session._page.cookies("https://grok.com");
            if (freshCookies.length > 0) {
                session.cookies = freshCookies;
                session.timestamp = Date.now();
                console.log(`[AuthService] 🔄 Refreshed ${freshCookies.length} cookies for ${email}`);
                return true;
            }
        } catch (error) {
            console.error(`[AuthService] Cookie refresh failed for ${email}:`, error.message);
        }
        return false;
    }

    async refreshAllCookies() {
        for (const [email] of this.activeSessions) {
            await this.refreshCookies(email);
        }
    }

    isSessionValid(email, maxAge = 60 * 60 * 1000) {
        const session = this.getSession(email);
        if (!session) return false;
        const age = Date.now() - session.timestamp;
        return age < maxAge;
    }

    async reloginAccount(email) {
        const count = this._reloginCounts.get(email) || 0;
        if (count >= MAX_RELOGIN_ATTEMPTS) {
            console.error(`[AuthService] ⛔ Account ${email} exceeded max re-login attempts (${MAX_RELOGIN_ATTEMPTS}). Skipping.`);
            return null;
        }

        if (this._reloginLocks.has(email)) {
            console.log(`[AuthService] ⏳ Re-login already in progress for ${email}, waiting...`);
            return this._reloginLocks.get(email);
        }

        const promise = this._doRelogin(email);
        this._reloginLocks.set(email, promise);
        try {
            return await promise;
        } finally {
            this._reloginLocks.delete(email);
        }
    }

    async _doRelogin(email) {
        const count = (this._reloginCounts.get(email) || 0) + 1;
        this._reloginCounts.set(email, count);

        console.log(`[AuthService] 🔄 Re-logging in account: ${email} (attempt ${count}/${MAX_RELOGIN_ATTEMPTS})...`);

        const accounts = AccountService.loadAccounts();
        const account = accounts.find(a => a.email === email);
        if (!account) {
            console.error(`[AuthService] ❌ Cannot re-login: account ${email} not found in accounts.json`);
            return null;
        }

        const oldSession = this.activeSessions.get(email);
        const accIdx = oldSession ? oldSession.accIdx : 0;

        try {
            const newSession = await this.setupAccount(account, accIdx);
            if (newSession) {
                console.log(`[AuthService] ✅ Re-login successful for ${email}`);
                return newSession;
            } else {
                console.error(`[AuthService] ❌ Re-login failed for ${email}`);
                return null;
            }
        } catch (error) {
            console.error(`[AuthService] ❌ Re-login error for ${email}:`, error.message);
            return null;
        }
    }

    getReloginCount(email) {
        return this._reloginCounts.get(email) || 0;
    }

    resetAllReloginCounts() {
        this._reloginCounts.clear();
        console.log('[AuthService] Reset all re-login counts');
    }
}

// Export singleton instance
module.exports = new AuthService();
