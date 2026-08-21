# Vortex "Deploy Mods" — real engine reference

**This is not this project's own design doc.** It documents a **third-party tool's** (Vortex's) own
internal behavior, straight from its source — the same docs-separation convention as
`reference-esp-vs-esl.md`/`reference-espfe.md`. Nothing here is rationale for code in this repo; see
`TECHNICAL.md` for that.

Sourced by reading `awesmdiver/Vortex` (fork of `Nexus-Mods/Vortex`) at
`F:\Claude Workspace\vortex-tools\vortex`, confirmed **0 commits behind** `upstream/master` on
2026-08-18 before reading. If this doc is consulted much later, re-run the freshness check in
`CLAUDE.md` before trusting it — Vortex's own deploy code can and does change between versions.

Written because this project reads/writes Vortex's own live state (Update Collection, Rules
Generator's Apply steps, a rebuild) and a wrong assumption about deploy's real steps/ordering is a
real risk. Director's own words: *"I would assume [updating plugins.txt] is part of Vortex's
deploy... Messing up deployment would be bad."* Short answer up front: **it isn't** — plugins.txt is
written by a separate extension reacting to deploy *finishing*, not by deploy itself. Details below.

## Entry points — what actually triggers a deploy

All of these funnel into the same `deploy-mods` event, which is bound to the pipeline below via a
2-second debouncer (`Debouncer`, `mod_management/index.ts:1407-1415`):

- **The "Deploy Mods" button** (`mod_management/views/ActivationButton.tsx:46-48,73`) — emits
  `deploy-mods` with `deployOptions.manual` presumably `true`.
- **The "Deployment necessary" notification's "Deploy" action** (`mod_management/index.ts:1312-1376`,
  `onNeedToDeploy`) — shown whenever mod state changes without a deploy following, unless
  `settings.automation.deploy` is on, in which case it deploys automatically.
- **The mod-state-change auto-deploy timer** (`onModsEnabled`, `mod_management/index.ts:1187-1211`) —
  debounces a deploy after mods are enabled/disabled, gated by the same automation setting.
- **The pre-launch hook** (`mod_management/preStartDeployHook.ts`) — offers to deploy before the game
  starts if a deploy is still pending.
- **Collection post-install** (`InstallManager.ts:3022-3034`) — a collection install triggers its own
  deploy once installation settles.

## The core pipeline (`genUpdateModDeployment`, `mod_management/index.ts:629-950`)

This is the actual body bound to `deploy-mods`. Steps run **in this order**, each awaited before the
next starts (all inside a single activation lock, `withActivationLock`, so two deploys can't
interleave):

1. **Guards** (`index.ts:655-722`) — refuses to run if a tool/game process is already running, if no
   profile is active, if the game is no longer discovered, or if no deployment method is selected/
   supported for the enabled mod types. These reject or notify *before* anything below runs.
2. **User gate** (`index.ts:730-736,752-753`) — for a non-manual (automatic) deploy only, calls
   `activator.userGate()` (or the game's own `deploymentGate()`), which is how e.g. the elevated
   symlink activator gets its UAC prompt out of an unattended trigger.
3. **Wait for active installs** (`index.ts:767-770`) — if the install manager is mid-install, waits
   for it to go idle so a half-installed mod is never deployed.
4. **Load the previous deployment manifest per mod type** (`index.ts:786-797`, `loadActivation` in
   `mod_management/util/activationStore.ts:400-448`) — reads `vortex.deployment.<type>.json` from
   the **game's mod-type target folder** (falls back to a `.msgpack` backup in the staging folder if
   the primary is missing/corrupt — `activationStore.ts:270-338`). This is Vortex's own record of
   what it deployed last time; sequential per type because activation order matters.
5. **`will-deploy` event** (`index.ts:799-800`, `api.emitAndAwait("will-deploy", ...)`) — a
   pre-deploy hook other extensions can await. The profile is re-read afterward
   (`index.ts:802-811`) so a handler that disables a mod here still affects this deploy.
6. **External-changes check** (`index.ts:813-822`, `dealWithExternalChanges` in
   `mod_management/util/externalChanges.ts:270-345`) — compares the last manifest against what's
   actually on disk in the game folder now. Files Vortex didn't touch itself (not from a collection
   install, not from `recentChanges`) are surfaced to the user in a dialog with a chosen action
   (keep/restore/drop/import); everything else is auto-resolved silently.
7. **Incompatibility check** (`index.ts:824-825`, `checkIncompatibilities`, `index.ts:390-452`) —
   scans enabled mods' `conflicts`-type rules; if any enabled mod conflicts with another enabled mod,
   the whole deploy is **rejected** (`ProcessCanceled`) after showing a notification — nothing below
   this step runs.
8. **Sort mods** (`index.ts:827-828`, `doSortMods` → `sortMods` in `mod_management/util/sort.ts`) —
   a **topological sort of enabled mods by Vortex's own `before`/`after` mod rules**, used to decide
   file-overwrite order during activation. This is *not* plugin load order and has nothing to do
   with LOOT — it only decides which mod's copy of a shared file wins. A cycle here throws
   `CycleError` and aborts the deploy (shown as the "Mod rules contain cycles" notification).
9. **Merge mods** (`index.ts:830-839`, `doMergeMods`, `index.ts:477-552`) — runs registered file
   mergers (e.g. INI/config mergers some game extensions register) against the sorted mod list,
   producing merged output under a `__merged[.typeId]` folder in staging. Files that went into a
   merge are tracked (`usedInMerge`) so they don't ALSO get deployed standalone.
10. **Validate deployment target** (`index.ts:845-848`, `validateDeploymentTarget`) — if any mod
    type's deploy path is unknown, asks whether to ignore that type or cancel.
11. **Deploy each mod type, sequentially** (`index.ts:849-860`, `deployAllModTypes` →
    `deployModType` → `deployMods` in `modActivation.ts:46-115`). Per mod type:
    - `activator.prepare(destinationPath, true, lastActivation, normalize)` — loads the previous
      deployment into an in-memory context (`LinkingDeployment.ts:120-152`); doesn't touch disk yet.
    - For every mod (already sorted low→high priority), and finally for the merged-output pseudo-mod:
      `activator.activate(modPath, mod.installationPath, subDir, blacklist)` — **walks the staged
      mod's files and records what *should* be deployed**, skipping blacklisted (merge-consumed)
      files (`LinkingDeployment.ts:357-403`). Later mods overwrite earlier ones in this in-memory map
      — still no disk writes yet.
    - `activator.finalize(gameId, destinationPath, installationPath, progressCB)` — **this is where
      files actually move** (`LinkingDeployment.ts:154-346`): diffs the old vs. new deployment maps,
      unlinks every removed/source-changed/content-changed file, then (re-)links every added/changed
      file into the game folder. The default Windows activator is `hardlink_activator`
      (priority 5, `hardlink_activator/index.ts:33-45`) — it hard-links staged mod files into the
      game's Data folder rather than copying them, so editing/removing a "deployed" file also
      affects the file in the mod's staging folder (same inode) unless the activator backs it up
      first (see `BACKUP_TAG`/`.vortex_backup` handling, `LinkingDeployment.ts:757-800`). Other
      available methods: `symlink_activator`, `symlink_activator_elevate` (needs UAC), `move_activator`,
      `null_activator` — same `IDeploymentMethod` contract, different link mechanism.
    - `doSaveActivation` → `saveActivation` (`activationStore.ts:450-515`) — **writes the new
      manifest**: `vortex.deployment.<type>.json` (or untagged for the default mod type) into the
      **target/deploy path** (the game's Data folder for that mod type), plus a `.msgpack` binary
      backup into the **staging path**. If the new activation list is empty, both files are removed
      instead of written.
    - After all types: redundant-mod notification only (mods that ended up contributing zero files)
      — not part of the deploy itself.
12. **`did-deploy` event** (`index.ts:863-872`, `api.emitAndAwait("did-deploy", profile.id,
    newDeployment, progressCB, deployOptions)`) — fired **after the activation lock is released**, so
    a second deploy could technically start while `did-deploy` handlers are still running. This is
    the extension point most other systems (including plugins.txt — see below) hook into.
13. **`mods-did-deploy` event** (`index.ts:874`) — a plain (non-awaited) event, fired right after.
14. **`bake-settings` event** (`index.ts:877`, `bakeSettings`, `index.ts:217-221`) —
    `api.emitAndAwait("bake-settings", profile.gameId, sortedModList, profile)`. Generic game-INI
    tweak application (mod-supplied INI edits merged into e.g. `Skyrim.ini`/`SkyrimPrefs.ini`),
    handled by the separate `ini_prep` extension (`ini_prep/index.ts:414+`) via its own
    `apply-settings` sub-event. Unrelated to plugins.txt/load order.
15. **Deployment-necessary flag cleared** (`index.ts:879`, `setDeploymentNecessary(game.id, false)`).
16. **Analytics only** (`index.ts:881-889`) — `emitModsDeployed`/`emitModListSnapshot`. Not
    functional state.

Errors at any point are caught centrally (`index.ts:890-942`) and mapped to specific notifications
(`UserCanceled` → silent, `CycleError` → "Mod rules contain cycles" with a fix action,
`ProcessCanceled`/`TemporaryError` → warning, everything else → generic failure notification). The
activation lock and the "deployment" activity flag are always released in a `finally`
(`index.ts:943-945`), regardless of outcome.

## plugins.txt / loadorder.txt are NOT written by core deploy

Confirmed real: nothing in the numbered pipeline above touches `plugins.txt` or `loadorder.txt`.
They're written by the **`gamebryo-plugin-management`** extension (a separate, game-family-specific
extension — this is the one that applies to Skyrim SE) reacting to the `did-deploy` event (step 12
above), not as part of deploy itself:

1. **`did-deploy` handler** (`extensions/gamebryo-plugin-management/src/index.ts:1930-1950`) — calls
   `onDidDeploy(api, profileId)` (`index.ts:1701-1760`), *unless* a collection install is active, in
   which case the equivalent work happens later via `collection-postprocess-complete`
   (`index.ts:1915-1927`) instead. `did-purge` triggers the same `onDidDeploy` (`index.ts:1952-1954`)
   — purging mods re-syncs the plugin list exactly like deploying does.
2. **`updatePluginList`** (`onDidDeploy` → `index.ts:270-274` → `updatePluginListImpl`,
   `index.ts:114-256`) — scans each enabled mod's **staging** folder for plugin files to learn which
   mod each plugin came from, then reads the **actual deployed files in the game's Data folder**
   (`fs.readdirAsync(modPath)`, `index.ts:214-218`) to mark each known plugin `deployed: true/false`.
   Dispatches `setPluginList(...)` to `session.plugins.pluginList`, then calls
   `pluginPersistor.setKnownPlugins(knownPlugins, blueprintIds)` — this **immediately** schedules a
   write of `loadorder.txt`/`plugins.txt` reflecting the current known load order, even before any
   fresh LOOT sort runs (`PluginPersistor.ts:129-137`).
3. **`plugin-details` refresh** (`onDidDeploy`, `index.ts:1735-1746`) — emits `plugin-details`,
   asking LOOT (`autosort.ts:523-697`, `pluginDetails`) to reload per-plugin metadata (masters,
   groups, tags). Bounded to 30s (`PLUGIN_DETAILS_TIMEOUT`, `index.ts:1692`) or cut short early by a
   profile/game switch — a genuine stall here does not block deploy from finishing indefinitely.
4. **`autosort-plugins` event** (`onDidDeploy`, `index.ts:1748-1757`, after a 500ms settle delay) —
   handled by `LootInterface.onSort` (`autosort.ts:173-261`). Runs LOOT's real sort
   (`loot.sortPluginsAsync`) **only if** this was a forced call (a collection install left a
   "pending plugin sort" marker, `hasPendingPluginSort`, `index.ts:1697-1699`) or the user's
   `settings.plugins.autoSort` is on — a normal deploy with auto-sort off updates the plugin list
   (step 2) but does **not** re-sort load order.
5. **LOOT sort → state → persistor write** (`autosort.ts:306-317`) — `loot.sortPluginsAsync(...)`
   returns the sorted plugin name list; `updatePluginOrder(sorted, false, autoEnable)` is dispatched
   into the `loadOrder` reducer. `PluginPersistor` is registered as that reducer's **persistor**
   (`registerPersistor("loadOrder", pluginPersistor)`, `index.ts:727`), so the diffed state change
   flows through `setItem`/`removeItem` calls, which schedule another debounced (200ms) `serialize()`
   → `doSerialize()` — this is the write that actually reflects the fresh LOOT order.
6. **The write itself** (`PluginPersistor.ts:292-374`, `doSerialize`) — writes `loadorder.txt`
   (informational list, all known plugins) then `plugins.txt` (the enabled subset, `*`-prefixed for
   Skyrim SE's format — see below) to `pluginPath(gameId)`.

## Where these files actually live — not the same folder as deployed mods

`extensions/gamebryo-plugin-management/src/util/gameSupport.ts:371-392`:

- **Deployed mod/plugin files** go to `gameDataPath(gameId)` = `<game install dir>\Data` — this is
  what the core deploy pipeline's `activator.finalize()` writes to.
- **`plugins.txt`/`loadorder.txt`** go to `pluginPath(gameId)` = `appDataPath(gameId)`, which
  resolves to `%LOCALAPPDATA%\<game>\` (e.g. `%LOCALAPPDATA%\Skyrim Special Edition\`) — **a
  different folder entirely**, resolved independent of deploy.

Skyrim SE's plugin format is `pluginTXTFormat: "fallout4"` (`gameSupport.ts:45-70`), **not**
`"original"` — despite the name, this is the newer format where `plugins.txt` lists every known
plugin (native and non-native) with `*` marking enabled ones, and load order is driven entirely by
line order in `plugins.txt`/`loadorder.txt`, never by file mtimes. (The mtime-touching branch in
`PluginPersistor.doSerialize` at `PluginPersistor.ts:335-348` is gated on
`mPluginFormat === "original"`, so it never runs for Skyrim SE regardless of the `autoSort` setting.)

## What this project should specifically care about

- **A deploy is not a single atomic write.** The manifest write (pipeline step 11) and the
  plugins.txt/loadorder.txt write (reaction steps 2 and 5 above) are separate operations, separated
  by at least a `did-deploy` event round-trip plus a 500ms settle delay plus LOOT's own sort time
  (autosort.ts comments cite full-load-order LOOT sorts observed at 20s+). A tool in this project
  that reads Vortex's live state **immediately** after triggering (or observing) a deploy could see
  the deployment manifest already updated but `plugins.txt` still reflecting the pre-deploy order —
  or, if a collection install is active, `plugins.txt` may not update at all until
  `collection-postprocess-complete` fires.
- **This project already reads `plugins.txt` read-only** (`lib/missing-masters-scan.js`, per its own
  header comment) for enabled/ghost status only — it explicitly does not need `loadorder.txt` since
  it doesn't need plugin *order*, only presence/activation. That existing choice is consistent with
  everything above: nothing in this project writes to either file, so there's no risk of this
  project's own writes racing Vortex's deploy-reaction chain — the risk direction is purely
  "reading a plugins.txt that a deploy triggered but hasn't finished rewriting yet," not the reverse.
- **The deployment manifest (`vortex.deployment.<type>.json`) is the one Vortex-authored file this
  project could plausibly want to read to confirm "did an actual deploy happen and finish."** It's
  written synchronously as part of the core pipeline (step 11), before `did-deploy` even fires, so
  its presence/timestamp is a safe leading indicator that the core linking pipeline completed — it
  says nothing about whether the plugins.txt reaction chain has also finished.
- **Mod enable/disable state itself is not something deploy reads fresh off disk** — it comes from
  Vortex's own Redux store / `state.v2` LevelDB, which this project already reads directly elsewhere.
  Deploy doesn't mutate that store; it only *acts on* whatever's already there at the moment it runs.

## Purge (the inverse operation, for completeness)

`activator.purge()` (`LinkingDeployment.ts:433-465`) removes all links previously recorded in the
manifest and runs the same directory-cleanup pass deploy's `finalize()` does. `did-purge` fires the
same `onDidDeploy` plugin-list-refresh reaction as `did-deploy`
(`gamebryo-plugin-management/src/index.ts:1952-1954`) — from this project's perspective, a purge and
a deploy carry the same plugins.txt-timing caveat above.

## Open questions

None left ambiguous by the source — every step above traces to a specific function and file. The one
genuine judgment call in scope was **where this doc lives**; placed as its own `docs/` file rather
than a TECHNICAL.md section per the instruction to keep third-party reference material clearly
separate from this project's own architecture rationale. Design side, feel free to rename/relocate.
