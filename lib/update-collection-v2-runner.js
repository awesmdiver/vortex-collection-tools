'use strict';
// Framework-agnostic orchestration for Update Collection v2 (Phase 1: read-only Check for Updates +
// Review, no real apply/deploy yet) -- used by web/update-collection-v2-routes.js. See
// TECHNICAL.md's "Update Collection v2" section for the full design writeup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const semver = require('semver');
const { spawn } = require('child_process');
const syncRunner = require('./sync-runner');
const nexusCollectionDownload = require('./nexus-collection-download');
const { checkPremiumStatus } = require('./nexus-mod-download');
const { findSevenZip, listArchive, extractFile } = require('./sevenzip');
const { diffCollectionMods, didFileChange, buildIndex, findMatch, buildSharedModIndex, findSharedModMatch } = require('./collection-diff');
const { locateArchive } = require('./archive-locator');
const { findModRoot } = require('./mod-root');
const { parseModuleConfigFile, hasUnhandledFeatures } = require('./fomod-parser');
const { resolveChoices } = require('./choice-resolver');
const helperClient = require('./vortex-helper-client');
const syncLib = require('./vortex-sync/lib');
const { rebuildSingleMod } = require('./rebuild-single-mod');
const appConfig = require('./app-config');
const rulesGen = require('./rules-generator');
const cleanupScan = require('./cleanup-scan');
const { scanOneMod } = require('./missing-files-scan');

const WORKER_PATH = path.join(__dirname, 'update-collection-v2-worker.js');
const OP_TIMEOUT_MS = 30_000;
// Nexus's own game-domain slug for this game -- same convention already established elsewhere in
// this project (rebuild-single-mod.js's own NEXUS_GAME_DOMAIN), hardcoded since this toolkit is
// Skyrim SE specific throughout. Used by buildCollectionMembershipRule below for a rule reference's
// own repo.gameId, which is the NEXUS domain, not this project's internal GAME_ID ('skyrimse').
const NEXUS_GAME_DOMAIN = 'skyrimspecialedition';

function runIsolated(input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, OP_TIMEOUT_MS);

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error('This is taking too long -- Vortex may have a hidden error dialog open. Check your taskbar, close it, then try again.'));
                return;
            }
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`Update Collection v2 worker produced invalid output: ${e.message}`));
                }
                return;
            }
            const message = stderr.trim();
            if (message) console.error(`[update-collection-v2-runner] worker exited ${code}: ${message}`);
            reject(new Error(message || 'Couldn\'t read Vortex\'s database for this. Make sure Vortex is fully closed and try again.'));
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

// Every locally-installed, non-Workshop ("Added Collections") collection -- the mockup's own screen 1
// explicitly locks its "Workshop" tab ("Workshop collections aren't handled by this tool yet --
// manage those in Vortex directly"), so this tool must never show one.
//
// listInstalledCollections/scanStagingCollections' own vortex_collection_* exclusion is NOT
// sufficient by itself for this -- confirmed live, a real, genuine finding (not assumed): that
// function deliberately LETS a Workshop-tab folder through once it has real on-disk content (see its
// own header comment/hasRealWorkshopContent -- built for the OTHER tools that share this same
// function, e.g. Rules Generator's own "old collection" picker, which legitimately wants to see a
// content-bearing Workshop draft too). A real Workshop collection on this machine ("Currently
// testing", modId "vortex_collection_4WLXM1cNK") genuinely appeared in listInstalledCollections'
// own output during this task's own verification. Filtered out explicitly here, on top of whatever
// that shared function already does -- this tool's own constraint is stricter than every other
// caller of listInstalledCollections, so it can't just inherit their shared exclusion as-is.
const WORKSHOP_FOLDER_PATTERN = /^vortex_collection_/i;
function listCollections(stagingDir) {
    return syncRunner.listInstalledCollections(stagingDir).filter((c) => !WORKSHOP_FOLDER_PATTERN.test(c.modId));
}

// Live-helper path (2026-08-18) -- same helper-first pattern as every other tool in this project's
// "remove the Vortex-must-be-closed requirement" effort. Reads collectionSlug/revisionNumber/author/
// pictureUrl straight off the helper's already-fetched GET /mods response instead of state.v2 --
// confirmed live against a real install that these fields exist at the expected nested
// mod.attributes.* path (collectionSlug, revisionNumber, author, pictureUrl, customFileName), same
// parity every other *FromLiveData/*ViaHelper function in this project already established for its
// own field set. Returns null (never throws) only when the helper's own /mods read fails -- the
// caller falls back to the state.v2 path in that case.
async function resolveNexusInfoViaHelper(collectionModIds) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const out = {};
    for (const modId of collectionModIds) {
        const mod = data.mods[modId];
        const attrs = (mod && mod.attributes) || {};
        out[modId] = {
            collectionSlug: attrs.collectionSlug ?? null,
            revisionNumber: attrs.revisionNumber ?? null,
            author: attrs.author ?? null,
            pictureUrl: attrs.pictureUrl ?? null,
            liveName: attrs.customFileName ?? null,
        };
    }
    return out;
}

// State.v2 fallback -- used only when the helper extension isn't reachable.
async function resolveNexusInfo(stateDir, collectionModIds) {
    return runIsolated({ stateDir, mode: 'resolve-nexus-info', collectionModIds });
}

// Sequential, not parallel -- same pacing Workshop Report's own /check already established (its own
// header comment: "a director with many Workshop collections hitting Nexus's GraphQL endpoint in
// parallel risks rate limits"), reused here for the identical reason against the identical API.
async function fetchNewestRevisions(apiKey, collections) {
    const results = new Map();
    for (const c of collections) {
        if (!c.collectionSlug) {
            results.set(c.modId, { checkError: 'no-slug' });
            continue;
        }
        try {
            const { revisions } = await nexusCollectionDownload.fetchCollectionRevisions(apiKey, c.collectionSlug);
            const newest = nexusCollectionDownload.resolveNewestRevision(revisions);
            results.set(c.modId, newest
                ? { newestRevisionNumber: newest.revisionNumber, newestUpdatedAt: newest.updatedAt, checkError: null }
                : { checkError: 'no-revisions' });
        } catch (e) {
            results.set(c.modId, { checkError: e.message });
        }
    }
    return results;
}

// The "Check for Updates" button -- for every installed, non-Workshop collection, resolves its real
// Nexus collectionSlug + currently-installed revisionNumber (helper-first, state.v2 fallback), then
// asks Nexus for the newest published revision and compares. Read-only throughout -- never touches
// Vortex's database for a write, never downloads a bundle (that only happens in reviewUpdate below,
// once the user actually asks to review one specific collection's update).
async function checkForUpdates({ staging, state }) {
    const apiKey = nexusCollectionDownload.resolveApiKey(); // fail fast if unconfigured
    const local = listCollections(staging);
    const modIds = local.map((c) => c.modId);

    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    let nexusInfoByModId = helperAvailable ? await resolveNexusInfoViaHelper(modIds) : null;
    let source = 'helper-extension';
    if (!nexusInfoByModId) {
        source = 'state.v2';
        if (syncLib.isVortexRunning()) {
            const err = new Error('Vortex is currently running. Close it completely and try again.');
            err.code = 'VORTEX_RUNNING';
            throw err;
        }
        nexusInfoByModId = await resolveNexusInfo(state, modIds);
    }

    const enriched = local.map((c) => ({ ...c, ...(nexusInfoByModId[c.modId] || {}) }));
    const revisionResults = await fetchNewestRevisions(apiKey, enriched);

    const collections = enriched.map((c) => {
        const rev = revisionResults.get(c.modId) || {};
        const installedRevision = c.revisionNumber ?? null;
        const updateAvailable = rev.newestRevisionNumber != null && installedRevision != null
            && rev.newestRevisionNumber > installedRevision;
        return {
            modId: c.modId, name: c.liveName || c.name, author: c.author, modCount: c.modCount,
            pictureUrl: c.pictureUrl, collectionSlug: c.collectionSlug,
            installedRevision, newestRevisionNumber: rev.newestRevisionNumber ?? null,
            updateAvailable, checkError: rev.checkError || null,
        };
    });
    collections.sort((a, b) => a.name.localeCompare(b.name));
    return { collections, source };
}

// Server-side cache for the collections-overview screen (2026-08-18) -- director's own explicit
// model: "when you start Vortex it will do a collection refresh... let's do the same, when someone
// first starts the server - do this refresh to cache, images, metadata - then it's a manual
// 'Refresh' like Vortex." One real checkForUpdates pass runs automatically when the server process
// starts (web/update-collection-v2-routes.js's createUpdateCollectionV2Router triggers it once, at
// router-creation time); after that, this cache is authoritative until the user clicks Refresh --
// deliberately NO TTL, NO background re-polling. In-memory only (module-level, not persisted) --
// lost on a server restart by design, since a restart is exactly the "someone first starts the
// server" moment that re-triggers the auto-refresh anyway, same as reopening Vortex re-triggers its
// own collections refresh.
let ucv2Cache = { collections: null, source: null, checkedAt: null, refreshing: false, error: null, errorCode: null };

function getCollectionsCache() {
    return ucv2Cache;
}

// The ONE function that ever writes to the cache -- both the server-startup auto-refresh and the
// manual Refresh button call this SAME function, so there's one real cache being updated, not two
// separate mechanisms that could drift out of sync with each other. Guards against a genuine
// double-run (the startup pass and an eager manual click racing each other) by just returning the
// in-flight state rather than starting a second concurrent Nexus sweep. Never throws -- a real
// failure (Vortex running, no API key, a Nexus error) is captured INTO the cache's own `error` field,
// same "quietly skip, don't crash startup, re-checked next time" precedent shell.js's own startup
// Vortex-version-check already established, so a bad first run never takes the server down or wedges
// the cache in a permanently-refreshing state.
async function refreshCollectionsCache({ staging, state }) {
    if (ucv2Cache.refreshing) return ucv2Cache;
    ucv2Cache = { ...ucv2Cache, refreshing: true, error: null, errorCode: null };
    try {
        const result = await checkForUpdates({ staging, state });
        ucv2Cache = {
            collections: result.collections, source: result.source,
            checkedAt: Date.now(), refreshing: false, error: null, errorCode: null,
        };
    } catch (e) {
        // errorCode preserved (not just e.message) so a caller (the /check-updates route) can
        // re-derive the exact same VORTEX_RUNNING 409 checkForUpdates itself would have thrown,
        // without fragile message-string matching.
        ucv2Cache = { ...ucv2Cache, refreshing: false, error: e.message, errorCode: e.code || null };
    }
    return ucv2Cache;
}

// The "Review update" flow -- for ONE collection, downloads the newest revision's real
// collection.json from Nexus, reads the currently-installed one straight off disk (the same
// established "installed collection.json is the authoritative record of what's installed" source
// captureBackupSnapshot already relies on), and diffs them. Vortex is NOT required to be closed for
// this at all -- resolving the slug/installed-revision is the only Vortex-touching step, same
// helper-first/state.v2-fallback pattern as checkForUpdates above; reading the OLD collection.json is
// a plain local file read, and fetching the NEW one is a Nexus API call, neither ever needs Vortex.
async function reviewUpdate({ collectionModId, staging, state }) {
    const local = listCollections(staging);
    const collection = local.find((c) => c.modId === collectionModId);
    if (!collection) throw new Error(`Collection "${collectionModId}" isn't currently installed (or isn't a real, non-Workshop collection).`);

    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    let nexusInfo = helperAvailable ? await resolveNexusInfoViaHelper([collectionModId]) : null;
    let source = 'helper-extension';
    if (!nexusInfo) {
        source = 'state.v2';
        if (syncLib.isVortexRunning()) {
            const err = new Error('Vortex is currently running. Close it completely and try again.');
            err.code = 'VORTEX_RUNNING';
            throw err;
        }
        nexusInfo = await resolveNexusInfo(state, [collectionModId]);
    }
    const info = nexusInfo[collectionModId] || {};
    if (!info.collectionSlug) throw new Error(`No Nexus collection id is on record for "${collection.name}" -- can't look up its revisions.`);

    const apiKey = nexusCollectionDownload.resolveApiKey();
    const sevenZipExe = findSevenZip();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-collection-v2-'));
    // Real bug, confirmed live (2026-08-23): fetchAndExtractCollectionJson's own revisionNumber:null
    // path resolves "latest" via fetchCollectionRevision's collection(slug){latestPublishedRevision},
    // which -- same real gap fetchCollectionRevisions/resolveNewestRevision were already fixed for
    // elsewhere in this file (see that pair's own header comment, "revisionStatus: draft does NOT
    // mean nothing real here") -- silently SKIPS an unlisted/draft revision even when it's genuinely
    // the newest. checkForUpdates already resolves the real newest revision the director-correct way
    // (draft-inclusive); reviewUpdate must use that SAME resolution before downloading, or it can
    // silently download and diff against an OLDER published revision while still labeling it with the
    // newer revision number the update-check found -- exactly what happened live: the real Rev 7 had
    // no recorded FOMOD choices for "Window Shadows Ultimate - Patch Hub" (a genuine Open FOMOD, per
    // its own real instructions field), but the download that actually ran pulled in stale choices
    // from an older revision instead, so the FOMOD picker never triggered.
    const { revisions } = await nexusCollectionDownload.fetchCollectionRevisions(apiKey, info.collectionSlug);
    const newest = nexusCollectionDownload.resolveNewestRevision(revisions);
    if (!newest) throw new Error(`No revisions found on Nexus for "${collection.name}" (slug="${info.collectionSlug}").`);
    let newRevision;
    try {
        newRevision = await nexusCollectionDownload.fetchAndExtractCollectionJson({
            slug: info.collectionSlug, revisionNumber: newest.revisionNumber, destDir: tmpDir, sevenZipExe,
        });
    } finally {
        // extracted collection.json is re-read below before cleanup -- fs.rmSync only removes the
        // temp dir, the parsed data already lives in memory by then.
    }
    const newCollectionRaw = JSON.parse(fs.readFileSync(newRevision.collectionJsonPath, 'utf8'));
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const oldCollectionRaw = JSON.parse(fs.readFileSync(collection.collectionJsonPath, 'utf8'));
    const diff = diffCollectionMods(oldCollectionRaw.mods, newCollectionRaw.mods);
    // Real gap the director caught: `u.old.version` is just what the OLD collection revision happens
    // to have recorded, not necessarily what's actually installed right now -- the moment a mod is
    // updated by the user OUTSIDE this collection's own tracking, that recording goes stale and every
    // comparison built on it (the version arrow, the "keep installed" default below) silently reads
    // backwards relative to what's really going to happen to the user's files. Resolve the REAL live
    // version for each Updated mod here (helper-first, same fallback-to-stale-data convention this
    // whole file already follows when the Helper isn't reachable) -- see
    // resolveLiveVersionForUpdatedMod's own header comment for the three-tier match it uses.
    const liveModsData = helperAvailable ? await helperClient.getAllMods() : null;
    const liveMatcher = liveModsData ? buildLiveIdentityIndex(liveModsData.mods) : null;
    const liveModsByNexusId = liveModsData ? buildNexusIdIndex(liveModsData.mods) : null;
    // Flags a real, director-reported scenario: the installed (old) version is genuinely NEWER than
    // what this revision pins ("I already have Mod version 2.3.0 installed, and the collection
    // replaced it 2.2.5") -- lets the Review screen default that row's "keep installed version"
    // checkbox to checked instead of leaving the choice buried. See isInstalledVersionNewer's own
    // header comment for why this is deliberately conservative (false whenever unsure).
    // fileChanged: whether the actual mod FILE differs (md5/fileId/version), vs. the same file with
    // only its recorded FOMOD choices changed (see collection-diff.js's own didFileChange/choicesEqual
    // split). The Review screen uses this to label a choices-only row "FOMOD" instead of a same-to-
    // same version arrow, and to hide "keep installed version" for it -- that choice is about which
    // FILE is installed, meaningless when the file itself never changed.
    const updatedWithVersionFlag = diff.updated.map((u) => {
        let liveInstalledVersion = null;
        if (liveMatcher) {
            const vortexModId = resolveLiveVersionForUpdatedMod(liveMatcher, liveModsByNexusId, u);
            if (vortexModId) {
                const attrs = (liveModsData.mods[vortexModId] || {}).attributes || {};
                if (attrs.version) liveInstalledVersion = attrs.version;
            }
        }
        // Real live data wins when we have it; the collection's own stale recording is only ever the
        // fallback (Helper unreachable, or this specific mod genuinely couldn't be resolved live).
        const effectiveInstalledVersion = liveInstalledVersion || u.old.version;
        return {
            ...u,
            fileChanged: didFileChange(u.old, u.new),
            installedIsNewer: isInstalledVersionNewer(effectiveInstalledVersion, u.new.version),
            // Only set when it's a REAL live version that differs from the collection's own recorded
            // one -- the Review screen uses this to show what's actually about to happen
            // (real-installed -> new) instead of the stale old-revision-pin -> new arrow. null (not
            // just falsy-absent) is deliberate here so the frontend can tell "checked and same" apart
            // from "never checked" if that distinction is ever needed later.
            liveInstalledVersion: liveInstalledVersion && liveInstalledVersion !== u.old.version ? liveInstalledVersion : null,
        };
    });

    // "Shared with another collection" annotation on Removed mods (2026-08-21) -- reuses Safe
    // Collection Removal's own real, proven cross-reference wholesale (buildSharedModIndex/
    // findSharedModMatch, now shared via collection-diff.js so both tools run the exact same
    // identity-matching logic, not two separately-maintained copies -- see that file's own header
    // comment on those two functions). Same reasoning remove-collection-runner.js's own reviewRemoval
    // already documents: cross-reference against EVERY other real installed collection, including
    // Workshop-authored ones with genuine content (syncRunner.listInstalledCollections, deliberately
    // NOT the Workshop-excluding `local`/listCollections used to resolve `collection` above -- that
    // exclusion is about what THIS tool can update, not about what counts as "another collection" for
    // shared-mod purposes). Skipped entirely when nothing was removed -- no other collection.json
    // needs reading if there's no removed mod to check them against.
    let removedWithSharedFlag = diff.removed.map((m) => ({ ...m, shared: false, usedBy: [] }));
    if (diff.removed.length > 0) {
        const otherCollections = syncRunner.listInstalledCollections(staging).filter((c) => c.modId !== collectionModId);
        // Same optional-mod fallback convention as remove-collection-runner.js's own
        // filterToLikelyInstalled -- not reused directly (it isn't exported, and this file already
        // has its own local resolveLiveModId to call, so importing it back would just re-create the
        // circular require this whole relocation was written to avoid).
        const filterToLikelyInstalled = (mods) => (liveMatcher
            ? mods.filter((m) => !!resolveLiveModId(liveMatcher, m.source))
            : mods.filter((m) => m.optional !== true));
        const otherIndexes = otherCollections.map((c) => {
            let mods = [];
            try {
                mods = JSON.parse(fs.readFileSync(c.collectionJsonPath, 'utf8')).mods || [];
            } catch {
                mods = [];
            }
            return { name: c.name, index: buildSharedModIndex(filterToLikelyInstalled(mods)) };
        });
        removedWithSharedFlag = diff.removed.map((m) => {
            const usedBy = [];
            for (const o of otherIndexes) {
                if (findSharedModMatch(o.index, m)) usedBy.push(o.name);
            }
            return { ...m, shared: usedBy.length > 0, usedBy };
        });
    }

    return {
        collectionModId, collectionName: collection.liveName || collection.name,
        installedRevision: info.revisionNumber ?? null, newRevisionNumber: newRevision.revisionNumber,
        newRevisionId: newRevision.revisionId ?? null,
        removed: removedWithSharedFlag, updated: updatedWithVersionFlag, added: diff.added,
        // Display-only (2026-08-18) -- every mod matched with no genuine update, so the Review
        // screen's total row count can reconcile against the collection's real total mod count.
        // Never read by applyUpdate below -- Apply still only ever acts on removed/updated/added.
        unchanged: diff.unchanged,
        // The new revision's own author-written load-order/conflict rules -- Phase 2's own finalize
        // step applies these against the just-updated live mod set (see applyCollectionModRules).
        // Purely additive field; harmless to any caller (e.g. Phase 1's own Review screen) that
        // doesn't read it.
        modRules: newCollectionRaw.modRules || [],
        source,
    };
}

// ---------------------------------------------------------------------------------------------
// Phase 2 (2026-08-18): real Apply for the Updated and Removed buckets only -- see TECHNICAL.md's
// "Update Collection v2 Phase 2" section for the full research/design writeup (real Vortex source
// findings on deploy-single-mod/remove-mods/setModAttributes, the fast-extraction-plus-metadata-
// refresh design the director explicitly asked for instead of mimicking Vortex's own slow
// InstallManager reinstall, and the live-data backup this phase uses to keep Vortex open
// throughout). Added mods and Optional Installs are explicitly OUT of scope here -- a genuinely NEW
// mod (no existing state.v2 entry) raises a real, unresolved registration question this phase
// deliberately does not guess at; see the research doc for what Phase 3 needs to answer first.
// ---------------------------------------------------------------------------------------------

// Same identity-matching primitive vortex-sync/lib.js already uses for same-session resolution
// (rule references against currently-installed mods) -- confirmed the RIGHT strictness for THIS use
// case (unlike collection-diff.js's own cross-revision matcher, which deliberately avoids
// makeIdentityMatcher/tag -- see that file's own header comment for why). Here, both sides of the
// match come from the SAME collection.json snapshot (the currently-installed one): the OLD
// collection.json's own mod.source, and the live Vortex mod's own attributes, which were set from
// that EXACT same collection.json at install time -- confirmed live 2026-08-18 that
// attrs.referenceTag/modId/fileId/fileMD5 match a real installed mod's own collection.json
// source.tag/modId/fileId/md5 exactly.
function buildLiveIdentityIndex(mods) {
    const refs = Object.keys(mods).map((vortexModId) => {
        const attrs = mods[vortexModId].attributes || {};
        return { vortexModId, fileMD5: attrs.fileMD5, tag: attrs.referenceTag, modId: attrs.modId, fileId: attrs.fileId };
    });
    return syncLib.makeIdentityMatcher(refs);
}

// sourceLike: a collection.json mod's own `source` object ({md5, tag, modId, fileId, ...}).
// Returns the real, live Vortex modId (the mods###<gameId>###<modId> key) or null.
function resolveLiveModId(matcher, sourceLike) {
    const match = matcher(sourceLike);
    return match ? match.vortexModId : null;
}

// Bare-Nexus-modId index over Vortex's live mods -- Map<String(modId), vortexModId[]>. Only ever
// consulted as a LAST resort (see resolveLiveVersionForUpdatedMod below); a mod page contributing
// more than one live-installed file (a Main file plus a separately-installed Patch, same real
// ambiguity collection-diff.js's own modIdentityKeys header comment documents for the cross-revision
// case) shows up here as a multi-entry list, and the caller refuses to guess between them.
function buildNexusIdIndex(mods) {
    const byNexusId = new Map();
    for (const [vortexModId, mod] of Object.entries(mods)) {
        const attrs = mod.attributes || {};
        if (attrs.modId == null) continue;
        const key = String(attrs.modId);
        if (!byNexusId.has(key)) byNexusId.set(key, []);
        byNexusId.get(key).push(vortexModId);
    }
    return byNexusId;
}

// Resolves the REAL live Vortex mod id for one Updated-bucket pair, for reading its actual current
// version -- three tiers, checked in order, never guesses:
//   1. `u.old.source` via the strict identity matcher (md5/tag/modId+fileId -- vortex-sync/lib.js's
//      own identityKeys) -- the common case: this mod hasn't been touched outside the collection, so
//      its live identity still matches exactly what the OLD revision recorded.
//   2. `u.new.source` via the same strict matcher -- an earlier partial apply already moved this mod
//      forward to the NEW revision's identity (same real case applyUpdate's own "already-up-to-date"
//      check handles, see that function's header comment).
//   3. Bare Nexus modId (same mod PAGE, any file) -- the real gap the director caught: a mod updated
//      by the user OUTSIDE this collection's own tracking has live fileId/md5/tag that match NEITHER
//      side of this diff at all (it's a genuinely different, third file), so tiers 1-2 correctly find
//      nothing. Only trusted when it resolves to EXACTLY ONE live mod -- same "ambiguous -> refuse"
//      rule buildNexusIdIndex's own header comment describes, so a Main+Patch mod page never gets
//      guessed between.
function resolveLiveVersionForUpdatedMod(matcher, liveModsByNexusId, u) {
    let vortexModId = resolveLiveModId(matcher, u.old.source);
    if (!vortexModId) vortexModId = resolveLiveModId(matcher, u.new.source);
    if (!vortexModId && liveModsByNexusId && u.old.source && u.old.source.type === 'nexus' && u.old.source.modId != null) {
        const candidates = liveModsByNexusId.get(String(u.old.source.modId));
        if (candidates && candidates.length === 1) vortexModId = candidates[0];
    }
    return vortexModId;
}

// Live-data equivalent of vortex-sync/lib.js's own captureBackupSnapshot (see sync-runner.js's own
// version for the state.v2 original) -- same {ignored, disabled, oldMods} shape, same
// buildBackupSnapshot/saveBackup so the result lands in the SAME backups folder, in the SAME file
// format, visible in the SAME "restore a previous backup" UI Update Collection (Classic) already
// has -- just sourced from the helper's already-fetched live data instead of state.v2, so Vortex
// never has to close for this (director's own explicit call, 2026-08-18: keep Vortex open the whole
// time, don't reintroduce the close-then-reopen hang this whole mechanism exists to avoid). Returns
// null (never throws) if the collection's own live rules can't be read -- caller decides whether a
// missing backup should block the apply.
async function captureLiveBackupSnapshot({ collectionModId, collectionName, staging, data }) {
    const rules = await helperClient.getLiveRulesForMod(collectionModId);
    if (rules === null) return null;
    const ignored = syncLib.extractIgnored(rules);

    const enabledSet = new Set(data.enabledModKeys);
    const disabledCandidates = [];
    for (const [vortexModId, mod] of Object.entries(data.mods)) {
        if (enabledSet.has(vortexModId)) continue;
        const attrs = mod.attributes || {};
        disabledCandidates.push({
            vortexModId, name: attrs.customFileName || attrs.modName || vortexModId,
            fileMD5: attrs.fileMD5, tag: attrs.referenceTag, modId: attrs.modId, fileId: attrs.fileId,
            author: attrs.author, category: attrs.category, version: attrs.version,
        });
    }
    let disabled = syncLib.filterToCollectionMembers(disabledCandidates, rules);
    if (staging) disabled = syncLib.attachPluginFiles(disabled, staging);

    let oldMods = null;
    try {
        const collectionJsonPath = path.join(staging, collectionModId, 'collection.json');
        const raw = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
        oldMods = syncLib.extractModsForSnapshot(raw);
    } catch {
        oldMods = null;
    }

    return syncLib.buildBackupSnapshot({
        collectionModId, collectionName, profileId: data.profileId, profileName: null,
        stagingDir: staging, ignored, disabled, oldMods,
    });
}

// ---------------------------------------------------------------------------------------------
// Dependency-break detection (2026-08-18) -- replicates Vortex's own real "Updating may break
// dependencies" modal (InstallManager.ts, around its queryIgnoreDependent call), confirmed against
// real source, not guessed. Vortex's real check: for a mod being updated, find every OTHER
// currently-installed mod with a `requires` rule that currently resolves to the OLD version but
// would NOT resolve to the NEW one. ONLY `requires` rules trigger this -- confirmed via real source,
// NOT before/after/conflicts, even though real installed rule data on this machine has plenty of
// non-"*" versionMatch values on those OTHER types too (load-order rules, not dependency rules --
// checked and confirmed via a live grep across this machine's own real /mods data before assuming
// otherwise).
// ---------------------------------------------------------------------------------------------

// Mirrors Vortex's own real coerceToSemver/safeCoerce (mod_management/util/coerceToSemver.ts,
// confirmed via real source) -- turns a loose, non-strict version string (very common in real mod
// metadata, e.g. "1.5", "2.3.5a") into something `semver` can actually compare, without changing
// what it means (a bare "1.5" becomes "1.5.0", never silently widened into a range).
function coerceToSemverLoose(version) {
    const trimmed = (version || '').trim();
    if (!trimmed) return undefined;
    const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (match) {
        const [, major, minor, patch, rest] = match;
        const preRelease = rest.trim().replace(/^[.\-+]/, '');
        return preRelease ? `${major}.${minor}.${patch}-${preRelease}` : `${major}.${minor}.${patch}`;
    }
    if (/^v?[0-9.]+$/.test(trimmed)) {
        const sanitized = trimmed.replace(/\b0+(\d)/g, '$1');
        const coerced = semver.coerce(sanitized);
        return coerced ? coerced.version : trimmed;
    }
    return undefined;
}

function safeCoerceLoose(input) {
    return /^v?[0-9.]+$/.test(input || '') ? (coerceToSemverLoose(input) || input) : input;
}

// Reimplements Vortex's own real collectionModToRule (collections/util/transformCollection.ts,
// confirmed via real source, not guessed) -- a director-caught, real gap in Phase 3 (2026-08-18): a
// newly-Added mod installed correctly (registered, attributes, enabled, deployed -- confirmed live,
// enabled+deployed in Vortex's own Mods table with the right version) but showed NO collection
// association at all. Traced the real mechanism: Vortex does NOT mark a member mod with a
// "belongs to collection X" attribute of its own -- it adds a real `requires` RULE to the
// COLLECTION's OWN live mod entry, referencing the member's identity (confirmed by reading
// state-query-worker.js's own scanAllCollections, already established in this project: collection
// membership is resolved by matching a live mod's identity against the COLLECTION mod's own
// `rules[]`, never a per-member attribute). Scoped to this project's own real case -- Nexus-sourced
// mods only, the only source.type this project's own mod objects ever carry in practice -- not the
// full bundle/direct/manual matrix Vortex's own real function also handles.
function buildCollectionMembershipRule(mod, effectiveMod) {
    const { source } = mod;
    const coerced = coerceToSemverLoose(mod.version);
    const { updatePolicy } = source;
    let versionMatch;
    if (updatePolicy === 'prefer') {
        versionMatch = coerced ? `>=${coerced}+prefer` : mod.version;
    } else if (updatePolicy === 'latest') {
        versionMatch = '*';
    } else {
        // Default to 'exact' for undefined or explicit 'exact' updatePolicy -- matches Vortex's own
        // real fallback exactly.
        versionMatch = coerced || mod.version;
    }
    const reference = {
        description: mod.name,
        fileMD5: source.md5,
        gameId: syncLib.GAME_ID,
        fileSize: source.fileSize,
        versionMatch,
        logicalFileName: source.logicalFilename,
    };
    // Only a fuzzy (prefer/latest) reference gets md5Hint -- matches Vortex's own real conditional
    // exactly (an 'exact' reference already pins the file precisely via versionMatch itself).
    if (updatePolicy === 'latest' || updatePolicy === 'prefer') reference.md5Hint = source.md5;
    reference.repo = {
        repository: 'nexus', gameId: NEXUS_GAME_DOMAIN,
        modId: String(source.modId), fileId: String(source.fileId), campaign: 'collection',
    };
    // Real mods on this project's own machine always carry their own collection-assigned tag
    // (confirmed: every real reference this project has ever read has one) -- no deterministic-tag
    // fallback needed the way Vortex's own function has for a tagless/legacy case.
    reference.tag = source.tag;
    const rule = {
        type: 'requires', reference, phase: 0,
        extra: { author: mod.author, version: mod.version, name: mod.name, instructions: mod.instructions || undefined },
    };
    // A FOMOD-choice mod's real rule carries its own resolved installerChoices -- effectiveMod (not
    // mod) so a freshly-resolved picker choice this apply made is what's recorded, same "persist
    // what was ACTUALLY extracted" reasoning as effectiveAddedByOriginal's own collection.json entry.
    if (effectiveMod.choices) rule.installerChoices = effectiveMod.choices;
    return rule;
}

// A collection revision can specify an OLDER version than what's already installed -- a curator
// downgrading, or the director having manually updated past what the collection currently pins
// ("I already have Mod version 2.3.0 installed, and the collection replaced it 2.2.5", his own real
// test case). Uses the SAME semver coercion as the dependency-break check above -- deliberately
// conservative: returns false (don't pre-check the "keep installed" box) whenever either version
// can't be interpreted as a real version, rather than guessing. Never throws.
function isInstalledVersionNewer(installedVersion, collectionVersion) {
    const installedCoerced = coerceToSemverLoose(installedVersion);
    const collectionCoerced = coerceToSemverLoose(collectionVersion);
    if (!semver.valid(installedCoerced) || !semver.valid(collectionCoerced)) return false;
    return semver.gt(installedCoerced, collectionCoerced);
}

// Mirrors Vortex's own real testRef version-match block (mod_management/util/testModReference.ts,
// confirmed via real source, including its exact escape-hatch order) -- given a mod's real
// version/fileMD5 and a rule reference's own versionMatch constraint, returns whether that version
// satisfies it. Three escape hatches checked before ever reaching real semver-range comparison,
// exactly matching Vortex's own real priority: an exact string match, a byte-identical file (the
// version STRING can differ while the content is still literally the same file), or the two
// version strings coercing to the same normalized form. Only once all three fail does this fall to
// `semver.satisfies` -- and if the version can't even be interpreted as a version at all, Vortex's
// own real behavior is to refuse (require the exact string match), not guess compatible.
function versionSatisfiesRequirement(modVersion, modFileMD5, ref) {
    if (!ref || !ref.versionMatch || ref.versionMatch === '*' || !modVersion) return true; // nothing to check
    const versionMatch = ref.versionMatch.split('+')[0];
    if (modVersion === ref.versionMatch) return true;
    if (ref.fileMD5 && ref.fileMD5 === modFileMD5) return true;
    if (safeCoerceLoose(modVersion) === safeCoerceLoose(versionMatch)) return true;
    const versionCoerced = coerceToSemverLoose(modVersion);
    if (semver.valid(versionCoerced)) {
        return semver.satisfies(versionCoerced, versionMatch, { loose: true, includePrerelease: true });
    }
    return false;
}

// Mirrors Vortex's own real idOnlyRef (mod_management/util/testModReference.ts) -- a reference with
// nothing but a bare live-id link has no real identifying data to ever go stale, so it can never
// "break" via a version bump; Vortex's own real dependency-break check excludes these too.
function isIdOnlyRef(ref) {
    if (!ref || ref.id === undefined) return false;
    const realKeys = Object.keys(ref).filter((k) => !['id', 'archiveId', 'versionMatch', 'idHint'].includes(k));
    return realKeys.length === 0;
}

// For each mod in the Updated bucket, finds every OTHER currently-installed mod (excluding the
// collection's own entry -- its own rules get refreshed by applyCollectionModRules above, a separate
// concern) whose own `requires` rule currently resolves to the mod being updated but would NOT
// resolve to it once updated to the new revision's own version. Uses the SAME identity-matching
// primitive (syncLib.makeIdentityMatcher/ruleReferenceIdentity) already established throughout this
// file, not a new/different matcher.
//
// Deliberately goes FURTHER than Vortex's own real modal, per the director's own explicit complaint
// that it "doesn't tell me anything" -- returns full detail per break (which mod depends on which,
// old/new version, the failing constraint) instead of a bare "may be incompatible" flag.
function findBrokenDependencies(updated, mods, collectionModId) {
    const breaks = [];
    updated.forEach((u, updatedIndex) => {
        const oldMatcher = syncLib.makeIdentityMatcher([u.old.source]);
        for (const [dependentVortexModId, mod] of Object.entries(mods)) {
            if (dependentVortexModId === collectionModId) continue;
            for (const rule of (mod.rules || [])) {
                if (rule.type !== 'requires') continue;
                if (isIdOnlyRef(rule.reference)) continue;
                if (!oldMatcher(syncLib.ruleReferenceIdentity(rule))) continue; // not about the mod being updated
                const newVersionOk = versionSatisfiesRequirement(u.new.version, u.new.source && u.new.source.md5, rule.reference);
                if (newVersionOk) continue;
                const attrs = mod.attributes || {};
                breaks.push({
                    updatedIndex,
                    dependentVortexModId,
                    dependentName: attrs.customFileName || attrs.modName || dependentVortexModId,
                    updatedModName: u.new.name,
                    oldVersion: u.old.version,
                    newVersion: u.new.version,
                    versionMatch: rule.reference.versionMatch,
                    rule,
                });
            }
        }
    });
    return breaks;
}

// Applies a collection.json's own `modRules` array (author-written load-order/conflict rules) into
// Vortex's live per-mod rules database -- the "applying collection rules" half of Vortex's own real
// finalize step (see applyUpdate's own call site for the full context). Genuinely NOT the same job as
// rules-generator.js's own applyRules/computeRulesToApply -- those transcribe rules BETWEEN two
// DIFFERENT installed collections (an old collection's proven rules, carried into a newer/different
// collection variant, via analyzeCollections' own cross-collection mapping). This writes the SAME
// collection's own new-revision-authored rules, matched against its own just-updated live mod set --
// a plain identity resolution, not a cross-collection mapping problem at all. Reuses the SAME
// low-level primitives applyRules itself uses internally (computeUpsertOp, CONFLICT_RULE_TYPES,
// helperClient.applyRuleChange) rather than a third rule-writing mechanism.
//
// Identity: confirmed via real data (a real installed collection.json's own modRules array) that each
// entry's `source`/`reference` are shaped `{fileMD5, fileExpression, versionMatch, logicalFileName}`
// -- fileMD5-first, no modId/fileId at all. This is a SAME-REVISION identity question (this revision's
// own rules, against mods just re-extracted to this SAME revision's own exact archives), matching
// buildLiveIdentityIndex/resolveLiveModId's own already-established md5-priority matcher (used
// elsewhere in this file for the identical reason) -- NOT collection-diff.js's own deliberately
// different matcher, which exists specifically to compare mods ACROSS two revisions where fileMD5 is
// proven worthless (see that file's own header comment). Different problem, different tool -- reusing
// collection-diff.js's matcher here would be reaching for the wrong one, not more reuse.
//
// modRules is a flat, whole-collection array (not scoped to one mod's own rules[]) -- each entry names
// BOTH sides explicitly. A rule whose source or target mod isn't currently installed (an Added/Optional
// mod still deferred to Phase 3, or a Removed mod the user chose to keep untracked but not reinstall)
// is silently skipped -- expected, not an error; counted in unresolvedCount for transparency.
async function applyCollectionModRules(modRules, matcher, mods) {
    const byMod = new Map(); // sourceVortexModId -> [{type, targetVortexModId}]
    let unresolvedCount = 0;
    for (const rule of modRules) {
        if (!rulesGen.CONFLICT_RULE_TYPES.includes(rule.type)) continue; // requires/recommends are handled via mods[].source dependencies elsewhere, not this phase's job
        const sourceVortexModId = resolveLiveModId(matcher, rule.source);
        const targetVortexModId = resolveLiveModId(matcher, rule.reference);
        if (!sourceVortexModId || !targetVortexModId) { unresolvedCount += 1; continue; }
        if (!byMod.has(sourceVortexModId)) byMod.set(sourceVortexModId, []);
        byMod.get(sourceVortexModId).push({ type: rule.type, targetVortexModId });
    }

    const modsChanged = [];
    let totalRulesWritten = 0;
    for (const [sourceVortexModId, rulesToAdd] of byMod) {
        const attrs = (mods && mods[sourceVortexModId] && mods[sourceVortexModId].attributes) || {};
        const name = attrs.customFileName || attrs.modName || sourceVortexModId;
        // Read fresh right before writing, same as rules-generator.js's own applyRules -- don't trust
        // even THIS function's own just-fetched matcher snapshot for the mutation itself.
        const currentRules = await helperClient.getLiveRulesForMod(sourceVortexModId);
        if (currentRules === null) {
            modsChanged.push({ vortexModId: sourceVortexModId, name, ok: false, error: "Couldn't read this mod's current live rules." });
            continue;
        }
        let workingRules = currentRules;
        const ops = [];
        for (const { type, targetVortexModId } of rulesToAdd) {
            const result = rulesGen.computeUpsertOp(workingRules, type, targetVortexModId);
            workingRules = result.workingRules;
            if (result.op) ops.push(result.op);
        }
        if (ops.length === 0) continue; // every rule for this mod already exactly matches -- true no-op, nothing to write or report
        try {
            for (const { remove, add } of ops) {
                const ok = await helperClient.applyRuleChange(sourceVortexModId, remove, add);
                if (!ok) throw new Error(`Couldn't apply a rule change for "${sourceVortexModId}".`);
            }
            totalRulesWritten += ops.length;
            modsChanged.push({ vortexModId: sourceVortexModId, name, ok: true, rulesWritten: ops.length });
        } catch (e) {
            modsChanged.push({ vortexModId: sourceVortexModId, name, ok: false, error: e.message });
        }
    }
    return { modsChanged, totalRulesWritten, unresolvedCount };
}

// ---------------------------------------------------------------------------------------------
// FOMOD-choice-needed detection (2026-08-18) -- lib/choice-resolver.js is REPLAY-only by its own
// design (its own header comment: reproduces a mod's already-recorded choices "with zero UI
// interaction"). That's the right tool when a collection's own curator already made the choice --
// but Update Collection v2's real Apply can hit an Updated mod where there's genuinely no valid
// prior choice to replay. Two REAL, distinct cases, confirmed via real source before assuming
// otherwise (rebuild-mod.js's own classifyMod, extract-mod.js's own real extraction path):
//
//   1. "Open" -- the new revision's own collection.json recorded NO choices at all for a mod whose
//      real archive genuinely has a FOMOD installer. This is the SAME real signal classifyMod's own
//      SKIP_OPEN_FOMOD already detects for Rebuild Collection -- confirmed via real source, not
//      rebuilt here, just reused for the Updated-bucket case specifically.
//   2. "Choices mismatch" -- recorded choices DO exist, but the new revision's own ModuleConfig.xml
//      changed shape enough that they no longer cleanly map. Confirmed via real source
//      (choice-resolver.js's own resolveChoices): this does NOT throw or refuse today -- it
//      degrades silently via `warnings[]` (a missing installStep entry drops that step's files
//      entirely; a step NAME mismatch still applies the stale choices anyway, position-matched,
//      with only a warning) -- meaning a shape-changed FOMOD currently produces a wrong or
//      incomplete extraction with NO hard failure surfaced anywhere. This detection runs
//      resolveChoices in a dry preview (same real parser, same real resolver, zero writes) and
//      treats ANY warning as "needs a fresh human choice", rather than trusting the silent
//      degradation.
// ---------------------------------------------------------------------------------------------

// Real mod-type FOMOD group selection semantics (SelectExactlyOne/SelectAtMostOne = radio,
// SelectAny/SelectAtLeastOne/SelectAll = checkbox) live in the group's own real `type` attribute,
// already parsed verbatim by fomod-parser.js -- the frontend picker reads this directly, no new
// classification needed here.

// For ONE Updated-bucket entry, returns `null` if no fresh choice is needed, or a real detail
// object (name, reason, the parsed FOMOD structure to render) if one is. Never throws -- a mod
// whose archive can't even be located, or isn't a FOMOD-installer archive at all, is a DIFFERENT,
// pre-existing problem the real extraction step already reports; this gate only concerns itself
// with the specific "needs a human FOMOD choice" case.
async function detectFomodChoiceNeed(newMod, downloadsDir, sevenZipExe) {
    let archivePath;
    try {
        archivePath = await locateArchive(downloadsDir, newMod.source);
    } catch {
        return null; // no archive resolvable -- the real extraction step already reports this
    }
    let entries;
    try {
        entries = await listArchive(sevenZipExe, archivePath);
    } catch {
        return null;
    }
    // findModRoot THROWS (not a falsy configPath) when the archive has no FOMOD installer at all --
    // real, pre-existing bug found and fixed here (2026-08-18): this call was previously unguarded,
    // so ANY non-FOMOD mod reaching this gate crashed the whole apply outright with a raw 500
    // ("No 'fomod/ModuleConfig.xml' found anywhere in the archive."), confirmed live testing Added
    // mods for the first time against a real collection where most Added mods are plain (non-FOMOD)
    // archives. Never caught before because no real apply had previously exercised this gate against
    // a non-FOMOD mod since it shipped -- same "not a FOMOD-installer archive at all, nothing to
    // check" outcome as every other early-return in this function, just via a throw instead of a
    // falsy return.
    let configPath;
    let rootPrefix;
    try {
        ({ configPath, rootPrefix } = findModRoot(entries));
    } catch {
        return null;
    }

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucv2-fomod-peek-'));
    let parsedFomod;
    try {
        const extractedConfigPath = await extractFile(sevenZipExe, archivePath, configPath, scratchDir);
        parsedFomod = parseModuleConfigFile(extractedConfigPath);
    } catch {
        return null; // couldn't even parse the config -- a different, pre-existing problem
    } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    // A top-level always-installed <files> block is a different, already-known parser gap
    // (fomod-parser.js's own header comment) -- not this gate's problem to solve.
    if (hasUnhandledFeatures(parsedFomod)) return null;

    const hasRecordedChoices = newMod.choices && newMod.choices.type === 'fomod';
    if (!hasRecordedChoices) {
        return { name: newMod.name, reason: 'open', parsedFomod };
    }

    const rootPrefixLower = (rootPrefix || '').toLowerCase();
    const relativeEntries = rootPrefix
        ? entries
            .filter((e) => {
                const lower = e.path.toLowerCase();
                return lower.startsWith(`${rootPrefixLower}\\`) || lower.startsWith(`${rootPrefixLower}/`);
            })
            .map((e) => ({ ...e, path: e.path.slice(rootPrefix.length + 1) }))
        : entries;
    const { warnings } = resolveChoices(parsedFomod, newMod.choices, relativeEntries);
    if (warnings.length > 0) {
        // existingChoices: the collection's own recorded (but no-longer-cleanly-replayable) picks --
        // passed through so the picker can pre-select + label whatever still matches by name as
        // "(Preset)", matching real Vortex's own real preset-driven dialog (confirmed against the
        // real engine, XmlScriptExecutor.cs's convertOptions/preselectOptions: an option is marked
        // `preset`/pre-selected purely because it matches a SUPPLIED prior choice by name -- nothing
        // to do with the FOMOD's own "Recommended" type, an initial wrong assumption corrected by
        // reading the real source). Deliberately NOT set for the "open" reason below -- there's
        // nothing recorded to preset from, matching real Vortex exactly (no supplied preset there
        // either).
        return { name: newMod.name, reason: 'mismatch', warnings, parsedFomod, existingChoices: newMod.choices };
    }
    return null;
}

// Scans every Updated-bucket entry for a real FOMOD-choice need, in parallel with the SAME
// concurrency reasoning this project's own extraction already uses (independent per-mod archive
// reads, no shared state). Returns an array of `{updatedIndex, name, reason, warnings?,
// parsedFomod}` -- `updatedIndex` is safe to use here (unlike a value round-tripped through the
// client) since it's only ever consumed within this SAME applyUpdate call, immediately after.
async function detectFomodChoiceNeeds(updated, downloadsDir, sevenZipExe) {
    const results = await Promise.all(updated.map((u) => detectFomodChoiceNeed(u.new, downloadsDir, sevenZipExe)));
    const needs = [];
    results.forEach((r, updatedIndex) => { if (r) needs.push({ updatedIndex, ...r }); });
    return needs;
}

// Builds the FULL `choices.options` structure resolveChoices() expects from a user's fresh real
// picks -- one entry per RAW install step (in document order, matching resolveChoices' own
// positional-match contract), each with EVERY group (even one with zero real selections, as an
// empty `choices: []`) -- an entry must exist for every step/group or resolveChoices would log a
// spurious "no recorded choices" warning for a group that was correctly, deliberately left empty.
// `picks`: `{ [stepIdx]: { [groupIdx]: number[] } }` -- the frontend's own selected plugin indices
// per group, keyed positionally (matching how the picker renders parsedFomod.installSteps).
function buildFomodChoicesFromPicks(parsedFomod, picks) {
    const options = parsedFomod.installSteps.map((step, stepIdx) => ({
        name: step.name,
        groups: step.groups.map((group, groupIdx) => {
            // A SelectAll group has no real choice to make -- every plugin installs regardless of
            // any pick, matching the real FOMOD spec. Auto-including every index here (rather than
            // relying on the frontend to send them all) means a SelectAll group's own files can
            // never be silently dropped just because nothing was rendered as clickable for it.
            const selectedIndices = group.type === 'SelectAll'
                ? group.plugins.map((_, idx) => idx)
                : (picks && picks[stepIdx] && picks[stepIdx][groupIdx]) || [];
            return {
                name: group.name,
                choices: selectedIndices.map((idx) => ({ idx, name: group.plugins[idx] ? group.plugins[idx].name : '' })),
            };
        }),
    }));
    return { type: 'fomod', options };
}

// Plugin-file-change detection (2026-08-18) -- whether a real Vortex "Deploy Mods" is needed
// afterward for plugins.txt/loadorder.txt to reflect this apply. Confirmed via real Vortex source
// (docs/VORTEX-DEPLOY-REFERENCE.md): this project's own applyUpdate deploys through the Helper's
// `deploy-single-mod` event (per-mod file linking only), which NEVER fires `did-deploy` -- that's
// only emitted by the full `deploy-mods` pipeline. `did-deploy` is what `gamebryo-plugin-management`
// reacts to, and it does so UNCONDITIONALLY after every real deploy (confirmed reading `onDidDeploy`
// directly, gamebryo-plugin-management/src/index.ts ~1701-1760: `updatePluginList` runs and
// `autosort-plugins` fires regardless of whether the deploy actually touched a plugin file) -- this
// project's per-mod path skips that reconciliation on EVERY apply, not just plugin-changing ones.
// The reason this only WARNS on a real plugin-file change, not every apply, isn't that Vortex treats
// an asset-only update specially -- it's that re-running the skipped reconciliation on an UNCHANGED
// plugin set would just re-sort the same list into the same order, so skipping it there has no real
// consequence. The gap is always technically there; it's only ever visible when a plugin file was
// actually added, removed, or renamed.
//
// Deliberately NOT auto-triggering a fix here -- investigated and rejected two options, both real
// risks rather than a narrow safe fix: (1) emitting a real `deploy-mods` would re-run the FULL
// pipeline (sort/merge/incompatibility-check/finalize across every enabled mod) -- exactly the
// multi-hour-hang risk this project's whole single-mod-deploy architecture exists to avoid (same
// root cause as the "Helper unavailable during deploy" investigation elsewhere in this file's own
// history: `saveActivation`'s synchronous LevelDB write across the WHOLE mod list). (2) emitting a
// synthetic `did-deploy` directly (skipping the real pipeline) would fire EVERY extension's own
// `did-deploy` listener system-wide, not just gamebryo-plugin-management's -- an unaudited blast
// radius across Vortex's whole extension ecosystem, not a narrowly-scoped plugins.txt refresh.
// Confirmed there's no narrower purpose-built "just resync the plugin list" event exposed to
// extensions either (`autosort-plugins` alone only re-sorts plugins ALREADY known to Vortex's
// session state -- it doesn't discover a newly-added/removed plugin file, which is exactly the case
// that matters here). Real Vortex's OWN answer to "bulk operation added/removed plugins outside a
// normal single-mod install" is the SAME thing -- a collection install marks a "pending plugin sort"
// and still waits for a real deploy to settle before LOOT re-sorts. There's no cheaper real path.
// So: detect precisely, tell the user plainly, let them run Vortex's own Deploy Mods themselves.
const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);
function listPluginBasenamesLower(folderPath) {
    try {
        return new Set(
            fs.readdirSync(folderPath)
                .filter((f) => PLUGIN_EXTENSIONS.has(path.extname(f).toLowerCase()))
                .map((f) => f.toLowerCase()),
        );
    } catch {
        return new Set(); // folder missing/unreadable -- treat as "no plugins", never fail the apply over this
    }
}
// True only if the plugin-file SET (by basename) genuinely differs -- added, removed, or renamed.
// Re-extracting the exact same plugin(s) (an asset-only update) returns false.
function pluginSetChanged(beforeSet, afterSet) {
    if (beforeSet.size !== afterSet.size) return true;
    for (const name of beforeSet) if (!afterSet.has(name)) return true;
    return false;
}

// The actual apply -- re-extracts each Updated mod's NEW archive into its EXISTING staging slot
// (lib/rebuild-single-mod.js, the SAME engine Missing Masters' Rebuild This Mod uses -- deliberately
// NOT going through Vortex's own InstallManager, which is the multi-hour hang this whole mechanism
// exists to route around), refreshes that mod's own metadata so Vortex's UI shows correct info
// afterward, then deploys just that one mod. Removed mods: "remove" fully uninstalls them via
// Vortex's own real remove-mods event; "keep" takes no Vortex action at all -- the mod simply stops
// being tracked in this project's own saved copy of the collection once Apply finishes (see the
// collection.json overwrite at the end). Added mods are deliberately left untouched -- Phase 3, not
// this phase; each Added row in the result is marked skipped so the caller can render that plainly
// rather than implying nothing happened to them.
//
// REQUIRES the helper extension (Vortex genuinely open) -- there is no state.v2 equivalent for
// deploy-single-mod/remove-mods/setModAttributes; these are real Vortex actions dispatched through
// Vortex's own running process, not database rows this project could otherwise write directly.
//
// Split into prepareApply (this) + runApply (below) 2026-08-21, for real live streamed progress
// (director's own task: mirror PGPatcher's /build + /build/events SSE shape). Everything that can
// genuinely REFUSE the whole apply before any write happens -- the dependency-break and FOMOD-choice
// gates -- has to stay a synchronous, pre-202 check (same "check first, only then kick off the real
// background work" shape PGPatcher's own DynDoLOD gate already uses): the user needs to make a real
// decision before any write proceeds, so these can never be represented as progress events on the
// real stream. prepareApply is exactly the old applyUpdate's own top half, UNCHANGED logic, just
// returning its resolved state instead of falling through into the real write work. runApply is the
// old bottom half (backup onward), now accepting that resolved state plus an onProgress callback.
async function prepareApply({ collectionModId, staging, downloads, state, ignoreDependencyBreaks, keepInstalledModIds, fomodPicks }) {
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperAvailable) {
        const err = new Error('The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to apply an update -- this real deploy/remove/metadata work only exists through it, unlike this tool\'s read-only routes, which can also fall back to state.v2.');
        err.code = 'HELPER_UNAVAILABLE';
        throw err;
    }

    // Fresh re-review right before writing anything -- never trust a client-held diff that may be
    // stale (same "always re-derive server-side" principle every real write in this project follows).
    const review = await reviewUpdate({ collectionModId, staging, state });

    const collection = listCollections(staging).find((c) => c.modId === collectionModId);
    if (!collection) throw new Error(`Collection "${collectionModId}" isn't currently installed (or isn't a real, non-Workshop collection).`);

    // "You curated this collection" (2026-08-18) -- purely informational (see the note below in the
    // final result), so a failure here (no API key configured, a Nexus API hiccup) never blocks the
    // real apply -- defaults to false and moves on.
    const isOwnCollection = await checkIsOwnCollection(collection.author);

    const data = await helperClient.getAllMods();
    if (!data) throw new Error("Couldn't read Vortex's live mod list -- try again.");

    // Keep-installed-version choice ("I already have Mod version 2.3.0 installed, and the
    // collection replaced it 2.2.5 -- I want to keep the newer mod"). Keyed by the Nexus modId of
    // the OLD (currently-installed) entry -- stable across the diff (the mod PAGE doesn't change on
    // an update, only fileId/version do), so the client can hold onto it between Review and Apply
    // without depending on array order. String-coerced since collection.json's own modId is a
    // number while a client-held id might round-trip as a string.
    const keptModIds = new Set((keepInstalledModIds || []).map(String));

    // Dependency-break gate -- checked BEFORE any real write (backup included), so a refusal is
    // instant and side-effect-free, matching Vortex's own real "Cancel" default. Re-derived fresh
    // here (never trusted from a stale client-held copy), reusing `data` already fetched above --
    // zero extra network cost. See findBrokenDependencies' own header comment for the full design.
    //
    // A mod kept at its installed version can never genuinely "break" a dependent -- its version
    // literally isn't changing, so whatever already satisfied a dependent's rule keeps satisfying
    // it. Modeled by substituting `new: u.old` for a kept mod before break-detection runs, rather
    // than adding a second special-case branch inside findBrokenDependencies itself.
    const updatedForBreakCheck = review.updated.map((u) => (keptModIds.has(String(u.old.source && u.old.source.modId)) ? { ...u, new: u.old } : u));
    const dependencyBreaks = findBrokenDependencies(updatedForBreakCheck, data.mods, collectionModId);
    if (dependencyBreaks.length > 0 && !ignoreDependencyBreaks) {
        const err = new Error(`Updating ${dependencyBreaks.length} mod's dependents may break -- see dependencyBreaks for detail. Set ignoreDependencyBreaks to proceed anyway.`);
        err.code = 'DEPENDENCY_BREAKS_FOUND';
        err.dependencyBreaks = dependencyBreaks;
        throw err;
    }

    // FOMOD-choice gate -- same "check before any real write, refuse with real detail, let the
    // caller resolve and re-call" pattern as the dependency-break gate above. `fomodPicks` (keyed
    // by the mod's stable Nexus modId, same reasoning as keepInstalledModIds) carries whatever the
    // caller already resolved in an earlier round trip -- a need covered by a supplied pick is
    // resolved here, not re-flagged; anything NOT covered still blocks the apply outright.
    const fomodPicksSupplied = fomodPicks || {};
    const sevenZipExe = findSevenZip();
    // Added mods (2026-08-18, Phase 3) need the SAME real FOMOD-choice gate Updated mods already
    // get -- collection.json always records the curator's own choices for EVERY mod, installed or
    // not, so detectFomodChoiceNeed works unmodified against an Added mod too; it doesn't assume
    // the mod was ever previously installed, it just checks the recorded `choices` against the
    // archive's real FOMOD structure. No recorded choices at all (a genuine "Open FOMOD" the
    // curator left to installer discretion) surfaces as reason:'open', same real picker either way
    // -- there's no separate "fresh install" picker to build, the existing one already covers it.
    // detectFomodChoiceNeeds expects `{new: mod}` pairs (matching review.updated's own shape); Added
    // mods are wrapped inline rather than changing that shared function's contract.
    const updatedFomodNeeds = await detectFomodChoiceNeeds(review.updated, downloads, sevenZipExe);
    const addedFomodNeeds = await detectFomodChoiceNeeds(review.added.map((m) => ({ new: m })), downloads, sevenZipExe);
    // modId resolved once here (not deferred via updatedIndex) so the rest of this gate -- and the
    // Added-mod install loop below -- can treat Updated/Added needs identically from this point on.
    const fomodChoiceNeeds = [
        ...updatedFomodNeeds.map((n) => ({ ...n, modId: String(review.updated[n.updatedIndex].new.source && review.updated[n.updatedIndex].new.source.modId) })),
        ...addedFomodNeeds.map((n) => ({ ...n, modId: String(review.added[n.updatedIndex].source && review.added[n.updatedIndex].source.modId) })),
    ];
    const stillNeeded = fomodChoiceNeeds.filter((n) => !Object.prototype.hasOwnProperty.call(fomodPicksSupplied, n.modId));
    if (stillNeeded.length > 0) {
        const err = new Error(`${stillNeeded.length} mod(s) need a real FOMOD choice before Apply can continue -- see fomodChoiceNeeds for detail.`);
        err.code = 'FOMOD_CHOICES_NEEDED';
        err.fomodChoiceNeeds = stillNeeded.map((n) => ({
            modId: n.modId, name: n.name, reason: n.reason, warnings: n.warnings, parsedFomod: n.parsedFomod,
            existingChoices: n.existingChoices,
        }));
        throw err;
    }
    // Resolve fresh choices for every need the caller DID supply a pick for -- reuses the SAME
    // parsedFomod the detection pass already extracted, no redundant second archive read.
    const resolvedFomodChoices = new Map(); // modId (string) -> fresh choices object
    for (const n of fomodChoiceNeeds) {
        if (Object.prototype.hasOwnProperty.call(fomodPicksSupplied, n.modId)) {
            resolvedFomodChoices.set(n.modId, buildFomodChoicesFromPicks(n.parsedFomod, fomodPicksSupplied[n.modId]));
        }
    }

    // Every gate has cleared -- this is everything runApply below needs, already resolved, so it
    // never has to re-derive (or re-fetch) any of this itself.
    return { review, collection, isOwnCollection, data, keptModIds, dependencyBreaks, resolvedFomodChoices };
}

// Polls Vortex's own real deploy-mods progress (helperClient.getDeployAllProgress) WHILE
// deployAllMods() is in flight, emitting a real {type:'progress'} event on every tick -- same exact
// polling shape web/pgpatcher-routes.js's own runFullDeployWithProgress already established for this
// identical problem (a real Vortex deploy has no other progress signal). Not literally shared code
// (that function lives in a route file, this is a runner-layer concern per this file's own
// architecture), but deliberately the SAME mechanism -- this is what "reuse the existing
// deployAllResult-driven progress, don't rebuild it" means here: the real signal source
// (getDeployAllProgress) is unchanged, only how it reaches the client changed (SSE push instead of a
// separate GET /apply-progress poll, which this whole task supersedes).
async function runDeployAllWithProgress(onProgress, phaseLabel) {
    onProgress({ type: 'phase', message: phaseLabel });
    const pollInterval = setInterval(async () => {
        const progress = await helperClient.getDeployAllProgress();
        if (progress && typeof progress.percent === 'number') {
            onProgress({ type: 'progress', message: phaseLabel, current: Math.round(progress.percent), total: 100 });
        }
    }, 1000);
    try {
        return await helperClient.deployAllMods();
    } finally {
        clearInterval(pollInterval);
    }
}

// Plain-language replacements for the real internal status/kind values a failed rebuildSingleMod()
// call can still return once resolveMode:'all' is wired into both Apply loops below (2026-08-22) --
// confirmed by reading rebuild-mod.js/rebuild-single-mod.js's own current real output, not assumed.
// FAILED_MISMATCH_NOT_TOUCHED should no longer be reachable from EITHER loop at all now that
// resolveMode is always passed -- kept here only as a harmless defensive fallback, not because it's
// expected to fire. CRITICAL_MANUAL_RESTORE_NEEDED is deliberately NOT in this table -- rebuild-mod.js
// already returns a good, actionable `.detail` for it (the real "go to Rebuild Collection and Resume
// from previous incomplete run" instruction), so the fallback chain below already surfaces it
// correctly without needing an override.
// Copy pass by Gemini (queue: update-collection-v2-apply-failure-messages-gemini-pass, 2026-08-22).
const APPLY_FAILURE_MESSAGES = {
    FAILED_MISMATCH_NOT_TOUCHED: "This mod's installed files did not match the update archive, so no changes were made. This should rarely happen, but if repeating Apply Update does not fix it, open Rebuild Collection to resolve this mod.",
    FAILED_EXTRACTION_NOT_TOUCHED: "Unpacking the archive failed, so your existing installed files were left unchanged. Delete the downloaded archive and run Apply Update again to fetch a fresh copy.",
    FAILED_EXTRACTION_NO_PRIOR_DATA: "Unpacking the archive failed and no prior version was installed, leaving this mod's files incomplete. Delete the downloaded archive and run Apply Update again to fetch a fresh copy.",
    SKIP_OPEN_FOMOD: "This mod requires manual installer choices that were not saved in this collection. Install this mod directly through Vortex instead.",
};

// Shared by both the Updated and Added loops below -- same priority order both already used inline
// (downloadError/downloadSkipped describe what JUST happened during a real auto-download attempt,
// more relevant than a stale classify detail), now also checking APPLY_FAILURE_MESSAGES before
// falling back to rebuildMod's own `.detail`/kind/status, so a known real failure gets a real
// sentence instead of a raw internal string leaking straight to the user.
function describeApplyFailure(rebuildResult) {
    if (rebuildResult.downloadError) return `Auto-download failed: ${rebuildResult.downloadError}`;
    if (rebuildResult.downloadSkipped === 'not-premium') return 'Auto-download needs Nexus Premium.';
    const status = rebuildResult.status || rebuildResult.kind;
    return APPLY_FAILURE_MESSAGES[status] || rebuildResult.detail || status || 'Extraction did not complete.';
}

// ---- Apply Result "Retry" support (2026-08-23) ----
// A few of the Apply Result screen's own "problems" are genuinely isolated, single operations that
// don't need a whole fresh Apply to re-run -- this section gives each one a real, standalone re-run
// path. Shared functions here are used BOTH by runApply's own real first-time run above and by the
// retry* functions below, so the two can never silently drift apart.
//
// applyRetryCache: review.modRules / review.newRevisionNumber / review.newRevisionId /
// review.removed / removedResults aren't persisted anywhere once the original /apply request
// completes. A fresh reviewUpdate() COULD stand in for the first three (a real, if heavier, Nexus
// re-fetch) -- but NOT for removed/removedResults: a fresh review's own `removed` list only shows
// mods NOT YET removed from this collection's tracking, so a mod whose file-removal already
// succeeded (just its membership-rule cleanup failed) would no longer appear in it at all, making a
// fresh-review-based retry silently unable to find (and re-strip) its stale rule. Caching the
// ACTUAL originally-computed values sidesteps that mismatch honestly, for every category, rather
// than re-deriving three of the four one way and the fourth another way. Keyed by collectionModId,
// overwritten by the next successful apply for that same collection, and expired after a bounded
// window so this never grows unbounded across many collections/sessions.
//
// A single Updated/Added mod's own extraction retry (retryModExtraction below) deliberately does
// NOT use this cache -- it re-runs a fresh reviewUpdate() instead, which is the honestly-correct
// choice there: the whole point of that retry is re-checking this mod's real current state (its
// live Vortex identity, whether it's already been resolved some other way since) before trying
// again, not replaying stale data from the original failed attempt.
const APPLY_RETRY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- covers "reviewing the Apply Result screen", not meant as a durable record
const applyRetryCache = new Map(); // collectionModId -> { savedAt, modRules, newRevisionNumber, newRevisionId, removed, removedResults }

function cacheApplyRetryData(collectionModId, fields) {
    applyRetryCache.set(collectionModId, { savedAt: Date.now(), ...fields });
}

function getApplyRetryData(collectionModId) {
    const entry = applyRetryCache.get(collectionModId);
    if (!entry) return null;
    if (Date.now() - entry.savedAt > APPLY_RETRY_CACHE_TTL_MS) {
        applyRetryCache.delete(collectionModId);
        return null;
    }
    return entry;
}

function retryDataExpiredError() {
    const err = new Error("This apply's own data has expired -- run Apply Update again to retry.");
    err.code = 'RETRY_DATA_EXPIRED';
    return err;
}

// The new revision's own author-written collection rules, applied against a FRESH live mod read --
// shared by runApply's own real first-time run and retryModRules below. See runApply's own call
// site (further down) for why a fresh read (not the pre-apply one) is required, and why it's
// wrapped in withHelperRetry.
async function applyModRulesFresh(modRules) {
    // withHelperRetry (2026-08-23) -- this was a single, un-retried call, unlike most other Helper
    // reads in this file. Real gap: Vortex's own renderer can genuinely still be busy finishing
    // per-mod deploy work from the Updated/Added loops just above when this fires (or, for a retry,
    // from whatever the director was just doing in Vortex), and a real ~46MB /mods payload competing
    // with that can plausibly miss MODS_TIMEOUT_MS (5s) -- confirmed live, director's own report
    // ("Couldn't re-read Vortex's live mod list..."). A few retries with real backoff gives Vortex
    // genuine room to catch up before this gives up.
    const freshData = await withHelperRetry(() => helperClient.getAllMods());
    if (!freshData) {
        return { modsChanged: [], totalRulesWritten: 0, unresolvedCount: 0, error: "Couldn't re-read Vortex's live mod list to apply this revision's own collection rules." };
    }
    return applyCollectionModRules(modRules, buildLiveIdentityIndex(freshData.mods), freshData.mods);
}

// Strips a removed mod's own stale membership rule off the COLLECTION mod's own live `rules` array --
// shared by runApply's own real first-time run and retryMembershipCleanup below. See runApply's own
// call site (further down) for the full real-Vortex-source reasoning on why this exists at all.
async function cleanupRemovedMembershipRules(collectionModId, removed, removedResults) {
    const eligibleForCleanup = removedResults.filter((r) => r.ok === true && (r.action === 'removed' || r.action === 'already-removed'));
    if (eligibleForCleanup.length === 0) return { ok: true, count: 0, error: null };
    const removedSourceByNameForRules = new Map(removed.map((m) => [m.name, m.source]));
    try {
        const liveRules = await helperClient.getLiveRulesForMod(collectionModId);
        if (!liveRules) return { ok: false, count: 0, error: "Couldn't read the collection's own live rules." };
        let count = 0;
        let allOk = true;
        for (const r of eligibleForCleanup) {
            const source = removedSourceByNameForRules.get(r.name);
            if (!source) continue;
            const removedMatcher = syncLib.makeIdentityMatcher([source]);
            const rule = liveRules.find((rl) => rl.type === 'requires' && removedMatcher(syncLib.ruleReferenceIdentity(rl)));
            if (!rule) continue; // no stale rule found on the collection -- nothing to strip
            const ok = await withHelperRetry(() => helperClient.applyRuleChange(collectionModId, rule, undefined));
            if (ok) count += 1; else allOk = false;
        }
        return {
            ok: allOk, count,
            error: allOk ? null : "Vortex didn't confirm every membership-rule removal -- the collection may still list a removed mod as a member.",
        };
    } catch (e) {
        return { ok: false, count: 0, error: e.message };
    }
}

// Advances the COLLECTION mod's own revisionNumber/version/newestVersion(/revisionId) attributes --
// shared by runApply's own real first-time run and retryCollectionAttributes below. See runApply's
// own call site (further down) for the full real-Vortex-source reasoning on why this exists at all.
async function updateCollectionAttributes(collectionModId, newRevisionNumber, newRevisionId) {
    try {
        const newRevisionStr = String(newRevisionNumber);
        const ok = await withHelperRetry(() => helperClient.setModAttributes(collectionModId, {
            revisionNumber: newRevisionNumber,
            version: newRevisionStr,
            newestVersion: newRevisionStr,
            ...(newRevisionId != null ? { revisionId: newRevisionId } : {}),
        }));
        return {
            ok,
            error: ok ? null : "Vortex didn't confirm the write -- the next Check for Updates (and Vortex's own native Update prompt) may still show this same revision as available.",
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// Retry #1: re-runs this revision's own author-written collection rules against a fresh live read.
async function retryModRules({ collectionModId }) {
    const cached = getApplyRetryData(collectionModId);
    if (!cached) throw retryDataExpiredError();
    if (!cached.modRules || cached.modRules.length === 0) return { modsChanged: [], totalRulesWritten: 0, unresolvedCount: 0 };
    return applyModRulesFresh(cached.modRules);
}

// Retry #2: re-runs the collection mod's own revisionNumber/version/newestVersion/revisionId write.
async function retryCollectionAttributes({ collectionModId }) {
    const cached = getApplyRetryData(collectionModId);
    if (!cached) throw retryDataExpiredError();
    return updateCollectionAttributes(collectionModId, cached.newRevisionNumber, cached.newRevisionId);
}

// Retry #3: re-runs the removed-mods membership-rule cleanup against the ORIGINAL apply's own
// removed/removedResults (not a fresh review -- see applyRetryCache's own header comment for why a
// fresh review can't stand in for this one specifically).
async function retryMembershipCleanup({ collectionModId }) {
    const cached = getApplyRetryData(collectionModId);
    if (!cached) throw retryDataExpiredError();
    return cleanupRemovedMembershipRules(collectionModId, cached.removed, cached.removedResults);
}

// Looks up a downloaded archive by its own real fileMD5 (same identity signal deletedArchiveResults
// elsewhere in this file already uses) and deletes it via the SAME primitive that block already
// uses (cleanupScan.deleteEntries -- a plain fs.rmSync per path). Best-effort: a mod whose archive
// is already gone, or was never downloaded through Vortex, has nothing to delete -- not an error,
// since the point is only ensuring a genuinely STALE/corrupt file doesn't survive to be re-extracted
// against again; a missing file already satisfies that.
async function deleteStaleArchive(source, downloads) {
    if (!source || !source.md5) return;
    try {
        const downloadsData = await helperClient.getAllDownloads();
        if (!downloadsData) return;
        const file = Object.values(downloadsData.files).find((f) => f.fileMD5 === source.md5);
        if (!file || !file.localPath) return;
        cleanupScan.deleteEntries([path.join(downloads, file.localPath)]);
    } catch (e) {
        console.error(`[update-collection-v2-runner] couldn't delete stale archive before retry: ${e.message}`);
    }
}

// Replaces (or, for a brand-new Added mod, appends) one mod's own entry in the on-disk
// collection.json after a successful single-mod retry -- the same real backup-before-write and
// identity-matched replace convention runApply's own bulk collection.json merge already uses
// (buildIndex/findMatch, collection-diff.js), scoped to just the one mod this retry touched instead
// of re-walking the whole file's worth of results.
function mergeOneModIntoCollectionJson(collectionJsonPath, oldEntryForMatch, newEntryToWrite) {
    const currentRaw = fs.readFileSync(collectionJsonPath, 'utf8');
    const currentParsed = JSON.parse(currentRaw);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(`${collectionJsonPath}.pre-update-${stamp}.json`, currentRaw);
    let newMods;
    if (oldEntryForMatch) {
        const matchIndex = buildIndex([oldEntryForMatch]);
        let replaced = false;
        newMods = currentParsed.mods.map((mod) => {
            if (!replaced && findMatch(matchIndex, mod)) {
                replaced = true;
                return newEntryToWrite;
            }
            return mod;
        });
        if (!replaced) newMods.push(newEntryToWrite); // wasn't tracked yet (e.g. an Added mod) -- append
    } else {
        newMods = [...currentParsed.mods, newEntryToWrite];
    }
    fs.writeFileSync(collectionJsonPath, JSON.stringify({ ...currentParsed, mods: newMods }, null, 2));
}

// Retry #4 -- the concrete, real-world case: a single Updated/Added mod's own extraction failure
// (FAILED_EXTRACTION_NOT_TOUCHED / FAILED_EXTRACTION_NO_PRIOR_DATA / FAILED_MISMATCH_NOT_TOUCHED --
// the last one shouldn't occur anymore now that resolveMode:'all' is always passed, but this retry
// still recovers it the same way if it somehow does). The real recovery is deleting the archive and
// re-downloading fresh, then running the FULL extraction pipeline again -- not a shortcut, so this
// does not use rebuildSingleMod's own "already up to date" scanOneMod shortcut the main Updated loop
// uses; it always deletes and re-extracts for real. Re-derives this mod's own current review entry
// via a fresh reviewUpdate() (see applyRetryCache's own header comment for why this one path is
// deliberately NOT cache-based) rather than the original bucket loops' own in-flight state, so a
// retry always acts on this mod's CURRENT real state, not stale data from the attempt that failed.
async function retryModExtraction({ collectionModId, staging, downloads, state, modId }) {
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperAvailable) {
        const err = new Error('The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to retry this.');
        err.code = 'HELPER_UNAVAILABLE';
        throw err;
    }
    const review = await reviewUpdate({ collectionModId, staging, state });
    const collection = listCollections(staging).find((c) => c.modId === collectionModId);
    if (!collection) throw new Error(`Collection "${collectionModId}" isn't currently installed (or isn't a real, non-Workshop collection).`);
    const data = await helperClient.getAllMods();
    if (!data) throw new Error("Couldn't read Vortex's live mod list -- try again.");
    const matcher = buildLiveIdentityIndex(data.mods);
    const sevenZipExe = findSevenZip();

    const u = review.updated.find((x) => String(x.old.source && x.old.source.modId) === String(modId));
    const m = !u ? review.added.find((x) => String(x.source && x.source.modId) === String(modId)) : null;

    if (!u && !m) {
        // Genuinely good news, not an error -- this mod no longer shows as needing an update/install
        // at all in a fresh review, so whatever this retry would have done is already done (or moot).
        return { ok: true, alreadyResolved: true, name: null, error: null };
    }

    if (u) {
        const vortexModId = resolveLiveModId(matcher, u.old.source) || resolveLiveModId(matcher, u.new.source);
        if (!vortexModId) {
            return { ok: false, name: u.new.name, error: "Couldn't find this mod in Vortex's current live state -- it may have been removed since the original apply." };
        }
        await deleteStaleArchive(u.new.source, downloads);
        const fomodNeed = await detectFomodChoiceNeed(u.new, downloads, sevenZipExe);
        if (fomodNeed) {
            return { ok: false, name: u.new.name, error: "This mod's installer needs a real FOMOD choice that isn't recorded -- run Apply Update again to make that choice, then retry." };
        }
        const rebuildResult = await rebuildSingleMod({
            vortexModId, gameId: syncLib.GAME_ID, downloadsDir: downloads, stagingDir: staging,
            mod: u.new, allowAutoDownload: true, resolveMode: 'all',
        });
        if (rebuildResult.status !== 'REBUILT') {
            return { ok: false, name: u.new.name, error: describeApplyFailure(rebuildResult), status: rebuildResult.status || rebuildResult.kind };
        }
        const newArchiveId = await resolveDownloadIdForArchive(u.new);
        const attrsOk = await helperClient.setModAttributes(vortexModId, {
            version: u.new.version, modName: u.new.name,
            fileMD5: u.new.source && u.new.source.md5, modId: u.new.source && u.new.source.modId,
            fileId: u.new.source && u.new.source.fileId, fileSize: u.new.source && u.new.source.fileSize,
            logicalFileName: u.new.source && u.new.source.logicalFilename,
            referenceTag: u.new.source && u.new.source.tag,
            ...(newArchiveId ? { archiveId: newArchiveId } : {}),
        });
        const deployOk = await helperClient.deployMod(vortexModId, true);
        if (deployOk) {
            try {
                mergeOneModIntoCollectionJson(collection.collectionJsonPath, u.old, u.new);
            } catch (e) {
                console.error(`[update-collection-v2-runner] retry succeeded but couldn't update local collection.json: ${e.message}`);
            }
        }
        return {
            ok: deployOk, name: u.new.name, attributesRefreshed: attrsOk, deployed: deployOk,
            fileCount: rebuildResult.fileCount,
            error: deployOk ? null : "Files were re-extracted but Vortex couldn't deploy them -- check Vortex's own log.",
        };
    }

    // Added-mod retry -- mirrors the main Added loop's own install sequence, minus the FOMOD-choice
    // resolution (already gated at the original Apply's own prepareApply, and re-checked fresh below
    // the same way the Updated retry above does).
    await deleteStaleArchive(m.source, downloads);
    const fomodNeed = await detectFomodChoiceNeed(m, downloads, sevenZipExe);
    if (fomodNeed) {
        return { ok: false, name: m.name, error: "This mod's installer needs a real FOMOD choice that isn't recorded -- run Apply Update again to make that choice, then retry." };
    }
    const rebuildResult = await rebuildSingleMod({
        vortexModId: null, gameId: syncLib.GAME_ID, downloadsDir: downloads, stagingDir: staging,
        mod: m, allowAutoDownload: true, resolveMode: 'all',
    });
    if (rebuildResult.status !== 'REBUILT') {
        return { ok: false, name: m.name, error: describeApplyFailure(rebuildResult), status: rebuildResult.status || rebuildResult.kind };
    }
    const newVortexModId = rebuildResult.targetFolderName;
    const vortexMod = {
        id: newVortexModId, state: 'installed', type: '', installationPath: newVortexModId,
        attributes: { name: m.name, installTime: new Date().toISOString() },
    };
    let createOk = await withHelperRetry(() => helperClient.createMod(newVortexModId, vortexMod));
    let liveState = null;
    if (!createOk) {
        liveState = await verifyModLiveState(newVortexModId);
        createOk = liveState.registered;
    }
    if (!createOk) {
        return { ok: false, name: m.name, vortexModId: newVortexModId, error: "Files were extracted, but Vortex couldn't register this as a new mod after real retries -- check Vortex's own log." };
    }
    const newArchiveId = await resolveDownloadIdForArchive(m);
    const attrsOk = await withHelperRetry(() => helperClient.setModAttributes(newVortexModId, {
        version: m.version, modName: m.name,
        fileMD5: m.source && m.source.md5, modId: m.source && m.source.modId,
        fileId: m.source && m.source.fileId, fileSize: m.source && m.source.fileSize,
        logicalFileName: m.source && m.source.logicalFilename,
        referenceTag: m.source && m.source.tag,
        ...(m.source && m.source.type === 'nexus' ? { source: 'nexus' } : {}),
        ...(newArchiveId ? { archiveId: newArchiveId } : {}),
        enableallplugins: true,
    }));
    let enabledOk = await withHelperRetry(() => helperClient.setModEnabled(newVortexModId, true));
    if (!enabledOk) {
        if (!liveState) liveState = await verifyModLiveState(newVortexModId);
        enabledOk = liveState.enabled;
    }
    let deployOk = await withHelperRetry(() => helperClient.deployMod(newVortexModId, true));
    if (!deployOk) deployOk = verifyModDeployedOnDisk(newVortexModId, staging);
    let membershipOk = true;
    if (deployOk) {
        membershipOk = await withHelperRetry(() => helperClient.applyRuleChange(collectionModId, undefined, buildCollectionMembershipRule(m, m)));
        if (!membershipOk) membershipOk = await verifyMembershipLive(collectionModId, m.source);
    }
    const ok = deployOk;
    const problems = [];
    if (!attrsOk) problems.push('metadata (version/fileId/etc) may be stale');
    if (!enabledOk) problems.push("the Mods table's Enabled checkbox may not reflect this mod");
    if (!membershipOk) problems.push("Vortex may not show this mod as part of the collection");
    if (!deployOk) problems.push("Vortex couldn't deploy it after real retries");
    if (ok) {
        try {
            mergeOneModIntoCollectionJson(collection.collectionJsonPath, null, m);
        } catch (e) {
            console.error(`[update-collection-v2-runner] retry succeeded but couldn't update local collection.json: ${e.message}`);
        }
    }
    return {
        ok, name: m.name, vortexModId: newVortexModId, attributesRefreshed: attrsOk, enabled: enabledOk,
        membershipLinked: membershipOk, deployed: deployOk, fileCount: rebuildResult.fileCount,
        error: problems.length > 0 ? `${problems.join('; ')} -- check Vortex's own log.` : null,
    };
}

// The real write work -- everything that happens once prepareApply's own gates have all cleared.
// `prepared` is prepareApply's own already-resolved return value for THIS SAME apply request, never
// re-derived here. Emits real phase/progress events via onProgress as each stage actually happens,
// at minimum: the backup snapshot, each Updated mod's own extraction, removal, each Added mod's own
// install, rule application, and the final deploy -- SSE-streamed by the route (see
// web/update-collection-v2-routes.js's own POST /apply + GET /apply/events, mirroring PGPatcher's
// /build + /build/events shape directly).
async function runApply({ prepared, collectionModId, staging, downloads, syncBackupRoot, removedChoice, ignoreDependencyBreaks, deleteArchives, onProgress = () => {} }) {
    const { review, collection, isOwnCollection, data, keptModIds, dependencyBreaks, resolvedFomodChoices } = prepared;

    onProgress({ type: 'phase', message: 'Taking a backup snapshot…' });
    const backupSnapshot = await captureLiveBackupSnapshot({
        collectionModId, collectionName: review.collectionName, staging, data,
    });
    let backupPath = null;
    let backupError = null;
    if (backupSnapshot && syncBackupRoot) {
        try {
            backupPath = syncLib.saveBackup(backupSnapshot, syncBackupRoot);
        } catch (e) {
            backupError = e.message;
        }
    } else if (!syncBackupRoot) {
        backupError = 'No backups folder is configured under Settings -- set one before applying a real update.';
    } else {
        backupError = "Couldn't read this collection's live rules to build a backup snapshot.";
    }
    if (!backupPath) {
        // No backup, no apply -- this is the first operation in this whole effort that can change
        // files Skyrim itself loads; skipping the backup step is never acceptable here.
        const err = new Error(`Couldn't take a real backup before applying -- refusing to continue. ${backupError || ''}`.trim());
        err.code = 'BACKUP_FAILED';
        throw err;
    }

    const matcher = buildLiveIdentityIndex(data.mods);

    // Phase 2b (2026-08-18): Ignored/Disabled preservation -- the one thing Update Collection
    // (Classic) already does well that Phase 2 shipped without. Classic's own applyIgnores/
    // applyDisables (vortex-sync/lib.js) are built around a fundamentally different flow (they run
    // either side of a full native Vortex reinstall, requiring Vortex closed) and don't fit this
    // phase's in-place-re-extraction mechanism at all -- see TECHNICAL.md's "Phase 2b" section for
    // the full reasoning. What DOES carry over directly: captureLiveBackupSnapshot above already
    // captures this collection's ignored/disabled state in the exact shape needed (backupSnapshot.
    // ignored: rule refs; backupSnapshot.disabled: live mods, including their own vortexModId, not
    // currently in data.enabledModKeys) -- Phase 2b's whole job is USING that already-captured data,
    // not re-deriving it.
    //
    // Ignored: a mod flagged ignored:true on the collection's own rules may never have actually been
    // installed by Vortex in the first place (that's what "ignored" means to Vortex's own install
    // flow) -- if such a mod also shows up in this diff's Updated/Removed buckets (collection.json's
    // raw mods[] is a separate concept from the rules' ignored flag), attempting extraction/removal
    // on it would either fail confusingly or act on a mod that was never really present. Skipped
    // cleanly instead, `ok: null` (the SAME convention addedResults already uses for Phase-3-deferred
    // Added mods) so the collectionJsonUpdated merge below leaves its existing local entry untouched.
    //
    // Disabled: a REAL bug in Phase 2's own shipped code, found while researching this -- the Updated
    // loop's `deployMod(vortexModId, true)` below is hardcoded, which force-enables a mod the user
    // had deliberately disabled as an unintended side effect of redeploying its updated files. Fixed
    // by tracking which live mod ids this apply's Updated loop actually force-enabled
    // (touchedVortexModIds), then -- ONLY after the whole update finishes -- re-disabling whichever of
    // THOSE were captured as disabled beforehand. Deliberately scoped to touched mods only, not every
    // disabled member of the collection: an untouched mod's enabled state was never disturbed by this
    // apply (Phase 2 never redeploys a mod it didn't re-extract), so re-issuing a disable call on it
    // would be a redundant, wasted round-trip -- a real collection here can have 100+ disabled mods.
    const ignoredMatcher = syncLib.makeIdentityMatcher(backupSnapshot.ignored);
    const touchedVortexModIds = new Set();
    let pluginFileChangeDetected = false; // see listPluginBasenamesLower/pluginSetChanged above

    const updatedResults = [];
    // Tracks the effective NEW mod entry actually used for each Updated-bucket item -- for a mod
    // the FOMOD gate resolved a fresh real pick for, this is `u.new` with `choices` overridden, so
    // the collection.json merge below persists what was ACTUALLY extracted, not the stale/absent
    // recorded choices. A future Rebuild This Mod on this same mod then replays the real pick that
    // was just made, instead of re-hitting the same "needs a choice" gate every time.
    const effectiveNewByOld = new Map();
    // Same reasoning as effectiveNewByOld above, for the Added-mod install loop below -- keyed by
    // the ORIGINAL review.added entry (object identity, same convention) rather than modId, since
    // that's what the collection.json merge iterates to decide which Added mods actually succeeded.
    const effectiveAddedByOriginal = new Map();
    for (let updatedI = 0; updatedI < review.updated.length; updatedI += 1) {
        const u = review.updated[updatedI];
        // Keyed by u.old.source.modId (not u.new) so it's byte-identical to the frontend's own
        // ucv2UpdatedModId(u) lookup -- both describe the same live mod, but matching the EXACT
        // helper the review table already uses to key its rows avoids any chance of drift between
        // the two call sites ever silently breaking the mod-start/mod-complete row lookup.
        const modId = String(u.old.source && u.old.source.modId);
        onProgress({ type: 'progress', message: `Extracting ${u.new.name}…`, current: updatedI + 1, total: review.updated.length });
        onProgress({ type: 'mod-start', modId, name: u.new.name });
        const finishUpdated = (result) => {
            // modId (2026-08-23) -- carried onto the pushed result too, not just the SSE frame, so
            // Apply Result's own per-problem Retry button knows which mod to re-run (POST
            // /apply/retry-mod's own real target identifier).
            updatedResults.push({ ...result, modId });
            onProgress({
                type: 'mod-complete', modId, name: u.new.name, ok: result.ok,
                error: result.error || null, action: result.action || null, status: result.status || null,
            });
        };
        if (ignoredMatcher(u.old.source)) {
            finishUpdated({ name: u.new.name, ok: null, action: 'ignored-skipped' });
            continue;
        }
        // Keep-installed-version choice -- checked before ignored-skipped's own resolution attempt
        // so the user's explicit choice is never overridden. Deliberately NOT touched at all (no
        // extraction, no deploy, no attribute refresh) -- the whole point is leaving this mod's
        // files/version exactly as they are. ok: null (same convention as ignored-skipped/added
        // mods) so the collection.json merge below leaves this mod's existing (still-accurate) local
        // entry untouched -- replacing it with the new revision's data would misdescribe what's
        // actually installed. Accepted, deliberate trade-off, same one ignored-skipped already
        // carries: this mod keeps showing as "needs update" on every future Check for Updates,
        // harmlessly, since this same check will keep skipping it every time.
        if (keptModIds.has(String(u.old.source && u.old.source.modId))) {
            finishUpdated({ name: u.new.name, ok: null, action: 'kept-installed-version' });
            continue;
        }
        let vortexModId = resolveLiveModId(matcher, u.old.source);
        if (!vortexModId) {
            // Real case, not theoretical -- caught live during this task's own verification: an
            // EARLIER apply attempt (this same collection, a retry after a partial failure) already
            // genuinely succeeded on this exact mod, so its live identity has already moved past the
            // OLD (review's own `u.old`) fileId/md5 -- resolving against the old identity correctly
            // fails to find it anymore, but that's success, not absence. Check the NEW identity
            // before giving up -- if IT resolves, this mod is already correctly up to date...
            const alreadyUpdatedModId = resolveLiveModId(matcher, u.new.source);
            if (alreadyUpdatedModId) {
                // ...but identity alone isn't proof the mod is actually intact -- the director's own
                // real catch: this used to trust the identity match and skip re-extraction outright,
                // even though a mod's staging folder can go missing files (a failed prior extraction,
                // a manual delete, damage from removing a shared mod) while Vortex's live record still
                // matches. Same missing-files-scan.js engine Rebuild Missing Files already uses for
                // exactly this question, reused as-is (not rebuilt) -- its own existingStagingFolder
                // check inside classifyMod is already a cheap "does staging even have anything in it"
                // first pass before the costlier archive-list-and-diff, so this only pays full price
                // for a folder that's genuinely there but wrong, not for one that's obviously empty.
                let stagingComplete = false;
                try {
                    const scan = await scanOneMod(u.new, {
                        downloadsDir: downloads, stagingDir: staging, sevenZipExe,
                        knownVortexModId: alreadyUpdatedModId,
                    });
                    stagingComplete = scan.bucket === 'ok';
                } catch {
                    // Couldn't tell either way -- don't trust the shortcut, re-extract for real below.
                    stagingComplete = false;
                }
                if (stagingComplete) {
                    finishUpdated({ name: u.new.name, ok: true, action: 'already-up-to-date' });
                    continue;
                }
                // Staging is genuinely incomplete despite the identity match -- fall through into the
                // SAME re-extraction path used below, using this already-resolved live mod id (this
                // mod's real, existing slot) rather than treating it as absent from Vortex entirely.
                vortexModId = alreadyUpdatedModId;
            } else {
                finishUpdated({ name: u.new.name, ok: false, error: "Couldn't find this mod in Vortex's current live state -- it may have been removed since Review ran." });
                continue;
            }
        }
        try {
            // Same "Download missing archives automatically" Settings toggle Missing Masters/
            // Rebuild Collection already follow (2026-08-18, director's own explicit call after a
            // real archive-mismatch case during this task's own verification: "if no archive or the
            // current archive doesn't fully match all the metadata, we download the archive like
            // Vortex would do") -- read fresh per apply, not baked into config at server startup.
            const allowAutoDownload = !!appConfig.loadConfig().downloadMissingArchives;
            // A mod the FOMOD-choice gate above resolved a fresh real pick for gets THAT choices
            // block instead of the new revision's own (stale-or-absent) recorded one -- everything
            // else about the mod (source/version/name) is unchanged, only `choices` is overridden.
            const freshFomodChoices = resolvedFomodChoices.get(String(u.new.source && u.new.source.modId));
            const effectiveNewMod = freshFomodChoices ? { ...u.new, choices: freshFomodChoices } : u.new;
            effectiveNewByOld.set(u.old, effectiveNewMod);
            // knownVortexModId is always passed to classifyMod for this bucket (an existing,
            // already-registered slot, never a fresh install), so its own targetFolderName ===
            // vortexModId every time (rebuild-mod.js: `targetFolderName = knownVortexModId ||
            // archiveBaseName`) -- safe to build this mod's real staging path before rebuilding.
            const stagingModDir = path.join(staging, vortexModId);
            const pluginsBefore = listPluginBasenamesLower(stagingModDir);
            const rebuildResult = await rebuildSingleMod({
                vortexModId, gameId: syncLib.GAME_ID, downloadsDir: downloads, stagingDir: staging,
                mod: effectiveNewMod, allowAutoDownload,
                // 'all' (2026-08-22, the real fix): Update Collection v2's whole job is moving this
                // mod to the new revision's own content -- unlike Rebuild Collection (verifying an
                // EXISTING install against its own recorded archive, where a mismatch is a genuine
                // "did something change locally?" question worth pausing on), there is no scenario
                // here where preserving what's currently on disk over the new revision is correct.
                // Makes FAILED_MISMATCH_NOT_TOUCHED unreachable from this call site -- see
                // rebuild-mod.js's own resolveMode header comment for the full real behavior.
                resolveMode: 'all',
                onPhase: (phase) => onProgress({ type: 'mod-phase', modId, phase }),
            });
            if (rebuildResult.status !== 'REBUILT') {
                // classifyMod couldn't extract (no archive, open FOMOD, excepted) or rebuildMod
                // found a real content mismatch / a mid-swap failure -- either way, staging was NOT
                // changed to the new content (or, for CRITICAL_MANUAL_RESTORE_NEEDED, needs a human
                // -- see rebuild-mod.js's own comment), so this mod is deliberately NOT deployed.
                // See describeApplyFailure's own header comment for the priority order and the real
                // plain-language replacements for the known statuses that would otherwise leak a raw
                // internal string straight to the user.
                finishUpdated({
                    name: u.new.name, ok: false, error: describeApplyFailure(rebuildResult),
                    status: rebuildResult.status || rebuildResult.kind,
                });
                continue;
            }
            if (pluginSetChanged(pluginsBefore, listPluginBasenamesLower(stagingModDir))) {
                pluginFileChangeDetected = true;
            }
            // Metadata refresh -- Vortex's own UI would have set these via InstallManager; this
            // project's own faster extraction bypasses InstallManager entirely, so this is the
            // explicit follow-up step the director asked for instead. archiveId resolved by matching
            // the NEW archive's own real download record (localPath) against the live downloads
            // list, same identity signal Clean Up's own buildDownloadLookup already established.
            const newArchiveId = await resolveDownloadIdForArchive(u.new);
            // Confirmed via real source (mod_management/reducers/mods.ts): setModAttributes MERGES
            // into the mod's existing attributes, it does not replace them wholesale -- any field
            // NOT included here (customFileName in particular -- the user's own local rename, if
            // they made one) is left completely untouched, deliberately.
            const attributes = {
                version: u.new.version, modName: u.new.name,
                fileMD5: u.new.source && u.new.source.md5, modId: u.new.source && u.new.source.modId,
                fileId: u.new.source && u.new.source.fileId, fileSize: u.new.source && u.new.source.fileSize,
                logicalFileName: u.new.source && u.new.source.logicalFilename,
                referenceTag: u.new.source && u.new.source.tag,
                ...(newArchiveId ? { archiveId: newArchiveId } : {}),
            };
            const attrsOk = await helperClient.setModAttributes(vortexModId, attributes);
            touchedVortexModIds.add(vortexModId);
            const deployOk = await helperClient.deployMod(vortexModId, true);
            finishUpdated({
                name: u.new.name, ok: deployOk, attributesRefreshed: attrsOk, deployed: deployOk,
                fileCount: rebuildResult.fileCount,
                error: deployOk ? null : "Files were re-extracted but Vortex couldn't deploy them -- check Vortex's own log.",
            });
        } catch (e) {
            finishUpdated({ name: u.new.name, ok: false, error: e.message });
        }
    }

    const removedResults = [];
    if (removedChoice === 'remove' && review.removed.length > 0) {
        onProgress({ type: 'phase', message: 'Removing mods…' });
        const toRemove = [];
        for (const m of review.removed) {
            if (ignoredMatcher(m.source)) {
                removedResults.push({ name: m.name, ok: null, action: 'ignored-skipped' });
                continue;
            }
            const vortexModId = resolveLiveModId(matcher, m.source);
            if (vortexModId) {
                // Checked BEFORE removal (the folder still exists) -- a mod being fully uninstalled
                // taking any real plugin file down with it is exactly the same "plugins.txt could go
                // stale" case as an Updated-bucket plugin swap.
                if (listPluginBasenamesLower(path.join(staging, vortexModId)).size > 0) {
                    pluginFileChangeDetected = true;
                }
                toRemove.push({ name: m.name, vortexModId });
            } else {
                // Real case, not theoretical -- same reasoning as the Updated bucket's own
                // "already-up-to-date" check above: an EARLIER apply attempt on this same
                // collection already genuinely removed this mod, so it's correctly absent from
                // Vortex's live state now -- that's success, not a problem. Unlike an update, a
                // removed mod has no "new identity" to double-check against; `review.removed` itself
                // is fresh from THIS call's own reviewUpdate (moments ago), so "still locally
                // tracked, but genuinely absent live" reliably means "already achieved" in practice
                // -- treated as success so the collection.json merge below correctly stops tracking
                // it, rather than showing this same phantom "needs removing" forever.
                removedResults.push({ name: m.name, ok: true, action: 'already-removed' });
            }
        }
        if (toRemove.length > 0) {
            try {
                const ok = await helperClient.removeMods(toRemove.map((m) => m.vortexModId));
                toRemove.forEach((m) => removedResults.push({ name: m.name, ok, action: 'removed' }));
            } catch (e) {
                toRemove.forEach((m) => removedResults.push({ name: m.name, ok: false, error: e.message }));
            }
        }
    } else if (removedChoice === 'keep') {
        review.removed.forEach((m) => removedResults.push({ name: m.name, ok: true, action: 'kept' }));
    }

    // Added mods (2026-08-18, Phase 3) -- installed for real now, not just shown as information.
    // Reuses Rebuild Collection's own real fresh-install branch: rebuildSingleMod's own
    // `vortexModId` param is only ever used to build classifyMod's `knownVortexModId` (and, when a
    // `mod` object is supplied directly as it is here, the vortexModId-based Vortex lookup is
    // skipped entirely) -- passing it as null here is EXACTLY the same "never tracked before"
    // fallback collection-runner.js's own retryMissingArchiveDownload/reclassifyMod/
    // forceExtractOffSiteMod/extractImportedOffSiteMod already use for a mod Vortex has never seen:
    // classifyMod's own `targetFolderName = knownVortexModId || archiveBaseName` takes over, so
    // extraction lands in a brand-new, archive-named staging folder -- confirmed by reading
    // rebuild-mod.js directly, not assumed.
    //
    // What Rebuild Collection's own engine does NOT do (confirmed by reading collection-runner.js's
    // runRebuild end to end -- it only ever calls rebuildMod, a pure filesystem operation, never a
    // Vortex API call) is register the new folder with Vortex's own live state -- a mod Vortex has
    // never heard of doesn't show up in its Mods table or get deployed just because files exist on
    // disk in its staging folder. That registration is a real, in-process Vortex action (confirmed
    // via real source, mod_management/index.ts: `api.events.on('create-mod', (gameMode, mod,
    // callback) => onAddMod(...))`, which dispatches `addMod(gameId, mod)` into Vortex's own Redux
    // store and ensures the folder exists) -- it can only be triggered from INSIDE Vortex's own
    // process, exactly like deploy-single-mod/remove-mods/set-attributes already are, so it's a new
    // Helper extension route (`POST /mods/create`, vortex-collection-helper's own createMod), not
    // something this project can dispatch directly. Deliberately registered AFTER a verified-
    // successful extraction, not before (Vortex's own real "Add Mods" drag-and-drop flow registers
    // FIRST, empty folder, then copies files in) -- this project's own classify/extract/verify engine
    // means we KNOW the real content is good before Vortex's database ever hears about this mod,
    // never risking a registered-but-broken entry the way a naive port of Vortex's own order would.
    const addedResults = [];
    for (let addedI = 0; addedI < review.added.length; addedI += 1) {
        const m = review.added[addedI];
        // Keyed by m.source.modId -- the same identifier this file already uses to key Added mods
        // everywhere else (resolveDownloadIdForArchive/buildCollectionMembershipRule etc.), and the
        // review table has no separate ucv2AddedModId helper of its own to match against instead.
        const modId = String(m.source && m.source.modId);
        // No real "downloading from Nexus" sub-phase here -- rebuildSingleMod has no progress hook of
        // its own to report that from, and this project's own standing rule is never to fabricate
        // progress that isn't a real signal. One honest "Installing…" phase per mod instead.
        onProgress({ type: 'progress', message: `Installing ${m.name}…`, current: addedI + 1, total: review.added.length });
        onProgress({ type: 'mod-start', modId, name: m.name });
        const finishAdded = (result) => {
            // modId (2026-08-23) -- same reasoning as finishUpdated's own modId above.
            addedResults.push({ ...result, modId });
            onProgress({
                type: 'mod-complete', modId, name: m.name, ok: result.ok,
                error: result.error || null, action: result.action || null, status: result.status || null,
            });
        };
        try {
            const allowAutoDownload = !!appConfig.loadConfig().downloadMissingArchives;
            const freshFomodChoices = resolvedFomodChoices.get(String(m.source && m.source.modId));
            const effectiveMod = freshFomodChoices ? { ...m, choices: freshFomodChoices } : m;
            effectiveAddedByOriginal.set(m, effectiveMod);

            const rebuildResult = await rebuildSingleMod({
                vortexModId: null, gameId: syncLib.GAME_ID, downloadsDir: downloads, stagingDir: staging,
                mod: effectiveMod, allowAutoDownload,
                // Same 'all' reasoning as the Updated loop above -- a stale leftover folder from a
                // prior failed attempt is the realistic mismatch case here (Added mods are fresh
                // installs), but "install what the new revision says" applies equally.
                resolveMode: 'all',
                onPhase: (phase) => onProgress({ type: 'mod-phase', modId, phase }),
            });
            if (rebuildResult.status !== 'REBUILT') {
                // Same describeApplyFailure() as the Updated loop above.
                finishAdded({
                    name: m.name, ok: false, error: describeApplyFailure(rebuildResult),
                    status: rebuildResult.status || rebuildResult.kind,
                });
                continue;
            }

            const newVortexModId = rebuildResult.targetFolderName;
            // Minimal real IMod shape (confirmed against Vortex's own real create-mod call site) --
            // installationPath must exactly match the folder rebuildSingleMod just verified-extracted
            // into. The metadata refresh right below (the SAME setModAttributes call the Updated loop
            // already makes) fills in the rest (version/fileId/md5/etc); this is only what Vortex's
            // own reducer needs to accept the mod as real in the first place.
            const vortexMod = {
                id: newVortexModId, state: 'installed', type: '', installationPath: newVortexModId,
                attributes: { name: m.name, installTime: new Date().toISOString() },
            };
            let createOk = await withHelperRetry(() => helperClient.createMod(newVortexModId, vortexMod));
            // liveState (2026-08-18): cached across create/enable's own verify-fallback checks below --
            // see verifyModLiveState's own header comment for why a real Helper response can be lost
            // even when the underlying dispatch already succeeded, and why re-reading live state
            // directly is a reliable (not racy) way to tell the two apart.
            let liveState = null;
            if (!createOk) {
                liveState = await verifyModLiveState(newVortexModId);
                createOk = liveState.registered;
            }
            if (!createOk) {
                finishAdded({ name: m.name, ok: false, error: "Files were extracted, but Vortex couldn't register this as a new mod after real retries -- check Vortex's own log.", vortexModId: newVortexModId });
                continue;
            }

            const newArchiveId = await resolveDownloadIdForArchive(effectiveMod);
            const attributes = {
                version: m.version, modName: m.name,
                fileMD5: m.source && m.source.md5, modId: m.source && m.source.modId,
                fileId: m.source && m.source.fileId, fileSize: m.source && m.source.fileSize,
                logicalFileName: m.source && m.source.logicalFilename,
                referenceTag: m.source && m.source.tag,
                // Only ever set for a real Nexus-sourced mod -- matches nexus_integration's own real
                // attribute value (confirmed via source), never guessed for an off-site mod.
                ...(m.source && m.source.type === 'nexus' ? { source: 'nexus' } : {}),
                ...(newArchiveId ? { archiveId: newArchiveId } : {}),
                // Real, director-caught gap (2026-08-18): without this, a brand-new multi-plugin mod
                // sat with its plugins un-checked in Vortex's own plugin list until the user manually
                // clicked "Enable all" on a real Vortex notification -- something a genuine collection
                // update never makes you do. Confirmed via real Vortex source
                // (gamebryo-plugin-management/src/index.ts's own `mod-enabled` handler): a newly-
                // enabled mod with more than one plugin auto-enables all of them ONLY if
                // `mod.attributes.enableallplugins === true`; otherwise it shows exactly the "contains
                // multiple plugins" notification confirmed live this session, requiring a manual
                // "Enable all" click. That attribute is normally set by InstallManager
                // (`processEnableAllPlugins`) when an installer script emits an enableallplugins
                // instruction -- this project's own extraction bypasses InstallManager entirely (the
                // whole point of Update Collection v2), so nothing else was ever going to set it. Safe
                // to set unconditionally: the real auto-enable logic only branches on plugin COUNT
                // (single plugin already auto-enables regardless; zero plugins never checks this flag
                // at all), so setting it on every Added mod matches a real collection install's own
                // outcome without needing to know the plugin count in advance.
                enableallplugins: true,
            };
            const attrsOk = await withHelperRetry(() => helperClient.setModAttributes(newVortexModId, attributes));

            // A brand-new mod has no prior profile entry at all -- unlike an Updated mod (which was
            // already enabled from its original install), this needs its OWN real Enabled flip, not
            // just deploy-single-mod's own `enable` argument (which only controls file-linking, never
            // the profile flag the Mods table checkbox actually reads -- see setModEnabled's own
            // header comment in vortex-helper-client.js for the full reasoning already established
            // for the Updated/disabled-restoration case).
            let enabledOk = await withHelperRetry(() => helperClient.setModEnabled(newVortexModId, true));
            if (!enabledOk) {
                if (!liveState) liveState = await verifyModLiveState(newVortexModId);
                enabledOk = liveState.enabled;
            }
            let deployOk = await withHelperRetry(() => helperClient.deployMod(newVortexModId, true));
            if (!deployOk) deployOk = verifyModDeployedOnDisk(newVortexModId, staging);

            // Same real reconciliation concern as the Updated/Removed loops -- a brand-new mod
            // introducing its own .esp/.esm/.esl is exactly the case a per-mod deploy can't reconcile
            // on its own (see pluginFileChangeDetected's own header comment above the Updated loop).
            if (listPluginBasenamesLower(path.join(staging, newVortexModId)).size > 0) {
                pluginFileChangeDetected = true;
            }

            // Collection membership (2026-08-18, director-caught) -- registering/enabling/deploying a
            // mod does NOT make it show as "part of this collection" in Vortex's own UI; that's a
            // SEPARATE real rule on the COLLECTION's own live entry (see buildCollectionMembershipRule's
            // own header comment for the full trace). Added AFTER a real deploy, not before -- an
            // undeployed mod showing as a collection member would be a real, if lesser, version of the
            // exact "registered but not actually working" problem this whole task exists to fix.
            let membershipOk = true; // nothing to link if the mod itself never deployed -- not this step's own failure to report
            if (deployOk) {
                membershipOk = await withHelperRetry(() => helperClient.applyRuleChange(
                    collectionModId, undefined, buildCollectionMembershipRule(m, effectiveMod),
                ));
                if (!membershipOk) membershipOk = await verifyMembershipLive(collectionModId, m.source);
            }

            // ok is registered-AND-deployed -- the two "does this mod fundamentally work" gates (also
            // what the collection.json merge below keys on, same as before). attrsOk/enabledOk/
            // membershipOk are surfaced separately rather than silently folded away: even after real
            // retries, a mod can land deployed with stale/missing metadata, the wrong Enabled checkbox
            // state, or no collection association, and that's real, honest information worth showing
            // rather than a blanket "it worked" -- matches this project's own "never run a real action
            // silently" standing rule for RESULT reporting, not just progress (DESIGN.md, commit
            // 4bdd307).
            const ok = deployOk;
            const problems = [];
            if (!attrsOk) problems.push('metadata (version/fileId/etc) may be stale');
            if (!enabledOk) problems.push("the Mods table's Enabled checkbox may not reflect this mod");
            if (!membershipOk) problems.push("Vortex may not show this mod as part of the collection");
            if (!deployOk) problems.push("Vortex couldn't deploy it after real retries");
            finishAdded({
                name: m.name, ok, vortexModId: newVortexModId, attributesRefreshed: attrsOk,
                enabled: enabledOk, membershipLinked: membershipOk, deployed: deployOk,
                fileCount: rebuildResult.fileCount,
                error: problems.length > 0 ? `${problems.join('; ')} -- check Vortex's own log.` : null,
            });
        } catch (e) {
            finishAdded({ name: m.name, ok: false, error: e.message });
        }
    }

    // Optional "also delete the archive" choice for Remove All (2026-08-18) -- default OFF,
    // deliberately: removing a mod from the collection shouldn't silently delete a downloaded
    // archive the user might reuse, and this project's own Clean Up/Mod Scrub report already exists
    // specifically to handle orphaned-archive cleanup as its own deliberate, reviewed step (an
    // archive left behind here surfaces there naturally on a later scan). Reuses the exact same
    // delete primitive Mod Scrub's own bulk-delete already uses (cleanupScan.deleteEntries -- a
    // plain fs.rmSync per path), not a new deletion mechanism. Eligible for BOTH `removed` and
    // `already-removed` outcomes (an earlier attempt already having removed the mod from Vortex
    // doesn't change the user's current "also delete the archive" choice for it) -- matched back to
    // review.removed by NAME, not array position, since removedResults' own order interleaves
    // ignored/already-removed entries (pushed inline) with real `removed` entries (pushed after the
    // batch removeMods call finishes), so it is NOT index-aligned with review.removed.
    const deletedArchiveResults = [];
    if (removedChoice === 'remove' && deleteArchives) {
        const eligible = removedResults.filter((r) => r.ok === true && (r.action === 'removed' || r.action === 'already-removed'));
        if (eligible.length > 0) {
            const removedSourceByName = new Map(review.removed.map((m) => [m.name, m.source]));
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
                    const source = removedSourceByName.get(r.name);
                    const file = source && source.md5 && byMd5.get(source.md5);
                    if (file && file.localPath) {
                        toDelete.push({ name: r.name, path: path.join(downloads, file.localPath) });
                    } else {
                        deletedArchiveResults.push({ name: r.name, ok: false, error: "Couldn't find this mod's downloaded archive -- it may already be gone, or was never downloaded through Vortex." });
                    }
                }
                if (toDelete.length > 0) {
                    const rmResults = cleanupScan.deleteEntries(toDelete.map((t) => t.path));
                    toDelete.forEach((t, i) => {
                        const rm = rmResults[i];
                        deletedArchiveResults.push({ name: t.name, ok: rm.ok, error: rm.error, path: t.path });
                    });
                }
            }
        }
    }

    // Strip this collection's own stale membership rule for every real removal (2026-08-22, real
    // confirmed gap) -- the Added-mod loop above already keeps this SAME array's ADD side in sync
    // (helperClient.applyRuleChange(collectionModId, undefined, buildCollectionMembershipRule(...)));
    // this is the missing REMOVE side. Real Vortex's own source confirms `rules` on the collection
    // mod's own live entry -- not this tool's on-disk collection.json, and not the collection's own
    // revisionNumber/version attributes handled below -- is the authoritative "who's a member" record
    // its Workshop editor, health checks, and dependency gathering all read (InstallDriver.ts's
    // repeated `this.mCollection.rules`/`collection.rules` reads, e.g. ~line 311/333/538/905/997).
    // Left unfixed, a removed mod keeps showing as a collection member in Vortex's own UI forever,
    // even after this same apply correctly uninstalls it. Extracted into cleanupRemovedMembershipRules
    // (2026-08-23) so Apply Result's own per-problem Retry can re-run exactly this same real operation
    // standalone -- see that function's own header comment.
    const removedMembershipCleanup = removedChoice === 'remove'
        ? await cleanupRemovedMembershipRules(collectionModId, review.removed, removedResults)
        : { ok: true, count: 0, error: null };

    // Resolve acknowledged dependency breaks -- only runs when the caller already passed
    // ignoreDependencyBreaks (the gate above would have refused otherwise). Mirrors Vortex's own
    // real "Ignore" action exactly (InstallManager.ts's queryIgnoreDependent, confirmed via real
    // source): removes the dependent's own rule and re-adds the SAME rule with `ignored: true` set --
    // NOT a deletion, so the dependency relationship itself stays on record, just marked as
    // acknowledged/no-longer-warn-worthy, exactly matching what "you'll continually get warnings
    // about it" in Vortex's own real modal copy implies would otherwise happen. Only resolved for a
    // break whose target mod's update actually SUCCEEDED this apply (`ok === true`) -- if the real
    // extraction failed, the mod's version never actually changed, so marking the dependency broken
    // would be premature and wrong.
    const dependencyBreakResults = [];
    if (ignoreDependencyBreaks) {
        for (const b of dependencyBreaks) {
            if (updatedResults[b.updatedIndex]?.ok !== true) continue;
            try {
                const ok = await helperClient.applyRuleChange(b.dependentVortexModId, b.rule, { ...b.rule, ignored: true });
                dependencyBreakResults.push({ name: `${b.dependentName} -> ${b.updatedModName}`, ok, action: 'dependency-rule-ignored' });
            } catch (e) {
                dependencyBreakResults.push({ name: `${b.dependentName} -> ${b.updatedModName}`, ok: false, error: e.message });
            }
        }
    }

    // Finalize: apply the new revision's own author-written collection rules -- the "applying
    // collection rules" half of Vortex's own real finalize status line ("Finalizing installation -
    // deploying mods and applying collection rules...", confirmed from a real screenshot). The
    // "deploying mods" half is already covered: each Updated mod above already got a real
    // deploy-single-mod call (Phase 2's own narrower-than-deploy-mods choice, unchanged here).
    //
    // A FRESH live mods read is required here, not the pre-apply `matcher` built above -- several
    // mods' own fileMD5/fileId attributes just changed via setModAttributes in the Updated loop, and
    // modRules resolution needs the POST-update identity (this revision's real content), not the
    // stale pre-apply one. Skipped entirely (no re-fetch) when this revision has no modRules at all,
    // to avoid the real cost of a second ~46MB /mods read for nothing.
    // Extracted into applyModRulesFresh (2026-08-23) so Apply Result's own per-problem Retry can
    // re-run exactly this same real operation standalone -- see that function's own header comment.
    let modRulesResult = { modsChanged: [], totalRulesWritten: 0, unresolvedCount: 0 };
    if (review.modRules && review.modRules.length > 0) {
        onProgress({ type: 'phase', message: 'Applying collection rules…' });
        modRulesResult = await applyModRulesFresh(review.modRules);
    }

    // Disabled restoration -- run ONLY after every Updated/Removed mod has finished, mirroring
    // Classic's own "fix up enabled state after the real install work is done" ordering (its own
    // applyDisables step runs after Vortex's native Resume finishes, for the same reason: correcting
    // state makes sense once the thing that could have disturbed it is done, not mid-flight). Only
    // touchedVortexModIds (mods this apply's Updated loop actually force-enabled via deployMod(...,
    // true) above) are candidates -- see the header comment above the Updated loop for why untouched
    // mods are deliberately left alone.
    //
    // BOTH setModEnabled and deployMod(false) are required, not either alone -- a real, live finding
    // (2026-08-18): deploy-single-mod's own `enable` flag only controls file-linking, never a mod's
    // PROFILE-level Disabled flag (persistent.profiles[profileId].modState[modId].enabled -- what the
    // Mods table checkbox and enabledModKeys actually read). setModEnabled fixes that flag itself;
    // deployMod(false) un-links the files so nothing is left active in Data in the meantime. See
    // vortex-helper-client.js's own setModEnabled header comment for the full writeup.
    const disabledResults = [];
    for (const d of backupSnapshot.disabled) {
        if (!d.vortexModId || !touchedVortexModIds.has(d.vortexModId)) continue;
        try {
            const enabledOk = await helperClient.setModEnabled(d.vortexModId, false);
            const deployOk = await helperClient.deployMod(d.vortexModId, false);
            disabledResults.push({ name: d.name, ok: enabledOk && deployOk, action: 'disabled-restored' });
        } catch (e) {
            disabledResults.push({ name: d.name, ok: false, action: 'disabled-restored', error: e.message });
        }
    }

    // Full deploy (2026-08-18) -- ONLY when this apply added, removed, or renamed a real plugin file
    // (pluginFileChangeDetected, computed during the Updated/Removed loops above via
    // listPluginBasenamesLower/pluginSetChanged). The per-mod deploy-single-mod calls each Updated
    // mod already got never trigger Vortex's own real did-deploy reaction chain (confirmed via
    // docs/VORTEX-DEPLOY-REFERENCE.md), so plugins.txt/loadorder.txt would otherwise stay stale until
    // the user separately clicked Vortex's own Deploy Mods -- this runs the SAME real deploy-mods
    // event that button dispatches, through the Helper (vortex-collection-helper's own
    // /mods/deploy-all, confirmed against real Vortex source, not guessed). Deliberately placed AFTER
    // disabledResults above, not before -- by the time this fires, every touched mod's real enabled/
    // disabled state is already correctly settled, so the real deploy pipeline (which deploys
    // whatever the profile currently marks enabled) reflects the FINAL intended state, not an
    // intermediate one that would just get re-churned a moment later.
    let deployAllResult = { attempted: false, ok: null, error: null };
    if (pluginFileChangeDetected) {
        deployAllResult.attempted = true;
        try {
            const ok = await runDeployAllWithProgress(onProgress, 'Deploying via Vortex. Check Vortex and accept any file changes if prompted.');
            deployAllResult.ok = ok;
            if (!ok) {
                deployAllResult.error = "Vortex's own deploy didn't confirm success -- plugins.txt may still need a manual Deploy Mods in Vortex.";
            }
        } catch (e) {
            deployAllResult.ok = false;
            deployAllResult.error = e.message;
        }
    }

    // Updates the local collection.json to reflect ONLY the changes that genuinely succeeded --
    // NOT a wholesale overwrite to the new revision's content. Real bug caught and fixed via this
    // task's own live testing (2026-08-18): an earlier version of this function DID overwrite the
    // whole file wholesale once every attempted mod's own dispatch had returned, which silently lost
    // track of a real, live PARTIAL failure (RMB SPIDified - Core Framework hit a genuine
    // FAILED_MISMATCH_NOT_TOUCHED) the moment the file was rewritten to the new revision's own
    // mods[] -- the next Check for Updates then wrongly reported that mod as already current, even
    // though its actual staged files were never touched. A per-mod merge is the correct fix: start
    // from the CURRENT local collection.json's own mods[] (read fresh, not review's own in-memory
    // copy -- untouched since reviewUpdate ran moments ago, but re-read rather than assumed), then
    // replace ONLY the entries whose own update/remove genuinely succeeded (`ok === true`); anything
    // that failed keeps its EXISTING local entry so the next Check for Updates/Review still shows it
    // as a real, pending change. A genuinely NEW mod (Phase 3, 2026-08-18) isn't in
    // currentParsed.mods at all yet, so it can't be found/replaced by this same per-mod walk --
    // appended separately below, once per successfully-installed Added mod. Matches entries by
    // identity (collection-diff.js's own modIdentityKeys/buildIndex/findMatch, the SAME
    // cross-revision-safe matcher Phase 1's own diff already uses -- not object-reference equality,
    // which a fresh JSON.parse of the same file content never preserves across two separate reads).
    let collectionJsonUpdated = false;
    try {
        const collectionJsonPath = collection.collectionJsonPath;
        const currentRaw = fs.readFileSync(collectionJsonPath, 'utf8');
        const currentParsed = JSON.parse(currentRaw);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(`${collectionJsonPath}.pre-update-${stamp}.json`, currentRaw);

        const succeededUpdateIndex = buildIndex(review.updated.filter((u, i) => updatedResults[i] && updatedResults[i].ok === true).map((u) => u.old));
        const succeededUpdateByOld = new Map(review.updated.filter((u, i) => updatedResults[i] && updatedResults[i].ok === true).map((u) => [u.old, effectiveNewByOld.get(u.old) || u.new]));
        // Matched by NAME, not array position (2026-08-22 fix, found while working the removed-mods
        // rules-cleanup task below) -- removedResults is NOT index-aligned with review.removed (see
        // the deletedArchiveResults block's own header comment a few lines above this for the full
        // reasoning: ignored/already-removed entries are pushed inline during the main loop, but real
        // `removed` entries are pushed AFTER the batch removeMods call finishes, so review.removed[i]
        // and removedResults[i] can genuinely refer to two different mods). The old `review.removed
        // .filter((m, i) => removedResults[i]...)` here had exactly that bug -- confirmed real, not
        // just theoretical, by re-deriving it from this same interleaving already documented below.
        const succeededRemovalNames = new Set(removedResults.filter((r) => r.ok === true).map((r) => r.name));
        const succeededRemovalIndex = buildIndex(review.removed.filter((m) => succeededRemovalNames.has(m.name)));

        const newMods = [];
        for (const mod of currentParsed.mods) {
            const updateMatch = findMatch(succeededUpdateIndex, mod);
            if (updateMatch) {
                newMods.push(succeededUpdateByOld.get(updateMatch));
                continue;
            }
            if (findMatch(succeededRemovalIndex, mod)) continue; // dropped -- removed or kept, both stop tracking it
            newMods.push(mod); // unchanged, or a failed update/remove -- keep the existing entry as-is
        }
        // A successfully-installed Added mod isn't in currentParsed.mods yet (it never was) -- append
        // it now, using effectiveAddedByOriginal so a fresh FOMOD pick this apply actually resolved
        // is what gets persisted, not the new revision's stale/absent recorded choices (same
        // reasoning as succeededUpdateByOld above for the Updated bucket).
        review.added.forEach((m, i) => {
            if (addedResults[i] && addedResults[i].ok === true) {
                newMods.push(effectiveAddedByOriginal.get(m) || m);
            }
        });

        // Pretty-printed (2-space indent), matching the original downloaded collection.json's own
        // formatting -- a plain JSON.stringify with no indent silently minified this file to one
        // giant line every time this merge ran, confirmed live 2026-08-22 (director's own VS Code
        // check: only the FIRST pre-update backup, taken before this bug's first overwrite, was still
        // readable -- both the current file and a later backup were already minified).
        fs.writeFileSync(collectionJsonPath, JSON.stringify({ ...currentParsed, mods: newMods }, null, 2));
        collectionJsonUpdated = true;
    } catch (e) {
        // Non-fatal -- the real Vortex-side work above already happened and is real/correct
        // regardless; a stale local collection.json just means the next Check for Updates would
        // show a wrong/stale diff, an annoyance to fix by hand, not data loss.
        console.error(`[update-collection-v2-runner] failed to update local collection.json after apply: ${e.message}`);
    }

    // Advance the COLLECTION mod's own revisionNumber/version (2026-08-22, real confirmed gap) --
    // every write above only ever touches MEMBER mods; this is the one write that touches the
    // collection mod's own record. Real Vortex source confirms both readers of this exact attribute
    // pair: this tool's own resolveNexusInfoViaHelper (reads attrs.revisionNumber for its "installed
    // revision" check) and real Vortex's own native CollectionTile "Update available" condition
    // (parseInt(attributes.newestVersion) > parseInt(attributes.version) -- confirmed via real
    // source, collections/views/CollectionTile/index.tsx). updateMeta (collections/index.ts) only
    // ever refreshes newestVersion/newestFileId/description/etc from a re-fetch of the CURRENTLY
    // -tracked revision -- it never advances `version` itself, so nothing else was ever going to fix
    // this without this explicit write. newestVersion is set to the SAME new revision number here
    // (not left stale) so this reads correctly immediately, without waiting on Vortex's own next
    // updateMeta pass to reconcile it -- same "don't leave a known-stale value sitting around"
    // reasoning as the collection.json merge just above.
    onProgress({ type: 'phase', message: "Updating the collection's own Vortex record…" });
    // Extracted into updateCollectionAttributes (2026-08-23) so Apply Result's own per-problem Retry
    // can re-run exactly this same real write standalone -- see that function's own header comment.
    const { ok: collectionAttributesUpdated, error: collectionAttributesError } = await updateCollectionAttributes(
        collectionModId, review.newRevisionNumber, review.newRevisionId,
    );

    // Apply Result's own per-problem Retry buttons (2026-08-23) need a few fields from THIS review
    // that aren't persisted anywhere else once this request completes -- see cacheApplyRetryData's
    // own header comment for why a fresh reviewUpdate() can't stand in for all of them.
    cacheApplyRetryData(collectionModId, {
        modRules: review.modRules, newRevisionNumber: review.newRevisionNumber, newRevisionId: review.newRevisionId,
        removed: review.removed, removedResults,
    });

    return {
        collectionName: review.collectionName, newRevisionNumber: review.newRevisionNumber,
        backupPath, updatedResults, removedResults, disabledResults, deletedArchiveResults,
        dependencyBreakResults, modRulesResult, addedResults, collectionJsonUpdated,
        removedMembershipCleanup, collectionAttributesUpdated, collectionAttributesError,
        isOwnCollection, pluginFileChangeDetected, deployAllResult,
    };
}

// "You curated this collection" (2026-08-18) -- matches the real Nexus-authenticated user's own
// display name (the same GET /v1/users/validate.json this project already calls for Premium-status
// gating) against the collection's own real `info.author`. Purely informational -- any failure here
// (no API key configured, a Nexus API hiccup) must never block or fail the real apply, so this
// always resolves to a boolean and never throws.
async function checkIsOwnCollection(collectionAuthor) {
    if (!collectionAuthor) return false;
    try {
        const apiKey = nexusCollectionDownload.resolveApiKey();
        if (!apiKey) return false;
        const status = await checkPremiumStatus(apiKey);
        if (!status || !status.name) return false;
        return status.name.trim().toLowerCase() === String(collectionAuthor).trim().toLowerCase();
    } catch (e) {
        console.error(`[update-collection-v2-runner] checkIsOwnCollection failed (non-fatal): ${e.message}`);
        return false;
    }
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Bounded retry-with-real-delay for a single Added-mod Helper call (2026-08-18, Phase 3 resilience
// follow-up -- director-reported live: 5 of 10 real Added mods succeeded, the other 5 registered but
// didn't finish under the load of installing many mods in one apply). Vortex's own real deploy
// machinery is CONFIRMED (TECHNICAL.md's "A DIFFERENT, now CONFIRMED case", root-caused via real
// source to activationStore.ts's synchronous saveActivation) to have real, brief blocking windows --
// observed live as short as ~3.6s-6s during ordinary per-mod-type deploy activity, not just the ~83s
// full-deploy case -- comfortably longer than this project's own short per-call budgets (2s for a
// plain dispatch like createMod/setModAttributes/setModEnabled). A single call landing during one of
// these brief windows shouldn't sink an otherwise-healthy mod outright. All four Added-mod Helper
// calls (createMod/setModAttributes/setModEnabled/deployMod) are already independently documented as
// idempotent -- re-registering the same modId, re-merging the same attributes, re-setting the same
// enabled flag, and re-linking the same files are all harmless to repeat -- so retrying here carries
// no double-dispatch risk beyond what helperFetch's own existing single immediate network-failure
// retry already accepts.
//
// Deliberately a REAL delay between attempts, unlike helperFetch's own immediate network-failure
// retry -- an instant retry would very plausibly re-hit the exact same still-ongoing multi-second
// block; waiting gives it a real chance to actually clear first. Bounded at 3 total attempts (2
// retries), not infinite -- a genuinely broken mod, or a real sustained ~83s-class block (the
// SEPARATE, NOT-yet-mitigated concurrent-native-deploy risk already documented in
// vortex-helper-client.js's own header comment), should still fail and be reported honestly rather
// than hang the whole apply indefinitely; this bounded retry only ever protects against the SHORTER,
// already-confirmed brief disruptions, not that larger one.
async function withHelperRetry(fn, { attempts = 3, delayMs = 3000 } = {}) {
    let result;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        result = await fn();
        if (result) return result;
        if (attempt < attempts) await sleep(delayMs);
    }
    return result;
}

// Verify-after-retry fallback (2026-08-18) -- a real, deeper gap found via live testing on top of
// withHelperRetry above: retries alone aren't always enough, because Vortex's own real dispatch runs
// SYNCHRONOUSLY inside the Helper's request handler BEFORE it writes an HTTP response back (already
// documented, vortex-helper-client.js's own applyRuleChange comment) -- a call whose LAST retry
// attempt still times out client-side can still have genuinely succeeded server-side; retrying again
// just risks repeating the exact same lost-response outcome. Confirmed live, unambiguously: a real
// apply run's own JSON result reported createMod as "failed after 3 real retries" for 4 mods, while a
// direct live-state check taken independently, moments earlier, already showed all 4 correctly
// registered in Vortex's own state.
//
// Rather than retry forever (which would just repeat the same risk), this reads the REAL, current
// live state directly once retries are exhausted. This is a reliable check, not a racy one: because
// the dispatch is synchronous, if it happened, `state.persistent.mods` already reflects it by the
// time ANY subsequent read runs, whether that's a moment later or much later.
//
// The verify read is ITSELF wrapped in withHelperRetry -- a real, second-order bug found and fixed
// live in the SAME testing session: a single bare getAllMods() call is exposed to the exact same
// disruption that just caused the original 3 retries to fail, and firing it immediately afterward can
// simply re-hit the SAME still-ongoing block, producing a false "not registered" from the verify step
// too. Confirmed live: 3 mods in one real run still showed ok:false after this fallback was first
// added, and a direct live-state check moments later showed all 3 genuinely registered all along --
// the verify call had failed for the identical reason the original calls did.
async function verifyModLiveState(modId) {
    const data = await withHelperRetry(() => helperClient.getAllMods());
    if (!data) return { registered: false, enabled: false };
    return { registered: !!data.mods[modId], enabled: data.enabledModKeys.includes(modId) };
}

// Same verify-after-retry idea as verifyModLiveState above, for deployMod specifically -- but a plain
// LOCAL filesystem check instead of a real Helper call (deploy's own real effect, file-linking, is
// directly observable on disk, no network round trip needed, and this is the exact same ground-truth
// signal already confirmed live this session to be the most reliable one available: a mod's own
// plugin file existing in the real Data folder IS what "genuinely deployed" means in real terms).
// Checks a real plugin file specifically when the mod has one (the strongest, most meaningful
// signal an installed mod is genuinely active) -- falls back to any file at all for a mod with no
// plugins, so a pure asset/texture mod isn't wrongly treated as "unverifiable."
function verifyModDeployedOnDisk(newVortexModId, stagingDir) {
    try {
        const dataDir = appConfig.loadConfig().skyrimDataDir;
        if (!dataDir) return false;
        const files = fs.readdirSync(path.join(stagingDir, newVortexModId));
        const plugins = files.filter((f) => PLUGIN_EXTENSIONS.has(path.extname(f).toLowerCase()));
        const toCheck = plugins.length > 0 ? plugins : files;
        return toCheck.some((f) => fs.existsSync(path.join(dataDir, f)));
    } catch {
        return false;
    }
}

// Same idea again, for the collection-membership rule -- reads the collection's own real live rules
// fresh and checks whether one now references this mod's identity (repo.modId/fileId, the same
// identity buildCollectionMembershipRule's own reference.repo already carries), rather than trusting
// applyRuleChange's own possibly-lost HTTP response.
async function verifyMembershipLive(collectionModId, source) {
    // Same withHelperRetry wrapping as verifyModLiveState's own getAllMods call, and for the exact
    // same real reason -- a bare single read is exposed to the same disruption that just caused the
    // original applyRuleChange retries to fail. A real, valid empty array (genuinely no matching rule
    // yet) is still truthy in JS, so this only ever retries on getLiveRulesForMod's own null (real
    // failure), never on a legitimate "not found yet" result.
    const rules = await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId));
    if (!rules) return false;
    return rules.some((r) => r.reference && r.reference.repo
        && String(r.reference.repo.modId) === String(source.modId)
        && String(r.reference.repo.fileId) === String(source.fileId));
}

// Resolves a NEW collection.json mod entry's own archive to its real, live download record id
// (state.persistent.downloads.files key) so the metadata refresh above can correctly update
// archiveId -- otherwise Clean Up's own orphan-detection (buildModLookup's usedArchiveIds) would
// keep pointing this mod at its OLD, no-longer-current archive. Matches by localPath against the
// archive filename classifyMod/locateArchive already resolved during extraction, reusing the exact
// same identity philosophy Clean Up's own buildDownloadLookup established (this project's own data,
// not a new concept). Returns null (best-effort) if no matching download record is found or the
// helper read fails -- the metadata refresh still proceeds for every OTHER field either way.
async function resolveDownloadIdForArchive(newMod) {
    try {
        const data = await helperClient.getAllDownloads();
        if (!data) return null;
        for (const [downloadId, file] of Object.entries(data.files)) {
            if (file.fileMD5 === (newMod.source && newMod.source.md5)) return downloadId;
        }
        return null;
    } catch {
        return null;
    }
}

module.exports = {
    listCollections, checkForUpdates, reviewUpdate, prepareApply, runApply,
    buildLiveIdentityIndex, resolveLiveModId, applyCollectionModRules,
    findBrokenDependencies, versionSatisfiesRequirement, isIdOnlyRef, isInstalledVersionNewer,
    buildNexusIdIndex, resolveLiveVersionForUpdatedMod,
    detectFomodChoiceNeed, detectFomodChoiceNeeds, buildFomodChoicesFromPicks,
    getCollectionsCache, refreshCollectionsCache, buildCollectionMembershipRule,
    retryModRules, retryCollectionAttributes, retryMembershipCleanup, retryModExtraction,
};
