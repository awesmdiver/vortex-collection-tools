#!/usr/bin/env node
// Local web UI for Vortex Collection Tools -- Rebuild Collection (lib/collection-runner.js,
// mounted at /api/rebuild), Update Collection (lib/sync-runner.js, mounted at /api/sync), and
// Settings (lib/app-config.js, mounted at /api/settings). Binds to 127.0.0.1 ONLY -- never
// 0.0.0.0 -- since this server can trigger real filesystem/state-DB mutations. No auth: whoever
// can reach this process can already run `node` on this machine and has full access anyway, same
// trust model as the CLI.
//
// Paths (staging/downloads/backupRoot/state) have NO hardcoded default -- this project is meant
// to be shared, so nothing machine-specific is baked into source. Resolution order: explicit CLI
// flag wins, then the unified config.json (lib/app-config.js, edited via the Settings page), then
// (state only) Vortex's own auto-detected default under %APPDATA%. If staging/downloads are still
// unset after that, the server boots anyway -- every route that needs them handles the unconfigured
// case explicitly instead of crashing (see rebuild-routes.js/sync-routes.js's own comments).
//
// Usage: node web/server.js [--port N] [--host <ip>] [--staging <dir>] [--downloads <dir>]
//   [--state <path>] [--backup-root <dir>] [--no-open]

const path = require('path');
const express = require('express');
const { spawn } = require('child_process');

const { createRouter } = require('./rebuild-routes');
const { createSyncRouter } = require('./sync-routes');
const { createSettingsRouter } = require('./settings-routes');
const { createStatsRouter } = require('./stats-routes');
const { createWorkThroughRouter } = require('./work-through-routes');
const { createRulesGeneratorRouter } = require('./rules-generator-routes');
const { createCleanupRouter } = require('./cleanup-routes');
const { createMissingMastersRouter } = require('./missing-masters-routes');
const { createArchiveFinderRouter } = require('./archive-finder-routes');
const { createMergeRouter } = require('./merge-routes');
const { createRebuildMissingRouter } = require('./rebuild-missing-routes');
const { createWorkshopReportRouter } = require('./workshop-report-routes');
const { createMergeHistoryRouter } = require('./merge-history-routes');
const { createMergeUpdateReportRouter } = require('./merge-update-report-routes');
const { createModExceptionsRouter } = require('./mod-exceptions-routes');
const { createCycleHelperRouter } = require('./cycle-helper-routes');
const { createUpdateCollectionV2Router } = require('./update-collection-v2-routes');
const { createRemoveCollectionRouter } = require('./remove-collection-routes');
const { createRemovedFromMainRouter } = require('./removed-from-main-routes');
const { createPgpatcherRouter } = require('./pgpatcher-routes');
const { createClearUpdateFlagsRouter } = require('./clear-update-flags-routes');
const { createSaveCleanerRouter } = require('./save-cleaner-routes');
const { createFileRetrieverRouter } = require('./file-retriever-routes');
const { createDuplicateVersionCleanupRouter } = require('./duplicate-version-cleanup-routes');
const { createAddModsToCollectionsRouter } = require('./add-mods-to-collections-routes');
const { createDeployRouter } = require('./deploy-routes');
const { createRequestGuard } = require('./request-guard');
const { createClientErrorRouter } = require('./client-error-route');
const { loadSyncLib } =require('../lib/collection-runner');
const appConfig = require('../lib/app-config');
const bridgeClient = require('../lib/vortex-bridge-client');
const syncLib = require('../lib/vortex-sync/lib');
const fomodPickerData = require('../lib/fomod-picker-data');

function parseArgs(argv) {
    const args = {
        // port/host/open default to null/undefined here (not their real defaults) so main() can
        // tell "not passed on the CLI" apart from "passed" and fall back to config.json, same
        // resolution order as the path fields below (CLI flag > config.json > built-in default).
        port: null,
        host: null,
        staging: null,
        downloads: null,
        state: null,
        backupRoot: null,
        syncBackupRoot: null,
        open: null,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--port') args.port = Number(argv[++i]);
        else if (argv[i] === '--host') args.host = argv[++i];
        else if (argv[i] === '--staging') args.staging = argv[++i];
        else if (argv[i] === '--downloads') args.downloads = argv[++i];
        else if (argv[i] === '--state') args.state = argv[++i];
        else if (argv[i] === '--backup-root') args.backupRoot = argv[++i];
        else if (argv[i] === '--sync-backup-root') args.syncBackupRoot = argv[++i];
        else if (argv[i] === '--no-open') args.open = false;
        else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
    }
    return args;
}

function main() {
    const cliArgs = parseArgs(process.argv.slice(2));

    let syncLib;
    try {
        syncLib = loadSyncLib();
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }

    const fileConfig = appConfig.loadConfig();

    // Application-level log (2026-08-26, lib/app-logger.js) -- opt-in, off by default. Initialized
    // as early as possible in main() (right after config is readable at all) so it captures as much
    // of real startup as it can, including the resolved-config dump right below, and the App Data
    // migration's own console.log/error calls right after this block -- genuinely can't be any
    // earlier than this -- the decision itself comes from config.json, which isn't loaded until
    // the line above.
    let appLogPath = null;
    if (fileConfig.appLogEnabled) {
        appLogPath = require('../lib/app-logger').initAppLogger();
        console.log(`[startup] Application log enabled -- writing to ${appLogPath}`);
    } else {
        require('../lib/app-logger').initConsoleStamp(); // the time in front of every console line, log file or not
    }

    // App Data one-time migration (2026-09-14, "split Logs from App Data") -- a no-op until
    // appDataDir is actually set, and a no-op again on every startup after the real move already
    // happened (see lib/app-data-migration.js's own header for why it's always safe to re-run). Runs
    // before the `config` object below is built so every resolved*Dir field it reads already
    // reflects the post-migration location.
    require('../lib/app-data-migration').migrateIfConfigured(fileConfig);

    const config = {
        port: cliArgs.port || fileConfig.serverPort || 4321,
        host: cliArgs.host || fileConfig.serverHost || '127.0.0.1',
        // --no-open always wins (sandbox-test-rebuild.js relies on this to force it off
        // regardless of the user's own autoOpenBrowser preference); otherwise fall back to config.
        open: cliArgs.open === false ? false : fileConfig.autoOpenBrowser !== false,
        staging: cliArgs.staging || fileConfig.staging || null,
        downloads: cliArgs.downloads || fileConfig.downloads || null,
        backupRoot: cliArgs.backupRoot || fileConfig.backupRoot || null,
        syncBackupRoot: cliArgs.syncBackupRoot || fileConfig.syncBackupRoot || null,
        state: cliArgs.state || fileConfig.state || syncLib.DEFAULT_STATE_DIR,
        // No CLI flag for this one (same as logsDir) -- config.json/Settings is the only path in.
        // App Data (2026-09-14): cleanupExcludeListDir is retired from Settings but kept as the
        // legacy fallback for anyone who had customized it -- see app-config.js's own LEGACY
        // comment on the field and resolveDataDir's own header.
        cleanupExcludeListDir: appConfig.resolveDataDir('mod-scrub', fileConfig.cleanupExcludeListDir),
        // Missing Masters utility -- no CLI flags for these either, config.json/Settings only.
        skyrimDataDir: fileConfig.skyrimDataDir || null,
        pluginsListDir: fileConfig.pluginsListDir || null,
        dummyMastersOutputDir: fileConfig.dummyMastersOutputDir || null,
        // ESLifier awareness -- optional, blank is a supported state (see app-config.js's own
        // comment). No CLI flag, config.json/Settings only.
        eslifierOutputDir: fileConfig.eslifierOutputDir || null,
        // Archive Finder utility -- no CLI flag, config.json/Settings only. Deliberately reuses
        // `downloads` above as its own scan folder, no separate field for that. App Data (2026-09-14):
        // archiveFinderDbDir is retired from Settings but kept as the legacy fallback -- see
        // cleanupExcludeListDir's own comment just above.
        archiveFinderDbDir: appConfig.resolveDataDir('archive-finder/index', fileConfig.archiveFinderDbDir),
        // Mod Exceptions list (lib/mod-exception-store.js) -- shared between Rebuild Collection and
        // Rebuild Missing Files. No CLI flag, config.json/Settings only. App Data (2026-09-14):
        // modExceptionListDir is retired from Settings but kept as the legacy fallback -- see
        // cleanupExcludeListDir's own comment above.
        modExceptionListDir: appConfig.resolveDataDir('mod-exceptions', fileConfig.modExceptionListDir),
        // PGPatcher Load Order Editor -- optional, blank is a supported state (see app-config.js's
        // own comment). No CLI flag, config.json/Settings only.
        pgpatcherCfgDir: fileConfig.pgpatcherCfgDir || null,
        pgpatcherOutputBackupDir: fileConfig.pgpatcherOutputBackupDir || null,
        // Save Cleaner -- optional, blank is a supported state (auto-detected on Settings load
        // instead; see web/settings-routes.js). No CLI flag, config.json/Settings only.
        saveCleanerSavesDir: fileConfig.saveCleanerSavesDir || null,
        saveCleanerBackupRoot: fileConfig.saveCleanerBackupRoot || null,
        // maxBackupsToKeep is NOT included here deliberately -- unlike the paths above, it's read
        // fresh from config.json at the moment each rebuild run actually needs it (see
        // rebuild-routes.js), not baked in at startup, so changing it never needs a restart.
    };

    const app = express();
    // Must stay first: refuses other websites' requests (Host/Origin/X-VCT checks) before static
    // files, routing and body parsing. See web/request-guard.js.
    app.use(createRequestGuard({ host: config.host, port: config.port }));
    // Before the app-wide json parser on purpose: this route has its own 2 KB body cap.
    app.use('/api/client-error', createClientErrorRouter());
    // Default 100kb is too small for "extract everything" on a big collection -- Rebuild Missing
    // Files' /extract sends a {source, destination} pair per missing file, and a collection with
    // hundreds of missing files across many mods can clear 100kb easily (confirmed live: 413 on
    // "My GTS Audio Overhaul"). 10mb comfortably covers even a very large collection's full list.
    app.use(express.json({ limit: '10mb' }));
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/api/rebuild', createRouter(config));
    app.use('/api/sync', createSyncRouter(config));
    app.use('/api/settings', createSettingsRouter());
    app.use('/api/stats', createStatsRouter());
    app.use('/api/work-through', createWorkThroughRouter());
    app.use('/api/rules-generator', createRulesGeneratorRouter(config));
    app.use('/api/cleanup', createCleanupRouter(config));
    app.use('/api/missing-masters', createMissingMastersRouter(config));
    app.use('/api/archive-finder', createArchiveFinderRouter(config));
    app.use('/api/merge', createMergeRouter(config));
    app.use('/api/rebuild-missing', createRebuildMissingRouter(config));
    app.use('/api/workshop-report', createWorkshopReportRouter(config));
    app.use('/api/merge-history', createMergeHistoryRouter(config));
    app.use('/api/merge-update-report', createMergeUpdateReportRouter(config));
    app.use('/api/mod-exceptions', createModExceptionsRouter());
    app.use('/api/cycle-helper', createCycleHelperRouter(config));
    app.use('/api/update-collection-v2', createUpdateCollectionV2Router(config));
    app.use('/api/remove-collection', createRemoveCollectionRouter(config));
    app.use('/api/removed-from-main', createRemovedFromMainRouter(config));
    app.use('/api/pgpatcher', createPgpatcherRouter(config));
    app.use('/api/clear-update-flags', createClearUpdateFlagsRouter(config));
    app.use('/api/save-cleaner', createSaveCleanerRouter(config));
    app.use('/api/file-retriever', createFileRetrieverRouter());
    app.use('/api/duplicate-version-cleanup', createDuplicateVersionCleanupRouter(config));
    app.use('/api/add-mods-to-collections', createAddModsToCollectionsRouter());
    // Shared Deploy step (2026-09-14) -- Rebuild Collection, Rebuild Missing Files, and Update
    // Collection v2 all call this one router now; see its own header comment.
    app.use('/api/deploy', createDeployRouter());

    // Shared FOMOD preview-image route (2026-09-17, "Open FOMOD mods get an Install button") -- was
    // update-collection-v2-routes.js's own private /fomod-image; now a whole-app route (not scoped
    // to any one tool area) since Rebuild Missing Files and Rebuild Collection's own new Install
    // action populate the SAME server-side image cache (lib/fomod-picker-data.js's
    // registerFomodImages, keyed by the mod's own Nexus modId, not by which tool detected it) via
    // their own detectFomodChoiceNeed calls. A plain GET (not POST) -- exactly what an <img src>
    // tag needs to request directly, and a read-only, side-effect-free lookup either way.
    app.get('/api/fomod-image', (req, res) => {
        const { modId, imagePath } = req.query || {};
        if (!modId || !imagePath) return res.status(400).end();
        const resolved = fomodPickerData.serveFomodImage(String(modId), String(imagePath));
        if (!resolved) return res.status(404).end();
        res.sendFile(resolved);
    });

    // Best-effort cleanup for a cancelled FOMOD picker (2026-09-17, item 12b,
    // diagnostics/fomod-parity/findings-log.md -- "clean up after a cancelled FOMOD picker"). Real
    // Vortex's own cancel path is fully transactional; ours leaked a scratch preview-image dir per
    // cancelled-and-never-reopened mod until this. closeFomodPicker() fires this once per mod still
    // in the abandoned session (fire-and-forget, never awaited) -- always responds ok regardless of
    // outcome, since a cleanup failure must never surface to someone who just pressed Cancel.
    // releaseFomodImages() itself is already a safe no-op when `imageCacheToken` doesn't match the
    // CURRENTLY registered entry (e.g. the same mod reopened immediately after cancelling already
    // registered a fresh one), so this never risks deleting a dir a live session is using.
    app.post('/api/fomod-image-cleanup', (req, res) => {
        const { modId, imageCacheToken } = req.body || {};
        if (modId && imageCacheToken) {
            try {
                fomodPickerData.releaseFomodImages(String(modId), String(imageCacheToken));
            } catch {
                // Best-effort -- see comment above.
            }
        }
        res.json({ ok: true });
    });

    // Shared, whole-app route (not scoped to any one tool area) -- shell.js's Home "Update
    // Collection" card uses this to decide LIVE, on every click, whether to open Update Collection
    // v2 (Vortex Bridge reachable) or Classic (Vortex Bridge not reachable) -- the user never sees or picks
    // between the two, one button routes automatically. Checked fresh every time, not cached at
    // page load, since the Vortex Bridge/Vortex's own running state can change between visits. Same real
    // checkBridgeAvailable() every *-routes.js file already calls internally for its own
    // opportunistic fallback -- this is just the first place it's exposed directly to the frontend.
    // One patient health try (10 s) for Update Collection's first check -- the page keeps asking until Vortex answers or about
    // 45 seconds pass, and reports "final" so the give-up is logged. See probeBridge in lib/vortex-bridge-client.js.
    app.get('/api/update-collection-v2-bridge-probe', async (req, res) => {
        const answer = await bridgeClient.probeBridge({ gameId: syncLib.GAME_ID });
        res.json(answer);
    });
    app.post('/api/update-collection-v2-bridge-probe/gave-up', (req, res) => {
        const waited = Math.round(Number(req.body && req.body.waitedMs) || 0);
        console.warn('[vortex-bridge] Update Collection gave up waiting for Vortex after ' + waited + ' ms (' + (Number(req.body && req.body.attempts) || 0) + ' tries): Vortex did not answer /health in time.');
        res.json({ ok: true });
    });

    app.get('/api/bridge-status', async (req, res) => {
        const available = await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID);
        res.json({ available });
    });

    // Settings page's "Restart Now" button -- spawns a fresh, fully independent instance of this
    // same server (same args this one was launched with, forcing --no-open since a browser tab is
    // already open), then tears this one down. `server` is assigned below, after this route is
    // registered -- the handler closes over that `let` binding, so it correctly sees the real
    // instance once listen() actually runs.
    let server;
    app.post('/api/settings/restart-server', (req, res) => {
        res.json({ ok: true });
        // Small delay so the response above actually reaches the browser before teardown starts.
        setTimeout(() => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                const respawnArgs = process.argv.slice(2).filter((a) => a !== '--no-open');
                respawnArgs.push('--no-open');
                // windowsHide: true -- without it, a detached console-subsystem process (node.exe)
                // spawned on Windows gets its own new console window, which flashes visibly on
                // screen for a moment before settling into the background. Confirmed live 2026-07-27:
                // the respawned server (and, before this fix, the browser-opening cmd.exe spawn
                // below) both did this on every Settings-triggered restart.
                spawn(process.execPath, [__filename, ...respawnArgs], {
                    cwd: process.cwd(), stdio: 'ignore', detached: true, windowsHide: true,
                }).unref();
                process.exit(0);
            };
            // server.close()'s callback only fires once every connection is done -- an open SSE
            // stream (this app uses several) could keep one alive indefinitely. Force the restart
            // anyway after a short grace period rather than hanging forever.
            server.close(finish);
            setTimeout(finish, 2000);
        }, 150);
    });

    // Used by stop.ps1/stop.bat for a clean shutdown (vs. Ctrl+C/closing the window, which work
    // equally well). Same graceful-close-with-grace-period pattern as restart-server above, minus
    // the respawn.
    app.post('/api/shutdown', (req, res) => {
        res.json({ ok: true, message: 'Shutting down' });
        setTimeout(() => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                process.exit(0);
            };
            server.close(finish);
            setTimeout(finish, 2000);
        }, 150);
    });

    server = app.listen(config.port, config.host, () => {
        // A browser can't navigate to 0.0.0.0 -- that only means "all interfaces" as a bind
        // address. Always open/print a real loopback URL for local browsing; the bind-address line
        // below is what actually tells the user whether the network can reach it too.
        const isLoopback = config.host === '127.0.0.1' || config.host === 'localhost';
        const browseUrl = `http://${isLoopback ? config.host : '127.0.0.1'}:${config.port}`;
        console.log(`Vortex Collection Tools running at ${browseUrl}`);
        // A Health Check pause that a crash or a failed restore left behind is put back now (only while the
        // switches still read as off); if Vortex is not up yet it is tried again at the start of the next job.
        require('../lib/health-check-pause').recoverPendingSnapshot().catch(() => {});
        // Real PID + how this process was started -- both come up directly in real debugging
        // (GitHub issue #4's own investigation had to guess at exactly this). VCT_STARTED_BY is set
        // by launcher/src-tauri/src/main.rs's own spawn_node() right before it spawns node.exe --
        // absent (undefined) means this was started some other way (a terminal, start-server.ps1/
        // .bat, sandbox-test-rebuild.js, etc.), which is itself useful to know.
        console.log(`[startup] PID ${process.pid}, started via ${process.env.VCT_STARTED_BY || 'terminal/direct (not the tray launcher)'}`);
        // Full resolved config dump -- every actual path value, not just "configured"/"not
        // configured" (task's own explicit ask, motivated by issue #4's own remaining guesswork).
        // Safe to dump whole: `config` here is main()'s own local resolved-startup object, which
        // never copies nexusApiKey out of fileConfig in the first place (see its construction above)
        // -- no redaction needed, nothing sensitive is in it.
        console.log('[startup] Resolved config:', JSON.stringify(config, null, 2));
        if (config.staging && config.downloads) {
            console.log(`Staging: ${config.staging}`);
            console.log(`Downloads: ${config.downloads}`);
            console.log(`Backup root: ${config.backupRoot || '(not set -- backups will be skipped until configured)'}`);
        } else {
            console.log('Staging/downloads not configured yet -- open Settings in the web UI to set them up.');
        }
        if (isLoopback) {
            console.log(`(bound to ${config.host} only -- not reachable from the network)`);
        } else {
            console.log(`(bound to ${config.host} -- REACHABLE FROM THE NETWORK. This server has no authentication; anyone who can reach it has full control of your mod files.)`);
        }
        if (config.open) {
            spawn('cmd.exe', ['/c', 'start', '', browseUrl], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
        }
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`Port ${config.port} is already in use -- pick another with --port <N>.`);
            // Exit code 3, distinct from both 0 (clean/deliberate stop) and the general nonzero-crash
            // bucket a plain exit(1) would fall into -- launcher/src-tauri/src/main.rs's
            // spawn_crash_monitor special-cases this one so "someone else already has this port" is
            // never misclassified as a genuine crash and respawned into a doomed loop (every respawn
            // would hit this identical EADDRINUSE again). Keep this in sync with that file's own
            // PORT_CONFLICT_EXIT_CODE constant if this ever changes.
            process.exit(3);
        }
        throw e;
    });
}

main();
