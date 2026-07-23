'use strict';
// Framework-agnostic core orchestration for the Update Collection flow (backup -> apply-ignores ->
// apply-disables -> compare), shared by sync-cli.js, sync-menu.js, and web/sync-routes.js so none
// of the three reimplements this logic -- mirrors lib/collection-runner.js's own contract exactly:
// nothing here touches console/readline/process.exit; callers own all presentation.
//
// Before this file existed, sync-cli.js and sync-menu.js each independently implemented the same
// backup/apply-ignores/apply-disables dry-run-then-confirm-then-apply sequence -- this consolidates
// that real duplication, not just plumbing for the web UI.

const path = require('path');
const { spawn } = require('child_process');

const SYNC_LIB_PATH = path.join(__dirname, 'vortex-sync', 'lib.js');
const STATE_WRITE_WORKER_PATH = path.join(__dirname, 'state-write-worker.js');

function loadSyncLib() {
    return require(SYNC_LIB_PATH);
}

// Same isolation/timeout contract as lib/collection-runner.js's runIsolatedStateQuery -- see that
// function's own comment for the full native-crash rationale (classic-level/LevelDB can hit an
// unrecoverable native assertion crash on certain real-world write-ahead-log shapes, even with
// Vortex fully closed). Applies identically here -- writes go through the exact same binding, so
// this gets the SAME isolation/timeout treatment as reads, not less caution just because it writes.
const SYNC_OP_TIMEOUT_MS = 30_000;

const CRASH_HELP_TEXT =
    'Could not complete this step. While reading/writing Vortex\'s database, there was a crash, ' +
    'possibly due to files still being written from a recent Vortex session. If a Windows error ' +
    'dialog appeared, check your taskbar -- it can open behind other windows -- and click Abort. ' +
    'Try again; if it keeps happening, close this application, open Vortex, wait a moment, then ' +
    'close Vortex normally, and restart this application.';

const TIMEOUT_HELP_TEXT =
    'This step is taking too long -- this usually means a Windows error dialog is open and hidden ' +
    'behind other windows. Check your taskbar, click Abort on it, then try again. If it keeps ' +
    'happening, close this application, open Vortex, wait a moment, then close Vortex normally, ' +
    'and restart this application.';

function runIsolatedSyncOp(input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [STATE_WRITE_WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, SYNC_OP_TIMEOUT_MS);

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
                    reject(new Error(`Sync worker produced invalid output: ${e.message}`));
                }
                return;
            }
            reject(new Error(CRASH_HELP_TEXT + (stderr.trim() ? ` (details: ${stderr.trim()})` : '') + ` [exit ${code}${signal ? `, signal ${signal}` : ''}]`));
        });
        child.stdin.write(JSON.stringify({ syncLibPath: SYNC_LIB_PATH, ...input }));
        child.stdin.end();
    });
}

// ---------- Picker ----------

function listInstalledCollections(stagingDir) {
    return loadSyncLib().scanStagingCollections(stagingDir);
}

async function listProfiles(stateDir) {
    const { profiles } = await runIsolatedSyncOp({ stateDir, mode: 'list-profiles' });
    return profiles;
}

// ---------- Phase 1: Backup (run BEFORE clicking "Update" in Vortex) ----------

async function captureBackupSnapshot({ stateDir, stagingDir, collectionModId, profileId }) {
    const syncLib = loadSyncLib();
    const collections = stagingDir ? syncLib.scanStagingCollections(stagingDir) : [];
    const collectionName = collections.find((c) => c.modId === collectionModId)?.name || collectionModId;
    const captured = await runIsolatedSyncOp({ stateDir, mode: 'backup-capture', collectionModId, profileId, stagingDir });
    return syncLib.buildBackupSnapshot({
        collectionModId, collectionName, profileId, profileName: captured.profileName,
        stagingDir, ignored: captured.ignored, disabled: captured.disabled,
    });
}

function saveBackupSnapshot(snapshot) {
    return loadSyncLib().saveBackup(snapshot);
}

function listBackups() {
    return loadSyncLib().listBackups();
}

function loadBackup(filePath) {
    return loadSyncLib().loadBackup(filePath);
}

// ---------- Phase 2: Apply Ignores (run AFTER Vortex Update -> Later, Vortex closed) ----------

async function previewApplyIgnores({ stateDir, modId, ignoredRefs }) {
    const { changed } = await runIsolatedSyncOp({ stateDir, mode: 'apply-ignores-preview', modId, ignoredRefs });
    return changed;
}

function checkVortexVersionCompat(stateDir) {
    return loadSyncLib().checkVortexVersionCompat(stateDir);
}

// Returns { changed, backupDir, vortexVersion, versionTested }.
function applyIgnores({ stateDir, modId, ignoredRefs }) {
    return runIsolatedSyncOp({ stateDir, mode: 'apply-ignores-write', modId, ignoredRefs });
}

// ---------- Phase 3: Apply Disables (run AFTER Resume finishes, Vortex closed) ----------

async function previewApplyDisables({ stateDir, disabledRefs }) {
    const { matches } = await runIsolatedSyncOp({ stateDir, mode: 'apply-disables-preview', disabledRefs });
    return matches;
}

// Returns { changed, backupDir, vortexVersion, versionTested }.
function applyDisables({ stateDir, profileId, disabledRefs }) {
    return runIsolatedSyncOp({ stateDir, mode: 'apply-disables-write', profileId, disabledRefs });
}

// ---------- Optional: Compare (pure computation, never touches the state DB) ----------

function compareCollectionAgainstBackup(collection, snapshot) {
    return loadSyncLib().computeSync(collection, snapshot.ignored, snapshot.disabled);
}

function writePatchedCollection(collection, syncResult, outPath) {
    return loadSyncLib().writePatchedCollection(collection, syncResult, outPath);
}

module.exports = {
    loadSyncLib,
    listInstalledCollections,
    listProfiles,
    captureBackupSnapshot,
    saveBackupSnapshot,
    listBackups,
    loadBackup,
    previewApplyIgnores,
    checkVortexVersionCompat,
    applyIgnores,
    previewApplyDisables,
    applyDisables,
    compareCollectionAgainstBackup,
    writePatchedCollection,
};
