'use strict';
// Framework-agnostic core orchestration for the Update Collection flow (backup -> apply-ignores ->
// apply-disables -> compare), used by web/sync-routes.js -- mirrors lib/collection-runner.js's own
// contract exactly: nothing here touches console/readline/process.exit; callers own all
// presentation. sync-cli.js still calls lib/vortex-sync/lib.js directly rather than through here
// (see TECHNICAL.md's Future Work -- low-priority cleanup, functionally unaffected). The interactive
// terminal menu that used to also call lib.js directly (sync-menu.js) has been archived -- see
// terminal-flow-archive/, gitignored -- this project is 100% web-UI-driven now.

const fs = require('fs');
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

// Deliberately covers all THREE real causes in one message rather than trying to tell them apart --
// confirmed live this is genuinely ambiguous from here: a real native LevelDB crash (files still
// being written from a recent Vortex session), an ordinary "Vortex hasn't written this mod to its
// state database yet" error, and a manually-entered collection id that's simply gone stale (its own
// clear message either way, e.g. from getRules()) all surface as a non-zero exit from the isolated
// worker process, with no reliable way to tell them apart from the exit code/stderr text alone.
// Numbered so any of the three is easy to act on without first figuring out which one actually
// happened.
const CRASH_HELP_TEXT =
    'Could not complete this step due to not being able to read/write to Vortex\'s database.\n\n' +
    'Three possible scenarios:\n' +
    '1. Open Vortex and click **Refresh** in the upper-right corner of the Added Collections page, then close Vortex.\n' +
    '2. A crash and a Windows error dialog may have appeared -- check your taskbar (it may have opened behind other windows) and click **Abort**.\n' +
    '3. The Vortex collection id manually entered is no longer valid -- please correct or remove it before pressing Preview.\n\n' +
    'Try this step again.';

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
            // The raw stderr/exit code used to be appended directly to the user-facing message --
            // confirmed live this was exactly the clutter making an already-plain-English error
            // ("mod not found... try Refresh") look like a cryptic crash report. Logged to this
            // process's own console instead (still available for real debugging) rather than
            // shown to the user at all, who gets just the clean, actionable CRASH_HELP_TEXT.
            if (stderr.trim()) {
                console.error(`[sync-runner] worker exited ${code}${signal ? ` (signal ${signal})` : ''}: ${stderr.trim()}`);
            }
            reject(new Error(CRASH_HELP_TEXT));
        });
        child.stdin.write(JSON.stringify({ syncLibPath: SYNC_LIB_PATH, ...input }));
        child.stdin.end();
    });
}

// ---------- Picker ----------

function listInstalledCollections(stagingDir) {
    return loadSyncLib().scanStagingCollections(stagingDir);
}

// Returns { profiles, lastActiveProfileId } -- lastActiveProfileId lets the UI default-select the
// profile Vortex was actually last using for this game, instead of leaving that to guesswork.
async function listProfiles(stateDir) {
    return runIsolatedSyncOp({ stateDir, mode: 'list-profiles' });
}

// ---------- Read-only reports (callable any time, regardless of workflow phase) ----------

async function listIgnoredMods({ stateDir, modId }) {
    const { ignored } = await runIsolatedSyncOp({ stateDir, mode: 'list-ignored', modId });
    return ignored;
}

async function listDisabledMods({ stateDir, modId, profileId }) {
    const { disabled } = await runIsolatedSyncOp({ stateDir, mode: 'list-disabled', modId, profileId });
    return disabled;
}

// ---------- Phase 1: Backup (run BEFORE clicking "Update" in Vortex) ----------

async function captureBackupSnapshot({ stateDir, stagingDir, collectionModId, profileId }) {
    const syncLib = loadSyncLib();
    const collections = stagingDir ? syncLib.scanStagingCollections(stagingDir) : [];
    const matchedCollection = collections.find((c) => c.modId === collectionModId);
    const collectionName = matchedCollection?.name || collectionModId;
    // Captured now, before the user clicks Update in Vortex, so a later Compare can diff the OLD
    // collection.json's full mod list against the NEW one -- what the collection AUTHOR added/removed,
    // independent of anything the user personally ignored/disabled. null if it can't be read right
    // now (e.g. nothing staged yet) -- Compare treats that as "not captured", not "nothing changed".
    let oldMods = null;
    if (matchedCollection) {
        try {
            const raw = JSON.parse(fs.readFileSync(matchedCollection.collectionJsonPath, 'utf8'));
            oldMods = syncLib.extractModsForSnapshot(raw);
        } catch {
            oldMods = null;
        }
    }
    const captured = await runIsolatedSyncOp({ stateDir, mode: 'backup-capture', collectionModId, profileId, stagingDir });
    return syncLib.buildBackupSnapshot({
        collectionModId, collectionName, profileId, profileName: captured.profileName,
        stagingDir, ignored: captured.ignored, disabled: captured.disabled, oldMods,
    });
}

// backupsDir: optional override (Settings' "Update Collection backups folder" / config.json's
// syncBackupRoot) -- lib.js's own saveBackup/listBackups already default to their hardcoded
// lib/vortex-sync/backups/ when this is omitted, so passing undefined here is exactly "use the
// default", not an error case.
function saveBackupSnapshot(snapshot, backupsDir) {
    return loadSyncLib().saveBackup(snapshot, backupsDir);
}

function listBackups(backupsDir) {
    return loadSyncLib().listBackups(backupsDir);
}

function loadBackup(filePath) {
    return loadSyncLib().loadBackup(filePath);
}

// ---------- Phase 2: Apply Ignores (run AFTER Vortex Update -> Later, Vortex closed) ----------

async function previewApplyIgnores({ stateDir, modId, ignoredRefs }) {
    return runIsolatedSyncOp({ stateDir, mode: 'apply-ignores-preview', modId, ignoredRefs });
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
    const { matches, identityWarning } = await runIsolatedSyncOp({ stateDir, mode: 'apply-disables-preview', disabledRefs });
    return { matches, identityWarning };
}

// Returns { changed, backupDir, vortexVersion, versionTested }.
function applyDisables({ stateDir, profileId, disabledRefs }) {
    return runIsolatedSyncOp({ stateDir, mode: 'apply-disables-write', profileId, disabledRefs });
}

// ---------- Recovery: restore a previous state.v2 backup ----------

function listStateBackups() {
    return loadSyncLib().listStateBackups();
}

// Returns { restoredFrom, preRestoreBackupDir }.
function restoreState({ stateDir, backupDir }) {
    return runIsolatedSyncOp({ stateDir, mode: 'restore-state', backupDir });
}

// ---------- Optional: Compare (pure computation, never touches the state DB) ----------

function compareCollectionAgainstBackup(collection, snapshot) {
    return loadSyncLib().computeSync(collection, snapshot.ignored, snapshot.disabled, snapshot.oldMods);
}

function writePatchedCollection(collection, syncResult, outPath) {
    return loadSyncLib().writePatchedCollection(collection, syncResult, outPath);
}

module.exports = {
    loadSyncLib,
    listInstalledCollections,
    listProfiles,
    listIgnoredMods,
    listDisabledMods,
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
    listStateBackups,
    restoreState,
};
