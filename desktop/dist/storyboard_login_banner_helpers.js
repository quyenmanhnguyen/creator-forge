/* eslint-disable no-undef */
/**
 * PR-21: pure helpers that compute the login-banner state from the
 * `auth:getSessionStatus` IPC payload (or the legacy `auth:getAccounts`
 * fallback). Kept renderer-free so it can be unit-tested under plain
 * Node without an Electron window.
 *
 * The banner has 4 visible states (`unknown` is the initial/loading
 * variant, the others are returned by the IPC):
 *
 *   - `unknown`     → neutral, "Checking Grok session…" while we wait
 *                     on the IPC (or if it threw and we have no signal).
 *   - `no-accounts` → red, "No Grok account configured" + "Open manual
 *                     login" CTA.
 *   - `stale`       → yellow, "Session may be stale — re-login
 *                     recommended" + "Open manual login" CTA.
 *   - `ready`       → green, "Grok session active — N account(s) ready"
 *                     + "Refresh status" CTA.
 *
 * The helper returns ``{ cssClass, text, buttonText, buttonAction }``
 * — the renderer just plugs these into the existing DOM nodes.
 *
 * Strict shape rules (mirrors PR-20E security guarantees):
 *   - We never read or surface cookie values, headers, statsig IDs,
 *     bearer tokens, or passwords from the IPC payload — only the
 *     declared status/account-summary fields. ``buildStatusFromAccounts``
 *     covers the legacy fallback the same way.
 */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.StoryboardLoginBannerHelpers = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const KNOWN_STATES = new Set(['ready', 'stale', 'no_accounts', 'unknown']);

    /**
     * Map the IPC's status enum (snake_case from auth:getSessionStatus)
     * to the renderer's CSS class (kebab-case, matches the .banner.X
     * variants in creator-forge.html).
     */
    function statusToCssClass(status) {
        switch (status) {
            case 'ready':       return 'ready';
            case 'stale':       return 'stale';
            case 'no_accounts': return 'no-accounts';
            default:            return 'unknown';
        }
    }

    /**
     * Build a renderer-ready summary from a raw `auth:getSessionStatus`
     * payload. Returns { status, cssClass, text, buttonText, buttonAction }.
     *
     * `payload` is whatever the IPC returned. We accept loose shapes —
     * if `status` is missing or not in the known set, we degrade to
     * 'unknown' (don't alarm the user with red on a transient IPC blip).
     */
    function deriveBannerState(payload) {
        const safe = payload && typeof payload === 'object' ? payload : {};
        let status = typeof safe.status === 'string' ? safe.status : 'unknown';
        if (!KNOWN_STATES.has(status)) {
            status = 'unknown';
        }
        const readyCount = Number.isFinite(safe.ready_count) ? safe.ready_count : null;
        const configuredCount = Number.isFinite(safe.configured_count) ? safe.configured_count : null;
        const reason = typeof safe.reason === 'string' ? safe.reason.trim() : '';

        if (status === 'ready') {
            const n = readyCount != null ? readyCount : (configuredCount != null ? configuredCount : 1);
            const noun = n === 1 ? 'account' : 'accounts';
            return {
                status,
                cssClass: statusToCssClass(status),
                text: 'Grok session active — ' + n + ' ' + noun + ' ready.',
                buttonText: 'Refresh status',
                buttonAction: 'storyboard-batch-refresh-session',
            };
        }
        if (status === 'stale') {
            const detail = reason || 'Session may be stale — re-login recommended.';
            return {
                status,
                cssClass: statusToCssClass(status),
                text: detail,
                buttonText: 'Open manual login',
                buttonAction: 'storyboard-batch-login',
            };
        }
        if (status === 'no_accounts') {
            return {
                status,
                cssClass: statusToCssClass(status),
                text: 'No Grok account configured. Open the manual-login window to sign in; cookies will persist across app restarts.',
                buttonText: 'Open manual login',
                buttonAction: 'storyboard-batch-login',
            };
        }
        // unknown
        return {
            status,
            cssClass: 'unknown',
            text: reason || 'Checking Grok session…',
            buttonText: 'Open manual login',
            buttonAction: 'storyboard-batch-login',
        };
    }

    /**
     * Legacy fallback: when `getSessionStatus` IPC is unavailable, build
     * an equivalent banner shape from `auth:getAccounts` (which returns
     * either an array or `{accounts:[...]}`). We can only distinguish
     * has-account vs. no-account here — there's no freshness signal —
     * so accounts present collapses to `ready` and missing collapses
     * to `no_accounts`.
     */
    function deriveBannerStateFromAccounts(accountsPayload) {
        const accounts = Array.isArray(accountsPayload)
            ? accountsPayload
            : (accountsPayload && Array.isArray(accountsPayload.accounts) ? accountsPayload.accounts : []);
        if (accounts.length > 0) {
            return deriveBannerState({
                status: 'ready',
                ready_count: accounts.length,
                configured_count: accounts.length,
            });
        }
        return deriveBannerState({ status: 'no_accounts' });
    }

    return {
        statusToCssClass,
        deriveBannerState,
        deriveBannerStateFromAccounts,
        KNOWN_STATES,
    };
}));
