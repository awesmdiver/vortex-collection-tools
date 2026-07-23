'use strict';
// Generic Server-Sent-Events session: event buffering + replay + broadcast, reusable for both
// "computing a plan" and "running a rebuild" progress streams (web/routes.js creates one instance
// of each). See run-state.js's original header for the race-safety rationale: emit() pushes into
// the buffer THEN writes to every attached response with no `await` in between -- Node is
// single-threaded and run-to-completion, so there's no window where an event could be missed by
// both the buffer and a live push. subscribe() replays the buffer (tagged with `id:` for the
// browser's native EventSource Last-Event-ID reconnect) before registering for live pushes -- a
// client that attaches even slightly late, or reconnects mid-stream, never misses anything.

function createSseSession() {
    let session = null; // { id, phase, eventBuffer: [], subscribers: Set<res>, seq }

    function isActive() {
        return session !== null && session.phase !== 'done' && session.phase !== 'error';
    }

    function get() {
        return session;
    }

    function start({ id }) {
        session = { id, phase: 'starting', eventBuffer: [], subscribers: new Set(), seq: 0 };
        return session;
    }

    function emit(event) {
        if (!session) return;
        session.seq += 1;
        const frame = { seq: session.seq, ts: new Date().toISOString(), ...event };
        if (event.type === 'phase') session.phase = event.phase;
        if (event.done) session.phase = event.error ? 'error' : 'done';
        session.eventBuffer.push(frame);

        const payload = `id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`;
        for (const res of session.subscribers) {
            try {
                res.write(payload);
            } catch {
                session.subscribers.delete(res);
            }
        }
    }

    function subscribe(res, { afterSeq = 0 } = {}) {
        if (!session) return;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        for (const frame of session.eventBuffer) {
            if (frame.seq <= afterSeq) continue;
            res.write(`id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`);
        }
        session.subscribers.add(res);
        const keepAlive = setInterval(() => {
            try {
                res.write(':\n\n');
            } catch {
                clearInterval(keepAlive);
            }
        }, 15000);
        res.on('close', () => {
            clearInterval(keepAlive);
            if (session) session.subscribers.delete(res);
        });
    }

    return { isActive, get, start, emit, subscribe };
}

module.exports = { createSseSession };
