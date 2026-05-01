/**
 * Offline tests for the work-stealing multi-account fan-out
 * scheduler.
 *
 * Coverage:
 *   - even distribution when sessions are equally fast
 *   - work-stealing: a fast session drains items the slow
 *     session would otherwise keep idle in static slicing
 *   - cancellation: workers stop pulling new items the moment
 *     ``isCancelled()`` returns true; in-flight items still
 *     resolve into ``results``
 *   - quarantine after N consecutive failures: the bad
 *     session stops pulling, healthy sessions drain the rest
 *   - requeueOnSessionQuarantine: failed items pushed back
 *     into the queue and retried on a different session
 *   - processOne throwing → recorded as { success: false, error }
 *     rather than rejecting the whole batch
 *   - empty inputs degrade gracefully
 *
 * Run:  node desktop/tests/test_multi_account_fan_out.js
 */

'use strict';

const assert = require('assert');
const { runFanOut } = require('../src/orchestration/multi_account_fan_out');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Basic shape ──────────────────────────────────────────────────

test('throws when sessions is empty', async () => {
    await assert.rejects(
        () => runFanOut({ sessions: [], items: [1], processOne: async () => ({ success: true }) }),
        /sessions array is empty/i,
    );
});

test('throws when processOne is missing', async () => {
    await assert.rejects(
        () => runFanOut({ sessions: [{ accIdx: 0 }], items: [1] }),
        /processOne callback is required/i,
    );
});

test('throws when items is not an array', async () => {
    await assert.rejects(
        () => runFanOut({ sessions: [{ accIdx: 0 }], items: 'not-an-array', processOne: async () => ({}) }),
        /items must be an array/i,
    );
});

test('empty items: returns empty results + zero stats', async () => {
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }, { accIdx: 1 }],
        items: [],
        processOne: async () => ({ success: true }),
    });
    assert.deepStrictEqual(out.results, []);
    assert.strictEqual(out.stats.perSession.length, 2);
    for (const s of out.stats.perSession) {
        assert.strictEqual(s.taken, 0);
        assert.strictEqual(s.ok, 0);
        assert.strictEqual(s.failed, 0);
        assert.strictEqual(s.quarantined, false);
    }
});

// ─── Even distribution ────────────────────────────────────────────

test('all results land in the right slot, every item processed exactly once', async () => {
    const N = 20;
    const items = Array.from({ length: N }, (_, i) => `item-${i}`);
    const seen = new Set();
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }, { accIdx: 1 }],
        items,
        processOne: async (item, _session, idx) => {
            assert.strictEqual(item, items[idx], 'item at idx must match');
            assert.ok(!seen.has(idx), `idx ${idx} must be processed exactly once`);
            seen.add(idx);
            return { success: true, idx };
        },
        perSessionConcurrency: 4,
        workerStaggerMs: 0,
    });
    assert.strictEqual(seen.size, N);
    assert.strictEqual(out.results.length, N);
    for (let i = 0; i < N; i++) {
        assert.strictEqual(out.results[i].idx, i, `slot ${i}`);
    }
    const totalOk = out.stats.perSession.reduce((a, s) => a + s.ok, 0);
    assert.strictEqual(totalOk, N);
});

test('two equal-speed sessions split work roughly evenly', async () => {
    const N = 20;
    const items = Array.from({ length: N }, (_, i) => i);
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }, { accIdx: 1 }],
        items,
        processOne: async (_item, _session, _idx) => {
            await sleep(5);
            return { success: true };
        },
        perSessionConcurrency: 4,
        workerStaggerMs: 0,
    });
    const taken = out.stats.perSession.map((s) => s.taken).sort();
    // Equal speeds → roughly half each. Allow a generous slack
    // because the worker-stagger and JS event-loop ordering
    // make exact 10/10 splits non-deterministic.
    assert.ok(taken[0] >= 5, `slow session got ${taken[0]} (expected ≥5)`);
    assert.ok(taken[1] <= 15, `fast session got ${taken[1]} (expected ≤15)`);
    assert.strictEqual(taken[0] + taken[1], N);
});

// ─── Work-stealing ────────────────────────────────────────────────

test('a fast session steals work from a slow one (vs static slicing)', async () => {
    // The whole point of the scheduler. We rig session B to be 10×
    // slower than A. With static slicing A would do 10/10 and idle
    // for the rest of B's work. With work-stealing A should take
    // SIGNIFICANTLY more than half.
    const N = 20;
    const items = Array.from({ length: N }, (_, i) => i);
    const out = await runFanOut({
        sessions: [{ accIdx: 0, name: 'fast' }, { accIdx: 1, name: 'slow' }],
        items,
        processOne: async (_item, session, _idx) => {
            await sleep(session.name === 'fast' ? 2 : 20);
            return { success: true };
        },
        perSessionConcurrency: 1,
        workerStaggerMs: 0,
    });
    const fastTaken = out.stats.perSession.find((s) => s.accIdx === 0).taken;
    const slowTaken = out.stats.perSession.find((s) => s.accIdx === 1).taken;
    assert.ok(
        fastTaken > slowTaken,
        `fast session should take more than slow; got fast=${fastTaken} slow=${slowTaken}`,
    );
    // With ratio 10×, fast should grab ~18/20.
    assert.ok(
        fastTaken >= N / 2 + 3,
        `fast session should take meaningfully > half; got fast=${fastTaken}/${N}`,
    );
    assert.strictEqual(fastTaken + slowTaken, N);
});

test('per-session concurrency multiplies in-flight items', async () => {
    // Snapshot the maximum number of concurrent processOne calls.
    // With M=2 sessions × C=3 workers each, peak should be 6.
    let inFlight = 0;
    let maxInFlight = 0;
    const N = 30;
    const items = Array.from({ length: N }, (_, i) => i);
    await runFanOut({
        sessions: [{ accIdx: 0 }, { accIdx: 1 }],
        items,
        processOne: async () => {
            inFlight++;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await sleep(5);
            inFlight--;
            return { success: true };
        },
        perSessionConcurrency: 3,
        workerStaggerMs: 0,
    });
    assert.ok(
        maxInFlight >= 5,
        `expected ≥5 concurrent (2×3=6, allow 1 slack); saw ${maxInFlight}`,
    );
});

// ─── Cancellation ────────────────────────────────────────────────

test('cancellation: workers stop pulling once isCancelled() returns true', async () => {
    let cancelled = false;
    const seen = [];
    const N = 50;
    const items = Array.from({ length: N }, (_, i) => i);
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }, { accIdx: 1 }],
        items,
        processOne: async (_item, _session, idx) => {
            seen.push(idx);
            await sleep(2);
            // Cancel after we've started processing a few items.
            if (seen.length >= 6) cancelled = true;
            return { success: true };
        },
        isCancelled: () => cancelled,
        perSessionConcurrency: 2,
        workerStaggerMs: 0,
    });
    // We should NOT have processed all 50 items.
    assert.ok(seen.length < N, `cancelled run still processed all ${N} items`);
    // The unfinished slots should be `undefined`.
    const filledSlots = out.results.filter((r) => r !== undefined).length;
    assert.strictEqual(filledSlots, seen.length);
});

// ─── Failure handling ─────────────────────────────────────────────

test('processOne throwing is caught and recorded as failure', async () => {
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }],
        items: ['ok', 'boom', 'ok2'],
        processOne: async (item) => {
            if (item === 'boom') throw new Error('kaboom');
            return { success: true, item };
        },
        perSessionConcurrency: 1,
        workerStaggerMs: 0,
    });
    assert.strictEqual(out.results[1].success, false);
    assert.match(out.results[1].error, /kaboom/);
    assert.strictEqual(out.stats.perSession[0].ok, 2);
    assert.strictEqual(out.stats.perSession[0].failed, 1);
});

test('falsy result counts as failure', async () => {
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }],
        items: ['a', 'b'],
        processOne: async (item) => (item === 'a' ? { success: true } : null),
        perSessionConcurrency: 1,
        workerStaggerMs: 0,
    });
    assert.strictEqual(out.stats.perSession[0].ok, 1);
    assert.strictEqual(out.stats.perSession[0].failed, 1);
});

// ─── Quarantine ──────────────────────────────────────────────────

test('quarantine after N consecutive failures: bad session stops pulling', async () => {
    // Session 0 always fails; session 1 always succeeds.
    // With maxConsecutiveFailures=3, session 0 should quarantine
    // after 3 takes. Session 1 should pick up all remaining work.
    const N = 30;
    const items = Array.from({ length: N }, (_, i) => i);
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }, { accIdx: 1 }],
        items,
        processOne: async (_item, session, _idx) => {
            await sleep(2);
            return session.accIdx === 0
                ? { success: false, error: 'rate-limited' }
                : { success: true };
        },
        perSessionConcurrency: 1,
        maxConsecutiveFailures: 3,
        workerStaggerMs: 0,
    });
    const bad = out.stats.perSession.find((s) => s.accIdx === 0);
    const good = out.stats.perSession.find((s) => s.accIdx === 1);
    assert.strictEqual(bad.quarantined, true);
    assert.ok(bad.taken <= 3, `bad session should not have taken more than 3 (took ${bad.taken})`);
    assert.strictEqual(good.quarantined, false);
    assert.ok(good.taken >= N - 3, `good session should drain remaining (took ${good.taken}/${N})`);
});

test('successes reset the consecutive-failure counter (no quarantine)', async () => {
    // Pattern: fail, ok, fail, ok, fail, ok, ... — should NEVER
    // hit ``maxConsecutiveFailures=2`` because the streak resets
    // on every success.
    const N = 10;
    const items = Array.from({ length: N }, (_, i) => i);
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }],
        items,
        processOne: async (_item, _session, idx) => ({ success: idx % 2 === 1 }),
        perSessionConcurrency: 1,
        maxConsecutiveFailures: 2,
        workerStaggerMs: 0,
    });
    assert.strictEqual(out.stats.perSession[0].quarantined, false);
    assert.strictEqual(out.stats.perSession[0].taken, N);
});

test('requeueOnSessionQuarantine: failed item is retried on a different session', async () => {
    // Session 0 fails the only item it touches. Session 1 succeeds.
    // With requeue, the failed item is pushed back and ends up in
    // results[] as a SUCCESS (handled by session 1).
    let retried = false;
    const out = await runFanOut({
        sessions: [{ accIdx: 0, badness: true }, { accIdx: 1 }],
        items: ['only-item'],
        processOne: async (_item, session) => {
            if (session.badness) {
                return { success: false, error: 'bad-session' };
            }
            retried = true;
            return { success: true, retried: true };
        },
        perSessionConcurrency: 1,
        maxConsecutiveFailures: 1,
        requeueOnSessionQuarantine: true,
        workerStaggerMs: 0,
    });
    assert.strictEqual(retried, true);
    assert.strictEqual(out.results[0].success, true);
    assert.strictEqual(out.results[0].retried, true);
    const bad = out.stats.perSession.find((s) => s.accIdx === 0);
    assert.strictEqual(bad.quarantined, true);
});

// ─── onProgress ──────────────────────────────────────────────────

test('onProgress is called once per item with the right shape', async () => {
    const items = ['a', 'b', 'c'];
    const events = [];
    await runFanOut({
        sessions: [{ accIdx: 7 }],
        items,
        processOne: async (item) => ({ success: true, item }),
        perSessionConcurrency: 1,
        onProgress: (ev) => events.push(ev),
        workerStaggerMs: 0,
    });
    assert.strictEqual(events.length, items.length);
    for (const ev of events) {
        assert.ok(items.includes(ev.item));
        assert.strictEqual(typeof ev.idx, 'number');
        assert.strictEqual(ev.session.accIdx, 7);
        assert.strictEqual(ev.sessionIdx, 0);
        assert.strictEqual(ev.result.success, true);
    }
});

test('onProgress throwing does not crash the batch', async () => {
    const out = await runFanOut({
        sessions: [{ accIdx: 0 }],
        items: ['a', 'b'],
        processOne: async () => ({ success: true }),
        perSessionConcurrency: 1,
        onProgress: () => { throw new Error('progress blew up'); },
        workerStaggerMs: 0,
    });
    assert.strictEqual(out.results.length, 2);
    assert.strictEqual(out.stats.perSession[0].ok, 2);
});

// ─── Runner ──────────────────────────────────────────────────────

(async () => {
    let passed = 0;
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ok  ${t.name}`);
            passed++;
        } catch (err) {
            console.error(`  FAIL ${t.name}`);
            console.error('       ' + (err && err.stack ? err.stack : err));
            failed++;
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
