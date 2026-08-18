'use strict';
// Framework-agnostic orchestration for Cycle Helper, used by web/cycle-helper-routes.js -- mirrors
// lib/rules-generator-runner.js's own contract exactly: nothing here touches console/req/res,
// callers own all presentation.

const path = require('path');
const { spawn } = require('child_process');
const helperClient = require('./vortex-helper-client');
const rg = require('./rules-generator');
const cd = require('./cycle-detector');
const { shapeCycleResult } = require('./cycle-helper-shape');

const WORKER_PATH = path.join(__dirname, 'cycle-helper-worker.js');
const OP_TIMEOUT_MS = 30_000;

const CRASH_HELP_TEXT =
    "Couldn't read Vortex's database for this. Make sure Vortex is fully closed and try again -- " +
    'if it keeps happening, a Windows error dialog may be open and hidden behind other windows ' +
    '(check your taskbar).';

const TIMEOUT_HELP_TEXT =
    'This is taking too long -- this usually means a Windows error dialog is open and hidden ' +
    'behind other windows. Check your taskbar, close it, then try again.';

function runIsolated(input) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, OP_TIMEOUT_MS);

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(TIMEOUT_HELP_TEXT));
                return;
            }
            if (code === 0) {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(new Error(`Cycle Helper worker produced invalid output: ${e.message}`));
                }
                return;
            }
            const message = stderr.trim();
            if (message) console.error(`[cycle-helper-runner] worker exited ${code}: ${message}`);
            reject(new Error(message || CRASH_HELP_TEXT));
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

// Read-only -- {modKey: rules[]} for every mod enabled right now. The caller is responsible for
// persisting the result (lib/cycle-helper-snapshot.js) -- this only ever reads Vortex's state.
async function snapshot(stateDir) {
    const { rulesByModKey } = await runIsolated({ stateDir, mode: 'snapshot' });
    return rulesByModKey;
}

// Read-only. snapshotRulesByModKey (optional): the prior snapshot's rulesByModKey, already loaded
// from disk by the caller.
async function scan(stateDir, snapshotRulesByModKey) {
    return runIsolated({ stateDir, mode: 'scan', snapshotRulesByModKey: snapshotRulesByModKey || null });
}

// The real write -- opens Vortex's LIVE state.v2 (full backup taken first, refuses if Vortex is
// running). action: 'remove' | 'flip'. The result includes a `validation` field: a fresh post-write
// scan, read through the SAME live handle that did the write (see cycle-helper-worker.js's own
// comment on why -- a separate later withStateDb copy can miss this write entirely).
async function applyFix(stateDir, ownerModKey, ruleType, targetModKey, action, snapshotRulesByModKey) {
    return runIsolated({
        stateDir, mode: 'apply-fix', ownerModKey, ruleType, targetModKey, action,
        snapshotRulesByModKey: snapshotRulesByModKey || null,
    });
}

// Best-effort ONLY -- mirrors sync-runner.js's own checkBackupFreshness exactly, including its
// crash-safety contract. Self-contained: it re-reads Vortex's live state.v2 fresh every call and
// never depends on a prior Scan having run, so the caller can call this as early as landing on Cycle
// Helper's own first screen, not only after a Scan result already rendered (2026-08-18 -- see
// cycle-helper-app.js's own callers). The worker mode this calls (`scan-freshness-check`) prefers the
// optional Vortex Collection Helper extension when it's running (no WAL involved at all -- see
// lib/vortex-helper-client.js); only when that's NOT available does it fall back to a WAL-included
// read diffed against the safe copy, which carries a documented native-crash risk (see
// vortex-sync/lib.js's withStateDbIncludingWal comment) -- if that crashes this whole isolated worker
// process, this just resolves `{ checked: false }` rather than throwing, since a missed bonus check
// should never turn into a user-facing error. `source` ('helper-extension' | 'wal-diff') says which
// path actually answered -- not user-facing UI, just a low-key signal for confirming which path ran.
async function checkScanFreshness(stateDir) {
    try {
        const { stale, diffCount, source } = await runIsolated({ stateDir, mode: 'scan-freshness-check' });
        return { checked: true, stale, diffCount, source };
    } catch {
        return { checked: false, stale: false };
    }
}

// Change History (2026-08-18) -- reverts a batch of previously-applied fixes in ONE live-state open
// (one backup, one Vortex-closed gate). fixes: an array of fix records exactly as logged by
// lib/cycle-helper-history.js (ownerModKey/targetModKey/action/originalType-or-originalRule/etc, see
// its own header comment for the full shape) -- these are self-contained, so callers can hand this
// either the CURRENT in-progress session's own just-applied fixes (inline revert) or a past session
// loaded from disk (Change History page) with no other difference. Partial success is expected: see
// cycle-helper-worker.js's own 'revert-fixes' mode for why a stale row never blocks the others.
async function revertFixes(stateDir, fixes) {
    return runIsolated({ stateDir, mode: 'revert-fixes', fixes });
}

// Live-data equivalents of snapshot()/scan() above (2026-08-18) -- sourced from the optional Vortex
// Collection Helper extension (lib/vortex-helper-client.js) instead of an isolated state.v2 worker
// process, so Snapshot/Scan can work with Vortex still OPEN (director's own ask -- see
// web/cycle-helper-routes.js's own helper-availability check, which decides whether to call these or
// the state.v2 functions above). No process isolation here, unlike everything above -- this never
// touches LevelDB at all (the whole native-crash-risk reason runIsolated/the worker process exist in
// the first place), it's a plain HTTP fetch plus in-process JS, so running it directly in this
// long-running server process is safe. Both return null (never throw) if the helper's /mods call
// fails for any reason, even after /health already answered -- the caller falls back to the state.v2
// path in that case, same "never let this speed path break the existing one" posture as everything
// else helper-related.
async function snapshotViaHelper() {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const rulesByModKey = {};
    for (const modKey of data.enabledModKeys) {
        rulesByModKey[modKey] = (data.mods[modKey] && data.mods[modKey].rules) || [];
    }
    return rulesByModKey;
}

// snapshotRulesByModKey (optional): the PRIOR snapshot's rulesByModKey, already loaded from disk by
// the caller -- same parameter/meaning as scan() above, just fed into the SAME analyzeCycles ranking
// logic against a live-sourced modIndex instead of a state.v2-sourced one.
async function scanViaHelper(snapshotRulesByModKey) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    const analysis = cd.analyzeCycles(modIndex, data.enabledModKeys, snapshotRulesByModKey || null);
    return shapeCycleResult(rg, modIndex, analysis);
}

// Concrete ruleIO backend for cd.applyCandidateFix/revertFix (2026-08-18) -- writes through the
// companion extension's real Redux dispatch instead of LevelDB. See TECHNICAL.md's "Safety model"
// write-up for why there's deliberately no backup step here: dispatching addModRule/removeModRule
// through Vortex's own reducer is exactly as safe as a hand-edit through Vortex's own Conflict
// Editor -- no more, no less -- and Cycle Helper's own Snapshot feature remains an independent
// safety net regardless of which write path is active. commit() throws a real, user-facing error on
// failure (never silently swallowed) -- a write that got this far already passed the find/validate
// step in cycle-detector.js, so a failure here is a genuine problem worth surfacing, not a signal to
// silently retry via state.v2.
function makeHelperRuleIO() {
    return {
        async readRules(modId) {
            const rules = await helperClient.getLiveRulesForMod(modId);
            if (rules === null) throw new Error(`Couldn't read live rules for "${modId}" from the helper extension.`);
            return rules;
        },
        async commit(modId, currentRules, remove, add) {
            const ok = await helperClient.applyRuleChange(modId, remove, add);
            if (!ok) throw new Error(`The helper extension couldn't apply this rule change for "${modId}".`);
        },
    };
}

// Live-helper equivalent of applyFix above (2026-08-18) -- writes through the companion extension's
// POST /rules/apply instead of withLiveStateDb, so Apply-fix can run with Vortex genuinely OPEN.
// Returns null (never throws) ONLY when the helper's own /mods read fails -- that's the "helper
// unavailable" signal the caller falls back to state.v2 on. Once real live data is in hand, a
// genuine failure from applyCandidateFix itself (rule not found, stale) throws normally and should
// reach the user as a real error, exactly as the state.v2 path would produce for the identical
// scenario -- NOT be silently retried through a different mechanism.
async function applyFixViaHelper(ownerModKey, ruleType, targetModKey, action) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    const fixResult = await cd.applyCandidateFix(makeHelperRuleIO(), modIndex, ownerModKey, ruleType, targetModKey, action);

    // Post-write validation, predicted locally rather than re-fetched (2026-08-18) -- deliberately
    // NOT a second ~46MB /mods call. See TECHNICAL.md's Cycle Helper section for the real
    // investigation this came out of: repeated large-payload JSON parses inside this one
    // long-running server process, not any network/connection issue, turned out to be the actual
    // cause of a real director-reported reliability bug -- halving the large-payload load per
    // Apply-fix (2 calls -> 1) is a direct, verified mitigation. This is safe, not a shortcut:
    // `commit()` only returns normally once Vortex's own reducer has accepted the exact remove/add
    // pair below, so the resulting rules array is fully known, not guessed -- mirrors
    // makeLevelDbRuleIO's own commit (remove old, then add new) exactly, applied to the SAME
    // in-memory modIndex entry the fix itself was resolved against.
    const ownerEntry = modIndex.get(ownerModKey);
    const newRule = action === 'flip' ? { ...fixResult.originalRule, type: rg.invertType(ruleType) } : undefined;
    const removeIdx = ownerEntry.rules.indexOf(fixResult.originalRule);
    let updatedRules = removeIdx === -1
        ? ownerEntry.rules
        : ownerEntry.rules.slice(0, removeIdx).concat(ownerEntry.rules.slice(removeIdx + 1));
    if (newRule) updatedRules = updatedRules.concat([newRule]);
    ownerEntry.rules = updatedRules; // this modIndex is local and disposable -- only ever used for this one validation pass

    const analysis = cd.analyzeCycles(modIndex, data.enabledModKeys, null);
    const validation = shapeCycleResult(rg, modIndex, analysis);
    return {
        ...fixResult,
        targetModKey,
        ownerName: rg.displayName(modIndex.get(ownerModKey)),
        targetName: rg.displayName(modIndex.get(targetModKey)),
        originalType: action === 'flip' ? ruleType : undefined,
        newType: action === 'flip' ? rg.invertType(ruleType) : undefined,
        resolvedCycle: !validation.hasCycles,
        validation,
    };
}

// Live-helper equivalent of revertFixes above (2026-08-18) -- same partial-success contract as
// cycle-helper-worker.js's own 'revert-fixes' mode: each fix is tried independently, a stale row's
// own failure is caught and reported in `failed`, never aborting the rest of the batch. Returns null
// (never throws) ONLY when the helper's own /mods read fails -- the caller falls back to state.v2 in
// that case, same as applyFixViaHelper above.
async function revertFixesViaHelper(fixes) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    const ruleIO = makeHelperRuleIO();
    const reverted = [];
    const failed = [];
    for (const fix of fixes) {
        try {
            await cd.revertFix(ruleIO, modIndex, fix);
            reverted.push({ ownerModKey: fix.ownerModKey, ownerName: fix.ownerName, targetModKey: fix.targetModKey, targetName: fix.targetName });
        } catch (e) {
            failed.push({ ownerModKey: fix.ownerModKey, ownerName: fix.ownerName, targetModKey: fix.targetModKey, targetName: fix.targetName, message: e.message });
        }
    }
    return { reverted, failed };
}

module.exports = {
    snapshot, scan, applyFix, checkScanFreshness, revertFixes,
    snapshotViaHelper, scanViaHelper, applyFixViaHelper, revertFixesViaHelper,
};
