'use strict';
// Thin Express handlers for Safe Collection Removal -- all real logic lives in
// lib/remove-collection-runner.js. See TECHNICAL.md's "Safe Collection Removal" section for the
// full design writeup.

const express = require('express');
const runner = require('../lib/remove-collection-runner');
const helperClient = require('../lib/vortex-helper-client');
const syncLib = require('../lib/vortex-sync/lib');
const { createSseSession } = require('./sse-session');

function createRemoveCollectionRouter(config) {
    const router = express.Router();
    const { staging, downloads } = config;

    // Real SSE-streamed progress (2026-08-25, closes docs/UI-PATTERN-MAP.md's "Safe Collection
    // Removal's actual remove step" finding -- a button-label-only "Removing…" with zero real
    // feedback, the closest match in this app to the exact complaint that started the mandatory-
    // progress rule). Same 202-then-stream shape as clear-update-flags-routes.js's own /clear.
    const applySession = createSseSession();

    router.get('/apply/events', (req, res) => {
        if (!applySession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        applySession.subscribe(res, { afterSeq });
    });

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
        if (applySession.isActive()) {
            return res.status(409).json({ error: 'A removal is already in progress.' });
        }

        // HELPER_UNAVAILABLE is checked synchronously up front (mirroring the not-configured checks
        // above) so a caller with no Vortex open gets a normal, immediate 4xx rather than an SSE
        // session that just opens and instantly errors -- the real, possibly-slow work only starts
        // once this fast precondition is known good.
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!helperAvailable) {
            return res.status(409).json({
                error: 'helper-unavailable',
                message: "The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to remove a collection -- this real remove-mods/unlink work only exists through it, unlike this tool's read-only Review screen, which never needs it.",
            });
        }

        const mySession = applySession.start({ id: `remove-collection-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (applySession.get() === mySession) applySession.emit(event);
        };

        (async () => {
            try {
                const result = await runner.applyRemoval({
                    collectionModId, staging, downloads, selectedModIds, deleteArchives,
                    onProgress: (p) => emitIfCurrent({ type: 'phase', ...p }),
                });
                emitIfCurrent({ type: 'done', done: true, ...result });
            } catch (e) {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true });
            }
        })();
    });

    return router;
}

module.exports = { createRemoveCollectionRouter };
