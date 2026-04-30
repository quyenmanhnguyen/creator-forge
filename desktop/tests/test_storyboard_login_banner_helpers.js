/**
 * PR-21: offline tests for `storyboard_login_banner_helpers.js`.
 *
 * Asserts the always-on 3-state mapping (ready/stale/no_accounts plus
 * the unknown fallback) and the security guarantee that the helper
 * never surfaces cookies/tokens/headers/passwords from the IPC payload
 * — even if the IPC ever returns them by accident.
 */

const path = require('path');
const helpers = require(path.join(__dirname, '..', 'dist', 'storyboard_login_banner_helpers.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { console.log('  ok  ' + name); pass++; }
    else      { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); fail++; }
}

console.log('PR-21: storyboard_login_banner_helpers');

// ─── deriveBannerState — ready ──────────────────────────────────────
{
    const s = helpers.deriveBannerState({
        status: 'ready',
        ready_count: 2,
        configured_count: 2,
        accounts: [],
    });
    ok('ready → cssClass ready', s.cssClass === 'ready');
    ok('ready → status ready', s.status === 'ready');
    ok('ready → text mentions count + plural', /2 accounts/i.test(s.text));
    ok('ready → button refresh-status', s.buttonAction === 'storyboard-batch-refresh-session');
}

// ─── ready singular ─────────────────────────────────────────────────
{
    const s = helpers.deriveBannerState({ status: 'ready', ready_count: 1, configured_count: 1 });
    ok('ready singular → "1 account"', /1 account\b/.test(s.text), s.text);
    ok('ready singular → not "accounts"', !/1 accounts/.test(s.text), s.text);
}

// ─── stale ──────────────────────────────────────────────────────────
{
    const s = helpers.deriveBannerState({ status: 'stale', reason: 'Session 2h old' });
    ok('stale → cssClass stale', s.cssClass === 'stale');
    ok('stale → uses IPC reason', s.text === 'Session 2h old');
    ok('stale → button login', s.buttonAction === 'storyboard-batch-login');
}

// ─── stale without reason ───────────────────────────────────────────
{
    const s = helpers.deriveBannerState({ status: 'stale' });
    ok('stale w/o reason → fallback text',
       /stale/i.test(s.text) && /re-login/i.test(s.text), s.text);
}

// ─── no_accounts ────────────────────────────────────────────────────
{
    const s = helpers.deriveBannerState({ status: 'no_accounts' });
    ok('no_accounts → cssClass no-accounts (kebab)', s.cssClass === 'no-accounts');
    ok('no_accounts → text mentions configured',
       /no grok account/i.test(s.text), s.text);
    ok('no_accounts → button login', s.buttonAction === 'storyboard-batch-login');
}

// ─── unknown fallbacks ──────────────────────────────────────────────
{
    const s = helpers.deriveBannerState({});
    ok('empty payload → unknown', s.cssClass === 'unknown');
    ok('empty payload → checking text', /checking/i.test(s.text));
}
{
    const s = helpers.deriveBannerState(null);
    ok('null payload → unknown', s.cssClass === 'unknown');
}
{
    const s = helpers.deriveBannerState({ status: 'gibberish' });
    ok('unknown status → unknown', s.cssClass === 'unknown');
    ok('unknown status → status unknown', s.status === 'unknown');
}

// ─── deriveBannerStateFromAccounts (legacy fallback) ────────────────
{
    const s = helpers.deriveBannerStateFromAccounts([{ email: 'a@b.c' }, { email: 'd@e.f' }]);
    ok('accounts array len 2 → ready 2', s.cssClass === 'ready' && /2 accounts/.test(s.text));
}
{
    const s = helpers.deriveBannerStateFromAccounts([]);
    ok('accounts empty → no-accounts', s.cssClass === 'no-accounts');
}
{
    const s = helpers.deriveBannerStateFromAccounts({ accounts: [{ email: 'a@b.c' }] });
    ok('wrapped accounts → ready', s.cssClass === 'ready' && /1 account\b/.test(s.text));
}
{
    const s = helpers.deriveBannerStateFromAccounts(null);
    ok('null accounts → no-accounts', s.cssClass === 'no-accounts');
}

// ─── statusToCssClass direct ────────────────────────────────────────
{
    ok('statusToCssClass(ready)', helpers.statusToCssClass('ready') === 'ready');
    ok('statusToCssClass(stale)', helpers.statusToCssClass('stale') === 'stale');
    ok('statusToCssClass(no_accounts)', helpers.statusToCssClass('no_accounts') === 'no-accounts');
    ok('statusToCssClass(weird)', helpers.statusToCssClass('weird') === 'unknown');
}

// ─── security: never surface cookies/headers/tokens/passwords ───────
// Even if the IPC misbehaves and returns secret-shaped fields, the
// helper output (text + buttonText + buttonAction + cssClass) must
// be free of them. PR-20E enforced this on the IPC side; this test
// is the renderer-side guard.
{
    const tainted = {
        status: 'ready',
        ready_count: 1,
        configured_count: 1,
        cookies: [{ name: 'session', value: 'SECRET_COOKIE_VALUE' }],
        capturedHeaders: { 'x-statsig-id': 'STATSIG_LEAK' },
        accounts: [{
            email: 'leaktest@example.com',
            password: 'PASSWORD_LEAK',
            statsigId: 'ID_LEAK',
        }],
        bearer: 'Bearer abc.xyz.LEAK',
    };
    const s = helpers.deriveBannerState(tainted);
    const blob = JSON.stringify(s);
    ok('no SECRET_COOKIE_VALUE in output', !blob.includes('SECRET_COOKIE_VALUE'));
    ok('no STATSIG_LEAK in output', !blob.includes('STATSIG_LEAK'));
    ok('no PASSWORD_LEAK in output', !blob.includes('PASSWORD_LEAK'));
    ok('no ID_LEAK in output', !blob.includes('ID_LEAK'));
    ok('no Bearer.*LEAK in output', !/Bearer.+LEAK/.test(blob));
    ok('no leaktest@example.com surfaced', !blob.includes('leaktest@example.com'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
