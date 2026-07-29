'use strict';
// Persisted per-collection dismissals for Update Collection's backup ratio warning (sync-app.js's
// buildBackupRatioWarning) -- "This is normal for this collection" means never flag THIS collection
// again, without silencing the warning for every other collection. Same simple load/save JSON-file
// pattern as lib/work-through-state.js -- gitignored, single source of truth, no database (only a
// handful of entries expected).
//
// Keyed by collection NAME (normalized), not modId. Confirmed live (2026-07-29) against this
// install's own real data that modId is NOT stable across a collection update, and not just in the
// revision/timestamp segments a first read of the folder-naming convention would suggest -- "Body
// Swap updated"'s own middle "nexusModId" segment itself changed between two real revisions of the
// SAME collection (745639 at rev 22, 747482 at rev 25). There is no substring of modId that survives
// an update, so keying by it would defeat the entire point of a PERSISTENT dismissal -- the user
// would lose it exactly when Update Collection is actually used. Name is the same stable identity
// this codebase already relies on elsewhere for this identical problem (see sync-app.js's
// backupsFor(), which matches backups to a collection by name across updates for the same reason).
// Normalized via trim+lowercase so incidental case/whitespace differences (a trailing space in a
// collection's own display name, confirmed real on "Body Swap updated ") don't fork one collection
// into two entries.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'backup-ratio-dismiss-state.json');
const DEFAULT_STATE = { dismissed: {} };

function normalizeKey(collectionName) {
    return String(collectionName || '').trim().toLowerCase();
}

function loadState() {
    let onDisk = {};
    try {
        onDisk = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        // No file yet (fresh install) or unreadable/corrupt -- defaults cover it, not an error worth
        // surfacing, same convention as app-config.js's loadConfig().
    }
    return { ...DEFAULT_STATE, ...onDisk, dismissed: { ...DEFAULT_STATE.dismissed, ...(onDisk.dismissed || {}) } };
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
}

function isDismissed(collectionName) {
    const key = normalizeKey(collectionName);
    if (!key) return false;
    return !!loadState().dismissed[key];
}

function setDismissed(collectionName) {
    const key = normalizeKey(collectionName);
    if (!key) return loadState();
    const state = loadState();
    // collectionName (original casing) kept purely for display/debugging -- the key itself is what's
    // actually matched against.
    state.dismissed[key] = { dismissedAt: new Date().toISOString(), collectionName };
    return saveState(state);
}

function getDismissedCount() {
    return Object.keys(loadState().dismissed).length;
}

// "Remind me for all collections again" (Settings) -- clears every dismissal at once. Deliberately
// no confirmation modal at the route/UI layer: unlike deleting real backup files, this only resets a
// preference -- re-dismissing a still-normal collection later costs one click, nothing is lost.
function resetAll() {
    return saveState({ dismissed: {} });
}

module.exports = { STATE_PATH, loadState, saveState, isDismissed, setDismissed, getDismissedCount, resetAll };
