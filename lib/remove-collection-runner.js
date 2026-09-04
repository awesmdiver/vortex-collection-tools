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
const { listCollections, buildLiveIdentityIndex, resolveLiveModId, getCollectionsCache, stagingHasRealFiles } = require('./update-collection-v2-runner');
const { locateArchive } = require('./archive-locator');
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
        // installedRevision (2026-08-29, director's own direct ask -- match Update Collection's own
        // card badge): already computed by the shared cache's own checkForUpdates pass, just wasn't
        // being forwarded here. undefined (not null) when the cache hasn't populated it yet, matching
        // Update Collection v2's own ucv2RenderCollections `c.installedRevision !== undefined` check
        // for "has /check-updates run yet" -- the frontend badge follows that exact convention.
        installedRevision: c.installedRevision,
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
// onProgress (2026-08-25, closes the exact "this looks stuck but nothing is happening" gap
// docs/UI-PATTERN-MAP.md flagged for this tool) -- optional; emits real phase transitions so the
// route layer can stream them over SSE the same way every other real write in this app does
// (createSseSession(), mirroring clear-update-flags-routes.js's own shape). Two of these phases
// ('resolving', 'removing') have no meaningful per-item count -- helperClient.removeMods is ONE
// atomic bulk call to the Helper extension with no per-mod feedback possible from this side, so
// there's nothing to count during it, same as Clear Update Flags' own "Starting…" phase-only state
// before its first per-mod event arrives. 'deleting-archives' DOES get a real per-file count, since
// that loop runs locally.
async function applyRemoval({ collectionModId, staging, downloads, selectedModIds, deleteArchives, onProgress }) {
    const emit = onProgress || (() => {});
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperAvailable) {
        const err = new Error("The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to remove a collection -- this real remove-mods/unlink work only exists through it, unlike this tool's read-only Review screen, which never needs it.");
        err.code = 'HELPER_UNAVAILABLE';
        throw err;
    }

    emit({ phase: 'resolving', message: 'Checking what needs to change…' });
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
    //
    // Staging/archive pre-check (2026-09-01, director-caught real live failure: "got error in vortex
    // about removing a mod that was already removed, i.e. staging and/or archive was already removed").
    // Ported from update-collection-v2-runner.js's own runApply Removed-mods loop (2026-08-28, same
    // root cause there) -- confirmed via Vortex's own source (mod_management/eventHandlers.ts's
    // undeployMods): when a mod's staging folder is already gone on disk, the real undeploy attempt
    // throws ENOENT, and VORTEX'S OWN CODE (not this project's) catches that by showing a real,
    // BLOCKING "Mod not found" dialog requiring a person to click Ignore/Deploy in the Vortex window
    // itself -- no option on the real remove-mods event suppresses this. A mod with no real staging
    // content (or whose downloaded archive is also gone) has nothing genuine for Vortex to undeploy
    // anyway, so it's routed through removeModsRecordOnly instead (deletes just the tracked record, no
    // undeploy attempt, no dialog risk) -- any stale symlink left in Data/ gets cleaned up by the
    // Deploy step this app already prompts for after every apply, same as the dialog's own "Deploy"
    // option would have done regardless. The collection's own tracking entry (collectionModId) is
    // NEVER routed to record-only -- it always needs the real remove-mods event to fully unregister it.
    const modResults = [];
    const toRemove = [];
    const toRemoveRecordOnly = [];
    for (const m of toConsider) {
        const vortexModId = resolveLiveModId(matcher, m.source);
        if (!vortexModId) {
            modResults.push({ name: m.name, source: m.source, ok: true, action: 'already-removed' });
            continue;
        }
        const liveMod = data.mods[vortexModId];
        const stagingExists = !!(liveMod && liveMod.installationPath
            && stagingHasRealFiles(path.join(staging, liveMod.installationPath)));
        let archiveExists = false;
        try {
            await locateArchive(downloads, m.source);
            archiveExists = true;
        } catch {
            archiveExists = false;
        }
        const entry = { name: m.name, source: m.source, ok: null, vortexModId };
        modResults.push(entry);
        (stagingExists && archiveExists ? toRemove : toRemoveRecordOnly).push(entry);
    }

    emit({ phase: 'removing', message: `Removing "${review.collectionName}" from Vortex…` });
    let removeOk = false;
    let removeError = null;
    try {
        removeOk = await helperClient.removeMods([collectionModId, ...toRemove.map((m) => m.vortexModId)]);
        if (!removeOk) removeError = "Vortex couldn't remove this collection -- check Vortex's own log.";
    } catch (e) {
        removeError = e.message;
    }
    toRemove.forEach((r) => {
        r.ok = removeOk;
        r.action = 'removed';
        if (!removeOk) r.error = "Vortex couldn't remove this mod -- check Vortex's own log.";
    });

    if (toRemoveRecordOnly.length > 0) {
        let recordOnlyOk = false;
        let recordOnlyError = null;
        try {
            recordOnlyOk = await helperClient.removeModsRecordOnly(toRemoveRecordOnly.map((m) => m.vortexModId));
            if (!recordOnlyOk) recordOnlyError = "Vortex couldn't remove this mod's tracked record -- check Vortex's own log.";
        } catch (e) {
            recordOnlyError = e.message;
        }
        toRemoveRecordOnly.forEach((r) => {
            r.ok = recordOnlyOk;
            r.action = 'removed';
            if (!recordOnlyOk) r.error = recordOnlyError;
        });
    }

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
                    // Looped one path at a time (rather than one batch cleanupScan.deleteEntries call)
                    // purely to get a real per-file count out to onProgress -- deleteEntries' own
                    // per-path try/catch behavior is reused as-is, just invoked with a 1-element array
                    // each time instead of the full list at once.
                    for (let i = 0; i < toDelete.length; i++) {
                        const t = toDelete[i];
                        emit({ phase: 'deleting-archives', current: i + 1, total: toDelete.length, message: `Deleting archive: ${t.name}` });
                        const [rm] = cleanupScan.deleteEntries([t.path]);
                        deletedArchiveResults.push({ name: t.name, ok: rm.ok, error: rm.error, path: t.path });
                    }
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
