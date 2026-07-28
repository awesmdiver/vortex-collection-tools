# Rules Generator — Phase 2: Applying Rules to Vortex's Live Database

## Context

Rules Generator's read/review UI (the "Ready to copy" / "Needs your input" / "Nothing to do"
lists, expandable cards, per-row rule-type overrides, conflict-file indicators) is now solid and
confirmed by the user ("the input UI is grounded now"). The next step is the feature the whole tool
exists for: actually writing the reviewed/approved rules onto the new collection's mods in Vortex's
live `state.v2` database, so the user no longer has to hand-resolve the same conflicts a second
time in Vortex's own "Manage rules" dialog.

This is the first live-database WRITE this feature has ever performed (everything built so far —
including this session's `computeConflictingFiles` — has been read-only). Per this project's own
standing rule (confirmed with the user earlier this session, and already documented in
`TECHNICAL.md`'s "Write-safety requirement" note), any such write must reuse the existing
`withLiveStateDb`/`backupLiveState` safety wrapper already proven by Update Collection's own writes
(`writeIgnoredFlags`/`writeDisabledFlags`), must be tested against a **copied** `state.v2` first,
and must NOT be run against the user's real live Vortex database without their separate, explicit
confirmation — this plan does not include that confirmation; it will be requested at that point.

Two scope questions were confirmed with the user before this plan was written:
1. **One "Apply to Vortex" button for the whole list**, not a per-mod Apply button (matches Update
   Collection's own single Preview→Apply-per-step pattern already established in this app).
2. **Both "Ready to copy" AND any resolved "Needs your input" anomaly** get applied in the same
   pass. An anomaly still left at "???" (unresolved) is simply skipped — no error, no blocking —
   the user can come back later (rerun this tool, or resolve it directly in Vortex).

## Vortex's real mechanism — verified against actual GitHub source, not inferred

Per the user's explicit instruction to be "100% in-sync" with Vortex, this was checked against
Vortex's real source (`Nexus-Mods/Vortex`, via `gh search code` + raw file fetches), not just
inferred from previously-observed data:

- **The actual rule-write action** (`extensions/mod-dependency-manager/src/views/ConflictEditor.tsx`,
  `buildRuleActions()`) dispatches `vortexActions.addModRule(gameId, modId, { reference: { id:
  otherModId, versionMatch }, type })` — a **bare `{id, versionMatch}` reference, no `idHint`**.
  `versionMatch` is `'*'` for the default "any version" case (`translateModVersion` returns `'*'`
  when the rule's version-match mode is `"any"`, which is the default).
- **The reducer** (`src/renderer/src/extensions/mod_management/reducers/mods.ts`,
  `addModRule` handler): before/after rules are treated as **one mutually-exclusive group**
  (`conflicts` is its own singleton group) — if an existing rule in the *same group* already
  references the *same* target (`referenceEqual`), the new rule **replaces** it in place
  (`setSafe` at that index); otherwise it's appended (`pushSafe`). This is the exact
  create-or-replace semantics a new write should mirror, not a blind append.
- **`referenceEqual`** (`.../util/testModReference.ts`): for an "id-only" reference (no
  fileMD5/repo/etc., just `id`/`versionMatch`/`archiveId` — our exact shape), it compares by
  `lhs.id === rhs.id` directly.
- **`idHint` is NOT part of the write** — it's added later, by a *separate* action/reducer
  (`cacheModReference`, same file) that Vortex runs on its own schedule to cache a resolved
  reference. This is why every real rule read from the live DB earlier this session (verified via
  a direct, read-only `withStateDb` peek at "Faultier's PBR Landscapes 2k/4k"'s real rules) has
  `idHint` present even though the write path never constructs it — confirms the empirical
  observation without needing to guess whether `idHint` is required. It is not; omitting it matches
  Vortex's own action creator exactly, and Vortex's own caching pass will backfill it in its own
  time (or not — it's a cache, not load-bearing).

**Conclusion — the exact reference shape to write:** `{ id: targetModKey, versionMatch: '*' }`.
No `idHint`, no `fileMD5`/`fileExpression` construction needed, since the target is always an
already-installed mod in the same new collection (this project's own established scope for Rules
Generator).

## Design

### Write function — new, in `lib/rules-generator.js`

New `applyRules(db, modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides)`:

1. Re-run `analyzeCollections(modIndex, oldCollectionKey, newCollectionKey)` **fresh**, inside the
   caller's already-open `db`/`modIndex` — never trust a client-held/stale computed list for
   anything that writes to disk (same principle `rebuild-routes.js`'s own header comment already
   states: "a client-held plan is never trusted for anything that touches the filesystem").
2. For each `mapping` item: for each row in `rulesToConsider` (indexed by `ruleIdx`, same
   deterministic order the UI already renders), the final type is
   `ruleOverrides[\`${newModKey}::${ruleIdx}\`]` if present, else the row's own computed type. Skip
   the row if the final type is `''` (the "???" override — explicitly "no rule").
3. For each `anomalies` item where `anomalyOverrides[modKey]` is a real candidate index (not `''`
   or missing): resolve `oldModKey = item.candidates[Number(idx)].targetKey`, then compute that
   anomaly's own applicable rules via the **same** old-mod-rule-fetch → remap → dedupe logic
   already used for a normal mapping entry. This requires lifting the current inline per-mapping
   computation in `analyzeCollections` (the block building `ruleSetSource`/`copyable`/
   `rulesToConsider`/`oldModRules`) out into a shared helper, e.g. `computeMappingDetails(modIndex,
   newModKey, oldModKey, newMemberKeySet, oldModKeysInMapping)`, called identically from both the
   normal mapping loop and this now-resolved-anomaly path — so there is exactly one implementation
   of "given a new mod and its real old-mod link, compute the rules to copy," not two.
4. Collect all `(newModKey, type, targetModKey)` triples to write across both sources.
5. **Idempotency / mirror Vortex's own semantics exactly:** before adding a triple, check
   `getEffectiveRules(modIndex, newModKey)` (already exists, already does the full bidirectional
   effective-rule check) for an existing effective rule of the same type (or the *opposite* of
   before/after, since Vortex groups them) referencing the same target. If already effectively
   resolved either direction, skip — nothing to write, matches Vortex's own "???" meaning exactly.
6. For each mod that ends up with 1+ rules to write: read `persistent###mods###skyrimse###<newModKey>###rules`
   **fresh** right before writing (mirrors `writeIgnoredFlags`'s own pattern exactly — don't rely on
   the pre-built `modIndex`'s possibly-stale copy), validate its shape with the existing
   `assertRulesShapeKnown`/`validateRuleShape` (`lib/vortex-sync/lib.js`; export it if not already
   exported), then for each new rule: check for an existing entry in the *same before/after group*
   referencing the same target (mirrors `referenceEqual` + the reducer's group logic above) —
   replace it in place if found, else append `{ type, reference: { id: targetModKey, versionMatch:
   '*' } }`. Write back via `db.put` only if the mod's rules array actually changed (no no-op
   writes).
7. Return a summary: `{ mods: [{newModKey, name, rulesWritten}], totalRulesWritten, totalModsChanged,
   skippedAlreadyResolved, skippedUnresolvedAnomalies, backupDir }` (backupDir comes from
   `withLiveStateDb`'s own return value, same as `apply-ignores-write`/`apply-disables-write`
   already do).

### Isolated worker — mirrors `state-write-worker.js`'s existing pattern exactly

`lib/rules-generator-worker.js` gets two new modes (dry-run + real write, same pairing as
Update Collection's `apply-ignores-preview`/`apply-ignores-write`):
- `'apply-preview'`: read-only, via `syncLib.withStateDb` (safe copy-then-read). Runs the same
  `applyRules` logic in a dry-run mode (no `db.put` calls) purely to return an accurate count for
  the confirmation dialog — callable any time, no Vortex-closed requirement.
- `'apply-write'`: the real write, via `syncLib.withLiveStateDb` (auto-backup, refuses if Vortex is
  running, same as every other live write in this project).

`lib/rules-generator-runner.js` gets two new exported functions, `applyPreview(...)` and
`apply(...)`, mirroring `analyze()`'s existing shape (spawn the worker, JSON in/out).

### Route — `web/rules-generator-routes.js`

Two new routes, both gated by the existing `vortexRunningGate` helper already used for
`/workshop-collections` and `/analyze`:
- `POST /apply-preview` — dry-run count.
- `POST /apply` — the real write.

Both take `{ oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides }` in the request
body — the frontend sends its current `rgRuleOverrides`/`rgAnomalyOverrides` maps directly (already
built and populated by the existing review UI), and the backend re-derives everything else fresh.

### Frontend — `web/public/rules-generator-app.js` + `index.html`

- New **"Apply to Vortex"** button (primary-styled, since it's the main call-to-action once review
  is done) placed in the results area, above/near the section headers — a page-level action since
  it spans both "Ready to copy" and resolved "Needs your input" items, not scoped to one section
  (unlike "Expand all", which IS section-scoped).
- Click → `apply-preview` first (always re-check right before showing the confirm dialog, so the
  count is accurate even if some time passed since the last Analyze) → a confirmation modal using
  the **serious register** (`TECHNICAL-FRIENDLY-VOICE-GUIDELINES.md`, per the two-register skill
  split established this session) — wording mirrors the skill's own confirmed serious-register
  example structure: *"This writes {N} rule(s) across {M} mod(s) directly to Vortex's live database.
  A full backup is taken first."* No "feel free to"/exclamation-point casualness here — this is
  exactly the kind of consequential action the serious register exists for.
- On confirm → `apply` (the real write) → success summary (which mods/rules were written, where
  the backup landed) → automatically re-run Analyze so the page reflects the new, post-write state
  (previously-"Ready to copy" mods that just got applied will naturally drop out of the list once
  Vortex's own rules already resolve them).
- Vortex-running/critical-error handling reuses the existing `rgHandleError`/
  `showVortexRunningModal` machinery already wired up for `/analyze`.

## Files touched

- `lib/rules-generator.js` — refactor inline mapping computation into `computeMappingDetails()`,
  add `applyRules()`.
- `lib/vortex-sync/lib.js` — export `assertRulesShapeKnown`/`validateRuleShape` if not already
  exported (check first; likely already only used internally by `writeIgnoredFlags`).
- `lib/rules-generator-worker.js` — add `apply-preview`/`apply-write` modes.
- `lib/rules-generator-runner.js` — add `applyPreview()`/`apply()`.
- `web/rules-generator-routes.js` — add `POST /apply-preview`, `POST /apply`.
- `web/public/rules-generator-app.js` + `index.html` — Apply button, confirm modal, success summary.
- `TECHNICAL.md` — document this whole mechanism (the Vortex-source-verified write shape above,
  the design decisions, the write-safety reuse) in the existing "Rules Generator" section, same
  level of detail as everything already documented there. This was explicitly requested by the user
  and could not be done while in plan-mode (read-only) — first real step after approval.
- `docs/plans/2026-07-26-rules-generator-apply-to-vortex.md` (this project's own plans folder) —
  archive this plan once the feature is built and tested, per this project's own standing
  plan-archiving convention.

## Verification / testing protocol (mandatory — do not skip or reorder)

1. **Unit-level sanity check first**: a small throwaway script (deleted after use, same convention
   as this session's own rule-shape research script) exercising `applyRules`'s pure logic
   (mapping/anomaly resolution, idempotency skip, replace-vs-append) against an in-memory
   `modIndex` fixture — no DB at all. Catches logic bugs cheaply before touching any real files.
2. **Copy-based integration test (required before any live test)**: copy the user's real `state.v2`
   into a scratch directory (a true filesystem copy, never the live one), point a temporary
   `stateDir` override at that copy, and run the full `apply-preview` → `apply` path against it end
   to end — this exercises `withLiveStateDb`'s own backup-and-refuse-if-running logic for real,
   without any risk to the actual live database. Confirm: correct rules appear in the copy's DB
   afterward (read back and diff against expectations), backup directory was created, no rule
   duplication on a second run (idempotency holds).
3. **Do NOT run against the real, live `state.v2`** as part of this implementation pass. Once the
   copy-based test above passes and the code is reviewed, explicitly ask the user for confirmation
   — separate from routine read-only testing — before ever pointing this at their actual live
   Vortex database, per their own standing instruction earlier this session ("when ready to test on
   live db let me know for confirmation within vortex").
4. Standard live UI check (Vortex-closed, fresh browser tab, syntax-check every edited file) for
   everything up through the confirm-dialog/preview flow, same as every other UI change this
   session — this part IS safe to test live (it only calls `apply-preview`, never `apply`) up
   until the final "click Confirm" step, which stays gated behind step 3's explicit go-ahead.

## Addendum (2026-07-26) — outcome

Fully implemented and verified through step 4 above. Notable things found along the way:

- **A real indexing bug caught before it ever reached the UI**: the frontend numbers a mod's
  `ruleIdx` overrides from the *filtered* `resolvable` array (excluding `status === 'unresolved'`
  rows), but the first draft of `computeRulesToApply` indexed the raw unfiltered array. Would have
  silently applied an override to the wrong rule whenever a mod had an unresolved row mixed in
  before a resolvable one. Fixed by filtering identically on both sides; caught by a dedicated test
  before any live testing.
- Unit-level fixture tests (step 1) all passed, including a direct assertion that the written
  reference shape is exactly `{ id, versionMatch: '*' }` with no `idHint` — matching Vortex's real
  action creator precisely.
- Copy-based integration test (step 2) ran the full real pipeline (worker → `withStateDb`/
  `withLiveStateDb` → `applyRules`) against a true filesystem copy of the user's real `state.v2`:
  preview and real write agreed exactly (53 rules across 7 mods on this run), the rules verifiably
  landed on re-read, and a second pass wrote 0 new rules (idempotency confirmed). Test backup
  folders and the scratch copy were cleaned up afterward; only pre-existing (2026-07-25) real
  backups remain in `state-backups/`.
- Live UI check (step 4) confirmed the "Apply to Vortex" button, the apply-preview-driven confirm
  dialog (serious register, accurate live count), and Cancel all work correctly against the real
  live database in read-only preview mode. The actual write (clicking Confirm against the real live
  `state.v2`) was deliberately NOT performed, per step 3 — that requires the user's own separate,
  explicit go-ahead, requested after this plan's work was reported back.

### Addendum 2 (2026-07-26) — real performance bug found during the user's own live test

The user tested Vortex-open (correctly gated, got the "Vortex is running" popup), closed Vortex,
retried "Apply to Vortex" — and "Checking what would change…" hung noticeably. Root cause:
`applyRules`' idempotency check called `getEffectiveRules(modIndex, newModKey)` — a full reverse
scan over the user's ENTIRE Vortex mod library, not just the two collections being compared — once
per RULE instead of once per MOD. A mod needing 23 rules did 23 full-library scans instead of 1;
this scales with the size of the user's whole Vortex history, which is large. Fixed by grouping
`toApply` by `newModKey` first and computing `getEffectiveRules` once per mod. Verified against a
synthetic 8,000-mod library fixture: same correct result, single-digit milliseconds. Documented in
TECHNICAL.md as a standing lesson for any future code touching `getEffectiveRules`. Server restarted
with the fix; not yet re-confirmed live by the user as of this addendum.
