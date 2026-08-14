'use strict';
// Rebuild Missing Files -- thin Express handlers. Real logic lives in
// lib/missing-files-scan.js (scan) and lib/sevenzip.js's extractMany (fix). See DESIGN.md's own
// section on this tool and TECHNICAL.md for the full writeup.
//
// GET /collections is deliberately its OWN listing here, not a reuse of Rebuild Collection's
// /api/rebuild/collections -- that endpoint's "workshopOnlyCollections" means "tracked in Vortex
// with NO collection.json at all", which is exactly the case this tool can never scan (nothing to
// diff against). This tool's own "Workshop collections" group means the opposite: an
// authoring collection that DOES have a local collection.json (Vortex writes one while a Workshop
// collection is actively being edited) -- see missing-files-scan.js's own header comment.
//
// The scan itself needs no "Vortex must be closed" gate (same reasoning as Missing Masters' own
// /scan) -- it only ever reads collection.json files, archive listings, and the staging folder,
// never Vortex's live state.v2. /extract is the one write in this router (staging folder files),
// so it's gated exactly like every other staging-folder write in this app.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const { listPickableCollections, scanCollections, scanOneMod } = require('../lib/missing-files-scan');
const { loadCollection } = require('../lib/collection-parser');
const { findSevenZip, extractMany } = require('../lib/sevenzip');
const nexusModDownload = require('../lib/nexus-mod-download');
const syncLib = require('../lib/vortex-sync/lib');
const { createSseSession } = require('./sse-session');

const scanSession = createSseSession();

function createRebuildMissingRouter(config) {
    const router = express.Router();
    const { staging, downloads } = config;
    const sevenZipExe = findSevenZip();

    function isInside(baseDir, targetPath) {
        const resolvedBase = path.resolve(baseDir);
        const resolvedTarget = path.resolve(targetPath);
        return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
    }

    function requireConfigured(res) {
        if (staging && downloads) return true;
        res.status(400).json({ error: 'not-configured', message: 'Set up the staging and downloads folders under Settings first.' });
        return false;
    }

    router.get('/collections', (req, res) => {
        if (!staging) return res.json({ installed: [], workshop: [], configured: false });
        try {
            const { installed, workshop } = listPickableCollections(staging);
            res.json({ installed, workshop, configured: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/scan/events', (req, res) => {
        if (!scanSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        scanSession.subscribe(res, { afterSeq });
    });

    // Streams per-mod progress, then a final 'scan-complete' carrying the full report -- same
    // POST-starts-202/GET-.../events-subscribes shape as every other scan/plan in this app
    // (sse-session.js).
    router.post('/scan', (req, res) => {
        if (!requireConfigured(res)) return;
        const collectionModIds = Array.isArray(req.body?.collectionModIds) ? req.body.collectionModIds : [];
        if (collectionModIds.length === 0) return res.status(400).json({ error: 'Pick at least one collection to check.' });
        if (scanSession.isActive()) return res.status(409).json({ error: 'A scan is already in progress.' });

        const mySession = scanSession.start({ id: `scan-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (scanSession.get() === mySession) scanSession.emit(event);
        };

        (async () => {
            try {
                const collectionResults = await scanCollections(collectionModIds, {
                    stagingDir: staging, downloadsDir: downloads, sevenZipExe,
                    onProgress: (p) => emitIfCurrent({ type: 'mod-scanned', ...p }),
                });
                const statColls = collectionResults.filter((c) => !c.error).length;
                const statMods = collectionResults.reduce((n, c) => n + (c.modsWithMissing?.length || 0), 0);
                const statFiles = collectionResults.reduce((n, c) => n + (c.modsWithMissing || []).reduce((m, mod) => m + mod.missing.length, 0), 0);
                emitIfCurrent({
                    type: 'scan-complete', done: true, collectionResults,
                    stats: { collectionsChecked: statColls, modsWithMissing: statMods, filesMissing: statFiles },
                });
            } catch (e) {
                emitIfCurrent({ type: 'scan-error', done: true, error: true, message: e.message });
            }
        })();
    });

    // Extracts just the missing files for one or more mods, straight from their already-resolved
    // archive -- the same sevenzip.js extractMany a full Rebuild Collection run uses, just scoped to
    // the specific paths a scan found absent. Re-verifies every path is STILL actually missing right
    // before extracting (cheap fs.existsSync checks) rather than trusting the client-held scan
    // result outright -- real time may have passed since the scan ran.
    router.post('/extract', (req, res) => {
        if (!requireConfigured(res)) return;
        if (syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (items.length === 0) return res.status(400).json({ error: 'Nothing selected to extract.' });

        (async () => {
            const results = [];
            for (const item of items) {
                const { name, targetFolderName, archivePath, files } = item || {};
                if (!targetFolderName || !archivePath || !Array.isArray(files) || files.length === 0) {
                    results.push({ name, ok: false, error: 'Incomplete request.' });
                    continue;
                }
                if (!fs.existsSync(archivePath)) {
                    results.push({ name, ok: false, error: 'The archive is no longer on disk -- try Download Archive, or re-scan.' });
                    continue;
                }
                const stagingModDir = path.join(staging, targetFolderName);
                const stillMissing = files.filter((f) => !fs.existsSync(path.join(stagingModDir, f)));
                if (stillMissing.length === 0) {
                    results.push({ name, ok: true, extracted: [], note: 'Already fixed -- nothing was actually missing anymore.' });
                    continue;
                }
                try {
                    await extractMany(sevenZipExe, archivePath, stillMissing, stagingModDir);
                    const reallyThere = stillMissing.filter((f) => fs.existsSync(path.join(stagingModDir, f)));
                    const stillGone = stillMissing.filter((f) => !fs.existsSync(path.join(stagingModDir, f)));
                    results.push({
                        name, ok: stillGone.length === 0, extracted: reallyThere,
                        error: stillGone.length > 0 ? `${stillGone.length} file(s) were not found inside the archive: ${stillGone.join(', ')}` : undefined,
                    });
                } catch (e) {
                    results.push({ name, ok: false, error: e.message });
                }
            }
            res.json({ results });
        })();
    });

    // Downloads ONE mod's archive from Nexus (Premium-only, same policy as Rebuild Collection's own
    // "download missing archives" -- see lib/nexus-mod-download.js's header), then immediately
    // re-scans that one mod so the report row can update in place without a full re-scan.
    router.post('/download-archive', async (req, res) => {
        if (!requireConfigured(res)) return;
        const { collectionModId, modId, fileId } = req.body || {};
        if (!collectionModId || modId == null || fileId == null) {
            return res.status(400).json({ error: 'collectionModId, modId, and fileId are required.' });
        }
        let collection;
        try {
            collection = loadCollection(path.join(staging, collectionModId, 'collection.json'));
        } catch (e) {
            return res.status(400).json({ error: `Could not read this collection's collection.json: ${e.message}` });
        }
        const mod = collection.mods.find((m) => m.source?.modId === modId && m.source?.fileId === fileId);
        if (!mod) return res.status(404).json({ error: 'That mod was not found in this collection anymore -- try re-scanning.' });
        if (mod.source?.type !== 'nexus') return res.status(400).json({ error: 'This mod is not hosted on Nexus -- download its archive manually.' });

        try {
            const apiKey = nexusModDownload.resolveApiKey();
            const premium = await nexusModDownload.checkPremiumStatus(apiKey);
            if (!premium.isPremium) {
                return res.status(400).json({
                    error: 'not-premium',
                    message: "Nexus only allows automated downloads for Premium accounts -- this respects Nexus's ad-supported download model for free users. Download this archive manually from Nexus instead.",
                });
            }
            await nexusModDownload.downloadModArchive({ apiKey, gameDomain: collection.info?.domainName, source: mod.source, destDir: downloads });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }

        const result = await scanOneMod(mod, { downloadsDir: downloads, stagingDir: staging, sevenZipExe });
        res.json({ result });
    });

    // Same "navigate straight into it" pattern as Missing Masters' own /open-staging-folder --
    // validated to actually be inside the configured staging directory first (cheap
    // defense-in-depth, not a real capability restriction; this only ever receives a path this
    // tool's own scan just found).
    router.post('/open-staging-folder', (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { targetFolderName } = req.body || {};
        if (!targetFolderName || typeof targetFolderName !== 'string') {
            return res.status(400).json({ error: 'No folder given to open.' });
        }
        const folderPath = path.join(staging, targetFolderName);
        if (!isInside(staging, folderPath)) {
            return res.status(400).json({ error: 'That folder is not inside your configured staging directory.' });
        }
        spawn(`explorer.exe "${path.resolve(folderPath)}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createRebuildMissingRouter };
