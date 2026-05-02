/* eslint-disable no-undef */
/**
 * compose_voice_picker_helpers.js — pure filter / default-selection
 * helpers for the Compose panel's TTS Provider × Voice picker pair.
 *
 * Why this lives in its own module
 * --------------------------------
 * The Compose panel exposes two dropdowns:
 *
 *   - ``ps-tts-provider`` — edge-tts (online) | piper-tts (offline)
 *   - ``ps-voice``         — voice short_name (e.g. en-US-AriaNeural)
 *
 * Before this module the voice picker was populated from a single
 * unfiltered ``/producer/voices`` list, so a user could pick
 * ``provider=piper-tts`` while the voice value was still
 * ``en-US-AriaNeural`` (an Edge voice id) and hit a confusing
 * sidecar warning at runtime. This module owns the small amount of
 * client-side logic needed to keep the two dropdowns coherent:
 *
 *   1. Filter the cached voice list by the currently-selected provider.
 *   2. Choose a sensible default voice after the filter:
 *        - keep the user's prior pick if it's still in the filtered set
 *        - otherwise prefer the sidecar's ``default`` for that provider
 *        - otherwise fall back to the first option in the filter
 *
 * The helpers are framework-free + side-effect-free so they can be
 * unit-tested in Node without a DOM. The renderer uses them via
 * ``window.ComposeVoicePickerHelpers`` (same UMD pattern as
 * ``storyboard_progress_helpers.js``).
 */

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.ComposeVoicePickerHelpers = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Return only the voices matching ``provider``. ``provider=null``
     * or empty string returns the input untouched (mirrors the
     * sidecar's ``voices_for_provider(None)`` semantics so callers
     * that don't care about provider segmentation still get the
     * full list).
     *
     * The filter is case-insensitive and trim-tolerant so a stray
     * ``" Piper-TTS "`` from a hand-edited dropdown still matches.
     * Voices missing a ``provider`` field default to ``edge-tts``,
     * matching the sidecar's `Voice` dataclass default — so an
     * older payload from a pre-PR sidecar still groups under
     * Edge instead of disappearing entirely.
     */
    function filterVoicesByProvider(voices, provider) {
        if (!Array.isArray(voices)) return [];
        const norm = (provider || '').trim().toLowerCase();
        if (!norm) return voices.slice();
        return voices.filter((v) => {
            if (!v || typeof v !== 'object') return false;
            const p = (typeof v.provider === 'string' && v.provider.trim())
                ? v.provider.trim().toLowerCase()
                : 'edge-tts';
            return p === norm;
        });
    }

    /**
     * Pick the voice that should be selected after a filter pass.
     * The renderer calls this after ``filterVoicesByProvider`` so the
     * ``ps-voice`` dropdown always points at something valid.
     *
     *   1. If ``current`` is in the filtered list, keep it.
     *   2. Else if ``preferredDefault`` is in the filtered list, use it.
     *   3. Else fall back to the first entry's short_name.
     *   4. If the filter is empty (unknown provider), return ``null``
     *      so the caller can render a friendly empty-state.
     */
    function pickDefaultVoice(filteredVoices, current, preferredDefault) {
        if (!Array.isArray(filteredVoices) || filteredVoices.length === 0) return null;
        const shortNames = new Set(filteredVoices.map((v) => v && v.short_name));
        if (current && shortNames.has(current)) return current;
        if (preferredDefault && shortNames.has(preferredDefault)) return preferredDefault;
        return filteredVoices[0].short_name || null;
    }

    /**
     * Convenience: combine filter + default-pick into one call so the
     * renderer can do a single round-trip per provider change. The
     * shape mirrors the ``/producer/voices`` response so it's easy to
     * spread back into ``populateVoicePicker`` state.
     */
    function selectVoicesForProvider({ allVoices, provider, current, sidecarDefault }) {
        const filtered = filterVoicesByProvider(allVoices, provider);
        const selected = pickDefaultVoice(filtered, current, sidecarDefault);
        return { voices: filtered, selected };
    }

    return {
        filterVoicesByProvider,
        pickDefaultVoice,
        selectVoicesForProvider,
    };
}));
