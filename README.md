# Vortex Collection Tools

A local toolkit for managing Vortex-installed Skyrim SE collections, with a shared web UI
(`node web/server.js`, binds `127.0.0.1` only) covering two related but distinct jobs:

- **Rebuild Collection** — reinstalls/repairs an already-installed collection's staging folder by
  extracting mod archives directly and replaying the FOMOD installer choices recorded in
  `collection.json`, bypassing Vortex's own slow archive-extraction pipeline. Use this when a
  staging folder has drifted, been corrupted, or you just want a much faster full reinstall than
  Vortex's own "Resume" step.
- **Update Collection** — preserves which mods you've marked Ignored/Disabled across a Vortex-driven
  collection *update* (Vortex otherwise forgets these on every update). This tool never extracts
  archives itself — it only manipulates Vortex's own state database (`state.v2`) before and after
  you click Update/Resume in Vortex's own UI, so Vortex's installer skips the mods it should.

This project is the merger of two previously-separate tools (`Collection-Extractor` and
`vortex-collection-sync`, both under `F:\Claude Projects\Vortex\`) into one shared codebase and web
UI, kept as an extensible home for future Vortex tooling — both old folders/repos remain untouched
as historical/rollback reference.

## Quick start

```
npm install
npm run web
```

Opens `http://127.0.0.1:4321` with a top-level nav for both tool areas. Terminal CLI access is also
available (see below) for either flow without the web UI.

## Rebuild Collection

```
node rebuild-collection.js [--collection-mod-id <id>] [--staging <dir>] [--downloads <dir>]
  [--state <path>] [--backup-root <dir>] [--dry-run] [--resume <log-file>] [--yes]
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

## Update Collection

```
node sync-menu.js      # interactive terminal menu (recommended)
node sync-cli.js <command> [options]   # flag-based CLI (list-collections, backup, apply-ignores,
                                        # apply-disables, compare, list-backups, ...)
```

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

## Future work

Eventually replacing Vortex's own slow "Resume" install step with this project's fast direct
extraction, for the Update Collection flow too — so collection updates become as fast as rebuilds
already are. Real, unsolved blockers: Rebuild Collection's engine only ever touches the staging
filesystem, with zero awareness of Vortex's state database; Vortex itself must still register any
new/changed staging folder as a tracked mod entry (state-DB record, correct per-profile enabled
state, load-order integration) — today only Vortex's own "Resume" step does this, and nothing in
this project creates a brand-new mod entry from scratch. This needs its own research spike (reading
Vortex's real installer source, the way `vortex-source-refs.json`/`check-vortex-source-drift.js`
already do for the extraction side) before any design is attempted.

## Project structure

```
Vortex-Collection-Tools/
├── rebuild-collection.js, extract-mod.js, compare-output.js, smoke-test-collection.js,
│   snapshot-collection-staging.js, download-collection.js, check-vortex-source-drift.js
├── sync-cli.js, sync-menu.js
├── vortex-source-refs.json
├── lib/
│   ├── collection-parser.js, archive-locator.js, fomod-parser.js, choice-resolver.js,
│   │   mod-root.js, simple-installer.js, sevenzip.js       — Rebuild Collection's extraction engine
│   ├── rebuild-mod.js, collection-runner.js                — Rebuild Collection orchestration
│   ├── state-query-worker.js, state-write-worker.js         — isolated child-process DB access
│   ├── sync-runner.js                                       — Update Collection orchestration
│   ├── hash-manifest.js, diff-manifests.js, diff-manifests-ci.js, esp-flag-diff.js — comparison utils
│   ├── vortex-drift-check.js, nexus-collection-download.js
│   └── vortex-sync/                                          — Update Collection's engine
│       ├── lib.js, report.js, win-dialog.js
│       ├── config.json (gitignored), config.example.json
│       ├── backups/ (gitignored), state-backups/ (gitignored)
├── web/
│   ├── server.js, rebuild-routes.js, sync-routes.js, run-state.js, sync-run-state.js, sse-session.js
│   └── public/ (index.html, app.js, sync-app.js, shell.js, styles.css)
├── logs/ (gitignored)      — Rebuild Collection run logs
└── reports/ (gitignored)   — Update Collection HTML reports
```
