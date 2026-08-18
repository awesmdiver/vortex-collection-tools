'use strict';
// Builds a lib/rebuild-mod.js-compatible `mod` object ({name, source, choices}) directly from a
// single mod's own record -- no collection.json/collection membership required. See TECHNICAL.md's
// "Single-mod rebuild engine" section for the full design writeup: Vortex's own per-mod
// `attributes.installerChoices` uses the EXACT SAME shape collection.json's `choices` block does
// ([{name, groups:[{name, choices:[{idx, name}]}]}]), confirmed against a real mod (Snazzy Morthal
// AIO) this session -- so no collection.json is actually needed to replay a FOMOD's recorded
// choices, only a translation of the record's own already-recorded fields.
//
// Two data sources, one field-mapping function (2026-08-18, Missing Masters' own "remove the
// Vortex-must-be-closed requirement" step -- same pattern as Cycle Helper's ruleIO / Rules
// Generator's *ViaHelper functions, see TECHNICAL.md's Missing Masters section):
// - buildModFromVortexState -- the ORIGINAL, state.v2-backed path (syncLib.withStateDb, requires
//   Vortex closed). Reads the same flattened `attributes###*` keys every other state.v2 reader here
//   does.
// - buildModFromLiveData -- reads the SAME fields from the optional Vortex Collection Helper
//   extension's already-fetched `GET /mods` response instead (lib/vortex-helper-client.js's
//   getAllMods()) -- no DB, no Vortex-closed requirement. Confirmed live against a real mod (Alchemy
//   Station Variants - FOMOD) that the extension's nested `mod.attributes.installerChoices` is
//   `{type, options}` -- the exact two fields state.v2 stores as separate
//   `installerChoices###type`/`installerChoices###options` keys, just not flattened -- and that
//   every other field this file reads (source/modId/fileId/fileSize/fileMD5/customFileName/
//   logicalFileName) exists at the equivalent `mod.attributes.*` path, same parity
//   buildModIndexFromLiveData (lib/rules-generator.js) already established for its own field set.
// Both funnel through shapeMod so the actual "how do these fields become the {name, source,
// choices} object rebuildMod expects" logic lives in exactly one place.

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

function shapeMod(record, vortexModId) {
    const {
        customFileName, logicalFileName, source, modId, fileId, fileSize, fileMD5,
        installerChoicesType, installerChoicesOptions,
    } = record;
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
}

// vortexModId: the mods### key -- for every real-world case seen so far this IS the mod's own
// staging folder name (installationPath and id are the same string), confirmed against real
// state.v2 data this session.
//
// Read-only: uses the SAME safe-copy-then-read pattern every other state.v2 read in this project
// already uses (syncLib.withStateDb) -- never touches the live database, and throws its own clear
// "Vortex is currently running" error if Vortex hasn't been closed (the caller's own
// vortexRunningGate should still check first for a fast, clean 409 before even attempting this).
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

        return shapeMod({ customFileName, logicalFileName, source, modId, fileId, fileSize, fileMD5, installerChoicesType, installerChoicesOptions }, vortexModId);
    });
}

// Live-helper equivalent -- `mods` is the raw `data.mods` object straight from a caller's own
// already-made getAllMods() call (not re-fetched here, same "caller owns the one big request"
// convention every other *ViaHelper path in this project follows). Throws the SAME MOD_NOT_FOUND
// shape as buildModFromVortexState for a mod id that doesn't exist -- callers already handle that
// error the same way regardless of which path produced it.
function buildModFromLiveData(mods, vortexModId, gameId = syncLib.GAME_ID) {
    const raw = mods[vortexModId];
    if (!raw) {
        const err = new Error(`No mod found in Vortex's records with id "${vortexModId}" for game "${gameId}".`);
        err.code = 'MOD_NOT_FOUND';
        throw err;
    }
    const attrs = raw.attributes || {};
    return shapeMod({
        customFileName: attrs.customFileName,
        logicalFileName: attrs.logicalFileName,
        source: attrs.source,
        modId: attrs.modId,
        fileId: attrs.fileId,
        fileSize: attrs.fileSize,
        fileMD5: attrs.fileMD5,
        installerChoicesType: attrs.installerChoices ? attrs.installerChoices.type : undefined,
        installerChoicesOptions: attrs.installerChoices ? attrs.installerChoices.options : undefined,
    }, vortexModId);
}

module.exports = { buildModFromVortexState, buildModFromLiveData };
