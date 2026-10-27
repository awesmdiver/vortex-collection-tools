'use strict';
// Rebuild Missing Files -- thin Express handlers. Real logic lives in
// lib/missing-files-scan.js (scan) and lib/extract-resolved-files.js (fix). See DESIGN.md's own
// section on this tool and TECHNICAL.md for the full writeup.
//
// GET /collections is deliberately its OWN listing here, not a reuse of Rebuild Collection's
// /api/rebuild/collections -- that endpoint's "workshopOnlyCollections" means "tracked in Vortex
// with NO collection.json at all", which is exactly the case this tool can never scan (nothing to
// diff against). This tool's own "Workshop collections" group means the opposite: an
// authoring collection that DOES have a local collection.json (Vortex writes one while a Workshop
// collection is actively being edited) -- see missing-files-scan.js's own header comment.
//
// The scan's own file-by-file diff needs no gate at all -- it only ever reads collection.json files,
// archive listings, and the staging folder (same reasoning as Missing Masters' own /scan). /scan DOES
// also read Vortex's live state per collection now (Bridge-first, state.v2 disk-fallback -- see that
// route's own comment, "never scan without knowing which mods are Ignored", 2026-09-14), which is why
// /scan carries the same "Vortex Bridge busy / Vortex running" 409 gate every other live-state read in this
// router already has (see /nexus-slug's own comment below for why that read needs the same gate).
// /extract is one write in this router (staging folder files), gated exactly like every other
// staging-folder write in this app. /refresh-from-nexus is the other (collection.json itself) -- see
// its own comment below.

const fs = require('fs');
const path = require('path');
const { openFolderInExplorer, revealInExplorer } = require('../lib/open-in-explorer');
const express = require('express');

const { listPickableCollections, scanCollections, scanOneMod, loadIgnoredAndKnownIds } = require('../lib/missing-files-scan');
const { loadCollection } = require('../lib/collection-parser');
const { resolveDomainDownloadsDir } = require('../lib/archive-locator');
const { findSevenZip } = require('../lib/sevenzip');
const { extractResolvedFiles } = require('../lib/extract-resolved-files');
const { existsPlainOrGhosted } = require('../lib/ghost-files');
const modExceptionStore = require('../lib/mod-exception-store');
const nexusModDownload = require('../lib/nexus-mod-download');
const nexusCollectionDownload = require('../lib/nexus-collection-download');
const runner = require('../lib/collection-runner');
const { pickOpenFileAsync } = require('../lib/vortex-sync/win-dialog');
const syncLib = require('../lib/vortex-sync/lib');
const bridgeClient = require('../lib/vortex-bridge-client');
const { withHealthCheckPaused } = require('../lib/health-check-pause');
const appConfig = require('../lib/app-config');
const { detectFomodChoiceNeed, buildFomodChoicesFromPicks } = require('../lib/fomod-picker-data');
const { buildLiveIdentityIndex, resolveLiveModId, loadLiveModsData, savePicksToVortex } = require('../lib/vortex-live-fomod-choices');
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
    // Bridge-first, state.v2-fallback (2026-08-21) -- same treatment Rebuild Collection just got
    // (rebuild-collection-vortex-helper-support, same session), reusing its own brand-new
    // `runner.loadSyncStateViaBridge` directly rather than introducing a second, parallel mechanism:
    // that function already reconstructs `loadSyncState`'s identical output shape (collectionSlug
    // included) from one live `bridgeClient.getAllMods()` call, with zero state.v2 access. Judgment
    // call: the task's own reference was `update-collection-v2-runner.js`'s `resolveNexusInfoViaBridge`
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
        const bridgeAvailable = await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID);
        const syncState = bridgeAvailable
            ? await runner.loadSyncStateViaBridge({
                bridgeClient, syncLib, collectionModId, collection: collectionInfo.collection, stagingDir: staging,
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
        // Bridge-first (2026-08-21): skip this gate entirely once the Vortex Bridge covers the read --
        // resolveSlugForCollection's own Bridge-vs-state.v2 branch makes the gate genuinely
        // unnecessary in that case. Untouched (same message, same shape) for the no-Bridge fallback.
        if (!(await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID)) && syncLib.isVortexRunning()) {
            // "Currently busy", not "close it" -- this gate only ever trips when the Vortex Bridge (which
            // this router always prefers) didn't answer while Vortex is running; there's no genuine
            // "must be closed" path here. Same wording/reasoning update-collection-v2-runner.js's own
            // checkForUpdates/reviewUpdate fallback already established for the identical condition
            // (2026-08-30) -- this router just never got the same fix. Matched by the frontend's own
            // /currently busy/i check (rmfHandleError) to show the correct modal variant.
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently busy. Please wait for Vortex to finish its current activity, then try again.' });
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
        // Bridge-first (2026-08-21, same treatment as /nexus-slug's own gate above): skip this check
        // entirely once the Vortex Bridge covers the read. Untouched (same message, same shape) for the
        // no-Bridge fallback.
        const bridgeAvailable = await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID);
        if (!bridgeAvailable && syncLib.isVortexRunning()) {
            // "Currently busy", not "close it" -- this gate only ever trips when the Vortex Bridge (which
            // this router always prefers) didn't answer while Vortex is running; there's no genuine
            // "must be closed" path here. Same wording/reasoning update-collection-v2-runner.js's own
            // checkForUpdates/reviewUpdate fallback already established for the identical condition
            // (2026-08-30) -- this router just never got the same fix. Matched by the frontend's own
            // /currently busy/i check (rmfHandleError) to show the correct modal variant.
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently busy. Please wait for Vortex to finish its current activity, then try again.' });
        }
        try {
            const { workshopOnlyCollections: found } = bridgeAvailable
                ? await runner.loadSyncStateBatchViaBridge({ bridgeClient, syncLib, entries: [], stagingDir: staging })
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
    // Ignored-mod awareness (queue: rebuild-missing-ignored-mods) is why this now ALWAYS needs the
    // same gate below, not just when refreshFirst is non-empty -- the per-collection Vortex-state
    // read further down (Ignored mods + knownVortexModIds) is a genuinely new live-state read for
    // this scan (previously it was pure filesystem, see missing-files-scan.js's own header comment),
    // gated the exact same way every other live-state read in this router already is.
    router.post('/scan', async (req, res) => {
        if (!requireConfigured(res)) return;
        const collectionModIds = Array.isArray(req.body?.collectionModIds) ? req.body.collectionModIds : [];
        const refreshFirst = Array.isArray(req.body?.refreshFirst) ? req.body.refreshFirst : [];
        if (collectionModIds.length === 0) return res.status(400).json({ error: 'Pick at least one collection to check.' });
        if (scanSession.isActive()) return res.status(409).json({ error: 'A scan is already in progress.' });
        // Bridge-first (2026-08-21, same treatment as /nexus-slug's own gate above) -- BOTH real
        // state.v2 dependencies inside this scan are Bridge-capable now, not just refreshFirst's own
        // per-collection slug lookups (resolveSlugForCollection, already Bridge-aware): the
        // ignored/knownVortexModIds loop below also gets a Vortex Bridge path (runner.loadSyncStateViaBridge),
        // falling back to a real state.v2 disk read (runner.loadSyncState) rather than sync-runner.js's
        // old listIgnoredMods, which had no Vortex Bridge equivalent and no knownVortexModIds of its own. A
        // read failure there no longer fails open (silently treating every mod as not-Ignored) -- it
        // excludes that one collection from the scan and reports it as its own failure instead (see
        // that loop's own comment, "never scan without knowing which mods are Ignored", 2026-09-14).
        // This outer 409 gate still matters: without it, the Bridge-unavailable branch could try to
        // open state.v2 while Vortex is concurrently writing it.
        const bridgeAvailable = await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID);
        if (!bridgeAvailable && syncLib.isVortexRunning()) {
            // "Currently busy", not "close it" -- this gate only ever trips when the Vortex Bridge (which
            // this router always prefers) didn't answer while Vortex is running; there's no genuine
            // "must be closed" path here. Same wording/reasoning update-collection-v2-runner.js's own
            // checkForUpdates/reviewUpdate fallback already established for the identical condition
            // (2026-08-30) -- this router just never got the same fix. Matched by the frontend's own
            // /currently busy/i check (rmfHandleError) to show the correct modal variant.
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently busy. Please wait for Vortex to finish its current activity, then try again.' });
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

                // One Vortex-state read per collection -- Ignored mods AND each kept mod's real,
                // Vortex-assigned staging folder name (knownVortexModIds), from the SAME call. See
                // loadIgnoredAndKnownIds' own comment (lib/missing-files-scan.js) for the full
                // "never scan without knowing which mods are Ignored" reasoning (2026-09-14) and why
                // a read failure here is never allowed to fail open into an empty ignored list. Kept
                // as a shared lib function (not a second per-router thin wrapper like
                // resolveSlugForCollection above) since the "isolate the collections that failed"
                // behavior below is genuinely batch/RMF-specific, not something Rebuild Collection's
                // own single-collection computePlan() needs.
                const { ignoredMatchers, knownVortexModIdsByCollection, otherVersionsByModIdByCollection, unreadableCollections } =
                    await loadIgnoredAndKnownIds(collectionModIds, { stagingDir: staging, state, bridgeAvailable });
                for (const [collectionModId, message] of unreadableCollections) {
                    console.error(`[rebuild-missing-routes] /scan: could not read Vortex's mod data for "${collectionModId}" -- excluding it from this scan rather than guessing: ${message}`);
                }
                // Never scan blind: a collection this couldn't read real Ignored/folder-name data for
                // is never handed to scanCollections() at all -- only the collections that DID resolve
                // are. If every selected collection failed, there is nothing left to scan; stop with a
                // clear error instead of showing an empty/misleading results screen.
                const scannableCollectionIds = collectionModIds.filter((id) => !unreadableCollections.has(id));
                if (scannableCollectionIds.length === 0) {
                    const [firstMessage] = unreadableCollections.values();
                    emitIfCurrent({
                        type: 'scan-error', done: true, error: true,
                        message: `Could not read Vortex's mod data for any of the selected collection(s): ${firstMessage}`,
                    });
                    return;
                }

                // Mod Exceptions list (queue: rebuild-missing-hand-pick-exceptions) -- a plain local
                // file read (unlike ignoredMatchers above), loaded once per scan, same convention as
                // lib/mod-exception-store.js's own header comment on why this is checked here rather
                // than bolted on after scanOneMod's real classification.
                const { modExceptionListDir } = appConfig.loadConfig();
                const exceptionMatcher = modExceptionStore.makeExceptionMatcher(appConfig.resolveDataDir('mod-exceptions', modExceptionListDir));

                const collectionResults = await scanCollections(scannableCollectionIds, {
                    stagingDir: staging, downloadsDir: downloads, sevenZipExe, ignoredMatchers, exceptionMatcher,
                    knownVortexModIdsByCollection, otherVersionsByModIdByCollection, bridgeAvailable,
                    onProgress: (p) => emitIfCurrent({ type: 'mod-scanned', ...p }),
                });
                // Add the excluded collections back into the report, in the SAME {collectionModId,
                // name, error} shape scanCollections() already uses for an unreadable collection.json
                // -- rmfRenderReport's own existing failedCollections handling already surfaces this
                // correctly, no client change needed.
                for (const [collectionModId, message] of unreadableCollections) {
                    collectionResults.push({
                        collectionModId, name: collectionDisplayName(collectionModId),
                        error: `Could not read Vortex's mod data: ${message}`,
                    });
                }

                // Auto-download missing archives during the scan (2026-09-14, director's own ask:
                // "there is no reason to say 'hey, the file is missing', then have someone click on
                // Download Archive, then have them click on extract archive -- it should be
                // automated"). Same opt-in setting and Premium-only policy Rebuild Collection's own
                // POST /runs already applies (web/rebuild-routes.js) -- reusing the setting rather than
                // adding a second toggle. Runs AFTER scanCollections finishes classifying everything,
                // so it only re-resolves mods that came back archive-missing with a real "we don't have
                // the right file" reason (NOT_FOUND/HASH_MISMATCH -- missing-files-scan.js's own
                // scanOneMod now threads classifyMod's own `code` through for exactly this). AMBIGUOUS
                // (several byte-identical local candidates) is excluded -- that needs a human pick, the
                // same exclusion Rebuild Collection's own eligibleForDownload applies. A mod that isn't
                // actually Nexus-hosted (an off-site mod can also land on NOT_FOUND/HASH_MISMATCH --
                // see rebuild-mod.js's own classifyMod) is caught by resolveAndDownloadArchive's own
                // existing 'not-nexus' check below and just skipped, not treated as a failure.
                const { downloadMissingArchives: autoDownloadEnabled } = appConfig.loadConfig();
                const eligibleArchiveMissing = [];
                for (const c of collectionResults) {
                    if (c.error) continue;
                    for (const m of c.modsArchiveMissing) {
                        if (m.code === 'NOT_FOUND' || m.code === 'HASH_MISMATCH') eligibleArchiveMissing.push({ collectionModId: c.collectionModId, mod: m });
                    }
                }
                // Reported to the client regardless of whether anything was actually eligible this
                // scan -- rmfBuildActionsCell (rebuild-missing-app.js) uses `premium` to decide whether
                // an archive-missing row still gets its own Download Archive button (hidden only when
                // the setting is on AND the account is confirmed non-Premium; every other case --
                // setting off, or Premium but this specific row wasn't eligible/still failed -- keeps
                // the button as the real fallback, per the director's own enumerated cases).
                const archiveAutoDownload = { enabled: !!autoDownloadEnabled, premium: null };
                if (autoDownloadEnabled && eligibleArchiveMissing.length > 0) {
                    emitIfCurrent({ type: 'checking-premium' });
                    const apiKey = nexusModDownload.resolveApiKey();
                    const premium = await nexusModDownload.checkPremiumStatus(apiKey);
                    archiveAutoDownload.premium = !!premium.isPremium;
                    if (!premium.isPremium) {
                        emitIfCurrent({
                            type: 'download-skipped', reason: 'not-premium', count: eligibleArchiveMissing.length,
                            message: "Nexus API only allows automated downloads for Premium accounts -- this respects Nexus's ad-supported download model for free users. Download these archives manually from Nexus, or upgrade to Premium.",
                        });
                    } else {
                        for (let i = 0; i < eligibleArchiveMissing.length; i++) {
                            const { collectionModId, mod } = eligibleArchiveMissing[i];
                            emitIfCurrent({ type: 'downloading-missing-archive', index: i + 1, total: eligibleArchiveMissing.length, name: mod.name });
                            try {
                                const { result } = await downloadAndRescan({ collectionModId, modId: mod.modId, fileId: mod.fileId, apiKey, skipPremiumCheck: true });
                                // Move this mod out of its stale archive-missing entry and into the
                                // bucket its fresh re-scan actually landed in, on the SAME collectionResults
                                // entry the client is about to receive -- no second round trip needed.
                                const cResult = collectionResults.find((c) => c.collectionModId === collectionModId);
                                cResult.modsArchiveMissing = cResult.modsArchiveMissing.filter((x) => x !== mod);
                                if (result.bucket === 'missing') cResult.modsWithMissing.push(result);
                                else if (result.bucket === 'archive-missing') cResult.modsArchiveMissing.push(result);
                                // bucket 'ok' -- nothing missing after all; simply drops off the report.
                            } catch (e) {
                                // 'not-nexus' (an off-site mod that happened to get NOT_FOUND/HASH_MISMATCH
                                // too) or 'download-failed' (network/Nexus error) -- the row stays
                                // archive-missing with its ORIGINAL reason either way. A failed auto-
                                // download must never abort the rest of the scan.
                                console.warn(`[rebuild-missing-routes] auto-download during scan: "${mod.name}" failed: ${e.message}`);
                            }
                        }
                        emitIfCurrent({ type: 'downloading-missing-archives-complete' });
                    }
                }

                // "Last checked" (queue: rebuild-missing-last-checked) -- unlike markFixed, this
                // fires for every collection that reached scan completion here, unconditionally,
                // regardless of whether it turned up anything missing. Matches lastFixedState's own
                // layering rule (see its header): the lib stays state-store-free, only the route
                // (which already owns lastFixedState) touches it.
                for (const c of collectionResults) lastFixedState.markChecked(c.collectionModId);
                const statColls = collectionResults.filter((c) => !c.error).length;
                const statMods = collectionResults.reduce((n, c) => n + (c.modsWithMissing?.length || 0), 0);
                const statFiles = collectionResults.reduce((n, c) => n + (c.modsWithMissing || []).reduce((m, mod) => m + mod.missing.length, 0), 0);
                const statOptionalSkipped = collectionResults.reduce((n, c) => n + (c.optionalSkipped || 0), 0);
                emitIfCurrent({
                    type: 'scan-complete', done: true, collectionResults, refreshFailures, archiveAutoDownload,
                    stats: { collectionsChecked: statColls, modsWithMissing: statMods, filesMissing: statFiles, optionalSkipped: statOptionalSkipped },
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
    // Each file is a {source, destination} pair (see lib/mod-install-plan.js's own
    // resolveFomodOrSimpleFiles/resolveBundleFiles) -- source is the file's REAL archive-internal
    // path, destination is where it belongs in the staging folder, and the two differ whenever a
    // mod-root wrapper was stripped (e.g. an archive with everything under a "Patches\" subfolder
    // that Vortex's installer strips on install). lib/extract-resolved-files.js's own
    // extractResolvedFiles needs the real SOURCE path to find the member at all -- the exact same
    // shared scratch-dir-then-copy Rebuild Collection's own extract-mod.js uses for a real rebuild.
    //
    // `stillMissing` on the RETURN value (2026-09-16, "a row that's actually already fixed stays
    // stuck showing N missing forever") is the authoritative answer to "which of `files`' own
    // destinations are still actually missing, right now, after this call" -- every ok:true branch
    // below sets it. web/public/rebuild-missing-app.js's rmfApplyExtractResults used to INFER this
    // from `extracted` instead (row.missing minus whatever this call's own `extracted` list named),
    // which is wrong the moment `extracted` is empty for a reason other than "nothing was extracted
    // because extraction failed" -- the "already fixed" branch just below always returns an empty
    // `extracted` BY DESIGN, since nothing needed copying, so that inference silently left an
    // already-resolved row's `missing` list untouched forever. Returning the real post-call answer
    // here, instead of making the client re-derive it, closes the whole class: any future reason a
    // file could be missing-then-not-missing for a reason other than THIS call's own extraction
    // (already fixed, fixed by something else, a ghost file appearing) is handled the same correct
    // way with no further client-side changes.
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
            return { name, ok: true, extracted: [], stillMissing: [], note: 'Already fixed -- nothing was actually missing anymore.' };
        }
        // Shared scratch-extract-then-copy (2026-09-14, "share one install and extraction engine")
        // -- used to run its own separate copy of this exact sequence, scratching under os.tmpdir()
        // (typically C:) regardless of which drive staging actually lives on. `staging` itself is
        // passed as scratchRoot (same convention Rebuild Collection's own extract-mod.js already
        // uses -- scratch as a sibling of the real destination) so the final copy stays a fast
        // same-drive operation and a large restore never risks filling a small C: drive.
        try {
            const skipped = await extractResolvedFiles(sevenZipExe, archivePath, stillMissing, stagingModDir, staging);
            const skippedDestinations = stillMissing
                .filter((f) => skipped.some((s) => s.path === f.source))
                .map((f) => f.destination);
            const reallyThere = stillMissing.filter((f) => !skippedDestinations.includes(f.destination)).map((f) => f.destination);
            return {
                // skippedDestinations doubles as `stillMissing` here -- it's exactly "the destinations
                // this call attempted to fix but couldn't find in the archive," i.e. still missing
                // right now. Any destination in the ORIGINAL `files` that wasn't in `stillMissing` to
                // begin with was already present before this call even started, so it's correctly
                // absent from both `extracted` and this list either way.
                name, ok: skippedDestinations.length === 0, extracted: reallyThere, stillMissing: skippedDestinations,
                error: skippedDestinations.length > 0 ? `${skippedDestinations.length} file(s) were not found inside the archive: ${skippedDestinations.join(', ')}` : undefined,
            };
        } catch (e) {
            return { name, ok: false, error: e.message };
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
        // "Vortex must be closed" gate removed 2026-08-25 -- live-tested with the director (real
        // extract, Vortex open): no "External Changes" dialog, no issues. That dialog only fires at
        // Deploy time (Vortex's own classifyExternalChange, mod_management\util\externalChanges.ts),
        // never from files merely appearing in staging -- same reasoning Update Collection v2 already
        // relies on (see its own externalChangesNote in update-collection-v2-app.js), which has never
        // gated this at all. See rmfExtractConfirmModal's own comment in index.html for the full
        // writeup. Do not re-add without a real, new reason -- this was a deliberate removal, not an
        // oversight.
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (items.length === 0) return res.status(400).json({ error: 'Nothing selected to extract.' });
        if (extractSession.isActive()) return res.status(409).json({ error: 'An extraction is already in progress.' });

        const mySession = extractSession.start({ id: `extract-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (extractSession.get() === mySession) extractSession.emit(event);
        };

        (async () => withHealthCheckPaused(async () => {
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
                    let result;
                    // "Rebuild Missing Files: real per-mod status pills during Extract" (2026-09-14):
                    // emitted BEFORE this item's own work starts, so the row shows what's actually
                    // happening right now instead of the PREVIOUS item's finished state for the entire
                    // duration of a long download or a large extraction.
                    emitIfCurrent({
                        type: 'mod-started', index: index + 1, total, name: item.name,
                        phase: item.kind === 'archive-missing' ? 'downloading' : 'extracting',
                    });
                    if (item.kind === 'archive-missing') {
                        // Checked alongside ordinary 'missing' rows (2026-09-02 v5 addendum) -- goes
                        // through the exact same download-then-extract chain the single-row Download
                        // Archive button uses, not a second copy of that logic. onPhase moves this row
                        // from "Downloading…" to "Extracting…" once the download itself finishes and a
                        // real extraction actually starts (skipped entirely when the download alone
                        // already resolved everything).
                        const onPhase = (phase) => emitIfCurrent({ type: 'mod-phase', index: index + 1, name: item.name, phase });
                        try {
                            const outcome = await downloadThenExtract({ collectionModId: item.collectionModId, modId: item.modId, fileId: item.fileId }, onPhase);
                            result = outcome.extractResult
                                // extractResult already has {name, ok, extracted, error} -- reuse verbatim.
                                ? outcome.extractResult
                                // No extraction was attempted -- either the download alone already
                                // resolved everything (rare) or the re-scan still couldn't place it
                                // (still archive-missing/some other bucket); reflect the real outcome
                                // instead of assuming success.
                                : { name: outcome.mod.name, ok: outcome.result?.bucket === 'ok', extracted: [], error: outcome.result?.bucket !== 'ok' ? (outcome.result?.reason || 'Downloaded, but still not resolved -- try re-scanning.') : undefined };
                        } catch (e) {
                            result = { name: item.name, ok: false, error: e.message };
                        }
                    } else {
                        result = await extractOneMod(item);
                    }
                    results.push(result);
                    if (result.ok && result.extracted?.length > 0 && item.collectionModId) {
                        fixedCollectionIds.add(item.collectionModId);
                    }
                    // extracted/error/note carried through (previously just {ok}) so the row's own
                    // final pill/detail can say what actually happened -- a real extracted count, the
                    // real failure reason, or "already fixed, nothing was actually missing anymore"
                    // (extractOneMod's own note) -- instead of a bare ok/fail with no detail at all.
                    emitIfCurrent({
                        type: 'mod-extracted', index: index + 1, total, name: result.name, ok: result.ok,
                        extracted: result.extracted?.length || 0, error: result.error, note: result.note,
                    });
                }
                for (const collectionModId of fixedCollectionIds) lastFixedState.markFixed(collectionModId);
                emitIfCurrent({ type: 'extract-complete', done: true, results });
            } catch (e) {
                emitIfCurrent({ type: 'extract-error', done: true, error: true, message: e.message });
            }
        }, { onPaused: (line) => console.log(`[rebuild-missing-routes] ${line}`), onRestoreFailed: (line) => console.warn(`[rebuild-missing-routes] ${line}`) }))();
    });

    // Resolves a mod entry from a collection and does the real Nexus download for it (Premium-only,
    // same policy as Rebuild Collection's own "download missing archives" -- see
    // lib/nexus-mod-download.js's header). Throws a structured error ({.code, .message}) on any
    // failure the caller should surface distinctly (bad-request/not-found/not-nexus/not-premium/
    // download-failed) -- never partially downloads. Factored out (2026-09-02 v5 addendum) so both
    // /download-archive (one mod) and /extract's batch loop (a whole checked selection, mixed with
    // ordinary 'missing' items) share this exact real-download logic instead of it existing twice.
    //
    // apiKey/skipPremiumCheck (2026-09-14, "download missing archives automatically during the
    // scan"): the scan's own auto-download loop checks Premium ONCE for the whole batch (same
    // reasoning Rebuild Collection's own POST /runs already applies -- see its "checking-premium"
    // phase), then passes the already-resolved key through here for every mod so this function
    // doesn't re-hit the Nexus validate endpoint per mod. Both existing callers (/download-archive,
    // downloadAndRescan's own default use inside downloadThenExtract) omit these and get the exact
    // same per-call resolve+check as before this feature.
    async function resolveAndDownloadArchive({ collectionModId, modId, fileId, apiKey: providedApiKey, skipPremiumCheck = false }) {
        if (!collectionModId || modId == null || fileId == null) {
            const err = new Error('collectionModId, modId, and fileId are required.'); err.code = 'bad-request'; throw err;
        }
        let collection;
        try {
            collection = loadCollection(path.join(staging, collectionModId, 'collection.json'));
        } catch (e) {
            const err = new Error(`Could not read this collection's collection.json: ${e.message}`); err.code = 'bad-request'; throw err;
        }
        const mod = collection.mods.find((m) => m.source?.modId === modId && m.source?.fileId === fileId);
        if (!mod) { const err = new Error('That mod was not found in this collection anymore -- try re-scanning.'); err.code = 'not-found'; throw err; }
        if (mod.source?.type !== 'nexus') { const err = new Error('This mod is not hosted on Nexus -- download its archive manually.'); err.code = 'not-nexus'; throw err; }

        // Logged (2026-09-01, director's own ask -- a real live incident: 4 items had Download Archive
        // clicked, only 1 actually came back downloaded, and this route had ZERO logging anywhere --
        // both the failure path (an error was caught and turned into a JSON response, but never
        // written to console) and the "downloaded, but the file still doesn't resolve everything" path
        // were completely silent.
        console.log(`[rebuild-missing-routes] downloading: "${mod.name}" (modId=${modId}, fileId=${fileId}, collection="${collectionModId}")`);
        const apiKey = providedApiKey || nexusModDownload.resolveApiKey();
        if (!skipPremiumCheck) {
            const premium = await nexusModDownload.checkPremiumStatus(apiKey);
            if (!premium.isPremium) {
                console.warn(`[rebuild-missing-routes] downloading: "${mod.name}" refused -- account is not Premium.`);
                const err = new Error("Nexus only allows automated downloads for Premium accounts -- this respects Nexus's ad-supported download model for free users. Download this archive manually from Nexus instead.");
                err.code = 'not-premium'; throw err;
            }
        }
        // mod.domainName (a real, per-mod field Nexus/Vortex's own collection.json schema carries --
        // confirmed live 2026-08-25, "TES Arena Bikini Armor"/modId 106393: collection info.domainName
        // is "skyrimspecialedition", but this ONE mod's own entry carries domainName "skyrim" -- a
        // real cross-listed mod, hosted on Nexus under Legacy Skyrim's own domain even though it's a
        // member of an SE collection) takes priority over the collection-wide default. Using the
        // collection's domain unconditionally asked the Nexus API for modId 106393 under the WRONG
        // game, which genuinely doesn't exist there -- that's the real cause of the "Mod not
        // available" 403, not a Nexus-side problem.
        const gameDomain = mod.domainName || collection.info?.domainName;
        // Same per-mod resolution on the FILESYSTEM side as gameDomain is for the API side -- a
        // cross-listed mod's archive belongs in ITS OWN domain's downloads folder (a sibling of the
        // configured one), not the collection-wide one. See resolveDomainDownloadsDir's own header
        // comment -- this is the other half of the same real bug (confirmed live 2026-08-25).
        const destDir = resolveDomainDownloadsDir(downloads, mod.domainName);
        try {
            await nexusModDownload.downloadModArchive({ apiKey, gameDomain, source: mod.source, destDir });
            console.log(`[rebuild-missing-routes] downloading: "${mod.name}" downloaded successfully to ${destDir}.`);
        } catch (e) {
            console.warn(`[rebuild-missing-routes] downloading: "${mod.name}" FAILED: ${e.message}`);
            const err = new Error(e.message); err.code = 'download-failed'; throw err;
        }
        // "Last dealt with" (queue: rebuild-missing-last-fixed) -- the download itself already
        // succeeded by this point, so this counts as a real fix regardless of what the re-scan below
        // finds (the archive is genuinely new on disk now, even if its contents still don't fully
        // resolve every missing file).
        lastFixedState.markFixed(collectionModId);
        return mod;
    }

    // Download + re-scan only, no extraction (2026-09-14, "download missing archives automatically
    // during the scan" -- factored out of downloadThenExtract below, which is now just this plus its
    // own extract step). Used by the scan's own auto-download loop (which deliberately stops here --
    // extraction is still a Continue-time action, same as every other row) AND by downloadThenExtract
    // itself, so the "resolve, download, re-scan" sequence exists in exactly one place. apiKey/
    // skipPremiumCheck pass straight through to resolveAndDownloadArchive (see its own header).
    async function downloadAndRescan({ collectionModId, modId, fileId, apiKey, skipPremiumCheck }) {
        const mod = await resolveAndDownloadArchive({ collectionModId, modId, fileId, apiKey, skipPremiumCheck }); // throws on failure
        const result = await scanOneMod(mod, { downloadsDir: downloads, stagingDir: staging, sevenZipExe });
        return { mod, result };
    }

    // The shared download-then-extract chain (2026-09-02 v5 addendum): a freshly-downloaded Nexus
    // archive is definitionally the correct file (fetched by modId/fileId, not a guessed local
    // candidate), so there's nothing left to verify before extracting -- always re-scans then
    // extracts in the same call. Used by BOTH /download-archive (one mod) and /extract's batch loop
    // (archive-missing items checked alongside ordinary 'missing' ones), so this chain exists in
    // exactly one place, not duplicated per caller. Returns { mod, result, extractResult } --
    // `result` matches scanOneMod's own bucket contract (with bucket flipped to 'ok' on a successful
    // chained extraction, same as before this was factored out) for /download-archive's own
    // unchanged response shape; `extractResult` (null if no extraction was attempted) carries
    // extractOneMod's own {name, ok, extracted, error} shape for the batch route to reuse directly.
    //
    // onPhase (optional, "Rebuild Missing Files: real per-mod status pills during Extract", 2026-09-14):
    // called with 'extracting' right before this function's own extractOneMod call, so the /extract
    // batch loop below can tell its per-row pill apart from "still downloading" -- the single-row
    // /download-archive route below doesn't pass one (it has no per-row pill of its own to update), and
    // this function works exactly as before when omitted.
    async function downloadThenExtract({ collectionModId, modId, fileId }, onPhase) {
        const { mod, result: rescanResult } = await downloadAndRescan({ collectionModId, modId, fileId });
        let result = rescanResult;
        let extractResult = null;
        // The download itself can succeed while the re-scan STILL reports this mod as missing
        // something (e.g. the freshly-downloaded archive doesn't actually contain what collection.json
        // expects, or scanOneMod's own re-classification still can't resolve it for some other reason
        // -- bucket 'missing' and 'archive-missing' are genuinely different failure shapes, see
        // missing-files-scan.js's own scanOneMod).
        if (result?.bucket === 'ok') {
            console.log(`[rebuild-missing-routes] downloadThenExtract: "${mod.name}" re-scan confirms fully resolved.`);
        } else if (result?.bucket === 'missing') {
            console.warn(`[rebuild-missing-routes] downloadThenExtract: "${mod.name}" downloaded, but re-scan still reports ${result.missing.length} missing file(s) -- extracting now.`);
            onPhase?.('extracting');
            extractResult = await extractOneMod({
                name: result.name, targetFolderName: result.targetFolderName,
                archivePath: result.archivePath, files: result.missing,
            });
            if (extractResult.ok) {
                console.log(`[rebuild-missing-routes] downloadThenExtract: "${mod.name}" auto-extract after download succeeded (${extractResult.extracted.length} file(s)).`);
                result = { bucket: 'ok', name: result.name };
            } else {
                console.warn(`[rebuild-missing-routes] downloadThenExtract: "${mod.name}" auto-extract after download FAILED: ${extractResult.error}`);
                result = { ...result, error: extractResult.error };
            }
        } else {
            console.warn(`[rebuild-missing-routes] downloadThenExtract: "${mod.name}" downloaded, but re-scan came back bucket="${result?.bucket}" (${result?.reason || 'no reason given'}) -- not resolved.`);
        }
        return { mod, result, extractResult };
    }

    // Downloads ONE mod's archive from Nexus, then immediately extracts via the shared chain above,
    // so the report row can update in place without a full re-scan. Response shape unchanged from
    // before this was factored out (2026-09-02) -- rmfDownloadArchive's own frontend handling needs
    // no changes.
    // "Open FOMOD mods get an Install button" (2026-09-17) -- looks up a mod purely by
    // collectionModId+modId+fileId (same identity every other per-mod route in this router already
    // uses), never by array position (a fresh scan could have reordered/removed rows since the
    // client last rendered them).
    function findModInCollection(collectionModId, modId, fileId) {
        if (!collectionModId || modId == null || fileId == null) {
            const err = new Error('collectionModId, modId, and fileId are required.'); err.code = 'bad-request'; throw err;
        }
        let collection;
        try {
            collection = loadCollection(path.join(staging, collectionModId, 'collection.json'));
        } catch (e) {
            const err = new Error(`Could not read this collection's collection.json: ${e.message}`); err.code = 'bad-request'; throw err;
        }
        const mod = collection.mods.find((m) => m.source?.modId === modId && m.source?.fileId === fileId);
        if (!mod) { const err = new Error('That mod was not found in this collection anymore -- try re-scanning.'); err.code = 'not-found'; throw err; }
        return mod;
    }

    // Peeks the mod's own real ModuleConfig.xml so the shared picker (web/public/fomod-picker.js)
    // has something to render -- the exact same lib/fomod-picker-data.js detectFomodChoiceNeed
    // Update Collection v2 already uses for its own gate, called here for a SINGLE mod at Install
    // click time rather than a whole batch. allowAutoDownload is always false here: an archive-
    // missing mod already has its own separate Download Archive action -- Install only ever offers
    // itself on a Couldn't Check row, which by definition already has a real, locatable archive
    // (scanOneMod only reaches 'skipped' for a mod whose archive it COULD read).
    router.post('/fomod-picker-data', async (req, res) => {
        if (!requireConfigured(res)) return;
        // ignoreFomodValidation (2026-09-15, "validate the installer against the real schema"): the
        // picker's own "Install Anyway" retry re-POSTs this SAME route with this flag set, after its
        // first call came back reason:'invalid'.
        const { collectionModId, modId, fileId, ignoreFomodValidation } = req.body || {};
        try {
            const mod = findModInCollection(collectionModId, modId, fileId);
            const need = await detectFomodChoiceNeed(mod, downloads, sevenZipExe, false, undefined, !!ignoreFomodValidation);
            if (!need) {
                return res.status(409).json({ error: 'not-a-fomod', message: "This mod's archive couldn't be read as a FOMOD installer right now -- try re-scanning." });
            }
            // Spread `need` whole (2026-09-15, "the Install picker never receives the installed-file
            // state") rather than hand-listing its fields -- the old hand-list silently dropped
            // detectFomodChoiceNeed's own `installedFileState` (added after this hand-list was
            // written), which is why the picker never had anything to pre-select against for either
            // Install action. `need` already contains only client-meant fields (name/reason/
            // parsedFomod/warnings/existingChoices/installedFileState) -- nothing internal to strip.
            res.json({ needs: [{ modId: String(modId), ...need }] });
        } catch (e) {
            const status = e.code === 'bad-request' ? 400 : e.code === 'not-found' ? 404 : 500;
            res.status(status).json({ error: e.message });
        }
    });

    // Real Install action -- REWRITTEN 2026-09-17 ("Install opens an invisible picker, and Install
    // should do a clean reinstall of the mod") from an additive-only extractResolvedFiles call (which
    // only ever ADDED missing files into whatever was already in the staging folder) to a genuine
    // clean reinstall: the SAME runner.installOpenFomodMod() Rebuild Collection's own install-fomod
    // route already uses (web/rebuild-routes.js, `/logs/:filename/install-fomod`), reused verbatim
    // rather than kept as a second, additive-only path. That function classifies the mod fresh with
    // these picks applied, then rebuildMod() extracts into a temp folder and swapInRebuiltMod()
    // replaces the staging folder outright (lock retries, rollback, and lib/game-edited-files.js's
    // own rule all included) -- an Open FOMOD mod's staging folder can hold files from whatever
    // options were picked before, so only adding missing files left the wrong mix behind. The end
    // state matches a fresh Vortex install with these exact picks, not a patched-up old one.
    router.post('/install-fomod', async (req, res) => {
        if (!requireConfigured(res)) return;
        // ignoreFomodValidation (2026-09-15, "validate the installer against the real schema"): set
        // when this Finish came from a picker session that went through the "Install Anyway"
        // override -- persisted onto the resulting choices so a later background rebuild of this
        // exact same mod doesn't re-block on the same already-confirmed archive.
        const { collectionModId, modId, fileId, picks, ignoreFomodValidation } = req.body || {};
        if (!collectionModId || modId == null || fileId == null) {
            return res.status(400).json({ error: 'collectionModId, modId, and fileId are required.' });
        }
        try {
            const outcome = await runner.installOpenFomodMod({
                collectionModId, stagingDir: staging, downloadsDir: downloads, sevenZipExe, modId, fileId, picks,
                ignoreFomodValidation: !!ignoreFomodValidation,
            });
            // installOpenFomodMod()'s own REBUILD shape flattens rebuildMod()'s result fields (status,
            // detail, ...) directly onto the outcome -- destructured out here so `mod`/`choices` (only
            // needed for the best-effort savePicksToVortex call below) never leak into the response,
            // and so `status` means the same thing (a real rebuildMod() status OR a non-REBUILD
            // classifyMod() action kind, e.g. SKIP_NO_ARCHIVE) whichever branch this outcome took --
            // status-labels.js's own STATUS_TEXT already maps both vocabularies, so the row can show
            // either one the same way.
            const { mod: installedMod, choices: installedChoices, kind: outcomeKind, ...rebuiltFields } = outcome;
            const status = outcomeKind === 'REBUILD' ? rebuiltFields.status : outcomeKind;
            const detail = outcomeKind === 'REBUILD' ? rebuiltFields.detail : outcome.detail;
            console.log(`[rebuild-missing-routes] install-fomod: modId=${modId} fileId=${fileId} -- ${status}${detail ? `: ${detail}` : ''}`);
            res.json({
                result: {
                    ok: status === 'REBUILT', status, detail,
                    targetFolderName: outcome.targetFolderName, archiveName: outcome.archiveName,
                    code: outcomeKind === 'REBUILD' ? undefined : outcome.code,
                    candidateFile: outcomeKind === 'REBUILD' ? undefined : outcome.candidateFile,
                    candidateFiles: outcomeKind === 'REBUILD' ? undefined : outcome.candidateFiles,
                },
            });

            // Save the picks back to Vortex's own live state -- best-effort, AFTER the real response
            // above, never something a save failure should block the Install action itself on. Fires
            // whenever classification itself reached REBUILD, regardless of whether the rebuild's own
            // status came back REBUILT or a failure (a lock, etc.) -- classification succeeding means
            // the picks themselves were valid even if the file-swap transiently failed, same
            // convention Rebuild Collection's own install-fomod route already established. See
            // lib/vortex-live-fomod-choices.js's own savePicksToVortex for what each outcome means.
            //
            // Own try/catch, deliberately NOT sharing the outer one below (2026-09-17, carried over
            // from this same route's prior version): res.json() already fired above, so anything
            // throwing after that point must never reach a catch block that tries to send a SECOND
            // response -- Express throws ERR_HTTP_HEADERS_SENT for exactly that.
            if (outcomeKind === 'REBUILD') {
                try {
                    const bridgeAvailable = await bridgeClient.checkBridgeAvailable(syncLib.GAME_ID);
                    const saveResult = await savePicksToVortex(installedMod, installedChoices, { bridgeAvailable });
                    if (saveResult.saved) {
                        console.log(`[rebuild-missing-routes] install-fomod: "${installedMod.name}" picks saved to Vortex's own live state (vortexModId=${saveResult.vortexModId}) -- won't show as Open FOMOD again.`);
                    } else {
                        console.warn(`[rebuild-missing-routes] install-fomod: "${installedMod.name}" picks NOT saved to Vortex (${saveResult.reason}${saveResult.message ? `: ${saveResult.message}` : ''}) -- this mod may still show as Open FOMOD on a future scan.`);
                    }
                } catch (e) {
                    console.warn(`[rebuild-missing-routes] install-fomod: saving picks to Vortex threw for "${installedMod.name}": ${e.message}`);
                }
            }
        } catch (e) {
            res.status(e.code === 'NOT_A_FOMOD' ? 409 : 500).json({ error: e.message });
        }
    });

    router.post('/download-archive', async (req, res) => {
        if (!requireConfigured(res)) return;
        const { collectionModId, modId, fileId } = req.body || {};
        try {
            const outcome = await downloadThenExtract({ collectionModId, modId, fileId });
            res.json({ result: outcome.result });
        } catch (e) {
            const statusByCode = { 'bad-request': 400, 'not-found': 404, 'not-nexus': 400, 'not-premium': 400, 'download-failed': 500 };
            const status = statusByCode[e.code] || 500;
            res.status(status).json(e.code === 'not-premium' ? { error: 'not-premium', message: e.message } : { error: e.message });
        }
    });

    // A non-Nexus ('archive-missing' with no modId/fileId) row's own "Browse…" action -- ports
    // Rebuild Collection's already-shipped off-site Import flow (lib/collection-runner.js's
    // importOffSiteArchive/extractImportedOffSiteMod, backed by lib/offsite-import-map.js +
    // classifyMod's own overrideArchivePath) rather than a second implementation. Mirrors the
    // log-view/Work Through Report version of this route (web/rebuild-routes.js's own
    // POST /logs/:filename/import-offsite) -- import THEN immediately re-attempt in one step, since
    // that's this tool's own established single-row-resolve convention (rmfDownloadArchive), not the
    // Plan page's two-step version (which has no report row yet to update).
    //
    // Looked up by {collectionModId, name}, never modId/fileId -- an off-site mod has neither; same
    // identity offsite-import-map.json itself is keyed by.
    router.post('/import-offsite', async (req, res) => {
        if (!requireConfigured(res)) return;
        const { collectionModId, name } = req.body || {};
        if (!collectionModId || !name) return res.status(400).json({ error: 'collectionModId and name are required.' });
        let picked;
        try {
            picked = await pickOpenFileAsync({
                title: `Select the archive for "${name}"`,
                filter: 'Archive files (*.zip;*.7z;*.rar)|*.zip;*.7z;*.rar|All files (*.*)|*.*',
            });
        } catch (e) {
            return res.status(500).json({ error: `File picker failed: ${e.message}` });
        }
        if (!picked) return res.json({ ok: false, cancelled: true });
        try {
            runner.importOffSiteArchive({ downloadsDir: downloads, collectionModId, name, pickedFilePath: picked });
            const outcome = await runner.extractImportedOffSiteMod({
                collectionModId, stagingDir: staging, downloadsDir: downloads, sevenZipExe, name,
            });
            // "Last dealt with" (queue: rebuild-missing-last-fixed) -- same real-fix bar every other
            // successful-restore path in this router already applies (a REBUILD is a genuine write to
            // the staging folder, same as a real extraction).
            if (outcome.kind === 'REBUILD') lastFixedState.markFixed(collectionModId);
            res.json({ ok: true, outcome });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Real Deploy step -- MOVED to the shared web/deploy-routes.js (2026-09-14, "the same Deploy
    // step on every Done screen"), mounted at /api/deploy. The client (rebuild-missing-app.js's
    // rmfStartDeploy) now calls /api/deploy/all + /api/deploy/all/progress instead of this router's
    // own copies.

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
        try { openFolderInExplorer(folderPath); } catch (e) { return res.status(400).json({ error: e.message }); }
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createRebuildMissingRouter };
