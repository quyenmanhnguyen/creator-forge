/**
 * storyboard_compose_helpers.js — pure helpers for the renderer's
 * "Compose with AutoGrok" panel (PR-16).
 *
 * Loaded as a plain `<script>` before `creator-forge.js` so the renderer
 * has a small, testable module without pulling in a bundler. Also
 * `module.exports`-friendly so `desktop/tests/*.js` can require it
 * directly under Node (no jsdom needed).
 *
 * The helpers mirror the picking / asset-building logic that
 * `desktop/src/bridges/StoryboardBridge.js#composeWithScenes` runs in the
 * main process. We deliberately don't call the bridge from the renderer
 * because the dist UI has no module bundler — the renderer instead
 * issues two IPCs (`image:generate` then `producer:composeShort`) and uses
 * the new `electronAPI.statBytes` IPC for the ≥ 50 KB blur-rejection
 * check (PR-9).
 */
(function (root, factory) {
    'use strict';
    const mod = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = mod;
    } else if (root) {
        root.StoryboardComposeHelpers = mod;
    }
}(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Matches StoryboardBridge.MIN_USABLE_IMAGE_BYTES + PR-9 ImageService
    // MIN_BLOB_LEN. Below this size a Grok image is almost certainly a
    // blur preview / moderation placeholder.
    const MIN_USABLE_IMAGE_BYTES = 50000;

    /**
     * Decide which scenes to actually feed into image:generate.
     *
     * Returns the prompts in input order plus an `indexMap` linking each
     * prompt back to its scene index. Scenes missing `image_prompt` or with
     * non-positive `duration_s` are listed in `skipped[]` so the caller can
     * surface them in the UI.
     *
     * @param {Array<{scene_id?:number,image_prompt?:string,duration_s?:number}>} scenes
     * @returns {{ prompts: string[], indexMap: number[],
     *            skipped: Array<{scene_id?:number,reason:string}> }}
     */
    function planPromptsFromScenes(scenes) {
        const prompts = [];
        const indexMap = [];
        const skipped = [];
        const list = Array.isArray(scenes) ? scenes : [];
        for (let i = 0; i < list.length; i++) {
            const s = list[i] || {};
            const prompt = typeof s.image_prompt === 'string' ? s.image_prompt.trim() : '';
            const duration = Number(s.duration_s);
            if (!prompt) {
                skipped.push({ scene_id: s.scene_id, reason: 'missing image_prompt' });
                continue;
            }
            if (!(duration > 0)) {
                skipped.push({ scene_id: s.scene_id, reason: 'invalid duration_s' });
                continue;
            }
            prompts.push(prompt);
            indexMap.push(i);
        }
        return { prompts, indexMap, skipped };
    }

    /**
     * Group `image:generate` raw results into a Map<promptIdx, savedFiles[]>
     * using the same `globalIdx`/`localIdx` convention as `StoryboardBridge`.
     *
     * @param {{ success?:boolean, results?:Array<{globalIdx?:number,localIdx?:number,savedFiles?:string[]}> }} imageGenerateResp
     * @param {number} promptCount  Length of the prompts[] passed to image:generate.
     * @returns {Map<number,string[]>}
     */
    function groupSavedFilesByPromptIndex(imageGenerateResp, promptCount) {
        const map = new Map();
        const results = imageGenerateResp && Array.isArray(imageGenerateResp.results)
            ? imageGenerateResp.results
            : [];
        for (const r of results) {
            const idx = (typeof r.globalIdx === 'number')
                ? r.globalIdx
                : (typeof r.localIdx === 'number' ? r.localIdx : null);
            if (idx == null || idx < 0 || idx >= promptCount) continue;
            if (!map.has(idx)) map.set(idx, []);
            const list = Array.isArray(r.savedFiles) ? r.savedFiles : [];
            for (const f of list) map.get(idx).push(f);
        }
        return map;
    }

    /**
     * Pick the first savedFile whose on-disk size is ≥ minBytes.
     *
     * `statBytesFn(path)` is async and must return `{ exists:boolean,
     * size:number }` (or null). In the renderer we wire this to
     * `electronAPI.statBytes`; in tests it can be a plain stub.
     *
     * @param {string[]} savedFiles
     * @param {(path:string)=>Promise<{exists:boolean,size:number}|null>} statBytesFn
     * @param {{ minBytes?: number }} [opts]
     * @returns {Promise<{ chosen: { filePath:string, bytes:number }|null,
     *                     candidates: number,
     *                     reason: string|null }>}
     */
    async function pickFirstUsableSavedFile(savedFiles, statBytesFn, opts = {}) {
        const minBytes = typeof opts.minBytes === 'number' ? opts.minBytes : MIN_USABLE_IMAGE_BYTES;
        const list = Array.isArray(savedFiles) ? savedFiles : [];
        if (!list.length) {
            return {
                chosen: null,
                candidates: 0,
                reason: 'image:generate returned no files for this scene',
            };
        }
        for (const filePath of list) {
            let st;
            try {
                st = await statBytesFn(filePath);
            } catch (_) {
                st = null;
            }
            const bytes = st && typeof st.size === 'number' ? st.size : 0;
            if (bytes >= minBytes) {
                return { chosen: { filePath, bytes }, candidates: list.length, reason: null };
            }
        }
        return {
            chosen: null,
            candidates: list.length,
            reason: `no candidate file ≥ ${minBytes} bytes (likely blur/moderation placeholder)`,
        };
    }

    /**
     * Walk `scenes[]` in order, picking one usable image per scene from the
     * `image:generate` response. Maintain a cumulative `start_s` on the
     * audio timeline so the composer pins each image to the right window.
     *
     * Mirrors StoryboardBridge.composeWithScenes step 3+4. Diverges only in
     * the stat-bytes call (renderer-friendly async IPC instead of fs.statSync).
     *
     * @param {Array<{scene_id?:number,image_prompt?:string,duration_s?:number}>} scenes
     * @param {object} imageGenerateResp  `image:generate` IPC response.
     * @param {(path:string)=>Promise<{exists:boolean,size:number}|null>} statBytesFn
     * @param {{ minBytes?:number }} [opts]
     * @returns {Promise<{
     *   sceneAssets: Array<{image_path:string,start_s:number,duration_s:number,scene_id?:number}>,
     *   skipped: Array<{scene_id?:number,reason:string}>,
     * }>}
     */
    async function buildSceneAssetsFromImageBatch(scenes, imageGenerateResp, statBytesFn, opts = {}) {
        const list = Array.isArray(scenes) ? scenes : [];
        const { prompts, indexMap, skipped: planSkipped } = planPromptsFromScenes(list);
        const grouped = groupSavedFilesByPromptIndex(imageGenerateResp, prompts.length);

        const sceneAssets = [];
        const skipped = planSkipped.slice();
        let cursor = 0.0;

        for (let i = 0; i < list.length; i++) {
            const s = list[i] || {};
            const prompt = typeof s.image_prompt === 'string' ? s.image_prompt.trim() : '';
            const duration = Number(s.duration_s);
            if (!prompt || !(duration > 0)) {
                // Already in `skipped` from planPromptsFromScenes. Advance the
                // audio cursor only when duration is meaningful so subsequent
                // scenes line up with the narration.
                if (duration > 0) cursor += duration;
                continue;
            }

            const promptIdx = indexMap.indexOf(i);
            const candidates = (promptIdx >= 0 ? grouped.get(promptIdx) : null) || [];
            const pick = await pickFirstUsableSavedFile(candidates, statBytesFn, opts);
            if (pick.chosen) {
                sceneAssets.push({
                    image_path: pick.chosen.filePath,
                    start_s: Number(cursor.toFixed(3)),
                    duration_s: Number(duration.toFixed(3)),
                    scene_id: s.scene_id,
                });
            } else {
                skipped.push({ scene_id: s.scene_id, reason: pick.reason });
            }
            cursor += duration;
        }

        return { sceneAssets, skipped };
    }

    /**
     * Drive image:generate with **scene-level retries** (PR-17).
     *
     * Behavior:
     *   1. First attempt — bulk-call `imageGenerateFn` with one prompt per
     *      *eligible* scene (scenes missing `image_prompt` or with
     *      non-positive `duration_s` are pre-marked `skipped` and never sent).
     *   2. After picking ≥ minBytes files per scene, identify scenes that
     *      didn't get a usable hero image. For attempts 2..maxAttempts,
     *      re-invoke `imageGenerateFn` with **only those scenes' prompts**.
     *      A scene that succeeds on attempt ≥ 2 is marked `retried`.
     *   3. After the final attempt, any scene still without a hero image
     *      is marked `fallback` (the composer will gradient-fill its
     *      window — the audio cursor still advances so the timeline stays
     *      in sync).
     *
     * `imageGenerateFn(prompts, ctx)` is async, returns a normal
     * `image:generate` response shape (`{ success, results: [{ globalIdx,
     * savedFiles[] }, ...] }`). `ctx = { attemptNumber, sceneIds }` lets
     * tests / callers log or rate-limit per attempt.
     *
     * `statBytesFn(path)` is the same async stat-bytes contract used by
     * `pickFirstUsableSavedFile`.
     *
     * @returns {Promise<{
     *   sceneAssets: Array<{image_path:string,start_s:number,duration_s:number,scene_id?:number}>,
     *   perSceneStatus: Array<{scene_id?:number, status:'generated'|'retried'|'skipped'|'fallback', attempts:number, reason?:string, image_path?:string}>,
     *   retryCount: number,           // # of extra attempts beyond the first bulk call
     *   imageGenerate: object|null,   // raw response from the FIRST attempt (legacy)
     *   maxAttempts: number,
     * }>}
     */
    async function orchestrateImageGenerationWithRetries(scenes, imageGenerateFn, statBytesFn, opts = {}) {
        const list = Array.isArray(scenes) ? scenes : [];
        const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 2);
        const minBytes = typeof opts.minBytes === 'number' ? opts.minBytes : MIN_USABLE_IMAGE_BYTES;

        // Per-scene state tracker — lives across attempts so we don't re-issue
        // prompts for scenes that already produced a usable image.
        const sceneState = list.map((s) => {
            const prompt = typeof (s && s.image_prompt) === 'string' ? s.image_prompt.trim() : '';
            const duration = Number(s && s.duration_s);
            if (!prompt) {
                return { scene_id: s && s.scene_id, status: 'skipped', attempts: 0, reason: 'missing image_prompt', duration: duration > 0 ? duration : 0 };
            }
            if (!(duration > 0)) {
                return { scene_id: s && s.scene_id, status: 'skipped', attempts: 0, reason: 'invalid duration_s', duration: 0 };
            }
            return { scene_id: s && s.scene_id, status: 'pending', attempts: 0, prompt, duration, image_path: null, last_reason: null };
        });

        let firstResp = null;
        let retryCount = 0;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // Pending = had a prompt + duration, no asset chosen yet.
            const pending = [];
            for (let i = 0; i < sceneState.length; i++) {
                if (sceneState[i].status === 'pending') pending.push({ idx: i, st: sceneState[i] });
            }
            if (!pending.length) break;

            const prompts = pending.map((p) => p.st.prompt);
            const sceneIds = pending.map((p) => p.st.scene_id);
            let resp;
            try {
                resp = await imageGenerateFn(prompts, { attemptNumber: attempt, sceneIds });
            } catch (err) {
                // Hard IPC failure on this attempt — treat as "no results"
                // so the next attempt (if any) gets a clean shot.
                resp = { success: false, error: err && err.message ? err.message : String(err), results: [] };
            }
            if (attempt === 1) firstResp = resp;
            if (attempt > 1) retryCount += pending.length;

            const grouped = groupSavedFilesByPromptIndex(resp, prompts.length);
            for (let k = 0; k < pending.length; k++) {
                pending[k].st.attempts = attempt;
                const candidates = grouped.get(k) || [];
                const pick = await pickFirstUsableSavedFile(candidates, statBytesFn, { minBytes });
                if (pick.chosen) {
                    pending[k].st.status = attempt === 1 ? 'generated' : 'retried';
                    pending[k].st.image_path = pick.chosen.filePath;
                    pending[k].st.bytes = pick.chosen.bytes;
                    pending[k].st.last_reason = null;
                } else {
                    pending[k].st.last_reason = pick.reason;
                }
            }
        }

        // Anything still pending after maxAttempts → 'fallback' (composer
        // will gradient-fill that window). This matches what the user sees
        // in the result card and in the docs/troubleshooting flow.
        for (const st of sceneState) {
            if (st.status === 'pending') {
                st.status = 'fallback';
                if (!st.reason) st.reason = st.last_reason || 'image:generate did not return a ≥50KB file after all retries';
            }
        }

        // Build sceneAssets in scene order with cumulative start_s. Audio
        // cursor advances even for skipped/fallback scenes so subsequent
        // scenes line up with the narration.
        const sceneAssets = [];
        let cursor = 0;
        for (let i = 0; i < list.length; i++) {
            const st = sceneState[i];
            const duration = Number(list[i] && list[i].duration_s);
            if (st.status === 'generated' || st.status === 'retried') {
                sceneAssets.push({
                    image_path: st.image_path,
                    start_s: Number(cursor.toFixed(3)),
                    duration_s: Number(duration.toFixed(3)),
                    scene_id: st.scene_id,
                });
            }
            if (duration > 0) cursor += duration;
        }

        const perSceneStatus = sceneState.map((st) => {
            const out = { scene_id: st.scene_id, status: st.status, attempts: st.attempts };
            if (st.reason) out.reason = st.reason;
            if (st.image_path) out.image_path = st.image_path;
            if (typeof st.bytes === 'number') out.bytes = st.bytes;
            return out;
        });

        return {
            sceneAssets,
            perSceneStatus,
            retryCount,
            imageGenerate: firstResp,
            maxAttempts,
        };
    }

    /**
     * Convenience: count scenes that ended up in `fallback` (composer
     * will gradient-fill them) given a `perSceneStatus[]`.
     */
    function countFallbackScenes(perSceneStatus) {
        return (perSceneStatus || []).filter((s) => s && s.status === 'fallback').length;
    }

    /**
     * Strip the renderer-only `scene_id` annotation before crossing the
     * `producer:composeShort` IPC boundary (sidecar's SceneAssetSpec only
     * knows about image_path / start_s / duration_s).
     */
    function stripSceneAssetForComposer(sceneAssets) {
        return (sceneAssets || []).map(({ image_path, start_s, duration_s }) => ({
            image_path, start_s, duration_s,
        }));
    }

    return {
        MIN_USABLE_IMAGE_BYTES,
        planPromptsFromScenes,
        groupSavedFilesByPromptIndex,
        pickFirstUsableSavedFile,
        buildSceneAssetsFromImageBatch,
        orchestrateImageGenerationWithRetries,
        countFallbackScenes,
        stripSceneAssetForComposer,
    };
}));
