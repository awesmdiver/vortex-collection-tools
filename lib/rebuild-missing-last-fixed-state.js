'use strict';
// Persisted per-collection "last dealt with" timestamp for Rebuild Missing Files' own picker
// (queue: rebuild-missing-last-fixed) -- lightweight, purpose-built store, deliberately NOT Rebuild
// Collection's own heavy per-run JSON log system (logsDir/findLatestRealLog/runStatus/resumability,
// see web/rebuild-routes.js's findLastExtracted) -- this tool has none of those concepts (no
// resumability, no halted-critical state), so a small collectionModId -> ISO timestamp map is
// enough. Same simple load/save JSON-file pattern as lib/backup-ratio-dismiss-state.js -- gitignored,
// single source of truth, no database.
//
// Keyed by collectionModId (the staging folder name), matching Rebuild Collection's own "Last
// extracted" (findLastExtracted is keyed the same way, via its per-collection log filenames) --
// deliberately NOT collection name, unlike backup-ratio-dismiss-state.js's own name-keying. That
// file's own header explains why IT needs name-keying: an Update Collection run RENAMES the staging
// folder (a new archive-derived modId), and a "you already acknowledged this" dismissal should
// survive that indefinitely. A recency timestamp is different -- the whole point is "were the files
// THIS folder currently has checked recently," so resetting to "no timestamp" once the folder
// changes is the honest behavior, not a bug: a timestamp carried over from before an update would
// otherwise misleadingly claim the CURRENT (post-update) files were already checked.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'rebuild-missing-last-fixed-state.json');
const DEFAULT_STATE = { lastFixed: {} };

function loadState() {
    let onDisk = {};
    try {
        onDisk = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        // No file yet (fresh install) or unreadable/corrupt -- defaults cover it, not an error
        // worth surfacing, same convention as app-config.js's loadConfig().
    }
    return { ...DEFAULT_STATE, ...onDisk, lastFixed: { ...DEFAULT_STATE.lastFixed, ...(onDisk.lastFixed || {}) } };
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
}

// Judgment call (flagged in the handoff, not silently guessed): only a REAL fix -- at least one
// file actually extracted, or an archive actually downloaded -- marks a collection dealt-with. A
// scan alone, even one that finds nothing wrong, does NOT call this. Matches Rebuild Collection's
// own "Last extracted" semantics: a real rebuild happened, not just a picker load.
function markFixed(collectionModId) {
    if (!collectionModId) return loadState();
    const state = loadState();
    state.lastFixed[collectionModId] = new Date().toISOString();
    return saveState(state);
}

function getLastFixed(collectionModId) {
    return loadState().lastFixed[collectionModId] || null;
}

module.exports = { markFixed, getLastFixed };
