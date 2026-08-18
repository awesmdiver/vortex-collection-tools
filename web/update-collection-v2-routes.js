'use strict';
// Thin Express handlers for Update Collection v2 (Phase 1: read-only Check for Updates + Review, no
// real apply/deploy yet) -- all real logic lives in lib/update-collection-v2-runner.js +
// lib/collection-diff.js. See TECHNICAL.md's "Update Collection v2" section for the full design
// writeup.

const express = require('express');
const runner = require('../lib/update-collection-v2-runner');

function createUpdateCollectionV2Router(config) {
    const router = express.Router();
    const { staging, state } = config;

    // Ungated, local-only -- the base collection list (name/author/modCount/pictureUrl-less) never
    // needs Vortex or Nexus at all, same "always-available read" convention as every other tool's
    // own /scan-style listing route. Real revision-check status only ever comes from the explicit
    // /check-updates action below, never fetched implicitly here.
    router.get('/collections', (req, res) => {
        if (!staging) return res.json({ collections: [], configured: false });
        try {
            const collections = runner.listCollections(staging).map((c) => ({
                modId: c.modId, name: c.name, author: c.author, modCount: c.modCount,
            }));
            res.json({ collections, configured: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // "Check for Updates" -- resolves each collection's real Nexus slug + installed revision
    // (helper-first, state.v2 fallback, see the runner's own comment) and compares against the
    // newest published revision. A real 409 (vortex-running) only ever surfaces from the state.v2
    // fallback branch, same shape every other gated route in this project already returns.
    router.post('/check-updates', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        try {
            const result = await runner.checkForUpdates({ staging, state });
            res.json(result);
        } catch (e) {
            if (e.code === 'VORTEX_RUNNING') {
                return res.status(409).json({ error: 'vortex-running', message: e.message });
            }
            res.status(500).json({ error: e.message });
        }
    });

    // "Review update" -- downloads the newest revision's real collection.json from Nexus and diffs
    // it against the currently-installed one. Same VORTEX_RUNNING handling as /check-updates.
    router.post('/review', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'No collection given to review.' });
        }
        try {
            const result = await runner.reviewUpdate({ collectionModId, staging, state });
            res.json(result);
        } catch (e) {
            if (e.code === 'VORTEX_RUNNING') {
                return res.status(409).json({ error: 'vortex-running', message: e.message });
            }
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createUpdateCollectionV2Router };
