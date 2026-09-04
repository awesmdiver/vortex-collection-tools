'use strict';
// Thin Express handlers for the "Clean Up" report -- all real logic lives in lib/cleanup-scan.js.
// See TECHNICAL.md's "Clean Up report" section for the full design writeup.

const path = require('path');
const express = require('express');
const syncLib = require('../lib/vortex-sync/lib');
const cleanupScan = require('../lib/cleanup-scan');
const excludeStore = require('../lib/cleanup-exclude-store');
const helperClient = require('../lib/vortex-helper-client');
const { createSseSession } = require('./sse-session');

// Real SSE-streamed progress for scan-staging/scan-archives (2026-08-25, closes
// docs/UI-PATTERN-MAP.md's "Mod Scrub / Clean Up -- scan-staging / scan-archives" finding: static
// spinner, no SSE, not benchmarked-instant). Both scans are a single opaque
// cleanupScan.scanStaging(FromLiveData)/scanArchives(FromLiveData) call under the hood, with no
// internal per-item hook to report through -- same shape as Rules Generator's Analyze/Apply
// (web/rules-generator-routes.js), so this streams real phase text plus a live elapsed-time tick
// every second while the real call is in flight, rather than faking a percentage. Copied here (not
// imported) per this project's own "own tiny helpers, self-contained per file" convention.
function tickingPhase(emit, phase, message) {
    let seconds = 0;
    emit({ type: 'phase', phase, message, seconds });
    const timer = setInterval(() => {
        seconds += 1;
        emit({ type: 'phase', phase, message, seconds });
    }, 1000);
    return () => clearInterval(timer);
}

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
    //
    // Opportunistic helper-extension path (2026-08-18, same "remove the Vortex-must-be-closed
    // requirement" pattern already shipped for Cycle Helper/Rules Generator/Missing Masters -- see
    // TECHNICAL.md's "Clean Up report" section). Checked BEFORE vortexRunningGate, same as every
    // other helper-integrated route: source the live mods data from
    // helperClient.getAllMods()/getAllDownloads() when reachable, fall through to the exact
    // original gated state.v2 path, untouched, when it's not.
    const scanStagingSession = createSseSession();

    router.get('/scan-staging/events', (req, res) => {
        if (!scanStagingSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        scanStagingSession.subscribe(res, { afterSeq });
    });

    router.post('/scan-staging', async (req, res) => {
        // Not-configured is a genuine instant no-op -- answered synchronously, same shape as before
        // this task, no SSE session ever starts for it.
        if (!staging) return res.json({ configured: false, total: 0, exceptions: [], needsReview: [] });
        if (scanStagingSession.isActive()) {
            return res.status(409).json({ error: 'A scan is already in progress.' });
        }
        const mySession = scanStagingSession.start({ id: `cleanup-scan-staging-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (scanStagingSession.get() === mySession) scanStagingSession.emit(event);
        };

        (async () => {
            const stopTicking = tickingPhase(emitIfCurrent, 'scanning', 'Scanning your staging folder…');
            try {
                const { staging: ignoredStaging } = excludeStore.load(cleanupExcludeListDir);
                const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
                const modsData = helperAvailable ? await helperClient.getAllMods() : null;
                let source = 'state.v2';
                let result;
                if (modsData) {
                    source = 'helper-extension';
                    result = cleanupScan.scanStagingFromLiveData(modsData.mods, staging, ignoredStaging);
                } else {
                    // vortexRunningGate can't be used here -- the 202 response has already gone out,
                    // so a second res.status(...).json(...) would throw. Same inlined-check shape
                    // rules-generator-routes.js's own /analyze uses for its identical fallback gate.
                    if (syncLib.isVortexRunning()) {
                        stopTicking();
                        emitIfCurrent({
                            type: 'error', done: true, error: true, errorCode: 'vortex-running',
                            message: 'Vortex is currently running. Close it completely and try again.',
                        });
                        return;
                    }
                    result = await cleanupScan.scanStaging(state, staging, ignoredStaging);
                }
                stopTicking();
                emitIfCurrent({ type: 'done', done: true, configured: true, ...result, source });
            } catch (e) {
                stopTicking();
                emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
            }
        })();
    });

    // Needs BOTH getAllMods() (usedArchiveIds) and getAllDownloads() (the download-side lookups) --
    // only takes the helper path when BOTH calls succeed, so a "helper answered /mods but not
    // /downloads" moment falls all the way through to state.v2 rather than a partial/wrong result.
    const scanArchivesSession = createSseSession();

    router.get('/scan-archives/events', (req, res) => {
        if (!scanArchivesSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        scanArchivesSession.subscribe(res, { afterSeq });
    });

    router.post('/scan-archives', async (req, res) => {
        if (!downloads) return res.json({ configured: false, total: 0, exceptions: [], needsReview: [], hasUninstalledArchives: false });
        if (scanArchivesSession.isActive()) {
            return res.status(409).json({ error: 'A scan is already in progress.' });
        }
        const mySession = scanArchivesSession.start({ id: `cleanup-scan-archives-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (scanArchivesSession.get() === mySession) scanArchivesSession.emit(event);
        };

        (async () => {
            const stopTicking = tickingPhase(emitIfCurrent, 'scanning', 'Scanning your downloaded archives…');
            try {
                const { archives: ignoredArchives } = excludeStore.load(cleanupExcludeListDir);
                const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
                let modsData = null;
                let downloadsData = null;
                if (helperAvailable) {
                    modsData = await helperClient.getAllMods();
                    downloadsData = modsData ? await helperClient.getAllDownloads() : null;
                }
                let source = 'state.v2';
                let result;
                if (modsData && downloadsData) {
                    source = 'helper-extension';
                    result = cleanupScan.scanArchivesFromLiveData(modsData.mods, downloadsData.files, downloads, ignoredArchives);
                } else {
                    if (syncLib.isVortexRunning()) {
                        stopTicking();
                        emitIfCurrent({
                            type: 'error', done: true, error: true, errorCode: 'vortex-running',
                            message: 'Vortex is currently running. Close it completely and try again.',
                        });
                        return;
                    }
                    result = await cleanupScan.scanArchives(state, downloads, ignoredArchives);
                }
                stopTicking();
                emitIfCurrent({ type: 'done', done: true, configured: true, ...result, source });
            } catch (e) {
                stopTicking();
                emitIfCurrent({ type: 'error', done: true, error: true, message: e.message });
            }
        })();
    });

    // kind = the side that was just scanned/deleted ('staging' | 'archives'); this checks the
    // OTHER side for exact-basename matches, THEN re-validates each against Vortex's real state --
    // a name match alone isn't proof (see crossCheck's own header comment for the real near-miss
    // that made this necessary). Same opportunistic helper-extension path -- only ever needs ONE
    // side's live data (mods for kind==='archives', downloads for kind==='staging'), so only that
    // one call is made, same reasoning as crossCheckFromLiveData's own comment.
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
        try {
            const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
            let liveData = null;
            if (helperAvailable) {
                liveData = kind === 'archives' ? await helperClient.getAllMods() : await helperClient.getAllDownloads();
            }
            let source = 'state.v2';
            let matches;
            if (liveData) {
                source = 'helper-extension';
                matches = kind === 'archives'
                    ? cleanupScan.crossCheckFromLiveData(liveData.mods, null, kind, names, otherDir)
                    : cleanupScan.crossCheckFromLiveData(null, liveData.files, kind, names, otherDir);
            } else {
                if (vortexRunningGate(res)) return;
                matches = await cleanupScan.crossCheck(state, kind, names, otherDir);
            }
            res.json({ matches, source });
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
