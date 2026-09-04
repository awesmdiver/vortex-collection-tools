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
// Restore (2026-08-23) reads Archive Finder's own index and reuses Rebuild Missing Files' own
// extract-to-scratch-then-copy shape. Deliberately NOT archive-finder-routes.js's POST /extract:
// that route persists its outputFolder as the user's new Archive Finder default, so restoring into
// staging through it would silently move where all their future extractions land.
const fs = require('fs');
const { createDb } = require('../lib/archive-finder-db');
const { hashFileMd5 } = require('../lib/file-hash');
const { loadCollection } = require('../lib/collection-parser');
// Version display for the Restore archive chooser. Was a private re-derivation of Vortex's own
// naming shapes here, which re-introduced a bug download-naming.js had already been fixed for -- see
// docs/SHARED-CODE-MAP.md's version-parsing section.
const { parseVersionFromDownloadName } = require('../lib/download-naming');

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
            return res.json({ configured: false, total: 0, problemMasters: [], unreadable: [] });
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
    // Turns one plugin back on in Vortex (2026-08-23). The whole mechanism already existed --
    // helperClient.setPluginEnabled, live-verified and already used by web/pgpatcher-routes.js at
    // four call sites -- so this is a thin relay, not new machinery. It takes the raw filename
    // exactly as it appears in plugins.txt, which is precisely the shape `master.name` already has.
    //
    // NO deploy is needed for the flag itself, and none is triggered here: setPluginEnabled flips
    // Vortex's own in-memory plugin flag. plugins.txt -- the file the game actually reads, and the
    // file /scan reads -- is only rewritten by Vortex during a real deploy, which is exactly why the
    // client updates the row from THIS response rather than re-scanning (a re-scan would still say
    // Disabled and look broken). setPluginEnabled self-verifies against Vortex's own before/after
    // readback, so its return value is the truth.
    //
    // 409 + 'helper-unavailable' matches the convention already used elsewhere in this app
    // (web/clear-update-flags-routes.js's requireHelper) rather than inventing a status for it.
    router.post('/set-plugin-enabled', async (req, res) => {
        const { name } = req.body || {};
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'A plugin name is required.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            if (!helperAvailable) {
                return res.status(409).json({
                    error: 'helper-unavailable',
                    message: 'The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to turn a plugin back on.',
                });
            }
            const ok = await helperClient.setPluginEnabled(name, true);
            if (!ok) {
                // A real, reproducible case, not a generic failure: a plugin whose owning mod isn't
                // deployed has no load-order entry to flip at all, so Vortex's own readback can't
                // confirm the new value. Reported honestly rather than as success -- the client turns
                // this into the on-row "Couldn't enable plugin" note.
                return res.status(422).json({ error: 'not-in-load-order' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Runs Vortex's own real full deploy (2026-08-23). Fixing anything in this tool updates staging
    // and Vortex's own settings, but the GAME sees none of it until a deploy runs -- true of Enable
    // (an in-memory flag flip) and of Restore. So this isn't a convenience button; it's the step that
    // makes the other fixes take effect.
    //
    // Same call and the same fire-and-poll shape PGPatcher's own Deploy All already uses
    // (web/pgpatcher-routes.js) rather than a second pattern: POST kicks it off and returns 202
    // immediately, the client polls /deploy-all/progress. deployAllMods()/getDeployAllProgress() are
    // themselves a poll-shaped pair in lib/vortex-helper-client.js, so an SSE wrapper would be
    // inventing push semantics the underlying primitive doesn't have.
    //
    // Module-scoped single-flight, matching PGPatcher's: this is a real, out-of-band, whole-install
    // Vortex operation, not something scoped to one scan.
    let deployAllInProgress = false;
    router.post('/deploy-all', async (req, res) => {
        if (deployAllInProgress) {
            return res.status(409).json({ error: 'A deploy is already in progress.' });
        }
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!helperAvailable) {
            return res.status(409).json({
                error: 'helper-unavailable',
                message: 'The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to deploy from here.',
            });
        }
        deployAllInProgress = true;
        res.status(202).json({});
        (async () => {
            try {
                await helperClient.deployAllMods();
            } catch {
                // deployAllMods never throws by contract; the progress endpoint below is what
                // actually reports a real failure, so there is nothing useful to do here.
            }
        })().finally(() => { deployAllInProgress = false; });
    });

    router.get('/deploy-all/progress', async (req, res) => {
        const progress = await helperClient.getDeployAllProgress();
        // A null here means "no fresh update right now", NOT that the deploy failed -- the same
        // event-loop congestion that makes a deploy slow can also time out this poll. Falls back to
        // this route's own in-flight flag rather than reporting a false "not active", exactly as
        // PGPatcher's own equivalent does.
        res.json(progress || { active: deployAllInProgress, done: !deployAllInProgress });
    });

    // ---------- Restore a mod whose files are gone entirely (2026-08-23) ----------
    // Only ever offered for the "files are gone" row: status 'missing' with no readyToDeploy, no
    // activeAlternate, no deployedMisplaced and no possibleHollowInstall. The hollow-install case is
    // Rebuild This Mod's territory -- there the staging folder still exists and Vortex still has the
    // mod's own record to resolve an archive from. Restore exists precisely because that record is
    // gone, which is why it has to go searching the archive index instead.

    // An empty result means one of FOUR different things, and three of them are not "not found".
    // Getting this wrong is the most likely way this feature misleads someone, so the states are
    // distinguished explicitly rather than collapsed:
    //   not-configured   -- Archive Finder has no index folder set at all.
    //   not-scanned      -- index exists but has never indexed anything.
    //   ext-not-indexed  -- THE TRAP. The index only covers file types the user chose, and that
    //                       defaults to ['.esp'] (lib/app-config.js). A great many missing masters
    //                       are .esm, so a perfectly healthy index genuinely finds nothing and
    //                       "not found" would be a lie.
    //   not-found        -- genuinely absent from every indexed archive.
    router.get('/restore/search', (req, res) => {
        const name = String(req.query.name || '');
        if (!name) return res.status(400).json({ error: 'A master name is required.' });
        const ext = path.extname(name).toLowerCase();
        const { archiveFinderDbDir, archiveFinderExtensions } = appConfig.loadConfig();
        if (!archiveFinderDbDir) return res.json({ state: 'not-configured' });

        const extensions = archiveFinderExtensions || ['.esp'];
        let db;
        try {
            db = createDb(archiveFinderDbDir, { downloads, staging });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
        try {
            const stats = db.stats();
            if (!stats.archiveCount) return res.json({ state: 'not-scanned' });
            if (!extensions.map((x) => x.toLowerCase()).includes(ext)) {
                return res.json({ state: 'ext-not-indexed', ext, extensions });
            }
            // search() is a substring LIKE and returns one row per (file x archive), which is both
            // why a chooser is needed AND why the exact-basename filter has to happen here.
            const rows = db.search(name, extensions)
                .filter((r) => String(r.fileName).toLowerCase() === name.toLowerCase());
            if (rows.length === 0) return res.json({ state: 'not-found' });

            // One entry per ARCHIVE, not per file row -- the same plugin can appear more than once
            // inside a single archive (a FOMOD shipping several variants), and offering the same
            // archive twice in the chooser would be noise.
            const byArchive = new Map();
            for (const r of rows) {
                if (byArchive.has(r.archiveId)) continue;
                const meta = db.getArchiveById(r.archiveId) || {};
                // Prefer the file's own real mtime on disk; fall back to what the index recorded
                // at scan time if the archive has since been moved or deleted.
                let mtime = meta.mtime ? new Date(meta.mtime).toISOString() : null;
                let sizeOnDisk = meta.size || null;
                let onDisk = false;
                try {
                    const st = fs.statSync(r.archivePath);
                    mtime = st.mtime.toISOString();
                    sizeOnDisk = st.size;
                    onDisk = true;
                } catch { /* moved or deleted since the scan -- flagged via onDisk below */ }
                byArchive.set(r.archiveId, {
                    archiveId: r.archiveId,
                    archiveName: r.archiveName,
                    archivePath: r.archivePath,
                    internalPath: r.internalPath,
                    size: sizeOnDisk,
                    downloadedAt: mtime,
                    onDisk,
                    fileCount: db.countFilesInArchive(r.archiveId),
                    version: parseVersionFromDownloadName(r.archiveName),
                });
            }
            const matches = [...byArchive.values()]
                .sort((a, b) => String(b.downloadedAt || '').localeCompare(String(a.downloadedAt || '')));
            res.json({ state: 'matches', matches });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            db.close();
        }
    });

    // Real, in-flight restore state, module-scoped and single-flight -- same shape as /deploy-all
    // above rather than a second pattern. Extracting a large mod is genuinely slow, so the client
    // polls this instead of sitting behind a static label.
    let restoreState = null;
    router.get('/restore/progress', (req, res) => {
        res.json(restoreState || { active: false, done: true });
    });

    router.post('/restore', async (req, res) => {
        const { name, archivePath, targetFolderName } = req.body || {};
        if (!name || !archivePath || !targetFolderName) {
            return res.status(400).json({ error: 'name, archivePath and targetFolderName are all required.' });
        }
        if (restoreState && restoreState.active) {
            return res.status(409).json({ error: 'A restore is already in progress.' });
        }
        if (!staging) return res.status(400).json({ error: 'not-configured', message: 'Set up the staging folder under Settings first.' });
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!helperAvailable) {
            return res.status(409).json({
                error: 'helper-unavailable',
                message: 'The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to add the restored mod to Vortex.',
            });
        }
        restoreState = { active: true, done: false, percent: 0, text: 'Extracting mod files from archive\u2026' };
        res.status(202).json({});

        (async () => {
            try {
                // A raw whole-archive extract was WRONG here, and the live test proved it: restoring
                // RMB SPIDified put all ten of its folders into staging, including five mutually
                // exclusive "03 SPID - Skip *" installer choices. Restore registers the mod as
                // already-installed, so Vortex never runs the FOMOD wizard -- it just deploys
                // whatever is sitting there, i.e. every variant at once.
                //
                // So this goes through the SAME engine the rest of the app uses (rebuildSingleMod ->
                // rebuild-mod.js), which replays recorded FOMOD choices, falls back to Vortex's own
                // mod-root detection when there are none, and refuses outright rather than guessing
                // when an archive genuinely needs a choice nobody recorded. It also brings REAL ghost
                // preservation with it (rebuild-mod.js's stripGhostPairs/applyGhostPreservation) --
                // stronger than the single existsPlainOrGhosted check this replaces, not weaker.
                const stat = fs.statSync(archivePath);
                const md5 = await hashFileMd5(archivePath);

                // Restore exists for a mod Vortex has FORGOTTEN -- but the collection it came from is
                // very often still installed, and its collection.json still records that mod's own
                // FOMOD choices. Matching on md5 rather than name/modId is exact and needs no
                // filename parsing: it is the same archive or it isn't.
                const recorded = findRecordedModByMd5(staging, md5);
                restoreState.percent = 10;

                const mod = recorded || {
                    // No collection record (the mod wasn't from a collection, or that collection is
                    // gone too). choices:null is the real signal to the engine -- it applies its own
                    // deterministic no-recorded-choices path rather than dumping everything.
                    name: targetFolderName,
                    source: { type: 'nexus', md5, fileSize: stat.size, logicalFilename: path.basename(archivePath) },
                    choices: null,
                };
                if (!mod.source.md5) mod.source.md5 = md5;
                if (!mod.source.fileSize) mod.source.fileSize = stat.size;

                restoreState.percent = 25;
                const result = await rebuildSingleMod({
                    vortexModId: targetFolderName, gameId: syncLib.GAME_ID, stateDir: state,
                    downloadsDir: downloads, stagingDir: staging, mod,
                });
                if (result.status !== 'REBUILT') {
                    // SKIP_OPEN_FOMOD specifically means the archive has a real wizard and nobody
                    // recorded a choice. Passed through untouched so the client can reuse the message
                    // this app already has for exactly that (mmDescribeRebuildFailure) rather than
                    // inventing a second wording for the same situation.
                    restoreState = { active: false, done: true, percent: 100, result: { ok: false, rebuild: result } };
                    return;
                }

                restoreState.percent = 80;
                restoreState.text = 'Adding mod to Vortex and enabling\u2026';
                const vortexMod = {
                    id: targetFolderName, state: 'installed', type: '', installationPath: targetFolderName,
                    attributes: { name: mod.name || targetFolderName, installTime: new Date().toISOString() },
                };
                const created = await helperClient.createMod(targetFolderName, vortexMod);
                if (!created) throw new Error("Files were extracted, but Vortex couldn't register this as a new mod -- check Vortex's own log.");
                // Director's call: enabled by default. A restored mod the user then has to go and
                // switch on themselves isn't really restored.
                const enabled = await helperClient.setModEnabled(targetFolderName, true);
                restoreState = {
                    active: false, done: true, percent: 100,
                    result: {
                        ok: true, enabled, targetFolderName,
                        // rebuild-mod.js reports files it left alone because a .ghost sibling means
                        // the user deliberately disabled them -- passed straight through so the
                        // client can still say so rather than looking like it silently skipped part
                        // of the mod.
                        ghostPreserved: result.ghostPreserved || [],
                        usedRecordedChoices: !!recorded,
                        collectionName: recorded ? recorded.__collectionName : null,
                    },
                };
            } catch (e) {
                restoreState = { active: false, done: true, percent: 100, result: { ok: false, error: e.message } };
            }
        })();
    });

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
