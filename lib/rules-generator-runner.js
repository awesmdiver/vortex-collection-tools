'use strict';
// Framework-agnostic orchestration for the Rules Generator flow, used by
// web/rules-generator-routes.js -- mirrors lib/sync-runner.js's own contract exactly: nothing
// here touches console/req/res, callers own all presentation.

const path = require('path');
const { spawn } = require('child_process');
const rg = require('./rules-generator');
const helperClient = require('./vortex-helper-client');
const anomalyMemoryStore = require('./rules-generator-anomaly-memory');
const chSnapshot = require('./cycle-helper-snapshot');
const appConfig = require('./app-config');

const WORKER_PATH = path.join(__dirname, 'rules-generator-worker.js');
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
                    reject(new Error(`Rules Generator worker produced invalid output: ${e.message}`));
                }
                return;
            }
            const message = stderr.trim();
            if (message) console.error(`[rules-generator-runner] worker exited ${code}: ${message}`);
            // A genuine, specific error from the worker (e.g. "collection not found") is more
            // useful surfaced directly than papered over with the generic crash text -- only fall
            // back to CRASH_HELP_TEXT when stderr has nothing actionable in it.
            reject(new Error(message || CRASH_HELP_TEXT));
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}

async function listWorkshopCollections(stateDir) {
    const { collections } = await runIsolated({ stateDir, mode: 'list-workshop-collections' });
    return collections;
}

async function analyze(stateDir, oldCollectionKey, newCollectionKey) {
    return runIsolated({ stateDir, mode: 'analyze', oldCollectionKey, newCollectionKey });
}

// Completed/Exceptions report -- read-only. anomalyOverrides lets an already-resolved "Needs your
// input" pick count as Completed rather than an Exception.
async function report(stateDir, oldCollectionKey, newCollectionKey, anomalyOverrides) {
    return runIsolated({ stateDir, mode: 'report', oldCollectionKey, newCollectionKey, anomalyOverrides });
}

// Read-only dry run -- an accurate count for the confirm dialog, no writes. Same
// oldCollectionKey/newCollectionKey plus the frontend's current per-row overrides
// (ruleOverrides: `${newModKey}::${ruleIdx}` -> type; anomalyOverrides: modKey -> picked
// candidate index; relationshipOverrides: modKey -> {targetKey, type}, Step 1: Relationship Check).
async function applyPreview(stateDir, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides) {
    return runIsolated({ stateDir, mode: 'apply-preview', oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides });
}

// The real write -- opens Vortex's LIVE state.v2 (full backup taken first, refuses if Vortex is
// running). Same params as applyPreview.
async function apply(stateDir, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides) {
    return runIsolated({ stateDir, mode: 'apply-write', oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides });
}

// Exception report's own "Clear all rules" -- read-only dry run for its confirm dialog. The skip
// list is always re-derived server-side from live/safe-copy data, never trusted from the client
// (see rules-generator.js's clearSkippedRules/computeApplyPlan header comments) -- anomalyOverrides
// is the only real input, same as report/applyPreview.
async function clearSkippedPreview(stateDir, oldCollectionKey, newCollectionKey, anomalyOverrides) {
    return runIsolated({ stateDir, mode: 'clear-skipped-preview', oldCollectionKey, newCollectionKey, anomalyOverrides });
}

// The real clear -- opens Vortex's LIVE state.v2 (full backup taken first, refuses if Vortex is
// running). Same params as clearSkippedPreview.
async function clearSkipped(stateDir, oldCollectionKey, newCollectionKey, anomalyOverrides) {
    return runIsolated({ stateDir, mode: 'clear-skipped-write', oldCollectionKey, newCollectionKey, anomalyOverrides });
}

// Step 3 (Exceptions)'s own "switch to match the old collection" -- read-only dry run for its
// confirm dialog. switchModKeys: array of newModKeys the user picked "Switch" for (per-mod picks via
// "Save my picks", or every currently-known skip's modKey for the bulk "Switch all" button) -- the
// skip list itself is always re-derived server-side, never trusted from the client.
async function switchSkippedPreview(stateDir, oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys) {
    return runIsolated({ stateDir, mode: 'switch-skipped-preview', oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys });
}

// The real switch -- opens Vortex's LIVE state.v2 (full backup taken first, refuses if Vortex is
// running). Same params as switchSkippedPreview.
async function switchSkipped(stateDir, oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys) {
    return runIsolated({ stateDir, mode: 'switch-skipped-write', oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys });
}

// Concrete ruleIO backend -- helper-extension-backed (2026-08-18). Mirrors lib/cycle-helper-runner.js's
// own makeHelperRuleIO exactly, just reused here rather than duplicated: readRules relays through
// the shared lib/vortex-helper-client.js's getLiveRulesForMod, commit dispatches every {remove, add}
// op in order via applyRuleChange (one POST /rules/apply per op -- see rules-generator.js's own
// makeLevelDbRuleIO comment for why a MULTI-op array is the right shape here, unlike Cycle Helper's
// own always-exactly-one-op case). Throws a real, user-facing error on failure -- once real live data
// is in hand and a write has started, a failure partway through is a genuine problem to surface, not
// a signal to silently retry through state.v2 (same reasoning as Cycle Helper's own makeHelperRuleIO).
function makeHelperRuleIO() {
    return {
        async readRules(modId) {
            const rules = await helperClient.getLiveRulesForMod(modId);
            if (rules === null) throw new Error(`Couldn't read live rules for "${modId}" from the helper extension.`);
            return rules;
        },
        async commit(modId, currentRules, ops) {
            for (const { remove, add } of ops) {
                const ok = await helperClient.applyRuleChange(modId, remove, add);
                if (!ok) throw new Error(`The helper extension couldn't apply a rule change for "${modId}".`);
            }
        },
    };
}

// Live-helper equivalents of listWorkshopCollections/analyze/report above (2026-08-18, Tier 2) --
// same "sourced from the optional Vortex Collection Helper extension instead of an isolated
// state.v2 worker process" pattern the six write/preview functions below already establish, applied
// to the three READ routes that gate the front door of the whole Rules Generator flow (page load's
// own collection picker, "Find matching rules", and the Report tab). No ruleIO/commit/snapshot
// concern here at all -- these never write anything, so this is pure "swap the data source" wiring:
// each mirrors its own state.v2-mode sibling in rules-generator-worker.js line for line, just reading
// modIndex from helperClient.getAllMods()+buildModIndexFromLiveData instead of a live withStateDb
// read. Returns `null` (never throws) ONLY when the helper's own /mods read fails, same contract as
// every other ViaHelper function here -- the caller falls back to the exact original gated path.
async function listWorkshopCollectionsViaHelper() {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    const collections = [];
    for (const entry of modIndex.values()) {
        if (entry.type !== 'collection') continue;
        if (!/^vortex_collection_/i.test(entry.modKey)) continue; // real installs excluded, see vortex-sync/lib.js
        collections.push({ modKey: entry.modKey, name: rg.displayName(entry) });
    }
    collections.sort((a, b) => a.name.localeCompare(b.name));
    return { collections };
}

async function analyzeViaHelper(oldCollectionKey, newCollectionKey) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    if (!modIndex.has(oldCollectionKey)) {
        throw new Error(`Original collection not found in Vortex's current state (it may have been removed or reinstalled).`);
    }
    if (!modIndex.has(newCollectionKey)) {
        throw new Error(`New collection not found in Vortex's current state (it may have been removed or reinstalled).`);
    }
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    const stagingRoot = appConfig.loadConfig().staging;
    const analysis = rg.analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemory, stagingRoot);
    const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, {}, {}, anomalyMemory, stagingRoot);
    const { toWrite, skippedAlreadySet: rawSkips } = rg.computeApplyPlan(modIndex, toApply);
    const pendingTripleKeys = new Set(toWrite.map((t) => `${t.newModKey}::${t.type}::${t.targetModKey}`));
    const exceptions = rg.computeSkipExceptions(modIndex, analysis, rawSkips);
    return { ...analysis, mapping: rg.filterMappingToPending(analysis.mapping, pendingTripleKeys), exceptions };
}

async function reportViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    if (!modIndex.has(oldCollectionKey)) {
        throw new Error(`Original collection not found in Vortex's current state (it may have been removed or reinstalled).`);
    }
    if (!modIndex.has(newCollectionKey)) {
        throw new Error(`New collection not found in Vortex's current state (it may have been removed or reinstalled).`);
    }
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    const stagingRoot = appConfig.loadConfig().staging;
    return rg.computeReportData(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, anomalyMemory, stagingRoot);
}

// Live-helper equivalents of the six functions above (2026-08-18) -- sourced from the optional
// Vortex Collection Helper extension instead of an isolated state.v2 worker process, so Apply/
// Clear-skipped/Switch-skipped (and their preview dry runs) can run with Vortex genuinely OPEN.
// Mirrors lib/cycle-helper-runner.js's own snapshotViaHelper/scanViaHelper/applyFixViaHelper pattern
// exactly: no process isolation (this never touches LevelDB at all, so the native-crash-risk reason
// the isolated worker exists doesn't apply), anomalyMemory/stagingRoot read the SAME plain local
// files the worker itself reads (no isolation concern either), and every function returns `null`
// (never throws) ONLY when the helper's own /mods read fails -- the caller falls back to the exact
// original state.v2 path in that case. A genuine failure from applyRules/clearSkippedRules/
// switchSkippedRules itself (once real live data is in hand) throws normally and should reach the
// user as a real error, exactly as the state.v2 path would produce for the identical scenario.
async function applyPreviewViaHelper(oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    const stagingRoot = appConfig.loadConfig().staging;
    return rg.applyRules(makeHelperRuleIO(), modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides, { dryRun: true, anomalyMemory, stagingRoot });
}

// The real write. Same "automatic Cycle Helper snapshot right before a VCT-driven rules[] write"
// courtesy the state.v2 path already extends (see rules-generator-worker.js's own apply-write mode)
// -- here via chSnapshot.captureFromRulesByModKey, which reads straight off the SAME modIndex this
// function already built from the helper's own /mods response, no db/syncLib needed at all.
async function applyViaHelper(oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    chSnapshot.captureFromRulesByModKey(data.enabledModKeys, modIndex);
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    const stagingRoot = appConfig.loadConfig().staging;
    const applyResult = await rg.applyRules(makeHelperRuleIO(), modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides, { dryRun: false, anomalyMemory, stagingRoot });
    // Same "re-derive fresh from the SAME in-memory-patched modIndex, no second read" pattern the
    // state.v2 path's own apply-write mode establishes -- applyRules already patched modIndex's own
    // entries as it wrote (see its own comment), so this is a correct, zero-extra-call recomputation.
    const freshAnalysis = rg.analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemoryStore.loadAnomalyChoices(), stagingRoot);
    const { toApply: freshToApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, {}, {}, anomalyMemory, stagingRoot);
    const { skippedAlreadySet: freshRawSkips } = rg.computeApplyPlan(modIndex, freshToApply);
    const freshExceptions = rg.computeSkipExceptions(modIndex, freshAnalysis, freshRawSkips);
    return { ...applyResult, freshAnalysis, freshExceptions };
}

async function clearSkippedPreviewViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    const stagingRoot = appConfig.loadConfig().staging;
    const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
    const { skippedAlreadySet } = rg.computeApplyPlan(modIndex, toApply);
    return {
        totalRulesToClear: skippedAlreadySet.length,
        totalModsAffected: new Set(skippedAlreadySet.map((s) => s.literalOwnerKey)).size,
    };
}

async function clearSkippedViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    chSnapshot.captureFromRulesByModKey(data.enabledModKeys, modIndex);
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    const stagingRoot = appConfig.loadConfig().staging;
    const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
    const { skippedAlreadySet } = rg.computeApplyPlan(modIndex, toApply);
    const clearResult = await rg.clearSkippedRules(makeHelperRuleIO(), modIndex, skippedAlreadySet);
    const freshReport = rg.computeReportData(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, anomalyMemory, stagingRoot);
    return { ...clearResult, freshReport };
}

async function switchSkippedPreviewViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    const stagingRoot = appConfig.loadConfig().staging;
    const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
    const { skippedAlreadySet } = rg.computeApplyPlan(modIndex, toApply);
    const wanted = new Set(switchModKeys || []);
    const filtered = skippedAlreadySet.filter((s) => wanted.has(s.newModKey));
    return {
        totalRulesToSwitch: filtered.length,
        totalModsAffected: new Set(filtered.map((s) => s.newModKey)).size,
    };
}

async function switchSkippedViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys) {
    const data = await helperClient.getAllMods();
    if (!data) return null;
    const modIndex = rg.buildModIndexFromLiveData(data.mods, data.enabledModKeys);
    chSnapshot.captureFromRulesByModKey(data.enabledModKeys, modIndex);
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    const stagingRoot = appConfig.loadConfig().staging;
    const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
    const { skippedAlreadySet } = rg.computeApplyPlan(modIndex, toApply);
    const wanted = new Set(switchModKeys || []);
    const filtered = skippedAlreadySet.filter((s) => wanted.has(s.newModKey));
    const switchResult = await rg.switchSkippedRules(makeHelperRuleIO(), modIndex, filtered);
    const freshAnalysis = rg.analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemoryStore.loadAnomalyChoices(), stagingRoot);
    const { toApply: freshToApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
    const { skippedAlreadySet: freshRawSkips } = rg.computeApplyPlan(modIndex, freshToApply);
    const freshExceptions = rg.computeSkipExceptions(modIndex, freshAnalysis, freshRawSkips);
    return { ...switchResult, freshExceptions };
}

module.exports = {
    listWorkshopCollections,
    analyze,
    report,
    applyPreview,
    apply,
    clearSkippedPreview,
    clearSkipped,
    switchSkippedPreview,
    switchSkipped,
    listWorkshopCollectionsViaHelper,
    analyzeViaHelper,
    reportViaHelper,
    applyPreviewViaHelper,
    applyViaHelper,
    clearSkippedPreviewViaHelper,
    clearSkippedViaHelper,
    switchSkippedPreviewViaHelper,
    switchSkippedViaHelper,
};
