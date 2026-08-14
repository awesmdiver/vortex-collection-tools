'use strict';
// Thin Express handlers for the Rules Generator flow -- all real logic lives in
// lib/rules-generator.js (matching + applyRules) and lib/rules-generator-runner.js (DB access,
// isolated worker). See TECHNICAL.md's "Rules Generator" section.

const express = require('express');
const syncLib = require('../lib/vortex-sync/lib');
const syncRunner = require('../lib/sync-runner');
const rgRunner = require('../lib/rules-generator-runner');
const rgLib = require('../lib/rules-generator');

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
    // live state -- Vortex must be closed. Deduped against the "old" list above (queue:
    // rules-generator-workshop-collection-dedup) -- scanStagingCollections (vortex-sync/lib.js) was
    // relaxed in 3427f35 to include a Workshop-named folder once it has real on-disk content, so a
    // Workshop collection can now legitimately appear in BOTH lists (it's both "old" and "new" at
    // once, which makes no sense in a picker whose whole point is comparing two DIFFERENT
    // collections). A collection that already has real content and shows up as "old" doesn't need
    // to also show as a raw Workshop option here -- the dedup runs one way only, old wins. Reuses
    // listInstalledCollections directly (cheap, filesystem-only, no extra Vortex dependency --
    // Vortex is already confirmed closed above for this route regardless) rather than threading
    // stagingDir through the isolated worker just to duplicate that same read in-process.
    router.get('/workshop-collections', async (req, res) => {
        if (vortexRunningGate(res)) return;
        try {
            const collections = await rgRunner.listWorkshopCollections(state);
            if (staging) {
                let alreadyListedIds;
                try {
                    alreadyListedIds = new Set(syncRunner.listInstalledCollections(staging).map((c) => c.modId));
                } catch {
                    alreadyListedIds = new Set(); // staging unreadable -- fail open, no dedup rather than a 500 here
                }
                res.json({ collections: collections.filter((c) => !alreadyListedIds.has(c.modKey)) });
                return;
            }
            res.json({ collections });
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

    router.post('/analyze', async (req, res) => {
        if (vortexRunningGate(res)) return;
        const { oldCollectionKey, newCollectionKey } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const result = await rgRunner.analyze(state, oldCollectionKey, newCollectionKey);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Completed/Exceptions report -- read-only, same shape/gate as /analyze.
    router.post('/report', async (req, res) => {
        if (vortexRunningGate(res)) return;
        const { oldCollectionKey, newCollectionKey, anomalyOverrides } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const result = await rgRunner.report(state, oldCollectionKey, newCollectionKey, anomalyOverrides);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Read-only dry run -- an accurate rule/mod count for the confirm dialog, no writes. Always
    // called fresh right before showing that dialog, never trusting a client-held count.
    router.post('/apply-preview', async (req, res) => {
        if (vortexRunningGate(res)) return;
        const { oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const result = await rgRunner.applyPreview(state, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // The real write -- opens Vortex's LIVE state.v2 directly (full backup taken first, refuses if
    // Vortex is running). Same params as /apply-preview.
    router.post('/apply', async (req, res) => {
        if (vortexRunningGate(res)) return;
        const { oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides } = req.body || {};
        if (!oldCollectionKey || !newCollectionKey) {
            return res.status(400).json({ error: 'oldCollectionKey and newCollectionKey are both required.' });
        }
        try {
            const result = await rgRunner.apply(state, oldCollectionKey, newCollectionKey, ruleOverrides, anomalyOverrides);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createRulesGeneratorRouter };
