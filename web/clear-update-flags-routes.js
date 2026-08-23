'use strict';
// Thin Express handlers for "Clear Update Flags" -- all real logic lives in
// lib/vortex-update-flags.js. See that file's own header comment for the full design writeup.
//
// REQUIRES the Helper extension reachable, no state.v2 fallback -- unlike this project's other
// Helper-optional reads, there is no safe raw-DB-write equivalent for a live mutation like this
// (same reasoning lib/update-collection-v2-runner.js's own prepareApply already documents for its
// own HELPER_UNAVAILABLE gate).

const fs = require('fs');
const path = require('path');
const express = require('express');
const syncLib = require('../lib/vortex-sync/lib');
const helperClient = require('../lib/vortex-helper-client');
const { createSseSession } = require('./sse-session');
const {
    buildUpdateFlagPicker, resolveModIdsToClear, backupUpdateFlags, clearUpdateFlags, restoreUpdateFlagsBackup,
} = require('../lib/vortex-update-flags');

function createClearUpdateFlagsRouter(config) {
    const router = express.Router();
    const { staging, syncBackupRoot } = config;

    // Real POST-kicks-off-then-SSE-streams-progress shape, mirroring PGPatcher's own /build endpoint
    // exactly (web/pgpatcher-routes.js's buildSession/currentBuildChild/buildCancelled) -- the
    // original one-shot POST /clear left the button just saying "Clearing..." for however long a
    // large selection's own per-mod loop took, reading as frozen in real live testing (director's own
    // report, 2026-08-23). clearCancelled has no child-process equivalent to kill (this loop is a
    // plain async for-loop, not a spawned process) -- it's the same "checkable flag between
    // iterations" shape clearUpdateFlags's own shouldCancel param expects.
    const clearSession = createSseSession();
    let clearCancelled = false;

    router.get('/clear/events', (req, res) => {
        if (!clearSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        clearSession.subscribe(res, { afterSeq });
    });

    // Same real semantics as /build/cancel: a cancelled clear is a real partial result, never an
    // error -- whatever mods were already cleared before this landed genuinely stayed cleared (their
    // Helper writes already happened and can't be un-sent), and the backup written before the run
    // started already covers every one of them.
    router.post('/clear/cancel', (req, res) => {
        if (!clearSession.isActive()) {
            return res.status(404).json({ error: 'No clear is currently running.' });
        }
        clearCancelled = true;
        res.json({ ok: true });
    });

    async function requireHelper(res) {
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!helperAvailable) {
            res.status(409).json({
                error: 'helper-unavailable',
                message: 'The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to use this tool.',
            });
            return false;
        }
        return true;
    }

    // One call gives the card-grid picker everything it draws directly -- EVERY real Installed/
    // Workshop collection (not just ones with a pending flag -- see buildUpdateFlagPicker's own
    // header comment), plus the standalone list. No separate collections-lookup round trip.
    router.get('/list', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'not-configured', message: 'Set up the staging folder under Settings first.' });
        try {
            if (!(await requireHelper(res))) return;
            const data = await helperClient.getAllMods();
            if (!data) return res.status(500).json({ error: "Couldn't read Vortex's live mod list -- try again." });
            res.json(buildUpdateFlagPicker(staging, data.mods, data.enabledModKeys));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Body: { collectionModIds: string[], includeStandalone: boolean } -- which checked cards/row to
    // include (collectionModIds names match Rebuild Missing Files' own request-body convention).
    // Re-derives the real modIds to clear from a FRESH live scan (never trusts a client-supplied
    // modId list directly), so a stale picker state from an earlier /list call can't clear something
    // that changed underneath it. The resolve+backup step below stays synchronous and fails closed
    // exactly as before this task (if the backup write itself fails, nothing gets cleared, and this
    // response is a normal 4xx/5xx, not an SSE event) -- ONLY the actual clearing loop moves to the
    // background once the backup has genuinely succeeded, streamed over GET /clear/events.
    router.post('/clear', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'not-configured', message: 'Set up the staging folder under Settings first.' });
        if (!syncBackupRoot) {
            return res.status(400).json({ error: 'not-configured', message: 'A backups folder is not configured yet -- open Settings to set one up.' });
        }
        const { collectionModIds, includeStandalone } = req.body || {};
        if (!Array.isArray(collectionModIds)) {
            return res.status(400).json({ error: 'collectionModIds must be an array (can be empty).' });
        }
        if (clearSession.isActive()) {
            return res.status(409).json({ error: 'A clear is already in progress.' });
        }
        try {
            if (!(await requireHelper(res))) return;
            const data = await helperClient.getAllMods();
            if (!data) return res.status(500).json({ error: "Couldn't read Vortex's live mod list -- try again." });

            const modIds = resolveModIdsToClear(staging, data.mods, { collectionModIds, includeStandalone }, data.enabledModKeys);
            if (modIds.length === 0) {
                return res.status(400).json({ error: 'Nothing selected to clear.' });
            }

            // Names for the backup file's own metadata -- a second, independent scan (same real
            // primitive as the modId resolution just above, buildUpdateFlagPicker instead of
            // resolveModIdsToClear), simplicity over micro-optimizing away a cheap re-scan.
            const picker = buildUpdateFlagPicker(staging, data.mods, data.enabledModKeys);
            const selectedIds = new Set(collectionModIds.map(String));
            const includedCollections = [...picker.installed, ...picker.workshop]
                .filter((c) => selectedIds.has(String(c.modId)))
                .map((c) => ({ collectionId: c.modId, collectionName: c.name }));

            let backupPath;
            try {
                backupPath = backupUpdateFlags({
                    modIds, mods: data.mods, backupRoot: syncBackupRoot,
                    includedCollections, includedStandalone: !!includeStandalone,
                });
            } catch (e) {
                // Fails closed -- no backup, no clear (same "no backup, no write" rule Update
                // Collection v2's own runApply already enforces for its own real Vortex-state writes).
                return res.status(500).json({ error: `Couldn't take a real backup before clearing -- refusing to continue. ${e.message}` });
            }

            // The backup genuinely succeeded -- from here on this is real, in-progress Vortex-state
            // work, so it moves to the background and streams instead of blocking this response.
            // Same 202-then-stream shape as PGPatcher's own /build (web/pgpatcher-routes.js).
            clearCancelled = false;
            const mySession = clearSession.start({ id: `clear-${Date.now()}` });
            res.status(202).json({});
            const emitIfCurrent = (event) => {
                if (clearSession.get() === mySession) clearSession.emit(event);
            };

            (async () => {
                // Nothing to cancel during the resolve+backup step above (already finished by now) --
                // this is the real moment a cancel becomes meaningful, same as /build's own
                // onSpawn-fired 'cancellable' event.
                emitIfCurrent({ type: 'cancellable' });
                try {
                    const results = await clearUpdateFlags({
                        modIds,
                        mods: data.mods,
                        onProgress: ({ done, total, modId: mId, modName, ok }) => {
                            emitIfCurrent({
                                type: 'progress', message: 'Clearing update flags…', current: done, total, modId: mId, modName, ok,
                            });
                        },
                        shouldCancel: () => clearCancelled,
                    });
                    emitIfCurrent({
                        type: 'done', done: true, backupPath, total: modIds.length, results, cancelled: clearCancelled,
                    });
                } catch (e) {
                    emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, backupPath });
                }
            })();
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Restores exactly ONE backup snapshot -- the one tied to the clear that just completed (the
    // client already has its own `backupPath` from that clear's own 'done' event/response). No
    // browse-for-any-backup picker (director explicitly considered and declined that for now -- see
    // TODO.md's vortex-collection-tools "ideas" section for the deferred version). Gated behind the
    // same requireHelper check every other route here uses -- a restore is a live Helper write, same
    // as a clear. NEVER trusts a raw client-supplied filesystem path outright: backupPath must resolve
    // to a real file whose immediate parent is exactly the configured update-flags backup subfolder
    // (same path.dirname(...) !== knownDir check web/rebuild-routes.js's own /logs/:filename routes
    // already use for the identical "client hands back a path this server itself wrote" shape).
    router.post('/restore', async (req, res) => {
        if (!syncBackupRoot) {
            return res.status(400).json({ error: 'not-configured', message: 'A backups folder is not configured yet -- open Settings to set one up.' });
        }
        const { backupPath } = req.body || {};
        if (!backupPath || typeof backupPath !== 'string') {
            return res.status(400).json({ error: 'backupPath is required.' });
        }
        const updateFlagsBackupDir = path.resolve(syncBackupRoot, 'update-flags');
        const resolved = path.resolve(backupPath);
        if (path.dirname(resolved) !== updateFlagsBackupDir) {
            return res.status(400).json({ error: 'invalid-backup-path', message: "That backup file isn't inside the configured backups folder." });
        }
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'backup-not-found', message: "That backup file doesn't exist anymore." });
        }
        try {
            if (!(await requireHelper(res))) return;
            const results = await restoreUpdateFlagsBackup({ backupPath: resolved });
            res.json({ results });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createClearUpdateFlagsRouter };
