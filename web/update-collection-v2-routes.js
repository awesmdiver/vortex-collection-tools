'use strict';
// Thin Express handlers for Update Collection v2 -- Phase 1 (read-only Check for Updates + Review)
// plus Phase 2 (real Apply for Updated + Removed mods only -- Added/Optional Installs are Phase 3).
// All real logic lives in lib/update-collection-v2-runner.js + lib/collection-diff.js. See
// TECHNICAL.md's "Update Collection v2" section for the full design writeup.

const express = require('express');
const runner = require('../lib/update-collection-v2-runner');
const { createSseSession } = require('./sse-session');

function createUpdateCollectionV2Router(config) {
    const router = express.Router();
    const { staging, downloads, state, syncBackupRoot } = config;

    // One real check-updates pass, automatically, the moment the server process starts (this factory
    // runs exactly once, at server startup -- see web/server.js's own single `createUpdateCollectionV2
    // Router(config)` call). Director's own explicit model: "when you start Vortex it will do a
    // collection refresh... let's do the same." Fire-and-forget -- never blocks the server from
    // listening, and a failure (Vortex running, no API key configured yet) lands in the cache's own
    // `error` field rather than crashing startup (runner.refreshCollectionsCache never throws). The
    // very first page load, if it beats this to finishing, sees `refreshing:true` from GET
    // /collections below and polls -- see that route's own comment.
    if (staging) {
        runner.refreshCollectionsCache({ staging, state }).catch(() => {});
    }

    // Returns the SHARED server-side cache directly (2026-08-18 -- this route used to be a plain
    // local-only listing with no revision/image data at all, "never fetched implicitly here"; that's
    // no longer true, see the startup auto-refresh above and the manual /check-updates below, which
    // both write into the SAME cache runner.getCollectionsCache() reads). Still never makes a Nexus
    // call itself -- purely a cache read, instant either way. `refreshing:true` with `collections:
    // null` means the startup auto-refresh (or a manual Refresh) is still in flight -- the frontend
    // polls this same route again shortly rather than showing a blank/stale state.
    router.get('/collections', (req, res) => {
        if (!staging) return res.json({ collections: [], configured: false, refreshing: false, checkedAt: null });
        try {
            const local = runner.listCollections(staging).map((c) => ({
                modId: c.modId, name: c.name, author: c.author, modCount: c.modCount,
            }));
            const cache = runner.getCollectionsCache();
            // Cache not populated yet (still refreshing, or the auto-refresh hasn't run at all for
            // some reason) -- fall back to the plain local listing so the page at least shows real
            // names/mod counts immediately, never a totally empty grid while waiting.
            const collections = cache.collections || local;
            res.json({
                collections, configured: true, refreshing: cache.refreshing,
                checkedAt: cache.checkedAt, source: cache.source, error: cache.error,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // The manual "Refresh" button (renamed from "Check for Updates" to match the new mental model --
    // see TECHNICAL.md) -- resolves each collection's real Nexus slug + installed revision
    // (helper-first, state.v2 fallback, see the runner's own comment) and compares against the
    // newest published revision. Now goes through refreshCollectionsCache so this writes into the
    // SAME cache the startup auto-refresh populates, rather than being a second, separate mechanism
    // -- GET /collections immediately reflects whatever this call just found. A real 409
    // (vortex-running) only ever surfaces from the state.v2 fallback branch, same shape every other
    // gated route in this project already returns.
    router.post('/check-updates', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const result = await runner.refreshCollectionsCache({ staging, state });
        if (result.error) {
            // refreshCollectionsCache swallows the real error into the cache rather than throwing --
            // errorCode preserves checkForUpdates' own real error code, so this returns the exact
            // same VORTEX_RUNNING 409 shape every other route here returns.
            if (result.errorCode === 'VORTEX_RUNNING') {
                return res.status(409).json({ error: 'vortex-running', message: result.error });
            }
            return res.status(500).json({ error: result.error });
        }
        res.json({ collections: result.collections, source: result.source });
    });

    // "Review update" -- downloads the newest revision's real collection.json from Nexus and diffs
    // it against the currently-installed one. Same VORTEX_RUNNING handling as /check-updates.
    router.post('/review', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'No collection given to review.' });
        }
        try {
            const result = await runner.reviewUpdate({ collectionModId, staging, state });
            res.json(result);
        } catch (e) {
            if (e.code === 'VORTEX_RUNNING') {
                return res.status(409).json({ error: 'vortex-running', message: e.message });
            }
            res.status(500).json({ error: e.message });
        }
    });

    // Phase 2/3's real Apply -- Updated mods get re-extracted+metadata-refreshed+redeployed, Removed
    // mods get either fully uninstalled or left alone per removedChoice, Added mods get installed for
    // real. Requires the helper extension reachable -- see the runner's own HELPER_UNAVAILABLE
    // handling; there is no state.v2 fallback for this route, unlike every read route in this file,
    // since deploy/remove/metadata-refresh are real Vortex actions with no database-row equivalent
    // this project could otherwise write directly.
    //
    // Real, live streamed progress (2026-08-21) -- mirrors web/pgpatcher-routes.js's own /build +
    // /build/events shape exactly (same POST-kicks-off-then-SSE-streams-progress pattern, same
    // createSseSession primitive): a real multi-phase pipeline (re-review, backup, per-mod extraction/
    // install, rule application, a full deploy) used to run as ONE blocking request with no feedback
    // beyond a static "Applying…" button and a narrow side-channel poll that only ever covered the
    // final deploy step (ucv2StartApplyProgressPolling/GET /apply-progress, both fully superseded by
    // this -- removed below, not kept alongside).
    //
    // The dependency-break and FOMOD-choice gates genuinely need the user's own decision before ANY
    // real write proceeds, so they stay a synchronous pre-flight check (runner.prepareApply) --
    // exactly the same "check first, only then kick off the real background work" shape PGPatcher's
    // own DynDoLOD gate already uses -- and still 409 exactly as before, before this route ever
    // returns 202. Once prepareApply's own gates all clear, runner.runApply does the actual write
    // work in the background, streaming real phase/progress events via emitIfCurrent.
    const applySession = createSseSession();

    router.get('/apply/events', (req, res) => {
        if (!applySession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        applySession.subscribe(res, { afterSeq });
    });

    router.post('/apply', async (req, res) => {
        if (!staging || !downloads) return res.status(400).json({ error: 'Set up the staging and downloads folders under Settings first.' });
        const { collectionModId, removedChoice, ignoreDependencyBreaks, keepInstalledModIds, deleteArchives, fomodPicks } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'No collection given to apply.' });
        }
        if (removedChoice !== undefined && removedChoice !== 'remove' && removedChoice !== 'keep') {
            return res.status(400).json({ error: 'removedChoice must be "remove" or "keep" (or omitted when there\'s nothing removed).' });
        }
        if (keepInstalledModIds !== undefined && !Array.isArray(keepInstalledModIds)) {
            return res.status(400).json({ error: 'keepInstalledModIds must be an array (or omitted).' });
        }

        let prepared;
        try {
            prepared = await runner.prepareApply({ collectionModId, staging, downloads, state, ignoreDependencyBreaks, keepInstalledModIds, fomodPicks });
        } catch (e) {
            if (e.code === 'HELPER_UNAVAILABLE') {
                return res.status(409).json({ error: 'helper-unavailable', message: e.message });
            }
            // No real write happened yet -- refused before the backup step, matching Vortex's own
            // real "Cancel" default. The frontend shows these details (which mod, old/new version,
            // the failing constraint -- see findBrokenDependencies' own header comment for why this
            // goes further than Vortex's own vague real modal) and, if the user chooses to proceed,
            // re-calls this SAME route with ignoreDependencyBreaks: true.
            if (e.code === 'DEPENDENCY_BREAKS_FOUND') {
                return res.status(409).json({ error: 'dependency-breaks-found', message: e.message, dependencyBreaks: e.dependencyBreaks });
            }
            // Same pattern -- refused before any real write. The frontend renders a real picker per
            // mod (parsedFomod: the real install-step/group/plugin tree) and re-calls this SAME
            // route with fomodPicks: {[modId]: {...}} once the director has made real choices.
            if (e.code === 'FOMOD_CHOICES_NEEDED') {
                return res.status(409).json({ error: 'fomod-choices-needed', message: e.message, fomodChoiceNeeds: e.fomodChoiceNeeds });
            }
            return res.status(500).json({ error: e.message });
        }

        if (applySession.isActive()) {
            return res.status(409).json({ error: 'An apply is already in progress.' });
        }

        const mySession = applySession.start({ id: `apply-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (applySession.get() === mySession) applySession.emit(event);
        };

        runner.runApply({
            prepared, collectionModId, staging, downloads, syncBackupRoot, removedChoice,
            ignoreDependencyBreaks, deleteArchives, onProgress: emitIfCurrent,
        }).then((result) => {
            emitIfCurrent({ type: 'done', result, done: true });
        }).catch((e) => {
            // BACKUP_FAILED is the one runner-thrown error code that can still happen here (every
            // OTHER real write below it just reports its own per-mod ok:false/error rather than
            // throwing) -- surfaced with the same code the frontend's own ucv2HandleError already
            // knows how to render, just via the stream now instead of a synchronous 500.
            emitIfCurrent({
                type: 'error', message: e.message, done: true, error: true,
                code: e.code === 'BACKUP_FAILED' ? 'backup-failed' : undefined,
            });
        });
    });

    // Apply Result's own per-problem Retry (2026-08-23) -- re-runs ONE specific failed operation from
    // a just-completed apply, standalone, without a whole fresh Apply. See the runner's own "Apply
    // Result Retry support" section for the shared mechanics (the short-lived retry cache, and why
    // the single-mod retry deliberately doesn't use it). Guarded the same way /apply itself is
    // guarded against a second concurrent /apply -- retrying one piece while a fresh full Apply is
    // mid-flight on the same collection would race on the same live Vortex state/staging folder.
    // RETRY_DATA_EXPIRED gets its own real error code (the cache's own bounded TTL, or simply never
    // having applied yet this server session) so the frontend can say plainly "run Apply Update
    // again" instead of a generic failure.
    const retryBusyGuard = (req, res) => {
        if (applySession.isActive()) {
            res.status(409).json({ error: 'apply-in-progress', message: 'An apply is already in progress.' });
            return true;
        }
        return false;
    };

    router.post('/apply/retry-mod-rules', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            res.json(await runner.retryModRules({ collectionModId }));
        } catch (e) {
            if (e.code === 'RETRY_DATA_EXPIRED') return res.status(409).json({ error: 'retry-data-expired', message: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/apply/retry-collection-attributes', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            res.json(await runner.retryCollectionAttributes({ collectionModId }));
        } catch (e) {
            if (e.code === 'RETRY_DATA_EXPIRED') return res.status(409).json({ error: 'retry-data-expired', message: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/apply/retry-membership-cleanup', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            res.json(await runner.retryMembershipCleanup({ collectionModId }));
        } catch (e) {
            if (e.code === 'RETRY_DATA_EXPIRED') return res.status(409).json({ error: 'retry-data-expired', message: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // Retry #4 -- a single Updated/Added mod's own extraction failure. Real Vortex writes, same as
    // /apply itself, so it needs staging/downloads configured and the same HELPER_UNAVAILABLE/
    // VORTEX_RUNNING handling every other real-write route in this file already has.
    router.post('/apply/retry-mod', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        if (!staging || !downloads) return res.status(400).json({ error: 'Set up the staging and downloads folders under Settings first.' });
        const { collectionModId, modId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        if (!modId || typeof modId !== 'string') return res.status(400).json({ error: 'No mod given to retry.' });
        try {
            res.json(await runner.retryModExtraction({ collectionModId, staging, downloads, state, modId }));
        } catch (e) {
            if (e.code === 'HELPER_UNAVAILABLE') return res.status(409).json({ error: 'helper-unavailable', message: e.message });
            if (e.code === 'VORTEX_RUNNING') return res.status(409).json({ error: 'vortex-running', message: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createUpdateCollectionV2Router };
