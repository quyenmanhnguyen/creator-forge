/**
 * keysStore.js — persistent API-keys store for the desktop app.
 *
 * The Python research sidecar reads its API keys from environment
 * variables (DEEPSEEK_API_KEY, YOUTUBE_API_KEY, GOOGLE_API_KEY /
 * GEMINI_API_KEY for the alternate LLM, RUNNINGHUB_API_KEY for
 * ComfyUI image gen). Historically users set these in a `.env` file
 * at the repo root before launching the app, which is fine for
 * developers but unfriendly for end users running a packaged build.
 *
 * This module gives `electron/main.js` a tiny persistent JSON store
 * under `app.getPath('userData')/api-keys.json` so the renderer's
 * Settings ⚙ button can read / write keys without touching the
 * filesystem directly. The values are then merged into the env
 * passed to `researchSidecar.start({ extraEnv })`.
 *
 * Pure-functional: every external surface (storeDir, fs impl) is
 * dependency-injectable so the offline test suite can hit every
 * branch without touching real userData.
 *
 * **Storage caveats** — the file is plain JSON with `chmod 0600`.
 * That's the same posture as the existing `accounts.json` (which
 * already holds Grok email + password in clear text). It is NOT
 * an OS-keychain-grade vault. If the user's machine is compromised
 * the keys are recoverable. We accept this trade-off because it
 * matches the rest of the app and avoids a hard dependency on
 * `keytar` / `safeStorage` which behave inconsistently on Linux
 * without a system keyring.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const KEYS_FILENAME = 'api-keys.json';

/**
 * Whitelist of env-var names the renderer is allowed to set / read.
 *
 * Keep this list in sync with `research/core/pixelle/config.py` and
 * `research/api/main.py`'s required-env list. New keys MUST be added
 * here explicitly — anything not on the whitelist is silently dropped
 * by `saveKeys`, both as a defence-in-depth against renderer bugs and
 * to keep `getKeyEnv()` from leaking unrelated process-env vars.
 */
const ALLOWED_KEYS = Object.freeze([
    'DEEPSEEK_API_KEY',
    'YOUTUBE_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'RUNNINGHUB_API_KEY',
]);

/**
 * Resolve the absolute path to the JSON store. The caller-injected
 * `storeDir` (from `app.getPath('userData')` in production) wins;
 * the `CREATOR_FORGE_KEYS_FILE` env override is honoured for tests
 * and power users who want to relocate the file (e.g. into a
 * profile-specific folder). When `storeDir` is omitted (e.g. in
 * unit tests that pre-set the env override) we fall back to the
 * current working directory so an unset path never throws.
 */
function getKeysFile({ storeDir, env = process.env } = {}) {
    if (env && env.CREATOR_FORGE_KEYS_FILE) {
        return env.CREATOR_FORGE_KEYS_FILE;
    }
    const dir = storeDir || process.cwd();
    return path.join(dir, KEYS_FILENAME);
}

/**
 * Load saved keys from disk. Returns `{}` (not `null`) when the file
 * is missing, empty, malformed, or contains non-object JSON, so the
 * caller can spread / iterate without a null-guard. Unknown keys are
 * filtered out on read too, so even if the file was hand-edited with
 * extra fields they won't leak into the renderer.
 */
function loadKeys({ storeDir, env = process.env, fsImpl = fs } = {}) {
    const file = getKeysFile({ storeDir, env });
    let raw;
    try {
        raw = fsImpl.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return {};
        // Permission errors etc. — surface an empty store rather than
        // crash, matching the existing `loadAccounts()` posture.
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const k of ALLOWED_KEYS) {
        if (typeof parsed[k] === 'string' && parsed[k].length > 0) {
            out[k] = parsed[k];
        }
    }
    return out;
}

/**
 * Persist a keys object. Only whitelisted, non-empty string values
 * are written; everything else (numbers, objects, empty strings,
 * undefined) is dropped. The parent directory is created on a fresh
 * install where `userData` doesn't exist yet, mirroring
 * `AccountService.saveAccounts`.
 *
 * The file is always written with mode 0600 (owner read/write only)
 * to reduce the blast radius of an accidentally-shared filesystem.
 *
 * Returns the sanitised object that was actually written, so the
 * caller can echo it back to the renderer instead of re-reading.
 */
function saveKeys(keys, { storeDir, env = process.env, fsImpl = fs } = {}) {
    const file = getKeysFile({ storeDir, env });
    const dir = path.dirname(file);
    try {
        fsImpl.mkdirSync(dir, { recursive: true });
    } catch (err) {
        if (!err || err.code !== 'EEXIST') {
            // Re-throw — we can't proceed without the directory.
            throw err;
        }
    }
    const sanitised = {};
    if (keys && typeof keys === 'object') {
        for (const k of ALLOWED_KEYS) {
            const v = keys[k];
            if (typeof v === 'string' && v.length > 0) {
                sanitised[k] = v;
            }
        }
    }
    const text = JSON.stringify(sanitised, null, 4) + '\n';
    fsImpl.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    // writeFileSync's `mode` only takes effect when the file is created;
    // re-chmod existing files so a 644 file from a prior version gets
    // tightened on the next save.
    try {
        fsImpl.chmodSync(file, 0o600);
    } catch (_) {
        // Windows ignores POSIX modes — that's fine.
    }
    return sanitised;
}

/**
 * Build the env diff to merge into the sidecar's spawn env. Returns
 * an object containing only the whitelisted, non-empty string keys
 * — never any other process-env values. Equivalent to `loadKeys()`
 * today but kept as a separate function so callers can swap in
 * derived values (e.g. `GEMINI_API_KEY` ↔ `GOOGLE_API_KEY` aliasing)
 * later without touching every call site.
 */
function getKeyEnv(opts = {}) {
    return loadKeys(opts);
}

module.exports = {
    ALLOWED_KEYS,
    KEYS_FILENAME,
    getKeysFile,
    loadKeys,
    saveKeys,
    getKeyEnv,
};
