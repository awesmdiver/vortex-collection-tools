'use strict';
// Mod Exceptions -- thin Express handlers over lib/mod-exception-store.js. SHARED by two entry
// points: Rebuild Missing Files' own per-row "Add to Exception List" quick-add action, and the
// Reports > Mod Exceptions sub-tab (view/add/remove the whole list). Neither Rebuild Collection nor
// Rebuild Missing Files' /scan route calls into this router directly -- they read the store's own
// makeExceptionMatcher() straight from lib/mod-exception-store.js instead; this router only exists
// for the UI's own list-management actions (queue: rebuild-missing-hand-pick-exceptions).

const express = require('express');
const modExceptionStore = require('../lib/mod-exception-store');
const appConfig = require('../lib/app-config');

function createModExceptionsRouter() {
    const router = express.Router();

    router.get('/', (req, res) => {
        const { modExceptionListDir } = appConfig.loadConfig();
        const { mods } = modExceptionStore.load(modExceptionListDir);
        res.json({ mods, configured: !!modExceptionListDir });
    });

    // Accepts name (required) and modId (optional, Nexus mod id -- NOT fileId, see the store's own
    // header for why). Case-insensitive de-dupe on name so clicking "Add to Exception List" twice
    // for the same mod (e.g. from two different collections' scan rows) doesn't create two entries.
    router.post('/add', (req, res) => {
        const { name, modId } = req.body || {};
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'A mod name is required.' });
        }
        const { modExceptionListDir } = appConfig.loadConfig();
        try {
            const data = modExceptionStore.load(modExceptionListDir);
            const normalized = modExceptionStore.normalizeName(name);
            const already = data.mods.some((m) => modExceptionStore.normalizeName(m.name) === normalized);
            if (!already) {
                data.mods.push({ name: name.trim(), modId: modId != null ? modId : null, addedAt: new Date().toISOString() });
                modExceptionStore.save(modExceptionListDir, data);
            }
            res.json({ mods: data.mods });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // Removes by name (case-insensitive) -- the same identity a row's own "Remove" action always
    // has on hand, whether triggered from the Reports tab's own list or (in principle) anywhere
    // else this list is ever surfaced.
    router.post('/remove', (req, res) => {
        const { name } = req.body || {};
        if (!name) {
            return res.status(400).json({ error: 'A mod name is required.' });
        }
        const { modExceptionListDir } = appConfig.loadConfig();
        try {
            const data = modExceptionStore.load(modExceptionListDir);
            const normalized = modExceptionStore.normalizeName(name);
            data.mods = data.mods.filter((m) => modExceptionStore.normalizeName(m.name) !== normalized);
            modExceptionStore.save(modExceptionListDir, data);
            res.json({ mods: data.mods });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createModExceptionsRouter };
