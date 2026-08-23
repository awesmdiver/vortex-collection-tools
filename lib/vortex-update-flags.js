'use strict';
// "Clear Update Flags" utility -- Vortex's own real "Update available" flag for a mod lives at
// state.persistent.mods.<gameId>.<modId>.attributes.newestVersion/.newestFileId (also
// .lastUpdateTime/.newestChangelog, set alongside them by the same real code path -- confirmed by
// reading Vortex's own real source, extensions/nexus_integration/util/checkModsVersion.ts:
// setNoUpdateAttributes clears the first three, updateLatestFileAttributes sets/clears
// newestChangelog alongside them). A collection's own member mods can end up flagged even when the
// collection deliberately pins an OLDER version than Nexus's own "latest" -- this tool clears the
// stale flag directly, through the Helper's own real live-state write, never a raw DB file edit.
//
// Collection membership (2026-08-23, second real fix): a mod's OWN attributes.collectionId (a NUMBER
// Vortex sets when a mod was installed as part of downloading a SPECIFIC PUBLISHED NEXUS COLLECTION
// -- confirmed via real Vortex source, collectionExport.ts) is NOT a reliable membership signal --
// live-verified against the director's own real install that his 22 real Workshop collections ("My
// Mods", "My Environment", etc.) are personally-curated groupings built mostly from mods that were
// already installed individually, so their real members never get this attribute set at all. Reuses
// Rebuild Missing Files' own proven approach instead (lib/missing-files-scan.js's
// listPickableCollections + each collection's own on-disk collection.json), which already handles
// both Installed and Workshop collections correctly for that tool -- see
// buildCollectionMembershipMaps' own header comment below for the full mechanism.

const fs = require('fs');
const path = require('path');
const semver = require('semver');
const helperClient = require('./vortex-helper-client');
const { listPickableCollections } = require('./missing-files-scan');
const { loadCollection } = require('./collection-parser');
const { buildLiveIdentityIndex, resolveLiveModId, buildNexusIdIndex } = require('./update-collection-v2-runner');

// Whether Vortex ITSELF would judge this mod as having a pending update -- a faithful port of real
// Vortex source, `src/renderer/src/extensions/mod_management/util/modUpdateState.ts`'s own
// `updateState()` (plus `versionClean.ts` in the same folder), read live out of the checked-out fork
// at F:\Claude Workspace\vortex-tools\vortex per this project's own "mirror Vortex's own behavior ->
// read its real source" rule.
//
// 2026-08-23, real confirmed LOGIC bug: this used to be `newestVersion !== undefined ||
// newestFileId !== undefined` -- i.e. "has Vortex EVER recorded a newest-* value for this mod," not
// "does that value actually differ from what's installed." Those attributes stay populated
// indefinitely once any update check has run, long after the mod has been updated to match, so the
// old test wildly over-counted: the director's own live install showed 1,886 flagged for ONE
// collection and a "Clear Flags (4,763)" total, against Vortex's own real "Update available" filter
// showing 7 of 4,570.
//
// What Vortex really does, in order (see the real file -- this is a summary of the port below, the
// code is the spec):
//   - No `source` attribute at all -> there is no possible update, full stop.
//   - COLLECTION (`revisionId !== undefined`): versions are plain integers and downgrades aren't
//     supported, so it's a strict numeric `newest > current`.
//   - Regular MOD: any version CHANGE counts (including a downgrade -- Vortex can't assume a
//     versioning scheme, and a downgrade may be intended), compared after semver normalization.
//   - Either kind is also flagged when the newest file id is known-but-different, or the literal
//     string 'unknown' (the site says there's an update but not which file).
//
// The collection branch is genuinely reachable here, NOT dead code: `listModsWithUpdateFlags` walks
// the whole live `mods` payload from the Helper's own GET /mods, which is Vortex's raw
// `state.persistent.mods` subtree -- collections live in there as ordinary mod entries (type
// 'collection', carrying `revisionId`), so a collection's OWN entry reaches this function alongside
// its member mods.
//
// One deliberate divergence from `updateState`: that function returns a STATE string, and Vortex's
// own "Update available" filter (VersionFilter.tsx) matches on `updateState(attrs) !== 'current'`,
// which also catches `bug-disable` -- a mod with a `bugMessage` but NO pending update. This returns
// the real `hasUpdate` boolean instead, deliberately excluding that case: a bug-flagged mod with no
// update has no update flag to clear, so counting it here would put a mod in the picker that this
// tool can't actually do anything about. Expect that to make our count equal-or-slightly-lower than
// Vortex's own filtered count, never higher.
//
// `versionClean` below mirrors versionClean.ts exactly -- semver.coerce -> semver.valid ->
// semver.clean, falling back to '0.0.0-' + the raw input when it isn't coercible at all (which makes
// two different uncoercible strings still compare as different, rather than collapsing to equal).
function versionClean(input) {
    let res = semver.valid(semver.coerce(input, { includePrerelease: true }));
    if (res !== null) res = semver.clean(res);
    return res || '0.0.0-' + input;
}

// Vortex reads each of these attributes through storeHelper.ts's own `getSafe`, which bails to its
// fallback on `current == null` -- so a stored literal `null` reaches updateState() as a real
// `undefined`, NOT as null. That is not a nitpick: the director's own live state has `newestVersion:
// null` / `newestFileId: null` on ~4,300 mods (JSON has no undefined, and an earlier build of this
// very tool wrote literal nulls before the Helper's own null->undefined fix landed). Without this
// normalization the port still counted every one of them (versionClean(null) -> '0.0.0-null', which
// differs from any real version), i.e. 4,301 vs Vortex's own 7 -- the same bug in a new disguise.
// `revisionId` is deliberately NOT normalized: updateState reads THAT one raw off `attributes`, so a
// literal null there really does take the collection branch, and this mirrors that exactly.
const gs = (v) => (v === null ? undefined : v);

function hasUpdateFlag(attrs) {
    if (!attrs || !attrs.source) return false; // Vortex: `if (!truthy(attributes.source)) return 'current'`
    const fileId = gs(attrs.fileId);
    const version = gs(attrs.version);
    const newestFileId = gs(attrs.newestFileId);
    const newestVersion = gs(attrs.newestVersion);

    const hasNewerVersion = attrs.revisionId !== undefined
        ? parseInt(newestVersion ?? '0', 10) > parseInt(version ?? '0', 10)
        : newestVersion !== undefined && version !== undefined
            && versionClean(newestVersion) !== versionClean(version);

    return newestFileId === 'unknown'
        || (!!newestFileId && !!fileId && newestFileId.toString() !== fileId.toString())
        || hasNewerVersion;
}

// name convention already established elsewhere in this project for live Helper mod data
// (lib/update-collection-v2-runner.js's own findBrokenDependencies/resolveLiveModId call sites):
// attrs.customFileName || attrs.modName || the live modId itself. No collectionId field anymore --
// see this file's own header comment for why that attribute was dropped as a membership signal.
function listModsWithUpdateFlags(mods) {
    const out = [];
    for (const [modId, mod] of Object.entries(mods || {})) {
        const attrs = (mod && mod.attributes) || {};
        // A COLLECTION's own entry is never a candidate here (2026-08-23, real live finding).
        // hasUpdateFlag above keeps Vortex's own collection branch on purpose -- that's what makes it
        // a faithful, verifiable port of updateState() against Vortex's own "Update available" filter
        // -- but a collection being flagged means a NEW CURATED REVISION was published on Nexus,
        // which is a completely different signal from "a member mod's file is stale," and explicitly
        // not something this tool should touch. Left in the picker they also landed in the
        // "standalone" bucket, which is nonsense on its face: a collection can't be "not part of any
        // collection." Filtering here rather than inside hasUpdateFlag keeps the Vortex port pure and
        // puts this tool's own scope decision where the tool actually enumerates its candidates.
        // Live offenders this removes: "Body Swap updated" (v29->30), "Update Collection Test
        // Collection" (v5->7).
        if (attrs.revisionId !== undefined) continue;
        if (!hasUpdateFlag(attrs)) continue;
        out.push({
            modId,
            name: attrs.customFileName || attrs.modName || modId,
            currentVersion: attrs.version ?? null,
            newestVersion: attrs.newestVersion ?? null,
        });
    }
    return out;
}

// The real membership computation, shared by both buildUpdateFlagPicker (the /list display) and
// resolveModIdsToClear (the /clear route's own re-derivation) -- one real scan, not two, so they can
// never silently disagree with each other.
//
// listPickableCollections(staging) (lib/missing-files-scan.js) -- the SAME real scan Rebuild Missing
// Files already uses -- finds every staging subfolder with a real collection.json and splits it into
// Installed vs Workshop, correctly covering BOTH (unlike Update Collection v2's own listCollections(),
// which excludes Workshop for a reason specific to its own Apply flow). For each one, this reads its
// own collection.json fresh (loadCollection) to get the CURATOR's own real membership list
// (`.mods[].source`), then resolves each member to a real live Vortex modId via the same
// identity-matching primitive Update Collection v2's own Apply already trusts
// (buildLiveIdentityIndex/resolveLiveModId, built on syncLib.makeIdentityMatcher) -- built ONCE
// against the live `mods` data and reused for every collection, not re-built per collection. A
// flagged mod that resolves into ANY collection's own membership list that way is claimed; whatever
// flagged mod is left unclaimed at the end is genuinely standalone.
//
// LAST-RESORT membership fallback (2026-08-23, second real live finding): the strict matcher above
// only ever matches on `md5:` / `tag:` / `id:{modId}:{fileId}` composite keys, and
// buildLiveIdentityIndex's own header comment is explicit about the assumption that makes that safe
// -- "both sides of the match come from the SAME collection.json snapshot... the live Vortex mod's
// own attributes, which were set from that EXACT same collection.json at install time." That holds
// for Update Collection v2's own original use case, but it breaks here for precisely the mods this
// tool cares about most: a member that has SINCE been updated independently has a new
// fileId/md5/referenceTag, so it matches NONE of those keys against the collection.json's own pinned
// original identity. Live-confirmed offender: "Modern NPC Pathing" is a real member of "My QOL and
// Utilities" (Vortex's own Collection column says so), but its collection.json still pins
// modId=185413 / fileId=780309 / tag="sRd41bFR3NE" / v2.4.6 while the live mod is now v2.4.9 with
// fileId=789369 and no referenceTag at all -- so it fell through to "standalone".
//
// The fix already existed in the same file the strict matcher comes from, just wired to a different
// call site: buildNexusIdIndex, whose own header describes it as "only ever consulted as a LAST
// resort" for exactly this "mod was updated since original state" case. This mirrors
// resolveLiveVersionForUpdatedMod's own established tier-3 pattern rather than inventing a second
// one: bare Nexus modId (same mod PAGE, any file), Nexus-sourced members only, consulted ONLY when
// the exact match genuinely failed -- the exact-match path is completely unchanged.
//
// The ambiguity guard is deliberately one step stronger than that function's own (director's own
// live finding): Vortex can genuinely hold TWO installed copies of one Nexus mod at once -- an old
// copy left behind after an update, sitting DISABLED rather than removed. A flat "refuse if more
// than one candidate" would then refuse for exactly the updated mods this fallback exists to catch.
// So multiple candidates are first narrowed to the ENABLED ones (data.enabledModKeys from the
// Helper's own GET /mods, which is literally
// `persistent.profiles[profileId].modState[modId].enabled === true` -- see the helper extension's own
// getEnabledModKeys, and vortex-helper-client.js's setModEnabled header for the full writeup of that
// field). Exactly one enabled candidate is the real match: an inactive leftover isn't a competing
// candidate at all, since Vortex itself isn't using it. Genuine ambiguity -- several enabled at once,
// or none -- still refuses to guess, same as the pattern it mirrors.
function resolveLiveModIdByNexusId(byNexusId, enabledSet, sourceLike) {
    if (!sourceLike || sourceLike.type !== 'nexus' || sourceLike.modId == null) return null;
    const candidates = byNexusId.get(String(sourceLike.modId));
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const enabled = candidates.filter((id) => enabledSet.has(id));
    return enabled.length === 1 ? enabled[0] : null;
}

function buildCollectionMembershipMaps(staging, mods, enabledModKeys) {
    const flaggedMods = listModsWithUpdateFlags(mods);
    const flaggedModIds = new Set(flaggedMods.map((m) => m.modId));
    const claimedModIds = new Set();
    const matcher = buildLiveIdentityIndex(mods);
    const byNexusId = buildNexusIdIndex(mods);
    const enabledSet = new Set(enabledModKeys || []);

    const annotate = (collections) => collections.map((c) => {
        const collectionJsonPath = path.join(staging, c.modId, 'collection.json');
        let members = [];
        try {
            members = loadCollection(collectionJsonPath).mods || [];
        } catch {
            members = []; // unreadable/corrupt collection.json -- treat as having no known members
        }
        const flaggedMemberModIds = [];
        for (const member of members) {
            let liveModId = resolveLiveModId(matcher, member.source);
            if (!liveModId) liveModId = resolveLiveModIdByNexusId(byNexusId, enabledSet, member.source);
            if (liveModId && flaggedModIds.has(liveModId)) {
                flaggedMemberModIds.push(liveModId);
                claimedModIds.add(liveModId);
            }
        }
        return { modId: c.modId, name: c.name, modCount: c.modCount, flaggedCount: flaggedMemberModIds.length, flaggedModIds: flaggedMemberModIds };
    });

    const { installed, workshop } = listPickableCollections(staging);
    const installedAnnotated = annotate(installed);
    const workshopAnnotated = annotate(workshop);
    const standalone = flaggedMods.filter((m) => !claimedModIds.has(m.modId));
    return { installed: installedAnnotated, workshop: workshopAnnotated, standalone };
}

// The /list route's own display data -- EVERY real installed/Workshop collection shows up here
// (matching Rebuild Missing Files' own "show everything, let the user pick" pattern), regardless of
// whether it currently has any flagged members at all; flaggedCount is context, not a filter.
//
// flaggedModIds is now INCLUDED rather than stripped (2026-08-23). It used to be dropped as "an
// internal detail resolveModIdsToClear needs, the frontend doesn't" -- true when the payload could
// run to thousands of ids, but no longer, now that flagged means a genuinely pending update (the
// whole list is a handful of mods on a real install). The frontend genuinely does need it: a mod can
// belong to more than one collection (live-confirmed -- "AltTabFix 1.3.1" is a real member of both
// "Dragonborn UI for GTS" and "My QOL and Utilities"), so the "Clear Flags (N)" button summing each
// checked card's own flaggedCount counted that mod once per collection and read 6 where only 5 mods
// would actually be cleared. The button now unions these id lists instead, matching what
// resolveModIdsToClear really returns. Each card's own displayed flaggedCount is deliberately left
// as-is: "how many of THIS collection's mods are flagged" is honest per-card context, and a shared
// mod really is flagged in both.
function buildUpdateFlagPicker(staging, mods, enabledModKeys) {
    const { installed, workshop, standalone } = buildCollectionMembershipMaps(staging, mods, enabledModKeys);
    return { installed, workshop, standalone };
}

// The /clear route's own re-derivation -- re-runs the SAME real membership computation fresh (never
// trusts a client-held modId list) and resolves the caller's selected collectionModIds (+ the
// standalone toggle) down to the real, current set of live modIds to actually clear.
function resolveModIdsToClear(staging, mods, { collectionModIds, includeStandalone }, enabledModKeys) {
    const { installed, workshop, standalone } = buildCollectionMembershipMaps(staging, mods, enabledModKeys);
    const selected = new Set((collectionModIds || []).map(String));
    const selectedCollections = [...installed, ...workshop].filter((c) => selected.has(String(c.modId)));
    // De-duplicated (2026-08-23): a mod can genuinely belong to more than one selected collection --
    // live-confirmed, "AltTabFix 1.3.1" is a real member of BOTH "Dragonborn UI for GTS" and "My QOL
    // and Utilities". Without this it appeared twice in the returned list, which meant a doubled
    // Helper write for that mod and a duplicate entry in the backup snapshot. Harmless in effect
    // (clearing an already-cleared flag is a no-op, and the restore replays the same values twice)
    // but genuinely wrong, and it inflated the run's own progress `total` past the real mod count.
    return [...new Set([
        ...selectedCollections.flatMap((c) => c.flaggedModIds),
        ...(includeStandalone ? standalone.map((m) => m.modId) : []),
    ])];
}

// One timestamped JSON snapshot per clear run, mirroring lib/vortex-sync/lib.js's own saveBackup
// convention (same configured backupsDir, same pretty-printed JSON, same "no hardcoded fallback --
// the caller's configured folder is required" rule) without reusing that function directly -- its
// own schema is keyed by a single collectionModId, which doesn't fit a run that can span multiple
// collections plus standalone mods. Reads each mod's CURRENT live attributes straight from `mods`
// (the same already-fetched GET /mods payload the route already has) rather than trusting
// listModsWithUpdateFlags' own trimmed shape, so newestFileId/lastUpdateTime/newestChangelog (not
// part of that trimmed shape) are still captured. Contains the exact values before clearing, per
// mod, so a restore is just replaying this file's own values back through a real setModAttributes
// call per mod, in reverse -- see restoreUpdateFlagsBackup below (2026-08-23) for that replay.
//
// Written into backupRoot's own "update-flags" SUBFOLDER, not the flat root (2026-08-23, real
// confirmed bug) -- lib/vortex-sync/lib.js's own listBackups(backupsDir) does a flat readdirSync
// over that same configured folder and calls loadBackup() on every .json file it finds, rejecting a
// file ONLY when its schemaVersion doesn't match BACKUP_SCHEMA_VERSION. This snapshot's own
// schemaVersion (1) happens to equal that constant, but its real shape (createdAt/
// includedCollections/includedStandalone/mods[]) has nothing to do with Update Collection's own
// real backups (collectionModId/profileId/ignored/disabled/oldMods/etc, buildBackupSnapshot) --
// sharing the flat folder meant a Clear Update Flags snapshot would silently show up in Update
// Collection's own backup-restore picker as if it were one of its real backups. A flat readdirSync
// never descends into a subfolder, so this alone keeps the two kinds of snapshot apart without
// touching lib/vortex-sync/lib.js's own trusted listBackups/loadBackup/BACKUP_SCHEMA_VERSION at all.
function backupUpdateFlags({ modIds, mods, backupRoot, includedCollections, includedStandalone }) {
    if (!backupRoot) throw new Error('A backups folder must be configured under Settings before clearing update flags.');
    const updateFlagsBackupDir = path.join(backupRoot, 'update-flags');
    fs.mkdirSync(updateFlagsBackupDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const snapshot = {
        schemaVersion: 1,
        createdAt,
        includedCollections: includedCollections || [],
        includedStandalone: !!includedStandalone,
        mods: modIds.map((modId) => {
            const attrs = (mods[modId] && mods[modId].attributes) || {};
            return {
                modId,
                newestVersion: attrs.newestVersion ?? null,
                newestFileId: attrs.newestFileId ?? null,
                lastUpdateTime: attrs.lastUpdateTime ?? null,
                newestChangelog: attrs.newestChangelog ?? null,
            };
        }),
    };
    const stamp = createdAt.replace(/[:.]/g, '-');
    const filePath = path.join(updateFlagsBackupDir, `clear-update-flags-${stamp}.json`);
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    return filePath;
}

// Clears whatever modIds it's handed -- no scope/grouping concept at this layer, that's the route's
// job (it resolves a checked collection/standalone selection back to real, CURRENT modIds first, not
// trusting a client-supplied list directly). Sends null for each field -- the Helper's own
// /mods/set-attributes now normalizes a literal null into a real JS undefined before dispatch
// (2026-08-23 fix, vortex-collection-helper's own index.js), matching what Vortex's own real
// clearing code (checkModsVersion.ts's setNoUpdateAttributes) sends. Per-mod success/failure
// returned so a partial failure is visible, never silently swallowed.
//
// `mods` (optional, the same already-fetched GET /mods payload the route already has) + `onProgress`
// (2026-08-23, real SSE-streaming fix -- director's own live report: a 5,000+-mod "Select all" run
// just showed a static "Clearing..." label for however long the whole loop took, reading as
// completely stuck). `onProgress({ done, total, modId, modName, ok })` fires after EACH mod's own
// Helper write settles (success or failure) -- shape mirrors PGPatcher's own build-progress events
// (web/pgpatcher-routes.js's parsePgtoolsLine -> `{ type: 'progress', current, total, message }`),
// per UX-PRINCIPLES.md's own "show the phase name and the count together" rule. Both params are
// purely additive: omitting either leaves this function's own return value and backup-then-clear
// ordering completely unchanged from before this fix.
//
// `shouldCancel` (optional () => boolean) is checked BETWEEN iterations only, never mid-write -- a
// write already in flight always finishes, so a cancelled run is a real, honest partial result (every
// mod already cleared genuinely stayed cleared), never a rollback. Mirrors PGPatcher's own real
// /build/cancel mechanism (a plain mutable flag checked between pgtools output lines,
// currentBuildChild.kill() itself has no equivalent here since this loop has no child process to
// kill) -- the same "checkable flag" shape, not a new cancellation pattern.
async function clearUpdateFlags({ modIds, mods, onProgress, shouldCancel }) {
    const results = [];
    const total = modIds.length;
    for (const modId of modIds) {
        if (shouldCancel && shouldCancel()) break;
        const attrs = (mods && mods[modId] && mods[modId].attributes) || {};
        const modName = attrs.customFileName || attrs.modName || modId;
        let ok = false;
        let error = null;
        try {
            ok = await helperClient.setModAttributes(modId, {
                newestVersion: null, newestFileId: null, lastUpdateTime: null, newestChangelog: null,
            });
            if (!ok) error = "Vortex didn't confirm the write.";
        } catch (e) {
            error = e.message;
        }
        results.push({ modId, ok, error });
        if (onProgress) onProgress({ done: results.length, total, modId, modName, ok });
    }
    return results;
}

// The restore this file's own backupUpdateFlags header comment already promised ("a restore is just
// replaying this file's own values back through a real setModAttributes call per mod, in reverse")
// -- restores exactly ONE snapshot (the route's job is validating backupPath actually resolves inside
// the configured update-flags folder before this ever sees it; this function trusts it's already a
// real file there). Reads the same schema backupUpdateFlags writes and replays each mod's own
// CAPTURED value back through the same real Helper call clearUpdateFlags already uses -- whatever was
// captured (a real version string, or `null` for "wasn't flagged before the clear") gets written back
// exactly as captured, so a mod that was never flagged correctly comes back un-flagged too (the
// Helper's own /mods/set-attributes route already normalizes a literal null to undefined before
// dispatch, same fix clearUpdateFlags's own null payload already relies on). Same `{ modId, ok, error
// }` per-mod result shape clearUpdateFlags returns, for the same reason: a partial failure stays
// visible, never silently swallowed.
async function restoreUpdateFlagsBackup({ backupPath }) {
    const snapshot = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const mods = Array.isArray(snapshot.mods) ? snapshot.mods : [];
    const results = [];
    for (const m of mods) {
        let ok = false;
        let error = null;
        try {
            ok = await helperClient.setModAttributes(m.modId, {
                newestVersion: m.newestVersion, newestFileId: m.newestFileId,
                lastUpdateTime: m.lastUpdateTime, newestChangelog: m.newestChangelog,
            });
            if (!ok) error = "Vortex didn't confirm the write.";
        } catch (e) {
            error = e.message;
        }
        results.push({ modId: m.modId, ok, error });
    }
    return results;
}

module.exports = {
    hasUpdateFlag, listModsWithUpdateFlags, buildUpdateFlagPicker, resolveModIdsToClear,
    backupUpdateFlags, clearUpdateFlags, restoreUpdateFlagsBackup,
};
