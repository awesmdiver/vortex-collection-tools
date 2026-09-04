'use strict';
// Thin Express handlers for Update Collection v2 -- Phase 1 (read-only Check for Updates + Review)
// plus Phase 2 (real Apply for Updated + Removed mods only -- Added/Optional Installs are Phase 3).
// All real logic lives in lib/update-collection-v2-runner.js + lib/collection-diff.js. See
// TECHNICAL.md's "Update Collection v2" section for the full design writeup.

const express = require('express');
const runner = require('../lib/update-collection-v2-runner');
const helperClient = require('../lib/vortex-helper-client');
const syncLib = require('../lib/vortex-sync/lib');
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

    // "Review update" -- downloads a revision's real collection.json from Nexus (the newest by
    // default, or targetRevisionNumber -- the Review/Removed screens' own revision picker, 2026-08-27
    // -- to diff against a specific OLDER available revision instead) and diffs it against the
    // currently-installed one. Same VORTEX_RUNNING handling as /check-updates.
    //
    // Real, live streamed progress (2026-08-30, director-caught real gap: a large collection -- 1955
    // mods on a real live collection -- can spend real time in reviewUpdateCore's own per-mod
    // open-FOMOD check with nothing on screen showing it's working, not hung). Same POST-kicks-off-
    // then-SSE-streams-progress shape /apply above already established (same createSseSession
    // primitive, same 202-then-events pattern) -- reused here rather than a second convention.
    const reviewSession = createSseSession();

    router.get('/review/events', (req, res) => {
        if (!reviewSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        reviewSession.subscribe(res, { afterSeq });
    });

    router.post('/review', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId, targetRevisionNumber } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'No collection given to review.' });
        }
        // The dropdown's <select> value is always a string -- coerce here rather than pushing that
        // detail onto the runner, which compares it against real numeric revisionNumber values.
        const parsedTarget = targetRevisionNumber == null ? undefined : Number(targetRevisionNumber);
        if (parsedTarget !== undefined && !Number.isFinite(parsedTarget)) {
            return res.status(400).json({ error: 'targetRevisionNumber must be a number.' });
        }
        // Deliberately NOT a single-flight 409 guard, unlike /apply below -- review is read-only (same
        // reasoning run-state.js's own header comment already gives for why planning doesn't need one
        // either), so a second request (a real re-pick from the revision dropdown, a page reload that
        // re-fires the initial load) just supersedes the old one outright. Real bug this fixes
        // (2026-08-30, live-confirmed): the old 409 here left the user stuck seeing a hard "Couldn't do
        // that" error with no way to start a fresh review short of a server restart, because a page
        // reload orphans the in-flight request server-side with nothing to cancel it. emitIfCurrent's
        // own `reviewSession.get() === mySession` check already exists precisely to make this safe --
        // an abandoned review's late events silently no-op instead of corrupting a newer one's stream.
        const mySession = reviewSession.start({ id: `review-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (reviewSession.get() === mySession) reviewSession.emit(event);
        };

        runner.reviewUpdate({
            collectionModId, staging, state, targetRevisionNumber: parsedTarget, downloads,
            onProgress: emitIfCurrent,
        }).then((result) => {
            emitIfCurrent({ type: 'done', result, done: true });
        }).catch((e) => {
            if (e.code === 'VORTEX_RUNNING') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'vortex-running' });
                return;
            }
            if (e.code === 'REVISION_NOT_FOUND') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'revision-not-found' });
                return;
            }
            // reviewUpdateCore's own new hard block (2026-08-30, director's own call -- see that
            // function's header comment) -- same 'helper-unavailable' code every real-write route in
            // this file already uses, so ucv2HandleError's existing showHelperUnavailableModal handler
            // picks this up unchanged rather than falling through to a generic error banner.
            if (e.code === 'HELPER_UNAVAILABLE') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'helper-unavailable' });
                return;
            }
            emitIfCurrent({ type: 'error', message: e.message, done: true, error: true });
        });
    });

    // Real FOMOD preview images (2026-08-28) -- serves a file the SAME detectFomodChoiceNeed call
    // that produced this modId's own fomodChoiceNeeds entry already extracted to a private scratch
    // folder (see runner.serveFomodImage's own header comment for why: matches Vortex's own real
    // FOMOD wizard, which reads an already-fully-extracted file off disk, not a per-hover
    // extraction). A plain GET (not POST) -- this is exactly what an <img src> tag needs to be able
    // to request directly, and it's a read-only, side-effect-free lookup either way.
    router.get('/fomod-image', (req, res) => {
        const { modId, imagePath } = req.query || {};
        if (!modId || !imagePath) return res.status(400).end();
        const resolved = runner.serveFomodImage(String(modId), String(imagePath));
        if (!resolved) return res.status(404).end();
        res.sendFile(resolved);
    });

    // Phase 2/3's real Apply -- Updated mods get re-extracted+metadata-refreshed+redeployed, Removed
    // mods get either fully uninstalled or kept per-mod (keepRemovedModIds -- checked-by-default on
    // the review screen means "keep"), Added mods get installed for real. Requires the helper
    // extension reachable -- see the runner's own HELPER_UNAVAILABLE
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
        const { collectionModId, keepRemovedModIds, ignoreDependencyBreaks, keepInstalledModIds, deleteArchives, fomodPicks, targetRevisionNumber, prerequisiteChoices } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'No collection given to apply.' });
        }
        if (keepRemovedModIds !== undefined && !Array.isArray(keepRemovedModIds)) {
            return res.status(400).json({ error: 'keepRemovedModIds must be an array (or omitted).' });
        }
        if (keepInstalledModIds !== undefined && !Array.isArray(keepInstalledModIds)) {
            return res.status(400).json({ error: 'keepInstalledModIds must be an array (or omitted).' });
        }

        // targetRevisionNumber (2026-08-27): whatever revision the Review screen actually just showed
        // (ucv2CurrentReview.newRevisionNumber -- the true newest by default, or a manual older pick),
        // same coercion as /review's own targetRevisionNumber handling above -- see prepareApply's own
        // comment for why dropping this here would silently discard a manual pick at apply time.
        const parsedTargetForApply = targetRevisionNumber == null ? undefined : Number(targetRevisionNumber);
        if (parsedTargetForApply !== undefined && !Number.isFinite(parsedTargetForApply)) {
            return res.status(400).json({ error: 'targetRevisionNumber must be a number.' });
        }

        if (applySession.isActive()) {
            return res.status(409).json({ error: 'An apply is already in progress.' });
        }

        // prepareApply moved INSIDE the stream (2026-08-30, director's own catch: its own pre-flight
        // work -- a fresh re-review plus the dependency-break/FOMOD-choice gates -- used to run
        // synchronously BEFORE this 202 ever went out, which is exactly why a real ~2000-mod collection
        // could sit on a bare "Applying..." button for minutes with zero indication anything was
        // happening (confirmed live: 165+ seconds on this exact route, still climbing). The single-
        // apply-at-a-time guard above still runs first and stays a synchronous 400/409, same as before
        // -- only the parts that can take real time move onto the stream. A gate refusal
        // (DEPENDENCY_BREAKS_FOUND/FOMOD_CHOICES_NEEDED/HELPER_UNAVAILABLE) now arrives as its own
        // 'error' frame instead of a synchronous 409 -- see ucv2HandleApplyEvent's own header comment
        // (update-collection-v2-app.js) for how the frontend routes each code to the right modal.
        const mySession = applySession.start({ id: `apply-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (applySession.get() === mySession) applySession.emit(event);
        };

        let prepared;
        try {
            prepared = await runner.prepareApply({
                collectionModId, staging, downloads, state, ignoreDependencyBreaks, keepInstalledModIds, fomodPicks,
                targetRevisionNumber: parsedTargetForApply, prerequisiteChoices, onProgress: emitIfCurrent,
            });
        } catch (e) {
            if (e.code === 'HELPER_UNAVAILABLE') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'helper-unavailable' });
                return;
            }
            // No real write happened yet -- refused before the backup step, matching Vortex's own
            // real "Cancel" default. The frontend shows these details (which mod, old/new version,
            // the failing constraint -- see findBrokenDependencies' own header comment for why this
            // goes further than Vortex's own vague real modal) and, if the user chooses to proceed,
            // re-calls this SAME route with ignoreDependencyBreaks: true.
            if (e.code === 'DEPENDENCY_BREAKS_FOUND') {
                emitIfCurrent({
                    type: 'error', message: e.message, done: true, error: true,
                    code: 'dependency-breaks-found', dependencyBreaks: e.dependencyBreaks,
                });
                return;
            }
            // Same pattern -- refused before any real write (2026-08-31, diagnostics/2026-08-30-
            // added-mod-prerequisite-check-scoping.md). The frontend renders a per-mod modal (each
            // missing prerequisite named) and re-calls this SAME route with prerequisiteChoices:
            // {[addedModKey]: 'skip'|'install'} once the director has made real choices.
            if (e.code === 'MISSING_PREREQUISITES_FOUND') {
                emitIfCurrent({
                    type: 'error', message: e.message, done: true, error: true,
                    code: 'missing-prerequisites-found', missingPrerequisites: e.missingPrerequisites,
                });
                return;
            }
            // Same pattern -- refused before any real write. The frontend renders a real picker per
            // mod (parsedFomod: the real install-step/group/plugin tree) and re-calls this SAME
            // route with fomodPicks: {[modId]: {...}} once the director has made real choices.
            if (e.code === 'FOMOD_CHOICES_NEEDED') {
                emitIfCurrent({
                    type: 'error', message: e.message, done: true, error: true,
                    code: 'fomod-choices-needed', fomodChoiceNeeds: e.fomodChoiceNeeds,
                });
                return;
            }
            emitIfCurrent({ type: 'error', message: e.message, done: true, error: true });
            return;
        }

        runner.runApply({
            prepared, collectionModId, staging, downloads, syncBackupRoot, keepRemovedModIds,
            ignoreDependencyBreaks, deleteArchives, onProgress: emitIfCurrent,
        }).then((result) => {
            // Keeps the collections-overview cache from showing the OLD revision after a real Apply --
            // see patchCollectionCacheRevision's own header comment for why this patches just the one
            // entry instead of triggering a full refreshCollectionsCache. Not called from the catch
            // branch below -- a failed/partial apply shouldn't claim a new revision landed.
            runner.patchCollectionCacheRevision(collectionModId, result.newRevisionNumber);
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

    // Optional Mods Gate/Installs' own real Apply (2026-08-28, director's own build-out -- see
    // runner.prepareApplyOptional's own header comment for the full reasoning). Same SSE
    // session/stream as the main /apply above -- Vortex only ever allows one collection update at a
    // time anyway, so there's no need for a second event stream; GET /apply/events already covers
    // whichever of the two is actually running. Same 202-then-stream shape, same gate-error mapping.
    router.post('/apply-optional', async (req, res) => {
        if (!staging || !downloads) return res.status(400).json({ error: 'Set up the staging and downloads folders under Settings first.' });
        const { collectionModId, optionalModKeys, fomodPicks, targetRevisionNumber } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'No collection given to apply.' });
        }
        if (!Array.isArray(optionalModKeys) || optionalModKeys.length === 0) {
            return res.status(400).json({ error: 'optionalModKeys must be a non-empty array.' });
        }
        const parsedTargetForApply = targetRevisionNumber == null ? undefined : Number(targetRevisionNumber);
        if (parsedTargetForApply !== undefined && !Number.isFinite(parsedTargetForApply)) {
            return res.status(400).json({ error: 'targetRevisionNumber must be a number.' });
        }

        if (applySession.isActive()) {
            return res.status(409).json({ error: 'An apply is already in progress.' });
        }

        // prepareApplyOptional moved INSIDE the stream (2026-08-31, diagnostics/2026-08-30-real-
        // apply-marathon-findings.md finding #5) -- same exact fix /apply itself already got just
        // above, ported here: prepareApplyOptional runs the same reviewUpdateCore full pass /apply's
        // own prepareApply does, which used to run synchronously BEFORE this 202 ever went out --
        // confirmed live, a real 3-optional-mod submit sat with zero visible progress for 6+ minutes
        // (CPU-time-sampling confirmed it was genuinely working the whole time, not hung). The
        // single-apply-at-a-time guard above still runs first and stays a synchronous 409, same as
        // /apply. A gate refusal (HELPER_UNAVAILABLE/FOMOD_CHOICES_NEEDED, or any other prepare
        // failure) now arrives as its own 'error' frame instead of a synchronous 409/500 -- same
        // ucv2HandleApplyEvent routing /apply's own gate frames already use.
        const mySession = applySession.start({ id: `apply-optional-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (applySession.get() === mySession) applySession.emit(event);
        };

        let prepared;
        try {
            prepared = await runner.prepareApplyOptional({
                collectionModId, staging, downloads, state, optionalModKeys, fomodPicks,
                targetRevisionNumber: parsedTargetForApply, onProgress: emitIfCurrent,
            });
        } catch (e) {
            // optional: true on every error frame here too (2026-08-31) -- same flag the 'done' frame
            // below already carries, now load-bearing: ucv2HandleApplyEvent's own 'error' branch reads
            // it to retry via ucv2StartOptionalApply (not the main flow's ucv2ConfirmApply) and return
            // to the Optional Installs screen, not ucv2Screen2 -- see that handler's own comment.
            if (e.code === 'HELPER_UNAVAILABLE') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'helper-unavailable', optional: true });
                return;
            }
            if (e.code === 'FOMOD_CHOICES_NEEDED') {
                emitIfCurrent({
                    type: 'error', message: e.message, done: true, error: true,
                    code: 'fomod-choices-needed', fomodChoiceNeeds: e.fomodChoiceNeeds, optional: true,
                });
                return;
            }
            emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, optional: true });
            return;
        }

        runner.runApply({
            prepared, collectionModId, staging, downloads, syncBackupRoot,
            keepRemovedModIds: [], ignoreDependencyBreaks: true, deleteArchives: false,
            onProgress: emitIfCurrent,
        }).then((result) => {
            runner.patchCollectionCacheRevision(collectionModId, result.newRevisionNumber);
            emitIfCurrent({ type: 'done', result, done: true, optional: true });
        }).catch((e) => {
            emitIfCurrent({
                type: 'error', message: e.message, done: true, error: true, optional: true,
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

    // Retry #5 (2026-08-28) -- re-runs the Updated-mods membership-rule refresh. See
    // refreshUpdatedMembershipRules' own header comment (lib/update-collection-v2-runner.js) for why
    // this is a separate retry from the Removed-mods cleanup above -- they touch the same collection
    // rule array but for opposite reasons (stale content identity vs. stale presence).
    router.post('/apply/retry-updated-membership-refresh', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            res.json(await runner.retryUpdatedMembershipRefresh({ collectionModId }));
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

    // Pre-Deploy health check + fix (2026-08-27, director-requested) -- checks every mod this
    // collection's OWN current on-disk record says should be a member against Vortex's real live
    // state, and fixes any that are registered but not Enabled and/or not linked as a collection
    // member (plus their own load-order rules, if the collection has any) -- see
    // fixCollectionMembershipGaps' own header comment in the runner for the full reasoning. The
    // frontend calls this FIRST, before /deploy-all, so a whole apply's worth of silently-broken
    // registration (the real 2026-08-27 batchDispatch bug) gets caught and fixed automatically
    // instead of requiring N individual per-mod Retry clicks. Read+write only (never touches Data/
    // or staging), so it doesn't need the staging/downloads guard retry-mod above needs.
    router.post('/fix-collection-gaps', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            res.json(await runner.fixCollectionMembershipGaps({ collectionModId, staging }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Real, full Vortex deploy (2026-08-27, director's own architecture call) -- this project's whole
    // Apply is now extract/register/rule-only; it NEVER touches Data/ or creates hardlinks/symlinks
    // itself. That's exclusively Vortex's own job, done here via the SAME real deployAllMods() event
    // the native "Deploy Mods" button dispatches, offered as its own explicit step on the Apply Result
    // screen once every mod is done -- not an automatic tail end of Apply, and not conditional on
    // whether a plugin file happened to change (a real, confirmed gap the OLD per-mod-deploy design
    // had: deploy-single-mod never fires Vortex's own did-deploy reaction chain at all, so plugins.txt/
    // loadorder.txt only ever got reconciled when this tool detected a plugin change and triggered a
    // conditional deploy-all itself -- now every apply gets a real, unconditional full deploy).
    //
    // Same exact fire-and-poll shape web/missing-masters-routes.js's own /deploy-all already uses
    // (itself mirroring web/pgpatcher-routes.js's): POST kicks it off and returns 202 immediately, the
    // client polls /deploy-all/progress. deployAllMods()/getDeployAllProgress() are themselves a
    // poll-shaped pair in lib/vortex-helper-client.js, so an SSE wrapper would be inventing push
    // semantics the underlying primitive doesn't have. Module-scoped single-flight, same reasoning as
    // that route's own -- this is a real, out-of-band, whole-install Vortex operation.
    let deployAllInProgress = false;
    router.post('/deploy-all', async (req, res) => {
        if (deployAllInProgress) {
            return res.status(409).json({ error: 'A deploy is already in progress.' });
        }
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!helperAvailable) {
            return res.status(409).json({
                error: 'helper-unavailable',
                message: 'The Vortex Collection Helper extension must be reachable (Vortex genuinely open) to deploy from here.',
            });
        }
        deployAllInProgress = true;
        res.status(202).json({});
        (async () => {
            try {
                await helperClient.deployAllMods();
            } catch {
                // deployAllMods never throws by contract; the progress endpoint below is what
                // actually reports a real failure, so there is nothing useful to do here.
            }
        })().finally(() => { deployAllInProgress = false; });
    });

    // Post-deploy quick reconciliation (2026-09-01, director's own explicit design) -- see
    // runner.quickVerifyAndFinalize's own header comment for the full "why". Called by the frontend
    // automatically the moment /deploy-all/progress reports done:true for an apply that didn't
    // finish clean; never redoes real work itself, only confirms and finalizes or reports honestly.
    router.post('/verify-and-finalize', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            res.json(await runner.quickVerifyAndFinalize(collectionModId, staging, downloads));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/deploy-all/progress', async (req, res) => {
        const progress = await helperClient.getDeployAllProgress();
        // A null here means "no fresh update right now", NOT that the deploy failed -- the same
        // event-loop congestion that makes a deploy slow can also time out this poll. Falls back to
        // this route's own in-flight flag rather than reporting a false "not active", exactly as
        // missing-masters-routes.js's own equivalent does.
        const result = progress || { active: deployAllInProgress, done: !deployAllInProgress };
        // Real false-positive fix (2026-08-31, diagnostics/2026-08-30-real-apply-marathon-findings.md
        // finding #1) -- the Helper's own deployAllMods() call can return/resolve normally even when
        // Vortex actually aborted the deploy because of a rule cycle, so `result.error` staying empty
        // here is NOT proof the deploy succeeded. `deployBlockedByCycles` (Helper v0.18.0+, a real
        // boolean fact read off Vortex's own live notification state, not guessed) is the corrective
        // signal -- only overrides a genuinely empty error, never a real one this route already
        // reported another way. `code` lets the frontend theme-substitute "Cycle Helper" the same way
        // it already does for the retry-pass guard's own CYCLE_RETRY_BLOCKED_MESSAGE.
        if (result.done && result.deployBlockedByCycles && !result.error) {
            result.error = runner.DEPLOY_BLOCKED_BY_CYCLES_MESSAGE;
            result.code = runner.DEPLOY_BLOCKED_BY_CYCLES_CODE;
        }
        res.json(result);
    });

    return router;
}

module.exports = { createUpdateCollectionV2Router };
