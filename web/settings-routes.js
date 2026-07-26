'use strict';
// Settings page backend -- GET/POST for the single unified config.json (lib/app-config.js). The
// Nexus API key is a credential: GET never echoes the real value back (only a boolean flag saying
// one is stored), and POST only overwrites it when the caller actually sent a non-empty new value
// (an empty/omitted field on save means "leave it alone", not "clear it") -- clearing is a separate,
// explicit action so a blank form field can never accidentally wipe an already-configured key.

const fs = require('fs');
const path = require('path');
const express = require('express');
const appConfig = require('../lib/app-config');
const { pickFolderAsync } = require('../lib/vortex-sync/win-dialog');

// Every real backup-run folder this project ever creates is named "<collectionModId>-<runTimestamp>"
// (see lib/collection-runner.js's runBackup(), and pruneOldBackups()'s own "<collectionModId>-"
// prefix match) where runTimestamp is `new Date().toISOString().replace(/[:.]/g, '-')`, e.g.
// "...-2026-07-24T18-26-16-750Z". The "Delete all backups" button below matches this suffix before
// touching anything -- a safety net so a misconfigured backupRoot (accidentally pointed at a shared/
// reused folder) can't have unrelated content wiped by this one-click destructive action.
const BACKUP_RUN_DIR_PATTERN = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function listBackupRunDirs(backupRoot) {
    let entries;
    try {
        entries = fs.readdirSync(backupRoot, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.filter((e) => e.isDirectory() && BACKUP_RUN_DIR_PATTERN.test(e.name)).map((e) => e.name);
}

const PATH_FIELDS = ['staging', 'downloads', 'backupRoot', 'syncBackupRoot', 'state'];
// No sensible blank/default state for these three -- Rebuild Collection can't scan a collection
// without staging/downloads, and Update Collection can't save a backup without somewhere real
// (not "wherever this project happens to think is a good place") to put it. backupRoot/state are
// deliberately NOT required: backupRoot only matters if maxBackupsToKeep is turned on (0 = off,
// the default), and state auto-detects a real default under %APPDATA%.
const REQUIRED_PATH_FIELDS = ['staging', 'downloads', 'syncBackupRoot'];
// Server bind settings -- like the paths above, these are only read once at process startup
// (web/server.js), so changing any of them needs the same restart-required treatment.
const SERVER_FIELDS = ['serverPort', 'serverHost', 'autoOpenBrowser'];

function withoutKey(cfg) {
    const { nexusApiKey, ...rest } = cfg;
    return { ...rest, hasNexusApiKey: !!nexusApiKey };
}

function createSettingsRouter() {
    const router = express.Router();

    router.get('/', (req, res) => {
        res.json(withoutKey(appConfig.loadConfig()));
    });

    router.post('/', (req, res) => {
        const body = req.body || {};
        const before = appConfig.loadConfig();
        const patch = {};

        for (const key of PATH_FIELDS) {
            if (key in body) patch[key] = (body[key] || '').trim() || null;
        }
        // One field does double duty: null = unlimited (back up every run, keep forever); 0 = off
        // (don't back up at all); 1-3 = back up every run, prune down to the N most recent after.
        if ('maxBackupsToKeep' in body) {
            const raw = body.maxBackupsToKeep;
            if (raw === null || raw === '' || raw === undefined) {
                patch.maxBackupsToKeep = null;
            } else {
                const n = Number(raw);
                patch.maxBackupsToKeep = Number.isFinite(n) ? Math.min(3, Math.max(0, Math.floor(n))) : null;
            }
        }
        // Always a plain 1-8 integer -- unlike maxBackupsToKeep, there's no meaningful "unlimited"
        // here, so an invalid/blank value just falls back to 1 (sequential), never null.
        if ('concurrentExtractions' in body) {
            const n = Number(body.concurrentExtractions);
            patch.concurrentExtractions = Number.isFinite(n) ? Math.min(8, Math.max(1, Math.floor(n))) : 1;
        }
        if (body.clearNexusApiKey) {
            patch.nexusApiKey = null;
        } else if (typeof body.nexusApiKey === 'string' && body.nexusApiKey.trim()) {
            patch.nexusApiKey = body.nexusApiKey.trim();
        }

        if ('serverPort' in body) {
            const n = Number(body.serverPort);
            patch.serverPort = Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : 4321;
        }
        if ('serverHost' in body) {
            patch.serverHost = (body.serverHost || '').trim() || '127.0.0.1';
        }
        if ('autoOpenBrowser' in body) {
            patch.autoOpenBrowser = !!body.autoOpenBrowser;
        }
        // Read fresh per-run (like maxBackupsToKeep/concurrentExtractions) -- deliberately NOT added
        // to PATH_FIELDS/SERVER_FIELDS, so toggling it never triggers restartRequired.
        if ('downloadMissingArchives' in body) {
            patch.downloadMissingArchives = !!body.downloadMissingArchives;
        }
        if ('forceExtractOffSiteMismatches' in body) {
            patch.forceExtractOffSiteMismatches = !!body.forceExtractOffSiteMismatches;
        }
        if ('hideVortexVersionWarning' in body) {
            patch.hideVortexVersionWarning = !!body.hideVortexVersionWarning;
        }

        // Server-side backstop for the required fields -- the Settings page itself already blocks
        // Save client-side, but this defends against a corrupt/manually-edited config.json (or any
        // future non-web caller) ending up with one of these blank via this same endpoint.
        const merged = { ...before, ...patch };
        const missing = REQUIRED_PATH_FIELDS.filter((k) => !merged[k]);
        if (missing.length > 0) {
            return res.status(400).json({ error: 'missing-required', missing, message: `Required setting(s) missing: ${missing.join(', ')}.` });
        }

        const restartRequired = [...PATH_FIELDS, ...SERVER_FIELDS].some((k) => k in patch && patch[k] !== before[k]);
        const after = appConfig.saveConfig(patch);
        res.json({ ...withoutKey(after), restartRequired });
    });

    // Native folder-browser dialog for the path fields' "Browse..." buttons -- runs on the SAME
    // machine as the browser (this whole tool assumes that), so a server-side native dialog is a
    // real option, unlike a browser file input (which never exposes a real absolute OS path).
    router.post('/browse-folder', async (req, res) => {
        const { initialDir, title } = req.body || {};
        try {
            const picked = await pickFolderAsync({ title: title || 'Select a folder', initialDir: initialDir || undefined });
            res.json({ path: picked });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Read-only count for the "Delete all backups" confirmation dialog -- lets the client show a
    // real, specific number ("This will delete N backup(s)") before the user commits, rather than a
    // vague "are you sure?".
    router.get('/backups-info', (req, res) => {
        const { backupRoot } = appConfig.loadConfig();
        if (!backupRoot) return res.json({ backupRoot: null, count: 0 });
        res.json({ backupRoot, count: listBackupRunDirs(backupRoot).length });
    });

    // Deletes every real backup-run folder under the configured backupRoot -- permanent, no undo.
    // Only touches folders matching BACKUP_RUN_DIR_PATTERN (see its own comment above); anything else
    // sitting in backupRoot is left alone.
    router.post('/delete-backups', (req, res) => {
        const { backupRoot } = appConfig.loadConfig();
        if (!backupRoot) return res.status(400).json({ error: 'No backup root folder is configured.' });
        const dirs = listBackupRunDirs(backupRoot);
        for (const name of dirs) {
            fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
        }
        res.json({ deletedCount: dirs.length });
    });

    return router;
}

module.exports = { createSettingsRouter };
