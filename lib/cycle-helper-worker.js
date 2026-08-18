#!/usr/bin/env node
// Isolated child process for Cycle Helper's DB reads/writes -- same native-LevelDB-crash rationale
// as lib/rules-generator-worker.js/state-query-worker.js (see their own header comments): a
// long-running web server process must never call withStateDb/withLiveStateDb in-process. Mirrors
// rules-generator-worker.js's mode-dispatched protocol exactly.
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

// modKeys enabled in Vortex's CURRENT active profile for this game -- shared by 'snapshot', 'scan',
// and 'scan-freshness-check' below (all three need exactly the same scoping: see
// syncLib.getEnabledModKeys' own header comment for why this must match Vortex's real sortMods
// scoping exactly).
async function getScopedModKeys(syncLib, db) {
    const profileId = await syncLib.getLastActiveProfileId(db);
    if (!profileId) {
        throw new Error(
            "Could not determine Vortex's active profile for this game. Open Vortex once, make sure " +
            'a profile is selected, close it, then try again.'
        );
    }
    return syncLib.getEnabledModKeys(db, profileId);
}

// {modKey: rules[]} for every mod enabled right now -- the exact same shape/scoping 'snapshot'
// captures, factored out so 'scan-freshness-check' below can run the identical capture through two
// different db handles (safe vs WAL-included) without drifting from 'snapshot's own logic.
async function captureRulesByModKey(syncLib, rg, db) {
    const modIndex = await rg.buildModIndex(db);
    const enabledModKeys = await getScopedModKeys(syncLib, db);
    const rulesByModKey = {};
    for (const modKey of enabledModKeys) {
        rulesByModKey[modKey] = modIndex.get(modKey)?.rules || [];
    }
    return rulesByModKey;
}

// Extracted to lib/cycle-helper-shape.js (2026-08-18) so lib/cycle-helper-runner.js's live-helper
// path (no state.v2 involved at all) can produce an IDENTICALLY-shaped result from a differently-
// sourced modIndex, without duplicating this logic.
const { shapeCycleResult } = require('./cycle-helper-shape');

async function main() {
    const input = JSON.parse(await readStdin());
    const { stateDir, mode } = input;
    const syncLib = require('./vortex-sync/lib');
    const rg = require('./rules-generator');
    const cd = require('./cycle-detector');
    const helperClient = require('./vortex-helper-client');

    let result;
    switch (mode) {
        // Read-only -- captures {modKey: rules[]} for every mod enabled right now, so a LATER scan
        // can tell "this exact rule wasn't there (or was different) last time you checked" (the
        // strongest ranking signal analyzeCycles has -- see cycle-detector.js). The caller
        // (web/cycle-helper-routes.js) persists the returned rulesByModKey to disk itself
        // (lib/cycle-helper-snapshot.js) -- this worker only ever reads Vortex's state, never a
        // local project file, same separation of concerns rules-generator-worker.js already keeps.
        case 'snapshot': {
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const rulesByModKey = await captureRulesByModKey(syncLib, rg, db);
                return { rulesByModKey };
            });
            break;
        }
        // Read-only, via the safe temp-copy path (withStateDb). snapshotRulesByModKey (optional) is
        // the PRIOR snapshot's rulesByModKey, already loaded from disk by the caller -- this worker
        // never touches that file itself.
        case 'scan': {
            const { snapshotRulesByModKey } = input;
            result = await syncLib.withStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const enabledModKeys = await getScopedModKeys(syncLib, db);
                const analysis = cd.analyzeCycles(modIndex, enabledModKeys, snapshotRulesByModKey || null);
                return shapeCycleResult(rg, modIndex, analysis);
            });
            break;
        }
        // Follow-up freshness check ONLY -- never used for Scan's own displayed/ranked result (a
        // SEPARATE, earlier 'scan' call, in its OWN worker process, already returned that). Same
        // pattern as lib/state-write-worker.js's 'backup-capture-freshness-check': re-reads the same
        // data two ways (safe copy, then WAL-included) and diffs it, all inside ONE isolated worker
        // process so this bonus check never doubles the number of child processes a single Scan
        // click spawns. Confirmed live 2026-08-16 (real director bug report): a small rule edit made
        // directly in Vortex's own UI, then closed, can still be sitting only in state.v2's *.log
        // WAL when the user runs Scan right after -- withStateDb's safe copy deliberately never
        // copies that WAL (see vortex-sync/lib.js's own copyStateDb/withStateDbIncludingWal
        // comments: copying/replaying a live WAL is a documented native-crash risk), so Scan can
        // silently show OLD rule data with no indication anything was missed. Diffs ALL enabled
        // mods' rules (not just the ones already in a shown cycle) -- the real cost here is the
        // second full-directory copy+open WAL-included read demands, not the per-mod key count, so
        // scoping down wouldn't meaningfully cut cost; this tool's own tangles run dozens of mods,
        // not thousands, so a full diff is cheap regardless.
        case 'scan-freshness-check': {
            const captureOnce = (db) => captureRulesByModKey(syncLib, rg, db);
            const safe = await syncLib.withStateDb(stateDir, captureOnce);

            // Optional, opportunistic helper-extension path (2026-08-18, lib/vortex-helper-client.js
            // -- see its own header comment and the companion vortex-collection-helper project's
            // README.md/TECHNICAL.md for the full story). When the helper is running, its reads come
            // straight from Vortex's own LIVE in-memory state -- no WAL involved at all, so there's
            // nothing to "include" and no diffing-two-copies dance needed: just compare the safe
            // copy's own already-read rules against what the helper reports live right now, per mod.
            // checkHelperAvailable has a short timeout and never throws, so this adds negligible cost
            // for the (currently overwhelming majority of) users who don't have the helper installed
            // -- one quick failed health check, then straight through to the untouched fallback below.
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let diffCount = 0;
            let source;
            if (helperAvailable) {
                source = 'helper-extension';
                const modKeys = Object.keys(safe);
                const liveResults = await Promise.all(modKeys.map((modKey) => helperClient.getLiveRulesForMod(modKey)));
                modKeys.forEach((modKey, i) => {
                    const liveRules = liveResults[i];
                    // null means the helper couldn't answer for THIS mod specifically (not found in
                    // live state, a transient per-mod failure) -- "can't confirm freshness for this
                    // one" is not the same claim as "definitely stale", so it's skipped rather than
                    // counted; only a REAL rules mismatch increments diffCount.
                    if (liveRules === null) return;
                    if (JSON.stringify(safe[modKey] || []) !== JSON.stringify(liveRules)) diffCount += 1;
                });
            } else {
                // Fallback -- EXACTLY the original logic, untouched: re-reads the same data via
                // withStateDbIncludingWal and diffs it against the safe copy above. See this case's
                // own original comment (still applies verbatim here) for why this exists and its own
                // documented native-crash-risk tradeoff.
                source = 'wal-diff';
                const walIncluded = await syncLib.withStateDbIncludingWal(stateDir, captureOnce);
                const allKeys = new Set([...Object.keys(safe), ...Object.keys(walIncluded)]);
                for (const key of allKeys) {
                    if (JSON.stringify(safe[key] || []) !== JSON.stringify(walIncluded[key] || [])) diffCount += 1;
                }
            }
            result = { stale: diffCount > 0, diffCount, source };
            break;
        }
        // The real write -- opens Vortex's LIVE state.v2 directly. withLiveStateDb takes a full
        // backup first and refuses if Vortex is running or the backup is incomplete, same safety
        // net every other live write in this project already goes through. ownerModKey/ruleType/
        // targetModKey identify the exact rule to touch -- always the values THIS SAME scan just
        // returned for the chosen candidate, never re-derived or trusted from anywhere else.
        case 'apply-fix': {
            const { ownerModKey, ruleType, targetModKey, action, snapshotRulesByModKey } = input;
            result = await syncLib.withLiveStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const fixResult = await cd.applyCandidateFix(cd.makeLevelDbRuleIO(db), modIndex, ownerModKey, ruleType, targetModKey, action);
                // Validate (Step 5) re-derives fresh, POST-write state from this SAME still-open live
                // handle -- never a separate later withStateDb copy. Confirmed live 2026-08-16: a
                // write via this handle can still be sitting only in state.v2's *.log WAL when this
                // callback returns (LevelDB doesn't compact on every close), and withStateDb's copy
                // deliberately never copies that WAL (copying/replaying a live WAL is a documented
                // native-crash risk -- see vortex-sync/lib.js's own copyStateDb comment) -- so a
                // fresh copy-based read right after this write would silently show the OLD, pre-fix
                // state and report "still cycling" even though the fix genuinely took. Reading
                // through the SAME handle that just wrote sidesteps the WAL/compaction question
                // entirely: LevelDB always checks its own in-memory memtable first, so a handle sees
                // its own writes immediately regardless of whether they've been flushed to a durable
                // SST file yet.
                const postModIndex = await rg.buildModIndex(db);
                const enabledModKeys = await getScopedModKeys(syncLib, db);
                const analysis = cd.analyzeCycles(postModIndex, enabledModKeys, snapshotRulesByModKey || null);
                const validation = shapeCycleResult(rg, postModIndex, analysis);
                // Change History (2026-08-18, lib/cycle-helper-history.js) -- display names and the
                // flip's before/after pair are resolved HERE, off the same post-write modIndex every
                // other display name in this file already comes from, never trusted from the client
                // (same "always render displayName(), never a raw modKey" rule shapeCycleResult
                // itself follows). resolvedCycle rides on the SAME re-scan Validate already needed --
                // no extra DB read for it. web/cycle-helper-routes.js's own /apply-fix handler is the
                // one that actually persists this to a session file (this worker never touches
                // project-local files, same separation of concerns as 'snapshot' above).
                return {
                    ...fixResult,
                    targetModKey,
                    ownerName: rg.displayName(postModIndex.get(ownerModKey)),
                    targetName: rg.displayName(postModIndex.get(targetModKey)),
                    originalType: action === 'flip' ? ruleType : undefined,
                    newType: action === 'flip' ? rg.invertType(ruleType) : undefined,
                    resolvedCycle: !validation.hasCycles,
                    validation,
                };
            });
            break;
        }
        // Reverts a batch of previously-applied fixes in ONE live-state open (one backup, one
        // Vortex-closed gate, not one per row) -- see cd.revertFix's own header comment for the
        // stale-revert guard each row goes through. Partial success is expected and fine: a stale row
        // must never block reverting the others in the same batch (2026-08-17 plan doc's own
        // instruction), so each fix is tried independently and its own failure caught individually
        // rather than letting one throw abort the whole loop.
        case 'revert-fixes': {
            const { fixes } = input;
            result = await syncLib.withLiveStateDb(stateDir, async (db) => {
                const modIndex = await rg.buildModIndex(db);
                const ruleIO = cd.makeLevelDbRuleIO(db);
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
