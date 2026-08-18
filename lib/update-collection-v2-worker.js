#!/usr/bin/env node
// Isolated child process for Update Collection v2's own state.v2 reads -- same native-LevelDB-crash
// rationale as lib/state-query-worker.js/rules-generator-worker.js (see their own header comments):
// a long-running web server process must never call withStateDb in-process.
//
// Protocol: reads one JSON line from stdin: { stateDir, mode, ...params }.
// Writes one JSON line to stdout on success: whatever shape that mode's operation returns.
//
// One mode today: 'resolve-nexus-info' -- state.v2 fallback for the SAME per-collection
// {collectionSlug, revisionNumber, author, pictureUrl, liveName} the helper extension already
// exposes live via GET /mods' attributes -- see lib/update-collection-v2-runner.js's own
// resolveNexusInfoViaHelper for the primary, helper-first path this mirrors. Read individually per
// collectionModId (a handful of plain key reads each, not a full DB scan) since this only ever runs
// for the small set of already-known-installed "Added Collections", unlike buildModIndex's own
// whole-DB iteration.

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

    let result;
    switch (mode) {
        case 'resolve-nexus-info': {
            const { collectionModIds } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const out = {};
                for (const modId of collectionModIds) {
                    const [collectionSlug, revisionNumber, author, pictureUrl, customFileName] = await Promise.all([
                        syncLib.getModValue(db, modId, 'attributes###collectionSlug'),
                        syncLib.getModValue(db, modId, 'attributes###revisionNumber'),
                        syncLib.getModValue(db, modId, 'attributes###author'),
                        syncLib.getModValue(db, modId, 'attributes###pictureUrl'),
                        syncLib.getModValue(db, modId, 'attributes###customFileName'),
                    ]);
                    const parse = (v) => { try { return v === undefined ? null : JSON.parse(v); } catch { return null; } };
                    out[modId] = {
                        collectionSlug: parse(collectionSlug),
                        revisionNumber: parse(revisionNumber),
                        author: parse(author),
                        pictureUrl: parse(pictureUrl),
                        liveName: parse(customFileName),
                    };
                }
                return out;
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
