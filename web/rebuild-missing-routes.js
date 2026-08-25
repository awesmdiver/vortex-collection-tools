'use strict';
// Rebuild Missing Files -- thin Express handlers. Real logic lives in
// lib/missing-files-scan.js (scan) and lib/sevenzip.js's extractMany (fix). See DESIGN.md's own
// section on this tool and TECHNICAL.md for the full writeup.
//
// GET /collections is deliberately its OWN listing here, not a reuse of Rebuild Collection's
// /api/rebuild/collections -- that endpoint's "workshopOnlyCollections" means "tracked in Vortex
// with NO collection.json at all", which is exactly the case this tool can never scan (nothing to
// diff against). This tool's own "Workshop collections" group means the opposite: an
// authoring collection that DOES have a local collection.json (Vortex writes one while a Workshop
// collection is actively being edited) -- see missing-files-scan.js's own header comment.
//
// The scan itself needs no "Vortex must be closed" gate (same reasoning as Missing Masters' own
// /scan) -- it only ever reads collection.json files, archive listings, and the staging folder,
// never Vortex's live state.v2. /extract is one write in this router (staging folder files), gated
// exactly like every other staging-folder write in this app. /refresh-from-nexus is the other
// (collection.json itself) -- see its own comment below. /nexus-slug is the one place this router
// reads Vortex's live state at all, and only as a one-off, explicitly user-triggered lookup (see
// its own comment) -- it doesn't touch the read-only scan path above.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const { listPickableCollections, scanCollections, scanOneMod } = require('../lib/missing-files-scan');
const { loadCollection } = require('../lib/collection-parser');
const { findSevenZip, extractMany } = require('../lib/sevenzip');
const { existsPlainOrGhosted } = require('../lib/ghost-files');
const modExceptionStore = require('../lib/mod-exception-store');
const nexusModDownload = require('../lib/nexus-mod-download');
const nexusCollectionDownload = require('../lib/nexus-collection-download');
const runner = require('../lib/collection-runner');
const syncRunner = require('../lib/sync-runner');
const syncLib = require('../lib/vortex-sync/lib');
const helperClient = require('../lib/vortex-helper-client');
const appConfig = require('../lib/app-config');
const lastFixedState = require('../lib/rebuild-missing-last-fixed-state');
const workshopReportFetchState = require('../lib/workshop-report-fetch-state');
const { createSseSession } = require('./sse-session');

const scanSession = createSseSession();
const extractSession = createSseSession();

function createRebuildMissingRouter(config) {
    const router = express.Router();
    const { staging, downloads, state } = config;
    const sevenZipExe = findSevenZip();

    function isInside(baseDir, targetPath) {
        const resolvedBase = path.resolve(baseDir);
        const resolvedTarget = path.resolve(targetPath);
        return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
    }

    function requireConfigured(res) {
        if (staging && downloads) return true;
        res.status(400).json({ error: 'not-configured', message: 'Set up the staging and downloads folders under Settings first.' });
        return false;
    }

    // Best-effort display name for a collectionModId, for the "refreshing from Nexus…" progress line
    // (queue: rebuild-missing-batch-refresh-toggle) -- fires BEFORE scanCollections itself runs (which
    // is the only other place this app resolves a collection's display name), so this can't just read
    // scanCollections' own result. Same fallback shape as that function's own name resolution: the
    // collection's own info.name, or the raw collectionModId if collection.json can't be read at all.
    function collectionDisplayName(collectionModId) {
        try {
            const collection = loadCollection(path.join(staging, collectionModId, 'collection.json'));
            return collection.info?.name || collectionModId;
        } catch {
            return collectionModId;
        }
    }

    router.get('/collections', (req, res) => {
        // Batch "refresh before scan" toggle's own persisted state (queue: rebuild-missing-batch-
        // refresh-toggle) -- same lightweight, page-owned-not-Settings-owned pattern as Missing
        // Masters' own recognizeEslifierEnabled (missing-masters-routes.js), read fresh here rather
        // than cached, same reasoning: cheap, and stays correct if changed from another tab/window.
        const { rebuildMissingRefreshWorkshopBeforeScan } = appConfig.loadConfig();
        const refreshWorkshopBeforeScan = !!rebuildMissingRefreshWorkshopBeforeScan;
        if (!staging) return res.json({ installed: [], workshop: [], notDownloaded: [], refreshWorkshopBeforeScan, configured: false });
        try {
            const { installed, workshop } = listPickableCollections(staging);
            // "Last dealt with" (queue: rebuild-missing-last-fixed) -- a cheap local JSON read, not
            // a Vortex live-state read, so attaching it here on every picker load is fine (unlike
            // notDownloadedCollections just below, which stays explicit-action-only for exactly that
            // reason). null for a collection this router has never actually fixed anything in.
            for (const item of [...installed, ...workshop]) {
                item.lastFixed = lastFixedState.getLastFixed(item.modId);
                item.lastChecked = lastFixedState.getLastChecked(item.modId);
            }
            // Cached, not re-read here -- populated by the explicit POST /load-vortex-data action
            // above (a live Vortex-state read shouldn't fire silently on every picker load). Empty
            // until the user has clicked that at least once this session.
            res.json({ installed, workshop, notDownloaded: notDownloadedCollections, refreshWorkshopBeforeScan, configured: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Persists the batch "refresh before scan" toggle -- lives on this page itself (not Settings),
    // same "own small immediate-save route" pattern as Missing Masters' own /set-recognize-eslifier.
    router.post('/set-refresh-workshop-before-scan', (req, res) => {
        const { enabled } = req.body || {};
        appConfig.saveConfig({ rebuildMissingRefreshWorkshopBeforeScan: !!enabled });
        res.json({ enabled: !!enabled });
    });

    // Shared by /nexus-slug below and the batch "refresh before scan" step in /scan (queue:
    // rebuild-missing-batch-refresh-toggle) -- one real per-collection Vortex-state read, same logic
    // either way. Throws with `.kind` set to one of 'bad-collection' (resolveCollectionInfo itself
    // failed -- a genuinely bad collectionModId), 'no-slug' (state read succeeded, Vortex just has no
    // Nexus id on record), or left unset for any other state-read failure (a real crash/timeout, not a
    // "this collection doesn't have one" case) -- callers map these to the same 400/404/500 split the
    // original two-try/catch version of this route used, not flattened into one status for every
    // failure.
    //
    // Helper-first, state.v2-fallback (2026-08-21) -- same treatment Rebuild Collection just got
    // (rebuild-collection-vortex-helper-support, same session), reusing its own brand-new
    // `runner.loadSyncStateViaHelper` directly rather than introducing a second, parallel mechanism:
    // that function already reconstructs `loadSyncState`'s identical output shape (collectionSlug
    // included) from one live `helperClient.getAllMods()` call, with zero state.v2 access. Judgment
    // call: the task's own reference was `update-collection-v2-runner.js`'s `resolveNexusInfoViaHelper`
    // (a different, unexported, multi-modId-shaped helper for a different caller's own needs) -- since
    // this route already consumes `loadSyncState`'s exact result shape via `syncState.collectionSlug`,
    // reusing collection-runner.js's own sibling function is the smaller, more consistent change: no
    // new cross-module export needed, and it's the SAME mechanism this file's neighbor
    // (`web/rebuild-routes.js`) just verified live this same session.
    async function resolveSlugForCollection(collectionModId) {
        let collectionInfo;
        try {
            collectionInfo = runner.resolveCollectionInfo(staging, collectionModId);
        } catch (e) {
            e.kind = 'bad-collection';
            throw e;
        }
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        const syncState = helperAvailable
            ? await runner.loadSyncStateViaHelper({
                helperClient, syncLib, collectionModId, collection: collectionInfo.collection, stagingDir: staging,
            })
            : await runner.loadSyncState({
                state, collectionModId, collection: collectionInfo.collection, stagingDir: staging,
            });
        if (!syncState.collectionSlug) {
            const err = new Error("Vortex doesn't have a Nexus id on record for this collection yet -- it needs to have been installed (or, for a Workshop collection, opened in Vortex) at least once before this can look it up on Nexus.");
            err.kind = 'no-slug';
            throw err;
        }
        return { slug: syncState.collectionSlug, collectionName: collectionInfo.name };
    }

    // Looks up a picked collection's Nexus id, so the "Refresh from Nexus" button knows what to
    // fetch -- unlike Rebuild Collection's picker, listPickableCollections has no live Vortex-state
    // read at all (see missing-files-scan.js's own header comment), and collection.json itself
    // never records its own slug (confirmed directly against real collection.json files this
    // session -- only `info.name`/`author`/etc., nothing identifying). The only place this id is
    // recorded at all is Vortex's own live state (`attributes###collectionSlug`, the same one
    // rebuild-routes.js's picker already reads for its "View on Nexus" button) -- so this is a
    // real, one-off Vortex-state read, run ONLY when the user explicitly clicks the button, never as
    // part of the plain filesystem scan/picker load above.
    router.post('/nexus-slug', async (req, res) => {
        if (!requireConfigured(res)) return;
        // BUG FIX (queue: rebuild-missing-vortex-db-read, director's own call): hit this live while
        // testing the Refresh-from-Nexus button -- Vortex was open, this route's own state.v2 read
        // failed with the generic native-DB-crash help text instead of a clear "close Vortex first"
        // message. Deliberately deferred fixing it in that task ("fold the fix in here rather than
        // bolt it on piecemeal") since this task ALSO adds a second, bigger Vortex-DB read below --
        // same gate, same message shape as rebuild-routes.js's own /plan and /vortex-data/refresh.
        //
        // Helper-first (2026-08-21): skip this gate entirely once the Helper covers the read --
        // resolveSlugForCollection's own Helper-vs-state.v2 branch makes the gate genuinely
        // unnecessary in that case. Untouched (same message, same shape) for the no-Helper fallback.
        if (!(await helperClient.checkHelperAvailable(syncLib.GAME_ID)) && syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }
        const { collectionModId } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'Missing collectionModId.' });
        }
        try {
            res.json(await resolveSlugForCollection(collectionModId));
        } catch (e) {
            if (e.kind === 'bad-collection') return res.status(400).json({ error: e.message });
            if (e.kind === 'no-slug') return res.status(404).json({ error: 'no-slug', message: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // Vortex-tracked Workshop collections with NO local collection.json at all (e.g. "My GTS Audio
    // Overhaul" -- confirmed live this session: never extracted, so listPickableCollections' own
    // pure filesystem scan can never find it -- there's nothing on disk to read). Populated by
    // POST /load-vortex-data below, surfaced by GET /collections alongside the filesystem-only
    // installed/workshop groups. Module-level, same "load once, cache until the next explicit
    // refresh" shape as rebuild-routes.js's own workshopOnlyCollections.
    //
    // NAMING, deliberately NOT "workshopOnlyCollections" (this variable's own name is intentionally
    // different from Rebuild Collection's field of the same underlying real-world concept): this
    // router's own header comment already documents that "workshop" in THIS file's own vocabulary
    // means the OPPOSITE thing (an authoring collection that DOES have a local collection.json).
    // Naming it identically to Rebuild Collection's concept here would silently collide with that
    // established meaning.
    let notDownloadedCollections = [];

    // Reads Vortex's live state.v2 DB directly (same primitive Rebuild Collection's own
    // /vortex-data/refresh uses -- collection-runner.js's loadSyncStateBatch, not reimplemented) to
    // discover Workshop-tracked collections this tool would otherwise never see. Deliberately NOT
    // automatic on page load -- same "manual, explicit action" shape this whole router already
    // follows (a live-state read is exactly the kind of thing that shouldn't fire silently, and
    // Vortex must be closed for it to succeed at all). `entries: []` -- this route only cares about
    // the discovery side (workshopOnlyCollections), not per-collection sync state (that's what
    // /nexus-slug is for, lazily, per row) -- confirmed live/via source (state-query-worker.js's own
    // scanAllCollections) that the discovery scan only needs `stagingDir`, not a populated entries
    // list, so this stays a single lightweight DB pass rather than Rebuild Collection's own heavier
    // per-collection batch.
    router.post('/load-vortex-data', async (req, res) => {
        if (!requireConfigured(res)) return;
        // Helper-first (2026-08-21, same treatment as /nexus-slug's own gate above): skip this check
        // entirely once the Helper covers the read. Untouched (same message, same shape) for the
        // no-Helper fallback.
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!helperAvailable && syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }
        try {
            const { workshopOnlyCollections: found } = helperAvailable
                ? await runner.loadSyncStateBatchViaHelper({ helperClient, syncLib, entries: [], stagingDir: staging })
                : await runner.loadSyncStateBatch({ state, entries: [], stagingDir: staging });
            // Dedupe against collections that already have a local collection.json -- those already
            // show up in the normal "workshop" group above (listPickableCollections' own filesystem
            // scan already finds them); only a genuinely never-fetched one belongs here.
            const { workshop: alreadyLocal } = listPickableCollections(staging);
            const alreadyLocalIds = new Set(alreadyLocal.map((w) => w.modId));
            notDownloadedCollections = found
                .filter((w) => !alreadyLocalIds.has(w.modId))
                .sort((a, b) => a.name.localeCompare(b.name));
            res.json({ ok: true, notDownloaded: notDownloadedCollections });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Resolves the revision to actually fetch when the caller doesn't ask for a specific one --
    // ALWAYS the newest revision, draft or published, BY updatedAt (queue: rebuild-missing-batch-
    // refresh-toggle, per the approved v3 mockup's own explicit call: "director confirmed there's no
    // case for going back to an older revision", replacing the v2 per-collection revision picker
    // entirely). Deliberately NOT fetchCollectionRevisions' own default sort (revisionNumber
    // descending) -- that mockup's own comment (and this project's real, live-confirmed finding) is
    // that Nexus updates a draft/unlisted revision's CONTENT in place rather than assigning it a new
    // revisionNumber, so a genuinely fresher revision can still sort BEHIND an older, larger
    // revisionNumber if only picked that way. updatedAt is the only field that actually reflects "was
    // this the one most recently changed."
    // Renamed from resolveNewestRevisionNumber (2026-08-24, workshop-report-real-staleness-check) --
    // now returns the whole resolved {revisionNumber, updatedAt}, not just the number, so
    // refreshCollectionFromNexus below can record BOTH into workshop-report-fetch-state.js's own
    // tracker. updatedAt is the field Workshop Report's own staleness check actually compares on
    // (see that route's own comment on why revisionNumber alone is unreliable).
    async function resolveNewestRevisionInfo(slug) {
        const apiKey = nexusCollectionDownload.resolveApiKey();
        const { revisions } = await nexusCollectionDownload.fetchCollectionRevisions(apiKey, slug);
        const newest = nexusCollectionDownload.resolveNewestRevision(revisions);
        if (!newest) {
            throw new Error(`No revisions found on Nexus for slug="${slug}".`);
        }
        return { revisionNumber: newest.revisionNumber, updatedAt: newest.updatedAt };
    }

    // Pulls a collection's newest saved revision from Nexus (always -- see
    // resolveNewestRevisionInfo's own comment, no picker) and writes it to collectionModId's own
    // staging folder -- either REFRESHING an existing collection.json (the fix for the "archive
    // mismatch" false-positives a stale one can cause -- Rebuild Missing Files diffs against whatever
    // collection.json says SHOULD be installed, so a stale copy makes correctly-installed mods look
    // broken) or FETCHING one for the first time, for a Workshop-only row that's never been extracted
    // at all (the only real difference is "is there something to back up first," not a different
    // operation). Shared by POST /refresh-from-nexus below AND /scan's own batch "refresh before
    // scan" step (queue: rebuild-missing-batch-refresh-toggle) -- one real implementation, not two
    // copies that could drift. Returns the same shape either caller needs; never throws for an
    // ALREADY-handled case (a missing backup write, a fetch failure) -- callers get a normal
    // {ok:false, error} back instead, since /scan's own batch loop must keep going past one
    // collection's failure (see its own comment) rather than unwind on an exception.
    //
    // Also records the fetched revision into workshop-report-fetch-state.js's own tracker
    // (2026-08-24, workshop-report-real-staleness-check) -- on EVERY successful fetch through here,
    // first-time or re-fetch, regardless of which caller triggered it (this function is the one
    // shared implementation, so fixing it here covers Workshop Report's own "Update from Nexus"
    // button AND Rebuild Missing Files' own first-fetch/batch-refresh paths in one place). That
    // tracker is what a LATER Workshop Report check compares against to decide updateAvailable --
    // this function itself has no opinion on staleness, it just honestly records what got fetched.
    async function refreshCollectionFromNexus(collectionModId, slug) {
        const destDir = path.join(staging, collectionModId);
        const collectionJsonPath = path.join(destDir, 'collection.json');
        const isFirstFetch = !fs.existsSync(collectionJsonPath);

        let previousModCount = null;
        let backupPath = null;
        if (!isFirstFetch) {
            try {
                const previous = JSON.parse(fs.readFileSync(collectionJsonPath, 'utf8'));
                previousModCount = Array.isArray(previous.mods) ? previous.mods.length : null;
            } catch { /* best-effort -- missing before/after count doesn't block the refresh itself */ }

            // Same timestamp convention as this app's other backups (e.g. vortex-sync/lib.js's
            // backupLiveState) -- ISO timestamp with ':'/'.' replaced so it's a valid Windows
            // filename. Kept right next to the file it backs up (not a separate backups folder) so
            // it's the easiest possible thing to find and restore by hand if a refresh turns out
            // unwanted. Nothing to back up on a first fetch -- there's no prior file yet.
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupPath = path.join(destDir, `collection.json.backup-${stamp}`);
            try {
                fs.copyFileSync(collectionJsonPath, backupPath);
            } catch (e) {
                return { ok: false, error: `Could not back up the current collection.json before refreshing -- refusing to overwrite it without one: ${e.message}`, backupPath: null };
            }
        }

        try {
            const { revisionNumber, updatedAt } = await resolveNewestRevisionInfo(slug);
            const result = await nexusCollectionDownload.fetchAndExtractCollectionJson({
                slug, revisionNumber, destDir, sevenZipExe,
            });
            // A first fetch means this collectionModId is no longer "not downloaded" -- drop it from
            // that cached list so the picker doesn't keep offering it there once a real
            // collection.json exists (it'll show up in the normal "workshop" group on the next
            // /collections call, via listPickableCollections' own filesystem scan).
            if (isFirstFetch) {
                notDownloadedCollections = notDownloadedCollections.filter((w) => w.modId !== collectionModId);
            }
            // Record what actually landed on disk -- see this function's own header comment above.
            // Best-effort: a tracker write failure must never undo an otherwise-successful fetch.
            try { workshopReportFetchState.recordFetch(collectionModId, { revisionNumber, updatedAt }); } catch { /* non-fatal */ }
            return { ok: true, isFirstFetch, backupPath, previousModCount, ...result };
        } catch (e) {
            // The backup above (if any) is real and untouched -- extractFile only overwrites
            // collection.json once 7z itself succeeds, so a failure here (network, bad slug, no
            // matching revision) never leaves an existing file in a half-written state, and never
            // creates a stray one for a first fetch either.
            return { ok: false, error: e.message, backupPath };
        }
    }

    router.post('/refresh-from-nexus', async (req, res) => {
        if (!requireConfigured(res)) return;
        const { collectionModId, slug } = req.body || {};
        if (!collectionModId || typeof collectionModId !== 'string') {
            return res.status(400).json({ error: 'Missing collectionModId.' });
        }
        if (!slug || typeof slug !== 'string') {
            return res.status(400).json({ error: 'Missing slug.' });
        }
        const result = await refreshCollectionFromNexus(collectionModId, slug);
        res.status(result.ok ? 200 : 500).json(result);
    });

    router.get('/scan/events', (req, res) => {
        if (!scanSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        scanSession.subscribe(res, { afterSeq });
    });

    // Streams per-mod progress, then a final 'scan-complete' carrying the full report -- same
    // POST-starts-202/GET-.../events-subscribes shape as every other scan/plan in this app
    // (sse-session.js). `refreshFirst` (queue: rebuild-missing-batch-refresh-toggle): the Workshop
    // collectionModIds to pull fresh from Nexus BEFORE this same scan reads their collection.json --
    // the v3 mockup's own batch toggle, replacing the shipped v2 per-card button/modal entirely (see
    // rmfRenderPickerGroup's own comment in the frontend for why the per-card action is gone). Gated
    // on isVortexRunning() up front, synchronously, before the SSE session even starts -- every
    // refresh needs a real state.v2 read to resolve its own slug, so this fails fast with the normal
    // 409 shape instead of starting a scan session that's doomed to fail partway through.
    // Ignored-mod awareness (queue: rebuild-missing-ignored-mods) is why this now ALWAYS needs
    // Vortex closed, not just when refreshFirst is non-empty -- listIgnoredMods is a genuinely new
    // live Vortex-state read for this scan (previously it was pure filesystem, see
    // missing-files-scan.js's own header comment), gated the exact same way every other live-state
    // read in this router already is.
    router.post('/scan', async (req, res) => {
        if (!requireConfigured(res)) return;
        const collectionModIds = Array.isArray(req.body?.collectionModIds) ? req.body.collectionModIds : [];
        const refreshFirst = Array.isArray(req.body?.refreshFirst) ? req.body.refreshFirst : [];
        if (collectionModIds.length === 0) return res.status(400).json({ error: 'Pick at least one collection to check.' });
        if (scanSession.isActive()) return res.status(409).json({ error: 'A scan is already in progress.' });
        // Helper-first (2026-08-21, same treatment as /nexus-slug's own gate above) -- BOTH real
        // state.v2 dependencies inside this scan are Helper-capable now, not just refreshFirst's own
        // per-collection slug lookups (resolveSlugForCollection, already Helper-aware): the ignored-
        // mod loop below also gets a Helper path, since listIgnoredMods (sync-runner.js) has no
        // Helper equivalent of its own and, left as the only path, would make this gate's removal
        // unsafe -- its own try/catch already fails OPEN (empty ignored list) rather than aborting the
        // scan, so simply skipping this outer 409 without also fixing that loop would have silently
        // degraded scan ACCURACY (genuinely-ignored mods misreported as missing) for every collection,
        // every time, whenever Vortex is open -- a real correctness regression, not a neutral no-op.
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!helperAvailable && syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }

        const mySession = scanSession.start({ id: `scan-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (scanSession.get() === mySession) scanSession.emit(event);
        };

        (async () => {
            try {
                // Real, not hypothetical: refreshing one collection failing (network, no Nexus id on
                // record, no revision found) must not abort the WHOLE scan -- the other picked
                // collections, refreshed or not, still deserve a real scan result. Each failure is
                // collected and surfaced in the final report instead, per-collection, not silently
                // dropped.
                const refreshFailures = [];
                for (const collectionModId of refreshFirst) {
                    const name = collectionDisplayName(collectionModId);
                    emitIfCurrent({ type: 'collection-refreshing', collectionModId, name });
                    try {
                        const { slug } = await resolveSlugForCollection(collectionModId);
                        const result = await refreshCollectionFromNexus(collectionModId, slug);
                        if (!result.ok) refreshFailures.push({ collectionModId, name, error: result.error });
                    } catch (e) {
                        refreshFailures.push({ collectionModId, name, error: e.message });
                    }
                }

                // One ignored-mod lookup per collection, turned into a plain identity-matching
                // function via vortex-sync/lib.js's own makeIdentityMatcher -- that's the SAME
                // cross-shape matcher this codebase already uses everywhere an Ignored/Disabled ref
                // needs to be matched against a collection.json mod's own source, not new logic.
                // Fails open per-collection (empty ignored list, not an aborted scan) -- a lookup
                // failure here should never wrongly SUPPRESS the ignored check by crashing the whole
                // run, and should never silently mislabel a real problem as ignored either; failing
                // open just means this one collection's ignored mods (if any) show up as normal
                // missing/archive-issue rows instead, same as before this feature existed.
                //
                // Helper-first (2026-08-21): when the Helper's reachable, `ignored` comes from
                // loadSyncStateViaHelper's own already-computed field instead of the state.v2-only
                // syncRunner.listIgnoredMods -- both are syncLib.extractIgnored(mod.rules) under the
                // hood (confirmed by reading collection-runner.js's own queryLiveStateBatch), so this
                // is the identical value, just read live instead of from a closed-Vortex DB copy. This
                // is what makes skipping the gate above actually safe, not just permissive -- without
                // this, a Helper-available scan would still silently lose ignored-mod accuracy for
                // every collection, since listIgnoredMods itself has no Helper equivalent.
                const ignoredMatchers = new Map();
                for (const collectionModId of collectionModIds) {
                    try {
                        let ignored;
                        if (helperAvailable) {
                            const collectionInfo = runner.resolveCollectionInfo(staging, collectionModId);
                            const syncState = await runner.loadSyncStateViaHelper({
                                helperClient, syncLib, collectionModId, collection: collectionInfo.collection, stagingDir: staging,
                            });
                            ignored = syncState.ignored;
                        } else {
                            ignored = await syncRunner.listIgnoredMods({ stateDir: state, modId: collectionModId });
                        }
                        ignoredMatchers.set(collectionModId, syncLib.makeIdentityMatcher(ignored));
                    } catch {
                        ignoredMatchers.set(collectionModId, () => null);
                    }
                }
                // Mod Exceptions list (queue: rebuild-missing-hand-pick-exceptions) -- a plain local
                // file read (unlike ignoredMatchers above), loaded once per scan, same convention as
                // lib/mod-exception-store.js's own header comment on why this is checked here rather
                // than bolted on after scanOneMod's real classification.
                const { modExceptionListDir } = appConfig.loadConfig();
                const exceptionMatcher = modExceptionStore.makeExceptionMatcher(modExceptionListDir);

                const collectionResults = await scanCollections(collectionModIds, {
                    stagingDir: staging, downloadsDir: downloads, sevenZipExe, ignoredMatchers, exceptionMatcher,
                    onProgress: (p) => emitIfCurrent({ type: 'mod-scanned', ...p }),
                });
                // "Last checked" (queue: rebuild-missing-last-checked) -- unlike markFixed, this
                // fires for every collection that reached scan completion here, unconditionally,
                // regardless of whether it turned up anything missing. Matches lastFixedState's own
                // layering rule (see its header): the lib stays state-store-free, only the route
                // (which already owns lastFixedState) touches it.
                for (const c of collectionResults) lastFixedState.markChecked(c.collectionModId);
                const statColls = collectionResults.filter((c) => !c.error).length;
                const statMods = collectionResults.reduce((n, c) => n + (c.modsWithMissing?.length || 0), 0);
                const statFiles = collectionResults.reduce((n, c) => n + (c.modsWithMissing || []).reduce((m, mod) => m + mod.missing.length, 0), 0);
                emitIfCurrent({
                    type: 'scan-complete', done: true, collectionResults, refreshFailures,
                    stats: { collectionsChecked: statColls, modsWithMissing: statMods, filesMissing: statFiles },
                });
            } catch (e) {
                emitIfCurrent({ type: 'scan-error', done: true, error: true, message: e.message });
            }
        })();
    });

    // Extracts the missing files for ONE mod, straight from its already-resolved archive.
    // Re-verifies every path is STILL actually missing right before extracting (cheap
    // fs.existsSync checks) rather than trusting the client-held scan result outright -- real time
    // may have passed since the scan ran.
    //
    // Each file is a {source, destination} pair (see missing-files-scan.js's own resolveExpectedDestinations
    // header comment) -- source is the file's REAL archive-internal path, destination is where it
    // belongs in the staging folder, and the two differ whenever a mod-root wrapper was stripped
    // (e.g. an archive with everything under a "Patches\" subfolder that Vortex's installer strips
    // on install). extractMany needs the real SOURCE path to find the member at all, and preserves
    // the archive's own internal folder structure verbatim into destDir -- only correct when nothing
    // was stripped -- so this replays the same scratch-dir-then-copy pattern extract-mod.js's own
    // installResolvedFiles already uses for a real rebuild: extract every source into a scratch temp
    // dir in one 7z call, then copy each into its real destination under the staging folder.
    async function extractOneMod(item) {
        const { name, targetFolderName, archivePath, files } = item || {};
        if (!targetFolderName || !archivePath || !Array.isArray(files) || files.length === 0) {
            return { name, ok: false, error: 'Incomplete request.' };
        }
        if (!fs.existsSync(archivePath)) {
            return { name, ok: false, error: 'The archive is no longer on disk -- try Download Archive, or re-scan.' };
        }
        const stagingModDir = path.join(staging, targetFolderName);
        // A ".ghost"-suffixed sibling means Vortex already has this file, just deliberately disabled
        // (see ghost-files.js) -- must be excluded here specifically, not just at scan time: without
        // this, re-extracting it would restore the plain, ACTIVE file right alongside the still-
        // present ghost, silently un-disabling the user's own Vortex choice.
        const stillMissing = files.filter((f) => !existsPlainOrGhosted(stagingModDir, f.destination));
        if (stillMissing.length === 0) {
            return { name, ok: true, extracted: [], note: 'Already fixed -- nothing was actually missing anymore.' };
        }
        const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmf-extract-'));
        try {
            await extractMany(sevenZipExe, archivePath, stillMissing.map((f) => f.source), scratchDir);
            const reallyThere = [];
            const stillGone = [];
            for (const f of stillMissing) {
                const scratchPath = path.join(scratchDir, f.source);
                if (!fs.existsSync(scratchPath)) {
                    stillGone.push(f.destination);
                    continue;
                }
                const destFullPath = path.join(stagingModDir, f.destination);
                fs.mkdirSync(path.dirname(destFullPath), { recursive: true });
                fs.copyFileSync(scratchPath, destFullPath);
                reallyThere.push(f.destination);
            }
            return {
                name, ok: stillGone.length === 0, extracted: reallyThere,
                error: stillGone.length > 0 ? `${stillGone.length} file(s) were not found inside the archive: ${stillGone.join(', ')}` : undefined,
            };
        } catch (e) {
            return { name, ok: false, error: e.message };
        } finally {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    }

    router.get('/extract/events', (req, res) => {
        if (!extractSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        extractSession.subscribe(res, { afterSeq });
    });

    // Same POST-starts-202/GET-.../events-subscribes SSE shape as /scan above (queue:
    // rebuild-missing-extract-progress -- a big batch, e.g. a whole collection's worth of mods, could
    // run for a while with zero feedback otherwise; "nothing is happening" reads as broken). Streams a
    // 'mod-extracted' event per item as it finishes, then a final 'extract-complete' carrying the same
    // {results} shape the route used to return synchronously -- the client's own result-summary
    // rendering (rmfApplyExtractResults) is unchanged, it just now reads `results` off the last SSE
    // frame instead of the POST response body.
    router.post('/extract', (req, res) => {
        if (!requireConfigured(res)) return;
        if (syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (items.length === 0) return res.status(400).json({ error: 'Nothing selected to extract.' });
        if (extractSession.isActive()) return res.status(409).json({ error: 'An extraction is already in progress.' });

        const mySession = extractSession.start({ id: `extract-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (extractSession.get() === mySession) extractSession.emit(event);
        };

        (async () => {
            try {
                const results = [];
                // "Last dealt with" (queue: rebuild-missing-last-fixed) -- collected as a Set so a
                // batch spanning several collections marks each one at most once, and ONLY once a
                // REAL file was extracted for it (result.extracted.length > 0) -- an "already fixed,
                // nothing left to extract" success (extracted: []) doesn't count, matching the
                // judgment call in rebuild-missing-last-fixed-state.js's own header.
                const fixedCollectionIds = new Set();
                const total = items.length;
                for (let index = 0; index < items.length; index += 1) {
                    const item = items[index];
                    const result = await extractOneMod(item);
                    results.push(result);
                    if (result.ok && result.extracted?.length > 0 && item.collectionModId) {
                        fixedCollectionIds.add(item.collectionModId);
                    }
                    emitIfCurrent({ type: 'mod-extracted', index: index + 1, total, name: result.name, ok: result.ok });
                }
                for (const collectionModId of fixedCollectionIds) lastFixedState.markFixed(collectionModId);
                emitIfCurrent({ type: 'extract-complete', done: true, results });
            } catch (e) {
                emitIfCurrent({ type: 'extract-error', done: true, error: true, message: e.message });
            }
        })();
    });

    // Downloads ONE mod's archive from Nexus (Premium-only, same policy as Rebuild Collection's own
    // "download missing archives" -- see lib/nexus-mod-download.js's header), then immediately
    // re-scans that one mod so the report row can update in place without a full re-scan.
    router.post('/download-archive', async (req, res) => {
        if (!requireConfigured(res)) return;
        const { collectionModId, modId, fileId } = req.body || {};
        if (!collectionModId || modId == null || fileId == null) {
            return res.status(400).json({ error: 'collectionModId, modId, and fileId are required.' });
        }
        let collection;
        try {
            collection = loadCollection(path.join(staging, collectionModId, 'collection.json'));
        } catch (e) {
            return res.status(400).json({ error: `Could not read this collection's collection.json: ${e.message}` });
        }
        const mod = collection.mods.find((m) => m.source?.modId === modId && m.source?.fileId === fileId);
        if (!mod) return res.status(404).json({ error: 'That mod was not found in this collection anymore -- try re-scanning.' });
        if (mod.source?.type !== 'nexus') return res.status(400).json({ error: 'This mod is not hosted on Nexus -- download its archive manually.' });

        try {
            const apiKey = nexusModDownload.resolveApiKey();
            const premium = await nexusModDownload.checkPremiumStatus(apiKey);
            if (!premium.isPremium) {
                return res.status(400).json({
                    error: 'not-premium',
                    message: "Nexus only allows automated downloads for Premium accounts -- this respects Nexus's ad-supported download model for free users. Download this archive manually from Nexus instead.",
                });
            }
            await nexusModDownload.downloadModArchive({ apiKey, gameDomain: collection.info?.domainName, source: mod.source, destDir: downloads });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }

        // "Last dealt with" (queue: rebuild-missing-last-fixed) -- the download itself already
        // succeeded by this point (an earlier throw would have returned 500 above), so this counts
        // as a real fix regardless of what the re-scan below finds (the archive is genuinely new on
        // disk now, even if its contents still don't fully resolve every missing file).
        lastFixedState.markFixed(collectionModId);

        const result = await scanOneMod(mod, { downloadsDir: downloads, stagingDir: staging, sevenZipExe });
        res.json({ result });
    });

    // Same "navigate straight into it" pattern as Missing Masters' own /open-staging-folder --
    // validated to actually be inside the configured staging directory first (cheap
    // defense-in-depth, not a real capability restriction; this only ever receives a path this
    // tool's own scan just found).
    router.post('/open-staging-folder', (req, res) => {
        if (!staging) return res.status(400).json({ error: 'Set up the staging folder under Settings first.' });
        const { targetFolderName } = req.body || {};
        if (!targetFolderName || typeof targetFolderName !== 'string') {
            return res.status(400).json({ error: 'No folder given to open.' });
        }
        const folderPath = path.join(staging, targetFolderName);
        if (!isInside(staging, folderPath)) {
            return res.status(400).json({ error: 'That folder is not inside your configured staging directory.' });
        }
        spawn(`explorer.exe "${path.resolve(folderPath)}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createRebuildMissingRouter };
