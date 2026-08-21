'use strict';
// Thin Express handlers for Safe Collection Removal -- all real logic lives in
// lib/remove-collection-runner.js. See TECHNICAL.md's "Safe Collection Removal" section for the
// full design writeup.

const express = require('express');
const runner = require('../lib/remove-collection-runner');

function createRemoveCollectionRouter(config) {
    const router = express.Router();
    const { staging, downloads } = config;

    // Screen 1's collection grid -- reads Update Collection v2's own shared, Nexus-backed cache (see
    // remove-collection-runner.js's own getCollectionsOverview comment); never makes a network call
    // itself, so this is always instant.
    router.get('/collections', async (req, res) => {
        if (!staging) return res.json({ collections: [], configured: false, refreshing: false, checkedAt: null });
        try {
            const result = await runner.getCollectionsOverview({ staging });
            res.json({ ...result, configured: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Screen 2's review -- cross-references the chosen collection's mods against every OTHER
    // installed collection. Purely a filesystem read; never requires the helper extension.
    router.post('/review', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'No collection given to review.' });
        }
        try {
            const result = await runner.reviewRemoval({ collectionModId, staging });
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // The real Apply -- removes the collection itself, plus every mod the caller selected, from
    // Vortex's live state. Requires the helper extension reachable (Vortex genuinely open) -- there is
    // no state.v2 equivalent for a real remove-mods dispatch, same real constraint Update Collection
    // v2's own Apply already has.
    router.post('/apply', async (req, res) => {
        if (!staging || !downloads) return res.status(400).json({ error: 'Set up the staging and downloads folders under Settings first.' });
        const { collectionModId, selectedModIds, deleteArchives } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'No collection given to remove.' });
        }
        if (selectedModIds !== undefined && !Array.isArray(selectedModIds)) {
            return res.status(400).json({ error: 'selectedModIds must be an array (or omitted).' });
        }
        try {
            const result = await runner.applyRemoval({ collectionModId, staging, downloads, selectedModIds, deleteArchives });
            res.json(result);
        } catch (e) {
            if (e.code === 'HELPER_UNAVAILABLE') {
                return res.status(409).json({ error: 'helper-unavailable', message: e.message });
            }
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createRemoveCollectionRouter };
