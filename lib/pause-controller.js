'use strict';
// Small, event-driven pause/resume state machine for a single active Rebuild Collection run. One
// instance per run -- created fresh in web/rebuild-routes.js's run handler, not a shared singleton,
// so the next run always starts with a clean controller (mirrors the existing per-run
// haltedCritical/nextIndex closures already local to lib/collection-runner.js's runRebuild).
//
// Deliberately event-driven (waitForChange()'s promise), not polled on a timer -- the extraction
// loop just awaits it, at zero CPU cost while idle, and wakes immediately the moment any of
// requestPause/cancelPause/confirmPause fire.
//
// States: 'running' (workers pulling new work normally) -> 'draining' (pause requested -- no NEW
// work is pulled, but in-flight rebuildMod() calls always run to completion, same "only ever stops
// PULLING new work" safety story this project's existing haltedCritical flag already documents) ->
// either back to 'running' (cancelPause -- confirmed with the user this must fully resume, not just
// dismiss a popup) or forward to 'paused' (confirmPause, terminal -- a fresh controller is needed
// for the next run; there is no path back from 'paused').
function createPauseController() {
  let state = 'running';
  let inFlight = 0;
  let waiter = null; // resolves the current waitForChange() promise, if anyone's awaiting one

  function wake() {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve();
    }
  }

  return {
    getState() { return state; },
    isPaused() { return state !== 'running'; },
    getInFlightCount() { return inFlight; },

    requestPause() {
      if (state === 'running') { state = 'draining'; wake(); }
    },
    // Only meaningful while draining -- a no-op from 'running' (nothing to cancel) or 'paused'
    // (already finalized; resuming a fully-paused run is a fresh Resume from the picker, not this
    // control).
    cancelPause() {
      if (state === 'draining') { state = 'running'; wake(); }
    },
    // Authoritative server-side guard, mirroring this project's existing "don't trust the caller"
    // discipline (e.g. vortex-sync/lib.js's assertRulesShapeKnown) -- the UI already disables its
    // own OK button until in-flight hits 0, this is defense in depth for the rare race where a mod
    // finishes a beat after the client thought it already had.
    confirmPause() {
      if (state !== 'draining') {
        throw new Error(`Cannot confirm pause from state "${state}" -- pause must be requested first.`);
      }
      if (inFlight !== 0) {
        throw new Error(`${inFlight} extraction(s) are still in progress -- wait for them to finish before confirming.`);
      }
      state = 'paused';
      wake();
    },

    markStarted() { inFlight += 1; },
    markFinished() { inFlight = Math.max(0, inFlight - 1); },

    // Resolves the next time state or inFlight changes. Only one waiter is ever needed in practice
    // (the single extraction loop awaiting it) -- a second call before the first resolves replaces
    // it rather than stacking, which is fine since there's only ever one caller.
    waitForChange() {
      return new Promise((resolve) => { waiter = resolve; });
    },
  };
}

module.exports = { createPauseController };
