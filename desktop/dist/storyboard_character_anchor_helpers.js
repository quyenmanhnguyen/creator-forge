/* eslint-disable no-undef */
/**
 * storyboard_character_anchor_helpers.js — pure helpers for two
 * HF-12 user-reported pain points:
 *
 *   1. Character / style consistency across scenes. The Visual DNA
 *      string nails *style* (era, palette, lighting, lens, mood) but
 *      not *who* the character is. Even with a global reference
 *      image attached, Grok's imagine-image-edit model would drift
 *      because each scene's image_prompt re-described the woman
 *      from scratch (different hair adjectives, different makeup,
 *      different framing) without anchoring her identity. These
 *      helpers prepend a verbatim character-anchor sentence to
 *      every prompt the renderer sends to ``image:generate`` /
 *      ``refimg:generate``, so the model gets the same identity
 *      cue on every variant.
 *
 *   2. Auto-fit target duration for Compose audio + Refine script
 *      previously required at least one settled scene video — it
 *      fell back to "no scene videos yet" when the user wanted to
 *      compose narration *before* burning Grok credits on Image /
 *      Video batch. The estimated per-scene durations from
 *      ``/producer/scene_breakdown`` (computed from words ÷ WPM)
 *      already give us a reliable target — these helpers surface
 *      that as a fallback so the SRT can scale to the planned
 *      total even with zero scene videos rendered yet.
 *
 * The functions are framework-free + side-effect-free so they can
 * be unit-tested in Node without a DOM. The renderer uses them via
 * ``window.StoryboardCharacterAnchorHelpers`` (UMD pattern, same as
 * the other ``*_helpers.js`` modules).
 */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.StoryboardCharacterAnchorHelpers = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Normalise a free-form character anchor into a single-line
     * cue. Trims, collapses internal whitespace, strips a trailing
     * period (we re-add one in the prefix), caps length so we never
     * blow Grok's prompt budget if the user pastes a paragraph.
     *
     * @param {string} anchor
     * @returns {string} normalised cue or '' when the input is empty
     */
    function normalizeCharacterAnchor(anchor) {
        if (typeof anchor !== 'string') return '';
        const collapsed = anchor.replace(/\s+/g, ' ').trim();
        if (!collapsed) return '';
        const trimmed = collapsed.replace(/[.\s]+$/u, '');
        // 480 chars ~ a long sentence; comfortably below Grok's
        // typical few-thousand-token cap and leaves room for the
        // existing per-scene prompt + Visual DNA tail.
        return trimmed.length > 480 ? trimmed.slice(0, 480).trimEnd() : trimmed;
    }

    /**
     * Build the verbatim cue we prepend to every prompt. We keep
     * the structure visible to the model (``Subject anchor:``) so
     * Grok's edit head can attend to the identity tokens
     * separately from the scene-specific framing.
     *
     * @param {string}  anchor   raw user input
     * @param {boolean} hasRefs  whether ≥1 reference image is attached for the row
     * @returns {string} prefix string ending with ``. `` (empty when anchor is empty)
     */
    function buildCharacterAnchorPrefix(anchor, hasRefs) {
        const cue = normalizeCharacterAnchor(anchor);
        if (!cue) return '';
        // When refs are attached we add an explicit "match the
        // reference" instruction. Without refs the cue alone still
        // helps the LLM-generated variants stay on-character.
        return hasRefs
            ? `Subject anchor (match reference image): ${cue}. `
            : `Subject anchor: ${cue}. `;
    }

    /**
     * Apply the character anchor to a flat list of prompt strings.
     * Skipped silently when the anchor is empty or the prompt list
     * is empty / non-array. Always returns a fresh array; the
     * input is never mutated.
     *
     * @param {string[]} prompts
     * @param {string}   anchor
     * @returns {string[]}
     */
    function applyCharacterAnchor(prompts, anchor) {
        if (!Array.isArray(prompts)) return [];
        const prefix = buildCharacterAnchorPrefix(anchor, false);
        if (!prefix) return prompts.slice();
        return prompts.map((p) => {
            if (typeof p !== 'string' || !p.trim()) return p;
            return prefix + p;
        });
    }

    /**
     * Apply the character anchor to a list of refimg-style items
     * (``{ prompt, refImagePaths }``). Items with ≥1 ref get the
     * "match reference image" variant of the prefix; items with
     * empty refs (defensive — shouldn't usually arrive in this
     * code path) get the bare-anchor variant.
     *
     * @param {Array<{prompt: string, refImagePaths: string[]}>} items
     * @param {string} anchor
     * @returns {Array<{prompt: string, refImagePaths: string[]}>}
     */
    function applyCharacterAnchorToRefItems(items, anchor) {
        if (!Array.isArray(items)) return [];
        const cue = normalizeCharacterAnchor(anchor);
        if (!cue) return items.map((it) => Object.assign({}, it));
        return items.map((it) => {
            if (!it || typeof it.prompt !== 'string' || !it.prompt.trim()) {
                return Object.assign({}, it);
            }
            const hasRefs = Array.isArray(it.refImagePaths) && it.refImagePaths.length > 0;
            const prefix = buildCharacterAnchorPrefix(anchor, hasRefs);
            return Object.assign({}, it, { prompt: prefix + it.prompt });
        });
    }

    /**
     * Sum up scene durations from a /producer/scene_breakdown
     * response (or the renderer's cached ``state.lastScenes``).
     * Tolerates missing / non-numeric ``duration_s`` fields.
     *
     * @param {Array<{duration_s?: number}>} scenes
     * @returns {number} summed seconds, 0 when empty / invalid
     */
    function sumSceneDurations(scenes) {
        if (!Array.isArray(scenes)) return 0;
        let total = 0;
        for (const s of scenes) {
            if (!s || typeof s !== 'object') continue;
            const d = Number(s.duration_s);
            if (Number.isFinite(d) && d > 0) total += d;
        }
        return total;
    }

    /**
     * Resolve the auto-fit target for Compose audio + Refine script.
     * Priority order:
     *
     *   1. Explicit user override (``targetOverrideS``) when > 0.
     *   2. Settled scene-video paths (sidecar will ffprobe-sum).
     *   3. Scene_breakdown estimate (sum of per-scene ``duration_s``
     *      or the cached ``totalDurationEstimate``).
     *   4. None — caller surfaces "no scene videos yet" message.
     *
     * @param {Object} opts
     * @param {string[]} [opts.sceneVideoPaths]      settled scene mp4 paths
     * @param {Array<{duration_s?: number}>} [opts.scenes]  cached scene_breakdown scenes
     * @param {number}  [opts.totalDurationEstimate]    cached total estimate (overrides sum if provided)
     * @param {number}  [opts.targetOverrideS]          user-typed override in seconds (raw)
     * @returns {{source: 'override'|'videos'|'scene_breakdown'|'none',
     *            sceneVideos: string[],
     *            targetDurationS: number,
     *            summaryText: string}}
     */
    function resolveAutoFitTarget(opts) {
        const o = opts || {};
        const sceneVideos = Array.isArray(o.sceneVideoPaths)
            ? o.sceneVideoPaths.filter((p) => typeof p === 'string' && p.trim().length > 0)
            : [];
        const override = Number(o.targetOverrideS);
        if (Number.isFinite(override) && override > 0) {
            return {
                source: 'override',
                sceneVideos,
                targetDurationS: override,
                summaryText: `Target duration override: ${override.toFixed(1)}s (manual).`,
            };
        }
        if (sceneVideos.length) {
            return {
                source: 'videos',
                sceneVideos,
                targetDurationS: 0,
                summaryText: `${sceneVideos.length} scene video${sceneVideos.length === 1 ? '' : 's'} ready — captions will auto-fit their summed duration (override below).`,
            };
        }
        const scenes = Array.isArray(o.scenes) ? o.scenes : [];
        const cached = Number(o.totalDurationEstimate);
        const sum = Number.isFinite(cached) && cached > 0 ? cached : sumSceneDurations(scenes);
        if (sum > 0) {
            return {
                source: 'scene_breakdown',
                sceneVideos,
                targetDurationS: sum,
                summaryText: `No scene videos yet — using scene_breakdown estimate (${sum.toFixed(1)}s, ${scenes.length} scene${scenes.length === 1 ? '' : 's'}). Generate Video batch above to switch to ffprobe-measured duration.`,
            };
        }
        return {
            source: 'none',
            sceneVideos,
            targetDurationS: 0,
            summaryText: 'No scene videos and no scene_breakdown yet — run "Break into scenes" above to enable auto-fit.',
        };
    }

    return {
        normalizeCharacterAnchor,
        buildCharacterAnchorPrefix,
        applyCharacterAnchor,
        applyCharacterAnchorToRefItems,
        sumSceneDurations,
        resolveAutoFitTarget,
    };
}));
