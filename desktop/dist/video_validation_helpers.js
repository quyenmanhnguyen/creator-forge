/**
 * video_validation_helpers.js — ffprobe-based validation for I2V/T2V/composer
 * mp4 outputs (PR-20E hardening).
 *
 * Why this exists: every video acceptance point in the desktop app today
 * accepts a file as "generated" based on byte size alone (1 KB at the
 * service download layer, 10 KB in the compose-with-AutoGrok bridge,
 * nothing at all in the Batch Image+Video panel). A truncated download
 * or a non-mp4 error body that happens to be > N KB still passes those
 * floors, gets handed to the composer as a usable scene, and the user
 * sees a "generated" row that won't actually play.
 *
 * This helper layers ffprobe on top of the existing size check:
 *
 *   1. exists + size ≥ minBytes  (unchanged contract)
 *   2. ffprobe -show_format -show_streams parses cleanly
 *   3. format.duration > minDurationSec
 *   4. at least one stream has codec_type === "video"
 *
 * If ffprobe is not on PATH (and FFPROBE_PATH env / common bundle
 * locations don't resolve), the helper degrades gracefully to (1) only
 * with `ffprobeAvailable: false` in the result so the caller can
 * surface the warning. The validation never throws — failure modes
 * always come back as `{ ok: false, reason }`.
 *
 * Loaded as plain CommonJS so tests can `require()` it under Node.
 * Renderer-side use is via the `video:validateOutput` IPC (see
 * desktop/electron/main.js); the renderer doesn't spawn ffprobe
 * directly.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Mirrors the floors used elsewhere in the codebase. The I2V helper
// already exposes `MIN_USABLE_VIDEO_BYTES = 10000`; we keep the same
// number here so callers don't drift apart over time. The composer's
// final mp4 has a slightly higher floor since a real 9:16 short
// rendered with audio + captions is always tens of KB at minimum.
const MIN_USABLE_VIDEO_BYTES = 10000;
const MIN_FINAL_MP4_BYTES = 10000;
const MIN_DURATION_SEC = 0.2;
const FFPROBE_TIMEOUT_MS = 15000;

// Resolve an ffprobe binary the same way main.js#getFfmpegPath resolves
// ffmpeg: env override → common bundle locations → PATH fallback.
// Returns the string we'll hand to spawn(); 'ffprobe' is the PATH
// fallback (spawn will fail with ENOENT if it really isn't installed,
// which we catch and surface as ffprobeAvailable=false).
function getFfprobePath() {
    const candidates = [
        process.env.FFPROBE_PATH,
        path.join(process.cwd(), 'bin', 'ffprobe.exe'),
        path.join(process.cwd(), 'ffprobe.exe'),
        path.join(process.cwd(), 'ffmpeg', 'ffprobe.exe'),
        path.join(process.cwd(), 'ffmpeg', 'bin', 'ffprobe.exe'),
        path.join(__dirname, '..', 'bin', 'ffprobe.exe'),
        path.join(__dirname, 'ffprobe.exe'),
        path.join(__dirname, '..', 'ffmpeg', 'ffprobe.exe'),
        path.join(__dirname, '..', 'ffmpeg', 'bin', 'ffprobe.exe'),
        process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'ffprobe.exe') : null,
        'ffprobe',
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate === 'ffprobe' || (function () {
            try { return fs.existsSync(candidate); } catch (_) { return false; }
        })()) {
            return candidate;
        }
    }
    return 'ffprobe';
}

// Spawn ffprobe and collect its JSON stdout. The factory pattern lets
// tests inject a fake `spawnFn` (see test_video_validation_helpers.js)
// so we don't have to install ffprobe in CI.
function _runFfprobe(filePath, spawnFn) {
    const fn = typeof spawnFn === 'function' ? spawnFn : spawn;
    return new Promise((resolve) => {
        let child;
        try {
            child = fn(getFfprobePath(), [
                '-v', 'error',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                filePath,
            ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ available: false, code: -1, stdout: '', stderr: err && err.message ? err.message : String(err) });
            return;
        }
        if (!child || !child.stdout || !child.stderr) {
            resolve({ available: false, code: -1, stdout: '', stderr: 'spawn returned no child' });
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            settle({ available: true, code: -1, stdout, stderr: stderr + '\n[timeout]' });
        }, FFPROBE_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (err) => {
            clearTimeout(timer);
            const code = err && err.code === 'ENOENT' ? -1 : -2;
            settle({ available: code !== -1, code, stdout, stderr: (err && err.message) || String(err) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            settle({ available: true, code, stdout, stderr });
        });
    });
}

/**
 * Probe a file with ffprobe (or fall back to size-only when ffprobe is
 * unavailable). Always resolves; never throws.
 *
 * @param {string} filePath
 * @param {{ spawnFn?: Function, statFn?: Function }} [opts]
 * @returns {Promise<{
 *   exists: boolean,
 *   size: number,
 *   ffprobeAvailable: boolean,
 *   durationSec: number|null,
 *   hasVideoStream: boolean|null,
 *   width: number|null,
 *   height: number|null,
 *   codec: string|null,
 *   reason: string|null,
 * }>}
 */
async function probeVideoFile(filePath, opts) {
    const o = opts || {};
    const statFn = typeof o.statFn === 'function' ? o.statFn : (p) => {
        try {
            const s = fs.statSync(p);
            return { exists: true, size: Number(s.size) || 0 };
        } catch (_) {
            return { exists: false, size: 0 };
        }
    };
    if (typeof filePath !== 'string' || !filePath) {
        return {
            exists: false, size: 0, ffprobeAvailable: false,
            durationSec: null, hasVideoStream: null, width: null, height: null, codec: null,
            reason: 'empty filePath',
        };
    }
    const st = statFn(filePath) || { exists: false, size: 0 };
    if (!st.exists) {
        return {
            exists: false, size: 0, ffprobeAvailable: false,
            durationSec: null, hasVideoStream: null, width: null, height: null, codec: null,
            reason: `file not on disk: ${filePath}`,
        };
    }
    const size = Number(st.size) || 0;
    const probeRes = await _runFfprobe(filePath, o.spawnFn);
    if (!probeRes.available) {
        return {
            exists: true, size, ffprobeAvailable: false,
            durationSec: null, hasVideoStream: null, width: null, height: null, codec: null,
            reason: 'ffprobe unavailable on this machine — fell back to exists+size check',
        };
    }
    if (probeRes.code !== 0 || !probeRes.stdout) {
        const trimmed = (probeRes.stderr || '').split('\n').slice(-3).join(' ').trim();
        return {
            exists: true, size, ffprobeAvailable: true,
            durationSec: null, hasVideoStream: false, width: null, height: null, codec: null,
            reason: `ffprobe rejected file (exit ${probeRes.code}): ${trimmed || 'no stderr'}`,
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(probeRes.stdout);
    } catch (err) {
        return {
            exists: true, size, ffprobeAvailable: true,
            durationSec: null, hasVideoStream: false, width: null, height: null, codec: null,
            reason: `ffprobe stdout was not valid JSON: ${err && err.message ? err.message : 'parse error'}`,
        };
    }
    const fmt = (parsed && parsed.format) || {};
    const streams = Array.isArray(parsed && parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((s) => s && s.codec_type === 'video') || null;
    const durRaw = fmt.duration != null ? Number(fmt.duration) : (videoStream && videoStream.duration != null ? Number(videoStream.duration) : NaN);
    const durationSec = Number.isFinite(durRaw) ? durRaw : null;
    return {
        exists: true,
        size,
        ffprobeAvailable: true,
        durationSec,
        hasVideoStream: !!videoStream,
        width: videoStream && Number.isFinite(Number(videoStream.width)) ? Number(videoStream.width) : null,
        height: videoStream && Number.isFinite(Number(videoStream.height)) ? Number(videoStream.height) : null,
        codec: videoStream && videoStream.codec_name ? String(videoStream.codec_name) : null,
        reason: null,
    };
}

/**
 * Validate a video file against the project's policy. Builds on
 * probeVideoFile and applies the byte/duration/stream thresholds.
 *
 * Policy:
 *   - exists + size ≥ minBytes  (always)
 *   - if ffprobe ran:
 *       durationSec > minDurationSec
 *       hasVideoStream === true
 *
 * Returns `{ ok, reason, ffprobeAvailable, ... }`. The full probe shape
 * is included so callers can log width/height/codec without re-probing.
 *
 * @param {string} filePath
 * @param {{
 *   minBytes?: number,
 *   minDurationSec?: number,
 *   spawnFn?: Function,
 *   statFn?: Function,
 * }} [opts]
 */
async function validateVideoOutput(filePath, opts) {
    const o = opts || {};
    const minBytes = typeof o.minBytes === 'number' ? o.minBytes : MIN_USABLE_VIDEO_BYTES;
    const minDur = typeof o.minDurationSec === 'number' ? o.minDurationSec : MIN_DURATION_SEC;
    const probe = await probeVideoFile(filePath, { spawnFn: o.spawnFn, statFn: o.statFn });
    if (!probe.exists) {
        return Object.assign({}, probe, { ok: false });
    }
    if (probe.size < minBytes) {
        return Object.assign({}, probe, {
            ok: false,
            reason: `file is suspiciously small (${probe.size} < ${minBytes} bytes — likely truncated download)`,
        });
    }
    if (probe.ffprobeAvailable) {
        if (!probe.hasVideoStream) {
            return Object.assign({}, probe, {
                ok: false,
                reason: probe.reason || 'no video stream detected by ffprobe',
            });
        }
        if (!(typeof probe.durationSec === 'number' && probe.durationSec > minDur)) {
            return Object.assign({}, probe, {
                ok: false,
                reason: `ffprobe reports duration ${probe.durationSec == null ? 'unknown' : probe.durationSec.toFixed(3) + 's'} ≤ ${minDur}s`,
            });
        }
        return Object.assign({}, probe, { ok: true, reason: null });
    }
    // ffprobe unavailable → soft pass with the size check, but keep the
    // reason set so callers can log a warning. Tests assert on this.
    return Object.assign({}, probe, { ok: true });
}

const api = {
    MIN_USABLE_VIDEO_BYTES,
    MIN_FINAL_MP4_BYTES,
    MIN_DURATION_SEC,
    getFfprobePath,
    probeVideoFile,
    validateVideoOutput,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.VideoValidationHelpers = api;
}
