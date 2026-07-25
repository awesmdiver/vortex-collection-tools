'use strict';
// Persisted manual "completed" tracking for the Work Through Report -- ONLY for problem mods this
// tool can't resolve automatically (Category B: SKIP_OPEN_FOMOD, CRITICAL_MANUAL_RESTORE_NEEDED,
// FAILED_EXTRACTION_*, off-site SKIP_NO_ARCHIVE). Resolvable mods (FAILED_MISMATCH_NOT_TOUCHED,
// Nexus-hosted SKIP_NO_ARCHIVE) never touch this file at all -- resolving them mutates the log file
// itself in place (see resolveMismatchedMod/retryMissingArchiveDownload in collection-runner.js), so
// they naturally stop appearing on the next read with zero persistence needed here.
//
// Same simple load/save JSON-file pattern as lib/app-config.js -- gitignored, single source of
// truth, no database (this project's own established minimal-dependency ethos: only ~dozens of
// entries expected, a database would solve a performance problem that doesn't exist).

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'work-through-state.json');
const DEFAULT_STATE = { completed: {} };

function loadState() {
    let onDisk = {};
    try {
        onDisk = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        // No file yet (fresh install) or unreadable/corrupt -- defaults cover it, not an error worth
        // surfacing, same convention as app-config.js's loadConfig().
    }
    return { ...DEFAULT_STATE, ...onDisk, completed: { ...DEFAULT_STATE.completed, ...(onDisk.completed || {}) } };
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
}

// Stable across re-derivations of the "current issues" list (which recomputes fresh from log files
// every time, never persisting its own identity for a mod instance) -- falls back to name since some
// Category B mods (off-site sources) have no modId/fileId at all. A mod literally renamed between
// runs loses its completion flag; an accepted, minor imprecision this project already tolerates
// elsewhere (e.g. mod-name truncation in the log-view page).
function makeKey({ collectionModId, modId, fileId, name }) {
    return `${collectionModId}:${modId ?? 'noid'}:${fileId ?? 'noid'}:${name}`;
}

function setCompleted(key, completed) {
    const state = loadState();
    if (completed) state.completed[key] = { completedAt: new Date().toISOString() };
    else delete state.completed[key];
    saveState(state);
    return state;
}

// Drops any stored key that no longer matches a CURRENT Category-B problem mod -- keeps the file
// from accumulating permanently-stale entries once something is genuinely fixed via a real rerun
// (at which point it simply stops appearing in "current issues" at all). Cheap given the expected
// small entry count; called once per /list read.
function pruneToKeys(validKeys) {
    const state = loadState();
    const validSet = new Set(validKeys);
    let changed = false;
    for (const key of Object.keys(state.completed)) {
        if (!validSet.has(key)) {
            delete state.completed[key];
            changed = true;
        }
    }
    if (changed) saveState(state);
    return state;
}

module.exports = { STATE_PATH, loadState, saveState, makeKey, setCompleted, pruneToKeys };
