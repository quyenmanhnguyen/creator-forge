// PR-20D — pure state helpers for the "Batch Image + Video" panel.
//
// The panel mirrors the KCRACKER-style UX from autogrok-veo3: two
// independent tables, one per modality (image, video). Each row is
// keyed by `scene_id` so the user can re-run a single scene without
// touching others, and the video phase is decoupled from the image
// phase — clicking "Generate videos" is a separate, opt-in action.
//
// Two video modes are supported per the user's request:
//   - "i2v": pair with the row's image_path (must be settled first)
//   - "t2v": prompt-only, no image needed
//
// All helpers are pure / immutable (return new arrays/objects, never
// mutate inputs) so they're testable offline without DOM or IPC mocks.
// CommonJS export with a window-namespace fallback so the same file
// works for `require()` in Node tests and `<script>` in the renderer.

(function (root) {
    "use strict";

    /**
     * Build initial image-batch row state from a `scene_breakdown`
     * response. Empty / whitespace `image_prompt` → `status="skipped"`
     * with a reason; ineligible rows still appear in the table so the
     * user understands why a scene was excluded.
     *
     * @param {Array<Object>} scenes - scene_breakdown items.
     * @returns {Array<Object>} image-batch rows.
     */
    function initImageRowsFromScenes(scenes) {
        if (!Array.isArray(scenes)) return [];
        return scenes.map((s, i) => {
            const prompt = (s && typeof s.image_prompt === "string") ? s.image_prompt.trim() : "";
            const skipped = !prompt;
            return {
                order: i + 1,
                scene_id: s ? s.scene_id : null,
                title: (s && s.title) || "",
                duration_s: (s && typeof s.duration_s === "number") ? s.duration_s : 0,
                prompt,
                status: skipped ? "skipped" : "pending",
                progress: 0,
                attempts: 0,
                image_path: null,
                bytes: 0,
                reason: skipped ? "missing image_prompt" : null,
                url: null,
            };
        });
    }

    /**
     * Build initial video-batch row state. The video prompt comes
     * from `flow_video_prompt` (long-form scene_breakdown) or
     * `video_prompt` (short-form), whichever is present. For T2V mode
     * the prompt is enough; for I2V mode the row will need an image
     * path supplied later.
     *
     * @param {Array<Object>} scenes
     * @returns {Array<Object>} video-batch rows.
     */
    function initVideoRowsFromScenes(scenes) {
        if (!Array.isArray(scenes)) return [];
        return scenes.map((s, i) => {
            const fvp = (s && typeof s.flow_video_prompt === "string") ? s.flow_video_prompt.trim() : "";
            const vp = (s && typeof s.video_prompt === "string") ? s.video_prompt.trim() : "";
            const prompt = fvp || vp;
            const skipped = !prompt;
            return {
                order: i + 1,
                scene_id: s ? s.scene_id : null,
                title: (s && s.title) || "",
                duration_s: (s && typeof s.duration_s === "number") ? s.duration_s : 0,
                prompt,
                status: skipped ? "skipped" : "pending",
                progress: 0,
                attempts: 0,
                image_path: null, // populated from the image table for I2V mode
                video_path: null,
                bytes: 0,
                reason: skipped ? "missing video_prompt / flow_video_prompt" : null,
                url: null,
            };
        });
    }

    /**
     * Mark all eligible rows as `generating` ahead of dispatching the
     * batch IPC. Skipped rows stay skipped.
     */
    function startBatchPhase(rows) {
        return rows.map((row) => {
            if (row.status === "skipped") return row;
            return Object.assign({}, row, { status: "generating", progress: 0, attempts: (row.attempts || 0) + 1 });
        });
    }

    /**
     * Apply a `job:progress` payload to a row keyed by `scene_id`.
     * Progress is monotonically non-decreasing — late events with a
     * lower percentage are ignored. Settled rows
     * (generated/retried/fallback/skipped) ignore progress entirely
     * so a stray late event can't bump a terminal row's bar.
     */
    function applyBatchProgress(rows, sceneId, payload) {
        const sid = String(sceneId);
        return rows.map((row) => {
            if (String(row.scene_id) !== sid) return row;
            if (row.status === "generated" || row.status === "retried"
                || row.status === "fallback" || row.status === "skipped") return row;
            const p = (payload && typeof payload.progress === "number") ? payload.progress : null;
            if (p === null) return row;
            const next = Math.max(0, Math.min(100, p));
            if (next <= row.progress) return row;
            return Object.assign({}, row, { progress: next });
        });
    }

    /**
     * Settle a row with the final result for the image phase. The
     * row's `bytes` is honored if non-zero so the renderer can show
     * file size next to the thumbnail.
     */
    function applyBatchResult(rows, sceneId, result) {
        const sid = String(sceneId);
        return rows.map((row) => {
            if (String(row.scene_id) !== sid) return row;
            const status = (result && result.status) || "fallback";
            return Object.assign({}, row, {
                status,
                progress: status === "generated" || status === "retried" ? 100 : row.progress,
                attempts: (result && result.attempts != null) ? result.attempts : row.attempts,
                image_path: (result && result.image_path != null) ? result.image_path : row.image_path,
                video_path: (result && result.video_path != null) ? result.video_path : row.video_path,
                bytes: (result && typeof result.bytes === "number" && result.bytes > 0) ? result.bytes : row.bytes,
                reason: (result && result.reason != null) ? result.reason : row.reason,
            });
        });
    }

    /**
     * Pair settled image rows with video rows for I2V mode by
     * `scene_id`, copying `image_path` from the image row into the
     * video row's pairing slot. Video rows whose paired image hasn't
     * settled (or settled to fallback) are flagged as ineligible —
     * the renderer can disable the per-row Generate button until the
     * image is ready.
     *
     * @param {Array<Object>} videoRows
     * @param {Array<Object>} imageRows
     * @returns {Array<Object>} videoRows with `image_path` populated
     *                          where possible.
     */
    function pairImagePathsForI2V(videoRows, imageRows) {
        const byId = new Map();
        for (const ir of imageRows) {
            if (ir.image_path && (ir.status === "generated" || ir.status === "retried")) {
                byId.set(String(ir.scene_id), ir.image_path);
            }
        }
        return videoRows.map((row) => {
            const ip = byId.get(String(row.scene_id)) || null;
            if (ip === row.image_path) return row;
            return Object.assign({}, row, { image_path: ip });
        });
    }

    /**
     * Build the IPC payload for `image:generate`. Returns the prompts
     * + the scene_id ordering used so the renderer can map
     * `globalIdx` from progress events back to scene rows.
     */
    function planImageGenerate(rows) {
        const eligible = rows.filter((r) => r.status !== "skipped" && r.prompt);
        return {
            prompts: eligible.map((r) => r.prompt),
            sceneIds: eligible.map((r) => r.scene_id),
        };
    }

    /**
     * Build the IPC payload for I2V or T2V. In I2V mode, only rows
     * whose `image_path` is populated (paired by
     * `pairImagePathsForI2V`) are eligible — the rest are returned in
     * `skipped[]` with a reason so the renderer can mark them.
     *
     * @param {Array<Object>} rows
     * @param {"i2v"|"t2v"} mode
     */
    function planVideoGenerate(rows, mode) {
        const out = { mode, items: null, prompts: null, sceneIds: [], skipped: [] };
        if (mode === "t2v") {
            const eligible = rows.filter((r) => r.status !== "skipped" && r.prompt);
            const skipped = rows.filter((r) => r.status === "skipped" || !r.prompt);
            out.prompts = eligible.map((r) => r.prompt);
            out.sceneIds = eligible.map((r) => r.scene_id);
            out.skipped = skipped.map((r) => ({ scene_id: r.scene_id, reason: r.reason || "missing prompt" }));
            return out;
        }
        // I2V: need both image_path and prompt.
        const eligible = [];
        const skipped = [];
        for (const r of rows) {
            if (r.status === "skipped" || !r.prompt) {
                skipped.push({ scene_id: r.scene_id, reason: r.reason || "missing prompt" });
                continue;
            }
            if (!r.image_path) {
                skipped.push({ scene_id: r.scene_id, reason: "no image — generate or pick image first" });
                continue;
            }
            eligible.push(r);
        }
        out.items = eligible.map((r) => ({ imagePath: r.image_path, prompt: r.prompt }));
        out.sceneIds = eligible.map((r) => r.scene_id);
        out.skipped = skipped;
        return out;
    }

    /**
     * Map an IPC batch response shape (success/failures and
     * savedFiles) into per-scene results that
     * `applyBatchResult` can consume. Used after both `image:generate`
     * and `video:generate` / `i2v:generate` resolve.
     *
     * Image responses: `{success, results:[{prompt, savedFiles:[]}, ...]}`.
     * Video responses: `{success, results:[{prompt, success, videoPath, error}, ...]}`.
     * The shapes differ slightly so we accept either via a `kind`
     * argument and route accordingly.
     *
     * @param {Object} resp - IPC response
     * @param {Array} sceneIds - scene_id ordering used in the request
     * @param {"image"|"video"} kind
     */
    function mapBatchResponse(resp, sceneIds, kind) {
        const out = [];
        if (!resp || !Array.isArray(resp.results)) {
            for (const sid of sceneIds) {
                out.push({ scene_id: sid, status: "fallback", reason: (resp && resp.error) || "no results" });
            }
            return out;
        }
        for (let i = 0; i < sceneIds.length; i++) {
            const sid = sceneIds[i];
            const r = resp.results[i];
            if (!r) {
                out.push({ scene_id: sid, status: "fallback", reason: "no result for scene" });
                continue;
            }
            if (kind === "image") {
                // ImageService.generateBatch returns
                //   { success, savedFiles: string[], outputPath, ... }
                // — `savedFiles` is an array of absolute paths. Older
                // shapes used `[{ path | savedPath, bytes }, ...]`,
                // so accept both for forward/backward compatibility.
                let imagePath = null;
                let bytes = 0;
                const saved = Array.isArray(r.savedFiles) && r.savedFiles.length ? r.savedFiles[0] : null;
                if (typeof saved === "string") {
                    imagePath = saved;
                } else if (saved && typeof saved === "object") {
                    imagePath = saved.path || saved.savedPath || null;
                    bytes = typeof saved.bytes === "number" ? saved.bytes : 0;
                } else if (typeof r.outputPath === "string" && r.outputPath) {
                    imagePath = r.outputPath;
                }
                if (imagePath) {
                    out.push({ scene_id: sid, status: "generated", image_path: imagePath, bytes });
                } else {
                    out.push({ scene_id: sid, status: "fallback", reason: r.error || "no usable image" });
                }
            } else {
                if (r.success && (r.videoPath || r.savedFile)) {
                    out.push({
                        scene_id: sid,
                        status: "generated",
                        video_path: r.videoPath || r.savedFile,
                        bytes: typeof r.bytes === "number" ? r.bytes : 0,
                    });
                } else {
                    out.push({ scene_id: sid, status: "fallback", reason: r.error || "video generation failed" });
                }
            }
        }
        return out;
    }

    /**
     * Aggregate counters for the panel header. Returns counts of each
     * status so the UI can show "5 generated, 1 fallback, 2 skipped"
     * style summaries without iterating the rows in the renderer.
     */
    function summarizeRows(rows) {
        const out = { total: rows.length, pending: 0, generating: 0, generated: 0, retried: 0, fallback: 0, skipped: 0 };
        for (const r of rows) {
            const s = r.status || "pending";
            if (out[s] != null) out[s] += 1;
        }
        return out;
    }

    /** Human-friendly status label. */
    function statusLabel(status) {
        switch (status) {
            case "pending":    return "pending";
            case "generating": return "generating…";
            case "generated":  return "generated";
            case "retried":    return "retried";
            case "fallback":   return "failed";
            case "skipped":    return "skipped";
            default:           return status || "?";
        }
    }

    /** Pill color class for the status. */
    function statusClass(status) {
        switch (status) {
            case "generated":  return "ok";
            case "retried":    return "ok";
            case "generating": return "info";
            case "fallback":   return "warn";
            case "skipped":    return "muted";
            default:           return "muted";
        }
    }

    const api = {
        initImageRowsFromScenes,
        initVideoRowsFromScenes,
        startBatchPhase,
        applyBatchProgress,
        applyBatchResult,
        pairImagePathsForI2V,
        planImageGenerate,
        planVideoGenerate,
        mapBatchResponse,
        summarizeRows,
        statusLabel,
        statusClass,
    };

    if (typeof module === "object" && module.exports) module.exports = api;
    if (root && typeof root === "object") root.StoryboardBatchHelpers = api;
})(typeof window !== "undefined" ? window : globalThis);
