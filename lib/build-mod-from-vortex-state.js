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
    // classic-level 2.0+ (abstract-level's "not found" change, 2026-08-27's classic-level 1.4.1 ->
    // 3.0.0 upgrade) yields undefined for a missing key instead of throwing LEVEL_NOT_FOUND -- guard
    // the JSON.parse directly. This is the ~12-field-per-mod hot path (readModFromOpenDb below), so
    // an unguarded JSON.parse(undefined) here would have broken essentially every mod read.
    const raw = await db.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
}

function shapeMod(record, vortexModId) {
    const {
        customFileName, logicalFileName, source, modId, fileId, fileSize, fileMD5, version,
        installerChoicesType, installerChoicesOptions, bundleFileExpression, bundleCollectionModId,
    } = record;
    const name = customFileName || logicalFileName || vortexModId;
    const choices = installerChoicesType === 'fomod'
        ? { type: installerChoicesType, options: installerChoicesOptions }
        : undefined;

    // Bundle-type mods (2026-08-26, Missing Masters bundle-support fix) carry no modId/fileId/md5 of
    // their own -- update-collection-v2-runner.js's own setModAttributes calls record
    // bundleFileExpression/bundleCollectionModId as this app's own custom Vortex attributes
    // specifically so THIS reconstruction path (rebuild-single-mod.js's own no-collection.json
    // lookup, e.g. Missing Masters' general repair scan) can recognize a bundle mod instead of
    // silently falling into the 'offsite' branch below -- worse than an honest failure, since it
    // sends the mod down a dead-end "no download URL" path instead. Only a mod installed/updated
    // AFTER that fix shipped carries these attributes; an older bundle mod has neither and correctly
    // falls through to the 'offsite' branch's own honest (if imprecise) handling.
    // bundleCollectionModId is returned as a separate top-level field, not nested inside `source` --
    // classifyMod()'s own collectionModId is always a sibling OPTION passed alongside `mod`, never
    // read from mod.source, so nesting it there would be silently ignored by that call.
    if (bundleFileExpression && bundleCollectionModId) {
        return {
            name,
            source: { type: 'bundle', fileExpression: bundleFileExpression },
            choices,
            bundleCollectionModId,
        };
    }

    return {
        name,
        source: {
            type: source === 'nexus' ? 'nexus' : 'offsite',
            modId,
            fileId,
            fileSize,
            md5: fileMD5,
            // version (2026-08-25, Merge Update Report) -- not read/consumed by any existing caller
            // of this shared shape (rebuildMod's own {name, source, choices} contract has never
            // needed it), added alongside fileId/md5 since it's the same kind of "which exact file"
            // identifier and this project's own established convention (attrs.version, per
            // update-collection-v2-runner.js's own real usage) already treats it that way.
            version,
            logicalFilename: logicalFileName,
        },
        choices,
    };
}

// vortexModId: the mods### key -- for every real-world case seen so far this IS the mod's own
// staging folder name (installationPath and id are the same string), confirmed against real
// state.v2 data this session.
//
// readModFromOpenDb (2026-08-25, Merge Update Report) -- the actual read, pulled out of
// buildModFromVortexState below so a caller needing MANY mods' attrs (a report scanning several
// merges' worth of source plugins, potentially dozens of unique mods) can open ONE state.v2 session
// (syncLib.withStateDb copies the WHOLE database to a temp dir per call -- confirmed expensive, not
// something to do once per mod) and read every mod it needs from that single open `db`, instead of
// looping buildModFromVortexState itself and paying a full state.v2 copy per mod. Returns `null`
// (not a thrown MOD_NOT_FOUND) for an unknown mod -- a batch caller checking many mods expects most
// lookups to fail gracefully (an unrelated mod, a since-uninstalled one), not to abort the whole scan.
async function readModFromOpenDb(db, gameId, vortexModId) {
    const prefix = `persistent###mods###${gameId}###${vortexModId}###attributes###`;
    const installationPath = await safeGet(db, `persistent###mods###${gameId}###${vortexModId}###installationPath`);
    if (installationPath === undefined) return null;

    const [
        customFileName, logicalFileName, source, modId, fileId, fileSize, fileMD5, version,
        installerChoicesType, installerChoicesOptions, bundleFileExpression, bundleCollectionModId,
    ] = await Promise.all([
        safeGet(db, `${prefix}customFileName`),
        safeGet(db, `${prefix}logicalFileName`),
        safeGet(db, `${prefix}source`),
        safeGet(db, `${prefix}modId`),
        safeGet(db, `${prefix}fileId`),
        safeGet(db, `${prefix}fileSize`),
        safeGet(db, `${prefix}fileMD5`),
        safeGet(db, `${prefix}version`),
        // state.v2 flattens nested objects into separate ###-delimited leaf keys, same as every
        // other nested field in this database (rules, etc.) -- installerChoices is NOT one
        // combined JSON blob at a single key. Confirmed real 2026-07-27 against Snazzy Morthal
        // AIO's own record: `attributes###installerChoices###type` and
        // `attributes###installerChoices###options` are two separate keys.
        safeGet(db, `${prefix}installerChoices###type`),
        safeGet(db, `${prefix}installerChoices###options`),
        // Bundle-type mod tags (2026-08-26 fix) -- see shapeMod's own header comment.
        safeGet(db, `${prefix}bundleFileExpression`),
        safeGet(db, `${prefix}bundleCollectionModId`),
    ]);

    return shapeMod({
        customFileName, logicalFileName, source, modId, fileId, fileSize, fileMD5, version,
        installerChoicesType, installerChoicesOptions, bundleFileExpression, bundleCollectionModId,
    }, vortexModId);
}

// Read-only: uses the SAME safe-copy-then-read pattern every other state.v2 read in this project
// already uses (syncLib.withStateDb) -- never touches the live database, and throws its own clear
// "Vortex is currently running" error if Vortex hasn't been closed (the caller's own
// vortexRunningGate should still check first for a fast, clean 409 before even attempting this).
// Single-mod convenience wrapper around readModFromOpenDb above -- opens its own state.v2 session,
// for callers that only need exactly one mod (unchanged from before this file also gained a batch
// path). A caller needing several mods should use syncLib.withStateDb + readModFromOpenDb directly
// instead, to only pay the state.v2 copy cost once.
async function buildModFromVortexState({ stateDir, gameId = syncLib.GAME_ID, vortexModId }) {
    return syncLib.withStateDb(stateDir, async (db) => {
        const mod = await readModFromOpenDb(db, gameId, vortexModId);
        if (!mod) {
            const err = new Error(`No mod found in Vortex's records with id "${vortexModId}" for game "${gameId}".`);
            err.code = 'MOD_NOT_FOUND';
            throw err;
        }
        return mod;
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
        version: attrs.version,
        installerChoicesType: attrs.installerChoices ? attrs.installerChoices.type : undefined,
        installerChoicesOptions: attrs.installerChoices ? attrs.installerChoices.options : undefined,
        // Bundle-type mod tags (2026-08-26 fix) -- already present on the raw attributes bag the
        // Helper returns, unlike readModFromOpenDb's own state.v2 path which has to fetch each key
        // individually. See shapeMod's own header comment.
        bundleFileExpression: attrs.bundleFileExpression,
        bundleCollectionModId: attrs.bundleCollectionModId,
    }, vortexModId);
}

module.exports = { buildModFromVortexState, buildModFromLiveData, readModFromOpenDb };
