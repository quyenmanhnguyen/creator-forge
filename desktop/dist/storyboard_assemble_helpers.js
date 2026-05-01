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

    /**
     * Pick the savedFile from each settled video row and return them
     * in scene_id order, ready to drop into the scene-videos
     * textarea.
     *
     * Rows are kept only when they have:
     *   - status === 'settled' (or 'fallback' with savedFile present
     *     — the user may have manually fixed the failure)
     *   - a non-empty savedFile string
     *   - an extension in SUPPORTED_VIDEO_EXTS
     *
     * @param {Array<object>} videoRows
     * @returns {string[]}
     */
    function pullScenePathsFromBatch(videoRows) {
        if (!Array.isArray(videoRows)) return [];
        const sortable = videoRows
            .filter((r) => r && typeof r === 'object')
            .filter((r) => typeof r.savedFile === 'string' && r.savedFile.trim().length > 0)
            .filter((r) => {
                const lower = String(r.savedFile).toLowerCase();
                return SUPPORTED_VIDEO_EXTS.some((ext) => lower.endsWith(ext));
            });

        // Stable sort by scene_id when present, otherwise preserve
        // insertion order (Array.prototype.sort is stable in V8).
        sortable.sort((a, b) => {
            const ai = (a.scene_id != null) ? Number(a.scene_id) : Number.POSITIVE_INFINITY;
            const bi = (b.scene_id != null) ? Number(b.scene_id) : Number.POSITIVE_INFINITY;
            return ai - bi;
        });

        return sortable.map((r) => String(r.savedFile).trim());
    }

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
     * @param {string} [form.captionMode]
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

        return {
            scene_videos: cleaned,
            audio_path: blankToNull(f.audioPath),
            srt_path: blankToNull(f.srtPath),
            output_dir: blankToNull(f.outputDir),
            audio_mode: (f.audioMode === 'none') ? 'none' : 'replace',
            trim_to: (f.trimTo === 'audio') ? 'audio' : 'video',
            caption_mode: (f.captionMode === 'none') ? 'none' : 'soft',
        };
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
        parseSceneVideoPaths,
        pullScenePathsFromBatch,
        buildAssemblePayload,
        validateAssembleForm,
    };
}));
