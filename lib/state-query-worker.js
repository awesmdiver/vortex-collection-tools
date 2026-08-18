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

// Reported to the parent process over stderr (stdout is reserved for the single final JSON result
// line) so the web UI can show "Step X of 3" instead of a static spinner for a step that has no
// cheap way to report a real byte/percent progress (LevelDB has no O(1) key count, and this DB's
// own known native-crash history rules out adding an extra scan just to estimate one -- see
// runIsolatedStateQuery's header comment in collection-runner.js). Emitted at the START of each of
// the 3 real full-scan passes below, not on completion, since a single pass can itself take a
// while with no sub-progress of its own -- the user should see "Step 1 of 3" the moment it begins,
// not only once it's already done.
const PROGRESS_PREFIX = '##PROGRESS## ';
function reportProgress(step, total, label) {
    process.stderr.write(PROGRESS_PREFIX + JSON.stringify({ step, total, label }) + '\n');
}

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

// ONE scan over every Vortex mod-entry of type "collection", gathering everything BOTH
// Workshop-only detection AND cross-collection membership lookup need -- avoids a second full
// per-collection-key scan for the same data (this session's own "batch, don't multiply full DB
// scans" lesson, confirmed to matter for native-crash frequency, not just speed).
//
// Membership mirrors Vortex's OWN real algorithm -- confirmed by reading Vortex's actual source
// (github.com/Nexus-Mods/Vortex): generateCollectionMap (src/renderer/src/extensions/collections/
// index.ts), which backs the real "+2" badge in Vortex's own Mods page, prefers `rule.reference.id`
// (a direct live-modKey link) and falls back to content-identity matching (findModByRef.ts ->
// testModReference.ts's testRef) for a rule with no such id. CONFIRMED LIVE this session, on real
// collection-sourced rules, that `rule.reference.id` is simply never populated for this data shape
// -- every rule read from a collection's own `rules` array only ever carries the original
// repo-based reference (fileMD5, repo.modId/fileId, tag) it was built from. So the fallback path is
// what's actually exercised here, and this mirrors THAT: fileMD5 first (tied to the physical file,
// identical across every collection referencing it), then repo.modId+repo.fileId. Deliberately does
// NOT use `tag` for this cross-collection match -- confirmed live it's a deterministic-but-PER-
// COLLECTION value (see deterministicReferenceTag.ts): the exact same file had tag "q0OdB2bBFjKs"
// in one collection's rule and "XSaQ0ZgYLdg" in another's, for the identical fileMD5/repo pair --
// and Vortex's own testRef confirms a tag MISMATCH is not fatal there either, it falls through to
// fileMD5/repo, exactly like this does.
function ruleIdentityKeys(rule) {
    const ref = rule.reference || {};
    const keys = [];
    if (ref.fileMD5) keys.push(`md5:${ref.fileMD5}`);
    if (ref.repo?.modId != null && ref.repo?.fileId != null) keys.push(`id:${ref.repo.modId}:${ref.repo.fileId}`);
    return keys;
}
async function scanAllCollections(db, stagingDir) {
    const collectionKeys = [];
    for await (const [key, value] of db.iterator()) {
        const m = key.match(/^persistent###mods###skyrimse###(.+)###type$/);
        if (m) {
            try { if (JSON.parse(value) === 'collection') collectionKeys.push(m[1]); } catch { /* not a collection */ }
        }
    }
    const workshopOnly = [];
    const membership = new Map(); // vortexModId (live modKey) -> [{collectionModId, collectionName}]
    for (const key of collectionKeys) {
        const prefix = `persistent###mods###skyrimse###${key}###`;
        let customFileName, attrName, installationPath, source, collectionSlug, localRevisionNumber, rulesRaw;
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
            if (field === 'rules') rulesRaw = v;
        }
        const collectionName = customFileName || attrName || key;

        let rules = [];
        try { rules = JSON.parse(rulesRaw); } catch { /* no rules, or unreadable -- treat as none */ }
        for (const rule of rules) {
            for (const idKey of ruleIdentityKeys(rule)) {
                if (!membership.has(idKey)) membership.set(idKey, []);
                const list = membership.get(idKey);
                if (!list.some((c) => c.collectionModId === key)) list.push({ collectionModId: key, collectionName });
            }
        }

        // Previously skipped any collection whose folder already had a collection.json, on the
        // assumption that meant "now a real, scannable staging folder, let the main list handle
        // it." Confirmed wrong (2026-07-24): a Workshop collection gets a collection.json written
        // to its root while actively being edited/re-packaged in Vortex's own Workshop UI, or via
        // this tool's own "Fetch from Nexus" -- neither makes it a real installed collection, so
        // that check isn't the right signal. But `type === 'collection'` alone isn't enough either
        // -- a REAL, actually-installed collection has that same type, just keyed by its own
        // archive-derived modId (confirmed live: without a further check here, all 7 of the user's
        // real installed collections leaked into this same Workshop-only list, alongside their
        // correct appearance in the main list too). The real distinguishing signal, confirmed
        // against a real install (2026-07-24): only Vortex's own raw "vortex_collection_<id>"
        // modId naming means "tracked in the Workshop tab" -- a real install always gets renamed to
        // the archive-derived form (<Name>-<modId>-<version>-<timestamp>) once installed. See
        // scanStagingCollections in vortex-sync/lib.js for the exact same signal, applied to
        // exclude these from the main list instead.
        if (!/^vortex_collection_/i.test(key)) continue;
        const folder = installationPath || key;
        workshopOnly.push({
            name: collectionName, source: source || null, modId: key, folder,
            collectionSlug: collectionSlug || null, localRevisionNumber: localRevisionNumber ?? null,
        });
    }
    return { workshopOnly, membership };
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
        reportProgress(1, 3, 'Finding currently-installed mods…');
        const matches = allRefs.length > 0 ? await syncLib.findCurrentModIds(db, allRefs) : [];
        const matchByKey = new Map(matches.map((m) => [refKey(m.matchedRef), m.vortexModId]));

        // Second full-scan pass (same already-open DB, no extra process/risk) -- see
        // buildModVersionIndex's own comment for why version/fileId, not modVersion/isPrimary.
        reportProgress(2, 3, 'Indexing installed mod versions…');
        const modVersionIndex = await buildModVersionIndex(db);

        // Third full-scan pass (same already-open DB) -- see scanAllCollections' own comment for
        // why this mirrors Vortex's real generateCollectionMap instead of guessing at one.
        reportProgress(3, 3, 'Scanning collections for shared mods…');
        const scan = stagingDir ? await scanAllCollections(db, stagingDir) : { workshopOnly: [], membership: new Map() };

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
            // Which OTHER installed collections also reference this exact mod (by content identity
            // -- fileMD5 then repo.modId+fileId, see scanAllCollections/ruleIdentityKeys for why),
            // only meaningful once this mod is confirmed actually installed somewhere (matched via
            // findCurrentModIds), so a mod nobody has ever staged doesn't spuriously show as
            // "shared". Excludes this collection itself. Real, confirmed-live case this was built
            // for: "Dragon Priests Retexture SE - Half Res" shared by 3 collections with different
            // recorded FOMOD choices for the identical file -- a FAILED_MISMATCH_NOT_TOUCHED here is
            // much easier to reason about once you know it's not a corrupted/wrong extraction, just
            // a different collection's own choices for a mod they both happen to depend on.
            const sharedWithCollectionsByKey = {};
            for (const mod of pc.keptMods) {
                const key = refKey({ modId: mod.source.modId, fileId: mod.source.fileId });
                if (!matchByKey.has(key)) continue;
                const idKeys = [];
                if (mod.source.md5) idKeys.push(`md5:${mod.source.md5}`);
                if (mod.source.modId != null && mod.source.fileId != null) idKeys.push(`id:${mod.source.modId}:${mod.source.fileId}`);
                let entries = null;
                for (const idKey of idKeys) {
                    if (scan.membership.has(idKey)) { entries = scan.membership.get(idKey); break; }
                }
                if (!entries) continue;
                const others = entries.filter((c) => c.collectionModId !== modId);
                if (others.length > 0) sharedWithCollectionsByKey[key] = others;
            }
            out[modId] = {
                ignored: pc.ignored, removedMods: pc.removedMods, keptMods: pc.keptMods, knownVortexModIdEntries,
                otherVersionsByModId, sharedWithCollectionsByKey, liveName: pc.liveName, collectionSlug: pc.collectionSlug,
            };
        }
        // Reserved key, not a real collectionModId (those are always real staging folder names) --
        // batch-wide, doesn't depend on which collections were requested since these collections
        // were never found by scanStagingCollections in the first place (no collection.json to scan).
        out.__workshopOnly = scan.workshopOnly;
        return out;
    });

    process.stdout.write(JSON.stringify(results));
}

main().catch((e) => {
    process.stderr.write(e.message || String(e));
    process.exit(1);
});
