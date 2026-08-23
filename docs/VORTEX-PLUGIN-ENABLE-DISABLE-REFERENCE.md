# Vortex plugin enable/disable — real engine reference

**This is not this project's own design doc.** It documents a **third-party tool's** (Vortex's) own
internal behavior, straight from its source — the same docs-separation convention as
`VORTEX-DEPLOY-REFERENCE.md`/`VORTEX-PLUGIN-SORT-REFERENCE.md`, its two companions. Read those two
alongside this one: deploy covers what triggers a deploy and what it does; sort covers how libloot
orders the result; this one covers the **enabled/disabled flag on an individual plugin** — a
genuinely separate concern from either.

Sourced by reading `awesmdiver/Vortex` at `F:\Claude Workspace\vortex-tools\Vortex`, confirmed **27
commits behind** `upstream/master` on 2026-08-21 (last synced 2026-08-18). Re-run the freshness check
in `CLAUDE.md` before trusting this if consulted much later — Vortex's own plugin-management code can
and does change between versions.

Written because this project needed a real, reliable way to toggle **one specific plugin's** own
active/inactive state (PGPatcher's DynDoLOD.esp gate — see the "Case study" section at the bottom),
and the first attempt at that (disabling whatever whole *mod* a deployment manifest recorded as the
plugin's "current owner") turned out to be fundamentally unreliable. This doc is the reference for
*why*, and for the real mechanism that replaced it.

## Three genuinely different "enabled" concepts — don't conflate them

Confirmed via source, not assumed, because mixing these up is exactly what caused the original bug:

| Concept | Where it lives | What sets it | What reads it |
|---|---|---|---|
| **Mod's profile-level enabled flag** | `state.persistent.profiles[profileId].modState[modId].enabled` | The Mods table checkbox; `setModEnabled` action | Deploy pipeline decides which mods' files to link — genuinely requires a real deploy to take effect on disk |
| **Plugin's own load-order enabled flag** | `state.loadOrder[pluginId].enabled` | The Plugins table checkbox; `setPluginEnabled` action | `PluginPersistor` — writes plugins.txt automatically on ANY change to this state, ~200ms debounced, independent of any deploy (see below — this was gotten WRONG in an earlier version of this doc) |
| **plugins.txt's own `*` prefix** | An on-disk file, not Redux state at all | Written by `PluginPersistor`, auto-triggered by a `state.loadOrder` change | The actual game, and any external tool (PGPatcher, this project's own `isDynDoLODActive`) |

These can legitimately disagree with each other for a while — a mod can be "enabled" while the plugin
inside it is toggled off. But `state.loadOrder`'s own flag and plugins.txt are NOT on separate timers
the way the table above might suggest at a glance: the plugin-level flag reaches plugins.txt within
about 200ms on its own, no deploy needed — see "The flag flip DOES reach plugins.txt on its own" below
for the full, corrected story. The mod-level flag is the one that genuinely needs a real deploy.

## `state.loadOrder` — the real, live source of truth for a plugin's own flag

Registered by `gamebryo-plugin-management` itself: `context.registerReducer(['loadOrder'],
loadOrderReducer)` (`extensions/gamebryo-plugin-management/src/index.ts:361`). Shape per plugin,
confirmed from the reducer (`extensions/gamebryo-plugin-management/src/reducers/loadOrder.ts`):

```ts
state.loadOrder[pluginId] = { name: string, enabled: boolean, loadOrder: number }
```

Keyed by `toPluginId(fileName)` (`extensions/gamebryo-plugin-management/src/util/toPluginId.ts`):
lowercased, `path.basename`'d, with a trailing `.ghost` extension stripped (Vortex's own mechanism for
hiding a plugin file from the game without deleting it — unrelated to the enabled flag, just sharing
the same filename-normalization step). `"DynDOLOD.esp"` and `"dyndolod.esp"` and
`"mods/dyndolod.esp.ghost"` all resolve to the same key, `"dyndolod.esp"`.

**Confirmed empirically (2026-08-21, live against a real running Vortex):** a plugin whose owning
mod becomes fully undeployed doesn't linger in `state.loadOrder` with `enabled: false` — its entry
disappears from the object entirely (`found: false` reading it back). This matches
`setPluginOrder`/`updatePluginOrder`'s own reducer logic (`loadOrder.ts`), which rebuilds the object
fresh from whatever plugin list is currently being applied rather than patching in place.

## `setPluginEnabled` — the real action, and why it has no public write path

```ts
// extensions/gamebryo-plugin-management/src/actions/loadOrder.ts
export const setPluginEnabled = createAction(
  "SET_PLUGIN_ENABLED",
  (pluginName: string, enabled: boolean) => ({ pluginName, enabled }),
);
```

This is `redux-act`'s `createAction`, which uses its **description string as the actual dispatched
`type`**, unless that exact description is reused elsewhere in the app (then it gets a disambiguating
suffix). Confirmed via a full-repo grep of Vortex's own source: `"SET_PLUGIN_ENABLED"` appears
**exactly once** — so no collision, and the real dispatched type is the literal string
`"SET_PLUGIN_ENABLED"`.

**No confirmed, externally-reachable write path exists for this action** through any *normal*
extension API surface:
- `gamebryo-plugin-management` registers exactly two `context.registerAPI` calls
  (`extensions/gamebryo-plugin-management/src/index.ts:512,652`): `lootSortAsync` (re-sorts an
  already-known plugin list, no enable/disable) and `isBlueprintPlugin` (read-only, Starfield-only).
  Neither touches a plugin's enabled flag.
- The only externally-emittable event that touches it, `set-plugin-list`
  (`index.ts:2035-2043`), dispatches `updatePluginOrder(newPlugins, setEnabled, defaultEnable)` — a
  **destructive wholesale replace**: every plugin in the list gets `enabled: setEnabled`, every plugin
  NOT in the list gets the opposite. Passing it a single plugin name would silently disable every
  other plugin in the load order. Not usable for a scoped, single-plugin toggle.
- The real action creator (`setPluginEnabled` itself) lives inside `gamebryo-plugin-management`'s own
  private, bundled source — not exported through the public `vortex-api` package
  (`etc/vortex.api.md`), and not reachable from a genuinely separate extension's own module scope the
  way a same-codebase import would be.

The one place Vortex's own UI dispatches this action directly: `notifyMultiplePlugins`
(`index.ts:1632-1685`), the "this mod contains multiple plugins" notification shown after a mod with
more than one plugin gets (re-)enabled. Its "Enable all" button:

```ts
plugins.forEach((plugin) => api.store.dispatch(setPluginEnabled(plugin, true)));
```

This is the literal proof this doc's own confirmed mechanism (below) reuses.

## The confirmed mechanism: dispatch the plain object directly

Since the real dispatched `type` is just the description string, and Redux doesn't care how an
action object was constructed — only that its `type` matches a registered reducer — a companion
extension running **inside** Vortex's own process (this project's Vortex Collection Helper,
`F:\Claude Workspace\vortex-tools\vortex-collection-helper`) can dispatch the exact same shape
directly, with no import of `gamebryo-plugin-management`'s own private module at all:

```js
api.store.dispatch({ type: 'SET_PLUGIN_ENABLED', payload: { pluginName, enabled } });
```

**Why this is a safe thing to test, not a blind guess:** Redux's own design means an action whose
`type` matches no reducer is a true no-op — nothing touches state, nothing corrupts, if the hypothesis
were wrong. **Live-verified round-trip against a real running Vortex (2026-08-21)**, not just reasoned
through: disabled `DynDOLOD.esp` (`before.enabled:true` → `after.enabled:false`, `changed:true`),
re-enabled it (`changed:true` back to `true`), both confirmed **instantly visible in Vortex's own
Plugins tab checkbox**, with no deploy in between. A `state.v2` + `plugins.txt`/`loadorder.txt` backup
was taken (Vortex closed) before this was ever tried against the director's real, live install.

Exposed as `GET /plugins/:pluginName` (read `state.loadOrder[id]`) and `POST
/plugins/:pluginName/set-enabled` (the dispatch above, with a before/after readback in the same
response) in the Helper extension (`vortex-collection-helper/index.js`, v0.11.0), wrapped by
`vortex-collection-tools`' own `lib/vortex-helper-client.js` as `getPluginLoadOrder(pluginName)` and
`setPluginEnabled(pluginName, enable)`.

## The flag flip DOES reach plugins.txt on its own — no deploy needed (corrected 2026-08-21)

**An earlier version of this doc claimed the opposite** — that a real full deploy was still required
for the plugin flag to reach plugins.txt. That was wrong, and the live test that seemed to "confirm"
it was confounded: at the time of that test, DynDoLOD.esp's own FILE had already been undeployed by
earlier, unrelated mod-level testing (see the case study below) — and `PluginPersistor.doSerialize()`
only ever includes a plugin in its output if it's present in `mKnownPlugins` (files actually deployed
to Data), regardless of what `state.loadOrder` says about its enabled flag. With the file gone, of
course nothing showed up — that had nothing to do with deploy vs. no-deploy.

**The real mechanism, confirmed straight from source**
(`extensions/gamebryo-plugin-management/src/util/PluginPersistor.ts`): this is a genuine `IPersistor`
implementation bound to the `loadOrder` Redux state. Its `setItem` (called by Vortex's own persistence
middleware on every `state.loadOrder` write) calls `serialize()`, which schedules `doSerialize()` via a
**200ms `setTimeout` debounce** — no deploy anywhere in that chain. `doSerialize()` writes both
`loadorder.txt` and `plugins.txt` fresh from current state every time it fires.

**Live re-verified, both directions, properly isolated this time** (director's own real Vortex,
2026-08-21): with DynDOLOD.esp's owning mod left untouched and enabled the whole time (so its file
never leaves Data) —
1. Baseline: `*DynDOLOD.esp` in plugins.txt, file present.
2. `POST /plugins/DynDOLOD.esp/set-enabled {enabled:false}` → 2 second wait → plugins.txt now reads
   `DynDOLOD.esp` (unstarred, i.e. inactive) — file **still present** on disk, confirmed via
   `Test-Path`.
3. `POST .../set-enabled {enabled:true}` → 2 second wait → back to `*DynDOLOD.esp`.

So: as long as a caller only flips the PLUGIN's own flag and never touches the owning MOD's
deployment, plugins.txt reflects the change within about 200ms–2s (network/IPC overhead dominates the
real debounce) with **no deploy at all**. This is a completely different case from the mod-level
`setModEnabled` flag (previous table row), which genuinely does need a real deploy to relink/unlink
files on disk — that part of `VORTEX-DEPLOY-REFERENCE.md`'s own finding stands unchanged.

## Known, unresolved limitation: a full deploy is still uncancellable (mod-level disables only)

Checked specifically because this was the whole reason an earlier automated flow (see "Case study"
below) got reverted. `activator.cancel` is the only "cancel"-named thing anywhere in the deploy
pipeline (`src/renderer/src/extensions/mod_management/index.ts:1290-1291`), and it's internal
cleanup-on-error inside a single-mod deploy's own `catch` block — never an externally reachable "stop
this in-flight deploy" call. **This no longer matters for the plugin-level DynDoLOD.esp gate at all**
(see the correction above — there's no deploy in that path anymore to be stuck in). It's still real and
relevant for anything that disables a whole MOD and needs a full deploy to actually unlink its files
(this project's own separate "PGPatcher's previous output" gate, see the case study) — that path
remains genuinely uncancellable once started, and any UI built around it should say so plainly.

## Case study: PGPatcher's DynDoLOD.esp gate

The real motivating problem, in brief (see `web/pgpatcher-routes.js`'s own code comments and this
project's `prompts/handoff-latest.md` history for the full blow-by-blow):

1. **First attempt** (commits `652f018`/`5b3b15a`/`90cf4b9`): resolved dyndolod.esp's "owning mod" via
   `vortex.deployment.json` (which records only the CURRENT winner of a file-name conflict), then
   disabled that whole mod + full-deployed. **Reverted** (`5670cca`) after live testing found two real
   problems: (a) the recorded "owner" can be, and was, wrong the moment more than one installed mod
   ships a file named `dyndolod.esp` — disabling the wrong mod does nothing, since a different mod
   still deploys the real file; (b) disabling a whole mod takes every OTHER file it provides offline
   too, not just the one plugin — real collateral risk.
2. **Root-cause testing** (2026-08-21): found 4 separate installed mods on the director's own real
   install that each physically contain a `dyndolod.esp` file. Disabling all 4 simultaneously (the
   "obvious" fix) STILL failed the live check — `state.loadOrder`'s own `enabled` flag never moved,
   even after a clean full deploy plus a 20-second settle wait, ruling out timing as an excuse.
3. **The actual fix**: stop trying to control the PLUGIN by manipulating MODS at all. Target
   `state.loadOrder['dyndolod.esp']` directly via the mechanism this doc documents. No mod resolution,
   no risk of picking the wrong one, no collateral impact on any mod's other files.
4. One more real gap closed along the way, unrelated to Vortex's own internals: the gate's original
   assumption ("DynDoLOD's own generated LOD content might contaminate PGPatcher's scan if its mod
   stays enabled") turned out to be moot — the director had already confirmed separately that
   PGPatcher's own settings exclude DynDoLOD's generated meshes/textures regardless of deploy state,
   so the ONLY real gate is "is `dyndolod.esp` itself active" — nothing about the mod's other files.
5. **The deploy step itself turned out to be unnecessary too** (same day, caught by the director's own
   direct challenge: "I can just enable/disable the plugin in Vortex and PGPatcher knows, without a
   deploy — are you sure it uses plugins.txt for this?"). The implementation initially still ran a
   full `deployAllMods()` after the plugin flag flip, on the (wrong) assumption that plugins.txt only
   updates at deploy time — see "The flag flip DOES reach plugins.txt on its own" above for the
   correction and the properly-isolated re-test that proved it. Removed the deploy call entirely from
   the DynDoLOD path; replaced with a short poll confirming the write landed.

Current implementation: `web/pgpatcher-routes.js`'s `disableDyndolodForRequest`/`reenableDyndolod`
(calls `helperClient.setPluginEnabled('DynDOLOD.esp', ...)`, then polls `isDynDoLODActive` briefly to
confirm the write landed — no deploy call at all, per the correction above), wired into `/load` and
`/build`'s real interactive confirm-modal flow. Because there's no deploy in this path, `/build`'s own
re-enable is immediate on a successful build too, not gated behind a confirm the way the output-mod
gate below still needs to be.

**A second, related gate followed immediately after** (same session, same day): the real GUI also
refuses to run at all if a leftover `ParallaxGen_Diff.json` marker from a PRIOR PGPatcher build is
still deployed in the real Data folder (`PGPatcher/src/main.cpp:449-456`, "PGPatcher meshes exist in
your data directory, please delete before re-running") — confirmed this check runs unconditionally at
the very start of the GUI's own `mainRunnerPrep`, before any file scanning, and confirmed the real GUI
has no separate "just check conflicts" mode at all (`mainRunner` always chains `mainRunnerPrep`
straight into `mainRunnerPatch` — the conflicts-vs-patch split is entirely this project's own
pgtools-CLI-only concept). `pgtools.exe` again has no equivalent pre-flight check, but this one is a
genuine correctness risk for this project's own `/build` too, not only GUI-policy mirroring: if
PGPatcher's own previous output mod stays enabled, its conflict scan would see its own prior output as
just another live mod. Unlike DynDoLOD.esp, resolving which mod to disable here is unambiguous — it's
this project's own configured `settings.outputDir`, matched by exact folder-basename equality against
the live mod list — so this reuses the ordinary mod-level `setModEnabled` (the RIGHT tool this time,
since there's no individual plugin to target, just a marker file) rather than the plugin-level
mechanism above. Same confirm-modal/disable-deploy-reenable-deploy shape, generalized to track and
re-enable whichever of the two independent gates a given `/load` or `/build` actually triggered.
