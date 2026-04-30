/**
 * PR-22: pure helpers for the Account Manager UI in the Storyboard tab.
 *
 * Lifted/aligned with the autogrok-veo3 reference flow:
 *   accounts.json (plaintext under userData) ⇆ UI form
 *   ↓
 *   "Auto-login all" button → auth:setupAccounts IPC → AuthService.setupAccounts
 *   ↓
 *   Browser windows minimised (Browser.setWindowBounds windowState=minimized)
 *   ↓
 *   AuthService.activeSessions populated, session keep-alive
 *   ↓
 *   auth:getSessionStatus drives the always-on banner (PR-21).
 *
 * This module is *renderer-free* (no DOM access, no Electron imports)
 * so it can be unit-tested under plain Node. The renderer in
 * creator-forge.js depends on the exported pure functions only.
 *
 * Security contract:
 *   - Plaintext passwords live in `accounts.json` (parity with
 *     autogrok-veo3, user-chosen scope per PR-22 option A) but they
 *     MUST NOT cross any IPC boundary that the user can observe via
 *     the always-on banner / log pane / DevTools mirror.
 *   - `formatAccountRow` ALWAYS replaces the password with a fixed
 *     ●●● placeholder. Tests assert the password string is not
 *     reachable from the row payload.
 *   - `redactAccountListForDisplay` sanitises a whole list before
 *     handing it to the renderer.
 */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.StoryboardAccountManagerHelpers = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PASSWORD_PLACEHOLDER = '●●●●●●';
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    /**
     * Validate a single account entry.
     *
     * @param {{email?:string, password?:string}} account
     * @returns {{valid: boolean, error: string|null, normalized: {email:string,password:string}|null}}
     */
    function validateAccount(account) {
        if (!account || typeof account !== 'object') {
            return { valid: false, error: 'Account is empty', normalized: null };
        }
        const email = typeof account.email === 'string' ? account.email.trim() : '';
        const password = typeof account.password === 'string' ? account.password : '';
        if (!email) {
            return { valid: false, error: 'Email is required', normalized: null };
        }
        if (!EMAIL_RE.test(email)) {
            return { valid: false, error: `Email looks invalid: ${email}`, normalized: null };
        }
        if (!password) {
            return { valid: false, error: `Password is required for ${email}`, normalized: null };
        }
        return {
            valid: true,
            error: null,
            normalized: { email, password },
        };
    }

    /**
     * Validate a list of accounts. Returns the normalised list (only
     * `email` + `password` per row, no extras) and per-index errors so
     * the UI can highlight bad rows.
     *
     * Rejects duplicate emails (case-insensitive).
     */
    function validateAccountList(accounts) {
        const list = Array.isArray(accounts) ? accounts : [];
        const errors = [];
        const seen = new Set();
        const normalized = [];
        list.forEach((acc, idx) => {
            const res = validateAccount(acc);
            if (!res.valid) {
                errors.push({ idx, error: res.error });
                return;
            }
            const key = res.normalized.email.toLowerCase();
            if (seen.has(key)) {
                errors.push({ idx, error: `Duplicate email: ${res.normalized.email}` });
                return;
            }
            seen.add(key);
            normalized.push(res.normalized);
        });
        return {
            valid: errors.length === 0,
            errors,
            normalized,
        };
    }

    /**
     * Format a single account for display in the Account Manager
     * table. Merges the live session info from
     * ``auth:getSessionStatus`` (PR-20E) so the row shows whether the
     * email currently has a fresh / stale / no session.
     *
     * The password is ALWAYS replaced by ``●●●●●●``. Tests assert the
     * caller's plaintext password never appears in the returned row.
     */
    function formatAccountRow(account, sessionInfo) {
        const email = account && typeof account.email === 'string' ? account.email : '';
        const session = sessionInfo && typeof sessionInfo === 'object' ? sessionInfo : {};
        const ageMs = typeof session.age_ms === 'number' ? session.age_ms : null;
        const cookieCount = typeof session.cookie_count === 'number' ? session.cookie_count : 0;
        const hasSession = !!session.has_session;
        const fresh = !!session.fresh;
        let stateLabel;
        let stateClass;
        if (!hasSession) {
            stateLabel = 'no session';
            stateClass = 'no-accounts';
        } else if (fresh) {
            stateLabel = 'ready';
            stateClass = 'ready';
        } else {
            stateLabel = 'stale';
            stateClass = 'stale';
        }
        return {
            email,
            password_display: PASSWORD_PLACEHOLDER,
            has_session: hasSession,
            fresh,
            cookie_count: cookieCount,
            age_label: formatAgeLabel(ageMs),
            state_label: stateLabel,
            state_class: stateClass,
        };
    }

    function formatAgeLabel(ageMs) {
        if (ageMs == null || !Number.isFinite(ageMs)) return '—';
        const sec = Math.floor(ageMs / 1000);
        if (sec < 60) return `${sec}s`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ${min % 60}m`;
        const day = Math.floor(hr / 24);
        return `${day}d ${hr % 24}h`;
    }

    /**
     * Merge an account list with a `auth:getSessionStatus` payload.
     * The session payload (PR-20E) carries one entry per *configured*
     * account; we look up by email and produce one display row per
     * account in the input list. Unmatched emails (e.g. a row the
     * user just typed in but hasn't saved) get the no-session state.
     */
    function mergeWithSessionStatus(accounts, sessionStatus) {
        const list = Array.isArray(accounts) ? accounts : [];
        const sessionAccounts = (sessionStatus && Array.isArray(sessionStatus.accounts))
            ? sessionStatus.accounts
            : [];
        const sessionByEmail = new Map();
        sessionAccounts.forEach((entry) => {
            if (entry && typeof entry.email === 'string') {
                sessionByEmail.set(entry.email.toLowerCase(), entry);
            }
        });
        return list.map((acc) => {
            const email = acc && typeof acc.email === 'string' ? acc.email : '';
            const info = sessionByEmail.get(email.toLowerCase()) || null;
            return formatAccountRow(acc, info);
        });
    }

    /**
     * Strip every account in the list down to its display-safe shape.
     * Used as a defence-in-depth before any object touches the
     * renderer's HTML composition or the log pane.
     */
    function redactAccountListForDisplay(accounts, sessionStatus) {
        return mergeWithSessionStatus(accounts, sessionStatus);
    }

    /**
     * Sanitise a setupAccounts IPC progress event for log display.
     * The IPC handler in main.js calls sendLog with strings that
     * already include the email but NEVER the password — this helper
     * just normalises the shape for the renderer's log pane and
     * provides a defensive password strip in case a future change
     * leaks one through.
     */
    function sanitizeProgressLog(line, accounts) {
        if (typeof line !== 'string') return '';
        let safe = line;
        const list = Array.isArray(accounts) ? accounts : [];
        list.forEach((acc) => {
            if (acc && typeof acc.password === 'string' && acc.password) {
                // Replace any literal password occurrence with a
                // fixed sigil so a misbehaving log line cannot
                // surface the plaintext.
                while (safe.indexOf(acc.password) !== -1) {
                    safe = safe.replace(acc.password, '●●●');
                }
            }
        });
        return safe;
    }

    /**
     * Compute the action that the always-on login banner's CTA
     * should perform. With PR-22 we have a real auto-login path, so
     * "Open manual login" is the fallback — primary CTA flips to
     * "Auto-login" when accounts.json has at least one entry.
     *
     * The renderer composes this with PR-21's
     * `deriveBannerState` to pick the final button text + action.
     *
     * @param {{configured_count?:number, status?:string}} sessionStatus
     * @returns {{action: string, label: string}}
     */
    function deriveBannerCta(sessionStatus) {
        const status = sessionStatus && typeof sessionStatus.status === 'string'
            ? sessionStatus.status
            : 'unknown';
        const configured = sessionStatus && Number.isFinite(sessionStatus.configured_count)
            ? sessionStatus.configured_count
            : 0;
        if (status === 'ready') {
            return {
                action: 'storyboard-batch-refresh-session',
                label: 'Refresh status',
            };
        }
        if (configured > 0) {
            return {
                action: 'storyboard-account-auto-login',
                label: 'Auto-login (programmatic)',
            };
        }
        return {
            action: 'storyboard-batch-login',
            label: 'Open manual login',
        };
    }

    return {
        PASSWORD_PLACEHOLDER,
        validateAccount,
        validateAccountList,
        formatAccountRow,
        mergeWithSessionStatus,
        redactAccountListForDisplay,
        sanitizeProgressLog,
        deriveBannerCta,
        formatAgeLabel,
    };
}));
