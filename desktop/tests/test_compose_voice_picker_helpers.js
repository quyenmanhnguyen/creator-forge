/**
 * Offline regression tests for compose_voice_picker_helpers.js.
 *
 * Coverage:
 *   1. filterVoicesByProvider returns the input untouched when provider is empty.
 *   2. filterVoicesByProvider matches case-insensitively and trims whitespace.
 *   3. filterVoicesByProvider treats missing `provider` field as "edge-tts".
 *   4. filterVoicesByProvider returns [] for unknown providers.
 *   5. pickDefaultVoice keeps the user's current pick when it's still in the list.
 *   6. pickDefaultVoice falls back to the sidecar default when current is filtered out.
 *   7. pickDefaultVoice falls back to the first list entry when both are missing.
 *   8. pickDefaultVoice returns null on an empty filtered list (unknown provider).
 *   9. selectVoicesForProvider composes filter + default-pick correctly.
 *  10. selectVoicesForProvider returns selected=null when filter is empty.
 *
 * Run:  node desktop/tests/test_compose_voice_picker_helpers.js
 */

'use strict';

const assert = require('assert');
const helpers = require('../dist/compose_voice_picker_helpers.js');
const { filterVoicesByProvider, pickDefaultVoice, selectVoicesForProvider } = helpers;

const SAMPLE = [
    { short_name: 'en-US-AriaNeural',      label: 'English (US) · Aria · F',      locale: 'en-US', gender: 'F', provider: 'edge-tts' },
    { short_name: 'en-US-GuyNeural',       label: 'English (US) · Guy · M',       locale: 'en-US', gender: 'M', provider: 'edge-tts' },
    { short_name: 'vi-VN-HoaiMyNeural',    label: 'Tiếng Việt · Hoài My · F',     locale: 'vi-VN', gender: 'F', provider: 'edge-tts' },
    { short_name: 'vi_VN-vais1000-medium', label: 'Tiếng Việt · VAIS-1000',       locale: 'vi-VN', gender: 'M', provider: 'piper-tts' },
    { short_name: 'en_US-amy-medium',      label: 'English (US) · Amy (Piper)',   locale: 'en-US', gender: 'F', provider: 'piper-tts' },
];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('filterVoicesByProvider returns the input untouched when provider is empty', () => {
    assert.deepStrictEqual(filterVoicesByProvider(SAMPLE, ''), SAMPLE);
    assert.deepStrictEqual(filterVoicesByProvider(SAMPLE, null), SAMPLE);
    assert.deepStrictEqual(filterVoicesByProvider(SAMPLE, undefined), SAMPLE);
});

test('filterVoicesByProvider returns [] when input is not an array', () => {
    assert.deepStrictEqual(filterVoicesByProvider(null, 'edge-tts'), []);
    assert.deepStrictEqual(filterVoicesByProvider(undefined, 'edge-tts'), []);
    assert.deepStrictEqual(filterVoicesByProvider({}, 'edge-tts'), []);
});

test('filterVoicesByProvider matches case-insensitively and trims whitespace', () => {
    const piper = filterVoicesByProvider(SAMPLE, '  Piper-TTS  ');
    assert.strictEqual(piper.length, 2);
    assert.ok(piper.every((v) => v.provider === 'piper-tts'));
});

test('filterVoicesByProvider returns only edge-tts voices for provider=edge-tts', () => {
    const edge = filterVoicesByProvider(SAMPLE, 'edge-tts');
    assert.strictEqual(edge.length, 3);
    assert.ok(edge.every((v) => v.provider === 'edge-tts'));
    const names = edge.map((v) => v.short_name);
    assert.deepStrictEqual(names, ['en-US-AriaNeural', 'en-US-GuyNeural', 'vi-VN-HoaiMyNeural']);
});

test('filterVoicesByProvider treats a missing provider field as edge-tts', () => {
    const legacy = [
        { short_name: 'en-US-AriaNeural', label: 'Aria', locale: 'en-US', gender: 'F' }, // no provider
        { short_name: 'vi_VN-vais1000-medium', label: 'VAIS', locale: 'vi-VN', gender: 'M', provider: 'piper-tts' },
    ];
    assert.deepStrictEqual(
        filterVoicesByProvider(legacy, 'edge-tts').map((v) => v.short_name),
        ['en-US-AriaNeural'],
    );
    assert.deepStrictEqual(
        filterVoicesByProvider(legacy, 'piper-tts').map((v) => v.short_name),
        ['vi_VN-vais1000-medium'],
    );
});

test('filterVoicesByProvider returns [] for an unknown provider', () => {
    assert.deepStrictEqual(filterVoicesByProvider(SAMPLE, 'bogus-engine'), []);
});

test('filterVoicesByProvider skips malformed entries', () => {
    const dirty = [
        null,
        undefined,
        'not-an-object',
        { short_name: 'en-US-AriaNeural', provider: 'edge-tts' },
    ];
    const out = filterVoicesByProvider(dirty, 'edge-tts');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].short_name, 'en-US-AriaNeural');
});

test('pickDefaultVoice keeps current when it is still in the filtered list', () => {
    const edge = filterVoicesByProvider(SAMPLE, 'edge-tts');
    assert.strictEqual(
        pickDefaultVoice(edge, 'en-US-GuyNeural', 'en-US-AriaNeural'),
        'en-US-GuyNeural',
    );
});

test('pickDefaultVoice falls back to sidecar default when current is filtered out', () => {
    const piper = filterVoicesByProvider(SAMPLE, 'piper-tts');
    // ``current`` is an edge voice no longer in the filtered set →
    // use the sidecar default which IS in the list.
    assert.strictEqual(
        pickDefaultVoice(piper, 'en-US-AriaNeural', 'en_US-amy-medium'),
        'en_US-amy-medium',
    );
});

test('pickDefaultVoice falls back to the first list entry when both inputs are missing', () => {
    const piper = filterVoicesByProvider(SAMPLE, 'piper-tts');
    assert.strictEqual(
        pickDefaultVoice(piper, null, null),
        piper[0].short_name,
    );
});

test('pickDefaultVoice returns null on an empty filtered list', () => {
    assert.strictEqual(pickDefaultVoice([], 'en-US-AriaNeural', 'en-US-AriaNeural'), null);
    assert.strictEqual(pickDefaultVoice(null, 'whatever', 'whatever'), null);
});

test('selectVoicesForProvider composes filter + default pick', () => {
    const result = selectVoicesForProvider({
        allVoices: SAMPLE,
        provider: 'piper-tts',
        current: 'en-US-AriaNeural',  // not in piper list
        sidecarDefault: 'vi_VN-vais1000-medium',
    });
    assert.strictEqual(result.voices.length, 2);
    assert.strictEqual(result.selected, 'vi_VN-vais1000-medium');
});

test('selectVoicesForProvider returns selected=null when filter is empty', () => {
    const result = selectVoicesForProvider({
        allVoices: SAMPLE,
        provider: 'bogus-engine',
        current: 'en-US-AriaNeural',
        sidecarDefault: 'en-US-AriaNeural',
    });
    assert.deepStrictEqual(result.voices, []);
    assert.strictEqual(result.selected, null);
});

(async function run() {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
        } catch (err) {
            failed += 1;
            console.error(`  ✗ ${t.name}\n    ${err.stack || err.message}`);
        }
    }
    if (failed) {
        console.error(`\n${failed} / ${tests.length} test(s) FAILED`);
        process.exit(1);
    }
    console.log(`\n${tests.length} test(s) PASSED`);
})();
