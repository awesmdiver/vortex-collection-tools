'use strict';
// Save Cleaner -- wraps the bundled ReSaver_Renewed.exe (lib/save-cleaner-runner.js) into the real
// Phase 1 flow from design/mockup-save-cleaner.html: pick a save, health report, choose what to
// clean, save out (Save or Save As, never silently). See that mockup for the full design writeup,
// and F:\Claude Workspace\skyrim-modding\fallrimtools-resaver-renewed's own prompts/handoff-latest.md
// (commit 02e8065) for the exe's real CLI shape this file drives.
//
// Real progress caveat (read before changing the SSE wiring below): unlike pgtools.exe, ReSaver_
// Renewed's report/clean/save each print exactly ONE JSON object at the very end of a run and exit
// -- there is no incremental stdout to parse into byte-precise progress the way pgpatcher-routes.js
// does. Every operation here still goes through the SAME createSseSession() pattern (a 'phase' event
// on start, a final 'result'/'error' event on completion) so the UI shows a real "this is running"
// state consistent with every other tool's own progress convention -- it just can't show a
// determinate percentage. In real testing a `report` on a ~40MB save took 5-9s and `save` (reload +
// reclean + write) a few seconds more, both well within "a short wait with a visible phase message,"
// not "needs a real progress bar" territory.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const express = require('express');
const appConfig = require('../lib/app-config');
const syncRunner = require('../lib/sync-runner');
const helperClient = require('../lib/vortex-helper-client');
const resaverRunner = require('../lib/save-cleaner-runner');
const saveScan = require('../lib/save-cleaner-scan');
const saveBackups = require('../lib/save-cleaner-backups');
const { pickSaveFileAsync } = require('../lib/vortex-sync/win-dialog');
const { createSseSession } = require('./sse-session');

// Only checked for the Step 3 "close [game] first" gate (a save file can't be safely edited while
// the game has it open) -- same tasklist-based approach lib/vortex-sync/lib.js's own
// isVortexRunning already uses for the equivalent Vortex-must-be-closed gates elsewhere in this app.
function isGameRunning(game) {
    try {
        const out = execSync('tasklist', { encoding: 'utf8', windowsHide: true });
        if (game === 'fallout4') {
            return /(?:^|\\)Fallout4(?:SE)?\.exe/im.test(out);
        }
        if (game === 'starfield') {
            return /(?:^|\\)Starfield\.exe/im.test(out);
        }
        // skyrim or default
        return /(?:^|\\)(?:SkyrimSE|Skyrim|SkyrimVR)\.exe/im.test(out);
    } catch {
        return false; // best-effort; never block the whole page over a failed process check
    }
}

function createSaveCleanerRouter(config) {
    const router = express.Router();
    const { staging, state } = config;

    function getSavesDir(game = 'skyrim') {
        const { saveCleanerSavesDir, saveCleanerSavesDirFO4, saveCleanerSavesDirStarfield } = appConfig.loadConfig();
        if (game === 'fallout4') {
            return saveCleanerSavesDirFO4 || saveScan.resolveDefaultSavesDir('fallout4');
        }
        if (game === 'starfield') {
            return saveCleanerSavesDirStarfield || saveScan.resolveDefaultSavesDir('starfield');
        }
        return saveCleanerSavesDir || saveScan.resolveDefaultSavesDir('skyrim');
    }

    // Cross-references each save's raw profileFolderId (a Vortex profile ID, when the install uses
    // per-profile save separation) against Vortex's own real profile list to attach the actual
    // display name. Prefers the live Helper extension (getLiveProfiles) -- no "close Vortex first"
    // gate at all, matches every other read this app has moved onto the Helper for -- and only falls
    // back to the on-disk state.v2 read (which genuinely does need Vortex closed, since it can't open
    // the same LevelDB Vortex already has locked) when the Helper isn't installed, isn't running, or
    // is an older version that predates GET /profiles. Best-effort either way: a lookup failure just
    // leaves saves ungrouped by name (raw ID still shown) rather than failing the whole saves list.
    async function attachProfileNames(saves) {
        const ids = new Set(saves.map((s) => s.profileFolderId).filter(Boolean));
        if (ids.size === 0) return saves;

        const live = await helperClient.getLiveProfiles();
        let profiles = live ? live.profiles : null;
        if (!profiles) {
            try {
                ({ profiles } = await syncRunner.listProfiles(state));
            } catch {
                return saves; // Vortex running (and no Helper) / no state.v2 yet -- fall back to raw IDs on the frontend
            }
        }
        const nameById = new Map(profiles.map((p) => [p.profileId, p.name]));
        return saves.map((s) => ({
            ...s,
            profileName: s.profileFolderId ? (nameById.get(s.profileFolderId) || null) : null,
        }));
    }

    // Whether the "Regional Save Names" mod (github.com/powerof3/RegionalSaveNames) is installed --
    // prefers the live Helper's own real mod list (matches by display name, immune to the shipped
    // DLL's own filename ever changing -- confirmed real 2026-08-25: the file is actually named
    // "po3_RegionalSaveNames.dll", not the repo's own name, and a future mod update could rename it
    // again), falling back to the on-disk staging-folder DLL scan (isRegionalSaveNamesInstalled) only
    // when the Helper isn't installed/running -- same helper-first-then-fall-back shape as
    // attachProfileNames above.
    async function detectRegionalSaveNames() {
        const live = await helperClient.getAllMods();
        if (live && live.mods) {
            // A real, successful Helper answer either way -- trust it rather than falling through to
            // the disk scan, which could be stale (mod present in staging but disabled in Vortex).
            // Matching against live.mods alone isn't enough: a mod stays in that list even when
            // disabled, only enabledModKeys reflects its real profile-level Enabled/Disabled state --
            // require both, so a disabled-but-still-staged copy correctly reads as "not installed"
            // (director's own call, 2026-08-25: Vortex's own enabled state is always the real truth).
            const enabled = new Set(live.enabledModKeys);
            return Object.entries(live.mods).some(([modKey, mod]) => {
                if (!enabled.has(modKey)) return false;
                const name = mod?.attributes?.customFileName || mod?.attributes?.name || '';
                return /regional save names/i.test(name);
            });
        }
        // Helper not installed/running -- fall back to the on-disk staging-folder scan.
        return staging ? saveScan.isRegionalSaveNamesInstalled(staging) : false;
    }

    function requireResaverInstalled(res) {
        if (resaverRunner.isResaverInstalled()) return true;
        res.status(400).json({
            error: 'resaver-not-installed',
            message: "The save-cleaning engine (ReSaver_Renewed.exe) isn't bundled with this build yet.",
        });
        return false;
    }

    function requireSavesDir(res, game = 'skyrim') {
        const dir = getSavesDir(game);
        if (dir) return dir;
        const labels = {
            skyrim: 'Skyrim',
            fallout4: 'Fallout 4',
            starfield: 'Starfield',
        };
        const label = labels[game] || 'Skyrim';
        res.status(400).json({ error: 'not-configured', message: `Set your ${label} saves folder under Settings first.` });
        return null;
    }

    // Resolves the real mod/collection name for every orphaned-script group in a fresh `report`
    // result -- the CLI's own --data-dir flag can only ever say "still shipped by something
    // installed" (a bare boolean); this app's own staging-folder knowledge is what turns that into
    // a real name (or an honest "not currently installed" with no guessed identity for an
    // already-removed mod -- see lib/save-cleaner-scan.js's own header comment for why that's the
    // real limit, confirmed by reading every historical-record mechanism this app already has).
    function enrichOrphanedScripts(reportResult) {
        const groups = reportResult?.problems?.unattachedInstances?.byScriptName;
        if (!Array.isArray(groups) || groups.length === 0 || !staging) return reportResult;
        const scriptOriginIndex = saveScan.buildScriptOriginIndex(staging);
        // ExcludingWorkshop (2026-08-27) -- attributing a leftover script to "which collection left
        // this behind" must only ever consider a real install, never a stale Workshop-draft folder
        // for the same collection (same bug class Update Collection v2/Merge Plugins already hit for
        // real -- see lib/sync-runner.js's own header comment on this function).
        const collections = syncRunner.listInstalledCollectionsExcludingWorkshop(staging);
        const collectionNameIndex = saveScan.buildCollectionNameIndex(collections);
        for (const group of groups) {
            const origin = saveScan.resolveScriptOrigin({ scriptOriginIndex, collectionNameIndex }, group.scriptName);
            group.modName = origin.modName;
            group.collectionName = origin.collectionName;
        }
        return reportResult;
    }

    router.get('/saves', async (req, res) => {
        const game = (req.query.game || 'skyrim').toLowerCase();
        if (!['skyrim', 'fallout4', 'starfield'].includes(game)) {
            return res.status(400).json({ error: 'invalid-game', message: 'Game must be "skyrim", "fallout4", or "starfield".' });
        }
        const dir = getSavesDir(game);
        if (!dir) {
            const label = { skyrim: 'Skyrim', fallout4: 'Fallout 4', starfield: 'Starfield' }[game];
            res.status(400).json({ error: 'not-configured', message: `Set your ${label} saves folder under Settings first.` });
            return;
        }
        try {
            let saves = await attachProfileNames(saveScan.listSaves(dir, game));
            // Only surface the filename's own region tag (e.g. "Tamriel") when the "Regional Save
            // Names" mod is actually installed -- see parseRegionFromFilename's own header comment
            // for why: without that mod, the same filename segment can just as easily be an internal
            // cell/quest tag ("APStartCell") or a different naming mod's own label ("AutoRotate"),
            // not a trustworthy region name. Gating here (not in listSaves itself) keeps that
            // presentation decision in one place rather than every caller re-deciding it.
            // Note: Regional Save Names is Skyrim-only, so skip this for Fallout 4.
            if (game === 'skyrim' && await detectRegionalSaveNames()) {
                saves = saves.map((s) => ({ ...s, region: saveScan.parseRegionFromFilename(s.filename) }));
            }
            res.json({ savesDir: dir, saves, game });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/skyrim-running', (req, res) => {
        const game = (req.query.game || 'skyrim').toLowerCase();
        if (!['skyrim', 'fallout4', 'starfield'].includes(game)) {
            return res.status(400).json({ error: 'invalid-game', message: 'Game must be "skyrim", "fallout4", or "starfield".' });
        }
        res.json({ running: isGameRunning(game) });
    });

    // ---- Scan (Step 1b -> Step 2 health report) ----
    const scanSession = createSseSession();
    router.get('/scan/events', (req, res) => {
        if (!scanSession.get()) return res.status(404).end();
        scanSession.subscribe(res, { afterSeq: Number(req.headers['last-event-id'] || 0) });
    });
    router.post('/scan', async (req, res) => {
        if (!requireResaverInstalled(res)) return;
        const { essPath, game } = req.body || {};
        const normalizedGame = (game || 'skyrim').toLowerCase();
        if (!['skyrim', 'fallout4'].includes(normalizedGame)) {
            return res.status(400).json({ error: 'invalid-game', message: 'Game must be "skyrim" or "fallout4".' });
        }
        if (!essPath || !fs.existsSync(essPath)) {
            return res.status(400).json({ error: 'not-found', message: 'That save could not be found -- it may have been moved or deleted.' });
        }
        const mySession = scanSession.start({ id: `scan-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => { if (scanSession.get() === mySession) scanSession.emit(event); };
        emitIfCurrent({ type: 'phase', message: 'Reading save file…' });
        try {
            const { skyrimDataDir } = appConfig.loadConfig();
            // Skyrim-specific data directory only applies to Skyrim
            const dataDir = normalizedGame === 'skyrim' ? (skyrimDataDir || undefined) : undefined;
            const result = await resaverRunner.report(essPath, { dataDir });
            enrichOrphanedScripts(result);
            emitIfCurrent({ type: 'result', done: true, result });
        } catch (e) {
            emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
        }
    });

    // ---- View (Step 1's own "View" button -- a full load, same as /scan, but a fully separate SSE
    // session so peeking at a save's info from the picker can never collide with a real in-flight
    // Step 1b->Step 2 scan. Reuses resaverRunner.report() -- the same data /scan already computes --
    // rather than a second CLI entry point; the frontend just renders a different subset of the same
    // `save` object (path/character summary/version/size/screenshot, no problem counts -- those show
    // on the real health report page next, per the director's own scoping, 2026-08-25). ----
    const viewSession = createSseSession();
    router.get('/view/events', (req, res) => {
        if (!viewSession.get()) return res.status(404).end();
        viewSession.subscribe(res, { afterSeq: Number(req.headers['last-event-id'] || 0) });
    });
    router.post('/view', async (req, res) => {
        if (!requireResaverInstalled(res)) return;
        const { essPath, game } = req.body || {};
        const normalizedGame = (game || 'skyrim').toLowerCase();
        if (!['skyrim', 'fallout4'].includes(normalizedGame)) {
            return res.status(400).json({ error: 'invalid-game', message: 'Game must be "skyrim" or "fallout4".' });
        }
        if (!essPath || !fs.existsSync(essPath)) {
            return res.status(400).json({ error: 'not-found', message: 'That save could not be found -- it may have been moved or deleted.' });
        }
        const mySession = viewSession.start({ id: `view-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => { if (viewSession.get() === mySession) viewSession.emit(event); };
        emitIfCurrent({ type: 'phase', message: 'Reading file…' });
        try {
            const result = await resaverRunner.report(essPath);
            emitIfCurrent({ type: 'result', done: true, result: { save: result.save } });
        } catch (e) {
            emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
        }
    });

    // ---- Clean preview (Step 3 -> Step 4, in-memory only -- never writes) ----
    const cleanSession = createSseSession();
    router.get('/clean/events', (req, res) => {
        if (!cleanSession.get()) return res.status(404).end();
        cleanSession.subscribe(res, { afterSeq: Number(req.headers['last-event-id'] || 0) });
    });
    router.post('/clean', async (req, res) => {
        if (!requireResaverInstalled(res)) return;
        const { essPath, categories, resetHavok, purifyFormLists, game } = req.body || {};
        const normalizedGame = (game || 'skyrim').toLowerCase();
        if (!['skyrim', 'fallout4'].includes(normalizedGame)) {
            return res.status(400).json({ error: 'invalid-game', message: 'Game must be "skyrim" or "fallout4".' });
        }
        if (!essPath || !fs.existsSync(essPath)) {
            return res.status(400).json({ error: 'not-found', message: 'That save could not be found -- it may have been moved or deleted.' });
        }
        if (isGameRunning(normalizedGame)) {
            const gameLabel = normalizedGame === 'fallout4' ? 'Fallout 4' : 'Skyrim';
            return res.status(409).json({ error: 'game-running', message: `${gameLabel} is currently running. Close it completely, then try again.` });
        }
        const mySession = cleanSession.start({ id: `clean-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => { if (cleanSession.get() === mySession) cleanSession.emit(event); };
        emitIfCurrent({ type: 'phase', message: 'Cleaning in memory…' });
        try {
            const result = await resaverRunner.clean(essPath, { categories: categories || [], resetHavok: !!resetHavok, purifyFormLists: !!purifyFormLists });
            emitIfCurrent({ type: 'result', done: true, result });
        } catch (e) {
            emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
        }
    });

    // Native Save dialog, pre-filled with the next free save number -- Step 5's own real Windows
    // dialog. This route never decides where to write; it only hands back whatever the user actually
    // picked (or null if they cancelled), same as this app's every other Browse.../native-dialog route.
    router.post('/pick-save-target', async (req, res) => {
        const { essPath, game } = req.body || {};
        const normalizedGame = (game || 'skyrim').toLowerCase();
        if (!['skyrim', 'fallout4'].includes(normalizedGame)) {
            return res.status(400).json({ error: 'invalid-game', message: 'Game must be "skyrim" or "fallout4".' });
        }
        const savesDir = getSavesDir(normalizedGame);
        if (!essPath || !savesDir) {
            const label = normalizedGame === 'fallout4' ? 'Fallout 4' : 'Skyrim';
            return res.status(400).json({ error: 'not-configured', message: `Set your ${label} saves folder under Settings first.` });
        }
        try {
            const saves = saveScan.listSaves(savesDir, normalizedGame);
            const suggestedName = saveScan.suggestNextSaveName(saves, path.basename(essPath), normalizedGame);
            const gameConfig = saveScan.GAMES[normalizedGame];
            const filterLabel = normalizedGame === 'fallout4' ? 'Fallout 4 saves' : 'Skyrim saves';
            const filterExt = gameConfig.ext;
            const picked = await pickSaveFileAsync({
                title: 'Save cleaned save as',
                // The save's OWN folder, not always the top-level saves folder -- confirmed real: this
                // install organizes saves into per-profile subfolders, so opening at the generic
                // top-level Saves dir would land the dialog somewhere with no sibling saves at all.
                // Falls back to savesDir itself for a flat (subfolder-free) layout, same value either way.
                initialDir: path.dirname(essPath),
                filter: `${filterLabel} (*${filterExt})|*${filterExt}|All files (*.*)|*.*`,
                defaultFileName: suggestedName,
            });
            res.json({ path: picked });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- Save / Save As (Step 5/5b) -- one route for both; the only difference between "Save As" a
    // new file and "Save" replacing the original is which outPath the frontend sends (a brand-new
    // native-dialog pick vs. the currently-open save's own path). Either way, if something already
    // exists at outPath, it's backed up first (when a backup root is configured) before ReSaver's own
    // write touches it -- this is what makes "Save" safe to also just be a plain call to this route. ----
    const saveSession = createSseSession();
    router.get('/save/events', (req, res) => {
        if (!saveSession.get()) return res.status(404).end();
        saveSession.subscribe(res, { afterSeq: Number(req.headers['last-event-id'] || 0) });
    });
    router.post('/save', async (req, res) => {
        if (!requireResaverInstalled(res)) return;
        const { essPath, outPath, categories, resetHavok, purifyFormLists, game } = req.body || {};
        const normalizedGame = (game || 'skyrim').toLowerCase();
        if (!['skyrim', 'fallout4'].includes(normalizedGame)) {
            return res.status(400).json({ error: 'invalid-game', message: 'Game must be "skyrim" or "fallout4".' });
        }
        if (!essPath || !fs.existsSync(essPath)) {
            return res.status(400).json({ error: 'not-found', message: 'That save could not be found -- it may have been moved or deleted.' });
        }
        if (!outPath) {
            return res.status(400).json({ error: 'missing-out-path', message: 'No output file was chosen.' });
        }
        if (isGameRunning(normalizedGame)) {
            const gameLabel = normalizedGame === 'fallout4' ? 'Fallout 4' : 'Skyrim';
            return res.status(409).json({ error: 'game-running', message: `${gameLabel} is currently running. Close it completely, then try again.` });
        }
        const mySession = saveSession.start({ id: `save-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => { if (saveSession.get() === mySession) saveSession.emit(event); };
        try {
            const { saveCleanerBackupRoot, saveCleanerBackupRootFO4, maxSaveCleanerBackupsToKeep } = appConfig.loadConfig();
            const backupRoot = normalizedGame === 'fallout4' ? saveCleanerBackupRootFO4 : saveCleanerBackupRoot;
            let backup = null;
            if (fs.existsSync(outPath) && backupRoot) {
                emitIfCurrent({ type: 'phase', message: 'Backing up the file this will replace…' });
                const gameConfig = saveScan.GAMES[normalizedGame];
                const cosaveExt = gameConfig.cosaveExt;
                const cosaveOutPath = outPath.replace(new RegExp(`${gameConfig.ext}$`, 'i'), cosaveExt);
                backup = saveBackups.backupSave(backupRoot, outPath, fs.existsSync(cosaveOutPath) ? cosaveOutPath : null);
                saveBackups.pruneSaveBackups(backupRoot, maxSaveCleanerBackupsToKeep);
            }
            emitIfCurrent({ type: 'phase', message: 'Cleaning and writing the new save…' });
            const result = await resaverRunner.saveAs(essPath, outPath, { categories: categories || [], resetHavok: !!resetHavok, purifyFormLists: !!purifyFormLists });
            emitIfCurrent({ type: 'result', done: true, result: { ...result, backup } });
        } catch (e) {
            emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
        }
    });

    // ---- Backups (Settings) -- same list/count/delete-all/restore/keep-N shape as Vortex Database
    // Backups, per the mockup's own explicit "exactly like Vortex Database Backups" instruction.
    // When both Skyrim and Fallout 4 backups are configured, this combines both; when only one is
    // configured, it shows only that one's backups. ----
    function getAllBackupRoots() {
        const { saveCleanerBackupRoot, saveCleanerBackupRootFO4 } = appConfig.loadConfig();
        return [saveCleanerBackupRoot, saveCleanerBackupRootFO4].filter(Boolean);
    }

    router.get('/backups-info', (req, res) => {
        const roots = getAllBackupRoots();
        const count = roots.reduce((sum, root) => sum + saveBackups.listSaveBackups(root).length, 0);
        res.json({ count });
    });

    router.get('/backups', (req, res) => {
        const roots = getAllBackupRoots();
        const allBackups = roots.flatMap((root) => saveBackups.listSaveBackups(root).map((b) => ({ ...b, backupRoot: root })));
        res.json({ backups: allBackups });
    });

    router.post('/delete-backups', (req, res) => {
        const roots = getAllBackupRoots();
        if (roots.length === 0) return res.status(400).json({ error: 'not-configured', message: 'No backup folder is configured.' });
        try {
            const results = roots.map((root) => saveBackups.deleteAllSaveBackups(root));
            res.json({ deleted: results.reduce((sum, r) => sum + (r.deleted || 0), 0) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/restore-backup', (req, res) => {
        const { backupDir, backupRoot } = req.body || {};
        const roots = getAllBackupRoots();
        if (roots.length === 0) return res.status(400).json({ error: 'not-configured', message: 'No backup folder is configured.' });
        if (!backupDir) return res.status(400).json({ error: 'missing-backup', message: 'No backup was chosen.' });
        // If backupRoot is specified, use that; otherwise try to find which root contains this backup
        const rootToUse = backupRoot || roots.find((r) => fs.existsSync(path.join(r, backupDir)));
        if (!rootToUse) return res.status(400).json({ error: 'backup-not-found', message: 'That backup folder could not be found.' });
        try {
            res.json(saveBackups.restoreSaveBackup(rootToUse, backupDir));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

function isSkyrimRunning() {
    return isGameRunning('skyrim');
}

module.exports = { createSaveCleanerRouter, isSkyrimRunning };
