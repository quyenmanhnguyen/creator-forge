/* eslint-disable no-undef */
/**
 * PR-A: pure helpers that drive the long-running progress UI for
 * LLM-heavy endpoints (currently used by ``/producer/scene_breakdown``,
 * which can take 30–120s on a multi-scene script with variant
 * expansion enabled).
 *
 * The UI shown by ``showProgress`` (in creator-forge.js) needs three
 * things refreshed on a timer:
 *
 *   1. An elapsed-time counter so the user has a concrete signal that
 *      the call is still alive ("12s elapsed").
 *   2. A phase-label that ticks through 3-4 expected sub-steps so the
 *      user understands *what* the long wait is doing (Visual DNA
 *      extraction → scene split → variant prompts).
 *   3. An indeterminate progress bar — pure CSS, no JS contract here.
 *
 * Item 1 + 2 are pure functions of the elapsed milliseconds, which is
 * why they live in this module — they're trivially unit-testable in
 * Node without a DOM and decouple the renderer from the time math.
 *
 * The helpers are deliberately framework-free: the caller passes a
 * static "phases" array of ``{ at_ms, text }`` and an elapsed ms,
 * and we return the matching label. No state is mutated.
 */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.StoryboardProgressHelpers = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Format an elapsed ms count as a compact human-readable string.
     *
     *   formatElapsed(0)      → "0s"
     *   formatElapsed(900)    → "0s"   (sub-second floored, never "0.9s")
     *   formatElapsed(12_000) → "12s"
     *   formatElapsed(75_000) → "1m 15s"
     *   formatElapsed(3_600_000) → "60m 0s" (we don't roll over to hours —
     *                            a scene_breakdown that takes >1h is broken)
     *
     * Negative or non-finite inputs clamp to 0 so a misbehaving
     * caller can't render "NaNs".
     */
    function formatElapsed(ms) {
        const n = Number(ms);
        if (!Number.isFinite(n) || n < 0) return '0s';
        const totalSec = Math.floor(n / 1000);
        if (totalSec < 60) return `${totalSec}s`;
        const minutes = Math.floor(totalSec / 60);
        const seconds = totalSec - minutes * 60;
        return `${minutes}m ${seconds}s`;
    }

    /**
     * Given an ordered list of phase milestones and an elapsed ms,
     * return the label whose ``at_ms`` is the largest value still ≤
     * elapsed. This lets us "advance" the visible phase as time
     * passes without any explicit state — the renderer just polls
     * with whatever ``elapsed`` it has and gets the right text.
     *
     * Phase rules (enforced by clamping rather than throwing — a
     * progress UI must never crash the form on malformed input):
     *
     *   - ``phases`` must be an array; otherwise we return ''.
     *   - Each entry must be ``{ at_ms: number, text: string }``;
     *     entries missing either field are skipped.
     *   - The list is sorted ascending by ``at_ms`` internally so
     *     callers don't have to.
     *   - If no phase has ``at_ms ≤ elapsed`` we return '' (the
     *     renderer treats that as "no phase text yet").
     */
    function selectPhaseLabel(phases, elapsedMs) {
        if (!Array.isArray(phases)) return '';
        const elapsed = Number.isFinite(elapsedMs) ? Number(elapsedMs) : 0;
        // Defensive copy + filter so callers' arrays aren't mutated.
        const valid = phases
            .filter((p) => p && typeof p.text === 'string' && Number.isFinite(p.at_ms))
            .slice()
            .sort((a, b) => a.at_ms - b.at_ms);
        let current = '';
        for (const p of valid) {
            if (p.at_ms <= elapsed) current = p.text;
            else break;
        }
        return current;
    }

    /**
     * Default phases for ``/producer/scene_breakdown``. The cumulative
     * timing matches PR-A's measured backend pipeline:
     *
     *   t = 0       — backend just received the POST; show the most
     *                 generic "Đang gửi yêu cầu…" so the bar is never
     *                 blank on the very first paint.
     *   t = ~3s     — main breakdown LLM call typically begins here
     *                 (after FastAPI dispatch + DeepSeek auth).
     *   t = ~25s    — Visual DNA extraction (parallel-ish on backend).
     *   t = ~45s    — variant prompts fan-out begins (now parallel).
     *   t = ~75s    — usual tail; warn the user we're still working.
     *
     * Exposed so other panels can reuse them or swap in their own.
     */
    const DEFAULT_SCENE_BREAKDOWN_PHASES = Object.freeze([
        Object.freeze({ at_ms: 0,      text: 'Đang gửi yêu cầu sang DeepSeek…' }),
        Object.freeze({ at_ms: 3000,   text: 'Đang phân tích kịch bản và chia scene…' }),
        Object.freeze({ at_ms: 25000,  text: 'Đang trích xuất Visual DNA…' }),
        Object.freeze({ at_ms: 45000,  text: 'Đang sinh prompts variants song song…' }),
        Object.freeze({ at_ms: 75000,  text: 'Vẫn đang xử lý — script dài cần thêm vài chục giây nữa…' }),
    ]);

    /**
     * HTML factory for the progress block. Returns a string the caller
     * can drop into ``.innerHTML`` of the result panel. Kept as a
     * pure function so we can snapshot-test the markup separately
     * from the live timer.
     *
     * Inputs:
     *   - ``label``: short headline ("Breaking script into scenes…").
     *     Falsy → defaults to "Working…".
     *   - ``phaseText``: optional sub-line shown under the bar
     *     (typically the result of ``selectPhaseLabel``). Empty
     *     string → omits the phase row entirely so the panel doesn't
     *     have a blank gap before phases catch up.
     *   - ``elapsedText``: pre-formatted elapsed string (e.g. "12s").
     *   - ``hint``: optional small italic hint shown at the bottom
     *     once the call has been pending for >3s (the renderer
     *     decides the threshold; this helper just renders what it's
     *     handed).
     *
     * The bar has a dedicated ``.progress-bar`` class so the CSS
     * animation is contained — see creator-forge.html for the
     * keyframes.
     */
    function buildProgressHtml(opts) {
        const o = (opts && typeof opts === 'object') ? opts : {};
        const label = typeof o.label === 'string' && o.label ? o.label : 'Working…';
        const phaseText = typeof o.phaseText === 'string' ? o.phaseText : '';
        const elapsedText = typeof o.elapsedText === 'string' ? o.elapsedText : '0s';
        const hint = typeof o.hint === 'string' ? o.hint : '';

        const phaseRow = phaseText
            ? `<div class="progress-phase">${escapeHtml(phaseText)}</div>`
            : '';
        const hintRow = hint
            ? `<div class="progress-hint">${escapeHtml(hint)}</div>`
            : '';

        return [
            '<div class="progress-block">',
            '  <div class="progress-head">',
            `    <span class="spinner"></span>`,
            `    <span class="progress-label">${escapeHtml(label)}</span>`,
            `    <span class="progress-elapsed">${escapeHtml(elapsedText)}</span>`,
            '  </div>',
            '  <div class="progress-bar"><div class="progress-bar-fill"></div></div>',
            phaseRow,
            hintRow,
            '</div>',
        ].join('');
    }

    /**
     * Local copy of the renderer's escapeHtml — duplicated rather
     * than imported so this module stays standalone (the renderer's
     * helpers live inside its IIFE and aren't exported). Identical
     * semantics to the renderer version.
     */
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    return {
        formatElapsed: formatElapsed,
        selectPhaseLabel: selectPhaseLabel,
        buildProgressHtml: buildProgressHtml,
        DEFAULT_SCENE_BREAKDOWN_PHASES: DEFAULT_SCENE_BREAKDOWN_PHASES,
    };
}));
