'use strict';
// Single-run-at-a-time tracking for the actual rebuild (destructive) phase, built on the generic
// SSE session helper (sse-session.js). This is a personal, local, single-user tool -- one
// collection rebuild at a time is all that's ever needed, so a second run is refused (409) rather
// than queued. (Plan computation, by contrast, is read-only and doesn't need this guard -- see
// web/routes.js's separate planSession, also built on sse-session.js.)

const { createSseSession } = require('./sse-session');

const session = createSseSession();

function isRunActive() {
    return session.isActive();
}

function getCurrentRun() {
    const s = session.get();
    if (!s) return null;
    return { runId: s.id, collectionModId: s.collectionModId, phase: s.phase, eventBuffer: s.eventBuffer };
}

function startRun({ runId, collectionModId }) {
    if (session.isActive()) {
        const active = session.get();
        const err = new Error(`A run is already in progress (collection "${active.collectionModId}").`);
        err.code = 'RUN_ACTIVE';
        throw err;
    }
    const s = session.start({ id: runId });
    s.collectionModId = collectionModId;
    return s;
}

function emit(event) {
    // Runs use a richer set of "this is done" markers than the generic session's default
    // `event.done` -- translate them here so sse-session.js stays free of run-specific knowledge.
    const done = event.type === 'run-complete' || event.type === 'run-error';
    session.emit({ ...event, done, error: event.type === 'run-error' });
}

function subscribe(res, opts) {
    session.subscribe(res, opts);
}

module.exports = { isRunActive, getCurrentRun, startRun, emit, subscribe };
