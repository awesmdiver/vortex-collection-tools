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

## Future work

Eventually replacing Vortex's own slow "Resume" install step with this project's fast direct
extraction, for the Update Collection flow too — so collection updates become as fast as rebuilds
already are. Independently re-raised twice now (once during this project's own early design, once
again later after noticing the "Resume is the slow step" wording on the Update Collection page) --
a second, independent read on the same idea is a good sign it's worth pursuing seriously, not just
a one-off thought. The likely division of labor: Rebuild Collection's engine does the actual
SLOW part (archive extraction, FOMOD choice replay) directly to the staging folder -- the part
this project already does fast -- while Vortex itself still handles anything this project doesn't
replicate today (live FOMOD installer PROMPTS for a genuinely new mod with no prior recorded
choices, and critically, registering the result as a tracked mod entry in its own state database).
Real, unsolved blocker: Rebuild Collection's engine only ever touches the staging filesystem, with
zero awareness of Vortex's state database; Vortex itself must still register any new/changed
staging folder as a tracked mod entry (state-DB record, correct per-profile enabled state,
load-order integration) — today only Vortex's own "Resume" step does this, and nothing in this
project creates a brand-new mod entry from scratch. This needs its own research spike (reading
Vortex's real installer source, the way `vortex-source-refs.json`/`check-vortex-source-drift.js`
already do for the extraction side) before any design is attempted.

Other open items, not yet started:
- **Refresh `TESTED_VORTEX_VERSIONS`** (low priority — deprioritized 2026-07-25; the identity-drift
  detector below covers the actual risk this was meant to guard against, so this is now a nice-to-
  have accuracy improvement, not a safety gap): researched Vortex's own GitHub source
  (`Nexus-Mods/Vortex`) to see whether it has a better DB-incompatibility signal than an app-version
  allowlist. Findings: Vortex's own migration system (`src/renderer/src/util/migrate.ts`) isn't a
  monotonic schema-version counter either — it's per-migration `minVersion` semver gates plus an
  already-applied-migration-ids ledger (`state.app.migrations`), checked against the same
  `state.app.appVersion` this tool already reads. So the allowlist approach is directionally the
  right idea, just stale: current Vortex HEAD is 2.4.0-beta.2 (this tool's list still stops at
  2.3.0), and two real persisted-state-shape fixes shipped since — `moveDomainFolders_2_1` (2.1.0
  beta.4→beta.5, a `download.game` domain bug) and `healStoragePathNames_2_4` (2.4.0 beta.1→beta.2,
  CDN storage paths polluting mod/download names) — neither is a `rules`-array change specifically,
  but confirms Vortex does still change persisted shapes between betas. Bump the allowlist to
  include 2.4.0-beta.1/.2 once actually exercised against them, and periodically re-diff against
  Vortex's `CHANGELOG.md`.
- **Multi-profile validation**: both tools should operate on/show data from whichever Vortex profile
  is currently ENABLED when more than one profile exists, not blend across profiles. Update
  Collection is already explicitly profile-aware (`profileId` is a first-class concept throughout
  its own code); Rebuild Collection's side looks murkier (`state-query-worker.js`'s
  `buildModVersionIndex` collects every profile a mod is enabled in, with no apparent "current
  profile" scoping). Can't be fully tested yet — needs a second real Vortex profile to validate
  against.
- **Extend the Create-Backup freshness check to Apply Ignores/Apply Disables previews and Rules
  Generator** (see "Confirmed live (2026-07-27)... Fixed (2026-07-27)..." above — Create Backup's
  `checkBackupFreshness` is done; the same WAL-vs-safe comparison technique is directly reusable
  wherever else `withStateDb` reads ignored/disabled/rules data, but isn't wired up yet anywhere else).
- **Cross-collection FOMOD-choice divergence**: currently always refuses
  (`FAILED_MISMATCH_NOT_TOUCHED`) when two collections recorded genuinely different install choices
  for a shared mod. Wants a "last collection wins" option with an explicit warning/confirm step
  (never silent), possibly a dedicated page listing every mod currently blocked this way with a
  manual per-mod "extract anyway" button. Not designed yet.
- **Rules Generator report, Phase 2**: today's report (see "Rules Generator Report (Completed /
  Exceptions)" above) can't confirm the leftover-old-install mods are actually ENABLED in the active
  profile (no per-profile state read yet) or that they genuinely file-conflict with anything (would
  need a real filesystem scan against every new-collection member — too expensive to run for every
  report). Phase 2 candidates: read per-profile mod-enabled state (same DB area
  `state-query-worker.js`'s `buildModVersionIndex` already touches for a different purpose) to
  upgrade "still installed" to "still installed AND enabled"; and/or a persisted log per Apply run
  (today's report is always computed fresh live, nothing is saved) so history can be browsed the way
  Stats Report browses Rebuild Collection's history.
- **`sync-cli.js` refactor** to call `lib/sync-runner.js` (it still calls `lib/vortex-sync/lib.js`
  directly) — pure cleanup, functionally unaffected, low priority.
- **Background watchdog process** so the server can actually be restarted from the web UI even when
  it's crashed/died outright (today's "can't reach the server" message, added 2026-07-25, can only
  ever tell the user to relaunch `start-server.bat` themselves — nothing can be listening to receive
  an HTTP "restart" request if the process is fully dead). A watchdog would need: (1) to become the
  new thing the user actually starts/stops instead of `node web/server.js` directly, since otherwise
  it can't tell "user closed it on purpose" apart from "it crashed, relaunch it" and would just
  resurrect the server every time someone tries to shut it down; (2) a real stop mechanism (a "Stop
  Server" web UI control, most likely) for the watchdog to listen for, since a fully hidden/no-window
  process has no window to close and no console to Ctrl+C; (3) some way to still see server console
  output for real debugging, which a fully hidden window loses. Not designed or scoped yet.
- **Multi-game support**: this whole project is hardcoded to `GAME_ID = 'skyrimse'` throughout
  (`lib/vortex-sync/lib.js` and beyond) — Vortex's own state.v2 is shared across every game it
  manages, not just Skyrim SE (confirmed live: a real install had a genuine, unrelated Dragon's
  Dogma 2 profile sitting in the same database, correctly filtered out of `listProfiles()` rather
  than treated as corrupted). Supporting other games would mean threading a `gameId` parameter
  through instead of the current hardcoded constant — real scope, not started, only worth doing if
  this tool is ever meant to cover games besides Skyrim SE.
- Backup-before-rebuild deliberately stayed sequential when extraction went concurrent (see
  **Concurrent extraction** above) — revisit only if it's ever an actual bottleneck; it's off by
  default already.
- **Ignored/Disabled report could show every Vortex mod status**, not just Ignored/Disabled (e.g.
  Enabled, Endorsed/not, install-failed, etc.) — currently scoped narrowly to what Update Collection
  itself actually tracks/acts on. Raised as a "maybe in the future" idea, not designed or scoped yet
  — needs a real discussion on which statuses are worth surfacing and why before building it.
- ~~**No web UI to restore the automatic full state.v2 backup.**~~ — done. Settings page's Update
  Collection group ("Vortex database backups" subsection) now has a "Restore…" button next to
  "Delete all backups" -- lists available backups by timestamp (`GET /api/sync/state-backups`),
  restores the chosen one (`POST /api/sync/restore-state`), gated server-side exactly like every
  other live-state write here (Vortex must be closed). Kept distinctly named/located from the
  unrelated "Restore Backup" button on the Update Collection page itself (that one restores a
  collection's ignore/disable snapshot, not the live database).
- ~~**Self-contained release packaging**~~ — done, see **Building a release package** above
  (`build-release.ps1`) and the main README's "Getting a release without installing anything"
  section. A literal single-.exe (Node SEA / `pkg`) was considered and rejected: `classic-level`'s
  native addon and this project's read/write-next-to-the-app-folder assumptions (config.json, logs,
  backups) both fight a packaged snapshot's read-only filesystem model.
- **Possible web-UI "Dry Run" option**: the CLI has a real `--dry-run` flag, but the web UI's own
  "View Collection" → Plan → "Start Rebuild" flow already shows a full preview before anything is
  touched, so there's no separate dry-run *mode* to opt into there today. Not needed right now, but
  worth reconsidering if testers end up wanting an explicit "just preview, don't even show me the
  Start Rebuild button yet" option in Settings.
- **New "Utilities" section** (top-level nav area, alongside Rebuild Collection/Update
  Collection/Settings/Reports) — a home for standalone maintenance tools that don't belong to either
  main workflow. First utility: **delete unused staging folders and/or archives** — find staging
  mod-folders and/or downloaded archives that no longer correspond to anything any installed
  collection actually references, and let the user review/delete them. Not designed yet (needs
  real thought on what "unused" means precisely — e.g. cross-referencing every installed
  collection's `collection.json` against staging/downloads contents — and what the review/confirm
  UI looks like before deleting anything real).
- **Callout icon/classification pass**: the target convention is now documented (see **Callout
  severity conventions** above) and `.callout--info`/`.callout--warning`/`.callout--critical` all
  exist — but most of the app hasn't been migrated to it yet. Needs a real inventory pass: list
  every existing callout/banner/status message in the app and reclassify each into the right
  severity, fixing the several `.callout--warning` uses that aren't actually warnings under the
  documented convention (e.g. the "Next steps in Vortex" instructional boxes, the first-run
  Settings welcome banner — both informational, not warnings). Not started.

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
│   └── vortex-sync/                                          — Update Collection's engine
│       ├── lib.js, report.js, win-dialog.js (incl. the async pickFolderAsync used by Settings' Browse buttons)
│       ├── backups/ (gitignored), state-backups/ (gitignored)
├── web/
│   ├── server.js, rebuild-routes.js, sync-routes.js, settings-routes.js, stats-routes.js,
│   │   work-through-routes.js, rules-generator-routes.js, run-state.js, sync-run-state.js, sse-session.js
│   └── public/ (index.html, app.js, sync-app.js, settings-app.js, stats-app.js,
│       work-through-app.js, rules-generator-app.js, reports-rulesgen-app.js, status-labels.js,
│       shell.js, styles.css)
├── logs/ (gitignored)      — Rebuild Collection run logs
└── reports/ (gitignored)   — HTML reports written by the archived terminal-flow-archive/sync-menu.js
                              only; the web UI's own Compare report renders directly to the browser
                              response instead, nothing written to disk
```
