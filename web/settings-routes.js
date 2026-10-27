'use strict';
// Settings page backend -- GET/POST for the single unified config.json (lib/app-config.js). The
// Nexus API key is a credential: GET never echoes the real value back (only a boolean flag saying
// one is stored), and POST only overwrites it when the caller actually sent a non-empty new value
// (an empty/omitted field on save means "leave it alone", not "clear it") -- clearing is a separate,
// explicit action so a blank form field can never accidentally wipe an already-configured key.

const fs = require('fs');
const path = require('path');
const { openFolderInExplorer, revealInExplorer } = require('../lib/open-in-explorer');
const express = require('express');
const appConfig = require('../lib/app-config');
const { pickFolderAsync } = require('../lib/vortex-sync/win-dialog');
const { findVortexManagedConflict } = require('../lib/vortex-managed-paths');
const bridgeClient = require('../lib/vortex-bridge-client');
const { version: TOOL_VERSION } = require('../package.json');
const syncLib = require('../lib/vortex-sync/lib');
const saveScan = require('../lib/save-cleaner-scan');
const appDataManager = require('../lib/app-data-manager');
const { createSseSession } = require('./sse-session');

// App Data (2026-09-14, "split Logs from App Data"): this used to filter for
// /^rebuild-.+\.json$/ specifically, because that pattern was the ONLY thing this project ever
// wrote under logsDir -- which meant "Delete all logs" actually deleted Rebuild Collection's own
// run reports (Resume/Retry/Stats history), not troubleshooting logs at all. Those reports now live
// under App Data (getAppDataDir('rebuild-collection/reports')), never under logsDir -- so logsDir is
// finally what its name always claimed: troubleshooting-only (the app log, Merge Plugins failure
// logs, and any future tool's own). Deleting EVERYTHING under it, recursively across every tool's
// own subfolder, is now genuinely harmless, so no filename pattern is needed any more.
function listLogFiles(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
    } catch {
        return [];
    }
    return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath || e.path, e.name));
}

// Every real backup-run folder this project ever creates is named "<collectionModId>-<runTimestamp>"
// (see lib/collection-runner.js's runBackup(), and pruneOldBackups()'s own "<collectionModId>-"
// prefix match) where runTimestamp is `new Date().toISOString().replace(/[:.]/g, '-')`, e.g.
// "...-2026-07-24T18-26-16-750Z". The "Delete all backups" button below matches this suffix before
// touching anything -- a safety net so a misconfigured backupRoot (accidentally pointed at a shared/
// reused folder) can't have unrelated content wiped by this one-click destructive action.
const BACKUP_RUN_DIR_PATTERN = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function listBackupRunDirs(backupRoot) {
    let entries;
    try {
        entries = fs.readdirSync(backupRoot, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.filter((e) => e.isDirectory() && BACKUP_RUN_DIR_PATTERN.test(e.name)).map((e) => e.name);
}

const PATH_FIELDS = ['staging', 'downloads', 'backupRoot', 'syncBackupRoot', 'state', 'logsDir', 'appDataDir', 'skyrimDataDir', 'pluginsListDir', 'dummyMastersOutputDir', 'archiveFinderOutputDir', 'eslifierOutputDir', 'mergeOutputDir', 'mergeStagingCopyDir', 'pgpatcherCfgDir', 'pgpatcherOutputBackupDir', 'saveCleanerSavesDir', 'saveCleanerBackupRoot', 'saveCleanerSavesDirFO4', 'saveCleanerBackupRootFO4', 'saveCleanerSavesDirStarfield', 'saveCleanerBackupRootStarfield'];
// App Data (2026-09-14, "split Logs from App Data"): ucv2TrackingDir, cleanupExcludeListDir,
// archiveFinderDbDir, modExceptionListDir, and cycleHelperHistoryDir are RETIRED from this list (and
// from the Settings page entirely) -- appDataDir replaces all five. They stay real fields in
// lib/app-config.js's own DEFAULT_CONFIG (read-only now, LEGACY-commented there) purely so the
// one-time migration (lib/app-data-migration.js) can find whatever a returning user had customized
// them to; nothing in this router reads or writes them anymore.
//
// No sensible blank/default state for these -- Rebuild Collection can't scan a collection without
// staging/downloads, Update Collection can't save a backup without somewhere real (not "wherever
// this project happens to think is a good place") to put it, Missing Masters' three fields need a
// real answer, and appDataDir itself is the same "every new data location is a user-chosen path,
// never a silent built-in default" standing rule as it replaced (confirmed 2026-07-27, restated
// 2026-09-14 for App Data specifically: a cleanup of an unconfigured scratch/logs folder already
// deleted every real Rebuild Collection run report once -- see TECHNICAL.md). backupRoot/state/
// archiveFinderOutputDir/eslifierOutputDir are deliberately NOT required: backupRoot only matters if
// maxBackupsToKeep is turned on (0 = off, the default), state auto-detects a real default under
// %APPDATA%, archiveFinderOutputDir is just an optional pre-filled default -- the user can always
// pick a destination per extraction instead -- and eslifierOutputDir is simply inert (no ESLifier
// downgrade applied) until the user actually sets it, same "blank is a normal, supported state" as
// archiveFinderOutputDir.
const REQUIRED_PATH_FIELDS = ['staging', 'downloads', 'syncBackupRoot', 'appDataDir', 'skyrimDataDir', 'pluginsListDir', 'dummyMastersOutputDir'];
// pgpatcherCfgDir is deliberately NOT in REQUIRED_PATH_FIELDS above -- unlike skyrimDataDir/
// appDataDir (needed by tools most installs actually use), this is a single, brand-new,
// one-workflow integration; requiring it would block saving ANY OTHER setting for every install
// that never touches PGPatcher. Same "optional, blank is a supported state" treatment as
// archiveFinderOutputDir/mergeOutputDir/eslifierOutputDir -- the PGPatcher tool itself reports
// "not configured yet" and points at Settings when this is blank, rather than the whole page
// refusing to save. pgpatcherOutputBackupDir gets the exact same treatment for the same reason --
// backing up the existing PGPatcher output before a real build overwrites it is opt-in (blank =
// today's exact behavior, no backup step at all), not something every PGPatcher user is required to
// set up before saving any other setting on the page.
// Server bind settings -- like the paths above, these are only read once at process startup
// (web/server.js), so changing any of them needs the same restart-required treatment.
// appLogEnabled (2026-08-26) belongs here too, not with downloadMissingArchives/
// forceExtractOffSiteMismatches/hideVortexVersionWarning below -- lib/app-logger.js's console.*
// wrapping only ever happens once, at boot, same as autoOpenBrowser/serverPort/serverHost.
const SERVER_FIELDS = ['serverPort', 'serverHost', 'autoOpenBrowser', 'appLogEnabled'];
// Merge Plugins' own post-merge "Merge Settings" -- see lib/app-config.js's mergePostMergeAction
// comment for what each value does.
const MERGE_POST_MERGE_ACTIONS = ['disable', 'remove', 'backup-remove'];

function withoutKey(cfg) {
    const { nexusApiKey, ...rest } = cfg;
    // toolVersion (2026-08-23) -- static, from package.json, always safe to include (no network call,
    // unlike the Vortex Bridge's own version below which needs a live round-trip -- see GET /bridge-info).
    return { ...rest, hasNexusApiKey: !!nexusApiKey, toolVersion: TOOL_VERSION };
}

// Real SSE-streamed progress for a plain "delete every item in this list" action (2026-08-25, closes
// docs/UI-PATTERN-MAP.md's Settings findings: a static "Deleting…" text swap with no real feedback on
// genuinely slow filesystem work). Each item is a synchronous fs.rmSync -- fast per-file, but a real,
// possibly-long loop on a large backup/log folder -- so this reports a REAL current/total count per
// item, same technique as remove-collection-runner.js's own "deleting-archives" phase (loop one item
// at a time instead of one batch call, purely to get a per-item count out). Shared by /delete-backups
// and /delete-logs below rather than duplicated -- both are the identical shape, just a different
// item list/label.
function deleteWithProgress(session, res, itemLabel, items, deleteOne) {
    if (session.isActive()) {
        return res.status(409).json({ error: `A ${itemLabel} deletion is already in progress.` });
    }
    const mySession = session.start({ id: `${itemLabel}-${Date.now()}` });
    res.status(202).json({});
    const emitIfCurrent = (event) => {
        if (session.get() === mySession) session.emit(event);
    };
    (async () => {
        try {
            for (let i = 0; i < items.length; i++) {
                emitIfCurrent({ type: 'phase', current: i + 1, total: items.length, message: `Deleting ${itemLabel} ${i + 1} of ${items.length}…` });
                deleteOne(items[i]);
            }
            emitIfCurrent({ type: 'done', done: true, deletedCount: items.length });
        } catch (e) {
            emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
        }
    })();
}

function createSettingsRouter() {
    const router = express.Router();

    router.get('/', (req, res) => {
        const cfg = withoutKey(appConfig.loadConfig());
        // Save Cleaner's own saves-folder auto-detect for Skyrim -- checked on every GET (never written to
        // config.json until the user actually clicks Save), same "auto-detected badge, still a real
        // editable field" shape the mockup's own Settings screen shows. Uses the real (possibly
        // OneDrive-redirected) Documents folder -- see lib/save-cleaner-scan.js's own
        // resolveDefaultSavesDir/resolveDocumentsDir for why a naive os.homedir() guess isn't enough.
        if (!cfg.saveCleanerSavesDir) {
            cfg.saveCleanerSavesDir = saveScan.resolveDefaultSavesDir('skyrim');
            cfg.saveCleanerSavesDirAutoDetected = !!cfg.saveCleanerSavesDir;
        }
        // Same auto-detect for Fallout 4.
        if (!cfg.saveCleanerSavesDirFO4) {
            cfg.saveCleanerSavesDirFO4 = saveScan.resolveDefaultSavesDir('fallout4');
            cfg.saveCleanerSavesDirFO4AutoDetected = !!cfg.saveCleanerSavesDirFO4;
        }
        // Same auto-detect for Starfield.
        if (!cfg.saveCleanerSavesDirStarfield) {
            cfg.saveCleanerSavesDirStarfield = saveScan.resolveDefaultSavesDir('starfield');
            cfg.saveCleanerSavesDirStarfieldAutoDetected = !!cfg.saveCleanerSavesDirStarfield;
        }
        res.json(cfg);
    });

    router.post('/', (req, res) => {
        const body = req.body || {};
        const before = appConfig.loadConfig();
        const patch = {};

        for (const key of PATH_FIELDS) {
            if (key in body) patch[key] = (body[key] || '').trim() || null;
        }
        // One field does double duty: null = unlimited (back up every run, keep forever); 0 = off
        // (don't back up at all); 1-3 = back up every run, prune down to the N most recent after.
        if ('maxBackupsToKeep' in body) {
            const raw = body.maxBackupsToKeep;
            if (raw === null || raw === '' || raw === undefined) {
                patch.maxBackupsToKeep = null;
            } else {
                const n = Number(raw);
                patch.maxBackupsToKeep = Number.isFinite(n) ? Math.min(3, Math.max(0, Math.floor(n))) : null;
            }
        }
        // Separate field, separate backup store (see app-config.js's own comment) -- null/blank
        // means unlimited, same shape as maxBackupsToKeep, but no "0 = off" state since these
        // backups aren't optional. Minimum of 1 if a number is given at all (0 would silently
        // delete every safety backup right after it's taken, defeating the point).
        if ('maxStateBackupsToKeep' in body) {
            const raw = body.maxStateBackupsToKeep;
            if (raw === null || raw === '' || raw === undefined) {
                patch.maxStateBackupsToKeep = null;
            } else {
                const n = Number(raw);
                patch.maxStateBackupsToKeep = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : null;
            }
        }
        // Save Cleaner's own backups -- same "null = unlimited, no 0-off state" shape as
        // maxStateBackupsToKeep above (a save file is too valuable to a real playthrough to treat
        // "don't back it up at all" as a real option the way maxBackupsToKeep's 0 does).
        if ('maxSaveCleanerBackupsToKeep' in body) {
            const raw = body.maxSaveCleanerBackupsToKeep;
            if (raw === null || raw === '' || raw === undefined) {
                patch.maxSaveCleanerBackupsToKeep = null;
            } else {
                const n = Number(raw);
                patch.maxSaveCleanerBackupsToKeep = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : null;
            }
        }
        // Always a plain 1-8 integer -- unlike maxBackupsToKeep, there's no meaningful "unlimited"
        // here, so an invalid/blank value just falls back to 1 (sequential), never null.
        if ('concurrentExtractions' in body) {
            const n = Number(body.concurrentExtractions);
            patch.concurrentExtractions = Number.isFinite(n) ? Math.min(8, Math.max(1, Math.floor(n))) : 1;
        }
        if (body.clearNexusApiKey) {
            patch.nexusApiKey = null;
        } else if (typeof body.nexusApiKey === 'string' && body.nexusApiKey.trim()) {
            patch.nexusApiKey = body.nexusApiKey.trim();
        }

        if ('serverPort' in body) {
            const n = Number(body.serverPort);
            patch.serverPort = Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : 4321;
        }
        if ('serverHost' in body) {
            patch.serverHost = (body.serverHost || '').trim() || '127.0.0.1';
        }
        if ('autoOpenBrowser' in body) {
            patch.autoOpenBrowser = !!body.autoOpenBrowser;
        }
        if ('appLogEnabled' in body) {
            patch.appLogEnabled = !!body.appLogEnabled;
        }
        // Merge Plugins' "Merge Settings" -- validated against a known set rather than trusted
        // as-is (same defensive habit as maxBackupsToKeep's clamp above), since an unrecognized value
        // here would otherwise reach web/merge-routes.js's own switch and silently do nothing.
        if ('mergePostMergeAction' in body && MERGE_POST_MERGE_ACTIONS.includes(body.mergePostMergeAction)) {
            patch.mergePostMergeAction = body.mergePostMergeAction;
        }
        // Read fresh per-run (like maxBackupsToKeep/concurrentExtractions) -- deliberately NOT added
        // to PATH_FIELDS/SERVER_FIELDS, so toggling it never triggers restartRequired.
        if ('downloadMissingArchives' in body) {
            patch.downloadMissingArchives = !!body.downloadMissingArchives;
        }
        if ('forceExtractOffSiteMismatches' in body) {
            patch.forceExtractOffSiteMismatches = !!body.forceExtractOffSiteMismatches;
        }
        if ('pauseVortexHealthCheck' in body) {
            patch.pauseVortexHealthCheck = !!body.pauseVortexHealthCheck;
        }
        if ('hideVortexVersionWarning' in body) {
            patch.hideVortexVersionWarning = !!body.hideVortexVersionWarning;
        }

        // Server-side backstop for the required fields -- the Settings page itself already blocks
        // Save client-side, but this defends against a corrupt/manually-edited config.json (or any
        // future non-web caller) ending up with one of these blank via this same endpoint.
        const merged = { ...before, ...patch };
        const missing = REQUIRED_PATH_FIELDS.filter((k) => !merged[k]);
        if (missing.length > 0) {
            return res.status(400).json({ error: 'missing-required', missing, message: `Required setting(s) missing: ${missing.join(', ')}.` });
        }

        // App Data folder vs. Vortex's own managed folders (2026-08-27, GitHub issue #4; carried over
        // to appDataDir 2026-09-14 -- this same check used to target archiveFinderDbDir specifically,
        // since that was the one thing that opened a real SQLite connection inside a user-chosen
        // folder; App Data now holds that same database, so the same collision risk applies to it
        // instead). Checked against `merged`, not just `patch`, so this catches BOTH a fresh
        // appDataDir being pointed at Vortex's territory AND downloads/staging being changed to
        // somewhere that now happens to contain an already-saved appDataDir. Server-side backstop
        // (same reasoning as the REQUIRED_PATH_FIELDS check above) -- the Settings page itself should
        // also warn/block client-side, but a corrupt/manually-edited config.json or any future
        // non-web caller must not be able to slip past this via this same endpoint. See
        // lib/vortex-managed-paths.js for exactly which folders count and why.
        const dbConflict = findVortexManagedConflict(merged.appDataDir, { downloads: merged.downloads, staging: merged.staging });
        if (dbConflict) {
            return res.status(400).json({
                error: 'app-data-in-vortex-folder',
                message: `The App Data folder can't be the same as, or inside, your ${dbConflict.label} ("${dbConflict.path}"). Vortex actively manages that folder, and the Archive Finder database that lives in App Data can block Vortex itself with a "File busy" error if left open there. Choose a different folder.`,
            });
        }

        const restartRequired = [...PATH_FIELDS, ...SERVER_FIELDS].some((k) => k in patch && patch[k] !== before[k]);
        const after = appConfig.saveConfig(patch);
        res.json({ ...withoutKey(after), restartRequired });
    });

    // Native folder-browser dialog for the path fields' "Browse..." buttons -- runs on the SAME
    // machine as the browser (this whole tool assumes that), so a server-side native dialog is a
    // real option, unlike a browser file input (which never exposes a real absolute OS path).
    router.post('/browse-folder', async (req, res) => {
        const { initialDir, title } = req.body || {};
        try {
            const picked = await pickFolderAsync({ title: title || 'Select a folder', initialDir: initialDir || undefined });
            res.json({ path: picked });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Vortex Bridge's own reported version + connection state (2026-08-23) -- separate from the
    // main GET / above since this needs a real network round-trip to the Vortex Bridge's /health endpoint
    // (slow/absent whenever Vortex isn't open), unlike the static toolVersion field. Never throws --
    // getBridgeHealth already returns null on any failure, same "connected: false" either way whether
    // Vortex is closed or the extension genuinely isn't installed.
    //
    // Also reports whether that version is new enough (2026-08-23). The comparison lives HERE, not in
    // the browser, because it's a real semver comparison and `semver` is a Node dependency -- the
    // frontend just renders the booleans. `outdated` is only ever true when genuinely connected: "not
    // connected" is a separate state with its own established "Vortex Connection Required" handling,
    // and conflating the two would tell someone with no Vortex Bridge at all that theirs is out of date.
    router.get('/bridge-info', async (req, res) => {
        const health = await bridgeClient.getBridgeHealth();
        const connected = !!health && health.ok === true && health.gameId === syncLib.GAME_ID;
        const version = connected ? (health.version || null) : null;
        res.json({
            connected,
            version,
            minVersion: bridgeClient.MIN_BRIDGE_VERSION,
            outdated: connected && bridgeClient.isBridgeOutdated(version),
        });
    });

    // Read-only count for the "Delete all backups" confirmation dialog -- lets the client show a
    // real, specific number ("This will delete N backup(s)") before the user commits, rather than a
    // vague "are you sure?".
    router.get('/backups-info', (req, res) => {
        const { backupRoot } = appConfig.loadConfig();
        if (!backupRoot) return res.json({ backupRoot: null, count: 0 });
        res.json({ backupRoot, count: listBackupRunDirs(backupRoot).length });
    });

    const deleteBackupsSession = createSseSession();

    router.get('/delete-backups/events', (req, res) => {
        if (!deleteBackupsSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        deleteBackupsSession.subscribe(res, { afterSeq });
    });

    // Deletes every real backup-run folder under the configured backupRoot -- permanent, no undo.
    // Only touches folders matching BACKUP_RUN_DIR_PATTERN (see its own comment above); anything else
    // sitting in backupRoot is left alone.
    router.post('/delete-backups', (req, res) => {
        const { backupRoot } = appConfig.loadConfig();
        if (!backupRoot) return res.status(400).json({ error: 'No backup root folder is configured.' });
        const dirs = listBackupRunDirs(backupRoot);
        deleteWithProgress(deleteBackupsSession, res, 'backup', dirs, (name) => {
            fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
        });
    });

    // Read-only count+size for the "Delete Logs" confirmation, same reasoning as /backups-info
    // above. Recursive across every tool's own logs subfolder (app/, merge-plugins/, any future
    // one) -- see listLogFiles' own comment for why this no longer needs a filename pattern.
    router.get('/logs-info', (req, res) => {
        const logsRoot = appConfig.getLogsRoot();
        const files = listLogFiles(logsRoot);
        const totalBytes = files.reduce((sum, f) => { try { return sum + fs.statSync(f).size; } catch { return sum; } }, 0);
        res.json({ logsRoot, count: files.length, totalBytes });
    });

    const deleteLogsSession = createSseSession();

    router.get('/delete-logs/events', (req, res) => {
        if (!deleteLogsSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        deleteLogsSession.subscribe(res, { afterSeq });
    });

    // Deletes every real file under the Logs folder, recursively across every tool's own subfolder --
    // permanent, no undo, but genuinely harmless now that Logs holds nothing but troubleshooting
    // notes (see listLogFiles' own comment). App Data is a completely separate folder tree and is
    // never touched by this.
    router.post('/delete-logs', (req, res) => {
        const logsRoot = appConfig.getLogsRoot();
        const files = listLogFiles(logsRoot);
        deleteWithProgress(deleteLogsSession, res, 'log file', files, (fullPath) => {
            fs.rmSync(fullPath, { force: true });
        });
    });

    // Opens the logs root folder itself in Explorer (navigates INTO it), unlike the Reveal buttons
    // elsewhere in this app which select a specific file/folder within ITS parent -- there's no
    // single file to select here, just "show me where these live."
    router.post('/open-logs-folder', (req, res) => {
        const logsRoot = appConfig.getLogsRoot();
        fs.mkdirSync(logsRoot, { recursive: true });
        try { openFolderInExplorer(logsRoot); } catch (e) { return res.status(400).json({ error: e.message }); }
        res.json({ ok: true });
    });

    // ---------- App Data (2026-09-14, "split Logs from App Data") ----------

    // Read-only total for the section's own header line ("N items · X MB") -- `configured: false`
    // when appDataDir hasn't been set yet, so the client can show its own "set this up" prompt
    // instead of an empty checklist that looks broken.
    router.get('/app-data-info', (req, res) => {
        const { appDataDir, staging } = appConfig.loadConfig();
        if (!appDataDir) return res.json({ appDataDir: null, configured: false, count: 0, sizeBytes: 0 });
        const groups = appDataManager.buildGroups(appDataDir, { staging });
        const { count, sizeBytes } = appDataManager.totalCountAndSize(groups);
        res.json({ appDataDir, configured: true, count, sizeBytes });
    });

    // The full checklist -- one group per tool+data-kind (see lib/app-data-manager.js's own
    // buildGroups), each carrying its own director-approved "lose" copy so the delete confirmation
    // never has to be rebuilt/duplicated client-side.
    router.get('/app-data-items', (req, res) => {
        const { appDataDir, staging } = appConfig.loadConfig();
        if (!appDataDir) return res.json({ configured: false, groups: [] });
        res.json({ configured: true, groups: appDataManager.buildGroups(appDataDir, { staging }) });
    });

    const deleteAppDataSession = createSseSession();

    router.get('/delete-app-data-items/events', (req, res) => {
        if (!deleteAppDataSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        deleteAppDataSession.subscribe(res, { afterSeq });
    });

    // Deletes exactly the items the client selected -- never a delete-all. Every path is
    // re-validated server-side against the CURRENT appDataDir before anything is touched (never
    // trust a client-supplied path without validating containment, same rule this app already
    // applies to log filenames and merge history paths) -- a stale/tampered id can't escape App Data.
    router.post('/delete-app-data-items', (req, res) => {
        const { appDataDir } = appConfig.loadConfig();
        if (!appDataDir) return res.status(400).json({ error: 'No App Data folder is configured.' });
        const deletePaths = Array.isArray(req.body?.deletePaths) ? req.body.deletePaths : [];
        const { valid, errors } = appDataManager.validateAndCollectPaths(appDataDir, deletePaths);
        if (errors.length > 0) console.error(`[settings-routes] /delete-app-data-items: ${errors.join(' ')}`);
        deleteWithProgress(deleteAppDataSession, res, 'item', valid, (p) => {
            fs.rmSync(p, { recursive: true, force: true });
        });
    });

    // Same "navigate INTO it" treatment as /open-logs-folder above.
    router.post('/open-app-data-folder', (req, res) => {
        const { appDataDir } = appConfig.loadConfig();
        if (!appDataDir) return res.status(400).json({ error: 'No App Data folder is configured.' });
        fs.mkdirSync(appDataDir, { recursive: true });
        try { openFolderInExplorer(appDataDir); } catch (e) { return res.status(400).json({ error: e.message }); }
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createSettingsRouter };
