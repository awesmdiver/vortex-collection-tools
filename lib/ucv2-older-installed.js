// Installed mods that are older than the collection lists (2026-10-24). A read-only classification of what Vortex has
// right now against the newest revision's file list; it is the answer to "is anything of this collection behind?".
// Bridge-free and pure: the caller hands in the live mods and its own identity matcher / version comparison.
//
// The rule, kept strict on purpose (a wrong "older" is worse than a missing one):
//   * only Nexus files with a mod id and a file id (a bundle entry's "version" can be the collection's own revision number);
//   * a listed file that is installed as exactly that file (resolve(source)) is up to date, whatever its version says;
//   * otherwise the mod PAGE is looked at, and only when exactly ONE installed mod is on that page, that installed mod is
//     not the exact file of some other entry, and the collection lists just ONE file from that page. Two files of one
//     page (House Cats: HeadT 2 and Pet the cats 2.1) are different files, never "2 is older than 2.1";
//   * the installed version must be provably lower (isOlder is false whenever either version cannot be read).

// mods: the new revision's mods (required and optional). liveMods: Vortex's mods by key. resolve(source) -> live key or null.
// nexusIndex: Map<String(modId), liveKey[]>. skipKeys: Set of "modId:fileId" already being handled (updated/added/removed).
function findOlderInstalled({ mods, liveMods, resolve, nexusIndex, isOlder, skipKeys }) {
    const nexus = (mods || []).filter((m) => m && m.source && m.source.type === 'nexus' && m.source.modId != null && m.source.fileId != null);
    const exactLiveKeys = new Set();
    const listedPerPage = new Map();
    for (const m of nexus) {
        const k = resolve(m.source);
        if (k) exactLiveKeys.add(k);
        const page = String(m.source.modId);
        listedPerPage.set(page, (listedPerPage.get(page) || 0) + 1);
    }
    const out = [];
    for (const m of nexus) {
        const id = `${m.source.modId}:${m.source.fileId}`;
        if (skipKeys && skipKeys.has(id)) continue;
        if (resolve(m.source)) continue; // this very file is installed
        const page = String(m.source.modId);
        if (listedPerPage.get(page) !== 1) continue;
        const candidates = (nexusIndex && nexusIndex.get(page)) || [];
        if (candidates.length !== 1) continue;
        const liveKey = candidates[0];
        if (exactLiveKeys.has(liveKey)) continue;
        const live = liveMods[liveKey];
        const attrs = (live && live.attributes) || {};
        if (!attrs.version || !isOlder(attrs.version, m.version)) continue;
        out.push({ mod: m, vortexModId: liveKey, installedVersion: String(attrs.version), attributes: attrs });
    }
    return out;
}

// The "old" side the update pipeline expects, built from what Vortex really holds (so the old file is found as installed).
function liveSourceOf(attrs, listedSource) {
    return {
        type: 'nexus', modId: listedSource.modId, fileId: attrs.fileId != null ? attrs.fileId : null,
        md5: attrs.fileMD5 || undefined, tag: attrs.referenceTag || undefined,
        logicalFilename: attrs.logicalFileName || listedSource.logicalFilename,
        updatePolicy: listedSource.updatePolicy,
    };
}

module.exports = { findOlderInstalled, liveSourceOf };
