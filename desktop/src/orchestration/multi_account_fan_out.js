/**
 * multi_account_fan_out.js — work-stealing scheduler for spreading
 * a batch of items across multiple authenticated Grok sessions.
 *
 * Why this exists
 * ---------------
 * Earlier batched IPC handlers (`image:generate`, `video:generate`,
 * `i2v:generate`, `refimg:generate`) split a list of N prompts into
 * ``Math.ceil(N / sessions.length)``-sized slices and dispatched
 * each slice to one session via ``Service.generateBatch``. That
 * static slicing left throughput on the table whenever the per-
 * account latency was uneven:
 *
 *   - Account A finishes its 5 items in 30 s.
 *   - Account B is rate-limited / has cold cookies / is on a
 *     slower geo and takes 90 s for its 5 items.
 *   - Total wall time = 90 s. Account A is idle for 60 s.
 *
 * With a shared work queue, the moment Account A finishes an item
 * it pulls the next one — Account B contributes whatever it can
 * without holding back the rest of the batch.
 *
 * The scheduler is a pure JS module — it knows nothing about
 * Electron, Grok, or what an "item" is. The caller injects a
 * ``processOne(item, session, idx)`` function and the scheduler
 * orchestrates concurrency, work-stealing, and per-session
 * health.
 *
 * Public API
 * ----------
 *
 *   const { runFanOut } = require('multi_account_fan_out');
 *   const { results, stats } = await runFanOut({
 *       sessions,            // array of {accIdx, ...} session objects
 *       items,               // array of items to process
 *       processOne,          // async (item, session, idx) => result
 *       perSessionConcurrency: 30,
 *       onProgress,          // optional ({item, idx, result, session, sessionIdx})
 *       isCancelled,         // optional () => boolean
 *       maxConsecutiveFailures, // optional integer; quarantine after N
 *       requeueOnSessionQuarantine, // optional bool; default false
 *       workerStaggerMs,     // optional, default 75
 *   });
 *
 * Returns
 *   {
 *     results: Array<result>,    // index-aligned with items
 *     stats: {
 *       perSession: Array<{
 *         accIdx, taken, ok, failed,
 *         consecutiveFailures, quarantined
 *       }>,
 *     },
 *   }
 *
 * Semantics
 * ---------
 *
 * - The shared queue is a monotonically-increasing index. Workers
 *   atomically take the next index by post-incrementing a closed-
 *   over counter. JS is single-threaded, so the post-increment is
 *   safe between awaits.
 *
 * - Each session spawns ``perSessionConcurrency`` workers. With
 *   M sessions and C workers each, peak parallelism is M × C.
 *
 * - Workers are staggered by ``workerStaggerMs`` so the first
 *   wave doesn't hammer Grok with M × C simultaneous requests
 *   (this matches the existing 75 ms stagger in
 *   ``ImageService.generateBatch``).
 *
 * - ``maxConsecutiveFailures`` quarantines a session after N
 *   consecutive failures. Quarantined sessions stop pulling new
 *   work; in-flight items continue.
 *
 * - ``requeueOnSessionQuarantine`` (default false) — when a
 *   session is quarantined, any items it had already taken
 *   that resolved as failures are NOT automatically re-tried.
 *   When true, those failed items are pushed back into the
 *   queue so a healthy session can retry them. Items that
 *   succeeded are kept regardless.
 *
 * - Cancellation: workers check ``isCancelled()`` before pulling
 *   the next item. In-flight items continue to completion (the
 *   scheduler does not abort the underlying ``processOne``).
 *
 * Failure model
 * -------------
 *
 * - A "failure" is either:
 *   1. ``processOne`` resolves to a falsy value, or
 *   2. ``processOne`` resolves to ``{ success: false, ... }``, or
 *   3. ``processOne`` throws.
 *
 * - On (3) the scheduler catches and writes
 *   ``{ success: false, error: <message> }`` into ``results``.
 *
 * - ``results`` is index-aligned with ``items``. Slots that were
 *   never reached (because every session was quarantined before
 *   they could be taken) stay ``undefined`` — caller can detect
 *   this and surface it as a partial-batch warning.
 */

'use strict';

/**
 * Schedule ``items`` across ``sessions`` using a shared work
 * queue. See module docs for details.
 *
 * @param {object} opts
 * @returns {Promise<{
 *   results: Array<any>,
 *   stats: { perSession: Array<object> },
 * }>}
 */
async function runFanOut(opts) {
    const {
        sessions,
        items,
        processOne,
        perSessionConcurrency = 30,
        onProgress = null,
        isCancelled = null,
        maxConsecutiveFailures = null,
        requeueOnSessionQuarantine = false,
        workerStaggerMs = 75,
    } = opts || {};

    if (!Array.isArray(sessions) || sessions.length === 0) {
        throw new Error('multi_account_fan_out: sessions array is empty');
    }
    if (typeof processOne !== 'function') {
        throw new Error('multi_account_fan_out: processOne callback is required');
    }
    if (!Array.isArray(items)) {
        throw new Error('multi_account_fan_out: items must be an array');
    }

    const N = items.length;
    if (N === 0) {
        return {
            results: [],
            stats: {
                perSession: sessions.map((s) => ({
                    accIdx: typeof s.accIdx === 'number' ? s.accIdx : null,
                    taken: 0,
                    ok: 0,
                    failed: 0,
                    consecutiveFailures: 0,
                    quarantined: false,
                })),
            },
        };
    }

    // Shared queue of ORIGINAL item indices. We start with [0..N).
    // The scheduler pops from the FRONT (FIFO); requeued items go
    // to the BACK so they're tried last (reduces head-of-line
    // blocking on a flaky item).
    const queue = [];
    for (let i = 0; i < N; i++) queue.push(i);

    const results = new Array(N);
    const sessionStats = sessions.map((s) => ({
        accIdx: typeof s.accIdx === 'number' ? s.accIdx : null,
        taken: 0,
        ok: 0,
        failed: 0,
        consecutiveFailures: 0,
        quarantined: false,
    }));

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const cancelled = () => {
        if (typeof isCancelled !== 'function') return false;
        try {
            return Boolean(isCancelled());
        } catch (_) {
            return false;
        }
    };

    // ``inFlight`` is the count of items currently being processed.
    // Workers exit only when ``queue`` is empty AND ``inFlight`` is
    // zero — otherwise a quarantine-triggered requeue could push an
    // item back into the queue after every other worker had already
    // observed an empty queue and bailed.
    let inFlight = 0;
    // Coarse poll interval for the "queue is empty but might refill"
    // wait. Small enough to be invisible at human-scale, large enough
    // to not burn CPU when nothing's happening.
    const IDLE_POLL_MS = 5;

    /**
     * One worker bound to a single session. Pulls items from the
     * shared ``queue`` until it's empty (or its session is
     * quarantined / the batch is cancelled).
     */
    const sessionWorker = async (session, sessionIdx, workerIdx) => {
        if (workerStaggerMs > 0) {
            await sleep(workerIdx * workerStaggerMs);
        }
        while (true) {
            if (cancelled()) return;
            const stat = sessionStats[sessionIdx];
            if (stat.quarantined) return;

            if (queue.length === 0) {
                // Drained for good only when no other worker has an
                // item in flight (which could requeue on quarantine).
                if (inFlight === 0) return;
                await sleep(IDLE_POLL_MS);
                continue;
            }

            const myIdx = queue.shift();
            if (typeof myIdx !== 'number') continue;

            stat.taken++;
            inFlight++;
            const item = items[myIdx];

            let result;
            let threw = false;
            try {
                result = await processOne(item, session, myIdx);
            } catch (err) {
                threw = true;
                const msg = (err && err.message) ? err.message : String(err);
                result = { success: false, error: msg };
            }
            // NOTE: ``inFlight`` is decremented at the very end of
            // this iteration — AFTER the success/failure +
            // requeue + onProgress logic. This is what lets a
            // sibling worker observe ``inFlight > 0`` while the
            // current worker is still in the process of pushing a
            // requeued item back onto the queue.

            // Normalise the success flag. ``processOne`` may return:
            //   - falsy  → treated as failure
            //   - { success: bool, ... } → respected as-is
            //   - any other truthy object → treated as success
            const ok = !threw
                && result
                && (typeof result === 'object' ? result.success !== false : true);

            results[myIdx] = result;

            if (ok) {
                stat.ok++;
                stat.consecutiveFailures = 0;
            } else {
                stat.failed++;
                stat.consecutiveFailures++;
                if (
                    typeof maxConsecutiveFailures === 'number'
                    && maxConsecutiveFailures > 0
                    && stat.consecutiveFailures >= maxConsecutiveFailures
                ) {
                    stat.quarantined = true;
                    if (requeueOnSessionQuarantine) {
                        // Push the just-failed item back so a
                        // healthy session can retry. We do NOT
                        // push items that were taken earlier —
                        // those already settled in ``results``.
                        results[myIdx] = undefined;
                        queue.push(myIdx);
                    }
                }
            }

            if (typeof onProgress === 'function') {
                try {
                    onProgress({
                        item,
                        idx: myIdx,
                        result,
                        session,
                        sessionIdx,
                    });
                } catch (_) {
                    // onProgress errors must not crash the scheduler.
                }
            }

            // Drop the in-flight counter only after the
            // success/failure/requeue accounting has settled. A
            // sibling worker that polls between ``queue.shift()``
            // and this decrement still sees ``inFlight > 0`` and
            // keeps spinning, so a requeue (which lands in
            // ``queue`` above) cannot be missed.
            inFlight--;
        }
    };

    const workers = [];
    const concurrency = Math.max(1, perSessionConcurrency);
    for (let s = 0; s < sessions.length; s++) {
        const c = Math.min(concurrency, N);
        for (let w = 0; w < c; w++) {
            workers.push(sessionWorker(sessions[s], s, w));
        }
    }
    await Promise.all(workers);

    return {
        results,
        stats: { perSession: sessionStats },
    };
}

module.exports = { runFanOut };
