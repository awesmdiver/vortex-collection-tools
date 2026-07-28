'use strict';
// Builds a lib/rebuild-mod.js-compatible `mod` object ({name, source, choices}) directly from a
// single mod's own state.v2 record -- no collection.json/collection membership required. See
// TECHNICAL.md's "Single-mod rebuild engine" section for the full design writeup: Vortex's own
// per-mod `attributes.installerChoices` uses the EXACT SAME shape collection.json's `choices`
// block does ([{name, groups:[{name, choices:[{idx, name}]}]}]), confirmed against a real mod
// (Snazzy Morthal AIO) this session -- so no collection.json is actually needed to replay a FOMOD's
// recorded choices, only a translation of state.v2's own already-recorded fields.
//
// Read-only: uses the SAME safe-copy-then-read pattern every other state.v2 read in this project
// already uses (syncLib.withStateDb) -- never touches the live database, and throws its own clear
// "Vortex is currently running" error if Vortex hasn't been closed (the caller's own
// vortexRunningGate should still check first for a fast, clean 409 before even attempting this).

const syncLib = require('./vortex-sync/lib');

async function safeGet(db, key) {
    try {
        const raw = await db.get(key);
        return JSON.parse(raw);
    } catch (e) {
        if (e.code === 'LEVEL_NOT_FOUND') return undefined;
        throw e;
    }
}

// vortexModId: the mods### key -- for every real-world case seen so far this IS the mod's own
// staging folder name (installationPath and id are the same string), confirmed against real
// state.v2 data this session.
async function buildModFromVortexState({ stateDir, gameId = syncLib.GAME_ID, vortexModId }) {
    return syncLib.withStateDb(stateDir, async (db) => {
        const prefix = `persistent###mods###${gameId}###${vortexModId}###attributes###`;
        const installationPath = await safeGet(db, `persistent###mods###${gameId}###${vortexModId}###installationPath`);
        if (installationPath === undefined) {
            const err = new Error(`No mod found in Vortex's records with id "${vortexModId}" for game "${gameId}".`);
            err.code = 'MOD_NOT_FOUND';
            throw err;
        }

        const [
            customFileName, logicalFileName, source, modId, fileId, fileSize, fileMD5,
            installerChoicesType, installerChoicesOptions,
        ] = await Promise.all([
            safeGet(db, `${prefix}customFileName`),
            safeGet(db, `${prefix}logicalFileName`),
            safeGet(db, `${prefix}source`),
            safeGet(db, `${prefix}modId`),
            safeGet(db, `${prefix}fileId`),
            safeGet(db, `${prefix}fileSize`),
            safeGet(db, `${prefix}fileMD5`),
            // state.v2 flattens nested objects into separate ###-delimited leaf keys, same as every
            // other nested field in this database (rules, etc.) -- installerChoices is NOT one
            // combined JSON blob at a single key. Confirmed real 2026-07-27 against Snazzy Morthal
            // AIO's own record: `attributes###installerChoices###type` and
            // `attributes###installerChoices###options` are two separate keys.
            safeGet(db, `${prefix}installerChoices###type`),
            safeGet(db, `${prefix}installerChoices###options`),
        ]);

        return {
            name: customFileName || logicalFileName || vortexModId,
            source: {
                type: source === 'nexus' ? 'nexus' : 'offsite',
                modId,
                fileId,
                fileSize,
                md5: fileMD5,
                logicalFilename: logicalFileName,
            },
            choices: installerChoicesType === 'fomod'
                ? { type: installerChoicesType, options: installerChoicesOptions }
                : undefined,
        };
    });
}

module.exports = { buildModFromVortexState };
