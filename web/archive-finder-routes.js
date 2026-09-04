'use strict';
// Archive Finder -- folded in 2026-07-28 from the standalone "Archive File Finder" project (see
// TECHNICAL.md's "Archive Finder" section for the full writeup and what got reused vs. rebuilt).
//
// Reuses this project's existing pieces rather than duplicating them:
//   - `downloads` (the existing, already-required Vortex downloads folder setting) IS the scan
//     folder -- no separate "scan folder" field, since it's the exact same folder Rebuild
//     Collection already uses.
//   - lib/sevenzip.js (this project's own copy, a strict superset of the standalone tool's own --
//     see lib/archive-finder-scanner.js's own header comment for the specific fixes it carries).
//   - The generic `/api/settings/browse-folder` endpoint for BOTH the Settings page's own Browse
//     buttons AND this page's own ad-hoc "pick an extraction destination" dialog -- no dedicated
//     pick-folder route here.
//   - web/sse-session.js for scan progress, matching Rebuild Collection's own plan/run-progress
//     streaming convention (POST starts a session + responds 202, GET .../events subscribes),
//     instead of the standalone tool's own bespoke raw-http SSE implementation.
//
// The archive/file index database is opened LAZILY (on first real use) and closed again after a
// period of inactivity -- see getDb()/dbHandle below (lib/idle-close-handle.js). archiveFinderDbDir/downloads are
// still real Settings path fields needing a restart to pick up a CHANGE (same treatment every other
// configured folder in this project gets); what changed (2026-08-27, GitHub issue #4) is that the
// database connection itself is no longer opened once at router-creation time and held for the
// entire life of the server -- that handle was a real WAL-locked file sitting inside whatever
// folder the user configured, for as long as the server ran, with nothing ever closing it. If that
// folder is one Vortex itself actively manages (its downloads folder, its staging/mods folder), the
// held-open handle can produce a genuine "File busy" error FOR VORTEX. See
// lib/vortex-managed-paths.js and this file's own settings-side validation
// (web/settings-routes.js) for the other half of that fix -- this file's job is only to stop
// holding the handle open for the process's whole lifetime.

const fs = require('fs');
const path = require('path');
const express = require('express');
const appConfig = require('../lib/app-config');
const { createDb } = require('../lib/archive-finder-db');
const scanner = require('../lib/archive-finder-scanner');
const sevenzip = require('../lib/sevenzip');
const { buildTree } = require('../lib/archive-finder-tree');
const { createSseSession } = require('./sse-session');
const { createIdleCloseHandle } = require('../lib/idle-close-handle');

const scanSession = createSseSession();

// How long the database connection is allowed to sit open with no activity before it's closed --
// generous enough that a user actively poking around (typing a search, browsing an archive tree)
// never sees it churn open/closed between clicks, short enough that "closed the app tab an hour
// ago" doesn't mean "held a handle in Vortex's folder for the rest of the day." Deliberately NOT
// configurable -- this is an implementation detail, not something a user should ever need to think
// about (same reasoning as this project not exposing e.g. HTTP keep-alive timeouts).
const DB_IDLE_CLOSE_MS = 5 * 60 * 1000;

function createArchiveFinderRouter(config) {
    const router = express.Router();
    const { downloads, staging, archiveFinderDbDir } = config;

    // The idle-close TIMING logic itself lives in lib/idle-close-handle.js -- a small, independently
    // unit-tested (with a short delay, since production's real 5-minute wait can't practically be
    // exercised in a test) module, rather than inline here. isBusy: never close mid-scan -- a scan
    // can run far longer than the idle window and holds its OWN direct reference to whatever
    // instance open() returns (see /scan below); closing out from under it would break the
    // in-progress writes. scanSession.isActive() is true for the scan's whole duration (start
    // through 'done'/'error'), so the handle checks again after the same window instead of closing
    // while it's still true.
    const dbHandle = createIdleCloseHandle({
        idleMs: DB_IDLE_CLOSE_MS,
        isBusy: () => scanSession.isActive(),
        open: () => {
            try {
                const db = createDb(archiveFinderDbDir, { downloads, staging });
                if (db.migration && db.migration.status !== 'none') {
                    console.log(`[archive-finder] legacy database migration: ${JSON.stringify(db.migration)}`);
                }
                return db;
            } catch (e) {
                // Logged HERE (inside open(), which createIdleCloseHandle only calls once per
                // failure cycle -- it caches the error and skips retrying open() on every
                // subsequent get() until the next idle-close cycle clears it) rather than in
                // getDb() below, which runs on EVERY request -- logging there would spam the
                // console once per request while genuinely misconfigured.
                console.error(`[archive-finder] could not open the database: ${e.message}`);
                throw e;
            }
        },
        close: (db) => db.close(),
    });

    // Opens (or returns the already-open) database connection, resetting the idle-close timer on
    // every call so genuine activity keeps it alive. Returns null (never throws) if
    // archiveFinderDbDir isn't configured at all, or if the last open attempt failed --
    // requireConfigured()/notConfiguredMessage() below surface the real reason via
    // dbHandle.getError().
    function getDb() {
        if (!archiveFinderDbDir) return null;
        return dbHandle.get();
    }

    function notConfiguredMessage() {
        const missing = [];
        if (!downloads) missing.push('Vortex downloads folder');
        if (!archiveFinderDbDir) missing.push('Archive Finder database folder');
        if (missing.length > 0) return `Set up the ${missing.join(' and ')} under Settings first.`;
        // Both fields ARE set, so getDb() must have hit a real open failure -- surface its own
        // message (e.g. the Vortex-managed-folder refusal, or a foreign-database refusal) directly,
        // rather than the generic "set these up" wording, which would be actively misleading here.
        const err = dbHandle.getError();
        return err ? err.message : 'Archive Finder database is not available right now.';
    }

    function requireConfigured(res) {
        if (getDb() && downloads) return true;
        res.status(400).json({ error: 'not-configured', message: notConfiguredMessage() });
        return false;
    }

    // Combined "am I ready to use, and what's currently configured" check for the page's own
    // initial load -- configured=false lets the client show a plain setup message instead of a
    // real error, same convention as missing-masters-routes.js's own /scan.
    router.get('/config', (req, res) => {
        const { archiveFinderOutputDir, archiveFinderExtensions } = appConfig.loadConfig();
        res.json({
            configured: !!(getDb() && downloads),
            configError: !getDb() && archiveFinderDbDir && downloads ? notConfiguredMessage() : null,
            downloads: downloads || null,
            outputFolder: archiveFinderOutputDir || '',
            extensions: archiveFinderExtensions || ['.esp'],
        });
    });

    // Only ever called with { extensions } -- outputFolder is remembered automatically after a
    // successful extraction (see /extract below), and downloads/archiveFinderDbDir are real
    // Settings-page path fields (web/settings-routes.js), not editable from here.
    router.post('/config', (req, res) => {
        const { extensions } = req.body || {};
        if (!Array.isArray(extensions) || extensions.length === 0) {
            return res.status(400).json({ error: 'At least one file extension is required.' });
        }
        appConfig.saveConfig({ archiveFinderExtensions: extensions });
        res.json({ extensions });
    });

    router.get('/stats', (req, res) => {
        if (!requireConfigured(res)) return;
        res.json(getDb().stats());
    });

    router.get('/search', (req, res) => {
        if (!requireConfigured(res)) return;
        const archiveDb = getDb();
        const q = (req.query.q || '').trim();
        const mode = req.query.mode === 'archives' ? 'archives' : 'files';
        if (!q) return res.json([]);
        if (mode === 'archives') return res.json(archiveDb.searchArchives(q));
        const { archiveFinderExtensions } = appConfig.loadConfig();
        const extensions = (archiveFinderExtensions || ['.esp']).map((e) => e.toLowerCase());
        res.json(archiveDb.search(q, extensions));
    });

    router.get('/archive-tree', async (req, res) => {
        if (!requireConfigured(res)) return;
        const id = Number(req.query.id);
        const archive = getDb().getArchiveById(id);
        if (!archive) return res.status(404).json({ error: 'Unknown archive id' });
        try {
            const exePath = sevenzip.findSevenZip();
            const entries = await sevenzip.listArchive(exePath, archive.path);
            const tree = buildTree(entries);
            res.json({ archiveId: archive.id, archiveName: archive.name, archivePath: archive.path, tree });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/scan/events', (req, res) => {
        if (!scanSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        scanSession.subscribe(res, { afterSeq });
    });

    router.post('/scan', (req, res) => {
        if (!requireConfigured(res)) return;
        if (scanSession.isActive()) {
            return res.status(409).json({ error: 'A scan is already in progress' });
        }
        const { archiveFinderExtensions } = appConfig.loadConfig();
        const extensions = archiveFinderExtensions || ['.esp'];
        const mySession = scanSession.start({ id: `scan-${Date.now()}` });
        res.status(202).json({});

        // getDb() called explicitly here (not just via requireConfigured() above) -- this is the ONE
        // reference the scanner keeps and calls repeatedly across the whole scan's lifetime (many
        // async ticks, potentially many minutes for a large downloads folder), so it must resolve to
        // an already-open, idle-timer-reset instance before scanning starts. scanSession.isActive()
        // (true from scanSession.start() above until 'done'/'error' fires) is what keeps the idle
        // handle's own timer from pulling this same instance out from under the scan mid-run -- see
        // lib/idle-close-handle.js's own isBusy comment.
        const emitter = scanner.scan({ scanFolder: downloads, extensions, archiveDb: getDb() });
        const emitIfCurrent = (event) => {
            if (scanSession.get() === mySession) scanSession.emit(event);
        };
        emitter.on('progress', (d) => emitIfCurrent({ type: 'progress', ...d }));
        emitter.on('done', (d) => {
            emitIfCurrent({ type: 'done', ...d, done: true });
            dbHandle.touch(); // restart the idle clock from NOW, not from whenever getDb() last happened to be called mid-scan
        });
        emitter.on('error', (d) => {
            emitIfCurrent({ type: 'error', ...d, done: true, error: true });
            dbHandle.touch();
        });
    });

    router.get('/failed-archives', (req, res) => {
        if (!requireConfigured(res)) return;
        res.json(getDb().getFailedArchives());
    });

    router.post('/failed-archives/untrack', (req, res) => {
        if (!requireConfigured(res)) return;
        const archiveDb = getDb();
        const archiveIds = Array.isArray(req.body?.archiveIds) ? req.body.archiveIds : [];
        const results = archiveIds.map((id) => {
            const archive = archiveDb.getArchiveById(id);
            if (!archive) return { archiveId: id, ok: false, error: 'Unknown archive id' };
            archiveDb.deleteArchive(id);
            return { archiveId: id, ok: true };
        });
        res.json({ results });
    });

    // Permanent, no undo -- path-validated against the configured downloads folder first, same
    // "cheap defense-in-depth" reasoning as every other folder-scoped write in this project.
    router.post('/failed-archives/delete-file', (req, res) => {
        if (!requireConfigured(res)) return;
        const archiveDb = getDb();
        const archiveIds = Array.isArray(req.body?.archiveIds) ? req.body.archiveIds : [];
        const downloadsResolved = path.resolve(downloads);
        const results = archiveIds.map((id) => {
            const archive = archiveDb.getArchiveById(id);
            if (!archive) return { archiveId: id, ok: false, error: 'Unknown archive id' };
            const resolved = path.resolve(archive.path);
            if (resolved !== downloadsResolved && !resolved.startsWith(downloadsResolved + path.sep)) {
                return { archiveId: id, ok: false, error: 'Archive path is outside the configured downloads folder; refusing to delete' };
            }
            try {
                fs.unlinkSync(resolved);
                archiveDb.deleteArchive(id);
                return { archiveId: id, ok: true };
            } catch (e) {
                return { archiveId: id, ok: false, error: e.message };
            }
        });
        res.json({ results });
    });

    router.post('/extract', async (req, res) => {
        if (!requireConfigured(res)) return;
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        const flat = !!req.body?.flat;
        const { archiveFinderOutputDir } = appConfig.loadConfig();
        const outputFolder = (req.body?.outputFolder && String(req.body.outputFolder).trim()) || archiveFinderOutputDir;
        if (!outputFolder) {
            return res.status(400).json({ error: 'No destination folder set. Choose one in the extract dialog.' });
        }
        if (outputFolder !== archiveFinderOutputDir) {
            appConfig.saveConfig({ archiveFinderOutputDir: outputFolder }); // remember as the default for next time
        }
        const exePath = sevenzip.findSevenZip();
        const results = [];

        // Tracks names already placed in each destination folder so two files sharing a basename
        // (common in flat mode, or same-name files across subfolders of one archive) don't
        // silently overwrite one another.
        const usedNamesByDir = new Map();
        function reserveName(destDir, fileName) {
            if (!usedNamesByDir.has(destDir)) {
                const seed = new Set();
                try {
                    for (const existing of fs.readdirSync(destDir)) seed.add(existing.toLowerCase());
                } catch {
                    // dir doesn't exist yet
                }
                usedNamesByDir.set(destDir, seed);
            }
            const used = usedNamesByDir.get(destDir);
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            let candidate = fileName;
            let n = 2;
            while (used.has(candidate.toLowerCase())) {
                candidate = `${base} (${n})${ext}`;
                n++;
            }
            used.add(candidate.toLowerCase());
            return candidate;
        }

        for (const item of items) {
            const archivePath = item.archivePath;
            const internalPath = item.internalPath;
            const key = `${archivePath}|${internalPath}`;
            if (!archivePath || !internalPath) {
                results.push({ key, ok: false, error: 'Missing archivePath/internalPath' });
                continue;
            }
            const archiveName = path.basename(archivePath);
            const archiveBase = path.basename(archiveName, path.extname(archiveName));
            const destDir = flat ? outputFolder : path.join(outputFolder, archiveBase);
            const fileName = path.basename(internalPath);
            const desiredName = reserveName(destDir, fileName);
            try {
                let extractedPath = await sevenzip.extractFile(exePath, archivePath, internalPath, destDir);
                if (path.basename(extractedPath) !== desiredName) {
                    const finalPath = path.join(destDir, desiredName);
                    fs.renameSync(extractedPath, finalPath);
                    extractedPath = finalPath;
                }
                results.push({ key, ok: true, path: extractedPath });
            } catch (e) {
                results.push({ key, ok: false, error: e.message });
            }
        }
        res.json({ outputFolder, results });
    });

    return router;
}

module.exports = { createArchiveFinderRouter };
