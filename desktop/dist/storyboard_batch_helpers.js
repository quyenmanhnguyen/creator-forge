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
    function initImageRowsFromScenes(scenes, opts) {
        if (!Array.isArray(scenes)) return [];
        // PR-23: optional `imagesPerScene` expands every scene into N
        // independent variant rows. Each row carries a unique `row_id`
        // (`scene_id#variant_idx`) so progress / result events can target
        // a single variant without bleeding across siblings; `scene_id`
        // is kept for I2V pairing. Default 1 = legacy behaviour.
        //
        // PR-26: when the scene carries an `image_prompts` array
        // (LLM-expanded variants from /producer/scene_breakdown with
        // images_per_scene > 1), prefer entry `v` over the singular
        // `image_prompt`. The legacy field still wins when the array is
        // shorter than the number of variants requested by the UI, so
        // the fallback never produces a phantom empty prompt.
        const variants = Math.max(1, Math.floor(Number((opts && opts.imagesPerScene) || 1)) || 1);
        const out = [];
        let order = 1;
        scenes.forEach((s) => {
            const fallbackPrompt = (s && typeof s.image_prompt === "string") ? s.image_prompt.trim() : "";
            const variantList = Array.isArray(s && s.image_prompts) ? s.image_prompts : [];
            const sceneId = s ? s.scene_id : null;
            for (let v = 0; v < variants; v += 1) {
                const variantPrompt = (typeof variantList[v] === "string") ? variantList[v].trim() : "";
                const prompt = variantPrompt || fallbackPrompt;
                const skipped = !prompt;
                out.push({
                    order: order++,
                    scene_id: sceneId,
                    variant_idx: v,
                    row_id: `${sceneId == null ? "scene" : sceneId}#${v}`,
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
                });
            }
        });
        return out;
    }

    /**
     * Build initial video-batch row state. The video prompt comes
     * from `video_prompt` (preferred — the i2v alias used everywhere
     * else in the codebase) or `flow_video_prompt` (long-form
     * scene_breakdown alternative), whichever is present. The
     * precedence matches `StoryboardBridge.animateScenes`,
     * `storyboard_compose_table_helpers.initRowsFromScenes`, and
     * `storyboard_video_compose_helpers.planI2VJobsFromScenesAndImages`
     * so a scene that carries both fields lands the same prompt in
     * every panel. For T2V mode the prompt is enough; for I2V mode
     * the row will need an image path supplied later.
     *
     * @param {Array<Object>} scenes
     * @returns {Array<Object>} video-batch rows.
     */
    function initVideoRowsFromScenes(scenes, opts) {
        if (!Array.isArray(scenes)) return [];
        const variants = Math.max(1, Math.floor(Number((opts && opts.videosPerScene) || 1)) || 1);
        const out = [];
        let order = 1;
        scenes.forEach((s) => {
            const vp = (s && typeof s.video_prompt === "string") ? s.video_prompt.trim() : "";
            const fvp = (s && typeof s.flow_video_prompt === "string") ? s.flow_video_prompt.trim() : "";
            const prompt = vp || fvp;
            const skipped = !prompt;
            const sceneId = s ? s.scene_id : null;
            for (let v = 0; v < variants; v += 1) {
                out.push({
                    order: order++,
                    scene_id: sceneId,
                    variant_idx: v,
                    row_id: `${sceneId == null ? "scene" : sceneId}#${v}`,
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
                });
            }
        });
        return out;
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
    function applyBatchProgress(rows, key, payload) {
        // PR-23: prefer matching by `row_id` so progress events for
        // variant N do not bleed into variant N±1 of the same scene.
        // Falls back to `scene_id` so legacy callers / tests keep
        // working when the table was built with one row per scene
        // (and so "broadcast a scene-level event to all its variants"
        // — used by the renderer's row_id-first dispatch — still works
        // when callers pass just the scene id).
        const target = String(key);
        const anyRowIdMatch = rows.some((row) => row.row_id != null && String(row.row_id) === target);
        return rows.map((row) => {
            const matchById = row.row_id != null && String(row.row_id) === target;
            const matchByScene = !anyRowIdMatch && String(row.scene_id) === target;
            if (!matchById && !matchByScene) return row;
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
    function applyBatchResult(rows, key, result) {
        // PR-23: same row_id-vs-scene_id matching contract as
        // applyBatchProgress — when the table has variant rows, hit
        // exactly the row that was settled. Falls back to scene_id
        // when no row matches by row_id (legacy / scene-level
        // broadcasts).
        const target = String(key);
        const anyRowIdMatch = rows.some((row) => row.row_id != null && String(row.row_id) === target);
        return rows.map((row) => {
            const matchById = row.row_id != null && String(row.row_id) === target;
            const matchByScene = !anyRowIdMatch && String(row.scene_id) === target;
            if (!matchById && !matchByScene) return row;
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
        // PR-23: with multiple image variants per scene, prefer the
        // image with the lowest variant_idx that has settled. Falls
        // back to the first settled image we encounter when no
        // variant_idx is set (legacy 1-row-per-scene tables).
        const bestByScene = new Map();
        for (const ir of imageRows) {
            if (!ir.image_path) continue;
            if (ir.status !== "generated" && ir.status !== "retried") continue;
            const key = String(ir.scene_id);
            const cur = bestByScene.get(key);
            const v = (typeof ir.variant_idx === "number") ? ir.variant_idx : 0;
            if (!cur || v < cur.v) {
                bestByScene.set(key, { v, image_path: ir.image_path });
            }
        }
        return videoRows.map((row) => {
            const entry = bestByScene.get(String(row.scene_id));
            const ip = entry ? entry.image_path : null;
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
            // PR-23: row_ids[] runs in lock-step with prompts[] so the
            // renderer can map a `globalIdx` from a progress event back
            // to the exact variant row, not just the scene.
            rowIds: eligible.map((r) => (r.row_id != null ? r.row_id : r.scene_id)),
        };
    }

    /**
     * PR-28 — resolve the list of reference image paths to use for a
     * row. Per-row overrides trump the global list. Returns a new
     * de-duplicated string[] (may be empty). Never mutates its
     * inputs; safe to call on every render.
     *
     * @param {Object}                       row           batch row (must have ``row_id``)
     * @param {Map<string,string[]>|Object}  rowRefMap     per-row overrides keyed by row_id
     * @param {string[]}                    globalRefs    global default list (applies when no override)
     */
    function resolveRefsForRow(row, rowRefMap, globalRefs) {
        if (!row || row.row_id == null) return [];
        const key = String(row.row_id);
        const override = _lookupRefs(rowRefMap, key);
        const chosen = (override && override.length) ? override : (Array.isArray(globalRefs) ? globalRefs : []);
        return _dedupeRefs(chosen);
    }

    function _lookupRefs(refMap, key) {
        if (!refMap) return null;
        if (typeof refMap.get === "function") {
            const v = refMap.get(key);
            return Array.isArray(v) ? v : null;
        }
        if (typeof refMap === "object") {
            const v = refMap[key];
            return Array.isArray(v) ? v : null;
        }
        return null;
    }

    function _dedupeRefs(list) {
        const out = [];
        const seen = new Set();
        for (const p of (list || [])) {
            if (typeof p !== "string") continue;
            const trimmed = p.trim();
            if (!trimmed || seen.has(trimmed)) continue;
            seen.add(trimmed);
            out.push(trimmed);
        }
        return out;
    }

    /**
     * PR-28 — split rows into two disjoint buckets by whether they
     * resolve to ≥1 reference image. Rows with no refs take the
     * legacy `image:generate` path; rows with refs take the
     * `refimg:generate` path. Skipped / empty-prompt rows stay in
     * their existing bucket so the renderer can still mark them as
     * skipped without hitting the IPC.
     *
     * @param {Array<Object>}                 rows
     * @param {Object}                        opts
     * @param {Map<string,string[]>|Object}   opts.rowRefMap
     * @param {string[]}                      opts.globalRefs
     */
    function partitionRowsByRefs(rows, opts) {
        const o = opts || {};
        const withRefs = [];
        const withoutRefs = [];
        for (const r of (Array.isArray(rows) ? rows : [])) {
            const resolved = resolveRefsForRow(r, o.rowRefMap, o.globalRefs);
            if (resolved.length > 0) withRefs.push(r); else withoutRefs.push(r);
        }
        return { withRefs, withoutRefs };
    }

    /**
     * PR-28 — build the IPC payload for ``refimg:generate``. Runs in
     * lock-step with ``planImageGenerate``: returns ``items`` (shape
     * matching ``RefImageService.generateBatch``: ``{ prompt,
     * refImagePaths }``), ``sceneIds``, ``rowIds`` so
     * ``mapBatchResponse`` can map ``globalIdx`` back to the exact
     * variant row. Rows without a prompt or marked skipped are
     * excluded; rows without any resolved refs are excluded too (the
     * caller is expected to call ``planImageGenerate`` for those
     * separately).
     */
    function planRefImageGenerate(rows, opts) {
        const o = opts || {};
        const items = [];
        const sceneIds = [];
        const rowIds = [];
        for (const r of (Array.isArray(rows) ? rows : [])) {
            if (!r || r.status === "skipped" || !r.prompt) continue;
            const refs = resolveRefsForRow(r, o.rowRefMap, o.globalRefs);
            if (!refs.length) continue;
            items.push({ prompt: r.prompt, refImagePaths: refs });
            sceneIds.push(r.scene_id);
            rowIds.push(r.row_id != null ? r.row_id : r.scene_id);
        }
        return { items, sceneIds, rowIds };
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
        const out = { mode, items: null, prompts: null, sceneIds: [], rowIds: [], skipped: [] };
        if (mode === "t2v") {
            const eligible = rows.filter((r) => r.status !== "skipped" && r.prompt);
            const skipped = rows.filter((r) => r.status === "skipped" || !r.prompt);
            out.prompts = eligible.map((r) => r.prompt);
            out.sceneIds = eligible.map((r) => r.scene_id);
            out.rowIds = eligible.map((r) => (r.row_id != null ? r.row_id : r.scene_id));
            out.skipped = skipped.map((r) => ({
                scene_id: r.scene_id,
                row_id: r.row_id != null ? r.row_id : r.scene_id,
                reason: r.reason || "missing prompt",
            }));
            return out;
        }
        // I2V: need both image_path and prompt.
        const eligible = [];
        const skipped = [];
        for (const r of rows) {
            if (r.status === "skipped" || !r.prompt) {
                skipped.push({
                    scene_id: r.scene_id,
                    row_id: r.row_id != null ? r.row_id : r.scene_id,
                    reason: r.reason || "missing prompt",
                });
                continue;
            }
            if (!r.image_path) {
                skipped.push({
                    scene_id: r.scene_id,
                    row_id: r.row_id != null ? r.row_id : r.scene_id,
                    reason: "no image — generate or pick image first",
                });
                continue;
            }
            eligible.push(r);
        }
        out.items = eligible.map((r) => ({ imagePath: r.image_path, prompt: r.prompt }));
        out.sceneIds = eligible.map((r) => r.scene_id);
        out.rowIds = eligible.map((r) => (r.row_id != null ? r.row_id : r.scene_id));
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
     * **Synchronous** variant — kept for back-compat. The caller gets
     * every `kind === "video"` row marked `generated` as long as the
     * IPC said `success: true`, which is the looser behavior that
     * pre-PR-20E let tiny/invalid mp4s through. For new code, prefer
     * `mapBatchResponseAsync` with a validator.
     *
     * @param {Object} resp - IPC response
     * @param {Array} sceneIds - scene_id ordering used in the request
     * @param {"image"|"video"} kind
     */
    function mapBatchResponse(resp, sceneIds, kind, rowIds) {
        const out = [];
        const ids = Array.isArray(sceneIds) ? sceneIds : [];
        const rids = Array.isArray(rowIds) ? rowIds : null;
        const rowIdAt = (i) => (rids && rids[i] != null ? rids[i] : ids[i]);
        if (!resp || !Array.isArray(resp.results)) {
            for (let i = 0; i < ids.length; i += 1) {
                out.push({
                    scene_id: ids[i],
                    row_id: rowIdAt(i),
                    status: "fallback",
                    reason: (resp && resp.error) || "no results",
                });
            }
            return out;
        }
        for (let i = 0; i < ids.length; i++) {
            const sid = ids[i];
            const rid = rowIdAt(i);
            const r = resp.results[i];
            if (!r) {
                out.push({ scene_id: sid, row_id: rid, status: "fallback", reason: "no result for scene" });
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
                    out.push({ scene_id: sid, row_id: rid, status: "generated", image_path: imagePath, bytes });
                } else {
                    // PR-29: when the IPC didn't surface a specific
                    // `error` (common for moderated / blank Grok
                    // responses where the chat stream just returns no
                    // image bytes), give the user something concrete to
                    // act on instead of the unhelpful "no usable image".
                    const reason = (typeof r.error === "string" && r.error.trim())
                        ? r.error
                        : "Grok returned no images — possibly moderated, rate-limited, or session expired (check Login panel)";
                    out.push({ scene_id: sid, row_id: rid, status: "fallback", reason });
                }
            } else {
                if (r.success && (r.videoPath || r.savedFile)) {
                    out.push({
                        scene_id: sid,
                        row_id: rid,
                        status: "generated",
                        video_path: r.videoPath || r.savedFile,
                        bytes: typeof r.bytes === "number" ? r.bytes : 0,
                    });
                } else {
                    // PR-29: same rationale as the image branch — surface
                    // an actionable hint when the service didn't pass an
                    // explicit error string. Most silent failures are
                    // session / rate-limit / Veo-moderation, all of
                    // which the user can recover from manually.
                    const reason = (typeof r.error === "string" && r.error.trim())
                        ? r.error
                        : "Video generation produced no output — possibly moderated, rate-limited, or session expired (check Login panel)";
                    out.push({ scene_id: sid, row_id: rid, status: "fallback", reason });
                }
            }
        }
        return out;
    }

    /**
     * PR-20E — async counterpart that runs every successful video row
     * through an injected ffprobe-backed validator. Failure modes:
     *
     *   - missing file / truncated download / no video stream → `fallback`
     *     with the validator's `reason` copied in.
     *   - validator throws                                   → `fallback`
     *     with `"validator threw: <msg>"`.
     *   - validator returns `{ ok:true, ffprobeAvailable:false }` → row
     *     is marked `generated` with a `size_only: true` hint (size
     *     floor already passed at the service layer); renderer can show
     *     a tooltip.
     *
     * Image rows are unchanged — we don't ffprobe images.
     *
     * @param {Object} resp
     * @param {Array} sceneIds
     * @param {"image"|"video"} kind
     * @param {{
     *   validateFn?: (filePath:string)=>Promise<{ok:boolean,reason?:string,size?:number,ffprobeAvailable?:boolean}>,
     * }} [opts]
     */
    async function mapBatchResponseAsync(resp, sceneIds, kind, opts) {
        const o = opts || {};
        const validateFn = (kind === "video" && typeof o.validateFn === "function") ? o.validateFn : null;
        const rowIds = Array.isArray(o.rowIds) ? o.rowIds : null;
        // When no validator is supplied, behavior matches the sync
        // variant — callers that don't care about ffprobe keep working.
        if (!validateFn) return mapBatchResponse(resp, sceneIds, kind, rowIds);
        const base = mapBatchResponse(resp, sceneIds, kind, rowIds);
        const out = [];
        for (const row of base) {
            if (row.status !== "generated" || !row.video_path) {
                out.push(row);
                continue;
            }
            let check = null;
            try {
                check = await validateFn(row.video_path);
            } catch (err) {
                out.push(Object.assign({}, row, {
                    status: "fallback",
                    reason: `validator threw: ${(err && err.message) || err}`,
                }));
                continue;
            }
            if (!check || check.ok !== true) {
                out.push(Object.assign({}, row, {
                    status: "fallback",
                    reason: (check && typeof check.reason === "string" && check.reason) || "video failed ffprobe validation",
                }));
                continue;
            }
            const next = Object.assign({}, row);
            if (typeof check.size === "number" && check.size > 0) next.bytes = check.size;
            if (check.ffprobeAvailable === false) next.size_only = true;
            out.push(next);
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

    /**
     * PR-24 — count variants per scene_id so the renderer can render
     * "scene N · variant K/M" labels. Returns a Map keyed by stringified
     * scene_id (or "" when scene_id is missing) → total variant count.
     * Pure, defensive against null rows.
     */
    function buildVariantTotals(rows) {
        const map = new Map();
        if (!Array.isArray(rows)) return map;
        for (const r of rows) {
            const k = (r && r.scene_id != null) ? String(r.scene_id) : "";
            map.set(k, (map.get(k) || 0) + 1);
        }
        return map;
    }

    /**
     * PR-27 — bulk selection + inline edit + delete + re-roll helpers.
     *
     * The renderer maintains a Set<string> of selected ``row_id``s
     * per kind (image / video). All selection helpers are pure and
     * return new Sets so React-style "render from state" stays
     * trivial to reason about.
     */

    /** Return a new Set with ``row_id`` toggled. */
    function toggleRowSelection(selected, row_id) {
        const out = new Set(selected || []);
        const key = row_id == null ? "" : String(row_id);
        if (!key) return out;
        if (out.has(key)) out.delete(key); else out.add(key);
        return out;
    }

    /** Build a Set of every row_id in ``rows`` (skipped rows included). */
    function selectAllRowIds(rows) {
        const out = new Set();
        if (!Array.isArray(rows)) return out;
        for (const r of rows) {
            if (r && r.row_id != null) out.add(String(r.row_id));
        }
        return out;
    }

    /** Filter ``selected`` so it only contains row_ids present in ``rows``. */
    function reconcileSelection(selected, rows) {
        const valid = selectAllRowIds(rows);
        const out = new Set();
        for (const k of (selected || [])) {
            if (valid.has(String(k))) out.add(String(k));
        }
        return out;
    }

    /**
     * Settled rows (``generated`` / ``retried``) keep their files on
     * disk — editing the prompt for one of them would do nothing
     * useful since the asset is already produced. Skipped rows can be
     * edited (so the user can fix the prompt and re-fill). In-flight
     * rows can't be edited because the IPC has already taken the
     * prompt.
     */
    function canEditRow(row) {
        if (!row) return false;
        const s = row.status || "pending";
        return s === "pending" || s === "skipped" || s === "fallback";
    }

    /**
     * Allow delete on every status — the renderer will still warn the
     * user via a confirm dialog before nuking generated assets.
     * Returning ``true`` for ``generating`` is a soft cancel: the
     * row vanishes from the table and any late progress / result
     * events for that row_id silently no-op (applyBatchProgress /
     * applyBatchResult key by row_id, so a missing row simply skips).
     */
    function canDeleteRow(row) {
        return Boolean(row);
    }

    /**
     * Drop every row whose row_id is in ``removeIds`` (Set or any
     * iterable). Returns a new array; the input is never mutated. The
     * surviving rows keep their original ``order`` / ``variant_idx``
     * so the table doesn't visually re-shuffle after a delete — only
     * the deleted rows disappear.
     */
    function removeRows(rows, removeIds) {
        if (!Array.isArray(rows)) return [];
        const drop = new Set();
        for (const k of (removeIds || [])) drop.add(String(k));
        if (!drop.size) return rows.slice();
        return rows.filter((r) => {
            const key = r && r.row_id != null ? String(r.row_id) : "";
            return !drop.has(key);
        });
    }

    /**
     * Replace the prompt text of a single row. Pure — returns a new
     * array. ``status === "skipped"`` and ``status === "fallback"``
     * rows are promoted to ``pending`` once a non-empty prompt
     * arrives so the user can re-fill them with the new text;
     * conversely a prompt cleared back to empty falls back to
     * ``skipped``.
     */
    function updatePromptForRow(rows, row_id, prompt) {
        if (!Array.isArray(rows)) return [];
        const target = String(row_id);
        const next = (typeof prompt === "string") ? prompt.trim() : "";
        return rows.map((r) => {
            if (!r || String(r.row_id) !== target) return r;
            // Settled rows ignore prompt edits — once a file is on
            // disk, editing the prompt would be misleading. Generating
            // rows ignore too because the IPC already picked up the
            // value. Both states are protected at the UI level via
            // canEditRow, but enforce here as well so a programmatic
            // caller can't sneak past it.
            if (!canEditRow(r)) return r;
            const isReeditableStatus = r.status === "skipped" || r.status === "fallback";
            return Object.assign({}, r, {
                prompt: next,
                status: next ? (isReeditableStatus ? "pending" : r.status) : "skipped",
                reason: next ? null : (r.reason || "missing image_prompt"),
            });
        });
    }

    /**
     * Re-roll: replace the prompts for every row matching ``scene_id``
     * with entries from ``newPrompts``. Slots beyond the length of
     * ``newPrompts`` keep their existing prompt (degraded
     * gracefully when the LLM returns fewer prompts than variants).
     * Used after ``storyboard.variantPrompts`` resolves — keeps
     * row_id, status, attempts intact so progress mid-batch isn't
     * obliterated.
     */
    function applyVariantPrompts(rows, scene_id, newPrompts) {
        if (!Array.isArray(rows)) return [];
        if (!Array.isArray(newPrompts) || !newPrompts.length) return rows.slice();
        const target = String(scene_id);
        // Walk variants in variant_idx order so ``newPrompts[v]`` lands
        // on variant v deterministically.
        const order = rows
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => r && String(r.scene_id) === target)
            .sort((a, b) => {
                const ai = (typeof a.r.variant_idx === "number") ? a.r.variant_idx : 0;
                const bi = (typeof b.r.variant_idx === "number") ? b.r.variant_idx : 0;
                return ai - bi;
            });
        const out = rows.slice();
        for (let v = 0; v < order.length && v < newPrompts.length; v += 1) {
            const idx = order[v].i;
            const row = out[idx];
            if (!canEditRow(row)) continue; // don't trample settled / in-flight rows
            const next = (typeof newPrompts[v] === "string") ? newPrompts[v].trim() : "";
            if (!next) continue;
            const isReeditableStatus = row.status === "skipped" || row.status === "fallback";
            out[idx] = Object.assign({}, row, {
                prompt: next,
                status: isReeditableStatus ? "pending" : row.status,
                reason: null,
            });
        }
        return out;
    }

    /**
     * PR-29 — filter ``rows`` down to those whose ``row_id`` is in
     * ``selected`` (Set<string> or any iterable). Order is preserved
     * from the input. Used by ``sbbGenerateImages`` /
     * ``sbbGenerateVideos`` to scope a Generate run to the user's
     * checkbox selection (and by the per-row Retry handler with a
     * synthetic single-id set). Pure — never mutates inputs.
     */
    function filterRowsBySelection(rows, selected) {
        if (!Array.isArray(rows)) return [];
        const sel = new Set();
        for (const k of (selected || [])) sel.add(String(k));
        if (!sel.size) return [];
        return rows.filter((r) => {
            if (!r || r.row_id == null) return false;
            return sel.has(String(r.row_id));
        });
    }

    /**
     * Summary of a selection — used by the bulk-action toolbar to
     * decide which buttons to enable. ``editable`` / ``deletable`` are
     * counts of rows in the selection that pass canEditRow /
     * canDeleteRow respectively. ``scenes`` is the set of distinct
     * scene_ids touched, useful for "Re-roll variants for the N scenes
     * you selected".
     */
    function summarizeSelection(rows, selected) {
        const sel = new Set();
        for (const k of (selected || [])) sel.add(String(k));
        const byId = new Map();
        for (const r of (rows || [])) {
            if (r && r.row_id != null) byId.set(String(r.row_id), r);
        }
        let editable = 0;
        let deletable = 0;
        let inFlight = 0;
        const scenes = new Set();
        for (const k of sel) {
            const r = byId.get(k);
            if (!r) continue;
            if (canEditRow(r)) editable += 1;
            if (canDeleteRow(r)) deletable += 1;
            if (r.status === "generating") inFlight += 1;
            if (r.scene_id != null) scenes.add(String(r.scene_id));
        }
        return {
            total: sel.size,
            editable,
            deletable,
            inFlight,
            scenes,
        };
    }

    /**
     * PR-24 — format the "scene N · variant K/M" label segment for a
     * row. When the scene only has a single variant (legacy 1-row-per-
     * scene tables) the variant tag is omitted so older tables keep
     * their familiar layout.
     */
    function formatVariantLabel(row, variantTotals) {
        const sceneId = row && row.scene_id != null ? row.scene_id : null;
        const sceneLabel = `scene ${sceneId != null ? sceneId : "?"}`;
        const total = (variantTotals && variantTotals.get && variantTotals.get(sceneId != null ? String(sceneId) : "")) || 1;
        if (total <= 1) return sceneLabel;
        const idx = (row && typeof row.variant_idx === "number") ? row.variant_idx : 0;
        return `${sceneLabel} · variant ${idx + 1}/${total}`;
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
        mapBatchResponseAsync,
        summarizeRows,
        statusLabel,
        statusClass,
        buildVariantTotals,
        formatVariantLabel,
        // PR-27 — bulk selection / inline edit / delete / re-roll.
        toggleRowSelection,
        selectAllRowIds,
        reconcileSelection,
        canEditRow,
        canDeleteRow,
        removeRows,
        updatePromptForRow,
        applyVariantPrompts,
        summarizeSelection,
        // PR-29 — selection-aware Generate + per-row Retry.
        filterRowsBySelection,
        // PR-28 — reference image upload (global + per-row override).
        resolveRefsForRow,
        partitionRowsByRefs,
        planRefImageGenerate,
    };

    if (typeof module === "object" && module.exports) module.exports = api;
    if (root && typeof root === "object") root.StoryboardBatchHelpers = api;
})(typeof window !== "undefined" ? window : globalThis);
