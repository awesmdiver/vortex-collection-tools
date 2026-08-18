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
async function rebuildSingleMod({ vortexModId, gameId, stateDir, downloadsDir, stagingDir, allowAutoDownload = false, liveMods = null }) {
    if (runState.isRunActive()) {
        const err = new Error('A Rebuild Collection run is currently in progress. Wait for it to finish, then try again.');
        err.code = 'RUN_ACTIVE';
        throw err;
    }

    const mod = liveMods
        ? buildModFromLiveData(liveMods, vortexModId, gameId)
        : await buildModFromVortexState({ stateDir, gameId, vortexModId });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-single-mod-'));
    const tempCollectionPath = path.join(tempDir, 'collection.json');
    fs.writeFileSync(tempCollectionPath, JSON.stringify({ mods: [mod] }));

    try {
        const sevenZipExe = findSevenZip();
        let action = await classifyMod(mod, {
            downloadsDir, stagingDir, knownVortexModId: vortexModId, sevenZipExe,
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
            try {
                await downloadModArchive({
                    apiKey, gameDomain: NEXUS_GAME_DOMAIN, source: mod.source, destDir: downloadsDir,
                });
            } catch (e) {
                return { modName: mod.name, ...action, downloadError: e.message, autoDownloadEnabled: true, canAutoDownload: true };
            }
            action = await classifyMod(mod, {
                downloadsDir, stagingDir, knownVortexModId: vortexModId, sevenZipExe,
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

        const result = await rebuildMod(mod, action, { collectionJsonPath: tempCollectionPath, downloadsDir, stagingDir });
        return { modName: mod.name, targetFolderName: action.targetFolderName, ...result };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

module.exports = { rebuildSingleMod };
