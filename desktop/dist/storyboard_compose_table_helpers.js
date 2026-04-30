/**
 * Pure helpers driving the per-scene "Compose with AutoGrok" table view
 * (PR-20C). The table replaces the three separate cards
 * (per-scene image status / scene assets / video assets) that the
 * renderer used to print after orchestration finished, with one
 * column-per-phase row that updates *live* as `job:progress` events
 * fire from the main process.
 *
 * These helpers are intentionally framework-agnostic — they take a
 * row list and a delta and return a new row list. The renderer owns
 * the DOM; this module owns the state shape and transitions, which
 * is what makes the behavior testable offline.
 *
 * Contract notes:
 * - Row identity is `scene_id`. Image and I2V progress events arrive
 *   with `globalIdx` which is relative to the current batch call's
 *   sub-list of prompts/items (see ImageService / I2VService); the
 *   renderer maps `globalIdx → scene_id` itself before invoking
 *   `applyImageProgress` / `applyI2VProgress`.
 * - Statuses are aligned with the image + I2V helpers' status table:
 *     image: 'pending' | 'generating' | 'generated' | 'retrying' |
 *            'retried' | 'fallback' | 'skipped'
 *     i2v:   'pending' | 'idle' | 'generating' | 'generated' |
 *            'retrying' | 'retried' | 'fallback' | 'skipped'
 *   `idle` is the i2v initial state for a row that has a usable
 *   image but the I2V phase hasn't started yet (or won't run because
 *   useI2V=false). `pending` is reserved for "no plan yet".
 * - Helpers are pure: they never mutate their inputs.
 */

(function (root, factory) {
    if (typeof module !== "undefined" && module.exports) {
        module.exports = factory();
    } else {
        root.StoryboardComposeTableHelpers = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // ── Row factory ─────────────────────────────────────────────────────

    /**
     * Build the initial row list from a scene_breakdown response.
     * Every scene gets a row whether or not it can be I2V-eligible —
     * the status columns reflect that downstream.
     *
     * @param {Array<Object>} scenes
     * @returns {Array<Object>} rows
     */
    function initRowsFromScenes(scenes) {
        if (!Array.isArray(scenes)) return [];
        return scenes.map((s, idx) => ({
            order: idx + 1,
            scene_id: s && s.scene_id != null ? s.scene_id : null,
            title: (s && s.title) ? String(s.title) : "",
            duration_s: typeof (s && s.duration_s) === "number" ? s.duration_s : 0,
            image_prompt: (s && s.image_prompt) ? String(s.image_prompt) : "",
            video_prompt: (s && (s.video_prompt || s.flow_video_prompt))
                ? String(s.video_prompt || s.flow_video_prompt) : "",
            // Image phase state.
            image: {
                status: "pending",
                progress: 0,
                attempts: 0,
                image_path: null,
                bytes: null,
                reason: null,
            },
            // I2V phase state.
            i2v: {
                status: "pending",
                progress: 0,
                attempts: 0,
                video_path: null,
                bytes: null,
                reason: null,
            },
        }));
    }

    // ── Phase setup ─────────────────────────────────────────────────────

    /**
     * Mark every row whose scene_id is in `eligibleSceneIds` as
     * 'generating' (image phase). Other rows are left at 'pending'
     * but get a reason so the table explains why they're not active
     * (typically: missing image_prompt or duration).
     *
     * @param {Array<Object>} rows
     * @param {Array<number|string>} eligibleSceneIds
     * @param {Array<{scene_id: any, reason: string}>} skipped
     * @returns {Array<Object>} new rows
     */
    function startImagePhase(rows, eligibleSceneIds, skipped) {
        const eligible = new Set((eligibleSceneIds || []).map((id) => String(id)));
        const skipMap = new Map(
            (skipped || []).map((s) => [String(s.scene_id), s.reason || "skipped"]),
        );
        return rows.map((row) => {
            const sid = String(row.scene_id);
            if (eligible.has(sid)) {
                return Object.assign({}, row, {
                    image: Object.assign({}, row.image, { status: "generating", attempts: 1 }),
                });
            }
            if (skipMap.has(sid)) {
                return Object.assign({}, row, {
                    image: Object.assign({}, row.image, { status: "skipped", reason: skipMap.get(sid) }),
                    i2v: Object.assign({}, row.i2v, { status: "skipped", reason: "no image" }),
                });
            }
            return row;
        });
    }

    /**
     * Bump the `attempts` counter and set status='retrying' for the
     * rows whose scene_id is in `retrySceneIds` (image phase).
     */
    function startImageRetry(rows, retrySceneIds, attemptNumber) {
        const retry = new Set((retrySceneIds || []).map((id) => String(id)));
        return rows.map((row) => {
            if (!retry.has(String(row.scene_id))) return row;
            return Object.assign({}, row, {
                image: Object.assign({}, row.image, {
                    status: "retrying",
                    attempts: typeof attemptNumber === "number" ? attemptNumber : (row.image.attempts || 0) + 1,
                    progress: 0,
                }),
            });
        });
    }

    /**
     * Apply a single `job:progress` event from `image:generate`.
     * Pre-result the only thing we care about is the percentage so
     * the row can move its progress bar; once a result lands we
     * overwrite status with 'generated' (or stay in retrying if the
     * file failed; the orchestrator's final pick decides 'fallback'
     * vs. 'retried' afterwards via applyImageResult).
     *
     * @param {Array<Object>} rows
     * @param {number|string} sceneId
     * @param {{progress?: number, result?: Object}} payload
     * @returns {Array<Object>} new rows
     */
    function applyImageProgress(rows, sceneId, payload) {
        const sid = String(sceneId);
        return rows.map((row) => {
            if (String(row.scene_id) !== sid) return row;
            const p = (payload && typeof payload.progress === "number") ? payload.progress : null;
            const next = Object.assign({}, row.image);
            if (p !== null && p > next.progress) next.progress = Math.max(0, Math.min(100, p));
            // Don't downgrade a row that's already settled — including
            // 'skipped' rows that were filtered out at the planning
            // stage, so a stray late `image:progress` event for a
            // recycled scene_id can't bump a skipped row's bar.
            if (row.image.status === "generated" || row.image.status === "retried"
                || row.image.status === "fallback" || row.image.status === "skipped") return row;
            return Object.assign({}, row, { image: next });
        });
    }

    /**
     * Settle an image row. `status` should be 'generated' (first
     * attempt) / 'retried' (later attempt) / 'fallback' (no usable
     * image after maxAttempts). When the row settles to a usable
     * image we also flip i2v.status to 'idle' so the table makes it
     * obvious that the I2V phase is now waiting on this row.
     */
    function applyImageResult(rows, sceneId, settle) {
        const sid = String(sceneId);
        return rows.map((row) => {
            if (String(row.scene_id) !== sid) return row;
            const image = Object.assign({}, row.image, {
                status: settle.status,
                attempts: settle.attempts != null ? settle.attempts : row.image.attempts,
                image_path: settle.image_path != null ? settle.image_path : row.image.image_path,
                bytes: settle.bytes != null ? settle.bytes : row.image.bytes,
                reason: settle.reason != null ? settle.reason : row.image.reason,
                progress: settle.status === "generated" || settle.status === "retried" ? 100 : row.image.progress,
            });
            const i2vNext = settle.status === "generated" || settle.status === "retried"
                ? Object.assign({}, row.i2v, { status: row.i2v.status === "pending" ? "idle" : row.i2v.status })
                : (settle.status === "fallback"
                    ? Object.assign({}, row.i2v, { status: "skipped", reason: "no image" })
                    : row.i2v);
            return Object.assign({}, row, { image, i2v: i2vNext });
        });
    }

    // ── I2V phase ──────────────────────────────────────────────────────

    function startI2VPhase(rows, eligibleSceneIds, skipped) {
        const eligible = new Set((eligibleSceneIds || []).map((id) => String(id)));
        const skipMap = new Map(
            (skipped || []).map((s) => [String(s.scene_id), s.reason || "skipped"]),
        );
        return rows.map((row) => {
            const sid = String(row.scene_id);
            if (eligible.has(sid)) {
                return Object.assign({}, row, {
                    i2v: Object.assign({}, row.i2v, { status: "generating", attempts: 1 }),
                });
            }
            if (skipMap.has(sid) && (row.i2v.status === "pending" || row.i2v.status === "idle")) {
                return Object.assign({}, row, {
                    i2v: Object.assign({}, row.i2v, { status: "skipped", reason: skipMap.get(sid) }),
                });
            }
            return row;
        });
    }

    function startI2VRetry(rows, retrySceneIds, attemptNumber) {
        const retry = new Set((retrySceneIds || []).map((id) => String(id)));
        return rows.map((row) => {
            if (!retry.has(String(row.scene_id))) return row;
            return Object.assign({}, row, {
                i2v: Object.assign({}, row.i2v, {
                    status: "retrying",
                    attempts: typeof attemptNumber === "number" ? attemptNumber : (row.i2v.attempts || 0) + 1,
                    progress: 0,
                }),
            });
        });
    }

    function applyI2VProgress(rows, sceneId, payload) {
        const sid = String(sceneId);
        return rows.map((row) => {
            if (String(row.scene_id) !== sid) return row;
            const p = (payload && typeof payload.progress === "number") ? payload.progress : null;
            const next = Object.assign({}, row.i2v);
            if (p !== null && p > next.progress) next.progress = Math.max(0, Math.min(100, p));
            if (row.i2v.status === "generated" || row.i2v.status === "retried"
                || row.i2v.status === "fallback" || row.i2v.status === "skipped") return row;
            return Object.assign({}, row, { i2v: next });
        });
    }

    function applyI2VResult(rows, sceneId, settle) {
        const sid = String(sceneId);
        return rows.map((row) => {
            if (String(row.scene_id) !== sid) return row;
            const i2v = Object.assign({}, row.i2v, {
                status: settle.status,
                attempts: settle.attempts != null ? settle.attempts : row.i2v.attempts,
                video_path: settle.video_path != null ? settle.video_path : row.i2v.video_path,
                bytes: settle.bytes != null ? settle.bytes : row.i2v.bytes,
                reason: settle.reason != null ? settle.reason : row.i2v.reason,
                progress: settle.status === "generated" || settle.status === "retried" ? 100 : row.i2v.progress,
            });
            return Object.assign({}, row, { i2v });
        });
    }

    // ── Status → label/color mapping consumed by the renderer ──────────

    const IMAGE_STATUS_LABEL = {
        pending: "pending",
        generating: "generating…",
        generated: "generated",
        retrying: "retrying…",
        retried: "retried",
        fallback: "fallback (gradient)",
        skipped: "skipped",
    };
    const I2V_STATUS_LABEL = {
        pending: "pending",
        idle: "idle (image only)",
        generating: "generating…",
        generated: "generated",
        retrying: "retrying…",
        retried: "retried",
        fallback: "fallback → image",
        skipped: "skipped",
    };
    // CSS class hint mapping; the renderer can use these to color the
    // status pill consistently with other PR-17 status displays.
    const STATUS_CLASS = {
        pending: "muted",
        idle: "muted",
        generating: "info",
        retrying: "warn",
        generated: "ok",
        retried: "ok",
        fallback: "warn",
        skipped: "muted",
    };

    function imageStatusLabel(status) {
        return IMAGE_STATUS_LABEL[status] || status || "?";
    }
    function i2vStatusLabel(status) {
        return I2V_STATUS_LABEL[status] || status || "?";
    }
    function statusClass(status) {
        return STATUS_CLASS[status] || "muted";
    }

    // ── Aggregate counters consumed by the summary stats row ───────────

    function summarizeRows(rows) {
        const out = {
            total: rows.length,
            image_generated: 0,
            image_retried: 0,
            image_fallback: 0,
            image_skipped: 0,
            i2v_generated: 0,
            i2v_retried: 0,
            i2v_fallback: 0,
            i2v_skipped: 0,
            i2v_idle: 0,
        };
        for (const r of rows) {
            if (r.image.status === "generated") out.image_generated++;
            else if (r.image.status === "retried") out.image_retried++;
            else if (r.image.status === "fallback") out.image_fallback++;
            else if (r.image.status === "skipped") out.image_skipped++;
            if (r.i2v.status === "generated") out.i2v_generated++;
            else if (r.i2v.status === "retried") out.i2v_retried++;
            else if (r.i2v.status === "fallback") out.i2v_fallback++;
            else if (r.i2v.status === "skipped") out.i2v_skipped++;
            else if (r.i2v.status === "idle") out.i2v_idle++;
        }
        return out;
    }

    return {
        initRowsFromScenes,
        startImagePhase,
        startImageRetry,
        applyImageProgress,
        applyImageResult,
        startI2VPhase,
        startI2VRetry,
        applyI2VProgress,
        applyI2VResult,
        imageStatusLabel,
        i2vStatusLabel,
        statusClass,
        summarizeRows,
    };
});
