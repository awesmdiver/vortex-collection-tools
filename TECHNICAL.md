# Technical documentation

This is the deep-dive reference for Vortex Collection Tools — running from source, command-line
usage, internals, and the project layout. If you just want to try the app out, see
[`README.md`](README.md) instead; this file is for anyone who wants to dig further.

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
6. Zips the whole staged folder to `VortexCollectionTools-v<version>-win-x64.zip` at the project
   root.

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

A brand-new install with nothing configured yet lands on Settings automatically, once, with a
welcome banner — never again once staging/downloads are saved.

## Rebuild Collection

```
node rebuild-collection.js [--collection-mod-id <id>] [--staging <dir>] [--downloads <dir>]
  [--state <path>] [--backup-root <dir>] [--concurrency <1-8>] [--dry-run]
  [--resume <log-file>] [--yes]
```

Always run `--dry-run` first. See `lib/collection-runner.js`, `lib/rebuild-mod.js`, and the
extraction engine (`lib/simple-installer.js`, `lib/choice-resolver.js`, `lib/fomod-parser.js`,
`lib/sevenzip.js`) for how this works. Other CLI entry points (`extract-mod.js`,
`compare-output.js`, `smoke-test-collection.js`, `snapshot-collection-staging.js`,
`download-collection.js`, `check-vortex-source-drift.js`) are validation/utility tools used during
this engine's own development — see comments in each file.

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

**Verify with `sandbox-test-download.js` before enabling this for real** (see below) — it downloads
into a throwaway folder, never your real downloads directory, so you can confirm the mechanism
against your own real collection first.

## Sandbox-testing a download (or a rebuild) without touching real folders

`node sandbox-test-download.js --collection-mod-id <id> --sandbox-downloads <dir>
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

`node sandbox-test-rebuild.js --collection-mod-id <id> --sandbox <dir> [--port 4322]
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

> ⚠️ **Not stable yet — still being reviewed and improved.** Rebuild Collection is the well-tested
> part of this toolkit right now; treat everything below as in-progress.

The web UI (Update Collection tab) is the primary, recommended way to run this flow. A flag-based
CLI also exists for scripting/automation:
```
node sync-cli.js <command> [options]   # list-collections, backup, apply-ignores,
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
- **Cross-collection FOMOD-choice divergence**: currently always refuses
  (`FAILED_MISMATCH_NOT_TOUCHED`) when two collections recorded genuinely different install choices
  for a shared mod. Wants a "last collection wins" option with an explicit warning/confirm step
  (never silent), possibly a dedicated page listing every mod currently blocked this way with a
  manual per-mod "extract anyway" button. Not designed yet.
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

```
Vortex-Collection-Tools/
├── CLAUDE.md                                             — standing instructions for Claude Code in this repo
├── DESIGN.md                                             — UI/UX design guide: colors, components, voice,
│                                                            "every report must look the same" rule
├── config.json (gitignored), config.example.json      — single unified settings file, see lib/app-config.js
├── rebuild-collection.js, extract-mod.js, compare-output.js, smoke-test-collection.js,
│   snapshot-collection-staging.js, download-collection.js, check-vortex-source-drift.js,
│   sandbox-test-rebuild.js                              — safe A/B concurrency testing, see section above
│   sandbox-test-download.js                             — safe archive-download testing, see section above
├── start-server.bat, start-server.ps1                    — double-click launchers (npm install on first run, then start + auto-open browser)
├── sync-cli.js                                            — flag-based CLI for Update Collection (scripting/automation)
├── terminal-flow-archive/ (gitignored, not pushed to GitHub) — sync-menu.js, the old interactive
│   terminal menu; kept only as a reference for a possible future non-web-based flow
├── vortex-source-refs.json
├── lib/
│   ├── app-config.js                                     — the unified config.json reader/writer
│   ├── collection-parser.js, archive-locator.js, fomod-parser.js, choice-resolver.js,
│   │   mod-root.js, simple-installer.js, sevenzip.js       — Rebuild Collection's extraction engine
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
│   └── vortex-sync/                                          — Update Collection's engine
│       ├── lib.js, report.js, win-dialog.js (incl. the async pickFolderAsync used by Settings' Browse buttons)
│       ├── backups/ (gitignored), state-backups/ (gitignored)
├── web/
│   ├── server.js, rebuild-routes.js, sync-routes.js, settings-routes.js, stats-routes.js,
│   │   work-through-routes.js, run-state.js, sync-run-state.js, sse-session.js
│   └── public/ (index.html, app.js, sync-app.js, settings-app.js, stats-app.js,
│       work-through-app.js, shell.js, styles.css)
├── logs/ (gitignored)      — Rebuild Collection run logs
└── reports/ (gitignored)   — HTML reports written by the archived terminal-flow-archive/sync-menu.js
                              only; the web UI's own Compare report renders directly to the browser
                              response instead, nothing written to disk
```
