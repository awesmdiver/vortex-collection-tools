'use strict';
// Continue Update / review classification against what Vortex ALREADY holds (2026-10-23, "Gate To
// Sovngarde" Rev 118, a run that died when Vortex ran out of memory).
//
// The review diffs the collection's LOCAL collection.json (only replaced after a clean apply, so it
// still holds the previous revision) against the new revision. After a run that got partway, most of
// the "Update" rows are mods whose NEW file is already installed. Real numbers from that run: of 55
// pairs, 54 already had the new file installed with the new file id / version / md5 saved, and the
// collection's own rules already pointed at the new file for 50 of them. This module looks at the live
// state and moves each pair to where it really belongs. Pure functions: no Bridge calls, no writes.
//
//   * alreadyNew   -- the live mod already is the new revision's file (same file id / md5 / tag). Never
//                     an update. (Rules: identical file ids = not an update, ever.)
//   * finishDetails-- the installed mod's saved details are stale (still the old file id / md5), but
//                     the new file is provably in place: a download record with the new md5 is linked
//                     to that very mod. A light step re-saves the details (set-attributes, nothing else).
//   * removed      -- a mod the new revision still lists (exact modId + fileId, optional ones included)
//                     is never "removed"; one that is not installed at all is flagged notInstalled.
//   * duplicates   -- two live mod records for the same file; reported, never merged or removed.

const { choicesEqual } = require('./collection-diff');
const { isRealFomodChoices } = require('./vortex-live-fomod-choices');

// Are the new revision's install picks already what the installed mod has? Compared with what is INSTALLED
// (the mod's live installerChoices), not with the old collection record: a mod the previous apply already
// installed with the new picks is not "install options changed" again. Nothing to replay (the new revision
// records no picks) counts as done; with no live picks to compare, fall back to old record vs new.
function installPicksAlreadyApplied(liveMod, u) {
    const newChoices = u.new && u.new.choices;
    if (!isRealFomodChoices(newChoices)) return true;
    const live = liveMod && liveMod.attributes && liveMod.attributes.installerChoices;
    if (isRealFomodChoices(live)) return choicesEqual(live, newChoices);
    return choicesEqual(u.old && u.old.choices, newChoices);
}

// What Apply itself writes after a re-extract (update-collection-v2-runner.js runApply, the Updated
// loop). Kept in one place so "Finish saving details" writes exactly the same fields.
function buildDetailsAttributes(newMod) {
    const s = newMod.source || {};
    return {
        version: newMod.version, modName: newMod.name,
        fileMD5: s.md5, modId: s.modId, fileId: s.fileId, fileSize: s.fileSize,
        logicalFileName: s.logicalFilename, referenceTag: s.tag,
    };
}

// Vortex's own "is there an update" rule (src/renderer/src/extensions/mod_management/util/modUpdateState.ts,
// updateState; read 2026-10-23, our fork at the time). The arrow shows when newestFileId differs from fileId,
// newestFileId is "unknown", or newestVersion differs from version. The hover text "(Current version: X)" prints
// attributes.newestVersion, so "?" means that attribute is missing. Kept as a pure function so a test can pin it.
function vortexUpdateState(attrs) {
    const a = attrs || {};
    if (!a.source) return 'current';
    const clean = (v) => String(v).replace(/^v/i, '').trim();
    const hasNewerVersion = a.revisionId !== undefined
        ? parseInt(a.newestVersion ?? '0', 10) > parseInt(a.version ?? '0', 10)
        : (a.newestVersion !== undefined && a.version !== undefined && clean(a.newestVersion) !== clean(a.version));
    const hasUpdate = a.newestFileId === 'unknown'
        || (a.newestFileId && a.fileId && String(a.newestFileId) !== String(a.fileId))
        || hasNewerVersion;
    return hasUpdate ? 'update' : 'current';
}

// The "newest" fields to write next to an updated mod's details, so Vortex does not keep showing the update arrow
// for a file that is already installed. The collection pins exactly this file, so it is the newest the person is
// meant to have; Vortex's own next update check puts the truth back. Never lowers a newer file Vortex recorded
// (compared with the value read just before our write) and never touches "unknown" (Vortex says an update exists).
function newestFieldsFor(liveAttrs, fileId, version) {
    if (fileId == null) return {};
    const n = liveAttrs && liveAttrs.newestFileId;
    if (n === 'unknown') return {};
    if (n != null && n !== '' && Number(n) > Number(fileId)) return {};
    return { newestFileId: fileId, newestVersion: version };
}

// Mods on the file the collection asks for that still show the arrow only because of stale newest* values.
// identities: Set of "modId:fileId" the new revision asks for. Returns [{ vortexModId, name, version, attributes }].
function findStaleUpdateArrows({ liveMods, identities }) {
    const out = [];
    for (const [key, m] of Object.entries(liveMods || {})) {
        if (!m || m.type === 'collection') continue;
        const a = m.attributes || {};
        if (a.modId == null || a.fileId == null || !identities.has(`${a.modId}:${a.fileId}`)) continue;
        if (vortexUpdateState(a) !== 'update') continue;
        const fields = newestFieldsFor(a, a.fileId, a.version);
        if (!fields.newestFileId) continue; // a newer file Vortex recorded, or "unknown": leave it
        out.push({ vortexModId: key, name: a.modName || a.name || key, version: a.version ?? null, attributes: fields });
    }
    return out;
}

function sameFileId(a, b) {
    return a != null && b != null && String(a) === String(b);
}

// Is there a download record for the NEW file's md5 that belongs to this very mod? (linked through the
// record's own installed.modId, or through the mod's archiveId). Files-on-disk proof without touching disk.
function newFileProvenFor(vortexModId, liveMod, newMd5, downloadsFiles) {
    if (!newMd5 || !downloadsFiles) return false;
    const attrs = (liveMod && liveMod.attributes) || {};
    const archiveId = (liveMod && liveMod.archiveId) || attrs.archiveId;
    if (archiveId && downloadsFiles[archiveId] && downloadsFiles[archiveId].fileMD5 === newMd5) return true;
    for (const dl of Object.values(downloadsFiles)) {
        if (dl && dl.fileMD5 === newMd5 && dl.installed && dl.installed.modId === vortexModId) return true;
    }
    return false;
}

function classifyUpdatedPairs({ updated, liveMods, resolve, resolveCandidate, downloadsFiles }) {
    const stillUpdated = [];
    const alreadyNew = []; // the NEW mod objects (same shape as diff.unchanged entries)
    const finishDetails = []; // { mod, vortexModId, attributes, was: {fileId, version} }
    const notInstalled = []; // the NEW mod objects of pairs whose mod is not in Vortex at all: installed as new, never "updated"
    for (const u of updated) {
        const newKey = resolve(u.new.source);
        if (newKey) {
            // Choices-only changes (same file, other FOMOD picks) are real updates; the file itself is done.
            if (installPicksAlreadyApplied(liveMods && liveMods[newKey], u)) {
                alreadyNew.push(u.new);
                continue;
            }
            // The new file is in place but the install picks are the old ones: real work is left, and it is
            // the picks only (the row says so instead of a version arrow).
            stillUpdated.push({ ...u, fileChanged: false, fileAlreadyNew: true, liveKey: newKey });
            continue;
        }
        const candKey = resolveCandidate ? resolveCandidate(u) : null;
        const cand = candKey && liveMods ? liveMods[candKey] : null;
        if (cand && sameFileId(cand.attributes && cand.attributes.fileId, u.new.source && u.new.source.fileId)) {
            alreadyNew.push(u.new);
            continue;
        }
        if (cand && newFileProvenFor(candKey, cand, u.new.source && u.new.source.md5, downloadsFiles)) {
            const a = cand.attributes || {};
            finishDetails.push({ mod: u.new, vortexModId: candKey, attributes: { ...buildDetailsAttributes(u.new), ...newestFieldsFor(cand.attributes, u.new.source && u.new.source.fileId, u.new.version) }, was: { fileId: a.fileId ?? null, version: a.version ?? null } });
            continue;
        }
        // Nothing in Vortex for the old file, the new file or any other file of this mod: there is nothing to update.
        if (!cand && !resolve(u.old.source)) { notInstalled.push(u.new); continue; }
        stillUpdated.push(u);
    }
    return { stillUpdated, alreadyNew, finishDetails, notInstalled };
}

// ruleIdentities (optional Set of "modId:fileId" the collection's LIVE rules still name): a removal for a mod that
// is not installed AND has no rule left has nothing to do any more (an earlier, partly finished apply did it), so it is dropped.
function classifyRemoved({ removed, newModsAll, resolve, ruleIdentities }) {
    const stillListed = new Set((newModsAll || [])
        .filter((m) => m.source && m.source.modId != null && m.source.fileId != null)
        .map((m) => `${m.source.modId}:${m.source.fileId}`));
    const kept = [];
    const stillRequired = []; // the new revision still lists this exact file: never a removal
    for (const m of removed) {
        const id = m.source && m.source.modId != null && m.source.fileId != null ? `${m.source.modId}:${m.source.fileId}` : null;
        if (id && stillListed.has(id)) { stillRequired.push(m); continue; }
        const notInstalled = !resolve(m.source);
        if (notInstalled && ruleIdentities && id && !ruleIdentities.has(id)) continue; // already finished
        kept.push({ ...m, notInstalled });
    }
    return { removed: kept, stillRequired };
}

// Groups of live records that hold the same file (same modId + fileId, or same md5) where at least one
// matches an identity in `identities` (a Set of "modId:fileId" for this revision). Reported only.
// Are two live mods that carry the SAME Nexus ids really the same thing? (2026-10-24: "Modified Overlay Meshes" has a
// tiny archive of the collection author's own, but its saved details were copied from RaceMenu, so it carries
// RaceMenu's modId:fileId; the old test called the two copies of each other.) The ids alone prove nothing. Evidence,
// from the archive each mod points at (the download record, not the mod's own copied details):
//   * both archives known: the same file name, or the same md5 when both have one, or (no md5 on either) the same size;
//     a different md5, a different size or a different name means NOT the same;
//   * an archive unknown on either side: only an equal mod name stem counts ("can't tell" otherwise, and it is not listed).
// A mod belonging to several collections is one mod: collections are never part of this test.
function normStem(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function sameThing(a, b, downloadsFiles) {
    const dA = downloadsFiles && (a.archiveId || a.attrs.archiveId) ? downloadsFiles[a.archiveId || a.attrs.archiveId] : null;
    const dB = downloadsFiles && (b.archiveId || b.attrs.archiveId) ? downloadsFiles[b.archiveId || b.attrs.archiveId] : null;
    if (dA && dB) {
        if (dA === dB) return true;
        if (dA.localPath && dB.localPath && dA.localPath === dB.localPath) return true;
        if (dA.fileMD5 && dB.fileMD5) return String(dA.fileMD5).toLowerCase() === String(dB.fileMD5).toLowerCase();
        if (dA.size != null && dB.size != null) return Number(dA.size) === Number(dB.size) && !(dA.localPath && dB.localPath);
        return false; // can't tell
    }
    const nA = normStem(a.attrs.modName || a.attrs.name);
    return !!nA && nA === normStem(b.attrs.modName || b.attrs.name);
}

function findDuplicateCopies({ liveMods, identities, hasFiles, downloadsFiles }) {
    const byId = new Map();
    for (const [key, m] of Object.entries(liveMods || {})) {
        const a = m.attributes || {};
        if (a.modId == null || a.fileId == null || m.type === 'collection') continue;
        const id = a.modId + ':' + a.fileId;
        if (!identities.has(id)) continue;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push({ key, m, attrs: a, archiveId: m.archiveId });
    }
    const out = [];
    for (const entries of byId.values()) {
        if (entries.length < 2) continue;
        // clusters of entries that are really the same thing (transitively)
        const clusters = [];
        for (const e of entries) {
            const hit = clusters.find((c) => c.some((x) => sameThing(x, e, downloadsFiles)));
            if (hit) hit.push(e); else clusters.push([e]);
        }
        for (const c of clusters) {
            if (c.length < 2) continue;
            out.push(c.map(({ key, m, attrs }) => ({
                vortexModId: key, name: attrs.name || attrs.modName || key, version: attrs.version ?? null, fileId: attrs.fileId,
                archiveLinked: !!(m.archiveId || attrs.archiveId), hasFiles: hasFiles ? !!hasFiles(key, m) : null,
            })));
        }
    }
    return out;
}

// One downloads read for a whole review, memoized; a failed read is tried once more after a pause before giving
// up (null = "could not check", never "nothing found"). read() resolves to { files } or a falsy value.
function createDownloadsReader(read, pause) {
    let memo;
    return async function readDownloadsOnce() {
        if (memo !== undefined) return memo;
        let dls = await Promise.resolve().then(read).catch(() => null);
        if (!(dls && dls.files)) {
            await Promise.resolve().then(pause).catch(() => {});
            dls = await Promise.resolve().then(read).catch(() => null);
        }
        memo = dls && dls.files ? dls : null;
        return memo;
    };
}

// The picks-only group: mods whose NEW file is installed and whose only difference is the install picks. The person
// can say "they already have the new options" (an earlier apply reinstalled them before it saved the picks); the tool
// then writes the new picks as the mod's installerChoices and installs nothing again.
function picksOnlyMods(updated) {
    return (updated || []).filter((u) => u.fileAlreadyNew && u.liveKey).map((u) => ({
        vortexModId: u.liveKey, name: u.new.name, version: u.new.version ?? null,
        fileId: u.new.source && u.new.source.fileId, attributes: { installerChoices: u.new.choices },
    }));
}

// What "They already have the new options" may write, checked against Vortex as it is NOW: only for a wanted mod whose
// installed file is the new one; the write is the picks and nothing else. Returns { writes:[{vortexModId,name,attributes}], refused:[{vortexModId,name}] }.
function planConfirmNewOptions(items, wantedIds, liveMods) {
    const wanted = new Set(wantedIds || []);
    const writes = [];
    const refused = [];
    for (const item of items || []) {
        if (!wanted.has(item.vortexModId)) continue;
        const attrs = liveMods && liveMods[item.vortexModId] && liveMods[item.vortexModId].attributes;
        if (!attrs || String(attrs.fileId) !== String(item.fileId)) { refused.push({ vortexModId: item.vortexModId, name: item.name }); continue; }
        writes.push({ vortexModId: item.vortexModId, name: item.name, attributes: { installerChoices: item.attributes.installerChoices } });
    }
    return { writes, refused };
}

module.exports = {
    sameThing,
    planConfirmNewOptions,
    picksOnlyMods,
    installPicksAlreadyApplied,
    vortexUpdateState, newestFieldsFor, findStaleUpdateArrows,
    createDownloadsReader, classifyUpdatedPairs, classifyRemoved, findDuplicateCopies, buildDetailsAttributes, newFileProvenFor };
