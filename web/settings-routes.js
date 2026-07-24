'use strict';
// Settings page backend -- GET/POST for the single unified config.json (lib/app-config.js). The
// Nexus API key is a credential: GET never echoes the real value back (only a boolean flag saying
// one is stored), and POST only overwrites it when the caller actually sent a non-empty new value
// (an empty/omitted field on save means "leave it alone", not "clear it") -- clearing is a separate,
// explicit action so a blank form field can never accidentally wipe an already-configured key.

const express = require('express');
const appConfig = require('../lib/app-config');

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
        if ('backupEnabled' in body) patch.backupEnabled = !!body.backupEnabled;
        if (body.clearNexusApiKey) {
            patch.nexusApiKey = null;
        } else if (typeof body.nexusApiKey === 'string' && body.nexusApiKey.trim()) {
            patch.nexusApiKey = body.nexusApiKey.trim();
        }

        const restartRequired = PATH_FIELDS.some((k) => k in patch && patch[k] !== before[k]);
        const after = appConfig.saveConfig(patch);
        res.json({ ...withoutKey(after), restartRequired });
    });

    return router;
}

module.exports = { createSettingsRouter };
