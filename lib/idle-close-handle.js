'use strict';
// Generic "open lazily, close after a period of inactivity" wrapper for a resource with its own
// open()/close() (a database connection, here -- see web/archive-finder-routes.js). Exists as its
// own small module so the idle-close TIMING logic itself -- the actual fix for GitHub issue #4, a
// handle that must not survive an idle server -- is independently testable with a short delay
// (scripts/test-idle-close-handle.js), rather than living inline in a route file where only the
// real 5-minute production delay could ever be exercised in a test.

// open()/close() are plain sync functions (this project's `node:sqlite` usage is fully sync
// throughout). isBusy() lets a caller defer closing while some OTHER long-running operation still
// holds its own direct reference to the same instance (e.g. an in-progress scan) -- checked INSIDE
// the timer callback, not just at schedule time, since the busy state can still be true when the
// timer finally fires even though it wasn't when it was scheduled.
function createIdleCloseHandle({ idleMs, open, close, isBusy = () => false }) {
    let instance = null;
    let openError = null;
    let idleTimer = null;

    function scheduleClose() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (isBusy()) {
                scheduleClose(); // don't close now -- check again after the same window
                return;
            }
            if (instance) {
                close(instance);
                instance = null;
            }
            openError = null; // a fresh open attempt gets a fresh chance next time, not a cached failure forever
        }, idleMs);
        idleTimer.unref?.(); // never itself keeps the process alive
    }

    // Returns the open instance, opening it first if needed, and resets the idle clock either way.
    // Returns null (never throws) if the last open attempt failed -- getError() below reports why,
    // without retrying that failing open on every single call.
    function get() {
        if (instance) {
            scheduleClose();
            return instance;
        }
        if (openError) return null;
        try {
            instance = open();
        } catch (e) {
            openError = e;
            return null;
        }
        scheduleClose();
        return instance;
    }

    function getError() {
        return openError;
    }

    // Restarts the idle clock from NOW without opening/touching openness state -- for a caller
    // whose own long-running operation keeps its OWN direct reference to `instance` (so it never
    // calls get() again mid-operation) and only wants to mark real activity at specific moments
    // (e.g. when that operation finishes), rather than have the clock run out from whenever get()
    // was last called at the very start.
    function touch() {
        if (instance) scheduleClose();
    }

    // For tests only -- lets a test assert the handle is genuinely closed without waiting on a
    // production-scale idleMs.
    function isOpenForTest() {
        return instance !== null;
    }

    return { get, getError, touch, isOpenForTest };
}

module.exports = { createIdleCloseHandle };
