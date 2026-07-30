# BUILD PROMPT — Friendly merge errors (never dump raw xelib/EPERM to the user)

A real tester hit a raw error on the Forge (Merge Plugins): a non-fatal sandbox-cleanup `EPERM` warning
**and** xelib's "Loader failed" both leaked to the screen verbatim, instead of a friendly message. Fix the
presentation so no worker error ever reaches the user as raw technical text, and harden the cleanup a
touch (the tester's Skyrim is on a `C:`-drive Steam install — prime territory for Defender to hold the
brief file lock). Standing rules: `CLAUDE.md`, `DESIGN.md`, `plain-language-writer`.

## Root cause

`lib/merge-runner.js` surfaces the worker's raw stderr as the user-facing error, assuming any stderr text
is already friendly (it's built to pass through the worker's own nice thrown errors, like the
filename-collision one). But xelib's **native** errors ("Loader failed", "CopyElement failed") and the
`removeSandbox` cleanup warning (`(cleanup warning, non-fatal: … EPERM …)`) are raw and ugly — and they
sail straight through to the UI (`web/merge-routes.js` returns `{ error: e.message }`, shown verbatim).

## Do

1. **Never surface the non-fatal cleanup warning.** In `lib/merge-worker.js` `removeSandbox`, write the
   warning with a distinct prefix — `##WARN## ` — instead of raw text. In `lib/merge-runner.js`'s stderr
   line loop, **skip `##WARN## ` lines** exactly like it already skips `##PROGRESS## ` (log via
   `console.error` for devs, but never add them to `stderrTail`). The cleanup failure is non-fatal by
   design; the user should never see it.

2. **Allowlist the worker's OWN friendly errors; everything else → the friendly fallback.** The worker
   intentionally throws a few user-ready messages (filename collision, "no plugins provided", "no output
   path", "merge could not fully drop its dependency on…", "Unknown mode"). Mark **only those** as
   user-facing — write them to stderr with a `##USERERR## ` prefix (a small helper, or an `isUserFacing`
   flag on those thrown Errors). In `merge-runner.js`, when the worker exits non-zero: surface a
   `##USERERR## ` message verbatim; for **any other** stderr (native xelib errors, unmarked crashes,
   empty) fall back to the existing `CRASH_HELP_TEXT`. Defensive by default — an unknown *future* error
   also lands as the friendly message, not a stack dump. Keep the raw text in a `console.error` for
   debugging.

3. **Harden the cleanup (the tester's `C:`-drive case).** In `removeSandbox`, bump `maxRetries` 5 → 10 and
   `retryDelay` 200 → 300 ms (more patience for an AV-locked file). And **sweep stale sandboxes**: when
   `pickSandboxParent` / `stageItems` sets up `.vct-merge-tmp`, first best-effort-delete any leftover
   `vct-merge-*` child dirs from prior runs (ignore failures) so a missed cleanup can't accumulate.

## Copy (design-owned — use as-is, don't invent)

The existing `CRASH_HELP_TEXT` is the right friendly fallback and stays as written:
> "Something went wrong while reading or merging these plugins. Close and reopen the app, then try again
> with a smaller selection to narrow down which plugin is causing it."

No new user-facing copy is needed. If some case turns out to need its own specific message, **don't write
it** — flag it in the handoff and the design side will.

## Verify + handoff

- Simulate a raw failure (temporarily throw a native-style "Loader failed" **without** the `##USERERR##`
  marker) → the UI shows `CRASH_HELP_TEXT`, not the raw string.
- A genuine user-facing error (filename collision) still shows its own friendly message.
- Confirm (by code inspection or a forced failure) that no `##WARN##` / cleanup text ever reaches the
  surfaced error, and leftover sandbox dirs get swept on the next run.
- Handoff to `prompts/handoff-latest.md` (flag anything user-facing for the design side, per this repo's
  README-sync rule).
