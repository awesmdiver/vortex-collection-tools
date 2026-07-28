# Rebuild Collection — Pause/Resume Extraction

## Context

A large collection can take hours to extract. The user wants to be able to **pause** an in-progress
extraction (finish whatever's currently running, don't start anything new), close the app, and come
back later to resume exactly where it left off — with a clear "hey, you left this paused" prompt on
the "Choose a collection" home page, since more than one collection could be sitting paused at once.

Research before this plan confirmed something important: **the resume mechanism this needs already
exists almost entirely.** `lib/collection-runner.js`'s `RESUMABLE_STATUSES` + `loadResumeLog()` +
`buildPlan()`'s resumed-mod short-circuit, and `web/rebuild-routes.js`'s `findResumableLog()` +
the existing "Resume from previous incomplete run" checkbox/`resumeLogPath` flow (`app.js`'s
`openPlan()`), already do everything needed to pick up a partially-done run from its log file — a
log is already written to disk after **every single mod** completes (`onModComplete` →
`runner.writeLog(logPath, currentLog('in-progress'))`, `rebuild-routes.js:614`), so the "what's
already done, what's left" checkpoint is already continuously saved with zero new code. The real
gaps are narrower than they first look:
1. A way to gracefully stop new extractions from starting mid-run (today, a run only ever stops via
   `CRITICAL_MANUAL_RESTORE_NEEDED` or the whole process dying — no pause exists at all).
2. Marking a log `'paused'` (a new, distinct `runStatus`) instead of leaving it `'in-progress'`, so
   the home page can tell "deliberately paused" apart from "crashed/interrupted."
3. A more visible home-page prompt than today's quiet "— Resumable" dropdown suffix.
4. A discard action that stops offering resume without touching any files.

Confirmed with the user before designing the concurrency change: **Cancel (in the pause popup) must
truly resume full concurrency immediately** — "we continue extraction like nothing happened until
fully completed or the user hits pause again." Only clicking "OK" actually finalizes the pause. This
means workers that already went idle while waiting to drain must be revivable, not just left stopped
— see the pause controller design below for how this is done without polling or unsafe concurrency
changes to the existing, well-tested worker-pool loop.

## Design

### Pause controller — new, small, event-driven (no polling)

A tiny new module (e.g. `lib/pause-controller.js`) tracks three things for the current run: a
`state` (`'running' | 'draining' | 'paused'`), an in-flight counter, and a way to wake up anyone
waiting on a state change without polling:
- `requestPause()` — `running → draining`. Wakes waiters.
- `cancelPause()` — `draining → running` (no-op/error from any other state). Wakes waiters.
- `confirmPause()` — `draining → paused`, but only accepted if the in-flight counter is actually 0
  (authoritative server-side check — the UI already disables OK until then, this is defense in
  depth, mirroring `assertRulesShapeKnown`-style "don't trust the caller" checks already used
  elsewhere in this project). Wakes waiters.
- `markStarted()` / `markFinished()` — in-flight counter, called from the same place
  `onModStart`/`onModComplete` already fire.
- `waitForChange()` — returns a promise that resolves the next time any of the above fire. Internal
  use only (the extraction loop awaits this instead of polling on a timer).

### `runRebuild()` (`lib/collection-runner.js`) — reworked to be resumable-in-place

Today it's one `Promise.all` of a fixed worker batch that runs to completion. New shape: an outer
loop that spawns a batch of workers (each identical to today's `worker()`, just also checking
`!controller.isPaused()` in its `while` condition alongside the existing `haltedCritical` check —
same "only ever stops PULLING new work, in-flight `rebuildMod()` calls always finish naturally"
safety story already documented for `haltedCritical`, unchanged), then after a batch settles:
- Queue fully drained, or `haltedCritical` → done, return as today.
- Otherwise (must have been a pause) → `await controller.waitForChange()` (zero CPU cost while
  idle) → if cancelled, loop back and spawn a **fresh** batch to refill the now-open worker slots
  (this is what makes Cancel instant and complete, not just "stop showing the popup"); if confirmed,
  break out and return `{ haltedCritical: false, pausedConfirmed: true }`.

This is the only change to the core extraction loop. Nothing about how an individual mod is
extracted, backed up, or logged changes at all.

### Route handler (`web/rebuild-routes.js`) — three new small routes + one branch

- `POST /runs/current/pause` → `controller.requestPause()`, emit `{type:'pause-requested', inFlight: controller.count}`.
- `POST /runs/current/cancel-pause` → `controller.cancelPause()`, emit `{type:'pause-cancelled'}`.
- `POST /runs/current/confirm-pause` → `controller.confirmPause()` (rejects with a clear error if
  in-flight isn't 0 — surfaced as a normal error toast, shouldn't normally happen since the UI gates
  this already).
- After `runRebuild()` resolves, a new branch alongside the existing `haltedCritical`/`completed`
  one: if `pausedConfirmed`, write the log via the **exact same** `currentLog('paused')` +
  `runner.writeLog()` pattern already used for every other status, emit `{type:'paused', logPath,
  summary, ...}`, and return (skip the normal completion branch). `run-state.js`'s `emit()` needs
  `'paused'` added to its existing done-detection (`event.type === 'run-complete' || ...`) so the
  single-run guard releases — this is what lets the user start rebuilding a *different* collection
  while this one sits paused, satisfying "more than one paused collection" directly.

### Resume — no new code needed beyond one status string

`findResumableLog()` (`rebuild-routes.js`) currently only recognizes `'in-progress'`/
`'halted-critical'` as resumable. Add `'paused'` to that check. Everything downstream — the
`resumableLog` field already attached to every collection in the existing `GET /collections`
response, the existing "Resume from previous incomplete run" checkbox, `app.js`'s `openPlan()` /
`state.resumeLogPath` flow, `loadResumeLog()`'s per-mod-status resume logic — already works
unmodified, because none of it inspects the log's top-level `runStatus`; it only reads the
per-mod statuses inside `mods[]`, which a paused log already has correct and complete.

### Discard — one new small route, no file deletion

Per the user's confirmed choice (keep the log for history, just stop offering resume): a new route
(e.g. `POST /logs/:filename/discard-pause`) reads that one log file, changes its `runStatus` from
`'paused'` to `'paused-discarded'`, writes it back. `findResumableLog()`'s check naturally excludes
this new value, so it stops being offered — the log itself, and everything it recorded (what was
already extracted), stays exactly as it was for Browse Logs/Stats Report history. Nothing else is
touched — no staging folders, no backups.

### Frontend — Pause button + popup (`web/public/index.html` + `app.js`)

- New "Pause" button in `#view-progress`'s header, next to `#phaseIndicator`.
- A small in-flight tracker already has everything it needs from existing events: add
  `state.inFlightMods` (a `Set`), populated from the SSE events `app.js` already receives —
  add on `'mod-start'`, delete on `'mod-complete'` (both already fire today; only new client-side
  bookkeeping, no new server data needed for this part).
- Click Pause → `POST /pause` → open a new shared-style confirm modal (mirrors
  `syncApplyConfirmModal`'s shape): text shows `state.inFlightMods.size` extractions still finishing;
  **OK starts disabled**, Cancel always enabled. As `'mod-complete'` events arrive while the modal
  is open, update the displayed count. **OK only enables once the server's own `'paused'` SSE event
  arrives** (authoritative — not just when the client's local count happens to read 0, avoiding any
  client/server drift), at which point the text switches to a confirmation ("Extraction has paused.
  You can resume this collection later from the Choose a Collection page.") — clicking OK just
  closes the modal and navigates back to the picker.
  - Actually: since confirming a pause requires an explicit `POST /confirm-pause` per the design
    above (the server won't auto-finalize just because in-flight hit 0 — that's what makes Cancel
    meaningful up until the literal last moment), OK's flow is: becomes enabled once in-flight hits
    0 locally AND has been given a beat to let the server's own drain complete → click OK → `POST
    /confirm-pause` → on success, show the confirmation text, then navigate to the picker. If
    `/confirm-pause` ever rejects (a real race — a mod finished a beat after the client thought it
    was done), just re-disable OK and keep waiting; this should be rare, not a normal path.
- Click Cancel (any time before OK) → `POST /cancel-pause` → close modal immediately, no other
  client-side state change needed — the progress view keeps receiving `'mod-start'`/`'mod-complete'`
  events exactly as it already does, since the server-side worker pool is refilling on its own.

### Frontend — home page paused-collection callout (`index.html` + `app.js`)

New callout on `#view-picker` (styled like the existing `callout--warning` conventions), built
entirely from data the picker's existing `GET /collections` call already returns per-collection
(`resumableLog: {path, runStatus, ...}` — extending `findResumableLog` to recognize `'paused'` is
the only server change this needs). Client-side: filter the already-fetched collection list for
`c.resumableLog?.runStatus === 'paused'`.
- Exactly one → show its name directly with **Resume** and **Discard** buttons.
- More than one → a `<select>` listing each by name, with the same two buttons acting on whichever
  is currently selected.
- **Resume** → calls the existing `openPlan(collectionModId, name, resumableLog.path)` directly (the
  exact function the current "Resume from previous incomplete run" checkbox already uses) — no new
  client logic needed beyond wiring the button to it.
- **Discard** → confirm-then-`POST /logs/:filename/discard-pause`, then refresh the collection list
  so the callout updates (shrinks the dropdown, or disappears entirely if that was the last one).

## Files touched

- `lib/pause-controller.js` — new, small (state machine described above).
- `lib/collection-runner.js` — rework `runRebuild()`'s outer loop as described; no change to
  `rebuildMod()`, `buildPlan()`, or any of the resume-loading logic.
- `web/rebuild-routes.js` — 3 new routes (`pause`, `cancel-pause`, `confirm-pause`) + 1 new route
  (`discard-pause`) + the new `pausedConfirmed` branch in the run handler + the one-line
  `findResumableLog` extension.
- `web/run-state.js` — add `'paused'` to `emit()`'s existing done-detection.
- `web/public/index.html` — Pause button in `#view-progress`; new pause-confirm modal (mirrors
  existing modal shape); new paused-collections callout on `#view-picker`.
- `web/public/app.js` — `state.inFlightMods` tracking off existing `mod-start`/`mod-complete`
  handling; pause button/modal wiring; paused-collections callout render + Resume (reuses
  `openPlan`) + Discard wiring.
- `TECHNICAL.md` — document the pause controller design, the `'paused'`/`'paused-discarded'`
  runStatus values, and why resume needed zero changes (once written, worth recording alongside
  this project's other "verified against the real mechanism first" write-ups).

## Verification

1. Syntax-check every edited file (`node --check`).
2. A throwaway script exercising the pause controller's state machine directly (running →
   draining → paused, and running → draining → cancelled → running again, including the
   confirmPause-rejects-if-in-flight-not-zero guard) — no server needed for this part.
3. Live test (Vortex closed, real collection, small one first): start a rebuild with concurrency
   > 1, click Pause mid-run, confirm the popup's count matches actual in-flight extractions and
   counts down correctly, confirm OK stays disabled until 0, click **Cancel** partway through and
   confirm new `mod-start` events resume arriving (proves the worker-refill logic actually works,
   not just that the flag flips) — this is the one path most worth stress-testing since it's the
   new, non-trivial concurrency logic. Then repeat and this time let it fully drain and click OK —
   confirm the log's `runStatus` is `'paused'`, the run's SSE stream ends cleanly, and the app
   returns to the picker.
4. Confirm the paused-collection callout appears on the picker (single, then force a second one to
   confirm the dropdown path), Resume correctly reopens the Plan view pre-populated with
   `resumeLogPath` set and the plan correctly skips already-done mods, and Discard removes it from
   the callout while the log still shows up untouched in Browse Logs.
