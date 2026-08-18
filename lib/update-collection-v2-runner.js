'use strict';
// Framework-agnostic orchestration for Update Collection v2 (Phase 1: read-only Check for Updates +
// Review, no real apply/deploy yet) -- used by web/update-collection-v2-routes.js. See
// TECHNICAL.md's "Update Collection v2" section for the full design writeup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const syncRunner = require('./sync-runner');
const nexusCollectionDownload = require('./nexus-collection-download');
const { findSevenZip } = require('./sevenzip');
const { diffCollectionMods } = require('./collection-diff');
const helperClient = require('./vortex-helper-client');
const syncLib = require('./vortex-sync/lib');

const WORKER_PATH = path.join(__dirname, 'update-collection-v2-worker.js');
const OP_TIMEOUT_MS = 30_000;

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
    let newRevision;
    try {
        newRevision = await nexusCollectionDownload.fetchAndExtractCollectionJson({
            slug: info.collectionSlug, revisionNumber: null, destDir: tmpDir, sevenZipExe,
        });
    } finally {
        // extracted collection.json is re-read below before cleanup -- fs.rmSync only removes the
        // temp dir, the parsed data already lives in memory by then.
    }
    const newCollectionRaw = JSON.parse(fs.readFileSync(newRevision.collectionJsonPath, 'utf8'));
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const oldCollectionRaw = JSON.parse(fs.readFileSync(collection.collectionJsonPath, 'utf8'));
    const diff = diffCollectionMods(oldCollectionRaw.mods, newCollectionRaw.mods);

    return {
        collectionModId, collectionName: collection.liveName || collection.name,
        installedRevision: info.revisionNumber ?? null, newRevisionNumber: newRevision.revisionNumber,
        removed: diff.removed, updated: diff.updated, added: diff.added, source,
    };
}

module.exports = { listCollections, checkForUpdates, reviewUpdate };
