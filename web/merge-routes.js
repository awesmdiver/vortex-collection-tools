'use strict';
// Merge Plugins (The Forge) -- bundles several plugins from one or more installed collections into
// a single output plugin, ESL-flagging it automatically when it qualifies. See TECHNICAL.md's
// "Merge engine" section for the full design writeup (the Part A feasibility spike, the v1.0
// new-record-only scope, the ESPFE qualification pipeline).
//
// Reuses this project's existing pieces rather than duplicating them:
//   - lib/sync-runner.js's listInstalledCollections (the exact same "installed collections" list
//     Rebuild Collection/Rules Generator already show).
//   - The generic `/api/settings/browse-folder` endpoint for the output-folder picker -- no
//     dedicated pick-folder route here.
//   - web/sse-session.js for merge progress, matching Archive Finder's/Rebuild Collection's own
//     POST-starts-a-session + GET-.../events-subscribes convention.
//   - syncLib.isVortexRunning() for the "Vortex must be closed" gate (this reads staging files,
//     not Vortex's own database, but staging is Vortex-managed and could be mid-write).

const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const appConfig = require('../lib/app-config');
const syncLib = require('../lib/vortex-sync/lib');
const syncRunner = require('../lib/sync-runner');
const { scanCollectionPlugins } = require('../lib/merge-plugin-scan');
const mergeRunner = require('../lib/merge-runner');
const { createSseSession } = require('./sse-session');

const LIGHT_PLUGIN_LIMIT = 4096; // hardcoded per the Part A spike sign-off -- requires SSE 1.6.1130+

const mergeSession = createSseSession();

function createMergeRouter(config) {
    const router = express.Router();
    const { staging } = config;

    function vortexRunningGate(res) {
        if (syncLib.isVortexRunning()) {
            res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
            return true;
        }
        return false;
    }

    function requireStaging(res) {
        if (staging) return true;
        res.status(400).json({ error: 'not-configured', message: 'Set up your Vortex staging folder under Settings first.' });
        return false;
    }

    // The merge engine needs the real Skyrim Data folder to stage actual base-game masters
    // (Skyrim.esm etc, hardlinked into a throwaway sandbox) -- a zero-record dummy master is only
    // enough for xelib's own loader, not for copying a "new" record that references a real FormID
    // inside that master (see lib/merge-worker.js's stageMaster). Read fresh each call, same as the
    // existing skyrimDataDir read in the /merge route below -- Settings can change this without a
    // server restart.
    function requireSkyrimDataDir(res) {
        const { skyrimDataDir } = appConfig.loadConfig();
        if (skyrimDataDir) return skyrimDataDir;
        res.status(400).json({ error: 'not-configured', message: 'Set up your Skyrim Data folder under Settings first.' });
        return null;
    }

    router.get('/collections', (req, res) => {
        if (!requireStaging(res)) return;
        try {
            const collections = syncRunner.listInstalledCollections(staging).map((c) => ({
                modId: c.modId, name: c.name, author: c.author, modCount: c.modCount,
            }));
            res.json({ collections });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Searches the plugins belonging to the given (already-chosen) collections -- q/extensions are
    // applied here, server-side, rather than shipping every plugin down and filtering client-side,
    // since a large multi-collection pick can easily be thousands of files.
    router.get('/plugins', (req, res) => {
        if (!requireStaging(res)) return;
        const collectionModIds = String(req.query.collections || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (collectionModIds.length === 0) return res.json({ results: [] });
        const q = String(req.query.q || '').trim().toLowerCase();
        const extensions = String(req.query.extensions || '.esp,.esl,.esm').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        try {
            const allCollections = syncRunner.listInstalledCollections(staging);
            const chosen = allCollections.filter((c) => collectionModIds.includes(c.modId));
            const allPlugins = scanCollectionPlugins(staging, chosen);
            const results = allPlugins.filter((p) => {
                if (extensions.length && !extensions.includes(p.extension)) return false;
                if (!q) return true;
                return p.fileName.toLowerCase().includes(q) || p.modName.toLowerCase().includes(q);
            });
            res.json({ results });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Read-only look at each chosen plugin: does it contain any override/injected records (v1.0
    // excludes these from the actual merge -- see lib/merge-worker.js's own header comment), what
    // masters does it declare, and how many genuinely new records would it contribute. Vortex-gated
    // since this reads the real plugin files out of staging.
    router.post('/analyze', async (req, res) => {
        if (vortexRunningGate(res)) return;
        const gameDataDir = requireSkyrimDataDir(res);
        if (!gameDataDir) return;
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (items.length === 0) return res.status(400).json({ error: 'No plugins were provided.' });
        try {
            const result = await mergeRunner.analyzePlugins(items, gameDataDir);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/merge/events', (req, res) => {
        if (!mergeSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        mergeSession.subscribe(res, { afterSeq });
    });

    // Starts the actual merge (only the items the Review step left in -- override-containing
    // plugins must already be excluded by the caller). NEVER the Skyrim Data folder -- this tool
    // doesn't install anything into the game or Vortex, the user does that themselves afterward.
    router.post('/merge', (req, res) => {
        if (vortexRunningGate(res)) return;
        if (mergeSession.isActive()) {
            return res.status(409).json({ error: 'A merge is already in progress' });
        }
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        const outputName = String(req.body?.outputName || '').trim();
        const outputDir = String(req.body?.outputDir || '').trim();
        if (items.length === 0) return res.status(400).json({ error: 'No plugins were provided.' });
        if (!outputName) return res.status(400).json({ error: 'Name the merged plugin first.' });
        if (!outputDir) return res.status(400).json({ error: 'Choose an output folder first.' });

        const gameDataDir = requireSkyrimDataDir(res);
        if (!gameDataDir) return;
        const resolvedOut = path.resolve(outputDir);
        const resolvedData = path.resolve(gameDataDir);
        if (resolvedOut === resolvedData || resolvedOut.startsWith(resolvedData + path.sep)) {
            return res.status(400).json({ error: 'The output folder cannot be your Skyrim Data folder -- choose a different folder, then install the merged plugin as a mod in Vortex yourself.' });
        }

        const fileName = outputName.toLowerCase().endsWith('.esp') ? outputName : `${outputName}.esp`;
        const outputPath = path.join(outputDir, fileName);

        const mySession = mergeSession.start({ id: `merge-${Date.now()}` });
        res.status(202).json({});

        mergeRunner.mergePlugins(items, outputPath, LIGHT_PLUGIN_LIMIT, gameDataDir, (current, total, label) => {
            if (mergeSession.get() === mySession) mergeSession.emit({ type: 'progress', current, total, label });
        }).then((result) => {
            if (mergeSession.get() !== mySession) return;
            const { mergeOutputDir } = appConfig.loadConfig();
            if (outputDir !== mergeOutputDir) appConfig.saveConfig({ mergeOutputDir: outputDir }); // remember as the default for next time
            mergeSession.emit({ type: 'done', done: true, ...result });
        }).catch((e) => {
            if (mergeSession.get() !== mySession) return;
            mergeSession.emit({ type: 'error', done: true, error: true, message: e.message });
        });
    });

    // Trusted-localhost-only convenience (never exposed off loopback), same reasoning as
    // rebuild-routes.js's own /reveal -- opens the merge output folder directly in Explorer. The
    // output folder is arbitrary/user-chosen (never restricted to staging), so this doesn't
    // validate against any single configured root the way Missing Masters' own open-folder routes
    // do; there's no fixed root to validate against here.
    router.post('/open-output-folder', (req, res) => {
        const { folderPath } = req.body || {};
        if (!folderPath || typeof folderPath !== 'string') return res.status(400).json({ error: 'folderPath is required.' });
        spawn(`explorer.exe "${path.resolve(folderPath)}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createMergeRouter };
