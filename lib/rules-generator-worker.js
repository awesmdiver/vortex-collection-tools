#!/usr/bin/env node
// Isolated child process for Rules Generator's DB reads -- same native-LevelDB-crash rationale as
// lib/state-query-worker.js/state-write-worker.js (see their own header comments): a long-running
// web server process must never call withStateDb in-process. Mirrors state-write-worker.js's
// mode-dispatched protocol exactly.
//
// Protocol: reads one JSON line from stdin: { stateDir, mode, ...params }.
// Writes one JSON line to stdout on success: whatever shape that mode's operation returns.

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const input = JSON.parse(await readStdin());
    const { stateDir, mode } = input;
    const syncLib = require('./vortex-sync/lib');
    const rg = require('./rules-generator');
    const anomalyMemoryStore = require('./rules-generator-anomaly-memory');
    // Loaded once per request, reused across whichever mode below needs it -- a small, plain local
    // JSON file (see rules-generator-anomaly-memory.js's own header comment), not DB access, so
    // there's no isolation/crash-risk reason to defer this. Harmless no-op cost for modes that don't
    // touch analyzeCollections at all (e.g. list-workshop-collections).
    const anomalyMemory = anomalyMemoryStore.loadAnomalyChoices();
    // config.staging (2026-08-16) -- for computeMappingDetails' own no-current-conflict check (see
    // its own header comment). null when unconfigured, in which case that check is skipped
    // entirely -- same plain local-file read as anomalyMemory above, no isolation concern.
    const stagingRoot = require('./app-config').loadConfig().staging;

    let result;
    switch (mode) {
        // Real installed collections (has collection.json) are already listable without touching
        // the DB at all (see sync-runner.js's listInstalledCollections) -- this mode is only for
        // Workshop-only collections (no collection.json), which can't be discovered any other way.
        case 'list-workshop-collections': {
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const collections = [];
                for (const entry of modIndex.values()) {
                    if (entry.type !== 'collection') continue;
                    if (!/^vortex_collection_/i.test(entry.modKey)) continue; // real installs excluded, see vortex-sync/lib.js
                    collections.push({ modKey: entry.modKey, name: rg.displayName(entry) });
                }
                collections.sort((a, b) => a.name.localeCompare(b.name));
                return { collections };
            });
            break;
        }
        case 'analyze': {
            const { oldCollectionKey, newCollectionKey } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                if (!modIndex.has(oldCollectionKey)) {
                    throw new Error(`Original collection not found in Vortex's current state (it may have been removed or reinstalled).`);
                }
                if (!modIndex.has(newCollectionKey)) {
                    throw new Error(`New collection not found in Vortex's current state (it may have been removed or reinstalled).`);
                }
                const analysis = rg.analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemory, stagingRoot);
                // "Already applied" filtering (2026-08-16) -- see filterMappingToPending's own header
                // comment (rules-generator.js) for the full rationale: analyzeCollections' own mapping
                // never checks whether a rule it's proposing to copy has already been written in an
                // earlier Apply run. Applied here too (not just computeReportData/the Report tab) so
                // the in-app Ready-to-copy UI's own per-mod rule breakdown -- expand any card and its
                // dropdowns -- reflects the mod's CURRENT state, not stale pre-Apply data.
                const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, {}, {}, anomalyMemory, stagingRoot);
                const { toWrite, skippedAlreadySet: rawSkips } = rg.computeApplyPlan(modIndex, toApply);
                const pendingTripleKeys = new Set(toWrite.map((t) => `${t.newModKey}::${t.type}::${t.targetModKey}`));
                // exceptions (2026-08-17) -- the live in-app tool's own Step 3 (Exceptions) needs
                // this too, not just the separate Report tab's own 'report' mode below. Reuses
                // computeSkipExceptions (factored out of computeReportData the same day) rather than
                // a second computation -- see its own header comment. Step 3 itself only ever
                // auto-navigates here after a real Apply (see apply-write's own freshExceptions,
                // below) -- this is so the step is populated/reachable even on a plain scan, e.g. the
                // director's own real repro where mismatches already existed in Vortex from an
                // earlier manual edit, independent of whether Apply gets clicked again this session.
                const exceptions = rg.computeSkipExceptions(modIndex, analysis, rawSkips);
                return { ...analysis, mapping: rg.filterMappingToPending(analysis.mapping, pendingTripleKeys), exceptions };
            });
            break;
        }
        // Completed/Exceptions report -- read-only, same withStateDb safe-copy path as 'analyze'.
        case 'report': {
            const { oldCollectionKey, newCollectionKey, anomalyOverrides } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                if (!modIndex.has(oldCollectionKey)) {
                    throw new Error(`Original collection not found in Vortex's current state (it may have been removed or reinstalled).`);
                }
                if (!modIndex.has(newCollectionKey)) {
                    throw new Error(`New collection not found in Vortex's current state (it may have been removed or reinstalled).`);
                }
                return rg.computeReportData(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, anomalyMemory, stagingRoot);
            });
            break;
        }
        // Read-only dry run, via the safe temp-copy path (withStateDb) -- same "preview before you
        // ever write" pairing Update Collection's own apply-ignores-preview already establishes.
        // Computes an accurate count for the confirm dialog without touching anything.
        case 'apply-preview': {
            const { oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                return await rg.applyRules(rg.makeLevelDbRuleIO(db), modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides, { dryRun: true, anomalyMemory, stagingRoot });
            });
            break;
        }
        // The real write -- opens Vortex's LIVE state.v2 directly. withLiveStateDb takes a full
        // backup first and refuses if Vortex is running or the backup is incomplete, same safety
        // net every other live write in this project already goes through.
        case 'apply-write': {
            const { oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides } = input;
            result = await syncLib.withLiveStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                // Automatic Cycle Helper snapshot, BEFORE the real write below -- this is a
                // VCT-driven write that touches mods' `rules` arrays, same reasoning as Update
                // Collection's own apply-ignores-write/apply-disables-write (state-write-worker.js).
                // Reuses this SAME modIndex (already built fresh from this live db) rather than a
                // second scan. See lib/cycle-helper-snapshot.js's captureFromLiveDb for the shared
                // logic (best-effort, never blocks this write).
                const chSnapshot = require('./cycle-helper-snapshot');
                await chSnapshot.captureFromLiveDb(db, modIndex, syncLib);
                const applyResult = await rg.applyRules(rg.makeLevelDbRuleIO(db), modIndex, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides, { dryRun: false, anomalyMemory, stagingRoot });
                // applyRules patches modIndex's own entry.rules in place as it writes (see its own
                // comment) -- re-analyzing on this SAME modIndex right here gives the route layer an
                // accurate "what does it look like now" result with ZERO risk of the WAL/compaction
                // staleness a second withStateDb read would carry (see vortex-sync/lib.js's own
                // "Staleness" comment on withLiveStateDb -- confirmed real and NOT just a brief
                // window, 2026-08-16). No second DB access at all -- pure in-memory recomputation.
                // Re-loaded fresh (not the request-start `anomalyMemory` above) so it reflects any
                // choice applyRules' own write path just persisted a moment ago.
                const freshAnalysis = rg.analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemoryStore.loadAnomalyChoices(), stagingRoot);
                // freshExceptions (2026-08-17) -- this is the primary trigger for Step 3 (Exceptions):
                // right after a real Apply, the live in-app tool checks THIS to decide whether to
                // auto-navigate to Step 3 or stay on Step 2 (see rgConfirmApply's own comment).
                // Zero extra DB reads, same in-memory-patched modIndex applyResult itself just wrote to.
                const { toApply: freshToApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, {}, {}, anomalyMemory, stagingRoot);
                const { skippedAlreadySet: freshRawSkips } = rg.computeApplyPlan(modIndex, freshToApply);
                const freshExceptions = rg.computeSkipExceptions(modIndex, freshAnalysis, freshRawSkips);
                return { ...applyResult, freshAnalysis, freshExceptions };
            });
            break;
        }
        // Read-only preview for the confirm dialog -- same withStateDb safe-copy pairing
        // apply-preview/apply-write already establish, so the "This clears N rule(s)..." confirm
        // text is always accurate before the real, consequential write below runs.
        case 'clear-skipped-preview': {
            const { oldCollectionKey, newCollectionKey, anomalyOverrides } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
                const { skippedAlreadySet } = rg.computeApplyPlan(modIndex, toApply);
                return {
                    totalRulesToClear: skippedAlreadySet.length,
                    // literalOwnerKey, NOT newModKey -- the reverse-discovered case (see
                    // computeApplyPlan's own comment) means the rule Clear actually touches can live
                    // on the OTHER mod's own array. Counting by newModKey here would understate the
                    // real blast radius of this confirm dialog's own "across M mod(s)" disclosure.
                    totalModsAffected: new Set(skippedAlreadySet.map((s) => s.literalOwnerKey)).size,
                };
            });
            break;
        }
        // Clears ONLY the specific rules the exception report identified as "skipped, already set
        // differently" -- director's own real-world root cause (see rules-generator.js's own
        // computeApplyPlan/clearSkippedRules header comments). The skip list is ALWAYS re-derived
        // fresh from THIS live db, never trusted from the client (same principle every other
        // DB-touching computation in this file already follows) -- anomalyOverrides is the only
        // input that affects which rules would even be attempted, same as 'report'/'apply-write'.
        case 'clear-skipped-write': {
            const { oldCollectionKey, newCollectionKey, anomalyOverrides } = input;
            result = await syncLib.withLiveStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const chSnapshot = require('./cycle-helper-snapshot');
                await chSnapshot.captureFromLiveDb(db, modIndex, syncLib);
                const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
                const { skippedAlreadySet } = rg.computeApplyPlan(modIndex, toApply);
                const clearResult = await rg.clearSkippedRules(rg.makeLevelDbRuleIO(db), modIndex, skippedAlreadySet);
                // Same "re-derive fresh from the SAME in-memory-patched modIndex, no second DB read"
                // pattern apply-write's own freshAnalysis already establishes -- see that mode's own
                // comment for the staleness rationale this avoids. freshReport (not just
                // freshAnalysis) so the Report tab can re-render its own Completed/Exceptions shape
                // immediately, confirming the just-cleared rules are gone from skippedAlreadySet,
                // without a second /report round-trip that could show stale pre-clear data.
                const freshReport = rg.computeReportData(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, anomalyMemory, stagingRoot);
                return { ...clearResult, freshReport };
            });
            break;
        }
        // Read-only preview for Step 3's confirm dialog (2026-08-17) -- both the per-mod "Save my
        // picks" and the bulk "Switch all" button share this same preview shape. switchModKeys:
        // array of newModKeys the user picked "Switch to match the old collection" for -- the server
        // re-derives the full skippedAlreadySet fresh and filters down to just these, never trusting
        // client-held skip details (same principle clear-skipped-preview already follows).
        case 'switch-skipped-preview': {
            const { oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
                const { skippedAlreadySet } = rg.computeApplyPlan(modIndex, toApply);
                const wanted = new Set(switchModKeys || []);
                const filtered = skippedAlreadySet.filter((s) => wanted.has(s.newModKey));
                return {
                    totalRulesToSwitch: filtered.length,
                    totalModsAffected: new Set(filtered.map((s) => s.newModKey)).size,
                };
            });
            break;
        }
        // Step 3's "Save my picks" / "Switch all" -- writes the old collection's intended rule for
        // ONLY the mods the user picked "Switch to match the old collection" for (see
        // switchSkippedRules' own header comment for why removal and addition can target different
        // mods). Same "always re-derive fresh, never trust the client" principle as
        // clear-skipped-write; switchModKeys is the only client-supplied selection.
        case 'switch-skipped-write': {
            const { oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys } = input;
            result = await syncLib.withLiveStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const chSnapshot = require('./cycle-helper-snapshot');
                await chSnapshot.captureFromLiveDb(db, modIndex, syncLib);
                const { toApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
                const { skippedAlreadySet } = rg.computeApplyPlan(modIndex, toApply);
                const wanted = new Set(switchModKeys || []);
                const filtered = skippedAlreadySet.filter((s) => wanted.has(s.newModKey));
                const switchResult = await rg.switchSkippedRules(rg.makeLevelDbRuleIO(db), modIndex, filtered);
                // Same "re-derive fresh from the SAME in-memory-patched modIndex, no second DB read"
                // pattern apply-write/clear-skipped-write already establish.
                const freshAnalysis = rg.analyzeCollections(modIndex, oldCollectionKey, newCollectionKey, anomalyMemoryStore.loadAnomalyChoices(), stagingRoot);
                const { toApply: freshToApply } = rg.computeRulesToApply(modIndex, oldCollectionKey, newCollectionKey, {}, anomalyOverrides || {}, {}, anomalyMemory, stagingRoot);
                const { skippedAlreadySet: freshRawSkips } = rg.computeApplyPlan(modIndex, freshToApply);
                const freshExceptions = rg.computeSkipExceptions(modIndex, freshAnalysis, freshRawSkips);
                return { ...switchResult, freshExceptions };
            });
            break;
        }
        default:
            throw new Error(`Unknown mode: ${mode}`);
    }

    process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
    process.stderr.write(e.message || String(e));
    process.exit(1);
});
