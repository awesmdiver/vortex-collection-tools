'use strict';
// Thin Express handlers for Cycle Helper -- all real logic lives in lib/cycle-detector.js (the
// graph algorithm + fix-application), lib/cycle-helper-snapshot.js (the local snapshot file), and
// lib/cycle-helper-runner.js (DB access, isolated worker). See TECHNICAL.md's "Cycle Helper"
// section, and docs/plans/2026-08-16-cycle-helper-research.md for the full design rationale.

const express = require('express');
const syncLib = require('../lib/vortex-sync/lib');
const chRunner = require('../lib/cycle-helper-runner');
const chSnapshot = require('../lib/cycle-helper-snapshot');
const chHistory = require('../lib/cycle-helper-history');
const helperClient = require('../lib/vortex-helper-client');

function createCycleHelperRouter(config) {
    const router = express.Router();
    const { state } = config;

    function vortexRunningGate(res) {
        if (syncLib.isVortexRunning()) {
            res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
            return true;
        }
        return false;
    }

    // Step 0 -- lightweight, on-demand snapshot of every enabled mod's current rules. NOT a full
    // state.v2 backup (that's Apply's own job, taken automatically right before it writes anything).
    //
    // Opportunistic helper-extension path (2026-08-18, director's own ask): when the Vortex
    // Collection Helper extension is reachable, this reads live via `chRunner.snapshotViaHelper`
    // INSTEAD of gating on Vortex being closed at all -- the whole point is letting this work with
    // Vortex still open. Checked BEFORE `vortexRunningGate`, which would otherwise refuse the
    // request outright the instant Vortex is running. Falls through to the exact original
    // state.v2 path, untouched, whenever the helper isn't reachable OR its own read fails for any
    // reason even after /health answered.
    router.post('/snapshot', async (req, res) => {
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            if (helperAvailable) {
                const liveRulesByModKey = await chRunner.snapshotViaHelper();
                if (liveRulesByModKey) {
                    const saved = chSnapshot.saveSnapshot(liveRulesByModKey);
                    return res.json({ createdAt: saved.createdAt, source: 'helper-extension' });
                }
            }
            if (vortexRunningGate(res)) return;
            const rulesByModKey = await chRunner.snapshot(state);
            const saved = chSnapshot.saveSnapshot(rulesByModKey);
            res.json({ createdAt: saved.createdAt, source: 'state.v2' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Pure local-file read -- no Vortex/DB dependency, safe to call any time (used to render the
    // Step-0 status bar on page load).
    router.get('/snapshot-status', (req, res) => {
        res.json(chSnapshot.getSnapshotStatus());
    });

    // Step 2 -- scans Vortex's CURRENT live state for rule cycles, ranking candidate rules by how
    // likely each is the actual cause. Reuses the prior snapshot (if any) as the strongest ranking
    // signal -- see lib/cycle-detector.js's analyzeCycles for the full ranking rationale.
    //
    // Same opportunistic helper-extension path as /snapshot above -- checked before
    // vortexRunningGate so a real Scan can run with Vortex still open when the helper answers,
    // falling through to the exact original state.v2 path, untouched, otherwise.
    router.post('/scan', async (req, res) => {
        try {
            const { rulesByModKey: snapshotRulesByModKey } = chSnapshot.loadSnapshot();
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            if (helperAvailable) {
                const liveResult = await chRunner.scanViaHelper(snapshotRulesByModKey);
                if (liveResult) return res.json({ ...liveResult, source: 'helper-extension' });
            }
            if (vortexRunningGate(res)) return;
            const result = await chRunner.scan(state, snapshotRulesByModKey);
            res.json({ ...result, source: 'state.v2' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Best-effort ONLY -- self-contained (re-reads Vortex's live state.v2 fresh every call), so the
    // frontend calls this both on landing on Cycle Helper's own first screen AND in parallel with
    // /scan, not only after /scan already succeeded (2026-08-18 -- see cycle-helper-app.js). Never
    // throws a real error to the client (see chRunner.checkScanFreshness's own comment): worst case
    // is { checked: false }, which the UI just treats as "no freshness warning to show," not a
    // failure. No vortexRunningGate -- if Vortex is open when this runs, the underlying read just
    // fails and checkScanFreshness swallows it the same as any other error (same reasoning as
    // Update Collection's own /backup/check-freshness route).
    router.post('/scan/check-freshness', async (req, res) => {
        const result = await chRunner.checkScanFreshness(state);
        res.json(result);
    });

    // Step 4 -- the real write. Opens Vortex's LIVE state.v2 directly (full backup taken first,
    // refuses if Vortex is running). ownerModKey/ruleType/targetModKey/action must all be exactly
    // what the most recent /scan returned for the chosen candidate -- never trusted from anywhere
    // else, same principle every other live write in this app already follows.
    //
    // Change History (2026-08-18): historySessionId, if the client has one already, is the CURRENT
    // in-progress session (everything since the last Scan click -- see cycle-helper-app.js's own
    // chScan, which clears it) -- omitted/falsy for this session's FIRST fix. chHistory.logFix
    // starts a new session when it's falsy, else appends; either way it returns the session's own
    // (possibly new) id, handed back to the client so the NEXT fix in this same session logs to the
    // same file. This route is the one that actually writes the log entry -- the worker (chRunner/
    // cycle-helper-worker.js) never touches project-local files, same separation of concerns
    // 'snapshot' already keeps.
    // Opportunistic helper-extension write path (2026-08-18, direct follow-up to Snapshot/Scan
    // above, now that the extension has a confirmed-working write endpoint): checked BEFORE
    // vortexRunningGate, same pattern as Snapshot/Scan. When the helper answers, this writes through
    // its real Redux dispatch (POST /rules/apply) instead of state.v2 -- see lib/cycle-helper-
    // runner.js's applyFixViaHelper and TECHNICAL.md's "Safety model" write-up for why that's safe
    // WITHOUT the usual backupLiveState step. `result` stays null only when the helper's own /mods
    // read fails (the "helper unavailable" signal) -- a genuine failure from the write itself
    // (applyCandidateFix rejecting a stale/missing rule) throws and is surfaced as a real error
    // below, never silently retried through state.v2.
    router.post('/apply-fix', async (req, res) => {
        const { ownerModKey, ruleType, targetModKey, action, historySessionId } = req.body || {};
        if (!ownerModKey || !ruleType || !targetModKey || !action) {
            return res.status(400).json({ error: 'ownerModKey, ruleType, targetModKey, and action are all required.' });
        }
        if (action !== 'remove' && action !== 'flip') {
            return res.status(400).json({ error: 'action must be "remove" or "flip".' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable
                ? await chRunner.applyFixViaHelper(ownerModKey, ruleType, targetModKey, action)
                : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                const { rulesByModKey } = chSnapshot.loadSnapshot();
                result = await chRunner.applyFix(state, ownerModKey, ruleType, targetModKey, action, rulesByModKey);
            }
            result.source = source;

            const fixLogEntry = {
                ownerModKey: result.ownerModKey,
                ownerName: result.ownerName,
                targetModKey: result.targetModKey,
                targetName: result.targetName,
                action: result.action,
                resolvedCycle: result.resolvedCycle,
            };
            if (result.action === 'flip') {
                fixLogEntry.originalType = result.originalType;
                fixLogEntry.newType = result.newType;
            } else {
                fixLogEntry.originalRule = result.originalRule;
            }
            const session = chHistory.logFix(historySessionId, fixLogEntry);
            result.historySessionId = session.sessionId;

            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Change History -- every saved session, newest first, full fix details included (see
    // lib/cycle-helper-history.js's own listSessions comment for why there's no separate
    // per-session detail route). Pure local-file read, same "no Vortex/DB dependency" posture as
    // /snapshot-status.
    router.get('/history', (req, res) => {
        res.json({ sessions: chHistory.listSessions() });
    });

    // Reverts one or more previously-logged fixes back to their ORIGINAL value -- shared by both
    // revert locations (inline "This session so far" and the separate Change History page): the
    // client just hands this whichever fix records it already has in hand (a subset of the current
    // session's own just-applied fixes, or a subset of a past session loaded via /history), no
    // difference in handling either way. Opens Vortex's LIVE state.v2 ONCE for the whole batch (see
    // cycle-helper-worker.js's own 'revert-fixes' mode) -- a stale row (see cd.revertFix's own
    // guard) is reported per-row in `failed`, never aborts the rest of the batch.
    // Same opportunistic helper-extension path as apply-fix above -- checked before
    // vortexRunningGate. Per-fix staleness failures are already caught INSIDE
    // chRunner.revertFixesViaHelper (reported in `failed`, same as the state.v2 path), so `result`
    // only stays null here when the helper's own /mods read fails outright, in which case this falls
    // through to the exact original gated/backed-up path, untouched.
    router.post('/history/revert', async (req, res) => {
        const { fixes } = req.body || {};
        if (!Array.isArray(fixes) || fixes.length === 0) {
            return res.status(400).json({ error: 'No fixes to revert were provided.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable ? await chRunner.revertFixesViaHelper(fixes) : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                result = await chRunner.revertFixes(state, fixes);
            }
            result.source = source;
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createCycleHelperRouter };
