'use strict';
// Cycle Helper's own on-demand "rules right before you went and hand-edited them in Vortex"
// snapshot -- see docs/plans/2026-08-16-cycle-helper-research.md's "Vortex keeps no rule-change
// timestamp anywhere" finding for why this exists at all. Deliberately lightweight: just
// {modKey: rules[]} for every mod enabled at snapshot time, NOT a full state.v2 backup (that's a
// different, heavier safety net -- see vortex-sync/lib.js's backupLiveState, taken automatically
// right before Apply writes anything). One snapshot at a time, overwritten on each new Snapshot
// click -- same simple single-record shape as backup-ratio-dismiss-state.js, not a growing log.
//
// Same plain load/save JSON-file pattern as lib/work-through-state.js -- gitignored, single source
// of truth, no database (this project's own established minimal-dependency ethos).

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'config', 'cycle-helper-snapshot.json');
const DEFAULT_STATE = { createdAt: null, rulesByModKey: null };

function loadSnapshot() {
    let onDisk = {};
    try {
        onDisk = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        // No file yet (fresh install, or never snapshotted) or unreadable/corrupt -- defaults cover
        // it, not an error worth surfacing, same convention as work-through-state.js's loadState().
    }
    return { ...DEFAULT_STATE, ...onDisk };
}

// rulesByModKey: {modKey: rule[]} for every mod enabled at snapshot time (from cycle-helper-worker's
// 'snapshot' mode, a real live-state read) -- stamps createdAt itself so every caller gets the same
// "now", rather than trusting a timestamp computed in a different process.
function saveSnapshot(rulesByModKey) {
    const state = { createdAt: new Date().toISOString(), rulesByModKey };
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
}

// For the Step-0 status bar -- doesn't leak the (potentially large) rulesByModKey payload into a
// route that only needs to know whether/when a snapshot exists.
function getSnapshotStatus() {
    const { createdAt } = loadSnapshot();
    return { taken: createdAt !== null, createdAt };
}

// Shared by every AUTOMATIC snapshot trigger (there is no manual button for these -- Update
// Collection's own apply-ignores-write/apply-disables-write in lib/state-write-worker.js, and Rules
// Generator's own apply-write in lib/rules-generator-worker.js): both are VCT-driven writes that
// touch a mod's `rules` array, so the user shouldn't have to remember to click Snapshot before
// either one. Takes an ALREADY-BUILT modIndex (every caller has one in scope already -- rebuilding
// it here would be a redundant second full DB scan) and the caller's own already-required syncLib
// module (for getLastActiveProfileId/getEnabledModKeys -- not required directly by this file so it
// stays as lightweight/dependency-free as work-through-state.js's own sibling files). MUST be called
// BEFORE the real write it's riding along on, not after -- the whole point is "what did the rules
// look like right before this change," not the just-modified result. Swallows its own errors (no
// active profile resolved, etc.) so a snapshot failure can never break the real write it's attached
// to -- this is a best-effort background capture, not part of any critical path.
async function captureFromLiveDb(db, modIndex, syncLib) {
    try {
        const profileId = await syncLib.getLastActiveProfileId(db);
        if (!profileId) return;
        const enabledModKeys = await syncLib.getEnabledModKeys(db, profileId);
        const rulesByModKey = {};
        for (const modKey of enabledModKeys) rulesByModKey[modKey] = modIndex.get(modKey)?.rules || [];
        saveSnapshot(rulesByModKey);
    } catch {
        // Best-effort only -- see header comment above.
    }
}

// Same automatic-snapshot purpose as captureFromLiveDb above, for the OTHER real write path
// (2026-08-18) -- Rules Generator/Update Collection writing through the optional Vortex Collection
// Helper extension instead of state.v2 directly (see lib/rules-generator-runner.js's own helper-
// backed apply/clearSkipped/switchSkipped functions). No `db`/`syncLib` needed here at all: the
// helper's own `GET /mods` response already resolved the active profile's enabledModKeys server-side
// (see lib/vortex-helper-client.js's getAllMods), so this just reads straight off the modIndex
// already built from that response -- same shape captureFromLiveDb produces, zero extra calls.
// Same best-effort contract: never throws, a snapshot failure must never break the real write it
// rides along on.
function captureFromRulesByModKey(enabledModKeys, modIndex) {
    try {
        const rulesByModKey = {};
        for (const modKey of enabledModKeys) rulesByModKey[modKey] = modIndex.get(modKey)?.rules || [];
        saveSnapshot(rulesByModKey);
    } catch {
        // Best-effort only -- see captureFromLiveDb's own header comment above.
    }
}

module.exports = { STATE_PATH, loadSnapshot, saveSnapshot, getSnapshotStatus, captureFromLiveDb, captureFromRulesByModKey };
