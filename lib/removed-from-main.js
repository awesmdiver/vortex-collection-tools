'use strict';
// "Removed from main" (themed: The Unbinding / RobCo Redundancy Purge / Stage Jettison): finds the mods the MAIN
// collection dropped, lists the player's matching mods next to them, and deletes those on request.
//
// Two collections only: the main collection (installed, kept up to date by its author) and the player's own new
// collection on top of it (an upgrade such as a 4K mod matched to main's 2K one). Main is never changed.
//
// What proves "main dropped it": main's OWN current list of mods (its installed collection.json), nothing else.
// What Vortex shows for the old mod (Uninstalled, half-removed, still installed) is never used as proof, because
// Update Collection's removal sometimes does not finish (a Vortex time-out leaves any of those). Vortex is read
// only afterwards, to find what an unfinished removal left behind so it can be cleaned up with the pair.
//
// The pairs come from Rules Generator's saved link list (lib/rules-generator-links.js); followMainUpdate moves a
// link when main only UPDATED a mod and reports the ones whose main mod is gone. Update Collection's change
// records (lib/ucv2-change-records.js) are extra evidence only (a removal that was "kept" on purpose is kept).
//
// Removal reuses the paths that already exist: Update Collection's remove-and-verify (removeModsVerifiedRetry,
// staging checked so Vortex's blocking "Mod not found" dialog is never provoked, record-only otherwise), Duplicate
// Version Cleanup's archive removal (shared archives are kept), and the Bridge's rule batch for the rules.
// Everything the Bridge or the disk is asked for goes through `deps`, so the tests run on stand-ins.

const fs = require('fs');
const path = require('path');
const rg = require('./rules-generator');
const linksStore = require('./rules-generator-links');
const { buildSharedModIndex, findSharedModMatch } = require('./collection-diff');
const appConfig = require('./app-config');

// ---- default dependencies (lazy: the heavy runners load only when a real run needs them) ----

function realDeps() {
    const bridge = require('./vortex-bridge-client');
    const syncRunner = require('./sync-runner');
    const ucv2 = require('./update-collection-v2-runner');
    const dup = require('./duplicate-version-cleanup');
    const { locateArchive } = require('./archive-locator');
    const syncLib = require('./vortex-sync/lib');
    const chSnapshot = require('./cycle-helper-snapshot');
    return {
        bridge,
        listInstalledCollections: (staging) => syncRunner.listInstalledCollections(staging),
        readChangeRecords: (id) => ucv2.readChangeRecords(id),
        buildLiveIdentityIndex: ucv2.buildLiveIdentityIndex,
        resolveLiveModId: ucv2.resolveLiveModId,
        stagingHasRealFiles: ucv2.stagingHasRealFiles,
        removeModsVerifiedRetry: ucv2.removeModsVerifiedRetry,
        locateArchive,
        findSharedArchiveConflict: dup.findSharedArchiveConflict,
        removeOrphanDownloads: dup.removeOrphanDownloads,
        // One backup per run: the same live backup Update Collection takes (saved where its restore list finds it)
        // plus the rules snapshot Rules Generator takes before it writes.
        backup: async ({ newCollectionKey, newName, staging, data, modIndex, syncBackupRoot }) => {
            if (!syncBackupRoot) throw Object.assign(new Error('No backups folder is configured under Settings -- set one before deleting anything.'), { code: 'BACKUP_FAILED' });
            const snapshot = await ucv2.captureLiveBackupSnapshot({ collectionModId: newCollectionKey, collectionName: newName, staging, data });
            if (!snapshot) throw Object.assign(new Error("Couldn't read the new collection's rules to make a backup first."), { code: 'BACKUP_FAILED' });
            const backupPath = syncLib.saveBackup(snapshot, syncBackupRoot);
            try { chSnapshot.captureFromRulesByModKey(data.enabledModKeys, modIndex); } catch { /* the rules snapshot is a bonus; the backup above is the gate */ }
            return backupPath;
        },
    };
}

function withDeps(deps) { return { ...realDeps(), ...(deps || {}) }; }

// ---- small helpers ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const rowId = (link) => `${link.main.modKey}::${link.new.modKey}`;

function readCollectionJsonMods(collectionJsonPath) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8')); } catch { return null; }
    return raw && Array.isArray(raw.mods) ? raw.mods : null;
}

// The Source-shaped identity of a saved link side or a live mod.
function sourceOfIdentity(id) {
    return { type: 'nexus', md5: id.fileMD5 || undefined, modId: id.modId != null ? Number(id.modId) : undefined, fileId: id.fileId != null ? Number(id.fileId) : undefined };
}
function sourceOfLiveMod(mod) {
    const a = (mod && mod.attributes) || {};
    return { type: 'nexus', md5: a.fileMD5, modId: a.modId, fileId: a.fileId, fileSize: a.fileSize, tag: a.referenceTag, logicalFilename: a.logicalFileName, name: a.modName || a.name };
}

// Does a collection.json mod entry stand for this saved identity? (md5, or the same page and file).
function listedMatchesIdentity(listed, id) {
    const s = listed.source || {};
    if (id.fileMD5 && s.md5 && id.fileMD5 === s.md5) return true;
    if (id.modId != null && id.fileId != null && s.modId != null && s.fileId != null
        && String(id.modId) === String(s.modId) && String(id.fileId) === String(s.fileId)) return true;
    return false;
}

// Main's own current list, shaped for followMainUpdate. Each entry needs the key Vortex uses for it when there is one
// (a link stores that key); a listed mod Vortex does not have gets the key of a saved link that stands for the same
// file, else a made-up one. Nothing here depends on what state Vortex holds for a mod -- only on the key to point at.
function buildCurrentMods(mainMods, links, liveMatcher, deps) {
    return mainMods.map((m) => {
        const s = m.source || {};
        let modKey = liveMatcher ? deps.resolveLiveModId(liveMatcher, s) : null;
        if (!modKey) {
            const link = links.find((l) => listedMatchesIdentity(m, l.main));
            if (link) modKey = link.main.modKey;
        }
        if (!modKey) modKey = `main-list:${s.modId ?? ''}:${s.fileId ?? ''}:${s.md5 || norm(m.name)}`;
        return {
            modKey, modId: s.modId != null ? String(s.modId) : null, fileId: s.fileId != null ? String(s.fileId) : null,
            fileMD5: s.md5 || null, name: m.name, version: m.version || null,
        };
    });
}

// A second look before a link counts as gone: main's list must hold no mod with this file or this name.
function stillListedInMain(mainMods, id) {
    const wantName = norm(id.name);
    return mainMods.some((m) => listedMatchesIdentity(m, id) || (wantName && norm(m.name) === wantName));
}

// Update Collection's record of the removal, when it kept one (newest first). Only ever extra evidence.
function removalRecordFor(records, id) {
    const wantName = norm(id.name);
    for (const rec of records || []) {
        for (const r of rec.removed || []) {
            const sameFile = (id.fileMD5 && r.md5 && id.fileMD5 === r.md5)
                || (id.modId != null && id.fileId != null && r.modId != null && r.fileId != null && String(id.modId) === String(r.modId) && String(id.fileId) === String(r.fileId));
            if (sameFile || (wantName && norm(r.name) === wantName)) return r;
        }
    }
    return null;
}

function liveKeyFor(data, matcher, id, notKeys, deps) {
    // The key is Vortex's own id for the mod; the identity only guards against a key that now stands for another file.
    const same = (key) => {
        const a = (data.mods[key] && data.mods[key].attributes) || {};
        if (id.fileMD5 && a.fileMD5) return id.fileMD5 === a.fileMD5;
        if (id.modId != null && id.fileId != null && a.modId != null && a.fileId != null) return String(id.modId) === String(a.modId) && String(id.fileId) === String(a.fileId);
        return true; // nothing to tell them apart by on one side: trust the key
    };
    if (id.modKey && !notKeys.has(id.modKey) && data.mods[id.modKey] && same(id.modKey)) return id.modKey;
    if (!id.fileMD5 && !(id.modId != null && id.fileId != null)) return null;
    const found = matcher ? deps.resolveLiveModId(matcher, sourceOfIdentity(id)) : null;
    return found && !notKeys.has(found) ? found : null;
}

// The other collections that also hold this mod. Installed collections are read from their own collection.json (the
// check Safe Collection Removal uses); the player's own collections by their rules. Main and the new collection never count.
function collectionsAlsoHolding({ source, liveKey, others, editable }) {
    const names = [];
    if (source) {
        for (const o of others) if (findSharedModMatch(o.index, { source })) names.push(o.name);
    }
    if (liveKey) {
        for (const c of editable) if (c.memberKeys.has(liveKey)) names.push(c.name);
    }
    return [...new Set(names)];
}

function describeOthers({ data, matcher, deps, staging, skipCollectionKeys }) {
    const installed = deps.listInstalledCollections(staging).filter((c) => !skipCollectionKeys.has(c.modId));
    const others = installed.map((c) => {
        const mods = readCollectionJsonMods(c.collectionJsonPath) || [];
        // Only what is really installed counts as "also in" (an Optional entry nobody installed holds nothing).
        const live = matcher ? mods.filter((m) => deps.resolveLiveModId(matcher, m.source)) : mods.filter((m) => m.optional !== true);
        return { key: c.modId, name: c.name, index: buildSharedModIndex(live), mods };
    });
    const editable = Object.entries(data.mods)
        .filter(([key, m]) => m && m.type === 'collection' && m.attributes && m.attributes.editable === true && !skipCollectionKeys.has(key))
        .map(([key, m]) => ({
            key, name: m.attributes.customFileName || m.attributes.name || key,
            memberKeys: new Set((m.rules || []).map((r) => r && r.reference && r.reference.id).filter(Boolean)),
        }));
    return { others, editable };
}

// ---- Compare ----

async function loadLive(deps) {
    const data = await deps.bridge.getAllMods();
    if (!data || !data.mods) {
        const err = new Error("Couldn't read Vortex's mod list -- is Vortex open and the Bridge running?");
        err.code = 'VORTEX_READ_FAILED';
        throw err;
    }
    return data;
}

async function compare({ mainCollectionKey, newCollectionKey, staging, linksDir, deps: depsIn, data: preloaded } = {}) {
    const deps = withDeps(depsIn);
    if (!mainCollectionKey || !newCollectionKey) throw new Error('Pick the main collection and your new collection first.');
    if (mainCollectionKey === newCollectionKey) throw new Error('Main and new must be two different collections.');

    const data = preloaded || await loadLive(deps);
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    if (!modIndex.has(mainCollectionKey) || !modIndex.has(newCollectionKey)) {
        throw new Error("One of the two collections isn't in Vortex any more. Pick them again.");
    }
    const names = {
        main: rg.displayName(modIndex.get(mainCollectionKey)) || mainCollectionKey,
        new: rg.displayName(modIndex.get(newCollectionKey)) || newCollectionKey,
    };
    const pairId = linksStore.pairIdFor(modIndex, mainCollectionKey, newCollectionKey);
    const base = { pairId, mainName: names.main, newName: names.new, rows: [] };

    const saved = linksStore.getLinks(pairId, { dir: linksDir });
    if (saved.length === 0) return { ...base, state: 'no-links' };

    // Main's own current list. If it cannot be read, nothing is claimed: an empty list must never read as "main dropped everything".
    const mainFolder = deps.listInstalledCollections(staging).find((c) => c.modId === mainCollectionKey);
    const mainMods = mainFolder ? readCollectionJsonMods(mainFolder.collectionJsonPath) : null;
    if (!mainMods || mainMods.length === 0) {
        throw new Error("Couldn't read the main collection's own list of mods, so nothing can be compared. Is it installed in Vortex?");
    }

    const matcher = deps.buildLiveIdentityIndex(data.mods);
    const currentMods = buildCurrentMods(mainMods, saved, matcher, deps);
    const followed = linksStore.followMainUpdate(pairId, { currentMods }, { dir: linksDir });
    const records = (() => { try { return deps.readChangeRecords(mainCollectionKey) || []; } catch { return []; } })();

    const skip = new Set([mainCollectionKey, newCollectionKey]);
    const { others, editable } = describeOthers({ data, matcher, deps, staging, skipCollectionKeys: skip });
    const newKeys = new Set(saved.map((l) => l.new.modKey));

    const rows = [];
    for (const link of followed.gone) {
        if (stillListedInMain(mainMods, link.main)) continue; // second look: main still lists it, so it is not gone

        const newKey = liveKeyFor(data, matcher, link.new, new Set(), deps);
        const mainKey = liveKeyFor(data, matcher, link.main, newKeys, deps);
        const record = removalRecordFor(records, link.main);
        const leftover = !!mainKey && !(record && record.status === 'kept');
        const mainShared = !!mainKey && collectionsAlsoHolding({ source: sourceOfLiveMod(data.mods[mainKey]), liveKey: mainKey, others, editable }).length > 0;

        // Nothing left to delete (the new mod is gone and no leftover remains): tidy the link away without a word.
        if (!newKey && !(leftover && !mainShared)) {
            linksStore.removeLink(pairId, link.main.modKey, link.new.modKey, { dir: linksDir });
            continue;
        }
        const alsoIn = newKey ? collectionsAlsoHolding({ source: sourceOfLiveMod(data.mods[newKey]), liveKey: newKey, others, editable }) : [];
        rows.push({
            id: rowId(link), mainName: link.main.name, newName: link.new.name,
            alsoIn, ticked: alsoIn.length === 0,
        });
    }
    rows.sort((a, b) => a.mainName.localeCompare(b.mainName));
    return { ...base, state: rows.length === 0 ? 'nothing' : 'list', rows, movedCount: followed.moved.length };
}

// ---- Delete ----

// Rules on other mods that point at a mod being deleted. A rule that names its target by id points at it when the ids
// are equal; one that names it another way (file hash, file name) must match a deleted mod and NO surviving one.
function rulesPointingAt({ data, modIndex, deletedKeys, skipOwnerKeys }) {
    const items = [];
    const deletedEntries = [...deletedKeys].map((k) => modIndex.get(k)).filter(Boolean);
    let survivors = null;
    const surviving = () => (survivors ||= [...modIndex.values()].filter((e) => e.type !== 'collection' && !deletedKeys.has(e.modKey)));
    for (const [ownerKey, mod] of Object.entries(data.mods)) {
        if (deletedKeys.has(ownerKey) || skipOwnerKeys.has(ownerKey)) continue;
        for (const rule of (mod && mod.rules) || []) {
            const ref = rule && rule.reference;
            if (!ref) continue;
            let points = false;
            if (ref.id != null) {
                points = deletedKeys.has(ref.id);
            } else if (deletedEntries.some((e) => rg.refMatchesEntry(ref, e))) {
                points = !surviving().some((e) => rg.refMatchesEntry(ref, e));
            }
            if (points) items.push({ modId: ownerKey, remove: rule });
        }
    }
    return items;
}

// What the archive of a removed mod needs: the download records that hold it, unless another mod or collection uses it.
function archiveFor({ mod, files, survivingMods, otherCollections, batchIds, deps }) {
    const a = (mod && mod.attributes) || {};
    const ids = new Set();
    if (mod && mod.archiveId && files[mod.archiveId]) ids.add(mod.archiveId);
    if (a.fileMD5) for (const [id, f] of Object.entries(files)) if (f.fileMD5 === a.fileMD5) ids.add(id);
    if (ids.size === 0) return { state: 'none' };
    const sharedByMod = Object.values(survivingMods).some((m) => {
        const sa = (m && m.attributes) || {};
        return (mod.archiveId && m.archiveId === mod.archiveId) || (a.fileMD5 && sa.fileMD5 === a.fileMD5);
    });
    const sharedByCollection = a.fileMD5 && otherCollections.some((c) => c.mods.some((m) => m.source && m.source.md5 === a.fileMD5));
    if (sharedByMod || sharedByCollection) return { state: 'kept-shared' };
    const safe = [];
    for (const id of ids) {
        const f = files[id];
        if (deps.findSharedArchiveConflict(files, id, f.localPath, new Set([...ids, ...batchIds]))) return { state: 'kept-shared' };
        safe.push(id);
    }
    return { state: 'delete', ids: safe };
}

function stagingAndArchiveOk(mod, staging, downloads, deps) {
    const stagingExists = !!(mod && mod.installationPath && deps.stagingHasRealFiles(path.join(staging, mod.installationPath)));
    return deps.locateArchive(downloads, sourceOfLiveMod(mod)).then(() => stagingExists, () => false);
}

// Removes the given Vortex mods the way Update Collection does. Returns { removed: Set(keys), failed: Map(key -> reason) }.
async function removeLiveMods({ keys, data, staging, downloads, deps }) {
    const removed = new Set();
    const failed = new Map();
    const real = [];
    const recordOnly = [];
    for (const key of keys) {
        const mod = data.mods[key];
        if (!mod) { removed.add(key); continue; } // already gone
        ((await stagingAndArchiveOk(mod, staging, downloads, deps)) ? real : recordOnly).push({ vortexModId: key, name: key });
    }
    if (real.length > 0) {
        try {
            const res = await deps.removeModsVerifiedRetry(real, staging);
            res.removed.forEach((m) => removed.add(m.vortexModId));
            res.stillRemaining.forEach((m) => failed.set(m.vortexModId, res.blockedReason || "Vortex didn't confirm the removal."));
        } catch (e) {
            real.forEach((m) => failed.set(m.vortexModId, e.message));
        }
    }
    if (recordOnly.length > 0) {
        try {
            const ok = await deps.bridge.removeModsRecordOnly(recordOnly.map((m) => m.vortexModId));
            recordOnly.forEach((m) => (ok ? removed.add(m.vortexModId) : failed.set(m.vortexModId, "Vortex didn't confirm the removal.")));
        } catch (e) {
            recordOnly.forEach((m) => failed.set(m.vortexModId, e.message));
        }
    }
    return { removed, failed };
}

async function deleteRows({
    mainCollectionKey, newCollectionKey, rowIds, staging, downloads, syncBackupRoot, linksDir, historyDir,
    onProgress, deps: depsIn, now = () => new Date(), pauseMs = 0,
} = {}) {
    const deps = withDeps(depsIn);
    const emit = onProgress || (() => {});

    // The list is worked out again here from Vortex and main's own list; the client's copy is only a set of ids.
    emit({ phase: 'checking', message: 'Checking what to delete…' });
    const data = await loadLive(deps);
    const fresh = await compare({ mainCollectionKey, newCollectionKey, staging, linksDir, deps, data });
    const wanted = new Set(rowIds || []);
    const chosen = fresh.rows.filter((r) => wanted.has(r.id));
    if (chosen.length === 0) {
        return { ok: true, deleted: 0, failed: 0, failures: [], newName: fresh.newName, nothingChosen: true };
    }

    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    const matcher = deps.buildLiveIdentityIndex(data.mods);
    const saved = linksStore.getLinks(fresh.pairId, { dir: linksDir });
    const linkById = new Map(saved.map((l) => [rowId(l), l]));
    const newKeys = new Set(saved.map((l) => l.new.modKey));
    const records = (() => { try { return deps.readChangeRecords(mainCollectionKey) || []; } catch { return []; } })();
    const skip = new Set([mainCollectionKey, newCollectionKey]);
    const { others, editable } = describeOthers({ data, matcher, deps, staging, skipCollectionKeys: skip });

    // One backup for the whole run, before anything changes.
    emit({ phase: 'backup', message: 'Making a backup first…' });
    const backupPath = await deps.backup({ newCollectionKey, newName: fresh.newName, staging, data, modIndex, syncBackupRoot });

    const files = ((await deps.bridge.getAllDownloads()) || {}).files || {};
    const work = chosen.map((row) => {
        const link = linkById.get(row.id);
        const newKey = liveKeyFor(data, matcher, link.new, new Set(), deps);
        let mainKey = liveKeyFor(data, matcher, link.main, newKeys, deps);
        const record = removalRecordFor(records, link.main);
        // The leftover main mod goes too, unless Update Collection kept it on purpose or another collection holds it.
        const mainShared = mainKey && collectionsAlsoHolding({ source: sourceOfLiveMod(data.mods[mainKey]), liveKey: mainKey, others, editable }).length > 0;
        if (mainKey && ((record && record.status === 'kept') || mainShared)) mainKey = null;
        return { row, link, newKey, mainKey, status: null, reason: null, rulesRemoved: 0, archives: [] };
    });
    const batchDownloadIds = new Set();

    const localMods = { ...data.mods }; // kept in step with what has been removed, so later rows see the truth
    const removedAll = new Set();
    const rulesNotRemoved = [];
    let done = 0;

    for (const w of work) {
        emit({ phase: 'deleting', current: done + 1, total: work.length, message: `Deleting ${done + 1} of ${work.length}…` });
        await deps.bridge.holdWhileVortexBusy?.({ onWait: () => emit({ phase: 'deleting', current: done + 1, total: work.length, message: 'Vortex is busy, waiting a moment…' }) });

        // 1. The new mod, then the leftover main mod. A row counts as deleted only when every removal in it is confirmed.
        const keys = [w.newKey, w.mainKey].filter(Boolean);
        const snapshot = { mods: localMods };
        const result = await removeLiveMods({ keys, data: snapshot, staging, downloads, deps });
        const reasons = [];
        for (const k of keys) if (result.failed.has(k)) reasons.push(result.failed.get(k));
        const okKeys = keys.filter((k) => result.removed.has(k));
        okKeys.forEach((k) => removedAll.add(k));

        // 2. The rules on other mods that pointed at what is gone (this includes the new collection's own entry for it).
        if (okKeys.length > 0) {
            const items = rulesPointingAt({ data: { mods: localMods }, modIndex, deletedKeys: new Set(okKeys), skipOwnerKeys: new Set([mainCollectionKey]) });
            if (items.length > 0) {
                let results = null;
                try { results = await deps.bridge.applyRuleChangesBatch(items); } catch { results = null; }
                items.forEach((it, i) => {
                    if (results && results[i] && results[i].ok) {
                        w.rulesRemoved += 1;
                        const owner = localMods[it.modId];
                        if (owner) localMods[it.modId] = { ...owner, rules: (owner.rules || []).filter((r) => r !== it.remove) };
                    } else {
                        rulesNotRemoved.push({ owner: it.modId, rule: it.remove });
                    }
                });
            }
        }

        // 3. The archives of what is gone, unless another mod or collection shares them.
        for (const k of okKeys) {
            const mod = data.mods[k];
            const survivingMods = Object.fromEntries(Object.entries(localMods).filter(([key]) => !removedAll.has(key) && key !== k));
            const arch = archiveFor({ mod, files, survivingMods, otherCollections: others, batchIds: batchDownloadIds, deps });
            if (arch.state === 'delete') {
                try {
                    const res = await deps.removeOrphanDownloads({ files, downloadIds: arch.ids, downloadsDir: downloads });
                    arch.ids.forEach((id) => batchDownloadIds.add(id));
                    w.archives.push({ key: k, state: res.leftovers.length ? 'not deleted' : 'deleted', detail: res.leftovers.map((l) => l.reason).join(' ') || undefined });
                } catch (e) {
                    w.archives.push({ key: k, state: 'not deleted', detail: e.message });
                }
            } else {
                w.archives.push({ key: k, state: arch.state });
            }
        }

        okKeys.forEach((k) => delete localMods[k]);
        w.removedKeys = okKeys;
        if (reasons.length === 0) { w.status = 'deleted'; } else { w.status = 'failed'; w.reason = reasons[0]; }
        done += 1;
        if (pauseMs) await sleep(pauseMs);
    }

    // Check by looking: a fresh read of Vortex. A mod still there is a failed row, whatever the call answered.
    emit({ phase: 'verifying', message: 'Checking the result…' });
    let verify = null;
    for (let attempt = 0; attempt < 3 && !verify; attempt += 1) {
        try { verify = await deps.bridge.getAllMods(); } catch { verify = null; }
        if (!verify && attempt < 2) await sleep(pauseMs || 1500);
    }
    if (verify && verify.mods) {
        for (const w of work) {
            if (w.status !== 'deleted') continue;
            const still = (w.removedKeys || []).find((k) => verify.mods[k]);
            if (still) { w.status = 'failed'; w.reason = "Vortex still lists it after the removal."; }
        }
    }

    // The links of deleted rows go; failed rows keep theirs, so they stay in the list for another try.
    for (const w of work) {
        if (w.status === 'deleted') linksStore.removeLink(fresh.pairId, w.link.main.modKey, w.link.new.modKey, { dir: linksDir });
    }

    const deleted = work.filter((w) => w.status === 'deleted');
    const failed = work.filter((w) => w.status === 'failed');
    const record = {
        at: now().toISOString(),
        mainCollection: { key: mainCollectionKey, name: fresh.mainName },
        newCollection: { key: newCollectionKey, name: fresh.newName },
        backupPath: backupPath || null,
        verified: !!(verify && verify.mods),
        deleted: deleted.length, failed: failed.length,
        rows: work.map((w) => ({
            gone: w.link.main.name, matching: w.link.new.name, status: w.status, reason: w.reason || undefined,
            newModRemoved: !!(w.newKey && (w.removedKeys || []).includes(w.newKey)),
            leftoverMainModRemoved: !!(w.mainKey && (w.removedKeys || []).includes(w.mainKey)),
            rulesRemoved: w.rulesRemoved, archives: w.archives,
        })),
        rulesNotRemoved: rulesNotRemoved.length,
    };
    const savedTo = writeHistory(record, historyDir);
    return {
        ok: failed.length === 0, deleted: deleted.length, failed: failed.length,
        failures: failed.map((w) => ({ id: w.row.id, name: w.link.new.name, reason: w.reason })),
        newName: fresh.newName, historyFile: savedTo,
    };
}

// The small record of what a run did, for the record (not shown unless asked), next to the other tools' history.
function getHistoryDir(override) {
    return override || appConfig.resolveDataDir('removed-from-main/history', path.join(__dirname, '..', 'config', 'removed-from-main-history'));
}
function writeHistory(record, historyDir) {
    try {
        const dir = getHistoryDir(historyDir);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${record.at.replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
        return file;
    } catch (e) {
        console.warn(`[removed-from-main] couldn't write the history record: ${e.message}`);
        return null;
    }
}

// The two pickers: any installed collection for main; one of the player's own editable collections for new.
async function listPickers({ staging, deps: depsIn } = {}) {
    const deps = withDeps(depsIn);
    const { getEditableCollections } = require('./add-mods-to-collections');
    const installed = staging ? deps.listInstalledCollections(staging).filter((c) => !/^vortex_collection_/i.test(c.modId)) : [];
    const mine = (await getEditableCollections()) || [];
    return {
        main: installed.map((c) => ({ modId: c.modId, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
        mine: mine.map((c) => ({ modId: c.modId, name: c.name })),
    };
}

module.exports = {
    compare, deleteRows: (args) => require('./vortex-bridge-client').withRunSummary('Removed From Main', () => deleteRows(args)),
    listPickers, rulesPointingAt, archiveFor, buildCurrentMods, rowId,
};
