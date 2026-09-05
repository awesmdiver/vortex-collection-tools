'use strict';
// Standalone, single-mod extraction engine -- the "any tool can call this for one mod" capability
// Missing Masters needs (a mod whose staging folder is empty/hollow but whose source archive is
// still intact), reusing Rebuild Collection's own classify/extract/verify/swap engine completely
// UNCHANGED. See TECHNICAL.md's "Single-mod rebuild engine" section for the full design writeup.
//
// extract-mod.js (the child process rebuildMod() spawns) always re-reads collection.json from
// disk by mod name (collection-parser.js's loadCollection/findMod) -- it never accepts an in-memory
// mod object. Rather than touching that already-tested file, this writes a tiny synthetic
// single-mod "collection.json" ({ mods: [mod] }) to a temp file and points --collection at it.
//
// Threading: confirmed with the user this is a single-person tool -- the odds of a whole-collection
// Rebuild Collection run and a single-mod repair both touching the SAME mod at the SAME moment are
// negligible, so no new per-mod/per-folder lock exists here. The only guard is a plain read-only
// check against web/run-state.js's existing "a Rebuild Collection run is happening" flag -- refuse
// to start rather than risk two independent processes touching the same staging folder at once.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildModFromVortexState, buildModFromLiveData } = require('./build-mod-from-vortex-state');
const { classifyMod, rebuildMod } = require('./rebuild-mod');
const { findSevenZip } = require('./sevenzip');
const { resolveApiKey, downloadModArchive, checkPremiumStatus } = require('./nexus-mod-download');
const runState = require('../web/run-state');

// Nexus's own game-domain slug for this game -- same convention already established elsewhere in
// this project (web/rebuild-routes.js's nexusModUrl()), hardcoded since this toolkit is Skyrim SE
// specific throughout, same as GAME_ID='skyrimse' for state.v2 keys.
const NEXUS_GAME_DOMAIN = 'skyrimspecialedition';

// liveMods (2026-08-18): optional `data.mods` object from the caller's own already-made
// vortexHelperClient.getAllMods() call -- when supplied, the mod lookup reads from that live,
// already-fetched data instead of opening state.v2 (buildModFromLiveData), so this whole function
// can run with Vortex genuinely open. A plain passed-in parameter rather than a separate
// `rebuildSingleModViaHelper` twin -- the mod lookup is the only step here that ever touches
// Vortex's own data, everything after it (classify/extract/verify/swap) is already
// source-agnostic, so duplicating the surrounding ~60 lines just to swap one lookup call would only
// add drift risk for no real benefit. `null`/omitted (the default) keeps the exact original
// state.v2-only behavior.
//
// mod (2026-08-18, Update Collection v2's own Phase 2): optional, already-built {name, source,
// choices} object, bypassing the vortexModId lookup (buildModFromVortexState/buildModFromLiveData)
// entirely when supplied. Exists for a genuinely different caller need than liveMods above: Missing
// Masters/Rebuild Collection want THIS mod's CURRENTLY-recorded state re-extracted (restoring a
// hollow install to what Vortex already thinks is installed); Update Collection v2 wants a NEW
// collection revision's own mod entry extracted into an EXISTING, already-registered staging slot
// (an actual version change, not a restore) -- collection.json's own raw mods[] entries already
// match this function's expected {name, source, choices} shape exactly, so the caller (see
// lib/update-collection-v2-runner.js's applyUpdate) passes one straight through. vortexModId is
// still required either way -- it's always the target staging folder name (via classifyMod's own
// knownVortexModId), never derived from `mod` itself.
// resolveMode (2026-08-22, Update Collection v2's own real-fix task): threaded straight through to
// the internal rebuildMod() call below -- see that function's own header comment for the two real
// modes ('all'/'keep-existing'). Optional, undefined by default (every existing caller -- Rebuild
// Collection, Missing Masters -- keeps its own current "refuse and report FAILED_MISMATCH_NOT_TOUCHED
// on a real mismatch" behavior unchanged when it isn't passed).
//
// onPhase (2026-08-22): optional (phase: 'downloading'|'installing') => void callback, a no-op by
// default -- lets a caller show real, live "what's happening right now" progress (matching what
// Vortex's own native install/update flow already shows) instead of one opaque black box from call
// to return. Fired at the two real, honest phase transitions this function actually has: right
// before a genuine Nexus auto-download starts, and right before the real extraction/comparison work
// begins once an archive is confirmed present. No percent/byte progress -- downloadModArchive has no
// progress signal of its own to report that from (confirmed by reading it), so this is deliberately
// just the two-phase split, not a fabricated percentage.
// collectionModId (2026-08-26, bundle-type mod fix): optional -- the parent collection's own Vortex
// modId, needed ONLY so classifyMod() can resolve a 'source.type === "bundle"' mod's content from
// that collection's own downloaded package (see lib/bundle-resolver.js). Every real caller that
// operates within one specific collection (Update Collection v2's Updated/Added loops and its
// retries) already has this in scope and should pass it; callers with no real collection context
// (Missing Masters' own general "repair any installed mod" scan, which reconstructs `mod.source` from
// Vortex's live per-mod attributes rather than a collection.json) leave it unset.
//
// Self-resolved fallback (2026-08-26, Missing Masters bundle-support fix): when this param is left
// unset AND `mod` is reconstructed here (providedMod not supplied), buildModFromVortexState/
// buildModFromLiveData's own shapeMod() now recovers a bundle mod's parent collectionModId from its
// own recorded bundleCollectionModId attribute (see build-mod-from-vortex-state.js), IF that mod was
// installed/updated after update-collection-v2-runner.js started writing it. That resolved value is
// used below when the caller didn't already supply one explicitly (an explicit caller-supplied
// collectionModId always wins). A bundle mod with neither -- installed before this fix shipped, or a
// caller-supplied `mod` object with no collectionModId of its own -- still degrades to the same
// honest "can't determine which collection this belongs to" failure rather than a crash (see
// resolveCollectionPackagePath's own null-collectionModId guard).
async function rebuildSingleMod({
    vortexModId, gameId, stateDir, downloadsDir, stagingDir, allowAutoDownload = false,
    liveMods = null, mod: providedMod = null, resolveMode = undefined, onPhase = () => {}, collectionModId = null,
}) {
    if (runState.isRunActive()) {
        const err = new Error('A Rebuild Collection run is currently in progress. Wait for it to finish, then try again.');
        err.code = 'RUN_ACTIVE';
        throw err;
    }

    const mod = providedMod || (liveMods
        ? buildModFromLiveData(liveMods, vortexModId, gameId)
        : await buildModFromVortexState({ stateDir, gameId, vortexModId }));

    // See collectionModId's own header comment above for why this falls back to the mod's own
    // self-resolved bundleCollectionModId rather than staying strictly caller-supplied.
    const effectiveCollectionModId = collectionModId || mod.bundleCollectionModId || null;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-single-mod-'));
    const tempCollectionPath = path.join(tempDir, 'collection.json');
    fs.writeFileSync(tempCollectionPath, JSON.stringify({ mods: [mod] }));

    try {
        const sevenZipExe = findSevenZip();
        let action = await classifyMod(mod, {
            downloadsDir, stagingDir, knownVortexModId: vortexModId, collectionModId: effectiveCollectionModId, sevenZipExe,
        });

        if (action.kind === 'SKIP_NO_ARCHIVE' && mod.source.type === 'nexus' && allowAutoDownload) {
            const apiKey = resolveApiKey();
            // Same Premium gate Rebuild Collection's own batch downloader already enforces
            // (downloadMissingArchivesForPlan -> checkPremiumStatus) -- confirmed real 2026-07-27
            // this single-mod path was calling downloadModArchive() directly, skipping that check
            // entirely, so a non-Premium account got a raw, confusing Nexus API error instead of the
            // same clear "this needs Premium" explanation used everywhere else in this app. Nexus's
            // API refuses non-Premium automated downloads by design, to protect its ad-supported
            // model (see nexus-mod-download.js's own header comment for the source citations) -- this
            // never attempts a workaround, same as Vortex's own client.
            const premium = await checkPremiumStatus(apiKey);
            if (!premium.isPremium) {
                return { modName: mod.name, ...action, downloadSkipped: 'not-premium', autoDownloadEnabled: true, canAutoDownload: true };
            }
            // Director's own call (2026-09-04): a genuine HASH_MISMATCH means the file sitting in
            // downloads is confirmed WRONG (real content, real bytes, just not what this collection
            // expects) -- redownloading a fresh copy ALONGSIDE it would just leave the wrong file as
            // permanent clutter (and a future ambiguity risk) since nothing else in this codebase ever
            // revisits it. Delete it first, then redownload -- if the fresh copy STILL doesn't match
            // (classifyMod below re-checks), that's now a genuinely persistent, confirmed problem, not
            // a stale-local-copy one. Scoped to HASH_MISMATCH only -- never NOT_FOUND (nothing exists
            // to delete) and never AMBIGUOUS (those candidates are already confirmed byte-identical
            // CORRECT copies via classifyMod's own AMBIGUOUS branch above; this whole block is
            // unreachable for that code since AMBIGUOUS resolves to kind:'REBUILD', never
            // 'SKIP_NO_ARCHIVE' -- the guard below is defensive, not load-bearing).
            if (action.code === 'HASH_MISMATCH' && action.candidateFile) {
                try {
                    fs.rmSync(action.candidateFile, { force: true });
                } catch (e) {
                    console.error(`[rebuild-single-mod] couldn't delete mismatched archive "${action.candidateFile}" before redownload: ${e.message}`);
                }
            }
            onPhase('downloading');
            try {
                await downloadModArchive({
                    apiKey, gameDomain: NEXUS_GAME_DOMAIN, source: mod.source, destDir: downloadsDir,
                });
            } catch (e) {
                return { modName: mod.name, ...action, downloadError: e.message, autoDownloadEnabled: true, canAutoDownload: true };
            }
            action = await classifyMod(mod, {
                downloadsDir, stagingDir, knownVortexModId: vortexModId, collectionModId: effectiveCollectionModId, sevenZipExe,
            });
        }

        if (action.kind !== 'REBUILD') {
            // canAutoDownload/autoDownloadEnabled let the client tell apart WHY no download was
            // attempted (setting turned off, vs. this mod's source isn't Nexus at all) from the
            // two more specific failure paths above (not-Premium, download itself failed) --
            // confirmed real 2026-07-28: without this, "archive missing, setting off" and "archive
            // missing, setting on but not-Premium" read as the exact same generic message.
            return { modName: mod.name, ...action, autoDownloadEnabled: allowAutoDownload, canAutoDownload: mod.source.type === 'nexus' };
        }

        onPhase('installing');
        const result = await rebuildMod(mod, action, { collectionJsonPath: tempCollectionPath, downloadsDir, stagingDir }, resolveMode);
        // action.autoResolvedDuplicate (2026-08-31): classifyMod's own AMBIGUOUS auto-pick, dropped
        // here otherwise -- rebuildMod()'s own return object has no knowledge of it. Threaded through
        // so the caller can still flag "picked one of several byte-identical duplicates automatically"
        // even though the mod installed successfully.
        return { modName: mod.name, targetFolderName: action.targetFolderName, autoResolvedDuplicate: action.autoResolvedDuplicate, ...result };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

module.exports = { rebuildSingleMod };
