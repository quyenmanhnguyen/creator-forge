/**
 * storyboard_video_compose_helpers.js — pure helpers for the renderer's
 * "Compose with AutoGrok" panel I2V branch (PR-20B).
 *
 * Counterpart of ``storyboard_compose_helpers.js`` (image flow). Loaded
 * as a plain ``<script>`` before ``creator-forge.js`` so the renderer
 * has a small, testable module without a bundler. Also
 * ``module.exports``-friendly so ``desktop/tests/*.js`` can require it
 * directly under Node (no jsdom needed).
 *
 * The helpers mirror the picking / asset-building logic that
 * ``StoryboardBridge#composeWithVideoScenes`` runs in the main process.
 * As with the image helpers we deliberately don't call the bridge from
 * the renderer because the dist UI has no bundler — the renderer
 * issues three IPCs (``image:generate`` then ``i2v:generate`` then
 * ``producer:composeShort``) and uses ``electronAPI.statBytes`` for
 * file-size checks.
 *
 * I2V result shape (from ``I2VService.generateBatch`` →
 * ``ipcMain.handle('i2v:generate')``):
 *
 *   {
 *     success: boolean,
 *     results: [
 *       { globalIdx, imagePath, prompt, savedFile, outputPath,
 *         success, error, title, videoId, ... },
 *       ...
 *     ],
 *   }
 *
 * Unlike ``image:generate`` (one prompt → up to N saved files), I2V
 * returns at most one ``savedFile`` per item — that's the local mp4
 * the bridge then pins to a timeline window.
 */
(function (root, factory) {
    'use strict';
    const mod = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = mod;
    } else if (root) {
        root.StoryboardVideoComposeHelpers = mod;
    }
}(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Sanity threshold below which the I2V output is almost certainly a
    // truncated download or empty stub. Real Grok I2V mp4s are
    // multi-hundred-KB to multi-MB; 10 KB is a generous floor that
    // catches zero-byte/garbage downloads without false-flagging an
    // unusually short clip.
    const MIN_USABLE_VIDEO_BYTES = 10000;

    /**
     * Build the i2v jobs[] for a list of scenes, paired against the
     * resolved sceneAssets[] from the image flow.
     *
     * Only scenes that already have a usable hero image (matched by
     * ``scene_id`` against ``sceneAssets``) AND a non-empty video
     * prompt are eligible — everything else is reported in ``skipped[]``
     * so the orchestrator can mark it ``fallback`` (the composer will
     * keep the scene's image clip per :func:`make_short`'s layered
     * fallback chain).
     *
     * Accepts both ``video_prompt`` and ``flow_video_prompt`` so the
     * scene_breakdown response (which carries ``flow_video_prompt``)
     * drops in directly.
     *
     * @param {Array<{scene_id?:number, video_prompt?:string, flow_video_prompt?:string, duration_s?:number}>} scenes
     * @param {Array<{image_path:string, start_s:number, duration_s:number, scene_id?:number}>} sceneAssets
     * @returns {{
     *   jobs: Array<{scene_id?:number, imagePath:string, prompt:string, start_s:number, duration_s:number}>,
     *   skipped: Array<{scene_id?:number, reason:string}>,
     * }}
     */
    function planI2VJobsFromScenesAndAssets(scenes, sceneAssets) {
        const list = Array.isArray(scenes) ? scenes : [];
        const assets = Array.isArray(sceneAssets) ? sceneAssets : [];
        const jobs = [];
        const skipped = [];

        // Index sceneAssets by scene_id for O(1) lookup. Ties (same
        // scene_id more than once) keep the first entry — matches the
        // image-flow contract where each scene owns one window.
        const assetById = new Map();
        for (const a of assets) {
            if (a && typeof a.scene_id !== 'undefined' && !assetById.has(a.scene_id)) {
                assetById.set(a.scene_id, a);
            }
        }

        for (let i = 0; i < list.length; i++) {
            const s = list[i] || {};
            const prompt = (
                typeof s.video_prompt === 'string' && s.video_prompt.trim()
            ) ? s.video_prompt.trim()
                : (typeof s.flow_video_prompt === 'string' ? s.flow_video_prompt.trim() : '');
            if (!prompt) {
                skipped.push({ scene_id: s.scene_id, reason: 'missing video_prompt / flow_video_prompt' });
                continue;
            }
            const asset = assetById.get(s.scene_id) || null;
            if (!asset || typeof asset.image_path !== 'string' || !asset.image_path.trim()) {
                skipped.push({ scene_id: s.scene_id, reason: 'no usable hero image (image flow skipped or fallback)' });
                continue;
            }
            const duration = Number(asset.duration_s);
            if (!(duration > 0)) {
                skipped.push({ scene_id: s.scene_id, reason: 'invalid duration_s on hero image asset' });
                continue;
            }
            const start = Number(asset.start_s);
            jobs.push({
                scene_id: s.scene_id,
                imagePath: asset.image_path,
                prompt,
                start_s: Number.isFinite(start) ? start : 0.0,
                duration_s: duration,
            });
        }
        return { jobs, skipped };
    }

    /**
     * Group an ``i2v:generate`` raw results array into a
     * ``Map<jobIdx, result>`` using the ``globalIdx`` / ``localIdx``
     * convention from ``I2VService.generateBatch``. At most one entry
     * per job index — I2V never produces multiple mp4s per item.
     *
     * @param {{ success?:boolean, results?:Array<object> }} i2vGenerateResp
     * @param {number} jobCount Length of the items[] passed to i2v:generate.
     * @returns {Map<number,object>}
     */
    function groupI2VResultsByJobIndex(i2vGenerateResp, jobCount) {
        const map = new Map();
        const results = i2vGenerateResp && Array.isArray(i2vGenerateResp.results)
            ? i2vGenerateResp.results
            : [];
        for (const r of results) {
            const idx = (typeof r.globalIdx === 'number')
                ? r.globalIdx
                : (typeof r.localIdx === 'number' ? r.localIdx : null);
            if (idx == null || idx < 0 || idx >= jobCount) continue;
            if (!map.has(idx)) map.set(idx, r);
        }
        return map;
    }

    /**
     * Pick the savedFile from a single I2V result if it's usable on
     * disk. Returns ``{ chosen, reason }`` mirroring
     * :func:`pickFirstUsableSavedFile` from the image helpers.
     *
     * Validation:
     *   1. ``result.savedFile`` must be a non-empty string AND
     *      ``statBytesFn(savedFile)`` must report ``size >= minBytes``
     *      (legacy contract — kept for back-compat).
     *   2. PR-20E: when an optional ``opts.validateFn(filePath, minBytes)``
     *      is provided, the result is also passed through ffprobe-backed
     *      validation; ``{ ok:false }`` from validateFn maps to
     *      ``chosen:null`` with the validator's ``reason`` so a
     *      truncated/invalid mp4 (size ≥ minBytes but no video stream)
     *      doesn't slip into ``video_scene_assets[]``.
     *
     * ``result.success === false`` short-circuits without any I/O —
     * the IPC handler already knows the download / generation failed.
     *
     * @param {object|null} result
     * @param {(path:string)=>Promise<{exists:boolean,size:number}|null>} statBytesFn
     * @param {{
     *   minBytes?:number,
     *   validateFn?:(filePath:string, minBytes:number)=>Promise<{ok:boolean,reason?:string,ffprobeAvailable?:boolean}>,
     * }} [opts]
     * @returns {Promise<{ chosen: { filePath:string, bytes:number, validation?:object }|null,
     *                     reason: string|null }>}
     */
    async function pickI2VOutputFile(result, statBytesFn, opts = {}) {
        const minBytes = typeof opts.minBytes === 'number' ? opts.minBytes : MIN_USABLE_VIDEO_BYTES;
        const validateFn = typeof opts.validateFn === 'function' ? opts.validateFn : null;
        if (!result) {
            return { chosen: null, reason: 'i2v:generate returned no result for this job' };
        }
        if (result.success === false) {
            const why = (typeof result.error === 'string' && result.error.trim()) ? result.error.trim() : 'unknown failure';
            return { chosen: null, reason: `i2v failed: ${why}` };
        }
        const filePath = (typeof result.savedFile === 'string' && result.savedFile)
            ? result.savedFile
            : (typeof result.outputPath === 'string' ? result.outputPath : '');
        if (!filePath) {
            return { chosen: null, reason: 'i2v result missing savedFile/outputPath (download did not complete)' };
        }
        let st = null;
        try {
            st = await statBytesFn(filePath);
        } catch (_) {
            st = null;
        }
        if (!st || st.exists === false) {
            return { chosen: null, reason: `savedFile not on disk: ${filePath}` };
        }
        const bytes = typeof st.size === 'number' ? st.size : 0;
        if (bytes < minBytes) {
            return { chosen: null, reason: `savedFile is suspiciously small (${bytes} < ${minBytes} bytes — likely truncated download)` };
        }
        if (validateFn) {
            let validation = null;
            try {
                validation = await validateFn(filePath, minBytes);
            } catch (err) {
                return { chosen: null, reason: `validateFn threw: ${(err && err.message) || err}` };
            }
            if (!validation || validation.ok !== true) {
                const reason = (validation && typeof validation.reason === 'string' && validation.reason)
                    ? validation.reason
                    : 'video failed ffprobe validation';
                return { chosen: null, reason };
            }
            return { chosen: { filePath, bytes, validation }, reason: null };
        }
        return { chosen: { filePath, bytes }, reason: null };
    }

    /**
     * Drive ``i2v:generate`` with **scene-level retries** (PR-20B).
     *
     * Mirrors :func:`orchestrateImageGenerationWithRetries` from the
     * image helpers:
     *
     *   1. First attempt — bulk-call ``i2vGenerateFn`` with one
     *      ``{imagePath, prompt}`` item per eligible job (jobs whose
     *      planning already passed; ineligible scenes never reach this
     *      orchestrator).
     *   2. After picking the savedFile from each result, identify jobs
     *      that didn't produce a usable mp4. For attempts 2..maxAttempts,
     *      re-invoke ``i2vGenerateFn`` with **only those jobs' items**.
     *      A job that succeeds on attempt ≥ 2 is marked ``retried``.
     *   3. After the final attempt, any job still without an mp4 is
     *      marked ``fallback`` — the bridge keeps the scene's image
     *      asset in ``scene_assets[]`` so the composer's layered
     *      fallback (``gradient < image < video``) renders the still
     *      frame for that window.
     *
     * ``i2vGenerateFn(items, ctx)`` is async, returns the IPC response
     * shape ``{ success, results: [{ globalIdx, savedFile, success, ... }, ...] }``.
     * ``ctx = { attemptNumber, sceneIds }`` lets tests / callers log or
     * rate-limit per attempt.
     *
     * @returns {Promise<{
     *   videoSceneAssets: Array<{video_path:string,start_s:number,duration_s:number,scene_id?:number}>,
     *   perSceneStatus: Array<{scene_id?:number, status:'generated'|'retried'|'fallback', attempts:number, reason?:string, video_path?:string, bytes?:number}>,
     *   retryCount: number,           // # of extra attempts beyond the first bulk call
     *   i2vGenerate: object|null,     // raw response from the FIRST attempt
     *   maxAttempts: number,
     * }>}
     */
    async function orchestrateI2VWithRetries(jobs, i2vGenerateFn, statBytesFn, opts = {}) {
        const list = Array.isArray(jobs) ? jobs : [];
        const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 2);
        const minBytes = typeof opts.minBytes === 'number' ? opts.minBytes : MIN_USABLE_VIDEO_BYTES;
        const validateFn = typeof opts.validateFn === 'function' ? opts.validateFn : null;

        // Per-job state tracker — lives across attempts so we don't
        // re-issue items for jobs that already produced a usable mp4.
        const jobState = list.map((j) => ({
            scene_id: j && j.scene_id,
            imagePath: j && typeof j.imagePath === 'string' ? j.imagePath : '',
            prompt: j && typeof j.prompt === 'string' ? j.prompt : '',
            start_s: j && typeof j.start_s === 'number' ? j.start_s : 0.0,
            duration_s: j && typeof j.duration_s === 'number' ? j.duration_s : 0.0,
            status: 'pending',
            attempts: 0,
            video_path: null,
            bytes: null,
            last_reason: null,
        }));

        let firstResp = null;
        let retryCount = 0;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const pending = [];
            for (let i = 0; i < jobState.length; i++) {
                if (jobState[i].status === 'pending') pending.push({ idx: i, st: jobState[i] });
            }
            if (!pending.length) break;

            const items = pending.map((p) => ({ imagePath: p.st.imagePath, prompt: p.st.prompt }));
            const sceneIds = pending.map((p) => p.st.scene_id);

            let resp;
            try {
                resp = await i2vGenerateFn(items, { attemptNumber: attempt, sceneIds });
            } catch (err) {
                // Hard IPC failure on this attempt — treat as "no
                // results" so the next attempt (if any) gets a clean
                // shot. Matches the image orchestrator's contract.
                resp = { success: false, error: err && err.message ? err.message : String(err), results: [] };
            }
            if (attempt === 1) firstResp = resp;
            if (attempt > 1) retryCount += pending.length;

            const grouped = groupI2VResultsByJobIndex(resp, items.length);
            for (let k = 0; k < pending.length; k++) {
                pending[k].st.attempts = attempt;
                const result = grouped.get(k) || null;
                const pick = await pickI2VOutputFile(result, statBytesFn, { minBytes, validateFn });
                if (pick.chosen) {
                    pending[k].st.status = attempt === 1 ? 'generated' : 'retried';
                    pending[k].st.video_path = pick.chosen.filePath;
                    pending[k].st.bytes = pick.chosen.bytes;
                    pending[k].st.last_reason = null;
                } else {
                    pending[k].st.last_reason = pick.reason;
                }
            }
        }

        // Anything still pending after maxAttempts → 'fallback'. The
        // bridge will keep the scene's image asset in ``scene_assets[]``
        // so the composer can still render that window per the layered
        // fallback chain.
        for (const st of jobState) {
            if (st.status === 'pending') {
                st.status = 'fallback';
                if (!st.last_reason) st.last_reason = 'i2v did not return a usable mp4 after all retries';
            }
        }

        // Build video_scene_assets[] in scene order using each job's
        // pre-computed start_s / duration_s (those came from the image
        // flow's cumulative timing).
        const videoSceneAssets = [];
        for (const st of jobState) {
            if (st.status === 'generated' || st.status === 'retried') {
                videoSceneAssets.push({
                    video_path: st.video_path,
                    start_s: Number(st.start_s.toFixed(3)),
                    duration_s: Number(st.duration_s.toFixed(3)),
                    scene_id: st.scene_id,
                });
            }
        }

        const perSceneStatus = jobState.map((st) => {
            const out = { scene_id: st.scene_id, status: st.status, attempts: st.attempts };
            if (st.last_reason) out.reason = st.last_reason;
            if (st.video_path) out.video_path = st.video_path;
            if (typeof st.bytes === 'number') out.bytes = st.bytes;
            return out;
        });

        return {
            videoSceneAssets,
            perSceneStatus,
            retryCount,
            i2vGenerate: firstResp,
            maxAttempts,
        };
    }

    /**
     * Convenience: count jobs that ended up in ``fallback`` (composer
     * will keep the image clip for that window) given a
     * ``perSceneStatus[]``.
     */
    function countFallbackI2VScenes(perSceneStatus) {
        return (perSceneStatus || []).filter((s) => s && s.status === 'fallback').length;
    }

    /**
     * Strip the renderer-only ``scene_id`` annotation before crossing
     * the ``producer:composeShort`` IPC boundary (sidecar's
     * VideoSceneAssetSpec only knows about video_path / start_s /
     * duration_s).
     */
    function stripVideoSceneAssetForComposer(videoSceneAssets) {
        return (videoSceneAssets || []).map(({ video_path, start_s, duration_s }) => ({
            video_path, start_s, duration_s,
        }));
    }

    return {
        MIN_USABLE_VIDEO_BYTES,
        planI2VJobsFromScenesAndAssets,
        groupI2VResultsByJobIndex,
        pickI2VOutputFile,
        orchestrateI2VWithRetries,
        countFallbackI2VScenes,
        stripVideoSceneAssetForComposer,
    };
}));
