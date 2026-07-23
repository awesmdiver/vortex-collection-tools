#!/usr/bin/env node
// Local web UI for Vortex Collection Tools -- Rebuild Collection (lib/collection-runner.js,
// mounted at /api/rebuild) and Update Collection (lib/sync-runner.js, mounted at /api/sync).
// Binds to 127.0.0.1 ONLY -- never 0.0.0.0 -- since this server can trigger real filesystem/
// state-DB mutations. No auth: whoever can reach this process can already run `node` on this
// machine and has full access anyway, same trust model as the CLI.
//
// Usage: node web/server.js [--port N] [--staging <dir>] [--downloads <dir>] [--state <path>]
//   [--backup-root <dir>] [--no-open]

const path = require('path');
const express = require('express');
const { spawn } = require('child_process');

const { createRouter } = require('./rebuild-routes');
const { createSyncRouter } = require('./sync-routes');
const { loadSyncLib } = require('../lib/collection-runner');

function parseArgs(argv) {
    const args = {
        port: 4321,
        staging: 'E:/Vortex Mods/skyrimse',
        downloads: 'F:/Vortex Downloads/skyrimse',
        state: null, // resolved below via syncLib.DEFAULT_STATE_DIR once loaded
        backupRoot: 'F:/Mod Extraction/Vortex-Rebuild-Backups',
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
    const args = parseArgs(process.argv.slice(2));

    let syncLib;
    try {
        syncLib = loadSyncLib();
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    if (!args.state) args.state = syncLib.DEFAULT_STATE_DIR;

    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/api/rebuild', createRouter(args));
    app.use('/api/sync', createSyncRouter(args));

    const server = app.listen(args.port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${args.port}`;
        console.log(`Vortex Collection Tools running at ${url}`);
        console.log(`Staging: ${args.staging}`);
        console.log(`Downloads: ${args.downloads}`);
        console.log(`Backup root: ${args.backupRoot}`);
        console.log('(bound to 127.0.0.1 only -- not reachable from the network)');
        if (args.open) {
            spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
        }
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`Port ${args.port} is already in use -- pick another with --port <N>.`);
            process.exit(1);
        }
        throw e;
    });
}

main();
