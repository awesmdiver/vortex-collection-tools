'use strict';
// File Retriever (2026-09-01) -- see lib/file-retriever-runner.js's own header comment for the full
// real design (the `uid`/category research, the two download paths). This file is just the thin
// HTTP layer: lookup + download, SSE progress for the direct-download path only (the website-
// fallback path needs no server-side work at all -- every file's own websiteUrl already comes back
// on the lookup response, the frontend just opens them).

const express = require('express');
const nexusModDownload = require('../lib/nexus-mod-download');
const fileRetriever = require('../lib/file-retriever-runner');
const appConfig = require('../lib/app-config');
const { createSseSession } = require('./sse-session');

const downloadSession = createSseSession();

function createFileRetrieverRouter() {
    const router = express.Router();

    // Resolves the configured Nexus API key, or null (never throws) -- every route below checks
    // this once up front and returns the same "not-configured" shape a missing Settings field
    // already gets elsewhere in this app, rather than letting resolveApiKey()'s own thrown error
    // surface as an opaque 500.
    function tryResolveApiKey() {
        try {
            return nexusModDownload.resolveApiKey();
        } catch {
            return null;
        }
    }

    // Frontend's own "which download path is about to happen" check -- read BEFORE showing the
    // destination screen (per the director's own spec: check Premium status before rendering that
    // screen, not after), not baked into the lookup response, since Premium status can change
    // independently of which mod is being looked at. Also carries the last-remembered destination
    // folder (2026-09-01) -- the Screen 3 pre-fill needs both pieces the moment that screen renders,
    // so this saves a second round trip rather than a separate GET for just the folder.
    router.get('/premium-status', async (req, res) => {
        const lastDestFolder = appConfig.loadConfig().fileRetrieverLastDestFolder || null;
        const apiKey = tryResolveApiKey();
        if (!apiKey) return res.json({ configured: false, isPremium: false, lastDestFolder });
        try {
            const status = await nexusModDownload.checkPremiumStatus(apiKey);
            res.json({ configured: true, isPremium: status.isPremium, lastDestFolder });
        } catch (e) {
            res.json({ configured: true, isPremium: false, lastDestFolder, error: e.message });
        }
    });

    // Silently remembers the destination folder for next time -- NOT a Settings-page field
    // (director's own explicit call, see app-config.js's own comment on fileRetrieverLastDestFolder
    // for the full reasoning); this is the tool's own convenience write, same
    // appConfig.saveConfig(partial) merge-and-write every real Settings save already uses, just
    // triggered from here instead of the Settings page. Best-effort/non-blocking by design on the
    // frontend side -- a failure here should never stop a real download from proceeding.
    router.post('/remember-destination', (req, res) => {
        const destDir = (req.body?.destDir || '').trim();
        if (!destDir) return res.status(400).json({ error: 'Missing destDir.' });
        appConfig.saveConfig({ fileRetrieverLastDestFolder: destDir });
        res.json({ ok: true });
    });

    // Shared by /lookup and /download -- validates the frontend's game-picker selection against the
    // real Nexus domain slugs this tool knows about, rather than passing an arbitrary caller-supplied
    // string straight through to the Nexus API. Falls back to Skyrim SE when omitted so any existing
    // caller (or a stale cached frontend) keeps working unchanged.
    function resolveGameDomain(raw) {
        const domain = (raw || fileRetriever.NEXUS_SE_GAME_DOMAIN).toLowerCase();
        return fileRetriever.NEXUS_GAME_DOMAINS[domain] ? domain : null;
    }

    router.post('/lookup', async (req, res) => {
        const apiKey = tryResolveApiKey();
        if (!apiKey) {
            return res.status(400).json({ error: 'not-configured', message: 'Enter a Nexus API key on the Settings page first.' });
        }
        const modId = Number(req.body?.modId);
        if (!modId || !Number.isInteger(modId) || modId <= 0) {
            return res.status(400).json({ error: 'Enter a valid Nexus mod ID (a positive whole number).' });
        }
        const gameDomain = resolveGameDomain(req.body?.gameDomain);
        if (!gameDomain) {
            return res.status(400).json({ error: 'Unrecognized game.' });
        }
        try {
            const result = await fileRetriever.lookupMod({ apiKey, gameDomain, modId });
            res.json(result);
        } catch (e) {
            const status = e.code === 'NOT_FOUND' ? 404 : 502;
            res.status(status).json({ error: e.message });
        }
    });

    router.get('/download/events', (req, res) => {
        if (!downloadSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        downloadSession.subscribe(res, { afterSeq });
    });

    // Direct-download path only (Premium). The website-fallback path is entirely client-side -- see
    // this file's own header comment -- so it never reaches this route at all.
    router.post('/download', async (req, res) => {
        const apiKey = tryResolveApiKey();
        if (!apiKey) {
            return res.status(400).json({ error: 'not-configured', message: 'Enter a Nexus API key on the Settings page first.' });
        }
        if (downloadSession.isActive()) {
            return res.status(409).json({ error: 'A File Retriever download is already in progress.' });
        }
        const modId = Number(req.body?.modId);
        const files = Array.isArray(req.body?.files) ? req.body.files : [];
        const destDir = (req.body?.destDir || '').trim();
        if (!modId || files.length === 0) {
            return res.status(400).json({ error: 'Missing modId or files to download.' });
        }
        if (!destDir) {
            return res.status(400).json({ error: 'Choose a destination folder first.' });
        }
        const gameDomain = resolveGameDomain(req.body?.gameDomain);
        if (!gameDomain) {
            return res.status(400).json({ error: 'Unrecognized game.' });
        }

        const mySession = downloadSession.start({ id: `file-retriever-${Date.now()}` });
        res.status(202).json({});

        try {
            const results = await fileRetriever.downloadSelected({
                apiKey, gameDomain, modId, files, destDir,
                onProgress: (event) => { if (downloadSession.get() === mySession) downloadSession.emit(event); },
            });
            const allOk = results.every((r) => r.ok !== false);
            if (downloadSession.get() === mySession) downloadSession.emit({ type: 'done', done: true, error: !allOk, results, destDir });
        } catch (e) {
            if (downloadSession.get() === mySession) downloadSession.emit({ type: 'error', done: true, error: true, message: e.message });
        }
    });

    return router;
}

module.exports = { createFileRetrieverRouter };
