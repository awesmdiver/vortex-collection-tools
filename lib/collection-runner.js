'use strict';
// Framework-agnostic core orchestration for rebuilding a Vortex collection's staging folder.
// Extracted from rebuild-collection.js so the terminal CLI and the web UI (web/server.js) run the
// exact same tested engine -- neither reimplements this logic. Nothing here touches
// console/readline/process.exit; callers (the CLI or the web routes) own all presentation.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { loadCollection } = require('./collection-parser');
const { classifyMod, rebuildMod } = require('./rebuild-mod');

const SYNC_LIB_PATH = path.join(__dirname, 'vortex-sync', 'lib.js');
const STATE_QUERY_WORKER_PATH = path.join(__dirname, 'state-query-worker.js');

// Statuses that represent a fully-resolved outcome from a prior run -- safe to skip entirely on
// resume. CRITICAL_MANUAL_RESTORE_NEEDED is deliberately excluded: that mod's underlying issue
// needs a human look, so it gets re-classified (and, if the user has fixed things, re-attempted)
// on resume rather than silently skipped forever.
const RESUMABLE_STATUSES = new Set([
    'REBUILT', 'SKIP_NO_ARCHIVE', 'SKIP_OPTIONAL_NOT_INSTALLED', 'SKIP_OPEN_FOMOD',
    'FAILED_MISMATCH_NOT_TOUCHED', 'FAILED_EXTRACTION_NOT_TOUCHED', 'FAILED_EXTRACTION_NO_PRIOR_DATA',
]);

function modKey(source) {
    return `${source.modId}:${source.fileId}`;
}

// lib/vortex-sync is this project's own in-tree module (formerly the separate sibling project
// vortex-collection-sync, merged in), reused for everything Vortex-live-state-related. Shared here
// so both rebuild-collection.js and web/server.js get the same friendly error instead of a raw
// MODULE_NOT_FOUND stack trace.
function loadSyncLib() {
    try {
        return require(SYNC_LIB_PATH);
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') {
            const err = new Error(
                `Could not find the in-tree vortex-sync module at "${SYNC_LIB_PATH}" -- this ` +
                `indicates a broken installation, not a missing sibling project.`
            );
            err.code = 'SYNC_LIB_NOT_FOUND';
            throw err;
        }
        throw e;
    }
}

// How long a normal (non-crashed) state query should ever reasonably take, even for a large
// Vortex install -- past this, the worker is presumed stuck, not just slow. Confirmed this
// session: when the native assertion crash happens, the OS's assertion dialog can spawn BEHIND
// other windows, showing nothing on top and nothing in a taskbar glance -- from the user's side
// it looks identical to a silent hang, not an obvious crash, with no clue to go check for it.
const STATE_QUERY_TIMEOUT_MS = 30_000;

const CRASH_HELP_TEXT =
    'Could not load the collection. While reading Vortex\'s database, there was a crash, possibly ' +
    'due to files still being written from a recent Vortex session. If a Windows error dialog ' +
    'appeared, check your taskbar -- it can open behind other windows -- and click Abort. Try ' +
    'again; if it keeps happening, close this application, open Vortex, wait a moment, then close ' +
    'Vortex normally, and restart this application.';

const TIMEOUT_HELP_TEXT =
    'Could not load the collection. Reading Vortex\'s database is taking too long -- this usually ' +
    'means a Windows error dialog is open and hidden behind other windows. Check your taskbar, ' +
    'click Abort on it, then try again. If it keeps happening, close this application, open ' +
    'Vortex, wait a moment, then close Vortex normally, and restart this application.';

// Runs lib/state-query-worker.js in an ISOLATED child process, for one or more collections in a
// SINGLE shared DB open (see loadSyncState/loadSyncStateBatch below -- batching directly reduces
// how many times this risky operation runs when working through several collections in one
// sitting). Confirmed this session, reproducibly, across multiple different collections -- this
// is a property of Vortex's overall state database, not any one collection's data:
// vortex-collection-sync's withStateDb (via classic-level/LevelDB) can hit a native assertion
// crash reading certain real-world write-ahead-log shapes, even with Vortex fully closed. A
// native crash is unrecoverable in-process, so this MUST run outside whatever process called it
// (critical for web/server.js, which must survive a bad read and keep serving other requests, not
// just for a one-shot CLI invocation). The crash blocks on a native OS dialog requiring manual
// dismissal (click Abort, never Retry/Ignore -- continuing past a violated invariant risks
// silently wrong data) -- confirmed this can spawn BEHIND other windows with zero on-screen
// indication, so a timeout here proactively kills the worker and tells the caller explicitly what
// to go check for, rather than leaving them staring at an unexplained stall.
function runIsolatedStateQuery(input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [STATE_QUERY_WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, STATE_QUERY_TIMEOUT_MS);

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(TIMEOUT_HELP_TEXT));
                return;
            }
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`Vortex state worker produced invalid output: ${e.message}`));
                }
                return;
            }
            reject(new Error(CRASH_HELP_TEXT + (stderr.trim() ? ` (details: ${stderr.trim()})` : '') + ` [exit ${code}${signal ? `, signal ${signal}` : ''}]`));
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

// Resolves a chosen collection's modId (== its staging folder name) into the standard
// collectionInfo shape, loading collection.json too. Throws a plain Error on failure --
// callers decide how to present that (CLI: console.error+exit; web: JSON error response).
function resolveCollectionInfo(stagingDir, collectionModId) {
    const collectionJsonPath = path.join(stagingDir, collectionModId, 'collection.json');
    if (!fs.existsSync(collectionJsonPath)) {
        throw new Error(`No collection.json found at "${collectionJsonPath}".`);
    }
    const collection = loadCollection(collectionJsonPath);
    // Matches scanStagingCollections' own convention (vortex-collection-sync/lib.js) so a
    // collection looks the same whether it was reached via the picker or via a direct modId.
    const name = collection.info?.name || collectionModId;
    return { modId: collectionModId, collectionJsonPath, name, collection };
}

function toSyncStateResult(raw) {
    if (raw.error) {
        const err = new Error(raw.error);
        err.code = 'SYNC_STATE_ERROR';
        throw err;
    }
    return {
        ignored: raw.ignored, removedMods: raw.removedMods, keptMods: raw.keptMods,
        knownVortexModIds: new Map(raw.knownVortexModIdEntries),
        otherVersionsByModId: raw.otherVersionsByModId || {},
        sharedWithCollectionsByKey: raw.sharedWithCollectionsByKey || {},
        liveName: raw.liveName,
        collectionSlug: raw.collectionSlug,
    };
}

// The one syncLib.withStateDb call this whole tool needs: ignored mods, kept/removed, and each
// kept mod's REAL Vortex-tracked staging folder name (see lib/rebuild-mod.js's classifyMod header
// for why this matters -- Vortex never renames a mod's folder on update, only refreshes its
// contents in place, so trusting the archive's own filename can miss the real, already-installed
// location entirely). Runs in an isolated child process (see runIsolatedStateQuery above) --
// this is the one operation in the whole tool confirmed able to hard-crash its caller. Single-
// collection convenience wrapper around loadSyncStateBatch -- used by the CLI, which only ever
// handles one collection per invocation. stagingDir is needed here too (not just in the batch
// version) so the CLI path also gets cross-collection membership info (scanAllCollections) --
// without it, only the web UI's batch refresh would ever compute "shared with other collections".
async function loadSyncState({ state, collectionModId, collection, stagingDir }) {
    const results = await runIsolatedStateQuery({
        syncLibPath: SYNC_LIB_PATH, state, collections: [{ modId: collectionModId, collection }], stagingDir,
    });
    return toSyncStateResult(results[collectionModId]);
}

// Same as loadSyncState, but for MULTIPLE collections in one shared DB open -- the web UI's
// "load Vortex data once" optimization (see web/routes.js's /api/vortex-data/refresh). `entries`
// is [{modId, collection}, ...]. Returns { results: Map<modId, syncStateResult | {error}>,
// workshopOnlyCollections } -- a single bad collection (e.g. one Vortex hasn't written to its
// state yet) doesn't lose the others' results. workshopOnlyCollections lists every Vortex-tracked
// collection with NO collection.json at all (never published, or published but only the Workshop
// copy is kept locally) -- these were never in `entries` to begin with (scanStagingCollections
// can't find them), so this is the only place that surfaces them; stagingDir is required to
// compute it, optional to keep this function usable without it if a caller doesn't care.
async function loadSyncStateBatch({ state, entries, stagingDir }) {
    const raw = await runIsolatedStateQuery({
        syncLibPath: SYNC_LIB_PATH, state, collections: entries, stagingDir,
    });
    const results = new Map();
    for (const { modId } of entries) {
        try {
            results.set(modId, { ok: true, data: toSyncStateResult(raw[modId]) });
        } catch (e) {
            results.set(modId, { ok: false, error: e.message });
        }
    }
    return { results, workshopOnlyCollections: raw.__workshopOnly || [] };
}

function loadResumeLog(resumePath) {
    const log = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
    const resolved = new Map();
    for (const entry of log.mods || []) {
        if (RESUMABLE_STATUSES.has(entry.status) && entry.modId != null && entry.fileId != null) {
            resolved.set(`${entry.modId}:${entry.fileId}`, entry);
        }
    }
    return resolved;
}

function writeLog(logPath, logData) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));
}

function summarize(mods) {
    const summary = {};
    for (const m of mods) summary[m.status] = (summary[m.status] || 0) + 1;
    return summary;
}

// Called out separately (not just buried in the general summary) per the user's explicit request
// -- an Open FOMOD (real FOMOD wizard, no recorded choices, no deterministic default to replay)
// needs a manual reinstall through Vortex, and should be easy to spot in the report.
function getOpenFomodMods(modEntries) {
    return modEntries.filter((e) => e.status === 'SKIP_OPEN_FOMOD');
}

// Formats the "a different version of this exact mod is already installed elsewhere" note --
// entries come from state-query-worker.js's buildModVersionIndex (version/fileId, the fields
// Vortex's OWN code actually trusts -- see that function's comment for why NOT modVersion/isPrimary).
function describeOtherVersions(entries) {
    if (!entries || entries.length === 0) return null;
    return entries.map((e) => {
        const enabledText = e.enabledProfiles && e.enabledProfiles.length > 0 ? 'enabled' : 'installed but not enabled';
        const variantText = e.variant ? ` via "${e.variant}"` : '';
        return `v${e.version || '?'} (fileId ${e.fileId || '?'}, ${enabledText}${variantText})`;
    }).join('; ');
}

// Checks THIS tool's own logs to see if a shared mod (by modId+fileId) was already successfully
// REBUILT as part of another installed collection's most recent completed run -- directly relevant
// when a mod ends up mismatched/failed here: was this a wrong extraction, or does the exact same
// file/choices combination already work fine as part of a different collection? Real, confirmed-
// live case this was built for: "Dragon Priests Retexture SE - Half Res", shared by 3 collections,
// each recording different FOMOD choices for the identical underlying file.
function findModStatusInOtherCollectionLog(logsDir, otherCollectionModId, modId, fileId) {
    if (!logsDir) return null;
    let files;
    try {
        files = fs.readdirSync(logsDir).filter((f) => f.startsWith(`rebuild-${otherCollectionModId}-`) && f.endsWith('.json'));
    } catch {
        return null;
    }
    let latest = null;
    for (const f of files) {
        let log;
        try { log = JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf8')); } catch { continue; }
        if (log.runStatus === 'dry-run-complete') continue; // informational only, not a real completion
        if (!latest || new Date(log.startedAt) > new Date(latest.startedAt)) latest = log;
    }
    if (!latest) return null;
    const entry = (latest.mods || []).find((m) => m.modId === modId && m.fileId === fileId);
    return entry ? { status: entry.status, finishedAt: latest.finishedAt || latest.startedAt } : null;
}

// Formats the "this exact mod is also referenced by other installed collections" note -- mirrors
// Vortex's own real "+2 collections" badge (see state-query-worker.js's scanAllCollections for the
// confirmed-against-Vortex's-actual-source membership logic), cross-referenced against this tool's
// own run logs so a mismatch reads as "a different collection's own choices produced this content",
// not an unexplained, possibly-alarming failure.
function describeSharedWithCollections(entries, { logsDir, modId, fileId }) {
    if (!entries || entries.length === 0) return null;
    return entries.map((c) => {
        const logInfo = findModStatusInOtherCollectionLog(logsDir, c.collectionModId, modId, fileId);
        let statusNote;
        if (!logInfo) statusNote = 'not yet rebuilt by this tool';
        else if (logInfo.status === 'REBUILT') statusNote = `already rebuilt ${new Date(logInfo.finishedAt).toLocaleDateString()}`;
        else statusNote = `last status there: ${logInfo.status}`;
        return `${c.collectionName} (${statusNote})`;
    }).join('; ');
}

// Builds modEntries (SKIP_IGNORED + classified skip results) and rebuildQueue (mods needing a
// real rebuild this run). onModClassified(entry, index, total) fires per mod as classification
// completes -- archive-hashing across dozens (or, for a big collection, 100+) mods takes real
// time, so index/total lets a caller show real "X of Y checked" progress rather than an
// unexplained spinner. For a mod headed into rebuildQueue (not yet a final modEntries status), a
// synthetic {name, status: 'REBUILD_QUEUED', existingStagingFolder} is passed instead -- purely
// for progress display, never written to modEntries/the log.
async function buildPlan({ removedMods, keptMods, knownVortexModIds, resumed, downloadsDir, stagingDir, sevenZipExe, otherVersionsByModId, sharedWithCollectionsByKey, logsDir, onModClassified }) {
    const modEntries = [];
    const rebuildQueue = [];
    const total = removedMods.length + keptMods.length;
    let index = 0;

    for (const mod of removedMods) {
        index += 1;
        const entry = { name: mod.name, modId: mod.source?.modId, fileId: mod.source?.fileId, status: 'SKIP_IGNORED' };
        modEntries.push(entry);
        if (onModClassified) onModClassified(entry, index, total);
    }

    for (const mod of keptMods) {
        index += 1;
        const key = modKey(mod.source);
        const priorEntry = resumed?.get(key);
        if (priorEntry) {
            modEntries.push(priorEntry);
            if (onModClassified) onModClassified(priorEntry, index, total);
            continue;
        }
        const knownVortexModId = knownVortexModIds.get(key);
        const action = await classifyMod(mod, { downloadsDir, stagingDir, knownVortexModId, sevenZipExe });
        const base = { name: mod.name, modId: mod.source?.modId, fileId: mod.source?.fileId };
        // Only meaningful when the SPECIFIC file this collection pins has no exact match --
        // state-query-worker.js already only populates this for exactly that case.
        const otherVersionsNote = mod.source?.modId != null
            ? describeOtherVersions(otherVersionsByModId?.[mod.source.modId])
            : null;
        // Which OTHER installed collections also reference this exact mod (real, live Vortex modKey
        // match, not a guess -- see scanAllCollections) -- meaningful regardless of match/mismatch
        // status, so computed and attached unconditionally alongside otherVersionsNote.
        const sharedWithNote = describeSharedWithCollections(sharedWithCollectionsByKey?.[key], {
            logsDir, modId: mod.source?.modId, fileId: mod.source?.fileId,
        });
        if (action.kind === 'SKIP_NO_ARCHIVE') {
            // Cross-referencing collection.json's own "optional" flag here: confirmed via real
            // investigation (a 24-mod collection, checked each mod's Vortex state directly) that a
            // missing archive for an OPTIONAL mod usually means the collection author never
            // required it and the user simply chose not to install it -- not a real problem needing
            // research, unlike a missing archive for a REQUIRED mod (that's a genuine "you're
            // missing something you're supposed to have" case, kept as SKIP_NO_ARCHIVE). Not a
            // perfect signal on its own -- some optional mods get installed anyway -- but a missing
            // archive AND optional=true together is a strong, real signal this was never installed
            // by choice, worth its own distinct status rather than lumping it in with genuine gaps.
            const optional = mod.optional === true;
            const status = optional ? 'SKIP_OPTIONAL_NOT_INSTALLED' : 'SKIP_NO_ARCHIVE';
            let detail = optional
                ? 'Marked optional in this collection and not installed -- likely by choice, not a missing file.'
                : action.detail;
            if (otherVersionsNote) detail += ` -- a different version of this exact mod IS installed: ${otherVersionsNote}`;
            if (sharedWithNote) detail += ` -- also part of: ${sharedWithNote}`;
            const entry = { ...base, status, detail };
            modEntries.push(entry);
            if (onModClassified) onModClassified(entry, index, total);
        } else if (action.kind === 'SKIP_OPEN_FOMOD') {
            const detailParts = [];
            if (otherVersionsNote) detailParts.push(`A different version of this exact mod IS installed: ${otherVersionsNote}`);
            if (sharedWithNote) detailParts.push(`Also part of: ${sharedWithNote}`);
            const entry = { ...base, status: 'SKIP_OPEN_FOMOD', detail: detailParts.length > 0 ? detailParts.join(' -- ') : undefined };
            modEntries.push(entry);
            if (onModClassified) onModClassified(entry, index, total);
        } else {
            // A REBUILD that will create the folder from scratch (no existing staging folder) is
            // exactly the case confirmed live this session: our tool recreates the collection's
            // pinned (older) file as a brand-new, disabled mod entry, while a NEWER version of the
            // same modId may already be installed and active via a different collection -- not
            // harmful (Vortex won't auto-enable the new entry), but worth knowing before assuming
            // "missing" meant "broken".
            const otherVersionsRebuildNote = !action.existingStagingFolder ? otherVersionsNote : null;
            rebuildQueue.push({
                mod, action,
                base: { ...base, otherVersionsNote: otherVersionsRebuildNote || undefined, sharedWithNote: sharedWithNote || undefined },
            });
            if (onModClassified) {
                onModClassified({ ...base, status: 'REBUILD_QUEUED', existingStagingFolder: action.existingStagingFolder }, index, total);
            }
        }
    }

    return { modEntries, rebuildQueue };
}

function buildLogData({ collectionInfo, stagingDir, downloadsDir, backupRoot, dryRun, startedAt, runStatus, modEntries }) {
    return {
        schemaVersion: 1,
        collectionModId: collectionInfo.modId,
        collectionName: collectionInfo.name,
        collectionJsonPath: collectionInfo.collectionJsonPath,
        stagingDir, downloadsDir, backupRoot, dryRun,
        startedAt,
        finishedAt: runStatus === 'in-progress' ? null : new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
        runStatus,
        totalMods: modEntries.length,
        summary: summarize(modEntries),
        mods: modEntries,
    };
}

// Full-collection pre-run backup: persisted, cross-drive, never auto-deleted -- the user's own
// explicit extra-insurance request for the first real-run round. Only mods with an EXISTING
// staging folder have anything to back up; a mod with no staging folder at all has nothing to
// protect (see lib/rebuild-mod.js). onProgress({index, total, modName}) fires per mod copied.
function runBackup({ rebuildQueue, backupRoot, collectionModId, runTimestamp, onProgress }) {
    const toBackUp = rebuildQueue.filter(({ action }) => action.existingStagingFolder);
    const backupRunDir = path.join(backupRoot, `${collectionModId}-${runTimestamp}`);
    fs.mkdirSync(backupRunDir, { recursive: true });
    let index = 0;
    for (const { action, mod } of toBackUp) {
        index += 1;
        if (onProgress) onProgress({ index, total: toBackUp.length, modName: mod.name });
        fs.cpSync(action.stagingModDir, path.join(backupRunDir, action.targetFolderName), { recursive: true });
    }
    return { backupRunDir, backedUpCount: toBackUp.length };
}

// The per-mod rebuild loop. Mutates AND returns modEntries; onModStart/onModComplete fire around
// each rebuildMod() call. Halts (returns {haltedCritical: true}) on CRITICAL_MANUAL_RESTORE_NEEDED
// -- the one non-self-healing failure mode; everything else logs and continues.
async function runRebuild({ rebuildQueue, collectionJsonPath, downloadsDir, stagingDir, modEntries, onModStart, onModComplete }) {
    let haltedCritical = false;
    for (const { mod, action, base } of rebuildQueue) {
        if (onModStart) onModStart(mod);
        const result = await rebuildMod(mod, action, { collectionJsonPath, downloadsDir, stagingDir });
        // Surfaced so a FAILED_* entry in the report is actionable without reverse-engineering it
        // via Vortex or a manual archive search first -- confirmed live: a mismatch flagged only
        // by mod name left no way to find the actual archive (the user's own real archive filename
        // for "Bitchcraft Tats" is "1.0-82644-1-0-1727545168.7z", containing none of the mod's own
        // name at all).
        const archiveName = action.archivePath ? path.basename(action.archivePath) : undefined;
        const entry = { ...base, targetFolderName: action.targetFolderName, archiveName, ...result };
        modEntries.push(entry);
        if (onModComplete) onModComplete(entry);
        if (entry.status === 'CRITICAL_MANUAL_RESTORE_NEEDED') {
            haltedCritical = true;
            break;
        }
    }
    return { haltedCritical };
}

module.exports = {
    RESUMABLE_STATUSES,
    modKey,
    loadSyncLib,
    resolveCollectionInfo,
    loadSyncState,
    loadSyncStateBatch,
    loadResumeLog,
    writeLog,
    summarize,
    getOpenFomodMods,
    buildPlan,
    buildLogData,
    runBackup,
    runRebuild,
};
