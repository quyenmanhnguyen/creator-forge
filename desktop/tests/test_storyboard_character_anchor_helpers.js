'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const helpers = require(path.join('..', 'dist', 'storyboard_character_anchor_helpers.js'));

const {
    normalizeCharacterAnchor,
    buildCharacterAnchorPrefix,
    applyCharacterAnchor,
    applyCharacterAnchorToRefItems,
    sumSceneDurations,
    resolveAutoFitTarget,
} = helpers;

// ─── normalizeCharacterAnchor ───────────────────────────────────────

test('normalizeCharacterAnchor collapses whitespace and trims trailing periods', () => {
    assert.strictEqual(
        normalizeCharacterAnchor('  young\twoman,\n\njet-black hair.   '),
        'young woman, jet-black hair',
    );
});

test('normalizeCharacterAnchor returns "" for non-strings, empty, and whitespace-only', () => {
    assert.strictEqual(normalizeCharacterAnchor(undefined), '');
    assert.strictEqual(normalizeCharacterAnchor(null), '');
    assert.strictEqual(normalizeCharacterAnchor(42), '');
    assert.strictEqual(normalizeCharacterAnchor(''), '');
    assert.strictEqual(normalizeCharacterAnchor('   \t\n  '), '');
});

test('normalizeCharacterAnchor caps very long inputs at 480 chars', () => {
    const huge = 'a'.repeat(800);
    const out = normalizeCharacterAnchor(huge);
    assert.ok(out.length <= 480);
    assert.strictEqual(out, 'a'.repeat(480));
});

// ─── buildCharacterAnchorPrefix ─────────────────────────────────────

test('buildCharacterAnchorPrefix without refs uses "Subject anchor:" prefix', () => {
    const out = buildCharacterAnchorPrefix('young woman, jet-black hair', false);
    assert.strictEqual(out, 'Subject anchor: young woman, jet-black hair. ');
});

test('buildCharacterAnchorPrefix with refs explicitly mentions reference image', () => {
    const out = buildCharacterAnchorPrefix('young woman, jet-black hair', true);
    assert.strictEqual(out, 'Subject anchor (match reference image): young woman, jet-black hair. ');
});

test('buildCharacterAnchorPrefix returns "" for empty anchor regardless of hasRefs', () => {
    assert.strictEqual(buildCharacterAnchorPrefix('', true), '');
    assert.strictEqual(buildCharacterAnchorPrefix('   ', false), '');
    assert.strictEqual(buildCharacterAnchorPrefix(null, true), '');
});

// ─── applyCharacterAnchor (plain prompts) ────────────────────────────

test('applyCharacterAnchor prepends prefix to every non-empty prompt', () => {
    const prompts = [
        'Wide shot of a cozy living room.',
        'Medium close-up, slightly high angle.',
        'Tight close-up from a low angle.',
    ];
    const out = applyCharacterAnchor(prompts, 'young woman, jet-black hair');
    assert.deepStrictEqual(out, [
        'Subject anchor: young woman, jet-black hair. Wide shot of a cozy living room.',
        'Subject anchor: young woman, jet-black hair. Medium close-up, slightly high angle.',
        'Subject anchor: young woman, jet-black hair. Tight close-up from a low angle.',
    ]);
});

test('applyCharacterAnchor returns a fresh copy when anchor is empty', () => {
    const prompts = ['scene 1', 'scene 2'];
    const out = applyCharacterAnchor(prompts, '');
    assert.deepStrictEqual(out, prompts);
    assert.notStrictEqual(out, prompts);
});

test('applyCharacterAnchor leaves empty / whitespace prompts untouched', () => {
    const prompts = ['scene 1', '', '   ', 'scene 4'];
    const out = applyCharacterAnchor(prompts, 'anchor');
    assert.strictEqual(out[0], 'Subject anchor: anchor. scene 1');
    assert.strictEqual(out[1], '');
    assert.strictEqual(out[2], '   ');
    assert.strictEqual(out[3], 'Subject anchor: anchor. scene 4');
});

test('applyCharacterAnchor returns [] for non-array input', () => {
    assert.deepStrictEqual(applyCharacterAnchor(null, 'anchor'), []);
    assert.deepStrictEqual(applyCharacterAnchor(undefined, 'anchor'), []);
    assert.deepStrictEqual(applyCharacterAnchor('not an array', 'anchor'), []);
});

// ─── applyCharacterAnchorToRefItems ──────────────────────────────────

test('applyCharacterAnchorToRefItems uses match-reference prefix when refs are present', () => {
    const items = [
        { prompt: 'wide cozy living room', refImagePaths: ['/path/ref1.png'] },
        { prompt: 'medium close-up portrait', refImagePaths: ['/path/ref1.png', '/path/ref2.png'] },
    ];
    const out = applyCharacterAnchorToRefItems(items, 'young woman, jet-black hair');
    assert.strictEqual(
        out[0].prompt,
        'Subject anchor (match reference image): young woman, jet-black hair. wide cozy living room',
    );
    assert.strictEqual(
        out[1].prompt,
        'Subject anchor (match reference image): young woman, jet-black hair. medium close-up portrait',
    );
    // refImagePaths must be preserved verbatim
    assert.deepStrictEqual(out[0].refImagePaths, ['/path/ref1.png']);
    assert.deepStrictEqual(out[1].refImagePaths, ['/path/ref1.png', '/path/ref2.png']);
});

test('applyCharacterAnchorToRefItems uses bare-anchor prefix when refs are missing', () => {
    const items = [
        { prompt: 'wide cozy living room', refImagePaths: [] },
        { prompt: 'medium close-up portrait' },
    ];
    const out = applyCharacterAnchorToRefItems(items, 'young woman, jet-black hair');
    assert.strictEqual(out[0].prompt, 'Subject anchor: young woman, jet-black hair. wide cozy living room');
    assert.strictEqual(out[1].prompt, 'Subject anchor: young woman, jet-black hair. medium close-up portrait');
});

test('applyCharacterAnchorToRefItems is a no-op when anchor is empty (returns shallow copy)', () => {
    const items = [{ prompt: 'wide cozy living room', refImagePaths: ['/a.png'] }];
    const out = applyCharacterAnchorToRefItems(items, '');
    assert.deepStrictEqual(out, items);
    assert.notStrictEqual(out, items);
    assert.notStrictEqual(out[0], items[0]);
});

test('applyCharacterAnchorToRefItems returns [] for non-array input', () => {
    assert.deepStrictEqual(applyCharacterAnchorToRefItems(null, 'anchor'), []);
    assert.deepStrictEqual(applyCharacterAnchorToRefItems(undefined, 'anchor'), []);
});

// ─── sumSceneDurations ───────────────────────────────────────────────

test('sumSceneDurations sums duration_s across an array of scenes', () => {
    const scenes = [
        { duration_s: 12.4 },
        { duration_s: 11.2 },
        { duration_s: 12.8 },
    ];
    assert.strictEqual(sumSceneDurations(scenes).toFixed(1), '36.4');
});

test('sumSceneDurations tolerates missing / non-numeric / negative values', () => {
    const scenes = [
        { duration_s: 10.0 },
        {},                       // missing
        { duration_s: 'oops' },   // not a number
        { duration_s: -3.5 },     // negative — skip
        { duration_s: 5.5 },
    ];
    assert.strictEqual(sumSceneDurations(scenes), 15.5);
});

test('sumSceneDurations returns 0 for empty / non-array input', () => {
    assert.strictEqual(sumSceneDurations([]), 0);
    assert.strictEqual(sumSceneDurations(null), 0);
    assert.strictEqual(sumSceneDurations(undefined), 0);
});

// ─── resolveAutoFitTarget ────────────────────────────────────────────

test('resolveAutoFitTarget priorities: override > videos > scene_breakdown > none', () => {
    // 1. Explicit override wins, even when scene videos and scenes are also present
    const ov = resolveAutoFitTarget({
        sceneVideoPaths: ['/p/shot1.mp4'],
        scenes: [{ duration_s: 5 }],
        targetOverrideS: 42.5,
    });
    assert.strictEqual(ov.source, 'override');
    assert.strictEqual(ov.targetDurationS, 42.5);

    // 2. Without override, videos win over scene_breakdown
    const vid = resolveAutoFitTarget({
        sceneVideoPaths: ['/p/shot1.mp4', '/p/shot2.mp4'],
        scenes: [{ duration_s: 5 }, { duration_s: 7 }],
    });
    assert.strictEqual(vid.source, 'videos');
    assert.strictEqual(vid.targetDurationS, 0);  // sidecar ffprobes the videos
    assert.deepStrictEqual(vid.sceneVideos, ['/p/shot1.mp4', '/p/shot2.mp4']);
    assert.match(vid.summaryText, /2 scene videos ready/);

    // 3. Without videos, scene_breakdown estimate kicks in (the HF-12
    //    fix the user explicitly asked for).
    const sb = resolveAutoFitTarget({
        sceneVideoPaths: [],
        scenes: [{ duration_s: 12.4 }, { duration_s: 11.2 }, { duration_s: 12.8 }],
    });
    assert.strictEqual(sb.source, 'scene_breakdown');
    assert.strictEqual(sb.targetDurationS.toFixed(1), '36.4');
    assert.match(sb.summaryText, /scene_breakdown estimate \(36\.4s, 3 scenes\)/);

    // 4. Neither — fall back to "run scene breakdown first"
    const none = resolveAutoFitTarget({});
    assert.strictEqual(none.source, 'none');
    assert.strictEqual(none.targetDurationS, 0);
    assert.match(none.summaryText, /run "Break into scenes"/);
});

test('resolveAutoFitTarget filters non-string and empty scene-video paths', () => {
    const out = resolveAutoFitTarget({
        sceneVideoPaths: ['/p/shot1.mp4', '', null, '   ', '/p/shot2.mp4'],
        scenes: [{ duration_s: 5 }],
    });
    assert.strictEqual(out.source, 'videos');
    assert.deepStrictEqual(out.sceneVideos, ['/p/shot1.mp4', '/p/shot2.mp4']);
});

test('resolveAutoFitTarget prefers cached totalDurationEstimate when set', () => {
    const out = resolveAutoFitTarget({
        sceneVideoPaths: [],
        scenes: [{ duration_s: 12.4 }, { duration_s: 11.2 }],
        totalDurationEstimate: 99.7,  // sidecar's authoritative number
    });
    assert.strictEqual(out.source, 'scene_breakdown');
    assert.strictEqual(out.targetDurationS, 99.7);
});

test('resolveAutoFitTarget rejects override of zero or negative', () => {
    const zero = resolveAutoFitTarget({
        sceneVideoPaths: ['/p/shot1.mp4'],
        targetOverrideS: 0,
    });
    assert.strictEqual(zero.source, 'videos');

    const neg = resolveAutoFitTarget({
        sceneVideoPaths: ['/p/shot1.mp4'],
        targetOverrideS: -5,
    });
    assert.strictEqual(neg.source, 'videos');
});
