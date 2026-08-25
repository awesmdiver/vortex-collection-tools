'use strict';
// Persisted per-collection "what did we actually fetch" tracker for Workshop Report's own real
// staleness check (queue: workshop-report-real-staleness-check) -- same lightweight load/save JSON
// pattern as lib/rebuild-missing-last-fixed-state.js, gitignored, single source of truth, no
// database.
//
// Answers a different question than that file's own lastFixed/lastChecked: not "when did I last
// look at this collection" but "which REVISION of this collection is the one currently on disk,
// according to Nexus." Workshop Report's own /check compares each check's freshly-resolved
// {revisionNumber, updatedAt} against what's recorded here to decide updateAvailable -- see that
// route's own comment for why the comparison itself must be on updatedAt, never revisionNumber alone
// (a draft/unlisted collection's revision is edited IN PLACE on Nexus; the number doesn't
// necessarily change when the content does -- lib/nexus-collection-download.js's own
// resolveNewestRevision resolves by updatedAt for exactly this reason, and this tracker inherits the
// same discipline).
//
// Keyed by collectionModId (the staging folder name), matching rebuild-missing-last-fixed-state.js's
// own keying rationale -- see that file's header for why collectionModId, not collection name.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'config', 'workshop-report-fetch-state.json');

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        // No file yet (fresh install, or before this feature shipped) or unreadable/corrupt --
        // an empty tracker is the correct default, same convention as app-config.js's loadConfig().
        return {};
    }
}

function saveState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
}

// Records the revision that was ACTUALLY downloaded for collectionModId, right after a real,
// successful fetch (first-time or re-fetch, both count -- see refreshCollectionFromNexus's own
// call site). fetchedAt is informational only (when THIS TOOL did the fetch), never used for the
// staleness comparison itself -- only revisionNumber/updatedAt (what Nexus itself reports for the
// fetched revision) are.
function recordFetch(collectionModId, { revisionNumber, updatedAt }) {
    if (!collectionModId) return loadState();
    const state = loadState();
    state[collectionModId] = { revisionNumber, updatedAt, fetchedAt: new Date().toISOString() };
    return saveState(state);
}

function getTrackedRevision(collectionModId) {
    return loadState()[collectionModId] || null;
}

module.exports = { recordFetch, getTrackedRevision };
