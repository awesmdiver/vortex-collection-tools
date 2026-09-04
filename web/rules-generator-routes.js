'use strict';
// Thin Express handlers for the Rules Generator flow -- all real logic lives in
// lib/rules-generator.js (matching + applyRules) and lib/rules-generator-runner.js (DB access,
// isolated worker). See TECHNICAL.md's "Rules Generator" section.

const express = require('express');
const syncLib = require('../lib/vortex-sync/lib');
const syncRunner = require('../lib/sync-runner');
const rgRunner = require('../lib/rules-generator-runner');
const rgLib = require('../lib/rules-generator');
const helperClient = require('../lib/vortex-helper-client');
const { createSseSession } = require('./sse-session');

// Real SSE-streamed progress for Analyze and Apply to Vortex (2026-08-25, closes
// docs/UI-PATTERN-MAP.md's "Rules Generator — Analyze"/"Apply to Vortex" findings: static text, no
// SSE, on an action that writes to potentially many mods). Both are a single opaque
// helperClient/isolated-worker call under the hood -- rgRunner.analyze(ViaHelper)/apply(ViaHelper)
// has no internal per-item hook to report through (unlike Clear Update Flags' own real per-mod
// for-loop), so there's no honest numeric count to show mid-flight. Rather than fake one, this
// streams real phase text plus a live elapsed-time tick every second while the real call is
// genuinely in flight -- the same "prove it's still alive, not frozen" technique PGPatcher's own
// live elapsed timer already uses in this app, just without a percentage. tickingPhase() is shared
// by both routes below rather than duplicated.
function tickingPhase(emit, phase, message) {
    let seconds = 0;
    emit({ type: 'phase', phase, message, seconds });
    const timer = setInterval(() => {
        seconds += 1;
        emit({ type: 'phase', phase, message, seconds });
    }, 1000);
    return () => clearInterval(timer);
}

function createRulesGeneratorRouter(config) {
    const router = express.Router();
    const { staging, state } = config;

    function vortexRunningGate(res) {
        if (syncLib.isVortexRunning()) {
            res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
            return true;
        }
        return false;
    }

    // Original (old) collections: real installs with a collection.json -- same fast,
    // filesystem-only listing Update Collection's own picker already uses, no Vortex-closed
    // dependency for this half.
    router.get('/collections', (req, res) => {
        if (!staging) return res.json({ collections: [], configured: false });
        try {
            res.json({ collections: syncRunner.listInstalledCollections(staging) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // New collections: every Workshop-tracked collection Vortex knows about, straight from its
    // live state. Deduped against the "old" list above (queue:
    // rules-generator-workshop-collection-dedup) -- scanStagingCollections (vortex-sync/lib.js) was
    // relaxed in 3427f35 to include a Workshop-named folder once it has real on-disk content, so a
    // Workshop collection can now legitimately appear in BOTH lists (it's both "old" and "new" at
    // once, which makes no sense in a picker whose whole point is comparing two DIFFERENT
    // collections). A collection that already has real content and shows up as "old" doesn't need
    // to also show as a raw Workshop option here -- the dedup runs one way only, old wins. Reuses
    // listInstalledCollections directly (cheap, filesystem-only, no extra Vortex dependency --
    // independent of whichever source below answered) rather than threading stagingDir through the
    // isolated worker just to duplicate that same read in-process.
    //
    // Opportunistic helper-extension path (2026-08-18, Tier 2 of "remove the Vortex-must-be-closed
    // requirement" -- this is the front door Tier 1's own write routes were stuck behind: this route
    // fires on every Rules Generator page load, so leaving it gated meant the picker itself never
    // populated with Vortex open, no matter how capable the write routes downstream had become).
    // Same pattern as every other route in this file: checked BEFORE vortexRunningGate, falls
    // through to the exact original gated path, untouched, when the helper isn't reachable.
    router.get('/workshop-collections', async (req, res) => {
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable ? await rgRunner.listWorkshopCollectionsViaHelper() : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                result = { collections: await rgRunner.listWorkshopCollections(state) };
            }
            let { collections } = result;
            if (staging) {
                let alreadyListedIds;
                try {
                    alreadyListedIds = new Set(syncRunner.listInstalledCollections(staging).map((c) => c.modId));
                } catch {
                    alreadyListedIds = new Set(); // staging unreadable -- fail open, no dedup rather than a 500 here
                }
                collections = collections.filter((c) => !alreadyListedIds.has(c.modKey));
            }
            res.json({ collections, source });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Vortex's own "N conflicting file(s)" indicator, mirrored -- pure filesystem comparison of two
    // mods' staging folders, no LevelDB involved, so this does NOT go through the isolated worker
    // and does NOT need vortexRunningGate (reading files on disk is safe with Vortex open; only its
    // own DB is the crash-risk resource). installationPathA/B come from analyze()'s own
    // installationPaths lookup so the frontend never has to touch the DB again for this.
    router.get('/conflicts', (req, res) => {
        if (!staging) return res.json({ files: [], configured: false });
        const { a, b } = req.query;
        if (!a || !b) return res.status(400).json({ error: 'Query params a and b (installationPath) are both required.' });
        try {
            const files = rgLib.computeConflictingFiles(staging, a, b);
            res.json({ files });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Step 1: Relationship Check candidates are computed HERE, not inside the isolated DB worker --
    // same reasoning as /conflicts below: computeRelationshipCandidates does real filesystem work
    // (computeConflictingFiles), which never touches Vortex's DB and so never needs worker-process
    // isolation, but DOES need config.staging, which only this route layer has. Bundled into the
    // SAME /analyze response (not a second round-trip) so the new Step 1 screen has everything it
    // needs the moment "Find matching rules" resolves, no extra loading state required.
    //
    // Opportunistic helper-extension path (2026-08-18, Tier 2) -- same pattern as /workshop-collections
    // above: checked before vortexRunningGate, falls through to the exact original gated path when
    // the helper isn't reachable.
    const analyzeSession = createSseSession();

    router.get('/analyze/events', (req, res) => {
        if (!analyzeSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        analyzeSession.subscribe(res, { afterSeq });
    });

    router.post('/analyze', async (req, res) => {
        const { oldCollectionKey, newCollectionKey } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        if (analyzeSession.isActive()) {
            return res.status(409).json({ error: 'An analysis is already in progress.' });
        }
        // vortexRunningGate only applies to the state.v2 fallback path, and that path is only known
        // once the (fast) helper-availability check below resolves -- checked inside the background
        // task, same as every other route here, rather than duplicated up front.
        const mySession = analyzeSession.start({ id: `rg-analyze-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (analyzeSession.get() === mySession) analyzeSession.emit(event);
        };

        (async () => {
            const stopTicking = tickingPhase(emitIfCurrent, 'analyzing', 'Comparing your two collections…');
            try {
                const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
                let result = helperAvailable ? await rgRunner.analyzeViaHelper(oldCollectionKey, newCollectionKey) : null;
                let source = 'helper-extension';
                if (!result) {
                    source = 'state.v2';
                    if (syncLib.isVortexRunning()) {
                        stopTicking();
                        emitIfCurrent({
                            type: 'error', done: true, error: true, errorCode: 'vortex-running',
                            message: 'Vortex is currently running. Close it completely and try again.',
                        });
                        return;
                    }
                    result = await rgRunner.analyze(state, oldCollectionKey, newCollectionKey);
                }
                stopTicking();
                // computeRelationshipCandidates handles a missing staging root internally (the
                // noLinkFound/file-conflict half needs it, the incompleteLinks half doesn't) -- always
                // called, never gated on `staging` here.
                const relationshipCandidates = rgLib.computeRelationshipCandidates(result, staging);
                emitIfCurrent({ type: 'done', done: true, ...result, relationshipCandidates, source });
            } catch (e) {
                stopTicking();
                emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
            }
        })();
    });

    // Completed/Exceptions report -- read-only, same shape/gate as /analyze, including the same
    // opportunistic helper-extension path (2026-08-18, Tier 2).
    router.post('/report', async (req, res) => {
        const { oldCollectionKey, newCollectionKey, anomalyOverrides } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable ? await rgRunner.reportViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides) : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                result = await rgRunner.report(state, oldCollectionKey, newCollectionKey, anomalyOverrides);
            }
            res.json({ ...result, source });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Read-only dry run -- an accurate rule/mod count for the confirm dialog, no writes. Always
    // called fresh right before showing that dialog, never trusting a client-held count.
    //
    // Opportunistic helper-extension path (2026-08-18, Tier 1 of "remove the Vortex-must-be-closed
    // requirement" -- same treatment Cycle Helper's own routes already got): checked BEFORE
    // vortexRunningGate, source data from the optional Vortex Collection Helper extension when it's
    // reachable, fall through to the exact original gated/backed-up state.v2 path, untouched, when
    // it's not (or its own /mods read fails for any reason even after /health answered).
    router.post('/apply-preview', async (req, res) => {
        const { oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable
                ? await rgRunner.applyPreviewViaHelper(oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides)
                : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                result = await rgRunner.applyPreview(state, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides);
            }
            res.json({ ...result, source });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // The real write -- opens Vortex's LIVE state.v2 directly (full backup taken first, refuses if
    // Vortex is running). Same params as /apply-preview. Same opportunistic helper-extension path as
    // above -- see its own comment. Real SSE-streamed progress (2026-08-25) -- same ticking-phase
    // shape as /analyze above, same reasoning (a single opaque write call, writes to potentially many
    // mods, no per-item hook to report through).
    const applySession = createSseSession();

    router.get('/apply/events', (req, res) => {
        if (!applySession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        applySession.subscribe(res, { afterSeq });
    });

    router.post('/apply', async (req, res) => {
        const { oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        if (applySession.isActive()) {
            return res.status(409).json({ error: 'An apply is already in progress.' });
        }
        const mySession = applySession.start({ id: `rg-apply-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (applySession.get() === mySession) applySession.emit(event);
        };

        (async () => {
            const stopTicking = tickingPhase(emitIfCurrent, 'applying', 'Writing rules to Vortex…');
            try {
                const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
                let result = helperAvailable
                    ? await rgRunner.applyViaHelper(oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides)
                    : null;
                let source = 'helper-extension';
                if (!result) {
                    source = 'state.v2';
                    if (syncLib.isVortexRunning()) {
                        stopTicking();
                        emitIfCurrent({
                            type: 'error', done: true, error: true, errorCode: 'vortex-running',
                            message: 'Vortex is currently running. Close it completely and try again.',
                        });
                        return;
                    }
                    result = await rgRunner.apply(state, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides, relationshipOverrides);
                }
                stopTicking();
                // freshAnalysis/freshExceptions (rules-generator-worker.js's own apply-write mode, or
                // its helper-backed equivalent) are computed from the SAME in-memory modIndex the
                // write itself just patched -- zero staleness risk, no second read.
                // relationshipCandidates still needs computing here (filesystem work, same reasoning
                // as /analyze), fed this fresh, just-written analysis rather than a possibly-stale
                // one. freshExceptions passes through untouched -- Step 3 (Exceptions)'s own trigger,
                // see rgConfirmApply's own comment.
                const { freshAnalysis, freshExceptions, ...writeSummary } = result;
                const relationshipCandidates = freshAnalysis ? rgLib.computeRelationshipCandidates(freshAnalysis, staging) : undefined;
                emitIfCurrent({
                    type: 'done', done: true, ...writeSummary, source,
                    freshAnalysis: freshAnalysis ? { ...freshAnalysis, relationshipCandidates } : undefined,
                    freshExceptions,
                });
            } catch (e) {
                stopTicking();
                emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
            }
        })();
    });

    // Exception report's "Clear all rules" -- read-only dry run for the confirm dialog. Same
    // gate/shape as /apply-preview, including the same opportunistic helper-extension path.
    router.post('/clear-skipped-preview', async (req, res) => {
        const { oldCollectionKey, newCollectionKey, anomalyOverrides } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable
                ? await rgRunner.clearSkippedPreviewViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides)
                : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                result = await rgRunner.clearSkippedPreview(state, oldCollectionKey, newCollectionKey, anomalyOverrides);
            }
            res.json({ ...result, source });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // The real clear -- opens Vortex's LIVE state.v2 directly (full backup taken first, refuses if
    // Vortex is running). Removes ONLY the specific rules the exception report identified (see
    // lib/rules-generator.js's clearSkippedRules), never anything else on those mods. Same
    // opportunistic helper-extension path as /apply above.
    router.post('/clear-skipped', async (req, res) => {
        const { oldCollectionKey, newCollectionKey, anomalyOverrides } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable
                ? await rgRunner.clearSkippedViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides)
                : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                result = await rgRunner.clearSkipped(state, oldCollectionKey, newCollectionKey, anomalyOverrides);
            }
            res.json({ ...result, source });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Step 3 (Exceptions)'s "switch to match the old collection" -- read-only dry run for the
    // confirm dialog. switchModKeys: array of newModKeys the user picked "Switch" for (per-mod picks
    // via "Save my picks", or every currently-known skip's modKey for the bulk "Switch all" button).
    // Same opportunistic helper-extension path as /apply-preview above.
    router.post('/switch-skipped-preview', async (req, res) => {
        const { oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable
                ? await rgRunner.switchSkippedPreviewViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys)
                : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                result = await rgRunner.switchSkippedPreview(state, oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys);
            }
            res.json({ ...result, source });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // The real switch -- opens Vortex's LIVE state.v2 directly (full backup taken first, refuses if
    // Vortex is running). Removes the conflicting literal rule AND writes the old collection's
    // intended rule in its place, for ONLY the mods in switchModKeys (see
    // lib/rules-generator.js's switchSkippedRules). Same opportunistic helper-extension path as
    // /apply above.
    router.post('/switch-skipped', async (req, res) => {
        const { oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let result = helperAvailable
                ? await rgRunner.switchSkippedViaHelper(oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys)
                : null;
            let source = 'helper-extension';
            if (!result) {
                source = 'state.v2';
                if (vortexRunningGate(res)) return;
                result = await rgRunner.switchSkipped(state, oldCollectionKey, newCollectionKey, anomalyOverrides, switchModKeys);
            }
            res.json({ ...result, source });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createRulesGeneratorRouter };
