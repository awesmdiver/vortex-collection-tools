'use strict';
// Thin Express handlers for the removed-from-main tool -- all real logic lives in lib/removed-from-main.js.
// Compare only reads (Vortex and main's own list); Delete is a real write to Vortex, so it needs the Vortex Bridge,
// takes the shared write lock, and streams real progress the same way Safe Collection Removal does.

const express = require('express');
const rfm = require('../lib/removed-from-main');
const bridgeClient = require('../lib/vortex-bridge-client');
const { withHealthCheckPaused } = require('../lib/health-check-pause');
const syncLib = require('../lib/vortex-sync/lib');
const syncLock = require('./sync-lock');
const { createSseSession } = require('./sse-session');

const BRIDGE_MESSAGE = 'Vortex needs to be open, with the Vortex Bridge running, for this tool to read or change anything.';

function createRemovedFromMainRouter(config) {
    const router = express.Router();
    const { staging, downloads, syncBackupRoot } = config;
    const deleteSession = createSseSession();

    async function bridgeGate(res) {
        if (await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID)) return true;
        res.status(409).json({ error: 'bridge-unavailable', message: BRIDGE_MESSAGE });
        return false;
    }

    router.get('/collections', async (req, res) => {
        if (!staging) return res.json({ main: [], mine: [], configured: false });
        try {
            if (!(await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID))) {
                return res.status(409).json({ error: 'bridge-unavailable', message: BRIDGE_MESSAGE });
            }
            res.json({ ...(await rfm.listPickers({ staging })), configured: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/compare', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { mainCollectionKey, newCollectionKey } = req.body || {};
        if (typeof mainCollectionKey !== 'string' || typeof newCollectionKey !== 'string') {
            return res.status(400).json({ error: 'Pick the main collection and your new collection first.' });
        }
        try {
            if (!(await bridgeGate(res))) return;
            res.json(await rfm.compare({ mainCollectionKey, newCollectionKey, staging }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/delete/events', (req, res) => {
        if (!deleteSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        deleteSession.subscribe(res, { afterSeq });
    });

    router.post('/delete', async (req, res) => {
        if (!staging || !downloads) return res.status(400).json({ error: 'Set up the staging and downloads folders under Settings first.' });
        const { mainCollectionKey, newCollectionKey, rowIds } = req.body || {};
        if (typeof mainCollectionKey !== 'string' || typeof newCollectionKey !== 'string') {
            return res.status(400).json({ error: 'Pick the main collection and your new collection first.' });
        }
        if (!Array.isArray(rowIds) || rowIds.length === 0 || !rowIds.every((r) => typeof r === 'string')) {
            return res.status(400).json({ error: 'Nothing is ticked.' });
        }
        if (deleteSession.isActive() || syncLock.isLocked()) {
            return res.status(409).json({ error: 'A write to Vortex is already in progress. Wait for it to finish.' });
        }
        if (!(await bridgeGate(res))) return;

        syncLock.acquire('removed-from-main');
        const mySession = deleteSession.start({ id: `removed-from-main-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (deleteSession.get() === mySession) deleteSession.emit(event);
        };
        (async () => {
            try {
                const result = await withHealthCheckPaused(() => rfm.deleteRows({
                    mainCollectionKey, newCollectionKey, rowIds, staging, downloads, syncBackupRoot,
                    onProgress: (p) => emitIfCurrent({ type: 'phase', ...p }),
                }), {
                    onPaused: (message) => emitIfCurrent({ type: 'phase', message }),
                    onRestoreFailed: (message) => emitIfCurrent({ type: 'phase', message }),
                });
                emitIfCurrent({ type: 'done', done: true, ...result });
            } catch (e) {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true });
            } finally {
                syncLock.release();
            }
        })();
    });

    return router;
}

module.exports = { createRemovedFromMainRouter };
