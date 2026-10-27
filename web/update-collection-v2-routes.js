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
    router.get('/collections', async (req, res) => {
        if (!staging) return res.json({ collections: [], configured: false, refreshing: false, checkedAt: null });
        try {
            // An older unfinished record that Vortex shows nothing open for is closed here, silently. Bounded wait:
            // a slow Vortex must not hold the list back (the check carries on and the next load sees the result).
            if (!applySession.isActive()) {
                await Promise.race([runner.repairStaleRecords(staging).catch(() => 0), new Promise((r) => setTimeout(r, 8000))]);
            }
            const local = runner.listCollections(staging).map((c) => ({
                modId: c.modId, name: c.name, author: c.author, modCount: c.modCount,
            }));
            const cache = runner.getCollectionsCache();
            // Cache not populated yet (still refreshing, or the auto-refresh hasn't run at all for
            // some reason) -- fall back to the plain local listing so the page at least shows real
            // names/mod counts immediately, never a totally empty grid while waiting.
            // The two card flags come from each collection's record on every load, never from the cache.
            const collections = cache.collections ? runner.withFreshCardFlags(cache.collections) : local;
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
    // (bridge-first, state.v2 fallback, see the runner's own comment) and compares against the
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

    // The person left Update Collection (back to the list, away from the page): forget the kept review.
    router.post('/review/release', (req, res) => {
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        runner.releaseReview(collectionModId);
        res.json({ ok: true });
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
            // function's header comment) -- same 'bridge-unavailable' code every real-write route in
            // this file already uses, so ucv2HandleError's existing showBridgeUnavailableModal handler
            // picks this up unchanged rather than falling through to a generic error banner.
            if (e.code === 'BRIDGE_UNAVAILABLE') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'bridge-unavailable' });
                return;
            }
            emitIfCurrent({ type: 'error', message: e.message, done: true, error: true });
        });
    });

    // Real FOMOD preview images: this router's own private /fomod-image route moved to a whole-app
    // GET /api/fomod-image in web/server.js 2026-09-17 ("Open FOMOD mods get an Install button") --
    // Rebuild Missing Files and Rebuild Collection's own new Install action populate the SAME
    // server-side image cache now, so one shared route replaces three would-be duplicates.

    // Phase 2/3's real Apply -- Updated mods get re-extracted+metadata-refreshed+redeployed, Removed
    // mods get either fully uninstalled or kept per-mod (keepRemovedModIds -- checked-by-default on
    // the review screen means "keep"), Added mods get installed for real. Requires the Vortex Bridge
    // extension reachable -- see the runner's own BRIDGE_UNAVAILABLE
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
        const { collectionModId, keepRemovedModIds, ignoreDependencyBreaks, ignoredDependencyBreakKeys, keepInstalledModIds, deleteArchives, fomodPicks, ignoreFomodValidationModIds, targetRevisionNumber, confirmed, includeOlderInstalled } = req.body || {};
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
        // (DEPENDENCY_BREAKS_FOUND/FOMOD_CHOICES_NEEDED/BRIDGE_UNAVAILABLE) now arrives as its own
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
                collectionModId, staging, downloads, state, ignoreDependencyBreaks, ignoredDependencyBreakKeys, keepInstalledModIds, fomodPicks,
                ignoreFomodValidationModIds, targetRevisionNumber: parsedTargetForApply, confirmed, includeOlderInstalled: includeOlderInstalled === true, onProgress: emitIfCurrent,
            });
        } catch (e) {
            if (e.code === 'BRIDGE_UNAVAILABLE') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'bridge-unavailable' });
                return;
            }
            // Vortex differs from what the person confirmed: nothing was written; the page offers "Review again".
            if (e.code === 'REVIEW_CHANGED') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'review-changed' });
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
        const { collectionModId, optionalModKeys, fomodPicks, ignoreFomodValidationModIds, targetRevisionNumber } = req.body || {};
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
        // /apply. A gate refusal (BRIDGE_UNAVAILABLE/FOMOD_CHOICES_NEEDED, or any other prepare
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
                collectionModId, staging, downloads, state, optionalModKeys, fomodPicks, ignoreFomodValidationModIds,
                targetRevisionNumber: parsedTargetForApply, onProgress: emitIfCurrent,
            });
        } catch (e) {
            // optional: true on every error frame here too (2026-08-31) -- same flag the 'done' frame
            // below already carries, now load-bearing: ucv2HandleApplyEvent's own 'error' branch reads
            // it to retry via ucv2StartOptionalApply (not the main flow's ucv2ConfirmApply) and return
            // to the Optional Installs screen, not ucv2Screen2 -- see that handler's own comment.
            if (e.code === 'BRIDGE_UNAVAILABLE') {
                emitIfCurrent({ type: 'error', message: e.message, done: true, error: true, code: 'bridge-unavailable', optional: true });
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

    // The result screen asks, before it draws a problem, whether the problem is still true (read only; see runner.recheckApplyProblems).
    router.post('/apply/recheck-problems', async (req, res) => {
        const { collectionModId, items } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        if (!Array.isArray(items)) return res.status(400).json({ error: 'No problems given.' });
        try {
            res.json(await runner.recheckApplyProblems({ collectionModId, items }));
        } catch (e) {
            res.json({ checked: false, results: {} });
        }
    });

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

    // Continue Update's first step (2026-10-23): saves the dependency warnings a busy Vortex made the apply
    // miss, and finishes the update when nothing else is left. See runner.finishPendingDependencyAcks.
    router.post('/apply/finish-pending-rules', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            res.json(await runner.finishPendingDependencyAcks(collectionModId, staging, downloads));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Retry #4 -- a single Updated/Added mod's own extraction failure. Real Vortex writes, same as
    // /apply itself, so it needs staging/downloads configured and the same BRIDGE_UNAVAILABLE/
    // VORTEX_RUNNING handling every other real-write route in this file already has.
    router.post('/apply/retry-mod', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        if (!staging || !downloads) return res.status(400).json({ error: 'Set up the staging and downloads folders under Settings first.' });
        const { collectionModId, modId, fomodPicks, ignoreFomodValidationModIds } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        if (!modId || typeof modId !== 'string') return res.status(400).json({ error: 'No mod given to retry.' });
        try {
            res.json(await runner.retryModExtraction({ collectionModId, staging, downloads, state, modId, fomodPicks, ignoreFomodValidationModIds }));
        } catch (e) {
            if (e.code === 'BRIDGE_UNAVAILABLE') return res.status(409).json({ error: 'bridge-unavailable', message: e.message });
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
    // "Finish saving details" -- re-saves the details of mods whose new file is already installed. Writes
    // through set-attributes only (see runner.finishSavingDetails).
    router.post('/finish-details', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId, vortexModIds } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        if (!Array.isArray(vortexModIds) || vortexModIds.some((x) => typeof x !== 'string')) return res.status(400).json({ error: 'No mods given.' });
        try {
            res.json(await runner.finishSavingDetails({ collectionModId, staging, state, downloads, vortexModIds }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // "Link its new download" -- marks a mod's own stray, unlinked archive installed (set-installed only; see
    // runner.linkStrayArchives).
    // "Remove its old download": deletes the record and file of old archives that Vortex re-listed. Takes only
    // download ids; the runner re-checks each against a fresh read.
    // "Clear the update arrow": writes newestFileId / newestVersion only, for mods the collection pins.
    // Continue Update, light and live: the list the last apply left unfinished plus the groups, checked against
    // Vortex as it is now. { legacy: true } = an older record with no list: the page runs the full review once.
    router.post('/continue-check', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId, settle } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            // settle: true (the Continue Update press) lets it save the rule and record items itself; the check on
            // coming back to the page only reads.
            res.json(await runner.continueCheckRun({ collectionModId, staging, settle: settle === true }));
        } catch (e) {
            if (e.code === 'BRIDGE_UNAVAILABLE') return res.status(409).json({ error: 'bridge-unavailable', message: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // "They already have the new options": saves the new install picks as the mods' installerChoices, nothing else.
    router.post('/confirm-new-options', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId, vortexModIds } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        if (!Array.isArray(vortexModIds) || vortexModIds.some((x) => typeof x !== 'string')) return res.status(400).json({ error: 'No mods given.' });
        try {
            res.json(await runner.confirmNewOptions({ collectionModId, staging, state, downloads, vortexModIds }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/clear-update-arrow', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId, vortexModIds } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        if (!Array.isArray(vortexModIds) || vortexModIds.some((x) => typeof x !== 'string')) return res.status(400).json({ error: 'No mods given.' });
        try {
            res.json(await runner.clearUpdateArrows({ collectionModId, staging, state, downloads, vortexModIds }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/remove-old-downloads', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        const { downloadIds } = req.body || {};
        if (!Array.isArray(downloadIds) || downloadIds.length === 0 || downloadIds.some((x) => typeof x !== 'string')) return res.status(400).json({ error: 'No downloads given.' });
        try {
            res.json(await runner.removeOldDownloadsRepair({ downloads, downloadIds }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/link-downloads', async (req, res) => {
        if (retryBusyGuard(req, res)) return;
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId, vortexModIds } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        if (!Array.isArray(vortexModIds) || vortexModIds.some((x) => typeof x !== 'string')) return res.status(400).json({ error: 'No mods given.' });
        try {
            res.json(await runner.linkStrayArchives({ collectionModId, staging, state, downloads, vortexModIds }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

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

    // Real, full Vortex deploy -- MOVED to the shared web/deploy-routes.js (2026-09-14, "the same
    // Deploy step on every Done screen"), mounted at /api/deploy. This project's whole Apply is now
    // extract/register/rule-only; it never touches Data/ or creates hardlinks/symlinks itself --
    // that's exclusively Vortex's own job, done via the SAME real deployAllMods() event the native
    // "Deploy Mods" button dispatches, offered as its own explicit step on the Apply Result screen
    // once every mod is done. The client (update-collection-v2-app.js's ucv2DeployAll) now calls
    // /api/deploy/all + /api/deploy/all/progress instead of this router's own copies.

    // Post-deploy quick reconciliation (2026-09-01, director's own explicit design) -- see
    // runner.quickVerifyAndFinalize's own header comment for the full "why". Called by the frontend
    // automatically the moment the shared deploy progress poll reports done:true for an apply that
    // didn't finish clean; never redoes real work itself, only confirms and finalizes or reports
    // honestly.
    router.post('/verify-and-finalize', async (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') return res.status(400).json({ error: 'No collection given.' });
        try {
            // Called only after a deploy finished without an error, and a deploy covers every collection.
            const outcome = await runner.quickVerifyAndFinalize(collectionModId, staging, downloads, { deployed: true });
            runner.clearAllDeployPending(staging);
            res.json(outcome);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // The list page's own Deploy (one deploy for every updated collection) finished without an error.
    router.post('/deploy-done', (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        try {
            res.json({ cleared: runner.clearAllDeployPending(staging) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createUpdateCollectionV2Router };
