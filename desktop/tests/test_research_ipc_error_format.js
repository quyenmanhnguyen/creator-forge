/**
 * HF-16 — offline tests for researchIPC error formatting.
 *
 * Verifies that ``_formatSidecarError`` flattens FastAPI-style 422
 * detail bodies into the renderer-visible Error.message string.
 *
 * Background: Electron's IPC bridge serialises Errors via
 * structuredClone, which only preserves ``message`` / ``name`` /
 * ``stack`` and drops every other own-property. Earlier code attached
 * the parsed body to ``err.body`` for the renderer's ``showError``
 * helper, but the renderer never saw it — only the literal string
 * ``sidecar 422``. We now bake the body into the message.
 *
 * Run:
 *   node desktop/tests/test_research_ipc_error_format.js
 */

'use strict';

const assert = require('assert');
const ipc = require('../electron/researchIPC.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log('  ok ', name);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
        if (err && err.stack) console.error(err.stack);
        failed++;
    }
}

// ─── _summarizeFastApiDetail ────────────────────────────────────────────────

test('_summarizeFastApiDetail: returns null for non-array', () => {
    assert.strictEqual(ipc._summarizeFastApiDetail(null), null);
    assert.strictEqual(ipc._summarizeFastApiDetail(undefined), null);
    assert.strictEqual(ipc._summarizeFastApiDetail('oops'), null);
    assert.strictEqual(ipc._summarizeFastApiDetail({ msg: 'x' }), null);
});

test('_summarizeFastApiDetail: empty array → null', () => {
    assert.strictEqual(ipc._summarizeFastApiDetail([]), null);
});

test('_summarizeFastApiDetail: joins loc + msg, strips body prefix', () => {
    const detail = [
        {
            type: 'string_too_short',
            loc: ['body', 'script'],
            msg: 'String should have at least 1 character',
            ctx: { min_length: 1 },
        },
    ];
    const out = ipc._summarizeFastApiDetail(detail);
    assert.strictEqual(out, 'script: String should have at least 1 character');
});

test('_summarizeFastApiDetail: multiple errors joined with "; "', () => {
    const detail = [
        { loc: ['body', 'a'], msg: 'A failed' },
        { loc: ['body', 'b'], msg: 'B failed' },
    ];
    const out = ipc._summarizeFastApiDetail(detail);
    assert.strictEqual(out, 'a: A failed; b: B failed');
});

test('_summarizeFastApiDetail: falls back to type when msg missing', () => {
    const detail = [{ loc: ['body', 'x'], type: 'value_error' }];
    assert.strictEqual(
        ipc._summarizeFastApiDetail(detail),
        'x: value_error',
    );
});

// ─── _formatSidecarError ────────────────────────────────────────────────────

test('_formatSidecarError: bare statusCode when body is null', () => {
    assert.strictEqual(
        ipc._formatSidecarError(500, null),
        'sidecar 500',
    );
});

test('_formatSidecarError: flattens FastAPI 422 detail into message', () => {
    const body = {
        detail: [
            {
                type: 'string_too_short',
                loc: ['body', 'script'],
                msg: 'String should have at least 1 character',
            },
        ],
    };
    const msg = ipc._formatSidecarError(422, body);
    assert.ok(msg.startsWith('sidecar 422 — '), `got ${msg}`);
    assert.ok(msg.includes('script:'), `expected field name in ${msg}`);
    assert.ok(msg.includes('at least 1 character'), `expected validator msg in ${msg}`);
});

test('_formatSidecarError: includes string detail verbatim', () => {
    const body = { detail: 'Sidecar overloaded' };
    assert.strictEqual(
        ipc._formatSidecarError(503, body),
        'sidecar 503 — Sidecar overloaded',
    );
});

test('_formatSidecarError: prefers .message when no detail', () => {
    const body = { message: 'Internal error: reflection failed' };
    assert.strictEqual(
        ipc._formatSidecarError(500, body),
        'sidecar 500 — Internal error: reflection failed',
    );
});

test('_formatSidecarError: falls back to JSON dump for opaque bodies', () => {
    const body = { ok: false, code: 'X42' };
    const msg = ipc._formatSidecarError(500, body);
    assert.ok(msg.startsWith('sidecar 500 — '), msg);
    assert.ok(msg.includes('"X42"'), msg);
});

test('_formatSidecarError: includes raw text body when JSON parse failed', () => {
    const body = { raw: '<html>500 — backend exploded</html>' };
    assert.strictEqual(
        ipc._formatSidecarError(500, body),
        'sidecar 500 — <html>500 — backend exploded</html>',
    );
});

test('_formatSidecarError: truncates very long summaries', () => {
    const body = { detail: 'x'.repeat(5000) };
    const msg = ipc._formatSidecarError(422, body);
    assert.ok(msg.endsWith('…'), 'expected ellipsis on truncated message');
    // 'sidecar 422 — ' (14) + 800 + '…' (1) = 815
    assert.ok(msg.length < 850, `expected truncated, got length ${msg.length}`);
});

// ─── Run ────────────────────────────────────────────────────────────────────

console.log('\nresearch IPC error format');
setImmediate(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
});
