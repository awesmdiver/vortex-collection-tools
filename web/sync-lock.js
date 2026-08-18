'use strict';
// Prevents two live WRITE operations (apply-ignores or apply-disables, real applies) from running
// concurrently. Unlike the Rebuild Collection flow's run-state.js, this flow's operations are each
// a single atomic backend call (not a multi-step loop with real incremental progress to stream), so
// this is a plain in-memory lock rather than a full SSE session -- there's nothing meaningful to
// stream mid-operation. Read-only steps (collections list, backup preview/capture, apply-ignores/
// apply-disables dry-run previews, compare) don't need this guard at all.

let active = null; // { kind: 'apply-ignores' | 'apply-disables', startedAt }

function isLocked() {
    return active !== null;
}

function acquire(kind) {
    if (active) {
        const err = new Error(`A write operation ("${active.kind}") is already in progress. Wait for it to finish.`);
        err.code = 'SYNC_WRITE_ACTIVE';
        throw err;
    }
    active = { kind, startedAt: new Date().toISOString() };
}

function release() {
    active = null;
}

module.exports = { isLocked, acquire, release };
