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
        res.json({ collections: withResume, vortexDataLoadedAt, workshopOnlyCollections });
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
            // Also populate THIS one collection's Vortex-sync-state cache right away -- confirmed
            // live this was otherwise confusing: the collection appears correctly in the main
            // picker immediately (a plain filesystem scan), but with no "✓ Vortex data cached"
            // mark until the next full "Load Vortex Data" click, since that's the only thing that
            // normally populates syncStateCache. One small isolated-child-process batch read (same
            // mechanism /api/rebuild/vortex-data/refresh uses, just for this single collectionModId) closes
            // that gap. Best-effort: a failure here (e.g. the native LevelDB crash this whole tool
            // isolates against) just means this one entry stays uncached until the next manual
            // refresh -- never lets a state-read problem fail the fetch that already succeeded.
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
                const { results, workshopOnlyCollections: found } = await runner.loadSyncStateBatch({ state, entries, stagingDir: staging });
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

    async function computePlan(collectionModId, resumeLogPath, onModClassified) {
        const collectionInfo = runner.resolveCollectionInfo(staging, collectionModId);
        const cached = syncStateCache.get(collectionModId);
        let ignored, removedMods, keptMods, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey;
        if (cached) {
            if (!cached.ok) throw new Error(cached.error);
            ({ ignored, removedMods, keptMods, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey } = cached.data);
        } else {
            ({ ignored, removedMods, keptMods, knownVortexModIds, otherVersionsByModId, sharedWithCollectionsByKey } = await runner.loadSyncState({
                state, collectionModId: collectionInfo.modId, collection: collectionInfo.collection, stagingDir: staging,
            }));
        }
        const resumed = resumeLogPath ? runner.loadResumeLog(resumeLogPath) : new Map();
        const { modEntries, rebuildQueue } = await runner.buildPlan({
            removedMods, keptMods, knownVortexModIds, resumed, otherVersionsByModId, sharedWithCollectionsByKey,
            downloadsDir: downloads, stagingDir: staging, sevenZipExe, logsDir, onModClassified,
        });
        return { collectionInfo, ignored, keptMods, knownVortexModIds, modEntries, rebuildQueue };
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
                    (entry, index, total) => emitIfCurrent({ type: 'classify-progress', name: entry.name, status: entry.status, index, total })
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
                    resumableLog: findResumableLog(collectionModId),
                });
            } catch (e) {
                emitIfCurrent({ type: 'plan-error', done: true, error: true, message: e.message });
            }
        })();
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
                runState.emit({ type: 'phase', phase: 'sync-state' });
                const { collectionInfo, modEntries, rebuildQueue } = await computePlan(collectionModId, resumeLogPath);
                logPath = path.join(logsDir, `rebuild-${collectionInfo.modId}-${runTimestamp}.json`);

                const currentLog = (runStatus) => runner.buildLogData({
                    collectionInfo, stagingDir: staging, downloadsDir: downloads, backupRoot,
                    dryRun: false, startedAt, runStatus, modEntries,
                });

                runState.emit({ type: 'phase', phase: 'plan-ready', modEntries, rebuildQueueCount: rebuildQueue.length, openFomodMods: runner.getOpenFomodMods(modEntries) });
                runner.writeLog(logPath, currentLog('in-progress'));

                if (rebuildQueue.length === 0) {
                    runner.writeLog(logPath, currentLog('completed'));
                    runState.emit({ type: 'run-complete', runStatus: 'completed', summary: runner.summarize(modEntries), totalMods: modEntries.length, logPath, backupRunDir: null, openFomodMods: runner.getOpenFomodMods(modEntries) });
                    return;
                }

                runState.emit({ type: 'phase', phase: 'backing-up' });
                const { backupRunDir } = runner.runBackup({
                    rebuildQueue, backupRoot, collectionModId: collectionInfo.modId, runTimestamp,
                    onProgress: (p) => runState.emit({ type: 'backup-progress', ...p }),
                });

                runState.emit({ type: 'phase', phase: 'rebuilding' });
                const { haltedCritical } = await runner.runRebuild({
                    rebuildQueue, collectionJsonPath: collectionInfo.collectionJsonPath,
                    downloadsDir: downloads, stagingDir: staging, modEntries,
                    onModStart: (mod) => runState.emit({ type: 'mod-start', modName: mod.name }),
                    onModComplete: (entry) => {
                        runState.emit({ type: 'mod-complete', ...entry });
                        runner.writeLog(logPath, currentLog('in-progress'));
                        if (entry.status === 'CRITICAL_MANUAL_RESTORE_NEEDED') {
                            runState.emit({ type: 'critical-halt', modName: entry.name, oldContentDir: entry.oldContentDir, rebuildingDir: entry.rebuildingDir, stagingModDir: entry.stagingModDir, logPath });
                        }
                    },
                });

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
        // This is a local, single-user tool -- the server runs on the same machine as the person
        // viewing it, so Node's own Date formatting already reflects the system's configured local
        // timezone with zero extra work (no need to detect/pass timezone explicitly).
        const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
        const badges = Object.entries(log.summary || {})
            .map(([status, count]) => `<span class="badge badge--${status.toLowerCase()} badge--clickable" data-status="${esc(status)}"><span class="badge__count">${count}</span> ${esc(status)}</span>`)
            .join('') + `<span class="badge badge--show-all" data-status="">Show all</span>`;
        // A real collection produced a 178-character mod name (several Nexus authors concatenate
        // multiple patch names into one) -- confirmed live this forces the (deliberately nowrap)
        // Mod column to claim nearly the whole table width under table-layout:auto, squeezing every
        // other row's Detail column down to ~75px and turning ordinary one-line content into
        // 200-300px of character-by-character wrapped text. Fixed at the source: truncate the
        // STRING itself before it reaches the DOM (not just visually via CSS) so nowrap never has an
        // extreme value to blow the column out on. Click a truncated name to see the full one.
        const MOD_NAME_TRUNCATE_AT = 70;
        const modNameCell = (name) => {
            if (name.length <= MOD_NAME_TRUNCATE_AT) return esc(name);
            const short = esc(name.slice(0, MOD_NAME_TRUNCATE_AT - 1)) + '…';
            return `<span class="mod-name mod-name--truncated" data-full="${esc(name)}" data-short="${short}" title="${esc(name)}">${short}</span>`;
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
        const modRow = (m) => {
            // "Already included in another collection" and the source archive name are identifying
            // info about the mod itself -- surfaced first, ahead of the (often long) missing/changed
            // file breakdown, per the user's own request: these got buried at the bottom before.
            let topBlock = '';
            if (m.sharedWithNote) topBlock += `<div class="file-list">Already included in:<br>${sharedWithLines(m.sharedWithNote).map(esc).join('<br>')}</div>`;
            if (m.archiveName) topBlock += `<div class="file-list">Archive: <code>${esc(m.archiveName)}</code></div>`;
            let rest = esc(m.detail || '').replace(/\n/g, '<br>');
            rest += fileListBlock('Missing', m.missing);
            rest += fileListBlock('Changed', m.changed);
            if (m.eslPreserved?.length) rest += `<div class="file-list">Marked as Light, left unchanged: ${m.eslPreserved.map(esc).join(', ')}</div>`;
            if (m.otherVersionsNote) rest += `<div class="file-list">A different version of this exact mod IS installed: ${esc(m.otherVersionsNote)}</div>`;
            const detail = topBlock ? `${topBlock}<div class="detail-group">${rest}</div>` : rest;
            return `<tr data-status="${esc(m.status)}"><td>${modNameCell(m.name)}</td><td><span class="status-pill status-pill--${m.status.toLowerCase()}">${esc(m.status)}</span></td><td class="detail-cell">${detail}</td></tr>`;
        };
        // Ignored/optional-not-installed mods carry no action at all -- same reasoning as the live
        // plan table: put them last so the mods that actually matter aren't buried.
        const NON_ACTIONABLE = new Set(['SKIP_IGNORED', 'SKIP_OPTIONAL_NOT_INSTALLED']);
        const allMods = log.mods || [];
        const actionableMods = allMods.filter((m) => !NON_ACTIONABLE.has(m.status));
        const ignoredMods = allMods.filter((m) => NON_ACTIONABLE.has(m.status));
        const rows = [...actionableMods, ...ignoredMods].map(modRow).join('');
        res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(log.collectionName)} -- Rebuild Log</title>
<link rel="stylesheet" href="/styles.css"></head>
<body><main class="app-main">
<div class="view-header">
  <h1>${esc(log.collectionName)}</h1>
  <p class="muted">${esc(log.runStatus)} -- started ${esc(fmtDate(log.startedAt))}${log.finishedAt ? ', finished ' + esc(fmtDate(log.finishedAt)) : ''}${log.durationMs ? ` (${(log.durationMs / 1000).toFixed(1)}s)` : ''}</p>
</div>
<div class="summary-badges" id="statusBadges">${badges}</div>
<div class="plan-table-wrap"><table class="plan-table">
<thead><tr><th>Mod</th><th>Status</th><th>Detail</th></tr></thead>
<tbody id="logTableBody">${rows}</tbody>
</table></div>
<script>
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
document.getElementById('statusBadges').addEventListener('click', (e) => {
  const badge = e.target.closest('.badge--clickable, .badge--show-all');
  if (!badge) return;
  const status = badge.dataset.status;
  document.querySelectorAll('#statusBadges .badge').forEach((b) => b.classList.remove('badge--filter-active'));
  const rows = document.querySelectorAll('#logTableBody tr');
  if (!status) {
    rows.forEach((r) => { r.style.display = ''; });
    return;
  }
  badge.classList.add('badge--filter-active');
  rows.forEach((r) => { r.style.display = r.dataset.status === status ? '' : 'none'; });
});
</script>
</main></body></html>`);
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
