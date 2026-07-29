# Build prompt — The Forge (Merge Plugins tool) · v1.0 Phase 1

Paste into `claude` running in this repo. **This is a two-part prompt: do PART A (a feasibility
spike) and STOP for sign-off before writing any merge engine or UI in PART B.** The merge engine is
the one genuinely uncertain piece in this whole app, so we prove it works headless before building
anything around it.

## What this tool is

A new tool, **Merge Plugins** (internal/codename **The Forge**), that bundles several Skyrim plugins
(`.esp` / `.esl`) from one or more installed collections into a **single** plugin, and flags the
result as an **ESPFE** (`.esp` + ESL flag) automatically when it qualifies — freeing load-order slots
without the user ever opening xEdit.

**Read these first (they define the rules the engine must honor):**
- `docs/reference-esp-vs-esl.md` and `docs/reference-espfe.md` — the .esp / .esl / ESPFE model and
  the exact conditions under which a merge can be ESL-flagged.
- `DESIGN.md` — the look/voice/component rules this tool must follow (especially "Selectable lists —
  the standard select-and-act pattern", "Tool page breadcrumb", "Tool page layout — group controls
  into cards", "Core components", "Color & severity system").
- `design/vortex-merge-tool-mockup.html` — **the approved UI.** Open it in a browser. The 5-step
  flow, the running "chosen for merge" cart, the review table with per-plugin status, and the
  ESL-flag callout are all there. Build to this.

**Scope guardrails for this whole prompt:**
- **Strings are hardcoded**, exactly like every existing tool today. Do **not** build or wire any
  theming here — the brand-theming framework is Phase 2 and will sweep this tool in afterward.
- **One owner per file:** you own the code and `TECHNICAL.md`. Leave `DESIGN.md` and everything under
  `design/` alone.
- Load the **`plain-language-writer`** skill for every user-facing string. This tool touches plugin
  files and warns about masters, so several messages are **serious register** (see below).

---

## PART A — Feasibility spike (report back, do NOT proceed to Part B without sign-off)

Answer these in a short written findings report, backed by a **minimal headless proof**, then stop.
Do not build the tool UI yet.

1. **Engine choice.** Compare the realistic options for actually performing the merge from inside
   this Node.js/Express app, running **headless** (no Electron, no GUI):
   - **`xelib`** — the native library extracted from xEdit (the same engine xEdit itself uses),
     callable over its C API / FFI from Node. This is what zEdit drives.
   - **`zmerge`** — the plugin-merging module from **zEdit / `zedit-revised`** (JS built on top of
     `xelib`). It already *is* a plugin merger; the question is whether its merge logic can be
     lifted/driven outside the Electron app.
   - **Shelling out** to a bundled xEdit (or `xEditLib`/standalone) with a merge script as a
     fallback.
   For each: can it (a) load plugins from arbitrary folders, (b) merge them into one plugin
   headlessly, (c) **set the ESL flag** on the output, and (d) be bundled/redistributed with this
   app? Recommend one, with the fallback.
2. **ESPFE qualification.** Per `docs/reference-espfe.md`: after a merge, decide programmatically
   whether the result can be ESL-flagged — record count within the light-plugin limit (≤ 4,096 new
   records), FormIDs that compact cleanly into the light range, and the cell/worldspace-override
   caution. Confirm whether the chosen engine reports these (record counts, FormID ranges, new-vs-
   override records, cell/worldspace edits) or whether we compute it ourselves and set the flag via
   the engine. Describe how we'll set the flag and how we'll detect "does NOT qualify → leave it a
   full `.esp` and tell the user why."
3. **Licensing.** xEdit / `xelib` carry their own license terms. State what they are and whether
   bundling/redistributing the engine (or shelling to it) inside this GitHub-released app is
   permitted, and any attribution we must ship. **Flag this clearly** — it may constrain the engine
   choice.
4. **Platform / packaging.** This app already bundles Node + 7-Zip and is Windows-x64 only. Confirm
   the engine (likely a native Windows DLL) fits that packaging, and roughly what it adds to the zip.
5. **Minimal proof.** Merge **two** small test plugins headlessly with the recommended engine,
   produce one output plugin, and confirm (i) it loads/parses back cleanly and (ii) the ESL flag can
   be set and read back. A tiny script + its output is enough — this de-risks Part B.

**Deliverable for Part A:** the findings + recommendation + the proof, reported back. **Then stop for
a go/no-go on the engine.** Note anything in `TECHNICAL.md` under a new "Merge engine" section.

---

## PART B — Build the tool (only after Part A sign-off)

Build **Merge Plugins** as a new top-level tool area, matching `design/vortex-merge-tool-mockup.html`
and the DESIGN.md sections above. Reuse existing tokens/components — no new colors.

### v1.0 scope — decided from the Part A spike (read before building)

The spike proved the engine (`xelib` via `XEditLib.dll`) on **new-record** merges and signed off on
that path. **v1.0's Forge ships that path only.** Build accordingly:

- **Merge scope = new-record plugins** — standalone mods whose content is genuinely new records
  (`!isOverride(rec) && !isInjected(rec)`). This is the proven `asNew=true` path.
- **Build the engine scaffolding to ANTICIPATE override merges, but do NOT build or verify the
  override-merge logic now.** Do-now (cheap, shared): the child-process merge worker, the output /
  ESL-flag / qualification pipeline, and the per-record loop that already classifies each record
  (new vs override vs injected — needed for the qualification count regardless). Defer to v1.1 (the
  expensive, unproven part): the `asNew=false` preserve-FormID copy, reference rebuilding, and the
  FormID-spread qualification math. Structure the code so v1.1 adds that as a contained branch, not a
  rewrite.
- **Be HONEST about override / patch plugins — never silently drop their overrides.** In the Review
  step, any selected plugin that contains override records (a compatibility patch, etc.) is flagged
  clearly — e.g. **"⚠️ Contains overrides — not merged in this version"** — and left out of the merge
  (or the user removes it). Merging only part of a patch's records would produce a broken result;
  don't. This is what the mockup's "Overrides a pick" status becomes for v1.0 — an honest,
  merge-excluding signal, not a soft warning. Run this copy through `plain-language-writer`.
- Where the mockup and the step descriptions below show richer override-aware review, treat that
  override *merging* behavior as v1.1 and substitute the honest "contains overrides → not merged yet"
  handling. Everything else (collections → search → cart → review → merge → done, the ESL verdict for
  new-record merges, output to a chosen folder) is v1.0 exactly as described.

**Resolved from the spike (don't re-litigate):**
- **Light-plugin limit: hardcode 4,096**; document "requires Skyrim SE 1.6.1130+." (Can become
  game-aware later with per-game theming.)
- **Run each merge in its own short-lived child process** — `xelib` can't re-init in-process; mirror
  `lib/state-query-worker.js`'s isolated-worker pattern.
- **Verify `xelib.displayName()` against a real, fully-populated mod early** (it returned empty on
  the synthetic test data) before trusting the Review step's mod-name column.
- **Licensing / release-gate:** before any release that bundles `XEditLib.dll`, add a
  `THIRD-PARTY-NOTICES.md` crediting xEdit/TES5Edit + `matortheeternal/xedit-lib` (MPL-1.1 / MPL-2.0,
  real repos) and the `xeditlib` wrapper (MIT). Not needed to build, but it blocks the v1.0 zip.

### Wiring & chrome
- New tool area `merge` in `shell.js`'s `TOOL_AREAS`. Add a **Home card** for it under **Main tools**
  (it's the headline v1.0 feature): icon 🧬, name **Merge Plugins**, one-line pitch condensed from the
  hero body. Pinnable like every other card.
- Breadcrumb eyebrow on **every** view of this tool: `Home › Merge Plugins` (Home links to the Home
  area), per the breadcrumb rules — no legacy "← Back to <tool>" buttons; the stepper's own "← Back"
  handles in-flow steps.
- Tool-hero (reuse the pattern): `🧬 Merge Many Plugins Into One` + the approved body from the mockup
  ("Skyrim's plugin slots fill up fast…"). Run the copy through `plain-language-writer`.

### The 5-step flow (stepper: Collections → Find files → Review → Merge → Done)

1. **Choose collections.** Multi-select list of the user's installed collections (name + mod count),
   using the **core** select-and-act pattern: Select all / Clear, live "N of M selected". Next →.
2. **Find & select plugins.** Search the plugins inside the chosen collections' installed mods (in
   the staging folder). Extension-include filter chips (`.esp` / `.esl` / `.esm`, plus add-ext).
   Results in a **paginated** select-and-act table (checkbox, File, Mod, Collection, Type badge —
   `.esl` badge accent-tinted). Critically:
   - A persistent **"chosen for merge" cart** that **accumulates across every search** — running a
     new search never clears earlier picks. Show the running count in a cart bar ("🧬 N plugins
     chosen — building up across every search").
   - **"View chosen (N) ↗"** opens the cart in its **own OS window** (same mechanism as the Rules
     Generator reference/rule view), grouped by collection, each removable, **updating live** as the
     user adds more. In the browser mockup this is faked as a slide-in drawer; in the app it's a real
     separate window like the existing reference view.
   - Already-chosen plugins render **checked** even when they surface in a different search. Selection
     tracked by plugin identity, not rendered rows.
3. **Review your merge.** Table of every chosen plugin with a per-item **status** computed by the
   engine, shown as a quiet pill and filterable via the report-style badges:
   - `Needs a master` (⚠️) — depends on a master that must be present (e.g. `Update.esm`).
   - `Overrides a pick` (⚠️) — overlaps another selected plugin.
   - `Clean` — no notes.
   These are **heads-ups, not blockers** — say so. Two callouts above the table:
   - **warn:** "N plugins depend on a master" — fine to merge; make sure those masters are installed;
     if one's missing after install, **Missing Masters** will catch it.
   - **info (the ESL verdict):** when it qualifies — explain plainly (≈ record count under the 4,096
     light limit, FormIDs compact fine, no risky cell/worldspace overrides → keeps its `.esp` name but
     is ESL-flagged, an ESPFE, costing 0 slots). When it does **not** qualify — say it stays a full
     `.esp` and give the specific reason (over the record limit, cell/worldspace edits, etc.).
   - Per-row remove; "← Add more files" (back to step 2) and the primary **"Merge N plugins →"**.
   - **Output** block: name the merged plugin (default e.g. `Merged Patch`) + a live Result preview
     (`Merged Patch.esp · ESL-flagged ✓` or `· full .esp` when it doesn't qualify). Include a
     **Browse…** folder picker for the output location.
4. **Merging…** Progress bar with live "Copying records from <plugin>… (k of N)". **Vortex must stay
   closed while this runs** — serious-register guard, blocking if Vortex is open (it reads staging).
5. **Done.** Stat grid (plugins merged / mods / collections / records); an info callout confirming
   the ESL-flagged output and the **exact folder it was saved to**; a "Next: turn it on in Vortex"
   callout (install the merged plugin as a mod, enable it, disable the originals it replaces — same
   flow as a Dummy Master / DynDOLOD output); buttons "Open output folder" and "Merge another →".

### Hard rules
- **Output always goes to a user-chosen folder, NEVER the Skyrim `Data` folder.** The tool does not
  install anything into the game or write to Vortex's database — the user installs the result
  themselves. Make that clear in the Done step.
- **Vortex must be closed** for the merge (reading staging + plugin files). Guard it, serious
  register, consistent with the app's existing "close Vortex first" blockers (🛑, matching the exact
  established phrasing — flag any inconsistency rather than inventing a new one).
- Honor the ESPFE qualification rules from `docs/reference-espfe.md` exactly; when in doubt, leave it
  a full `.esp` and explain, rather than flagging something that shouldn't be.

### Verify & document
- `npm run web`: walk all five steps — pick collections, search several times and watch the cart
  accumulate, open the live "chosen" window, review with the status filters, run a merge to a chosen
  folder, confirm the output is produced and (when it qualifies) ESL-flagged.
- Confirm light mode and dark mode both look right.
- Document the engine, the merge/flag pipeline, the qualification logic, and the tool wiring in
  `TECHNICAL.md` (this is engineer-facing — keep it out of user copy).

---

*After this ships and is verified, Phase 2 (the brand-theming framework) sweeps this tool's strings
into the theme layer, and Phase 3 back-ports the "chosen" live-window + normalized selection pattern
into the older tools.*
