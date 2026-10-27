'use strict';
// Paces and measures every call a long job (the apply, Continue Update) makes to the Vortex Bridge (2026-10-24).
//
// WHY: Vortex answers the Bridge on its one main thread, so every call queues behind Vortex's own work and behind
// our other calls; a timeout does not cancel the work, it only stops us waiting for it. Director, GTS Jelly rev 40:
// "I wonder if we are creating the slowness by too many requests." An earlier apply logged 387 timeouts in one run.
// So, while a "session" is open:
//   * ONE call is in flight at a time (a queue). A caller that is meant to run beside the others says `parallel`.
//   * A shared cool-down: after a timeout every call waits before it goes (2 s, doubling to 20 s on each further
//     timeout); each fast answer halves it, back to 0. The per-call "wait, then retry" in bridgeFetch stays as the inner step.
//   * A poll whose only job is a progress read is skipped while Vortex is slow, and never runs more often than 3 s.
//   * Every call is counted by route and by phase (answered, timed out, slowest, time waiting) in one summary block.
// Outside a session nothing here changes how a call behaves, so the other tools are untouched.

const COOLDOWN_START_MS = 2000;
const COOLDOWN_MAX_MS = 20_000;
const COOLDOWN_FLOOR_MS = 500; // halving below this means "back to 0"
const FAST_ANSWER_MS = 1500;
const MIN_POLL_GAP_MS = 3000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same route written once, whatever the mod or plugin in it.
function routeOf(method, path) {
    let p = String(path || '').split('?')[0];
    p = p.replace(/^\/rules\/(?!apply)[^/]+$/, '/rules/:modId').replace(/^\/plugins\/[^/]+/, '/plugins/:name');
    return `${method || 'GET'} ${p}`;
}

function newBucket() { return { calls: 0, answered: 0, timedOut: 0, refused: 0, slowestMs: 0, totalMs: 0 }; }
function addTo(bucket, res, ms) {
    bucket.calls += 1;
    bucket.totalMs += ms;
    if (ms > bucket.slowestMs) bucket.slowestMs = ms;
    if (res.timedOut) bucket.timedOut += 1;
    else if (res.networkFailure) bucket.refused += 1;
    else bucket.answered += 1;
}

function createBridgeLimiter({ now = () => Date.now(), sleepFn = realSleep } = {}) {
    let depth = 0;
    let opts = { serialize: true, ease: true };
    let stats = null;
    let phase = 'start';

    // the line
    let held = false;
    const waiters = [];
    let inFlight = 0;
    let queued = 0;

    // the shared cool-down
    let cooldownMs = 0;
    let coolUntil = 0;
    const lastPollAt = new Map();

    function freshStats(label) {
        return {
            label, startedAt: now(), endedAt: null, calls: 0, answered: 0, timedOut: 0, refused: 0, waitedMs: 0,
            slowestMs: 0, slowestRoute: null, slowestPhase: null,
            maxInFlightAtTimeout: 0, maxQueuedAtTimeout: 0, timeoutsWithOthersInFlight: 0,
            cooldownWaitedMs: 0, maxCooldownMs: 0, pollsSkipped: 0,
            byRoute: {}, byPhase: {},
        };
    }

    async function acquire() {
        if (!held) { held = true; return; }
        await new Promise((resolve) => waiters.push(resolve));
    }
    function release() {
        const next = waiters.shift();
        if (next) next(); // the slot passes straight on
        else held = false;
    }

    function isSlow() { return depth > 0 && now() < coolUntil; }

    function afterCall(res, ms, route, queuedBehind) {
        if (stats) {
            stats.calls += 1;
            stats.waitedMs += ms;
            if (res.timedOut) stats.timedOut += 1;
            else if (res.networkFailure) stats.refused += 1;
            else stats.answered += 1;
            if (ms > stats.slowestMs) { stats.slowestMs = ms; stats.slowestRoute = route; stats.slowestPhase = phase; }
            addTo(stats.byRoute[route] || (stats.byRoute[route] = newBucket()), res, ms);
            addTo(stats.byPhase[phase] || (stats.byPhase[phase] = newBucket()), res, ms);
            if (res.timedOut) {
                const others = inFlight; // this call has already left the count
                if (others > 0) stats.timeoutsWithOthersInFlight += 1;
                if (others + 1 > stats.maxInFlightAtTimeout) stats.maxInFlightAtTimeout = others + 1;
                if (queuedBehind > stats.maxQueuedAtTimeout) stats.maxQueuedAtTimeout = queuedBehind;
            }
        }
        if (!opts.ease) return;
        if (res.timedOut) {
            cooldownMs = cooldownMs > 0 ? Math.min(cooldownMs * 2, COOLDOWN_MAX_MS) : COOLDOWN_START_MS;
            coolUntil = now() + cooldownMs;
            if (stats && cooldownMs > stats.maxCooldownMs) stats.maxCooldownMs = cooldownMs;
        } else if (!res.networkFailure && ms < FAST_ANSWER_MS && cooldownMs > 0) {
            cooldownMs = Math.floor(cooldownMs / 2);
            if (cooldownMs < COOLDOWN_FLOOR_MS) { cooldownMs = 0; coolUntil = 0; }
        }
    }

    // task: async () => { ok, timedOut, networkFailure, ... } (one bridgeFetchOnce attempt). Outside a session it is just run.
    async function run({ method, path, parallel = false }, task) {
        if (depth === 0) return task();
        const route = routeOf(method, path);
        const lined = opts.serialize && !parallel;
        queued += 1;
        if (lined) await acquire();
        queued -= 1;
        let res;
        let ms = 0;
        try {
            if (opts.ease) {
                const wait = coolUntil - now();
                if (wait > 0) {
                    await sleepFn(wait);
                    if (stats) stats.cooldownWaitedMs += wait;
                }
            }
            inFlight += 1;
            const t0 = now();
            try {
                res = await task();
            } finally {
                inFlight -= 1;
                ms = now() - t0;
            }
            afterCall(res, ms, route, queued);
            return res;
        } finally {
            if (lined) release();
        }
    }

    function beginSession(label, options) {
        depth += 1;
        if (depth === 1) {
            opts = { serialize: true, ease: true, ...(options || {}) };
            stats = freshStats(label);
            phase = 'start';
            cooldownMs = 0;
            coolUntil = 0;
            lastPollAt.clear();
        }
    }
    function endSession() {
        if (depth === 0) return null;
        depth -= 1;
        if (depth > 0) return null;
        const done = stats;
        done.endedAt = now();
        stats = null;
        return done;
    }
    function setPhase(name) { if (depth > 0 && name) phase = String(name).replace(/\d+/g, 'N').slice(0, 80); }

    // True = skip this poll. A poll whose only job is a progress read waits while Vortex is slow, and runs at most every 3 s.
    function shouldSkipPoll(key) {
        if (depth === 0) return false;
        const t = now();
        const last = lastPollAt.get(key);
        if ((last !== undefined && t - last < MIN_POLL_GAP_MS) || (opts.ease && t < coolUntil)) {
            if (stats) stats.pollsSkipped += 1;
            return true;
        }
        lastPollAt.set(key, t);
        return false;
    }

    function snapshot() {
        if (!stats) return null;
        return JSON.parse(JSON.stringify({ ...stats, endedAt: stats.endedAt || now() }));
    }

    return {
        beginSession, endSession, setPhase, run, shouldSkipPoll, snapshot, isSlow,
        isActive: () => depth > 0,
        _state: () => ({ depth, inFlight, queued, cooldownMs, coolUntil, held }),
    };
}

function fmtSeconds(ms) {
    return ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

// One block for the log: totals, then each route and each phase.
function formatBridgeStats(s) {
    const lines = [];
    lines.push(`[bridge-stats] ${s.label}: ${s.calls} call${s.calls === 1 ? '' : 's'} to Vortex (${s.answered} answered, ${s.timedOut} timed out, ${s.refused} refused), `
        + `${fmtSeconds(s.waitedMs)} spent waiting on Vortex, slowest ${fmtSeconds(s.slowestMs)}${s.slowestRoute ? ` (${s.slowestRoute} during "${s.slowestPhase}")` : ''}.`);
    lines.push(`[bridge-stats]   at a timeout: most calls in flight ${s.maxInFlightAtTimeout}, most waiting in line ${s.maxQueuedAtTimeout}, `
        + `${s.timeoutsWithOthersInFlight} timeout${s.timeoutsWithOthersInFlight === 1 ? '' : 's'} with another call in flight at the same moment. `
        + `Cool-down: waited ${fmtSeconds(s.cooldownWaitedMs)} in total, longest ${fmtSeconds(s.maxCooldownMs)}. Polls skipped: ${s.pollsSkipped}.`);
    const row = (name, b) => `[bridge-stats]   ${name}: ${b.calls} calls, ${b.answered} answered, ${b.timedOut} timed out, slowest ${fmtSeconds(b.slowestMs)}, ${fmtSeconds(b.totalMs)} waiting`;
    lines.push('[bridge-stats]  by route:');
    for (const [k, b] of Object.entries(s.byRoute).sort((a, c) => c[1].calls - a[1].calls)) lines.push(row(k, b));
    lines.push('[bridge-stats]  by phase:');
    for (const [k, b] of Object.entries(s.byPhase).sort((a, c) => c[1].calls - a[1].calls)) lines.push(row(k, b));
    return lines.join('\n');
}

module.exports = {
    createBridgeLimiter, formatBridgeStats, routeOf,
    COOLDOWN_START_MS, COOLDOWN_MAX_MS, FAST_ANSWER_MS, MIN_POLL_GAP_MS,
};
