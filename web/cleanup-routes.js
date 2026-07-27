'use strict';
// Thin Express handlers for the "Clean Up" report -- all real logic lives in lib/cleanup-scan.js.
// See TECHNICAL.md's "Clean Up report" section for the full design writeup.

const path = require('path');
const express = require('express');
const syncLib = require('../lib/vortex-sync/lib');
const cleanupScan = require('../lib/cleanup-scan');
const excludeStore = require('../lib/cleanup-exclude-store');

function createCleanupRouter(config) {
    const router = express.Router();
    const { staging, downloads, state, cleanupExcludeListDir } = config;

    function vortexRunningGate(res) {
        if (syncLib.isVortexRunning()) {
            res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
            return true;
        }
        return false;
    }

    // Scans read Vortex's state.v2 (withStateDb already throws its own clear error if Vortex is
    // running -- vortexRunningGate here is just so the client gets the SAME {error, message} shape
    // it already handles everywhere else, instead of a raw 500). The exclude list is read fresh
    // from its own data file on every scan (no restart needed) -- only the FOLDER it lives in
    // (cleanupExcludeListDir) is baked in at startup, same as every other path field.
    router.get('/scan-staging', async (req, res) => {
        if (!staging) return res.json({ configured: false, total: 0, exceptions: [], needsReview: [] });
        if (vortexRunningGate(res)) return;
        try {
            const { staging: ignoredStaging } = excludeStore.load(cleanupExcludeListDir);
            const result = await cleanupScan.scanStaging(state, staging, ignoredStaging);
            res.json({ configured: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/scan-archives', async (req, res) => {
        if (!downloads) return res.json({ configured: false, total: 0, exceptions: [], needsReview: [], hasUninstalledArchives: false });
        if (vortexRunningGate(res)) return;
        try {
            const { archives: ignoredArchives } = excludeStore.load(cleanupExcludeListDir);
            const result = await cleanupScan.scanArchives(state, downloads, ignoredArchives);
            res.json({ configured: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // kind = the side that was just scanned/deleted ('staging' | 'archives'); this checks the
    // OTHER side for exact-basename matches, THEN re-validates each against Vortex's real state --
    // a name match alone isn't proof (see crossCheck's own header comment for the real near-miss
    // that made this necessary). Requires Vortex closed, same as the scans themselves.
    router.post('/cross-check', async (req, res) => {
        const { kind, names } = req.body || {};
        if (kind !== 'staging' && kind !== 'archives') {
            return res.status(400).json({ error: 'kind must be "staging" or "archives"' });
        }
        if (!Array.isArray(names) || names.length === 0) {
            return res.json({ matches: [] });
        }
        const otherDir = kind === 'staging' ? downloads : staging;
        if (!otherDir) return res.json({ matches: [] });
        if (vortexRunningGate(res)) return;
        try {
            const matches = await cleanupScan.crossCheck(state, kind, names, otherDir);
            res.json({ matches });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Deletes real files/folders -- permanent, no backup (confirmed with the user: these are
    // Vortex-recoverable via re-download or Rebuild Collection's re-extract, and Vortex itself would
    // flag the affected collection as incomplete if something still mattered). Every path is resolved
    // against the configured staging/downloads root and confirmed to still live directly under it
    // before deletion, so a malformed/crafted name can never escape to an arbitrary filesystem path.
    router.post('/delete', (req, res) => {
        if (vortexRunningGate(res)) return;
        const { kind, names } = req.body || {};
        if (kind !== 'staging' && kind !== 'archives') {
            return res.status(400).json({ error: 'kind must be "staging" or "archives"' });
        }
        const root = kind === 'staging' ? staging : downloads;
        if (!root) return res.status(400).json({ error: 'That folder is not configured.' });
        if (!Array.isArray(names) || names.length === 0) {
            return res.status(400).json({ error: 'No items given to delete.' });
        }
        const resolvedRoot = path.resolve(root) + path.sep;
        const paths = [];
        for (const name of names) {
            const full = path.resolve(root, name);
            if (!full.startsWith(resolvedRoot) || path.dirname(full) !== path.resolve(root)) {
                return res.status(400).json({ error: `Refusing to delete outside the configured folder: ${name}` });
            }
            paths.push(full);
        }
        const results = cleanupScan.deleteEntries(paths);
        res.json({ results });
    });

    // Adds name(s) to the permanent ignore list for that side, so a folder/archive the user has
    // confirmed is legitimate (e.g. a DynDOLOD/BodySlide output) never shows up as a candidate
    // again. Used by both the report's needsReview "Exclude" actions (array of names) and Settings'
    // "add one manually" field (single-element array).
    router.post('/exclude', (req, res) => {
        const { kind, names } = req.body || {};
        if (kind !== 'staging' && kind !== 'archives') {
            return res.status(400).json({ error: 'kind must be "staging" or "archives"' });
        }
        if (!Array.isArray(names) || names.length === 0) {
            return res.status(400).json({ error: 'No items given to exclude.' });
        }
        try {
            const data = excludeStore.load(cleanupExcludeListDir);
            const merged = [...new Set([...data[kind], ...names])].sort((a, b) => a.localeCompare(b));
            data[kind] = merged;
            excludeStore.save(cleanupExcludeListDir, data);
            res.json({ list: merged });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // Settings' "maintain the exclude list" section -- view both lists at once, and remove an entry
    // that shouldn't be permanently excluded anymore (it'll be re-evaluated on the next scan).
    router.get('/ignored', (req, res) => {
        res.json({ ...excludeStore.load(cleanupExcludeListDir), configured: !!cleanupExcludeListDir });
    });
    // Accepts either a single `name` or a `names` array (Settings' Remove Selected/Remove All send
    // an array; kept `name` too in case anything else ever wants to remove just one).
    router.post('/ignored/remove', (req, res) => {
        const { kind, name, names } = req.body || {};
        if (kind !== 'staging' && kind !== 'archives') {
            return res.status(400).json({ error: 'kind must be "staging" or "archives"' });
        }
        const toRemove = new Set(Array.isArray(names) ? names : name ? [name] : []);
        if (toRemove.size === 0) {
            return res.status(400).json({ error: 'No items given to remove.' });
        }
        try {
            const data = excludeStore.load(cleanupExcludeListDir);
            const updated = data[kind].filter((n) => !toRemove.has(n));
            data[kind] = updated;
            excludeStore.save(cleanupExcludeListDir, data);
            res.json({ list: updated });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createCleanupRouter };
