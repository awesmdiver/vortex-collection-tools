# Vortex plugin sorting — real engine reference

**This is not this project's own design doc** — same convention as its companion,
`VORTEX-DEPLOY-REFERENCE.md` (commit `fb45190`): pure third-party-engine reference material, kept
separate from this project's own architecture rationale in `TECHNICAL.md`. That doc covers **what
triggers** plugin sorting (the `did-deploy` reaction chain); this one covers **how the sort itself
works**. Read them together — the deploy doc's "post-deploy reactions" section is a compressed
version of what's expanded here.

Sourced by reading `awesmdiver/Vortex` at `F:\Claude Workspace\vortex-tools\vortex`, confirmed **0
commits behind** `upstream/master` before reading. Re-run the freshness check in `CLAUDE.md` before
trusting this if consulted much later.

**Headline finding:** Vortex does not implement plugin sorting itself. It calls the real **libloot**
library — the same LOOT engine the wider modding community already uses standalone — via a native
Node binding (`import { LootAsync, ... } from "loot"`, `autosort.ts:8`). Vortex's own code only
prepares libloot's inputs (which plugins, which lists) and applies its output (the sorted order) to
its own state; the actual sort algorithm is opaque native code Vortex doesn't re-implement or
control. Confirmed straight from Vortex's own UI copy: the "Sort Now" button's tooltip literally
reads *"Sort your load order using LOOT"* (`views/PluginList.tsx:481`).

## What triggers a sort

- **After every deploy/purge**, conditionally — see `VORTEX-DEPLOY-REFERENCE.md`'s "plugins.txt /
  loadorder.txt are NOT written by core deploy" section. In short: `onDidDeploy` emits
  `autosort-plugins`, which only actually re-sorts if a collection install left a pending-sort
  marker (forced) or `settings.plugins.autoSort` is on (`gamebryo-plugin-management/src/index.ts:1748-1757`).
- **The "Sort Now" toolbar button** on the Plugins page (`views/PluginList.tsx:471-493`) — always
  forces a sort (`emit("autosort-plugins", true, ...)`) regardless of the auto-sort setting.
- **A built-in self-test** (`testTriggerSort`, `index.ts:1245-1252`) that force-sorts 2s after every
  deploy, independent of the main reaction chain — this appears to be a diagnostic/test-manager check
  rather than a second production sort path.
- Every sort, forced or automatic, records a `"plugins-sorted"` entry in the plugin history log
  (`util/PluginHistory.ts:228-237`) — no functional effect, audit trail only.

## What data feeds the sort

`LootInterface` (`autosort.ts:82-1318`) hands libloot four inputs:

1. **The masterlist** (`masterlist.yaml`) — the real, community-maintained LOOT masterlist,
   downloaded from `https://raw.githubusercontent.com/loot/<gameId>/<pinned revision>/masterlist.yaml`
   (`util/masterlist.ts:5-11`, revision currently pinned to `v0.29`), cached at
   `<Vortex userData>/<gameId>/masterlist/masterlist.yaml`. Refreshed on LOOT init and periodically
   (throttled to once per 30 minutes, `isMasterlistOutdated`, `masterlist.ts:26-43`). This is the
   same masterlist LOOT's standalone app and every other masterlist-aware tool uses — Vortex doesn't
   maintain its own copy of these rules.
2. **The prelude** (`prelude.yaml`) — shared conditions/logic the masterlist references, from
   `github.com/loot/prelude` at the same pinned revision, cached at
   `<Vortex userData>/loot_prelude/prelude.yaml`.
3. **The userlist** (`userlist.yaml`) — entirely local, **not** downloaded. Holds the user's (or a
   collection author's) own overrides: custom LOOT group assignments and custom load-after/requires
   rules, edited via Vortex's own Userlist/Group editor dialogs (`registerDialog("userlist-editor"
   /"group-editor")`, `index.ts:700-701`) and persisted by `UserlistPersistor`
   (`util/UserlistPersistor.ts`) to `<Vortex userData>/<gameId>/userlist.yaml`. Reloaded whenever its
   mtime changes (`readLists`/`loadLists`, `autosort.ts:699-809`, gated on
   `this.mUserlistTime` staleness) — not on every sort.
4. **The plugin corpus itself** — every plugin libloot considers must be `deployed` in Vortex's own
   `session.plugins.pluginList` and not a `.ghost`-suffixed file (`isValid`, `doSort`,
   `autosort.ts:213-227`), pre-filtered to files that actually exist on disk
   (`autosort.ts:233-238`). libloot reads each plugin's real header data itself (masters, flags,
   records) when they're loaded into it — Vortex's JS layer never parses plugin content for sorting
   purposes beyond the pre-filters below.

## The real sort call (`LootInterface.doSort`, `autosort.ts:285-459`)

1. **Header pre-filter, not libloot's job** (`autosort.ts:292-301`, `findInvalidPlugins`,
   `util/findInvalidPlugins.ts`) — libloot's `loadPlugins`/`sortPlugins` abort entirely on the
   *first* invalid plugin, so retrying once per bad plugin would cost one full load+sort per
   failure. Vortex instead parses every candidate plugin's header itself first (`ESPFile.open`,
   16-way concurrent, `findInvalidPlugins.ts:8,22-47`) and excludes anything that throws `EINVAL`
   (corrupt/incomplete header — the same condition libloot itself reports as "not a valid plugin")
   before ever calling libloot.
2. **`readLists`** (`autosort.ts:755-809`) — reloads masterlist/userlist/prelude into libloot only if
   the userlist's mtime changed since the last load.
3. **The actual call**: `loot.sortPluginsAsync(pluginNames)` (`autosort.ts:307`) — hands libloot the
   filtered plugin name list; libloot returns the sorted order (or throws). This single call *is*
   the sort — everything else in this doc is either preparing its input or handling its output.
4. **Apply the result**: `updatePluginOrder(sorted, false, autoEnable)` dispatched
   (`autosort.ts:317`) into the `loadOrder` reducer
   (`reducers/loadOrder.ts:36-65`) — `setEnabled=false` means this never changes which plugins are
   enabled, only their order; `defaultEnable` (`settings.plugins.autoEnable`, default `false`,
   `reducers/settings.ts:20-21`) only applies to a plugin the reducer has no prior enabled-state for.
   Plugins libloot didn't return (e.g. excluded as invalid) keep their existing order, appended after
   the sorted set (`reducers/loadOrder.ts:53-62`). This state write is what feeds
   `PluginPersistor`'s `loadorder.txt`/`plugins.txt` write — see `VORTEX-DEPLOY-REFERENCE.md`.
5. **An empty result with plugins still queued** means LOOT closed mid-sort — treated as an
   interruption, not a real sort: the durable "pending plugin sort" marker
   (`actions.clearPendingPluginSort`) is only cleared on a genuine non-empty result or when there was
   nothing to sort (`autosort.ts:321-333`), so an interrupted sort retries on the next profile
   activation.

libloot's actual ranking logic (masters-before-non-masters, LOOT group partial ordering, explicit
masterlist/userlist load-after and requirement rules, then asset/record-overlap heuristics, then a
final deterministic tie-break) lives entirely inside the native library and isn't visible in
Vortex's own source — the best documentation of *what kinds* of relationships it reasons about is
the `EdgeType` enum Vortex itself defines purely to label cycle-error edges for its own UI
(`autosort.ts:27-40`): `hardcoded`, `master`/`masterFlag`, `masterlistGroup`/`userGroup`,
`masterlistLoadAfter`/`userlistLoadAfter`, `masterlistRequirement`/`userlistRequirement`,
`assetOverlap`, `recordOverlap`, `tieBreak`. For libloot's own algorithm semantics, its own
documentation (not part of this repo) is the source of truth — this reference only covers how Vortex
drives it.

## Cycle detection & the "Cyclic interaction" error

When `sortPluginsAsync` throws with a message starting `"Cyclic interaction"`
(`autosort.ts:351-352`, `reportCycle`), libloot has found a real dependency cycle in the graph built
from the four inputs above (an edge list of `{name, typeOfEdgeToNextVertex}` pairs on `err.cycle`).
Vortex:

1. **Renders the cycle** (`renderCycle`/`describeEdge`, `autosort.ts:958-1090`) as a chain of
   `plugin@group --(reason)--> plugin@group`, calling `loot.getGroupsPathAsync(...)` back into
   libloot to explain *why* two groups are connected when the edge is itself a group relationship.
2. **Proposes fixes** (`getSolutions`, `autosort.ts:1092-1177`) — for each cycle edge that's a
   *custom* (userlist) rule or group assignment, offers a checkbox to remove that specific rule/
   assignment; for a custom group-to-group path, offers to reset every user rule along that path.
   Only user-authored data is ever offered for removal — masterlist/hardcoded/asset/record-overlap
   edges can't be fixed this way since they aren't something Vortex wrote.
3. **Applies selected fixes** (`applyFix`, `autosort.ts:1179-1217`) then **re-runs the sort**
   (`autosort.ts:1294-1307`) after a settle delay for the userlist rewrite to land on disk.
4. Shown as notification id **`"loot-cycle-warning"`**, message *"Plugins not sorted because of
   cyclic rules"* (`autosort.ts:1249-1313`).

## What happens to plugins libloot can't place

- **Invalid/corrupt plugins**: caught pre-emptively by the header pre-filter above; if one still
  slips past ESPFile's own (more lenient) parse and libloot rejects it anyway
  (`err.name === "PluginNotLoaded"`, or a message matched by `invalidPluginsFromError`,
  `util/invalidPlugins.ts`), it's reported once via a `"loot-skipped-invalid-plugins"` notification
  (`reportSkippedInvalidPlugins`, `autosort.ts:51-80`) rather than retried plugin-by-plugin.
- **A plugin assigned to a LOOT group that no longer exists** — typically a collection that assigned
  a masterlist group later renamed/removed — libloot throws `'The group "..." does not exist'`. Vortex
  auto-recovers: `missingGroupFixes` (`util/groups.ts`) finds every dangling userlist reference to a
  group not present in either list, dispatches actions to reset those plugins to their default group,
  invalidates the cached userlist mtime, waits 500ms for the persistor to flush, and **retries the
  sort automatically** (`autosort.ts:365-381`) — no user action needed unless nothing was resettable.
- **A condition-evaluation failure referencing a game `.exe`** (`"Failed to evaluate condition"`,
  `autosort.ts:390-443`) is specifically called out in Vortex's own error copy as "usually caused by
  pirated copies of the game" — Vortex gathers the referenced file's existence/size/MD5/version to
  attach to the error report.
- **LOOT process death / "already closed"** (`err.name === "RemoteDied"`, or a message of exactly
  `"already closed"`) is treated as non-fatal — a torn-down LOOT instance (e.g. from a game/profile
  switch mid-sort) just means the result doesn't matter anymore, not a reportable failure.
- Anything else falls through to a generic `"loot-failed"` error notification.

## Cross-reference to Cycle Helper — these are two different, unrelated cycle mechanisms

**Correction to the framing this doc was requested under**: the working assumption was that this
plugin-sort cycle mechanism is *"almost certainly the exact mechanism Cycle Helper's own scan is
reverse-engineering."* Having read both real source trees, **that's not the case** — they're
separate graphs with separate causes, and TECHNICAL.md's own Cycle Helper section already confirms
which one Cycle Helper actually targets:

- **What Cycle Helper addresses** (`TECHNICAL.md`'s "Cycle Helper" section, `lib/cycle-detector.js`):
  Vortex's **mod-rule sort** — `mod_management/util/sort.ts`'s `before`/`after` **mod** rules,
  producing the file-overwrite priority order used during deploy (deploy pipeline step 8 in
  `VORTEX-DEPLOY-REFERENCE.md`). Its cycle detection is plain `graphlib`
  (`alg.topsort`/`alg.findCycles`) running entirely in Vortex's own JS — TECHNICAL.md is explicit
  that `cycle-detector.js`'s `findSCCs` "is what Vortex's own `alg.findCycles` does under the hood
  too." A cycle here throws `CycleError`, shown as notification id **`"mod-cycle-warning"`**, message
  *"Mod rules contain cycles"* (`mod_management/index.ts:904-917`).
- **What this doc covers**: Vortex's **plugin-sort** — libloot's own dependency graph over
  `.esp`/`.esm`/`.esl` files, built from masterlist/userlist/prelude data plus libloot's internal
  asset/record-overlap analysis, entirely opaque native code. A cycle here is libloot's own
  `"Cyclic interaction"` error, shown as notification id **`"loot-cycle-warning"`**, message
  *"Plugins not sorted because of cyclic rules"* (`autosort.ts:1249-1313`), with its own separate
  in-app fix-and-resort flow (`reportCycle`) already built into Vortex itself.

Different graph (mods vs. plugins), different node/edge data (Vortex's own mod rules vs. libloot's
masterlist/userlist/native heuristics), different detection code (JS `graphlib` vs. native libloot),
different error/notification, different existing fix UI. **Cycle Helper has no equivalent for LOOT
plugin-sort cycles today** — if a real `"loot-cycle-warning"` is ever seen in practice and judged
worth building a tool for, it would need its own separate scan approach (there's no local graph to
mirror the way `sort.ts` was mirrored, since the real ranking logic lives inside libloot itself,
not in readable Vortex source) rather than an extension of the existing Cycle Helper. Flagging this
as a finding, not a decision — no action taken.

## Open questions

None left ambiguous by the source for the mechanisms this doc covers — every claim traces to a
specific function and file. The one genuine unknown is libloot's own internal ranking algorithm
(how it weighs group order vs. explicit rules vs. overlap heuristics against each other) — that's
implemented in the native `loot` library, outside this repo, and outside what reading Vortex's own
source can answer; libloot's own upstream documentation would be the source for that, not this repo.
