#!/usr/bin/env node
// Isolated child process for Rules Generator's DB reads -- same native-LevelDB-crash rationale as
// lib/state-query-worker.js/state-write-worker.js (see their own header comments): a long-running
// web server process must never call withStateDb in-process. Mirrors state-write-worker.js's
// mode-dispatched protocol exactly.
//
// Protocol: reads one JSON line from stdin: { stateDir, mode, ...params }.
// Writes one JSON line to stdout on success: whatever shape that mode's operation returns.

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const input = JSON.parse(await readStdin());
    const { stateDir, mode } = input;
    const syncLib = require('./vortex-sync/lib');
    const rg = require('./rules-generator');

    let result;
    switch (mode) {
        // Real installed collections (has collection.json) are already listable without touching
        // the DB at all (see sync-runner.js's listInstalledCollections) -- this mode is only for
        // Workshop-only collections (no collection.json), which can't be discovered any other way.
        case 'list-workshop-collections': {
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const collections = [];
                for (const entry of modIndex.values()) {
                    if (entry.type !== 'collection') continue;
                    if (!/^vortex_collection_/i.test(entry.modKey)) continue; // real installs excluded, see vortex-sync/lib.js
                    collections.push({ modKey: entry.modKey, name: rg.displayName(entry) });
                }
                collections.sort((a, b) => a.name.localeCompare(b.name));
                return { collections };
            });
            break;
        }
        case 'analyze': {
            const { oldCollectionKey, newCollectionKey } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                if (!modIndex.has(oldCollectionKey)) {
                    throw new Error(`Original collection not found in Vortex's current state (it may have been removed or reinstalled).`);
                }
                if (!modIndex.has(newCollectionKey)) {
                    throw new Error(`New collection not found in Vortex's current state (it may have been removed or reinstalled).`);
                }
                return rg.analyzeCollections(modIndex, oldCollectionKey, newCollectionKey);
            });
            break;
        }
        // Completed/Exceptions report -- read-only, same withStateDb safe-copy path as 'analyze'.
        case 'report': {
            const { oldCollectionKey, newCollectionKey, anomalyOverrides } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                if (!modIndex.has(oldCollectionKey)) {
                    throw new Error(`Original collection not found in Vortex's current state (it may have been removed or reinstalled).`);
                }
                if (!modIndex.has(newCollectionKey)) {
                    throw new Error(`New collection not found in Vortex's current state (it may have been removed or reinstalled).`);
                }
                return rg.computeReportData(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {});
            });
            break;
        }
        // Read-only dry run, via the safe temp-copy path (withStateDb) -- same "preview before you
        // ever write" pairing Update Collection's own apply-ignores-preview already establishes.
        // Computes an accurate count for the confirm dialog without touching anything.
        case 'apply-preview': {
            const { oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                return await rg.applyRules(db, modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, { dryRun: true });
            });
            break;
        }
        // The real write -- opens Vortex's LIVE state.v2 directly. withLiveStateDb takes a full
        // backup first and refuses if Vortex is running or the backup is incomplete, same safety
        // net every other live write in this project already goes through.
        case 'apply-write': {
            const { oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides } = input;
            result = await syncLib.withLiveStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                return await rg.applyRules(db, modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, { dryRun: false });
            });
            break;
        }
        default:
            throw new Error(`Unknown mode: ${mode}`);
    }

    process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
    process.stderr.write(e.message || String(e));
    process.exit(1);
});
