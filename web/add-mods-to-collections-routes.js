'use strict';
// Bulk Collection Editor -- thin Express handlers. Real logic lives in
// lib/add-mods-to-collections.js. No staging/downloads config needed -- every read and both writes
// (add/remove) this tool does go entirely through the Vortex Bridge's live state, so the
// only gate here is "is the Vortex Bridge reachable."

const express = require('express');
const amc = require('../lib/add-mods-to-collections');
const bridgeClient = require('../lib/vortex-bridge-client');
const syncLib = require('../lib/vortex-sync/lib');

function createAddModsToCollectionsRouter() {
    const router = express.Router();

    async function requireBridge(res) {
        const available = await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID);
        if (!available) {
            res.status(409).json({
                error: 'bridge-unavailable',
                message: 'The Vortex Bridge extension must be reachable (Vortex genuinely open) for this tool -- both the live mod/collection list and the real write only exist through it.',
            });
            return false;
        }
        return true;
    }

    // POST, not GET (2026-09-15, "Bulk Collection Editor: add and remove mods") -- now that Step 1
    // (collections) comes before this search, the picked collections' own {modId, name} pairs travel
    // alongside the query so `alreadyIn` can be computed in the same call, rather than encoding an
    // array into a query string. Body: { q, collections?: [{modId, name}, ...] }.
    router.post('/search', async (req, res) => {
        if (!(await requireBridge(res))) return;
        const { q, collections } = req.body || {};
        try {
            const results = await amc.searchMods(q, collections);
            if (results === null) return res.status(502).json({ error: "Couldn't read your mod list from Vortex just now. Try again." });
            res.json({ results });
        } catch (e) {
            console.error(`[add-mods-to-collections-routes] /search failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/collections', async (req, res) => {
        if (!(await requireBridge(res))) return;
        try {
            const results = await amc.getEditableCollections();
            if (results === null) return res.status(502).json({ error: "Couldn't read your collections from Vortex just now. Try again." });
            res.json({ collections: results });
        } catch (e) {
            console.error(`[add-mods-to-collections-routes] /collections failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // Body: { collections: [{modId, name}, ...] } -- the Remove step's own merged-list read. Body:
    // { collections } -- the SAME shape /add and /remove already accept, so the client's own picked
    // list can be forwarded verbatim.
    router.post('/mods-in-collections', async (req, res) => {
        if (!(await requireBridge(res))) return;
        const { collections } = req.body || {};
        if (!Array.isArray(collections) || collections.length === 0) {
            return res.status(400).json({ error: 'No collections chosen.' });
        }
        try {
            const results = await amc.getModsInCollections(collections);
            if (results === null) return res.status(502).json({ error: "Couldn't read your collections from Vortex just now. Try again." });
            res.json({ mods: results });
        } catch (e) {
            console.error(`[add-mods-to-collections-routes] /mods-in-collections failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // Body: { modIds: [string, ...], collections: [{modId, name}, ...] }. `collections` carries each
    // one's display name straight from the client's own already-fetched picker list purely so the
    // result can name them back without a second round trip -- the actual write re-reads each
    // collection's real rules fresh server-side (see addModsToCollections), never trusts this name for
    // anything but display.
    router.post('/add', async (req, res) => {
        if (!(await requireBridge(res))) return;
        const { modIds, collections } = req.body || {};
        if (!Array.isArray(modIds) || modIds.length === 0) {
            return res.status(400).json({ error: 'No mods to add.' });
        }
        if (!Array.isArray(collections) || collections.length === 0) {
            return res.status(400).json({ error: 'No collections chosen.' });
        }
        try {
            const result = await amc.addModsToCollections(modIds, collections);
            res.json(result);
        } catch (e) {
            console.error(`[add-mods-to-collections-routes] /add failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // Mirror of /add above -- same body shape, same re-read-fresh-before-writing discipline (see
    // removeModsFromCollections's own header comment for why this one uses a single getAllMods()
    // snapshot instead of N per-collection reads).
    router.post('/remove', async (req, res) => {
        if (!(await requireBridge(res))) return;
        const { modIds, collections } = req.body || {};
        if (!Array.isArray(modIds) || modIds.length === 0) {
            return res.status(400).json({ error: 'No mods to remove.' });
        }
        if (!Array.isArray(collections) || collections.length === 0) {
            return res.status(400).json({ error: 'No collections chosen.' });
        }
        try {
            const result = await amc.removeModsFromCollections(modIds, collections);
            if (result === null) return res.status(502).json({ error: "Couldn't read your collections from Vortex just now. Try again." });
            res.json(result);
        } catch (e) {
            console.error(`[add-mods-to-collections-routes] /remove failed: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createAddModsToCollectionsRouter };
