'use strict';
// The download's side of the link for a mod Update Collection updated in place (2026-10-23, "Gate To
// Sovngarde": Vortex's Version drop-down listed "1.5.1 (Gate To Sovngarde)" and "1.5.1 (default)").
//
// An in-place update re-extracts into the mod's existing folder and re-saves its details; the new archive
// is registered as a download (resolveOrRegisterArchiveId) but nothing ever linked it to the mod. Two
// separate links exist in Vortex:
//   * the download's `installed` marker  -- what POST /downloads/set-installed writes. Only changes the
//     row label ("Never Installed" -> "Uninstalled").
//   * the mod's own top-level `archiveId` -- the ONLY thing that stops Vortex's table adding a separate
//     row for a finished download (ModList.tsx updateModsWithState: finished && !installedIds.has(id)).
//     Bridge 0.27.0 has POST /mods/set-archive-id for it; the chain below uses it.
// Pure apart from the injected bridge client (and the plain file delete for old archives).
const fs = require('fs');
const path = require('path');
const { deleteEntries } = require('./cleanup-scan');

function resolveDownloadPath(downloadsDir, localPath) {
    return path.isAbsolute(localPath) ? localPath : path.join(downloadsDir, localPath);
}
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mark the new archive installed for the mod. Never throws and never fails the update: false on any problem.
// `downloadsFiles` (optional, the held GET /downloads list) lets it skip a download already marked installed.
async function linkNewArchive(bridge, archiveId, vortexModId, downloadsFiles, log = console) {
    if (!archiveId || !vortexModId) return false;
    const dl = downloadsFiles && downloadsFiles[archiveId];
    if (dl && dl.installed && dl.installed.modId) return true; // already marked, nothing to write
    try {
        const ok = await bridge.setDownloadInstalled(archiveId, vortexModId);
        if (!ok) log.warn(`[ucv2-archive-link] could not mark download ${archiveId} installed for "${vortexModId}" (Vortex may list it as a separate entry).`);
        return !!ok;
    } catch (e) {
        log.warn(`[ucv2-archive-link] marking download ${archiveId} installed for "${vortexModId}" failed: ${e.message}`);
        return false;
    }
}

function nexusFileId(dl) {
    const ids = dl && dl.modInfo && dl.modInfo.nexus && dl.modInfo.nexus.ids;
    return ids && ids.fileId != null ? String(ids.fileId) : null;
}

// Finished downloads that no mod points at and that are a copy of one mod's CURRENT file (same md5, or the
// same Nexus mod id + file id). Never a download that matches no mod. A download matching two mods is
// reported as ambiguous and left alone. `identities`: optional Set of "modId:fileId" limiting which mods
// are looked at (this collection's). Returns [{ vortexModId, name, downloads: [{ id, installedMarked }] }]
// and `ambiguous`: ids skipped.
function findStrayOwnArchives({ liveMods, downloadsFiles, identities }) {
    const claimed = new Set();
    for (const m of Object.values(liveMods || {})) {
        if (m && m.archiveId) claimed.add(m.archiveId);
    }
    const byMd5 = new Map();
    const byIds = new Map();
    const add = (map, key, modKey) => {
        if (!key) return;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(modKey);
    };
    for (const [key, m] of Object.entries(liveMods || {})) {
        if (!m || m.type === 'collection') continue;
        const a = m.attributes || {};
        if (a.modId == null || a.fileId == null) continue;
        if (identities && !identities.has(`${a.modId}:${a.fileId}`)) continue;
        add(byMd5, a.fileMD5 ? String(a.fileMD5).toLowerCase() : null, key);
        add(byIds, `${a.modId}:${a.fileId}`, key);
    }
    const perMod = new Map();
    const ambiguous = [];
    for (const [id, dl] of Object.entries(downloadsFiles || {})) {
        if (!dl || dl.state !== 'finished' || claimed.has(id)) continue;
        const owners = new Set();
        if (dl.fileMD5) for (const k of byMd5.get(String(dl.fileMD5).toLowerCase()) || []) owners.add(k);
        const ids = dl.modInfo && dl.modInfo.nexus && dl.modInfo.nexus.ids;
        if (ids && ids.modId != null && nexusFileId(dl)) for (const k of byIds.get(`${ids.modId}:${nexusFileId(dl)}`) || []) owners.add(k);
        if (owners.size === 0) continue;
        if (owners.size > 1) { ambiguous.push(id); continue; }
        const [modKey] = owners;
        if (!perMod.has(modKey)) {
            const a = liveMods[modKey].attributes || {};
            perMod.set(modKey, { vortexModId: modKey, name: a.modName || a.name || modKey, version: a.version ?? null, downloads: [] });
        }
        perMod.get(modKey).downloads.push({ id, installedMarked: !!(dl.installed && dl.installed.modId), md5Match: !!(dl.fileMD5 && liveMods[modKey].attributes.fileMD5 && String(dl.fileMD5).toLowerCase() === String(liveMods[modKey].attributes.fileMD5).toLowerCase()) });
    }
    for (const st of perMod.values()) st.target = (st.downloads.find((d) => d.md5Match) || st.downloads[0]).id;
    return { strays: [...perMod.values()], ambiguous };
}

// ---- Point the mod at its new archive, then clear the old one (Bridge 0.27.0, recipe 12) ----
//
// Chain per mod, in this order; a failure at any step stops THAT mod's chain and never fails the update:
//   1. set-installed (linkNewArchive above)
//   2. set-archive-id: the mod's top-level archiveId becomes the new archive (reply carries 'previous')
//   3. verify with a fresh GET /mods: mods[id].archiveId is the new one
//   4. the old archive (previous) is removed -- file and record, POST /downloads/remove -- unless another mod
//      still points at it, its record is already gone, or another download record shares its file.
// Director's decision 2026-10-23: the old archive may be deleted, no extra confirmation.
// Steps 3 and 4 read the lists once for a whole batch of mods (a full GET /mods per mod would be minutes).

let versionCache = { at: 0, ok: false };
// Is the connected Bridge new enough to have set-archive-id? Cached for a minute. false = skip the step.
async function supportsArchiveId(bridge) {
    if (Date.now() - versionCache.at < 60000) return versionCache.ok;
    let ok = false;
    try {
        const health = await bridge.getBridgeHealth();
        ok = !!health && bridge.bridgeHasArchiveIdRoute(health.version);
    } catch { ok = false; }
    versionCache = { at: Date.now(), ok };
    return ok;
}
function resetVersionCache() { versionCache = { at: 0, ok: false }; }

// Step 2. Resolves to { ok:true, vortexModId, name, newArchiveId, previous } or { ok:false, skipped?:true }.
async function pointAtNewArchive(bridge, vortexModId, newArchiveId, name, log = console) {
    if (!vortexModId || !newArchiveId) return { ok: false };
    if (!(await supportsArchiveId(bridge))) return { ok: false, skipped: true };
    try {
        const r = await bridge.setModArchiveId(vortexModId, newArchiveId);
        if (!r) {
            log.warn(`[ucv2-archive-link] "${name || vortexModId}": could not point the mod at download ${newArchiveId}; its old download is left alone.`);
            return { ok: false };
        }
        if (r.supported === false) return { ok: false, skipped: true };
        return { ok: true, vortexModId, name: name || vortexModId, newArchiveId, previous: r.previous || null };
    } catch (e) {
        log.warn(`[ucv2-archive-link] "${name || vortexModId}": pointing at download ${newArchiveId} failed: ${e.message}`);
        return { ok: false };
    }
}

// Recipe 12's check, refined (2026-10-23). Which download records can go with this old one?
//   - The old record itself must still exist, and no mod may point at it.
//   - Other records that name the SAME FILE are removed with it when none of them is claimed by a mod and all are
//     finished: then nothing needs the file (a duplicate record of an unused archive). If a mod points at one of
//     them the file is in use and everything stays; a record still downloading also keeps the file.
// ownerModKey: the mod that was just pointed at its new archive. If it is the one using the file, the reason is
// 'own-copy' (its own current download is the same file) rather than "another mod".
// Returns { ok:true, ids:[old, ...siblings] } or { ok:false, code, text, mods:[names] }.
// Codes: 'gone' | 'old-in-use' | 'own-copy' | 'in-progress'.
function planOldArchiveRemoval(oldId, mods, downloads, ownerModKey) {
    const old = downloads[oldId];
    if (!old) return { ok: false, code: 'gone', text: 'its record is already gone', mods: [] };
    const records = [oldId];
    if (old.localPath) {
        for (const [id, d] of Object.entries(downloads)) if (id !== oldId && d && d.localPath === old.localPath) records.push(id);
    }
    const users = Object.entries(mods).filter(([, m]) => m && m.archiveId && records.includes(m.archiveId)).map(([key]) => key);
    if (users.length > 0) {
        const nameOf = (key) => { const a = (mods[key] && mods[key].attributes) || {}; return a.modName || a.name || key; };
        const onlyOwner = users.every((k) => k === ownerModKey);
        return {
            ok: false, code: onlyOwner ? 'own-copy' : 'old-in-use', mods: users.map(nameOf),
            text: onlyOwner ? "the mod's own current download is the same file" : `another mod still uses it (${users.map(nameOf).join(', ')})`,
        };
    }
    const running = records.filter((id) => downloads[id] && downloads[id].state !== 'finished');
    if (running.length > 0) return { ok: false, code: 'in-progress', text: 'a download of the same file is still running', mods: [] };
    return { ok: true, ids: records };
}
// Old text-returning form, kept for callers that only need a reason string or null.
function whyOldIsNotFree(oldId, mods, downloads, ownerModKey) {
    const plan = planOldArchiveRemoval(oldId, mods, downloads, ownerModKey);
    return plan.ok ? null : plan.text;
}

// Removes old archives COMPLETELY (2026-10-23). The Bridge's remove takes the record; the file can stay behind (the
// director's SKSE 2.2.6: record gone, file still in the downloads folder, so Vortex found the file and registered
// it again as a new "Never Installed" download). So, in order, for a batch:
//   1. Bridge removal of each record (POST /downloads/remove, which should delete the file too)
//   2. if the file is still there, the plain file delete VCT uses for removed mods' archives
//   3. ONE short wait, then one fresh read of the downloads: any record Vortex re-registered for the same file name
//      (finished, not marked installed, claimed by no mod) is removed the same way, once
// A file that cannot be deleted is reported ("Couldn't delete <name>: it is in use.") and logged.
// items: [{ id, name }]; modsClaim: mods map used to check nothing points at a re-registered copy.
// Returns one result per item: { id, recordRemoved, fileGone, fileError, reregisteredRemoved }.
async function removeArchivesAndFiles(bridge, items, { downloadsFiles, mods, downloadsDir, sleep = sleepMs, pauseMs = 3000, deleteFile = deleteEntries, log = console } = {}) {
    const results = items.map((it) => ({ id: it.id, recordRemoved: false, fileGone: false, fileError: null, reregisteredRemoved: false }));
    const fileNames = new Map(); // id -> localPath, read BEFORE the record goes
    const removeOne = async (id, localPath, result, label) => {
        let item = null;
        try {
            const res = await bridge.removeDownloads([id]);
            item = Array.isArray(res) ? (res.find((x) => x.downloadId === id) || res[0]) : null;
        } catch (e) {
            log.warn(`[ucv2-archive-link] "${label}": removing download ${id} failed: ${e.message}`);
        }
        result.recordRemoved = !!(item && item.ok);
        if (!result.recordRemoved) {
            log.warn(`[ucv2-archive-link] "${label}": removing download ${id} did not confirm${item && item.error ? ` (${item.error})` : ''}; it stays until the next Continue Update.`);
            return;
        }
        if (localPath && downloadsDir) {
            const full = resolveDownloadPath(downloadsDir, localPath);
            if (fs.existsSync(full)) {
                const [del] = deleteFile([full]);
                if (!del.ok) {
                    result.fileError = `Couldn't delete ${path.basename(full)}: it is in use.`;
                    log.warn(`[ucv2-archive-link] "${label}": ${result.fileError} (${del.error})`);
                    return;
                }
            }
            result.fileGone = !fs.existsSync(full);
        }
    };
    for (let i = 0; i < items.length; i += 1) {
        const lp = downloadsFiles && downloadsFiles[items[i].id] ? downloadsFiles[items[i].id].localPath : null;
        fileNames.set(items[i].id, lp);
        await removeOne(items[i].id, lp, results[i], items[i].name || items[i].id);
    }
    const names = new Set([...fileNames.values()].filter(Boolean));
    if (names.size === 0 || !downloadsDir) return results;
    // Did Vortex list the same file again?
    await sleep(pauseMs);
    let fresh = null;
    try { fresh = await bridge.getAllDownloads(); } catch { fresh = null; }
    if (!fresh || !fresh.files) {
        log.warn('[ucv2-archive-link] could not re-read the downloads to check for a re-listed old archive.');
        return results;
    }
    const removedIds = new Set(items.map((it) => it.id));
    const claimed = new Set(Object.values(mods || {}).map((m) => m && m.archiveId).filter(Boolean));
    for (const [id, f] of Object.entries(fresh.files)) {
        if (removedIds.has(id) || !f || !f.localPath || !names.has(f.localPath)) continue;
        if (f.state !== 'finished' || (f.installed && f.installed.modId) || claimed.has(id)) continue;
        const owner = results[items.findIndex((it) => fileNames.get(it.id) === f.localPath)];
        const res = { reregisteredRemoved: false };
        await removeOne(id, f.localPath, res, f.localPath);
        if (owner && res.recordRemoved) {
            owner.reregisteredRemoved = true;
            if (res.fileError) owner.fileError = res.fileError;
            owner.fileGone = res.fileGone || owner.fileGone;
        }
    }
    return results;
}

// Steps 3 and 4 for a batch of pointed mods. Returns one result per mod: { vortexModId, name, verified,
// oldRemoved, oldKept (reason), oneEntry }. 'oneEntry' is true only when the fresh read shows the mod points at
// the new archive AND no finished download of its current file is left unclaimed.
async function finishArchiveChains(bridge, pointed, log = console, opts = {}) {
    const results = pointed.map((p) => ({ vortexModId: p.vortexModId, name: p.name, verified: false, oldRemoved: false, oldKept: null, oneEntry: false }));
    if (pointed.length === 0) return results;
    let modsData = null;
    let dlData = null;
    try {
        modsData = await bridge.getAllMods();
        dlData = await bridge.getAllDownloads();
    } catch { /* handled below */ }
    if (!modsData || !modsData.mods || !dlData || !dlData.files) {
        log.warn('[ucv2-archive-link] could not re-read Vortex to verify the new archive links; no old archive was removed. Continue Update tries again.');
        return results;
    }
    const strays = findStrayOwnArchives({ liveMods: modsData.mods, downloadsFiles: dlData.files }).strays;
    const toClear = [];
    for (let i = 0; i < pointed.length; i += 1) {
        const p = pointed[i];
        const r = results[i];
        const live = modsData.mods[p.vortexModId];
        if (!live || live.archiveId !== p.newArchiveId) {
            log.warn(`[ucv2-archive-link] "${p.name}": after pointing it at download ${p.newArchiveId}, Vortex still shows a different archive; its old download is left alone.`);
            continue;
        }
        r.verified = true;
        r.oneEntry = !strays.some((s) => s.vortexModId === p.vortexModId);
        const oldId = p.previous;
        if (!oldId || oldId === p.newArchiveId) continue;
        const plan = planOldArchiveRemoval(oldId, modsData.mods, dlData.files, p.vortexModId);
        if (!plan.ok) {
            r.oldKept = plan.text;
            r.oldKeptCode = plan.code;
            log.warn(`[ucv2-archive-link] "${p.name}": old download ${oldId} left in place (${plan.text}).`);
            continue;
        }
        // The old record first, then any unused duplicate records of the same file.
        plan.ids.forEach((id, k) => toClear.push({ index: i, id, name: k === 0 ? p.name : `${p.name} (duplicate record)`, primary: k === 0 }));
    }
    if (toClear.length > 0) {
        if (!opts.downloadsDir) log.warn('[ucv2-archive-link] no downloads folder given, so old archive FILES cannot be deleted; only their records are removed.');
        const cleared = await removeArchivesAndFiles(bridge, toClear, { downloadsFiles: dlData.files, mods: modsData.mods, downloadsDir: opts.downloadsDir, sleep: opts.sleep, pauseMs: opts.pauseMs, deleteFile: opts.deleteFile, log });
        const doneOk = new Map(); // index -> every record of that mod's old archive went
        cleared.forEach((c, k) => {
            const r = results[toClear[k].index];
            doneOk.set(toClear[k].index, (doneOk.has(toClear[k].index) ? doneOk.get(toClear[k].index) : true) && c.recordRemoved && !c.fileError);
            if (c.fileError) r.fileError = c.fileError;
            r.reregisteredRemoved = r.reregisteredRemoved || c.reregisteredRemoved;
            if (!c.recordRemoved) { r.oldKept = 'removal did not confirm'; r.oldKeptCode = 'unconfirmed'; }
            else if (c.fileError) { r.oldKept = c.fileError; r.oldKeptCode = 'file-in-use'; }
        });
        for (const [index, ok] of doneOk) results[index].oldRemoved = ok;
    }
    return results;
}

// The repair: for each stray, mark the download installed (when it is not), point the mod at it, verify, then
// clear the mod's old archive. No re-extract, no download. One result per mod: { name, vortexModId, ok, oneEntry }.
// ok = the chain reached a verified link; oneEntry = a fresh read shows no unclaimed download left for the file.
async function repairStrayArchives(bridge, strays, log = console, opts = {}) {
    const pointed = [];
    const out = new Map();
    for (const s of strays) {
        let marked = 0;
        for (const d of s.downloads) {
            if (d.installedMarked) { marked += 1; continue; }
            if (await linkNewArchive(bridge, d.id, s.vortexModId, null, log)) marked += 1;
        }
        const entry = { name: s.name, vortexModId: s.vortexModId, ok: false, oneEntry: false };
        out.set(s.vortexModId, entry);
        if (marked !== s.downloads.length) continue;
        const target = s.target || (s.downloads[0] && s.downloads[0].id);
        const p = await pointAtNewArchive(bridge, s.vortexModId, target, s.name, log);
        if (p.ok) pointed.push(p);
        else if (p.skipped) log.warn(`[ucv2-archive-link] "${s.name}": marked download ${target} installed; this Bridge is too old to point the mod at it, so Vortex can still list it twice.`);
    }
    const done = await finishArchiveChains(bridge, pointed, log, opts);
    for (const r of done) {
        const e = out.get(r.vortexModId);
        e.ok = r.verified;
        e.oneEntry = r.oneEntry;
        if (r.fileError) e.fileError = r.fileError;
        // Only reasons the chain really has: a deliberate keep (another mod / the mod's own copy / a running
        // download), a file in use, or a removal call that did not confirm.
        if (!(r.verified && r.oneEntry)) e.reason = r.oldKeptCode || 'unconfirmed';
    }
    for (const e of out.values()) if (!e.oneEntry && !e.reason) e.reason = 'unconfirmed';
    return [...out.values()];
}

// ---- Old archives already left behind (re-listed by Vortex as "Never Installed") ----
// A finished, unmarked download that no mod points at and that is an OLDER file of an installed mod: same Nexus mod
// id, a lower file id than the installed one, no installed mod on that file id, and the same file name base
// ("<logical name>-<modId>-..."). A Never Installed download that matches no installed mod is never reported.
function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function findOldDownloadsOfInstalledMods({ liveMods, downloadsFiles }) {
    const claimed = new Set();
    const byNexus = new Map();
    const installedFileIds = new Set();
    for (const m of Object.values(liveMods || {})) if (m && m.archiveId) claimed.add(m.archiveId);
    for (const [key, m] of Object.entries(liveMods || {})) {
        if (!m || m.type === 'collection') continue;
        const a = m.attributes || {};
        if (a.modId == null || a.fileId == null) continue;
        installedFileIds.add(`${a.modId}:${a.fileId}`);
        if (!byNexus.has(String(a.modId))) byNexus.set(String(a.modId), []);
        byNexus.get(String(a.modId)).push({ key, a });
    }
    const out = [];
    for (const [id, dl] of Object.entries(downloadsFiles || {})) {
        if (!dl || dl.state !== 'finished' || claimed.has(id) || (dl.installed && dl.installed.modId)) continue;
        const ids = dl.modInfo && dl.modInfo.nexus && dl.modInfo.nexus.ids;
        if (!ids || ids.modId == null || ids.fileId == null) continue;
        if (installedFileIds.has(`${ids.modId}:${ids.fileId}`)) continue; // a file some mod is installed from: not old
        if (!planOldArchiveRemoval(id, liveMods, downloadsFiles, null).ok) continue; // kept on purpose: not offered
        const owners = (byNexus.get(String(ids.modId)) || []).filter(({ a }) => {
            if (!(Number(ids.fileId) < Number(a.fileId))) return false;
            const base = normName(a.logicalFileName);
            return !!base && normName(dl.localPath).startsWith(base + normName(String(ids.modId)));
        });
        if (owners.length !== 1) continue;
        const o = owners[0];
        out.push({ downloadId: id, vortexModId: o.key, name: o.a.modName || o.a.name || o.key, version: (dl.modInfo.meta && dl.modInfo.meta.fileVersion) || null, localPath: dl.localPath });
    }
    return out;
}

// The repair: delete the record and the file of each (re-validated against a fresh read), then check Vortex did
// not list the file again. Returns one result per download: { downloadId, name, ok, fileError, reregisteredRemoved }.
async function removeOldDownloads(bridge, downloadIds, { downloadsDir, sleep, pauseMs, deleteFile, log = console } = {}) {
    const modsData = await bridge.getAllMods();
    const dlData = await bridge.getAllDownloads();
    if (!modsData || !modsData.mods || !dlData || !dlData.files) {
        return downloadIds.map((id) => ({ downloadId: id, ok: false, reason: 'unconfirmed' }));
    }
    const valid = new Map(findOldDownloadsOfInstalledMods({ liveMods: modsData.mods, downloadsFiles: dlData.files }).map((x) => [x.downloadId, x]));
    const items = [];
    const results = [];
    for (const id of downloadIds) {
        const v = valid.get(id);
        if (!v) { results.push({ downloadId: id, ok: false, reason: 'unconfirmed' }); continue; }
        const plan = planOldArchiveRemoval(id, modsData.mods, dlData.files, null);
        if (!plan.ok) { results.push({ downloadId: id, name: v.name, ok: false, reason: plan.code === 'gone' ? 'unconfirmed' : plan.code }); continue; }
        plan.ids.forEach((rid, k) => items.push({ id: rid, name: k === 0 ? v.name : `${v.name} (duplicate record)`, primary: k === 0, forId: id }));
    }
    const cleared = await removeArchivesAndFiles(bridge, items, { downloadsFiles: dlData.files, mods: modsData.mods, downloadsDir, sleep, pauseMs, deleteFile, log });
    // One result per requested download; it is ok only when every record planned for it went and the file did.
    const byFor = new Map();
    cleared.forEach((c) => {
        const it = items.find((x) => x.id === c.id) || {};
        const key = it.forId || c.id;
        const prev = byFor.get(key) || { ok: true, fileError: undefined, rereg: false, unconfirmed: false, name: undefined };
        prev.ok = prev.ok && c.recordRemoved && !c.fileError;
        prev.unconfirmed = prev.unconfirmed || !c.recordRemoved;
        if (c.fileError) prev.fileError = c.fileError;
        prev.rereg = prev.rereg || c.reregisteredRemoved;
        if (it.primary) prev.name = it.name;
        byFor.set(key, prev);
    });
    for (const [key, v] of byFor) {
        results.push({ downloadId: key, name: v.name, ok: v.ok, fileError: v.fileError, reregisteredRemoved: v.rereg, reason: v.ok ? undefined : (v.fileError ? 'file-in-use' : 'unconfirmed') });
    }
    return results;
}

module.exports = {
    removeArchivesAndFiles, findOldDownloadsOfInstalledMods, removeOldDownloads,
    linkNewArchive, findStrayOwnArchives, repairStrayArchives,
    supportsArchiveId, resetVersionCache, pointAtNewArchive, finishArchiveChains, whyOldIsNotFree, planOldArchiveRemoval,
};
