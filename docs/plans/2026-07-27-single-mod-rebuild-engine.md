# Standalone single-mod extraction engine (Rebuild Collection ↔ Missing Masters)

## Context

Missing Masters found a real case (`Snazzy Morthal AIO-147759-2-1-1751281253`) where Vortex's own
database says a mod is `"installed"`, its source archive is still intact in Downloads, but its
staging folder on disk is completely empty — so a plugin it should contain (`Snazzy Interiors -
Morthal AIO.esp`) shows up as a "missing master." Create Dummy Master *does* fully resolve the
missing-master problem itself (Skyrim loads fine, no crash) — but Vortex still believes the mod is
installed while there's nothing on disk for the game to actually load, so the mod's own content
(here, the remodeled Morthal interiors) is simply invisible in-game, with no error to point at why.
Rebuild Collection already solves exactly this class of problem (re-extract a mod from its archive,
replaying FOMOD choices, so the real files exist again, not just a stand-in for the crash) but only
as part of a whole-collection run driven by `collection.json`. The goal here is to make that same
extraction capability callable for **one mod at a time**, driven by Vortex's own per-mod state.v2
record instead of a collection manifest, so Missing Masters (or any future tool) can trigger a
targeted repair without needing this mod to belong to any active Collection.

Confirmed via direct investigation (not assumed): `lib/rebuild-mod.js`'s `classifyMod()`/
`rebuildMod()` already operate on a single plain `mod` object, not a whole collection — and
Vortex's own per-mod `attributes.installerChoices` (in state.v2) uses the **exact same shape**
`choices-resolver.js`'s `resolveChoices()` expects from `collection.json`'s `choices` block
(`[{name, groups:[{name, choices:[{idx, name}]}]}]`). So no collection membership is actually
required — only translating state.v2's own recorded fields into the shape this engine already
consumes. The one wrinkle: `extract-mod.js` runs in a spawned child process and always re-reads
`collection.json` from disk by mod name (`loadCollection`/`findMod`) — it never accepts an
in-memory mod object. Rather than touching that already-tested file, the new engine writes a tiny
synthetic single-mod `collection.json`-shaped temp file and points `--collection` at it — zero
changes to `extract-mod.js`, `fomod-parser.js`, `choice-resolver.js`, `archive-locator.js`, or
`collection-parser.js`.

**Threading**: confirmed with the user this is a single-person tool, not enterprise — the odds of
a whole-collection Rebuild Collection run and a Missing-Masters single-mod repair both touching
the *same* mod at the *same* moment are negligible. No new per-mod/per-folder lock is being built.
The only real guard: refuse to start a single-mod repair if `web/run-state.js`'s existing
`isRunActive()` (already the single global "a Rebuild Collection run is happening" flag) is true —
a plain read-only check, zero changes to `run-state.js` or the existing collection-run flow.

**Risk framing**: per the user, if a repair ever extracts into the wrong empty folder, the fallout
is cheap — it's just staging/archive data, trivially deleted and re-obtained from Nexus. This is
why the design below favors a lightweight, transparent name-match heuristic (shown to the user,
not silently trusted) over building an elaborate "prove it's the right mod first" verification
pass.

## New files

### `lib/build-mod-from-vortex-state.js`
`async function buildModFromVortexState({ stateDir, gameId, vortexModId })` — opens a safe copy of
state.v2 (`syncLib.withStateDb`, the same pattern every other state.v2 read in this project
already uses) and reads `persistent###mods###<gameId>###<vortexModId>###attributes###*`. Returns:
```js
{
  name: attributes.customFileName || attributes.logicalFileName || vortexModId,
  source: {
    type: attributes.source === 'nexus' ? 'nexus' : 'offsite',
    modId: attributes.modId,
    fileId: attributes.fileId,
    fileSize: attributes.fileSize,
    md5: attributes.fileMD5,
    logicalFilename: attributes.logicalFileName,
  },
  choices: attributes.installerChoices
    ? { type: attributes.installerChoices.type, options: attributes.installerChoices.options }
    : undefined,
}
```
Throws a clear error if the mod key doesn't exist in state.v2 at all.

### `lib/rebuild-single-mod.js`
`async function rebuildSingleMod({ vortexModId, gameId, stateDir, downloadsDir, stagingDir, apiKey, gameDomain, allowAutoDownload })`:
1. `if (runState.isRunActive()) throw RUN_ACTIVE-style error` — "A Rebuild Collection run is
   currently in progress. Wait for it to finish, then try again."
2. `mod = await buildModFromVortexState(...)`.
3. Write `{ mods: [mod] }` to a temp file (`fs.mkdtempSync` + a fixed filename inside it, cleaned
   up in a `finally`) — this is the synthetic single-mod "collection.json".
4. `classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId: vortexModId, sevenZipExe })`
   (existing, unchanged).
5. If `SKIP_NO_ARCHIVE` and `mod.source.type === 'nexus'` and `allowAutoDownload`: call the
   existing `downloadModArchive({ apiKey, gameDomain, source: mod.source, destDir: downloadsDir })`
   (`lib/nexus-mod-download.js`, unchanged), then re-run `classifyMod` once more.
6. If still not `REBUILD`-classified, return that classify result as-is (same `SKIP_*` vocabulary
   Rebuild Collection's UI already knows how to render).
7. `rebuildMod(mod, action, { collectionJsonPath: tempCollectionPath, downloadsDir, stagingDir })`
   (existing, unchanged) — returns the same `REBUILT`/`FAILED_*` status shapes already used
   elsewhere in this app.
8. Delete the temp file/dir regardless of outcome.

No new CLI wrapper for now (not needed for this feature — can add one later trivially, since
`rebuildSingleMod()` is already a clean, dependency-injected library function).

## Route

New `POST /api/missing-masters/rebuild-mod` in `web/missing-masters-routes.js` (this router
already receives the full shared `config` object per `web/server.js:106` — `state`/`downloads`
just need to be destructured alongside the fields it already pulls out, no `server.js` change
needed). Add a local `vortexRunningGate(res)` closure matching the exact convention already used
in `cleanup-routes.js`/`rules-generator-routes.js`/`sync-routes.js` (this file currently has none,
by design, since its other two routes never needed Vortex closed — this is the one action that
does). Body: `{ vortexModId, allowAutoDownload }`. Flow: gate → call `rebuildSingleMod()` → 200
with the result, or the existing house-style `res.status(500).json({ error: e.message })` on
failure. Matches `rebuild-routes.js`'s simple synchronous-response convention (like
`/import-offsite-archive`) — no SSE session needed, this is a single fast mod.

## Missing Masters UI changes

**Detection (offline, no Vortex needed, extends `lib/missing-masters-scan.js`)**: during
`buildStagingModNameIndex`'s existing folder walk, also record any staging folder found completely
empty (0 files, including the existing one-level `data/Data` subfolder check) as a candidate
"hollow install," keyed by its cleaned display name (`stripDownloadNameSuffix`, already built).
For each `missing`-status master, do a simple token-overlap check between the master's own
filename (minus extension) and each hollow-install's cleaned name — if any share enough
significant words, attach it to that master entry as `possibleHollowInstall: { folderName,
vortexModId }` (`vortexModId` here is that folder's own name, per the confirmed real-world
pattern where installationPath/folder name doubles as the mods### key).

**Row UI** (`web/public/missing-masters-app.js`, `mmRenderMasterRow`): when
`possibleHollowInstall` is present, show a callout (same `.callout--warning` "Manual Action Needed"
convention already established) naming the specific folder plainly — e.g. *"We found an empty
install that might be the cause: `<folder>`."* — plus a **"Rebuild This Mod"** button next to
Create Dummy Master (they're not mutually exclusive; showing both is fine). This is deliberately
transparent about being a guess, not asserted as fact, matching the user's own "if in doubt, show
it, don't silently assume" precedent elsewhere in this app.

**Click flow**: same "Vortex must be closed" gate Vortex Scrub already uses client-side (check via
existing `syncLib.isVortexRunning()`-backed pattern, show the existing shared "Vortex is currently
running" modal if not) → confirm modal (mirroring Create Dummy Master's own confirm-before-write
modal) → `POST /api/missing-masters/rebuild-mod` → render the result plainly (REBUILT / SKIP_* /
FAILED_* — reuse existing status-badge styling) → re-run the normal Missing Masters scan so the
row updates.

## Files touched
- NEW `lib/build-mod-from-vortex-state.js`
- NEW `lib/rebuild-single-mod.js`
- `lib/missing-masters-scan.js` — hollow-install detection + `possibleHollowInstall` field
- `web/missing-masters-routes.js` — new route + local `vortexRunningGate`
- `web/public/missing-masters-app.js` — new callout + button + confirm modal + API call
- `web/public/index.html` — the new confirm-modal markup (mirrors `mmCreateDummyConfirmModal`)
- `TECHNICAL.md` — write up the design (state.v2↔collection.json shape equivalence, the synthetic
  temp-collection.json trick, the run-state.js reuse for the threading question) once built
- `DESIGN.md` — only if any new visible UI pattern doesn't already have a match (unlikely — this
  reuses `.callout--warning` and the existing confirm-modal shape as-is)

## Verification
1. `node --check` every new/edited `.js` file.
2. Unit-style manual check: call `buildModFromVortexState` directly against the real (Vortex
   closed) state.v2 for `Snazzy Morthal AIO-147759-2-1-1751281253` and confirm the returned `mod`
   object's `choices.options` matches the raw `installerChoices` dump already captured this
   session.
3. Live end-to-end test (heads-up to the user first, Vortex closed): trigger the new route for
   this exact real mod, confirm the staging folder actually gets populated with
   `Snazzy Interiors - Morthal AIO.esp` and its siblings, then re-run Missing Masters' scan and
   confirm this master drops out of the problem list entirely.
4. Confirm the `run-state.js` guard: manually flip `run-state.js`'s session active (or just read
   the code path) and confirm `rebuildSingleMod()` throws the friendly "a run is already in
   progress" error rather than proceeding.

## Addendum 2026-07-27: built, verified live against the real Snazzy Morthal AIO case

Built exactly as planned, with two real deviations found only once actually tested against real
data:

1. **`installerChoices` is NOT one combined key.** state.v2 flattens it into two separate
   `###`-delimited leaf keys (`attributes###installerChoices###type` and
   `attributes###installerChoices###options`), same as every other nested field in this database —
   not a single JSON blob at `attributes###installerChoices`. The first live test correctly came
   back `SKIP_OPEN_FOMOD` (no choices found) instead of `REBUILD`, which caught this immediately;
   `build-mod-from-vortex-state.js` now reads both leaf keys separately.
2. Three action buttons (Rebuild This Mod + Create Dummy Master + Copy name) needed the
   `.mm-row__header` actions column widened again, from `300px` (the 2-button width fixed earlier
   the same day) to `480px`, to keep all three on one line and preserve the Copy-name-always-
   rightmost alignment already established.

**Live end-to-end result** (Vortex closed, real data, not a dry run): `POST /rebuild-mod` for
`Snazzy Morthal AIO-147759-2-1-1751281253` returned
`{"status":"REBUILT","fileCount":4,"restoredMissingFiles":["snazzy interiors - morthal aio.esp", "snazzy interiors - morthal falion's house.esp", "snazzy interiors - morthal thaumaturgist's hut.esp", "snazzy thonnir's house.esp"]}`.
Confirmed on disk: the staging folder, empty before, now has all 4 real files. Missing Masters'
own scan still correctly reports this master as `missing` afterward — expected, not a bug: this
only repairs Vortex's **staging** folder, exactly like every other Rebuild Collection run; Vortex
itself still needs to reopen and deploy (the existing documented "expect External Changes" note)
before the file actually lands in the Data folder Missing Masters checks. Also directly confirmed
the `run-state.js` guard throws `RUN_ACTIVE` before doing any work when a run is marked active.

Context correction mid-build: the plan's original framing said Create Dummy Master "can't really
fix" a hollow install. Corrected per the user: Create Dummy Master DOES fully resolve the crash —
the real gap is that the mod's own content stays invisible in-game with no error pointing at why,
which is the actual reason this feature exists.
