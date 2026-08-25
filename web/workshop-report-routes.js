'use strict';
// Workshop Report -- for every Workshop-authored collection (has a local collection.json, or is
// tracked in Vortex but never fetched here at all), shows the REAL "last touched" timestamp
// straight from Nexus's own revision history.
//
// REAL FINDING BEHIND THIS (live-tested against real data, 2026-08-14): Nexus's own
// `Collection.updatedAt` (the collection record itself) is frozen at creation and never moves for
// a private/unlisted collection. `CollectionRevision.updatedAt` (per-revision) DOES move when the
// collection's content is edited -- confirmed against "My Dragonborn UI for GTS": its newest
// revision's `updatedAt` was 2026-08-13T23:23:54Z, independently confirmed by the director as
// genuinely when they last edited it. This report shows THAT timestamp (via
// nexus-collection-download.js's own resolveNewestRevision -- newest by updatedAt, not
// revisionNumber; see that function's own comment for why revisionNumber alone is unreliable for a
// draft that gets edited in place), not Collection.updatedAt.
//
// Data sources, all reused rather than reimplemented:
// - Collection list + slugs: listPickableCollections (this project's own filesystem scan, same one
//   Rebuild Missing Files already uses) for collections WITH a local collection.json, plus
//   collection-runner.js's own loadSyncStateBatch for BOTH per-collection Nexus slugs (via
//   `entries`) AND collections Vortex tracks but this tool has never fetched at all
//   (`workshopOnlyCollections` -- same primitive ff37c49 already added for Rebuild Missing Files'
//   own "Check Workshop for un-fetched collections").
// - Per-collection revision info: fetchCollectionRevisions + resolveNewestRevision (see the header
//   comment above and nexus-collection-download.js's own).
// - Open Staging Folder: reuses rebuild-missing-routes.js's own POST
//   /api/rebuild-missing/open-staging-folder directly from the frontend -- no new route for that.
//
// PACING: one collection at a time, not a parallel blast -- a director with many Workshop
// collections (17+ seen live this session) hitting Nexus's GraphQL endpoint in parallel risks rate
// limits. Streams progress the same POST-starts-202/GET-.../events-subscribes SSE shape as every
// other long scan in this app (sse-session.js). Result is cached (module-level, same "load once,
// keep until the next explicit refresh" shape as rebuild-missing-routes.js's own
// notDownloadedCollections) -- GET /rows never touches Nexus or Vortex, only /check does, matching
// this app's "manual action, not automatic live-state read" convention used everywhere else
// Nexus/Vortex-state gets touched.

const fs = require('fs');
const path = require('path');
const express = require('express');

const { listPickableCollections } = require('../lib/missing-files-scan');
const { loadCollection } = require('../lib/collection-parser');
const nexusCollectionDownload = require('../lib/nexus-collection-download');
const runner = require('../lib/collection-runner');
const syncLib = require('../lib/vortex-sync/lib');
const helperClient = require('../lib/vortex-helper-client');
const workshopReportFetchState = require('../lib/workshop-report-fetch-state');
const { createSseSession } = require('./sse-session');

const checkSession = createSseSession();

function createWorkshopReportRouter(config) {
    const router = express.Router();
    const { staging, state } = config;

    function requireConfigured(res) {
        if (staging) return true;
        res.status(400).json({ error: 'not-configured', message: 'Set up the staging folder under Settings first.' });
        return false;
    }

    // Cached result of the last successful check -- { rows, checkedAt } or null before the first
    // ever check this server process has run.
    let cachedReport = null;

    // A per-row "Fetch from Nexus" (queue: workshop-report-fetch-button) writes collection.json
    // straight to disk via rebuild-missing-routes.js's own /refresh-from-nexus -- a completely
    // separate router, with no reach into this one's cachedReport. Rather than wire up a
    // cross-router cache-patch call, self-heal here instead: a cheap fs.existsSync per still-
    // "not downloaded" row, on every GET (no Nexus/Vortex call, stays within this route's own
    // "never touches Nexus or Vortex" contract). Without this, a reload right after a successful
    // fetch would show the OLD cached "Not downloaded yet" state even though collection.json (and
    // Merge Plugins' own ability to see this collection) already reflects the fetch -- actively
    // wrong, not just stale.
    router.get('/rows', (req, res) => {
        if (cachedReport && staging) {
            for (const row of cachedReport.rows) {
                if (row.fetched) continue;
                if (fs.existsSync(path.join(staging, row.collectionModId, 'collection.json'))) {
                    row.fetched = true;
                    row.revisionNumber = null;
                    row.revisionStatus = null;
                    row.updatedAt = null;
                    row.checkError = null;
                    // No real staleness check has run for this row yet (that's what a real Check
                    // Nexus for updates pass, not this self-heal, establishes) -- false, not stale by
                    // default, same reasoning as the "no tracked record yet" baseline case below.
                    row.updateAvailable = false;
                }
            }
        }
        res.json(cachedReport || { rows: [], checkedAt: null });
    });

    router.get('/check/events', (req, res) => {
        if (!checkSession.get()) return res.status(404).end();
        const afterSeq = Number(req.headers['last-event-id'] || 0);
        checkSession.subscribe(res, { afterSeq });
    });

    router.post('/check', async (req, res) => {
        if (!requireConfigured(res)) return;
        // Helper-first (2026-08-24), same treatment as rebuild-missing-routes.js's own
        // POST /load-vortex-data -- skip the Vortex-closed gate entirely once the Helper covers the
        // read below (loadSyncStateBatchViaHelper). Untouched (same message, same shape) for the
        // no-Helper fallback -- this only ever skips the gate when the Helper genuinely reads the
        // same data the direct state.v2 open would have.
        const helperAvailable = await helperClient.checkHelperAvailable(syncLib.GAME_ID);
        if (!helperAvailable && syncLib.isVortexRunning()) {
            return res.status(409).json({ error: 'vortex-running', message: 'Vortex is currently running. Close it completely and try again.' });
        }
        if (checkSession.isActive()) return res.status(409).json({ error: 'A check is already in progress.' });

        const mySession = checkSession.start({ id: `workshop-report-${Date.now()}` });
        res.status(202).json({});
        const emitIfCurrent = (event) => {
            if (checkSession.get() === mySession) checkSession.emit(event);
        };

        (async () => {
            try {
                // Fail fast, before any Vortex-state read or per-collection work, if there's no key
                // to check anything with at all.
                const apiKey = nexusCollectionDownload.resolveApiKey();

                const { workshop: localWorkshop } = listPickableCollections(staging);
                const entries = [];
                for (const w of localWorkshop) {
                    try {
                        const collection = loadCollection(path.join(staging, w.modId, 'collection.json'));
                        entries.push({ modId: w.modId, collection });
                    } catch {
                        // Unreadable collection.json -- this collection just won't get a slug below
                        // (falls through to the "no Nexus id on record" row state), same tolerance
                        // this router's sibling routes already apply elsewhere.
                    }
                }

                // ONE shared Vortex-DB open for every local collection's slug AND the not-yet-
                // downloaded ones, rather than a per-collection read (see loadSyncStateBatch's own
                // header for why this matters on a large Workshop list). Helper-first (2026-08-24):
                // loadSyncStateBatchViaHelper is the exact same shape/return, just sourced from the
                // Helper's live getAllMods() instead of opening state.v2 directly -- see the gate
                // above for why this route can skip Vortex-closed once the Helper covers this read.
                const { results, workshopOnlyCollections } = helperAvailable
                    ? await runner.loadSyncStateBatchViaHelper({ helperClient, syncLib, entries, stagingDir: staging })
                    : await runner.loadSyncStateBatch({ state, entries, stagingDir: staging });

                // Same dedup rebuild-missing-routes.js's own POST /load-vortex-data already applies -- a collection with a
                // local collection.json already appears via localWorkshop; only a genuinely
                // never-fetched one belongs in the "not downloaded" half of this report.
                const localIds = new Set(localWorkshop.map((w) => w.modId));
                const notDownloaded = workshopOnlyCollections.filter((w) => !localIds.has(w.modId));

                const rows = [];
                for (const w of localWorkshop) {
                    const syncResult = results.get(w.modId);
                    const slug = syncResult?.ok ? syncResult.data.collectionSlug : null;
                    rows.push({ collectionModId: w.modId, name: w.name, slug, fetched: true });
                }
                for (const w of notDownloaded) {
                    rows.push({ collectionModId: w.modId, name: w.name, slug: w.collectionSlug, fetched: false });
                }
                rows.sort((a, b) => a.name.localeCompare(b.name));

                const total = rows.length;
                const finalRows = [];
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    emitIfCurrent({ type: 'collection-checking', index: i + 1, total, name: row.name });
                    if (!row.slug) {
                        finalRows.push({ ...row, revisionNumber: null, revisionStatus: null, updatedAt: null, checkError: 'no-slug', updateAvailable: false });
                        continue;
                    }
                    try {
                        const { revisions } = await nexusCollectionDownload.fetchCollectionRevisions(apiKey, row.slug);
                        const newest = nexusCollectionDownload.resolveNewestRevision(revisions);
                        if (!newest) {
                            finalRows.push({ ...row, revisionNumber: null, revisionStatus: null, updatedAt: null, checkError: 'no-revisions', updateAvailable: false });
                        } else {
                            // Real staleness check (2026-08-24, workshop-report-real-staleness-check),
                            // only meaningful for an already-fetched row -- a not-yet-downloaded row
                            // has no "update available" concept, just a fetch to do. Compares on
                            // updatedAt, never revisionNumber alone -- see this file's own header
                            // comment for why a same-number draft can still be a real update.
                            //
                            // No tracked record yet (every collection fetched before this feature
                            // shipped, the common case on rollout): can't know if it's stale without a
                            // real fetch history, so this check's own resolved revision becomes the
                            // assumed baseline -- written to the tracker right now -- and reports
                            // updateAvailable: false for THIS pass. The alternative (assume stale with
                            // no baseline) would just recreate "everything shows the button," the
                            // exact complaint this feature exists to fix. Every check after this one is
                            // accurate, since a real fetch (or this fallback baseline write) always
                            // populates the tracker going forward.
                            let updateAvailable = false;
                            if (row.fetched) {
                                const tracked = workshopReportFetchState.getTrackedRevision(row.collectionModId);
                                if (!tracked) {
                                    workshopReportFetchState.recordFetch(row.collectionModId, { revisionNumber: newest.revisionNumber, updatedAt: newest.updatedAt });
                                } else {
                                    updateAvailable = new Date(newest.updatedAt) > new Date(tracked.updatedAt);
                                }
                            }
                            finalRows.push({
                                ...row, revisionNumber: newest.revisionNumber, revisionStatus: newest.revisionStatus,
                                updatedAt: newest.updatedAt, checkError: null, updateAvailable,
                            });
                        }
                    } catch (e) {
                        finalRows.push({ ...row, revisionNumber: null, revisionStatus: null, updatedAt: null, checkError: e.message, updateAvailable: false });
                    }
                }

                const checkedAt = new Date().toISOString();
                cachedReport = { rows: finalRows, checkedAt };
                emitIfCurrent({ type: 'check-complete', done: true, rows: finalRows, checkedAt });
            } catch (e) {
                emitIfCurrent({ type: 'check-error', done: true, error: true, message: e.message });
            }
        })();
    });

    return router;
}

module.exports = { createWorkshopReportRouter };
