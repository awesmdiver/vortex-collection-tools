'use strict';
// Thin Express handlers for the "Missing Masters" utility -- all real logic lives in
// lib/missing-masters-scan.js / lib/esp-writer.js / lib/rebuild-single-mod.js. See TECHNICAL.md's
// "Missing Masters" section for the full design writeup.
//
// /scan and /create-dummy-master need NO Vortex-running gate at all: they only ever read
// Plugins.txt and the Data folder directly (immutable existing files, not Vortex's live state.v2
// LevelDB), and the only write (dummy master creation) goes to a separate, user-configured output
// folder Vortex isn't actively managing. /rebuild-mod is the one exception -- it reads a single
// mod's own state.v2 record (archive info, FOMOD choices), so it's gated like every other
// state.v2-touching route elsewhere in this app.

const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const missingMastersScan = require('../lib/missing-masters-scan');
const espWriter = require('../lib/esp-writer');
const syncLib = require('../lib/vortex-sync/lib');
const appConfig = require('../lib/app-config');
const { rebuildSingleMod } = require('../lib/rebuild-single-mod');
const helperClient = require('../lib/vortex-helper-client');

function createMissingMastersRouter(config) {
    const router = express.Router();
    const { skyrimDataDir, pluginsListDir, dummyMastersOutputDir, staging, downloads, state, eslifierOutputDir } = config;

    // Shared by both folder-opening routes -- validates targetPath actually resolves inside baseDir
    // before ever handing it to Explorer. Both callers only ever pass a path this project's own scan
    // just found (not raw user input), so this is cheap defense-in-depth, not a real capability gate.
    function isInside(baseDir, targetPath) {
        const resolvedBase = path.resolve(baseDir);
        const resolvedTarget = path.resolve(targetPath);
        return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
    }

    function vortexRunningGate(res) {
        if (syncLib.isVortexRunning()) {
            res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
            return true;
        }
        return false;
    }

    router.get('/scan', (req, res) => {
        if (!skyrimDataDir || !pluginsListDir) {
            return res.json({ configured: false, total: 0, problemMasters: [] });
        }
        try {
            const pluginsTxtPath = path.join(pluginsListDir, 'Plugins.txt');
            // `staging` is this project's own existing, already-required field (Rebuild/Update
            // Collection both depend on it) -- reused here purely to enrich results with a friendly
            // mod name per plugin (see buildStagingModNameIndex's own comment); Missing Masters
            // itself still works without it, just without the mod-name column populated.
            const result = missingMastersScan.scanMissingMasters(skyrimDataDir, pluginsTxtPath, staging, dummyMastersOutputDir, eslifierOutputDir);
            // Lets the Rebuild This Mod confirm dialog state plainly whether it WILL auto-download a
            // missing archive, rather than hedging with "if turned on in Settings" -- the client
            // already knows the answer by the time it needs to say anything.
            const { downloadMissingArchives, missingMastersRecognizeEslifier } = appConfig.loadConfig();
            res.json({
                configured: true, ...result, downloadMissingArchivesEnabled: !!downloadMissingArchives,
                // Read fresh per scan (like downloadMissingArchivesEnabled above) -- lets the client
                // apply/withhold the ESLifier soft-tier downgrade without a restart, and show its own
                // empty-state hint when there's no folder configured for it to match against yet.
                recognizeEslifierEnabled: missingMastersRecognizeEslifier !== false,
                eslifierOutputDirConfigured: !!eslifierOutputDir,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Only offered by the UI for 'missing' (genuinely absent) masters, never 'present-but-inactive'
    // ones -- re-validated here too, not just trusted from a possibly-stale client-side scan result.
    router.post('/create-dummy-master', (req, res) => {
        if (!skyrimDataDir || !dummyMastersOutputDir) {
            return res.status(400).json({ error: 'Set up the Skyrim Data folder and Dummy Masters output folder under Settings first.' });
        }
        const { name } = req.body || {};
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'No master name given.' });
        }
        // Re-check the master is still actually absent from the Data folder right now -- a
        // name-only client request is not proof by itself (mirrors this project's own established
        // "re-validate against real state before acting" convention from cleanup-scan.js's crossCheck).
        try {
            const filesOnDisk = missingMastersScan.scanDataFolder(skyrimDataDir);
            if (filesOnDisk.has(name.toLowerCase())) {
                return res.status(400).json({ error: `"${name}" already exists in the Data folder -- no dummy needed.` });
            }
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
        try {
            const createdPath = espWriter.createDummyMaster(name, dummyMastersOutputDir);
            res.json({ createdPath });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // Rebuilds ONE mod (not a whole collection) from Vortex's own mod record + its intact archive --
    // offered when a "missing" master's own staging folder was found completely empty (see
    // missing-masters-scan.js's hollowInstalls/possibleHollowInstall). Reuses Rebuild Collection's
    // own classify/extract/verify/swap engine unchanged (lib/rebuild-single-mod.js).
    //
    // Opportunistic helper-extension path (2026-08-18, same "remove the Vortex-must-be-closed
    // requirement" pattern already shipped for Cycle Helper and Rules Generator -- see
    // TECHNICAL.md's Missing Masters section). The only step here that ever needed Vortex closed was
    // the mod-record lookup (buildModFromVortexState's own state.v2 read) -- the actual rebuild
    // itself is pure filesystem work (staging/downloads), never a Vortex database write. Checked
    // BEFORE vortexRunningGate, same as every other helper-integrated route: source the live mod
    // data from helperClient.getAllMods() when reachable, fall through to the exact original
    // gated state.v2 path, untouched, when it's not (or its own /mods read fails).
    router.post('/rebuild-mod', async (req, res) => {
        if (!staging || !downloads) {
            return res.status(400).json({ error: 'Set up the staging and downloads folders under Settings first.' });
        }
        const { vortexModId } = req.body || {};
        if (!vortexModId || typeof vortexModId !== 'string') {
            return res.status(400).json({ error: 'No mod given to rebuild.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            const helperData = helperAvailable ? await helperClient.getAllMods() : null;
            let source = 'state.v2';
            if (helperData) {
                source = 'helper-extension';
            } else if (vortexRunningGate(res)) {
                return;
            }
            // Follows the SAME global "Download missing archives automatically" Settings toggle
            // Rebuild Collection itself uses (appConfig.loadConfig().downloadMissingArchives) --
            // deliberately not a separate per-click option here, so this behaves identically to
            // however the user already configured Rebuild Collection's own auto-download behavior,
            // rather than needing two different toggles for the same underlying capability.
            const { downloadMissingArchives } = appConfig.loadConfig();
            const result = await rebuildSingleMod({
                vortexModId, gameId: syncLib.GAME_ID, stateDir: state, downloadsDir: downloads, stagingDir: staging,
                allowAutoDownload: !!downloadMissingArchives,
                liveMods: helperData ? helperData.mods : null,
            });
            res.json({ ...result, source });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Persists the "Recognize ESLifier output" scan-option toggle -- lives on the Missing Masters
    // page itself (not Settings, unlike this project's other toggles), so it gets its own small,
    // immediate-save route rather than going through /api/settings' Save button.
    router.post('/set-recognize-eslifier', (req, res) => {
        const { enabled } = req.body || {};
        appConfig.saveConfig({ missingMastersRecognizeEslifier: !!enabled });
        res.json({ enabled: !!enabled });
    });

    // Opens a staging folder directly in Explorer (navigates INTO it, same "no single file to
    // select, just show me where this lives" pattern as settings-routes.js's own
    // /open-logs-folder) -- offered for a missing master whose mod name resolved to a real staging
    // folder (see missing-masters-scan.js's stagingFolderPath), so the user can review/manually
    // swap files themselves (e.g. the .esp-vs-.esl active-alternate case). Validated to actually be
    // inside the configured staging directory -- unlike rebuild-routes.js's own /reveal (accepts
    // any path, "trusted localhost only"), this one only ever receives a path this project's own
    // scan just found, so the extra check is cheap, low-friction defense-in-depth, not a real
    // capability restriction.
    router.post('/open-staging-folder', (req, res) => {
        if (!staging) {
            return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        }
        const { folderPath } = req.body || {};
        if (!folderPath || typeof folderPath !== 'string') {
            return res.status(400).json({ error: 'No folder given to open.' });
        }
        if (!isInside(staging, folderPath)) {
            return res.status(400).json({ error: 'That folder is not inside your configured staging directory.' });
        }
        spawn(`explorer.exe "${path.resolve(folderPath)}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ ok: true });
    });

    // Opens the folder a "deployed but misplaced" master's own file was actually found sitting in,
    // directly inside the Data folder itself -- see missing-masters-scan.js's deployedMisplaced (a
    // file Vortex deployed one folder too deep, e.g. "Data\data\1DustAdeptArmor.esl", which Skyrim
    // never reads since it only looks at Data's own root). Lets the user drag the misplaced files up
    // into Data themselves. Validated to actually be inside the configured Skyrim Data folder, same
    // "cheap defense-in-depth, not a real restriction" reasoning as /open-staging-folder above.
    router.post('/open-deployed-folder', (req, res) => {
        if (!skyrimDataDir) {
            return res.status(400).json({ error: 'Set up the Skyrim Data folder under Settings first.' });
        }
        const { folderPath } = req.body || {};
        if (!folderPath || typeof folderPath !== 'string') {
            return res.status(400).json({ error: 'No folder given to open.' });
        }
        if (!isInside(skyrimDataDir, folderPath)) {
            return res.status(400).json({ error: 'That folder is not inside your Skyrim Data folder.' });
        }
        spawn(`explorer.exe "${path.resolve(folderPath)}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createMissingMastersRouter };
