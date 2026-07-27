#!/usr/bin/env node
// Copies every EXISTING staging folder for a collection's kept mods to a sandbox directory, before
// a real rebuild, so a "before" state exists to compare against once Vortex re-scans the collection
// afterward (e.g. investigating why Vortex reports new/changed files on next deploy). Read-only
// against the real staging folders -- never touches them, just copies out. Requires Vortex closed
// (same as any other real state read this tool does).
//
// Usage:
//   node snapshot-collection-staging.js --collection-mod-id <id> --output <dir> [--staging <path>]
//     [--downloads <path>] [--state <path>]

const fs = require('fs');
const path = require('path');
const runner = require('./lib/collection-runner');
const appConfig = require('./lib/app-config');

const fileConfig = appConfig.loadConfig();

function parseArgs(argv) {
    const args = {
        collectionModId: null,
        output: null,
        staging: fileConfig.staging || null,
        downloads: fileConfig.downloads || null,
        state: fileConfig.state || null,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--collection-mod-id') args.collectionModId = argv[++i];
        else if (argv[i] === '--output') args.output = argv[++i];
        else if (argv[i] === '--staging') args.staging = argv[++i];
        else if (argv[i] === '--downloads') args.downloads = argv[++i];
        else if (argv[i] === '--state') args.state = argv[++i];
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.collectionModId || !args.output) {
        console.error('Usage: node snapshot-collection-staging.js --collection-mod-id <id> --output <dir> [--staging <path>] [--downloads <path>]');
        process.exit(2);
    }

    const syncLib = runner.loadSyncLib();
    if (syncLib.isVortexRunning()) {
        console.error('Vortex is currently running. Close it completely and try again.');
        process.exit(1);
    }

    const collectionInfo = runner.resolveCollectionInfo(args.staging, args.collectionModId);
    console.log(`Collection: ${collectionInfo.name} [${collectionInfo.modId}]`);

    const state = args.state || syncLib.DEFAULT_STATE_DIR;
    const { ignored, removedMods, keptMods, knownVortexModIds } = await runner.loadSyncState({
        state, collectionModId: args.collectionModId, collection: collectionInfo.collection,
    });

    const sevenZipExe = require('./lib/sevenzip').findSevenZip();
    const { rebuildQueue } = await runner.buildPlan({
        removedMods, keptMods, knownVortexModIds, resumed: null,
        downloadsDir: args.downloads, stagingDir: args.staging, sevenZipExe,
    });

    const withFolder = rebuildQueue.filter(({ action }) => action.existingStagingFolder);
    console.log(`${withFolder.length} of ${rebuildQueue.length} kept mod(s) have an existing staging folder to snapshot.`);

    fs.mkdirSync(args.output, { recursive: true });
    let copied = 0;
    for (const { action, mod } of withFolder) {
        const dest = path.join(args.output, action.targetFolderName);
        fs.cpSync(action.stagingModDir, dest, { recursive: true });
        console.log(`  copied: ${action.targetFolderName}`);
        copied++;
    }
    console.log(`\nDone. ${copied} folder(s) copied to "${args.output}".`);
}

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
});
