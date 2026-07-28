# Technical documentation

This is the deep-dive reference for Vortex Collection Tools — running from source, command-line
usage, internals, and the project layout. If you just want to try the app out, see
[`README.md`](README.md) instead; this file is for anyone who wants to dig further.

## Product direction: mimic Vortex, don't make the user go back to it (confirmed 2026-07-26)

A standing goal across this whole project, stated explicitly by the user: bring Vortex's own
native functionality *into* these tools wherever they overlap, so the user never has to alt-tab
back to Vortex to finish something this tool started. Rules Generator's review UI is the clearest
example so far — it deliberately mirrors Vortex's own "Manage rules" dialog: the exact same
before/after/??? /"never together with" wording (not invented labels), the same
one-dropdown-per-conflict row shape, defaulting to a suggested value the user can override, just
like Vortex's own dropdown does. When building anything new here that overlaps with something
Vortex itself already does, look at how Vortex presents that exact thing first (its real UI, its
real wording) and match it, rather than designing a parallel-but-different version of the same
concept.

**Extends to anything DB-write-adjacent too** (confirmed 2026-07-26): always check Vortex's real
source before implementing something that reads or writes its state — this project already does
this everywhere (`vortex-source-refs.json`, the `testModReference.ts`/`findRule.ts`/
`generateCollectionMap` citations throughout this file). Reason stated explicitly: mimicking
Vortex's own real behavior isn't just about UI consistency — it's also how a future write path
notices Vortex's own format/behavior has changed (a mismatch between "what we assumed" and "what
Vortex's current source actually does" is a signal to re-check before writing, not something to
paper over).

## Running from source

```
npm install
npm run web
```

Opens `http://127.0.0.1:4321` with a top-level nav for both tool areas plus **Settings**. Terminal
CLI access is also available (see below) for either flow without the web UI.

## Building a release package

`build-release.ps1` (project root) builds the self-contained zip attached to each GitHub release
(`VortexCollectionTools-v<version>-win-x64.zip`) — the one the README tells testers to download,
unzip, and double-click `start-server.bat` from, with nothing else to install. This exists because
the first release (v0.1.0) had its zip assembled by hand, ephemerally, with no repeatable process
left behind — v0.2.0 hit exactly that problem, so this script exists to make sure it never happens
again.

```
.\build-release.ps1                              # uses package.json's current version, latest pinned Node/7-Zip
.\build-release.ps1 -NodeVersion 24.18.0 -SevenZipRelease 26.02   # pin explicitly if needed
```

**Assumes nothing is pre-installed on the machine running it** — no Node.js, no 7-Zip, nothing
beyond what every Windows install already has (`git`, `npm` for the *current* checkout used to run
the script itself, and `msiexec`). What it does, in order:
1. Copies every `git ls-files`-tracked file into a clean staging folder (gitignored files —
   `config.json`, `logs/`, the archived `terminal-flow-archive/`, etc. — are correctly excluded
   automatically, since that's the same source list `git` itself uses).
2. Runs `npm ci --omit=dev` inside the staged copy — a clean, reproducible install matching
   `package-lock.json` exactly, including `classic-level`'s prebuilt native binding.
3. Downloads a portable Node.js runtime (`nodejs.org/dist`) and copies just `node.exe` (+ its
   LICENSE) into `node/` — `start-server.bat` looks for exactly this path.
4. Downloads 7-Zip's official installer **MSI** (`github.com/ip7z/7zip/releases`) and extracts it
   via `msiexec /a <msi> /qn TARGETDIR=...` — an "administrative install" that just unpacks files to
   a folder, installs/registers nothing. This is the key trick that avoids a chicken-and-egg
   problem: `msiexec` ships with every Windows install, so no 7-Zip needs to already exist to get
   `7z.exe`/`7z.dll` out of the official package. (7-Zip's separate "extra" download — a plain `.7z`
   archive — only contains the lighter `7za.exe`/`7za.dll`, which drops RAR support and other
   codecs; `lib/sevenzip.js` specifically expects the full `7z.exe`/`7z.dll` from the real
   installer, so that lighter package is the wrong source.) Copies `7z.exe`/`7z.dll` (+ License.txt)
   into `tools/7-Zip/` — `lib/sevenzip.js`'s own bundled-path check looks for exactly this path,
   ahead of any system-installed 7-Zip.
5. Writes `START HERE.txt` (plain-language quick start, referenced by the README and release
   notes).
6. Zips the whole staged folder to `github-releases\VortexCollectionTools-v<version>-win-x64.zip`
   (gitignored — a build artifact, not committed to source).

Smoke-test before shipping a release built this way: launch the bundled copy on a spare port
(`node\node.exe web\server.js --port <spare> --no-open` from inside the staged/zipped folder) and
confirm `GET /api/settings` responds — proves the bundled Node actually runs the real server, not
just that the files exist. `tools\7-Zip\7z.exe` with no arguments printing its version/usage banner
is enough to confirm that binary isn't corrupted.

**Known minor inefficiency, not worth fixing yet**: `classic-level`'s prebuilt native bindings for
every platform (Linux, macOS, Android, 32-bit) ship inside `node_modules/classic-level/prebuilds/`
even though this release is Windows-x64-only — a few extra MB of dead weight per release. Pruning
non-`win32-x64` prebuild folders after `npm ci` would trim this, but adds a real risk of breaking
`classic-level`'s own platform-detection if its lookup logic ever expects the other folders to at
least exist; not worth that risk for a few MB.

## Settings & configuration

Every path (staging/downloads/backup-root/Vortex database) and the Nexus API key live in a single
unified `config.json` (project root, gitignored — see `lib/app-config.js`; `config.example.json` is
the committed, placeholder-only template). **No personal path or credential is hardcoded anywhere in
source** — this project is meant to be shared, so a fresh clone has nothing machine-specific baked
in. Resolution order everywhere (both the web UI and every CLI script): explicit CLI flag wins, then
`config.json`, then (Vortex database path only) auto-detected under `%APPDATA%`.

**Keep `config.example.json` in sync with `lib/app-config.js`'s `DEFAULT_CONFIG` whenever a field is
added, removed, or renamed.** Confirmed live 2026-07-27: `config.example.json` had silently drifted
out of sync — missing both `maxStateBackupsToKeep` (added that same day) and `hideVortexVersionWarning`
(added earlier, 2026-07-25) — nothing enforces this automatically, so it's a manual step, easy to
forget when a change is focused on `app-config.js`/`settings-routes.js` and never touches the example
file at all. `loadConfig()`'s own default-merge means a stale example file causes no functional bug
(a real `config.json` still gets the real default via `DEFAULT_CONFIG`), which is exactly why this
kind of drift goes unnoticed for a while — it only actually matters to someone reading the example
file as documentation of the current shape.

The Settings page (web UI) edits this file directly:
- **Paths** — staging/downloads/backup-root/Update-Collection-backups-folder/Vortex-database, each
  with a native folder-browse button (`lib/vortex-sync/win-dialog.js`'s `pickFolderAsync`, a
  `FolderBrowserDialog` via `spawn` — async, so an open dialog never freezes the server). Path
  changes need a server restart; Save offers to do this for you automatically (spawns a fresh server
  process with the same launch args, tears the old one down once the response has flushed, then the
  page polls until the new one answers and reloads) rather than requiring you to do it manually.
  **Staging, downloads, and the Update Collection backups folder have no valid blank state** — the
  Settings page marks them `(required)` and blocks Save (client-side, plus a server-side backstop in
  `web/settings-routes.js` for a corrupt/manually-edited `config.json`) until all three are filled
  in. Rebuild Collection's own `backupRoot` and the Vortex database path stay optional: `backupRoot`
  only matters once backups are actually turned on (off by default, see below), and the database
  path auto-detects a real default under `%APPDATA%`.
- **Backups** — a single "backups to keep" number: `0` = off (no backup made at all, the default for
  a fresh install — explicit opt-in, not an assumed safety net), `1`-`3` = back up every real run and
  prune down to the N most recent afterward, blank = back up every run and never prune (unlimited).
  A backup is always a fresh, timestamped, full copy of every affected mod's current staging folder
  — never overwritten, so there's never a "stale leftover files" problem to manage. **Update
  Collection's own backups** (the ignored/disabled-mod snapshot files, a completely separate thing
  from the above) have no on/off toggle — they're small and cheap, so every "Create Backup" click
  just saves one to whatever folder is configured; there used to be a hardcoded fallback to a folder
  inside this project's own source tree (`lib/vortex-sync/backups/`) when nothing was configured,
  removed after live confirmation that landing a real backup somewhere with no obvious "Vortex"
  relationship, with no way to tell where it went, was actively confusing.
- **Performance** — "Concurrent extractions" (1-8 in the UI). See **Concurrent extraction** below.
- **NexusMods** — the personal API key (masked; the page never echoes a stored key back, only
  whether one exists). Stored as **plain text** in `config.json` — gitignored, so it never leaves
  this machine via git, but not encrypted at rest; anyone with access to this Windows account could
  read it directly from disk. Also has "Download missing archives automatically during rebuild"
  (Premium accounts only — see **Downloading missing archives automatically** below).
- **Appearance** — System/Dark/Light theme, defaulting to System (follows the OS/browser's
  `prefers-color-scheme` until explicitly overridden), persisted in the browser's `localStorage`
  only (a pure display preference, not written to `config.json`).
- **Logs** (General settings, 2026-07-27) — one `logsDir` root, shared across the whole app, not
  per-tool. `null` (default, unconfigured) resolves to the same flat `logs/` folder this project has
  always used — zero migration for an existing install. When a custom root IS set,
  `appConfig.getLogsDir('<tool-subdir>')` (`lib/app-config.js`) puts each tool's logs in its own
  subfolder underneath that root instead of one shared flat folder, so they stay easy to tell apart
  once more than one tool writes logs. Today only Rebuild Collection actually writes any
  (`web/rebuild-routes.js`, `web/stats-routes.js` and `web/work-through-routes.js` — the latter two
  only *read* the same folder — and the standalone `rebuild-collection.js` CLI all call
  `getLogsDir('rebuild-collection')`). Path change, so it requires a restart like staging/downloads.
  "Open Logs Folder" opens `getLogsRoot()` directly in Explorer (navigates *into* it, unlike the
  Reveal buttons elsewhere which select a path within its parent); "Delete all logs" permanently
  removes every file matching `rebuild-.+\.json` under that tool's resolved subfolder (a real count
  shown in the confirm dialog first, same pattern as "Delete all backups").
  **Standing rule going forward: any tool that starts writing its own logs must (1) call
  `appConfig.getLogsDir('<its-own-subdir-name>')` rather than inventing its own path, and (2) get a
  home in this same Settings section** — a location field (if it doesn't already share the one
  above), a Delete option, and an Open-folder button. Never require hunting through a log-viewer
  page or a completion screen to find out where a log physically lives.

A brand-new install with nothing configured yet lands on Settings automatically, once, with a
welcome banner — never again once staging/downloads are saved.

## Raw paths never appear as UI text (2026-07-27)

Standing rule, confirmed after three real instances were found and fixed in one pass (Rules
Generator's apply-result message, Rebuild Collection's completion screen, Settings' database-restore
result): **no absolute file/folder path is ever shown as plain text in this app's UI**, even right
next to a button that could open it. A path is either represented by an action button (Reveal —
selects it in Explorer within its parent folder; Open Logs Folder — navigates directly into a
folder) with the actual path living only in a `dataset.path` attribute, or not shown at all.

**Completion/result screens specifically never mention a backup folder at all** — confirmed
explicitly: "no one would ever need to access the backup folder from the completion page... all
backup folder interaction should be in settings, including reveal, restore." A success message on a
completion screen states what happened (counts, e.g. "N rule(s) written across M mod(s)") and
nothing about where any backup landed; Settings' own "Vortex database backups" section is the only
place backup-folder Reveal/Restore actions live (see the Restored/Safety-backup Reveal buttons
there, added the same session).

**No exception for destructive-action confirm dialogs either** — an earlier version of this note
carved one out (reasoning: "naming exactly what will happen" before an irreversible action, per
Safety Rules in `CLAUDE.md`), but the user explicitly rejected that when the same "Delete all
logs?"/"Delete all backups?" dialogs were found still printing a path: "remove the paths, just tell
what you are doing, nothing more." A destructive confirm still names the real, specific COUNT
("This will permanently delete 73 log files.") — that's what "naming exactly what will happen"
actually requires — it just never names the folder path itself. `web/settings-routes.js`'s
`/logs-info`/`/backups-info`-style endpoints still return the resolved path in their JSON (so a
future Reveal button could use it if ever added), the client-side status/confirm text just never
prints it.

## Rebuild Collection

```
node cli/rebuild-collection.js [--collection-mod-id <id>] [--staging <dir>] [--downloads <dir>]
  [--state <path>] [--backup-root <dir>] [--concurrency <1-8>] [--dry-run]
  [--resume <log-file>] [--yes]
```

Always run `--dry-run` first. See `lib/collection-runner.js`, `lib/rebuild-mod.js`, and the
extraction engine (`lib/simple-installer.js`, `lib/choice-resolver.js`, `lib/fomod-parser.js`,
`lib/sevenzip.js`) for how this works. `lib/extract-mod.js` is the isolated per-mod child-process
worker `rebuild-mod.js` spawns (same convention as `lib/state-write-worker.js`/`state-query-worker.js`
— crash containment, one mod's failure can't take down the whole run). The rest
(`scripts/compare-output.js`, `scripts/smoke-test-collection.js`,
`scripts/snapshot-collection-staging.js`, `scripts/download-collection.js`,
`scripts/check-vortex-source-drift.js`) are validation/utility tools used during this engine's own
development, reorganized out of the project root 2026-07-27 — see comments in each file, and
"Project structure" below.

**After a real (non-dry-run) rebuild, expect Vortex to show "External Changes" the next time it
starts**, for every mod that came back `REBUILT` — this is expected, not a sign of a real problem.
`rebuildMod()` swaps a rebuilt mod into place via `fs.renameSync` (crash-safety — see the header
comment in `lib/rebuild-mod.js`), which always creates a brand-new file on disk, even when its
content and `LastWriteTime` end up byte-identical to what was already deployed (the archive itself
supplies each entry's stored timestamp, not "now"). Vortex's own deployment tracking follows file
identity, not just content or mtime, so it correctly notices the staged file is no longer the same
physical file it last deployed — confirmed directly against a real case (`Laundry.esp` inside
"ESLified Patches"): identical size, identical `LastWriteTime`, identical SHA256 between staged and
deployed, but different NTFS File IDs, with `CreationTime` on the staged copy matching the exact
rebuild run that touched it. **Verified content is genuinely unchanged in this scenario** (that's
what a clean `REBUILT` status already guarantees — a rebuild only swaps in when its own missing/
changed diff came back clean) — safe to click **"Use newer file"** / **"Save all changes"** and
deploy in Vortex.

## Concurrent extraction

`lib/collection-runner.js`'s `runRebuild()` extracts mods in parallel via a small hand-rolled worker
pool (`concurrentExtractions` in Settings/`config.json`, 1-8, default 1/sequential — no restart
needed to change it, read fresh at the start of every run). This is safe because each mod's rebuild
already only spawns its own independent `extract-mod.js` child process and touches only that mod's
own uniquely-named paths — see the header comment on `runRebuild()` for the full reasoning (no shared
state, no real data race even though Node's event loop still serializes the bookkeeping).

**Confirmed real-world findings** (A/B-tested against a real 309-mod collection, "Body Swap
updated", via the sandbox technique below):
- Correctness is identical at every concurrency level (1, 3, 8, 16 all tested) — same exact
  REBUILT/SKIP_* counts every time. Concurrency only changes speed, never outcome.
- Real speedup is well short of the theoretical linear ceiling (8x for concurrency 8) — extraction is
  disk-I/O-bound as much as CPU-bound, so parallel 7-Zip processes end up competing for the same
  disk's I/O queue rather than getting independent lanes of work. Observed **~2-3x** at concurrency 8
  depending on drive layout, not 8x.
- **Drive choice measurably changes the result.** Staging and downloads on the SAME physical drive
  vs. two SEPARATE drives produced different speedups in real testing — always test (and expect real
  throughput from) whatever drive layout you actually run with; don't assume a number from one drive
  configuration applies to another.
- Going past 8 (tested 16 directly, bypassing the Settings page's UI cap) produced **zero further
  speedup** on the hardware/collection tested — 8 already sat at the real saturation point. There's
  no hard cap in `runRebuild()` itself, only in the Settings page's own input validation; raise
  `config.json`'s `concurrentExtractions` directly past 8 if you want to test your own ceiling.
- **Task Manager may show fewer simultaneous `7z.exe` processes than the concurrency setting** — this
  is expected, not a sign concurrency isn't working. Each mod's own pipeline alternates short 7-Zip
  invocations (list, an optional single-file FOMOD-config peek-extract, the real bulk extract) with
  pure-JS work in between (XML parsing/choice resolution, and SHA256-hashing every extracted file
  afterward to build the manifest) — at any snapshot, several "in-flight" mods are very likely
  sitting in one of those JS-only gaps rather than mid-extraction, so the live process count
  structurally undercounts the real concurrency happening underneath.

## Pause/Resume Extraction

**What it's for:** a large collection can take hours. Pause lets the user stop new extractions from
starting (letting whatever's currently running finish naturally), close the app, and come back later
via "Resume" on the picker page — without losing any progress.

**Resume needed almost no new code.** This project already writes the run's log to disk after
*every single mod* completes (`onModComplete` → `runner.writeLog(logPath, currentLog('in-progress'))`
in `web/rebuild-routes.js`), and already has a full resume mechanism (`RESUMABLE_STATUSES` +
`loadResumeLog()` + `buildPlan()`'s resumed-mod short-circuit in `lib/collection-runner.js`,
`findResumableLog()` + the "Resume from previous incomplete run" checkbox / `resumeLogPath` flow in
`app.js`'s `openPlan()`). None of that machinery inspects the log's top-level `runStatus` — it only
reads per-mod statuses inside `mods[]`, which a paused log already has complete and correct. Pause
only needed: (1) `findResumableLog()` extended to also recognize a new `'paused'` `runStatus` value
(alongside the existing `'in-progress'`/`'halted-critical'`), and (2) a way to gracefully stop a run
in the first place — which didn't exist before this feature at all (previously a run only ever ended
via `CRITICAL_MANUAL_RESTORE_NEEDED` or the whole process dying).

### Pause controller (`lib/pause-controller.js`) — event-driven, not polled

A small state machine (`'running' → 'draining' → 'paused'`, with `'draining' → 'running'` for
cancel) plus an in-flight counter. `waitForChange()` returns a promise that only resolves when
`requestPause()`/`cancelPause()`/`confirmPause()` actually fire — the extraction loop awaits this
instead of polling on a timer, so pausing costs zero CPU while idle.

**Why `confirmPause()` is a separate step from `requestPause()`:** confirmed directly with the user
that Cancel (in the pause popup) must **fully and immediately resume normal extraction** — "we
continue extraction like nothing happened until fully completed or the user hits pause again." Only
clicking OK actually finalizes the pause. This means a plain one-way "stop" flag wasn't enough;
`requestPause()` just stops new work from starting (workers finish their current mod, same
"in-flight always runs to completion" safety story `CRITICAL_MANUAL_RESTORE_NEEDED`'s
`haltedCritical` flag already established), while a *separate*, authoritative `confirmPause()` call
is what actually ends the run — and it rejects if the in-flight counter isn't genuinely 0 yet
(defense in depth beyond the UI's own "OK disabled until 0" gating, same "don't trust the caller"
discipline `assertRulesShapeKnown` already applies elsewhere in this project).

### `runRebuild()`'s rework — the only change to the core extraction loop

Previously a single `Promise.all` over a fixed worker batch, run once. Now an outer loop: spawn a
batch of workers (each identical to before, just also checking `!pauseController.isPaused()`
alongside the existing `haltedCritical` check), and once a batch settles, ask *why*:
- Queue fully drained, or `haltedCritical` → done, return exactly as before.
- Otherwise (must have been a pause) → `await pauseController.waitForChange()`, then either spawn a
  **fresh** batch sized to whatever's left (cancelled — this is what makes Cancel truly instant and
  complete, not just a dismissed popup) or return `{ pausedConfirmed: true }` (confirmed).

`pauseController` is optional — omitted entirely by the CLI's own direct caller (`rebuild-collection.js`,
no pause UI), which gets the exact original one-shot behavior since `isPaused()` can never become
true without a controller.

Verified with a throwaway integration test (a fake `rebuildMod` injected via `require.cache`, no
real filesystem/extraction work) before ever touching a real collection: no-controller path
unchanged (all mods processed); cancel-during-drain resumes full concurrency and finishes ALL mods,
not just the ones left after the pause window; confirm-during-drain stops for good with only the
in-flight batch logged, the rest correctly left for resume.

### New `runStatus` values

- `'paused'` — a deliberate, confirmed pause. Resumable (see above), and surfaced proactively on the
  picker page (a callout built from the exact same per-collection `resumableLog` data the picker's
  `<select>` already annotates with "— Resumable" — filtered client-side to
  `resumableLog.runStatus === 'paused'`, no new detection endpoint needed). Supports more than one
  paused collection at once via a dropdown.
- `'paused-discarded'` — set by `POST /logs/:filename/discard-pause` when the user discards a paused
  collection from the picker callout. Confirmed with the user: this must **only** stop offering the
  log for resume, never touch any files (staging folders, backups) or delete the log itself — the
  log stays exactly as it was for Browse Logs/Stats Report history, just no longer resumable.

### Session release for "more than one paused collection"

`web/run-state.js`'s single-run guard only allows one active run at a time. Its `emit()` needed
`event.type === 'paused'` added to its existing "this is a done event" detection (alongside
`'run-complete'`/`'run-error'`) — otherwise the guard would never release, and starting a rebuild on
a *different* collection while this one sits paused (explicitly required: "It is possible to have
more than one paused collection") would be blocked.

### Frontend pause popup — OK-enable timing (a real refinement made during implementation)

The original plan's wording said "OK only enables once the server's own `'paused'` SSE event
arrives" — but that event doesn't exist until *after* `confirm-pause` is actually called, which is
what clicking OK does. That's circular. The implemented, correct version: OK enables from the
**client's own live count** (`state.inFlightMods`, tracked off the same `'mod-start'`/`'mod-complete'`
SSE events already driving the progress table) reaching 0 — the earliest honest signal available
client-side. Clicking OK still goes through the server's authoritative `confirmPause()` check
(rejects if its own counter disagrees), and the client waits for the real `'paused'` SSE event
before navigating away from the progress view, so the picker's callout is guaranteed to see the
freshly-written log the moment it loads.

### Live test findings (2026-07-27)

Ran the full flow against real collections (College of Winterhold Overhaul, 91 mods; Body Swap
updated, 309 mods) with a stale server process still running the pre-pause-feature code — the
`/runs/current/pause` route 404'd ("Could not pause"). Not a code bug: `web/rebuild-routes.js` had
been saved 34 minutes after the running `node web/server.js` process started, and Node doesn't
hot-reload route files. **Lesson: always confirm the server process's start time is newer than the
last edit to any file it serves before live-testing a route change** (`Get-CimInstance Win32_Process
-Filter "name='node.exe'"` → `CreationDate`, compared against the edited files' mtimes) — restart via
the graceful `/api/shutdown` route rather than killing the process, since that lets an in-flight
extraction finish cleanly first.

Once restarted, Pause/Cancel/Confirm/Discard/Resume all worked correctly end-to-end. One real
environmental limitation surfaced: at `concurrentExtractions: 1` against already-downloaded
archives, a single mod's extraction (7-Zip on a small archive) finishes faster than a human/browser-
automation round-trip, so the in-flight counter was already back to 0 by the time the Pause modal
rendered every single time — the "OK stays disabled while N extractions finish" path could not be
caught live no matter how tightly the click was timed. This isn't a gap in coverage: the disabled→
enabled transition and the "confirm rejects if in-flight isn't actually 0" guard are both exercised
directly by the pause-controller unit tests and the fake-`rebuildMod` integration test (see above),
which control the timing explicitly instead of racing real disk I/O.

Three real UI bugs were found and fixed during this pass, all pre-existing (not introduced by the
pause work itself, but only visible once Resume was actually driven through the browser instead of
just unit-tested):
1. **Resume checkbox never reflected reality.** `renderPlan()` set `resumeBox`'s visibility and meta
   text but never set the checkbox's own `checked` state — a plan opened via the picker's Resume
   button (which sets `state.resumeLogPath` *before* the plan loads) rendered with 33/91 mods already
   shown as done, yet the checkbox still displayed unchecked. Fixed by making the Resume button pass
   an explicit `explicitResume` flag through to `openPlan()`; when set, `renderPlan()` skips the
   checkbox entirely and shows a plain, non-interactive confirmation line instead (the user's own
   call: "if I selected the Resume button, I shouldn't have to check a box too"). The original
   checkbox (for the case where a resumable log is merely *discovered* while browsing normally, not
   explicitly requested) is untouched.
2. **Header mod-count denominator disagreed with the "mods left" count next to it.** The resumed
   plan's title showed `(33 of 91 mods)` while the resume banner said "28 mods left to go" — 33+28=61,
   not 91, because 91 includes ignored/FOMOD/optional/no-archive mods that can never be rebuilt
   through this flow. Fixed by using `doneCount + remainingCount` (both from `plan.summary`) as the
   header's denominator instead of the collection's raw total, so the two numbers are always
   internally consistent.
3. **Pause button placement.** Originally its own small ghost button sitting in the header, not
   visually matched to the app's other primary actions and separated from the phase-status text by a
   lot of dead space. Moved onto the same row as `#phaseIndicator` (`.progress-header-row`, a flex
   row with `justify-content: space-between`) so it's always adjacent to the status text regardless
   of whether the Backup/Downloads notice rows below it are shown, restyled to `btn btn--primary` to
   match Start Rebuild/View Collection, and given its own bottom border/padding so it's visually
   separated from the notice rows rather than sitting flush against them.

## Downloading missing archives automatically

Rebuild Collection can auto-download a mod's archive from Nexus when it's missing from your
downloads folder, instead of just skipping it (`SKIP_NO_ARCHIVE`). Opt-in via Settings →
"Download missing archives automatically during rebuild" (`downloadMissingArchives` in
`config.json`, default `false`, read fresh per-run — no restart needed).

**Requires a Nexus Premium account.** This deliberately mirrors Vortex's own real behavior, not an
invented shortcut — see `vortex-source-refs.json` for the exact source citations. Vortex's own
`nexus_integration/eventHandlers.ts` refuses direct/automated downloads for non-Premium accounts
client-side, by design: *"nexusmods can't let users download files directly from client, without
showing ads"* — this respects Nexus's ad-supported revenue model for free users. This project
checks Premium status once per run (`GET /v1/users/validate.json`) before attempting anything; a
non-Premium account gets the exact same refusal Vortex's own client would give, logged clearly, with
no attempt at a workaround. A free account must download the archive manually via the website and
let Vortex install it.

The actual download resolves the collection.json-pinned `modId`+`fileId` via
`GET /v1/games/{domain}/mods/{modId}/files/{fileId}/download_link.json` (the same real endpoint
Vortex's own `node-nexus-api` calls) — never "latest"/"main file", so a mod with multiple file
versions on Nexus still gets the *exact* version the collection recorded. Every download is
verified against collection.json's own recorded `md5`/`fileSize` **before** being accepted (a
mismatch deletes the partial file and reports a clean `HASH_MISMATCH`/`SIZE_MISMATCH` failure,
never leaves a wrong file at a name a later run could mistake for the real thing).

**Two different "we don't have the archive" cases are treated identically** (same friendly Plan-page
message, same auto-download eligibility): a true "nothing this size in the downloads folder at all"
(`NOT_FOUND`), and a "something this exact size exists, but it's the wrong file" coincidence
(`HASH_MISMATCH`) — confirmed real-world with a 441-byte mod (`archive-locator.js` matches candidates
by file size first, then verifies by md5; a completely unrelated archive happened to be exactly the
same size and showed up as a "candidate" that had nothing to do with the mod in question). Only a
genuine **`AMBIGUOUS`** case (multiple candidates that are ALL byte-identical, real, correct matches —
an actual duplicate-file situation) is excluded and keeps its technical detail — downloading again
wouldn't resolve a duplicate, only add a third correct copy, so that one still needs a human.

**Off-site mods (not hosted on Nexus) are never auto-downloaded** — real collections can reference
`browse`/`direct`/`bundle`-type sources (Google Drive links, GitHub release assets, LoversLab, a
bundled asset shipped inside the collection's own package) which structurally carry no `modId`/
`fileId` to call the Nexus API with. These get their own Plan/log message instead: the recorded URL
for manual download, or *"This file is an off-site mod and no URL available."* if the collection
didn't record one either.

Any download failure (mod taken down, the pinned file version since removed by its author, network
error) is caught per-mod — one failure never stops the rest — and listed in the run's log under
`downloadedArchives.entries`, with the real Nexus API error message (not a raw JSON blob).

**Verify with `scripts/sandbox-test-download.js` before enabling this for real** (see below) — it downloads
into a throwaway folder, never your real downloads directory, so you can confirm the mechanism
against your own real collection first.

## Sandbox-testing a download (or a rebuild) without touching real folders

`node scripts/sandbox-test-download.js --collection-mod-id <id> --sandbox-downloads <dir>
(--mod-name "<name or substring>" | --all-missing) [--clean]` — downloads real archive(s) from Nexus
for a real collection's currently-missing mods into a THROWAWAY folder, never your real downloads
directory (refuses outright if `--sandbox-downloads` resolves to it). `--mod-name` targets one mod by
a case-insensitive substring match (errors if ambiguous); `--all-missing` scans every Nexus-hosted
mod in the collection (read-only against your real downloads folder — stat/hash only, never writes
there) and downloads whichever ones are genuinely missing. A clean run **is** the verification —
`downloadModArchive()` already checks actual size+md5 against collection.json before accepting a
download as real, the same way this project trusts collection.json everywhere else. No automatic
cleanup (unlike the rebuild sandbox below) — the point is letting you inspect the real file
afterward; pass `--clean` to remove the sandbox folder when done.

## Sandbox-testing a rebuild without touching real staging

`node scripts/sandbox-test-rebuild.js --collection-mod-id <id> --sandbox <dir> [--port 4322]
[--concurrency <n>] [--keep-server]` — smoke-tests a REAL rebuild (real archives, real 7-Zip work)
against a THROWAWAY staging folder, so you can safely test concurrency levels, or anything else,
against a large real collection without any risk to your actual staged mods. Spawns a completely
separate server instance on its own port with `--staging` pointed at the sandbox; `--downloads`/
`--state` stay pointed at your real ones (read-only in this flow, safe to share).

`--sandbox` is required with no default — deliberately forces a conscious choice of drive every
time (see the drive-choice finding above), and the script refuses outright if it resolves to your
real configured staging directory. `--concurrency`, if given, temporarily overwrites `config.json`'s
shared `concurrentExtractions` for the duration of the one run and always restores the original
value afterward, even on error.

The sandbox only ever contains a copy of the target collection's own `collection.json` — no per-mod
folders — so every mod takes the fast "staging folder doesn't exist yet" path (still a full, real
extraction) rather than the separate, already-independently-tested diff-against-existing-content
logic. That's why this is a smoke test for the extraction pipeline/concurrency specifically, not a
substitute for running the collection for real once you're ready to actually update your staging.

## Known FOMOD authoring quirks (confirmed real-world)

`lib/fomod-parser.js` / `lib/choice-resolver.js` replay a collection's recorded FOMOD choices
against the real archive's `ModuleConfig.xml`. Real, shipped mods have exposed several
non-obvious authoring patterns that a naive reading of the FOMOD spec would get wrong — each is
handled explicitly, with the archive that first exposed it noted for traceability:

- **Duplicate installStep names.** Two install steps can share the exact same `name` (e.g. two
  mutually-exclusive variant steps both called "Mesh Patches - Masks", gated on different earlier
  choices). Matching by name breaks the instant this happens — `.find()` always returns the first
  match, silently applying the wrong step's (possibly empty) recorded choices. Vortex records one
  `choices.options` entry per raw installStep **unconditionally, in document order**, including
  steps whose `<visible>` condition was never actually met (their entry just has empty/default
  selections) — so **array position, not name**, is the only reliable match key. (Confirmed via
  "Dragon Priests Retexture SE - Half Res".)
- **Whitespace-padded names.** `fast-xml-parser` trims attribute values by default, but a real
  mod's own XML can have a trailing space in a `name` attribute (`name="High Poly Vanilla Male
  Body "`) that Vortex's recorded `collection.json` preserves verbatim. An exact-string group/step
  name comparison silently fails to find the recorded entry. Always compare `.trim()`ed on both
  sides. (Confirmed via "Nordic Faces - Textures and Body Meshes".)
- **Non-empty-string "install at mod root" destinations.** An explicit empty-string
  `destination=""` on a `<file>`/`<folder>` entry is already documented FOMOD behavior for
  "install at the mod root, using just the source's basename" — but real authors also write this
  same intent as a literal `destination=".\<file>"` ("Faster HDT-SMP FSMP 3.5.0") or a bare
  `destination="."` (20 different `<folder>` entries in "Dwemer Armor SE - CBBE 3BA"). All three
  forms must normalize to the same result — `path.win32.normalize()` handles `.\`/`./` correctly
  but does **not** collapse a lone `.` further, so that case needs an explicit extra fold to `""`.

**How to validate any future change here against this user's real, live modded install — safely,
with zero writes**: for every mod in a real `collection.json` with `choices.type === 'fomod'` and
an existing staging folder, re-run the real pipeline (`findModRoot` → extract+parse the real
`ModuleConfig.xml` → `resolveChoices`) and diff the resulting destination-path set against
`buildManifest()` of what's actually on disk in that mod's staging folder. A clean diff across a
real collection's full FOMOD-choice mod list is strong evidence a change is correct; any mismatch
is either a bug to chase or (confirm via the mod's own recorded `choices`) a genuine cross-collection
choice divergence that's *supposed* to surface as `FAILED_MISMATCH_NOT_TOUCHED`.

## Vortex ".ghost" files (a deliberate disable choice, not a mismatch)

Vortex marks a deployed file as disabled-but-present by appending `.ghost` to its name (e.g.
right-click "never deploy this file", or a manual conflict-resolution choice) rather than deleting
it. A fresh archive extraction never contains a `.ghost`-suffixed name — that suffix only ever gets
applied by Vortex itself, after deployment — so naively diffing the two would call the archive's
plain file "added" and the current `.ghost` file "missing", and every rebuild path would then handle
that wrong in its own way: an ordinary clean rebuild's whole-folder swap silently discards the
`.ghost` file (a fresh extraction has nothing to carry it forward with), while the manual "Keep
modified" merge restored the plain, *active* file right alongside the still-present ghost. Confirmed
live (2026-07-24, "Dragonborn UI for GTS - Resources"): both `Disable Map Markers.esp` and
`...esp.ghost` ended up on disk at once, byte-identical, after clicking "Keep modified".

`lib/ghost-files.js` strips any ghost/plain pair (matched case-insensitively, same convention as
`diff-manifests-ci.js`'s NTFS-case-preservation handling) from both manifests before diffing, so a
legitimately-ghosted file no longer even triggers `FAILED_MISMATCH_NOT_TOUCHED` by itself. Per the
user's explicit call, a skipped ghost file's content is never reconciled against a possibly-newer
archive version — it's left completely untouched, and the skip is logged (`ghostPreserved` on a
normal/`keep-existing` result) rather than done silently. `resolveMode: 'all'` (full replace) is the
one exception: consistent with how it already discards a local ESL-only choice, a full replace also
discards the `.ghost` file — but now logs that it did, instead of doing it silently.

## Vortex's Workshop-tab collection folders (`vortex_collection_<id>`)

Every collection you've ever added to Vortex's **Workshop** tab (authoring/curating your own,
whether ever published or not) gets its own folder under the staging directory, named with Vortex's
raw internal id (`vortex_collection_<random>`), distinct from a real *installed* collection's
archive-derived folder name (`<Name>-<modId>-<revision>-<timestamp>`). This project's collection
picker treats the two completely differently (see the naming-convention checks in
`scanStagingCollections`/`scanAllCollections`) — only archive-named folders are real, rebuildable
collections; `vortex_collection_*` ones only ever show in the Workshop dropdown, regardless of
what's on disk inside them.

**The root `collection.json` in one of these folders cannot be trusted as "current state."**
Confirmed directly (2026-07-24): editing a Workshop collection's mod list in Vortex's UI (adding or
removing mods) does not touch the root `collection.json` at all — not its content, not even its
mtime. The real, live edit state lives entirely in Vortex's own internal database the whole time.
The root file only ever reflects whatever it was when first written by Vortex itself (apparently
once, early on) and then sits frozen until something explicitly overwrites it — either Vortex doing
so again at some later point, or this project's own "Fetch from Nexus" (below), which writes
directly into this same root path. Proven on a real collection where the root file (mtime unchanged
since 2025-12-29, predating this project's own Fetch feature entirely) listed 44 mods, but
publishing a new revision immediately afterward produced a `collection.json` with 67 mods (19
removed, 42 added since whatever point the root file was last accurate) inside the freshly-written
`export/collection_<N>.7z`.

That `export/collection_<N>.7z` (one .7z per locally-packaged revision, e.g. `collection_0.7z`,
`collection_2.7z`) is the one place a genuinely *current* local snapshot exists — written the moment
you package/publish a revision from Vortex's Workshop editor, containing the real `collection.json`
as of that exact action. If you need the actual current state of a Workshop collection without
publishing first, the only reliable options are that latest `export/collection_<N>.7z`, or a live
read of Vortex's own state DB (the collection's `rules` array reflects real-time edits, confirmed
against "My Empowering The NPCs").

This is also why this project's "Fetch from Nexus" feature (see **Update Collection** below and the
Workshop picker) always downloads fresh from Nexus's own CDN rather than ever reading a local
`export/*.7z` — nothing on disk in one of these folders can be assumed to match what's actually
published, so there's no shortcut worth trusting over asking Nexus directly for a specific revision.
A successful fetch overwrites the folder's root `collection.json` with that freshly-downloaded
content, then goes straight to the Plan view for it (same as clicking "View Collection" for a real
installed collection) — a fetched `collection.json` is just as usable to `computePlan` as any real
one, since neither it nor `resolveCollectionInfo` cares about the `vortex_collection_*` naming
convention at all (that only decides which picker dropdown a collection shows up in).

## Update Collection

The web UI (Update Collection tab) is the primary, recommended way to run this flow. A flag-based
CLI also exists for scripting/automation:
```
node cli/sync-cli.js <command> [options]   # list-collections, backup, apply-ignores,
                                        # apply-disables, compare, list-backups, ...
```
(The interactive terminal menu that used to accompany this — `sync-menu.js` — has been archived to
`terminal-flow-archive/`, gitignored, kept only as a reference for a possible future non-web-based
flow; this project is 100% web-UI-driven now.)

**Standing pattern -- never call a Vortex-state-gated endpoint unconditionally at page/script load**
(real bug fixed 2026-07-27): every `<script>` tag on this single-page app loads regardless of which
area the URL/nav actually lands on, so any top-level, unconditional call runs on EVERY page load no
matter what's showing. `web/public/sync-app.js`'s own `boot()` used to call `loadSyncProfiles()`
(hits `GET /api/sync/profiles`, which has a real `vortexRunningGate` since it needs the live active
profile) as part of its unconditional startup sequence -- meaning the shared "Vortex is running"
modal could pop up while the user was looking at a completely unrelated page (Utilities, in the case
that surfaced this), and since `boot()` only ever runs once per real page load, clicking over to
Update Collection itself afterward triggered no NEW check, leaving the profile dropdown silently
empty with no explanation at all -- the inverse bug, on the one page that actually needed the check.
Fixed by moving the profiles fetch to fire only from real user actions: the `nav-sync` click
listener (every visit re-checks), a `?area=sync` deep-link hook in `shell.js` (skipped when
returning from the Ignored/Disabled report's own `?profileId=` link, where `boot()` already awaits
it itself), and a fallback on the profile `<select>`'s own click if it's still empty. **This mirrors
a pattern this project already had right**: Rebuild Collection's own Vortex-state check only ever
runs when the user explicitly clicks **Load Vortex Data** (`refreshVortexData()` in `app.js`), never
on that page's initial landing -- its own `loadCollections()` eager call is safe specifically
because `/api/rebuild/collections` is gate-free (pure filesystem scan). Vortex Scrub
(`cleanup-app.js`) and Missing Masters (`missing-masters-app.js`) both already follow this same
correct shape too (zero eager calls at script-parse time, checks fire from tab-show/button-click
only). **Any future area added to this app must follow the same rule**: a Vortex-state-gated route
(anything with `vortexRunningGate` server-side) may only ever be called from an explicit action --
a button click, a nav/sub-tab visit, a focus/visibility event scoped to that area being the one
currently visible -- never unconditionally at load, regardless of which area happens to be showing.

**Standing pattern -- client-side navigation must keep the URL in sync** (real bug fixed 2026-07-27,
same session as the fix above): `showToolArea` (`shell.js`), `showReportsSubTab` (`stats-app.js`),
and `showUtilitiesSubTab` (`cleanup-app.js`) never touched `location`/`history` before -- clicking
between nav tabs and sub-tabs was purely a DOM class-toggle, so the address bar (and thus any
browser refresh) kept showing whatever `?area=`/`?reports=`/`?utilities=` the page happened to first
load with. The user's own real symptom: refreshing the browser always landed back on Update
Collection specifically, no matter which tab they'd actually been viewing -- because that was the
last real deep link (`?area=sync`) ever visited, and nothing since had updated the URL to reflect
subsequent nav-tab clicks. Fixed by having all three functions call `history.replaceState` (never
`pushState` -- this updates the CURRENT entry, it must not pile up a new Back-button stop per tab
click) to write `?area=`/the relevant sub-tab param every time they run, and clearing the OTHER
area's own sub-tab param (`?reports=`/`?utilities=`) when navigating away from it, since the
`?reports=` branch in shell.js's own jump-link handling takes precedence over `?area=` if left
stale. **Any future area/sub-tab must do the same**: whatever function actually switches the visible
view is responsible for writing its own URL state back, not just toggling `hidden` classes.

Three-phase, human-in-the-loop workflow (Vortex itself performs the actual mod installation — this
tool only brackets that step):

1. **Backup** (Vortex closed) — snapshots which mods are currently ignored/disabled for a
   collection.
2. In Vortex: click **Update** → **Download Update** → choose **Later** (not Install Now).
3. **Apply Ignores** (Vortex closed) — marks the backed-up ignored mods as ignored in the *new*
   collection's rules, so Vortex's installer skips them.
4. In Vortex: click **Resume**. This is the slow step (Vortex's own archive extraction) — not
   controlled by this tool.
5. **Apply Disables** (Vortex closed) — restores the disabled state on mods that should stay
   disabled, now that Vortex has assigned them real mod IDs.
6. **Compare** (optional, anytime) — generates an HTML report of what changed vs. a backup, without
   touching Vortex's state at all.

See `lib/vortex-sync/lib.js` for the full implementation and `lib/sync-runner.js` for the
framework-agnostic orchestration shared by the CLI, terminal menu, and web UI.

### Vortex version compatibility check

A standalone popup (`#vortexVersionWarningModal`, wired in `web/public/shell.js`) checks once at
every app startup whether the currently-installed Vortex (read via `app###appVersion` in state.v2)
is one this tool's live writes have actually been tested against
(`TESTED_VORTEX_VERSIONS` in `lib/vortex-sync/lib.js`). Previously this check only ran inside Apply
Ignores' Preview step; decoupled to app-startup since it's a whole-app compatibility question, not
specific to one step. `GET /api/sync/vortex-version-check` (`web/sync-routes.js`) reports
`{vortexRunning}` if Vortex is open at that moment (skipped silently, re-checked next launch — not
an error) or `{vortexVersion, versionTested}` otherwise. A "Don't show this again" checkbox on the
popup persists `hideVortexVersionWarning` to `config.json`; also exposed as its own toggle under
Settings → Update Collection, so it can be turned back on without hand-editing the file.

Separately, `assertRulesShapeKnown()` (also in `lib/vortex-sync/lib.js`) is a real, already-wired
structural tripwire: it refuses any live write if a mod's `rules` array (or an individual rule)
doesn't match the shape this tool expects, with a "Vortex's state layout may have changed" error —
this catches an actual schema change under the version check's radar (e.g. a not-yet-tested version
that happens to still report a familiar `appVersion` but has changed the data shape underneath).
`writeDisabledFlags()` has an equivalent inline guard on the one value it writes (`modState###...
###enabled` must be exactly `"true"`/`"false"`).

### Identity-drift detection (matching, not writing, is the real risk surface)

The two live-write functions above already refuse outright on an unfamiliar OUTER shape, so neither
can silently write garbage. The actual gap was narrower: the INNER identity fields used to figure
out *which* mod a rule/ref refers to (`reference.fileMD5`, `reference.repo.modId`,
`attributes###fileMD5`, etc. — see `identityKeys()`) were read with no validation at all. If Vortex
ever renamed one of those fields, every read of it would silently come back `undefined`, matching
would silently degrade to "matches nothing", and that gets reported today as "removed by the
collection author" / "not found installed" — a plausible-sounding but WRONG explanation for what's
actually a tool/Vortex incompatibility, not real removal.

`identityDriftWarning()` (`lib/vortex-sync/lib.js`) closes this: given a batch of identities freshly
read from LIVE state (never from a backup — a historical snapshot being sparse is normal), it flags
the situation as suspicious once ≥80% of ≥3 candidates come back with zero identity fields at all
(md5, tag, and modId+fileId all missing) — high enough to tolerate a handful of genuinely
bare-identity mods (some real off-site mods lack this data) without false-triggering on an ordinary
collection. Wired into both matching functions:
- `applyIgnoresToRules()` — candidates are every CURRENT rule's identity (the collection you're
  updating TO), returned as `identityWarning` alongside `changed`/`unmatched`.
- `findCurrentModIdsChecked()` — a new function alongside the original, unchanged
  `findCurrentModIds()` (kept exactly as-is since Rebuild Collection's `state-query-worker.js` and
  `sync-cli.js`'s own direct calls depend on its bare-array return; changing that contract would have
  risked the well-tested Rebuild Collection flow for an Update-Collection-only feature). Candidates
  are every id actually found under `persistent###mods###<game>###` during the full-scan fallback —
  confirmed real installed mods, not merely "some ref didn't match yet" (which is normal/expected
  when Resume hasn't finished installing a dependent mod).

Surfaced distinctly everywhere a result reaches a person — never blended into the normal
"removed"/"not found" text: `sync-app.js` shows it in the same `.callout--critical` box used for real
errors; `sync-cli.js` prints it as its own `⚠ WARNING:` line, separate from the dry-run/apply output
above it.

### Compare Report (`lib/vortex-sync/report.js`)

Restyled 2026-07-25 to match the other two Reports sub-tabs (Stats Report, Work Through Report)
exactly, per explicit direction that all three should look and feel the same. Was previously a fully
separate, self-contained HTML document with its own inline CSS/light-mode-only look and several
stacked tables (Added by author, Removed by author, Removed-ignored, Disabled-kept, Unmatched) —
now:
- Reuses `/styles.css` directly (no duplicated app-header/nav — it renders inside an `<iframe>`
  already sitting under the app's own Reports chrome, see `stats-app.js`'s `showUpdateCompareReport`)
  and a small inline bootstrap that reads `localStorage.getItem('theme')` so it follows the user's
  explicit light/dark choice, not just OS preference (localStorage is shared across same-origin
  documents, including this iframe).
- All 5 mod categories (Added/Removed by author, Marked Ignored, Kept-Disabled, Not Found Anymore —
  plus Needs Manual Disable when `outPath` is set) are ONE combined, filterable `.plan-table` with a
  Status column, driven by clickable `.summary-badges`/`.badge--clickable` — same exact mechanism and
  inline-script pattern as `sync-routes.js`'s `renderIgnoredDisabledReport` and `stats-app.js`'s Current
  Issues badges, not a new one-off pattern. New generic `.badge--info/success/warning/critical/neutral`
  and `.status-pill--info/success/warning/critical/neutral` CSS variants (styles.css) back this — reuse
  these for any future report needing the same four-color severity language on a badge/pill instead of
  inventing per-status colors.
- `modRules removed` (only ever meaningful when `outPath` is set, i.e. never for the web UI's own
  Compare button) is no longer shown unconditionally — it's gated behind `outPath` now, consistent
  with its sibling outPath-only stats (Plugins auto-disabled, Needs Manual Disable), rather than
  displaying a permanently-zero, unexplained number.
- All body copy rewritten per the `plain-language-writer` skill (dropped "collection.json has no
  per-mod enabled/disabled field", "confirmed against Vortex's own source", and similar internal
  implementation detail that had leaked into user-facing text).

## Safety notes

- Vortex must be fully closed before any state-database read or write — both flows check this and
  refuse otherwise.
- Any live *write* to Vortex's state DB (`apply-ignores`/`apply-disables`) takes a full backup of
  the entire `state.v2` directory first (`lib/vortex-sync/state-backups/`, gitignored — **can
  contain Vortex's stored Nexus API tokens, never commit or share this directory**).
- All state-database access (reads and writes) runs in an isolated child process with a timeout —
  `classic-level`/LevelDB has been confirmed able to hit a native, unrecoverable assertion crash on
  certain real-world write-ahead-log shapes, even with Vortex fully closed. Isolation means a crash
  only kills that one short-lived worker, not the whole server; if a run seems to hang, check your
  taskbar for a hidden Windows assertion dialog and click Abort.
- Rebuild Collection never writes to Vortex's state database at all — only to the staging
  filesystem layer, using a crash-safe `.rebuilding`/`.old` swap (mirroring Vortex's own
  `.installing` convention) so an interruption never leaves a half-extracted mod in place.
- Expect Vortex's own "External Changes" prompt after a real rebuild, for every `REBUILT` mod —
  this is expected, not a sign of corruption. See the note under **Rebuild Collection** above.
- **`logs/` is not backed up by anything in this project** — it's the *only* record of a
  collection's rebuild history (status per mod, "last extracted" timestamps, missing/changed file
  diffs), and it's just plain JSON on disk, as deletable as any other file here. Include it in
  whatever backup routine already covers the rest of your Skyrim/Vortex setup.
- **`config.json` (project root) is gitignored and holds your Nexus API key in plain text** — never
  encrypted at rest, only kept out of git. Same threat model as most local single-user dev tools;
  see **Settings & configuration** above. Include it in your own backup routine if you don't want to
  re-enter everything after a fresh machine/reformat.

## Callout severity conventions

Four severities -- informational/warning/critical match Vortex's own real notification system
(confirmed against `Nexus-Mods/Vortex`'s own source, `src/renderer/src/views/Notification.tsx` /
`tools/iconconfig.json`): informational uses a genuinely different icon shape (circled "i"), while
warning and critical are differentiated **only by color**, using the identical triangle-alert icon
— Vortex does NOT use a separate icon shape for warning vs. error/critical. This project follows
the same rule. Success has no Vortex equivalent to match (its own notification list doesn't
distinguish "you did something and it worked" from plain info) but fits the same green already
used elsewhere in this app for a completed/successful state (`--success`, `REBUILT` badges/pills).

| Severity | CSS class | Color token | Icon | When to use |
|---|---|---|---|---|
| Informational | `.callout--info` | `--accent` / `--accent-bg` (blue) | `&#9432;` (circled i) | Plain status or instructions — nothing is wrong. E.g. "Next steps in Vortex" (what to click next), a first-run welcome banner. |
| Success | `.callout--success` | `--success` / `--success-bg` (green) | none fixed yet -- a checkmark would match the badge/pill convention | Something completed. No callout currently uses this (only inline badges/pills/status text do) — added for a complete palette, not yet exercised by a real callout. |
| Warning | `.callout--warning` | `--warning` / `--warning-bg` (amber) | `&#9888;` (triangle-alert) | Needs attention but isn't blocking — an optional feature got skipped, a version compatibility caveat, "Vortex is running" gates. |
| Critical | `.callout--critical` | `--danger` / `--danger-bg` (red) | `&#9888;` (same triangle-alert, red) | A real failure or a step that cannot proceed until the user does something — a write to Vortex's database failed, a collection id no longer exists, a native crash. |

Outside of callouts, this same five-color system also covers: **grey** (`--text-muted` / `.muted`)
for plain secondary verbiage with no severity at all (the overwhelming majority of this app's text);
blue is additionally used for `.btn--primary`/links (a UI-affordance blue, not a severity signal —
don't read every blue element as "informational").

**Markup shape** (all four): a `<div class="callout callout--{severity}">` containing a
`<div class="callout__title">` (icon + short label) and body content (`<p>`/`<ol>`/`<ul>` as
needed) — see `web/public/index.html`'s existing callouts (`syncBackupNextSteps`,
`syncCollectionStaleError`, `syncBackupCriticalError`, etc.) for real examples of each severity.

**Critical messages built from a shared plain-text string** (e.g. `lib/sync-runner.js`'s
`CRASH_HELP_TEXT`, reused verbatim by the CLI's own console output) are rendered into this same
structured markup client-side by `web/public/sync-app.js`'s `renderCriticalMessage()` — a generic
`\n\n`-block parser that turns a trailing run of `"1. ..."`/`"2. ..."` lines into a real `<ol>`,
rather than needing a second, separately-maintained HTML copy of the same wording. Reuse this
function (or its same parsing convention) for any future shared plain-text/HTML message pair,
rather than inventing a new one-off format.

**Modals carry the same severity convention too, not just callouts** (added 2026-07-25) — a blocking
modal (something the user genuinely cannot proceed past, e.g. "Vortex is currently running" or
"Can't reach the server") gets the same icon + color token as its matching callout severity, applied
to the modal box's border and `<h2>` instead of a full-width callout: `.modal--warning` /
`.modal--critical` (see `web/public/styles.css`). Markup: `<div class="modal modal--{severity}">` with
`<h2>&#9888; {title}</h2>` — same triangle-alert icon as warning/critical callouts, no separate icon
shape. "Vortex is running" is `.modal--warning` (a resolvable gate, matching the callout table's own
classification above) — "Can't reach the server" is `.modal--critical` (a real failure, nothing works
until it's fixed). Real examples: `#vortexRunningModal`, `#serverUnreachableModal`.

**Prefer a shared centered modal over a top-level banner for a blocking, page-wide condition**
(added 2026-07-25, replacing the old per-tool-area `#vortexBanner`/`#syncVortexBanner`) — a banner
sitting at the top of a long page is easy to trigger completely off-screen if the user has scrolled
down into a later step, with nothing visible to explain why an action silently didn't work (confirmed
live, twice, before this fix). A modal is fixed/centered, so it's always seen regardless of scroll
position, and the user's scroll position is preserved once they dismiss it — no scroll-to-top hack
needed. Use a top-level banner instead only when the condition is genuinely **non-blocking** and the
user should be able to keep working elsewhere on the page while it's visible (e.g.
`#settingsFirstRunBanner`, `#syncBackupRootMissingBanner` — an advisory nudge, not something that
halts every other action). If in doubt: can the user still do something useful elsewhere on this
page right now? If no, use the modal. If yes, a banner is fine.

**Known inconsistency, not yet fixed** — several existing `.callout--warning` uses in this app
aren't actually warnings under the table above; they're informational/instructional and should
eventually become `.callout--info` (e.g. the "Next steps in Vortex" boxes, the first-run Settings
welcome banner). See **Future work**'s "Callout icon/classification pass" for the full inventory
this needs — this section defines the target convention; that TODO is the work of migrating
everything already-shipped over to it.

## Rules Generator

**What it's for:** some collections are layered — a base collection on 2K textures, a second
collection sitting on top swapping in 4K equivalents. The upper collection needs the same
before/after conflict rules as the one underneath; setting those by hand per-mod is the chore this
tool removes. Full original brief: `F:\Downloads\rules-generator-phase1-prompt.md`.

**Status (2026-07-26):** Phase 1 (data-collection/validation, read-only) and Phase 2's review UI
(expandable Ready to copy / Needs your input / Nothing to do lists, per-row overrides, conflict-file
indicators) are both built and confirmed working. Phase 2's write path ("Apply to Vortex" — see
below) is being built now.

Everything below was confirmed against **real live data** (the user's actual Vortex install) and
**Vortex's own GitHub source** (`Nexus-Mods/Vortex`), not assumed from the collection-tools API
docs — several of these facts directly contradict what a first read of the brief would suggest.

### The core mechanism, confirmed with a real fixture

Test fixture: old collection **"GTS - PBR Visual Overhaul"** (Vortex modId `742116`, has a real
`collection.json`), new collection **"Rules Generator"** (Workshop-only, key
`vortex_collection_RmrIQqMjP` — never published to Nexus, confirmed intentional: Nexus refuses to
publish a collection with unresolved rule conflicts, which is exactly the problem this tool
exists to fix). Test mod: Nexus modId `174492` ("Tomato's Windhelm PBR"), hosting two files under
one mod page — `730505` ("...2K") and `730506` ("...4K"). New collection has both files as
members; old collection has only the 2K file (`730505`) — confirmed by the user as the expected,
normal shape (old collection = source of rules; new collection = both size variants).

**The link (old→new mapping signal):** the user manually sets exactly one rule, on the **new**
(4K) mod, in Vortex's own "Manage rules" dialog: `4K after 2K`. This is the *only* thing that
identifies which new mod maps to which old mod — direction is always old→new, never inferred the
other way. Important nuance confirmed live: the new mod is **not guaranteed to have only that one
rule** — in this fixture the 4K mod's own `rules` array had 2 entries (the real link, plus an
unrelated pre-existing `after "Faultier's PBR Skyrim AIO 2k"` rule). So "count the rules, expect
exactly 1" (a literal reading of the original brief) is wrong — the link rule must be
**identified** (its target is a `requires`/membership entry of the *old* collection specifically),
not assumed to be the sole entry. Any *other* rule already set on the new mod, or any rule the new
mod has that the old mod doesn't, is left untouched by design — only reported, never
touched/reconciled.

**"Exactly one candidate" is not a safe signal on its own — confirmed with two real false
positives, 2026-07-26.** `Praedy's Fort Dawnguard - SE V3 4K` and `Blended Roads Redone 4K` each
resolved to exactly one candidate rule pointing at an old-collection member (`Skyland AIO`, an
unrelated hub mod both happen to have an ordinary conflict rule against) — same clean "1 result"
shape as every genuine pairing, with nothing in the rule data itself to tell them apart. The
user confirmed directly in Vortex: neither mod has any real relationship to Skyland AIO, and
`Fort Dawnguard` isn't even a member of the old collection at all.

**Fix: a required name-similarity gate, not just a tie-breaker.** `lib/rules-generator.js`'s
`namesLikelyMatch` normalizes each mod's display name (strip a standalone `1k`/`2k`/`4k`/`8k`
token, lowercase, strip punctuation) and requires the new mod's name to match-or-contain/be-
contained-by the candidate's name. This gate is applied to *every* candidate, not only when
there's more than one — it rejected both false positives above (no name resemblance to
`Skyland AIO`) while resolving every real pairing cleanly, **and** it fixed two cases that were
previously stuck as ambiguous (`Praedy's College of Winterhold 4K`, `Exist's Caves PBR 4k` — each
had multiple raw candidates, but only one resembled the mod's own name once irrelevant
conflict-rule noise was filtered out). Verified against the full real 21-member "Rules Generator"
collection: every member either resolved to exactly one name-matching candidate or was correctly
rejected (a hub mod with dozens of unrelated conflicts, or a genuinely new addition with no old-
collection counterpart at all) — zero remaining ambiguous cases in that run.

### Rule storage is bidirectional — the single biggest gotcha here

A conflict-resolution rule (`before`/`after`/`conflicts`) can be stored on **either** mod's own
entry — Vortex does not always write it on both sides. Confirmed directly from Vortex's own
source, `extensions/mod-dependency-manager/src/util/findRule.ts`'s `isConflictResolved`:

```ts
const CONFLICT_RULE_TYPES = ["before", "after", "conflicts"];
// checks mods[modId].rules for a rule referencing otherMod, OR
// mods[otherMod.id].rules for a rule referencing modId (reverse direction)
```

and `extensions/mod-dependency-manager/src/views/ConflictEditor.tsx` (the actual "Manage rules"
dialog), which is where **"???" in Vortex's UI is confirmed to mean "no rule exists in either
direction," not a stored `type: "unknown"` value**:

```tsx
const rule = rules[modId][conflict.otherMod.id] ?? { type: undefined, version: "any" };
// if (rule.type === undefined) { ...look for a reverse rule on the OTHER mod, type inverted... }
value={rule?.type || reverseRule?.type || "norule"}
...
<option value="norule">???</option>
```

**Proven with real data**, not just source-reading: reading the 2K mod's own `rules` array
directly gives only **3** rules (after "Faultier's PBR Windows", before "Detailed Rugs PBR",
after "Faultier's PBR Skyrim AIO 2k"). But Vortex's own "Manage rules" dialog shows **7** rules
against that same mod — the other 4 (Atmoran Legacy, Faultier's PBR Skyrim AIO 4k, SMIM SE 2-08,
and the 4K link itself) are each stored on the *other* mod's own entry, with before/after inverted
for display (e.g. Atmoran Legacy's own entry literally says `after Tomato's Windhelm PBR - 2K`,
which is why 2K's dialog shows `before Atmoran Legacy`). **Reading only a mod's own `rules` array
misses more than half its effective rules in this exact case.** Any code that builds "the full
rule set for mod X" must scan every other mod's rules for ones that reference X back, not just X's
own array — confirmed as the required design (option B, not A) directly by the user.

### Where "the old mod's rules to copy" actually comes from — DB-primary, collection.json fallback

The original brief's literal wording said to read the old mod's rules from `collection.json`
(since the old collection has one and the new one doesn't). Verified instead of assumed: the live
DB and collection.json mostly agree but **do drift** — collection.json's own `modRules` for the
Windhelm 2K mod (matched by `fileMD5`) returns only **5** of the **7** rules found live in the DB
(missing an `after "Faultier's PBR Skyrim AIO 4k"` rule that was evidently added/changed in Vortex
*after* the collection was last published — genuine live drift from the static snapshot, not a
bug). Decision (2026-07-26, confirmed with the user): **read the old mod's actual rule set from
the live DB when it's installed there** (freshest, captures live drift, one matching code path
shared with the new-collection side) **and fall back to collection.json's `modRules` only when
the old mod has no live DB entry at all** (e.g. genuinely not installed/resumed on this machine).
Collection membership itself — "which mod is conceptually the old collection's 2K mod" — still
comes from `collection.json`'s `mods[]` (same convention Rebuild/Update Collection already use,
portable, no Vortex-closed dependency needed just to answer that).

**Collection.json's `modRules[]` is bidirectional too**, for whichever cases actually hit the
fallback path — same lesson as the live DB, same flat-array structure, same need to check both
`source` and `reference` before inverting.

### Reference-matching: the real priority order, and three distinct raw shapes

Confirmed from Vortex's own `src/renderer/src/extensions/mod_management/util/testModReference.ts`
(`testRef`), the authoritative matching logic every rule reference is checked against, in
practice-relevant priority order:
1. `fileMD5` (exact file hash — strongest, most portable)
2. `repo.modId` + `repo.fileId` (Nexus identity — **both compared as strings**, e.g.
   `ref.repo.modId === (mod.modId).toString()`)
3. `logicalFileName` / `fileExpression` (name-based; `fileExpression` supports exact match or a
   `minimatch` glob against the sanitized archive filename)
4. bare `id`/`idHint` — explicitly documented in Vortex's own source as **"only useful in the
   current setup"**: it's just the mod's literal internal Vortex DB key string
   (e.g. `"Faultier's PBR Skyrim AIO 2k-125308-2-0-4-1751801188"`), not portable across a
   reinstall/update or a different machine. Roughly half the live rules found in this fixture use
   this shape with no `fileMD5` at all — a matcher that only trusts `fileMD5`/`repo` would silently
   fail to identify a real, already-resolved rule.

Three genuinely different raw shapes were found in live practice, not just theoretically:
- Collection-membership rules (`type: "requires"`, on a collection's own entry):
  `{description, fileMD5, gameId, fileSize, versionMatch, logicalFileName, tag, repo: {repository, gameId, modId, fileId, campaign}}`
  — `repo.modId`/`repo.fileId` here are **strings** (`"174492"`), while a plain mod's own
  `attributes###modId` DB value is a **number** (`174492`) — a strict `===` across the two
  silently fails.
- A mod's own richer ordering-rule shape (matches collection.json's `modRules[]` shape exactly):
  `{fileExpression, fileMD5, versionMatch, logicalFileName}`
- A mod's own sparser ordering-rule shape (no `fileMD5` at all):
  `{id, idHint, versionMatch}`

Also: `isDependencyRule` (`testModReference.ts`) confirms `"requires"`/`"recommends"` are a
*different category* from `"before"`/`"after"`/`"conflicts"` — dependency/membership rules vs.
conflict-ordering rules. Collection membership should always be read via `type === "requires"`,
never conflated with ordering rules.

### Other confirmed gotchas

- **`collection.json` itself has an internal field-name inconsistency**: `mods[].source` uses
  `.md5`, while `modRules[].source`/`.reference` use `.fileMD5` — same file, two different key
  names for the identical concept. Easy to miss, breaks a naive shared-lookup helper silently.
- **A Nexus mod page can host multiple files under one modId** (confirmed: modId `174492` has
  both the 2K and 4K files as separate `fileId`s) — `modId` identifies the mod page, `fileId`
  identifies the specific variant/file. A mod can also be re-uploaded at a new `fileId` for the
  same display name after an update (confirmed: modId `144182`'s "Tomato's PBR Solitude 2k" file
  existed at two different `fileId`s across versions) — don't assume one name ⇒ one stable fileId.
- **Nexus's REST `files.json` endpoint does not expose a file's md5** — only Vortex's own
  post-download hashing produces `fileMD5`. Cross-referencing a Nexus file listing against a
  collection's `fileMD5` values isn't possible via the API alone.
- **A Nexus collection slug only exists once a revision is actually published or drafted** — a
  Workshop-only collection with nothing ever uploaded to Nexus has no real slug, and the
  GraphQL API's `collection(slug)` query returns a clean `NOT_FOUND`-style error for it (confirmed
  live against slug `RmrIQqMjP`, which turned out to be the collection's *local* Workshop id
  — the `vortex_collection_<id>` DB key suffix — not a Nexus slug at all).

### Reusable building blocks confirmed (don't reinvent these)

- DB access: `lib/vortex-sync/lib.js`'s `withStateDb()` (hardened, requires Vortex closed,
  copies-then-opens-read-only). `getRules(db, modId)`, `getModValue(db, modId, field)`,
  `listProfiles(db)` all reusable as-is.
- Profile/collection picker: same `listProfiles()`/`scanStagingCollections()`, already exposed via
  Update Collection's `/api/sync/profiles` route — reuse the pattern, don't reimplement the picker.
- Nexus collection lookup: `lib/nexus-collection-download.js`'s `fetchCollectionRevisions(apiKey, slug)`.

### Phase 1 deliverable and its first real-collection run

`lib/rules-generator.js` (core logic: `buildModIndex`, `refMatchesEntry`/`resolveRefToModKey`,
`getEffectiveRules`, `getCollectionMembers`, `findCollectionByName`, `getOldModRuleSet`) +
`cli/rules-generator-cli.js` (standalone runnable script, matching this project's own convention of
CLI entry points under `cli/` + shared `lib/` logic — see **Project structure** below). Usage:
`node cli/rules-generator-cli.js [--old "Collection Name"] [--new "Collection Name"]`.

First run against the real, full "Rules Generator" collection (not just one isolated test mod)
correctly resolved the validated Windhelm PBR 2K/4K pairing end-to-end, and also auto-detected a
second real pairing (`Tomato's PBR Solitude` modId 144182 → `Tomato's PBR Solitude - Remastered 2k`
modId 181707 — the same pairing found by hand earlier this session, this time picked up
automatically) — good independent cross-validation of the whole mechanism.

**But it also surfaced a real gap, not just a clean pass:** the link-identification heuristic
("exactly one candidate rule whose target is an old-collection member = the link") produced a
likely **false positive** once more than a couple of new-collection members existed at once — a
mod with only one ordinary conflict rule that happens to land on an old-collection member gets
mistaken for a genuine replacement link. Confirmed with the user this is a real risk, not just
test-data noise to shrug off: **never silently guess a mapping or a remapped rule target unless
the match is unambiguous.** Anything uncertain — no candidate found, multiple candidates, or (once
built) an ambiguous remap target — goes into a review list, not a silent decision.

**Confirmed UX pattern to reuse for that review list** (2026-07-26): the existing **Work Through
Report** (`web/public/work-through-app.js`) already solves exactly this shape of problem —
each unresolved item carries a `resolveKind` discriminant (`mismatch`, `force-extract`,
`retry-extraction`, `delete-duplicate`, etc.) that determines which action button(s) render, each
calling its own dedicated resolve endpoint. Rules Generator's own review list (once built) should
follow the same pattern: each "I don't know" item gets a `resolveKind` (e.g. `no-link-found`,
`link-ambiguous`, `remap-ambiguous`), with resolution offered **both** in-app (pick the answer,
same as Work Through Report's buttons) **and** by pointing the user at exactly what to fix in
Vortex directly (Work Through Report's off-site-archive case does the equivalent today — an
informational note telling the user what to do in the other tool, not a deep link, since Vortex
has no inbound-link mechanism this project can hook into).

### Counterpart detection for a rule target that isn't the primary test pair (2026-07-26)

Real scenario found while reviewing a fuller "Rules Generator" collection: the *old* mod
(`Whiterun Remake - PBR - 2k`) has a real resolved rule — `after "Faultier's PBR Skyrim AIO 2k"`
— but the *new* collection separately gained `Faultier's PBR Skyrim AIO 4k` as an added member
(not linked to anything, shows `???` in Vortex's own dialog since no explicit rule connects it to
its 2k counterpart yet). Copying the old rule verbatim onto Whiterun-4k would still point at the
2k variant of Faultier's mod — the ambiguous-remap case the original brief already anticipated
(step 8), just reached by a target that has no explicit linking rule of its own.

**Resolution, confirmed 2026-07-26: no Nexus API call needed for this.** Both
`Faultier's PBR Skyrim AIO 2k` and `...4k` are already installed, so both already carry their own
`attributes###modId`/`attributes###fileId` in the local mod index (`buildModIndex`) — same modId,
different fileId is a direct, local, zero-network signal that two installed mods are counterparts
of the same Nexus mod page, independent of whether any Vortex rule ever explicitly linked them.
This extends the ambiguity/remap check to catch targets whose counterpart was simply *added* to
the new collection rather than deliberately rule-linked.

**Nexus API is a fallback only, for if/when local matching genuinely isn't enough** — confirmed
the user's account has no Nexus Premium, so any such fallback call must stick to metadata
endpoints only (`files.json`, GraphQL collection queries — both already proven to work without
Premium earlier this session) and never the download-link endpoints that this project's own
`nexus-mod-download.js` already correctly gates behind a Premium check (see **Downloading missing
archives automatically** above). No concrete case has actually required this fallback yet — every
scenario found so far resolves from already-installed local data.

**Resolution UX, confirmed 2026-07-26:** no standalone popup — unresolved/ambiguous cases surface
in a new Rules Generator report, following the Work Through Report's `resolveKind` pattern
documented just above, not a separate dialog mechanism.

**Follow-up bug, found live in the actual review UI (2026-07-26): shared modId alone is not
enough for this check either.** A single Nexus mod page can host genuinely *different* content as
sibling files, not just size variants of the same thing — e.g. `Tomato's PBR Solitude - Remastered
2k` and `...- Darker interior stone` share a modId (both are files on the same mod page) but are
not a 2k/4k pair of each other. `findNewCollectionCounterpart` was matching purely on shared modId
with no name check, and surfaced exactly this as a false "counterpart" option live in the review
page. Fixed by requiring the same `namesLikelyMatch` gate used for the primary link detection —
`"tomato s pbr solitude remastered"` and `"tomato s pbr solitude darker interior stone"` don't
satisfy it (neither contains the other), so this pairing is correctly rejected now. Lesson: *every*
place this project infers a relationship from a shared modId needs the name gate, not just the
first one found.

### Remapping to a counterpart is automatic, not a manual choice (confirmed 2026-07-26)

Originally built as a per-rule manual choice (a radio pair: "keep pointing at the original" vs.
"point at the new collection's own counterpart instead," pre-selected to the original). The user
corrected this directly, watching a real example (`Faultier's PBR Landscapes 4k`, whose original
`after Faultier's PBR Skyrim AIO 2k` rule was defaulting to "same as the original" in the review
UI): **when building a layered collection (2k base + 4k on top), a rule's target should ALWAYS be
remapped to its counterpart once one exists in the new collection — never left pointing at the
original.** This isn't a judgment call between two plausible options; it's the deterministic point
of the whole exercise. The new collection represents the fully-upgraded stack, so any inter-mod
relationship stays inside that upgraded stack once a counterpart exists for the target. Verified
against Vortex's own real, already-resolved rule for the 2k version (`Faultier's PBR Landscapes 2k`
→ `after Faultier's PBR Skyrim AIO 2k`) to confirm the mirrored 4k rule should indeed become
`Faultier's PBR Landscapes 4k` → `after Faultier's PBR Skyrim AIO 4k`.

**What changed:** a `rulesToConsider` entry that finds a counterpart now gets `status: 'remapped'`
(not `'ambiguous'`) with `targetKey` already set to the counterpart and `originalTargetKey` kept
for transparency — auto-resolved, not sent to manual review, but still shown in the "Ready to
copy" table with an inline note ("the original pointed at X — updated to the new collection's own
version") rather than silently hidden. The only thing that still genuinely needs a manual choice
is an **anomaly** — more than one candidate for which OLD mod a NEW mod even links to in the first
place; that has no deterministic answer the way a same-modId remap does.

**Dedupe had to run a second time, after remapping** — `resolvedCopyableRules` already dedupes by
the pre-remap target, so two rules that pointed at different targets before remapping but the
*same* target after (one already said `after AIO-4k` directly, another said `after AIO-2k` and got
remapped to `AIO-4k`) would otherwise both survive as redundant entries. Confirmed live
(`Tomato's PBR Solitude 4k` had exactly this duplicate) — fixed with a second dedupe pass in
`analyzeCollections`, keyed on the post-remap `(type, targetKey)` pair.

### The exact reference shape a newly-written rule needs (confirmed live, 2026-07-26)

Before designing the write path, checked what Vortex itself actually writes for a manually-created
rule between two already-installed mods — not guessed. Read `Faultier's PBR Landscapes 2k`/`4k`'s
real `rules` arrays directly (read-only, `withStateDb`, Vortex closed). Out of 12 rules on the 2k
mod and 12 on the 4k mod, **11 of the 12 on each use the bare `{id, idHint, versionMatch: "*"}`
shape** — including the exact manually-set "4K after 2K" test link rule from earlier Phase 1
research:
```json
{ "type": "after", "reference": { "id": "Faultier's PBR Landscapes 2k-125308-2-0-2-1751799808", "idHint": "Faultier's PBR Landscapes 2k-125308-2-0-2-1751799808", "versionMatch": "*" } }
```
`id`/`idHint` here is just the target mod's own internal Vortex DB key (== this project's own
`modKey`) — the bare/sparse shape TECHNICAL.md already flagged above as "only useful in the current
setup" per Vortex's own source comment. Only one rule (out of 24 total across both mods) used the
richer `{fileExpression, fileMD5, versionMatch, logicalFileName}` shape, paired with a `source`
field identifying which of the two size variants the rule was set from — likely written by a
different Vortex code path (e.g. collection `modRules` import), not the plain "Manage rules" dialog.

**Superseded/refined below (2026-07-26) — checked Vortex's actual source, not just the data.**
The data above was empirically correct but `idHint` turned out NOT to be part of the write itself —
see the next section for the source-verified mechanism, which is what this project's write path
actually implements.

### Vortex's real rule-write mechanism — verified against actual GitHub source (2026-07-26)

Per the user's explicit instruction to be "100% in-sync" with Vortex before writing anything,
checked the real mechanism directly (`Nexus-Mods/Vortex`, via `gh search code` + raw file fetches),
not just inferred from the observed data above:

- **The actual rule-write action** (`extensions/mod-dependency-manager/src/views/ConflictEditor.tsx`,
  `buildRuleActions()`) dispatches:
  ```ts
  vortexActions.addModRule(gameId, modId, {
    reference: { id: otherId, versionMatch: this.translateModVersion(mods[otherId], rules[modId][otherId].version) },
    type: rules[modId][otherId].type,
  });
  ```
  A **bare `{id, versionMatch}` reference — no `idHint` at all.** `translateModVersion` returns
  `'*'` for the default "any version" match mode.
- **The reducer** (`src/renderer/src/extensions/mod_management/reducers/mods.ts`, `addModRule`
  handler): `before`/`after` are treated as **one mutually-exclusive group** (`conflicts` is its own
  singleton group). If a rule in the *same group* already references the *same* target
  (`referenceEqual`), the new rule **replaces it in place** (`setSafe` at that index); otherwise
  it's **appended** (`pushSafe`). This create-or-replace semantics is exactly what any code writing
  a new rule must mirror — never a blind append, which could leave a redundant/contradictory
  before+after pair against the same target.
- **`referenceEqual`** (`.../util/testModReference.ts`): for an "id-only" reference (no
  fileMD5/repo/etc. — exactly our shape), it compares by `lhs.id === rhs.id` directly.
- **`idHint` is added later, by a *separate* action/reducer** (`cacheModReference`, same reducer
  file) that Vortex runs on its own schedule to cache a resolved reference — NOT part of the
  initial write. This is why the real rules read directly from the live DB (previous section) all
  had `idHint` present despite the write path never constructing it: Vortex's own caching pass had
  already run by the time they were read. Omitting `idHint` when writing matches Vortex's own
  action creator exactly; `idHint` is a cache, not load-bearing for the write to be valid.

**Conclusion for the write path — this is what's actually implemented:** `{ type, reference: { id:
targetModKey, versionMatch: '*' } }`. No `idHint`, no `source`, no fileMD5/fileExpression
construction — since Rules Generator only ever links two mods that are BOTH already installed in
the same new collection, the bare id-only shape is the exact, source-verified mechanism Vortex
itself uses for this precise scenario, not a fallback. A write must also mirror the reducer's own
replace-vs-append-by-group semantics described above, and `getEffectiveRules` (already built for
the read side) doubles as the idempotency check — if a rule is already effectively resolved either
direction, skip it, matching Vortex's own "???" meaning exactly.

### Write-safety requirement (Phase 2 — being built 2026-07-26)

Confirmed with the user ahead of ever writing code that touches the live DB, then followed exactly
as designed: Rules Generator's `applyRules()` (writing new rules onto the new mod's `rules` entry)
follows the same write-safety pattern `withLiveStateDb`/`backupLiveState` already establish
elsewhere in this project (see **Update Collection** above) — back up the live `state.v2` in full
before any write, refuse to write at all if the backup fails, and test the write logic against a
backup copy first rather than the real live DB. No new mechanism needed — reuses `withLiveStateDb`
exactly as Update Collection's own writes (`writeIgnoredFlags`/`writeDisabledFlags`) already do,
via new `apply-preview`/`apply-write` modes in `lib/rules-generator-worker.js` (same
isolated-worker pairing `state-write-worker.js` already established for Update Collection's own
preview/write split).

**Scope confirmed with the user 2026-07-26:** a single page-level "Apply to Vortex" button commits
everything currently resolved across BOTH "Ready to copy" and any "Needs your input" anomaly the
user has picked a real candidate for (not "???") — one backup+write per click, not one per mod. An
anomaly still left at "???" is simply skipped (not an error) — the user can resolve it later, either
by rerunning this tool or directly in Vortex.

**Gotcha caught before it ever reached the UI: `ruleIdx` must be computed from the same *filtered*
array the frontend renders, not the raw unfiltered one.** `rgRenderReadyCard` (rules-generator-app.js)
filters `rulesToConsider` to `status !== 'unresolved'` FIRST, then indexes the survivors — so a rule
override key like `NewA::1` means "the 2nd *visible* row", not "index 1 of the full array". The
first draft of `computeRulesToApply` indexed the raw unfiltered array instead, which would silently
apply an override to the wrong rule whenever a mod had any unresolved row mixed in before a
resolvable one. Fixed by filtering to `resolvable` first inside `computeRulesToApply` too, exactly
mirroring the UI's own filter — confirmed with a dedicated test (a mod with an unresolved rule
before a resolvable one, override on the visible row) before this ever reached a live test.

**Real performance bug found live (2026-07-26): `getEffectiveRules` must be called once per MOD,
never once per RULE.** `getEffectiveRules(modIndex, modKey)` does a full reverse-scan over EVERY
mod Vortex has ever tracked (across every collection/profile, not just the two being analyzed) to
find rules referencing `modKey` back. The first draft of `applyRules`' idempotency check called it
inside the per-triple loop — so a mod needing 23 rules did 23 full library scans instead of 1. This
scales with the size of the user's *entire* Vortex library, not just the two collections in play,
and is exactly what turned "Checking what would change…" into a real, user-noticed delay on a live
test (confirmed: Vortex closed correctly, gate worked correctly, the preview call itself was just
slow). Fixed by grouping `toApply` by `newModKey` first, then calling `getEffectiveRules` once per
mod and checking all of that mod's candidate rules against the one cached result. Verified with a
synthetic 8,000-mod library fixture: unfixed shape would scale with rules × library size; fixed
shape completed in single-digit milliseconds regardless. Lesson for any future code here: `modIndex`
represents the user's WHOLE Vortex history, potentially thousands of entries — anything that calls
`getEffectiveRules` (or writes a loop around it) must be conscious of that scale, not just the small
number of mods in the two collections being compared.

### Investigated live (2026-07-27): a "???" that looked like a missed rule, but wasn't

Real report: on "GTS - PBR Visual Overhaul" → its 4K upgrade, `Faultier's PBR Landscapes 4k`'s
Vortex rule editor showed `??? → Exist's Caves PBR - 2k` and `??? → Faultier's PBR Skyrim AIO 2k`,
even though the *2k* pairing (`Faultier's PBR Landscapes 2k` ↔ `Exist's Caves PBR - 2k`) clearly had
a real relationship in the old collection. Two things had to be verified before concluding anything,
both against ground truth rather than assumption — exactly the discipline this project has followed
all along:

**1. Vortex's `"(suggested)"` label does NOT mean "not a real rule" — confirmed against
`Nexus-Mods/Vortex`'s own source** (now locally cloned, see below). First guess was wrong: assumed
`"(suggested)"` meant Vortex was live-guessing because no real rule existed. The actual mechanism,
traced through the real source:
- `extensions/mod-dependency-manager/src/util/conflicts.ts`'s `getConflictMap()` computes
  `conflict.suggestion` purely from **file modification timestamps on disk** (whichever conflicting
  file is newer suggests `"after"`) — entirely independent of any saved rule.
- `extensions/mod-dependency-manager/src/views/ConflictEditor.tsx`'s `getRuleSpec()` is what
  actually determines the dropdown's **current value** — it looks ONLY at the real mod's persisted
  `mods[modId].rules` (matched via `util.testModReference`). No rule found → value is `undefined` →
  renders as `"???"`.
- `"(suggested)"` is purely a label decorator on the OPTION text (`conflict.suggestion === "after" ?
  t("after (suggested)") : t("after")`), shown regardless of whether that option is the current
  value. A dropdown showing **`"after (suggested)"` as its current value means a real, saved `"after"`
  rule exists** that happens to also match what the file-timestamp heuristic would suggest — not
  "this is only a suggestion." `"???"` is the only real "nothing saved" state.

**2. With that corrected, checked whether our tool's own reverse-scan actually finds the real rule
— it does.** Wrote a one-off diagnostic (`syncLib.withStateDb` + `rgLib.buildModIndex` +
`rgLib.getEffectiveRules`, run against the real, closed-Vortex live database) and confirmed
`getEffectiveRules(modIndex, "Faultier's PBR Landscapes 2k-...")`'s output DOES include the reverse
entry `{ type: 'before', target: Exist's Caves PBR - 2k, owner: Exist's Caves PBR - 2k, direction:
'reverse' }` — correctly picked up from Exist's Caves PBR-2k's own rule (`type: 'after', reference:
Faultier's Landscapes 2k`, inverted). This rule WAS correctly remapped and written onto the new
4K↔4K pairing — confirmed in the same rule editor screenshot that started this investigation:
`Faultier's PBR Landscapes 4k`'s `before → Exist's Caves PBR - 4k (updated from Exist's Caves PBR -
2k)` is exactly this rule, correctly copied. **Nothing was missed here; the matching/copying logic
worked exactly as designed.**

**So what IS `??? → Exist's Caves PBR - 2k` on the new mod, if not a missed rule?** Confirmed via
the live modIndex: **both** `Exist's Caves PBR - 2k` and `Exist's Caves PBR - 4k` are currently
installed and tracked in Vortex simultaneously (same for `Faultier's PBR Skyrim AIO 2k`/`4k`) — the
old 2k version was never disabled/removed when the 4k upgrade was added. Vortex's own conflict
detector correctly flags a REAL file conflict between the new `Faultier's PBR Landscapes 4k` and
this still-present old `Exist's Caves PBR - 2k` install. But **no rule for this exact pairing
(new-4K-mod ↔ leftover-old-2K-mod) ever existed anywhere** — the old collection never had it (it
only ever knew about 2k↔2k), so there is nothing in `collection.json` or the live DB for our tool to
copy. The `"???"` is accurate: this is a genuinely new relationship, not a resolved one that got
dropped.

**Conclusion — not a bug, but a real, distinct scenario worth surfacing:** Rules Generator's
matching only ever operates on "old collection member → new collection member" pairs. It has no way
to know about, or write rules for, an old-collection mod that's *also* still independently
installed/enabled in Vortex outside the new collection's own member list — that's a mod-management
leftover (the old version should be disabled once its replacement is added), not something rule-
copying can resolve. **Action item, not yet built:** the "Completed vs. Exceptions" report the user
has asked for (see Future Work) should specifically flag this class of `"???"` — an unresolved
conflict against a mod whose OTHER version (same Nexus modId, different fileId) is a real old-
collection member — so it reads as "leftover old install, go disable it in Vortex" rather than a
silent, unexplained gap the user has to rediscover by hand.

### Rules Generator Report (Completed / Exceptions) — Phase 1, 2026-07-27

New Reports sub-tab (`Reports > Rules Generator Report`, same tab-toggle mechanism as Stats/Work
Through/Update Compare Report — `REPORTS_SUB_TABS` in `stats-app.js`). Own picker (old/new
collection, same `/collections`+`/workshop-collections` calls Rules Generator's own page uses),
"Generate Report" button, then two sections:
- **Completed** — every mapping `analyzeCollections` already resolved with confidence (the exact
  set "Ready to copy"/Apply already covers), plus a count of anomalies the user has already picked a
  real candidate for (not `"???"`).
- **Exceptions**, split into the two genuinely different reasons something's still unresolved:
  - **Needs a decision** — Rules Generator's own ambiguous-match case (more than one old-collection
    mod could be the real match), still sitting at `"???"`.
  - **Old version still installed** — the leftover-old-install scenario from "Investigated live"
    above, computed by `findLeftoverOldInstalls()` (`lib/rules-generator.js`): for every
    old-collection member, check whether the new collection has a genuine different-fileId
    counterpart for it (`findNewCollectionCounterpart`, the same shared-modId + name-similarity gate
    already used for the primary link detection) — if so, the OLD fileId's own mod is flagged,
    regardless of whether it's actually still enabled (can't check that yet, see Future Work).
    Worded carefully as "still installed", not "definitely conflicting", since this tool can't
    confirm either an active-profile enabled state or a real file conflict without a much more
    expensive check.

Server: `lib/rules-generator.js`'s `computeReportData()` (calls the existing `analyzeCollections()`,
adds nothing new to the matching logic itself) → `'report'` mode in
`rules-generator-worker.js`/`rules-generator-runner.js`, same `withStateDb` read-only isolated-
worker pattern as `'analyze'` → `POST /api/rules-generator/report`, same `vortexRunningGate` as
every other Rules Generator route.

**Verified two ways before considering this done:** (1) a standalone script against a real,
Vortex-closed **snapshot copy** of `state.v2` (see below — copied specifically so testing this
didn't require the user to keep closing/reopening real Vortex mid-session), confirming
`computeReportData` reproduces the exact real scenario confirmed live in "Investigated live" above
(both `Faultier's PBR Landscapes` and `Faultier's PBR Skyrim AIO` correctly flagged as leftover-old-
install exceptions for the real `GTS - PBR Visual Overhaul` → `Rules Generator` collection pair);
(2) the actual UI, real and empty states both, via a mocked `fetch` returning that same verified
data (Vortex was open/in active use at the time, so the live route itself couldn't be exercised
end-to-end — `vortexRunningGate` blocks on ANY `vortex.exe` process system-wide, not scoped to which
`state` directory a request happens to be reading, so even a second server instance pointed at the
safe snapshot copy would have been blocked too; confirmed this rather than assuming it).

**Snapshot-copy testing pattern** (worth reusing whenever live-DB-dependent work needs testing while
Vortex is genuinely in use for something else): a plain recursive copy of the real `state.v2` folder
to a scratch directory, taken while Vortex was confirmed closed (`isVortexRunning()` — a plain
`tasklist` check for `vortex.exe`), then opened directly via `classic-level` + `buildModIndex` to
confirm it reads back identically to the live original (mod count matched: 4,626). Safe because nothing
ever writes back to it. Not the same thing as `withStateDb`'s own copy-then-read (which additionally
excludes the `.log` WAL file to dodge a replay-crash risk that only exists during an actual live
copy race) — fine for a one-off read-only test fixture, not a substitute for `withStateDb` in real
product code.

### Local Vortex source clone (2026-07-27)

`F:\Claude Workspace\vortex-tools\Vortex` — a full local clone of our fork of Vortex's own source
(`awesmdiver/Vortex`, forked from `Nexus-Mods/Vortex`; `origin`/`upstream` remotes, same convention
as the skyrimvr-claude-toolkit fork). Set up specifically because this project repeatedly needs to
verify assumptions against Vortex's actual behavior — grepping a local clone is much faster and more
reliable than repeated `gh api`/`gh search code` round-trips. Check here first before a fresh GitHub
call; `git fetch upstream && git merge upstream/master` (or `gh repo sync`) if it's gone stale.

### Confirmed live (2026-07-27): the WAL-exclusion tradeoff can silently drop real, recent writes

`copyStateDb`'s deliberate exclusion of Vortex's write-ahead log (`*.log`) when making the safe,
read-only copy every DB read in this project goes through (`withStateDb`, see that function's own
header comment) was accepted as "we lose at most the handful of very last writes that hadn't yet
been flushed out of the WAL, which is fine... Vortex flushes regularly." That assumption doesn't
always hold. Live incident: a user re-enabled roughly 1900 mods (undoing a large batch of disables),
closed Vortex fully, then ran Create Backup — it still reported 371 mods disabled.

Root-caused with a new reusable diagnostic, `diagnostics/wal-inclusion-check.js`: reads the current
profile's disabled+installed mods two ways from the same real `state.v2` — once through the real,
shipped `withStateDb` (WAL excluded) and once through an otherwise-identical copy that additionally
includes the `*.log` file — and diffs the two mod-id sets. Result against the real data above:
**371 mods disabled in the excluded read, 0 disabled in the included read, zero mismatches the other
direction.** That's an exact, direct match to the reported bug: the re-enable writes were sitting
only in the still-active WAL (raw file timestamps confirmed the `*.log` was ~37s newer than the
most recent compacted `*.ldb`/MANIFEST), and every read this project does was silently discarding
them. Not a caching bug anywhere in this app's own request/frontend layer — `withStateDb` already
does a completely fresh disk copy+read on every single call, so a browser refresh or "refresh the
collection" button changes nothing about what gets read from Vortex's own database.

This is not scoped to Create Backup — every reader that goes through `lib/vortex-sync/lib.js`'s
`withStateDb` (Update Collection's backup/apply-ignores/apply-disables, Rules Generator's
analyze/report) is exposed to the same silent staleness whenever Vortex closes with recent writes
still sitting unflushed in its WAL. `lib/collection-runner.js` (Rebuild Collection) uses a separate,
not-yet-audited state-read path (`lib/state-query-worker.js`) — unconfirmed whether it has the same
exposure; worth checking with the same diagnostic technique if a similar staleness report ever comes
up there.

**Fixed (2026-07-27) as a follow-up freshness check, deliberately NOT as a change to any real read's
actual data** — the original WAL-exclusion existed specifically because `classic-level`/LevelDB "has
been confirmed able to hit a native, unrecoverable assertion crash on certain real-world
write-ahead-log shapes, even with Vortex fully closed" (see the isolated-worker rationale above), so
the fix couldn't just be "include the log everywhere" without reintroducing that risk to the numbers
users actually rely on.

Design: `lib/vortex-sync/lib.js`'s `withStateDb`/`copyStateDb` were refactored to share one
`includeLog` option (default `false`, unchanged everywhere). A new sibling, `withStateDbIncludingWal`,
opts in — used by exactly one caller: a new `'backup-capture-wal-check'` mode in
`state-write-worker.js`, invoked ONLY by `sync-runner.js`'s new `checkBackupFreshness()`, which is
ONLY ever called as a separate, best-effort follow-up AFTER a real Create Backup already succeeded
(`POST /api/sync/backup/check-freshness`, wired up fire-and-forget in `sync-app.js` right after a
backup completes — never awaited inline, never blocking "Backup created!" from showing). It re-reads
the same ignored/disabled data two ways (the real safe read again, plus one WAL-included read) in
its own isolated child process, diffs them by name, and returns `{ checked, stale, disabledDiff,
ignoredDiff }`. If that worker crashes, `checkBackupFreshness`'s own `try/catch` swallows it and
returns `{ checked: false }` — a missed bonus check, never a user-facing error, and critically: it
can NEVER affect the backup that already succeeded, since that used the completely separate, always-
safe `withStateDb` path, called from a different worker invocation entirely.

When `stale` comes back true, the UI shows a warning (`syncBackupFreshnessWarning` callout) telling
the user Vortex may have closed before saving its latest changes, and to reopen Vortex, click
**Refresh** on the 'Added Collections' page (or just wait a few seconds), close it again, and re-run
Create Backup. Verified end-to-end against the real incident data above: `checkBackupFreshness`
correctly returned `{ checked: true, stale: true, disabledDiff: 371, ignoredDiff: 0 }` — an exact
match to the diagnostic script's findings, through the real route-to-worker pipeline, with Vortex
confirmed closed throughout and no crash.

### Vortex database backup pruning (2026-07-27)

Settings → "Vortex database backups" previously only supported "Delete all backups" (all-or-
nothing) for `lib/vortex-sync/state-backups/` (the full state.v2 safety copies `backupLiveState`
takes automatically before every live write — Update Collection's applies, Rules Generator's Apply
to Vortex, restore-state itself). They accumulated indefinitely with no in-app way to thin them out
incrementally. Added a new, separate config field, `maxStateBackupsToKeep` — deliberately NOT the
same field as Rebuild Collection's own `maxBackupsToKeep` (a different, unrelated backup store for a
different tool), and with a different default/semantics: null/blank means unlimited (today's actual
behavior, kept as the default so this is non-breaking), and a positive integer prunes down to the N
most recent. No "0 = off" state here, unlike `maxBackupsToKeep` — these backups aren't optional,
they're the safety net for a risky live DB write, so the Settings route clamps any given number to a
minimum of 1.

`lib/vortex-sync/lib.js`'s new `pruneStateBackups(maxToKeep)` mirrors `collection-runner.js`'s own
`pruneOldBackups` (same "keep newest N, delete the rest" idea), just applied to one flat folder
instead of grouped per collection. Called automatically from `withLiveStateDb` right after every new
backup is taken — the single, shared entry point every live write already goes through — so pruning
needs no separate trigger and applies uniformly no matter which specific write created the backup.
Verified: the slice/delete logic against 5 synthetic backup folders correctly kept the 2 newest and
deleted the 3 oldest; the real, no-op case (`maxToKeep` set to the actual current count) against the
9 real backups this session's own testing had accumulated correctly deleted zero.

## Vortex Scrub (Utilities area)

Finds staging folders and downloaded archives Vortex has no real relationship with anymore --
inevitable after heavy testing/reinstalling (`Utilities > Vortex Scrub`, `lib/cleanup-scan.js` +
`web/cleanup-routes.js` + `web/public/cleanup-app.js`). Originally built under Reports and named
"Clean Up report" (this section keeps that old name in a few internal identifiers below,
e.g. `lib/cleanup-scan.js`, `#cleanupResultsList` -- renaming those has no user-facing effect and
wasn't done); moved to its own top-level **Utilities** nav area and renamed **Vortex Scrub**
2026-07-27, per this project's own pre-existing "New Utilities section" idea (see the old **Future
work** entry, now in the workspace `TODO.md`) -- it *does things* (delete/exclude), unlike
everything actually left under Reports, which is read-only.

**Triggered by a real, live example** (2026-07-27): the user found mods in Vortex's own list showing
their raw modId-version-timestamp as the display name (e.g.
`College Curriculum - Faction Requirement-79929-1-0-0-1670095062`) instead of a friendly name.
Confirmed via `diagnostics/inspect-mod-by-name.js` (see that file's own header for a real bug it
surfaced along the way) against the live `state.v2`: Vortex had silently auto-adopted the
unrecognized staging folder into a bare `mods###` entry -- `installationPath` = the folder name,
`state: "installed"`, `type: ""` -- with **no `archiveId`, no `attributes.customFileName`, no
`attributes.collectionSlug`, no download record, no rich metadata of any kind**. Compared side by
side against a normal, properly-linked mod (`Alchemy Station Variants - FOMOD`), which has all of
those. That comparison is exactly what "no relationship with a downloaded mod or collection" means
in code below.

**Orphan criteria** (`lib/cleanup-scan.js`):
- **Scan Staging**: a staging-dir folder is an exception if either (a) no `mods###skyrimse###`
  entry has this `installationPath` at all, or (b) one does, but has no `archiveId` AND no
  `attributes###collectionSlug` (the ghost-mod case above).
- **Scan Archives**: a downloads-dir file is an exception if no `downloads###files###` entry has
  this `localPath`, regardless of that download's own `state` (a record referencing the filename
  means Vortex knows about it, complete or not). Files still mid-download are skipped entirely via
  Vortex's own `__vortex_tmp_` prefix (`TEMP_DOWNLOAD_PREFIX`,
  `Nexus-Mods/Vortex`'s `download_management/util/downloadNames.ts`) -- they legitimately have no
  download record yet and are not orphans.

**Confidence split -- exceptions vs. needsReview** (added 2026-07-27, same session, after a live
test against real data caught this before it shipped): criterion (b) above -- "has a mod entry but
no archive/collection" -- cannot tell a truly-abandoned mod apart from a deliberate,
no-archive-by-design "fake mod" a generator tool creates. Confirmed live: running Scan Staging for
real flagged not just the College Curriculum example but also `DynDOLOD Output`, `TexGen Output`,
`PGPatcher Output`, `Pandora Output`, `My Patches Output`, `Ini-Settings Output`, and several
`vortex_collection_*` folders (Vortex's own internal Workshop-tab storage) -- all share the exact
same no-archive/no-collection signature as a genuine orphan, but deleting any of them would silently
break LOD/bodies/patches with no Vortex-level warning (they're not collection members, so the user's
stated "Vortex would flag it" safety net does not cover this case). The user's own fix, applied
directly: Vortex's download-naming convention always ends a name in
`-<modId>-<version parts>-<10-digit unix timestamp>` (`RECOGNIZED_DOWNLOAD_NAME_PATTERN`, now defined
in the shared `lib/download-naming.js` -- see Missing Masters' own section below for why it moved
there and why its middle "version parts" match was later loosened) -- a hand-named tool-output folder
never does. So every orphan candidate now splits into:
- **`exceptions`** -- name matches the download-naming pattern -- confident, goes through the normal
  bulk Delete Selected/Delete All flow described below.
- **`needsReview`** -- name does NOT match -- shown in its own "Action Needed: Unrecognized
  Folders/Archives Found" callout, ABOVE the confident list, with its own checkbox list and four
  actions: Delete Checked, Delete All, Exclude Checked, Exclude All -- every one of the four still
  goes through a confirmation dialog, per the user's explicit "if in doubt, ask -- never silently
  assume either delete or keep."
- **`vortex_collection_*`** folders are hard-excluded from BOTH buckets entirely (never shown as a
  candidate of any kind) -- reuses the exact `/^vortex_collection_/i` pattern already established
  elsewhere in this project (`vortex-sync/lib.js`, `state-query-worker.js`).
- **Deliberately conservative on ambiguity, still, even after the pattern was loosened**: originally
  this bullet warned that a version string containing letters (e.g. `"1.0RC2"`) wouldn't match
  `RECOGNIZED_DOWNLOAD_NAME_PATTERN` -- **no longer true** as of the 2026-07-27 fix documented in
  Missing Masters' own section below (the pattern now accepts any non-hyphen content as the version
  segment, confirmed necessary by real Vortex data with non-numeric versions like `"new"`,
  `"3.4.0.3Beta"`). The REMAINING safe-direction guarantee is narrower but still real: a name that
  doesn't end in the modId-...-10-digit-timestamp shape AT ALL (a hand-named tool-output folder with
  no trailing digits, e.g. `DynDOLOD Output`) still correctly lands in `needsReview`, never a false
  "exceptions" match -- verified directly against every real hand-named example this project has
  encountered so far. The dangerous direction (wrongly treating a real tool-output folder as
  confidently-safe-to-bulk-delete) remains what this split exists to prevent.

**A second, distinct `needsReview` label -- "Possible manual download?"** (confirmed real
2026-07-27): Vortex has a SECOND naming shape for archives that reach the downloads folder outside
its own "Download with Manager" flow (the user manually downloaded from Nexus's website, or moved a
file straight into the folder) -- space-separated, ending in an ISO-ish timestamp plus a random
alphanumeric suffix (`"Portalmaster 186656 1.0 2026-07-27T19-43Z hfH9s6oFY.rar"`,
`MANUAL_DOWNLOAD_NAME_PATTERN`, `/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z [A-Za-z0-9]+$/`). Confirmed this
shape can ALSO appear on a genuinely Vortex-tracked download (`"Variadic Collision Dynamics..."`
earlier this same session had a real `downloads###` record) -- it's a naming-convention hint, not
proof of being an orphan. Only applied to items ALREADY in `needsReview` (no `downloads###`/mod
record at all): those get an inline `-- Possible manual download?` label instead of the generic
"unrecognized format" framing, since the likely real-world cause differs from a hand-named
tool-output folder (DynDOLOD Output, etc.) -- still goes through the exact same Delete/Exclude
actions and confirmation, just better-explained. Confirmed rare/edge-case by the user themselves, so
kept as a lightweight per-item label (`item.hint`) rather than a separate section or bucket.

**Permanent exclude list** -- once the user confirms a `needsReview` item is legitimate (e.g. their
own `DynDOLOD Output`) via Exclude Checked/All, its exact name is added to a list and filtered out
of every future scan entirely -- it won't even reach the `needsReview` bucket again.

- **Storage location is user-chosen, not baked in** (`lib/cleanup-exclude-store.js`, a
  `{staging: [...], archives: [...]}` JSON file named `exclude-list.json`, living in whatever folder
  `config.json`'s `cleanupExcludeListDir` points at). This field is a **required** path, no
  built-in-default fallback, mirroring Update Collection's `syncBackupRoot` treatment rather than
  `backupRoot`/`logsDir`/`state`'s "optional, falls back to a default" one -- standing rule
  confirmed by the user 2026-07-27 (see `feedback_user_configurable_storage_paths` memory): every
  NEW data location this project adds must be a path the user explicitly picks, never a silent
  default, going forward (the three pre-existing optional ones weren't retrofitted). Like
  `staging`/`downloads`/`backupRoot`, only the FOLDER is baked into the startup `config` object
  (`web/server.js`) and requires a restart to change -- the list file's actual CONTENTS are always
  read fresh per-request (`excludeStore.load`), so adding/removing entries never needs a restart.
- **Archive-side matching is extension-agnostic** (fixed 2026-07-27, caught by the user asking
  "if I add the full file name including the extension, is it handled correctly?"): comparing raw
  filenames would silently fail to match if a user typed an exclude entry without its `.7z`/`.rar`
  extension (an easy, unannounced mistake via Settings' manual Add field -- the report's own
  Exclude action always sends the full name with extension, so only manual entry was ever at risk).
  Fixed by stripping the extension on BOTH sides before comparing
  (`scanArchives`'s `ignored = new Set(ignoredNames.map(stripExt))`, compared against
  `stripExt(file)`) -- matches regardless of whether the stored entry has an extension or not.
  Verified with a real throwaway file: excluding by base name alone correctly suppressed the
  extensioned file from the exceptions list.
- **Settings UI** (`web/public/settings-app.js`): each side (staging/archives) is an expandable
  `<details>` disclosure showing a live count in its `<summary>`, with the SAME checkbox +
  Remove-Selected/Remove-All convention as Vortex Scrub's own exception lists (confirmed
  2026-07-27: a lone "Remove" button per row wasn't wanted -- consistency with its own
  pattern was). `POST /api/cleanup/ignored/remove` accepts a `names` array for bulk removal (kept
  singular `name` too, unused by any current caller). Reuses `POST /api/cleanup/exclude` for the
  manual "Add" field (same route the report's own Exclude actions call).

**Cross-scan follow-up is a name match FIRST, then a real re-validation against Vortex's state --
not name matching alone** (name-matching convention confirmed the same way as above; the
re-validation requirement found live 2026-07-27, a real near-miss): after a delete from either
side, the other location is checked for files/folders sharing that same exact base name (Vortex
always names a staging folder identically to its source archive's filename minus the extension,
even when a friendly `customFileName` exists). **A name match alone used to be treated as proof,
but isn't** -- confirmed via a real case: deleting the ghost-mod staging folder
`Andrealletius' Renaming Project` cross-matched `Andrealletius' Renaming Project.zip` in the
downloads folder purely by name, and the "delete this too?" prompt would have offered to delete it
-- but that archive turned out to have a genuine, real `downloads###files###...` record (a
separate, actually-Vortex-tracked download that just happens to share the same base name by
coincidence). The user clicked Skip; had they clicked Delete, a legitimate archive would have been
deleted. Fixed: `crossCheck` is now async and re-validates every name-matched candidate against
Vortex's real state (the same per-side orphan check `scanStaging`/`scanArchives` already use)
before including it in the results -- a name match is now necessary but not sufficient, exactly
like it should have been from the start. Requires Vortex closed, same as the scans themselves
(previously cross-check had no state dependency at all).

**No backup/quarantine before delete** -- confirmed explicitly with the user: these are always
Vortex-recoverable (re-download from Nexus, or re-extract via Rebuild Collection), and if something
deleted actually still mattered AS A COLLECTION MEMBER, Vortex itself would flag the affected
collection as incomplete. That safety net does NOT cover non-collection "fake mods" like generator
tool output -- exactly why the confidence split above exists, so those get an extra human
confirmation step instead of being silently trusted the same as a real collection-member orphan. A
plain confirmation dialog before every delete is still required and never skipped regardless of
which bucket (mirrors `web/public/settings-app.js`'s "Delete all backups" flow: fetch a real count
first, bake it into the confirm text, no vague "are you sure?").

**"Uninstalled Mods Detected" notice (Scan Archives only, added 2026-07-27)**: a lightweight,
informational (not warning) callout shown above the results when `scanArchives` finds any archive
that Vortex fully recognizes (a real `downloads###files###` record exists) but where no
currently-installed mod actually uses that download anymore. Confirmed scope explicitly by the user:
this has no staging equivalent -- "if a mod is extracted, it would show either enabled or disabled,
never uninstalled." Triggered by a real, verified example: the user asked to check
`OWL - NordwarUA Variants Patch-50057-1-2-1622411906` in the live `state.v2` and expected it flagged
"uninstalled" -- confirmed via direct queries: no `mods###` entry exists for that modId at all, but
its `downloads###files###UHZEYK94mi-z` record still exists with a **stale** `installed###modId`
back-reference to the deleted mod.

- **Detection is a reverse lookup, never trusting the download's own `installed` field**: a
  download's `installed###modId` can go stale (the mod it names was later uninstalled/removed, and
  Vortex never clears the download's own back-reference). The robust check instead asks "does ANY
  `mods###skyrimse###<modId>###archiveId` currently equal this download's id?" (`usedArchiveIds`, a
  `Set` built once per scan from every mod's own `archiveId`) -- confirmed against the real OWL
  example: no mod anywhere referenced `UHZEYK94mi-z` via `archiveId`, proving it's genuinely orphaned
  regardless of what its own stale field claims. A real, separate bug caught live the same day: the
  raw `archiveId` value in `state.v2` is JSON-encoded (a quoted string), same as `installationPath`/
  `localPath` elsewhere in this function -- comparing it unparsed against a download's own bare key id
  silently never matched ANYTHING, flagging every archive as orphaned (including known-good installed
  mods like `(0) Alchemy Station Variants - FOMOD`). Fixed by `JSON.parse`-ing it, matching the
  convention already used for every other field in `readModsAndDownloads`.
- **This started as a full per-archive list with friendly metadata (name/author/version) and its own
  Delete Selected/Delete All UI, matched against Vortex's own Uninstalled/Never-Installed status --
  scaled back to a plain boolean + static notice after a live investigation the same day.** The
  detection logic above is correct and was verified end-to-end, but the exact COUNT could never match
  what Vortex's own Mods table displays, and chasing that turned out to be a rabbit hole not worth
  the complexity:
  - Confirmed via Vortex's real source (`ModList.tsx`): a download only becomes a virtual row at all
    if `state === 'finished'` AND its `game` field includes the current game mode -- reproduced this
    exactly (`countsAsModRow` in `readModsAndDownloads`), but it changed the count by zero on the
    user's real data (every flagged archive already passed both checks), so it wasn't the actual
    explanation for an early over-count (96 archives found vs. the user's real 56 shown in Vortex).
  - The REAL explanation, confirmed by reading Vortex's grouping code (`modGrouping.ts`): the Mods
    table runs every mod/download through `groupMods(..., {groupBy: 'file'})`, which groups by
    `attributes.modId` first, then by `fileMatch` (same `newestFileId`, or same `logicalFileName`
    minus its version substring), then folds any non-enabled entries in that group onto whichever one
    IS enabled via `byEnabled`. Net effect: an old, unused download of a mod you still have installed
    under a newer file gets folded into that mod's own row as a version-choice in its dropdown (the
    "113 (default)" / "111 (default)" picker the user showed a screenshot of for `GTS - Anniversary
    Edition Full Upgrade Patch`) -- it is NOT shown as its own separate "Uninstalled" row at all.
    Reproducing this exactly would mean re-implementing Vortex's full modId+file+enabled grouping
    algorithm here, purely to make a number match a UI simplification that Vortex itself applies for
    display purposes, not because those files are actually "the same thing" for a disk-cleanup tool.
  - The user's own call after seeing this (2026-07-27): "the way Vortex handles these uninstall mods
    is a mess... let's not go down this rabbit hole." Only ~3 mods in their real 4580+ archive library
    ever actually show a version dropdown, confirming the exact-match problem was disproportionate to
    the value of solving it.
- **Final shape**: `scanArchives` returns a single `hasUninstalledArchives: boolean` (archives-only;
  no per-item list, no metadata, no delete/exclude action here). The UI shows a plain
  `callout--info` box, `#cleanupUninstalledNotice`, with static copy pointing the user to Vortex's own
  Mods table Status filter (Uninstalled / Never Installed) as the actual source of truth for which
  specific mods these are and what to do about them -- this tool's job stops at "there's something
  worth checking," not at reproducing Vortex's own status page.

**Full-DB iteration, no range-bounded prefix scan**: `readModsAndDownloads` uses an unbounded
`db.iterator()` + regex match, mirroring `state-query-worker.js`'s `buildModVersionIndex` exactly.
This is deliberate, not an oversight -- a `lt: prefix + '#'` bound looks like the obvious
optimization but is a real trap: LevelDB/ClassicLevel key comparison is byte-lexicographic, and `#`
(0x23) sorts BEFORE almost every real key-segment character (digits/letters are all higher), so that
bound silently excludes nearly everything. Hit this exact bug while building
`diagnostics/inspect-mod-by-name.js` during this feature's own research -- an early version reported
0 of 4583 real mod entries because of it, fixed by switching to `gte: prefix` + a manual
`startsWith`-then-`break` (or, here, no bound at all).

**Delete route path safety**: `web/cleanup-routes.js`'s `/delete` resolves every given name against
the configured staging/downloads root and confirms the result still lives DIRECTLY under that root
(`path.dirname(full) === path.resolve(root)`) before ever calling `fs.rmSync` -- a malformed or
crafted name (e.g. `../../something`) can never escape to an arbitrary filesystem path.

## Missing Masters (Utilities area, added 2026-07-27)

A second Utilities sub-tab (alongside Vortex Scrub) that finds active plugins whose declared
masters aren't actually available to the game right now -- the classic Skyrim "missing master"
crash. Modeled on the user's real Wrye Bash workflow (they run it purely for this one feature
alongside Vortex): live, always-current visibility with no manual rescan, plus a "Create Dummy
Master" action for a master a user deliberately chose not to install (e.g. a patch requiring an
ignored mod).

**Grounded in Wrye Bash's real source**, cloned+forked to `F:\Claude Workspace\vortex-tools\
wrye-bash` (`origin`=`awesmdiver/wrye-bash`, `upstream`=`wrye-bash/wrye-bash`, same convention as
the existing Vortex source clone) -- not assumed. Key findings from reading it directly:
- **Missing-master status** (`Mopy/bash/bosh/__init__.py`, `_WithMastersInfo.info_status()`): its
  core "Missing master(s)" check is purely `any(m not in modInfos for m in self.masterNames)` --
  file presence in the Data folder, regardless of active status. A present-but-disabled master
  falls into a separate "Delinquent Master" (load-order) concept instead -- **this project
  deliberately goes further** (see Detection below), since Skyrim only loads active plugins, so a
  present-but-disabled master crashes the game exactly like a truly-absent one.
- **Live refresh is NOT a filesystem watcher** (confirmed: zero hits for watchdog/inotify/wx.Timer
  anywhere in that codebase). It's `on_activate.subscribe(self.RefreshData)` -- Wrye Bash simply
  rescans every time its own window regains focus, plus once at startup. The browser equivalent
  used here is the Page Visibility API + window focus event, not `fs.watch`/`chokidar`.
- **"Create Dummy Master"** (`Mopy/bash/basher/mod_links.py`, `Mod_CreateDummyMasters`): only
  offered for masters genuinely absent from the Data folder. Writes a real, minimal, valid plugin
  (zero masters of its own, ESM/ESL/ESP flag guessed from the missing file's own extension, author
  field set to a recognizable marker `"BASHED DUMMY"`). Does NOT auto-activate it.

### Data sources -- three new required Settings path fields, same treatment as `cleanupExcludeListDir`

- `skyrimDataDir` -- the real Skyrim `Data` folder. **READ-ONLY** -- never written to.
- `pluginsListDir` -- the folder containing `Plugins.txt`. **READ-ONLY**.
- `dummyMastersOutputDir` -- the ONLY path this feature ever writes to. **Never the live Data or
  SKSE folder** -- standing rule stated explicitly by the user 2026-07-27 while this was being
  designed: any generated content (a dummy master, or anything similar in the future) always goes
  to a separate, user-chosen output folder, never directly into the live game folder. Matches the
  user's own real Wrye Bash workflow: dummy masters live in a dedicated folder inside their
  staging directory (e.g. `Wyre Output`) that they separately turn into a real Vortex mod --
  exactly the same pattern this project's own orphan-detection work already recognizes for
  DynDOLOD Output/BodySlide Output folders.

### Active-plugin-set derivation -- verified empirically against the user's real, live files, not assumed

Confirmed by directly reading the user's real `Plugins.txt` (2026-07-27): it does NOT list base
masters (`Skyrim.esm`, `Update.esm`, `Dawnguard.esm`, etc.) or a good chunk of Creation-Club `.esl`
content at all -- those are implicitly always active whenever present. Only genuinely toggleable
plugins get an explicit line (`*` prefix = active, no prefix = explicitly disabled). Rule used by
`lib/missing-masters-scan.js`'s `computeActiveSet`:

```
for each plugin file found directly in the Data folder:
    if it's a ".ghost"-suffixed file: never active (Vortex's own disabled-plugin marker)
    else if it's explicitly listed in Plugins.txt WITHOUT a "*": not active
    else (starred, OR not listed in Plugins.txt at all): active
```

`loadorder.txt` turned out to be **unnecessary** for this feature -- ghost-status is read directly
off the Data folder's own file listing (a ghosted file is physically renamed to `<name>.ghost`
there), which is more ground-truth-accurate than trusting a separate bookkeeping file that could in
principle be stale, and this feature has no need for plugin ORDER, only presence/activation. All
name comparisons are case-insensitive throughout (matches Windows filesystem + game behavior).

### Binary plugin format -- `lib/esp-header.js` (reader) / `lib/esp-writer.js` (dummy-master writer)

No existing code in this project reads raw plugin bytes -- Bethesda's format is small and stable
enough (unchanged since Skyrim's original release) that a purpose-built ~70-line reader beats
pulling in a full ESP-editing library (xEditLib from the separate `skyrimvr-claude-toolkit` project
could technically do this, but was deliberately NOT used here -- see the "why not xEditLib"
discussion below) for this one narrow need.

Verified against the user's real files before being written, not assumed from memory:
- `TES4` record header is a fixed 24 bytes: signature(4) + dataSize(4) + flags(4) + formId(4) +
  versionControlInfo(4) + formVersion(2) + unknown(2). Subrecords within `dataSize` are
  signature(4) + size(2, uint16 LE) + data(size bytes) -- confirmed by reading `Dawnguard.esm`'s
  real TES4 body byte-for-byte: `HEDR`, `CNAM` (author), then a `MAST`/`DATA` pair per master
  (`DATA` is an 8-byte legacy subrecord immediately following each `MAST`, safe to skip).
- Real flags confirmed via `Update.esm`/`Dawnguard.esm` (`0x81` = Master `0x1` + Localized `0x80`)
  and `ccbgssse002-exoticarrows.esl` (`0x281` = Master `0x1` + Localized `0x80` + Light Master
  `0x200`) -- **an SSE light-master (`.esl`) plugin has BOTH the Master and Light Master bits set
  together, not just `0x200` alone**, a real detail that would have been easy to get wrong from
  memory alone. `versionControlInfo=0`/`formVersion=44`/`unknown=0` confirmed consistent across
  esm/esl/esp real files -- used as-is for the dummy writer's own outer header.
- Compressed `TES4` records (flag bit `0x00040000`) are detected but NOT decompressed -- reported
  as "cannot parse header, skip" rather than implementing zlib-inflate support for what would be an
  exceedingly rare case for a header this small in practice (same "safe direction on ambiguity"
  convention as `RECOGNIZED_DOWNLOAD_NAME_PATTERN`'s deliberate conservatism elsewhere).

**Why not xEditLib** (the `skyrimvr-claude-toolkit` project's own xEditLib.dll + Node FFI wrapper,
which could technically read a plugin's master list): deliberately not used here as a runtime
dependency of this project. It's tied to a specific machine setup (a Windows registry key,
`XEditLib.dll` + its `.Hardcoded.dat` files) that this project's own "self-contained portable zip,
zero setup" distribution model would otherwise inherit as a new fragility point for every user who
downloads this tool. There is also no existing relationship between the two separate GitHub repos
-- wiring a cross-project runtime dependency would mean this tool could silently break for someone
who has one but not the other, or a mismatched version. Same "own your dependency, don't create a
soft cross-project reliance" reasoning this project's own CLAUDE.md already applies to ESP records
themselves (never `GetFormFromFile()` another mod's record -- copy it into your own plugin
instead). xEditLib's proper role here is purely as an independent, one-off validation tool during
*development* (cross-reading a generated dummy master to confirm it's structurally valid) -- never
something this app depends on at runtime.

### Detection (`lib/missing-masters-scan.js`)

For every currently ACTIVE plugin (per the rule above): read its own master list via
`lib/esp-header.js`. For each declared master, classify:
- **`missing`** -- the file doesn't exist anywhere in the Data folder at all. "Create Dummy Master"
  applies to this case only.
- **`present-but-inactive`** -- the file exists in the Data folder, but isn't currently active
  (explicitly un-starred, or ghosted). This is the real gap in Wrye Bash's own core status check
  (see above) but IS what the game engine actually cares about -- exactly the user's own "I
  ignored a mod, so its .esp isn't installed" scenario. Shown as its own distinct category since the
  fix differs (re-enable it in Vortex, not create a duplicate).

**Results are grouped by the PROBLEM MASTER, not the requiring plugin** (redesigned 2026-07-27,
deviating deliberately from Wrye Bash's own left/right-by-plugin UI -- see
`reference_ux_dependency_designer_skill` memory / `F:\Claude Workspace\docs\
UX-UI-DEPENDENCY-DESIGNER.md` for the design framework this was built against). Real motivating
example from the user's own live data: `GTS Patches - OWL.esp` alone is the missing master for 10
separate requiring plugins -- a plugin-first list repeats that same master's name 10 times, hiding
that fixing it ONCE resolves every one of those dependents. `scanMissingMasters` builds
`problemMastersByKey` (`Map<lowercased master name, {name, status, neededBy: []}>`) instead of one
entry per requiring plugin, sorted by `neededBy.length` descending (highest-impact fix first), then
alphabetically for ties -- stable, scannable, independent of `fs.readdirSync`'s own
platform-dependent ordering. Each `neededBy` array is itself alphabetized.

UI (`web/public/missing-masters-app.js`) renders each problem master as its own color-tinted card
(`.mm-row--critical`/`.mm-row--warning` in `styles.css` -- a left accent border + subtle background
tint, not a plain grey card; confirmed explicitly that an all-muted-grey list read as visually flat
over a long scan) with a real colored icon (\u{1F534}/\u{1F7E0}) + badge, the master's own name, a
**Copy name** button (clipboard write -- genuinely useful for pasting into Vortex's own search/
filter, and deliberately NOT a fake "Enable in Vortex" button, since this tool never writes to
`Plugins.txt`), **Create Dummy Master** only on `missing` rows, and a "Needed by N plugins" list
truncated to 3 with the existing `+N more`/`Show less` toggle convention once it exceeds that. The
results-meta line ("N problem master(s) are affecting M plugin(s) total.") accent-colors its two
counts (`.accent-count`) rather than rendering as flat muted text -- `M` is the count of DISTINCT
plugins across every master's `neededBy` (deduped via a `Set`, since one plugin can need more than
one problem master at once).

**Verified end-to-end against the user's real, live install (2026-07-27)**: scanned 3568 active
plugins in ~157ms, found 17 plugins with a problem master -- an EXACT match to Vortex's own
Warning-flag filter count shown in the user's own screenshot ("showing 17/3909 items"). Multiple
results correctly point at `GTS Patches - OWL.esp` as `present-but-inactive`, matching the specific
real example the user showed (that mod's own Vortex status independently confirmed as "uninstalled"
earlier this same session, in the Vortex Scrub work above).

**No Vortex-running gate needed for this feature at all** -- a genuine simplification vs. the rest
of this app. Detection only ever reads `Plugins.txt`/the Data folder directly (immutable existing
files, not Vortex's live state.v2 LevelDB), and the only write (dummy master creation) goes to the
separate `dummyMastersOutputDir` Vortex isn't actively managing.

### Live refresh (`web/public/missing-masters-app.js`)

**Current mechanism**: a silent background poll (`MM_POLL_INTERVAL_MS = 5000`, a plain
`setInterval`) calls `pollMissingMastersScanSilently()` every 5s, gated on
`!document.hidden && mmIsSubTabVisible()` (the browser tab isn't backgrounded/minimized, and the
Missing Masters sub-tab is the one actually visible -- `mmIsSubTabVisible()` checks both the
Utilities area and the sub-tab itself aren't hidden). That function fetches quietly (touches no
loading-state UI at all), keeps a `JSON.stringify` snapshot of the last response actually rendered
(`mmLastResponseJSON` -- a safe plain-string comparison since the backend's own ordering is fully
deterministic, so unchanged data always serializes identically), and only calls `mmRender()` -- the
one thing that redraws the DOM -- when the new response genuinely differs. A fetch failure in the
silent path is console-only, never surfaced in the UI. Plus a manual Refresh button (the full,
visible `runMissingMastersScan()` -- loading spinner, list teardown, real error surfacing) for
on-demand use, and a full scan whenever the sub-tab is switched to via `showUtilitiesSubTab`. Still
not a filesystem watcher -- a deliberate, simple timer, not `fs.watch`/`chokidar` -- chosen because
the actual read (`Plugins.txt` + a Data-folder listing + per-plugin header parses) is cheap enough
(~150ms against ~3500 active plugins, benchmarked live) that polling it outright is simpler than
wiring up real file-change events for the marginal gain of near-zero latency over a 5s poll.

**History, both same session (2026-07-27)**: originally modeled directly on Wrye Bash's own
`on_activate` -> `RefreshData()` mechanism (confirmed via its real source: rescans whenever its
window regains focus, not a filesystem watcher) -- retargeted here as
`document.addEventListener('visibilitychange', ...)` + `window.addEventListener('focus', ...)`
triggering the full, visible scan. The 5s silent poll was added alongside it (the user's real
workflow: watching this page while working in a SEPARATE Vortex window, never switching focus back
to the browser tab at all, so the focus listener alone never fired). The focus/visibilitychange
listeners were then REMOVED entirely, not just made silent -- confirmed genuinely disruptive: they
fired the full, visible `runMissingMastersScan()` (loading spinner + list teardown) on something as
small as alt-tabbing away to copy some text and back, and had become fully redundant once the silent
poll existed (Chrome's Page Visibility API tracks TAB visibility, not OS-level window focus --
switching to a different application while this tab stays open on screen never sets
`document.hidden`, so the poll keeps running the whole time regardless, with no freshness gained by
also forcing a visible reload on refocus).

**Layout, same day**: the Refresh button used to sit alone on its own `.view-actions` row above the
"N problem master(s)..." line -- confirmed unnecessary vertical space. `#mmResultsMeta` and the
button now share one persistent flex row (`.mm-header-row`, space-between) that also doubles as the
"all clear" empty message (the separate `#mmEmpty` element was removed) -- hidden as a whole only in
the not-configured state, same as everything else on this page. Missing Masters is also now listed
and defaulted FIRST in the Utilities sub-nav (`UTILITIES_SUB_TABS = ['missingmasters', 'scrub']`,
`nav-utilities`'s own click handler defaults to `'missingmasters'` instead of `'scrub'`) -- confirmed
it's used far more often than Vortex Scrub.

### Mod-name column (added 2026-07-27)

Confirmed real-world need: a raw plugin filename alone (`GTS Patches - OWL.esp`) doesn't say which
actual MOD it's part of, so a user can't always tell at a glance whether they recognize it.
`lib/missing-masters-scan.js`'s `buildStagingModNameIndex(stagingDir)` reuses this project's own
EXISTING, already-required `staging` config field (no new Settings field added) -- a pass over every
staging subfolder's own top-level files, mapping each plugin filename found back to its owning
folder, then stripping that folder's trailing modId-version-timestamp suffix via the shared
`lib/download-naming.js`'s `stripDownloadNameSuffix` (see below for why this moved to its own shared
module) to get a clean display name.
Benchmarked live against the user's real ~4550-folder staging directory: ~150-290ms for a full pass
-- cheap enough to rebuild on every scan (including the 5s silent poll). A folder whose name doesn't
match the pattern (a hand-named tool-output folder, or a manually-downloaded archive matching
`MANUAL_DOWNLOAD_NAME_PATTERN`'s shape instead) is used as-is, unstripped -- still more useful than
nothing, confirmed against real examples ("ESLifier Output" shown correctly unstripped;
"GTS - Specific Patches 97490 113 2026-07-17T15-17Z VMSnJrLRM" likewise). A plugin genuinely absent
from every staging folder (never installed at all) gets `modName: null`.

**Also checks one level into a `Data`/`data` subfolder** (case-insensitive), confirmed necessary by a
real "true missing master" case the same day: mod author `1DustAdeptArmorSE-53257-new-1628092406`
packaged BOTH `1DustAdeptArmor.esp` at its folder root AND `1DustAdeptArmor.esl` nested inside a
`data\` subfolder (an on/off pick-one-format choice some mod authors ship) -- the collection that
installed this mod picked the `.esp`, leaving the `.esl` genuinely sitting on the user's own disk,
just never deployed to the live Data folder. A root-only scan completely missed it (found the `.esp`,
moved on, never looked inside `data\`) -- exactly the case that would otherwise show `1DustAdeptArmor
.esl` as having no known mod name, when the user could actually go find the real file themselves and
manually resolve it instead of needing a dummy. Deliberately only ONE level deep (folder root, or
folder-root's own `Data` subfolder) -- not a general recursive walk -- matching this one real nesting
pattern, not a broader "search everywhere" for comparatively little further benefit.

**No "—" placeholder specifically for a `missing` master's own mod name** (removed the same day):
by definition a genuinely missing master usually has no staging folder to trace back to at all (that
IS why it's missing) -- so nearly every `missing` row would show the dash, every single time, which
reads as pure visual noise rather than information. A `present-but-inactive` master's file DOES exist
on disk, so its mod name is almost always found there; "—" stays meaningful for THAT status, for the
rare case it genuinely isn't found.

Every `problemMasters[]` entry and every `neededBy[]` entry gained a `modName` field. UI
(`web/public/missing-masters-app.js`) renders it as a genuine grid COLUMN, not inline text --
`.mm-row__header` became a 4-column grid (badge / filename / mod name / actions) and each
`.mm-neededby-row` a matching 2-column grid (filename / mod name), so every row's mod name lines up
with its neighbors down the list. Per the user's explicit format spec: the MASTER row's own mod name
is bold (`<strong class="mm-modname">`, full `--text` color -- it's the primary thing on that row),
while every needed-by dependent's mod name is normal weight and italic (`<span class="mm-modname">`,
`--text-muted` -- supplementary context, not the main point of that row). Italic carries the
"secondary" signal there rather than relying on color/weight alone, consistent with this feature's
own earlier "spacing/color both matter, don't just default everything to muted grey" lesson (see
`reference_ux_dependency_designer_skill` memory).

**Naming-convention pattern moved to a shared module, `lib/download-naming.js`** (same day, after two
real follow-up findings): a `Data`/`data` subfolder inside a mod's own staging folder is now also
checked (one level deep only, not a general recursive walk) -- confirmed necessary by a real "true
missing master" case, mod `1DustAdeptArmorSE-53257-new-1628092406` packaging BOTH
`1DustAdeptArmor.esp` at its root AND `1DustAdeptArmor.esl` nested in `data\` (an on/off pick-one-
format choice some mod authors ship); a root-only scan completely missed the nested file. Separately,
that SAME mod's own folder name exposed a real gap in `RECOGNIZED_DOWNLOAD_NAME_PATTERN` (previously
only defined in `cleanup-scan.js`): its version segment is the literal word `"new"`, not numeric, so
the original all-numeric-segments pattern (`(?:-\d+)*`) silently failed to recognize it as a Vortex
download at all -- while Vortex's own UI correctly shows the clean name `"1DustAdeptArmorSE"`.
Confirmed via a live screenshot of Vortex's own Version column that non-numeric version strings
(`"3.4.0.3Beta"`, `"1.0.1.VampirePatch"`) are common in real data, not a one-off. Fixed by loosening
the shared middle-segment match to `(?:-[^-]+)*` (any non-hyphen content, not just digits) --
deliberately fixed ONCE in a new shared `lib/download-naming.js` (also housing
`MANUAL_DOWNLOAD_NAME_PATTERN`/`isPossibleManualDownload`, plus a new `stripDownloadNameSuffix`
helper `missing-masters-scan.js` uses for its own display-name cleanup) rather than as two separate
copies, since both `cleanup-scan.js` (Vortex Scrub's exceptions/needsReview safety split) and
`missing-masters-scan.js` (this cosmetic mod-name column) benefit from the same, more accurate rule.
Checked the loosening against Vortex Scrub's own safety use FIRST, before sharing it: a hand-named
tool-output folder (`DynDOLOD Output`, `BodySlide Output`, etc.) never ends in a
`-<number>-...-<10-digit-timestamp>` shape at all, so this only recognizes more genuine downloads
correctly -- it doesn't newly risk misreading a hand-named folder as a safe-to-bulk-delete
"exceptions" match. Verified directly: `isRecognizedDownloadName` now correctly returns `true` for
the `1DustAdeptArmorSE...` example (previously `false`) while every real hand-named tool-output
folder still correctly returns `false`; also re-ran `scanStaging`/`scanArchives` against the user's
real, live state.v2 afterward (Vortex closed) and confirmed identical exceptions/needsReview counts
to before this change (0 exceptions / 19 needsReview staging, 0/0 archives) -- no regression.

**"Active alternate" detection, same day** -- confirmed genuinely useful real-world signal: a
`missing` master's own mod can be installed and ACTIVE right now, just deployed under a DIFFERENT
plugin filename from the very same mod package (the `1DustAdeptArmorSE` example again: its own
`.esp` variant is what's actually active/deployed, while the needed `.esl` variant sits unused in
that same staging folder). `buildStagingModNameIndex` now also returns `siblingsByModName` (`Map<mod
name, Set<every plugin filename that mod's own staging folder contains>>`), and
`scanMissingMasters`'s new `findActiveAlternate(masterFileName)` helper -- only run for `missing`
masters, since a `present-but-inactive` one's own file already exists on disk so the question doesn't
apply -- looks up the master's own mod name, finds every sibling plugin filename from that SAME mod,
and returns whichever one (if any) is both on disk in the Data folder AND currently active. Surfaced
as a new `activeAlternate` field (nullable) on the affected `problemMasters[]` entry -- this is a
strong hint the "missing" master isn't really a missing MOD at all, just a format/variant mismatch
the user can likely fix with a manual file swap, rather than needing a dummy master.

**UI styling, same day** -- rendered as a `.callout--warning` nested inside the master's own row
(`web/public/missing-masters-app.js`), matching the exact "Manual Action Needed: ..." convention
Vortex Scrub's own "Action Needed: Unrecognized Folders/Archives Found" callout already established
-- explicit request to keep every informational warning like this consistent app-wide, not a one-off
note style. Title: "Manual Action Needed: Uninstalled Mod Component Found". Body names the
`activeAlternate` file specifically (bold): *"`<activeAlternate>`" is part of this mod, but isn't
currently installed. To fix this, you'll need to manually remove the installed mod file and replace
it with this listed one so Vortex can properly recognize it (and clear any missing master
warnings).* -- "this listed one" refers to the row's own master name, already shown bold in the
header just above.

**Row-alignment bug, 2026-07-27 (reported via screenshot: a `missing` row's mod-name column didn't
line up with `present-but-inactive` rows' mod-name column)** -- root cause: `.mm-row__header`'s grid
(`grid-template-columns: auto minmax(160px, 1.2fr) minmax(140px, 1fr) auto`) had `auto` widths on the
badge and actions columns, and each row is its OWN independent grid container -- CSS Grid does not
share column tracks across separate `display: grid` elements. A `missing` row's badge text ("🔴
Missing") differs in width from a `present-but-inactive` row's ("🟠 Disabled"), AND `missing` rows
have an extra "Create Dummy Master" button in the actions column that other rows don't -- so each
row's two `fr` columns split the remaining space differently, visibly shifting where the mod-name
column landed row to row. Fixed by making the badge and actions columns FIXED widths (`118px` /
`300px`) instead of `auto` -- every row now reserves identical gutters regardless of its own badge
text or button count, so the two `fr` columns always start/end at the same x position across every
row. Verified live (screenshot before/after): mod names for "Disabled" and "Missing" rows alike now
line up in the same column.

Follow-up, same day: the actions column's two buttons (Copy name, Create Dummy Master) were still
wrapping onto two stacked lines at 250px, and with Copy name pushed first in the button array it sat
on top while Create Dummy Master sat below -- reported as visually inconsistent (Copy name's own
position moved between a 1-button row and a 2-button row). Fixed two ways together: widened the
actions column to `300px` so both buttons fit on one line without wrapping, and reordered the button
array so Create Dummy Master is added FIRST and Copy name LAST -- with `.mm-row__actions`' own
`justify-content: flex-end`, Copy name is now always the rightmost element regardless of whether a
row has one button or two, matching the request to keep every row's Copy name button aligned.

**Raw "Failed to fetch" shown verbatim, same day** -- `mmHandleError` (`web/public/missing-masters-app.js`)
used to do `box.textContent = e.message` unconditionally, so if the browser's `fetch()` couldn't even
reach the local server at all (the `node web/server.js` process itself not listening -- as opposed to
`mmApi`'s own `Error` for a real HTTP error response from a server that IS running), the raw
`TypeError: Failed to fetch` browser exception string got shown directly to the user -- a
developer-facing message with no actionable meaning to them, exactly the kind of thing the
`plain-language-writer` skill exists to catch. Fixed by checking `e instanceof TypeError` specifically
(the one thing a network-level fetch failure sets that a handled API error doesn't) and rendering a
real `callout__title` + `<p>` pair instead, matching the existing "Manual Action Needed" convention:
title "Can't Reach the App's Server", body explaining the local server itself may need restarting and
that clicking Refresh alone won't help until it is. Verified without touching the user's own live
server (it was actively serving a separate connection at the time) by calling `mmHandleError(new
TypeError('Failed to fetch'))` directly via the browser console in a separate tab and confirming the
rendered HTML/screenshot.

**Naming-convention gap #2, same day (reported: `ElysiumEstate5.0.1-4119-5-0-1` still showing raw,
while Vortex's own UI shows `ElysiumEstate5.0.1`)** -- investigated by (a) consulting the actual
Vortex source (the local fork+clone at `F:\Claude Workspace\vortex-tools\Vortex` -- see
`reference_vortex_source_clone` memory) and (b) listing the user's real, live staging directory
(`E:/Vortex Mods/skyrimse`, 4560 folders) to check any candidate regex against real data before
shipping it. Source finding: `deriveModInstallName`
(`src/renderer/src/extensions/mod_management/modIdManager.ts`) is a pure pass-through of the
archive's own downloaded filename (`maskFSInvalidChars` only swaps out `<>:"/\|?*` -- nothing else
about the name is generated by this function) -- meaning the staging folder name is fundamentally
whatever the DOWNLOAD was named, not something Vortex derives via one fixed formula. This explains
why multiple genuinely different shapes coexist in one real install rather than there being a single
"correct" pattern to reverse-engineer. `downloadNames.ts`'s `freeDownloadName` separately confirmed a
different collision-avoidance suffix mechanism (`name.<Date.now() ms-epoch>.ext`), and
`healStoragePathNames.ts` documents an actual historical Vortex naming regression (LAZ-807, CDN
storage-path leakage into name attributes, needing its own "healing" migration) -- both reinforce that
this naming pipeline has genuinely drifted across versions, not that this project's regex was simply
wrong once.

Counted three distinct real shapes across the live 4560-folder listing:
- Dash + 10-digit unix epoch (`RECOGNIZED_DOWNLOAD_NAME_PATTERN`'s original target): 4038 matches.
  Also fixed an empty-segment edge case here (`Project AHO - Spell Crafting for Mysticism-65891-1-0-1
  --1648930764` -- a blank version segment between two dashes right before the real epoch) by loosening
  `(?:-[^-]+)*` to `(?:-[^-]*)*` (zero-or-more instead of one-or-more per segment) so a blank
  repetition doesn't fail the whole match.
- Space-separated with an ISO timestamp + random token (e.g. `GTS - Specific Patches 97490 113
  2026-07-17T15-17Z VMSnJrLRM` -> `GTS - Specific Patches`): 139 matches. Previously only
  `MANUAL_DOWNLOAD_NAME_PATTERN` detected this shape's trailing date+token portion (for Vortex Scrub's
  "possible manual download" flag) but nothing stripped the modId/version prefix before it for display.
  New `SPACE_SEPARATED_DOWNLOAD_NAME_PATTERN` handles the full strip. Tight enough (mandatory numeric
  modId + mandatory ISO-shaped timestamp + mandatory trailing alnum token, all space-delimited) that
  zero false positives turned up across all 4560 real names -- added to `isRecognizedDownloadName`
  too, since it's just as trustworthy as the dash+epoch shape.
- Bare dash-modId-version with NO trailing timestamp at all (e.g. `ElysiumEstate5.0.1-4119-5-0-1` ->
  `ElysiumEstate5.0.1`, matching Vortex's own displayed name exactly): 93 matches. New
  `BARE_DASH_NO_TIMESTAMP_PATTERN`, used ONLY inside `stripDownloadNameSuffix`'s cosmetic fallback tier
  -- deliberately NOT added to `isRecognizedDownloadName`. Reason: without a timestamp anchor this
  shape is looser, and manual review of all 93 real matches found 3 ambiguous cases (`SQOSPatcher-v0-3`
  -> `SQOSPatcher-v0`, where "-3" might be part of a real "v0.3" version string rather than stray
  Vortex metadata; two `ggmods-<modId>-foundation-face...` folders where the trailing words might be
  the actual mod name). That ambiguity is an acceptable trade for Missing Masters' purely cosmetic
  display (worst case: an occasional name trimmed a bit more aggressively than ideal) but not for
  Vortex Scrub's safety classification (`isRecognizedDownloadName` feeds the "confident, safe for bulk
  delete" exceptions bucket) -- kept those two use cases on genuinely different confidence tiers rather
  than reusing one check for both.

`stripDownloadNameSuffix` now tries all three patterns in confidence order (dash+epoch, then
space+ISO+token, then the loose bare-dash fallback) and strips using the first match; unchanged if
none match. **Live-verified** (Vortex closed, same day): re-ran `scanStaging`/`scanArchives` against
the user's real state.v2 with the `SPACE_SEPARATED_DOWNLOAD_NAME_PATTERN` addition to
`isRecognizedDownloadName` live -- identical counts to the documented baseline (0 exceptions / 19
needsReview staging, 0/0 archives). Also confirmed directly that zero of the current `exceptions`
entries are newly recognized ONLY by the new pattern -- none of the 139 real space-separated-named
folders in this install are currently orphaned (all are backed by a real mod/download record), so the
new pattern wasn't even exercised by today's classification, let alone caused a regression.

**Standing order, added 2026-07-27** (see `feedback_vortex_source_sync_naming_recheck` memory): after
every future `merge-upstream` pull of new Vortex source, re-check
`modIdManager.ts`/`downloadNames.ts` (and grep for new `shortid()`-adjacent naming code) for any
additional naming convention Vortex may have introduced, and update `lib/download-naming.js`
accordingly -- cross-checked against a live folder listing before shipping, not from source reading
alone.

**Naming-convention gap #3, 2026-07-28: this project's OWN auto-download (`lib/nexus-mod-download.js`)
produced a file that broke every one of the naming-convention checks above.** Reported: Missing
Masters' single-mod auto-download (`Rebuild This Mod`) saved `Snazzy Morthal AIO-147759-2-1-
1751281253.7z`'s archive as plain `F:\Vortex Downloads\skyrimse\Snazzy Morthal AIO.7z` -- no
modId/version/timestamp suffix at all -- while manually downloading the exact same mod from
nexusmods.com produces the fully-suffixed name. Since every consumer of `lib/download-naming.js`
(`stripDownloadNameSuffix`, `isRecognizedDownloadName`, Vortex Scrub's exceptions/needsReview split,
Missing Masters' own staging-folder matching) depends on that suffix shape being present, any archive
this app downloads itself was silently invisible/misclassified to all of them.

Root-caused via Vortex's real source (not assumed): `modIdManager.ts`'s `deriveModInstallName` --
already cited above -- confirms Vortex's own install-time code is a pure pass-through of whatever the
DOWNLOADED FILE was already named; it never independently generates this suffix. So the suffix has to
be baked in by whatever named the archive file at download time -- and since our own
`downloadModArchive()` already calls the same real `download_link.json` endpoint Vortex itself uses
(see the citation earlier in this same file) but gets back the mod author's own plain uploaded
filename instead, the suffix must come specifically from Nexus's manual/website download flow, not
the raw CDN link itself.

**Solution found, then validated against 5 real mods before shipping** (per the user's own explicit
ask -- "pick 3 to 5 random mods and downloading them all to see how the file names land"): Nexus's
own `GET /v1/games/{gameDomain}/mods/{modId}/files/{fileId}.json` endpoint (single-file details, keyed
by the exact fileId this project already has via `source.fileId` -- no version/timestamp guessing
needed at all) returns a `file_name` field that IS ALREADY the fully-formed, naming-convention-correct
string. A real example (queried live this session):
```json
{
  "file_id": 753469,
  "name": "SkyParkour V3 - Parkour Framework",
  "version": "3.5.4",
  "mod_version": "3.5.4",
  "category_id": 1,
  "category_name": "MAIN",
  "is_primary": true,
  "size": 4861,
  "size_kb": 4861,
  "size_in_bytes": 4977807,
  "file_name": "SkyParkour V3 - Parkour Framework-132292-3-5-4-1779046772.7z",
  "uploaded_timestamp": 1779046772,
  "uploaded_time": "2026-05-17T19:39:32.000+00:00",
  "external_virus_scan_url": "https://www.virustotal.com/gui/file/...",
  "description": "...",
  "changelog_html": "...",
  "content_preview_link": "https://file-metadata.nexusmods.com/file/nexus-files-s3-meta/<gameId>/<modId>/<file_name>.json"
}
```
`file_name` matched that mod's own real staging-folder name byte-for-byte. Validated against 5
real, already-installed mods pulled from the user's live staging directory (ground truth: each
folder's own already-suffixed name) before committing to this approach:

| modId | Real folder name (ground truth) | API `file_name` |
|---|---|---|
| 37693 | `'Menagerie Creation Club Pet Overhaul' Patch-37693-2-10-1704998971` | matched (file's own name differs from the mod page title -- "Skills of the Wild", a bundled optional file -- but the modId/version/timestamp suffix shape matched) |
| 146873 | `Core Impact Framework - Latest Version-146873-1-2-8-1771158591` | exact match |
| 97050 | `Gourmet - Vigilant-97050-1-0-1690658632` | matched (file's own name "Gourmet - BS Bruma" differs, same bundled-file situation as above) |
| 22878 | `Monster Lipsync SE - Vanilla-22878-2-8b-1555466953` | matched -- confirms a non-numeric version segment ("2.8b") round-trips correctly too |
| 132292 | `SkyParkour V3 - Parkour Framework-132292-3-5-4-1779046772` | exact match, every field |

Note on the two "matched but different display name" rows: a mod page can host multiple files (main
file, optional files, patches), each with its OWN independently-uploaded `file_name` -- it does not
necessarily echo the mod page's own title. This is expected and harmless for this project's purposes:
`source.fileId` already pins down the exact file, so `file_name` is always the correct name for THAT
specific file regardless of what the overall mod is called.

**Implementation** (`lib/nexus-mod-download.js`): `downloadModArchive()` now calls a new
`resolveFileDetails(apiKey, gameDomain, modId, fileId)` after the download completes and hash-verifies
successfully, and uses `fileDetails.file_name` as the final on-disk filename whenever present.
Best-effort only -- wrapped in its own try/catch, falling back to the previous Content-Disposition/
logicalFilename-based name if this lookup fails for any reason (rate limit, mod taken down mid-flow,
etc.). A successful download under a slightly plainer name beats failing the whole operation over a
metadata lookup hiccup. This one shared function is called by BOTH Rebuild Collection's batch
downloader (`downloadMissingArchivesForPlan`) and Missing Masters' single-mod path
(`rebuild-single-mod.js`), so both benefit automatically -- no duplicated fix needed.

**Follow-up idea raised, not yet built**: since a single-mod rebuild only ever runs against a
completely empty staging folder (nothing to preserve, nothing Vortex-managed to conflict with), the
user noted this opens a natural Vortex Scrub feature: detect fully-empty staging directories (the
same signal Missing Masters' own `hollowInstalls` already computes) and offer to delete them outright,
as its own dedicated flow. Not scoped or built yet -- flagged here for a future session.

### Create Dummy Master (`lib/esp-writer.js`)

Only offered in the UI for `missing` (genuinely absent) masters -- re-validated server-side too
(`web/missing-masters-routes.js`'s `/create-dummy-master` re-scans the Data folder before writing,
never trusting a possibly-stale client-side result, same "re-validate against real state" pattern
as `cleanup-scan.js`'s `crossCheck`). Builds a minimal valid plugin from scratch: `TES4` + `HEDR` (12
bytes: version 1.7 float + 0 records + `nextObjectID` 0x800, Creation Kit's own default for a fresh
plugin) + `CNAM` (author `"Vortex Scrub Dummy Master"`, a recognizable marker mirroring Wrye Bash's
own `"BASHED DUMMY"` convention). Zero `MAST` entries -- the dummy has no masters of its own. Flags
guessed purely from the missing file's own extension (`.esm` -> `0x1`, `.esl` -> `0x201`, `.esp` ->
`0x0`) -- the real file is by definition missing, so there's no actual value to read, only guess by
convention (same limitation Wrye Bash itself accepts). Create-only, never overwrites an existing
file. Does NOT auto-activate the dummy (no Plugins.txt write anywhere in this path) -- the UI's own
confirmation text states plainly that it still needs to become an active mod in Vortex.

Round-trip verified in a throwaway temp directory before being trusted (2026-07-27): created
`.esp`/`.esm`/`.esl` dummies, re-read each with `lib/esp-header.js`, confirmed zero masters and the
correct flag bits every time; also confirmed the overwrite-protection correctly throws on a second
call for the same name.

### Single-mod rebuild engine (`lib/build-mod-from-vortex-state.js`, `lib/rebuild-single-mod.js`)

Missing Masters' first real cross-tool feature: reuses Rebuild Collection's own classify/extract/
verify/swap engine (`lib/rebuild-mod.js`'s `classifyMod()`/`rebuildMod()`, completely unchanged) to
repair ONE mod at a time, without that mod needing to belong to any active Vortex Collection. Full
plan writeup + live-test addendum: `docs/plans/2026-07-27-single-mod-rebuild-engine.md` (this
project's own plans folder -- project-specific plans live here now, not the centralized
`F:\Claude Workspace\docs\plans\`, which is reserved for workspace-wide/meta plans not tied to one
project).

**Why this exists**: a real case surfaced by Missing Masters -- `Snazzy Morthal AIO-147759-2-1-
1751281253`'s staging folder was found completely empty (0 files) while Vortex's own state.v2 still
said `state: "installed"` and the mod's source archive was still intact in Downloads. Create Dummy
Master fully resolves the crash (Skyrim loads fine) but leaves the mod's actual content invisible
in-game with nothing pointing at why -- exactly the class of problem Rebuild Collection already
solves, just previously only for a whole `collection.json`-driven run.

**Key discovery, confirmed by reading `lib/choice-resolver.js` directly, not assumed**: Vortex's own
per-mod state.v2 record (`persistent###mods###<gameId>###<modId>###attributes###installerChoices`)
stores its recorded FOMOD choices in the EXACT SAME shape `resolveChoices()` expects from
`collection.json`'s own `choices` block --
`[{name, groups:[{name, choices:[{idx, name}]}]}]`, one entry per raw install step in document
order. So replaying a FOMOD's recorded choices never actually required collection membership --
only translating state.v2's own already-recorded fields into the shape this engine already
consumes. **Gotcha found only once actually tested live**: this isn't stored as ONE combined key --
state.v2 flattens it into two separate leaf keys, `attributes###installerChoices###type` and
`attributes###installerChoices###options`, same convention as every other nested field in this
database. A first live test correctly came back `SKIP_OPEN_FOMOD` (no choices found) instead of
`REBUILD`, which is what caught this.

**`lib/build-mod-from-vortex-state.js`**: `buildModFromVortexState({stateDir, gameId, vortexModId})`
reads that one mod's `attributes` (via `syncLib.withStateDb`, the same safe-copy-then-read pattern
every other state.v2 read in this project already uses) and returns a plain
`{name, source, choices}` object shaped exactly like a `collection.json` mod entry.

**`lib/rebuild-single-mod.js`**: `rebuildSingleMod({vortexModId, ...})` is the actual reusable
engine entry point -- any tool can call it for one mod. `extract-mod.js` (the child process
`rebuildMod()` spawns) always re-reads `collection.json` from disk by mod name
(`collection-parser.js`'s `loadCollection`/`findMod`) -- it never accepts an in-memory mod object.
Rather than touching that already-tested file, this writes a tiny SYNTHETIC single-mod
`collection.json`-shaped temp file (`{mods: [mod]}`) and points `--collection` at it, cleaned up in
a `finally` -- zero changes to `extract-mod.js`, `fomod-parser.js`, `choice-resolver.js`,
`archive-locator.js`, or `collection-parser.js`. Everything downstream (`classifyMod`, `rebuildMod`,
`locateArchive`, `downloadModArchive` for the optional Nexus auto-download fallback) is reused
completely unchanged.

**Threading**: confirmed with the user this is a single-person tool -- the odds of a whole-
collection Rebuild Collection run and a Missing-Masters single-mod repair both touching the SAME
mod at the SAME moment are negligible, so no new per-mod/per-folder lock was built. The only guard
is a plain read-only check against `web/run-state.js`'s existing `isRunActive()` (already the
single global "a Rebuild Collection run is happening" flag, built on `sse-session.js`) -- refuse to
start a single-mod repair if a whole-collection run is active, rather than risk two independent
processes touching the same staging folder at once. Verified directly: marking that session active
and then calling `rebuildSingleMod()` throws the friendly `RUN_ACTIVE` error before doing any work.

**Missing Masters' own new detection** (`lib/missing-masters-scan.js`): `buildStagingModNameIndex`
now also records any staging folder found completely empty (0 files, root or the existing one-level
`Data` subfolder check) as a `hollowInstalls` entry. For each `missing`-status master,
`findPossibleHollowInstall` does a plain token-overlap match (significant words shared, case-
insensitive, requiring at least 2 shared words covering at least half of the smaller name's own
token set) between the master's own filename and each hollow install's cleaned name -- e.g.
"Snazzy Interiors - Morthal AIO.esp" vs. "Snazzy Morthal AIO" (stripped from the real folder name)
shares 3 significant tokens. Attached as `possibleHollowInstall: {folderName, vortexModId}`
(`vortexModId` == the folder's own name -- confirmed real-world this doubles as the mods### key).
Deliberately a lightweight, transparent GUESS shown to the user plainly (a new `.callout--warning`
naming the candidate folder), not verified against Vortex's own records before suggesting it --
per the user's own explicit call, the cost of guessing wrong here is cheap (it's just staging/
archive data, trivially deleted and re-obtained from Nexus), so this favors a simple heuristic over
an elaborate "prove it's the right mod first" search across every installed mod's archive.

**Route**: `POST /api/missing-masters/rebuild-mod` (`web/missing-masters-routes.js`) -- the one
route in this file that needs a Vortex-running gate (its other two routes deliberately don't, see
the file's own header comment), since it reads state.v2. Matches `rebuild-routes.js`'s simple
synchronous-response convention (no SSE session -- this is one fast mod, not a whole collection).

**UI**: "Rebuild This Mod" button (next to Create Dummy Master -- both can show at once, they're
not mutually exclusive) + a confirm modal mirroring Create Dummy Master's own shape. Reusing the
existing `.mm-row__actions` fixed-width layout (see the row-alignment fix above) meant a THIRD
button needed the actions column widened again, from `300px` to `480px`, to keep all three on one
line without reintroducing the alignment issue that fix originally solved.

**Live-verified end to end** (Vortex closed, real data): triggering this for the real
`Snazzy Morthal AIO-147759-2-1-1751281253` mod returned `REBUILT`, `fileCount: 4`, and the staging
folder -- empty before -- now has all 4 real files including `Snazzy Interiors - Morthal AIO.esp`.
Missing Masters' own scan still correctly reports this master as `missing` immediately afterward --
expected, not a bug: this only repairs the STAGING folder, exactly like every other Rebuild
Collection run (see this doc's own "expect External Changes" note above) -- Vortex itself still
needs to reopen and deploy before the file actually lands in the Data folder Missing Masters checks.

### Dummy Masters output folder excluded from staging cross-reference (2026-07-28)

Confirmed real: the configured Dummy Masters output folder (e.g. "Wyre Output," which can also
double as a Wrye Bash-style shared dump for many unrelated dummy stub plugins over time) sitting
directly inside the staging directory was being treated by `buildStagingModNameIndex` like any other
mod's own package -- one folder = one mod's siblings. Since it actually holds many unrelated dummy
files, an unrelated pair (`Bashed Patch, 0.esp` and a `TavernGames.esp` dummy, both genuine 61-byte
stubs this app itself had created) got grouped as "siblings," and `findActiveAlternate` wrongly
concluded one was an alternate format of the other just because both happened to be active/present.

Fix (`buildStagingModNameIndex(stagingDir, excludeDirAbs)`, `scanMissingMasters`'s new
`dummyMastersOutputDir` param): the configured folder is excluded from `siblingsByModName` and
`hollowInstalls` (cross-referencing/rebuild-offer logic that assumes "one folder = one real mod's
package") but its contents STILL populate `modNameByPlugin`/`folderPathByModName` (so a master whose
only known copy is a dummy sitting there still shows its real mod name and an "Open Staging Folder"
button -- still useful information, just not a basis for cross-referencing). `readyToDeploy` is
ALSO gated off when a master's resolved modName matches the dummy-masters folder's own stripped
name, since that folder isn't Vortex-deploy-managed (see espWriter.createDummyMaster's own "still
needs to become an active mod in Vortex" framing) -- "Open Vortex and click Deploy Mods" would be
actively wrong guidance for a dummy stub sitting there.

### Single-mod rebuild's auto-download now goes through the SAME Premium gate as Rebuild Collection (2026-07-28)

`rebuild-single-mod.js`'s auto-download path was calling `downloadModArchive()` directly, skipping
the Premium check `downloadMissingArchivesForPlan` (Rebuild Collection's own batch downloader)
already enforces -- a non-Premium account got a raw, confusing Nexus API error instead of the same
clear explanation used everywhere else in this app. Fixed: `checkPremiumStatus()` is called first;
not-Premium returns `{ ...action, downloadSkipped: 'not-premium', autoDownloadEnabled: true,
canAutoDownload: true }` without attempting anything; a real download failure (network, hash
mismatch, etc.) returns `{ ...action, downloadError: e.message, ... }` instead of throwing raw. Every
non-REBUILD return also carries `autoDownloadEnabled`/`canAutoDownload` so the client can distinguish
three genuinely different reasons nothing downloaded: setting is off, account isn't Premium, or the
attempt itself failed (`web/public/missing-masters-app.js`'s `mmDescribeRebuildFailure`, checked in
that priority order).

Whether auto-download is attempted at all now follows the SAME global "Download missing archives
automatically" Settings toggle (`downloadMissingArchives` in config.json) Rebuild Collection already
uses -- `/rebuild-mod` reads it server-side via `appConfig.loadConfig()` rather than trusting a
client-supplied flag, so both features stay in sync automatically. The `/scan` route also now
returns `downloadMissingArchivesEnabled` (this same value) so the Rebuild This Mod confirm dialog can
state plainly what WILL happen ("This downloads **X**'s archive and reinstalls it…" vs. "This
restores **X**'s files…") instead of hedging with "if turned on in Settings" -- see DESIGN.md's
"State a known outcome as fact" entry.

**Live-verified with a real not-Premium test** (temporary, reverted): `checkPremiumStatus` was
patched behind a `MM_TEST_FORCE_NOT_PREMIUM=1` env-var override (never touches the real account,
removed before committing) to confirm the not-Premium message renders correctly end to end without
needing to actually downgrade a real Nexus account. Confirmed via direct browser reproduction: the
message renders correctly every time -- the "nothing happened" reports that led to this test were
actually a SEPARATE visibility bug (see below), not a logic bug.

**Rebuild failure display moved from a page-level box to the row itself** (see DESIGN.md's
"Contextual error placement" entry for the full UX rationale): reported three separate times as
"nothing happened, no error, no warning" -- the failure message was rendering correctly in
`#mmCriticalError` every time, just at the top of the page while "Rebuild This Mod" can sit far down
a long problem-master list. `mmShowRebuildFailureOnRow` now inserts the failure as a NEW callout
directly in that row, positioned above the row's existing critical callout (e.g. "Missing Files in
Staging Folder") rather than overwriting it -- overwriting once lost the folder-name reference the
original message gave. Falls back to the old page-level box (with `scrollIntoView`) only if the
row's own callout can't be found for some reason.

### Missing Masters summary badges + tip banner (2026-07-28)

Added the same clickable-pill status filter convention already used by Stats Report's "Current
Issues" section (`badge--clickable`/`badge__count`/`badge--filter-active`, click to isolate a status,
click again or "Show all" to clear) -- one pill per status (Missing/Disabled/Pending) with a live
count, never auto-reset by the background poll or a manual Refresh so an active filter survives both
(only clearing it explicitly resets it, matching every other clickable-pill filter in this app). Also
added a 💡 Tip callout under the tool-hero banner reminding the user that fixing something here only
updates staging -- Vortex's own **Deploy Mods** is still required to finish moving it into the game.

## Future work

Tracked in the workspace `TODO.md` (not duplicated here — confirmed 2026-07-27, one place to check
instead of two) under `vortex-tools/vortex-collection-tools`, split into "ready to work on" and
"still just ideas" groups. The "New Utilities section" idea that used to live in this section is
done -- see **Vortex Scrub (Utilities area)** above.

## Project structure

Reorganized 2026-07-27: the project root had accumulated a long flat list of standalone `.js`
scripts alongside the files that actually need to live at root (start/stop launchers, README/
TECHNICAL/DESIGN docs, package.json, config). Root now holds only those — every script moved into
`cli/` (still-supported CLI entry points, one per main feature) or `scripts/` (dev-only validation/
sandbox tools, never required by the running app). `lib/extract-mod.js` moved further, into `lib/`
itself, since it's really the same kind of isolated child-process worker as
`state-write-worker.js`/`state-query-worker.js` — it was only ever at root because the whole project
started there. Every moved file's own `require()`s (and the two hidden path dependencies —
`lib/rebuild-mod.js`'s real spawn of `extract-mod.js`, `scripts/smoke-test-collection.js`'s own copy
of that same spawn, and `scripts/sandbox-test-rebuild.js`'s spawn of `web/server.js` — all previously
bare/`__dirname`-relative strings that assumed "I live at the project root") were updated and each
script re-run standalone to confirm it still resolves and executes correctly, not just
`node --check`ed for syntax.

```
Vortex-Collection-Tools/
├── CLAUDE.md                                             — standing instructions for Claude Code in this repo
├── DESIGN.md                                             — UI/UX design guide: colors, components, voice,
│                                                            "every report must look the same" rule
├── config.json (gitignored), config.example.json      — single unified settings file, see lib/app-config.js
├── start-server.bat, start-server.ps1                    — double-click launchers (npm install on first run, then start + auto-open browser)
├── stop.bat, stop.ps1                                     — clean shutdown from anywhere
├── build-release.ps1                                      — packages a release zip (bundled Node/7-Zip + git-tracked files)
├── vortex-source-refs.json                                — curated Vortex/fomod-installer source citations,
│                                                              see scripts/check-vortex-source-drift.js
├── terminal-flow-archive/ (gitignored, not pushed to GitHub) — sync-menu.js, the old interactive
│   terminal menu; kept only as a reference for a possible future non-web-based flow
├── diagnostics/                                           — reusable READ-ONLY one-off diagnostics
│   └── wal-inclusion-check.js                             — see "Confirmed live (2026-07-27): the
│                                                              WAL-exclusion tradeoff..." above
├── cli/                                                    — still-supported CLI entry points (the web UI is the
│   │                                                          primary way to run each flow; these are for
│   │                                                          scripting/automation, or when there's no browser)
│   ├── rebuild-collection.js                              — Rebuild Collection, see section above
│   ├── sync-cli.js                                        — flag-based CLI for Update Collection (scripting/automation)
│   └── rules-generator-cli.js                             — Rules Generator Phase 1 deliverable (read-only,
│                                                              prints what it found — see "Rules Generator" above)
├── scripts/                                                — dev-only validation/sandbox tools, never required by
│   │                                                          the running app — see comments in each file
│   ├── compare-output.js, smoke-test-collection.js         — byte-for-byte extraction verification vs. Vortex's
│   │                                                          own real staging output
│   ├── snapshot-collection-staging.js                     — "before" snapshot for investigating post-rebuild
│   │                                                          Vortex external-changes reports
│   ├── download-collection.js                             — fetch a published collection bundle directly via Nexus
│   ├── check-vortex-source-drift.js                       — checks vortex-source-refs.json's cited files for
│   │                                                          upstream changes
│   ├── sandbox-test-rebuild.js                             — safe A/B concurrency testing, see section above
│   └── sandbox-test-download.js                            — safe archive-download testing, see section above
├── lib/
│   ├── app-config.js                                     — the unified config.json reader/writer
│   ├── collection-parser.js, archive-locator.js, fomod-parser.js, choice-resolver.js,
│   │   mod-root.js, simple-installer.js, sevenzip.js       — Rebuild Collection's extraction engine
│   ├── extract-mod.js                                      — isolated per-mod child-process worker, spawned by
│   │                                                          rebuild-mod.js (same convention as
│   │                                                          state-write-worker.js/state-query-worker.js)
│   ├── rebuild-mod.js, collection-runner.js                — Rebuild Collection orchestration (incl. the
│   │                                                          concurrent-extraction worker pool)
│   ├── ghost-files.js                                      — Vortex ".ghost" (disabled file) handling
│   ├── state-query-worker.js, state-write-worker.js         — isolated child-process DB access
│   ├── sync-runner.js                                       — Update Collection orchestration
│   ├── hash-manifest.js, diff-manifests.js, diff-manifests-ci.js, esp-flag-diff.js — comparison utils
│   ├── vortex-drift-check.js, nexus-collection-download.js, nexus-mod-download.js — per-mod archive
│   │   auto-download (Downloading missing archives automatically, see section above)
│   ├── log-aggregation.js                                  — shared Stats/Work Through Report queries
│   ├── offsite-import-map.js, work-through-state.js          — Work Through Report's own small state files
│   ├── rules-generator.js, rules-generator-runner.js, rules-generator-worker.js — Rules Generator's core
│   │   logic, isolated-worker orchestration, and worker entry point
│   ├── pause-controller.js                                — Rebuild Collection pause/resume state machine
│   ├── cleanup-scan.js, cleanup-exclude-store.js            — Vortex Scrub's scan/cross-check/delete logic
│   │                                                          and its exclude-list data file reader/writer
│   ├── download-naming.js                                   — shared Vortex download/staging-folder naming-
│   │                                                          convention regexes, used by cleanup-scan.js AND
│   │                                                          missing-masters-scan.js (see "Naming-convention
│   │                                                          gap" entries above)
│   ├── esp-header.js, esp-writer.js                          — Missing Masters' TES4 header reader / dummy-
│   │                                                          master plugin writer (Create Dummy Master)
│   ├── missing-masters-scan.js                              — Missing Masters' own detection/classification
│   ├── build-mod-from-vortex-state.js, rebuild-single-mod.js — single-mod rebuild engine (Missing Masters'
│   │                                                          "Rebuild This Mod", reuses rebuild-mod.js's
│   │                                                          classify/extract engine unchanged)
│   └── vortex-sync/                                          — Update Collection's engine
│       ├── lib.js, report.js, win-dialog.js (incl. the async pickFolderAsync used by Settings' Browse buttons)
│       ├── backups/ (gitignored), state-backups/ (gitignored)
├── web/
│   ├── server.js, rebuild-routes.js, sync-routes.js, settings-routes.js, stats-routes.js,
│   │   work-through-routes.js, rules-generator-routes.js, cleanup-routes.js, missing-masters-routes.js,
│   │   run-state.js, sync-run-state.js, sse-session.js
│   └── public/ (index.html, app.js, sync-app.js, settings-app.js, stats-app.js,
│       work-through-app.js, rules-generator-app.js, reports-rulesgen-app.js, cleanup-app.js,
│       missing-masters-app.js, status-labels.js, shell.js, styles.css)
├── diagnostics/            — permanent, reusable read-only diagnostics (wal-inclusion-check.js,
│                              inspect-mod-by-name.js) -- see each file's own header for what it's for
├── logs/ (gitignored)      — Rebuild Collection run logs
└── reports/ (gitignored)   — HTML reports written by the archived terminal-flow-archive/sync-menu.js
                              only; the web UI's own Compare report renders directly to the browser
                              response instead, nothing written to disk
```
