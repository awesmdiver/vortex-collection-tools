#!/usr/bin/env node
// Rebuilds a real, already-installed Vortex collection's staging folder using this project's own
// validated extractor instead of Vortex's slow archive-extraction pipeline. This is the first
// production use of the extractor -- see README.md and the project plan for the full safety
// rationale. Never deletes a mod's staging folder without a verified-good replacement already in
// place; every mod's outcome is logged incrementally so a halted run can be resumed with --resume
// instead of starting over.
//
// Usage:
//   node rebuild-collection.js [--collection-mod-id <id>] [--staging <dir>] [--downloads <path>]
//     [--state <path>] [--backup-root <dir>] [--concurrency <1-8>] [--dry-run]
//     [--resume <log-file>] [--yes]
//
// Omit --collection-mod-id for an interactive menu of currently-installed collections.
//
// This CLI is a thin presentation layer over lib/collection-runner.js -- the same engine
// web/server.js uses, so both entry points run identical, independently-tested logic.

const fs = require('fs');
const path = require('path');

const runner = require('./lib/collection-runner');
const { selectFromList, confirm, requireVortexClosed, closeInteractive } = require('./lib/interactive');
const { findSevenZip } = require('./lib/sevenzip');
const appConfig = require('./lib/app-config');

let syncLib;
try {
    syncLib = runner.loadSyncLib();
} catch (e) {
    console.error(e.message);
    process.exit(2);
}

// No hardcoded personal-path defaults -- this project is meant to be shared. Falls back to the
// unified config.json (set via the web UI's Settings page) instead; if still unset, main() below
// errors clearly rather than silently operating against a wrong/nonexistent path.
const fileConfig = appConfig.loadConfig();

function parseArgs(argv) {
    const args = {
        collectionModId: null,
        staging: fileConfig.staging || null,
        downloads: fileConfig.downloads || null,
        state: fileConfig.state || syncLib.DEFAULT_STATE_DIR,
        backupRoot: fileConfig.backupRoot || null,
        // Clamped 1-8, same rule as the Settings page's own field -- 1 (sequential) if unset/invalid.
        concurrency: Math.min(8, Math.max(1, Math.floor(Number(fileConfig.concurrentExtractions)) || 1)),
        dryRun: false,
        resume: null,
        yes: false,
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--collection-mod-id') args.collectionModId = argv[++i];
        else if (argv[i] === '--staging') args.staging = argv[++i];
        else if (argv[i] === '--downloads') args.downloads = argv[++i];
        else if (argv[i] === '--state') args.state = argv[++i];
        else if (argv[i] === '--backup-root') args.backupRoot = argv[++i];
        else if (argv[i] === '--concurrency') args.concurrency = Math.min(8, Math.max(1, Math.floor(Number(argv[++i])) || 1));
        else if (argv[i] === '--dry-run') args.dryRun = true;
        else if (argv[i] === '--resume') args.resume = argv[++i];
        else if (argv[i] === '--yes') args.yes = true;
        else { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
    }
    return args;
}

async function resolveCollection(args) {
    if (args.collectionModId) {
        try {
            return runner.resolveCollectionInfo(args.staging, args.collectionModId);
        } catch (e) {
            console.error(`${e.message} Omit --collection-mod-id to pick from a menu.`);
            process.exit(2);
        }
    }

    const collections = syncLib.scanStagingCollections(args.staging);
    if (collections.length === 0) {
        console.error(`No installed collections (collection.json) found under "${args.staging}".`);
        process.exit(2);
    }
    const picked = await selectFromList(
        collections,
        (c) => `${c.name} (${c.modCount} mods) [${c.modId}]`,
        'Which installed collection do you want to rebuild?'
    );
    if (!picked) { console.log('Cancelled.'); process.exit(0); }
    return runner.resolveCollectionInfo(args.staging, picked.modId);
}

// Called out separately (not just buried in the general summary) per the user's explicit request
// -- an Open FOMOD (real FOMOD wizard, no recorded choices, no deterministic default to replay)
// needs a manual reinstall through Vortex, and should be easy to spot in the report.
function printOpenFomodSection(modEntries) {
    const openFomodMods = runner.getOpenFomodMods(modEntries);
    if (openFomodMods.length === 0) return;
    console.log('\n===== Needs manual reinstall (Open FOMOD) =====');
    console.log(
        `${openFomodMods.length} mod(s) have a real FOMOD installer wizard but no choices recorded in ` +
        `collection.json -- the collection deliberately leaves these to whoever installs it (Vortex's ` +
        `wizard even pre-selects based on what else is currently installed), so there's no default to ` +
        `replay automatically. Reinstall these manually through Vortex:`
    );
    for (const e of openFomodMods) console.log(`  - ${e.name}`);
}

const STATUS_LABEL = {
    REBUILT: '[REBUILT]',
    SKIP_IGNORED: '[SKIP-IGNORED]',
    SKIP_NO_ARCHIVE: '[SKIP-NO-ARCHIVE]',
    SKIP_OPTIONAL_NOT_INSTALLED: '[SKIP-OPTIONAL]',
    SKIP_OPEN_FOMOD: '[SKIP-OPEN-FOMOD]',
    FAILED_MISMATCH_NOT_TOUCHED: '[FAIL-NOT-TOUCHED]',
    FAILED_EXTRACTION_NOT_TOUCHED: '[FAIL-NOT-TOUCHED]',
    FAILED_EXTRACTION_NO_PRIOR_DATA: '[FAIL-STILL-MISSING]',
    CRITICAL_MANUAL_RESTORE_NEEDED: '[CRITICAL]',
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.staging || !args.downloads || !args.backupRoot) {
        console.error('Staging/downloads/backup-root are not configured. Pass --staging/--downloads/--backup-root, or set them via the web UI\'s Settings page (writes config.json).');
        process.exit(2);
    }
    const interactive = !args.yes;
    const sevenZipExe = findSevenZip();

    const collectionInfo = await resolveCollection(args);
    console.log(`Collection: ${collectionInfo.name} [${collectionInfo.modId}]`);
    console.log(`${collectionInfo.collection.mods.length} mod(s) recorded in collection.json.`);

    // Gate #1 -- before touching Vortex's state DB at all.
    if (!(await requireVortexClosed(syncLib, { interactive }))) {
        console.log('Aborted -- Vortex is running.');
        process.exit(1);
    }

    const { ignored, removedMods, keptMods, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey } = await runner.loadSyncState({
        state: args.state, collectionModId: collectionInfo.modId, collection: collectionInfo.collection, stagingDir: args.staging,
    });
    console.log(`${ignored.length} mod(s) marked ignored in Vortex -- these are never touched.`);
    console.log(`${knownVortexModIds.size} of ${keptMods.length} kept mod(s) already have a real Vortex-tracked staging folder.`);

    let resumed = new Map();
    if (args.resume) {
        resumed = runner.loadResumeLog(args.resume);
        console.log(`Resuming from "${args.resume}" -- ${resumed.size} mod(s) already resolved, will be skipped.`);
    }

    const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(__dirname, 'logs', `rebuild-${collectionInfo.modId}-${runTimestamp}.json`);
    const startedAt = new Date().toISOString();

    const { modEntries, rebuildQueue } = await runner.buildPlan({
        removedMods, keptMods, knownVortexModIds, resumed, otherVersionsByModId, sharedWithCollectionsByKey,
        downloadsDir: args.downloads, stagingDir: args.staging, sevenZipExe, logsDir: path.join(__dirname, 'logs'),
    });

    function currentLog(runStatus) {
        return runner.buildLogData({
            collectionInfo, stagingDir: args.staging, downloadsDir: args.downloads,
            backupRoot: args.backupRoot, dryRun: args.dryRun, startedAt, runStatus, modEntries,
        });
    }

    // Print the plan (always, dry-run or not) before anything destructive happens.
    console.log('\n===== Plan =====');
    for (const e of modEntries) console.log(`${STATUS_LABEL[e.status] || `[${e.status}]`} ${e.name}${e.detail ? ` -- ${e.detail}` : ''}`);
    for (const { mod, action } of rebuildQueue) {
        console.log(action.existingStagingFolder
            ? `[REBUILD] ${mod.name}`
            : `[REBUILD-MISSING] ${mod.name} -- no staging folder exists at all right now, will create from scratch`);
    }
    console.log('');
    const planSummary = runner.summarize([...modEntries, ...rebuildQueue.map(() => ({ status: 'REBUILD' }))]);
    for (const [status, count] of Object.entries(planSummary)) console.log(`${status}: ${count}`);
    console.log(`TOTAL: ${modEntries.length + rebuildQueue.length}`);

    printOpenFomodSection(modEntries);

    runner.writeLog(logPath, currentLog('in-progress'));
    console.log(`\nPlan written to ${logPath}`);

    if (args.dryRun) {
        runner.writeLog(logPath, currentLog('dry-run-complete'));
        closeInteractive();
        process.exit(0);
    }

    if (rebuildQueue.length === 0) {
        console.log('\nNothing to rebuild.');
        runner.writeLog(logPath, currentLog('completed'));
        closeInteractive();
        process.exit(0);
    }

    if (interactive) {
        const proceed = await confirm(`\nProceed with rebuilding ${rebuildQueue.length} mod(s)?`, true);
        if (!proceed) { console.log('Aborted.'); closeInteractive(); process.exit(0); }
    }

    // Gate #2 -- immediately before anything destructive, since real time (confirmation,
    // archive hashing during classification) may have passed since gate #1.
    if (!(await requireVortexClosed(syncLib, { interactive }))) {
        console.log('Aborted -- Vortex is running.');
        process.exit(1);
    }

    const { backupRunDir } = runner.runBackup({
        rebuildQueue, backupRoot: args.backupRoot, collectionModId: collectionInfo.modId, runTimestamp,
        onProgress: ({ index, total, modName }) => {
            if (index === 1) console.log(`\nBacking up ${total} mod(s)' current staging folders before touching anything...`);
        },
    });
    console.log(`Full-collection backup complete: "${backupRunDir}". This is NOT auto-deleted -- clean it up manually once you're confident.`);

    console.log(`\n===== Rebuilding${args.concurrency > 1 ? ` (${args.concurrency} at a time)` : ''} =====`);
    const { haltedCritical } = await runner.runRebuild({
        rebuildQueue, collectionJsonPath: collectionInfo.collectionJsonPath,
        downloadsDir: args.downloads, stagingDir: args.staging, modEntries,
        concurrency: args.concurrency,
        onModComplete: (entry) => {
            const mod = { name: entry.name };
            console.log(`${STATUS_LABEL[entry.status] || `[${entry.status}]`} ${mod.name}${entry.detail ? ` -- ${entry.detail}` : ''}`);
            if (entry.note) console.log(`    ${entry.note}`);
            if (entry.restoredMissingFiles?.length) {
                console.log(`    Restored ${entry.restoredMissingFiles.length} file(s) that were missing from the old staging folder:`);
                for (const f of entry.restoredMissingFiles) console.log(`      + ${f}`);
            }
            if (entry.missing?.length) {
                console.log(`    MISSING from the fresh extraction (was in old staging, needs research):`);
                for (const f of entry.missing) console.log(`      - ${f}`);
            }
            if (entry.changed?.length) {
                console.log(`    CHANGED content (same path, different hash, needs research):`);
                for (const f of entry.changed) console.log(`      * ${f}`);
            }
            runner.writeLog(logPath, currentLog('in-progress'));

            if (entry.status === 'CRITICAL_MANUAL_RESTORE_NEEDED') {
                console.log('\n' + '='.repeat(70));
                console.log('CRITICAL: swapping the verified-good rebuild into place failed. Halting the whole batch.');
                console.log(`  Mod:                ${entry.name}`);
                console.log(`  Old content at:     ${entry.oldContentDir}`);
                console.log(`  New content at:     ${entry.rebuildingDir}`);
                console.log(`  Real staging slot:  ${entry.stagingModDir}`);
                console.log('  Restore this one by hand, then re-run with --resume ' + `"${logPath}"`);
                console.log('='.repeat(70));
            }
        },
    });

    runner.writeLog(logPath, currentLog(haltedCritical ? 'halted-critical' : 'completed'));

    console.log('\n===== Summary =====');
    const finalSummary = runner.summarize(modEntries);
    for (const [status, count] of Object.entries(finalSummary)) console.log(`${status}: ${count}`);
    console.log(`TOTAL: ${modEntries.length}`);

    printOpenFomodSection(modEntries);

    console.log(`\nFull log: ${logPath}`);

    closeInteractive();
    process.exit(haltedCritical ? 1 : 0);
}

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    closeInteractive();
    process.exit(2);
});
