/**
 * storyboard_assemble_helpers.js — pure helpers for the renderer's
 * Video Assembly panel (PR-31).
 *
 * Loaded as a plain `<script>` before `creator-forge.js` so the
 * renderer has a small, testable module without pulling in a bundler.
 * Also `module.exports`-friendly so `desktop/tests/*.js` can require
 * it directly under Node.
 *
 * Two responsibilities:
 *   1. Convert UI strings (textarea contents, picker values) into a
 *      well-formed POST body for /producer/assemble.
 *   2. Mine the existing Video-batch state (settled rows from
 *      I2V/T2V) to autofill the scene_videos textarea, in scene
 *      order, dropping any rows that don't have a savedFile yet.
 *
 * Splitting these out keeps `creator-forge.js` readable and makes
 * the assemble path independent-testable in CI alongside the
 * existing helpers.
 */
(function (root, factory) {
    'use strict';
    const mod = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = mod;
    } else if (root) {
        root.StoryboardAssembleHelpers = mod;
    }
}(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const SUPPORTED_VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm'];

    /**
     * Turn a multi-line textarea value into a clean array of paths.
     *
     * Mirrors the backend strip rules so the POST body is identical
     * to what the user can read in the UI:
     *   - whitespace stripped per line
     *   - empty lines dropped
     *   - duplicate paths collapsed (keeps first occurrence)
     *
     * Does NOT validate file existence — the backend handles that and
     * surfaces structured warnings.
     *
     * @param {string} text
     * @returns {string[]}
     */
    function parseSceneVideoPaths(text) {
        if (typeof text !== 'string') return [];
        const seen = new Set();
        const out = [];
        for (const raw of text.split('\n')) {
            const line = raw.replace(/\r$/, '').trim();
            if (!line) continue;
            if (seen.has(line)) continue;
            seen.add(line);
            out.push(line);
        }
        return out;
    }

    // Statuses that count as "this row has a usable output file".
    // ``settled`` is the legacy IPC-layer status, ``generated`` /
    // ``retried`` are the real renderer-state statuses set by
    // ``applyBatchResult``, and ``fallback`` covers rows the user
    // manually rescued. ``generating`` / ``pending`` / ``failed`` /
    // ``skipped`` must NOT be promoted — those rows either don't have
    // a file yet or had their generation aborted.
    const SETTLED_STATUSES = new Set(['generated', 'retried', 'settled', 'fallback']);

    /**
     * Pull the local video file path from each settled video row and
     * return them in scene_id order, ready to drop into the
     * scene-videos textarea.
     *
     * Rows are kept only when they have:
     *   - status in SETTLED_STATUSES (or status absent — back-compat
     *     for older fixtures that omitted the field entirely; the
     *     extension + path checks below still gate them)
     *   - a non-empty file path on either ``video_path`` (real
     *     renderer state — populated by ``applyBatchResult``) or
     *     ``savedFile`` (legacy IPC contract / unit-test fixtures)
     *   - an extension in SUPPORTED_VIDEO_EXTS
     *
     * @param {Array<object>} videoRows
     * @returns {string[]}
     */
    function pullScenePathsFromBatch(videoRows) {
        if (!Array.isArray(videoRows)) return [];
        const pickPath = (r) => {
            const candidates = [r.video_path, r.savedFile];
            for (const c of candidates) {
                if (typeof c === 'string' && c.trim().length > 0) return c.trim();
            }
            return '';
        };
        const sortable = videoRows
            .filter((r) => r && typeof r === 'object')
            .filter((r) => {
                if (r.status == null) return true;
                return SETTLED_STATUSES.has(String(r.status));
            })
            .map((r) => Object.assign({}, r, { __path: pickPath(r) }))
            .filter((r) => r.__path.length > 0)
            .filter((r) => {
                const lower = r.__path.toLowerCase();
                return SUPPORTED_VIDEO_EXTS.some((ext) => lower.endsWith(ext));
            });

        // Stable sort by scene_id when present, otherwise preserve
        // insertion order (Array.prototype.sort is stable in V8).
        sortable.sort((a, b) => {
            const ai = (a.scene_id != null) ? Number(a.scene_id) : Number.POSITIVE_INFINITY;
            const bi = (b.scene_id != null) ? Number(b.scene_id) : Number.POSITIVE_INFINITY;
            return ai - bi;
        });

        return sortable.map((r) => r.__path);
    }

    // Whitelist of caption modes the backend's AssembleRequest will
    // accept (see research/api/routes/producer.py). Kept in this
    // module — not the schema layer — because the helper is the only
    // place the renderer needs to map UI strings to wire values.
    const CAPTION_MODES = ['soft', 'burn', 'none'];
    const DEFAULT_CAPTION_MODE = 'soft';

    // HF-10 — burn caption styling whitelists. Kept 1:1 in sync with
    // ``research/core/pixelle/assembler.py:CAPTION_STYLE_PRESETS`` and
    // the ``CaptionStyle`` / ``CaptionFontSize`` / ``CaptionPosition``
    // Literals on ``research/api/routes/producer.py:AssembleRequest``.
    // If any of those drift this list must drift with them — the
    // ``test_storyboard_assemble_helpers.js`` round-trip tests catch
    // mismatches. The font-size + position lists deliberately omit
    // empty string ('preset default') because the wire schema uses
    // ``null`` for that case; the helper coerces the UI's empty
    // string to ``null`` before serialising.
    const CAPTION_STYLES = ['modern', 'cinematic', 'tiktok', 'minimal'];
    const DEFAULT_CAPTION_STYLE = 'modern';
    const CAPTION_FONT_SIZES = ['small', 'medium', 'large'];
    const CAPTION_POSITIONS = ['bottom', 'middle', 'top'];

    /**
     * Build the JSON body for POST /producer/assemble from form
     * inputs. Empty string fields collapse to `null` to match the
     * backend's Optional[str] semantics — sending `""` makes the
     * sidecar treat it as a real path and warn.
     *
     * @param {object} form
     * @param {string[]} form.scenePaths
     * @param {string} [form.audioPath]
     * @param {string} [form.srtPath]
     * @param {string} [form.outputDir]
     * @param {string} [form.audioMode]
     * @param {string} [form.trimTo]
     * @param {string} [form.captionMode] - one of 'soft' (default,
     *   mov_text track), 'burn' (PR-32, rendered into video), 'none'
     *   (drop srt). Unknown values fall back to 'soft'.
     * @param {string} [form.captionStyle] - HF-10 burn preset name
     *   ('modern' / 'cinematic' / 'tiktok' / 'minimal'). Only emitted
     *   when ``captionMode === 'burn'``; unknown values fall back to
     *   ``DEFAULT_CAPTION_STYLE`` so a stale UI never produces a 422.
     * @param {string} [form.captionFontSize] - HF-10 font-size
     *   override ('small' / 'medium' / 'large') or empty string for
     *   the preset default. Empty / unknown values map to ``null``
     *   on the wire.
     * @param {string} [form.captionPosition] - HF-10 vertical-position
     *   override ('bottom' / 'middle' / 'top') or empty string for
     *   the preset default. Empty / unknown values map to ``null``.
     * @returns {object}
     */
    function buildAssemblePayload(form) {
        const f = form || {};
        const paths = Array.isArray(f.scenePaths) ? f.scenePaths : [];
        const cleaned = paths
            .map((p) => (typeof p === 'string' ? p.trim() : ''))
            .filter((p) => p.length > 0);

        const blankToNull = (v) => {
            if (typeof v !== 'string') return null;
            const t = v.trim();
            return t.length > 0 ? t : null;
        };

        const captionMode = CAPTION_MODES.includes(f.captionMode)
            ? f.captionMode
            : DEFAULT_CAPTION_MODE;

        const payload = {
            scene_videos: cleaned,
            audio_path: blankToNull(f.audioPath),
            srt_path: blankToNull(f.srtPath),
            output_dir: blankToNull(f.outputDir),
            audio_mode: (f.audioMode === 'none') ? 'none' : 'replace',
            trim_to: (f.trimTo === 'audio') ? 'audio' : 'video',
            caption_mode: captionMode,
        };

        // HF-10 — burn-only styling fields. Only sent when the user
        // actually picked ``burn`` so the wire payload stays minimal
        // for the common ``soft`` / ``none`` paths. Unknown values
        // collapse to the default preset / null so a stale renderer
        // never produces a 422.
        if (captionMode === 'burn') {
            payload.caption_style = CAPTION_STYLES.includes(f.captionStyle)
                ? f.captionStyle
                : DEFAULT_CAPTION_STYLE;
            payload.caption_font_size = CAPTION_FONT_SIZES.includes(f.captionFontSize)
                ? f.captionFontSize
                : null;
            payload.caption_position = CAPTION_POSITIONS.includes(f.captionPosition)
                ? f.captionPosition
                : null;
        }

        return payload;
    }

    /**
     * Decide whether the Assemble button should be enabled. Returns
     * `{ enabled, reason }`. Mirrors the structural validation we
     * also do server-side so the user gets fast feedback without an
     * IPC roundtrip.
     *
     * @param {object} form
     * @returns {{ enabled: boolean, reason: string }}
     */
    function validateAssembleForm(form) {
        const payload = buildAssemblePayload(form);
        if (payload.scene_videos.length === 0) {
            return { enabled: false, reason: 'Need at least one scene video path.' };
        }
        if (payload.scene_videos.length === 1 && !payload.audio_path) {
            // Single-clip + no audio override is technically valid
            // (scenes get re-encoded), but the user almost certainly
            // didn't mean to invoke assembly for a single clip with
            // no narration. Surface it as a warning, not a hard
            // block.
            return {
                enabled: true,
                reason: 'Heads up: 1 scene + no narration audio is just a re-encode.',
            };
        }
        return { enabled: true, reason: '' };
    }

    return {
        SUPPORTED_VIDEO_EXTS,
        CAPTION_MODES,
        DEFAULT_CAPTION_MODE,
        CAPTION_STYLES,
        DEFAULT_CAPTION_STYLE,
        CAPTION_FONT_SIZES,
        CAPTION_POSITIONS,
        parseSceneVideoPaths,
        pullScenePathsFromBatch,
        buildAssemblePayload,
        validateAssembleForm,
    };
}));
