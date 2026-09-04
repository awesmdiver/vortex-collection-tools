'use strict';
// Detection + cleanup engine for the "Duplicate Version Cleanup" tool (Utilities). Detection is a
// faithful port of scripts/list-vortex-version-groups.js's own real algorithm -- see that script's
// header comment for the full mechanism this reproduces (Vortex's own real Version-dropdown grouping:
// byModId -> fileMatch -> byEnabled, plus orphan-attachment by fileMD5/filename-modId-token match).
// Keep this in sync with that script rather than letting the two drift; the script stays as a
// standalone read-only diagnostic, this module is what the tool's own routes call.
//
// The cleanup recipe is the "remove, redownload, reinstall, replay FOMOD, reassign" recipe this
// project's own investigation confirmed is the ONLY one that survives a Vortex restart -- see
// diagnostics/2026-09-01-duplicate-download-persistence-investigation.md (record-only removal is
// confirmed broken) and design/SPEC-duplicate-version-cleanup-tool.md (the functional spec this
// implements, including the shared-archive and legit-vs-orphan safety rules below).
//
// Scope decision (2026-09-01 build, flagged in the handoff): a duplicate GROUP's non-survivor
// entries are, in every real case found this session, orphaned/unclaimed DOWNLOAD records -- a
// second genuinely-INSTALLED (if disabled) real mod sharing the same fileMatch bucket is a rare,
// different problem (it has its own staging folder, possibly its own separate collection
// memberships) that this build deliberately does NOT auto-remove -- it's always surfaced as `kind:
// 'legit'` with its own note, same as a content-different orphan another collection still needs, and
// is never touched by the group checkbox. Only orphaned DOWNLOAD entries are ever candidates for
// real removal.

const syncLib = require('./vortex-sync/lib');
const helperClient = require('./vortex-helper-client');
const { buildModFromLiveData } = require('./build-mod-from-vortex-state');
const { rebuildSingleMod } = require('./rebuild-single-mod');
const {
    buildCollectionMembershipRule, resolveOrRegisterArchiveId,
} = require('./update-collection-v2-runner');

function normalizeForNameMatch(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// Direct port of modGrouping.ts's own logicalName/fileMatch (see scripts/list-vortex-version-groups.js
// for the full citation) -- Vortex's real second-stage grouping within a modId bucket.
function logicalName(attrs) {
    if (!attrs.logicalFileName || !attrs.version) return attrs.logicalFileName;
    return attrs.logicalFileName.split(attrs.version).join('').trim();
}
function fileMatch(a, b) {
    if (a.newestFileId && a.modId !== undefined && a.newestFileId === b.newestFileId) return true;
    if (a.logicalFileName && logicalName(a) === logicalName(b)) return true;
    return false;
}
function versionCompareDesc(a, b) {
    const pa = String(a || '0').split(/[.-]/).map((n) => parseInt(n, 10));
    const pb = String(b || '0').split(/[.-]/).map((n) => parseInt(n, 10));
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const na = pa[i] || 0; const nb = pb[i] || 0;
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return nb - na;
    }
    return String(b || '').localeCompare(String(a || ''));
}
// Direct port of modGrouping.ts's own byEnabled (see scripts/list-vortex-version-groups.js) -- two or
// more simultaneously-enabled real installs never share one dropdown; each becomes its own row.
function splitByEnabled(entries) {
    const enabledEntries = entries.filter((e) => e.enabled === true);
    if (enabledEntries.length <= 1) return [entries];
    const sorted = [...enabledEntries].sort((a, b) => versionCompareDesc(a.version, b.version));
    const primary = [sorted[0]];
    const others = sorted.slice(1).map((e) => [e]);
    entries.filter((e) => e.enabled !== true).forEach((e) => primary.push(e));
    return [primary, ...others];
}

// Builds the raw [modId, entries[]] groups (>=2 entries only) -- entries carry both INSTALLED (real
// mods) and ORPHANED DOWNLOAD (unclaimed finished downloads) rows. Collection mods themselves are
// excluded (a collection's own Version dropdown is never a "duplicate version" the way a member mod's
// is). scopeVortexIds, when given, narrows to only the installed vortexModIds that scope resolves to
// (see filterToCollectionMembers below) -- content-identity matching, not raw shared-modId, same
// reasoning list-vortex-version-groups.js's own header comment documents.
function buildRawGroups(mods, files, enabledSet, scopeVortexIds) {
    const ids = Object.keys(mods);
    const claimedArchiveIds = new Set(ids.map((id) => mods[id].archiveId).filter(Boolean));

    const byModIdRaw = new Map();
    for (const id of ids) {
        if (mods[id].type === 'collection') continue;
        const attrs = mods[id].attributes || {};
        if (attrs.source !== 'nexus' || attrs.modId == null) continue;
        if (scopeVortexIds && !scopeVortexIds.has(id)) continue;
        const key = String(attrs.modId);
        if (!byModIdRaw.has(key)) byModIdRaw.set(key, []);
        byModIdRaw.get(key).push({
            kind: 'INSTALLED', id, fileMD5: attrs.fileMD5, version: attrs.version,
            enabled: enabledSet.has(id), state: mods[id].state,
            displayName: attrs.customFileName || attrs.modName || '(unknown name)',
            _attrs: attrs,
        });
    }
    const byModId = new Map();
    let groupCounter = 0;
    for (const [modId, entries] of byModIdRaw) {
        if (entries.length === 1) { byModId.set(`${modId}::0`, entries); continue; }
        const fileGroups = [];
        for (const e of entries) {
            const g = fileGroups.find((iter) => fileMatch(iter[0]._attrs, e._attrs));
            if (g) g.push(e); else fileGroups.push([e]);
        }
        fileGroups.forEach((g) => { byModId.set(`${modId}::${groupCounter++}`, g); });
    }

    for (const [key, entries] of byModId) {
        const modId = key.split('::')[0];
        const modIdToken = new RegExp(`(^|[^0-9])${modId}([^0-9]|$)`);
        const groupMd5s = new Set(entries.map((e) => e.fileMD5).filter(Boolean));
        const nameHint = normalizeForNameMatch((entries[0]._attrs && entries[0]._attrs.logicalFileName) || entries[0].displayName);
        for (const [downloadId, f] of Object.entries(files)) {
            if (f.state !== 'finished') continue;
            if (claimedArchiveIds.has(downloadId)) continue;
            const md5Match = groupMd5s.has(f.fileMD5);
            const nameMatch = f.localPath && modIdToken.test(f.localPath)
                && (!nameHint || normalizeForNameMatch(f.localPath).includes(nameHint));
            if (!md5Match && !nameMatch) continue;
            entries.push({
                kind: 'ORPHANED DOWNLOAD', id: downloadId, fileMD5: f.fileMD5,
                version: (f.modInfo && f.modInfo.meta && f.modInfo.meta.fileVersion) || '(unknown)',
                enabled: null, state: 'downloaded (unclaimed)',
                displayName: entries[0].displayName, localPath: f.localPath, fileTime: f.fileTime,
            });
        }
    }

    const displayGroups = [];
    for (const [key, entries] of byModId) {
        const modId = key.split('::')[0];
        splitByEnabled(entries).forEach((g) => displayGroups.push([modId, g]));
    }
    return displayGroups.filter(([, entries]) => entries.length >= 2);
}

// Every collection's own live rules, for both scoping (--collection equivalent) and the
// "which collection(s) does this mod belong to" capture every group and every cleanup needs.
async function loadCollectionsInfo(mods) {
    const collectionIds = Object.keys(mods).filter((id) => mods[id].type === 'collection');
    const collectionsInfo = [];
    for (const collectionModId of collectionIds) {
        const attrs = mods[collectionModId].attributes || {};
        const rules = await helperClient.getLiveRulesForMod(collectionModId);
        collectionsInfo.push({
            collectionModId, name: attrs.customFileName || attrs.modName || collectionModId,
            rules: rules || [],
        });
    }
    return collectionsInfo;
}

// True when `rules` contains a membership rule whose own reference identity matches `ref` --
// {fileMD5, tag, modId, fileId}. Reuses makeIdentityMatcher/ruleReferenceIdentity exactly the way
// filterToCollectionMembers does internally, just against one candidate ref instead of a list, so the
// matched RULE itself (not just a boolean) can be recovered when the caller needs its own
// type/ignored/installerChoices (see findMembershipRule below).
function findMembershipRule(rules, ref) {
    const matcher = syncLib.makeIdentityMatcher([ref]);
    return (rules || []).find((rule) => matcher(syncLib.ruleReferenceIdentity(rule)));
}

// Shapes the raw [modId, entries[]] groups into the UI/API contract: one row per duplicate GROUP,
// the survivor (currently-installed, never removable) plus every other entry classified 'orphan'
// (safe) or 'legit' (flagged, never auto-removed).
function shapeGroups(rawGroups, collectionsInfo) {
    const results = [];
    let counter = 0;
    for (const [modId, entries] of rawGroups) {
        const installedEntries = entries.filter((e) => e.kind === 'INSTALLED');
        const survivor = installedEntries.find((e) => e.enabled === true)
            || [...installedEntries].sort((a, b) => versionCompareDesc(a.version, b.version))[0];
        if (!survivor) continue; // shouldn't happen -- every group is built from >=1 INSTALLED entry
        const others = entries.filter((e) => e !== survivor);
        if (others.length === 0) continue;

        const survivorRef = { fileMD5: survivor.fileMD5, modId, fileId: survivor._attrs && survivor._attrs.fileId };
        const survivorCollections = collectionsInfo.filter((c) => !!findMembershipRule(c.rules, survivorRef));

        const removable = others.map((e) => {
            if (e.kind === 'INSTALLED') {
                return {
                    version: e.version, kind: 'legit', sourceKind: 'mod', vortexModId: e.id,
                    note: "A second real, installed copy of this mod exists (currently disabled) -- "
                        + "this tool only cleans up orphaned downloads, not a second real install. "
                        + 'Remove it by hand in Vortex if you\'re sure it\'s not needed.',
                };
            }
            // Byte-identical to the survivor -- always safe, regardless of what references it (anything
            // that needed this exact content already resolves to the survivor itself).
            if (e.fileMD5 && survivor.fileMD5 && e.fileMD5 === survivor.fileMD5) {
                return { version: e.version, kind: 'orphan', sourceKind: 'download', downloadId: e.id, localPath: e.localPath, fileMD5: e.fileMD5 };
            }
            const orphanRef = { fileMD5: e.fileMD5, modId };
            const referencedBy = collectionsInfo.filter((c) => {
                if (survivorCollections.some((sc) => sc.collectionModId === c.collectionModId)) return false;
                return !!findMembershipRule(c.rules, orphanRef);
            });
            if (referencedBy.length > 0) {
                return {
                    version: e.version, kind: 'legit', sourceKind: 'download', downloadId: e.id, localPath: e.localPath, fileMD5: e.fileMD5,
                    note: `Still pinned by ${referencedBy.map((c) => c.name).join(', ')}, on purpose -- a genuinely different file it resolves conflicts against.`,
                };
            }
            return { version: e.version, kind: 'orphan', sourceKind: 'download', downloadId: e.id, localPath: e.localPath, fileMD5: e.fileMD5 };
        });

        results.push({
            id: `g${counter++}`, modId, mod: survivor.displayName,
            installedVortexModId: survivor.id, installedVersion: survivor.version,
            collections: survivorCollections.map((c) => c.name),
            removable,
        });
    }
    results.sort((a, b) => a.mod.localeCompare(b.mod));
    return results;
}

// Read-only scan -- returns {groups}. Never modifies anything. collectionModIds, when given a
// non-empty array, scopes detection to the UNION of those collections' own real members
// (content-identity matched per collection, not raw shared modId -- see
// filterToCollectionMembers's own header comment); a mod belonging to ANY of the picked
// collections is included, not just the first one. Empty/omitted scans the whole install --
// this is the deliberate default (see design/SPEC-duplicate-version-cleanup-tool.md's own
// resolved open question #1), not a fallback to avoid.
//
// collectionModIds are Vortex's own live collection mod ids (== the staging folder name, same id
// every other picker in this app keys collections by -- see web/duplicate-version-cleanup-routes.js's
// own /collections route, which reads the real on-disk names via listPickableCollections rather
// than Vortex's own live attrs, which frequently leaves customFileName/modName unset and lets a raw
// "vortex_collection_<id>" id leak into the UI otherwise). loadCollectionsInfo below still names
// collections from Vortex's live attrs -- that's fine and unrelated: this function only needs it to
// look up a picked id's own RULES for scoping/membership-capture, never to display a name.
async function scanForDuplicates({ collectionModIds } = {}) {
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperAvailable) {
        const err = new Error('The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to scan for duplicate versions.');
        err.code = 'HELPER_UNAVAILABLE';
        throw err;
    }
    const modsData = await helperClient.getAllMods();
    if (!modsData) throw new Error("Couldn't read Vortex's live mod list.");
    const mods = modsData.mods || {};
    const enabledSet = new Set(modsData.enabledModKeys || []);
    const downloadsData = await helperClient.getAllDownloads();
    if (!downloadsData) throw new Error("Couldn't read Vortex's live downloads list.");
    const files = downloadsData.files || {};

    const collectionsInfo = await loadCollectionsInfo(mods);

    let scopeVortexIds = null;
    let scopedNames = [];
    const wantedIds = Array.isArray(collectionModIds) ? collectionModIds.filter(Boolean) : [];
    if (wantedIds.length > 0) {
        const matches = wantedIds
            .map((id) => collectionsInfo.find((c) => c.collectionModId === id))
            .filter(Boolean);
        if (matches.length === 0) {
            const err = new Error('None of the selected collections are currently installed in Vortex.');
            err.code = 'COLLECTION_NOT_FOUND';
            throw err;
        }
        const ids = Object.keys(mods);
        const items = ids.map((id) => {
            const attrs = mods[id].attributes || {};
            return { id, fileMD5: attrs.fileMD5, tag: attrs.referenceTag, modId: attrs.modId, fileId: attrs.fileId };
        });
        const unionIds = new Set();
        for (const match of matches) {
            for (const m of syncLib.filterToCollectionMembers(items, match.rules)) unionIds.add(m.id);
        }
        scopeVortexIds = unionIds;
        scopedNames = matches.map((m) => m.name);
    }

    const rawGroups = buildRawGroups(mods, files, enabledSet, scopeVortexIds);
    const groups = shapeGroups(rawGroups, collectionsInfo);
    console.log(`[duplicate-version-cleanup] scan: ${Object.keys(mods).length} installed mods, ${Object.keys(files).length} downloads, ${groups.length} duplicate group(s) found${scopedNames.length ? ` (scoped to ${scopedNames.join(', ')})` : ''}.`);
    return { groups };
}

// A single download id's real archive file, shared with any OTHER download record not in this same
// removal batch -- the exact real risk the 2026-08-30 "Bathing in Skyrim" finding documented (two
// download records pointing at the identical physical file; deleting one's file silently breaks the
// other). batchDownloadIds is every download id being removed together in THIS group's own operation
// (siblings sharing a path with each other are fine -- they're all going together); anything outside
// that set -- including the survivor's own current download record -- is a real, protected conflict.
function findSharedArchiveConflict(files, orphanDownloadId, orphanLocalPath, batchDownloadIds) {
    if (!orphanLocalPath) return null;
    const conflict = Object.entries(files).find(
        ([id, f]) => id !== orphanDownloadId && f.localPath === orphanLocalPath && !batchDownloadIds.has(id),
    );
    return conflict ? conflict[0] : null;
}

// The 8-step recipe for ONE group -- see this file's own header comment and
// design/SPEC-duplicate-version-cleanup-tool.md for the full "why". `orphanDownloadIds` is the exact
// set of this group's own currently-classified 'orphan' download entries to remove (recomputed fresh
// by the caller right before this runs -- see web/duplicate-version-cleanup-routes.js -- never trusted
// from a stale client-held scan). onPhase(text) reports coarse progress for the SSE stream.
async function cleanupGroup({ modId, installedVortexModId, orphanDownloadIds, downloadsDir, stagingDir, onPhase = () => {} }) {
    const name0 = `modId ${modId}`;
    console.log(`[duplicate-version-cleanup] cleanup START: ${name0} (installed=${installedVortexModId}, orphans=${JSON.stringify(orphanDownloadIds)})`);
    try {
        onPhase('capturing');
        const modsData = await helperClient.getAllMods();
        if (!modsData) return { ok: false, name: name0, error: "Couldn't read Vortex's live mod list." };
        const installedRecord = modsData.mods[installedVortexModId];
        if (!installedRecord) {
            return { ok: false, name: name0, error: 'This mod is no longer installed -- it may have been removed since the scan. Re-scan and try again.' };
        }
        const survivorMod = buildModFromLiveData(modsData.mods, installedVortexModId);
        const name = survivorMod.name;
        if (!survivorMod.source || survivorMod.source.type !== 'nexus' || survivorMod.source.modId == null || survivorMod.source.fileId == null) {
            return { ok: false, name, error: "This mod's own Nexus identity (modId/fileId) isn't fully recorded -- can't safely redownload it. Skipped." };
        }

        // Step 1: capture what must survive, BEFORE touching anything -- every collection this mod's
        // own membership rule resolves to, plus its own recorded FOMOD choices (already captured
        // above via buildModFromLiveData -- survivorMod.choices, straight off the mod's own live
        // attributes.installerChoices, same shape collection.json's own choices field uses).
        const collectionsInfo = await loadCollectionsInfo(modsData.mods);
        const survivorRef = { fileMD5: survivorMod.source.md5, modId: survivorMod.source.modId, fileId: survivorMod.source.fileId, tag: survivorMod.source.tag };
        const memberships = [];
        for (const c of collectionsInfo) {
            const rule = findMembershipRule(c.rules, survivorRef);
            if (rule) memberships.push({ collectionModId: c.collectionModId, collectionName: c.name, optional: rule.type === 'recommends', ignored: !!rule.ignored });
        }
        console.log(`[duplicate-version-cleanup] "${name}": belongs to ${memberships.length} collection(s): ${memberships.map((m) => m.collectionName).join(', ') || '(none)'}${survivorMod.choices ? ' -- has recorded FOMOD choices' : ''}`);

        // Step 2: shared-archive protection -- refuse any orphan whose file is still claimed by
        // something outside this batch, rather than ever deleting it. Refused entries are reported,
        // not silently dropped -- the rest of the batch (and the reinstall) still proceeds.
        const downloadsData = await helperClient.getAllDownloads();
        if (!downloadsData) return { ok: false, name, error: "Couldn't read Vortex's live downloads list." };
        const files = downloadsData.files || {};
        const batchSet = new Set(orphanDownloadIds);
        const safeToRemove = [];
        const refusedOrphans = [];
        for (const downloadId of orphanDownloadIds) {
            const f = files[downloadId];
            if (!f) continue; // already gone -- nothing to do
            const conflict = findSharedArchiveConflict(files, downloadId, f.localPath, batchSet);
            if (conflict) {
                console.warn(`[duplicate-version-cleanup] "${name}": refusing to remove download ${downloadId} -- its archive file is still shared with download ${conflict}, which is NOT part of this batch.`);
                refusedOrphans.push({ downloadId, reason: `Its archive file is still shared with another download record (${conflict}) not part of this cleanup -- skipped to avoid breaking it.` });
                continue;
            }
            safeToRemove.push(downloadId);
        }

        // Step 3: remove every entry in the selected group -- the real install (full uninstall, via
        // Vortex's own real remove-mods event) and every orphan download that passed the
        // shared-archive check (real file deletion too -- see removeDownloads' own header comment for
        // why this, not the confirmed-broken record-only path, is what actually survives a restart).
        onPhase('removing');
        const removeModOk = await helperClient.removeMods([installedVortexModId]);
        if (!removeModOk) return { ok: false, name, error: "Couldn't remove the currently-installed copy -- Vortex may be busy. Nothing else was touched for this mod." };
        let removedOrphanCount = 0;
        if (safeToRemove.length > 0) {
            const results = await helperClient.removeDownloads(safeToRemove);
            if (Array.isArray(results)) {
                for (const r of results) {
                    if (r.ok) removedOrphanCount += 1;
                    else console.warn(`[duplicate-version-cleanup] "${name}": failed to remove orphan download ${r.downloadId}: ${r.error}`);
                }
            } else {
                console.warn(`[duplicate-version-cleanup] "${name}": removeDownloads returned no results -- Helper may be unreachable.`);
            }
        }

        // Step 4 + 5: redownload the surviving file fresh, then re-extract/reinstall it into a NEW
        // staging slot (vortexModId: null -- same fresh-install shape the Added-mod loop uses).
        // rebuildSingleMod's own internal auto-download covers step 4 (it re-downloads when the
        // archive isn't already on disk, same allowAutoDownload path every other caller uses).
        onPhase('reinstalling');
        const effectiveMod = { ...survivorMod }; // .choices, if any, replays automatically (step 6)
        const rebuildResult = await rebuildSingleMod({
            vortexModId: null, gameId: syncLib.GAME_ID, downloadsDir, stagingDir,
            mod: effectiveMod, allowAutoDownload: true, resolveMode: 'all',
            onPhase: (phase) => onPhase(phase === 'downloading' ? 'downloading' : 'reinstalling'),
        }).catch((e) => ({ status: 'ERROR', error: e.message }));
        if (rebuildResult.status !== 'REBUILT') {
            return {
                ok: false, name,
                error: `Removed the old entries, but reinstalling "${name}" failed (${rebuildResult.error || rebuildResult.status || 'unknown error'}). `
                    + 'This mod is now uninstalled -- re-scan and try again, or reinstall it by hand in Vortex.',
                refusedOrphans,
            };
        }
        const newVortexModId = rebuildResult.targetFolderName;

        onPhase('registering');
        const archiveMatch = await resolveOrRegisterArchiveId(effectiveMod, downloadsDir, null);
        const attributes = {
            version: (archiveMatch && archiveMatch.fileVersion) || survivorMod.source.version,
            modName: name, fileMD5: survivorMod.source.md5, modId: survivorMod.source.modId,
            fileId: survivorMod.source.fileId, fileSize: survivorMod.source.fileSize,
            logicalFileName: survivorMod.source.logicalFilename, referenceTag: survivorMod.source.tag,
            source: 'nexus', enableallplugins: true,
            ...(effectiveMod.choices && effectiveMod.choices.type === 'fomod' ? { installerChoices: effectiveMod.choices } : {}),
        };
        const archiveId = archiveMatch ? archiveMatch.archiveId : undefined;
        const createOk = await helperClient.createMod(newVortexModId, {
            id: newVortexModId, state: 'installed', type: '', installationPath: newVortexModId,
            ...(archiveId ? { archiveId } : {}),
            attributes: { name, installTime: new Date().toISOString(), ...attributes },
        });
        if (!createOk) {
            return { ok: false, name, error: 'Reinstalled the files, but Vortex refused to register the new mod entry. Try re-scanning -- Rebuild Missing Files or a manual Vortex refresh may recover it.', refusedOrphans };
        }
        await helperClient.setModEnabled(newVortexModId, true);

        // Step 6: replay FOMOD choices -- already handled by extraction above (effectiveMod.choices,
        // captured in step 1, was passed straight into rebuildSingleMod, matching exactly how the
        // Added-mod loop replays a fresh archive's own recorded choices).

        // Step 7: re-write the membership rule for EVERY collection captured in step 1 -- a mod
        // belonging to 2+ collections gets a rule written back for each one.
        onPhase('reassigning');
        const modForRule = {
            source: survivorMod.source, version: survivorMod.source.version, author: undefined,
            phase: 0, instructions: undefined, name,
        };
        const ruleItems = memberships.map((m) => ({
            modId: m.collectionModId,
            add: buildCollectionMembershipRule({ ...modForRule, optional: m.optional }, effectiveMod, { ignored: m.ignored }),
        }));
        let membershipFailures = [];
        if (ruleItems.length > 0) {
            const results = await helperClient.applyRuleChangesBatch(ruleItems);
            if (Array.isArray(results)) {
                results.forEach((r, i) => { if (!r || r.ok !== true) membershipFailures.push(memberships[i].collectionName); });
            } else {
                membershipFailures = memberships.map((m) => m.collectionName);
            }
        }

        console.log(`[duplicate-version-cleanup] cleanup DONE: "${name}" -- reinstalled as ${newVortexModId}, removed ${removedOrphanCount}/${safeToRemove.length} orphan(s)${refusedOrphans.length ? `, refused ${refusedOrphans.length}` : ''}${membershipFailures.length ? `, FAILED to reassign: ${membershipFailures.join(', ')}` : ''}.`);
        return {
            ok: membershipFailures.length === 0, name, newVortexModId,
            removedOrphanCount, refusedOrphans,
            error: membershipFailures.length > 0 ? `Reinstalled, but couldn't reassign it back to: ${membershipFailures.join(', ')}.` : undefined,
        };
    } catch (e) {
        console.error(`[duplicate-version-cleanup] cleanup FAILED: ${name0}: ${e.message}`);
        return { ok: false, name: name0, error: e.message };
    }
}

module.exports = { scanForDuplicates, cleanupGroup, buildRawGroups, shapeGroups, findMembershipRule, findSharedArchiveConflict };
