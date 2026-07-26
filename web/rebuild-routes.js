'use strict';
// Thin Express handlers -- all real logic lives in lib/collection-runner.js (shared with the
// CLI) and web/run-state.js (SSE/single-run bookkeeping). Nothing destructive happens here
// without a fresh Vortex-closed check and a freshly-recomputed plan; a client-held plan is never
// trusted for anything that touches the filesystem.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const runner = require('../lib/collection-runner');
const { findSevenZip } = require('../lib/sevenzip');
const nexusDownload = require('../lib/nexus-collection-download');
const nexusModDownload = require('../lib/nexus-mod-download');
const appConfig = require('../lib/app-config');
const { pickOpenFileAsync } = require('../lib/vortex-sync/win-dialog');
const runState = require('./run-state');
const { createSseSession } = require('./sse-session');

const planSession = createSseSession();
const vortexDataSession = createSseSession();

function createRouter(config) {
    const router = express.Router();
    const { staging, downloads, state, backupRoot } = config;
    const syncLib = runner.loadSyncLib();
    const sevenZipExe = findSevenZip();
    const logsDir = path.join(__dirname, '..', 'logs');

    // Shared by /retry-download and /import-offsite -- a FAILED_EXTRACTION_* row with
    // archiveNotFound is the SAME underlying problem as SKIP_NO_ARCHIVE (the archive genuinely isn't
    // there), just discovered later, at actual extraction time instead of during classification.
    function isArchiveMissingStatus(entry) {
        return entry.status === 'SKIP_NO_ARCHIVE'
            || ((entry.status === 'FAILED_EXTRACTION_NOT_TOUCHED' || entry.status === 'FAILED_EXTRACTION_NO_PRIOR_DATA') && entry.archiveNotFound);
    }

    // Cache of loadSyncState results, keyed by collectionModId -- populated by
    // POST /api/rebuild/vortex-data/refresh (one shared DB open across every installed collection,
    // instead of one risky open per collection viewed). Vortex's state cannot change while it's
    // closed, and this whole tool requires Vortex closed anyway, so this cache stays valid for as
    // long as the user doesn't reopen Vortex -- exactly the real workflow (working through several
    // collections in one sitting). null value = attempted but that specific collection failed
    // (surfaced to the caller, not silently dropped); absent key = never attempted at all.
    const syncStateCache = new Map();
    let vortexDataLoadedAt = null;
    // Vortex-tracked collections with no collection.json at all (never published, or published but
    // only the Workshop copy kept locally) -- populated by /vortex-data/refresh, surfaced by
    // /collections as an explicit "can't extract these, here's why" note instead of silence.
    let workshopOnlyCollections = [];

    // Resumable IFF the collection's own MOST RECENT real (non-dry-run) attempt didn't finish
    // cleanly -- NOT "does any in-progress log exist anywhere in history". An earlier version just
    // picked the in-progress/halted-critical log with the latest startedAt, which kept offering a
    // stale resume forever once superseded: e.g. an attempt crashes and leaves its log stuck at
    // "in-progress", then a LATER --resume (run outside the web UI, so it writes its own new log
    // rather than updating the old one) actually finishes the collection -- the old crashed log's
    // in-progress status never changes, so it kept winning the "latest in-progress" comparison even
    // though nothing was left to resume. Confirmed live: Beauty Salon for GTS showed "Resumable"
    // after being fully completed via the CLI. Dry-run logs are excluded entirely -- they're
    // read-only/informational and don't reflect real completion state.
    // Most recent REAL (non-dry-run) log for a collection, regardless of how it ended -- shared by
    // findResumableLog (below) and the /collections route's "last extracted" timestamp, so both
    // agree on what "the latest attempt" means instead of scanning logsDir twice with slightly
    // different rules.
    function findLatestRealLog(collectionModId) {
        let files;
        try {
            files = fs.readdirSync(logsDir).filter((f) => f.startsWith(`rebuild-${collectionModId}-`) && f.endsWith('.json'));
        } catch {
            return null;
        }
        let latest = null;
        for (const f of files) {
            const full = path.join(logsDir, f);
            let log;
            try {
                log = JSON.parse(fs.readFileSync(full, 'utf8'));
            } catch {
                continue;
            }
            if (log.runStatus === 'dry-run-complete') continue;
            if (!latest || new Date(log.startedAt) > new Date(latest.log.startedAt)) latest = { path: full, log };
        }
        return latest;
    }

    function findResumableLog(collectionModId) {
        const latest = findLatestRealLog(collectionModId);
        if (!latest) return null;
        if (latest.log.runStatus !== 'in-progress' && latest.log.runStatus !== 'halted-critical') return null;
        return {
            path: latest.path,
            runStatus: latest.log.runStatus,
            finishedAt: latest.log.finishedAt,
            summary: latest.log.summary,
        };
    }

    // For the collection picker's "Last extracted: ..." label -- only a genuinely COMPLETED run
    // counts (an in-progress/halted-critical log isn't "when it was last extracted", it's an
    // unfinished attempt; findResumableLog already surfaces that case separately).
    function findLastExtracted(collectionModId) {
        const latest = findLatestRealLog(collectionModId);
        if (!latest || latest.log.runStatus !== 'completed') return null;
        return latest.log.finishedAt || latest.log.startedAt;
    }

    router.get('/collections', (req, res) => {
        // No staging folder configured yet (fresh install, before the Settings page has been filled
        // in) -- a valid, expected state, not an error. The picker just shows nothing to pick yet.
        if (!staging) {
            return res.json({ collections: [], vortexDataLoadedAt, workshopOnlyCollections: [], configured: false });
        }
        let collections;
        try {
            collections = syncLib.scanStagingCollections(staging);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
        const withResume = collections.map((c) => {
            const cached = syncStateCache.get(c.modId);
            // Prefer Vortex's own LIVE display name (e.g. a user's local "My ..." rename) over
            // collection.json's baked-in original published name -- only available once Vortex data
            // has been loaded (a live state read), so falls back to the original name until then.
            const liveName = cached && cached.ok ? cached.data.liveName : undefined;
            // Same cache backs the "View on Nexus" button for an already-installed collection --
            // only known once Vortex data has been loaded, same caveat as liveName above.
            const collectionSlug = cached && cached.ok ? cached.data.collectionSlug : undefined;
            return {
                ...c,
                name: liveName || c.name,
                originalName: c.name,
                collectionSlug: collectionSlug || null,
                resumableLog: findResumableLog(c.modId),
                lastExtracted: findLastExtracted(c.modId),
                vortexDataCached: cached ? cached.ok : false,
                vortexDataError: cached && !cached.ok ? cached.error : null,
            };
        });
        // scanStagingCollections already sorts, but on the ORIGINAL collection.json name -- the
        // liveName override just above can change what's actually displayed (e.g. a Vortex "My ..."
        // rename), so re-sort here on the name actually shown, not the one used to sort upstream.
        withResume.sort((a, b) => a.name.localeCompare(b.name));
        // lastExtracted must be recomputed fresh here every time, same as the main list just above
        // -- it was previously only ever set once, inside /vortex-data/refresh's background work,
        // then left stale in this module-level list until the next full refresh. Confirmed live:
        // rebuilding a Workshop-fetched collection (e.g. via the "Fetch from Nexus" -> Plan ->
        // rebuild flow) wrote a brand new log, but the Workshop dropdown kept showing no/old "Last
        // extracted" info until a fresh "Load Vortex Data" click, since nothing else re-ran
        // findLastExtracted for these entries in between.
        const workshopOnlyWithLastExtracted = workshopOnlyCollections.map((w) => ({ ...w, lastExtracted: findLastExtracted(w.modId) }));
        res.json({ collections: withResume, vortexDataLoadedAt, workshopOnlyCollections: workshopOnlyWithLastExtracted });
    });

    router.get('/vortex-status', (req, res) => {
        res.json({ running: syncLib.isVortexRunning() });
    });

    // Pulls a real collection.json for a Workshop-only collection straight from Nexus (bypassing
    // the nxm:// protocol / Vortex entirely) -- see lib/nexus-collection-download.js. Only ever
    // fetches the LAST PUBLISHED revision; the frontend shows the "may be stale vs. an
    // un-uploaded Workshop edit" warning before this is called. Once written, the collection
    // starts showing up normally via /collections (scanStagingCollections just needs the file to
    // exist on disk) -- no cache invalidation needed here beyond that.
    router.post('/workshop/fetch-from-nexus', async (req, res) => {
        const { slug, folder, revisionNumber } = req.body || {};
        if (!slug || typeof slug !== 'string' || !slug.trim()) {
            return res.status(400).json({ error: 'Missing or invalid "slug".' });
        }
        if (!folder || typeof folder !== 'string' || !folder.trim()) {
            return res.status(400).json({ error: 'Missing or invalid "folder".' });
        }
        const revNum = revisionNumber ? parseInt(revisionNumber, 10) : undefined;
        const destDir = path.join(staging, folder);
        try {
            const result = await nexusDownload.fetchAndExtractCollectionJson({ slug: slug.trim(), revisionNumber: revNum, destDir, sevenZipExe });
            // Previously removed this collection from the cached Workshop-only list here, on the
            // assumption a fetched collection.json makes it "a real, scannable staging folder" the
            // main list should handle instead. Confirmed wrong (2026-07-24): fetching a
            // collection.json for a Workshop draft doesn't make it a real installed collection --
            // scanStagingCollections (vortex-sync/lib.js) now excludes this folder-naming
            // convention from the main list unconditionally, so it stays exactly where it belongs,
            // in the Workshop-only list, whether or not a collection.json is cached here.
            const collectionModId = folder.trim();
            // Confirmed live this session: a stale cache entry from BEFORE this fetch (e.g. an
            // earlier "Load Vortex Data") carries the OLD collection.json's mod objects, including
            // their choices -- computePlan (below) trusts this cache over re-reading the file, so a
            // fetch that just wrote fresh FOMOD choices to disk had no effect on the plan at all,
            // silently falling back to SKIP_OPEN_FOMOD as if no choices existed. MUST drop the old
            // entry unconditionally, before attempting to repopulate it below -- if that attempt
            // fails (the same native-LevelDB crash risk this whole tool isolates against; confirmed
            // live, an assertion dialog firing here reproduced exactly this bug), the old entry needs
            // to be GONE, not left in place, so computePlan's cache-miss branch does a fresh read
            // instead of silently reusing pre-fetch data.
            syncStateCache.delete(collectionModId);
            // Also populate THIS one collection's Vortex-sync-state cache right away -- confirmed
            // live this was otherwise confusing: the collection appears correctly in the main
            // picker immediately (a plain filesystem scan), but with no "✓ Vortex data cached"
            // mark until the next full "Load Vortex Data" click, since that's the only thing that
            // normally populates syncStateCache. One small isolated-child-process batch read (same
            // mechanism /api/rebuild/vortex-data/refresh uses, just for this single collectionModId) closes
            // that gap. Best-effort: a failure here (e.g. the native LevelDB crash this whole tool
            // isolates against) just means this one entry stays uncached (not stale -- already
            // deleted above) until the next manual refresh -- never lets a state-read problem fail
            // the fetch that already succeeded.
            try {
                const collectionInfo = runner.resolveCollectionInfo(staging, collectionModId);
                const { results } = await runner.loadSyncStateBatch({
                    state, entries: [{ modId: collectionModId, collection: collectionInfo.collection }], stagingDir: staging,
                });
                const entry = results.get(collectionModId);
                if (entry) syncStateCache.set(collectionModId, entry);
            } catch { /* best-effort, see comment above */ }
            res.json({ ok: true, ...result });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Read-only lookup backing the revision picker: which revisions of this Nexus collection are
    // ACTUALLY published (vs. a work-in-progress draft) -- see fetchCollectionRevisions' own
    // comment for why this can't just be "the highest revision number so far".
    router.get('/workshop/nexus-revisions', async (req, res) => {
        const { slug } = req.query;
        if (!slug || typeof slug !== 'string' || !slug.trim()) {
            return res.status(400).json({ error: 'Missing or invalid "slug".' });
        }
        try {
            const apiKey = nexusDownload.resolveApiKey();
            const result = await nexusDownload.fetchCollectionRevisions(apiKey, slug.trim());
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/vortex-data/status', (req, res) => {
        res.json({ loadedAt: vortexDataLoadedAt, cachedCount: syncStateCache.size });
    });

    router.get('/vortex-data/events', (req, res) => {
        if (!vortexDataSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        vortexDataSession.subscribe(res, { afterSeq });
    });

    // One shared DB open across EVERY installed collection, instead of one risky open per
    // collection viewed -- see syncStateCache's own comment above for the rationale (Vortex's
    // state can't change while it's closed, and this tool requires Vortex closed anyway).
    router.post('/vortex-data/refresh', (req, res) => {
        if (!staging) {
            return res.status(400).json({ error: 'not-configured', message: 'Staging folder is not configured yet -- open Settings to set it up.' });
        }
        if (syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }
        let collections;
        try {
            collections = syncLib.scanStagingCollections(staging);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }

        const mySession = vortexDataSession.start({ id: `refresh-${Date.now()}` });
        res.status(202).json({ count: collections.length });

        // Same class of race as POST /plan (see its comment) -- an overlapping refresh request
        // must not have its late events land in a newer/different session.
        const emitIfCurrent = (event) => {
            if (vortexDataSession.get() === mySession) vortexDataSession.emit(event);
        };

        (async () => {
            try {
                emitIfCurrent({ type: 'phase', phase: 'reading', count: collections.length });
                const entries = collections.map((c) => ({ modId: c.modId, collection: runner.resolveCollectionInfo(staging, c.modId).collection }));
                const { results, workshopOnlyCollections: found } = await runner.loadSyncStateBatch({
                    state, entries, stagingDir: staging,
                    onProgress: (p) => emitIfCurrent({ type: 'sync-state-progress', ...p }),
                });
                for (const [modId, result] of results) syncStateCache.set(modId, result);
                vortexDataLoadedAt = new Date().toISOString();
                // Same enrichment the main list gets (see GET /collections above) -- lost when a
                // Workshop entry stopped being (mis)routed through the main list's own rendering.
                // A Workshop-tab modId can genuinely have a real rebuild log (nothing stops running
                // Rebuild Collection against one directly, e.g. while testing), so this isn't
                // hypothetical.
                // scanAllCollections returns these in whatever order the state DB's iterator
                // happened to yield keys in (not alphabetical) -- sort here, same as the main list.
                workshopOnlyCollections = found
                    .map((w) => ({ ...w, lastExtracted: findLastExtracted(w.modId) }))
                    .sort((a, b) => a.name.localeCompare(b.name));
                const failed = [...results.entries()].filter(([, r]) => !r.ok).map(([modId, r]) => ({ modId, error: r.error }));
                emitIfCurrent({ type: 'refresh-complete', done: true, loadedCount: results.size, failed, loadedAt: vortexDataLoadedAt });
            } catch (e) {
                emitIfCurrent({ type: 'refresh-error', done: true, error: true, message: e.message });
            }
        })();
    });

    async function computePlan(collectionModId, resumeLogPath, onModClassified, onSyncStateProgress) {
        const collectionInfo = runner.resolveCollectionInfo(staging, collectionModId);
        const cached = syncStateCache.get(collectionModId);
        let ignored, removedMods, keptMods, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey;
        if (cached) {
            if (!cached.ok) throw new Error(cached.error);
            ({ ignored, removedMods, keptMods, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey } = cached.data);
        } else {
            ({ ignored, removedMods, keptMods, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey } = await runner.loadSyncState({
                state, collectionModId: collectionInfo.modId, collection: collectionInfo.collection, stagingDir: staging,
                onProgress: onSyncStateProgress,
            }));
        }
        const resumed = resumeLogPath ? runner.loadResumeLog(resumeLogPath) : new Map();
        const { downloadMissingArchives, forceExtractOffSiteMismatches } = appConfig.loadConfig();
        const { modEntries, rebuildQueue } = await runner.buildPlan({
            collectionModId, removedMods, keptMods, knownVortexModIds, resumed, otherVersionsByModId, sharedWithCollectionsByKey,
            downloadsDir: downloads, stagingDir: staging, sevenZipExe, logsDir, onModClassified,
            downloadMissingArchivesEnabled: downloadMissingArchives,
            forceExtractOffSiteMismatchesEnabled: forceExtractOffSiteMismatches,
        });
        return { collectionInfo, ignored, keptMods, knownVortexModIds, modEntries, rebuildQueue, otherVersionsByModId, sharedWithCollectionsByKey };
    }

    // Serializes a rebuildQueue entry (which carries live archive paths etc.) down to what the
    // frontend actually needs to render a plan row.
    function rebuildQueueToJson(rebuildQueue) {
        return rebuildQueue.map(({ mod, action, base }) => ({
            name: mod.name,
            existingStagingFolder: action.existingStagingFolder,
            targetFolderName: action.targetFolderName,
            otherVersionsNote: base?.otherVersionsNote,
            sharedWithNote: base?.sharedWithNote,
            forcedMismatch: action.forcedMismatch || undefined,
        }));
    }

    router.get('/plan/current/events', (req, res) => {
        if (!planSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        planSession.subscribe(res, { afterSeq });
    });

    // Computing a plan means locating + (sometimes) md5-hashing every kept mod's archive --
    // real time for a large collection (Beauty Salon for GTS: 96 mods). Streamed via SSE (its
    // own session, separate from run-state's single-run guard -- viewing a plan is read-only, so
    // it should never be blocked by, or block, an actual rebuild) so the UI can show live
    // per-mod progress instead of an unexplained spinner that looks identical whether it's
    // working or hung.
    router.post('/plan', async (req, res) => {
        const { collectionModId, resumeLogPath } = req.body || {};
        if (!collectionModId) return res.status(400).json({ error: 'collectionModId is required.' });
        if (!staging || !downloads) {
            return res.status(400).json({ error: 'not-configured', message: 'Staging/downloads folders are not configured yet -- open Settings to set them up.' });
        }
        if (syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }

        const mySession = planSession.start({ id: `${collectionModId}-${Date.now()}` });
        res.status(202).json({});

        // Guards against a real race confirmed live: viewing a second collection's plan before the
        // first one's background computation finishes replaces the shared planSession, but the
        // FIRST request's async work keeps running regardless -- without this check, its late-
        // arriving events (including its own plan-ready, carrying the WRONG collection's data) get
        // written into whatever session is current by the time it finishes, silently overwriting
        // the second collection's in-progress or already-shown plan. Symptom seen directly: asked
        // for "GTS Community Edition", got "Beauty Salon for GTS" results instead. Each request now
        // only ever emits into the exact session IT started -- once superseded, its results are
        // simply and silently dropped instead of clobbering whichever plan the user is now viewing.
        const emitIfCurrent = (event) => {
            if (planSession.get() === mySession) planSession.emit(event);
        };

        (async () => {
            try {
                emitIfCurrent({
                    type: 'phase',
                    phase: syncStateCache.has(collectionModId) ? 'sync-state-cached' : 'sync-state',
                });
                const { collectionInfo, ignored, keptMods, knownVortexModIds, modEntries, rebuildQueue } = await computePlan(
                    collectionModId, resumeLogPath,
                    (entry, index, total) => emitIfCurrent({ type: 'classify-progress', name: entry.name, status: entry.status, index, total }),
                    (p) => emitIfCurrent({ type: 'sync-state-progress', ...p })
                );
                emitIfCurrent({
                    type: 'plan-ready',
                    done: true,
                    collectionInfo: { modId: collectionInfo.modId, name: collectionInfo.name, totalModsInCollection: collectionInfo.collection.mods.length },
                    ignoredCount: ignored.length,
                    knownVortexModIdCount: knownVortexModIds.size,
                    keptModCount: keptMods.length,
                    modEntries,
                    rebuildQueue: rebuildQueueToJson(rebuildQueue),
                    summary: runner.summarize([...modEntries, ...rebuildQueue.map(() => ({ status: 'REBUILD' }))]),
                    openFomodMods: runner.getOpenFomodMods(modEntries),
                    offSiteMissingMods: runner.getOffSiteMissingMods(modEntries),
                    resumableLog: findResumableLog(collectionModId),
                });
            } catch (e) {
                emitIfCurrent({ type: 'plan-error', done: true, error: true, message: e.message });
            }
        })();
    });

    // Plan-page "Import" button -- opens a native file picker (the user can point at the archive
    // wherever they actually saved it, no need to move it into the downloads folder by hand first),
    // then moves it there and records the mod association (lib/offsite-import-map.js). Does NOT
    // extract anything itself -- there's no log yet at this point (pre-run), so the user still
    // clicks "Downloaded and Start Rebuild" afterward, same as the plain-download case. Deliberately
    // does NOT check isVortexRunning() -- this only touches the downloads folder + a JSON mapping
    // file, never Vortex's own state.
    router.post('/import-offsite-archive', async (req, res) => {
        const { collectionModId, name } = req.body || {};
        if (!collectionModId || !name) return res.status(400).json({ error: 'collectionModId and name are required.' });
        if (!downloads) return res.status(400).json({ error: 'Downloads folder is not configured yet -- open Settings.' });
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
            const { filename } = runner.importOffSiteArchive({ downloadsDir: downloads, collectionModId, name, pickedFilePath: picked });
            res.json({ ok: true, filename });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    router.get('/runs/current', (req, res) => {
        const run = runState.getCurrentRun();
        if (!run) return res.json({ active: false });
        res.json({
            active: runState.isRunActive(),
            runId: run.runId,
            collectionModId: run.collectionModId,
            phase: run.phase,
            events: run.eventBuffer,
        });
    });

    router.get('/runs/current/events', (req, res) => {
        if (!runState.getCurrentRun()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        runState.subscribe(res, { afterSeq });
    });

    router.post('/runs', async (req, res) => {
        const { collectionModId, resumeLogPath } = req.body || {};
        if (!collectionModId) return res.status(400).json({ error: 'collectionModId is required.' });
        if (!staging || !downloads) {
            return res.status(400).json({ error: 'not-configured', message: 'Staging/downloads folders are not configured yet -- open Settings to set them up.' });
        }
        if (syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }

        const runId = `${collectionModId}-${Date.now()}`;
        let run;
        try {
            run = runState.startRun({ runId, collectionModId });
        } catch (e) {
            if (e.code === 'RUN_ACTIVE') return res.status(409).json({ error: 'run-active', message: e.message });
            throw e;
        }
        res.status(202).json({ runId });

        // Detached background task -- the response has already been sent; everything from here
        // reports progress exclusively through runState.emit() (SSE), matching the CLI's own
        // never-trust-a-stale-plan discipline: the plan is recomputed fresh, not reused from a
        // client's earlier /api/rebuild/plan call, since real time (and possibly Vortex state) may have
        // passed since then.
        (async () => {
            const startedAt = new Date().toISOString();
            const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
            let logPath;
            try {
                const syncStateStart = Date.now();
                runState.emit({ type: 'phase', phase: 'sync-state' });
                const { collectionInfo, modEntries, rebuildQueue, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey } = await computePlan(
                    collectionModId, resumeLogPath, undefined,
                    (p) => runState.emit({ type: 'sync-state-progress', ...p })
                );
                logPath = path.join(logsDir, `rebuild-${collectionInfo.modId}-${runTimestamp}.json`);

                // Stats Report data (schemaVersion 3) -- phaseDurationsMs/concurrentExtractionsForThisRun
                // are mutated in place below as each phase actually happens; currentLog()'s closure
                // picks up whatever's been set so far, so even a run that dies early logs partial,
                // honest data (null for anything never reached) rather than nothing at all.
                const phaseDurationsMs = { syncStateMs: Date.now() - syncStateStart, backupMs: null, rebuildMs: null };
                let concurrentExtractionsForThisRun = null; // set later, at the SAME fresh-read point as today -- see note below
                let downloadResults = null; // set below if the download phase runs; closed over here
                const currentLog = (runStatus) => runner.buildLogData({
                    collectionInfo, stagingDir: staging, downloadsDir: downloads, backupRoot,
                    dryRun: false, startedAt, runStatus, modEntries, downloadResults,
                    concurrentExtractions: concurrentExtractionsForThisRun, phaseDurationsMs,
                });

                runState.emit({ type: 'phase', phase: 'plan-ready', modEntries, rebuildQueueCount: rebuildQueue.length, openFomodMods: runner.getOpenFomodMods(modEntries) });
                runner.writeLog(logPath, currentLog('in-progress'));

                // Auto-download missing archives (opt-in, Premium-only -- see
                // lib/nexus-mod-download.js's header comment for why free accounts are refused
                // entirely rather than worked around). Runs BEFORE the empty-queue check below, so a
                // plan whose only gap is missing archives gets a real chance to fill it first, not an
                // immediate "nothing to rebuild".
                const { downloadMissingArchives } = appConfig.loadConfig();
                // HASH_MISMATCH is eligible too -- a same-size "candidate" is a coincidence, not the
                // real file, so downloading the correct one fixes it. AMBIGUOUS (multiple candidates
                // that ARE byte-identical correct matches) is excluded -- a real duplicate needing a
                // human, not something auto-download can resolve.
                const eligibleForDownload = modEntries.filter((e) =>
                    e.status === 'SKIP_NO_ARCHIVE' && (e.code === 'NOT_FOUND' || e.code === 'HASH_MISMATCH'));
                const missingNexusMods = collectionInfo.collection.mods.filter((m) =>
                    m.source?.type === 'nexus' && eligibleForDownload.some((e) => e.modId === m.source?.modId && e.fileId === m.source?.fileId));
                if (downloadMissingArchives && missingNexusMods.length > 0) {
                    runState.emit({ type: 'phase', phase: 'checking-premium' });
                    const apiKey = nexusModDownload.resolveApiKey();
                    const premium = await nexusModDownload.checkPremiumStatus(apiKey);
                    if (!premium.isPremium) {
                        runState.emit({
                            type: 'download-skipped', reason: 'not-premium', count: missingNexusMods.length,
                            message: "Nexus API only allows automated downloads for Premium accounts -- this respects Nexus's ad-supported download model for free users. Download these archives manually from Nexus and let Vortex install them, or upgrade to Premium.",
                        });
                        downloadResults = { results: [], skippedReason: 'not-premium' };
                    } else {
                        runState.emit({ type: 'phase', phase: 'downloading-missing', count: missingNexusMods.length });
                        downloadResults = await nexusModDownload.downloadMissingArchivesForPlan({
                            mods: missingNexusMods, downloadsDir: downloads, gameDomain: collectionInfo.collection.info?.domainName, apiKey,
                            onProgress: (p) => runState.emit({ type: 'download-progress', ...p }),
                        });
                        const downloadedMods = missingNexusMods.filter((m) =>
                            downloadResults.results.some((r) => r.modId === m.source.modId && r.fileId === m.source.fileId && r.status === 'DOWNLOADED'));
                        if (downloadedMods.length > 0) {
                            const newItems = await runner.reclassifyDownloadedMods({
                                downloadedMods, modEntries, knownVortexModIds,
                                otherVersionsByModId, sharedWithCollectionsByKey,
                                downloadsDir: downloads, stagingDir: staging, sevenZipExe, logsDir,
                            });
                            rebuildQueue.push(...newItems);
                        }
                        runState.emit({ type: 'download-complete', ...downloadResults });
                    }
                    runner.writeLog(logPath, currentLog('in-progress'));
                }

                if (rebuildQueue.length === 0) {
                    runner.writeLog(logPath, currentLog('completed'));
                    runState.emit({ type: 'run-complete', runStatus: 'completed', summary: runner.summarize(modEntries), totalMods: modEntries.length, logPath, backupRunDir: null, openFomodMods: runner.getOpenFomodMods(modEntries) });
                    return;
                }

                // maxBackupsToKeep is read fresh (not baked into config at server startup) --
                // unlike the path settings, changing it never needs a restart. 0 means off (skip
                // the backup step entirely); null means unlimited (back up, never prune); 1-3 means
                // back up then prune down to that many most recent.
                const { maxBackupsToKeep, concurrentExtractions } = appConfig.loadConfig();
                // Recorded here, at the SAME fresh-read point the setting has always been read at
                // (deliberately not hoisted earlier) -- a long download phase could see a real
                // Settings change take effect before this point, exactly as before this feature.
                concurrentExtractionsForThisRun = concurrentExtractions;
                let backupRunDir = null;
                // Two DIFFERENT skip reasons used to be reported identically ("Skipped (disabled in
                // Settings)") -- confirmed live this was actively misleading for the second case:
                // backups deliberately turned OFF (maxBackupsToKeep === 0, the intentional default)
                // vs. backups turned ON but with nowhere configured to put them (backupRoot blank) --
                // a real misconfiguration a user would want to notice and fix, not something that
                // reads as "working as intended". Distinguished here so the client can say which one
                // actually happened, matching this project's existing convention of surfacing a
                // misconfigured-but-non-fatal state clearly instead of silently doing less than
                // requested (see the not-Premium download-skip callout elsewhere in this same file).
                if (maxBackupsToKeep === 0) {
                    runState.emit({ type: 'phase', phase: 'backing-up', skipped: true, skippedReason: 'disabled' });
                    runState.emit({ type: 'backup-complete', skipped: true, skippedReason: 'disabled' });
                } else if (!backupRoot) {
                    runState.emit({ type: 'phase', phase: 'backing-up', skipped: true, skippedReason: 'not-configured' });
                    runState.emit({ type: 'backup-complete', skipped: true, skippedReason: 'not-configured' });
                } else {
                    const backupStart = Date.now();
                    runState.emit({ type: 'phase', phase: 'backing-up' });
                    let backedUpCount;
                    ({ backupRunDir, backedUpCount } = await runner.runBackup({
                        rebuildQueue, backupRoot, collectionModId: collectionInfo.modId, runTimestamp,
                        onProgress: (p) => runState.emit({ type: 'backup-progress', ...p }),
                    }));
                    phaseDurationsMs.backupMs = Date.now() - backupStart;
                    runner.pruneOldBackups({ backupRoot, collectionModId: collectionInfo.modId, maxBackupsToKeep });
                    // A separate, PERSISTENT event from the transient 'phase'/'backup-progress' text --
                    // for a small/fast collection the whole backup can finish in under a second (confirmed
                    // live: 20 mods, 849ms), too fast for the live phase indicator to be noticed at all.
                    // The client keeps this visible for the rest of the run instead of letting it get
                    // overwritten the instant 'phase: rebuilding' arrives.
                    runState.emit({ type: 'backup-complete', backedUpCount, backupRunDir, durationMs: phaseDurationsMs.backupMs });
                }

                const rebuildStart = Date.now();
                runState.emit({ type: 'phase', phase: 'rebuilding' });
                const { haltedCritical } = await runner.runRebuild({
                    rebuildQueue, collectionJsonPath: collectionInfo.collectionJsonPath,
                    downloadsDir: downloads, stagingDir: staging, modEntries,
                    concurrency: concurrentExtractions,
                    onModStart: (mod) => runState.emit({ type: 'mod-start', modName: mod.name }),
                    onModComplete: (entry) => {
                        runState.emit({ type: 'mod-complete', ...entry });
                        runner.writeLog(logPath, currentLog('in-progress'));
                        if (entry.status === 'CRITICAL_MANUAL_RESTORE_NEEDED') {
                            runState.emit({ type: 'critical-halt', modName: entry.name, oldContentDir: entry.oldContentDir, rebuildingDir: entry.rebuildingDir, stagingModDir: entry.stagingModDir, logPath });
                        }
                    },
                });
                phaseDurationsMs.rebuildMs = Date.now() - rebuildStart;

                const finalRunStatus = haltedCritical ? 'halted-critical' : 'completed';
                runner.writeLog(logPath, currentLog(finalRunStatus));
                runState.emit({
                    type: 'run-complete', runStatus: finalRunStatus, summary: runner.summarize(modEntries),
                    totalMods: modEntries.length, logPath, backupRunDir, openFomodMods: runner.getOpenFomodMods(modEntries),
                });
            } catch (e) {
                runState.emit({ type: 'run-error', message: e.message });
            }
        })();
    });

    router.get('/logs/:collectionModId', (req, res) => {
        let files;
        try {
            files = fs.readdirSync(logsDir).filter((f) => f.startsWith(`rebuild-${req.params.collectionModId}-`) && f.endsWith('.json'));
        } catch {
            return res.json({ logs: [] });
        }
        const logs = files
            .map((f) => {
                try {
                    return { file: f, ...JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf8')) };
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            // Dry-run logs are testing/preview artifacts, not real run history -- this list is for
            // browsing what actually happened to a collection, so they're noise here (and this
            // session alone produced several while debugging). Real logs only: in-progress,
            // halted-critical, completed.
            .filter((log) => log.runStatus !== 'dry-run-complete')
            .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
        res.json({ logs });
    });

    // Renders one specific log file as a readable HTML page (dark-themed, reuses styles.css) --
    // opened in a new tab from the summary view instead of forcing the user out to a raw JSON file
    // in a text editor via Reveal. filename is validated against the exact rebuild-log naming
    // pattern and re-resolved inside logsDir so this can never be used to read an arbitrary file.
    router.get('/logs/view/:filename', (req, res) => {
        const { filename } = req.params;
        if (!/^rebuild-.+\.json$/.test(filename)) return res.status(400).send('Invalid log filename.');
        const full = path.join(logsDir, filename);
        if (path.dirname(full) !== logsDir) return res.status(400).send('Invalid log filename.');
        let log;
        try {
            log = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            return res.status(404).send('Log file not found.');
        }
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        // ?from=work-through|stats (set by those pages' own "View Log" links) -- lets the back
        // button say "Back to Reports" and land on the exact sub-tab this was opened from, instead
        // of the generic "Back to Collections" default (which is still correct when this log was
        // reached some other way, e.g. from the main collection picker).
        const cameFromReports = req.query.from === 'work-through' || req.query.from === 'stats';
        // req.query.status carries the active badge filter (set by the Reports page's own "View
        // Log" link) so it round-trips back too -- confirmed live this was dropped here even though
        // the log page itself already restores it from this same query string on its own load
        // (see applyStatusFilter(...) in this page's embedded script below). Without this, "Back to
        // Reports" landed on the right sub-tab but always reset to "Show all", losing whatever
        // status badge was selected before clicking into the log.
        const statusQuery = req.query.status ? `&status=${encodeURIComponent(req.query.status)}` : '';
        const backButtonHtml = cameFromReports
            ? `<a href="${esc(`/?reports=${req.query.from}${statusQuery}`)}" class="btn btn--nav btn--back">&larr; Back to Reports</a>`
            : `<a href="/" class="btn btn--nav btn--back">&larr; Back to Collections</a>`;
        // Same breadcrumb-trail convention as the main SPA's #headerMeta label (shell.js's
        // setPageLabel) -- this page is server-rendered separately from that app, so it gets its own
        // static equivalent here rather than trying to share the JS mechanism across that boundary.
        const breadcrumb = req.query.from === 'work-through' ? 'Reports > Work Through Report > Log View'
            : req.query.from === 'stats' ? 'Reports > Stats Report > Log View'
            : 'Rebuild Collection > Browse Logs > Log View';
        // The nav's blue "active" highlight is normally driven entirely by shell.js (JS, only runs
        // on the main SPA page) -- this standalone page needs its own server-side equivalent so the
        // nav still reflects which section it conceptually belongs to, same breadcrumb reasoning.
        const activeArea = cameFromReports ? 'reports' : 'rebuild';
        const navTabClass = (area) => `nav-tab${area === activeArea ? ' nav-tab--active' : ''}`;
        // This is a local, single-user tool -- the server runs on the same machine as the person
        // viewing it, so Node's own Date formatting already reflects the system's configured local
        // timezone with zero extra work (no need to detect/pass timezone explicitly).
        const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
        const badges = Object.entries(log.summary || {})
            .map(([status, count]) => `<span class="badge badge--${status.toLowerCase()} badge--clickable" data-status="${esc(status)}"><span class="badge__count">${count}</span> ${esc(status)}</span>`)
            .join('') + `<span class="badge badge--show-all" data-status="">Show all</span>`;
        // Downloaded-archives recap -- only present when the "download missing archives" setting
        // was on for this run. A successful download that went on to rebuild is just a normal
        // REBUILT row already (no special-casing needed there); this block exists so a FAILED
        // download isn't easy to miss, and so a not-Premium skip is explained instead of silent.
        const downloadSummary = log.downloadedArchives ? (() => {
            const d = log.downloadedArchives;
            if (d.skippedReason === 'not-premium') {
                return `<div class="callout callout--warning">Download of ${d.attempted || 'the missing'} archive(s) was skipped: this Nexus account is not Premium, so automated downloads aren't available (respects Nexus's ad-supported download model for free users). Download and reinstall the archive(s) yourself either via Vortex or using the Work Through Report.</div>`;
            }
            if (!d.attempted) return '';
            const failedLines = (d.entries || []).filter((e) => e.status === 'FAILED')
                .map((e) => `<li>${esc(e.name)} -- ${esc(e.error)}</li>`).join('');
            return `<div class="file-list">Downloaded archives: ${d.succeeded} succeeded, ${d.failed} failed (of ${d.attempted} attempted).` +
                (failedLines ? `<ul>${failedLines}</ul>` : '') + `</div>`;
        })() : '';
        // A real collection produced a 178-character mod name (several Nexus authors concatenate
        // multiple patch names into one) -- confirmed live this forces the (deliberately nowrap)
        // Mod column to claim nearly the whole table width under table-layout:auto, squeezing every
        // other row's Detail column down to ~75px and turning ordinary one-line content into
        // 200-300px of character-by-character wrapped text. Fixed at the source: truncate the
        // STRING itself before it reaches the DOM (not just visually via CSS) so nowrap never has an
        // extreme value to blow the column out on. Click a truncated name to see the full one.
        const MOD_NAME_TRUNCATE_AT = 60;
        // Same skyrimspecialedition-domain convention lib/vortex-sync/report.js's own nexusUrl()
        // already uses -- this whole toolkit is SSE-only, never a different Nexus game domain.
        // Off-site mods (no modId) get no link at all, same as that other report's own behavior.
        // Plain mod page only (no ?tab=files&file_id=... download-tab deep link) -- confirmed live
        // this was the wrong page: the user wants the mod's own description page, not its Files tab.
        const nexusModUrl = (modId) => modId == null ? null : `https://www.nexusmods.com/skyrimspecialedition/mods/${modId}`;
        const modNameCell = (name, modId) => {
            const url = nexusModUrl(modId);
            const inner = name.length <= MOD_NAME_TRUNCATE_AT ? esc(name) : (() => {
                const short = esc(name.slice(0, MOD_NAME_TRUNCATE_AT - 1)) + '…';
                return `<span class="mod-name mod-name--truncated" data-full="${esc(name)}" data-short="${short}" title="${esc(name)}">${short}</span>`;
            })();
            // target="_blank" is just a fallback for middle-click/ctrl-click -- the real "open in a
            // new WINDOW, not a tab" behavior (what was actually asked for) needs window.open() with
            // explicit window features (width/height), which is what forces browsers to treat it as
            // a popup window instead of a tab; a plain target="_blank" anchor click alone can't do
            // that. See the .mod-name-link click handler further down in this page's embedded script.
            return url ? `<a class="mod-name-link" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>` : inner;
        };
        // sharedWithNote may be a plain array (current format, one entry per collection) or a legacy
        // '; '-joined string (logs written before this field became an array) -- normalize either
        // shape to a list so old log files still render correctly.
        const sharedWithLines = (note) => (Array.isArray(note) ? note : String(note).split('; '));
        // Missing/Changed can legitimately run into the hundreds for a badly-diverged mod (the
        // Dragon Priests Retexture case that prompted this had 152) -- one comma-separated run-on
        // line of those wasn't readable. Shows the first FILE_LIST_TRUNCATE_AT, one per line, with
        // the rest behind a click-to-expand toggle (same pattern as the mod-name truncation above,
        // adapted for a list instead of a single string).
        const FILE_LIST_TRUNCATE_AT = 6;
        const fileListBlock = (label, files) => {
            if (!files || files.length === 0) return '';
            const lines = files.map(esc);
            if (lines.length <= FILE_LIST_TRUNCATE_AT) {
                return `<div class="file-list">${label}:<br>${lines.join('<br>')}</div>`;
            }
            const shown = lines.slice(0, FILE_LIST_TRUNCATE_AT).join('<br>');
            const rest = lines.slice(FILE_LIST_TRUNCATE_AT).join('<br>');
            const restCount = lines.length - FILE_LIST_TRUNCATE_AT;
            return `<div class="file-list">${label}:<br>${shown}<br>` +
                `<span class="file-list-extra hidden">${rest}<br></span>` +
                `<a class="file-list-toggle" data-more="+${restCount} more" data-less="Show less">+${restCount} more</a></div>`;
        };
        // One "Delete" button per AMBIGUOUS duplicate candidate -- a plain helper function (not an
        // inline .map(...).join('') in modRow's own ternary chain) so nested template literals inside
        // an arrow function body can't create any ambiguity for the parser. Emits just the two cells
        // (no wrapping row div) -- the CALLER wraps every row in ONE shared CSS grid, so the button
        // column aligns across all rows regardless of how long/wrapped each path is. Confirmed live:
        // giving each row its OWN flex container let the button's position drift row to row whenever
        // one path wrapped to two lines and another didn't.
        // Displayed text is just the filename -- the full path never matters to the user (there's
        // only one archive/downloads folder in this whole app, already known from Settings), only
        // the name of the file to delete does. The full path still travels in data-filepath, which
        // the actual delete action needs to locate the real file -- only the DISPLAY is simplified.
        const ambiguousCandidateRow = (m, f) => `<code style="font-size:12px; white-space:nowrap;">${esc(path.basename(f))}</code>` +
            `<button class="btn btn--ghost btn--small delete-archive-candidate-btn" data-modid="${esc(m.modId ?? '')}" data-fileid="${esc(m.fileId ?? '')}" data-name="${esc(m.name)}" data-filepath="${esc(f)}">Delete</button>`;
        const ambiguousCandidateRows = (m) => m.candidateFiles.map((f) => ambiguousCandidateRow(m, f)).join('');
        const modRow = (m) => {
            // "Already included in another collection" and the source archive name are identifying
            // info about the mod itself -- surfaced first, ahead of the (often long) missing/changed
            // file breakdown, per the user's own request: these got buried at the bottom before.
            let topBlock = '';
            if (m.sharedWithNote) topBlock += `<div class="file-list">Already included in:<br>${sharedWithLines(m.sharedWithNote).map(esc).join('<br>')}</div>`;
            if (m.archiveName) topBlock += `<div class="file-list">Archive: <code>${esc(m.archiveName)}</code></div>`;
            // CRITICAL_MANUAL_RESTORE_NEEDED and an off-site hash-mismatch candidate both get a
            // highlighted (not plain/muted) treatment -- both are cases where the instruction text is
            // only useful if it's actually noticed, not lost among ordinary grey detail text.
            const offSiteMismatchForDetail = m.status === 'SKIP_NO_ARCHIVE' && m.offSite && m.code === 'HASH_MISMATCH' && m.candidateFile;
            let rest = (m.status === 'CRITICAL_MANUAL_RESTORE_NEEDED' || offSiteMismatchForDetail)
                ? `<div class="callout callout--critical">${esc(m.detail || '')}</div>`
                : esc(m.detail || '').replace(/\n/g, '<br>');
            rest += fileListBlock('Missing', m.missing);
            rest += fileListBlock('Changed', m.changed);
            if (m.eslPreserved?.length) rest += `<div class="file-list">Marked as Light, left unchanged: ${m.eslPreserved.map(esc).join(', ')}</div>`;
            if (m.ghostPreserved?.length) rest += `<div class="file-list">Vortex-disabled (.ghost), left untouched: ${m.ghostPreserved.map(esc).join(', ')}</div>`;
            if (m.otherVersionsNote) rest += `<div class="file-list">A different version of this exact mod IS installed: ${esc(m.otherVersionsNote)}</div>`;
            const detail = topBlock ? `${topBlock}<div class="detail-group">${rest}</div>` : rest;
            // "Extract all" (full replace) / "Keep modified" (additive merge, never overwrites
            // anything staging already has) -- see rebuild-mod.js's resolveMode header comment.
            // Only offered for FAILED_MISMATCH_NOT_TOUCHED rows with enough info recorded to
            // re-locate the mod (older logs predating targetFolderName being saved can't support
            // this). Off-site mods (no modId/fileId) still qualify -- re-located by name instead,
            // confirmed live with a real "browse"-type mod ("High Poly Head") that otherwise showed
            // no buttons at all despite having a real, resolvable staging folder and archive.
            const canResolve = m.status === 'FAILED_MISMATCH_NOT_TOUCHED' && m.targetFolderName && (m.modId != null && m.fileId != null || m.name);
            // A FAILED_EXTRACTION_* row with archiveNotFound is the SAME underlying problem as
            // SKIP_NO_ARCHIVE (the archive genuinely isn't there), just discovered later -- at actual
            // extraction time instead of during classification (e.g. an Import'd/force-extracted file
            // that was deleted again between planning and this run). Confirmed live: a mismatch-status
            // row like this had no recovery action at all before, unlike its SKIP_NO_ARCHIVE sibling.
            const archiveMissingStatus = m.status === 'SKIP_NO_ARCHIVE'
                || ((m.status === 'FAILED_EXTRACTION_NOT_TOUCHED' || m.status === 'FAILED_EXTRACTION_NO_PRIOR_DATA') && m.archiveNotFound);
            // AMBIGUOUS -- two or more byte-identical duplicate files for the same mod, confirmed
            // real-world ("Diverse 4thUnknown Dragons" had the exact same archive under two
            // different filenames). Computed here (not further down) so canRetryDownload below can
            // exclude it -- confirmed live this was a real bug: canRetryDownload didn't check code at
            // all, so an AMBIGUOUS mod still showed "Retry Download" (which would just add a THIRD
            // duplicate) instead of ever reaching the delete-a-duplicate buttons, since it's checked
            // earlier in this same ternary chain.
            const isAmbiguous = m.status === 'SKIP_NO_ARCHIVE' && m.code === 'AMBIGUOUS' && Array.isArray(m.candidateFiles) && m.candidateFiles.length > 1;
            // Shown for ANY current archive-missing row -- the backend route is the real eligibility
            // gatekeeper (rejects off-site/non-Nexus mods with a clear error), not this condition, so
            // it's offered even for a mod that was never auto-download-attempted at all.
            const canRetryDownload = archiveMissingStatus && !isAmbiguous && m.modId != null && m.fileId != null;
            // A same-size candidate that failed the md5 check IS a real, concrete file sitting in the
            // downloads folder -- almost certainly the user's own manual download attempt, just not a
            // byte-for-byte match. Offer to accept it anyway rather than only pointing back at the URL.
            // SKIP_NO_ARCHIVE-only -- candidateFile is only ever recorded during classification.
            const canForceExtract = offSiteMismatchForDetail;
            // An off-site missing archive (source.type 'browse'/'direct'/'bundle') can never be
            // auto-downloaded regardless of settings -- this tool has no way to fetch it, so the
            // Extraction column says so directly instead of just staying blank, with a link to the
            // collection.json-recorded source URL when one was actually recorded.
            const offSiteMissing = archiveMissingStatus && m.offSite && !canForceExtract;
            // Import is offered for ANY off-site SKIP_NO_ARCHIVE row, alongside whatever else applies
            // (Force Extract Anyway if a same-size candidate was auto-detected, or just the plain
            // "off-site" note otherwise) -- it's the reliable path regardless of whether the file
            // happens to be a same-size candidate, since the user explicitly picks the file rather
            // than relying on any auto-detection at all.
            const importBtnHtml = (canForceExtract || offSiteMissing)
                ? `<button class="btn btn--ghost btn--small import-offsite-btn" data-name="${esc(m.name)}">Import</button>`
                : '';
            // A FAILED_EXTRACTION_* row that ISN'T archive-missing failed for some other reason --
            // confirmed real-world this session, a transient Windows file-lock (EPERM) during the
            // 7z-scratch copy step, not anything wrong with the archive itself. Simple retry of the
            // exact same classify+extract flow is the right recovery action, distinct from Retry
            // Download/Import (which only make sense when the archive itself was the problem).
            const canRetryExtraction = (m.status === 'FAILED_EXTRACTION_NOT_TOUCHED' || m.status === 'FAILED_EXTRACTION_NO_PRIOR_DATA')
                && !archiveMissingStatus && m.targetFolderName && (m.modId != null && m.fileId != null || m.name);
            const extractionCell = canResolve
                ? `<div class="extraction-actions">`
                    + `<button class="btn btn--primary btn--small resolve-mismatch-btn" data-modid="${esc(m.modId ?? '')}" data-fileid="${esc(m.fileId ?? '')}" data-name="${esc(m.name)}" data-mode="all">Extract all</button>`
                    + `<button class="btn btn--primary btn--small resolve-mismatch-btn" data-modid="${esc(m.modId ?? '')}" data-fileid="${esc(m.fileId ?? '')}" data-name="${esc(m.name)}" data-mode="keep-existing">Keep modified</button>`
                    + `</div>`
                : canRetryDownload
                ? `<div class="extraction-actions">`
                    + `<button class="btn btn--primary btn--small retry-download-btn" data-modid="${esc(m.modId)}" data-fileid="${esc(m.fileId)}">Retry Download</button>`
                    + `</div>`
                : canForceExtract
                ? `<div class="extraction-actions">`
                    + `<button class="btn btn--primary btn--small force-extract-offsite-btn" data-name="${esc(m.name)}">Force Extract Anyway</button>`
                    + importBtnHtml
                    + `</div>`
                : offSiteMissing
                ? `<div class="extraction-actions">${importBtnHtml}</div>`
                    + `<div class="file-list">This mod is located off-site. You'll need to obtain it manually and install it via Vortex.`
                    + (m.sourceUrl ? `<br><a class="archive-link" href="${esc(m.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(m.sourceUrl)}</a>` : '')
                    + `</div>`
                : canRetryExtraction
                ? `<div class="extraction-actions">`
                    + `<button class="btn btn--primary btn--small retry-extraction-btn" data-modid="${esc(m.modId ?? '')}" data-fileid="${esc(m.fileId ?? '')}" data-name="${esc(m.name)}">Retry Extraction</button>`
                    + `</div>`
                : isAmbiguous
                ? `<div class="ambiguous-candidates">${ambiguousCandidateRows(m)}</div>`
                : '';
            return `<tr data-status="${esc(m.status)}"><td>${modNameCell(m.name, m.modId)}</td><td><span class="status-pill status-pill--${m.status.toLowerCase()}">${esc(m.status)}</span></td><td class="detail-cell">${detail}</td><td class="extraction-cell">${extractionCell}</td></tr>`;
        };
        // Ignored/optional-not-installed mods carry no action at all -- same reasoning as the live
        // plan table: put them last so the mods that actually matter aren't buried.
        const NON_ACTIONABLE = new Set(['SKIP_IGNORED', 'SKIP_OPTIONAL_NOT_INSTALLED']);
        const allMods = log.mods || [];
        const actionableMods = allMods.filter((m) => !NON_ACTIONABLE.has(m.status));
        const ignoredMods = allMods.filter((m) => NON_ACTIONABLE.has(m.status));
        const rows = [...actionableMods, ...ignoredMods].map(modRow).join('');
        res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Vortex Collection Tools — ${esc(breadcrumb)}</title>
<link rel="stylesheet" href="/styles.css"></head>
<body>
<header class="app-header">
  <div class="app-header__title">
    <span class="app-header__logo">&#9881;</span>
    <span>Vortex Collection Tools</span>
  </div>
  <nav class="app-nav">
    <a href="/?area=rebuild" class="${navTabClass('rebuild')}">Rebuild Collection</a>
    <a href="/?area=sync" class="${navTabClass('sync')}">Update Collection</a>
    <a href="/?area=settings" class="${navTabClass('settings')}">Settings</a>
    <a href="/?reports=stats" class="${navTabClass('reports')}">Reports</a>
  </nav>
  <div class="app-header__meta">${esc(breadcrumb)}</div>
</header>
<main class="app-main">
${backButtonHtml}
<div class="view-header">
  <h1>${esc(log.collectionName)}</h1>
  <p class="muted">${esc(log.runStatus)} -- started ${esc(fmtDate(log.startedAt))}${log.finishedAt ? ', finished ' + esc(fmtDate(log.finishedAt)) : ''}${log.durationMs ? ` (${(log.durationMs / 1000).toFixed(1)}s)` : ''}</p>
</div>
<div class="summary-badges" id="statusBadges">${badges}</div>
${downloadSummary}
<div class="plan-table-wrap"><table class="plan-table">
<thead><tr><th>Mod</th><th>Status</th><th>Detail</th><th>Extraction</th></tr></thead>
<tbody id="logTableBody" data-filename="${esc(filename)}">${rows}</tbody>
</table></div>
<!-- Same in-page modal convention as the main app (replaces native confirm()/alert(), which are
     tiny and easy to misread) -- this page has no shared JS with app.js, so it gets its own copy. -->
<div id="confirmModal" class="modal-overlay hidden">
  <div class="modal">
    <h2>Confirm</h2>
    <p id="confirmModalText"></p>
    <div class="modal-actions">
      <button class="btn btn--ghost" id="confirmModalCancel">Cancel</button>
      <button class="btn btn--primary" id="confirmModalOk">OK</button>
    </div>
  </div>
</div>
<div id="errorModal" class="modal-overlay hidden">
  <div class="modal modal--wide">
    <h2>Error</h2>
    <p id="errorModalText" class="error-modal-text"></p>
    <div class="modal-actions">
      <button class="btn btn--primary" id="errorModalOk">OK</button>
    </div>
  </div>
</div>
<script>
function showConfirmModal(message) {
  const overlay = document.getElementById('confirmModal');
  document.getElementById('confirmModalText').textContent = message;
  overlay.classList.remove('hidden');
  return new Promise((resolve) => {
    const cleanup = (result) => { overlay.classList.add('hidden'); resolve(result); };
    document.getElementById('confirmModalOk').onclick = () => cleanup(true);
    document.getElementById('confirmModalCancel').onclick = () => cleanup(false);
  });
}
function showErrorModal(message) {
  document.getElementById('errorModalText').textContent = message;
  document.getElementById('errorModal').classList.remove('hidden');
}
document.getElementById('errorModalOk').addEventListener('click', () => {
  document.getElementById('errorModal').classList.add('hidden');
});
// Forces a real popup WINDOW instead of a new tab -- a plain target="_blank" anchor click is
// treated as a tab by every modern browser regardless of site preference; window.open() with
// explicit width/height window features is what actually gets browsers to open a separate window.
// target="_blank"/rel="noopener" stay on the <a> itself purely as a middle-click/ctrl-click
// fallback (those bypass this click handler entirely and use the browser's own default).
document.querySelectorAll('.mod-name-link').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(a.href, '_blank', 'noopener,width=1200,height=900');
  });
});
document.querySelectorAll('.mod-name--truncated').forEach((el) => {
  el.addEventListener('click', () => {
    const stillTruncated = el.classList.toggle('mod-name--truncated');
    el.textContent = stillTruncated ? el.dataset.short : el.dataset.full;
  });
});
document.getElementById('logTableBody').addEventListener('click', (e) => {
  const toggle = e.target.closest('.file-list-toggle');
  if (!toggle) return;
  const extra = toggle.previousElementSibling;
  const stillHidden = extra.classList.toggle('hidden');
  toggle.textContent = stillHidden ? toggle.dataset.more : toggle.dataset.less;
});
document.getElementById('logTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.resolve-mismatch-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  const filename = document.getElementById('logTableBody').dataset.filename;
  const modId = btn.dataset.modid ? Number(btn.dataset.modid) : null;
  const fileId = btn.dataset.fileid ? Number(btn.dataset.fileid) : null;
  const name = btn.dataset.name;
  const resolveMode = btn.dataset.mode;
  const message = resolveMode === 'all'
    ? "Warning: this will fully replace this mod's staging folder. Continue?"
    : 'Warning: this keeps your modified files as they are, replaces everything else, and restores any missing files. Continue?';
  if (!await showConfirmModal(message)) return;
  row.querySelectorAll('.resolve-mismatch-btn').forEach((b) => { b.disabled = true; });
  btn.textContent = 'Working…';
  try {
    const res = await fetch('/api/rebuild/logs/' + encodeURIComponent(filename) + '/resolve-mismatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modId, fileId, name, resolveMode }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    location.reload();
  } catch (err) {
    showErrorModal('Failed: ' + err.message);
    row.querySelectorAll('.resolve-mismatch-btn').forEach((b) => { b.disabled = false; });
    btn.textContent = resolveMode === 'all' ? 'Extract all' : 'Keep modified';
  }
});
document.getElementById('logTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.retry-download-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  const filename = document.getElementById('logTableBody').dataset.filename;
  const modId = Number(btn.dataset.modid);
  const fileId = Number(btn.dataset.fileid);
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    const res = await fetch('/api/rebuild/logs/' + encodeURIComponent(filename) + '/retry-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modId, fileId }),
    });
    const data = await res.json();
    // A non-ok HTTP status (NOT_NEXUS/NOT_PREMIUM) means the log was NOT touched -- just show the
    // error, nothing to reload. data.ok === false with a 200 status means the download failed but
    // the route already persisted an updated "Download failed..." detail into the log -- reload
    // either way (success or that case) to show the current, real log content.
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    location.reload();
  } catch (err) {
    showErrorModal('Failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Retry Download';
  }
});
document.getElementById('logTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.force-extract-offsite-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  const filename = document.getElementById('logTableBody').dataset.filename;
  const name = btn.dataset.name;
  if (!await showConfirmModal('Warning: this file does not exactly match what this collection recorded (a different repack/edition). Extract it anyway? Vortex may prompt you to import it as a new mod afterward -- accept that prompt if so.')) return;
  btn.disabled = true;
  btn.textContent = 'Extracting…';
  try {
    const res = await fetch('/api/rebuild/logs/' + encodeURIComponent(filename) + '/force-extract-offsite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    location.reload();
  } catch (err) {
    showErrorModal('Failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Force Extract Anyway';
  }
});
document.getElementById('logTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.import-offsite-btn');
  if (!btn) return;
  const filename = document.getElementById('logTableBody').dataset.filename;
  const name = btn.dataset.name;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Waiting for file…';
  try {
    const res = await fetch('/api/rebuild/logs/' + encodeURIComponent(filename) + '/import-offsite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.cancelled) { btn.disabled = false; btn.textContent = originalText; return; }
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    location.reload();
  } catch (err) {
    showErrorModal('Failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
});
document.getElementById('logTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.retry-extraction-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  const filename = document.getElementById('logTableBody').dataset.filename;
  const modId = btn.dataset.modid ? Number(btn.dataset.modid) : null;
  const fileId = btn.dataset.fileid ? Number(btn.dataset.fileid) : null;
  const name = btn.dataset.name;
  btn.disabled = true;
  btn.textContent = 'Retrying…';
  try {
    const res = await fetch('/api/rebuild/logs/' + encodeURIComponent(filename) + '/retry-extraction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modId, fileId, name }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    location.reload();
  } catch (err) {
    showErrorModal('Failed: ' + err.message);
    row.querySelectorAll('.retry-extraction-btn').forEach((b) => { b.disabled = false; b.textContent = 'Retry Extraction'; });
  }
});
document.getElementById('logTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.delete-archive-candidate-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  const filename = document.getElementById('logTableBody').dataset.filename;
  const modId = btn.dataset.modid ? Number(btn.dataset.modid) : null;
  const fileId = btn.dataset.fileid ? Number(btn.dataset.fileid) : null;
  const name = btn.dataset.name;
  const filePath = btn.dataset.filepath;
  var sepIdx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf(String.fromCharCode(92)));
  var filePathBaseName = sepIdx >= 0 ? filePath.slice(sepIdx + 1) : filePath;
  if (!await showConfirmModal('Warning: this will permanently delete this file:\\n' + filePathBaseName + '\\n\\nContinue?')) return;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const res = await fetch('/api/rebuild/logs/' + encodeURIComponent(filename) + '/delete-archive-candidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modId, fileId, name, filePath }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    location.reload();
  } catch (err) {
    showErrorModal('Failed: ' + err.message);
    row.querySelectorAll('.delete-archive-candidate-btn').forEach((b) => { b.disabled = false; });
    btn.textContent = 'Delete';
  }
});
// Pulled out of the click handler so a page reload (e.g. after resolving a mismatch) can re-apply
// whichever filter was active, instead of always resetting to "show all" -- confirmed live this was
// confusing: resolving one mismatched mod reloaded the whole page and silently dropped back to
// showing every row, when the user was deliberately filtered down to just the mismatched ones.
function applyStatusFilter(status) {
  document.querySelectorAll('#statusBadges .badge').forEach((b) => b.classList.remove('badge--filter-active'));
  const rows = document.querySelectorAll('#logTableBody tr');
  if (!status) {
    rows.forEach((r) => { r.style.display = ''; });
    return;
  }
  const badge = document.querySelector('#statusBadges .badge--clickable[data-status="' + CSS.escape(status) + '"]');
  if (badge) badge.classList.add('badge--filter-active');
  rows.forEach((r) => { r.style.display = r.dataset.status === status ? '' : 'none'; });
}
document.getElementById('statusBadges').addEventListener('click', (e) => {
  const badge = e.target.closest('.badge--clickable, .badge--show-all');
  if (!badge) return;
  const status = badge.dataset.status;
  applyStatusFilter(status);
  // Persist the active filter in the URL (no navigation, just updates the address bar) so a later
  // location.reload() -- e.g. after resolving a mismatch below -- restores it instead of resetting.
  const url = new URL(location.href);
  if (status) url.searchParams.set('status', status); else url.searchParams.delete('status');
  history.replaceState(null, '', url);
});
// Restore whatever filter was active before this page load, if the URL says so.
applyStatusFilter(new URLSearchParams(location.search).get('status') || '');
</script>
</main></body></html>`);
    });

    // Manually resolves one mod that already came back FAILED_MISMATCH_NOT_TOUCHED in this exact
    // log, via the "Extraction" column's "Extract all"/"Keep modified" buttons on the log-view page.
    // Deliberately does NOT check isVortexRunning() -- resolveMismatchedMod never touches Vortex's
    // state database (same as the rest of Rebuild Collection), only the staging filesystem, so this
    // is safe to run with Vortex open. Updates the log FILE itself in place afterward so re-viewing
    // it later reflects the resolution instead of forever showing the original mismatch.
    router.post('/logs/:filename/resolve-mismatch', async (req, res) => {
        const { filename } = req.params;
        if (!/^rebuild-.+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid log filename.' });
        const full = path.join(logsDir, filename);
        if (path.dirname(full) !== logsDir) return res.status(400).json({ error: 'Invalid log filename.' });
        const { modId, fileId, name, resolveMode } = req.body || {};
        if (!['all', 'keep-existing'].includes(resolveMode)) {
            return res.status(400).json({ error: 'resolveMode must be "all" or "keep-existing".' });
        }
        // Off-site mods (source.type 'browse'/'direct') carry no modId/fileId at all -- name is the
        // only identifier available for those, so it's required whenever modId/fileId aren't.
        if ((modId == null || fileId == null) && !name) {
            return res.status(400).json({ error: 'modId+fileId, or name, are required.' });
        }
        let log;
        try {
            log = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            return res.status(404).json({ error: 'Log file not found.' });
        }
        const entryIndex = (log.mods || []).findIndex((m) => (
            modId != null && fileId != null ? (m.modId === modId && m.fileId === fileId) : (m.name === name && m.modId == null && m.fileId == null)
        ));
        if (entryIndex === -1) return res.status(404).json({ error: 'Mod not found in this log.' });
        const entry = log.mods[entryIndex];
        if (entry.status !== 'FAILED_MISMATCH_NOT_TOUCHED') {
            return res.status(400).json({ error: `This mod's status is "${entry.status}", not FAILED_MISMATCH_NOT_TOUCHED -- refusing to touch it.` });
        }
        if (!entry.targetFolderName) {
            return res.status(400).json({ error: 'This log entry has no recorded targetFolderName -- too old a log format to resolve this way.' });
        }
        try {
            const { result, archiveName } = await runner.resolveMismatchedMod({
                collectionModId: log.collectionModId, stagingDir: staging, downloadsDir: downloads,
                modId, fileId, name: entry.name, targetFolderName: entry.targetFolderName, resolveMode,
            });
            // Built fresh, not merged with the old entry -- the FAILED_MISMATCH_NOT_TOUCHED shape's
            // own fields (detail/missing/changed/changedEslOnly) don't apply to the new REBUILT
            // result at all and would otherwise linger stale if just spread over.
            const updatedEntry = {
                name: entry.name, modId: entry.modId, fileId: entry.fileId,
                targetFolderName: entry.targetFolderName, archiveName: archiveName || entry.archiveName,
                ...result,
            };
            log.mods[entryIndex] = updatedEntry;
            log.summary = runner.summarize(log.mods);
            runner.writeLog(full, log);
            res.json({ ok: true, entry: updatedEntry, summary: log.summary });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // "Retry Extraction" -- a FAILED_EXTRACTION_NOT_TOUCHED/NO_PRIOR_DATA mod whose failure wasn't
    // archive-not-found (that gets Retry Download/Import instead -- see isArchiveMissingStatus()
    // above). Covers a genuinely transient failure (confirmed real-world this session: an EPERM on a
    // freshly-extracted file during the 7z-scratch copy step, almost certainly antivirus/indexer
    // briefly holding a handle) by just re-attempting the exact same classify+extract flow.
    router.post('/logs/:filename/retry-extraction', async (req, res) => {
        const { filename } = req.params;
        if (!/^rebuild-.+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid log filename.' });
        const full = path.join(logsDir, filename);
        if (path.dirname(full) !== logsDir) return res.status(400).json({ error: 'Invalid log filename.' });
        const { modId, fileId, name } = req.body || {};
        if ((modId == null || fileId == null) && !name) {
            return res.status(400).json({ error: 'modId+fileId, or name, are required.' });
        }
        let log;
        try {
            log = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            return res.status(404).json({ error: 'Log file not found.' });
        }
        const entryIndex = (log.mods || []).findIndex((m) => (
            modId != null && fileId != null ? (m.modId === modId && m.fileId === fileId) : (m.name === name && m.modId == null && m.fileId == null)
        ));
        if (entryIndex === -1) return res.status(404).json({ error: 'Mod not found in this log.' });
        const entry = log.mods[entryIndex];
        if (entry.status !== 'FAILED_EXTRACTION_NOT_TOUCHED' && entry.status !== 'FAILED_EXTRACTION_NO_PRIOR_DATA') {
            return res.status(400).json({ error: `This mod's status is "${entry.status}" -- refusing to touch it.` });
        }
        if (!entry.targetFolderName) {
            return res.status(400).json({ error: 'This log entry has no recorded targetFolderName -- too old a log format to resolve this way.' });
        }
        try {
            const outcome = await runner.retryExtraction({
                collectionModId: log.collectionModId, stagingDir: staging, downloadsDir: downloads,
                modId, fileId, name: entry.name, targetFolderName: entry.targetFolderName,
            });
            // The archive situation can genuinely change between the original failure and this
            // retry (e.g. now AMBIGUOUS) -- retryExtraction() reports that as kind:'SKIP_NO_ARCHIVE'
            // instead of throwing, so it must be handled as its own distinct shape here, not assumed
            // to always be a successful { result, archiveName } outcome.
            const updatedEntry = outcome.kind === 'SKIP_NO_ARCHIVE'
                ? {
                    name: entry.name, modId: entry.modId, fileId: entry.fileId, status: 'SKIP_NO_ARCHIVE',
                    detail: outcome.detail, code: outcome.code, candidateFile: outcome.candidateFile, candidateFiles: outcome.candidateFiles,
                }
                : {
                    name: entry.name, modId: entry.modId, fileId: entry.fileId,
                    targetFolderName: entry.targetFolderName, archiveName: outcome.archiveName || entry.archiveName,
                    ...outcome.result,
                };
            log.mods[entryIndex] = updatedEntry;
            log.summary = runner.summarize(log.mods);
            runner.writeLog(full, log);
            res.json({ ok: true, entry: updatedEntry, summary: log.summary });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // "Delete duplicate" for an AMBIGUOUS SKIP_NO_ARCHIVE mod (real-world case: two byte-identical
    // copies of the same archive under different filenames, confirmed with "Diverse 4thUnknown
    // Dragons"). Deletes ONE of the recorded candidate files (validated to actually be one of them),
    // then re-checks the mod fresh once the ambiguity is resolved down to a single file -- or just
    // updates the remaining candidate list if more than one duplicate is still left.
    router.post('/logs/:filename/delete-archive-candidate', async (req, res) => {
        const { filename } = req.params;
        if (!/^rebuild-.+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid log filename.' });
        const full = path.join(logsDir, filename);
        if (path.dirname(full) !== logsDir) return res.status(400).json({ error: 'Invalid log filename.' });
        const { modId, fileId, name, filePath } = req.body || {};
        if ((modId == null || fileId == null) && !name) {
            return res.status(400).json({ error: 'modId+fileId, or name, are required.' });
        }
        if (!filePath) return res.status(400).json({ error: 'filePath is required.' });
        let log;
        try {
            log = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            return res.status(404).json({ error: 'Log file not found.' });
        }
        const entryIndex = (log.mods || []).findIndex((m) => (
            modId != null && fileId != null ? (m.modId === modId && m.fileId === fileId) : (m.name === name && m.modId == null && m.fileId == null)
        ));
        if (entryIndex === -1) return res.status(404).json({ error: 'Mod not found in this log.' });
        const entry = log.mods[entryIndex];
        if (entry.status !== 'SKIP_NO_ARCHIVE' || entry.code !== 'AMBIGUOUS' || !Array.isArray(entry.candidateFiles)) {
            return res.status(400).json({ error: 'This mod has no recorded duplicate-file list to resolve this way.' });
        }
        if (!entry.candidateFiles.includes(filePath)) {
            return res.status(400).json({ error: 'That file is not one of the recorded candidates for this mod.' });
        }
        try {
            runner.deleteArchiveCandidate({ downloadsDir: downloads, filePath });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
        const remaining = entry.candidateFiles.filter((f) => f !== filePath);
        try {
            let updatedEntry;
            if (remaining.length <= 1) {
                const outcome = await runner.reclassifyMod({
                    collectionModId: log.collectionModId, stagingDir: staging, downloadsDir: downloads, sevenZipExe,
                    modId, fileId, name: entry.name,
                });
                updatedEntry = outcome.kind === 'REBUILD'
                    ? { name: entry.name, modId: entry.modId, fileId: entry.fileId, targetFolderName: outcome.targetFolderName, archiveName: outcome.archiveName, ...outcome }
                    : { ...entry, status: outcome.kind, detail: outcome.detail, code: outcome.code, candidateFile: outcome.candidateFile, candidateFiles: outcome.candidateFiles };
            } else {
                updatedEntry = { ...entry, candidateFiles: remaining };
            }
            log.mods[entryIndex] = updatedEntry;
            log.summary = runner.summarize(log.mods);
            runner.writeLog(full, log);
            res.json({ ok: true, entry: updatedEntry, summary: log.summary });
        } catch (e) {
            // The file was already deleted successfully even if reclassify itself blew up -- still
            // persist that much rather than silently losing track of it.
            const updatedEntry = { ...entry, candidateFiles: remaining };
            log.mods[entryIndex] = updatedEntry;
            runner.writeLog(full, log);
            res.status(500).json({ ok: false, error: e.message, entry: updatedEntry });
        }
    });

    // On-demand retry for one SKIP_NO_ARCHIVE mod (log-view page's "Retry Download" button, or the
    // Work Through Report's equivalent). Shown for ANY current SKIP_NO_ARCHIVE entry regardless of
    // whether an auto-download was ever attempted before (useful even if downloadMissingArchives was
    // off during the original run) -- this route itself is the single source of truth for
    // eligibility (rejects off-site/non-Nexus mods with a clear error), not the caller.
    router.post('/logs/:filename/retry-download', async (req, res) => {
        const { filename } = req.params;
        if (!/^rebuild-.+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid log filename.' });
        const full = path.join(logsDir, filename);
        if (path.dirname(full) !== logsDir) return res.status(400).json({ error: 'Invalid log filename.' });
        const { modId, fileId } = req.body || {};
        if (modId == null || fileId == null) {
            return res.status(400).json({ error: 'modId and fileId are required.' });
        }
        let log;
        try {
            log = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            return res.status(404).json({ error: 'Log file not found.' });
        }
        const entryIndex = (log.mods || []).findIndex((m) => m.modId === modId && m.fileId === fileId);
        if (entryIndex === -1) return res.status(404).json({ error: 'Mod not found in this log.' });
        const entry = log.mods[entryIndex];
        if (!isArchiveMissingStatus(entry)) {
            return res.status(400).json({ error: `This mod's status is "${entry.status}" -- no archive-missing state recorded, refusing to touch it.` });
        }
        try {
            const outcome = await runner.retryMissingArchiveDownload({
                collectionModId: log.collectionModId, stagingDir: staging, downloadsDir: downloads, sevenZipExe,
                modId, fileId,
            });
            // code/candidateFile/candidateFiles must overwrite the OLD entry's copies, not just get
            // dropped by spreading ...entry first -- confirmed live this was a real bug: a stale
            // code="NOT_FOUND" survived a retry that actually came back AMBIGUOUS, hiding the
            // delete-duplicate UI even though the detail text correctly described the new situation.
            const updatedEntry = outcome.kind === 'REBUILD'
                ? { name: entry.name, modId, fileId, targetFolderName: outcome.targetFolderName, archiveName: outcome.archiveName, ...outcome }
                : {
                    ...entry, status: outcome.kind, detail: outcome.detail, code: outcome.code,
                    candidateFile: outcome.candidateFile, candidateFiles: outcome.candidateFiles,
                };
            log.mods[entryIndex] = updatedEntry;
            log.summary = runner.summarize(log.mods);
            runner.writeLog(full, log);
            res.json({ ok: true, entry: updatedEntry, summary: log.summary });
        } catch (e) {
            if (e.code === 'DOWNLOAD_FAILED') {
                // Per explicit request -- persisted into the log itself so it's visible on next
                // view too, not just this one response.
                const updatedEntry = { ...entry, detail: 'Download failed. Please download via Vortex.' };
                log.mods[entryIndex] = updatedEntry;
                runner.writeLog(full, log);
                return res.status(200).json({ ok: false, entry: updatedEntry, error: e.message });
            }
            res.status(400).json({ ok: false, error: e.message }); // NOT_NEXUS / NOT_PREMIUM -- don't mutate the log
        }
    });

    // On-demand "Force Extract Anyway" for one off-site SKIP_NO_ARCHIVE mod whose recorded
    // candidateFile is a real, same-size file that just failed the md5 check -- the manual
    // equivalent of the Settings "forceExtractOffSiteMismatches" toggle, for a mod the user chose
    // NOT to auto-force during the run. Name-based (off-site mods carry no modId/fileId), same
    // lookup convention as /resolve-mismatch's off-site fallback.
    router.post('/logs/:filename/force-extract-offsite', async (req, res) => {
        const { filename } = req.params;
        if (!/^rebuild-.+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid log filename.' });
        const full = path.join(logsDir, filename);
        if (path.dirname(full) !== logsDir) return res.status(400).json({ error: 'Invalid log filename.' });
        const { name } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required.' });
        let log;
        try {
            log = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            return res.status(404).json({ error: 'Log file not found.' });
        }
        const entryIndex = (log.mods || []).findIndex((m) => m.name === name && m.modId == null && m.fileId == null);
        if (entryIndex === -1) return res.status(404).json({ error: 'Mod not found in this log.' });
        const entry = log.mods[entryIndex];
        if (entry.status !== 'SKIP_NO_ARCHIVE' || entry.code !== 'HASH_MISMATCH' || !entry.candidateFile) {
            return res.status(400).json({ error: `This mod has no recorded hash-mismatch candidate file to force-extract.` });
        }
        try {
            const outcome = await runner.forceExtractOffSiteMod({
                collectionModId: log.collectionModId, stagingDir: staging, downloadsDir: downloads, sevenZipExe,
                name,
            });
            const updatedEntry = outcome.kind === 'REBUILD'
                ? { name: entry.name, targetFolderName: outcome.targetFolderName, archiveName: outcome.archiveName, ...outcome }
                : { ...entry, status: outcome.kind, detail: outcome.detail };
            log.mods[entryIndex] = updatedEntry;
            log.summary = runner.summarize(log.mods);
            runner.writeLog(full, log);
            res.json({ ok: true, entry: updatedEntry, summary: log.summary });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Log-view/Work Through Report "Import" button -- unlike the Plan page's version, there IS a log
    // here to update, so this imports (native picker -> move into downloads -> record association)
    // AND immediately attempts the extraction in one step, matching how "resolve this issue" already
    // works everywhere else on this page (one click = attempt + log update, not two separate steps).
    router.post('/logs/:filename/import-offsite', async (req, res) => {
        const { filename } = req.params;
        if (!/^rebuild-.+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid log filename.' });
        const full = path.join(logsDir, filename);
        if (path.dirname(full) !== logsDir) return res.status(400).json({ error: 'Invalid log filename.' });
        const { name } = req.body || {};
        if (!name) return res.status(400).json({ error: 'name is required.' });
        if (!downloads) return res.status(400).json({ error: 'Downloads folder is not configured yet -- open Settings.' });
        let log;
        try {
            log = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
            return res.status(404).json({ error: 'Log file not found.' });
        }
        const entryIndex = (log.mods || []).findIndex((m) => m.name === name && m.modId == null && m.fileId == null);
        if (entryIndex === -1) return res.status(404).json({ error: 'Mod not found in this log.' });
        const entry = log.mods[entryIndex];
        if (!isArchiveMissingStatus(entry)) {
            return res.status(400).json({ error: `This mod's status is "${entry.status}" -- no archive-missing state recorded, refusing to touch it.` });
        }
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
            runner.importOffSiteArchive({ downloadsDir: downloads, collectionModId: log.collectionModId, name, pickedFilePath: picked });
            const outcome = await runner.extractImportedOffSiteMod({
                collectionModId: log.collectionModId, stagingDir: staging, downloadsDir: downloads, sevenZipExe, name,
            });
            const updatedEntry = outcome.kind === 'REBUILD'
                ? { name: entry.name, targetFolderName: outcome.targetFolderName, archiveName: outcome.archiveName, ...outcome }
                : { ...entry, status: outcome.kind, detail: outcome.detail };
            log.mods[entryIndex] = updatedEntry;
            log.summary = runner.summarize(log.mods);
            runner.writeLog(full, log);
            res.json({ ok: true, entry: updatedEntry, summary: log.summary });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // Trusted-localhost-only convenience (never exposed off loopback) -- reveals a path in
    // Explorer from the summary view. explorer.exe has a well-known, non-standard command-line
    // parser: spawning it with an array arg (`['/select,' + path]`) lets Node's own Windows argv
    // quoting wrap the ENTIRE "/select,<path>" token in quotes whenever the path has a space --
    // which explorer.exe's parser then fails to recognize as the /select switch at all, silently
    // falling back to its default starting folder. Confirmed live: it opened the user's OneDrive
    // Documents folder instead of the real target every time. The documented, confirmed-working
    // fix is a raw shell command string with quotes ONLY around the path (not the /select, prefix).
    router.post('/reveal', (req, res) => {
        const { targetPath } = req.body || {};
        if (!targetPath || typeof targetPath !== 'string') return res.status(400).json({ error: 'targetPath is required.' });
        spawn(`explorer.exe /select,"${targetPath}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createRouter };
