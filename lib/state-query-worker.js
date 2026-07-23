#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Runs Vortex-live-state reads (ignored mods, kept/removed, findCurrentModIds) for ONE OR MORE
// collections in a SINGLE ISOLATED child process, sharing ONE withStateDb open across all of
// them. Confirmed this session, reproducibly, across multiple different collections: classic-
// level/LevelDB can hit a native assertion crash reading certain real-world write-ahead-log
// shapes, even with Vortex fully closed. A native crash is unrecoverable in-process, so this MUST
// run outside whatever process called it (critical for web/server.js).
//
// IMPORTANT cost characteristic, confirmed by reading vortex-collection-sync's findCurrentModIds:
// its full-scan fallback (which every ref hits here -- we never have a Vortex-internal vortexModId
// to fast-path on) is O(total mods installed across the ENTIRE Vortex profile), NOT O(mods in one
// collection) -- it enumerates every "persistent###mods###..." key once, then does 4 attribute
// reads per unique id, regardless of how many refs you're trying to match against. Calling it once
// PER COLLECTION (this file's first version) therefore multiplied total DB work by the number of
// collections batched -- confirmed empirically this session: batching 21 collections crashed MORE
// reliably than single-collection reads had, not less, because each batch held the DB open through
// 21x the read volume. Fixed by combining every collection's refs into ONE findCurrentModIds call
// (single full scan for the whole batch, whether it's 1 collection or 21) and distributing the
// matches back out afterward -- this is the actual fix, not just "isolate and hope."
//
// Protocol: reads one JSON line from stdin {state, collections: [{modId, collection}, ...]}.
// Writes one JSON line to stdout on success: {<modId>: {ignored, removedMods, keptMods,
// knownVortexModIdEntries} | {error: "..."}, ...} -- one entry PER requested collection; a
// per-collection failure in the CHEAP per-collection steps (getRules/computeSync -- e.g. Vortex
// hasn't written that mod to its state yet) is captured inline rather than aborting the whole
// batch. A native crash during the shared DB open still fails the whole process (nothing can be
// salvaged once that happens) -- surfaced to the parent as a non-zero/abnormal exit.

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

function refKey(ref) {
    return `${ref.modId}:${ref.fileId}`;
}

// Builds modId -> [{key, version, fileId, variant, installationPath, enabledProfiles}] for EVERY
// mod Vortex has ever installed (any collection, any game-profile), in ONE pass over the DB --
// lets a mod with no archive/no staging folder for the SPECIFIC file+version a collection pins
// still be cross-referenced against a DIFFERENT version of the same modId that IS installed
// elsewhere (e.g. a newer file brought in by another collection). Confirmed necessary via a real
// case this session: "powerofthree's Tweaks" pinned at an old fileId by one collection had no
// archive/folder for that exact file, while a newer fileId of the SAME modId was already installed
// (and enabled) via a different collection -- worth surfacing, not just silently "no archive".
// `version`/`fileId` are the fields Vortex's OWN update-checking code actually trusts (confirmed by
// reading Vortex's real source, modUpdateState.ts) -- NOT `modVersion` (a separate, install-time-only
// field that can go stale after a manual version switch and isn't used by Vortex itself for
// anything) and NOT `isPrimary` (a Nexus "main file" designation, unrelated to local install state).
async function buildModVersionIndex(db) {
    const keyToInfo = new Map();
    const enabledByKey = new Map();
    for await (const [key, value] of db.iterator()) {
        let m = key.match(/^persistent###mods###skyrimse###(.+?)###attributes###(modId|version|fileId|variant)$/);
        if (m) {
            const [, modKey, field] = m;
            if (!keyToInfo.has(modKey)) keyToInfo.set(modKey, {});
            try { keyToInfo.get(modKey)[field] = JSON.parse(value); } catch { keyToInfo.get(modKey)[field] = value; }
            continue;
        }
        m = key.match(/^persistent###mods###skyrimse###(.+?)###installationPath$/);
        if (m) {
            if (!keyToInfo.has(m[1])) keyToInfo.set(m[1], {});
            try { keyToInfo.get(m[1]).installationPath = JSON.parse(value); } catch { keyToInfo.get(m[1]).installationPath = value; }
            continue;
        }
        m = key.match(/^persistent###profiles###(.+?)###modState###(.+?)###enabled$/);
        if (m) {
            let val;
            try { val = JSON.parse(value); } catch { val = false; }
            if (val === true) {
                if (!enabledByKey.has(m[2])) enabledByKey.set(m[2], new Set());
                enabledByKey.get(m[2]).add(m[1]);
            }
        }
    }
    const byModId = new Map();
    for (const [key, info] of keyToInfo) {
        if (info.modId == null) continue;
        info.key = key;
        info.enabledProfiles = enabledByKey.has(key) ? [...enabledByKey.get(key)] : [];
        if (!byModId.has(info.modId)) byModId.set(info.modId, []);
        byModId.get(info.modId).push(info);
    }
    return byModId;
}

// Every mod Vortex tracks as type==="collection" that has NO collection.json in its own staging
// folder -- confirmed live this session these fall into exactly two real categories: (1) a true
// Workshop-only collection never published/downloaded at all (source: "user-generated"), or (2) a
// collection the user HAS published to Nexus (source: "nexus") but is still curating locally via
// the Workshop rather than having downloaded the packaged release. Either way, this tool has
// nothing to extract from without a real collection.json -- surfaced here so the picker can show
// an explicit, actionable note (publish + download to get a real collection.json) instead of the
// collection just silently never appearing with no explanation.
async function findWorkshopOnlyCollections(db, stagingDir) {
    const collectionKeys = [];
    for await (const [key, value] of db.iterator()) {
        const m = key.match(/^persistent###mods###skyrimse###(.+)###type$/);
        if (m) {
            try { if (JSON.parse(value) === 'collection') collectionKeys.push(m[1]); } catch { /* not a collection */ }
        }
    }
    const results = [];
    for (const key of collectionKeys) {
        const prefix = `persistent###mods###skyrimse###${key}###`;
        let customFileName, attrName, installationPath, source, collectionSlug, localRevisionNumber;
        for await (const [k, v] of db.iterator({ gte: prefix, lte: `${prefix}\xff` })) {
            const field = k.replace(prefix, '');
            if (field === 'attributes###customFileName') { try { customFileName = JSON.parse(v); } catch { /* ignore */ } }
            // attributes###name is the collection's own published/display name (e.g. "My PBR 4K
            // Upgrade") -- confirmed live this session as the fallback Vortex itself falls back to
            // when the user hasn't locally renamed the mod entry (no customFileName set). The prior
            // version had no such fallback and fell straight through to the raw staging-folder key
            // (e.g. "vortex_collection_1_KVpeFCG") whenever customFileName was absent -- confirmed
            // this is common: most collections here have no customFileName at all.
            if (field === 'attributes###name') { try { attrName = JSON.parse(v); } catch { /* ignore */ } }
            if (field === 'installationPath') { try { installationPath = JSON.parse(v); } catch { /* ignore */ } }
            if (field === 'attributes###source') { try { source = JSON.parse(v); } catch { /* ignore */ } }
            // The collection's own Nexus slug -- always correct regardless of which revision is
            // published, safe to auto-fill into the fetch UI's id field. NOT true of
            // attributes###revisionNumber below: confirmed live this session (user's own report)
            // that this is the LOCAL/Workshop revision currently being edited, which can be AHEAD
            // of whatever's actually published to Nexus (e.g. local revision 2, only revision 1
            // published) -- auto-filling the fetch UI's revision field with this value would
            // actively mislead the user into requesting a revision that doesn't exist or isn't the
            // one they think it is. Surfaced as an informational hint only, never auto-filled.
            if (field === 'attributes###collectionSlug') { try { collectionSlug = JSON.parse(v); } catch { /* ignore */ } }
            if (field === 'attributes###revisionNumber') { try { localRevisionNumber = JSON.parse(v); } catch { /* ignore */ } }
        }
        const folder = installationPath || key;
        const collectionJsonPath = path.join(stagingDir, folder, 'collection.json');
        if (fs.existsSync(collectionJsonPath)) continue;
        results.push({
            name: customFileName || attrName || folder, source: source || null, modId: key, folder,
            collectionSlug: collectionSlug || null, localRevisionNumber: localRevisionNumber ?? null,
        });
    }
    return results;
}

async function main() {
    const { state, collections, stagingDir, syncLibPath } = JSON.parse(await readStdin());
    const syncLib = require(syncLibPath);

    const results = await syncLib.withStateDb(state, async (db) => {
        // Cheap pass first (plain key reads, no full scan): per-collection ignored/kept/removed,
        // and the combined ref list every collection's keptMods contributes to the ONE shared scan.
        const perCollection = {};
        const allRefs = [];
        for (const { modId, collection } of collections) {
            try {
                const rules = await syncLib.getRules(db, modId);
                const ignored = syncLib.extractIgnored(rules);
                const { removedMods, keptMods } = syncLib.computeSync(collection, ignored, []);
                // The collection's OWN live display name, as Vortex currently shows it -- can differ
                // from collection.json's own info.name (the original published name) if the user
                // renamed their local copy (a common convention: prefixing personal collections with
                // "My "). A single cheap key read (not a scan), not the expensive part of this worker.
                let liveName;
                try {
                    const raw = await syncLib.getModValue(db, modId, 'attributes###customFileName');
                    if (raw !== undefined) liveName = JSON.parse(raw);
                } catch { /* no live name available -- caller falls back to collection.json's own name */ }
                // The collection's Nexus slug -- lets the "View on Nexus" button work for an
                // ALREADY-installed collection too, not just Workshop-only ones (which already had
                // this via findWorkshopOnlyCollections). Same cheap single-key read, no full scan.
                let collectionSlug;
                try {
                    const raw = await syncLib.getModValue(db, modId, 'attributes###collectionSlug');
                    if (raw !== undefined) collectionSlug = JSON.parse(raw);
                } catch { /* no slug known -- caller disables the "View on Nexus" button */ }
                perCollection[modId] = { ok: true, ignored, removedMods, keptMods, liveName, collectionSlug };
                for (const mod of keptMods) {
                    // A "browse" (non-Nexus, e.g. Google Drive) source has no modId/fileId at all --
                    // every such mod shares the identical "undefined:undefined" refKey, so including
                    // them here would let findCurrentModIds' one match silently win for ALL of them,
                    // not just the mod it actually belongs to. Confirmed live: 4 browse-type mods in
                    // one real collection all resolved to the SAME targetFolderName (whichever one's
                    // match happened to be inserted last), and only the one that genuinely owned that
                    // folder succeeded -- the other 3 correctly failed their safety diff (nothing was
                    // corrupted) but were wrongly blocked. These mods have no stable Vortex-tracked
                    // identity to look up anyway -- skip them entirely and let classifyMod fall back
                    // to archiveBaseName, which is the correct target for a non-Nexus mod.
                    if (mod.source.modId == null || mod.source.fileId == null) continue;
                    allRefs.push({
                        modId: mod.source.modId, fileId: mod.source.fileId,
                        fileMD5: mod.source.md5, tag: mod.source.tag,
                    });
                }
            } catch (e) {
                perCollection[modId] = { ok: false, error: e.message };
            }
        }

        // The one expensive operation (full scan of every installed mod), run EXACTLY ONCE for
        // the whole batch regardless of how many collections were requested.
        const matches = allRefs.length > 0 ? await syncLib.findCurrentModIds(db, allRefs) : [];
        const matchByKey = new Map(matches.map((m) => [refKey(m.matchedRef), m.vortexModId]));

        // Second full-scan pass (same already-open DB, no extra process/risk) -- see
        // buildModVersionIndex's own comment for why version/fileId, not modVersion/isPrimary.
        const modVersionIndex = await buildModVersionIndex(db);

        const out = {};
        for (const { modId } of collections) {
            const pc = perCollection[modId];
            if (!pc.ok) {
                out[modId] = { error: pc.error };
                continue;
            }
            const knownVortexModIdEntries = pc.keptMods
                .map((mod) => {
                    const key = refKey({ modId: mod.source.modId, fileId: mod.source.fileId });
                    const vortexModId = matchByKey.get(key);
                    return vortexModId ? [key, vortexModId] : null;
                })
                .filter(Boolean);
            // Only for mods where the SPECIFIC pinned file has no exact match -- if it matched,
            // existingStagingFolder will already be true and there's nothing to flag. Keyed by the
            // mod's own Nexus modId (as a string, JSON object keys are always strings) so
            // classifyMod can look it up directly by mod.source.modId.
            const otherVersionsByModId = {};
            for (const mod of pc.keptMods) {
                if (mod.source.modId == null) continue;
                const key = refKey({ modId: mod.source.modId, fileId: mod.source.fileId });
                if (matchByKey.has(key)) continue;
                const entries = modVersionIndex.get(mod.source.modId);
                if (entries && entries.length > 0) otherVersionsByModId[mod.source.modId] = entries;
            }
            out[modId] = { ignored: pc.ignored, removedMods: pc.removedMods, keptMods: pc.keptMods, knownVortexModIdEntries, otherVersionsByModId, liveName: pc.liveName, collectionSlug: pc.collectionSlug };
        }
        // Reserved key, not a real collectionModId (those are always real staging folder names) --
        // batch-wide, doesn't depend on which collections were requested since these collections
        // were never found by scanStagingCollections in the first place (no collection.json to scan).
        out.__workshopOnly = stagingDir ? await findWorkshopOnlyCollections(db, stagingDir) : [];
        return out;
    });

    process.stdout.write(JSON.stringify(results));
}

main().catch((e) => {
    process.stderr.write(e.message || String(e));
    process.exit(1);
});
