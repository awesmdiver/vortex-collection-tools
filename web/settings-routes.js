'use strict';
// Settings page backend -- GET/POST for the single unified config.json (lib/app-config.js). The
// Nexus API key is a credential: GET never echoes the real value back (only a boolean flag saying
// one is stored), and POST only overwrites it when the caller actually sent a non-empty new value
// (an empty/omitted field on save means "leave it alone", not "clear it") -- clearing is a separate,
// explicit action so a blank form field can never accidentally wipe an already-configured key.

const express = require('express');
const appConfig = require('../lib/app-config');
const { pickFolderAsync } = require('../lib/vortex-sync/win-dialog');

const PATH_FIELDS = ['staging', 'downloads', 'backupRoot', 'state'];

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
        if (body.clearNexusApiKey) {
            patch.nexusApiKey = null;
        } else if (typeof body.nexusApiKey === 'string' && body.nexusApiKey.trim()) {
            patch.nexusApiKey = body.nexusApiKey.trim();
        }

        const restartRequired = PATH_FIELDS.some((k) => k in patch && patch[k] !== before[k]);
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

    return router;
}

module.exports = { createSettingsRouter };
