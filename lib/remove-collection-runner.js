'use strict';
// Framework-agnostic orchestration for Safe Collection Removal ("The Quartermaster") -- used by
// web/remove-collection-routes.js. See TECHNICAL.md's "Safe Collection Removal" section for the
// full design writeup.
//
// The real gap this closes: Vortex's own "Remove collection" dialog is a single flat "Remove mods"
// checkbox plus "Please note, some mods may be required by multiple collections" -- checking it
// removes ALL of the collection's mods regardless, with no way to see which ones are actually
// shared with another installed collection, or choose per mod. This tool cross-references every
// OTHER installed collection's own collection.json first, so a shared mod defaults to kept (unchecked)
// instead of getting silently swept away.
//
// Deliberately reuses, not reinvents: update-collection-v2-runner.js's own listCollections (the same
// non-Workshop-filtered installed-collection listing) and buildLiveIdentityIndex/resolveLiveModId (the
// same collection.json-source -> live Vortex modId resolver Update Collection v2's own Removed-mods
// loop already uses).
//
// The mod-identity CROSS-REFERENCE below (buildSharedModIndex/findSharedModMatch) now lives in
// collection-diff.js (relocated 2026-08-21 so Update Collection v2's own Removed-mods review can
// reuse this exact same, already-proven logic) -- see that file's own header comment on those two
// functions for the full reasoning (why they deliberately don't reuse buildIndex/findMatch's own
// bare-modId fallback key, and the real false positive that proved it).

const fs = require('fs');
const path = require('path');
const { buildSharedModIndex, findSharedModMatch } = require('./collection-diff');
const { listCollections, buildLiveIdentityIndex, resolveLiveModId, getCollectionsCache } = require('./update-collection-v2-runner');
const syncRunner = require('./sync-runner');
const helperClient = require('./vortex-helper-client');
const syncLib = require('./vortex-sync/lib');
const cleanupScan = require('./cleanup-scan');

function readCollectionMods(collectionJsonPath) {
    try {
        const raw = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
        return raw.mods || [];
    } catch {
        return [];
    }
}

// A collection.json's raw mods[] records every mod the collection AUTHOR shipped, including Optional
// installs the user may have declined -- real Vortex's own removal only ever touches what's actually
// live-installed (confirmed via real source: removeCollection's own removeMods derives from
// collection.rules cross-referenced with findModByRef against LIVE state, not the raw mods list).
// Confirmed as a real, live discrepancy 2026-08-19: the director counted 14 real mods to remove on a
// 26-mod collection where this tool showed 18 -- the 4-mod gap was exactly its 4 Optional entries,
// none of them actually installed (verified live via resolveLiveModId against all four). When the
// live matcher is available, this is the authoritative check (matches real Vortex exactly, regardless
// of the optional flag); when the helper isn't reachable, falls back to filtering mod.optional ===
// true only (the same precedent collection-diff.js's own diffCollectionMods already established) --
// a strictly more conservative approximation, not a silent skip.
function filterToLikelyInstalled(mods, liveMatcher) {
    if (liveMatcher) return mods.filter((m) => !!resolveLiveModId(liveMatcher, m.source));
    return mods.filter((m) => m.optional !== true);
}

// Screen 1's own collection grid. Reuses Update Collection v2's own shared server-side cache
// (getCollectionsCache/refreshCollectionsCache) instead of a second, separate image mechanism -- a
// real bug fixed 2026-08-19: this used to call the Helper's own LIVE mod attributes directly, which
// showed blank cards on a fresh server start (same symptom Update Collection v2 had before its own
// startup auto-refresh, commit 5b82bad) and depended on Vortex's live attribute cache already having
// a real pictureUrl set, neither as reliable as the proven Nexus-backed cache. That cache is populated
// automatically once at server startup by update-collection-v2-routes.js's own router factory (which
// server.js always creates before listening, regardless of which tool the user opens first, so there
// is no need for a second startup trigger here) -- this is a pure, instant cache READ, never a Nexus
// call of its own. `refreshing`/`checkedAt` are surfaced the same way Update Collection v2's own GET
// /collections does, so the frontend can poll while the startup refresh is still in flight rather than
// showing a blank grid.
async function getCollectionsOverview({ staging }) {
    const local = listCollections(staging).map((c) => ({ modId: c.modId, name: c.name, author: c.author, modCount: c.modCount, pictureUrl: null }));
    const cache = getCollectionsCache();
    const cached = cache.collections && cache.collections.map((c) => ({
        modId: c.modId, name: c.name, author: c.author, modCount: c.modCount, pictureUrl: c.pictureUrl || null,
    }));
    return {
        collections: cached || local,
        source: cached ? cache.source : 'local',
        refreshing: cache.refreshing, checkedAt: cache.checkedAt,
    };
}

// Screen 2's own real gap-closer: for every mod in the collection being removed, cross-reference it
// against every OTHER installed (non-Workshop) collection's own collection.json mods[] -- a pure,
// read-only filesystem operation; the helper extension is used opportunistically (best-effort) to
// resolve which mods are ACTUALLY live-installed, but review still works without it (falls back to
// the optional-flag heuristic, same as Apply's own helper-first/state-fallback convention elsewhere
// in this project). `key` is a deterministic per-mod identity string (JSON of its own collection.json
// `source`) the frontend echoes back in `selectedModIds` at Apply time, so Apply can re-derive the
// exact same rows fresh rather than trusting a client-held list.
async function reviewRemoval({ collectionModId, staging }) {
    const target = listCollections(staging).find((c) => c.modId === collectionModId);
    if (!target) throw new Error(`Collection "${collectionModId}" isn't currently installed (or isn't a real, non-Workshop collection).`);

    // Cross-reference against EVERY other real installed collection, including Workshop-authored
    // ones with genuine content -- deliberately NOT the same Workshop-excluding listCollections used
    // to pick the target above. That exclusion exists because Update Collection v2 genuinely can't
    // update a Workshop collection (a real Vortex-side limitation); this cross-reference only ever
    // READS another collection's own collection.json to check for a shared mod, which carries no
    // such limitation. Reusing the Workshop-excluding list here was a real bug, caught live
    // 2026-08-19: a mod shared only with a Workshop-authored collection (e.g. a cloned "My
    // Environment") silently reported as "safe to remove" when it wasn't. syncRunner's own
    // listInstalledCollections already gates Workshop folders on real on-disk content
    // (hasRealWorkshopContent, vortex-sync/lib.js) -- no extra filtering needed here beyond
    // excluding the target collection itself.
    const others = syncRunner.listInstalledCollections(staging).filter((c) => c.modId !== collectionModId);

    // One live matcher, reused for both the target collection's own mods AND every other collection's
    // -- a mod is only really "required by" another collection if IT is actually installed there too
    // (an Optional entry the user declined everywhere doesn't block anything real). Best-effort: null
    // when the helper isn't reachable, and filterToLikelyInstalled's own fallback covers that case.
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    const liveData = helperAvailable ? await helperClient.getAllMods() : null;
    const liveMatcher = liveData ? buildLiveIdentityIndex(liveData.mods) : null;

    const targetMods = filterToLikelyInstalled(readCollectionMods(target.collectionJsonPath), liveMatcher);
    const otherIndexes = others.map((c) => ({
        name: c.name,
        index: buildSharedModIndex(filterToLikelyInstalled(readCollectionMods(c.collectionJsonPath), liveMatcher)),
    }));

    const mods = targetMods.map((m) => {
        const usedBy = [];
        for (const o of otherIndexes) {
            if (findSharedModMatch(o.index, m)) usedBy.push(o.name);
        }
        return {
            key: JSON.stringify(m.source || {}),
            name: m.name, author: m.author, version: m.version, source: m.source,
            shared: usedBy.length > 0, usedBy,
        };
    });

    const byName = (a, b) => a.name.localeCompare(b.name);
    return {
        collectionModId, collectionName: target.name, collectionAuthor: target.author,
        modCount: mods.length,
        shared: mods.filter((m) => m.shared).sort(byName),
        only: mods.filter((m) => !m.shared).sort(byName),
    };
}

// The real Apply. Removes the collection's own mod entry (collectionModId) AND every mod the caller
// selected, in ONE real helperClient.removeMods batch call -- confirmed via real Vortex source
// (mod_management's removeMods action, the same one Vortex's own "Remove collection" dialog
// dispatches) that a collection is just another entry in state.persistent.mods (type: 'collection'),
// so removing its own modId through the exact same generic mod-removal action is what Vortex's own
// dialog does too, not a separate mechanism this tool has to invent. The collection is ALWAYS removed
// (matching Vortex's own real dialog, where "remove the collection" and "remove its mods" are two
// independent choices) -- selectedModIds is purely the per-mod "Remove mods" decision, mod by mod.
//
// Deliberately re-derives the review server-side rather than trusting the caller's own copy (same
// "never trust a client-held diff" principle every other real write in this project already
// follows) -- selectedModIds is matched against THIS fresh review's own `key`s, not blindly used.
async function applyRemoval({ collectionModId, staging, downloads, selectedModIds, deleteArchives }) {
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperAvailable) {
        const err = new Error("The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to remove a collection -- this real remove-mods/unlink work only exists through it, unlike this tool's read-only Review screen, which never needs it.");
        err.code = 'HELPER_UNAVAILABLE';
        throw err;
    }

    const review = await reviewRemoval({ collectionModId, staging });
    const selectedSet = new Set(selectedModIds || []);
    const toConsider = [...review.shared, ...review.only].filter((m) => selectedSet.has(m.key));

    const data = await helperClient.getAllMods();
    if (!data) throw new Error("Couldn't read Vortex's live mod list -- try again.");
    const matcher = buildLiveIdentityIndex(data.mods);

    // Resolve each selected mod's real, live Vortex modId up front -- a mod that no longer resolves
    // live (an earlier attempt on this same collection already removed it) is treated as already
    // achieved, same "already-removed" success case Update Collection v2's own Removed-mods loop
    // already established, rather than re-flagged as a failure.
    const modResults = [];
    const toRemoveIds = [];
    for (const m of toConsider) {
        const vortexModId = resolveLiveModId(matcher, m.source);
        if (vortexModId) {
            toRemoveIds.push(vortexModId);
            modResults.push({ name: m.name, source: m.source, ok: null, vortexModId });
        } else {
            modResults.push({ name: m.name, source: m.source, ok: true, action: 'already-removed' });
        }
    }

    const idsToRemove = [collectionModId, ...toRemoveIds];
    let removeOk = false;
    let removeError = null;
    try {
        removeOk = await helperClient.removeMods(idsToRemove);
        if (!removeOk) removeError = "Vortex couldn't remove this collection -- check Vortex's own log.";
    } catch (e) {
        removeError = e.message;
    }
    modResults.forEach((r) => {
        if (r.ok === null) {
            r.ok = removeOk;
            r.action = 'removed';
            if (!removeOk) r.error = "Vortex couldn't remove this mod -- check Vortex's own log.";
        }
    });

    // Optional "also permanently delete the archive" choice -- same convention (default OFF,
    // matched by real fileMD5 against Vortex's live downloads list, same deletion primitive) Update
    // Collection v2's own Removed-mods screen already established.
    const deletedArchiveResults = [];
    if (deleteArchives) {
        const eligible = modResults.filter((r) => r.ok === true);
        if (eligible.length > 0) {
            const downloadsData = await helperClient.getAllDownloads();
            if (!downloadsData) {
                eligible.forEach((r) => deletedArchiveResults.push({ name: r.name, ok: false, error: "Couldn't read Vortex's live downloads list to find the archive." }));
            } else {
                const byMd5 = new Map();
                for (const file of Object.values(downloadsData.files)) {
                    if (file.fileMD5) byMd5.set(file.fileMD5, file);
                }
                const toDelete = [];
                for (const r of eligible) {
                    const file = r.source && r.source.md5 && byMd5.get(r.source.md5);
                    if (file && file.localPath) {
                        toDelete.push({ name: r.name, path: path.join(downloads, file.localPath) });
                    } else {
                        deletedArchiveResults.push({ name: r.name, ok: false, error: "Couldn't find this mod's downloaded archive -- it may already be gone, or was never downloaded through Vortex." });
                    }
                }
                if (toDelete.length > 0) {
                    const rmResults = cleanupScan.deleteEntries(toDelete.map((t) => t.path));
                    toDelete.forEach((t, i) => {
                        const rm = rmResults[i];
                        deletedArchiveResults.push({ name: t.name, ok: rm.ok, error: rm.error, path: t.path });
                    });
                }
            }
        }
    }

    return {
        ok: removeOk,
        collectionRemoved: removeOk,
        collectionName: review.collectionName,
        modResults: modResults.map((r) => ({ name: r.name, ok: r.ok, action: r.action, error: r.error || null })),
        deletedArchiveResults,
        error: removeOk ? null : removeError,
    };
}

module.exports = { getCollectionsOverview, reviewRemoval, applyRemoval };
