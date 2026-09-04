'use strict';
// Framework-agnostic orchestration for Update Collection v2 (Phase 1: read-only Check for Updates +
// Review, no real apply/deploy yet) -- used by web/update-collection-v2-routes.js. See
// TECHNICAL.md's "Update Collection v2" section for the full design writeup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const semver = require('semver');
const { spawn, execFile } = require('child_process');
const syncRunner = require('./sync-runner');
const nexusCollectionDownload = require('./nexus-collection-download');
const { checkPremiumStatus, downloadModArchive, resolveApiKey: resolveModDownloadApiKey } = require('./nexus-mod-download');
const nexusModRequirements = require('./nexus-mod-requirements');
const { findSevenZip, listArchive, extractFile, extractMany } = require('./sevenzip');
const { diffCollectionMods, didFileChange, buildIndex, findMatch, buildSharedModIndex, findSharedModMatch } = require('./collection-diff');
const { locateArchive } = require('./archive-locator');
const { findModRoot } = require('./mod-root');
const { parseModuleConfigFile, hasUnhandledFeatures } = require('./fomod-parser');
const { resolveChoices } = require('./choice-resolver');
const helperClient = require('./vortex-helper-client');
const syncLib = require('./vortex-sync/lib');
const { rebuildSingleMod } = require('./rebuild-single-mod');
const { classifyMod } = require('./rebuild-mod');
const appConfig = require('./app-config');
const rulesGen = require('./rules-generator');
const cycleDetector = require('./cycle-detector');
const cleanupScan = require('./cleanup-scan');
const { scanOneMod } = require('./missing-files-scan');
const { buildMergedPluginLookup, computeMergedPluginFlag } = require('./merged-plugin-lookup');

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
// own output during this task's own verification.
//
// 2026-08-27: this used to be its own local copy of the Workshop-folder exclusion (the same bug
// class then confirmed recurring in Merge Plugins/classic Update Collection/Save Cleaner, none of
// which had it at all) -- now just delegates to lib/sync-runner.js's own
// listInstalledCollectionsExcludingWorkshop, the ONE shared implementation every caller with this
// same constraint should use. Own name/signature kept unchanged -- lib/remove-collection-runner.js
// already imports `listCollections` from here for target selection.
function listCollections(stagingDir) {
    return syncRunner.listInstalledCollectionsExcludingWorkshop(stagingDir);
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

// Where Update Collection v2's own small per-collection tracking files live -- NEVER inside the
// collection's own Vortex staging folder (2026-09-01, director's own explicit correction: that folder
// belongs to Vortex, and a user updating the SAME collection through Vortex's own native flow, not
// this tool, can freely replace or clear its contents -- silently destroying this tool's own tracking
// data with zero warning). One subfolder per collection, keyed by the collection's own stable Nexus
// modId (not its staging folder name, which the director's own broader collection.json write-up
// already establishes can be reused/renamed by Vortex across a real update). Settings-configured,
// REQUIRED, no built-in-default fallback -- same standing rule as every other new data location this
// project adds (see app-config.js's own ucv2TrackingDir comment). Throws if unset; every real caller
// already wraps its own use of this in a non-fatal try/catch (see runApply's and computeNeedsRecheck's
// own call sites), so an unconfigured folder degrades to "no tracking this run", never a hard failure.
function getUcv2TrackingDir(collectionModId) {
    const { ucv2TrackingDir } = appConfig.loadConfig();
    if (!ucv2TrackingDir) throw new Error('Set the "Update tracking folder" in Settings (Update Collection) before applying a collection update.');
    const dir = path.join(ucv2TrackingDir, String(collectionModId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// The "Check for Updates" button -- for every installed, non-Workshop collection, resolves its real
// Nexus collectionSlug + currently-installed revisionNumber (helper-first, state.v2 fallback), then
// asks Nexus for the newest published revision and compares. Read-only throughout -- never touches
// Vortex's database for a write, never downloads a bundle (that only happens in reviewUpdate below,
// once the user actually asks to review one specific collection's update).
//
// "Continue update" (the button previously called Re-check) computation -- REWRITTEN 2026-09-01,
// twice, after the director's own direct corrections. FINAL scope, in the director's own words: "no
// collection should say re-check unless we performed an update on it... no other collection should
// show re-check, as we have never updated the collection. This is why I say we need a file to track
// this," and, ruling out a live-Vortex fallback entirely: "a disabled mod is not ours to fix, that is
// handled in vortex - we only care about updating the collection, nothing more." So this is Tier 1
// ONLY -- this tool's OWN tracked record of its OWN last apply attempt on this collection (runApply's
// own end-of-apply write, see that function's own "Tracked apply outcome" comment) -- and NOTHING
// else. No live Vortex read, no rules check, no collection.json completeness audit: a collection this
// tool has never touched has NOTHING to continue, full stop, regardless of what Vortex's own live
// per-mod status happens to show (that's Vortex's own concern, not this tool's).
function computeNeedsRecheck(collection) {
    try {
        const statusPath = path.join(getUcv2TrackingDir(collection.modId), 'ucv2-apply-status.json');
        if (!fs.existsSync(statusPath)) return false; // never touched by this tool -- nothing to continue
        const record = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        return !!(record && record.cleanApply === false); // our own last attempt didn't finish clean
    } catch {
        return false; // can't read our own tracking file -- default to no button, not a false alarm
    }
}

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
            // Read-only fallback (2026-08-30, director-caught real false alarm): this ISN'T "you must
            // close Vortex" -- Vortex genuinely being closed is only required for the direct state.v2
            // read just below, one of two ways to satisfy this same need. The Helper (the OTHER way)
            // is confirmed installed and normally works fine WHILE Vortex runs -- it just failed to
            // answer THIS time, most often because Vortex is busy on its own main thread (mid-deploy,
            // still starting up, etc. -- see vortex-helper-client.js's own header comment, "the helper
            // genuinely, reproducibly blocks during a real Vortex deploy", a confirmed, not guessed,
            // mechanism). Telling the user to close Vortex here is actively wrong advice for that real
            // case -- they don't need to close anything, just wait a moment and retry.
            const err = new Error("Vortex is currently busy. Please wait for Vortex to finish its current activity, then try again.");
            err.code = 'VORTEX_RUNNING';
            throw err;
        }
        nexusInfoByModId = await resolveNexusInfo(state, modIds);
    }

    const enriched = local.map((c) => ({ ...c, ...(nexusInfoByModId[c.modId] || {}) }));
    const revisionResults = await fetchNewestRevisions(apiKey, enriched);

    // No live Vortex read here at all -- see computeNeedsRecheck's own header comment for why: this
    // button is purely this tool's own tracked-record question, nothing live-state ever answers it.
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
            needsRecheck: computeNeedsRecheck(c),
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

// Patches ONE collection's own cached revision after a real Apply, instead of triggering a full
// refreshCollectionsCache -- that would mean a real Nexus API sweep across EVERY installed
// collection just to update one. runApply's own result already carries the real new revision number
// (result.newRevisionNumber -- the same value the Apply Result screen's own "Now on Rev
// {result.newRevisionNumber}" text already uses), so this just writes it straight into the existing
// cache entry rather than re-deriving it.
//
// Without this, the cache stays stale until the next manual Refresh or server restart -- the
// collections-overview screen's own reload-on-Back (ucv2CancelReview's own comment: "a real apply may
// have changed what's installed -- always reload fresh") just re-reads this SAME stale cache, since
// nothing else ever told it a real Apply happened.
//
// No-ops (never throws) when the cache isn't populated yet or doesn't contain this modId -- a real
// Apply failing to find its own collection in an unpopulated cache must never ALSO crash the apply
// that just succeeded. Every other collection's own cache entry, and every OTHER field on this one,
// is left completely untouched.
function patchCollectionCacheRevision(collectionModId, newRevisionNumber) {
    if (!ucv2Cache.collections) return;
    const index = ucv2Cache.collections.findIndex((c) => c.modId === collectionModId);
    if (index === -1) return;
    const entry = ucv2Cache.collections[index];
    const updatedEntry = {
        ...entry,
        installedRevision: newRevisionNumber,
        updateAvailable: entry.newestRevisionNumber != null && newRevisionNumber != null
            && entry.newestRevisionNumber > newRevisionNumber,
    };
    const updatedCollections = ucv2Cache.collections.slice();
    updatedCollections[index] = updatedEntry;
    ucv2Cache = { ...ucv2Cache, collections: updatedCollections };
}

// For tests only -- ucv2Cache is real module-level singleton state with no other way to seed it
// without going through a real Nexus sweep (refreshCollectionsCache/checkForUpdates). Same
// "*ForTest" convention as lib/idle-close-handle.js's own isOpenForTest.
function setCollectionsCacheForTest(cache) {
    ucv2Cache = cache;
}

// Pure: given every real revision Nexus has (newest-first) and the currently-installed revision
// number, narrows to the range a director would ever want to pick FROM this Review screen -- never
// offering a downgrade below what's already installed, per the director's own framing ("pull all the
// revisions from the currently installed revision to the newest") -- then resolves which ONE revision
// this review actually diffs against: the explicit pick if one was given (must be in that same
// narrowed range -- picking something below the installed revision, or a revisionNumber Nexus doesn't
// have at all, is refused with REVISION_NOT_FOUND rather than silently clamped), or the real newest
// (draft-inclusive, see reviewUpdate's own header comment on resolveNewestRevision) when none was.
// installedRevisionNumber === null (the installed revision couldn't be resolved at all) skips the
// range filter entirely -- every real revision stays pickable rather than guessing a floor.
function resolveReviewRevisions(revisions, installedRevisionNumber, targetRevisionNumber) {
    const revisionsInRange = installedRevisionNumber == null
        ? revisions
        : revisions.filter((r) => r.revisionNumber >= installedRevisionNumber);
    if (targetRevisionNumber == null) {
        return { revisionsInRange, target: nexusCollectionDownload.resolveNewestRevision(revisionsInRange) };
    }
    const target = revisionsInRange.find((r) => r.revisionNumber === targetRevisionNumber);
    if (!target) {
        const err = new Error(
            `Revision ${targetRevisionNumber} isn't available to pick here -- it must be between the ` +
            'currently-installed revision and the newest one Nexus has.'
        );
        err.code = 'REVISION_NOT_FOUND';
        throw err;
    }
    return { revisionsInRange, target };
}

// Skyrim SE's own executable name -- matches GAME_ID='skyrimse' used throughout this file. This
// project is SE-only (VR would be SkyrimVR.exe, a genuinely different game as far as this app is
// concerned, and not something this constant needs to cover).
const SKYRIM_EXE_NAME = 'SkyrimSE.exe';

// Real installed Skyrim SE version, read straight off the .exe's own embedded Windows file-version
// resource -- matches Vortex's OWN default getInstalledVersion() behavior for gamebryo games exactly
// (confirmed via real source, awesmdiver/vortex extensions/test-gameversion/src/gamesupport.ts's own
// header comment: "allow games to have specific functions to get at the version, otherwise take the
// version stored in the executable"). Does NOT need the Helper -- the exe's own file version is a
// static Windows PE resource, unrelated to Vortex's live state, so this works even with Vortex fully
// closed (matches this project's own "without the Helper" degraded-path convention -- see README's
// compatibility table -- rather than making the whole game-version-mismatch feature Helper-only).
// Derives the exe's path from skyrimDataDir (already a real, user-configured Settings field --
// Data/'s own parent folder is the game root SkyrimSE.exe lives in), no new Settings field needed.
// Returns null (never throws) on ANY failure -- no skyrimDataDir configured, the exe genuinely
// missing, PowerShell unavailable -- matching this project's own "gracefully degrade, never block
// the feature" convention for optional data throughout.
function getInstalledGameVersion() {
    return new Promise((resolve) => {
        const { skyrimDataDir } = appConfig.loadConfig();
        if (!skyrimDataDir) { resolve(null); return; }
        const exePath = path.join(path.dirname(skyrimDataDir), SKYRIM_EXE_NAME);
        if (!fs.existsSync(exePath)) { resolve(null); return; }
        execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.FileVersion`,
        ], { timeout: 5000 }, (err, stdout) => {
            resolve(err ? null : (stdout.trim() || null));
        });
    });
}

// Pure comparison, no I/O -- mirrors Vortex's own real InstallDriver.ts check EXACTLY (confirmed via
// source, ~line 875: `gv.reference === gameVersion`, plain string equality against each declared
// recommended version, never a semver range). Returns { mismatch: false } whenever either side is
// missing/empty -- "can't check" skips the warning entirely rather than guessing, same "never block
// a feature on data that isn't there" convention getInstalledGameVersion above already follows.
function checkGameVersionMismatch(installedVersion, recommendedVersions) {
    if (!installedVersion || !recommendedVersions || recommendedVersions.length === 0) {
        return { mismatch: false };
    }
    if (recommendedVersions.includes(installedVersion)) return { mismatch: false };
    return { mismatch: true, actual: installedVersion, intended: recommendedVersions.join(' or ') };
}

// Curator's own install instructions (2026-08-28, director's own real Vortex screenshot as reference --
// its own "Instructions" tab). Real Vortex's ICollectionInfo type confirms the field name
// (installInstructions: string). Pure, no I/O -- only surfaces a real, non-empty string; an unset or
// whitespace-only value returns null so the frontend renders nothing extra (not an empty callout).
// Returns the ORIGINAL string, not trimmed -- trimming is only for the emptiness check, never applied
// to the curator's own text that actually gets displayed.
function resolveInstallInstructions(newCollectionRaw) {
    const raw = newCollectionRaw && newCollectionRaw.info && newCollectionRaw.info.installInstructions;
    return (typeof raw === 'string' && raw.trim()) ? raw : null;
}

// The "Review update" flow -- for ONE collection, downloads a revision's real collection.json from
// Nexus (the newest by default, or a specific one the director explicitly picked from the Review
// screen's own revision dropdown -- see resolveReviewRevisions above), reads the currently-installed
// one straight off disk (the same established "installed collection.json is the authoritative record
// of what's installed" source captureBackupSnapshot already relies on), and diffs them. Vortex is NOT
// required to be closed for this at all -- resolving the slug/installed-revision is the only
// Vortex-touching step, same helper-first/state.v2-fallback pattern as checkForUpdates above; reading
// the OLD collection.json is a plain local file read, and fetching the NEW one is a Nexus API call,
// neither ever needs Vortex.
// Renamed from reviewUpdate (2026-08-29, real redundancy fix, director-requested) -- this is the
// REAL implementation; reviewUpdate below is now a thin public wrapper. The reason for the split:
// this function's own internal getAllMods() read (liveModsData, built for the keep-installed/
// optional-mod live matching just above) used to be silently wasted the instant it returned, because
// every internal caller that needed a live-mod snapshot for its OWN purposes (prepareApply's
// dependency-break check, prepareApplyOptional's identical check, retryModExtraction's live-modId
// resolve) called plain reviewUpdate() and then fetched a SECOND, completely separate ~46MB
// getAllMods() snapshot right after -- two full reads of the same live state, seconds apart, for
// the exact same live-review pass. liveModsData is NOT added to reviewUpdate's own public return
// object (that object is sent verbatim as the /review route's real HTTP response body, res.json(result)
// in update-collection-v2-routes.js -- a 46MB field on every Review click would be a severe
// regression), so this internal-only variant returns it separately, and only the three genuinely
// internal callers (prepareApply, prepareApplyOptional, retryModExtraction) reach for it.
// Review result cache (2026-08-30, director's own real catch: "why can't we do everything in the
// first pass including the dependency check? I would think vortex does not do two passes." He's
// right -- prepareApply used to call this SAME function a second time, from scratch, purely so its
// own dependency-break check (findBrokenDependencies, further down) could see the freshest data. But
// that check only needs review.updated + liveModsData, both of which THIS function already computed
// and returned the first time; nothing about the expensive part (the Nexus fetch, diffCollectionMods,
// and above all the ~1787-mod unchanged-archive scan the concurrency fix above exists for) needed to
// be redone at all. Confirmed live: a real ~2000-mod collection paid that full ~2-3 minute scan THREE
// times in a row for one Apply attempt -- once for Review, once for prepareApply's own gate, and
// again for the retry after resolving the dependency-break choice it surfaced -- with zero progress
// shown for any of the second/third passes (prepareApply never had onProgress wired to it at all).
//
// The fix keeps the ORIGINAL safety principle ("never trust a client-held diff that may be stale")
// fully intact -- this cache is keyed and populated entirely server-side, never by anything the
// client sends, so it's a bounded-time reuse of the server's OWN just-verified computation, not a
// trust concession. REVIEW_CACHE_TTL_MS bounds how stale a reused review can ever be; a real write
// (runApply, retryModExtraction) invalidates its own collection's entry the moment it starts, so a
// SUBSEQUENT apply attempt on the same collection can never reuse pre-write data by accident.
const REVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const reviewCache = new Map(); // key -> { result: {review, liveModsData}, computedAt }

function reviewCacheKey(collectionModId, targetRevisionNumber) {
    return `${collectionModId}::${targetRevisionNumber ?? 'latest'}`;
}

function invalidateReviewCache(collectionModId) {
    for (const key of reviewCache.keys()) {
        if (key.startsWith(`${collectionModId}::`)) reviewCache.delete(key);
    }
}

async function reviewUpdateCore(args) {
    const { collectionModId, targetRevisionNumber } = args;
    const key = reviewCacheKey(collectionModId, targetRevisionNumber);
    const cached = reviewCache.get(key);
    if (cached && Date.now() - cached.computedAt < REVIEW_CACHE_TTL_MS) return cached.result;
    const result = await reviewUpdateCoreUncached(args);
    // Stored under BOTH the key this call actually asked for AND the concrete resolved revision
    // (2026-08-30, real cache-miss bug caught live: the Review screen's own initial call omits
    // targetRevisionNumber entirely -- key "...::latest" -- but ucv2ConfirmApply always sends the
    // real resolved number it got back -- key "...::116" -- so prepareApply's own re-review missed
    // the cache it had JUST populated seconds earlier and redid the full scan anyway. Writing both
    // keys means either caller's own natural request shape hits the same entry.
    reviewCache.set(key, { result, computedAt: Date.now() });
    const resolvedKey = reviewCacheKey(collectionModId, result.review.newRevisionNumber);
    if (resolvedKey !== key) reviewCache.set(resolvedKey, { result, computedAt: Date.now() });
    return result;
}

async function reviewUpdateCoreUncached({ collectionModId, staging, state, targetRevisionNumber, downloads, onProgress = () => {} }) {
    const local = listCollections(staging);
    const collection = local.find((c) => c.modId === collectionModId);
    if (!collection) throw new Error(`Collection "${collectionModId}" isn't currently installed (or isn't a real, non-Workshop collection).`);

    onProgress({ type: 'phase', message: 'Fetching the latest revision from Nexus…' });
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    // Hard-blocked, not a degraded fallback (2026-08-30, director's own explicit call: "if vortex
    // isn't up - we don't do anything"). Real, live-confirmed incident this fixes: with Vortex closed,
    // this function used to silently keep going -- nexusInfo alone has its own legitimate state.v2
    // fallback (fine, read-only metadata), but every LIVE per-mod check further down (getAllMods,
    // getLiveRulesForMod -- Ignored/Disabled status, "still actually installed", "keep installed
    // version") quietly went null instead, and the Review screen showed confident-looking Ignored (0)/
    // Disabled (0) with no indication anything was missing. The director caught it by memory (knew
    // they'd only fixed Disabled mods, not Ignored ones) -- a less attentive read of the same screen
    // would have looked completely trustworthy. prepareApply/prepareApplyOptional/retryModExtraction
    // already refuse outright (HELPER_UNAVAILABLE) rather than degrade; review gets the exact same
    // treatment now instead of a partial result nobody asked for.
    if (!helperAvailable) {
        const err = new Error('Vortex needs to be open and reachable to review an update -- Ignored/Disabled status and live-installed checks all need real data from it, and a partial review would be misleading rather than just less complete. Open Vortex and try again.');
        err.code = 'HELPER_UNAVAILABLE';
        throw err;
    }
    let nexusInfo = helperAvailable ? await resolveNexusInfoViaHelper([collectionModId]) : null;
    let source = 'helper-extension';
    if (!nexusInfo) {
        source = 'state.v2';
        if (syncLib.isVortexRunning()) {
            // Same real false alarm as checkForUpdates' own identical fallback just above -- see that
            // throw's own header comment for the full reasoning. Not "close Vortex", just "wait for
            // it to finish whatever it's doing and retry" -- closing it is not actually required for
            // the Helper path to recover.
            const err = new Error("Vortex is currently busy. Please wait for Vortex to finish its current activity, then try again.");
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
    onProgress({ type: 'phase', message: 'Listing this collection’s revisions on Nexus…' });
    const { revisions } = await nexusCollectionDownload.fetchCollectionRevisions(apiKey, info.collectionSlug);
    const installedRevisionNumber = info.revisionNumber ?? null;
    const { revisionsInRange, target } = resolveReviewRevisions(revisions, installedRevisionNumber, targetRevisionNumber);
    if (!target) throw new Error(`No revisions found on Nexus for "${collection.name}" (slug="${info.collectionSlug}").`);
    // Real file size/game version/adult-content richness for the revision picker (2026-08-28,
    // director's own follow-up -- see fetchRevisionsRichness's own header comment for the full real
    // investigation/why this is safe to pay). Fetched for the WHOLE range in one aliased GraphQL
    // request, merged into each revision object here so the frontend never needs a second round
    // trip. Best-effort: fetchRevisionsRichness never throws, and a specific revision simply missing
    // from the response leaves that revision's own richness fields undefined -- the picker already
    // degrades gracefully to "just revision number + date" for those.
    onProgress({ type: 'phase', message: `Checking file size/game version for ${revisionsInRange.length} revision${revisionsInRange.length === 1 ? '' : 's'}…` });
    const richnessByRevision = await nexusCollectionDownload.fetchRevisionsRichness(
        apiKey, info.collectionSlug, revisionsInRange.map((r) => r.revisionNumber),
    );
    const revisionsInRangeWithRichness = revisionsInRange.map((r) => ({ ...r, ...(richnessByRevision[r.revisionNumber] || {}) }));
    onProgress({ type: 'phase', message: `Downloading Revision ${target.revisionNumber}’s own collection.json from Nexus…` });
    let newRevision;
    try {
        newRevision = await nexusCollectionDownload.fetchAndExtractCollectionJson({
            slug: info.collectionSlug, revisionNumber: target.revisionNumber, destDir: tmpDir, sevenZipExe,
            downloadsDir: downloads, collectionModId,
        });
    } finally {
        // extracted collection.json is re-read below before cleanup -- fs.rmSync only removes the
        // temp dir, the parsed data already lives in memory by then.
    }
    onProgress({ type: 'phase', message: 'Reading the downloaded revision…' });
    // Raw bytes kept verbatim (2026-09-01, director's own explicit correction: "we NEVER change the
    // collection.json file - never, it's read only... it belongs to the mod author", "Vortex uses it
    // too" -- the local collection.json must stay whatever Vortex's own native flow would have placed
    // there, never a hand-serialized reconstruction). Threaded through review/prepared as
    // newCollectionJsonRaw (a sibling of `review`, deliberately NOT a field ON review -- review is
    // sent to the frontend verbatim over SSE, see this function's own return-site comment, and this
    // string is the full multi-MB collection.json text on a large collection) all the way to runApply,
    // which writes it byte-for-byte in place of the old local collection.json once (and only once) a
    // full apply against this exact revision finishes completely clean -- see runApply's own "Replace
    // local collection.json with the pristine new revision" comment for the full write-site reasoning.
    const newCollectionJsonRaw = fs.readFileSync(newRevision.collectionJsonPath, 'utf8');
    const newCollectionRaw = JSON.parse(newCollectionJsonRaw);
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Game version mismatch (2026-08-27, director's own request, matching Vortex's real
    // InstallDriver.ts modal exactly) -- recommendedGameVersions comes straight from THIS revision's
    // own collection.json (info.gameVersions, confirmed real and populated on every real downloaded
    // collection.json this session -- zero extra Nexus calls, already-parsed data). installedVersion
    // is read directly off SkyrimSE.exe's own file version (see getInstalledGameVersion's own header
    // comment) -- independent of Vortex/the Helper entirely. Computed here, once, so the frontend
    // never has to re-derive the comparison itself.
    const recommendedGameVersions = (newCollectionRaw.info && newCollectionRaw.info.gameVersions) || null;
    const installedGameVersion = await getInstalledGameVersion();
    const gameVersionMismatch = checkGameVersionMismatch(installedGameVersion, recommendedGameVersions);

    const installInstructions = resolveInstallInstructions(newCollectionRaw);

    onProgress({ type: 'phase', message: 'Comparing against what’s currently installed…' });
    const oldCollectionRaw = JSON.parse(fs.readFileSync(collection.collectionJsonPath, 'utf8'));
    const diffStartedAt = Date.now();
    const diff = diffCollectionMods(oldCollectionRaw.mods, newCollectionRaw.mods);
    const diffMs = Date.now() - diffStartedAt;
    // Real, live-confirmed finding (2026-08-30): this comparison alone took long enough on a real
    // ~2000-mod collection (Gate To Sovngarde) to be the actual bottleneck behind a real "why is this
    // stuck on Fetching..." report -- confirmed via live process inspection (zero established network
    // connections, ~100% CPU) DURING what the UI's own single "Fetching..." label made look like one
    // step. Logged server-side (not surfaced as its own onProgress phase, since it's typically fast --
    // this is a diagnostic breadcrumb for the next time this needs investigating, not a promise this
    // step always needs its own UI phase) so a slow run like this one is visible in the server log
    // without needing to re-instrument blind.
    if (diffMs > 500) {
        console.log(`[update-collection-v2-runner] diffCollectionMods took ${diffMs}ms for ${oldCollectionRaw.mods.length} old / ${newCollectionRaw.mods.length} new mods -- worth profiling if this recurs.`);
    }
    // Real gap the director caught: `u.old.version` is just what the OLD collection revision happens
    // to have recorded, not necessarily what's actually installed right now -- the moment a mod is
    // updated by the user OUTSIDE this collection's own tracking, that recording goes stale and every
    // comparison built on it (the version arrow, the "keep installed" default below) silently reads
    // backwards relative to what's really going to happen to the user's files. Resolve the REAL live
    // version for each Updated mod here (helper-first, same fallback-to-stale-data convention this
    // whole file already follows when the Helper isn't reachable) -- see
    // resolveLiveVersionForUpdatedMod's own header comment for the three-tier match it uses.
    const liveModsData = helperAvailable ? await timedGetAllMods('reviewUpdate') : null;
    console.log(`[update-collection-v2-runner] PERF: liveModsData.mods has ${liveModsData ? Object.keys(liveModsData.mods).length : 0} entries`);
    const t_liveMatcherStart = Date.now();
    const liveMatcher = liveModsData ? buildLiveIdentityIndex(liveModsData.mods) : null;
    console.log(`[update-collection-v2-runner] PERF: buildLiveIdentityIndex took ${Date.now() - t_liveMatcherStart}ms`);
    const t_nexusIdxStart = Date.now();
    const liveModsByNexusId = liveModsData ? buildNexusIdIndex(liveModsData.mods) : null;
    console.log(`[update-collection-v2-runner] PERF: buildNexusIdIndex took ${Date.now() - t_nexusIdxStart}ms`);
    const enabledSet = liveModsData ? new Set(liveModsData.enabledModKeys) : null;

    // Ignored/Disabled real status (2026-08-30, director-caught real bug, screenshot evidence: "ELFX
    // Shadows"/"ELFX Shadows Patches Hub" showing as New when Vortex itself already shows them
    // Ignored). Root cause: diffCollectionMods is a pure collection.json-vs-collection.json diff --
    // an Ignored required mod (per real Vortex convention, `rule.ignored === true` -- see
    // buildCollectionMembershipRule's own header comment) was often NEVER actually installed, so it
    // was never written into this collection's own LOCAL collection.json to begin with, which makes
    // it look identical to a genuinely brand-new mod from a pure-diff standpoint. The real signal
    // diffCollectionMods can't see is this collection's own LIVE rules, not its local file.
    //
    // memberIdentities/collectionMemberRules moved up from where the Optional Mods block used to
    // fetch it (still reused there unchanged, just no longer re-fetched a second time) -- same real
    // fetch, now also read for its `ignored` flag here.
    const t_rulesStart = Date.now();
    const collectionMemberRules = helperAvailable
        ? await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId)).catch(() => null)
        : null;
    console.log(`[update-collection-v2-runner] PERF: getLiveRulesForMod took ${Date.now() - t_rulesStart}ms, rules=${collectionMemberRules ? collectionMemberRules.length : 'null'}`);
    const t_setsStart = Date.now();
    const memberIdentities = new Set(
        (collectionMemberRules || [])
            .filter((r) => r.reference && r.reference.repo)
            .map((r) => `${r.reference.repo.modId}:${r.reference.repo.fileId}`),
    );
    const ignoredIdentities = new Set(
        (collectionMemberRules || [])
            .filter((r) => r.reference && r.reference.repo && r.ignored === true)
            .map((r) => `${r.reference.repo.modId}:${r.reference.repo.fileId}`),
    );
    console.log(`[update-collection-v2-runner] PERF: memberIdentities/ignoredIdentities build took ${Date.now() - t_setsStart}ms`);
    const t_afterSets = Date.now();
    global.__ucv2PerfAfterSets = t_afterSets;
    const isIgnoredMod = (mod) => !!(mod.source && mod.source.modId && mod.source.fileId
        && ignoredIdentities.has(`${mod.source.modId}:${mod.source.fileId}`));
    // Genuinely a display-only overlay, never a bucket move -- an Updated mod that's currently
    // Disabled still needs its file re-extracted exactly like any other Updated mod (Phase 2b's own
    // existing disabled-restoration logic, captureLiveBackupSnapshot/touchedVortexModIds in runApply
    // below, already re-disables it once that real work finishes); this only labels the row so the
    // Review screen stops implying it's a plain New/Update like any other.
    const isDisabledMod = (mod) => {
        if (!liveMatcher || !enabledSet) return false;
        const vortexModId = resolveLiveModId(liveMatcher, mod.source);
        return !!vortexModId && !enabledSet.has(vortexModId);
    };

    // "New" mods that are actually already live-installed AND already a real member of THIS
    // collection (2026-09-01, director-caught real bug, screenshot evidence: re-checked "GTS - PBR
    // Visual Overhaul" at Rev 59 -> Rev 59 -- no real revision change at all -- and the Review screen
    // still showed 5 "New" mods, including "Angi'S Camp Archery Targets", which Vortex's own real Mods
    // table showed as Enabled/Collection: GTS - PBR Visual Overhaul/installed 2 weeks ago. Director's
    // own words: "I just did a re-check and there is nothing to fix but we say these files are 'new' --
    // confusing." Root cause: diffCollectionMods' own `added` bucket (collection-diff.js, ~line 279) is
    // pure set subtraction against the OLD local collection.json -- it has no idea whether a mod is
    // actually already installed, only whether the local file ever recorded it. If local tracking is
    // missing an entry for a mod that's genuinely already installed (a prior partial apply, a manual
    // install outside this tool's own tracking, whatever caused the drift), that mod is
    // indistinguishable from a genuinely brand-new one to a pure-file diff. Same root cause family as
    // the unchanged-bucket fix just below and the Ignored fix further down -- local collection.json
    // drifting from live Vortex reality -- just hitting `added` instead.
    //
    // Two real checks, both required, reusing liveMatcher/memberIdentities already built above (same
    // helper-first/fallback-to-stale-data convention this whole file already follows -- both are
    // simply empty/null when the Helper isn't reachable, so this silently no-ops rather than false-
    // reclassifying anything when live data can't be trusted):
    //   1. Is this mod's NEW-revision identity actually live-installed right now (liveMatcher)?
    //   2. Is it ALSO genuinely tied to THIS collection's own live rules (memberIdentities -- the same
    //      set the Ignored check above and Optional Mods' own membership filter below both already
    //      use)? A live-installed mod that ISN'T actually ruled to this collection (a coincidental
    //      identity match -- another collection happens to also require the exact same file) is
    //      deliberately LEFT in `added` -- registering this collection's own membership rule is still
    //      real, needed work for that case, not a false positive.
    // Reclassified into `unchanged` (plain `mod` shape, not a diff pair -- there's no genuine old/new
    // version pair to show, mirroring the SAME reclassification convention the unchanged bucket's own
    // live-installed check just below already uses in reverse) BEFORE that check runs, so a
    // reclassified mod still gets the exact same "still live-installed"/"needs an Open FOMOD choice"
    // treatment every other unchanged mod already gets, rather than skipping that check entirely.
    if (liveMatcher) {
        const isMemberIdentity = (mod) => !!(mod.source && mod.source.modId && mod.source.fileId
            && memberIdentities.has(`${mod.source.modId}:${mod.source.fileId}`));
        const actuallyAlreadyInstalled = diff.added.filter((m) => !!resolveLiveModId(liveMatcher, m.source) && isMemberIdentity(m));
        if (actuallyAlreadyInstalled.length > 0) {
            const alreadySet = new Set(actuallyAlreadyInstalled);
            diff.added = diff.added.filter((m) => !alreadySet.has(m));
            diff.unchanged = [...diff.unchanged, ...actuallyAlreadyInstalled];
        }
    }

    // Two real, live-confirmed gaps in the "unchanged" bucket (2026-08-29), fixed together here since
    // both need the SAME reclassification mechanism -- move an entry from unchanged into added, so it
    // flows through the exact same, already-proven Added-mod pipeline (FOMOD gate -> extraction ->
    // registration) instead of Apply silently never touching it:
    //
    // 1. "unchanged" only ever meant "this mod's identity didn't change between the old and new
    //    collection.json" -- it never checked whether the mod is STILL ACTUALLY installed in Vortex.
    //    A mod the director deleted directly in Vortex (outside this collection's own tracking) stays
    //    "unchanged" here forever, since nothing about its recorded identity ever changed -- Apply
    //    then never re-offers it. liveMatcher (built just above) already has everything needed to
    //    check this; it just was never asked here. Live-confirmed: 6 real mods the director deleted
    //    from Vortex, but not from the collection, silently never got reinstalled across a real apply.
    //
    // 2. An "Open FOMOD" (the archive has a real FOMOD installer wizard, but the collection has no
    //    recorded choices for it -- Vortex's OWN Install Type marks these mods "Fresh Install", not
    //    "Same Installer Options") has no static default to silently replay, so before this fix,
    //    detectFomodChoiceNeeds only ever scanned the updated/added buckets, so an Open FOMOD mod that
    //    happened to be file-identical to the last revision was invisible to that gate forever.
    //
    //    CORRECTED 2026-09-01 (director-caught real bug, screenshot evidence: re-checked "GTS - PBR
    //    Visual Overhaul" at Rev 59 -> Rev 59 -- no real revision change -- and 3 of 5 "New" mods
    //    were genuinely already correctly installed, real FOMOD choices already made, showing as
    //    "New" purely because THIS collection's own local collection.json never recorded those
    //    choices). Director's own standing scope for this whole tool: "we update the collection, if
    //    updated, we're done -- until the next update shows up... for the fomod, if installed
    //    correctly, it's skipped in the clean-up phase (re-check)... should they want to change the
    //    FOMOD items, they can do it in Vortex." This SUPERSEDES the original 2026-08-29 "ask every
    //    apply, regardless of whether the file changed" decision quoted in this file's own git
    //    history -- that decision assumed no real signal existed for "already correctly resolved";
    //    it does (Vortex's own live `attributes.installerChoices`, set the moment the real FOMOD
    //    wizard is genuinely completed, independent of whether THIS collection's own local file ever
    //    captured it). So `hasRecordedFomodChoices` now ALSO true when the mod is live-installed with
    //    real, non-empty live choices already recorded -- not just when local collection.json has its
    //    own copy. A mod with no real choices recorded anywhere (never actually installed through a
    //    completed FOMOD wizard) still correctly falls through to the real archive-read check below.
    //
    // Parallelized (Promise.all) -- the open-FOMOD check needs a real archive read per candidate
    // (locateArchive + listArchive + findModRoot), same "independent per-mod reads, no shared state"
    // reasoning the Added-mod loop's own bucketedAddedItems already uses elsewhere in this file.
    // findModRoot THROWS (not a falsy return) for an archive with no real fomod/ModuleConfig.xml --
    // caught here the same way detectFomodChoiceNeed's own header comment already documents (a plain,
    // non-FOMOD mod is a legitimate, common outcome, not an error).
    // Real, live progress (2026-08-30, director-caught real gap: a large collection's own Review can
    // spend real time here -- one archive read (locateArchive + a real `7z l` listing) per unchanged
    // mod with no recorded FOMOD choices -- with nothing on screen to show it's working, not hung.
    // Same activity-reporting shape this project's own Apply flow already established (onProgress
    // {type:'progress', current, total, message}, rendered as "current / total — message") -- reused
    // here rather than inventing a second convention. Promise.all runs every mod's own check
    // concurrently (unchanged, deliberately -- see this loop's own header comment above for why), so
    // "current" counts completions as they land, not array order; still an honest, live count.
    let unchangedCheckedCount = 0;
    console.log(`[update-collection-v2-runner] PERF: gap between sets-build and unchanged-loop start: ${Date.now() - global.__ucv2PerfAfterSets}ms; diff.unchanged.length=${diff.unchanged.length}`);
    if (diff.unchanged.length > 0) {
        onProgress({ type: 'phase', message: 'Checking installed mods for changes…' });
    }
    // Real, live-confirmed bottleneck (2026-08-30): an unthrottled Promise.all here fires one real
    // `7z.exe` child-process spawn (locateArchive + listArchive) PER unchanged mod all at once -- on
    // Gate To Sovngarde's real 1787-mod unchanged bucket, that's ~1787 simultaneous process spawns,
    // which pegged a full CPU core for 75+ seconds straight with no sign of finishing (confirmed via
    // live process CPU sampling: continuous ~100% single-core usage, zero network connections). Fixed
    // with the same bounded-concurrency `pool()` helper archive-finder-scanner.js already uses for the
    // identical "bulk listArchive calls" shape -- CONCURRENCY=6 matches that proven, already-tuned
    // value for the exact same kind of operation rather than guessing a new one.
    const UNCHANGED_CHECK_CONCURRENCY = 6;
    const unchangedClassifications = await poolMap(diff.unchanged, UNCHANGED_CHECK_CONCURRENCY, async (mod) => {
        const vortexModId = liveMatcher ? resolveLiveModId(liveMatcher, mod.source) : null;
        const stillLiveInstalled = !liveMatcher || !!vortexModId;
        // Real, already-completed live choices count too (see this block's own "CORRECTED 2026-09-01"
        // header comment above) -- Vortex's own live attributes.installerChoices is set the moment a
        // real FOMOD wizard genuinely finishes, independent of whether THIS collection's own local
        // collection.json ever captured a copy of it.
        const liveInstallerChoices = vortexModId && liveModsData && liveModsData.mods[vortexModId]
            && liveModsData.mods[vortexModId].attributes && liveModsData.mods[vortexModId].attributes.installerChoices;
        const hasLiveFomodChoices = !!(liveInstallerChoices && liveInstallerChoices.type === 'fomod'
            && Array.isArray(liveInstallerChoices.options) && liveInstallerChoices.options.length > 0);
        const hasRecordedFomodChoices = !!(mod.choices && mod.choices.type === 'fomod') || hasLiveFomodChoices;
        let isOpenFomod = false;
        if (!hasRecordedFomodChoices) {
            try {
                const archivePath = await locateArchive(downloads, mod.source);
                const entries = await listArchive(sevenZipExe, archivePath);
                findModRoot(entries);
                isOpenFomod = true;
            } catch {
                isOpenFomod = false; // no archive on disk yet, or genuinely not a FOMOD archive
            }
        }
        unchangedCheckedCount += 1;
        onProgress({ type: 'progress', current: unchangedCheckedCount, total: diff.unchanged.length, message: `Checking ${mod.name}` });
        return { mod, reclassify: !stillLiveInstalled || isOpenFomod };
    });
    diff.unchanged = unchangedClassifications.filter((c) => !c.reclassify).map((c) => c.mod);
    diff.added = [...diff.added, ...unchangedClassifications.filter((c) => c.reclassify).map((c) => c.mod)];

    // Ignored (2026-08-30, director-caught real bug -- screenshot evidence: "You Got Caught for
    // OStim SA," genuinely never installed per Vortex's own real Mods table ("Uninstalled"), showing
    // as "Installed" here instead of "Ignored"). Deliberately placed HERE, AFTER every bucket is
    // fully settled (including the unchanged->added reclassification just above) rather than filtered
    // early -- a first version of this fix only ever checked diff.added right after diffCollectionMods
    // returned, which missed two real cases live-confirmed the same session: (1) a mod ALREADY a
    // tracked member (still sitting in the local collection.json, so it starts in `unchanged` or
    // `updated`, never `added`), and (2) a mod that starts in `unchanged` but gets reclassified INTO
    // `added` by the block just above (not live-installed) -- checking added only ONCE, before that
    // reclassification ran, silently missed anything it moved in afterward. Checking all three FINAL
    // buckets, once, after every reclassification is done, is the only ordering that's actually
    // correct regardless of which bucket a real Ignored mod happens to start in.
    //
    // Pulled OUT of all three (not just flagged) -- Ignored genuinely means "don't install this," and
    // runApply below only ever processes review.added/review.updated/review.removed, so a mod that
    // never lands in one of those three can never reach the install pipeline. Real Vortex only ever
    // marks a REQUIRED-rule member ignored (an optional one uses this same flag for a different
    // reason -- "associated but not managed", see buildCollectionMembershipRule's own header comment
    // -- optional mods already live in their own separate optionalMods bucket below, untouched here).
    // u.old, NOT u.new (2026-08-30, real bug caught live -- director's own screenshot evidence:
    // "Gladys the Corgi" showing Ignored in Vortex's own live Mods list, yet still updated 2.0.7 ->
    // 3.0.1 by a real apply). ignoredIdentities is built from the live rule's own reference, which
    // points at whatever fileId is CURRENTLY installed -- for any genuine Update, that's u.old's
    // identity, never u.new's (a real version bump is exactly what changes fileId in the first place,
    // by definition -- see didFileChange's own header comment). Checking u.new here can never match a
    // real Ignored Updated mod at all; it would only ever fire for the (impossible) case where an
    // update's fileId happens not to change.
    const ignoredFromUpdated = diff.updated.filter((u) => isIgnoredMod(u.old));
    diff.updated = diff.updated.filter((u) => !isIgnoredMod(u.old));
    const ignoredFromUnchanged = diff.unchanged.filter(isIgnoredMod);
    diff.unchanged = diff.unchanged.filter((m) => !isIgnoredMod(m));
    const ignoredFromAdded = diff.added.filter(isIgnoredMod);
    diff.added = diff.added.filter((m) => !isIgnoredMod(m));
    const ignoredAdded = [...ignoredFromUpdated.map((u) => u.new), ...ignoredFromUnchanged, ...ignoredFromAdded];

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

    // Merged-plugin flag (2026-08-25) -- Update Collection v2's own Review already flags every OTHER
    // change before Apply would touch anything (version arrows, FOMOD-choice changes, shared-mod
    // warnings on Removed); this is the one real gap: an Updated mod gets RE-EXTRACTED into its
    // existing staging slot, and an Added mod gets freshly installed+enabled, either of which would
    // silently bring back a plugin that's on record as merged away by Merge Plugins, fighting with
    // whatever merged plugin now covers it. Only Updated/Added need this -- Removed is the opposite
    // direction (nothing to re-enable/re-stage), and Unchanged isn't touched by Apply at all. Reuses
    // Merge History's own saved-merge discovery wholesale (lib/merged-plugin-lookup.js's
    // buildMergedPluginLookup -> web/merge-history-routes.js's findAllMergeJsons) -- a plain, cheap
    // disk read, no live Plugins.txt/staging check (that drift computation is Merge History's own,
    // separate, already-shipped concern; this only asks "is this plugin ON RECORD as merged").
    const { mergeOutputDir } = appConfig.loadConfig();
    const mergedPluginLookup = buildMergedPluginLookup(mergeOutputDir);
    // .disabled tacked on here (not earlier) so it rides along with every other real per-mod flag
    // this same map pass already computes (fileChanged/installedIsNewer/mergedPluginFlag) instead of
    // a fourth separate pass over the same array.
    const updatedWithMergeFlag = updatedWithVersionFlag.map((u) => ({
        ...u,
        mergedPluginFlag: computeMergedPluginFlag(mergedPluginLookup, u.new),
        disabled: isDisabledMod(u.new),
    }));
    const addedWithMergeFlag = diff.added.map((m) => ({
        ...m,
        mergedPluginFlag: computeMergedPluginFlag(mergedPluginLookup, m),
        disabled: isDisabledMod(m),
    }));
    const unchangedWithDisabledFlag = diff.unchanged.map((m) => ({ ...m, disabled: isDisabledMod(m) }));

    // Optional mods (2026-08-28, director's own build-out of the Optional Mods Gate/Installs flow --
    // TECHNICAL.md's own Phase 1 write-up already flagged this as deliberately deferred). Raw
    // collection.json entries with `optional === true` -- diffCollectionMods excludes these from
    // removed/updated/added/unchanged entirely (see that function's own header comment), so this is
    // the ONE place they're read from newCollectionRaw.mods directly.
    //
    // CORRECTED 2026-08-30 (real bug the director caught live: "Skyshards Framework"/"Skyshards DLCs
    // And SubWorlds" -- already installed independently, never a member of THIS collection -- never
    // got offered at all, so they could never be associated). The original filter excluded any
    // optional mod that resolved to ANY live-installed mod, on the theory that "already installed"
    // meant "already handled" -- wrong: an optional mod can easily be installed completely
    // independently of this collection (a manual install, a different collection sharing it). The
    // real question is COLLECTION MEMBERSHIP, not install status -- exactly the same identity check
    // fixCollectionMembershipGaps already uses for its own "installed but not yet a member" gap
    // (memberIdentities, built once further up this function alongside ignoredIdentities -- see that
    // block's own header comment). A mod that's already a real member (an earlier optional-mods apply
    // pass, or a native Vortex association) is still correctly excluded here -- it just no longer
    // conflates "installed somewhere" with "installed as part of THIS collection". Falls back to
    // showing every optional mod unfiltered when the Helper isn't reachable (memberIdentities empty)
    // -- same "can't verify, don't silently hide" convention as this file's other live-Helper
    // fallbacks.
    const optionalMods = (newCollectionRaw.mods || [])
        .filter((m) => m.optional === true)
        .filter((m) => !(m.source && m.source.modId && m.source.fileId
            && memberIdentities.has(`${m.source.modId}:${m.source.fileId}`)));

    const review = {
        collectionModId, collectionName: collection.liveName || collection.name,
        installedRevision: installedRevisionNumber, newRevisionNumber: newRevision.revisionNumber,
        newRevisionId: newRevision.revisionId ?? null,
        // Every revision from what's currently installed up to the newest (2026-08-27, the Review/
        // Removed screens' own revision picker) -- lets the frontend build that dropdown without a
        // second round trip. Always the SAME range regardless of which one this particular review
        // actually diffed against (target/newRevisionNumber above), so re-rendering after a pick still
        // shows every other pickable revision, not just the one just chosen.
        revisions: revisionsInRangeWithRichness,
        // Game version mismatch (2026-08-27) -- see the computation above for the real source of
        // each field. gameVersionMismatch.mismatch is false whenever either side couldn't be
        // determined (no Settings path configured, exe not found, etc.) -- the frontend shows the
        // warning modal ONLY when this is explicitly true, never on missing data.
        recommendedGameVersions, installedGameVersion, gameVersionMismatch, installInstructions,
        removed: removedWithSharedFlag, updated: updatedWithMergeFlag, added: addedWithMergeFlag,
        // Ignored required mods (2026-08-30) -- real Vortex-confirmed status (rule.ignored === true),
        // pulled OUT of `added` above rather than flagged, since runApply below only ever installs
        // what's in review.added -- see the ignoredAdded/isIgnoredMod computation's own header
        // comment further up this function for the full real-bug writeup. Display + filter-pill only
        // on this screen; never processed by Apply, by construction.
        ignored: ignoredAdded,
        // Originally display-only (2026-08-18) -- every mod matched with no genuine update, so the
        // Review screen's total row count can reconcile against the collection's real total mod
        // count. ALSO read by runApply below now (2026-08-27, diagnostics/unchanged-mod-metadata-
        // staleness's own Finding 1) -- a mod can land here with a cosmetic-only change (a rename,
        // same file) that Review already displays correctly since this array already holds the
        // fresh new-revision object, but which used to never get persisted back to the local
        // collection.json at all. Still never used to decide WHETHER to act (that's still only
        // removed/updated/added) -- only to refresh what gets written for an item nothing else
        // touched.
        unchanged: unchangedWithDisabledFlag,
        // The new revision's own author-written load-order/conflict rules -- Phase 2's own finalize
        // step applies these against the just-updated live mod set (see applyCollectionModRules).
        // Purely additive field; harmless to any caller (e.g. Phase 1's own Review screen) that
        // doesn't read it.
        modRules: newCollectionRaw.modRules || [],
        optionalMods,
        source,
    };
    // liveModsData/newCollectionJsonRaw kept OUT of the object above deliberately -- see this
    // function's own header comment for why (the /review route sends that object verbatim as its
    // real HTTP response).
    return { review, liveModsData, newCollectionJsonRaw };
}

// Public wrapper -- the ONLY thing the /review route (and anything else outside this file) ever
// calls. Same real result the original single reviewUpdate() always returned; the internal
// liveModsData reviewUpdateCore also computed stays server-side, reused by the three callers below
// that actually need it instead of each paying for a second ~46MB read of their own.
async function reviewUpdate(args) {
    const { review } = await reviewUpdateCore(args);
    return review;
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

// modId:fileId, NOT just modId (2026-08-28) -- shared by the Updated/Added apply loops' own SSE
// row-key construction AND retryModExtraction's own lookup below, so both sides always agree on the
// same key shape. A single Nexus mod PAGE can ship several separate files (confirmed real, live,
// this same session: "HDT-SMP Distinct Falmer Hardened Armor - HIMBO"/"- CBBE 3BA", two fileIds
// under modId 189269, one of five such collision groups found in a single real collection) -- keying
// on modId alone let one mod's mod-start/mod-phase/mod-complete SSE frames silently overwrite a
// DIFFERENT mod's row on the frontend's modId-keyed Map (ucv2ApplyProgressRows), leaving the
// overwritten mod's own row frozen at "Download pending" forever even though it had already finished
// processing successfully. Same fix ucv2RemovedModId/keepRemovedModIdSet already got on 2026-08-26 for
// the exact same class of bug in the Removed bucket. Must match the frontend's own
// ucv2UpdatedModId/ucv2AddedModId exactly -- keep all in sync if this key ever changes again.
function sourceModFileKey(source, fallbackName) {
    const modId = source && source.modId;
    const fileId = source && source.fileId;
    return modId != null && fileId != null ? `${modId}:${fileId}` : String(modId ?? fallbackName);
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
    // withHelperRetry + the widened END_OF_APPLY_RETRY_OPTIONS budget (2026-09-01, director-caught
    // live: a real apply against GTS Legacy Lite hit BACKUP_FAILED because THIS was the one
    // getLiveRulesForMod call in this whole file with no retry patience at all -- every other call
    // site already wraps it. A missing backup blocks the entire apply outright (see runApply's own
    // "no backup, no apply" gate), so this is exactly the read that can least afford to give up on
    // one slow response.
    const rules = await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId), END_OF_APPLY_RETRY_OPTIONS);
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
// `rules[]`, never a per-member attribute).
//
// Bundle-type source handling (2026-08-28, real gap found live: MP_Melony.7z, a bundle-type Updated
// mod, kept showing "Download pending" on Vortex's own Collections page after a real, successful
// apply) -- Vortex's own real collectionModToRule explicitly EXCLUDES fileMD5 for a bundle source
// ("we can't use the md5 hash for a bundled file because they are recompressed during collection
// install and then the hash won't match", confirmed verbatim in transformCollection.ts) and never
// builds a `repo` block for it either (that's Nexus-only -- a bundle member has no modId/fileId).
// Mirrored here: repo is now built ONLY for source.type === 'nexus', and fileMD5 is omitted for a
// bundle source. Every other source.type this project's own mod objects can carry (nexus is the
// only one this project ever actively builds an Added/Updated rule for in practice) still gets the
// full nexus-shaped reference.
// `ignored` (2026-08-30, director-caught real gap): matches Vortex's own real per-rule `ignored`
// boolean flag exactly (confirmed via its own source -- mod_management/index.ts's real "incomplete
// required member" check explicitly excludes `rule["ignored"] === true`, and the collections
// extension's own session-status reconstruction treats an ignored member as terminal/resolved,
// never re-offered, whether required or optional). Real, live-confirmed case: the director manually
// associated an already-installed-but-unlinked mod ("Skyshards Framework") with this collection
// through Vortex's own native UI, and Vortex itself created the resulting rule with `ignored: true`
// -- its own convention for "this is now a tracked member, but it wasn't installed BY this
// collection, so don't actively manage it." fixCollectionMembershipGaps below passes this for
// exactly that same real scenario (an optional mod that resolves to an existing live install this
// apply never touched) instead of either silently skipping the association (the original bug) or
// forcing a wasteful, unnecessary re-extraction of a mod that's already correctly there.
function buildCollectionMembershipRule(mod, effectiveMod, { ignored } = {}) {
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
        // Bundle sources never get a real fileMD5 on the rule -- see this function's own header
        // comment above for the exact real-Vortex reasoning (recompression on collection install).
        fileMD5: source.type === 'bundle' ? undefined : source.md5,
        gameId: syncLib.GAME_ID,
        fileSize: source.fileSize,
        versionMatch,
        logicalFileName: source.logicalFilename,
    };
    // Only a fuzzy (prefer/latest) reference gets md5Hint -- matches Vortex's own real conditional
    // exactly (an 'exact' reference already pins the file precisely via versionMatch itself).
    if (updatePolicy === 'latest' || updatePolicy === 'prefer') reference.md5Hint = source.md5;
    if (source.type === 'nexus') {
        reference.repo = {
            repository: 'nexus', gameId: NEXUS_GAME_DOMAIN,
            modId: String(source.modId), fileId: String(source.fileId), campaign: 'collection',
        };
    }
    // Real mods on this project's own machine always carry their own collection-assigned tag
    // (confirmed: every real reference this project has ever read has one) -- no deterministic-tag
    // fallback needed the way Vortex's own function has for a tagless/legacy case. This is the
    // PRIMARY identity signal for a bundle source (no fileMD5, no repo above).
    reference.tag = source.tag;
    const rule = {
        type: mod.optional ? 'recommends' : 'requires', reference, phase: mod.phase ?? 0,
        extra: { author: mod.author, version: mod.version, name: mod.name, instructions: mod.instructions || undefined },
    };
    // Real Vortex's own collectionModToRule stamps this on a bundle member's rule too (extra.localPath
    // = path.join('bundled', fileExpression)) -- mirrored for parity, though nothing in this project
    // currently reads it back.
    if (source.type === 'bundle' && source.fileExpression) {
        rule.extra.localPath = path.join('bundled', source.fileExpression);
    }
    if (ignored) rule.ignored = true;
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

// Cross-collection "does the director already have this somewhere" index (2026-08-31, director's own
// real correction after live-testing findMissingAddedPrerequisites below): a mod being a real,
// resolvable Nexus file is NOT the same as it belonging here. Pandora Behaviour Engine REPLACES
// FNIS/Nemesis -- XP32 Maximum Skeleton Special Extended's own Nexus page lists Fores New Idles as an
// optional requirement (for FNIS-based animation replacers), which is real and correctly resolvable,
// but genuinely wrong to auto-install into a Pandora-based setup. Director's own words: "we never want
// to install mods that don't belong to anything already installed... Vortex would never do that...
// but we can be a little smarter" -- smarter means checking every OTHER installed collection's own
// declared mod list too, not just trusting Nexus's generic per-mod "requirements" metadata, which
// can't know which of several alternative/replacement mods a given setup actually uses.
//
// Deliberately the SAME shared-mod cross-reference idea the "shared with another collection" Removed-
// mods annotation above already established (syncRunner.listInstalledCollections, each collection's
// own raw collection.json mods[]) -- but a DIFFERENT identity check than buildSharedModIndex/
// findSharedModMatch: those two deliberately EXCLUDE the bare `nexus:modId` key (too weak a signal for
// removal safety, where a false negative is worse than a false positive). Here it's the opposite --
// a not-yet-installed candidate has no md5/logicalFilename to compare at all, only modId (and
// sometimes fileId once resolved), and a false NEGATIVE here (failing to recognize a real declared
// mod) is the safe direction, not a false positive. So this builds its own simple modId/fileId index
// rather than reusing those two functions. Every installed collection counts, including the one being
// applied (its own current mods[] can differ from review.added -- e.g. a genuinely-declared member
// that already resolved via some other path) -- not filtered to "other" collections the way the
// Removed-mods safety check above deliberately is.
function buildInstalledModDeclarationIndex(staging) {
    const keys = new Set();
    for (const c of syncRunner.listInstalledCollections(staging)) {
        let mods = [];
        try {
            mods = JSON.parse(fs.readFileSync(c.collectionJsonPath, 'utf8')).mods || [];
        } catch {
            continue;
        }
        for (const m of mods) {
            const src = m.source;
            if (!src || src.type !== 'nexus' || src.modId == null) continue;
            keys.add(`nexus:${src.modId}`);
            if (src.fileId != null) keys.add(`exact:${src.modId}:${src.fileId}`);
        }
    }
    return keys;
}

function isDeclaredSomewhereInstalled(index, modId, fileId) {
    if (fileId != null && index.has(`exact:${modId}:${fileId}`)) return true;
    return index.has(`nexus:${modId}`);
}

// Cross-collection "director explicitly chose not to install this" index (2026-08-31, same director
// correction as buildInstalledModDeclarationIndex just above, its own follow-up ask: "if the mod in
// question is ignored on the collection or another collection, if ignored, it is not to be installed").
// `ignored` is a LIVE Vortex rule flag (rule.ignored === true on a collection's own membership rule --
// see isIgnoredMod/buildCollectionMembershipRule elsewhere in this file), not something a static
// collection.json read can see at all -- a director who explicitly unticked/ignored a required or
// optional member (in THIS collection or in some completely different one that also happens to declare
// the same mod) has made a real, deliberate choice this gate must never override just because the mod
// is otherwise a real, declared, resolvable prerequisite. Checked EXACT (modId+fileId) only, matching
// how `ignored` itself is a per-specific-file rule, not a per-mod-page one -- unlike
// buildInstalledModDeclarationIndex's own bare-modId fallback, there's no safe looser match here (a
// director ignoring file A of a mod page says nothing about file B). One getLiveRulesForMod call per
// installed collection -- bounded the same way every other cross-collection check in this file already
// is (this only ever runs when review.added is non-empty, and the number of installed collections on a
// real machine is small, typically single digits).
async function buildIgnoredAnywhereIndex(staging) {
    const keys = new Set();
    for (const c of syncRunner.listInstalledCollections(staging)) {
        let rules;
        try {
            rules = await helperClient.getLiveRulesForMod(c.modId);
        } catch {
            rules = null;
        }
        for (const r of rules || []) {
            if (r.ignored === true && r.reference && r.reference.repo && r.reference.repo.modId != null && r.reference.repo.fileId != null) {
                keys.add(`${r.reference.repo.modId}:${r.reference.repo.fileId}`);
            }
        }
    }
    return keys;
}

function isIgnoredAnywhere(index, modId, fileId) {
    return fileId != null && index.has(`${modId}:${fileId}`);
}

// Missing-prerequisite check for Added mods (2026-08-31, diagnostics/2026-08-30-added-mod-
// prerequisite-check-scoping.md -- read that doc's own header for the full real incident this closes:
// a native Vortex install correctly refused to finish "Pandora XPMSE Behavior Patch" because its own
// prerequisite, "Pandora Behaviour Engine v4.4.0-beta", had been removed alongside it; this project's
// own Update Collection v2 had no equivalent check at all). See lib/nexus-mod-requirements.js's own
// header comment for the full real Nexus API research this is built on -- TWO distinct real signals,
// neither guessed: a genuine cross-MOD requirement (Mod.modRequirements), and a same-mod-page
// optional-file-needs-its-own-primary-file relationship (ModFile.primary) that the first signal
// structurally cannot see (a mod can't "require" itself).
//
// Scoped to `added` ONLY, never the whole collection -- the scoping doc's own decision #2, for the
// same real reason findBrokenDependencies' own siblings don't scan the whole collection either: a
// real collection can run to ~1900 mods, and one Nexus call per mod would be impractical. Bounded to
// this apply's own Added-mod count, typically a handful.
//
// isSatisfied checks BOTH real ways a prerequisite can already be covered: live-installed right now
// (nexusIdIndex for a cross-mod requirement -- ANY file of that mod page counts, matching Nexus's own
// real-world "just get this other mod" semantics; exactMatcher for a same-page primary-file
// requirement -- the SPECIFIC primary fileId must be the one that's live, not just any file sharing
// that modId), or ALSO being installed/updated in this SAME apply pass (thisApplyModIds/
// thisApplyModFileIds, same two-tier distinction).
async function findMissingAddedPrerequisites(added, updated, liveModsData, apiKey, staging, onProgress) {
    if (added.length === 0) return [];
    const declaredIndex = buildInstalledModDeclarationIndex(staging);
    const ignoredIndex = await buildIgnoredAnywhereIndex(staging);
    const nexusIdIndex = buildNexusIdIndex(liveModsData.mods);
    const exactMatcher = buildLiveIdentityIndex(liveModsData.mods);
    const thisApplyModIds = new Set([
        ...added.map((m) => String(m.source && m.source.modId)),
        ...updated.map((u) => String(u.new.source && u.new.source.modId)),
    ]);
    const thisApplyModFileKeys = new Set([
        ...added.map((m) => `${m.source && m.source.modId}:${m.source && m.source.fileId}`),
        ...updated.map((u) => `${u.new.source && u.new.source.modId}:${u.new.source && u.new.source.fileId}`),
    ]);
    const isSatisfiedAnyFile = (modId) => nexusIdIndex.has(String(modId)) || thisApplyModIds.has(String(modId));
    const isSatisfiedExactFile = (modId, fileId) => resolveLiveModId(exactMatcher, { modId, fileId }) !== null
        || thisApplyModFileKeys.has(`${modId}:${fileId}`);

    const missing = [];
    let checked = 0;
    for (const m of added) {
        checked += 1;
        onProgress({ type: 'progress', current: checked, total: added.length, message: `Checking prerequisites for ${m.name}` });
        const src = m.source;
        if (!src || src.type !== 'nexus' || src.modId == null || src.fileId == null) continue; // nothing to check for an off-site/non-Nexus source
        const result = await nexusModRequirements.resolveModPrerequisites(apiKey, src.modId, src.fileId);
        if (!result) continue; // best-effort -- a Nexus API failure here never blocks Apply, see resolveModPrerequisites' own header comment

        const missingItems = [];
        for (const req of result.crossMod) {
            if (isSatisfiedAnyFile(req.modId)) continue;
            missingItems.push({ modId: req.modId, name: req.modName, resolvable: req.resolvable, kind: 'cross-mod' });
        }
        if (result.ownPrimaryFile && !isSatisfiedExactFile(src.modId, result.ownPrimaryFile.fileId)) {
            missingItems.push({
                modId: String(src.modId), fileId: result.ownPrimaryFile.fileId, name: result.ownPrimaryFile.name,
                version: result.ownPrimaryFile.version, sizeInBytes: result.ownPrimaryFile.sizeInBytes,
                resolvable: true, kind: 'own-primary-file',
            });
        }
        if (missingItems.length > 0) {
            missing.push({ addedModKey: sourceModFileKey(src, m.name), addedModName: m.name, missing: missingItems });
        }
    }
    // A genuinely-missing cross-mod requirement doesn't carry a fileId yet (Nexus's own requirements
    // data never includes one -- see resolveModPrerequisites' own header comment) -- resolved here,
    // ONLY for entries that turned out to actually be missing (not for every requirement of every
    // Added mod), keeping this follow-up call count proportional to real problems found, not to
    // enumeration. Deduped by modId first -- two different Added mods can share the same missing
    // cross-mod requirement, and that mod's own primary file only needs resolving once.
    const primaryFileCache = new Map(); // modId -> resolved primary file or null
    for (const entry of missing) {
        for (const item of entry.missing) {
            if (item.kind !== 'cross-mod' || !item.resolvable || item.fileId) continue;
            if (!primaryFileCache.has(item.modId)) {
                primaryFileCache.set(item.modId, await nexusModRequirements.resolvePrimaryFileFor(apiKey, item.modId));
            }
            const primary = primaryFileCache.get(item.modId);
            if (primary) {
                item.fileId = primary.fileId; item.version = primary.version; item.sizeInBytes = primary.sizeInBytes;
            } else {
                item.resolvable = false; // no real primary file to install against after all -- offer skip only
            }
        }
    }
    // installable: a SEPARATE gate from resolvable (see buildInstalledModDeclarationIndex's own
    // header comment) -- a real, resolvable Nexus file is only ever OFFERED for install when some
    // installed collection (this one or another) also genuinely declares it, AND the director hasn't
    // explicitly ignored that exact file somewhere (buildIgnoredAnywhereIndex's own header comment --
    // a deliberate "ignore" choice always wins, even over a real declared membership). ignoredElsewhere
    // tracked as its own flag (not folded silently into `installable`) so the frontend can explain WHY
    // with its own distinct copy rather than reusing the "not part of anything installed" message for a
    // genuinely different real reason. Computed last, after fileId resolution above, since a cross-mod
    // item's fileId isn't known until then.
    for (const entry of missing) {
        for (const item of entry.missing) {
            const declared = isDeclaredSomewhereInstalled(declaredIndex, item.modId, item.fileId);
            const ignoredElsewhere = isIgnoredAnywhere(ignoredIndex, item.modId, item.fileId);
            item.ignoredElsewhere = ignoredElsewhere;
            item.installable = item.resolvable && declared && !ignoredElsewhere;
        }
    }
    return missing;
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
        //
        // withHelperRetry (2026-08-27) -- same exact race applyModRulesFresh's own getAllMods() call
        // above already hits and was already fixed for (see that function's own comment): this fires
        // in the same window, right after that same fresh read, while Vortex's own renderer can
        // genuinely still be busy finishing per-mod deploy work. Confirmed live, director's own
        // report: Apply showed 5 "Couldn't read this mod's current live rules" failures while Vortex
        // itself went on to deploy the collection successfully -- a transient "still busy" moment was
        // permanently failing this mod's rules step even though nothing was actually wrong.
        // Widened to END_OF_APPLY_RETRY_OPTIONS (2026-08-27) -- same reasoning as
        // END_OF_APPLY_RETRY_OPTIONS' own header comment: this call runs after the main apply's
        // heaviest real work, live-confirmed to fail under the standard budget while Vortex was
        // still genuinely catching up minutes later ("Bikini Mage Robes... couldn't read this mod's
        // current live rules").
        const currentRules = await withHelperRetry(() => helperClient.getLiveRulesForMod(sourceVortexModId), END_OF_APPLY_RETRY_OPTIONS);
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
                // Bounded retry against genuine "Vortex still catching up" rejections (2026-08-31,
                // director-caught real incident: a live apply's rule write failed here with zero
                // detail, right at the end of a big apply -- the exact same "Vortex's own renderer can
                // genuinely still be busy" window this function's own getLiveRulesForMod() call above
                // was already fixed for). applyRuleChangeDetailed() itself only retries once, and only
                // on a network-level failure -- this outer loop also retries a genuine same-process
                // rejection (ok:false with no networkFailure), same 3-attempt/3s-delay shape as
                // withHelperRetry's own default, since a plain object result can't use withHelperRetry
                // directly (its truthy-return check would stop after the very first attempt even when
                // ok is false).
                let attemptResult;
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    attemptResult = await helperClient.applyRuleChangeDetailed(sourceVortexModId, remove, add);
                    if (attemptResult.ok) break;
                    if (attempt < 3) await sleep(3000);
                }
                if (!attemptResult.ok) {
                    throw new Error(attemptResult.error || `Couldn't apply a rule change for "${sourceVortexModId}".`);
                }
            }
            totalRulesWritten += ops.length;
            modsChanged.push({ vortexModId: sourceVortexModId, name, ok: true, rulesWritten: ops.length });
        } catch (e) {
            modsChanged.push({ vortexModId: sourceVortexModId, name, ok: false, error: e.message });
        }
    }
    console.log(`[update-collection-v2-runner] applyCollectionModRules: ${modRules.length} authored rule(s), ${unresolvedCount} unresolved (source or target not currently installed), `
        + `${totalRulesWritten} written across ${modsChanged.length} mod(s), ${modsChanged.filter((m) => m.ok === false).length} failed.`);
    modsChanged.filter((m) => m.ok === false).forEach((m) => {
        console.warn(`[update-collection-v2-runner] applyCollectionModRules failure for "${m.name}" (${m.vortexModId}): ${m.error}`);
    });
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

// Real FOMOD preview images (2026-08-28) -- server-side only, in-memory, keyed by the mod's own
// Nexus modId (same identifier the picker's own `need.modId` already carries to the frontend).
// One entry per mod, overwritten (old scratch dir cleaned up) rather than accumulated -- a mod only
// ever has ONE live FOMOD gate open at a time in this tool's own single-apply-at-a-time model, so
// there's no real case where two different extractions for the SAME modId need to coexist. Entries
// are never actively expired on a timer -- the scratch dirs are small (just the mod's own Images/
// folder, not the whole archive) and get replaced on the next detection pass for that same mod
// (a fresh Apply/retry/optional-mods pass), so worst case is a handful of stale-but-harmless temp
// folders from a session that was closed mid-picker, not an unbounded leak.
const fomodImageCache = new Map(); // modId -> { dir, rootPrefix }

function registerFomodImages(modId, dir, rootPrefix) {
    const prior = fomodImageCache.get(modId);
    if (prior && prior.dir !== dir) fs.rmSync(prior.dir, { recursive: true, force: true });
    fomodImageCache.set(modId, { dir, rootPrefix: rootPrefix || '' });
}

// Resolves a picker-requested image (modId + the FOMOD's own <image path="..."/> value, relative to
// the mod's own root) to a real, already-extracted file on disk -- or null if nothing was ever
// registered for this modId, or the resolved path would escape the registered scratch dir (a
// defensive floor against a crafted imagePath in the request; this project's own real FOMOD archives
// have never needed anything beyond a plain relative path, per fomod-parser.js's own header comment).
function serveFomodImage(modId, imagePath) {
    const entry = fomodImageCache.get(String(modId));
    if (!entry || !imagePath) return null;
    const resolved = path.normalize(path.join(entry.dir, entry.rootPrefix, imagePath));
    const base = path.normalize(entry.dir + path.sep);
    if (!resolved.startsWith(base)) return null;
    return fs.existsSync(resolved) ? resolved : null;
}

// For ONE Updated-bucket entry, returns `null` if no fresh choice is needed, or a real detail
// object (name, reason, the parsed FOMOD structure to render) if one is. Never throws -- a mod
// whose archive can't even be located, or isn't a FOMOD-installer archive at all, is a DIFFERENT,
// pre-existing problem the real extraction step already reports; this gate only concerns itself
// with the specific "needs a human FOMOD choice" case.
//
// allowAutoDownload (2026-08-29, real root-cause fix, director-mandated -- "can't leave a FOMOD not
// installed correctly, it has to be part of the flow"): a BRAND-NEW mod (an Added mod, or an Optional
// install -- never previously installed) has no archive on disk yet at gate-check time. Locating
// nothing used to just return null here ("no need detected"), silently waving the apply past the
// gate -- the real Open FOMOD wall only got hit deep inside actual extraction, minutes later, surfacing
// as a plain failed "Open FOMOD" status instead of the real picker. Live-confirmed: "Skyshards DLCs
// And SubWorlds", a genuine Open FOMOD, sailed straight through this gate during an Optional-mods
// apply and failed live instead of prompting. Fixed by downloading the archive right here when it's
// missing (same downloadModArchive real download path rebuildSingleMod's own auto-download already
// uses) so the gate can actually look inside it -- the real extraction that follows later finds this
// SAME archive already on disk via its own locateArchive call, so this is never a second download.
async function detectFomodChoiceNeed(newMod, downloadsDir, sevenZipExe, allowAutoDownload) {
    let archivePath;
    try {
        archivePath = await locateArchive(downloadsDir, newMod.source);
    } catch {
        if (!allowAutoDownload || !newMod.source || newMod.source.type !== 'nexus') {
            return null; // no archive resolvable, and nothing this gate can do about it -- the real
                         // extraction step already reports this properly
        }
        try {
            const apiKey = resolveModDownloadApiKey();
            await downloadModArchive({ apiKey, gameDomain: NEXUS_GAME_DOMAIN, source: newMod.source, destDir: downloadsDir });
            archivePath = await locateArchive(downloadsDir, newMod.source);
        } catch {
            return null; // the download itself failed -- a different, pre-existing problem the real
                         // extraction step (which retries this same download) already reports
        }
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
    let keepScratchDir = false;
    try {
        const extractedConfigPath = await extractFile(sevenZipExe, archivePath, configPath, scratchDir);
        parsedFomod = parseModuleConfigFile(extractedConfigPath);
        // Real preview images (2026-08-28, director's own build-out -- checked against Vortex's own
        // real FOMOD wizard first, InstallerDialog.tsx's renderImage(): it points a plain <img> at an
        // already-fully-extracted file on disk, never a per-hover extraction or a data URI). This
        // project has no Electron file:// access (a browser tab, not a native window), so the picker
        // serves these over HTTP instead (see registerFomodImages/serveFomodImage + the
        // /fomod-image route) -- same "extract everything up front, dialog is a pure reader after
        // that" shape, just a fetch instead of a direct filesystem read. Only the mod's own Images/
        // folder (under its real rootPrefix, matching every <image path="..."/> in ModuleConfig.xml,
        // confirmed real: those paths are always relative to the mod root) -- not the whole archive,
        // which can be much larger than just its preview art.
        const imagesPrefix = `${(rootPrefix ? `${rootPrefix}\\` : '')}images\\`.toLowerCase();
        const imageEntries = entries.filter((e) => !e.isDir && e.path.toLowerCase().startsWith(imagesPrefix));
        if (imageEntries.length > 0) {
            try {
                await extractMany(sevenZipExe, archivePath, imageEntries.map((e) => e.path), scratchDir);
                registerFomodImages(String(newMod.source && newMod.source.modId), scratchDir, rootPrefix);
                keepScratchDir = true;
            } catch {
                // Best-effort -- a failure here never blocks the real FOMOD-choice gate this function
                // exists for. The picker's own <img> just falls back to its text placeholder (see
                // ucv2FomodShowPreview's own onerror handling) if no image ever got registered.
            }
        }
    } catch {
        return null; // couldn't even parse the config -- a different, pre-existing problem
    } finally {
        if (!keepScratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
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
async function detectFomodChoiceNeeds(updated, downloadsDir, sevenZipExe, allowAutoDownload, onProgress = () => {}) {
    // Same real thundering-herd bug as the unchanged-mod archive scan above (poolMap's own header
    // comment) -- an unthrottled Promise.all here fires one real 7z.exe spawn per mod all at once.
    // Smaller scale than that 1787-mod case (prepareApply's two callers pass ~41 and ~28 mods), but
    // confirmed live (2026-08-30) as a real contributor to prepareApply's own multi-minute, totally
    // invisible "Applying..." delay -- same fix, same CONCURRENCY, for the same reason.
    let checkedCount = 0;
    const results = await poolMap(updated, 6, async (u) => {
        const result = await detectFomodChoiceNeed(u.new, downloadsDir, sevenZipExe, allowAutoDownload);
        checkedCount += 1;
        onProgress({ type: 'progress', current: checkedCount, total: updated.length, message: `Checking FOMOD choices for ${u.new.name}` });
        return result;
    });
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
async function prepareApply({ collectionModId, staging, downloads, state, ignoreDependencyBreaks, keepInstalledModIds, fomodPicks, targetRevisionNumber, prerequisiteChoices, onProgress = () => {} }) {
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperAvailable) {
        const err = new Error('The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to apply an update -- this real deploy/remove/metadata work only exists through it, unlike this tool\'s read-only routes, which can also fall back to state.v2.');
        err.code = 'HELPER_UNAVAILABLE';
        throw err;
    }

    // Fresh re-review right before writing anything -- never trust a client-held diff that may be
    // stale (same "always re-derive server-side" principle every real write in this project follows).
    // targetRevisionNumber (2026-08-27, the Review/Removed screens' own revision picker) MUST be
    // threaded through here, not dropped -- a real, confirmed bug found live building this: without
    // it, this fresh re-review has no idea a specific OLDER revision was reviewed and silently
    // re-resolves to the true newest instead (resolveReviewRevisions' own no-target branch), discarding
    // the director's own deliberate pick at the exact moment it was supposed to take effect. The
    // frontend always sends whatever revision it actually just reviewed (ucv2CurrentReview.
    // newRevisionNumber, see ucv2ConfirmApply) -- not ONLY when a manual pick happened -- so this
    // fresh re-review is pinned to the SAME revision the director's own per-mod decisions (keep-
    // installed choices, removed-mod keep/remove, FOMOD picks) were actually made against, rather than
    // whatever Nexus's true newest happens to be by the time Apply fires moments later.
    // liveModsData (2026-08-29, real redundancy fix) -- reviewUpdateCore already reads Vortex's whole
    // live mod list once, internally, to build ITS OWN keep-installed/optional-mod matcher. This used
    // to be immediately followed by a SECOND, completely separate ~46MB getAllMods() read right below
    // for this gate's own dependency-break check -- two full reads of the same live state, seconds
    // apart. Reused directly now; only falls back to a fresh read if the Helper genuinely went
    // unreachable in between (rare, and the exact same failure mode a fresh read would hit anyway).
    // onProgress threaded into the fresh re-review too (2026-08-30, same director-caught gap this
    // whole block is being fixed for) -- a cache MISS here (first-ever apply on this collection, or
    // the TTL genuinely expired) still does the full multi-minute scan reviewUpdateCore's own cache
    // header comment describes, and without this it would go right back to being invisible. A cache
    // HIT just never fires any of reviewUpdateCoreUncached's own onProgress calls, resolving near-
    // instantly -- exactly the fast path this whole cache exists for.
    const { review, liveModsData, newCollectionJsonRaw } = await reviewUpdateCore({ collectionModId, staging, state, targetRevisionNumber, downloads, onProgress });

    const collection = listCollections(staging).find((c) => c.modId === collectionModId);
    if (!collection) throw new Error(`Collection "${collectionModId}" isn't currently installed (or isn't a real, non-Workshop collection).`);

    onProgress({ type: 'phase', message: 'Checking if you curated this collection…' });
    // "You curated this collection" (2026-08-18) -- purely informational (see the note below in the
    // final result), so a failure here (no API key configured, a Nexus API hiccup) never blocks the
    // real apply -- defaults to false and moves on.
    const isOwnCollection = await checkIsOwnCollection(collection.author);

    const data = liveModsData || await timedGetAllMods('prepareApply-fallback');
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
    onProgress({ type: 'phase', message: 'Checking whether this update breaks anything mods depend on…' });
    const updatedForBreakCheck = review.updated.map((u) => (keptModIds.has(sourceModFileKey(u.old.source, u.new.name)) ? { ...u, new: u.old } : u));
    const dependencyBreaks = findBrokenDependencies(updatedForBreakCheck, data.mods, collectionModId);
    if (dependencyBreaks.length > 0 && !ignoreDependencyBreaks) {
        const err = new Error(`Updating ${dependencyBreaks.length} mod's dependents may break -- see dependencyBreaks for detail. Set ignoreDependencyBreaks to proceed anyway.`);
        err.code = 'DEPENDENCY_BREAKS_FOUND';
        err.dependencyBreaks = dependencyBreaks;
        throw err;
    }

    // Missing-prerequisite gate for Added mods (2026-08-31) -- same "check before any real write,
    // refuse with real detail, let the caller resolve and re-call" shape as the dependency-break gate
    // just above. See findMissingAddedPrerequisites' own header comment for the full real design;
    // this is just the gate wiring: run the check against review.added as it stands right now, apply
    // whatever choices the caller already resolved from an EARLIER round trip (skip removes that mod
    // from review.added entirely -- matches Vortex's own real refusal for exactly this case, rather
    // than installing it broken; install does one real download+hash per resolvable missing item,
    // deduped across Added mods that share the same missing prerequisite, then appends each as a
    // normal new review.added entry so it flows through everything below -- the FOMOD gate, runApply's
    // own Added-mod loop -- completely generically, same as prepareApplyOptional's own header comment
    // already establishes for synthetic added entries), then refuse again with whatever's STILL
    // unresolved. A prerequisite mod that itself needs ANOTHER prerequisite (a real, if rare,
    // transitive case) surfaces on the NEXT round trip once this level's choices are applied -- one
    // check per call, same iterative-resolution shape the FOMOD-choice gate below already uses across
    // multiple round trips, not a loop within this single call.
    if (review.added.length > 0) {
        onProgress({ type: 'phase', message: `Checking prerequisites for ${review.added.length} new mod${review.added.length === 1 ? '' : 's'}…` });
    }
    const prereqChoicesSupplied = prerequisiteChoices || {};
    const prereqApiKey = resolveModDownloadApiKey();
    const foundPrereqIssues = await findMissingAddedPrerequisites(review.added, review.updated, data, prereqApiKey, staging, onProgress);
    if (foundPrereqIssues.length > 0) {
        const stillMissing = [];
        const installedThisRound = new Map(); // `${modId}:${fileId}` -> already-downloaded entry, so two Added mods needing the same prerequisite only download it once
        for (const entry of foundPrereqIssues) {
            const choice = prereqChoicesSupplied[entry.addedModKey];
            if (choice === 'skip') {
                review.added = review.added.filter((m) => sourceModFileKey(m.source, m.name) !== entry.addedModKey);
                continue;
            }
            if (choice === 'install') {
                for (const item of entry.missing) {
                    // installable already implies resolvable (see findMissingAddedPrerequisites' own
                    // final pass) -- covers both the doc's own decision #3 (off-site, nothing to
                    // install) AND the director's own 2026-08-31 correction (a real Nexus file that
                    // no installed collection actually declares never gets auto-installed either).
                    if (!item.installable) continue;
                    const key = `${item.modId}:${item.fileId}`;
                    if (installedThisRound.has(key)) continue;
                    const newEntry = await nexusModRequirements.downloadAndBuildAddedModEntry(prereqApiKey, NEXUS_GAME_DOMAIN, downloads, item);
                    installedThisRound.set(key, newEntry);
                    review.added.push(newEntry);
                    onProgress({ type: 'phase', message: `Also installing ${item.name} (a prerequisite of ${entry.addedModName})…` });
                }
                continue;
            }
            stillMissing.push(entry); // no choice supplied yet for this one -- the caller hasn't seen the gate yet, or genuinely hasn't decided
        }
        if (stillMissing.length > 0) {
            const err = new Error(`${stillMissing.length} new mod(s) have a missing prerequisite -- see missingPrerequisites for detail.`);
            err.code = 'MISSING_PREREQUISITES_FOUND';
            err.missingPrerequisites = stillMissing;
            throw err;
        }
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
    // mods are wrapped inline rather than changing that shared function's contract. allowAutoDownload
    // (2026-08-29) -- see detectFomodChoiceNeed's own header comment; without this, a brand-new Added
    // mod's own Open FOMOD sails straight past this gate undetected (no archive on disk yet to peek
    // inside) and only fails for real, deep inside extraction, later.
    const fomodGateAllowAutoDownload = !!appConfig.loadConfig().downloadMissingArchives;
    if (review.updated.length > 0) {
        onProgress({ type: 'phase', message: `Checking FOMOD install choices for ${review.updated.length} updated mod${review.updated.length === 1 ? '' : 's'}…` });
    }
    const updatedFomodNeeds = await detectFomodChoiceNeeds(review.updated, downloads, sevenZipExe, fomodGateAllowAutoDownload, onProgress);
    if (review.added.length > 0) {
        onProgress({ type: 'phase', message: `Checking FOMOD install choices for ${review.added.length} new mod${review.added.length === 1 ? '' : 's'}…` });
    }
    const addedFomodNeeds = await detectFomodChoiceNeeds(review.added.map((m) => ({ new: m })), downloads, sevenZipExe, fomodGateAllowAutoDownload, onProgress);
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
    return { review, collection, isOwnCollection, data, keptModIds, dependencyBreaks, resolvedFomodChoices, newCollectionJsonRaw };
}

// The Optional Mods Gate/Installs flow's own real Apply (2026-08-28, director's own build-out --
// TECHNICAL.md's Phase 1 write-up already flagged Optional Installs as deliberately deferred).
// Deliberately reuses runApply UNCHANGED rather than writing a second, parallel install pipeline --
// runApply already treats `prepared.review.added` completely generically (a plain list of raw
// collection.json mod entries to extract+register+configure for real, the exact machinery Phase 3's
// own Added-mod loop already proved), so the safest, lowest-risk way to install a director-picked
// set of optional mods is to hand it the SAME real, already-battle-tested code path with a
// synthetic review shaped `{ ...review, updated: [], removed: [], added: <picked optional mods> }`
// -- zero new real-write logic, zero chance of this new flow silently drifting from the proven one.
// updated/removed empty is exactly what a genuine no-updates-no-removals review already looks like
// (runApply's own `if (review.removed.length > 0)`/per-mod loops already no-op cleanly on empty
// arrays -- this isn't a special case runApply needs to know about).
async function prepareApplyOptional({ collectionModId, staging, downloads, state, optionalModKeys, fomodPicks, targetRevisionNumber, onProgress = () => {} }) {
    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperAvailable) {
        const err = new Error('The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to apply an update -- this real deploy/remove/metadata work only exists through it, unlike this tool\'s read-only routes, which can also fall back to state.v2.');
        err.code = 'HELPER_UNAVAILABLE';
        throw err;
    }

    // Same "fresh re-review right before writing anything, never trust a client-held list" principle
    // every other real write in this file follows -- review.optionalMods is reviewUpdate's own
    // already-live-filtered set (excludes anything already installed), so this can't re-offer
    // something a concurrent action already installed since the director last saw the gate screen.
    // liveModsData reused, same real redundancy fix as prepareApply above -- see that call site's own
    // header comment. onProgress threaded the same way too, same reasoning.
    const { review, liveModsData, newCollectionJsonRaw } = await reviewUpdateCore({ collectionModId, staging, state, targetRevisionNumber, downloads, onProgress });
    const wantedKeys = new Set((optionalModKeys || []).map(String));
    if (wantedKeys.size === 0) {
        const err = new Error('No optional mods were selected to install.');
        err.code = 'NO_OPTIONAL_MODS_SELECTED';
        throw err;
    }
    // modId:fileId, NOT bare modId -- see sourceModFileKey's own header comment. Without this, picking
    // just ONE of two optional file variants sharing a modId (e.g. HIMBO but not CBBE 3BA) would
    // silently install BOTH, since a bare-modId compare can't tell them apart.
    const added = review.optionalMods.filter((m) => wantedKeys.has(sourceModFileKey(m.source, m.name)));

    const collection = listCollections(staging).find((c) => c.modId === collectionModId);
    if (!collection) throw new Error(`Collection "${collectionModId}" isn't currently installed (or isn't a real, non-Workshop collection).`);
    onProgress({ type: 'phase', message: 'Checking if you curated this collection…' });
    const isOwnCollection = await checkIsOwnCollection(collection.author);
    const data = liveModsData || await timedGetAllMods('prepareApplyOptional-fallback');
    if (!data) throw new Error("Couldn't read Vortex's live mod list -- try again.");

    // Same real FOMOD-choice gate the main Added-mod path already gets -- an optional mod is still a
    // real archive that can need a real installer choice, same as any other fresh install.
    // allowAutoDownload (2026-08-29) -- see detectFomodChoiceNeed's own header comment; an optional
    // mod is ALWAYS a fresh install with no archive on disk yet, so without this, its own Open FOMOD
    // gate is unconditionally blind (live-confirmed, "Skyshards DLCs And SubWorlds").
    const fomodPicksSupplied = fomodPicks || {};
    const sevenZipExe = findSevenZip();
    const fomodGateAllowAutoDownload = !!appConfig.loadConfig().downloadMissingArchives;
    if (added.length > 0) {
        onProgress({ type: 'phase', message: `Checking FOMOD install choices for ${added.length} optional mod${added.length === 1 ? '' : 's'}…` });
    }
    const optionalFomodNeeds = await detectFomodChoiceNeeds(added.map((m) => ({ new: m })), downloads, sevenZipExe, fomodGateAllowAutoDownload, onProgress);
    const fomodChoiceNeeds = optionalFomodNeeds.map((n) => ({ ...n, modId: String(added[n.updatedIndex].source && added[n.updatedIndex].source.modId) }));
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
    const resolvedFomodChoices = new Map();
    for (const n of fomodChoiceNeeds) {
        if (Object.prototype.hasOwnProperty.call(fomodPicksSupplied, n.modId)) {
            resolvedFomodChoices.set(n.modId, buildFomodChoicesFromPicks(n.parsedFomod, fomodPicksSupplied[n.modId]));
        }
    }

    return {
        review: { ...review, updated: [], removed: [], added },
        collection, isOwnCollection, data,
        keptModIds: new Set(), dependencyBreaks: [], resolvedFomodChoices,
        newCollectionJsonRaw,
    };
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

// Fetches ONE specific revision's pristine collection.json content, verbatim -- the lean subset of
// reviewUpdateCoreUncached's own fetch sequence, skipping revision-listing/resolution entirely (the
// caller already knows exactly which revision it wants, from applyRetryCache) and skipping
// diffCollectionMods entirely too (confirmed elsewhere in this file to be the genuinely expensive
// part on a large collection -- irrelevant here, this is a pure fetch, never a review).
async function fetchPristineCollectionJson(collectionSlug, revisionNumber, collectionModId, downloads) {
    const sevenZipExe = findSevenZip();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-collection-v2-'));
    try {
        const newRevision = await nexusCollectionDownload.fetchAndExtractCollectionJson({
            slug: collectionSlug, revisionNumber, destDir: tmpDir, sevenZipExe, downloadsDir: downloads, collectionModId,
        });
        return fs.readFileSync(newRevision.collectionJsonPath, 'utf8');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// Post-deploy quick reconciliation (2026-09-01, director's own explicit design, after a real,
// live-reproduced "Mod not found" incident interrupted a genuine apply): rather than requiring a
// manual "Continue update" click -- a real, full re-apply -- for something that may already be
// completely fine after the director manually resolved a Vortex dialog and deployed, this checks
// ONLY the specific items THIS apply's own cached retry data (getApplyRetryData) says failed, and
// finalizes directly if they're now genuinely fixed. Director's own words: "before we attempt to do
// something again, we should check quickly if we really need to" -- Vortex is already known to be
// slow, so a full re-apply should be the FALLBACK, not the first move.
//
// Two possible outcomes:
//   - Everything that failed is now confirmed fixed (AND every other bucket the original apply
//     touched was already clean, per otherBucketsClean) -> finalize directly: replace
//     collection.json with the pristine revision and write a clean Tier 1 record -- the SAME
//     finalization runApply's own tail end does, just reached via a cheap live-state check instead
//     of a fresh full apply.
//   - Something genuinely still isn't right, or there's nothing cached to check against -> report
//     that plainly and change nothing. The existing "Continue update" button remains the correct
//     next step for a genuine re-apply; this function never attempts one itself.
//
// Scope note: only re-verifies Removed/Updated failures (the two buckets applyRetryCache has always
// cached, and the ones a real Vortex-side timeout can leave stale) -- Added-mod failures aren't
// cached here yet and always fall through to "not confirmed clean", same as before this existed.
// Removed-mod verification is "no longer live" only (not a separate staging re-check): Vortex's own
// real remove-mods event deletes staging as PART of removing the database record, so an absent live
// record already implies staging is gone too -- confirmed by reading that event's own real behavior,
// not assumed.
async function quickVerifyAndFinalize(collectionModId, staging, downloads) {
    const cached = getApplyRetryData(collectionModId);
    if (!cached) return { ok: false, reason: 'no-cached-data' };
    if (!cached.otherBucketsClean) return { ok: false, reason: 'other-buckets-not-clean' };

    const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperAvailable) return { ok: false, reason: 'helper-unavailable' };
    const data = await timedGetAllMods('quickVerifyAndFinalize');
    if (!data) return { ok: false, reason: 'live-read-failed' };
    const matcher = buildLiveIdentityIndex(data.mods);

    const failedRemovedNames = new Set((cached.removedResults || []).filter((r) => r.ok === false).map((r) => r.name));
    const stillBrokenRemoved = (cached.removed || [])
        .filter((m) => failedRemovedNames.has(m.name))
        .filter((m) => !!resolveLiveModId(matcher, m.source)); // still live -- genuinely not removed yet

    const stillBrokenUpdated = (cached.updated || [])
        .filter((u, i) => cached.updatedResults && cached.updatedResults[i] && cached.updatedResults[i].ok === false)
        .filter((u) => !resolveLiveModId(matcher, u.new.source)); // not live under the new identity -- genuinely not updated yet

    if (stillBrokenRemoved.length > 0 || stillBrokenUpdated.length > 0) {
        return {
            ok: false, reason: 'still-broken',
            stillBrokenNames: [...stillBrokenRemoved.map((m) => m.name), ...stillBrokenUpdated.map((u) => u.new.name)],
        };
    }

    // Everything that failed is now confirmed genuinely fixed -- finalize exactly like a clean
    // runApply would, just without redoing the real work.
    const collection = listCollections(staging).find((c) => c.modId === collectionModId);
    if (!collection) return { ok: false, reason: 'collection-not-found' };
    // Helper already confirmed reachable just above -- go straight to it, no state.v2 fallback
    // needed here (unlike reviewUpdateCoreUncached, which can run with Vortex closed).
    const nexusInfo = await resolveNexusInfoViaHelper([collectionModId]);
    const info = (nexusInfo && nexusInfo[collectionModId]) || {};
    if (!info.collectionSlug) return { ok: false, reason: 'no-collection-slug' };

    let newCollectionJsonRaw;
    try {
        newCollectionJsonRaw = await fetchPristineCollectionJson(info.collectionSlug, cached.newRevisionNumber, collectionModId, downloads);
    } catch (e) {
        console.error(`[update-collection-v2-runner] quickVerifyAndFinalize couldn't fetch the pristine revision: ${e.message}`);
        return { ok: false, reason: 'fetch-failed' };
    }

    try {
        const collectionJsonPath = collection.collectionJsonPath;
        const currentRaw = fs.readFileSync(collectionJsonPath, 'utf8');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(getUcv2TrackingDir(collectionModId), `pre-update-${stamp}.json`), currentRaw);
        fs.writeFileSync(collectionJsonPath, newCollectionJsonRaw);
    } catch (e) {
        console.error(`[update-collection-v2-runner] quickVerifyAndFinalize couldn't replace local collection.json: ${e.message}`);
        return { ok: false, reason: 'write-failed' };
    }
    try {
        const statusPath = path.join(getUcv2TrackingDir(collectionModId), 'ucv2-apply-status.json');
        fs.writeFileSync(statusPath, JSON.stringify({
            revisionApplied: cached.newRevisionNumber, cleanApply: true, appliedAt: new Date().toISOString(),
        }, null, 2));
    } catch (e) {
        console.error(`[update-collection-v2-runner] quickVerifyAndFinalize couldn't write the apply-status record: ${e.message}`);
        return { ok: false, reason: 'status-write-failed' };
    }
    return { ok: true };
}

// The new revision's own author-written collection rules, applied against a FRESH live mod read --
// shared by runApply's own real first-time run and retryModRules below. See runApply's own call
// site (further down) for why a fresh read (not the pre-apply one) is required, and why it's
// wrapped in withHelperRetry.
async function applyModRulesFresh(modRules) {
    // withHelperRetry (2026-08-23), widened to END_OF_APPLY_RETRY_OPTIONS (2026-08-27) -- this was
    // a single, un-retried call, unlike most other Helper reads in this file. Real gap: Vortex's own
    // renderer can genuinely still be busy finishing per-mod deploy work from the Updated/Added
    // loops just above when this fires (or, for a retry, from whatever the director was just doing
    // in Vortex), and a real ~46MB /mods payload competing with that can plausibly miss
    // MODS_TIMEOUT_MS (5s) -- confirmed live, director's own report ("Couldn't re-read Vortex's live
    // mod list..."), TWICE now: the original standard-budget gap, and again under the standard
    // budget even after that fix, this time a real ~10-minute block. See END_OF_APPLY_RETRY_OPTIONS'
    // own header comment for the full reasoning on the widened budget.
    const freshData = await withHelperRetry(() => timedGetAllMods('applyModRulesFresh'), END_OF_APPLY_RETRY_OPTIONS);
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
        // Widened to END_OF_APPLY_RETRY_OPTIONS (2026-08-27, real live gap found the SAME session
        // this function's own original bug -- "Vortex didn't confirm every membership-rule removal"
        // -- was fixed) -- this call was still a bare, completely un-retried read, the exact
        // opposite of the "give end-of-apply reads real breathing room" fix applied everywhere else
        // in this file. This runs AFTER the Added loop's own heavy real work, structurally the same
        // "Vortex might still be catching up" race as applyModRulesFresh/applyCollectionModRules.
        const liveRules = await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId), END_OF_APPLY_RETRY_OPTIONS);
        if (!liveRules) return { ok: false, count: 0, error: "Couldn't read the collection's own live rules." };

        // Resolve which removed mods actually still have a real stale rule to strip -- pure, no I/O.
        // Matches EITHER membership rule type (2026-09-01, director-caught real bug, live-confirmed):
        // buildCollectionMembershipRule writes 'requires' for a required member but 'recommends' for
        // an OPTIONAL one (mod.optional ? 'recommends' : 'requires') -- this was hardcoded to
        // 'requires' only, so a removed OPTIONAL mod's stale rule was never found here and never
        // stripped, leaving a permanent phantom "recommends" entry pointing at a mod no longer
        // installed. Content identity (removedMatcher) already pins the specific file precisely, so
        // widening the type check can't cause a false match against some other mod's rule.
        const toStrip = [];
        for (const r of eligibleForCleanup) {
            const source = removedSourceByNameForRules.get(r.name);
            if (!source) continue;
            const removedMatcher = syncLib.makeIdentityMatcher([source]);
            const rule = liveRules.find((rl) => (rl.type === 'requires' || rl.type === 'recommends') && removedMatcher(syncLib.ruleReferenceIdentity(rl)));
            if (!rule) continue; // no stale rule found on the collection -- nothing to strip
            toStrip.push({ source, rule });
        }
        // Logged (2026-09-01) -- this exact "found nothing to strip" path is what silently hid
        // today's real Bittercup bug for weeks: a stale rule of the WRONG type never showed up here
        // as an error, it just quietly never got stripped. Naming every mod checked (not just the
        // ones with something to strip) means a future recurrence is visible on inspection instead
        // of requiring a live API forensic session to rediscover.
        console.log(`[update-collection-v2-runner] cleanupRemovedMembershipRules: ${eligibleForCleanup.length} removed mod(s) checked, ${toStrip.length} had a stale membership rule to strip.`
            + (toStrip.length > 0 ? ` Stripping: ${toStrip.map((t) => `${t.source.modId}/${t.source.fileId} (${t.rule.type})`).join(', ')}` : ''));
        if (toStrip.length === 0) return { ok: true, count: 0, error: null };

        // Batched (2026-08-28, director-caught real gap, live-confirmed on a 39-removed-mod apply):
        // this used to be one applyRuleChange HTTP round trip PER removed mod, each with its own full
        // END_OF_APPLY_RETRY_OPTIONS budget (up to 8 attempts x 15s = ~2.5 minutes worst case) -- a
        // busy/slow Vortex compounds that to well over half an hour across a real 39-mod removal, even
        // with the 2-consecutive-failure circuit breaker below never tripping (each individual call
        // was eventually succeeding, just slowly, so consecutiveFailures kept resetting to 0). Matches
        // the SAME excess-round-trip fix the Added-mod registration loop already got on 2026-08-27
        // (applyRuleChangesBatch) -- vortex-collection-helper's own version dispatches every rule
        // removal in one Redux pass per HTTP request, real Vortex source (collections/index.ts,
        // collectionCreate.ts, InstallDriver.ts) never does this one-call-per-mod either. The old
        // per-mod circuit breaker is gone -- there's only one call left to retry now, not 39.
        const items = toStrip.map(({ rule }) => ({ modId: collectionModId, remove: rule }));
        const results = await withHelperRetry(() => helperClient.applyRuleChangesBatch(items), END_OF_APPLY_RETRY_OPTIONS);
        if (Array.isArray(results) && results.length === items.length && results.every((x) => x.ok === true)) {
            return { ok: true, count: toStrip.length, error: null };
        }

        // The batch call itself didn't confirm -- same verify-after-retry fallback every other real
        // write in this file already uses (Vortex's own dispatch runs synchronously and can complete
        // before the HTTP response makes it back, so a lost response doesn't necessarily mean a lost
        // write). ONE fresh rules read here, checked against every mod locally -- a per-mod re-fetch
        // would reintroduce the exact excess-round-trip problem this rewrite exists to fix.
        const freshRules = await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId), END_OF_APPLY_RETRY_OPTIONS);
        if (!freshRules) {
            return { ok: false, count: 0, error: "Vortex didn't confirm every membership-rule removal -- the collection may still list a removed mod as a member." };
        }
        let count = 0;
        let allOk = true;
        for (const { source } of toStrip) {
            const stillPresent = freshRules.some((rl) => rl.reference && rl.reference.repo
                && String(rl.reference.repo.modId) === String(source.modId)
                && String(rl.reference.repo.fileId) === String(source.fileId));
            if (!stillPresent) count += 1; else allOk = false;
        }
        return {
            ok: allOk, count,
            error: allOk ? null : "Vortex didn't confirm every membership-rule removal -- the collection may still list a removed mod as a member.",
        };
    } catch (e) {
        return { ok: false, count: 0, error: e.message };
    }
}

// Refreshes the COLLECTION mod's own membership rule for every Updated mod that actually succeeded
// this apply (2026-08-28, real live-confirmed gap) -- the Added-mod loop already keeps a member's
// rule in sync at install time (buildCollectionMembershipRule, applied via applyRuleChangesBatch);
// the Updated loop never did the equivalent. Real consequence, confirmed live: Update Collection
// v2's own Updated loop correctly re-extracts a mod's files and refreshes its OWN attributes
// (fileMD5/version/etc via setModAttributes), but the COLLECTION's `requires` rule for that mod is a
// SEPARATE piece of state pinned to the OLD revision's fileMD5/tag/version -- and Vortex's own
// Collections page ("Mods" tab, Download pending/Install) resolves membership by matching a rule's
// CONTENT identity (installSession/itemRows.ts's persistentRow: tag -> fileMD5 -> findModByRef),
// never the live mod's current attributes directly. Left stale, an Updated mod that genuinely
// succeeded still shows "Download pending" there forever (confirmed live 2026-08-28: MP_Melony.7z, a
// bundle mod, and Pandora XPMSE Behavior Patch, a Nexus mod -- both re-extracted and enabled
// correctly, both still "Download pending" on that page afterward). Note this is independent of the
// MAIN Mods table's own "Collection" column, which matches by the rule's raw `reference.id` instead
// (generateCollectionMap) -- that stays correct regardless, since `id` doesn't depend on content and
// this apply never touches it, which is why that column alone can't be trusted to catch this gap.
//
// Same batched remove+add shape cleanupRemovedMembershipRules above already established (one
// applyRuleChangesBatch call for the whole set, not one applyRuleChange per mod) -- a single item can
// carry BOTH remove and add (vortex-collection-helper's own /rules/apply(-batch) dispatches whichever
// of the two are present on that item), so this replaces each Updated mod's stale rule in one
// dispatch per mod, still one HTTP round trip for the whole batch.
async function refreshUpdatedMembershipRules(collectionModId, updated, updatedResults, effectiveNewByOld) {
    const eligible = [];
    for (let i = 0; i < updated.length; i += 1) {
        if (updatedResults[i] && updatedResults[i].ok === true) eligible.push(updated[i]);
    }
    if (eligible.length === 0) return { ok: true, count: 0, error: null };
    try {
        const liveRules = await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId), END_OF_APPLY_RETRY_OPTIONS);
        if (!liveRules) return { ok: false, count: 0, error: "Couldn't read the collection's own live rules." };

        // Resolve pure, no I/O -- old rule to remove (matched against the PRE-update identity, same
        // makeIdentityMatcher/ruleReferenceIdentity pairing cleanupRemovedMembershipRules already
        // uses) plus the fresh rule to add (built from whatever this apply actually extracted --
        // effectiveNewByOld so a FOMOD-resolved fresh pick is what gets recorded, same convention the
        // Updated loop's own collection.json merge already follows).
        // Matches EITHER membership rule type (2026-09-01, director-caught real bug, live-confirmed
        // live: a real optional mod -- "Anniversary Edition Upgrade - Bittercup - Tweaks and
        // Enhancements" -- updated from 1.5 to 1.5.1, but this lookup was hardcoded to 'requires'
        // only, so the OLD 'recommends' rule (buildCollectionMembershipRule writes 'recommends' for
        // any mod.optional member) was never found/removed here. Vortex's own Collections page then
        // considered BOTH the old and new file legitimate members, and both stayed installed and
        // enabled side by side -- the real duplicate-install root cause, not a Vortex quirk. Content
        // identity (oldMatcher) already pins the specific old file precisely, so widening the type
        // check can't cause a false match against some other mod's rule.
        const items = eligible.map((u) => {
            const oldMatcher = syncLib.makeIdentityMatcher([u.old.source]);
            const oldRule = liveRules.find((rl) => (rl.type === 'requires' || rl.type === 'recommends') && oldMatcher(syncLib.ruleReferenceIdentity(rl)));
            const effectiveNewMod = effectiveNewByOld.get(u.old) || u.new;
            const newRule = buildCollectionMembershipRule(effectiveNewMod, effectiveNewMod);
            return { modId: collectionModId, ...(oldRule ? { remove: oldRule } : {}), add: newRule };
        });
        // Logged (2026-09-01) -- names any item with NO oldRule found (add-only, nothing removed):
        // that's exactly the silent shape today's real Bittercup bug took before the fix above --
        // the new rule got added correctly every time, only the OLD one's removal quietly never
        // happened. Visible here now instead of requiring a live rules diff to notice.
        const addOnly = items.filter((it) => !it.remove);
        console.log(`[update-collection-v2-runner] refreshUpdatedMembershipRules: ${items.length} updated mod(s) refreshed, ${addOnly.length} had no old rule found to remove (add-only).`
            + (addOnly.length > 0 ? ` Add-only: ${addOnly.map((it) => `${it.add.reference.repo?.modId}/${it.add.reference.repo?.fileId} (${it.add.type})`).join(', ')}` : ''));
        const results = await withHelperRetry(() => helperClient.applyRuleChangesBatch(items), END_OF_APPLY_RETRY_OPTIONS);
        if (Array.isArray(results) && results.length === items.length && results.every((x) => x.ok === true)) {
            return { ok: true, count: items.length, error: null };
        }

        // Same verify-after-retry fallback every other real write in this file uses -- a lost response
        // doesn't necessarily mean a lost write (Vortex's own dispatch runs synchronously). One fresh
        // rules read, checked locally against every mod, not a per-mod re-fetch.
        const freshRules = await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId), END_OF_APPLY_RETRY_OPTIONS);
        if (!freshRules) {
            return { ok: false, count: 0, error: "Vortex didn't confirm the collection's own membership rules were refreshed -- some updated mods may still show as needing install there." };
        }
        let count = 0;
        let allOk = true;
        for (const { add } of items) {
            const newMatcher = syncLib.makeIdentityMatcher([{ md5: add.reference.fileMD5, tag: add.reference.tag, modId: add.reference.repo?.modId, fileId: add.reference.repo?.fileId }]);
            // Checks against add.type itself (2026-09-01, same real bug as above) rather than a
            // hardcoded 'requires' -- an optional mod's own newly-written rule is 'recommends', so the
            // old hardcoded check would report "not confirmed" here even when the write genuinely
            // succeeded, a false-negative error on top of the missed cleanup above.
            const nowPresent = freshRules.some((rl) => rl.type === add.type && newMatcher(syncLib.ruleReferenceIdentity(rl)));
            if (nowPresent) count += 1; else allOk = false;
        }
        return {
            ok: allOk, count,
            error: allOk ? null : "Vortex didn't confirm the collection's own membership rules were refreshed -- some updated mods may still show as needing install there.",
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
        // Widened to END_OF_APPLY_RETRY_OPTIONS + verify-after-retry fallback (2026-08-28) -- same
        // real gap as cleanupRemovedMembershipRules' own write just above: this runs in the exact
        // same "Vortex might still be genuinely busy" window (confirmed live -- a 28s+ unresponsive
        // /health check during this same apply's finalize stage), but was left on the short default
        // budget with no fallback. Live-confirmed false negative, director's own words: "it shows the
        // collection installed and enabled... Vortex did it's thing slowly but we show errors."
        let ok = await withHelperRetry(() => helperClient.setModAttributes(collectionModId, {
            revisionNumber: newRevisionNumber,
            version: newRevisionStr,
            newestVersion: newRevisionStr,
            ...(newRevisionId != null ? { revisionId: newRevisionId } : {}),
        }), END_OF_APPLY_RETRY_OPTIONS);
        if (!ok) {
            const data = await withHelperRetry(() => timedGetAllMods('updateCollectionAttributes-fallback'));
            const liveAttrs = data && data.mods[collectionModId] && data.mods[collectionModId].attributes;
            ok = !!liveAttrs && String(liveAttrs.revisionNumber) === newRevisionStr;
        }
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

// Retry #5 (2026-08-28): re-runs the Updated-mods membership-rule refresh (refreshUpdatedMembershipRules'
// own header comment has the full real reasoning) against the ORIGINAL apply's own updated/
// updatedResults/effectiveNewByOld -- same "cached, not re-reviewed" reasoning retryMembershipCleanup
// above already documents (a fresh review's own `updated` bucket can miss a mod whose extraction
// already succeeded this apply, if something else about it changed since).
async function retryUpdatedMembershipRefresh({ collectionModId }) {
    const cached = getApplyRetryData(collectionModId);
    if (!cached) throw retryDataExpiredError();
    return refreshUpdatedMembershipRules(collectionModId, cached.updated, cached.updatedResults, cached.effectiveNewByOld);
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
    // liveModsData reused, same real redundancy fix as prepareApply -- see that call site's own
    // header comment (lib/update-collection-v2-runner.js, prepareApply).
    const { review, liveModsData } = await reviewUpdateCore({ collectionModId, staging, state, downloads });
    // This retry is about to write for real -- see runApply's own identical invalidation for why.
    invalidateReviewCache(collectionModId);
    const collection = listCollections(staging).find((c) => c.modId === collectionModId);
    if (!collection) throw new Error(`Collection "${collectionModId}" isn't currently installed (or isn't a real, non-Workshop collection).`);
    const data = liveModsData || await timedGetAllMods('retryModExtraction-fallback');
    if (!data) throw new Error("Couldn't read Vortex's live mod list -- try again.");
    const matcher = buildLiveIdentityIndex(data.mods);
    const sevenZipExe = findSevenZip();

    // modId here is whatever the failed row's own SSE frame carried -- sourceModFileKey's modId:fileId
    // shape for a mod resolved through this apply's own Updated/Added loops. Matched the same way, not
    // via a bare modId compare, or a mod belonging to one of this collection's real modId-collision
    // groups (e.g. HIMBO/CBBE 3BA file-variant pairs) would resolve to the WRONG mod here.
    const u = review.updated.find((x) => sourceModFileKey(x.old.source, x.new.name) === String(modId));
    const m = !u ? review.added.find((x) => sourceModFileKey(x.source, x.name) === String(modId)) : null;

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
        const fomodNeed = await detectFomodChoiceNeed(u.new, downloads, sevenZipExe, true);
        if (fomodNeed) {
            return { ok: false, name: u.new.name, error: "This mod's installer needs a real FOMOD choice that isn't recorded -- run Apply Update again to make that choice, then retry." };
        }
        const rebuildResult = await rebuildSingleMod({
            vortexModId, gameId: syncLib.GAME_ID, downloadsDir: downloads, stagingDir: staging,
            mod: u.new, allowAutoDownload: true, resolveMode: 'all', collectionModId,
        });
        if (rebuildResult.status !== 'REBUILT') {
            return { ok: false, name: u.new.name, error: describeApplyFailure(rebuildResult), status: rebuildResult.status || rebuildResult.kind };
        }
        const archiveMatch = await resolveOrRegisterArchiveId(u.new, downloads);
        const attrsOk = await helperClient.setModAttributes(vortexModId, {
            // Prefer the real download's own fileVersion over collection.json's recorded version --
            // see resolveDownloadIdForArchive's own header comment for the full real mismatch this
            // avoids.
            version: (archiveMatch && archiveMatch.fileVersion) || u.new.version, modName: u.new.name,
            fileMD5: u.new.source && u.new.source.md5, modId: u.new.source && u.new.source.modId,
            fileId: u.new.source && u.new.source.fileId, fileSize: u.new.source && u.new.source.fileSize,
            logicalFileName: u.new.source && u.new.source.logicalFilename,
            referenceTag: u.new.source && u.new.source.tag,
            ...(archiveMatch ? { archiveId: archiveMatch.archiveId } : {}),
            // Bundle-type mod tags (2026-08-26, Missing Masters bundle-support fix) -- these are this
            // app's own custom Vortex attributes, not native ones (Vortex's own per-mod attributes
            // are a free-form bag, confirmed via source, same pattern as enableallplugins below).
            // Recorded so a LATER single-mod repair with no collection.json in scope (Missing
            // Masters' own general scan) can recognize this mod came from a bundle and resolve its
            // parent collection package -- see build-mod-from-vortex-state.js's shapeMod() and
            // rebuild-single-mod.js's own collectionModId fallback for the read-back side.
            ...(u.new.source && u.new.source.type === 'bundle'
                ? { bundleFileExpression: u.new.source.fileExpression, bundleCollectionModId: collectionModId }
                : {}),
        });
        const deployOk = await helperClient.deployMod(vortexModId, true);
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
    const fomodNeed = await detectFomodChoiceNeed(m, downloads, sevenZipExe, true);
    if (fomodNeed) {
        return { ok: false, name: m.name, error: "This mod's installer needs a real FOMOD choice that isn't recorded -- run Apply Update again to make that choice, then retry." };
    }
    const rebuildResult = await rebuildSingleMod({
        vortexModId: null, gameId: syncLib.GAME_ID, downloadsDir: downloads, stagingDir: staging,
        mod: m, allowAutoDownload: true, resolveMode: 'all', collectionModId,
    });
    if (rebuildResult.status !== 'REBUILT') {
        return { ok: false, name: m.name, error: describeApplyFailure(rebuildResult), status: rebuildResult.status || rebuildResult.kind };
    }
    const newVortexModId = rebuildResult.targetFolderName;
    // Resolved BEFORE createMod, not after (2026-08-28, real root-cause fix) -- archiveId is a
    // TOP-LEVEL field on Vortex's own real IMod shape (confirmed via IMod.ts: `archiveId?: string`,
    // a sibling of `attributes`, NOT nested inside it), and setModAttributes can only ever merge
    // into `attributes` -- it has no way to reach a top-level field at all. Resolving it after
    // creation and "applying" it via setModAttributes (the old code here) silently did nothing:
    // the value landed in attributes.archiveId, a field Vortex's own Version-column grouping never
    // reads, while the real mod.archiveId stayed permanently unset. See resolveOrRegisterArchiveId's
    // own header comment for the missing-archiveId consequence this produces.
    const archiveMatch = await resolveOrRegisterArchiveId(m, downloads);
    const vortexMod = {
        id: newVortexModId, state: 'installed', type: '', installationPath: newVortexModId,
        ...(archiveMatch ? { archiveId: archiveMatch.archiveId } : {}),
        // See the main Added-mod loop's own attributes object (further below in this file) for the
        // full real reasoning -- same fix, same shape, mirrored here for this single-mod retry path.
        attributes: {
            name: m.name, installTime: new Date().toISOString(),
            ...(m.choices && m.choices.type === 'fomod' ? { installerChoices: m.choices } : {}),
        },
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
    const attrsOk = await withHelperRetry(() => helperClient.setModAttributes(newVortexModId, {
        // Prefer the real download's own fileVersion over collection.json's recorded version --
        // see resolveDownloadIdForArchive's own header comment.
        version: (archiveMatch && archiveMatch.fileVersion) || m.version, modName: m.name,
        fileMD5: m.source && m.source.md5, modId: m.source && m.source.modId,
        fileId: m.source && m.source.fileId, fileSize: m.source && m.source.fileSize,
        logicalFileName: m.source && m.source.logicalFilename,
        referenceTag: m.source && m.source.tag,
        ...(m.source && m.source.type === 'nexus' ? { source: 'nexus' } : {}),
        // Bundle-type mod tags (2026-08-26 fix) -- see the Updated-loop retry's own comment above
        // for the full reasoning; same custom-attribute pattern.
        ...(m.source && m.source.type === 'bundle'
            ? { bundleFileExpression: m.source.fileExpression, bundleCollectionModId: collectionModId }
            : {}),
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
// Real, live-confirmed incident (2026-08-30): the SAME Vortex crash this whole reconciliation pass
// exists to recover from can leave a genuine CYCLE in the live mod rules graph (a rule an earlier,
// interrupted write only half-applied). Retrying a real write (removeMods, applyRuleChange) against
// Vortex while a cycle is present is worse than just leaving the original failure standing --
// director's own catch, live: Vortex's own mods-changed listener re-runs its full conflict/rules
// check on ANY mod list change (add or remove alike, confirmed via Vortex's own log), and with a
// cycle present that check thrashes (repeated "Mod rules contain cycles" warnings, memory climbing
// ~600MB -> 1.5GB in under 20 seconds in the real incident) and can crash Vortex a second time. Reuses
// this project's own already-proven cycle detection wholesale -- rules-generator.js's own
// buildModIndexFromLiveData (the exact live-data adapter Cycle Helper's own worker already
// established) feeds cycle-detector.js's buildGraph/topsort (topsort returns null iff a cycle exists
// anywhere in the graph) -- no new detection logic, just wiring two already-tested pieces together.
function checkForRuleCycles(liveModsData) {
    if (!liveModsData) return false; // can't tell -- don't block the retry on an unknown, same as every other "helper read failed" fallback in this file
    const modIndex = rulesGen.buildModIndexFromLiveData(liveModsData.mods, liveModsData.enabledModKeys);
    const { nodes, edges } = cycleDetector.buildGraph(modIndex, liveModsData.enabledModKeys);
    return cycleDetector.topsort(nodes, edges) === null;
}

// Plain, un-themed fallback text (director's own exact wording) -- server-side code has no access to
// the browser's active theme, so this is what shows if the frontend's own 'cycle-detected' code check
// (ucv2RenderApplyResult, update-collection-v2-app.js) ever doesn't fire for some reason. The
// frontend's real rendering swaps "Cycle Helper" for the theme's own name via window.themedToolName
// ('cycle-helper', 'Cycle Helper') -- same "ThemedName (Cycle Helper)" display convention this
// project already establishes for cross-tool references (see app.js's own VIEW_SUFFIXES comment).
const CYCLE_RETRY_BLOCKED_MESSAGE = 'A collection update failure caused rule cycles to form. Before '
    + 'retrying the update, resolve the cycles using Cycle Helper or within Vortex. Once all cycles '
    + 'are resolved, try applying the update again.';
const CYCLE_RETRY_BLOCKED_CODE = 'cycle-detected';

// Deliberately DIFFERENT wording from CYCLE_RETRY_BLOCKED_MESSAGE above, not a straight reuse
// (2026-08-31, diagnostics/2026-08-30-real-apply-marathon-findings.md finding #1 -- flagged here as
// the judgment call this build task's own prompt asked to surface, not decided silently). That
// message's own "retrying the update"/"applying the update again" advice is correct for ITS context
// (a removal/dependency-ack that itself failed) but would be actively WRONG here: by the time Deploy
// is even reachable, the collection update itself already succeeded in full (every mod removed/
// updated/added, every optional mod installed, every rule applied) -- only the deploy step is
// blocked. Telling the director to re-run "the update" would send them back through real, already-
// completed work for no reason; the actual fix is narrower (resolve the cycle, then just deploy
// again) -- exactly the director's own scoping call this same diagnostics finding already quotes:
// "tell user to fix in our tool and vortex and redeploy either in our cycle helper tool or vortex -
// not update collection." Same "using Cycle Helper" substring preserved on purpose, so the identical
// themed-name substitution (ucv2ThemedCycleMessage, update-collection-v2-app.js) works unchanged.
// Wording deliberately does NOT offer "deploy again from here" any more (2026-09-01, director's own
// explicit correction, live-caught: a real cycle came right back on a Retry Deploy click even though
// that path never re-touches rules at all -- proving this isn't something OUR tool's own retry can
// fix by trying again, so the retry option is removed entirely for this specific error, both here
// and in ucv2ShowDeployResult's own noRetry handling). The real fix has to happen in Vortex itself.
const DEPLOY_BLOCKED_BY_CYCLES_MESSAGE = "Update finished, but deployment failed. Vortex couldn't "
    + 'deploy your mods because a rule cycle was detected. Resolve the cycle using Cycle Helper or '
    + 'within Vortex, then deploy directly from Vortex.';
const DEPLOY_BLOCKED_BY_CYCLES_CODE = 'deploy-blocked-by-cycles';

// Final-pass retry for whatever the Remove step's own already-generous verify-retry (above, in
// runApply) still couldn't confirm -- see runApply's own call-site comment for the full real
// incident this fixes. Re-derives live state completely fresh rather than trusting removedResults'
// own (now possibly stale) verdict -- a mod the EARLIER attempt actually did remove, just lost the
// response for, must read as already-gone here, not get resubmitted for removal a second time.
// Mutates `removedResults` in place (flips ok:false entries to true on success) and emits matching
// mod-complete frames so the live Apply Progress table (if still open) reflects the real outcome.
async function retryStillFailedRemovals(review, keepRemovedModIdSet, removedRowKey, removedResults, onProgress) {
    const failedByKey = new Map(removedResults.filter((r) => r.ok === false && r.modKey).map((r) => [r.modKey, r]));
    if (failedByKey.size === 0) return;
    const helperBackUp = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperBackUp) return; // still down -- nothing more to do here, the existing message stands
    const freshData = await timedGetAllMods('runApply-finalRemovalRetry');
    if (!freshData) return;
    if (checkForRuleCycles(freshData)) {
        failedByKey.forEach((r) => { r.error = CYCLE_RETRY_BLOCKED_MESSAGE; r.code = CYCLE_RETRY_BLOCKED_CODE; });
        onProgress({ type: 'phase', message: "Vortex's mod rules contain a cycle -- skipping the removal retry until it's resolved…" });
        return;
    }
    onProgress({ type: 'phase', message: `Vortex is back — retrying ${failedByKey.size} mod${failedByKey.size === 1 ? '' : 's'} that couldn't be removed…` });
    const freshMatcher = buildLiveIdentityIndex(freshData.mods);
    const candidates = review.removed
        .filter((m) => !keepRemovedModIdSet.has(removedRowKey(m)) && failedByKey.has(removedRowKey(m)))
        .map((m) => ({ m, result: failedByKey.get(removedRowKey(m)), vortexModId: resolveLiveModId(freshMatcher, m.source) }));
    // Already gone -- this apply's own earlier attempt genuinely succeeded, only the response was
    // lost (the exact real risk documented above, at the original removeMods call site).
    candidates.filter((c) => !c.vortexModId).forEach((c) => {
        c.result.ok = true; c.result.error = undefined; c.result.action = 'removed';
        onProgress({ type: 'mod-complete', modId: c.result.modKey, name: c.result.name, ok: true, action: 'removed', kind: 'remove' });
    });
    const stillLive = candidates.filter((c) => c.vortexModId);
    if (stillLive.length === 0) return;
    let removeOk = false;
    try {
        removeOk = await helperClient.removeMods(stillLive.map((c) => c.vortexModId));
    } catch { /* removeOk stays false -- verify below decides the real outcome either way */ }
    // Same verify-after-retry shape as the original attempt -- a lost response here must not read as
    // a real failure any more than it did the first time.
    const verifyData = removeOk ? null : await timedGetAllMods('runApply-finalRemovalRetryVerify');
    stillLive.forEach((c) => {
        const stillPresent = removeOk ? false : !!(verifyData && verifyData.mods[c.vortexModId]);
        if (stillPresent) return; // genuinely still there -- leave the original failure result standing
        c.result.ok = true; c.result.error = undefined; c.result.action = 'removed';
        onProgress({ type: 'mod-complete', modId: c.result.modKey, name: c.result.name, ok: true, action: 'removed', kind: 'remove' });
    });
}

// Same final-pass retry, for the dependency-break "Ignore" acknowledgment writes (applyRuleChange
// with ignored:true) -- see this file's own dependencyBreakResults construction, further up in
// runApply, for what this write actually does and why it can fail during exactly this same crash
// window. Matched back to its own `b` by the identical name string dependencyBreakResults itself was
// built from (dependencyBreakResults is not guaranteed the same length/order as dependencyBreaks --
// a break whose target update didn't succeed is skipped entirely there -- so index correlation isn't
// safe; the name string is the one thing both sides already agree on).
async function retryStillFailedDependencyAcknowledgements(dependencyBreaks, updatedResults, dependencyBreakResults, onProgress) {
    const failedByName = new Map(dependencyBreakResults.filter((r) => r.ok === false).map((r) => [r.name, r]));
    if (failedByName.size === 0) return;
    const helperBackUp = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
    if (!helperBackUp) return;
    // Same cycle guard as retryStillFailedRemovals above -- see that function's own header comment
    // for the full real incident. applyRuleChange is a real write too; the same crash risk applies.
    const freshData = await timedGetAllMods('runApply-finalDependencyAckRetry');
    if (checkForRuleCycles(freshData)) {
        failedByName.forEach((r) => { r.error = CYCLE_RETRY_BLOCKED_MESSAGE; r.code = CYCLE_RETRY_BLOCKED_CODE; });
        onProgress({ type: 'phase', message: "Vortex's mod rules contain a cycle -- skipping the dependency-acknowledgement retry until it's resolved…" });
        return;
    }
    onProgress({ type: 'phase', message: `Vortex is back — retrying ${failedByName.size} dependency acknowledgement${failedByName.size === 1 ? '' : 's'}…` });
    for (const b of dependencyBreaks) {
        if (updatedResults[b.updatedIndex]?.ok !== true) continue;
        const name = `${b.dependentName} -> ${b.updatedModName}`;
        const result = failedByName.get(name);
        if (!result) continue;
        try {
            const ok = await helperClient.applyRuleChange(b.dependentVortexModId, b.rule, { ...b.rule, ignored: true });
            if (ok) { result.ok = true; result.error = undefined; result.action = 'dependency-rule-ignored'; }
        } catch { /* leave the original failure result standing */ }
    }
}

// Hoisted to module scope (2026-09-01) from a nested closure inside runApply so
// remove-collection-runner.js's own applyRemoval can reuse the exact same check -- no behavior change,
// pure extraction. Confirmed real gap (2026-08-28): a plain fs.existsSync(folderPath) is true for a
// folder that exists but has been emptied out (or was only ever a shell of subdirectories), which is
// exactly the "already deleted on disk" case Vortex's own real "Mod not found" dialog exists to catch.
// A real live apply hit this: the staging FOLDER for a just-added mod still existed, existsSync said
// true, so the remove routed through the real event path, and Vortex's own undeploy still threw ENOENT
// because the actual FILES inside were gone -- popping the exact blocking dialog this whole check
// exists to avoid. Walks the tree looking for at least one real file (not just an empty directory)
// rather than trusting the folder's own existence.
function stagingHasRealFiles(dirPath) {
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return false;
    }
    for (const entry of entries) {
        if (entry.isFile()) return true;
        if (entry.isDirectory() && stagingHasRealFiles(path.join(dirPath, entry.name))) return true;
    }
    return false;
}

async function runApply({ prepared, collectionModId, staging, downloads, syncBackupRoot, keepRemovedModIds, ignoreDependencyBreaks, deleteArchives, onProgress = () => {} }) {
    const { review, collection, isOwnCollection, data, keptModIds, dependencyBreaks, resolvedFomodChoices, newCollectionJsonRaw } = prepared;

    // Apply-start boundary marker (2026-09-01, director's own request after today's real bugs took
    // real forensic effort to trace from live API snapshots alone -- see the archiveId logging just
    // above for the concrete incident this responds to). One clear line per apply, naming the
    // collection/revision and every bucket's size, so any other log line from this same run can be
    // correlated to "which apply, which collection" without cross-referencing timestamps against
    // screenshots. collectionModId doubles as this apply's own correlation id for every log line
    // below that also names it.
    console.log(`[update-collection-v2-runner] APPLY START collectionModId="${collectionModId}" name="${review.collectionName}" rev ${review.installedRevision ?? '?'} -> ${review.newRevisionNumber ?? '?'} `
        + `updated=${review.updated.length} added=${review.added.length} removed=${review.removed.length} keepInstalled=${(keptModIds || []).length} deleteArchives=${!!deleteArchives}`);
    const t_applyStart = Date.now();

    // The review this apply is built on is about to become stale the moment real writes start below
    // -- see reviewUpdateCore's own cache header comment. Invalidated here, not at prepareApply's own
    // read, so a retry (dependency-break/FOMOD gate resolved, apply re-called) still gets the cheap
    // cache hit right up until an actual write genuinely begins.
    invalidateReviewCache(collectionModId);

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
        const err = new Error(`Cannot proceed without a safety backup. ${backupError || ''}`.trim());
        err.code = 'BACKUP_FAILED';
        throw err;
    }

    const matcher = buildLiveIdentityIndex(data.mods);
    // Fetched ONCE for the whole apply (2026-08-27, director-caught excess-call-count issue) --
    // every resolveDownloadIdForArchive() call below used to re-fetch the ENTIRE downloads list
    // fresh per mod (23 separate GET /downloads round trips on a 23-new-mod apply, on top of the
    // Updated loop's own). Downloads don't change mid-apply, so one snapshot here, threaded through
    // as an optional param, matches the same "fetch once, reuse" pattern data.mods/matcher already
    // established just above.
    const downloadsSnapshot = await withHelperRetry(() => helperClient.getAllDownloads());

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
        // Keyed by u.old.source (not u.new) so it's byte-identical to the frontend's own
        // ucv2UpdatedModId(u) lookup -- both describe the same live mod, but matching the EXACT
        // helper the review table already uses to key its rows avoids any chance of drift between
        // the two call sites ever silently breaking the mod-start/mod-complete row lookup. See
        // sourceModFileKey's own header comment for why this is modId:fileId, not modId alone.
        const modId = sourceModFileKey(u.old.source, u.new.name);
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
        if (keptModIds.has(sourceModFileKey(u.old.source, u.new.name))) {
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
                        knownVortexModId: alreadyUpdatedModId, collectionModId,
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
            const rebuildResult = await rebuildSingleMod({
                vortexModId, gameId: syncLib.GAME_ID, downloadsDir: downloads, stagingDir: staging,
                mod: effectiveNewMod, allowAutoDownload, collectionModId,
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
            // Metadata refresh -- Vortex's own UI would have set these via InstallManager; this
            // project's own faster extraction bypasses InstallManager entirely, so this is the
            // explicit follow-up step the director asked for instead. archiveId resolved by matching
            // the NEW archive's own real download record (localPath) against the live downloads
            // list, same identity signal Clean Up's own buildDownloadLookup already established.
            // Reuses the ONE downloads snapshot fetched at the top of runApply (see downloadsSnapshot's
            // own header comment) instead of a fresh GET /downloads per mod.
            const archiveMatch = await resolveOrRegisterArchiveId(u.new, downloads, downloadsSnapshot);
            // Confirmed via real source (mod_management/reducers/mods.ts): setModAttributes MERGES
            // into the mod's existing attributes, it does not replace them wholesale -- any field
            // NOT included here (customFileName in particular -- the user's own local rename, if
            // they made one) is left completely untouched, deliberately.
            const attributes = {
                // Prefer the real download's own fileVersion over collection.json's recorded
                // version -- see resolveDownloadIdForArchive's own header comment for the full real
                // mismatch this avoids (confirmed live: a "1.2"-vs-"1.2.0" split in Vortex's own
                // Version dropdown, only one of which had a working "Open Archive").
                version: (archiveMatch && archiveMatch.fileVersion) || u.new.version, modName: u.new.name,
                fileMD5: u.new.source && u.new.source.md5, modId: u.new.source && u.new.source.modId,
                fileId: u.new.source && u.new.source.fileId, fileSize: u.new.source && u.new.source.fileSize,
                logicalFileName: u.new.source && u.new.source.logicalFilename,
                referenceTag: u.new.source && u.new.source.tag,
                ...(archiveMatch ? { archiveId: archiveMatch.archiveId } : {}),
                // Bundle-type mod tags (2026-08-26, Missing Masters bundle-support fix) -- this
                // app's own custom Vortex attributes (Vortex's per-mod attributes are a free-form
                // bag, confirmed via source), recorded so a later single-mod repair with no
                // collection.json in scope (Missing Masters' own general scan) can recognize this
                // mod came from a bundle and resolve its parent collection package -- see
                // build-mod-from-vortex-state.js's shapeMod() and rebuild-single-mod.js's own
                // collectionModId fallback for the read-back side.
                ...(u.new.source && u.new.source.type === 'bundle'
                    ? { bundleFileExpression: u.new.source.fileExpression, bundleCollectionModId: collectionModId }
                    : {}),
            };
            const attrsOk = await helperClient.setModAttributes(vortexModId, attributes);
            touchedVortexModIds.add(vortexModId);
            // No per-mod deploy here anymore (2026-08-27, director's own architecture call): this
            // project never touches Data/ or creates hardlinks/symlinks itself -- that's exclusively
            // Vortex's OWN job. Every mod in this apply gets extracted/registered/ruled first; the
            // Apply Result screen's own explicit "Deploy" button (POST /deploy-all, web/update-
            // collection-v2-routes.js) triggers the real, single deployAllMods() afterward, matching
            // the native "Deploy Mods" button and Vortex's own real install/update flow exactly.
            finishUpdated({
                name: u.new.name, ok: true, attributesRefreshed: attrsOk,
                fileCount: rebuildResult.fileCount,
                skippedFiles: rebuildResult.skippedFiles || undefined,
                autoResolvedDuplicate: rebuildResult.autoResolvedDuplicate || undefined,
                error: attrsOk ? null : "Files were re-extracted, but Vortex's metadata refresh didn't confirm -- check Vortex's own log.",
            });
        } catch (e) {
            finishUpdated({ name: u.new.name, ok: false, error: e.message });
        }
    }

    // Per-mod keep/remove (2026-08-26, replacing the old all-or-nothing removedChoice) -- checkbox
    // semantics on the review screen are "checked = keep" (checked by DEFAULT, since the safer
    // default is protecting a mod something else might still need, e.g. one flagged "required by
    // another installed collection" -- director's own call). keepRemovedModIds is the set of
    // review.removed[] row keys the user left checked; everything else in review.removed gets
    // removed for real, same as the old 'remove' branch did unconditionally.
    //
    // Key is modId:fileId, NOT modId alone -- confirmed real, 2026-08-26: a single Nexus mod page can
    // ship several separate optional files that all end up in review.removed independently (e.g.
    // three different fileIds under the same modId 98945). modId alone would silently collapse their
    // keep/remove choice into one. Must match the frontend's own ucv2RemovedModId exactly (see that
    // function's header comment) -- keep both in sync if this key ever changes again.
    // stagingHasRealFiles is now a module-level function (hoisted 2026-09-01, see its own header
    // comment above runApply's declaration) -- the check below is unchanged, just no longer a nested
    // closure.
    const removedRowKey = (m) => {
        const modId = m.source && m.source.modId;
        const fileId = m.source && m.source.fileId;
        return modId != null && fileId != null ? `${modId}:${fileId}` : String(modId ?? m.name);
    };
    const keepRemovedModIdSet = new Set((keepRemovedModIds || []).map(String));
    const removedResults = [];
    if (review.removed.length > 0) {
        const toActuallyRemove = review.removed.filter((m) => !keepRemovedModIdSet.has(removedRowKey(m)));
        review.removed.filter((m) => keepRemovedModIdSet.has(removedRowKey(m)))
            .forEach((m) => removedResults.push({ name: m.name, ok: true, action: 'kept' }));
        if (toActuallyRemove.length > 0) {
            onProgress({ type: 'phase', message: 'Removing mods…' });
            const toRemove = [];
            // Mods with no real staging content/archive left (2026-08-28, director's own catch) --
            // routed through removeModRecordOnly instead of Vortex's real remove-mods, see the check
            // just below for the full real reasoning.
            const toRemoveRecordOnly = [];
            // Real, live progress for this pre-check pass (2026-08-30, director's own catch: "needs to
            // say Deleting 3/23" -- this loop had zero phase-level current/total before, only the
            // per-row mod-start/mod-complete pills below). This IS the real per-mod work happening here
            // (staging/archive existence checks); the actual batched Vortex removal call right after
            // has no further per-mod granularity to report (helperClient.removeMods is one real call).
            let removeCheckedCount = 0;
            for (const m of toActuallyRemove) {
                removeCheckedCount += 1;
                onProgress({ type: 'progress', current: removeCheckedCount, total: toActuallyRemove.length, message: `Checking ${m.name}` });
                // Live per-mod "Removing…" status (2026-08-28, director's own build-out -- Remove rows
                // had ZERO live-progress wiring before this, a real gap the mockup itself flagged:
                // helperClient.removeMods is one real batch Helper call with no per-mod granularity, so
                // every mod actually being removed gets its own mod-start right here (before the batch
                // call fires) and its own mod-complete once the batch's real outcome is known below --
                // same modId key convention (removedRowKey, matching the frontend's own
                // ucv2RemovedModId exactly) every other bucket's live rows already use.
                const modKey = removedRowKey(m);
                if (ignoredMatcher(m.source)) {
                    removedResults.push({ name: m.name, ok: null, action: 'ignored-skipped', modKey });
                    onProgress({ type: 'mod-complete', modId: modKey, name: m.name, ok: null, action: 'ignored-skipped', kind: 'remove' });
                    continue;
                }
                const vortexModId = resolveLiveModId(matcher, m.source);
                if (vortexModId) {
                    // Real fix (2026-08-28, director's own catch, confirmed live against a real
                    // apply): check staging + archive BEFORE asking Vortex to remove. Confirmed by
                    // reading Vortex's own source directly (mod_management/eventHandlers.ts's
                    // undeployMods) -- when a mod's staging folder is already gone on disk, the real
                    // undeploy attempt throws ENOENT, and VORTEX'S OWN CODE (not this project's)
                    // catches that by showing a real, BLOCKING "Mod not found" dialog requiring a
                    // person to click Ignore/Deploy in the Vortex window itself. There is no option on
                    // the real remove-mods event that suppresses this -- confirmed by reading the
                    // handler directly, not guessed. A mod with no real staging content (or whose
                    // downloaded archive is also gone) has nothing genuine for Vortex to undeploy
                    // anyway, so it's routed through removeModRecordOnly instead (deletes just the
                    // tracked record, no undeploy attempt, no dialog risk) -- any stale symlink left in
                    // Data/ gets cleaned up by the Deploy step this app already prompts for after every
                    // apply, same as the dialog's own "Deploy" option would have done regardless.
                    const liveMod = data.mods[vortexModId];
                    const stagingExists = !!(liveMod && liveMod.installationPath
                        && stagingHasRealFiles(path.join(staging, liveMod.installationPath)));
                    let archiveExists = false;
                    try {
                        await locateArchive(downloads, m.source);
                        archiveExists = true;
                    } catch {
                        archiveExists = false;
                    }
                    if (stagingExists && archiveExists) {
                        toRemove.push({ name: m.name, vortexModId, modKey });
                        onProgress({ type: 'mod-start', modId: modKey, name: m.name, kind: 'remove' });
                    } else {
                        toRemoveRecordOnly.push({ name: m.name, vortexModId, modKey });
                        onProgress({ type: 'mod-start', modId: modKey, name: m.name, kind: 'remove' });
                    }
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
                    removedResults.push({ name: m.name, ok: true, action: 'already-removed', modKey });
                    onProgress({ type: 'mod-complete', modId: modKey, name: m.name, ok: true, action: 'already-removed', kind: 'remove' });
                }
            }
            // Re-verify staging fresh, immediately before the real batched call (2026-08-28,
            // director-caught live gap): the per-mod check above runs early in this same loop, but
            // toRemove's own real removeMods dispatch only fires once the WHOLE loop (every mod in
            // this apply's Removed bucket) has finished -- on a heavily-churned test setup, staging
            // for an earlier-checked mod can genuinely go empty in that window (e.g. another
            // apply/revert on the SAME collection finishing its own cleanup concurrently). A mod
            // that's since gone empty is rerouted to toRemoveRecordOnly instead of being dispatched
            // through Vortex's real undeploy anyway -- exactly the same real "nothing genuine to
            // undeploy" case the original check exists to catch, just re-asked right before it
            // matters instead of trusting a possibly-stale answer from earlier in the loop.
            for (let i = toRemove.length - 1; i >= 0; i--) {
                const m = toRemove[i];
                const liveMod = data.mods[m.vortexModId];
                const stillHasStaging = !!(liveMod && liveMod.installationPath
                    && stagingHasRealFiles(path.join(staging, liveMod.installationPath)));
                if (!stillHasStaging) {
                    toRemove.splice(i, 1);
                    toRemoveRecordOnly.push(m);
                }
            }
            if (toRemove.length > 0) {
                try {
                    // removeModsVerifiedRetry (2026-09-01) -- NOT withHelperRetry. See that function's
                    // own header comment for the real, live-reproduced "Mod not found" incident this
                    // replaces it for: a blind retry can re-dispatch removeMods against a mod an EARLIER,
                    // timed-out attempt already genuinely removed, which is exactly what trips Vortex's
                    // own blocking modal. This re-checks live state before every retry and only ever
                    // shrinks the batch, never blindly resends it.
                    const { removed, stillRemaining, blockedReason } = await removeModsVerifiedRetry(toRemove, staging);
                    removed.forEach((m) => {
                        removedResults.push({ name: m.name, ok: true, action: 'removed', modKey: m.modKey });
                        onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: true, action: 'removed', kind: 'remove' });
                    });
                    if (stillRemaining.length > 0 && blockedReason) {
                        // Vortex is confirmed CURRENTLY showing a blocking dialog (see
                        // removeModsVerifiedRetry's own header comment) -- a getAllMods verify call
                        // right now would almost certainly hit the same wall, so report the real,
                        // actionable reason directly instead of spending more time on a doomed check.
                        stillRemaining.forEach((m) => {
                            removedResults.push({ name: m.name, ok: false, error: blockedReason, modKey: m.modKey });
                            onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: false, error: blockedReason, kind: 'remove' });
                        });
                    } else if (stillRemaining.length > 0) {
                        // Verify-after-retry (2026-08-27, real live false-negative found this same
                        // session): Vortex's own real dispatch runs synchronously and completes
                        // BEFORE the HTTP response is sent (same risk already documented/handled for
                        // every other write in this file) -- a lost response here can report a whole
                        // removal batch as "Failed" even though every mod was genuinely removed.
                        // Confirmed live: a real 19-mod removal reported "Failed" for all 19 while a
                        // direct live-state check, moments later, showed every one of them genuinely
                        // gone. Widened retry budget -- this runs right after the apply's own remove
                        // step, the same "Vortex might still be catching up" race END_OF_APPLY_RETRY_
                        // OPTIONS already covers elsewhere. Scoped to stillRemaining only now -- removed
                        // was already confirmed above, by removeModsVerifiedRetry's own live re-checks.
                        const snap = await withHelperRetry(() => timedGetAllMods('runApply-removeVerify'), END_OF_APPLY_RETRY_OPTIONS);
                        if (snap) {
                            stillRemaining.forEach((m) => {
                                const stillPresent = !!snap.mods[m.vortexModId];
                                const errorMsg = stillPresent ? "Vortex couldn't confirm this mod was removed after real retries -- check Vortex's own log." : undefined;
                                removedResults.push({
                                    name: m.name, ok: !stillPresent, action: stillPresent ? undefined : 'removed',
                                    error: errorMsg, modKey: m.modKey,
                                });
                                onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: !stillPresent, error: errorMsg || null, action: stillPresent ? null : 'removed', kind: 'remove' });
                            });
                        } else {
                            // Couldn't even verify -- genuinely unknown, report honestly as failed
                            // rather than silently assume success.
                            stillRemaining.forEach((m) => {
                                const errorMsg = "Couldn't confirm whether this mod was removed -- check Vortex's own log.";
                                removedResults.push({ name: m.name, ok: false, error: errorMsg, modKey: m.modKey });
                                onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: false, error: errorMsg, kind: 'remove' });
                            });
                        }
                    }
                } catch (e) {
                    toRemove.forEach((m) => {
                        removedResults.push({ name: m.name, ok: false, error: e.message, modKey: m.modKey });
                        onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: false, error: e.message, kind: 'remove' });
                    });
                }
            }
            // Record-only removes (2026-08-28) -- see the staging/archive check above for the full
            // real reasoning. Same verify-after-retry shape as the real removeMods batch above (a lost
            // response is the same documented risk every write in this file already accounts for),
            // just against a plain, real live-state read since this call has no "Mod not found"
            // dialog risk to race against.
            if (toRemoveRecordOnly.length > 0) {
                try {
                    const ok = await withHelperRetry(() => helperClient.removeModsRecordOnly(toRemoveRecordOnly.map((m) => m.vortexModId)));
                    if (ok) {
                        toRemoveRecordOnly.forEach((m) => {
                            removedResults.push({ name: m.name, ok: true, action: 'removed', modKey: m.modKey });
                            onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: true, action: 'removed', kind: 'remove' });
                        });
                    } else {
                        const snap = await withHelperRetry(() => timedGetAllMods('runApply-removeRecordOnlyVerify'), END_OF_APPLY_RETRY_OPTIONS);
                        if (snap) {
                            toRemoveRecordOnly.forEach((m) => {
                                const stillPresent = !!snap.mods[m.vortexModId];
                                const errorMsg = stillPresent ? "Vortex couldn't confirm this mod's record was removed after real retries -- check Vortex's own log." : undefined;
                                removedResults.push({
                                    name: m.name, ok: !stillPresent, action: stillPresent ? undefined : 'removed',
                                    error: errorMsg, modKey: m.modKey,
                                });
                                onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: !stillPresent, error: errorMsg || null, action: stillPresent ? null : 'removed', kind: 'remove' });
                            });
                        } else {
                            toRemoveRecordOnly.forEach((m) => {
                                const errorMsg = "Couldn't confirm whether this mod's record was removed -- check Vortex's own log.";
                                removedResults.push({ name: m.name, ok: false, error: errorMsg, modKey: m.modKey });
                                onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: false, error: errorMsg, kind: 'remove' });
                            });
                        }
                    }
                } catch (e) {
                    toRemoveRecordOnly.forEach((m) => {
                        removedResults.push({ name: m.name, ok: false, error: e.message, modKey: m.modKey });
                        onProgress({ type: 'mod-complete', modId: m.modKey, name: m.name, ok: false, error: e.message, kind: 'remove' });
                    });
                }
            }
        }
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
    // Phase 1: extraction. Bucketed into a strictly-sequential pass and a concurrent worker pool
    // (2026-08-28, director's own build spec) -- downloads must stay strictly sequential (this
    // project's own established Nexus rate-limit rule, unchanged), but extraction itself is real
    // independent per-mod file I/O touching no shared mutable state between mods, exactly what
    // collection-runner.js's own runRebuild() already proves is safe to run concurrently (each mod
    // spawns its own extract-mod.js child process and touches only its own uniquely-named staging
    // path). classifyMod() is called once per mod, up front, purely to answer "would THIS mod's
    // real rebuildSingleMod() call trigger a network download?" -- the exact same condition
    // rebuildSingleMod() checks internally (SKIP_NO_ARCHIVE + a nexus source + auto-download on),
    // confirmed by reading rebuild-single-mod.js directly -- so a mod needing a real download stays
    // in the sequential bucket below, and everything else (archive already present, or a
    // bundle/off-site source that never downloads through this path) is handed to the worker pool.
    // This does mean a mod gets classified twice (rebuildSingleMod() classifies again internally) --
    // a deliberate, low-cost tradeoff: classifyMod() is a cheap, read-only filesystem check, and this
    // avoids touching rebuild-single-mod.js/rebuild-mod.js at all, which are also shared by Rebuild
    // Collection, Missing Masters, and this file's own Updated-mod loop -- zero regression risk to
    // any of those from this change.
    //
    // What used to ALSO live in this loop -- create/set-attributes/set-enabled/rules-apply, up to 4
    // separate Helper round trips PER mod -- is deferred to Phase 2/3 below, batched across every mod
    // that made it through extraction. See this block's original header comment (further above,
    // unedited) for why registration only happens after a verified-successful extraction.
    const addedSevenZipExe = findSevenZip();
    const addedAllowAutoDownload = !!appConfig.loadConfig().downloadMissingArchives;
    const addedItems = review.added.map((m, addedI) => {
        // modId:fileId, NOT just m.source.modId -- see sourceModFileKey's own header comment. This is
        // purely the SSE row-key; attributes.modId below still reads m.source.modId directly (the
        // real Nexus id), unaffected by this key's shape.
        const modId = sourceModFileKey(m.source, m.name);
        const freshFomodChoices = resolvedFomodChoices.get(String(m.source && m.source.modId));
        const effectiveMod = freshFomodChoices ? { ...m, choices: freshFomodChoices } : m;
        effectiveAddedByOriginal.set(m, effectiveMod);
        const existingVortexModId = resolveLiveModId(matcher, m.source);
        return { m, addedI, modId, effectiveMod, existingVortexModId };
    });
    // Bucketing reads are independent, read-only filesystem checks -- same reasoning as the real
    // extraction pass below, so they run concurrently too rather than adding a serial pre-pass.
    const bucketedAddedItems = await Promise.all(addedItems.map(async (item) => {
        let willDownload = false;
        try {
            const action = await classifyMod(item.effectiveMod, {
                downloadsDir: downloads, stagingDir: staging, knownVortexModId: item.existingVortexModId || null,
                collectionModId, sevenZipExe: addedSevenZipExe,
            });
            willDownload = action.kind === 'SKIP_NO_ARCHIVE' && item.effectiveMod.source
                && item.effectiveMod.source.type === 'nexus' && addedAllowAutoDownload;
        } catch {
            // Classification itself failed here -- rebuildSingleMod() below will hit and surface the
            // same failure for real. Nothing here would trigger a download either way, so this mod is
            // safe to run in the parallel batch rather than blocking on it.
        }
        return { ...item, willDownload };
    }));

    // The phase-text counter ("N / total -- Installing X...") now counts mods as they each BEGIN
    // their own real processing via a shared counter, not each item's original review.added
    // position -- the two buckets below no longer necessarily start in that order.
    let addedStartedCount = 0;
    const addedPending = [];
    const processOneAdded = async (item) => {
        const { m, addedI, modId, effectiveMod, existingVortexModId } = item;
        addedStartedCount += 1;
        onProgress({ type: 'progress', message: `Installing ${m.name}…`, current: addedStartedCount, total: review.added.length });
        onProgress({ type: 'mod-start', modId, name: m.name });
        // Index-written (2026-08-27), NOT pushed -- mergeSucceededResultsIntoMods below reads
        // addedResults[i] positionally against review.added[i] (`review.added.forEach((m, i) => {
        // if (addedResults[i] && addedResults[i].ok === true) ... })`). Mods now routinely finish OUT
        // of their original review.added order (sequential-download mods, concurrent-extraction mods,
        // and Phase 2/3 registration below can all reorder which mod's result lands first) -- push()
        // would silently misalign every result after the first out-of-order finish. Writing directly
        // to this mod's own captured index keeps the array correctly aligned regardless of finish
        // order.
        const finishAdded = (result) => {
            addedResults[addedI] = { ...result, modId };
            onProgress({
                type: 'mod-complete', modId, name: m.name, ok: result.ok,
                error: result.error || null, action: result.action || null, status: result.status || null,
            });
        };
        try {
            const attemptRebuild = () => rebuildSingleMod({
                vortexModId: existingVortexModId || null, gameId: syncLib.GAME_ID, downloadsDir: downloads, stagingDir: staging,
                mod: effectiveMod, allowAutoDownload: addedAllowAutoDownload, collectionModId,
                resolveMode: 'all',
                onPhase: (phase) => onProgress({ type: 'mod-phase', modId, phase }),
            });
            let rebuildResult = await attemptRebuild();
            // Real bounded auto-retry (2026-08-28, director's own ask: "check first" rather than
            // retry blindly into the same wall). SKIP_NO_ARCHIVE with auto-download off, or a
            // confirmed not-Premium download skip, will fail IDENTICALLY every time -- retrying either
            // just wastes a second real attempt for a deterministic outcome, same "don't suggest
            // retrying a deterministic failure" rule this project's own error copy already follows
            // elsewhere (APPLY_FAILURE_MESSAGES/describeApplyFailure). Everything else (a plausible
            // transient network hiccup, or Vortex's own thread being busy with unrelated work, as
            // confirmed live this session) gets exactly ONE real retry -- rebuildSingleMod already
            // attempts auto-download internally when allowAutoDownload is on, so this naturally covers
            // "try to redownload it" without a separate download step.
            if (rebuildResult.status !== 'REBUILT') {
                const deterministic = rebuildResult.downloadSkipped === 'not-premium'
                    || (rebuildResult.status === 'SKIP_NO_ARCHIVE' && !addedAllowAutoDownload);
                if (!deterministic) {
                    rebuildResult = await attemptRebuild();
                }
            }
            if (rebuildResult.status !== 'REBUILT') {
                finishAdded({
                    name: m.name, ok: false, error: describeApplyFailure(rebuildResult),
                    status: rebuildResult.status || rebuildResult.kind,
                });
                return;
            }

            const newVortexModId = rebuildResult.targetFolderName; // === existingVortexModId when one was found above
            const archiveMatch = await resolveOrRegisterArchiveId(effectiveMod, downloads, downloadsSnapshot);
            const attributes = {
                // Prefer the real download's own fileVersion over collection.json's recorded
                // version -- see resolveDownloadIdForArchive's own header comment for the full real
                // mismatch this avoids (confirmed live: a "1.2"-vs-"1.2.0" split in Vortex's own
                // Version dropdown, only one of which had a working "Open Archive").
                version: (archiveMatch && archiveMatch.fileVersion) || m.version, modName: m.name,
                fileMD5: m.source && m.source.md5, modId: m.source && m.source.modId,
                fileId: m.source && m.source.fileId, fileSize: m.source && m.source.fileSize,
                logicalFileName: m.source && m.source.logicalFilename,
                referenceTag: m.source && m.source.tag,
                ...(m.source && m.source.type === 'nexus' ? { source: 'nexus' } : {}),
                // Real, director-caught gap (2026-08-18) -- see this block's original header comment
                // for the full "enableallplugins" trace.
                enableallplugins: true,
                ...(m.source && m.source.type === 'bundle'
                    ? { bundleFileExpression: m.source.fileExpression, bundleCollectionModId: collectionModId }
                    : {}),
                // Root-cause fix (2026-08-29, live catch): the real FOMOD selection genuinely was
                // applied to the extracted files (resolveChoices/extract-mod.js -- confirmed live,
                // resolved file counts matched what's actually on disk exactly, for every one of 3
                // real mods checked) -- but Vortex itself never learns that a choice was ever made,
                // because this whole pipeline deliberately extracts the archive itself and only
                // REGISTERS the result (createMod), never running Vortex's own real FOMOD wizard. Real
                // Vortex's own InstallManager writes the resolved selections to attributes.
                // installerChoices on every FOMOD-driven install (confirmed via its own real source,
                // mod_management/types/IMod.ts's IMod.installerChoices?: IChoiceType, and
                // installer_fomod_shared/types/interface.ts's IChoiceType = {type, options} -- the
                // EXACT same shape collection.json's own recorded `choices` field already uses, byte
                // for byte, confirmed by direct comparison). Without this, Vortex's own UI (its
                // Workshop tab's "+Add"/Fresh-Install marking, and any FOMOD-choices inspector) reads
                // this mod as if no installer choice was ever made at all, even though the right files
                // are genuinely sitting in staging -- confirmed live: reinstalling the SAME mod through
                // Vortex's own wizard is what would set this attribute and clear that mismatch.
                ...(effectiveMod.choices && effectiveMod.choices.type === 'fomod' ? { installerChoices: effectiveMod.choices } : {}),
            };
            // Kept OUT of `attributes` deliberately (2026-08-28, real root-cause fix) -- archiveId is
            // a TOP-LEVEL field on Vortex's own real IMod shape (confirmed via IMod.ts:
            // `archiveId?: string`, a sibling of `attributes`, not nested inside it). Threaded through
            // separately here so the createItems/create-retry construction below can place it
            // correctly instead of burying it where Vortex's own Version-column grouping never reads.
            const archiveId = archiveMatch ? archiveMatch.archiveId : undefined;

            // This mod's own extraction is fully done and verified -- it now sits behind the batch
            // registration call below (Phase 2/3), not a per-mod Vortex write of its own. "Pending
            // install" makes that real wait honest instead of leaving the row frozen on "Extracting…"
            // after the extraction itself has actually finished.
            onProgress({ type: 'mod-phase', modId, phase: 'pending-install' });

            addedPending.push({
                m, effectiveMod, modId, newVortexModId, existingVortexModId, attributes, archiveId,
                rebuildResult, finishAdded,
            });
        } catch (e) {
            finishAdded({ name: m.name, ok: false, error: e.message });
        }
    };

    // Downloads must stay strictly sequential (Nexus rate-limit risk) -- unchanged behavior from
    // before this restructure, just narrowed to only the mods that actually need one.
    const sequentialAddedItems = bucketedAddedItems.filter((it) => it.willDownload);
    for (const item of sequentialAddedItems) {
        await processOneAdded(item);
    }

    // Everything else: archive already on disk, or a source that never downloads through this path
    // (bundle/off-site) -- safe to extract concurrently. Same worker-pool shape as
    // collection-runner.js's own runRebuild() (an index cursor + a fixed-size batch of workers
    // pulling from it), capped by the same user-configurable concurrentExtractions setting already
    // wired end to end for Rebuild Collection (lib/app-config.js, Settings).
    const parallelAddedItems = bucketedAddedItems.filter((it) => !it.willDownload);
    if (parallelAddedItems.length > 0) {
        const concurrency = Math.max(1, Math.min(
            appConfig.loadConfig().concurrentExtractions || 1, parallelAddedItems.length,
        ));
        let nextParallelIndex = 0;
        const addedWorker = async () => {
            for (;;) {
                const myIndex = nextParallelIndex++;
                if (myIndex >= parallelAddedItems.length) return;
                await processOneAdded(parallelAddedItems[myIndex]);
            }
        };
        await Promise.all(Array.from({ length: concurrency }, () => addedWorker()));
    }

    // Phase 2/3 (2026-08-27, director-caught excess-call-count fix): register every mod that
    // survived extraction in as FEW Helper round trips as possible, batched across the whole set
    // instead of one call per mod. Matches real Vortex's own native collection-install code exactly
    // -- confirmed via source (collections/index.ts, collectionCreate.ts, InstallDriver.ts): every
    // real call site that adds collection membership rules dispatches ONE `batchDispatch(store,
    // rules.map(addModRule))` for the whole set, never one dispatch per mod. See
    // vortex-collection-helper's own applyRuleChangesBatch/setModsEnabledBatch/createModsBatch
    // header comments for the server-side half of this.
    //
    // Shared fallback reads (below): verifyModLiveState/verifyMembershipLive each fetch a WHOLE
    // snapshot (every live mod / one collection's whole rules list) per call -- calling either once
    // PER mod needing fallback would silently reintroduce the exact per-mod-call problem this
    // restructure exists to fix, and fallback is most likely to trigger during exactly the kind of
    // Helper disruption where minimizing calls matters most. So these are fetched ONCE, lazily, only
    // if at least one mod actually needs one, and shared across every mod that does.
    let sharedModsSnapshot; // undefined = not yet fetched; null = fetch failed; object = real snapshot
    async function getSharedModsSnapshot() {
        if (sharedModsSnapshot === undefined) {
            sharedModsSnapshot = (await withHelperRetry(() => timedGetAllMods('runApply-addedLoopFallback'), END_OF_APPLY_RETRY_OPTIONS)) || null;
        }
        return sharedModsSnapshot;
    }
    let sharedCollectionRules; // same undefined/null/array convention as above
    async function getSharedCollectionRules() {
        if (sharedCollectionRules === undefined) {
            sharedCollectionRules = (await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId), END_OF_APPLY_RETRY_OPTIONS)) || null;
        }
        return sharedCollectionRules;
    }

    // "Installing…" fires for the whole batch together, right at the real moment this batch
    // registration begins (2026-08-28, director's own build spec) -- every row that made it through
    // extraction flips at once here, honestly matching what createModsBatch below actually does (one
    // batched call covering the whole set, never one call per mod).
    for (const p of addedPending) {
        onProgress({ type: 'mod-phase', modId: p.modId, phase: 'batch-installing' });
    }

    // 2a: create -- only for mods genuinely new to Vortex (existingVortexModId gates this exactly
    // like the old per-mod code did). createModsBatch is NOT one atomic Redux batchDispatch (each
    // item drives the real async create-mod EVENT with its own filesystem side effect) -- see its
    // own header comment -- so a per-item result here IS a genuine independent signal, not just an
    // input-validation echo.
    const toCreate = addedPending.filter((p) => !p.existingVortexModId);
    const createResultsByModId = new Map();
    if (toCreate.length > 0) {
        const createItems = toCreate.map((p) => ({
            modId: p.newVortexModId,
            mod: {
                id: p.newVortexModId, state: 'installed', type: '', installationPath: p.newVortexModId,
                ...(p.archiveId ? { archiveId: p.archiveId } : {}),
                attributes: { name: p.m.name, installTime: new Date().toISOString(), ...p.attributes },
            },
        }));
        const results = await withHelperRetry(() => helperClient.createModsBatch(createItems));
        if (Array.isArray(results)) {
            for (const r of results) createResultsByModId.set(r.modId, r.ok === true);
        }
        // A null response means the WHOLE request never got a usable answer -- every item in it
        // falls through to the shared live-state fallback below, same as before, just scoped per
        // item instead of inline.
    }

    const registered = [];
    for (const p of addedPending) {
        let createOk = true;
        let attrsOk = true;
        if (!p.existingVortexModId) {
            createOk = createResultsByModId.get(p.newVortexModId) === true;
            if (!createOk) {
                const snap = await getSharedModsSnapshot();
                createOk = !!(snap && snap.mods[p.newVortexModId]);
                // The create call itself didn't confirm success before we fell back to this live
                // re-check -- registration may have landed but we can't be sure the attributes
                // payload specifically made it through intact, so re-send them explicitly as a
                // safety net (the one case this merge still costs a second call, same as before).
                if (createOk) {
                    attrsOk = await withHelperRetry(() => helperClient.setModAttributes(p.newVortexModId, p.attributes));
                }
            }
            // Real false negative, confirmed live (2026-08-28): the shared snapshot above is fetched
            // ONCE, lazily, the first time any mod in this loop needs it -- for a mod near the END of
            // a real batch, Vortex's own real async create-mod event (a genuine filesystem side
            // effect, not an atomic dispatch) can still be finishing when that ONE shared snapshot was
            // taken, even though the mod registers moments later. Confirmed via a real live apply: a
            // mod reported "Failed" here was independently verified -- files fully extracted (107 real
            // files on disk) AND genuinely registered in Vortex's own live mod list -- at the exact
            // same moment this code was about to report it as a failure. verifyModLiveState (already
            // proven in retryModExtraction's own single-mod path, but never wired into this main batch
            // loop until now) does a FRESH, individually-retried check instead of reusing the shared
            // snapshot -- can only ever correct a false "Failed" into a true "ok" here, never mask a
            // real one, since it reads real live Vortex state rather than guessing.
            if (!createOk) {
                const liveState = await verifyModLiveState(p.newVortexModId);
                createOk = liveState.registered;
                if (createOk) {
                    attrsOk = await withHelperRetry(() => helperClient.setModAttributes(p.newVortexModId, p.attributes));
                }
            }
            // One real bounded retry, registration ONLY (2026-08-28, director's own ask, "check first"
            // -- staging is already confirmed to have real content, since only a mod that survived
            // Phase 1 extraction ever reaches this loop, so there's nothing to re-extract here). The
            // batch createModsBatch call and the shared/individual live-state checks above all failed
            // to confirm registration -- as a last resort before giving up, try the SAME single-mod
            // createMod the Retry-button path already uses, once, directly for just this one mod.
            if (!createOk) {
                const retryCreateOk = await withHelperRetry(() => helperClient.createMod(p.newVortexModId, {
                    id: p.newVortexModId, state: 'installed', type: '', installationPath: p.newVortexModId,
                    ...(p.archiveId ? { archiveId: p.archiveId } : {}),
                    attributes: { name: p.m.name, installTime: new Date().toISOString(), ...p.attributes },
                }));
                createOk = retryCreateOk === true;
                if (!createOk) {
                    // The direct retry call itself may have hit the same lost-response risk every
                    // other real write in this file already accounts for -- one more live read before
                    // truly giving up.
                    const liveStateAfterRetry = await verifyModLiveState(p.newVortexModId);
                    createOk = liveStateAfterRetry.registered;
                }
                if (createOk) {
                    attrsOk = await withHelperRetry(() => helperClient.setModAttributes(p.newVortexModId, p.attributes));
                }
            }
            if (!createOk) {
                p.finishAdded({ name: p.m.name, ok: false, error: "Files were extracted, but Vortex couldn't register this as a new mod after real retries -- check Vortex's own log.", vortexModId: p.newVortexModId });
                continue;
            }
        } else {
            // Already live-tracked by Vortex under a matching identity (existingVortexModId resolved
            // above via resolveLiveModId -- md5/tag/modId+fileId) -- createMod is skipped entirely.
            // Deliberately NO attribute write here (2026-08-29, real live-confirmed corruption): this
            // used to unconditionally overwrite the matched mod's own modName/logicalFileName/version/
            // fileMD5/modId/fileId/referenceTag with THIS collection's own m.source values. A live
            // case caught it doing real damage -- a collection.json entry with the WRONG Nexus fileId
            // (a curation mistake, confirmed via Nexus's own API: the collection meant to add a small
            // OPTIONAL file but the entry's fileId pointed at a completely different MAIN file) still
            // matched an already-installed, unrelated mod ("Pandora Behaviour Engine v4.4.0-beta",
            // legitimately a member of a DIFFERENT collection, "Body Swap updated") purely because its
            // real identity happened to satisfy the match -- and this write then relabeled that shared
            // mod as "Pandora XPMSE Behavior Patch" (the WRONG collection's own name for it), corrupting
            // how it displays for every collection/user context that shares it, not just this one.
            // A genuine identity match means these values are ALREADY correct by definition (that's
            // literally how the match was found) -- there is no legitimate reason to rewrite them, only
            // risk when the match itself turns out to be based on bad source data. Nothing else needs a
            // write here either: a matched mod already has real content on disk (Phase 1 extraction
            // above reused its own existing staging folder via classifyMod's knownVortexModId), so this
            // branch is now a pure no-op past the createMod skip. The collection MEMBERSHIP rule this
            // mod's Added-loop writes further below (2c) is unaffected -- a genuinely shared mod
            // legitimately belonging to two collections is normal, correct Vortex behavior; it's only
            // the attribute overwrite that had no valid reason to happen.
            attrsOk = true;
        }
        registered.push({ ...p, attrsOk });
    }

    // 2b: enable -- every mod that made it past registration needs its own profile Enabled flip
    // (see this block's original header comment for why -- unlike an Updated mod, a brand-new mod
    // has no prior profile entry to inherit from). setModsEnabledBatch IS one atomic
    // batchDispatch across the whole array (see its own header comment) -- if the request comes
    // back null, the WHOLE dispatch is uncertain, not just individual items.
    const enableResultsByModId = new Map();
    if (registered.length > 0) {
        const enableItems = registered.map((p) => ({ modId: p.newVortexModId, enable: true }));
        const results = await withHelperRetry(() => helperClient.setModsEnabledBatch(enableItems));
        if (Array.isArray(results)) {
            for (const r of results) enableResultsByModId.set(r.modId, r.ok === true);
        }
    }

    // 2c: collection membership -- same batching, same all-or-nothing-dispatch reasoning as enable.
    // Every item in this ONE call targets the SAME collectionModId (the rule's own subject), so
    // results are matched back by POSITION, not modId, unlike create/enable above.
    //
    // Stale bundle-mod rule cleanup (2026-08-30, director-caught real duplicate: Vortex's own
    // native collection installer can leave behind an incomplete "requires" rule for a bundle mod
    // it never actually finished installing -- confirmed live, MP_Melony.7z showed permanently
    // stuck at "Install pending"/a garbage "0.0.0" version in Vortex's own Collection page, sitting
    // ALONGSIDE the real, correct rule this apply's own registration below then added for the SAME
    // bundle, once it actually succeeded). A bundle-type mod has no modId/fileId to identify it by
    // (see buildCollectionMembershipRule's own header comment) -- its own `reference.description`
    // (the bundle's plain name, e.g. "MP_Melony.7z") is the only real identity signal, so ANY
    // existing rule sharing that description but a DIFFERENT `tag` is a stale leftover for the same
    // logical bundle slot, not a legitimate second member. Only ever removes a rule that's about to
    // be immediately superseded by a freshly-added correct one in this SAME batched dispatch --
    // never a standalone cleanup pass with no replacement.
    const staleBundleRuleRemovals = new Map(); // registered index -> rule to remove
    const bundleCandidates = registered.filter((p) => p.m.source && p.m.source.type === 'bundle');
    if (bundleCandidates.length > 0) {
        const existingRules = await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId));
        if (Array.isArray(existingRules)) {
            for (let i = 0; i < registered.length; i += 1) {
                const p = registered[i];
                if (!p.m.source || p.m.source.type !== 'bundle') continue;
                const newTag = p.effectiveMod.source && p.effectiveMod.source.tag;
                const stale = existingRules.find((r) => r.reference && r.reference.description === p.m.name
                    && r.reference.tag !== newTag);
                if (stale) staleBundleRuleRemovals.set(i, stale);
            }
        }
    }

    // viaPrerequisite mods (2026-09-01, director-caught real duplicate) are deliberately excluded
    // here -- see downloadAndBuildAddedModEntry's own header comment: a prerequisite mod installs
    // for real, but must NEVER be declared a member of THIS collection, since some OTHER installed
    // collection is the one that actually owns/declares it. That exclusion was only ever wired into
    // the local collection.json merge; this membership-RULE write had no such guard, so it was
    // dispatching a real "belongs to this collection" rule for it anyway -- confirmed live, Vortex's
    // own Collection column showed the SAME collection name twice for one mod. Positions are
    // preserved via origIndex (not a plain filter+remap) so membershipResults[i] below still lines
    // up with registered[i] for every mod this DID write a rule for.
    let membershipResults = new Map(); // registered index -> {ok} | undefined (undefined = intentionally skipped)
    const membershipEligible = registered
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => !p.m.viaPrerequisite);
    if (membershipEligible.length > 0) {
        const ruleItems = membershipEligible.map(({ p, i }) => ({
            modId: collectionModId, add: buildCollectionMembershipRule(p.m, p.effectiveMod),
            ...(staleBundleRuleRemovals.has(i) ? { remove: staleBundleRuleRemovals.get(i) } : {}),
        }));
        const results = await withHelperRetry(() => helperClient.applyRuleChangesBatch(ruleItems));
        if (Array.isArray(results) && results.length === membershipEligible.length) {
            membershipEligible.forEach(({ i }, pos) => membershipResults.set(i, results[pos]));
        }
    }

    // Registering/enabling a mod does NOT make it show as "part of this collection" in Vortex's own
    // UI -- that's the separate membership rule above (see buildCollectionMembershipRule's own
    // header comment for the full trace). No per-mod deploy anywhere in this loop (2026-08-27,
    // director's own architecture call): this project never touches Data/ or creates hardlinks/
    // symlinks itself -- that's exclusively Vortex's OWN job, done ONCE via the Apply Result
    // screen's own explicit "Deploy" button (POST /deploy-all, web/update-collection-v2-routes.js)
    // after every mod in this apply is extracted/registered/ruled, matching the native "Deploy
    // Mods" button exactly.
    for (let i = 0; i < registered.length; i += 1) {
        const p = registered[i];
        try {
            let enabledOk = enableResultsByModId.get(p.newVortexModId) === true;
            if (!enabledOk) {
                const snap = await getSharedModsSnapshot();
                enabledOk = !!(snap && snap.enabledModKeys.includes(p.newVortexModId));
            }
            // viaPrerequisite mods never get a membership rule dispatched at all (see the
            // membershipEligible filter above) -- "no rule" IS the correct end state for them, so
            // there's nothing to verify and no problem to report.
            let membershipOk = p.m.viaPrerequisite || membershipResults.get(i)?.ok === true;
            if (!membershipOk && !p.m.viaPrerequisite) {
                const rules = await getSharedCollectionRules();
                membershipOk = !!(rules && rules.some((r) => r.reference && r.reference.repo
                    && String(r.reference.repo.modId) === String(p.m.source.modId)
                    && String(r.reference.repo.fileId) === String(p.m.source.fileId)));
            }

            // ok is TRUE once genuinely registered (the one real "does this mod fundamentally exist
            // as far as Vortex is concerned" gate now that deploy is deferred -- also what the
            // collection.json merge below keys on). attrsOk/enabledOk/membershipOk are surfaced
            // separately rather than silently folded away: a mod can land registered with stale/
            // missing metadata, the wrong Enabled checkbox state, or no collection association, and
            // that's real, honest information worth showing rather than a blanket "it worked" --
            // matches this project's own "never run a real action silently" standing rule for RESULT
            // reporting, not just progress (DESIGN.md, commit 4bdd307).
            const ok = true;
            const problems = [];
            if (!p.attrsOk) problems.push('metadata (version/fileId/etc) may be stale');
            if (!enabledOk) problems.push("the Mods table's Enabled checkbox may not reflect this mod");
            if (!membershipOk) problems.push("Vortex may not show this mod as part of the collection");
            // Real, non-blocking heads-up (2026-08-31, see extractMany's own header comment for the
            // full mechanism) -- a genuinely bad member inside an otherwise-healthy archive (confirmed
            // real: a 7-Zip "Incorrect reparse stream" bug on a specific .txt entry). This mod still
            // installed successfully with everything ELSE the archive had; only note it, never flip ok.
            if (p.rebuildResult.skippedFiles && p.rebuildResult.skippedFiles.length > 0) {
                problems.push(`${p.rebuildResult.skippedFiles.length} file(s) inside this mod's package couldn't be extracted -- you may want to let the mod author know`);
            }
            p.finishAdded({
                name: p.m.name, ok, vortexModId: p.newVortexModId, attributesRefreshed: p.attrsOk,
                enabled: enabledOk, membershipLinked: membershipOk,
                fileCount: p.rebuildResult.fileCount,
                skippedFiles: p.rebuildResult.skippedFiles || undefined,
                autoResolvedDuplicate: p.rebuildResult.autoResolvedDuplicate || undefined,
                error: problems.length > 0 ? `${problems.join('; ')} -- check Vortex's own log.` : null,
            });
        } catch (e) {
            p.finishAdded({ name: p.m.name, ok: false, error: e.message });
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
    // No more removedChoice gate -- `eligible` below already only ever contains mods that were
    // actually removed (action 'removed'/'already-removed'), never 'kept' ones, so this naturally
    // does the right thing per-mod without needing an outer all-or-nothing check.
    if (deleteArchives) {
        const eligible = removedResults.filter((r) => r.ok === true && (r.action === 'removed' || r.action === 'already-removed'));
        if (eligible.length > 0) {
            const removedSourceByName = new Map(review.removed.map((m) => [m.name, m.source]));
            // No Vortex/Helper round trip at all (2026-08-28, director's own real catch: this whole
            // step was going through Vortex's OWN downloads database via getAllDownloads() just to
            // find a real file's own path -- a pure local disk fact this project already has a
            // direct, Vortex-independent way to check). locateArchive (archive-locator.js) matches
            // by the SAME real size+md5 archiveExists already uses earlier in this Removed loop --
            // no live Vortex data needed, so this step can never fail just because Vortex/the Helper
            // is genuinely busy right after a real removal. Confirmed live: a real apply's own
            // archive-delete step failed for every eligible mod at once with "Couldn't read Vortex's
            // live downloads list" right after a real removal had just gone through -- this removes
            // that whole failure class rather than retrying into the same busy window.
            // Not being able to LOCATE the archive is never reported as a problem (2026-09-01,
            // director's own explicit call, live-caught on a real false "couldn't be deleted"
            // warning): if it's not sitting on disk under this mod's own recorded identity, the only
            // honest read is "already gone" -- there's nothing here for the director to act on, and a
            // warning that fires on ambiguity most people can't resolve just trains them to ignore the
            // whole "Applied with some problems" banner. This ONLY suppresses the locate step (no
            // source recorded, NOT_FOUND, HASH_MISMATCH, or any other locateArchive throw) -- a REAL
            // delete failure (the file WAS found, the actual fs delete call itself failed -- e.g.
            // locked/in-use/permissions) still gets reported below, since that's genuinely actionable.
            const toDelete = [];
            for (const r of eligible) {
                const source = removedSourceByName.get(r.name);
                if (!source) continue;
                try {
                    const archivePath = await locateArchive(downloads, source);
                    if (archivePath) toDelete.push({ name: r.name, path: archivePath });
                } catch {
                    // Couldn't locate it -- treated as already gone, silently. See comment above.
                }
            }
            if (toDelete.length > 0) {
                const rmResults = cleanupScan.deleteEntries(toDelete.map((t) => t.path));
                toDelete.forEach((t, i) => {
                    const rm = rmResults[i];
                    // A real failure gets just the file name, no raw OS error text (director's own
                    // explicit call, same session) -- the group heading already says "couldn't be
                    // deleted, delete them manually," so the file name alone is the whole actionable
                    // fact; the underlying error reads as noise on top of that.
                    deletedArchiveResults.push({ name: t.name, ok: rm.ok, path: t.path });
                });
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
    // No removedChoice gate -- cleanupRemovedMembershipRules already filters removedResults down to
    // real 'removed'/'already-removed' entries itself (see its own header comment), so calling it
    // unconditionally here correctly does nothing when every removed mod was kept.
    //
    // Settle pause (2026-08-28, director-requested) -- a plain delay before this function's own read
    // AND write, on top of the widened END_OF_APPLY_RETRY_OPTIONS budget already inside it. This is
    // the single call site structurally guaranteed to run immediately after the heaviest real work in
    // the whole apply (the Removed/Added loops just above), so giving Vortex's own background
    // processing a real head start here -- rather than only reacting to it via retries once the race
    // is already lost -- cuts down how often "Applied with some problems: Collection membership"
    // shows up at all.
    //
    // Gated on there being anything real to clean up (2026-08-28, live catch: a rules-only apply with
    // zero removed mods this run still paid the full pause for nothing) -- same eligibility check
    // cleanupRemovedMembershipRules itself already applies internally, so this never skips a case that
    // function would have actually acted on. Also covers refreshUpdatedMembershipRules below now
    // (2026-08-28) -- same settle-pause reasoning applies to it equally, so one shared gate/pause
    // covers both rather than paying it twice. Trimmed 15s -> 10s (2026-08-29, director's own ask
    // after a live run) -- the widened END_OF_APPLY_RETRY_OPTIONS budget on the reads/writes right
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

    // Final reconciliation pass (2026-08-30, director's own spec after a real live Vortex crash
    // mid-apply: "we should attempt to remove them again before we give the collection updated
    // successfully screen... just fix everything at the end then show collection updated - only show
    // the warning if you really cannot correct it the second attempt"). Runs ONCE, here, after every
    // other real-write step above has already had its full chance -- including the Remove step's own
    // already-generous END_OF_APPLY_RETRY_OPTIONS verify-retry (2 minutes). This is specifically for
    // a real crash that takes LONGER than that to recover from (confirmed live, 2026-08-30: Vortex was
    // still unreachable 17+ minutes later) -- rather than making the director manually finish the job
    // in Vortex's own UI, make one more real attempt now that Vortex has had the maximum possible time
    // to come back. Deliberately just ONE more attempt, not another open-ended retry loop -- see this
    // same header reasoning on END_OF_APPLY_RETRY_OPTIONS for why an ever-longer automatic wait is the
    // wrong fallback for a genuine outlier.
    //
    // MUST run here, before the collection.json merge below -- not after it (a real ordering bug
    // caught by the director's own follow-up question, "shouldn't re-running just correct itself,
    // that's what Vortex would do?": mergeSucceededResultsIntoMods only drops a mod from local
    // tracking when removedResults already reads ok:true, so if this retry ran AFTER that merge, a
    // mod this retry successfully removes would still show up as "needs removing" in local tracking
    // forever, and a genuinely still-failed one would incorrectly already be dropped -- either way,
    // the exact self-correcting behavior a fresh re-run is supposed to give you would never happen).
    await retryStillFailedRemovals(review, keepRemovedModIdSet, removedRowKey, removedResults, onProgress);
    await retryStillFailedDependencyAcknowledgements(dependencyBreaks, updatedResults, dependencyBreakResults, onProgress);

    // Collection membership-rule cleanup/refresh -- MUST run here, AFTER the retry pass above, not
    // before it (2026-08-31, real ordering bug found live: diagnostics/2026-08-30-real-apply-
    // marathon-findings.md finding #6). This used to run right after the main Removed/Updated loops,
    // before retryStillFailedRemovals/retryStillFailedDependencyAcknowledgements had a chance to flip
    // a mod's removedResults/updatedResults entry from ok:false to ok:true. Both cleanupRemoved-
    // MembershipRules and refreshUpdatedMembershipRules only ever act on entries already showing
    // ok:true (`action:'removed'`/`'already-removed'` or a real update) -- so a mod that only
    // succeeded on the LATER retry was never eligible when cleanup ran too early, leaving its OLD
    // `requires` rule (fileId/version pinned to the file that's no longer installed) sitting
    // alongside -- or in place of -- the correct current one. Vortex's own native "View Collection"
    // page reads these `requires` rules directly for its Download-pending/Install state, so a stale
    // one kept re-prompting for a file already replaced or removed. Live-confirmed real case: "Cloud
    // Shadows" initially failed removal (blocked by the "Mod not found" dialog earlier this same
    // session), succeeded only via the retry pass below the OLD call site -- and its stale rule was
    // still sitting there afterward, exactly matching this mechanism. Same "MUST run after the retry
    // pass" reasoning mergeSucceededResultsIntoMods below already documents for the exact same class
    // of bug -- this is the other place that same fix needed to land and didn't, until now.
    const hasEligibleMembershipCleanup = removedResults.some((r) => r.ok === true && (r.action === 'removed' || r.action === 'already-removed'));
    const hasEligibleMembershipRefresh = updatedResults.some((r) => r && r.ok === true);
    if (hasEligibleMembershipCleanup || hasEligibleMembershipRefresh) {
        onProgress({ type: 'phase', message: 'Updating large collections in Vortex can take some time. Please be patient while the process completes.' });
        await sleep(10_000);
    }
    const removedMembershipCleanup = await cleanupRemovedMembershipRules(collectionModId, review.removed, removedResults);
    const updatedMembershipRefresh = await refreshUpdatedMembershipRules(collectionModId, review.updated, updatedResults, effectiveNewByOld);

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
    // Cycle-safe rules skip (2026-09-01, director's own explicit safeguard, live-caught mid-test:
    // "if we pop up a cycle warning, the user then fixes the cycles and hits retry deploy or deploy
    // again, we need to make sure we are not running the rules again, otherwise it will put the
    // cycles right back in place... we need to track too if a cycle is generated by the rules and
    // if so, not to re-do them." The in-screen "Retry Deploy" button was already safe (it only ever
    // calls deploy-all, never re-enters runApply at all) -- this closes the OTHER path: a later
    // "Continue update" pass, which unconditionally re-applies review.modRules every time by design.
    // Re-writing the IDENTICAL rules a second time would recreate the exact cycle the director (or
    // Cycle Helper) just manually resolved in Vortex, trapping "fix cycle -> retry -> rules
    // reapplied -> same cycle back" in a loop. Scoped to this EXACT revision (rulesCycleRevision) --
    // a future real revision bump gets a genuinely fresh attempt, never permanently locked out.
    let rulesCycleDetected = false;
    let rulesCycleRevision = null;
    let skipRulesReapply = false;
    try {
        const priorStatusPath = path.join(getUcv2TrackingDir(collectionModId), 'ucv2-apply-status.json');
        if (fs.existsSync(priorStatusPath)) {
            const prior = JSON.parse(fs.readFileSync(priorStatusPath, 'utf8'));
            if (prior && prior.rulesCycleDetected === true && String(prior.rulesCycleRevision) === String(review.newRevisionNumber)) {
                skipRulesReapply = true;
                rulesCycleDetected = true;
                rulesCycleRevision = prior.rulesCycleRevision;
            }
        }
    } catch { /* can't tell -- don't skip on an unreadable record, same "fail open to the real work" convention as everything else here */ }

    let modRulesResult = { modsChanged: [], totalRulesWritten: 0, unresolvedCount: 0 };
    if (skipRulesReapply) {
        onProgress({ type: 'phase', message: 'Skipping collection rules (already applied -- a rule cycle was resolved manually since)…' });
    } else if (review.modRules && review.modRules.length > 0) {
        onProgress({ type: 'phase', message: 'Applying collection rules…' });
        modRulesResult = await applyModRulesFresh(review.modRules);
        // Real, live-confirmed check (2026-09-01): did applying THESE rules leave the full live rule
        // graph with a cycle in it? Same detection this file already trusts elsewhere
        // (retryStillFailedRemovals's own pre-retry gate) -- a whole-graph check, not scoped to only
        // this collection's own rules, since a cycle blocks deploy regardless of which rules formed
        // it. Recorded below in the SAME final status write as revisionApplied/cleanApply (not a
        // separate write here) so an earlier write in this function can never clobber a later one.
        if (review.modRules.length > 0) {
            const postRulesData = await timedGetAllMods('runApply-postRulesCycleCheck');
            if (checkForRuleCycles(postRulesData)) {
                rulesCycleDetected = true;
                rulesCycleRevision = review.newRevisionNumber;
            }
        }
    }

    // Disabled restoration -- run ONLY after every Updated/Removed mod has finished, mirroring
    // Classic's own "fix up enabled state after the real install work is done" ordering (its own
    // applyDisables step runs after Vortex's native Resume finishes, for the same reason: correcting
    // state makes sense once the thing that could have disturbed it is done, not mid-flight). Only
    // touchedVortexModIds (mods this apply's Updated loop actually force-enabled via deployMod(...,
    // true) above) are candidates -- see the header comment above the Updated loop for why untouched
    // mods are deliberately left alone.
    //
    // setModEnabled alone is enough now (2026-08-27) -- deployMod(false) used to be needed too (a
    // real, live finding, 2026-08-18: deploy-single-mod's own `enable` flag only controls file-
    // linking, never a mod's PROFILE-level Disabled flag), but with no per-mod deploy happening
    // anywhere in this apply anymore, there's no stray file-link left over to un-link here -- the
    // final, explicit Deploy step (the Apply Result screen's own button, POST /deploy-all) links
    // whatever the profile currently marks enabled, which by the time THAT runs already correctly
    // excludes this mod.
    const disabledResults = [];
    for (const d of backupSnapshot.disabled) {
        if (!d.vortexModId || !touchedVortexModIds.has(d.vortexModId)) continue;
        try {
            const enabledOk = await helperClient.setModEnabled(d.vortexModId, false);
            disabledResults.push({ name: d.name, ok: enabledOk, action: 'disabled-restored' });
        } catch (e) {
            disabledResults.push({ name: d.name, ok: false, action: 'disabled-restored', error: e.message });
        }
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
    // reasoning as the collection.json replace further below.
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
        updated: review.updated, updatedResults, effectiveNewByOld,
        // otherBucketsClean (2026-09-01) -- everything THIS apply touched EXCEPT removed/updated,
        // snapshotted so quickVerifyAndFinalize below can cheaply re-derive coreApplyClean later
        // without needing to redo any of these checks itself -- only removed/updated ever need a
        // fresh live re-check (those are the buckets a real Vortex-side timeout can leave in a
        // stale "failed" state after the underlying work actually finished). deletedArchiveResults
        // deliberately excluded -- see coreApplyClean's own header comment just below for why.
        otherBucketsClean: addedResults.every((r) => r.ok !== false) && disabledResults.every((r) => r.ok !== false)
            && dependencyBreakResults.every((r) => r.ok !== false)
            && collectionAttributesUpdated && !modRulesResult.error
            && removedMembershipCleanup.ok !== false && updatedMembershipRefresh.ok !== false,
    });

    // Tracked apply outcome (2026-09-01, "Re-check on an already-clean collection is confusing" fix,
    // Tier 1) -- persisted next to collection.json, so the Pick-a-collection screen can trust THIS
    // TOOL's own record of "did the apply we just ran genuinely finish clean" instead of re-deriving
    // it from live Vortex state every time. Named plainly (no slug prefix -- every collection already
    // has its own unique staging folder, so nothing else could collide here). Checks EVERY real result
    // bucket this apply touched, not just the obvious ones -- a Re-check button silently hidden on a
    // genuinely-incomplete apply would be a real regression, worse than showing one unnecessarily.
    // collectionJsonUpdated is folded in below, AFTER the replace attempt just underneath -- see that
    // block's own header comment.
    //
    // deletedArchiveResults deliberately excluded from "clean" (2026-09-01, director's own explicit
    // correction, live-caught): a failed archive delete is never something a real re-apply -- i.e.
    // "Continue update" -- could actually fix. Confirmed live: "no archive among 51 same-size
    // candidates matches this mod's own md5" is a permanent, genuine ambiguity this tool correctly
    // refuses to guess through -- re-running the exact same apply hits the exact same ambiguity
    // every time, forever. Blocking cleanApply/collection.json finalization on it meant a
    // collection that was otherwise 100% correctly installed kept showing "Continue update" with
    // literally nothing left that a re-apply could accomplish -- director's own words: "we have to
    // check that a Continue update is absolutely needed - if nothing needs to be done, it's done."
    // Still surfaced to the director as a real, if minor, problem (deletedArchiveResults is
    // unchanged in the return value below and Apply Result's own summary still lists it) -- just no
    // longer treated as blocking the collection's own overall completeness.
    //
    // modRulesResult.unresolvedCount also deliberately excluded (2026-09-01, real bug caught live:
    // a fully successful GTS Legacy Lite apply -- 3 updated, 2 added, 6 rules set, nothing else
    // wrong -- still reported "didn't finish completely" with NO problem ever shown, because
    // nothing on the frontend even checks this field). applyCollectionModRules's own header comment
    // is explicit that a nonzero unresolvedCount is normal, not a failure: "a rule whose source or
    // target mod isn't currently installed... is silently skipped -- expected, not an error;
    // counted in unresolvedCount for transparency." Gating cleanliness on it being zero contradicted
    // that function's own documented design. A GENUINE rules failure (modRulesResult.error -- e.g.
    // couldn't re-read Vortex's live mod list) still blocks cleanliness; only the informational
    // skip-count no longer does.
    const applyResultBuckets = [
        ...updatedResults, ...removedResults, ...addedResults, ...disabledResults,
        ...dependencyBreakResults,
    ];
    const coreApplyClean = applyResultBuckets.every((r) => r.ok !== false)
        && collectionAttributesUpdated && !modRulesResult.error
        && removedMembershipCleanup.ok !== false && updatedMembershipRefresh.ok !== false;

    // Replace local collection.json with the pristine new revision -- ONLY once everything else above
    // has genuinely finished clean, and as a straight byte-for-byte copy of what was downloaded from
    // Nexus (newCollectionJsonRaw, captured back in reviewUpdateCoreUncached), never a hand-rebuilt
    // merge (2026-09-01, director's own explicit correction, replacing the ORIGINAL 2026-08-18 design
    // this whole area used to have -- see git history for mergeSucceededResultsIntoMods if ever
    // needed): "we NEVER change the collection.json file - never, it's read only... it belongs to the
    // mod author and it's our tool to refer to see how the collection should be set up", "Vortex uses
    // it too" (a native Vortex re-download of this same collection must see exactly what IT would have
    // written, never a patched copy this tool invented), and "if we update a collection, at the end of
    // the day, the collection.json should be 100% identical to the original". A companion/add-on
    // collection layering on top later (changing FOMOD picks or rules for a shared mod), or a manual
    // Vortex change, is expected to make this file read stale over time -- that's fine, not something
    // this tool ever tries to correct (see computeNeedsRecheck's own header comment for the fuller
    // design writeup); it's ONLY this tool's own local collection.json write that must never diverge
    // from the real, downloaded original.
    //
    // Deliberately gated on coreApplyClean, not attempted unconditionally: if the apply is only
    // PARTIALLY done, the OLD local collection.json (still the previous, fully-completed revision) is
    // exactly what a "Continue update" re-review needs to keep diffing against to find what's still
    // left -- replacing it here with the new revision's content while real work remains undone would
    // make a future review compare the new revision against ITSELF, hiding the real gap. On a genuinely
    // clean apply, replacing is safe and correct: this collection's own local record now legitimately
    // IS this new revision, verbatim.
    let collectionJsonUpdated = false;
    if (coreApplyClean) {
        try {
            const collectionJsonPath = collection.collectionJsonPath;
            const currentRaw = fs.readFileSync(collectionJsonPath, 'utf8');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            // Backup snapshot written to this tool's OWN tracking folder, NOT next to collection.json
            // in staging (2026-09-01, see getUcv2TrackingDir's own header comment for the full real
            // reasoning) -- only the actual collection.json write below still touches staging, and
            // that's the one write this tool is allowed to make there.
            fs.writeFileSync(path.join(getUcv2TrackingDir(collectionModId), `pre-update-${stamp}.json`), currentRaw);
            fs.writeFileSync(collectionJsonPath, newCollectionJsonRaw);
            collectionJsonUpdated = true;
        } catch (e) {
            // Non-fatal -- the real Vortex-side work above already happened and is real/correct
            // regardless; a stale local collection.json just means the next Check for Updates would
            // show a wrong/stale diff, an annoyance to fix by hand, not data loss.
            console.error(`[update-collection-v2-runner] failed to replace local collection.json after apply: ${e.message}`);
        }
    }
    const cleanApply = coreApplyClean && collectionJsonUpdated;
    try {
        const statusPath = path.join(getUcv2TrackingDir(collectionModId), 'ucv2-apply-status.json');
        fs.writeFileSync(statusPath, JSON.stringify({
            revisionApplied: review.newRevisionNumber, cleanApply, appliedAt: new Date().toISOString(),
            // rulesCycleDetected/rulesCycleRevision (2026-09-01) -- see the modRules block's own
            // header comment above for the full "why". Written here, in the SAME final record, so an
            // earlier partial write inside this same run can never get clobbered by this one.
            rulesCycleDetected, rulesCycleRevision,
        }, null, 2));
    } catch (e) {
        // Non-fatal -- same "the real work already happened" reasoning the collectionJsonUpdated
        // write above already uses. A failed write here just means computeNeedsRecheck finds no
        // record next time and reads as "never touched" -- not a false alarm.
        console.error(`[update-collection-v2-runner] failed to write apply-status record: ${e.message}`);
    }

    // APPLY END -- pairs with the APPLY START marker above (same collectionModId), one line
    // summarizing per-bucket ok/failed counts so a skim of the log answers "did this apply actually
    // finish clean" without opening the frontend or replaying every SSE event.
    const countFails = (arr) => (arr || []).filter((r) => r.ok === false).length;
    console.log(`[update-collection-v2-runner] APPLY END collectionModId="${collectionModId}" (${Date.now() - t_applyStart}ms) `
        + `updated=${(updatedResults || []).length - countFails(updatedResults)}ok/${countFails(updatedResults)}fail `
        + `added=${(addedResults || []).length - countFails(addedResults)}ok/${countFails(addedResults)}fail `
        + `removed=${(removedResults || []).length - countFails(removedResults)}ok/${countFails(removedResults)}fail `
        + `membershipCleanup=${removedMembershipCleanup && removedMembershipCleanup.ok !== false} membershipRefresh=${updatedMembershipRefresh && updatedMembershipRefresh.ok !== false} `
        + `collectionJsonUpdated=${collectionJsonUpdated} coreApplyClean=${coreApplyClean}`);
    // Names every real failure (not just the count above) -- the actual per-mod push sites for
    // updated/added/removed are scattered across many branches in this file, too many to instrument
    // individually without a lot of churn; naming failures here in one place, right where every
    // bucket's final array already exists, gets the same debugging value with a single, low-risk
    // addition instead of dozens of scattered ones.
    for (const [label, arr] of [['updated', updatedResults], ['added', addedResults], ['removed', removedResults]]) {
        (arr || []).filter((r) => r.ok === false).forEach((r) => {
            console.warn(`[update-collection-v2-runner] APPLY FAILURE (${label}) collectionModId="${collectionModId}" mod="${r.name}": ${r.error || r.status || '(no error detail recorded)'}`);
        });
    }

    return {
        collectionName: review.collectionName, newRevisionNumber: review.newRevisionNumber,
        backupPath, updatedResults, removedResults, disabledResults, deletedArchiveResults,
        dependencyBreakResults, modRulesResult, addedResults, collectionJsonUpdated,
        // Exposed separately (2026-09-01, director's own catch: "how can we have an error writing to
        // our own file?" -- a fair question, since collectionJsonUpdated alone can't tell the
        // frontend WHY it's false. The common case isn't a write error at all -- it's this apply
        // genuinely not finishing clean, so the replace was correctly never attempted (see the
        // "Replace local collection.json" comment above). A GENUINE write failure is coreApplyClean
        // true but collectionJsonUpdated still false -- see ucv2RenderApplyResult's own use of this.
        coreApplyClean,
        removedMembershipCleanup, updatedMembershipRefresh, collectionAttributesUpdated, collectionAttributesError,
        isOwnCollection,
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

// Bounded-concurrency map -- same proven shape as archive-finder-scanner.js's own local `pool()`
// helper (identical "bulk listArchive calls" use case there), reimplemented here rather than
// imported to avoid a cross-feature module dependency for a single 10-line utility. Runs `worker`
// over `items` with at most `concurrency` in flight at once, preserving `items`' own order in the
// returned array (unlike a raw Promise.all over a `.map`, which fires every call simultaneously --
// see this function's own call site for the real hang that caused).
async function poolMap(items, concurrency, worker) {
    const results = new Array(items.length);
    let idx = 0;
    async function runNext() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await worker(items[i]);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
    await Promise.all(workers);
    return results;
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
// Timing wrapper (2026-08-29, director's own ask -- "how many times are we calling getAllMods, and
// how long does each one take") -- this project's own code already documented the real cost of this
// call (a ~46MB /mods payload, see this function's own callers' comments), but never actually
// MEASURED it live. Every call site below that reads the whole live mod list now goes through this,
// labeled per call site, so the real per-call latency (and how it changes as the install's own total
// mod count grows) is visible in the server log instead of just inferred. Logs to console (this
// project's own real app log, not a separate file) so it shows up in the same place every other
// [update-collection-v2-runner] log line already does.
async function timedGetAllMods(label) {
    const startedAt = Date.now();
    console.log(`[update-collection-v2-runner] getAllMods(${label}) -- started ${new Date(startedAt).toISOString()}`);
    const result = await helperClient.getAllMods();
    const ms = Date.now() - startedAt;
    console.log(`[update-collection-v2-runner] getAllMods(${label}) -- ${result ? 'finished' : 'failed (null)'} ${new Date().toISOString()} (${ms}ms)`);
    return result;
}

async function withHelperRetry(fn, { attempts = 3, delayMs = 3000 } = {}) {
    let result;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        result = await fn();
        if (result) return result;
        if (attempt < attempts) await sleep(delayMs);
    }
    return result;
}

// Real, live-confirmed incident (2026-09-01, director-caught, live-reproduced): a plain
// `withHelperRetry(() => helperClient.removeMods(ids))` blindly re-dispatches the EXACT same batch on
// every retry, with nothing checked in between. removeMods's own header comment already flagged this
// as a real, open risk ("the one bounded network-failure retry could in principle re-issue this call
// after the FIRST attempt actually already succeeded server-side but the response was lost") --
// confirmed for real this session: a real apply against GTS Community Edition sat in sustained Helper
// timeouts (every single call failing for 2+ minutes straight, main-thread congestion, not a brief
// blip), during which THREE separate top-level removeMods dispatches went out roughly 30s apart (the
// app log shows it plainly). Vortex's own dispatch runs synchronously before it ever writes a
// response, so an EARLIER attempt can genuinely finish the real removal server-side while our client
// is still timing out waiting on it -- a LATER blind retry then hits a mod whose staging is already
// gone, and Vortex's own code throws its real, blocking "Mod not found" modal (reproduced live,
// screenshot confirmed: "The mod you're removing has already been deleted on disk").
//
// The fix: re-check LIVE state before every retry, and DROP any modId that's already gone (not live,
// or live but with no real staging content left) from the next dispatch instead of blindly resending
// it -- a dropped id is folded into the success list, since "already gone" is exactly what a genuine
// removal produces. Only ever shrinks the retry batch, never grows it. Scoped to the real removeMods
// path specifically (not removeModsRecordOnly, which never attempts a real undeploy and so was never
// the one that could trigger this dialog in the first place -- see that call site's own comment).
//
// Worst-case backup, same director-caught incident: BEFORE every attempt (including the first),
// check whether Vortex is CURRENTLY showing a blocking dialog at all -- getDeployAllProgress's own
// externalChangesPending/blockingDialogs fields, a real, already-proven-live signal (see
// diagnostics/2026-08-28-helper-live-vortex-events-spec.md's own "Result" section -- confirmed to
// answer correctly even DURING a real blocking dialog, and independent of whether an actual deploy is
// running; the read itself always carries these signals). If one is up, dispatching another removeMods
// call is pointless (Vortex's main thread can't act on it) and risks queuing a second conflicting
// operation behind whatever's already stuck -- stop immediately with a clear, actionable reason
// instead of burning the whole retry budget against a wall Vortex has already put up.
async function removeModsVerifiedRetry(idsWithMeta, staging, { attempts = 3, delayMs = 3000 } = {}) {
    let remaining = idsWithMeta.slice();
    const confirmedRemoved = [];
    for (let attempt = 1; attempt <= attempts && remaining.length > 0; attempt += 1) {
        const progress = await helperClient.getDeployAllProgress();
        if (progress && (progress.externalChangesPending || (progress.blockingDialogs && progress.blockingDialogs.length > 0))) {
            const title = progress.blockingDialogs && progress.blockingDialogs[0] && progress.blockingDialogs[0].title;
            return {
                removed: confirmedRemoved, stillRemaining: remaining,
                blockedReason: title
                    ? `Vortex is waiting on you -- check its window (${title}) before continuing.`
                    : 'Vortex is waiting on you -- check its window before continuing.',
            };
        }
        const ok = await helperClient.removeMods(remaining.map((m) => m.vortexModId));
        if (ok) return { removed: [...confirmedRemoved, ...remaining], stillRemaining: [] };
        if (attempt >= attempts) break;
        await sleep(delayMs);
        const freshData = await timedGetAllMods('runApply-removeRetryRecheck');
        if (!freshData) continue; // couldn't read live state -- don't guess, just retry the same set next round
        const stillNeeded = [];
        for (const m of remaining) {
            const liveMod = freshData.mods[m.vortexModId];
            if (!liveMod) { confirmedRemoved.push(m); continue; } // gone from live entirely -- an earlier attempt already removed it for real
            const stillHasStaging = !!(liveMod.installationPath && stagingHasRealFiles(path.join(staging, liveMod.installationPath)));
            if (!stillHasStaging) { confirmedRemoved.push(m); continue; } // no real files left -- nothing left for a retry to safely act on
            stillNeeded.push(m);
        }
        remaining = stillNeeded;
    }
    return { removed: confirmedRemoved, stillRemaining: remaining };
}

// Widened retry budget for END-OF-APPLY verification reads specifically (2026-08-27, director-
// requested breathing room, after a real live failure): applyModRulesFresh's own getAllMods() call,
// applyCollectionModRules' per-mod getLiveRulesForMod() call, and cleanupRemovedMembershipRules'
// getLiveRulesForMod(collectionModId) call all run AFTER the Updated/Removed/Added loops have
// already fired off a large batch of real work (undeploy, extraction, dozens of Redux dispatches).
// Vortex's own real background processing of all that can keep running well past the moment OUR
// call sequence reaches this step -- confirmed live: a real apply's membership-cleanup AND
// conflict-rules reads both failed under the STANDARD withHelperRetry budget (3 attempts, 3s delay,
// ~20s total) while Vortex was still genuinely catching up MINUTES later (a real ~10-minute
// main-thread block was observed the same session). Widening this to ~2 minutes of real patience
// covers the common case without silently hanging forever -- a stall longer than this still needs
// the Apply Result screen's own per-problem Retry button, which is the correct place for a true
// outlier, not an ever-longer automatic wait.
//
// Deliberately NOT the new global default for withHelperRetry -- every OTHER call in this file runs
// mid-loop, where a real, permanent failure should still surface in a reasonable ~20s, not be
// mistaken for "Vortex is just catching up" for two full minutes. This widened budget is scoped
// specifically to the three read call sites named above, the only ones structurally guaranteed to
// run right after Vortex's heaviest real work in the whole apply.
const END_OF_APPLY_RETRY_OPTIONS = { attempts: 8, delayMs: 15_000 };

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
    const data = await withHelperRetry(() => timedGetAllMods('verifyModLiveState'));
    if (!data) return { registered: false, enabled: false };
    return { registered: !!data.mods[modId], enabled: data.enabledModKeys.includes(modId) };
}

// Only still needed by verifyModDeployedOnDisk below (2026-08-27: every OTHER per-mod deploy in
// runApply's own main loops was removed -- deploy is now the explicit, standalone step the Apply
// Result screen's own button triggers (POST /deploy-all) -- but retryModExtraction's own single-mod
// recovery path still deploys that ONE mod directly, out of scope for this change).
const PLUGIN_EXTENSIONS = new Set(['.esp', '.esm', '.esl']);
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

// General collection-membership health check + fix (2026-08-27, director-requested, wired into the
// Deploy button) -- checks EVERY mod this collection's OWN current on-disk collection.json says
// should be a member against Vortex's real live state, and fixes any that are registered but not
// Enabled and/or not linked as a collection member. General, not scoped to "whatever the last apply
// just added" -- re-derives from the collection's own current record every time it's called, so it
// also catches drift from an EARLIER interrupted apply this session, not just the most recent one.
// Real motivating case: the 2026-08-27 batchDispatch bug (see vortex-collection-helper's own
// applyRuleChangesBatch/setModsEnabledBatch header comments) left a whole apply's worth of newly-
// Added mods registered but silently missing both writes -- this is the general-purpose recovery for
// exactly that class of gap, offered as a pre-Deploy check instead of requiring N individual per-mod
// Retry clicks (which, for an Added mod, would route through retryModExtraction and RE-EXTRACT/
// RE-REGISTER it from scratch -- overkill and a real duplicate-registration risk for a mod that's
// already correctly installed and just needs these two flags fixed).
//
// Deliberately NEVER calls createMod, NEVER re-extracts, NEVER touches staging/Data -- a mod that
// doesn't resolve to a live Vortex modId at all is skipped outright (that's a genuine registration
// failure, a different problem this function doesn't attempt to solve). Two Helper reads up front
// (GET /mods, GET /rules/:collectionModId), then at most one batched write each for whatever's
// actually wrong -- cheap regardless of collection size, and a true no-op (zero writes) when
// everything's already correct.
async function fixCollectionMembershipGaps({ collectionModId, staging }) {
    let mods;
    let modRules;
    try {
        const collectionJsonPath = path.join(staging, collectionModId, 'collection.json');
        const raw = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
        mods = raw.mods || [];
        modRules = raw.modRules || [];
    } catch (e) {
        return { ok: false, checked: 0, fixedEnabled: 0, fixedMembership: 0, error: `Couldn't read this collection's own record: ${e.message}` };
    }

    const data = await withHelperRetry(() => timedGetAllMods('fixCollectionMembershipGaps'), END_OF_APPLY_RETRY_OPTIONS);
    if (!data) return { ok: false, checked: 0, fixedEnabled: 0, fixedMembership: 0, error: "Couldn't read Vortex's live mod list." };
    const matcher = buildLiveIdentityIndex(data.mods);
    const enabledSet = new Set(data.enabledModKeys);

    const rules = await withHelperRetry(() => helperClient.getLiveRulesForMod(collectionModId), END_OF_APPLY_RETRY_OPTIONS);
    const memberIdentities = new Set(
        (rules || [])
            .filter((r) => r.reference && r.reference.repo)
            .map((r) => `${r.reference.repo.modId}:${r.reference.repo.fileId}`),
    );

    const needsEnable = [];
    const needsMembership = [];
    // Real identities (modId:fileId), not just a count (2026-08-30, director-caught real gap): the
    // frontend's Optional Mods Gate reads a review snapshot taken BEFORE this call ever ran, so an
    // optional mod this call just associated (Skyshards Framework/DLCs -- already installed, just
    // needed the membership rule this function's own needsMembership push already handles) still
    // showed up as "available" in that stale snapshot's optionalMods, offering to install something
    // already done. Returned here so the frontend can subtract exactly these from that stale list
    // before rendering the gate, rather than re-deriving membership itself.
    const fixedMembershipIdentities = [];
    let checked = 0;
    for (const m of mods) {
        const vortexModId = resolveLiveModId(matcher, m.source);
        if (!vortexModId) continue; // not actually registered -- a real Retry (per-mod) covers this, not this function
        checked += 1;
        if (!enabledSet.has(vortexModId)) needsEnable.push({ modId: vortexModId, enable: true });
        if (m.source && m.source.modId && m.source.fileId
            && !memberIdentities.has(`${m.source.modId}:${m.source.fileId}`)) {
            // Optional mods get `ignored: true` (2026-08-30, see buildCollectionMembershipRule's own
            // header comment for the full real-Vortex-convention reasoning) -- this is exactly the
            // live-confirmed "already installed, never freshly installed by this apply" case
            // (Skyshards Framework: live-matched here purely by identity, but this collection's own
            // rules never referenced it -- most often because it was installed independently, or its
            // own Added-mod pass never ran/was declined). Scoped to optional (`recommends`) mods only
            // for now -- a REQUIRED mod hitting this same gap already goes through the main Added/
            // Updated loops' own stricter existingVortexModId verification first, and marking a
            // REQUIRED member `ignored` is a stronger claim (Vortex treats it as "this dependency is
            // permanently resolved, never re-check it") that hasn't been live-verified for that case.
            needsMembership.push({ modId: collectionModId, add: buildCollectionMembershipRule(m, m, { ignored: !!m.optional }) });
            fixedMembershipIdentities.push({ modId: m.source.modId, fileId: m.source.fileId });
        }
    }

    let enableOk = true;
    if (needsEnable.length > 0) {
        const results = await withHelperRetry(() => helperClient.setModsEnabledBatch(needsEnable), END_OF_APPLY_RETRY_OPTIONS);
        enableOk = Array.isArray(results) && results.every((r) => r.ok === true);
    }
    let membershipOk = true;
    if (needsMembership.length > 0) {
        const results = await withHelperRetry(() => helperClient.applyRuleChangesBatch(needsMembership), END_OF_APPLY_RETRY_OPTIONS);
        membershipOk = Array.isArray(results) && results.every((r) => r.ok === true);
    }

    // Per-mod conflict/load-order rules too (2026-08-27, director-requested: "if any of the 11 mods
    // have rules set - check they are correct") -- this collection's own author-written modRules
    // (before/after ordering between specific mods, separate from the membership rules above), the
    // SAME real operation runApply's own main flow already runs via applyModRulesFresh, reused here
    // unchanged rather than re-implemented. Idempotent by construction (computeUpsertOp only writes
    // what's actually missing/different from each mod's CURRENT rules), so calling this on a
    // collection that's already fully correct is a real no-op, not a redundant write. Reuses the
    // SAME matcher/data.mods already fetched above -- no extra GET /mods call.
    let modRulesResult = { modsChanged: [], totalRulesWritten: 0, unresolvedCount: 0 };
    if (modRules.length > 0) {
        modRulesResult = await applyCollectionModRules(modRules, matcher, data.mods);
    }
    // applyCollectionModRules never sets a top-level error -- a failure always shows up as an
    // individual modsChanged[i].ok === false entry instead (see its own return above).
    const modRulesOk = modRulesResult.modsChanged.every((r) => r.ok !== false);

    return {
        ok: enableOk && membershipOk && modRulesOk,
        checked, fixedEnabled: needsEnable.length, fixedMembership: needsMembership.length,
        // Only the ones that genuinely succeeded -- a failed membershipOk write means these mods are
        // NOT actually associated yet, so the frontend must keep offering them in the Gate rather than
        // silently dropping them because a write it never confirmed happened.
        fixedMembershipIdentities: membershipOk ? fixedMembershipIdentities : [],
        modRulesResult,
        error: (!enableOk || !membershipOk)
            ? "Some mods still couldn't be enabled or linked to the collection -- check Vortex's own log."
            : (!modRulesOk ? "Some mods' own load-order rules couldn't be confirmed -- check Vortex's own log." : null),
    };
}

// Resolves a NEW collection.json mod entry's own archive to its real, live download record id
// (state.persistent.downloads.files key) so the metadata refresh above can correctly update
// archiveId -- otherwise Clean Up's own orphan-detection (buildModLookup's usedArchiveIds) would
// keep pointing this mod at its OLD, no-longer-current archive. Matches by localPath against the
// archive filename classifyMod/locateArchive already resolved during extraction, reusing the exact
// same identity philosophy Clean Up's own buildDownloadLookup established (this project's own data,
// not a new concept). Returns null (best-effort) if no matching download record is found or the
// helper read fails -- the metadata refresh still proceeds for every OTHER field either way.
// Returns { archiveId, fileVersion } | null (2026-08-27, widened from a bare archiveId string --
// real, director-caught gap: this project used to write `attributes.version` straight from
// collection.json's own recorded version string, which can genuinely differ from the actual
// downloaded archive's own real Nexus file metadata (confirmed live: collection.json recorded
// "1.2" for a mod whose real download record's own modInfo.meta.fileVersion is "1.2.0"). Real
// Vortex's own InstallManager never has this mismatch because it always derives a mod's
// attributes.version from the SAME download metadata it uses everywhere else -- never a second,
// independent source. Vortex's own Mods table Version dropdown lists BOTH strings as if they were
// two different available versions once they disagree, and only the one matching the download
// record's own real fileVersion gets a working "Open Archive" -- confirmed live, the "1.2" entry
// had no Open Archive option, "1.2.0" did. Callers should prefer fileVersion over their own
// collection.json-sourced version string whenever a real download match is found (see the Updated/
// Added loops' own attrs.version below); fall back to the collection's own recorded version only
// when no match exists at all (an off-Nexus/bundle mod, or a genuinely missing archive).
// Return contract (2026-08-29, real root-cause fix -- see diagnostics/2026-08-29-orphaned-download-
// duplicates-investigation.md for the full live investigation this closes): a match returns
// {archiveId, fileVersion}; a CONFIRMED no-match (the downloads list was read successfully and
// genuinely has nothing with this md5) returns null; a read that FAILED (helper timeout/error --
// the same real Vortex-congestion pattern documented throughout this session's own server logs)
// returns undefined. Callers MUST NOT treat undefined the same as null -- doing so is exactly how
// this bug produced real, duplicate download registrations for the same file across separate
// applies: a fetch that failed under load looked identical to "no existing download," so the caller
// minted a brand-new one every time, orphaning the one it had already registered earlier. Confirmed
// live: two "You Got Caught for OStim SA" downloads (and 4 other test-collection mods), same file
// (byte-identical fileMD5/fileId/localPath), registered under different ids on separate apply runs.
async function resolveDownloadIdForArchive(newMod, prefetchedDownloads) {
    // A bundle-type mod deliberately has no real md5 to match by (newMod.source.md5 is undefined --
    // see the Added-mod loop's own fileMD5 comment, ~line 1024). Real Vortex downloads lists can ALSO
    // genuinely contain entries with no computed fileMD5 of their own. Without this guard,
    // `file.fileMD5 === (newMod.source && newMod.source.md5)` compares `undefined === undefined` and
    // false-matches the FIRST such entry the loop happens to hit -- confirmed live, 2026-08-30:
    // MP_Melony.7z (bundle) picked up a completely unrelated download's own archiveId AND
    // fileVersion ("2.0.0", collection.json's own recorded version for it is ""). Same
    // undefined-equals-undefined false-match class the archiveId-collision fix above (this
    // function's own SECOND root-cause fix comment) already fixed for checkModVariantsExist's
    // comparison -- this is a THIRD instance, just missed here. See
    // diagnostics/2026-08-30-duplicate-version-cleanup-utility-scoping.md for the full investigation.
    const wantedMd5 = newMod.source && newMod.source.md5;
    if (!wantedMd5) return null; // nothing real to match by -- confirmed no match, not undetermined
    try {
        const data = prefetchedDownloads || await helperClient.getAllDownloads();
        if (!data) return undefined; // read failed -- NOT the same as "confirmed no match"
        for (const [downloadId, file] of Object.entries(data.files)) {
            if (file.fileMD5 === wantedMd5) {
                const fileVersion = file.modInfo && file.modInfo.meta && file.modInfo.meta.fileVersion;
                return { archiveId: downloadId, fileVersion: fileVersion || undefined };
            }
        }
        return null; // confirmed: read succeeded, genuinely nothing matches
    } catch {
        return undefined; // read failed -- NOT the same as "confirmed no match"
    }
}

// Root-cause fix (2026-08-28, live catch) -- resolveDownloadIdForArchive above can only match an
// archive VORTEX ITSELF already knows about (it only ever looks at Vortex's own real
// state.persistent.downloads.files). Every archive THIS tool downloads itself (allowAutoDownload's
// own direct Nexus API call, bypassing Vortex's download manager entirely) is therefore invisible
// to it -- resolveDownloadIdForArchive returns null, and the caller's own
// `...(archiveMatch ? {archiveId: archiveMatch.archiveId} : {})` spread OMITS archiveId from the
// new mod's attributes entirely. Confirmed live: a real apply that needed 11 fresh self-downloads
// (archives had just been wiped) produced 10 mods with no archiveId at all, and Vortex's own real
// Version-column grouping (InstallManager.ts's checkModVariantsExist: `mod.archiveId === archiveId`)
// then grouped ALL of them together as if they were "variants" of one another purely because
// `undefined === undefined` -- 10 completely unrelated real mods, spuriously shown as duplicate
// versions of each other. The one mod that DIDN'T show this already had a live record (reused via
// existingVortexModId, never touched this archiveId-resolution path at all).
//
// Fix: when resolveDownloadIdForArchive can't find it, register the archive we ourselves just
// downloaded into Vortex's own real downloads database (registerLocalDownload -- Vortex's own real
// "a file was found on disk that we weren't involved in downloading" mechanism, ADD_LOCAL_DOWNLOAD),
// giving it a genuine, unique, Vortex-recognized archiveId instead of leaving the field empty.
//
// SECOND root-cause fix (2026-08-29) -- see resolveDownloadIdForArchive's own header comment for the
// undefined/null distinction this relies on, and diagnostics/2026-08-29-orphaned-download-
// duplicates-investigation.md for the full live investigation. A `prefetchedDownloads` read that
// FAILED (undefined) now gets exactly one more fresh, non-cached attempt -- same "one more live read
// before giving up" resilience pattern this file already uses elsewhere (verifyModLiveState, the
// Added-mod batch registration retry) -- before this function will register anything. If it's STILL
// undetermined after that, this deliberately returns null WITHOUT registering a new download: doing
// so blind, on the mere assumption "must not exist yet," is exactly the bug that produced real
// duplicate registrations for the same file across separate applies (confirmed live: 5 of 9 real
// test-collection mods checked had at least one orphaned "finished" download nothing pointed to
// anymore, each byte-identical -- same md5/fileId/localPath -- to the one actually in use). Leaving
// archiveId unset for this one pass is a far cheaper, fully recoverable cost (a later apply, or a
// genuinely idle Vortex, gets another chance to resolve it) than minting a permanent duplicate.
// THIRD root-cause fix (2026-09-01, director-caught live, same session as the Bittercup membership-
// rule fix -- fresh, reproducible evidence, not historical debt): the two "one more fresh read"
// resolveDownloadIdForArchive calls above only ever match by fileMD5. Confirmed live: Vortex's OWN
// native downloader can independently register the SAME archive (e.g. the director's own concurrent
// interaction with Vortex's UI, or a background update check) moments before this function's own
// fallback runs -- a freshly-finished native download record can genuinely have no fileMD5 computed
// on it YET (Vortex hashes it slightly after registering, not atomically with it), so the md5-only
// check finds nothing, and this function proceeds to mint a SECOND, redundant registration
// (registerLocalDownload) for a file that already has a real, Vortex-native download entry -- caught
// red-handed: "GTS - Specific Patches" ended up with a Vortex-native download (real fileMD5,
// Vortex's own short-id format) AND our own UUID-format registration (fileMD5 undefined), 52 seconds
// apart, during the same apply. A filename match is immune to this -- the archive's own basename on
// disk doesn't depend on whether Vortex has finished hashing it yet.
async function resolveDownloadIdByLocalPath(archiveBasename, prefetchedDownloads) {
    try {
        const data = prefetchedDownloads || await helperClient.getAllDownloads();
        if (!data) return null;
        for (const [downloadId, file] of Object.entries(data.files)) {
            if (file.localPath === archiveBasename) return downloadId;
        }
        return null;
    } catch {
        return null;
    }
}

async function resolveOrRegisterArchiveId(newMod, downloadsDir, prefetchedDownloads) {
    let existing = await resolveDownloadIdForArchive(newMod, prefetchedDownloads);
    if (existing === undefined) {
        existing = await resolveDownloadIdForArchive(newMod, null); // one more real, FRESH read
    }
    if (existing) {
        console.log(`[update-collection-v2-runner] archiveId resolved by md5 for "${newMod.name}": ${existing.archiveId}`);
        return existing;
    }
    if (existing === undefined) {
        console.warn(`[update-collection-v2-runner] archiveId resolution undetermined for "${newMod.name}" (downloads read kept failing) -- leaving archiveId unset this pass.`);
        return null; // still undetermined -- do NOT register blind
    }
    try {
        const archivePath = await locateArchive(downloadsDir, newMod.source);
        const archiveBasename = path.basename(archivePath);
        // Final guard, filename-based, immediately before registering -- see this function's own
        // header comment above for exactly the live incident this closes.
        const byName = await resolveDownloadIdByLocalPath(archiveBasename, null);
        if (byName) {
            console.log(`[update-collection-v2-runner] archiveId resolved by filename (md5 not yet computed) for "${newMod.name}": ${byName} -- avoided a duplicate registration.`);
            return { archiveId: byName, fileVersion: undefined };
        }
        const stat = fs.statSync(archivePath);
        const id = crypto.randomUUID();
        const registeredId = await withHelperRetry(() => helperClient.registerLocalDownload(id, archiveBasename, stat.size));
        if (registeredId) {
            console.log(`[update-collection-v2-runner] registered a new local download for "${newMod.name}": ${registeredId} (${archiveBasename})`);
        } else {
            console.warn(`[update-collection-v2-runner] registerLocalDownload failed for "${newMod.name}" (${archiveBasename}) -- archiveId left unset this pass.`);
        }
        return registeredId ? { archiveId: registeredId, fileVersion: undefined } : null;
    } catch (e) {
        console.warn(`[update-collection-v2-runner] couldn't resolve/register an archiveId for "${newMod.name}": ${e.message}`);
        return null; // no archive found on disk, or registration failed -- same "no match" outcome the caller already handles
    }
}

module.exports = {
    listCollections, checkForUpdates, reviewUpdate, prepareApply, prepareApplyOptional, runApply,
    buildLiveIdentityIndex, resolveLiveModId, applyCollectionModRules, resolveReviewRevisions,
    findBrokenDependencies, findMissingAddedPrerequisites, buildInstalledModDeclarationIndex, isDeclaredSomewhereInstalled, buildIgnoredAnywhereIndex, isIgnoredAnywhere, stagingHasRealFiles, versionSatisfiesRequirement, isIdOnlyRef, isInstalledVersionNewer,
    buildNexusIdIndex, resolveLiveVersionForUpdatedMod,
    detectFomodChoiceNeed, detectFomodChoiceNeeds, buildFomodChoicesFromPicks, serveFomodImage,
    getCollectionsCache, refreshCollectionsCache, patchCollectionCacheRevision, setCollectionsCacheForTest,
    buildCollectionMembershipRule,
    retryModRules, retryCollectionAttributes, retryMembershipCleanup, retryUpdatedMembershipRefresh, retryModExtraction,
    fixCollectionMembershipGaps, quickVerifyAndFinalize,
    checkGameVersionMismatch, getInstalledGameVersion, resolveInstallInstructions,
    DEPLOY_BLOCKED_BY_CYCLES_MESSAGE, DEPLOY_BLOCKED_BY_CYCLES_CODE,
    // Exported for Duplicate Version Cleanup (lib/duplicate-version-cleanup.js, 2026-09-01) -- its
    // own reinstall step needs the SAME archiveId resolution/registration logic the Added-mod loop
    // above already uses (md5 match first, filename-fallback guard against a not-yet-hashed race),
    // not a forked copy of it.
    resolveOrRegisterArchiveId,
};
