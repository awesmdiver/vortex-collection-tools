'use strict';
// Thin Express handlers for the Update Collection flow -- all real logic lives in
// lib/sync-runner.js (shared with sync-cli.js/sync-menu.js). Each of these phases is a single
// atomic backend operation (not a multi-step loop), so plain async request/response is used rather
// than SSE -- see web/sync-lock.js's own comment for why. Nothing destructive happens without a
// fresh Vortex-closed check, mirroring the Rebuild Collection flow's gate exactly.

const express = require('express');
const fs = require('fs');

const runner = require('../lib/sync-runner');
const { buildHtmlReport } = require('../lib/vortex-sync/report');
const syncLock = require('./sync-lock');

function createSyncRouter(config) {
    const router = express.Router();
    const { staging, state } = config;
    const syncLib = runner.loadSyncLib();

    function vortexRunningGate(res) {
        if (syncLib.isVortexRunning()) {
            res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
            return true;
        }
        return false;
    }

    router.get('/collections', (req, res) => {
        // No staging folder configured yet (fresh install) -- expected, not an error.
        if (!staging) return res.json({ collections: [], configured: false });
        try {
            res.json({ collections: runner.listInstalledCollections(staging) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/vortex-status', (req, res) => {
        res.json({ running: syncLib.isVortexRunning() });
    });

    router.get('/profiles', async (req, res) => {
        if (vortexRunningGate(res)) return;
        try {
            res.json({ profiles: await runner.listProfiles(state) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/backups', (req, res) => {
        res.json({ backups: runner.listBackups() });
    });

    // Phase 1 -- run BEFORE clicking "Update" on the collection in Vortex. Read-only (a temp copy
    // of state.v2), but Vortex must still be closed to safely copy it.
    router.post('/backup', async (req, res) => {
        const { collectionModId, profileId } = req.body || {};
        if (!collectionModId) return res.status(400).json({ error: 'collectionModId is required.' });
        if (!staging) return res.status(400).json({ error: 'not-configured', message: 'Staging folder is not configured yet -- open Settings to set it up.' });
        if (vortexRunningGate(res)) return;
        try {
            const snapshot = await runner.captureBackupSnapshot({ stateDir: state, stagingDir: staging, collectionModId, profileId });
            const filePath = runner.saveBackupSnapshot(snapshot);
            res.json({ ok: true, filePath, ignoredCount: snapshot.ignored.length, disabledCount: snapshot.disabled.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Phase 2 dry-run -- read-only, safe to call any time. Reports the Vortex-version-compat check
    // alongside so the UI can warn before the real apply, not just after.
    router.post('/apply-ignores/preview', async (req, res) => {
        const { modId, backupPath } = req.body || {};
        if (!modId || !backupPath) return res.status(400).json({ error: 'modId and backupPath are required.' });
        if (vortexRunningGate(res)) return;
        try {
            const snapshot = runner.loadBackup(backupPath);
            const changed = await runner.previewApplyIgnores({ stateDir: state, modId, ignoredRefs: snapshot.ignored });
            const { version, tested } = await runner.checkVortexVersionCompat(state);
            res.json({ changed, vortexVersion: version, versionTested: tested });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Phase 2 real write -- the only step that actually prevents Vortex from installing ignored
    // mods. lib/vortex-sync/lib.js's withLiveStateDb takes a full state.v2 backup first and refuses
    // if Vortex is running or the backup can't be completed.
    router.post('/apply-ignores/apply', async (req, res) => {
        const { modId, backupPath } = req.body || {};
        if (!modId || !backupPath) return res.status(400).json({ error: 'modId and backupPath are required.' });
        if (vortexRunningGate(res)) return;
        try {
            syncLock.acquire('apply-ignores');
        } catch (e) {
            return res.status(409).json({ error: 'write-active', message: e.message });
        }
        try {
            const snapshot = runner.loadBackup(backupPath);
            const result = await runner.applyIgnores({ stateDir: state, modId, ignoredRefs: snapshot.ignored });
            res.json({ ok: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            syncLock.release();
        }
    });

    // Phase 3 dry-run -- read-only. Only meaningful after Resume finishes (a dependent mod's id
    // doesn't exist in state until Vortex actually installs it) -- run too early and it just finds
    // fewer/zero matches, surfaced via `missing` rather than treated as an error.
    router.post('/apply-disables/preview', async (req, res) => {
        const { backupPath } = req.body || {};
        if (!backupPath) return res.status(400).json({ error: 'backupPath is required.' });
        if (vortexRunningGate(res)) return;
        try {
            const snapshot = runner.loadBackup(backupPath);
            if (snapshot.disabled.length === 0) {
                res.json({ matches: [], missing: [], nothingToDo: true });
                return;
            }
            const matches = await runner.previewApplyDisables({ stateDir: state, disabledRefs: snapshot.disabled });
            const foundNames = new Set(matches.map((m) => m.matchedRef.name));
            const missing = snapshot.disabled.filter((d) => !foundNames.has(d.name));
            res.json({ matches, missing, nothingToDo: false });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Phase 3 real write -- same live-state safety wrapper as apply-ignores/apply.
    router.post('/apply-disables/apply', async (req, res) => {
        const { profileId, backupPath } = req.body || {};
        if (!profileId || !backupPath) return res.status(400).json({ error: 'profileId and backupPath are required.' });
        if (vortexRunningGate(res)) return;
        try {
            syncLock.acquire('apply-disables');
        } catch (e) {
            return res.status(409).json({ error: 'write-active', message: e.message });
        }
        try {
            const snapshot = runner.loadBackup(backupPath);
            const result = await runner.applyDisables({ stateDir: state, profileId, disabledRefs: snapshot.disabled });
            res.json({ ok: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        } finally {
            syncLock.release();
        }
    });

    // Optional Compare -- pure computation, never touches the state DB (matches lib.js's own
    // computeSync/writePatchedCollection scope exactly: audit-only, does not control what Vortex
    // installs). Renders the existing buildHtmlReport HTML directly, mirroring the Rebuild flow's
    // /logs/view/:filename pattern (a GET so it can be opened straight via window.open, no body).
    router.get('/compare/report', (req, res) => {
        const { backupPath, collectionPath } = req.query;
        if (!backupPath || !collectionPath) return res.status(400).send('backupPath and collectionPath query params are required.');
        try {
            const snapshot = runner.loadBackup(backupPath);
            const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
            const result = runner.compareCollectionAgainstBackup(collection, snapshot);
            const before = result.removedMods.length + result.keptMods.length;
            const after = result.keptMods.length;
            const html = buildHtmlReport({
                collectionInfo: { name: snapshot.collectionName },
                collectionModId: snapshot.collectionModId,
                sourcePath: collectionPath,
                outPath: null,
                applied: false,
                before, after, result,
            });
            res.type('html').send(html);
        } catch (e) {
            res.status(500).send(`Error: ${e.message}`);
        }
    });

    return router;
}

module.exports = { createSyncRouter };
