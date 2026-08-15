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
const { createModExceptionsRouter } = require('./mod-exceptions-routes');
const { loadSyncLib } = require('../lib/collection-runner');
const appConfig = require('../lib/app-config');

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
        cleanupExcludeListDir: fileConfig.cleanupExcludeListDir || null,
        // Missing Masters utility -- no CLI flags for these either, config.json/Settings only.
        skyrimDataDir: fileConfig.skyrimDataDir || null,
        pluginsListDir: fileConfig.pluginsListDir || null,
        dummyMastersOutputDir: fileConfig.dummyMastersOutputDir || null,
        // ESLifier awareness -- optional, blank is a supported state (see app-config.js's own
        // comment). No CLI flag, config.json/Settings only.
        eslifierOutputDir: fileConfig.eslifierOutputDir || null,
        // Archive Finder utility -- no CLI flag, config.json/Settings only. Deliberately reuses
        // `downloads` above as its own scan folder, no separate field for that.
        archiveFinderDbDir: fileConfig.archiveFinderDbDir || null,
        // Mod Exceptions list (lib/mod-exception-store.js) -- shared between Rebuild Collection and
        // Rebuild Missing Files. No CLI flag, config.json/Settings only.
        modExceptionListDir: fileConfig.modExceptionListDir || null,
        // maxBackupsToKeep is NOT included here deliberately -- unlike the paths above, it's read
        // fresh from config.json at the moment each rebuild run actually needs it (see
        // rebuild-routes.js), not baked in at startup, so changing it never needs a restart.
    };

    const app = express();
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
    app.use('/api/mod-exceptions', createModExceptionsRouter());

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
            process.exit(1);
        }
        throw e;
    });
}

main();
