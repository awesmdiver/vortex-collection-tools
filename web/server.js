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
// Usage: node web/server.js [--port N] [--staging <dir>] [--downloads <dir>] [--state <path>]
//   [--backup-root <dir>] [--no-open]

const path = require('path');
const express = require('express');
const { spawn } = require('child_process');

const { createRouter } = require('./rebuild-routes');
const { createSyncRouter } = require('./sync-routes');
const { createSettingsRouter } = require('./settings-routes');
const { loadSyncLib } = require('../lib/collection-runner');
const appConfig = require('../lib/app-config');

function parseArgs(argv) {
    const args = {
        port: 4321,
        staging: null,
        downloads: null,
        state: null,
        backupRoot: null,
        open: true,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--port') args.port = Number(argv[++i]);
        else if (argv[i] === '--staging') args.staging = argv[++i];
        else if (argv[i] === '--downloads') args.downloads = argv[++i];
        else if (argv[i] === '--state') args.state = argv[++i];
        else if (argv[i] === '--backup-root') args.backupRoot = argv[++i];
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
        port: cliArgs.port,
        open: cliArgs.open,
        staging: cliArgs.staging || fileConfig.staging || null,
        downloads: cliArgs.downloads || fileConfig.downloads || null,
        backupRoot: cliArgs.backupRoot || fileConfig.backupRoot || null,
        state: cliArgs.state || fileConfig.state || syncLib.DEFAULT_STATE_DIR,
        // maxBackupsToKeep is NOT included here deliberately -- unlike the paths above, it's read
        // fresh from config.json at the moment each rebuild run actually needs it (see
        // rebuild-routes.js), not baked in at startup, so changing it never needs a restart.
    };

    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/api/rebuild', createRouter(config));
    app.use('/api/sync', createSyncRouter(config));
    app.use('/api/settings', createSettingsRouter());

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
                spawn(process.execPath, [__filename, ...respawnArgs], {
                    cwd: process.cwd(), stdio: 'ignore', detached: true,
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

    server = app.listen(config.port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${config.port}`;
        console.log(`Vortex Collection Tools running at ${url}`);
        if (config.staging && config.downloads) {
            console.log(`Staging: ${config.staging}`);
            console.log(`Downloads: ${config.downloads}`);
            console.log(`Backup root: ${config.backupRoot || '(not set -- backups will be skipped until configured)'}`);
        } else {
            console.log('Staging/downloads not configured yet -- open Settings in the web UI to set them up.');
        }
        console.log('(bound to 127.0.0.1 only -- not reachable from the network)');
        if (config.open) {
            spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
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
