'use strict';
// Bulk Collection Editor (Utilities tool) -- add mods to, or remove mods from, several of the
// user's own editable collections at once. Vortex's own native "Add Mods to Collection" dialog
// (collectionCreate.ts's addCollectionAction) only ever writes to ONE collection per confirm, and
// has no bulk-remove equivalent at all; this tool builds a running, cross-search pick list (Add) or
// a merged cross-collection list (Remove), then writes it into as many of the user's own editable
// collections as they check, in one batch.
//
// Vortex Bridge-only, no offline fallback -- both reads (the live mod list, which collections are editable
// right now) and the write (a real addModRule/removeModRule dispatch) only exist through Vortex's
// own live state, same reasoning Safe Collection Removal's own Apply and Duplicate Version Cleanup
// already document for their own Vortex Bridge-only routes.
//
// Semantics verified against real Vortex source (vortex-tools\vortex, checked
// out and current as of 2026-09-15 -- re-verified for this task per this project's own CLAUDE.md,
// same commit range as the original 2026-09-10 add-only build):
//   - MOD_TYPE (constants.ts) === 'collection'. An "editable collection" is any mod where
//     `type === 'collection' && attributes.editable === true` -- the live set Vortex's own sidebar
//     shows, NOT this app's own separate "installed vs workshop" staging-folder split
//     (lib/missing-files-scan.js's listPickableCollections is a different concept entirely: this
//     app's own collection-authoring folders, not Vortex's live editable-collection flag).
//   - `alreadyIncluded(rules, modId)` === `rules.find(rule => rule.reference.id === modId) !== undefined`.
//     Mirrored here as isAlreadyInCollection -- the exact same duplicate guard real Vortex applies
//     before ever writing a rule, so re-running Add on an overlapping pick is a safe no-op for mods
//     already present, never a duplicate rule.
//   - The real ADD write is `actions.addModRule(gameId, collectionId, { type: 'requires', reference:
//     { id: modId } })` -- a freshly-built minimal rule, since there's nothing to match yet.
//   - The real REMOVE write is `actions.removeModRule(gameId, collectionId, rule)`
//     (mods/actions.ts's removeModRule; CollectionPageEdit/index.tsx's own onRemoveRule always passes
//     `entry.rule`, the EXISTING rule object straight from that collection's own live `rules` array --
//     never a freshly-constructed one). This matters: the reducer's own `ruleEqual()` (reducers/
//     mods.ts) compares `{type, reference}` after stripping only `archiveId`/`description`/
//     `instructions` from `reference` -- any OTHER extra reference field (e.g. `versionMatch`) that
//     the real rule carries but a freshly-built minimal `{id: modId}` reference lacks would make the
//     comparison fail and the remove silently no-op. removeModsFromCollections below therefore always
//     removes the VERBATIM rule object read from that collection's own live rules, never a
//     reconstructed one -- mirroring real Vortex exactly, not just its common case.
//   - Both directions go through the SAME `lib/vortex-bridge-client.js` `applyRuleChangesBatch`,
//     whose own header comment already documents `remove`/`add` as `{type, reference} | undefined`
//     -- no Bridge-extension change needed for Remove; the batch endpoint already accepts a `remove`
//     alongside (or instead of) an `add` per item.

const bridgeClient = require('./vortex-bridge-client');

function displayName(attrs) {
    return (attrs && (attrs.customFileName || attrs.modName)) || '';
}

function isAlreadyInCollection(rules, modId) {
    return Array.isArray(rules) && rules.some((rule) => rule && rule.reference && rule.reference.id === modId);
}

// Every installed mod whose display name matches `query` (case-insensitive substring), excluding
// collections themselves -- same `mods[modId].type !== MOD_TYPE` filter real Vortex's own
// addCollectionAction applies to what's offered as addable. A blank/whitespace-only query returns no
// results rather than dumping the whole install -- the approved mockup only ever shows a real typed
// search. Returns null only when the Vortex Bridge's own /mods read itself failed (never for "no matches").
//
// `collectionEntries` (2026-09-15, "Bulk Collection Editor: add and remove mods"): the collections
// already picked in Step 1, `[{modId, name}, ...]` -- when given, each result also carries
// `alreadyIn: [{modId, name, version}]`, the subset of those picked collections that already have
// this mod (the mockup's own "Already in" column). Computed from the SAME `getAllMods()` snapshot
// already fetched for the search itself -- no second Vortex Bridge round trip.
async function searchMods(query, collectionEntries) {
    const data = await bridgeClient.getAllMods();
    if (!data) return null;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const collections = Array.isArray(collectionEntries) ? collectionEntries : [];
    const results = [];
    for (const [modId, mod] of Object.entries(data.mods)) {
        if (!mod || mod.type === 'collection') continue;
        const name = displayName(mod.attributes) || modId;
        if (!name.toLowerCase().includes(q)) continue;
        const alreadyIn = [];
        for (const { modId: collectionId, name: collectionName } of collections) {
            const collMod = data.mods[collectionId];
            if (!collMod || !isAlreadyInCollection(collMod.rules, modId)) continue;
            const collVersion = (collMod.attributes && collMod.attributes.version) || '0';
            alreadyIn.push({ modId: collectionId, name: collectionName, version: collVersion });
        }
        results.push({ modId, name, version: (mod.attributes && mod.attributes.version) || '', alreadyIn });
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

// Every collection Vortex's own UI would let the user edit right now, with a real live member count
// (unique rule.reference.id across the collection's own rules -- the same set real Vortex's own
// `collections()` helper builds for its addCollectionCondition/removeCollectionCondition checks),
// plus (2026-09-15) its own authoring `version` and published `revisionNumber` -- straight off
// `attributes.version`/`attributes.revisionNumber`, per DESIGN.md's "Writing a collection's version
// and revision" wording rules. `version` defaults to `'0'` when unset (a collection that's never had
// its working version bumped); `revisionNumber` is `null` when nothing's ever been published --
// callers render that as "not published yet", never "Rev 0". null only on a genuine Vortex Bridge read
// failure.
async function getEditableCollections() {
    const data = await bridgeClient.getAllMods();
    if (!data) return null;
    const results = [];
    for (const [modId, mod] of Object.entries(data.mods)) {
        if (!mod || mod.type !== 'collection' || !mod.attributes || mod.attributes.editable !== true) continue;
        const name = displayName(mod.attributes) || modId;
        const memberIds = new Set((mod.rules || []).map((r) => r && r.reference && r.reference.id).filter(Boolean));
        results.push({
            modId, name, modCount: memberIds.size,
            version: mod.attributes.version || '0',
            revisionNumber: mod.attributes.revisionNumber || null,
        });
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

// The real ADD write. For every checked collection, reads that collection's OWN current live rules
// fresh right before writing (never trusts a caller-side snapshot for the mutation itself) and skips
// any mod already present -- a genuine no-op for an overlapping re-run, not a duplicate rule. Every
// still-needed (collectionId, modId) pair is sent as ONE addModRule dispatch inside a single batch
// call, mirroring real Vortex's own batchDispatch (one Redux action for the whole set, not one HTTP
// round trip per mod).
//
// `collectionEntries`: [{modId, name}, ...] -- the checked collections (name is for display in the
// returned result only, never used for matching).
//
// Returns { collections: [{modId, name, added, alreadyPresent, failed, error?}], totalAdded }. A
// collection whose OWN fresh-rules read fails is reported with `error` set and added/alreadyPresent/
// failed all 0 -- nothing is queued for it, so a Vortex Bridge hiccup on one collection never blocks the
// others (each collection's batch items are independent of every other collection's).
async function addModsToCollections(modIds, collectionEntries) {
    const items = []; // {modId: collectionId, add: {...}} -- one per still-needed (collection, mod) pair
    const plan = []; // parallel to items -- the shared result-entry object each item's outcome tallies into
    const collectionResults = [];

    for (const { modId: collectionId, name: collectionName } of collectionEntries) {
        const currentRules = await bridgeClient.getLiveRulesForMod(collectionId);
        if (currentRules === null) {
            collectionResults.push({ modId: collectionId, name: collectionName, added: 0, alreadyPresent: 0, failed: 0, error: "Couldn't read this collection's current live rules." });
            continue;
        }
        const toAdd = modIds.filter((modId) => !isAlreadyInCollection(currentRules, modId));
        const entry = { modId: collectionId, name: collectionName, added: 0, alreadyPresent: modIds.length - toAdd.length, failed: 0 };
        collectionResults.push(entry);
        for (const modId of toAdd) {
            items.push({ modId: collectionId, add: { type: 'requires', reference: { id: modId } } });
            plan.push(entry);
        }
    }

    if (items.length > 0) {
        const results = await bridgeClient.applyRuleChangesBatch(items);
        if (results === null) {
            // Couldn't reach the Vortex Bridge for the write itself -- every queued item counts as failed,
            // never silently dropped.
            for (const entry of plan) entry.failed += 1;
        } else {
            results.forEach((result, i) => {
                if (result && result.ok) plan[i].added += 1;
                else plan[i].failed += 1;
            });
        }
    }

    const totalAdded = collectionResults.reduce((sum, c) => sum + c.added, 0);
    return { collections: collectionResults, totalAdded };
}

// (2026-09-15) Every mod in the picked collections, merged into one list, no duplicates -- the
// Remove step's own "which mods can I take out" picker. One `getAllMods()` snapshot serves both the
// membership data (each picked collection's own live `rules`) and the display name/version lookup
// for every member -- no per-collection round trip.
//
// A rule whose own `reference.id` no longer resolves to an installed mod (the mod was uninstalled
// after being added to the collection, or the collection references a mod from a machine/profile
// this one never had) still gets a row -- removal is a pure Vortex rule change, independent of
// whether the referenced mod is actually present right now, so there's no reason to hide it from the
// list a user might want to clean up. Its `name` falls back to the raw modId itself (the ONLY
// identifying data a rule carries -- real Vortex's own addModRule only ever writes `{id: modId}`,
// confirmed via collectionCreate.ts, no logicalFileName/version hint anywhere on the reference), and
// its `version` is `''`.
//
// Returns `[{modId, name, version, inCollections: [{modId, name, version}]}, ...]` sorted by name, or
// null on a genuine Vortex Bridge read failure. `inCollections[].version` is that COLLECTION's own working
// version (for the mockup's own per-pill `v3` badge) -- not the member mod's version.
async function getModsInCollections(collectionEntries) {
    const data = await bridgeClient.getAllMods();
    if (!data) return null;
    const byModId = new Map();
    for (const { modId: collectionId, name: collectionName } of collectionEntries) {
        const collMod = data.mods[collectionId];
        if (!collMod) continue; // collection vanished from live state since being picked -- nothing to list for it
        const collVersion = (collMod.attributes && collMod.attributes.version) || '0';
        for (const rule of collMod.rules || []) {
            const memberId = rule && rule.reference && rule.reference.id;
            if (!memberId) continue;
            if (!byModId.has(memberId)) {
                const memberMod = data.mods[memberId];
                const name = memberMod ? (displayName(memberMod.attributes) || memberId) : memberId;
                const version = memberMod ? ((memberMod.attributes && memberMod.attributes.version) || '') : '';
                byModId.set(memberId, { modId: memberId, name, version, inCollections: [] });
            }
            byModId.get(memberId).inCollections.push({ modId: collectionId, name: collectionName, version: collVersion });
        }
    }
    const results = [...byModId.values()];
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

// (2026-09-15) The real REMOVE write -- the mirror of addModsToCollections above, but matching real
// Vortex's own removal contract exactly (see this file's own header comment): each item's `remove`
// is the VERBATIM existing rule object, never a freshly-built one.
//
// Reads ONE `getAllMods()` snapshot immediately before writing -- rather than addModsToCollections'
// own N separate getLiveRulesForMod calls -- because this needs the SAME freshness guarantee for
// every picked collection's rules AND, additionally, every OTHER editable collection's rules (to
// report "still in another of your collections" on the Done screen). A single atomic snapshot taken
// right before the write is at least as fresh as N sequential per-collection reads (which could
// observe a mid-flight external change between them) and is cheaper.
//
// `modIds`: the mods checked for removal -- removed from EVERY picked collection that actually has
// them (the merged list's own "selecting a mod removes it from every picked collection it's in").
// `collectionEntries`: [{modId, name}, ...] -- the picked collections.
//
// Returns { collections: [{modId, name, removed, alreadyGone, failed, error?, removedMods:
// [{modId, name, version, stillIn: [{modId, name}]}]}], totalRemoved }. `stillIn` lists every OTHER
// editable collection (picked or not) still holding that mod AFTER this whole batch -- a mod removed
// from two picked collections in the same run is correctly excluded from each other's `stillIn`, even
// though the pre-write snapshot still shows it present in both (computed from the write's own actual
// per-item outcomes, not re-derived by re-reading Vortex a second time).
async function removeModsFromCollections(modIds, collectionEntries) {
    const data = await bridgeClient.getAllMods();
    if (!data) return null;

    const editableCollections = Object.entries(data.mods)
        .filter(([, m]) => m && m.type === 'collection' && m.attributes && m.attributes.editable === true)
        .map(([modId, m]) => ({ modId, rules: m.rules || [] }));

    const collectionResults = [];
    const perCollectionToRemove = new Map(); // collectionId -> [{modId, rule}]
    const items = [];
    const plan = []; // parallel to items -- {entry, collectionId, modId}

    for (const { modId: collectionId, name: collectionName } of collectionEntries) {
        const collMod = data.mods[collectionId];
        if (!collMod) {
            collectionResults.push({ modId: collectionId, name: collectionName, removed: 0, alreadyGone: 0, failed: 0, removedMods: [], error: "Couldn't read this collection's current live data." });
            continue;
        }
        const currentRules = collMod.rules || [];
        const toRemove = [];
        let alreadyGone = 0;
        for (const modId of modIds) {
            const rule = currentRules.find((r) => r && r.reference && r.reference.id === modId);
            if (!rule) { alreadyGone += 1; continue; }
            toRemove.push({ modId, rule });
        }
        const entry = { modId: collectionId, name: collectionName, removed: 0, alreadyGone, failed: 0, removedMods: [] };
        collectionResults.push(entry);
        perCollectionToRemove.set(collectionId, toRemove);
        for (const { modId, rule } of toRemove) {
            items.push({ modId: collectionId, remove: rule });
            plan.push({ entry, collectionId, modId });
        }
    }

    const removedByMod = new Map(); // modId -> Set<collectionId> actually removed from (ok results only)
    if (items.length > 0) {
        const results = await bridgeClient.applyRuleChangesBatch(items);
        if (results === null) {
            for (const { entry } of plan) entry.failed += 1;
        } else {
            results.forEach((result, i) => {
                const { entry, collectionId, modId } = plan[i];
                if (result && result.ok) {
                    entry.removed += 1;
                    if (!removedByMod.has(modId)) removedByMod.set(modId, new Set());
                    removedByMod.get(modId).add(collectionId);
                } else {
                    entry.failed += 1;
                }
            });
        }
    }

    for (const { modId: collectionId } of collectionEntries) {
        const entry = collectionResults.find((c) => c.modId === collectionId);
        const toRemove = perCollectionToRemove.get(collectionId);
        if (!entry || !toRemove) continue; // this collection hit the "couldn't read" error branch above
        for (const { modId } of toRemove) {
            const removedFrom = removedByMod.get(modId);
            if (!removedFrom || !removedFrom.has(collectionId)) continue; // failed -- not actually removed, leave out of the detail list
            const memberMod = data.mods[modId];
            const name = memberMod ? (displayName(memberMod.attributes) || modId) : modId;
            const version = memberMod ? ((memberMod.attributes && memberMod.attributes.version) || '') : '';
            const stillIn = editableCollections
                .filter((c) => c.modId !== collectionId)
                .filter((c) => !(removedFrom && removedFrom.has(c.modId)))
                .filter((c) => c.rules.some((r) => r && r.reference && r.reference.id === modId))
                .map((c) => {
                    const cMod = data.mods[c.modId];
                    return { modId: c.modId, name: displayName(cMod && cMod.attributes) || c.modId };
                });
            entry.removedMods.push({ modId, name, version, stillIn });
        }
    }

    const totalRemoved = collectionResults.reduce((sum, c) => sum + c.removed, 0);
    return { collections: collectionResults, totalRemoved };
}

module.exports = {
    searchMods, getEditableCollections, addModsToCollections, isAlreadyInCollection,
    getModsInCollections, removeModsFromCollections,
};
