'use strict';
// Rebuild Missing Files -- the read-only scan engine. For each mod in a picked collection, this
// resolves its archive the exact same way Rebuild Collection does (classifyMod, rebuild-mod.js),
// then figures out the exact set of files that SHOULD exist in the staging folder by replaying the
// same install resolution extract-mod.js uses for a real rebuild -- FOMOD choice replay
// (choice-resolver.js) for a mod with recorded FOMOD choices, or Vortex's own generic mod-root-
// prefix stripping (simple-installer.js) for a plain archive -- and diffs THAT against what's
// actually on disk. No extraction of the mod's own content needed for this (only a FOMOD's own
// small ModuleConfig.xml is peeked, to read its install steps).
//
// This replaces an earlier, much naiver version of this file that diffed the archive's RAW internal
// paths directly against the staging folder. Confirmed wrong via real-collection testing
// (2026-08-14): a FOMOD-installed mod's raw archive paths don't match what Vortex's installer
// actually produces (e.g. "Armory of the Dragon Cult - Half Res" archives everything under
// "Armory of the Dragon Cult - Half res\00 Data\00Base\...", but the FOMOD install step only copies
// a subset of that into the staging root) -- the naive diff reported the ENTIRE mod as missing
// (hundreds of files) when it was actually installed correctly. A plain "simple" (non-FOMOD)
// archive has the same problem on a smaller scale whenever it has a wrapper folder Vortex strips on
// install (e.g. "Legacy of the Dragonborn - Interesting NPCs Patch", 567 false "missing" files
// before this fix). See TECHNICAL.md for the full incident writeup.
//
// knownVortexModId is null by default here (unlike Rebuild Collection's plan, which always reads
// Vortex's live state to get this -- see rebuild-routes.js's computePlan), since classifyMod's own
// archive-basename fallback for targetFolderName matches the real staging folder in the overwhelming
// common case, without the risk/cost of an isolated state.v2 read. REVISED 2026-09-14 ("share one
// install and extraction engine", then "never scan without knowing which mods are Ignored"):
// scanCollections' own knownVortexModIdsByCollection param fills this in from the SAME per-collection
// live-state read loadIgnoredAndKnownIds() (below) does for ignoredMatchers -- one read, both maps,
// via the Vortex Bridge when it's reachable, a real state.v2 disk read (never Vortex's live state.v2 while
// Vortex could be concurrently writing it -- see loadIgnoredAndKnownIds' own comment) when it isn't.
// This closes a real, confirmed gap: a mod whose currently-matched archive (by collection.json's
// recorded size/md5) has a different filename than the one Vortex originally extracted from used to
// read as "no staging folder at all", reporting every one of its real, present files as missing (see
// diagnostics/shared-install-engine/root-cause-findings-2026-09-14.md -- confirmed live, "Armory of
// the Dragon Cult - Half Res", 562 files). A collection loadIgnoredAndKnownIds() couldn't get a real
// read for is never handed to scanCollections at all (see that function's own caller,
// rebuild-missing-routes.js's /scan route) -- there is no "guess and scan anyway" path left.
//
// listPickableCollections() deliberately does NOT reuse vortex-sync/lib.js's own
// scanStagingCollections -- that function excludes every "vortex_collection_<id>"-named folder
// unconditionally (Workshop-authoring collections), and this tool's own mockup explicitly wants a
// second "Workshop collections" group for exactly those (an authoring collection has its own real,
// locally-readable collection.json too, same as an installed one -- there's just as much reason to
// check it for missing staging files). A single extra filesystem pass, kept local to this file
// rather than changing scanStagingCollections' own long-standing exclusion (other callers rely on
// that exclusion staying exactly as-is).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCollection } = require('./collection-parser');
const { classifyMod } = require('./rebuild-mod');
const { listArchive } = require('./sevenzip');
const { resolveFomodOrSimpleFiles, resolveBundleFiles } = require('./mod-install-plan');
const { existsPlainOrGhosted } = require('./ghost-files');
const runner = require('./collection-runner');
const syncLib = require('./vortex-sync/lib');
const bridgeClient = require('./vortex-bridge-client');
const { loadLiveModsData, resolveEffectiveChoicesForMods } = require('./vortex-live-fomod-choices');
const { isVersionNewer } = require('./version-compare');

// An optional mod the person never installed is not a missing mod -- see collection-runner.js's
// isOptionalNotInstalled (2026-10-24, Daughter of Coldharbour: three Serana mods listed as "Not
// installed" with 32 missing files).
const { isOptionalNotInstalled } = runner;

function isWorkshopFolderName(name) {
    return /^vortex_collection_/i.test(name);
}

// One flat pass over the staging root -- every immediate subfolder with a collection.json is
// pickable, split into "installed" (a normal Vortex-assigned folder name) vs "workshop" (a
// Workshop-authoring folder, per the naming convention above). No Vortex live-state read at all --
// this is purely what's already sitting on disk, matching the mockup's own lack of a "Load Vortex
// Data" step.
function listPickableCollections(stagingDir) {
    let entries;
    try {
        entries = fs.readdirSync(stagingDir, { withFileTypes: true });
    } catch (err) {
        throw new Error(`Could not read staging directory "${stagingDir}": ${err.message}`);
    }
    const installed = [];
    const workshop = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const collectionJsonPath = path.join(stagingDir, entry.name, 'collection.json');
        if (!fs.existsSync(collectionJsonPath)) continue;
        let data;
        try {
            data = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
        } catch {
            continue; // not a valid collection.json -- skip
        }
        const item = {
            modId: entry.name,
            name: data.info?.name || entry.name,
            modCount: data.mods?.length || 0,
            // folderPath/collectionJsonPath (2026-08-27, Merge Plugins' own Workshop-disambiguation
            // fix) -- purely additive, matches the shape scanStagingCollections' own items already
            // carry. Needed by lib/merge-plugin-scan.js's scanCollectionPlugins/
            // computeMasterDependents, which read collection.collectionJsonPath directly. Every
            // existing caller (Rebuild Missing Files, Workshop Report) only ever destructures
            // modId/name/modCount (confirmed by reading both) or mutates extra fields onto these
            // same objects (rebuild-missing-routes.js's own lastFixed/lastChecked) -- adding more
            // fields here is safe by construction, not a shape change either caller depends on.
            folderPath: path.join(stagingDir, entry.name),
            collectionJsonPath,
        };
        (isWorkshopFolderName(entry.name) ? workshop : installed).push(item);
    }
    installed.sort((a, b) => a.name.localeCompare(b.name));
    workshop.sort((a, b) => a.name.localeCompare(b.name));
    return { installed, workshop };
}

// resolveExpectedDestinations (the naive, from-scratch reimplementation of extract-mod.js's own
// FOMOD/simple resolution) removed 2026-09-14, "Rebuild Collection, Update Collection, and Rebuild
// Missing Files share one install and extraction engine" -- scanOneMod below now calls
// lib/mod-install-plan.js's resolveFomodOrSimpleFiles/resolveBundleFiles, the exact same functions
// extract-mod.js itself uses for a real rebuild, so a FOMOD/simple-install fix only ever needs to
// land in one place. This also adds bundle-mod support, which the old copy never had at all (a
// bundle-type mod's files used to be resolved -- wrongly -- as a plain simple install against the
// WHOLE collection package, not its own real subfolder).

// Scans ONE mod. Returns one of:
//   { bucket: 'missing', name, modId, fileId, targetFolderName, archivePath, missing: {source, destination}[] }
//   { bucket: 'archive-missing', name, modId, fileId, reason }  -- can't diff without the archive
//   { bucket: 'skipped', name, modId, fileId, reason, skipKind } -- FOMOD wizard / not installed / unresolvable.
//     skipKind (2026-09-17, "Open FOMOD mods get an Install button"): 'open-fomod' (a real Open
//     FOMOD -- the frontend's own Install action targets exactly this, and only this, kind),
//     'unhandled-feature' (a FOMOD using a parser gap this tool can't replay), or 'resolve-error'
//     (a genuine tool/archive failure) -- machine-readable so the frontend never has to guess which
//     case it's looking at from reason text alone. Carries `...base` (modId/fileId/version/
//     domainName) like every other bucket here (2026-09-17 fix, "the Install button fails with
//     collectionModId, modId, and fileId are required" -- it didn't used to, and the Install
//     button's own /fomod-picker-data and /install-fomod calls need modId/fileId to find the mod
//     again).
//   { bucket: 'ok', name }                                       -- installed, archive resolved, nothing missing
//
// knownVortexModId (optional, default null -- see this file's own header comment on why every
// OTHER caller here leaves it null): Update Collection v2's Apply step is the one caller that DOES
// already know the real live Vortex mod id (resolved via its own identity match) and wants THIS
// specific staging folder checked, not classifyMod's archive-basename guess -- passed straight
// through to classifyMod, same param, same meaning.
//
// installedVersionEntries (optional, default null -- 2026-09-22, "flag when the installed version
// is newer than the collection's pinned version"): this mod's own slice of
// buildModVersionIndex/buildModVersionIndexLive's otherVersionsByModId (an array of {version,
// fileId, variant, installationPath, enabledProfiles} for every version of this modId installed
// but NOT matching what THIS collection currently pins -- i.e. exactly the "installed drifted away
// from the pin" case, resolved once per collection by scanCollections below via
// loadIgnoredAndKnownIds' own syncState read, the SAME read that already produces knownVortexModId
// above). Judgment call, flagged rather than guessed: only ENABLED entries (enabledProfiles.length
// > 0) count as "the installed version" for this flag -- a newer variant sitting on disk but not
// enabled in the current profile is a smaller practical risk (the director's own framing) and is
// deliberately NOT flagged. When several enabled entries exist for the same modId (a genuine
// multi-profile edge case), the HIGHEST of them is used -- a conservative "flag if ANY enabled
// copy is newer than the pin" rather than picking one arbitrarily.
async function scanOneMod(mod, { downloadsDir, stagingDir, sevenZipExe, exceptionMatcher = () => false, knownVortexModId = null, collectionModId = null, installedVersionEntries = null }) {
    let installedVersion = null;
    for (const entry of installedVersionEntries || []) {
        if (entry.version == null) continue;
        if (!entry.enabledProfiles || entry.enabledProfiles.length === 0) continue;
        if (installedVersion == null || isVersionNewer(entry.version, installedVersion)) installedVersion = entry.version;
    }
    const installedVersionNewer = isVersionNewer(installedVersion, mod.version);
    // domainName: only ever set on a mod cross-listed under a different game's own Nexus catalog
    // (see resolveDomainDownloadsDir's own header comment) -- surfaced so the report can show it,
    // since it's genuinely useful context (this mod's archive lives in a different downloads
    // subfolder than the rest of the collection).
    const base = {
        name: mod.name, version: mod.version || null, modId: mod.source?.modId ?? null, fileId: mod.source?.fileId ?? null, domainName: mod.domainName || null,
        installedVersion, installedVersionNewer,
    };
    let action;
    try {
        action = await classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId, collectionModId, sevenZipExe, exceptionMatcher });
    } catch (e) {
        return { bucket: 'archive-missing', ...base, reason: e.message };
    }
    if (action.kind === 'SKIP_EXCEPTED') {
        // Mod Exceptions list (queue: rebuild-missing-hand-pick-exceptions) -- never scanned, same
        // "don't even hash the archive" early-out classifyMod itself already applies for Rebuild
        // Collection. Acknowledged tier, matching the 'ignored' bucket's own treatment below.
        return { bucket: 'excepted', ...base, reason: action.detail };
    }
    if (action.kind === 'SKIP_NO_ARCHIVE') {
        // Can't know what SHOULD be in staging without the archive to list -- no missing-file diff
        // is possible, only surfaced as its own bucket so the report can still show it (with a
        // Download Archive action for Nexus mods) instead of silently dropping it. `code` (2026-09-14,
        // "download missing archives automatically during the scan") threads classifyMod's own
        // NOT_FOUND/HASH_MISMATCH/AMBIGUOUS/BUNDLE_FOLDER_NOT_FOUND straight through -- previously
        // dropped here, so rebuild-missing-routes.js's own scan-time auto-download (mirroring Rebuild
        // Collection's own eligibleForDownload filter in web/rebuild-routes.js) had no way to tell a
        // real "we don't have the right file" apart from AMBIGUOUS (several byte-identical local
        // candidates -- needs a human pick, not an automated download).
        return { bucket: 'archive-missing', ...base, reason: action.detail || 'No archive found.', code: action.code };
    }
    if (action.kind === 'SKIP_OPEN_FOMOD') {
        // "mods it couldn't check show up instead of hiding" (2026-09-14), reworded again 2026-09-17
        // ("Open FOMOD mods get an Install button"): this used to point the user at Vortex's own
        // installer as the only fix -- now that this tool can replay the SAME picker itself (the
        // shared FOMOD picker, see web/public/fomod-picker.js) and extract the result directly, the
        // reason names that instead. skipKind:'open-fomod' is the machine-readable discriminator the
        // frontend uses to decide whether an Install button belongs on this row at all -- the OTHER
        // two 'skipped' reasons below (an unhandled FOMOD feature, a genuine resolver error) have no
        // real picker to offer, so they're never mistaken for this case by pattern-matching reason
        // text.
        //
        // ...base (2026-09-17 fix, "the Install button fails with collectionModId, modId, and fileId
        // are required"): every OTHER bucket this function returns spreads `base` (modId/fileId/
        // version/domainName) -- this one, and the two other 'skipped' returns below, didn't, so the
        // row the client got had no modId/fileId at all. Harmless for the OLD "go reinstall through
        // Vortex" version of this row (nothing here ever needed them), but the new Install button's
        // own /fomod-picker-data and /install-fomod calls need exactly these two fields to find the
        // mod again -- confirmed real via a live sandbox run against a real Open FOMOD mod (iWant
        // Widgets): Install failed with a 400, "collectionModId, modId, and fileId are required,"
        // because this row never had them to send in the first place.
        // A legacy C# Script installer (item 13a) gets its OWN skipKind, deliberately never
        // 'open-fomod' -- the frontend's own Install-button gate checks skipKind === 'open-fomod'
        // specifically (rmfBuildActionsCell et al.), so any other skipKind already renders as a
        // plain, non-actionable reason with no button -- exactly right here, since this tool has no
        // way to actually drive this installer type's own picker.
        if (action.legacyInstaller) {
            return { bucket: 'skipped', ...base, skipKind: 'legacy-script-installer', reason: action.detail };
        }
        return { bucket: 'skipped', ...base, skipKind: 'open-fomod', reason: 'This mod has a FOMOD wizard with no saved choices — click Install to pick your options.' };
    }
    // REVISED (2026-09-01): this used to bucket:'skipped' here -- and scanCollections() silently
    // drops every 'skipped' result, never counting it anywhere in the report. Confirmed live and
    // real: a REQUIRED mod this collection installs (optional mods the person never installed are
    // filtered out before this point, see isOptionalNotInstalled) can
    // end up with NO staging folder at all (uninstalled by Vortex, a failed tool operation, manual
    // deletion, etc.), and the scan reported "no missing files" -- actively false, not just
    // incomplete. Falling through to the normal diff below instead: with no staging folder, every
    // one of resolved.destinations is absent, so this naturally lands in the SAME 'missing' bucket
    // + Extract recovery flow already built and tested for a partially-missing mod -- no new bucket
    // needed. Kept as one known accepted trade-off (documented in this file's header comment): a mod
    // updated in collection.json but not yet redeployed has an archive whose basename no longer
    // matches its still-staged folder, so this also (correctly, if a little bluntly) reports as
    // "fully missing" rather than a real diff -- Extract still fixes it either way.
    // Bundle-type mods (source.type === 'bundle', content packaged INSIDE the collection's own
    // downloaded package -- see lib/bundle-resolver.js's own header comment) never reach the normal
    // listArchive/resolve path below -- classifyMod()'s own classifyBundledMod already fully
    // resolved this mod's real file list at classify time (action.bundledFiles), against its own
    // real bundle subfolder, not the whole collection package. Checked here, before the generic
    // listArchive() call, which would otherwise list the COLLECTION's own package as if it were this
    // one mod's private archive -- a real, previously-unfixed gap: resolveExpectedDestinations had
    // no bundle awareness at all, so a bundled mod's files used to be resolved (wrongly) as a plain
    // "simple install" against the ENTIRE collection package's own file tree.
    let resolved;
    if (action.bundled) {
        resolved = resolveBundleFiles(action);
    } else {
        let entries;
        try {
            entries = await listArchive(sevenZipExe, action.archivePath);
        } catch (e) {
            return { bucket: 'archive-missing', ...base, reason: `Could not read the archive's contents: ${e.message}` };
        }
        try {
            resolved = await resolveFomodOrSimpleFiles(mod, entries, action.archivePath, { sevenZipExe, scratchRoot: os.tmpdir() });
        } catch (e) {
            return { bucket: 'skipped', ...base, skipKind: 'resolve-error', reason: `Could not resolve this mod's install: ${e.message}` };
        }
    }
    if (resolved.unresolvable) {
        return { bucket: 'skipped', ...base, skipKind: 'unhandled-feature', reason: resolved.unresolvable };
    }
    const resolvedFiles = resolved.files;
    // A ".ghost"-suffixed sibling is Vortex's own present-but-disabled marker (see ghost-files.js) --
    // not a real absence. Without this, a file the user intentionally disabled in Vortex reports as
    // "missing" here (confirmed live: "TGC Winterhold - ELFX Patch.esp", Vortex Ghost status,
    // ".esp.ghost" genuinely present on disk). Moot when the staging folder doesn't exist at all
    // (existsPlainOrGhosted's own fs.existsSync calls just return false, no throw) -- every
    // destination correctly falls into `missing` in that case.
    const missing = resolvedFiles.filter((f) => !existsPlainOrGhosted(action.stagingModDir, f.destination));
    if (missing.length === 0) return { bucket: 'ok', name: mod.name };
    return {
        bucket: 'missing', ...base, notInstalled: !action.existingStagingFolder,
        targetFolderName: action.targetFolderName, archivePath: action.archivePath, missing,
    };
}

// One Vortex-state read per collection -- the SAME call resolves both which mods are Ignored and
// each kept mod's real, Vortex-assigned staging folder name (knownVortexModIds), so a caller can
// never end up with one without the other. "Never scan without knowing which mods are Ignored"
// (2026-09-14, follow-up to "share one install and extraction engine" -- see this task's own
// diagnostics doc): this used to fail OPEN on any read error (treat every mod as not-Ignored,
// confirmed live-reproducible harm -- 562 false "missing" files from one genuinely-Ignored mod in
// the real Gate To Sovngarde investigation), and losing the read when the Vortex Bridge wasn't reachable
// also meant losing knownVortexModIds, bringing back the folder-name bug from the same investigation.
// A collection this can't get a real read for is returned in `unreadableCollections` instead of
// silently getting an empty ignored list -- the caller (rebuild-missing-routes.js's /scan route)
// excludes it from the real scan entirely rather than scanning it blind.
//
// Bridge-first, disk-fallback -- the SAME loadSyncStateAnyPath split Rebuild Collection's own
// web/rebuild-routes.js already established, replicated here as a plain if/else (not hoisted into a
// shared "any path" wrapper) since both branches are thin calls into this same file's already-shared
// runner.loadSyncStateViaBridge/runner.loadSyncState. `bridgeAvailable` is the caller's own,
// already-computed check (`bridgeClient.checkBridgeAvailable`) -- this function makes no Bridge-
// reachability decision of its own, so a caller that already gated on it (the 409 vortex-running
// check every route with a live-state read uses) doesn't pay for a second one. The disk path
// (state.v2) is therefore only ever reached once the caller has confirmed Vortex isn't running when
// the Vortex Bridge can't be reached -- never while Vortex could be concurrently writing that file.
async function loadIgnoredAndKnownIds(collectionModIds, { stagingDir, state, bridgeAvailable }) {
    const ignoredMatchers = new Map();
    const knownVortexModIdsByCollection = new Map();
    const otherVersionsByModIdByCollection = new Map();
    const unreadableCollections = new Map(); // collectionModId -> real error message
    for (const collectionModId of collectionModIds) {
        try {
            const collectionInfo = runner.resolveCollectionInfo(stagingDir, collectionModId);
            const syncState = bridgeAvailable
                ? await runner.loadSyncStateViaBridge({
                    bridgeClient, syncLib, collectionModId, collection: collectionInfo.collection, stagingDir,
                })
                : await runner.loadSyncState({
                    state, collectionModId, collection: collectionInfo.collection, stagingDir,
                });
            ignoredMatchers.set(collectionModId, syncLib.makeIdentityMatcher(syncState.ignored));
            knownVortexModIdsByCollection.set(collectionModId, syncState.knownVortexModIds);
            // otherVersionsByModId (2026-09-22, "flag when the installed version is newer than the
            // collection's pinned version"): the SAME syncState read already resolves this -- every
            // version of a modId installed but NOT matching this collection's own pinned ref (see
            // collection-runner.js's toSyncStateResult and its own buildModVersionIndex/Live callers).
            // Reused as-is rather than a second Vortex-state read -- this is exactly the "installed
            // drifted away from the pin" signal Rebuild Collection's own "a different version is
            // already installed" note already relies on.
            otherVersionsByModIdByCollection.set(collectionModId, syncState.otherVersionsByModId);
        } catch (e) {
            unreadableCollections.set(collectionModId, e.message);
        }
    }
    return { ignoredMatchers, knownVortexModIdsByCollection, otherVersionsByModIdByCollection, unreadableCollections };
}

// Scans every picked collection. Tolerant of one bad/unreadable collection -- matches
// collection-runner.js's own multi-collection tolerance pattern (one failure doesn't lose the
// others' results). onProgress: ({ collectionModId, collectionName, index, total, modName }) => void,
// called as each mod within a collection finishes.
//
// ignoredMatchers (queue: rebuild-missing-ignored-mods): optional Map<collectionModId,
// (source) => ref|null>, one entry per collection -- built by loadIgnoredAndKnownIds() (below) via
// vortex-sync/lib.js's own makeIdentityMatcher(syncState.ignored), a real Vortex-state read
// scanCollections/scanOneMod themselves deliberately never do (see this file's own header comment).
// Kept as a pure, already-resolved lookup function passed IN, not fetched here, so
// scanCollections/scanOneMod stay exactly as state-read-free and synchronous-per-mod as before --
// only the caller (rebuild-missing-routes.js's /scan route, via loadIgnoredAndKnownIds) needs to be
// Vortex-closed-gated for this, not this whole module.
// knownVortexModIdsByCollection (2026-09-14, "share one install and extraction engine", then "never
// scan without knowing which mods are Ignored" -- fixes the root cause in
// diagnostics/shared-install-engine/root-cause-findings-2026-09-14.md): optional
// Map<collectionModId, Map<"modId:fileId", vortexModId>>, one entry per collection
// loadIgnoredAndKnownIds() (below) resolved a real live Vortex read for -- the SAME read that also
// produces that collection's own ignoredMatchers entry, so callers never get one without the other.
// Threaded into each mod's own classifyMod() call below via scanOneMod's existing knownVortexModId
// param -- the SAME mechanism Rebuild Collection's own buildPlan()/classifyOneMod() always uses.
// Without this, a mod whose currently-matched archive (by collection.json's recorded size/md5) has a
// different filename than the one Vortex originally extracted from reads as "not installed at all",
// and every one of its real, present files counts as missing -- confirmed live and real (Armory of
// the Dragon Cult - Half Res, 562 files). Omitted entirely (only possible if the caller skips
// loadIgnoredAndKnownIds) falls back to the old archive-basename guessing -- not exercised by the
// real /scan route, which always calls it first.
async function scanCollections(collectionModIds, { stagingDir, downloadsDir, sevenZipExe, onProgress, ignoredMatchers, exceptionMatcher, knownVortexModIdsByCollection, otherVersionsByModIdByCollection, bridgeAvailable = false }) {
    // "Open FOMOD mods get an Install button" (2026-09-17) -- use Vortex's own recorded live
    // installerChoices before ever reaching scanOneMod's own archive-based SKIP_OPEN_FOMOD path, the
    // same shared check Update Collection v2/Rebuild Collection now use (see
    // lib/vortex-live-fomod-choices.js's own header comment). ONE live-data fetch for the whole batch
    // call (not per collection) -- the real live mods payload is large (~46MB, per
    // update-collection-v2-runner.js's own measured comment), so this is fetched once here and handed
    // to resolveEffectiveChoicesForMods() as an already-loaded value for every collection below,
    // rather than each one re-fetching it independently.
    const liveModsData = await loadLiveModsData(bridgeAvailable);
    const results = [];
    for (const collectionModId of collectionModIds) {
        const collectionJsonPath = path.join(stagingDir, collectionModId, 'collection.json');
        let collection;
        let name = collectionModId;
        try {
            collection = loadCollection(collectionJsonPath);
            name = collection.info?.name || collectionModId;
        } catch (e) {
            results.push({ collectionModId, name, error: `Could not read this collection's collection.json: ${e.message}` });
            continue;
        }
        const isIgnored = ignoredMatchers?.get(collectionModId) || (() => null);
        const knownVortexModIds = knownVortexModIdsByCollection?.get(collectionModId) || null;
        const otherVersionsByModId = otherVersionsByModIdByCollection?.get(collectionModId) || null;
        const mods = await resolveEffectiveChoicesForMods(collection.mods || [], { liveModsData });
        const modsWithMissing = [];
        const modsArchiveMissing = [];
        const modsIgnored = [];
        const modsExcepted = [];
        // "mods it couldn't check show up instead of hiding" (2026-09-14) -- scanOneMod's own
        // 'skipped' bucket (a FOMOD install this tool couldn't resolve -- an ambiguous archive, an
        // Open FOMOD with no recorded choices, an unhandled FOMOD feature) used to be dropped here
        // entirely: no `else if` branch below ever matched it, so it never reached ANY of these
        // arrays and the collection reported as if that mod had simply never existed. Confirmed
        // real and serious 2026-09-14: "Better Skyrim Parties" (Gate To Sovngarde) has a genuinely
        // empty staging folder -- no plugin, nothing -- and the scan still said "No Missing Files
        // Detected", because the mod was never counted as anything at all, missing or otherwise.
        const modsUnchecked = [];
        let optionalSkipped = 0;
        for (let i = 0; i < mods.length; i++) {
            const mod = mods[i];
            if (isOptionalNotInstalled(mod, knownVortexModIds, otherVersionsByModId)) {
                optionalSkipped++;
                if (onProgress) onProgress({ collectionModId, collectionName: name, index: i + 1, total: mods.length, modName: mod.name });
                continue;
            }
            let result;
            try {
                const knownVortexModId = knownVortexModIds && mod.source?.modId != null && mod.source?.fileId != null
                    ? knownVortexModIds.get(`${mod.source.modId}:${mod.source.fileId}`) || null
                    : null;
                const installedVersionEntries = otherVersionsByModId && mod.source?.modId != null
                    ? otherVersionsByModId[mod.source.modId] || null
                    : null;
                result = await scanOneMod(mod, { downloadsDir, stagingDir, sevenZipExe, exceptionMatcher, knownVortexModId, collectionModId, installedVersionEntries });
            } catch (e) {
                result = { bucket: 'archive-missing', name: mod.name, modId: mod.source?.modId ?? null, fileId: mod.source?.fileId ?? null, reason: e.message };
            }
            // A mod the director deliberately Ignored in Vortex still shows up as a normal
            // 'missing'/'archive-missing'/'skipped' result otherwise -- indistinguishable from a real
            // problem. Reclassified here, AFTER scanOneMod's own real classification, so the
            // underlying reason (files genuinely missing, the archive genuinely not matching, or the
            // install genuinely unresolvable) is still known -- this only changes how it's SHOWN, not
            // whether it was detected. Covers all three problem kinds equally (confirmed live: an
            // Ignored mod's archive not matching reads just as "not a real problem" as an Ignored
            // mod's files being missing -- same reasoning extends to "couldn't even check it," since
            // a deliberately-Ignored mod's own install is moot either way).
            if ((result.bucket === 'missing' || result.bucket === 'archive-missing' || result.bucket === 'skipped') && isIgnored(mod.source)) {
                result = {
                    bucket: 'ignored', name: mod.name, modId: mod.source?.modId ?? null, fileId: mod.source?.fileId ?? null,
                    reason: 'This mod is marked Ignored in Vortex -- not something to fix here.',
                };
            }
            if (result.bucket === 'missing') modsWithMissing.push(result);
            else if (result.bucket === 'archive-missing') modsArchiveMissing.push(result);
            else if (result.bucket === 'ignored') modsIgnored.push(result);
            else if (result.bucket === 'excepted') modsExcepted.push(result);
            else if (result.bucket === 'skipped') modsUnchecked.push(result);
            if (onProgress) onProgress({ collectionModId, collectionName: name, index: i + 1, total: mods.length, modName: mod.name });
        }
        // domainName (2026-09-14, "download missing archives automatically during the scan"): the
        // collection-wide default game domain, threaded through so the client can build a real Nexus
        // "view files" link (https://www.nexusmods.com/{domain}/mods/{modId}) for a mod whose OWN
        // domainName isn't set (the overwhelming common case -- see scanOneMod's own base.domainName
        // comment for the rare cross-listed exception, which still takes priority when present).
        results.push({ collectionModId, name, domainName: collection.info?.domainName || null, modsWithMissing, modsArchiveMissing, modsIgnored, modsExcepted, modsUnchecked, optionalSkipped });
    }
    return results;
}

module.exports = { listPickableCollections, scanOneMod, scanCollections, loadIgnoredAndKnownIds };
