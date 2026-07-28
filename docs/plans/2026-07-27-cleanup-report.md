# "Clean Up" Report — Orphaned Archives & Staging Folders

## Context

Heavy testing/reinstalling has left junk behind: staging folders and/or downloaded archives that
Vortex has no real relationship with anymore. Confirmed live via a real example the user found in
Vortex's own mod list (`College Curriculum - Faction Requirement-79929-1-0-0-1670095062`, shown with
its raw modId-version-timestamp as the display name instead of a friendly name): Vortex had silently
auto-adopted the unrecognized staging folder into a bare `mods###` entry (installationPath = the
folder name, `state: "installed"`, `type: ""`) with **no `archiveId`, no `attributes.customFileName`,
no collection membership, no download record, no rich metadata of any kind** -- functionally an
orphan even though it technically exists in Vortex's state. Compared against a normal, properly
linked mod (`Alchemy Station Variants - FOMOD`), which has `archiveId`, `attributes.fileName`,
`attributes.customFileName`, full metadata, etc. This confirms exactly what "no relationship with a
downloaded mod or collection" should mean in code, and that it's a real, currently-existing problem
worth building a permanent tool for, not just a one-off cleanup.

The user wants a **"Clean Up" report** (working name -- final name TBD) with two entry points --
**Scan Archives** and **Scan Staging** -- that inventories one side (downloaded archive files, or
staging folders) and finds every item Vortex has no real relationship with. Findings are listed with
a checkbox each, plus **Delete Selected** and **Delete All** actions. After deleting from either scan,
a follow-up check runs the OTHER inventory looking for matching counterparts (an orphaned archive's
same-named staging folder, or vice versa) and offers to delete those too. **Confirmed with the user:
no backup/quarantine step is needed before deleting** -- these are Vortex-recoverable (re-download
from Nexus, or re-extract via Rebuild Collection), and if something actually still mattered, Vortex
itself would flag the affected collection as incomplete. A clear confirmation dialog before every
delete is still required.

## Research findings (verified against real code + live data, not assumed)

- **Real mod, real archive**: `mods###skyrimse###<modId>` has `archiveId` (a UUID pointing to a
  `downloads###files###<archiveId>` record), `attributes.fileName`/`customFileName`/`author`/
  `category`/etc. `installationPath` is the raw folder name; `attributes.customFileName` is the
  friendly display override -- the underlying staging folder name is ALWAYS the raw pattern
  regardless of any custom display name (confirmed: `(0) Alchemy Station Variants - FOMOD` mod's
  `installationPath` is still `(0) Alchemy Station Variants - FOMOD-92768-1-4-6-1767891639`).
- **Ghost/orphan mod** (the College Curriculum example): `mods###` entry exists, but has no
  `archiveId` field at all, no `attributes.customFileName`, no `attributes.collectionSlug` -- just
  `id`/`installationPath`/`attributes.name` (= the raw folder name)/`state`/`type`.
- **Archive filename <-> staging folder name is an EXACT match, always**: confirmed by comparing
  real downloads-folder and staging-folder listings side by side --
  `(0) Alchemy Station Variants - FOMOD-92768-1-4-6-1767891639.7z` (archive) vs.
  `(0) Alchemy Station Variants - FOMOD-92768-1-4-6-1767891639` (staging folder, same name minus
  extension). **No fuzzy matching needed for the cross-scan step** -- it's a plain exact-string
  comparison (archive basename with its extension stripped vs. folder name).
  `downloads###files###<id>.localPath` is documented in Vortex's own source
  (`IDownload.localPath`, `src/renderer/.../types/IDownload.ts`) as "in practice just the file name."
- **In-progress downloads must be excluded from Scan Archives**: Vortex prefixes a download still in
  progress with `__vortex_tmp_` (`TEMP_DOWNLOAD_PREFIX`,
  `src/renderer/src/extensions/download_management/util/downloadNames.ts`) before renaming it to its
  final name on completion. Any file with this prefix must be skipped entirely, not flagged as
  orphaned (it will legitimately have no matching `downloads###` record yet).
- **Collection membership field**: `attributes###collectionSlug`, already used the same way
  elsewhere in this project (`lib/rules-generator.js`, `lib/state-query-worker.js`) -- reuse it here
  rather than inventing a new membership check.
- **Existing conventions to reuse, not reinvent**:
  - Reports area + sub-tab pattern: `web/public/index.html`'s `#area-reports` /
    `reports-sub-area-*` divs + `reports-sub-*` nav buttons, each with its own `<name>-app.js`
    (see `reports-rulesgen-app.js` for the newest example). A new "Clean Up" sub-tab follows this
    exact shape.
  - Destructive-delete confirmation pattern: `web/public/settings-app.js`'s "Delete all backups"
    flow (`settingsDeleteBackupsBtn` -> fetch a count -> show a modal with the count baked into the
    text -> confirm -> delete). Reuse this shape for Delete Selected / Delete All here.
  - Safe DB reads: `lib/vortex-sync/lib.js`'s `withStateDb` (requires Vortex closed, same as every
    other read in this project -- confirmed live during this investigation, `withStateDbCopy` throws
    if Vortex is running).
  - New permanent diagnostic already added and verified this session:
    `diagnostics/inspect-mod-by-name.js` (dumps every field for any mod/download whose id or values
    match a search string) -- directly useful for spot-checking scan results by hand later.

## Design

### Orphan criteria (exact rules for what counts as an exception)

**Scan Staging** (inventory = folder names directly under the configured staging dir):
A staging folder is an exception if EITHER:
1. No `mods###skyrimse###<modId>` entry has `installationPath` equal to this folder name at all, OR
2. A matching mod entry exists, but it has no `archiveId` AND no `attributes###collectionSlug`
   (the ghost-mod case -- Vortex adopted the folder but it has no real backing).

**Scan Archives** (inventory = files directly under the configured downloads dir, skipping any
`__vortex_tmp_*`-prefixed file):
An archive file is an exception if no `downloads###files###<id>` entry has `localPath` equal to this
file's name (checked regardless of that download's `state` -- any record referencing the filename
means Vortex knows about it, complete or not).

### Cross-scan follow-up (exact-match only, no fuzzy logic)

After a delete from either scan, take the basenames of what was just deleted (archive names with
their extension stripped, or staging folder names) and check the OTHER location for a file/folder
with that exact same base name. Report the count and list, and offer a second "delete these too"
confirmation. This reuses the same exception-list/checkbox UI, just pre-filled from the cross-check
instead of a fresh scan.

### Backend

- New `lib/cleanup-scan.js` (mirrors `lib/collection-runner.js`'s `withStateDb` usage style):
  - `scanStaging(stateDir, stagingDir)` -> reads all `mods###skyrimse###*` entries once (installPath,
    archiveId, collectionSlug per modId), lists the staging dir, returns `{ folder, reason:
    'no-mod-entry' | 'ghost-mod' }[]` for exceptions.
  - `scanArchives(stateDir, downloadsDir)` -> reads all `downloads###files###*.localPath` values once,
    lists the downloads dir (skip `__vortex_tmp_*`), returns `{ file, sizeBytes }[]` for exceptions.
  - `crossCheck(kind, deletedBaseNames, otherDir)` -> plain `fs.readdirSync` + exact basename
    comparison against `otherDir`, no state read needed (matches by name only, per the confirmed
    exact-match convention).
  - `deleteEntries(paths)` -> `fs.rmSync` per path (recursive for staging folders, plain unlink for
    archive files), no backup step (per the user's explicit confirmation), returns per-path
    success/failure so the UI can report partial failures (e.g. a locked file) instead of silently
    swallowing them.
- New `web/cleanup-routes.js` (mirrors `stats-routes.js`'s read-only-report style plus
  `settings-routes.js`'s delete-with-confirmation style):
  - `GET /api/cleanup/scan-staging`, `GET /api/cleanup/scan-archives` -> exception lists.
  - `POST /api/cleanup/cross-check` `{ kind, baseNames }` -> the other side's matching list.
  - `POST /api/cleanup/delete` `{ kind, paths }` -> deletes, returns per-item results.
  - No `vortexRunningGate` needed for the scan reads (same as other report routes -- `withStateDb`
    already enforces Vortex-closed itself and throws a clear error the UI surfaces); deletes are pure
    filesystem operations independent of Vortex's running state, but still fine to check
    `isVortexRunning()` first purely to keep messaging consistent with the rest of the app.

### Frontend

- New sub-tab in `#area-reports`: `reports-sub-cleanup` button + `reports-sub-area-cleanup` div,
  registered in `stats-app.js`'s `REPORTS_SUB_TABS`/`REPORTS_SUB_TAB_URL_MAP` alongside the existing
  four.
- New `web/public/reports-cleanup-app.js`:
  - Two buttons, "Scan Archives" / "Scan Staging", each calling its scan route and rendering the
    exception list: one row per item, a checkbox, the folder/file name, and (for archives) a
    human-readable size. A "select all" checkbox at the top.
  - "Delete Selected" (only the checked rows) and "Delete All" (every listed exception, no need to
    check every box first) -- both open the same confirmation modal shape as
    `settingsDeleteBackupsModal`, text baked with the real count ("This will permanently delete N
    staging folder(s)."), Cancel/Confirm.
  - After a successful delete, call the cross-check route with the deleted base names; if it returns
    any matches, show a second modal ("Found N matching {folder(s)/archive(s)} in {staging/the
    downloads folder} -- delete these too?") reusing the same list-with-checkboxes + Delete
    All/Selected UI, scoped to just that cross-check result.
  - A short static note above the buttons flagging the one real timing caveat found during design: if
    Rebuild Collection just finished extracting and Vortex hasn't been reopened yet to import the
    result, those staging folders will show as unmatched until Vortex processes them -- open Vortex
    first if that's the situation.

## Files touched

- `lib/cleanup-scan.js` -- new, the scan/cross-check/delete logic described above.
- `web/cleanup-routes.js` -- new, the four routes described above.
- `web/server.js` -- wire the new router in (same one-liner pattern as the other route files).
- `web/public/index.html` -- new Reports sub-tab button + sub-area div + confirmation modal(s)
  (mirroring `settingsDeleteBackupsModal`'s markup).
- `web/public/stats-app.js` -- register the new sub-tab in `REPORTS_SUB_TABS`/
  `REPORTS_SUB_TAB_URL_MAP`.
- `web/public/reports-cleanup-app.js` -- new, the UI logic described above.
- `TECHNICAL.md` -- document the orphan criteria, the exact-match cross-scan design, and the
  no-backup-needed decision (with the user's stated reasoning) so this doesn't get re-litigated.
- `diagnostics/inspect-mod-by-name.js` -- already created and fixed this session (had a real
  prefix-scan bounds bug, now corrected); no further change needed, just noted here as the tool to
  spot-check scan results against by hand.

## Verification

1. Syntax-check every new/edited file (`node --check`).
2. Dry-run the scan logic against the REAL current state (Vortex closed): confirm `scanStaging`
   flags the known example (`College Curriculum - Faction Requirement-79929-1-0-0-1670095062` and
   its two siblings from the same screenshot) and does NOT flag a known-good mod (e.g. the Alchemy
   Station Variants example). Confirm `scanArchives` correctly skips any `__vortex_tmp_*` file if one
   exists at test time.
3. Live UI test: run both scans for real, verify counts/names match a manual `ls` of the staging and
   downloads folders cross-referenced against the diagnostic script's output.
4. Test the confirmation-modal delete path on a small, deliberately-created throwaway folder/file
   first (not the user's real orphans) to confirm the delete + UI refresh works before running it for
   real.
5. Test the cross-scan follow-up: delete the confirmed staging-only orphans for real, confirm the
   follow-up correctly reports 0 matching archives (since this specific example has none), then find
   or construct a case where both sides exist to confirm the "delete these too" path actually fires
   and works.
6. Once implemented and confirmed working end-to-end, copy this plan file into this project's own
   `docs/plans/` per standing convention (in addition to wherever it lives in `~/.claude/plans`).

## Post-implementation update (2026-07-27, same day)

Implemented largely as planned, with one significant addition found necessary during live testing
against the user's real data -- documented in full in `TECHNICAL.md`'s "Clean Up report" section,
summarized here:

- **Confidence split added**: the original single-list "ghost-mod" criterion (no `archiveId` + no
  `attributes.collectionSlug`) can't tell a truly-abandoned mod apart from a deliberate,
  no-archive-by-design "fake mod" a generator tool creates. Running Scan Staging for real flagged
  not just the College Curriculum example but also `DynDOLOD Output`, `TexGen Output`,
  `PGPatcher Output`, `Pandora Output`, `My Patches Output`, and several `vortex_collection_*`
  folders (Vortex's own internal Workshop storage) -- all share the identical no-archive/
  no-collection signature as a genuine orphan, but deleting them would silently break the user's
  LOD/bodies/patches with no Vortex-level warning (the stated "Vortex would flag it" safety net only
  covers actual collection members). Fix (the user's own): Vortex's download-naming convention
  always ends a name in `-<modId>-<version parts>-<10-digit unix timestamp>` -- a hand-named folder
  never does. Every candidate now splits into a confident `exceptions` bucket (name matches the
  pattern, normal bulk Delete Selected/Delete All) and an `needsReview` bucket (name doesn't match,
  shown in its own "Action Needed: Unrecognized Folders/Archives Found" callout ABOVE the confident
  list, with its own four actions -- Delete Checked, Delete All, Exclude Checked, Exclude All --
  every one still behind a confirmation dialog). `vortex_collection_*` is hard-excluded from both
  buckets entirely.
- **Permanent exclude list added**: `config.json`'s `cleanupIgnoredStaging`/`cleanupIgnoredArchives`
  (`lib/app-config.js`, synced to `config.example.json`) -- once a `needsReview` item is confirmed
  legitimate via Exclude, it's filtered out of every future scan. Maintained under a new
  **Settings > Clean Up** section (view both lists, remove an entry, or add one manually) --
  requested by the user mid-implementation as a natural extension once the exclude concept existed.
- **New/changed routes**: `POST /api/cleanup/exclude` (bulk-add to the ignore list, used by both the
  report's Exclude actions and Settings' manual add), `GET /api/cleanup/ignored` +
  `POST /api/cleanup/ignored/remove` (Settings' list view/remove). `scan-staging`/`scan-archives`
  responses gained a `needsReview` array alongside `exceptions`.
- **Verified live end-to-end** against the user's real, current data (not synthetic): Scan Staging
  correctly split 47 candidates into 26 confident exceptions (including the exact College Curriculum
  trio) and 21 needsReview items (DynDOLOD/PGPatcher/Pandora/TexGen/etc.), with zero
  `vortex_collection_*` leakage into either bucket. Scan Archives correctly found 0 exceptions on the
  final, settled state -- a single false positive from a very early test run (right after the user
  closed Vortex) turned out to be a LevelDB flush-timing artifact, not a real bug: re-checking found
  a genuine matching download record for that file. The delete-confirmation modal, Settings
  add/remove flow, and the exclude-then-rescan cycle were all exercised live in the browser (with
  actual deletes deliberately left for the user to trigger on their own real data, not automated by
  Claude).
- `diagnostics/inspect-mod-by-name.js` (fixed prefix-scan bounds bug, see its own header) was used
  throughout to verify ground truth against the live database before writing any matching logic.

## Post-implementation update #2 (2026-07-27, same day, after live user review)

Further refinements the user asked for after actually using the built feature:

- **Exclude-list storage moved out of config.json into its own user-chosen folder**
  (`lib/cleanup-exclude-store.js`, a `{staging, archives}` JSON file, folder set via the new
  REQUIRED `cleanupExcludeListDir` path field). Prompted by a new standing rule the user stated
  explicitly: every new data location this project adds must be a path the user picks, never a
  silent default (saved to memory as `feedback_user_configurable_storage_paths`). Mirrors
  `syncBackupRoot`'s required-path treatment, with the same Settings "Browse..." + restart-required
  flow as `backupRoot`.
- **Archive-side exclude matching made extension-agnostic** -- the user asked to double-check
  whether adding an exclude entry WITH the file extension worked correctly; it did, but testing
  surfaced a real gap the other way (an entry typed WITHOUT the extension silently never matched).
  Fixed by comparing base names (extension stripped) on both sides.
  `Archmage Apparel Replacement version-19157-1-0` (no timestamp suffix) was flagged by the user as
  a real mod that just doesn't fully match the naming convention -- confirmed it already lands
  correctly in `needsReview` (not auto-deleted, not silently trusted), no code change needed there.
- **Settings exclude-list UI redesigned twice**: first from a single "Remove" button per row to the
  report's own checkbox + Remove-Selected/Remove-All convention, inside an expandable `<details>`
  disclosure showing a live count (the user pointed out Settings had no visible way to see or remove
  what was already excluded). Then the per-list "Select all" checkbox was removed again immediately
  after -- the user correctly pointed out it's pure redundancy once a Remove All button already
  exists right next to it. (The report's OWN "Select all" checkboxes, on the exceptions/needsReview
  lists, were left as-is -- this feedback was scoped to Settings' "Excluded folders/archives"
  sections specifically.)
- All of the above verified live in the browser against the real server (not just unit-tested):
  set a real exclude-list folder, saved, went through the actual restart-required flow, added/
  expanded/checked/removed entries, confirmed the on-disk `exclude-list.json` matched the UI state
  at every step, and re-ran the Clean Up report itself afterward to confirm scan-staging/
  scan-archives still worked correctly against the new store-based backend.
